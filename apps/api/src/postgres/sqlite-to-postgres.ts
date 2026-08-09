import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import type { QueryExecutor, SqlValue } from "./contracts.js";

export interface AdministrativeTransactionManager {
  administrativeTransaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
}

export interface SqliteToPostgresOptions {
  sqlitePath: string;
  workspaceId: string;
  localWorkspaceId?: string;
  workspaceName?: string;
  userMappings?: readonly SqliteUserIdentityMapping[];
}

export interface SqliteUserIdentityMapping {
  localUserId: string;
  hostedUserId: string;
  hostedGoogleSubject: string;
}

export function sqliteUserMappingsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): SqliteUserIdentityMapping[] {
  const encoded = environment.CAREEROS_MIGRATION_USER_MAPPINGS?.trim();
  if (encoded) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error("CAREEROS_MIGRATION_USER_MAPPINGS must be valid JSON.");
    }
    if (!Array.isArray(parsed)) throw new Error("CAREEROS_MIGRATION_USER_MAPPINGS must be a JSON array.");
    return parsed.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`User mapping ${index + 1} must be an object.`);
      const record = entry as Record<string, unknown>;
      if (typeof record.localUserId !== "string" || typeof record.hostedUserId !== "string" || typeof record.hostedGoogleSubject !== "string") {
        throw new Error(`User mapping ${index + 1} requires localUserId, hostedUserId, and hostedGoogleSubject.`);
      }
      return {
        localUserId: record.localUserId,
        hostedUserId: record.hostedUserId,
        hostedGoogleSubject: record.hostedGoogleSubject,
      };
    });
  }

  const localUserId = environment.CAREEROS_MIGRATION_LOCAL_USER_ID?.trim();
  const hostedUserId = environment.CAREEROS_MIGRATION_HOSTED_USER_ID?.trim();
  const hostedGoogleSubject = environment.CAREEROS_MIGRATION_HOSTED_GOOGLE_SUBJECT?.trim();
  if (!localUserId && !hostedUserId && !hostedGoogleSubject) return [];
  if (!localUserId || !hostedUserId || !hostedGoogleSubject) {
    throw new Error("The single-user migration mapping requires CAREEROS_MIGRATION_LOCAL_USER_ID, CAREEROS_MIGRATION_HOSTED_USER_ID, and CAREEROS_MIGRATION_HOSTED_GOOGLE_SUBJECT together.");
  }
  return [{ localUserId, hostedUserId, hostedGoogleSubject }];
}

export interface TableMigrationResult {
  table: string;
  sourceCount: number;
  validatedCount: number;
}

export interface SqliteToPostgresResult {
  workspaceId: string;
  sourceChecksum: string;
  tables: TableMigrationResult[];
  totalRows: number;
}

type SqliteRow = Record<string, unknown>;
type TargetColumn = { column_name: string; data_type: string; udt_name: string };

const TABLE_ORDER = [
  "workspace_users", "workspace_memberships", "workspace_invites", "workspace_invite_sessions", "workspace_comments", "audit_events",
  "companies", "job_postings", "applications", "application_events", "source_documents",
  "discovery_sources", "discovery_runs", "discovered_postings", "discovery_observations", "discovery_posting_aliases", "discovery_issues",
  "import_runs", "ai_runs", "field_evidence", "tasks", "salary_estimates", "salary_research_evidence", "contacts", "application_contacts",
  "tags", "job_tags", "career_tracks", "job_tracks", "skills", "job_skills", "projects", "project_skills", "project_tracks",
  "learning_items", "learning_skills", "goals", "profiles", "profile_evidence", "documents", "document_versions", "document_drafts",
  "application_materials", "capture_queue_items", "capture_drafts", "alert_rules", "alert_events", "notification_deliveries", "notification_delivery_attempts", "backup_records",
] as const;

const GLOBAL_TABLES = new Set(["workspace_users"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_REFERENCE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  workspace_memberships: ["user_id"],
  workspace_invites: ["created_by_user_id"],
  workspace_comments: ["author_user_id"],
  workspace_presence: ["user_id"],
  audit_events: ["actor_user_id"],
};

function isUuid(value: unknown): boolean {
  return UUID_PATTERN.test(String(value ?? ""));
}

function identityMappings(
  users: readonly SqliteRow[],
  referencedUserIds: ReadonlySet<string>,
  mappings: readonly SqliteUserIdentityMapping[],
): ReadonlyMap<string, SqliteUserIdentityMapping> {
  const sourceUsers = new Map(users.map((user) => [String(user.id), user]));
  const byLocalId = new Map<string, SqliteUserIdentityMapping>();
  const hostedUserIds = new Set<string>();
  const hostedSubjects = new Set<string>();

  for (const mapping of mappings) {
    const localUserId = mapping.localUserId.trim();
    const hostedUserId = mapping.hostedUserId.trim();
    const hostedGoogleSubject = mapping.hostedGoogleSubject.trim();
    if (!localUserId || !sourceUsers.has(localUserId)) {
      throw new Error(`User mapping references unknown local user ${localUserId || "<empty>"}.`);
    }
    if (byLocalId.has(localUserId)) throw new Error(`Duplicate user mapping for local user ${localUserId}.`);
    if (!isUuid(hostedUserId)) throw new Error(`Hosted user ID for ${localUserId} must be a stable UUID.`);
    if (!isUuid(hostedGoogleSubject)) throw new Error(`Hosted Google subject for ${localUserId} must be a UUID.`);
    if (hostedUserIds.has(hostedUserId)) throw new Error(`Hosted user ID ${hostedUserId} is mapped more than once.`);
    if (hostedSubjects.has(hostedGoogleSubject)) throw new Error(`Hosted Google subject ${hostedGoogleSubject} is mapped more than once.`);
    const normalised = { localUserId, hostedUserId, hostedGoogleSubject };
    byLocalId.set(localUserId, normalised);
    hostedUserIds.add(hostedUserId);
    hostedSubjects.add(hostedGoogleSubject);
  }

  for (const localUserId of referencedUserIds) {
    const sourceUser = sourceUsers.get(localUserId);
    if (!sourceUser) throw new Error(`Workspace data references missing local user ${localUserId}.`);
    if (byLocalId.has(localUserId)) continue;
    if (!isUuid(sourceUser.id) || !isUuid(sourceUser.auth_subject)) {
      throw new Error(
        `Local user ${localUserId} is not a hosted Google identity. Add an explicit local-user mapping before migration.`,
      );
    }
    const preserved = {
      localUserId,
      hostedUserId: String(sourceUser.id),
      hostedGoogleSubject: String(sourceUser.auth_subject),
    };
    if (hostedUserIds.has(preserved.hostedUserId) || hostedSubjects.has(preserved.hostedGoogleSubject)) {
      throw new Error(`Hosted identity for local user ${localUserId} conflicts with another mapping.`);
    }
    byLocalId.set(localUserId, preserved);
    hostedUserIds.add(preserved.hostedUserId);
    hostedSubjects.add(preserved.hostedGoogleSubject);
  }
  return byLocalId;
}

function remapUserReferences(
  table: string,
  rows: readonly SqliteRow[],
  mappings: ReadonlyMap<string, SqliteUserIdentityMapping>,
): SqliteRow[] {
  return rows.map((sourceRow) => {
    const row = { ...sourceRow };
    if (table === "workspace_users") {
      const mapping = mappings.get(String(sourceRow.id));
      if (!mapping) return row;
      row.id = mapping.hostedUserId;
      row.auth_subject = mapping.hostedGoogleSubject;
      return row;
    }
    for (const column of USER_REFERENCE_COLUMNS[table] ?? []) {
      if (row[column] === null || row[column] === undefined || row[column] === "") continue;
      const mapping = mappings.get(String(row[column]));
      if (!mapping) throw new Error(`No hosted identity mapping exists for ${table}.${column}=${String(row[column])}.`);
      row[column] = mapping.hostedUserId;
    }
    return row;
  });
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function sourceTableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function sourceColumns(sqlite: Database.Database, table: string): Array<{ name: string; pk: number }> {
  return sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>;
}

function targetValue(value: unknown, column: TargetColumn): SqlValue {
  if (value === undefined) return null;
  if (value === "" && ["date", "timestamp with time zone", "timestamp without time zone", "uuid"].includes(column.data_type)) return null;
  if (column.data_type === "jsonb" || column.data_type === "json") {
    if (value === null) return null;
    if (typeof value !== "string") return JSON.stringify(value);
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      throw new Error(`Invalid JSON for cloud column ${column.column_name}.`);
    }
  }
  if (column.data_type === "boolean") return value === true || value === 1 || value === "1" || value === "true";
  if (column.data_type === "uuid" && value !== null && !isUuid(value)) {
    throw new Error(`Invalid UUID for cloud column ${column.column_name}.`);
  }
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value as Buffer;
  return String(value);
}

function rowKey(row: SqliteRow, keyColumns: readonly string[]): string {
  return JSON.stringify(keyColumns.map((column) => row[column] ?? null));
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableJson(entry)]));
  }
  return value;
}

function comparableValue(value: unknown, column: TargetColumn): unknown {
  if (value === null || value === undefined || value === "") {
    return ["date", "timestamp with time zone", "timestamp without time zone", "uuid"].includes(column.data_type) ? null : value ?? null;
  }
  if (column.data_type === "jsonb" || column.data_type === "json") {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return stableJson(parsed);
  }
  if (column.data_type === "timestamp with time zone" || column.data_type === "timestamp without time zone") return new Date(String(value)).toISOString();
  if (column.data_type === "date") return String(value).slice(0, 10);
  if (column.data_type === "boolean") return value === true || value === 1 || value === "1" || value === "true";
  if (["smallint", "integer", "bigint", "real", "double precision", "numeric", "decimal"].includes(column.data_type)) return Number(value);
  if (column.data_type === "bytea") return Buffer.isBuffer(value) ? value.toString("hex") : String(value);
  return String(value);
}

function contentDigest(row: SqliteRow, columns: readonly TargetColumn[]): string {
  const values = columns.map((column) => [column.column_name, comparableValue(row[column.column_name], column)]);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function fileChecksum(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sourceRows(sqlite: Database.Database, table: string, localWorkspaceId: string, allowedUserIds: Set<string>, allowedInviteIds: Set<string>): SqliteRow[] {
  if (!sourceTableExists(sqlite, table)) return [];
  const rows = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as SqliteRow[];
  if (table === "workspace_users") return rows.filter((row) => allowedUserIds.has(String(row.id)));
  if (table === "workspace_invite_sessions") return rows.filter((row) => allowedInviteIds.has(String(row.invite_id)));
  if (sourceColumns(sqlite, table).some((column) => column.name === "workspace_id")) return rows.filter((row) => String(row.workspace_id) === localWorkspaceId);
  return rows;
}

async function targetColumns(transaction: QueryExecutor, table: string): Promise<TargetColumn[]> {
  const result = await transaction.query<TargetColumn>(
    "SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
    [table],
  );
  if (result.rows.length === 0) throw new Error(`Cloud table ${table} is missing. Run cloud migrations first.`);
  return result.rows;
}

async function insertRows(
  transaction: QueryExecutor,
  table: string,
  rows: SqliteRow[],
  sqliteColumns: Array<{ name: string; pk: number }>,
  columns: TargetColumn[],
  workspaceId: string,
): Promise<TableMigrationResult> {
  const sourceNames = new Set(sqliteColumns.map((column) => column.name));
  const insertColumns = columns.filter((column) => column.column_name === "workspace_id" || sourceNames.has(column.column_name));
  const keyColumns = [
    ...(GLOBAL_TABLES.has(table) ? [] : ["workspace_id"]),
    ...sqliteColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name).filter((column) => column !== "workspace_id"),
  ];
  if (keyColumns.length === 0) throw new Error(`Cloud migration cannot validate ${table} because it has no stable key.`);

  for (const sourceRow of rows) {
    const mapped: SqliteRow = { ...sourceRow };
    if (!GLOBAL_TABLES.has(table)) mapped.workspace_id = workspaceId;
    const values = insertColumns.map((column) => targetValue(mapped[column.column_name], column));
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    await transaction.query(
      `INSERT INTO ${quoteIdentifier(table)} (${insertColumns.map((column) => quoteIdentifier(column.column_name)).join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values,
    );
  }

  if (rows.length === 0) return { table, sourceCount: 0, validatedCount: 0 };
  const target = await transaction.query<SqliteRow>(
    `SELECT ${insertColumns.map((column) => quoteIdentifier(column.column_name)).join(",")} FROM ${quoteIdentifier(table)}${GLOBAL_TABLES.has(table) ? "" : " WHERE workspace_id=$1"}`,
    GLOBAL_TABLES.has(table) ? [] : [workspaceId],
  );
  const targetsByKey = new Map(target.rows.map((row) => [rowKey(row, keyColumns), row]));
  let validatedCount = 0;
  for (const sourceRow of rows) {
    const mapped = GLOBAL_TABLES.has(table) ? sourceRow : { ...sourceRow, workspace_id: workspaceId };
    const targetRow = targetsByKey.get(rowKey(mapped, keyColumns));
    if (!targetRow) continue;
    const sourceComparable = Object.fromEntries(insertColumns.map((column) => [column.column_name, targetValue(mapped[column.column_name], column)]));
    if (contentDigest(sourceComparable, insertColumns) !== contentDigest(targetRow, insertColumns)) {
      throw new Error(`Cloud content conflict for ${table} ${rowKey(mapped, keyColumns)}; existing cloud data differs from SQLite.`);
    }
    validatedCount += 1;
  }
  if (validatedCount !== rows.length) throw new Error(`Cloud validation failed for ${table}: expected ${rows.length} records, found ${validatedCount}.`);
  return { table, sourceCount: rows.length, validatedCount };
}

export async function migrateSqliteToPostgres(
  destination: AdministrativeTransactionManager,
  options: SqliteToPostgresOptions,
): Promise<SqliteToPostgresResult> {
  if (!isUuid(options.workspaceId)) {
    throw new Error("workspaceId must be a stable UUID for hosted migration.");
  }
  const checksumBefore = await fileChecksum(options.sqlitePath);
  const sqlite = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  let sourceTransactionOpen = false;
  try {
    sqlite.pragma("query_only = ON");
    sqlite.exec("BEGIN");
    sourceTransactionOpen = true;
    const integrity = sqlite.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
    const localWorkspace = options.localWorkspaceId
      ?? (sourceTableExists(sqlite, "workspaces") ? String((sqlite.prepare("SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id?: string } | undefined)?.id ?? "local-workspace") : "local-workspace");
    const localWorkspaceRow = sourceTableExists(sqlite, "workspaces")
      ? sqlite.prepare("SELECT * FROM workspaces WHERE id=?").get(localWorkspace) as SqliteRow | undefined
      : undefined;
    const membershipRows = sourceTableExists(sqlite, "workspace_memberships")
      ? sqlite.prepare("SELECT * FROM workspace_memberships WHERE workspace_id=?").all(localWorkspace) as SqliteRow[]
      : [];
    const inviteRows = sourceTableExists(sqlite, "workspace_invites")
      ? sqlite.prepare("SELECT * FROM workspace_invites WHERE workspace_id=?").all(localWorkspace) as SqliteRow[]
      : [];
    const userIds = new Set(membershipRows.map((row) => String(row.user_id)));
    for (const invite of inviteRows) userIds.add(String(invite.created_by_user_id));
    if (sourceTableExists(sqlite, "workspace_comments")) {
      for (const row of sqlite.prepare("SELECT author_user_id FROM workspace_comments WHERE workspace_id=?").all(localWorkspace) as SqliteRow[]) userIds.add(String(row.author_user_id));
    }
    if (sourceTableExists(sqlite, "audit_events")) {
      for (const row of sqlite.prepare("SELECT actor_user_id FROM audit_events WHERE workspace_id=? AND actor_user_id IS NOT NULL").all(localWorkspace) as SqliteRow[]) userIds.add(String(row.actor_user_id));
    }
    const inviteIds = new Set(inviteRows.map((row) => String(row.id)));
    const sourceUsers = sourceTableExists(sqlite, "workspace_users")
      ? sqlite.prepare("SELECT * FROM workspace_users").all() as SqliteRow[]
      : [];
    const userIdentityMappings = identityMappings(sourceUsers, userIds, options.userMappings ?? []);

    const results = await destination.administrativeTransaction(async (transaction) => {
      const workspaceCreatedAt = String(localWorkspaceRow?.created_at ?? new Date().toISOString());
      const workspaceUpdatedAt = String(localWorkspaceRow?.updated_at ?? workspaceCreatedAt);
      await transaction.query(
        `INSERT INTO workspaces(id,name,created_at,updated_at,deleted_at,revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [options.workspaceId, options.workspaceName ?? String(localWorkspaceRow?.name ?? "CareerOS"), workspaceCreatedAt, workspaceUpdatedAt, localWorkspaceRow?.deleted_at ? String(localWorkspaceRow.deleted_at) : null, Number(localWorkspaceRow?.revision ?? 1)],
      );
      const workspace = await transaction.query<SqliteRow>("SELECT id,name,created_at,updated_at,deleted_at,revision FROM workspaces WHERE id=$1", [options.workspaceId]);
      if (workspace.rowCount !== 1) throw new Error("Cloud workspace validation failed.");
      const workspaceColumns: TargetColumn[] = [
        { column_name: "id", data_type: "text", udt_name: "text" }, { column_name: "name", data_type: "text", udt_name: "text" },
        { column_name: "created_at", data_type: "timestamp with time zone", udt_name: "timestamptz" }, { column_name: "updated_at", data_type: "timestamp with time zone", udt_name: "timestamptz" },
        { column_name: "deleted_at", data_type: "timestamp with time zone", udt_name: "timestamptz" }, { column_name: "revision", data_type: "integer", udt_name: "int4" },
      ];
      const expectedWorkspace = {
        id: options.workspaceId,
        name: options.workspaceName ?? String(localWorkspaceRow?.name ?? "CareerOS"),
        created_at: workspaceCreatedAt,
        updated_at: workspaceUpdatedAt,
        deleted_at: localWorkspaceRow?.deleted_at ? String(localWorkspaceRow.deleted_at) : null,
        revision: Number(localWorkspaceRow?.revision ?? 1),
      };
      if (contentDigest(expectedWorkspace, workspaceColumns) !== contentDigest(workspace.rows[0], workspaceColumns)) {
        throw new Error("Cloud content conflict for the destination workspace; existing cloud data differs from SQLite.");
      }

      const tableResults: TableMigrationResult[] = [];
      for (const table of TABLE_ORDER) {
        const sqliteTableColumns = sourceTableExists(sqlite, table) ? sourceColumns(sqlite, table) : [];
        if (sqliteTableColumns.length === 0) continue;
        const rows = remapUserReferences(table, sourceRows(sqlite, table, localWorkspace, userIds, inviteIds), userIdentityMappings);
        tableResults.push(await insertRows(transaction, table, rows, sqliteTableColumns, await targetColumns(transaction, table), options.workspaceId));
      }
      return tableResults;
    });

    const checksumAfter = await fileChecksum(options.sqlitePath);
    if (checksumAfter !== checksumBefore) throw new Error("The local SQLite file changed during cloud migration; cloud validation was aborted.");
    sqlite.exec("COMMIT");
    sourceTransactionOpen = false;
    return {
      workspaceId: options.workspaceId,
      sourceChecksum: checksumBefore,
      tables: results,
      totalRows: results.reduce((sum, table) => sum + table.sourceCount, 0),
    };
  } finally {
    if (sourceTransactionOpen) sqlite.exec("ROLLBACK");
    sqlite.close();
  }
}
