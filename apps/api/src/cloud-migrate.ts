import { createSupabasePostgresProvider } from "./postgres/provider.js";
import { migrateCloudFoundation } from "./postgres/migrations.js";
import { migrateSqliteToPostgres, sqliteUserMappingsFromEnvironment } from "./postgres/sqlite-to-postgres.js";
import { sqlIdentifier } from "./postgres/identifiers.js";

const connectionString = process.env.CAREEROS_MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
if (!connectionString) throw new Error("CAREEROS_MIGRATION_DATABASE_URL or DATABASE_URL is required to migrate the CareerOS cloud database.");

const provider = createSupabasePostgresProvider(connectionString, {
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "0" },
  max: 2,
});

try {
  await migrateCloudFoundation(provider);
  const runtimeLoginRole = process.env.CAREEROS_DATABASE_LOGIN_ROLE?.trim();
  if (runtimeLoginRole) await provider.migrate(`GRANT careeros_runtime TO ${sqlIdentifier(runtimeLoginRole)}`);
  console.info("[CareerOS] PostgreSQL cloud foundation is up to date.");
  if (process.argv.includes("--from-sqlite")) {
    const sqlitePath = process.env.CAREEROS_SQLITE_MIGRATION_PATH?.trim() ?? "";
    const workspaceId = process.env.CAREEROS_MIGRATION_WORKSPACE_ID?.trim() ?? "";
    if (!sqlitePath) throw new Error("CAREEROS_SQLITE_MIGRATION_PATH is required with --from-sqlite.");
    if (!workspaceId) throw new Error("CAREEROS_MIGRATION_WORKSPACE_ID is required with --from-sqlite.");
    const result = await migrateSqliteToPostgres(provider, {
      sqlitePath,
      workspaceId,
      localWorkspaceId: process.env.CAREEROS_LOCAL_WORKSPACE_ID?.trim() || undefined,
      workspaceName: process.env.CAREEROS_MIGRATION_WORKSPACE_NAME?.trim() || undefined,
      userMappings: sqliteUserMappingsFromEnvironment(process.env),
    });
    console.info(`[CareerOS] Validated ${result.totalRows} SQLite records across ${result.tables.length} tables; the local database was not modified.`);
  }
} finally {
  await provider.close();
}
