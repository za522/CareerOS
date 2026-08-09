import { createHash, randomUUID } from "node:crypto";
import type { CloudDataProvider, QueryExecutor, WorkspaceContext } from "./postgres/contracts.js";
import type { ObjectStorageAdapter } from "./storage/object-storage.js";
import { assertSafeDirectUrl } from "./postgres-discovery-repository.js";

export const POSTGRES_WORKSPACE_BUNDLE_VERSION = 1 as const;
export const POSTGRES_WORKSPACE_BUNDLE_FORMAT = "careeros-postgres-workspace" as const;

type JsonPrimitive = null | boolean | number | string;
export type PortableValue = JsonPrimitive | PortableValue[] | { [key: string]: PortableValue };
export type PortableRow = Record<string, PortableValue>;

export type PostgresWorkspaceTable = {
  name: string;
  rows: PortableRow[];
  sha256: string;
};

export type PostgresWorkspaceFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
};

export type PostgresWorkspaceManifest = {
  format: typeof POSTGRES_WORKSPACE_BUNDLE_FORMAT;
  bundleVersion: typeof POSTGRES_WORKSPACE_BUNDLE_VERSION;
  schemaVersion: string;
  applicationVersion: string;
  sourceWorkspaceId: string;
  exportedAt: string;
  structuredDataSha256: string;
  tables: Array<{ name: string; rowCount: number; sha256: string }>;
  files: PostgresWorkspaceFile[];
};

export type PostgresWorkspaceBundle = {
  manifest: PostgresWorkspaceManifest;
  tables: PostgresWorkspaceTable[];
  files: Record<string, string>;
};

export type CreatePostgresWorkspaceBundleOptions = {
  provider: CloudDataProvider;
  storage: ObjectStorageAdapter;
  context: WorkspaceContext;
  schemaVersion: string;
  applicationVersion: string;
  exportedAt?: string;
};

export type RestorePostgresWorkspaceBundleOptions = {
  provider: CloudDataProvider;
  storage: ObjectStorageAdapter;
  context: WorkspaceContext;
  bundle: PostgresWorkspaceBundle | Uint8Array | string | unknown;
  expectedSchemaVersion: string;
  expectedApplicationVersion: string;
  mode?: "empty" | "replace";
  restoreId?: string;
};

export type PostgresWorkspaceRestoreResult = {
  restoredTables: number;
  restoredRows: number;
  restoredFiles: number;
};

export class PostgresWorkspaceRestoreError extends Error {
  readonly cleanupFailures: string[];

  constructor(message: string, options: { cause?: unknown; cleanupFailures?: string[] } = {}) {
    super(message, { cause: options.cause });
    this.name = "PostgresWorkspaceRestoreError";
    this.cleanupFailures = options.cleanupFailures ?? [];
  }
}

// Ordered parents-first for restore. Reverse order is safe for replacement deletes.
export const POSTGRES_WORKSPACE_TABLES = [
  "workspace_comments",
  "audit_events",
  "companies",
  "tags",
  "career_tracks",
  "skills",
  "projects",
  "learning_items",
  "goals",
  "profiles",
  "source_documents",
  "ai_runs",
  "tasks",
  "capture_drafts",
  "discovery_sources",
  "documents",
  "job_postings",
  "applications",
  "contacts",
  "discovery_runs",
  "discovered_postings",
  "discovery_posting_aliases",
  "discovery_observations",
  "discovery_issues",
  "import_runs",
  "field_evidence",
  "salary_estimates",
  "salary_research_evidence",
  "application_events",
  "document_versions",
  "document_drafts",
  "application_materials",
  "application_contacts",
  "job_tags",
  "job_tracks",
  "job_skills",
  "project_skills",
  "project_tracks",
  "learning_skills",
  "profile_evidence",
  "capture_queue_items",
  "alert_rules",
  "alert_events",
  "notification_deliveries",
  "notification_delivery_attempts",
] as const;

const IMMUTABLE_TABLES = new Set<string>([
  "audit_events",
  "source_documents",
  "salary_research_evidence",
  "application_events",
  "discovery_observations",
  "notification_delivery_attempts",
]);

// Delivery attempts are immutable and retain foreign keys to these mutable
// projection rows. Keep existing parents during replacement so restoring an
// older bundle cannot erase or rewrite newer delivery history.
const PRESERVED_HISTORY_PARENT_TABLES = new Set<string>([
  "alert_events",
  "notification_deliveries",
  "document_versions",
]);

const PRESERVED_PARENT_IDENTITY_COLUMNS: Record<string, readonly string[]> = {
  alert_events: ["workspace_id", "rule_id", "discovered_posting_id", "event_type", "deduplication_key"],
  notification_deliveries: ["workspace_id", "alert_event_id", "provider"],
  document_versions: [
    "workspace_id", "document_id", "job_posting_id", "parent_version_id", "version", "checkpoint_name",
    "content_json", "plain_text", "accepted_change_ids", "proposal_changes", "proposal_decisions",
    "change_summary", "provider", "model", "created_at", "deleted_at",
  ],
};

export const POSTGRES_SECRET_TABLES = new Set([
  "workspace_users",
  "workspace_memberships",
  "workspace_invites",
  "workspace_invite_sessions",
  "workspace_presence",
  "realtime_membership_outbox",
  "realtime_membership_attempts",
  "telegram_integrations",
  "backup_records",
]);

const FORBIDDEN_SECRET_KEY_NAMES = new Set([
  "authsubject",
  "authorization",
  "credential",
  "credentials",
]);

const FORBIDDEN_SECRET_KEY_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "servicerolekey",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "tokenhash",
  "idhash",
] as const;

const EPHEMERAL_COLUMNS: Record<string, Set<string>> = {
  capture_queue_items: new Set(["lease_token", "lease_expires_at"]),
  discovery_sources: new Set(["lease_token", "lease_until"]),
  notification_deliveries: new Set(["claim_token", "claimed_until"]),
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): PortableValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Backup data contains a non-finite number.");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  throw new Error(`Backup data contains an unsupported ${typeof value} value.`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid.`);
}

function assertStoragePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("A backup file path is unsafe.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("A backup file path is unsafe.");
}

function decodeCanonicalBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64.`);
  return bytes;
}

function decodeBundle(input: RestorePostgresWorkspaceBundleOptions["bundle"]): unknown {
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { throw new Error("Workspace backup is not valid JSON."); }
  }
  if (input instanceof Uint8Array) {
    try { return JSON.parse(Buffer.from(input).toString("utf8")); } catch { throw new Error("Workspace backup is not valid JSON."); }
  }
  return input;
}

function sanitiseExportRow(table: string, input: unknown): PortableRow {
  assertPlainObject(input, `${table} row`);
  const ephemeral = EPHEMERAL_COLUMNS[table];
  const row = Object.fromEntries(Object.entries(input)
    .filter(([key]) => !ephemeral?.has(key))
    .map(([key, value]) => [key, stableValue(value)]));
  assertNoSecretKeys(row);
  return row;
}

function assertNoSecretKeys(value: PortableValue) {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalised = key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_SECRET_KEY_NAMES.has(normalised) || FORBIDDEN_SECRET_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix))) {
      throw new Error(`Secret field ${key} cannot be exported.`);
    }
    assertNoSecretKeys(item);
  }
}

async function readTable(tx: QueryExecutor, table: string, workspaceId: string): Promise<PortableRow[]> {
  const result = await tx.query<{ value: Record<string, unknown> }>(
    `SELECT to_jsonb(record) AS value FROM ${table} record WHERE workspace_id=$1`,
    [workspaceId],
  );
  return result.rows
    .map((entry) => sanitiseExportRow(table, entry.value))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function documentFiles(tables: PostgresWorkspaceTable[]) {
  const files = new Map<string, { checksum: string; contentType: string; expectedSize?: number }>();
  const documents = tables.find((table) => table.name === "documents")?.rows ?? [];
  const versions = tables.find((table) => table.name === "document_versions")?.rows ?? [];
  const mimeByDocument = new Map(documents.map((row) => [String(row.id), String(row.mime_type ?? "application/octet-stream")]));
  for (const row of [...documents, ...versions]) {
    const path = String(row.relative_path ?? "");
    if (!path) continue;
    assertStoragePath(path);
    const checksum = String(row.checksum ?? "").toLowerCase();
    assertSha256(checksum, `Checksum for ${path}`);
    const contentType = "mime_type" in row ? String(row.mime_type || "application/octet-stream") : (mimeByDocument.get(String(row.document_id)) ?? "application/octet-stream");
    const expectedSize = "size_bytes" in row && Number(row.size_bytes) > 0 ? Number(row.size_bytes) : undefined;
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) throw new Error(`Document size for ${path} is invalid.`);
    const existing = files.get(path);
    if (existing && existing.checksum !== checksum) throw new Error(`Document path ${path} has conflicting checksums.`);
    if (existing?.expectedSize !== undefined && expectedSize !== undefined && existing.expectedSize !== expectedSize) throw new Error(`Document path ${path} has conflicting sizes.`);
    files.set(path, { checksum, contentType, expectedSize: existing?.expectedSize ?? expectedSize });
  }
  return files;
}

export async function createPostgresWorkspaceBundle(options: CreatePostgresWorkspaceBundleOptions): Promise<PostgresWorkspaceBundle> {
  if (!options.schemaVersion.trim()) throw new Error("Schema version is required.");
  if (!options.applicationVersion.trim()) throw new Error("Application version is required.");
  const tables = await options.provider.transaction(
    options.context,
    async (tx) => Promise.all(POSTGRES_WORKSPACE_TABLES.map(async (name) => {
      const rows = await readTable(tx, name, options.context.workspaceId);
      return { name, rows, sha256: sha256(stableJson(rows)) };
    })),
    { isolationLevel: "repeatable read", readOnly: true },
  );
  const fileReferences = documentFiles(tables);
  const files: Record<string, string> = {};
  const fileManifest: PostgresWorkspaceFile[] = [];
  for (const [path, reference] of [...fileReferences].sort(([left], [right]) => left.localeCompare(right))) {
    const object = await options.storage.read({ workspaceId: options.context.workspaceId, path, expectedChecksum: reference.checksum });
    if (object.sizeBytes !== object.bytes.byteLength || object.checksum !== reference.checksum) throw new Error(`Stored document ${path} failed verification.`);
    if (reference.expectedSize !== undefined && object.sizeBytes !== reference.expectedSize) throw new Error(`Stored document ${path} does not match its recorded size.`);
    files[path] = Buffer.from(object.bytes).toString("base64");
    fileManifest.push({ path, sizeBytes: object.sizeBytes, sha256: object.checksum, contentType: reference.contentType });
  }
  const structuredDataSha256 = sha256(stableJson(tables.map(({ name, rows }) => ({ name, rows }))));
  return {
    manifest: {
      format: POSTGRES_WORKSPACE_BUNDLE_FORMAT,
      bundleVersion: POSTGRES_WORKSPACE_BUNDLE_VERSION,
      schemaVersion: options.schemaVersion,
      applicationVersion: options.applicationVersion,
      sourceWorkspaceId: options.context.workspaceId,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      structuredDataSha256,
      tables: tables.map((table) => ({ name: table.name, rowCount: table.rows.length, sha256: table.sha256 })),
      files: fileManifest,
    },
    tables,
    files,
  };
}

export function encodePostgresWorkspaceBundle(bundle: PostgresWorkspaceBundle): Uint8Array {
  return Buffer.from(stableJson(bundle), "utf8");
}

function validateBundle(
  input: RestorePostgresWorkspaceBundleOptions["bundle"],
  expectedSchemaVersion: string,
  expectedApplicationVersion: string,
): { bundle: PostgresWorkspaceBundle; decodedFiles: Map<string, Uint8Array> } {
  const decoded = decodeBundle(input);
  assertPlainObject(decoded, "Workspace backup");
  assertPlainObject(decoded.manifest, "Workspace backup manifest");
  const manifest = decoded.manifest;
  if (manifest.format !== POSTGRES_WORKSPACE_BUNDLE_FORMAT || manifest.bundleVersion !== POSTGRES_WORKSPACE_BUNDLE_VERSION) throw new Error("Workspace backup version is not supported.");
  if (manifest.schemaVersion !== expectedSchemaVersion) throw new Error("Workspace backup schema version does not match this deployment.");
  if (manifest.applicationVersion !== expectedApplicationVersion) throw new Error("Workspace backup application version does not match this deployment.");
  if (typeof manifest.sourceWorkspaceId !== "string" || typeof manifest.exportedAt !== "string") throw new Error("Workspace backup manifest is invalid.");
  assertSha256(manifest.structuredDataSha256, "Structured data checksum");
  if (!Array.isArray(decoded.tables) || !Array.isArray(manifest.tables) || !Array.isArray(manifest.files)) throw new Error("Workspace backup contents are invalid.");
  assertPlainObject(decoded.files, "Workspace backup files");

  const expectedNames = [...POSTGRES_WORKSPACE_TABLES];
  const tables = decoded.tables as unknown[];
  const parsedTables: PostgresWorkspaceTable[] = tables.map((entry, index) => {
    assertPlainObject(entry, `Backup table ${index + 1}`);
    if (entry.name !== expectedNames[index] || POSTGRES_SECRET_TABLES.has(String(entry.name))) throw new Error("Workspace backup table set is invalid.");
    if (!Array.isArray(entry.rows)) throw new Error(`Rows for ${String(entry.name)} are invalid.`);
    assertSha256(entry.sha256, `Checksum for ${String(entry.name)}`);
    const seenIds = new Set<string>();
    const rows = entry.rows.map((row, rowIndex) => {
      assertPlainObject(row, `${String(entry.name)} row ${rowIndex + 1}`);
      const safe = stableValue(row) as PortableRow;
      assertNoSecretKeys(safe);
      if (typeof safe.id === "string") {
        if (!safe.id) throw new Error(`Backup table ${String(entry.name)} contains an empty row ID.`);
        if (seenIds.has(safe.id)) throw new Error(`Backup table ${String(entry.name)} contains duplicate row ID ${safe.id}.`);
        seenIds.add(safe.id);
      }
      return safe;
    });
    if (sha256(stableJson(rows)) !== entry.sha256) throw new Error(`Checksum for table ${String(entry.name)} does not match.`);
    return { name: String(entry.name), rows, sha256: entry.sha256 };
  });
  if (parsedTables.length !== expectedNames.length) throw new Error("Workspace backup table set is incomplete.");
  const alertEvents = parsedTables.find((table) => table.name === "alert_events");
  for (const row of alertEvents?.rows ?? []) {
    if (typeof row.direct_url !== "string") throw new Error("Workspace backup alert link is invalid.");
    if (!row.direct_url.trim()) continue;
    try { assertSafeDirectUrl(row.direct_url); }
    catch { throw new Error("Workspace backup contains an unsafe alert link."); }
  }
  if (sha256(stableJson(parsedTables.map(({ name, rows }) => ({ name, rows })))) !== manifest.structuredDataSha256) throw new Error("Structured workspace data failed checksum validation.");

  const tableManifest = manifest.tables as unknown[];
  if (tableManifest.length !== parsedTables.length) throw new Error("Workspace backup table manifest is incomplete.");
  tableManifest.forEach((entry, index) => {
    assertPlainObject(entry, `Table manifest ${index + 1}`);
    const table = parsedTables[index];
    if (entry.name !== table.name || entry.rowCount !== table.rows.length || entry.sha256 !== table.sha256) throw new Error(`Table manifest for ${table.name} does not match.`);
  });

  const decodedFiles = new Map<string, Uint8Array>();
  const seenPaths = new Set<string>();
  const validatedFileManifest: PostgresWorkspaceFile[] = [];
  for (const entry of manifest.files as unknown[]) {
    assertPlainObject(entry, "File manifest entry");
    assertStoragePath(entry.path);
    if (seenPaths.has(entry.path)) throw new Error(`Duplicate backup file path: ${entry.path}.`);
    seenPaths.add(entry.path);
    assertSha256(entry.sha256, `Checksum for ${entry.path}`);
    if (!Number.isSafeInteger(entry.sizeBytes) || Number(entry.sizeBytes) < 0 || typeof entry.contentType !== "string") throw new Error(`File manifest for ${entry.path} is invalid.`);
    const bytes = decodeCanonicalBase64((decoded.files as Record<string, unknown>)[entry.path], `File ${entry.path}`);
    if (bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.sha256) throw new Error(`File ${entry.path} failed checksum validation.`);
    decodedFiles.set(entry.path, bytes);
    validatedFileManifest.push({ path: entry.path, sizeBytes: Number(entry.sizeBytes), sha256: entry.sha256, contentType: entry.contentType });
  }
  if (Object.keys(decoded.files).length !== decodedFiles.size || Object.keys(decoded.files).some((path) => !seenPaths.has(path))) throw new Error("Workspace backup contains unlisted files.");
  const bundle = { manifest: { ...manifest, files: validatedFileManifest }, tables: parsedTables, files: decoded.files } as unknown as PostgresWorkspaceBundle;
  const referenced = documentFiles(parsedTables);
  if (referenced.size !== decodedFiles.size || [...referenced].some(([path, value]) => {
    const file = validatedFileManifest.find((entry) => entry.path === path);
    return !decodedFiles.has(path) || file?.sha256 !== value.checksum || (value.expectedSize !== undefined && file.sizeBytes !== value.expectedSize);
  })) {
    throw new Error("Workspace backup document files are incomplete.");
  }
  return { bundle, decodedFiles };
}

async function tableColumns(tx: QueryExecutor, table: string): Promise<Set<string>> {
  const result = await tx.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table]);
  if (!result.rows.length) throw new Error(`Required table ${table} does not exist.`);
  return new Set(result.rows.map((row) => row.column_name));
}

const USER_REFERENCE_COLUMNS: Record<string, readonly string[]> = {
  workspace_comments: ["author_user_id"],
  audit_events: ["actor_user_id"],
  capture_queue_items: ["created_by_user_id"],
};

function rewrittenRow(row: PortableRow, workspaceId: string, userId: string, knownUserIds: Set<string>, pathMap: Map<string, string>): PortableRow {
  const next: PortableRow = { ...row, workspace_id: workspaceId };
  if (typeof next.relative_path === "string" && next.relative_path) next.relative_path = pathMap.get(next.relative_path) ?? next.relative_path;
  for (const column of USER_REFERENCE_COLUMNS[String(row.__table_name ?? "")] ?? []) {
    const referencedUserId = next[column];
    if (typeof referencedUserId === "string" && referencedUserId && !knownUserIds.has(referencedUserId)) next[column] = userId;
  }
  return next;
}

function rewrittenTableRow(table: string, row: PortableRow, workspaceId: string, userId: string, knownUserIds: Set<string>, pathMap: Map<string, string>): PortableRow {
  const tagged = { ...row, __table_name: table };
  const rewritten = rewrittenRow(tagged, workspaceId, userId, knownUserIds, pathMap);
  delete rewritten.__table_name;
  if (table === "capture_queue_items" && rewritten.state === "Extracting") {
    Object.assign(rewritten, {
      state: "Queued",
      progress: 0,
      progress_message: "Resuming capture restored from backup",
      started_at: null,
      completed_at: null,
      import_run_id: null,
      draft_json: null,
    });
  }
  return rewritten;
}

async function insertRow(tx: QueryExecutor, table: string, row: PortableRow, columns: Set<string>, preserveExisting = false, verifyExisting = preserveExisting, replaceExisting = false) {
  const keys = Object.keys(row).sort();
  if (!keys.length || !keys.includes("workspace_id") || keys.some((key) => !columns.has(key) || !/^[a-z][a-z0-9_]*$/.test(key))) throw new Error(`Backup row for ${table} has invalid columns.`);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(",");
  const updateKeys = keys.filter((key) => key !== "id" && key !== "workspace_id");
  const conflictClause = replaceExisting
    ? ` ON CONFLICT (id) DO UPDATE SET ${updateKeys.map((key) => `${key}=excluded.${key}`).join(",")}`
    : preserveExisting ? " ON CONFLICT (id) DO NOTHING" : "";
  const inserted = await tx.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})${conflictClause}`, keys.map((key) => row[key]));
  if (preserveExisting && inserted.rowCount === 0) {
    const id = row.id;
    if (typeof id !== "string") throw new Error(`Immutable backup row for ${table} has no stable ID.`);
    const existing = (await tx.query<{ value: Record<string, unknown> }>(`SELECT to_jsonb(record) AS value FROM ${table} record WHERE workspace_id=$1 AND id=$2`, [row.workspace_id, id])).rows[0];
    if (!existing) throw new Error(`Preserved history row for ${table} could not be verified.`);
    const current = sanitiseExportRow(table, existing.value);
    if (verifyExisting && stableJson(current) !== stableJson(row)) throw new Error(`Immutable history conflict in ${table}.`);
    for (const key of PRESERVED_PARENT_IDENTITY_COLUMNS[table] ?? []) {
      if (stableJson(current[key]) !== stableJson(row[key])) throw new Error(`Preserved history identity conflict in ${table}.`);
    }
  }
}

async function assertTargetMode(tx: QueryExecutor, tables: PostgresWorkspaceTable[], workspaceId: string, userId: string, knownUserIds: Set<string>, mode: "empty" | "replace", pathMap: Map<string, string>, columns: Map<string, Set<string>>) {
  const counts = await Promise.all(POSTGRES_WORKSPACE_TABLES.map(async (table) => {
    const result = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
    return { table, count: Number(result.rows[0]?.count ?? 0) };
  }));
  if (mode === "empty") {
    const occupied = counts.find((entry) => entry.count > 0);
    if (occupied) throw new Error(`Target workspace is not empty (${occupied.table}).`);
    return;
  }
  for (const table of tables.filter((entry) => IMMUTABLE_TABLES.has(entry.name))) {
    const existing = await readTable(tx, table.name, workspaceId);
    const incoming = table.rows.map((row) => rewrittenTableRow(table.name, row, workspaceId, userId, knownUserIds, pathMap)).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    const existingById = new Map(existing.map((row) => [String(row.id), row]));
    for (const row of incoming) {
      const current = existingById.get(String(row.id));
      if (current && stableJson(current) !== stableJson(row)) throw new Error(`Replace would mutate immutable history in ${table.name}.`);
    }
  }
  for (const table of [...POSTGRES_WORKSPACE_TABLES].reverse()) {
    if (!IMMUTABLE_TABLES.has(table) && !PRESERVED_HISTORY_PARENT_TABLES.has(table)) {
      if (columns.get(table)?.has("deleted_at")) {
        await tx.query(`UPDATE ${table} SET deleted_at=COALESCE(deleted_at,now()) WHERE workspace_id=$1`, [workspaceId]);
      } else {
        await tx.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
      }
    }
  }
}

export async function restorePostgresWorkspaceBundle(options: RestorePostgresWorkspaceBundleOptions): Promise<PostgresWorkspaceRestoreResult> {
  const validated = validateBundle(options.bundle, options.expectedSchemaVersion, options.expectedApplicationVersion);
  const restoreId = options.restoreId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]+$/.test(restoreId)) throw new Error("Restore ID is invalid.");
  const pathMap = new Map(validated.bundle.manifest.files.map((file) => [file.path, `restores/${restoreId}/${file.path}`]));
  const uploaded: string[] = [];
  try {
    let restoredRows = 0;
    await options.provider.transaction(options.context, async (tx) => {
      const knownUserIds = new Set((await tx.query<{ user_id: string }>(
        "SELECT user_id FROM workspace_memberships WHERE workspace_id=$1",
        [options.context.workspaceId],
      )).rows.map((row) => row.user_id));
      knownUserIds.add(options.context.userId);
      const columns = new Map<string, Set<string>>();
      for (const table of POSTGRES_WORKSPACE_TABLES) columns.set(table, await tableColumns(tx, table));
      await assertTargetMode(tx, validated.bundle.tables, options.context.workspaceId, options.context.userId, knownUserIds, options.mode ?? "empty", pathMap, columns);
      for (const file of validated.bundle.manifest.files) {
        const path = pathMap.get(file.path)!;
        let existed = false;
        try {
          const existing = await options.storage.read({ workspaceId: options.context.workspaceId, path, expectedChecksum: file.sha256 });
          if (existing.sizeBytes !== file.sizeBytes) throw new Error(`Existing restored file ${file.path} has the wrong size.`);
          existed = true;
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
          if (code !== "not_found") throw error;
        }
        if (!existed) {
          const stored = await options.storage.upload({ workspaceId: options.context.workspaceId, path, bytes: validated.decodedFiles.get(file.path)!, contentType: file.contentType });
          if (stored.checksum !== file.sha256 || stored.sizeBytes !== file.sizeBytes) throw new Error(`Restored file ${file.path} failed provider verification.`);
          uploaded.push(path);
        }
      }
      for (const table of validated.bundle.tables) {
        const rows = table.name === "document_versions"
          ? [...table.rows].sort((left, right) => Number(left.version ?? 0) - Number(right.version ?? 0))
          : table.rows;
        for (const row of rows) {
          const replacing = (options.mode ?? "empty") === "replace";
          const immutable = IMMUTABLE_TABLES.has(table.name);
          const preserveParent = PRESERVED_HISTORY_PARENT_TABLES.has(table.name);
          await insertRow(
            tx,
            table.name,
            rewrittenTableRow(table.name, row, options.context.workspaceId, options.context.userId, knownUserIds, pathMap),
            columns.get(table.name)!,
            replacing && (immutable || preserveParent),
            replacing && immutable,
            replacing && !immutable && !preserveParent && columns.get(table.name)!.has("deleted_at"),
          );
          restoredRows += 1;
        }
      }
    }, { isolationLevel: "serializable", workspaceLock: "exclusive" });
    return { restoredTables: validated.bundle.tables.length, restoredRows, restoredFiles: uploaded.length };
  } catch (error) {
    const cleanup = await Promise.allSettled(uploaded.map((path) => options.storage.delete({ workspaceId: options.context.workspaceId, path })));
    const cleanupFailures = cleanup.flatMap((result, index) => result.status === "rejected"
      ? [`${uploaded[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : []);
    const message = error instanceof Error ? error.message : "Hosted workspace restore failed.";
    throw new PostgresWorkspaceRestoreError(
      cleanupFailures.length ? `${message} Cleanup also failed for ${cleanupFailures.length} staged object(s).` : message,
      { cause: error, cleanupFailures },
    );
  }
}
