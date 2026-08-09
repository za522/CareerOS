import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const BACKUP_BUNDLE_VERSION = 1 as const;
export const BACKUP_DATABASE_PATH = "careeros.sqlite";
const NON_PORTABLE_SECRET_TABLES = ["workspace_invites", "workspace_invite_sessions"] as const;
const NON_PORTABLE_SECRET_TABLE_NAMES = new Set<string>(NON_PORTABLE_SECRET_TABLES);

type SqliteValue = null | string | number | { blobBase64: string };

export type StructuredTable = {
  name: string;
  columns: string[];
  rows: SqliteValue[][];
};

export type StructuredDatabase = {
  objects: Array<{ type: string; name: string; tableName: string; sql: string }>;
  tables: StructuredTable[];
};

export type BackupManifest = {
  bundleVersion: typeof BACKUP_BUNDLE_VERSION;
  schemaVersion: number;
  applicationVersion: string;
  exportedAt: string;
  structuredDataSha256: string;
  database: { path: typeof BACKUP_DATABASE_PATH; sizeBytes: number; sha256: string };
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
};

export type BackupBundle = {
  manifest: BackupManifest;
  structuredData: StructuredDatabase;
  databaseBase64: string;
  files: Record<string, string>;
};

export type CreateBackupBundleOptions = {
  sqlite: Database.Database;
  dataDirectory: string;
  schemaVersion: number;
  applicationVersion: string;
  exportedAt?: string;
  associatedFilePaths?: string[];
};

export type ValidateBackupBundleOptions = {
  expectedSchemaVersion: number;
  expectedApplicationVersion: string;
};

export type PrepareBackupRestoreOptions = ValidateBackupBundleOptions & {
  bundle: BackupBundle | Buffer | string | unknown;
  destinationDataDirectory: string;
};

export type PreparedBackupRestore = {
  stagingDirectory: string;
  recoveryDirectory: string | null;
  committed: boolean;
  commit(): void;
  rollback(): void;
  finalize(): void;
  abort(): void;
  handoff(): void;
};

export type PendingRestoreMarker = {
  version: 1;
  stagingDirectoryName: string;
  recoveryDirectoryName: string;
  databaseSha256: string;
  createdAt: string;
};

export type PendingRestoreApplyResult = {
  applied: boolean;
  recoveryRetained: string | null;
};

function fsyncPath(path: string) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function durableWrite(path: string, bytes: Buffer | string) {
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  fsyncPath(path);
}

function fsyncTree(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) fsyncTree(path);
    else fsyncPath(path);
  }
  fsyncPath(directory);
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function encodeSqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (Buffer.isBuffer(value)) return { blobBase64: value.toString("base64") };
  throw new Error(`Unsupported SQLite value type in backup: ${typeof value}.`);
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableExists(sqlite: Database.Database, tableName: string) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)").get(tableName));
}

function nonPortableSecretTables(sqlite: Database.Database) {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((entry) => entry.name)
    .filter((name) => NON_PORTABLE_SECRET_TABLE_NAMES.has(name.toLowerCase()));
}

export function readStructuredDatabase(sqlite: Database.Database): StructuredDatabase {
  const objects = sqlite.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tableName: string; sql: string }>;

  const tableNames = objects.filter((object) => object.type === "table").map((object) => object.name).sort();
  const credentialTables = NON_PORTABLE_SECRET_TABLE_NAMES;
  const tables = tableNames.map((name): StructuredTable => {
    const columnRows = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
    const columns = columnRows.map((column) => column.name);
    const rawRows = credentialTables.has(name.toLowerCase()) ? [] : sqlite.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all() as Array<Record<string, unknown>>;
    const rows = rawRows
      .map((row) => columns.map((column) => encodeSqliteValue(row[column])))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    return { name, columns, rows };
  });

  return { objects, tables };
}

function portableDatabaseSnapshot(sqlite: Database.Database) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "careeros-portable-db-"));
  const portablePath = join(temporaryDirectory, BACKUP_DATABASE_PATH);
  writeFileSync(portablePath, sqlite.serialize(), { mode: 0o600 });
  const portable = new Database(portablePath);
  try {
    portable.pragma("foreign_keys = OFF");
    portable.transaction(() => {
      for (const table of nonPortableSecretTables(portable)) portable.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
    })();
    return { buffer: portable.serialize(), structuredData: readStructuredDatabase(portable) };
  } finally {
    portable.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function assertSafeBundlePath(input: string) {
  if (!input || input.includes("\0") || input.includes("\\") || isAbsolute(input)) {
    throw new Error(`Unsafe backup path: ${input || "<empty>"}.`);
  }
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe backup path: ${input}.`);
  }
  return input;
}

function pathInside(root: string, relativePath: string) {
  assertSafeBundlePath(relativePath);
  const target = resolve(root, ...relativePath.split("/"));
  const fromRoot = relative(resolve(root), target);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error(`Backup path escapes its data directory: ${relativePath}.`);
  }
  return target;
}

function referencedFilePaths(sqlite: Database.Database) {
  const paths = new Set<string>();
  for (const table of ["documents", "document_versions"]) {
    if (!tableExists(sqlite, table)) continue;
    const rows = sqlite.prepare(`SELECT relative_path AS relativePath FROM ${quoteIdentifier(table)} WHERE relative_path <> ''`).all() as unknown as Array<{ relativePath: string }>;
    for (const row of rows) paths.add(row.relativePath.replaceAll(sep, "/"));
  }
  return [...paths];
}

function readAssociatedFile(dataDirectory: string, relativePath: string) {
  const safePath = assertSafeBundlePath(relativePath);
  const absolutePath = pathInside(dataDirectory, safePath);
  if (!existsSync(absolutePath)) throw new Error(`Associated file is missing: ${safePath}.`);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Associated backup path is not a regular file: ${safePath}.`);
  const realRoot = realpathSync(dataDirectory);
  const realFile = realpathSync(absolutePath);
  const fromRoot = relative(realRoot, realFile);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error(`Associated file resolves outside the data directory: ${safePath}.`);
  }
  return readFileSync(realFile);
}

export function createBackupBundle(options: CreateBackupBundleOptions): BackupBundle {
  if (!Number.isInteger(options.schemaVersion) || options.schemaVersion < 1) throw new Error("Schema version must be a positive integer.");
  if (!options.applicationVersion.trim()) throw new Error("Application version is required.");
  if (!existsSync(options.dataDirectory)) throw new Error("The CareerOS data directory does not exist.");

  const { structuredData, buffer: databaseBuffer } = portableDatabaseSnapshot(options.sqlite);
  const paths = [...new Set(options.associatedFilePaths ?? referencedFilePaths(options.sqlite))].sort();
  const lowerCasePaths = new Set<string>();
  const files: Record<string, string> = {};
  const fileManifest = paths.map((relativePath) => {
    const safePath = assertSafeBundlePath(relativePath);
    if (safePath === BACKUP_DATABASE_PATH) throw new Error(`${BACKUP_DATABASE_PATH} is reserved for the database snapshot.`);
    const collisionKey = safePath.toLocaleLowerCase("en-US");
    if (lowerCasePaths.has(collisionKey)) throw new Error(`Backup contains a case-insensitive path collision: ${safePath}.`);
    lowerCasePaths.add(collisionKey);
    const buffer = readAssociatedFile(options.dataDirectory, safePath);
    files[safePath] = buffer.toString("base64");
    return { path: safePath, sizeBytes: buffer.byteLength, sha256: sha256(buffer) };
  });

  return {
    manifest: {
      bundleVersion: BACKUP_BUNDLE_VERSION,
      schemaVersion: options.schemaVersion,
      applicationVersion: options.applicationVersion,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      structuredDataSha256: sha256(stableJson(structuredData)),
      database: { path: BACKUP_DATABASE_PATH, sizeBytes: databaseBuffer.byteLength, sha256: sha256(databaseBuffer) },
      files: fileManifest,
    },
    structuredData,
    databaseBase64: databaseBuffer.toString("base64"),
    files,
  };
}

export function encodeBackupBundle(bundle: BackupBundle) {
  return Buffer.from(stableJson(bundle), "utf8");
}

function decodeBundleInput(input: PrepareBackupRestoreOptions["bundle"]): unknown {
  if (Buffer.isBuffer(input)) {
    try { return JSON.parse(input.toString("utf8")); } catch { throw new Error("Backup bundle is not valid JSON."); }
  }
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { throw new Error("Backup bundle is not valid JSON."); }
  }
  return input;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
}

function decodeBase64(value: unknown, label: string) {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new Error(`${label} is not valid base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  // Re-encoding provides strict canonical validation without running one large
  // regular expression over multi-megabyte SQLite snapshots.
  if (decoded.toString("base64") !== value) throw new Error(`${label} is not valid base64.`);
  return decoded;
}

export function validateBackupBundle(input: unknown, options: ValidateBackupBundleOptions): BackupBundle {
  const decoded = decodeBundleInput(input);
  assertPlainObject(decoded, "Backup bundle");
  assertPlainObject(decoded.manifest, "Backup manifest");
  const manifest = decoded.manifest;
  if (manifest.bundleVersion !== BACKUP_BUNDLE_VERSION) throw new Error(`Unsupported backup bundle version: ${String(manifest.bundleVersion)}.`);
  if (manifest.schemaVersion !== options.expectedSchemaVersion) {
    throw new Error(`Backup schema version ${String(manifest.schemaVersion)} does not match required version ${options.expectedSchemaVersion}.`);
  }
  if (manifest.applicationVersion !== options.expectedApplicationVersion) {
    throw new Error(`Backup application version ${String(manifest.applicationVersion)} does not match required version ${options.expectedApplicationVersion}.`);
  }
  if (manifest.database && typeof manifest.database === "object") assertPlainObject(manifest.database, "Database manifest");
  else throw new Error("Database manifest is invalid.");
  if (manifest.database.path !== BACKUP_DATABASE_PATH) throw new Error("Database snapshot path is invalid.");
  if (!Array.isArray(manifest.files)) throw new Error("Backup file manifest is invalid.");
  assertPlainObject(decoded.files, "Backup files");
  if (!decoded.structuredData || typeof decoded.structuredData !== "object") throw new Error("Structured database export is invalid.");

  const databaseBuffer = decodeBase64(decoded.databaseBase64, "Database snapshot");
  if (databaseBuffer.byteLength !== manifest.database.sizeBytes || sha256(databaseBuffer) !== manifest.database.sha256) {
    throw new Error("Database snapshot checksum or size does not match its manifest.");
  }
  if (sha256(stableJson(decoded.structuredData)) !== manifest.structuredDataSha256) {
    throw new Error("Structured database checksum does not match its manifest.");
  }

  const seenPaths = new Set<string>();
  for (const rawEntry of manifest.files) {
    assertPlainObject(rawEntry, "Backup file entry");
    if (typeof rawEntry.path !== "string") throw new Error("Backup file path is invalid.");
    const safePath = assertSafeBundlePath(rawEntry.path);
    const collisionKey = safePath.toLocaleLowerCase("en-US");
    if (seenPaths.has(collisionKey)) throw new Error(`Backup contains a duplicate path: ${safePath}.`);
    seenPaths.add(collisionKey);
    const fileBuffer = decodeBase64(decoded.files[safePath], `Backup file ${safePath}`);
    if (fileBuffer.byteLength !== rawEntry.sizeBytes || sha256(fileBuffer) !== rawEntry.sha256) {
      throw new Error(`Checksum or size mismatch for backup file: ${safePath}.`);
    }
  }
  for (const path of Object.keys(decoded.files)) {
    assertSafeBundlePath(path);
    if (!seenPaths.has(path.toLocaleLowerCase("en-US"))) throw new Error(`Backup contains an unmanifested file: ${path}.`);
  }

  return decoded as unknown as BackupBundle;
}

function verifyStagedDatabase(databasePath: string, expectedStructuredData: StructuredDatabase, associatedPaths: Set<string>) {
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = sqlite.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Staged SQLite database failed its integrity check.");
    if (stableJson(readStructuredDatabase(sqlite)) !== stableJson(expectedStructuredData)) {
      throw new Error("SQLite snapshot does not agree with the structured database export.");
    }
    for (const table of nonPortableSecretTables(sqlite)) {
      const count = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number };
      if (count.count !== 0) throw new Error(`Backup contains non-portable authentication state in ${table}.`);
    }
    for (const table of ["documents", "document_versions"]) {
      if (!tableExists(sqlite, table)) continue;
      const rows = sqlite.prepare(`SELECT relative_path AS relativePath FROM ${quoteIdentifier(table)} WHERE relative_path <> ''`).all() as Array<{ relativePath: string }>;
      for (const row of rows) {
        const safePath = assertSafeBundlePath(row.relativePath.replaceAll(sep, "/"));
        if (!associatedPaths.has(safePath)) throw new Error(`Database references an unbundled associated file: ${safePath}.`);
      }
    }
  } finally {
    sqlite.close();
  }
}

export function prepareBackupRestore(options: PrepareBackupRestoreOptions): PreparedBackupRestore {
  const bundle = validateBackupBundle(options.bundle, options);
  const destination = resolve(options.destinationDataDirectory);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stagingDirectory = resolve(parent, `.${basename(destination)}.restore-${randomUUID()}`);
  const recoveryPath = resolve(parent, `.${basename(destination)}.recovery-${randomUUID()}`);
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });

  try {
    const databaseBuffer = decodeBase64(bundle.databaseBase64, "Database snapshot");
    const stagedDatabasePath = pathInside(stagingDirectory, BACKUP_DATABASE_PATH);
    durableWrite(stagedDatabasePath, databaseBuffer);
    for (const entry of bundle.manifest.files) {
      const target = pathInside(stagingDirectory, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      durableWrite(target, decodeBase64(bundle.files[entry.path], `Backup file ${entry.path}`));
    }
    durableWrite(pathInside(stagingDirectory, "backup-manifest.json"), stableJson(bundle.manifest));
    durableWrite(pathInside(stagingDirectory, "backup-structured-data.json"), stableJson(bundle.structuredData));
    chmodSync(stagingDirectory, 0o700);
    verifyStagedDatabase(stagedDatabasePath, bundle.structuredData, new Set(bundle.manifest.files.map((entry) => entry.path)));
    fsyncTree(stagingDirectory);
    fsyncPath(parent);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  let committed = false;
  let finalized = false;
  let recoveryDirectory: string | null = null;
  const prepared: PreparedBackupRestore = {
    stagingDirectory,
    recoveryDirectory,
    committed,
    commit() {
      if (finalized) throw new Error("This prepared restore has already been finalized.");
      if (committed) return;
      try {
        if (existsSync(destination)) {
          renameSync(destination, recoveryPath);
          recoveryDirectory = recoveryPath;
        }
        renameSync(stagingDirectory, destination);
        committed = true;
        prepared.committed = true;
        prepared.recoveryDirectory = recoveryDirectory;
      } catch (error) {
        if (!existsSync(destination) && recoveryDirectory && existsSync(recoveryDirectory)) renameSync(recoveryDirectory, destination);
        recoveryDirectory = null;
        prepared.recoveryDirectory = null;
        throw error;
      }
    },
    rollback() {
      if (finalized) throw new Error("A finalized restore cannot be rolled back.");
      if (!committed) {
        rmSync(stagingDirectory, { recursive: true, force: true });
        return;
      }
      const failedRestore = `${stagingDirectory}.rolled-back`;
      renameSync(destination, failedRestore);
      try {
        if (recoveryDirectory) renameSync(recoveryDirectory, destination);
        else rmSync(failedRestore, { recursive: true, force: true });
      } catch (error) {
        renameSync(failedRestore, destination);
        throw error;
      }
      rmSync(failedRestore, { recursive: true, force: true });
      committed = false;
      prepared.committed = false;
      recoveryDirectory = null;
      prepared.recoveryDirectory = null;
    },
    finalize() {
      if (!committed) throw new Error("Commit the prepared restore before finalizing it.");
      if (recoveryDirectory) rmSync(recoveryDirectory, { recursive: true, force: true });
      recoveryDirectory = null;
      prepared.recoveryDirectory = null;
      finalized = true;
    },
    abort() {
      if (committed) throw new Error("A committed restore must be rolled back or finalized.");
      rmSync(stagingDirectory, { recursive: true, force: true });
      finalized = true;
    },
    handoff() {
      if (committed) throw new Error("A committed restore cannot be handed off.");
      if (finalized) throw new Error("This prepared restore has already been finalized.");
      fsyncTree(stagingDirectory);
      fsyncPath(parent);
      finalized = true;
    },
  };
  return prepared;
}

function stagedBundle(stagingDirectory: string, options: ValidateBackupBundleOptions) {
  const manifest = JSON.parse(readFileSync(pathInside(stagingDirectory, "backup-manifest.json"), "utf8")) as BackupManifest;
  const structuredData = JSON.parse(readFileSync(pathInside(stagingDirectory, "backup-structured-data.json"), "utf8")) as StructuredDatabase;
  const database = readFileSync(pathInside(stagingDirectory, BACKUP_DATABASE_PATH));
  const files: Record<string, string> = {};
  for (const entry of manifest.files) files[entry.path] = readFileSync(pathInside(stagingDirectory, entry.path)).toString("base64");
  return validateBackupBundle({ manifest, structuredData, databaseBase64: database.toString("base64"), files }, options);
}

function pendingDirectory(parent: string, name: string, expectedPrefix: string) {
  if (!name.startsWith(expectedPrefix) || name.includes("/") || name.includes("\\")) throw new Error("Pending restore metadata contains an invalid directory name.");
  const directory = resolve(parent, name);
  if (dirname(directory) !== parent) throw new Error("Pending restore metadata escapes its data directory.");
  return directory;
}

export function writePendingRestoreMarker(options: {
  markerPath: string;
  prepared: PreparedBackupRestore;
  databaseSha256: string;
  createdAt?: string;
}) {
  const marker = resolve(options.markerPath);
  const parent = dirname(marker);
  const stagingDirectoryName = basename(options.prepared.stagingDirectory);
  const dataName = stagingDirectoryName.match(/^\.(.+)\.restore-[0-9a-f-]+$/)?.[1];
  if (!dataName || dirname(resolve(options.prepared.stagingDirectory)) !== parent) throw new Error("Restore staging is not beside the pending marker.");
  const value: PendingRestoreMarker = {
    version: 1,
    stagingDirectoryName,
    recoveryDirectoryName: `.${dataName}.recovery-${randomUUID()}`,
    databaseSha256: options.databaseSha256,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  const temporary = `${marker}.${randomUUID()}.tmp`;
  options.prepared.handoff();
  try {
    durableWrite(temporary, stableJson(value));
    linkSync(temporary, marker);
    fsyncPath(parent);
  } catch (error) {
    if (!existsSync(marker)) rmSync(options.prepared.stagingDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  return value;
}

export function applyPendingBackupRestore(options: {
  markerPath: string;
  destinationDataDirectory: string;
  operations?: {
    removeMarker(path: string): void;
    removeRecovery(path: string): void;
  };
} & ValidateBackupBundleOptions): PendingRestoreApplyResult {
  const markerPath = resolve(options.markerPath);
  const destination = resolve(options.destinationDataDirectory);
  const parent = dirname(destination);
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as PendingRestoreMarker;
  if (marker.version !== 1 || typeof marker.databaseSha256 !== "string" || typeof marker.createdAt !== "string") throw new Error("Pending restore metadata is invalid.");
  const staging = pendingDirectory(parent, marker.stagingDirectoryName, `.${basename(destination)}.restore-`);
  const recovery = pendingDirectory(parent, marker.recoveryDirectoryName, `.${basename(destination)}.recovery-`);
  const operations = options.operations ?? {
    removeMarker: (path: string) => unlinkSync(path),
    removeRecovery: (path: string) => rmSync(path, { recursive: true }),
  };

  const stagingExists = existsSync(staging);
  const destinationExists = existsSync(destination);
  const recoveryExists = existsSync(recovery);
  if (stagingExists) {
    const bundle = stagedBundle(staging, options);
    if (bundle.manifest.database.sha256 !== marker.databaseSha256) throw new Error("Pending restore database does not match its durable marker.");
  } else if (!(destinationExists && recoveryExists)) {
    throw new Error("Pending restore staging is missing and no completed directory swap can be recovered.");
  } else {
    const activeDatabase = readFileSync(join(destination, BACKUP_DATABASE_PATH));
    if (sha256(activeDatabase) !== marker.databaseSha256) {
      const rejected = join(parent, `.${basename(destination)}.rejected-${randomUUID()}`);
      try {
        renameSync(destination, rejected);
        renameSync(recovery, destination);
        fsyncPath(parent);
      } catch (cause) {
        throw Object.assign(new Error("The active restored database is damaged and the retained previous database could not be recovered."), { restoreFatal: true, cause });
      }
      throw Object.assign(new Error(`The active restored database was damaged. The previous database was recovered; rejected data remains at ${rejected}.`), { restoreRecovered: true });
    }
  }

  if (stagingExists) {
    if (destinationExists && !recoveryExists) {
      renameSync(destination, recovery);
      fsyncPath(parent);
    }
    try {
      if (!existsSync(destination)) {
        renameSync(staging, destination);
        fsyncPath(parent);
      }
    } catch (error) {
      if (!existsSync(destination) && existsSync(recovery)) {
        renameSync(recovery, destination);
        fsyncPath(parent);
      }
      throw error;
    }
  }

  try {
    operations.removeMarker(markerPath);
    fsyncPath(parent);
  } catch (error) {
    const appliedError = Object.assign(new Error("The restored workspace is active, but restart finalization could not remove its pending marker."), { restoreApplied: true, cause: error });
    throw appliedError;
  }

  if (!existsSync(recovery)) return { applied: true, recoveryRetained: null };
  try {
    operations.removeRecovery(recovery);
    fsyncPath(parent);
    return { applied: true, recoveryRetained: null };
  } catch {
    return { applied: true, recoveryRetained: recovery };
  }
}
