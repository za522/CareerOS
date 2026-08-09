import pg, { type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import type {
  CloudDataProvider,
  QueryExecutor,
  QueryResult,
  SqlValue,
  TransactionOptions,
  WorkspaceContext,
} from "./contracts.js";
import { assertUuid } from "./identifiers.js";
import { sqlIdentifier } from "./identifiers.js";

const { Pool } = pg;

export interface PostgresProviderOptions {
  connectionString?: string;
  pool?: PoolConfig;
  provider?: "postgresql" | "supabase";
  applicationName?: string;
  runtimeRole?: string;
}

export interface CloudMigration {
  version: string;
  checksum: string;
  sql: string;
}

function executor(client: PoolClient): QueryExecutor {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
      const result = await client.query<QueryResultRow>(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 } satisfies QueryResult<Row>;
    },
  };
}

function transactionMode(options: TransactionOptions): string {
  const isolation = options.isolationLevel?.toUpperCase() ?? "READ COMMITTED";
  return `BEGIN ISOLATION LEVEL ${isolation}${options.readOnly ? " READ ONLY" : ""}`;
}

function retryableTransactionError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "40001" || code === "40P01";
}

async function transactionRetryDelay(attempt: number) {
  await new Promise((resolve) => setTimeout(resolve, 5 * (2 ** attempt) + Math.floor(Math.random() * 8)));
}

export class PostgresCloudDataProvider implements CloudDataProvider {
  readonly provider: "postgresql" | "supabase";
  readonly #pool: InstanceType<typeof Pool>;
  readonly #runtimeRole: string;

  constructor(options: PostgresProviderOptions = {}) {
    this.provider = options.provider ?? "postgresql";
    this.#runtimeRole = sqlIdentifier(options.runtimeRole ?? "careeros_runtime");
    this.#pool = new Pool({
      ...options.pool,
      connectionString: options.connectionString ?? options.pool?.connectionString,
      application_name: options.applicationName ?? "careeros-api",
    });
  }

  async transaction<T>(
    context: WorkspaceContext,
    work: (transaction: QueryExecutor) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    assertUuid(context.workspaceId, "workspaceId");
    assertUuid(context.userId, "userId");
    const client = await this.#pool.connect();
    try {
      await client.query(transactionMode(options));
      await client.query(`SET LOCAL ROLE ${this.#runtimeRole}`);
      await client.query("SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true), set_config('app.auth_subject', $3, true)", [
        context.workspaceId,
        context.userId,
        context.authSubject ?? "",
      ]);
      const workspaceLock = options.workspaceLock ?? "shared";
      if (workspaceLock !== "none") {
        const lockFunction = workspaceLock === "exclusive" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
        await client.query(`SELECT ${lockFunction}(hashtextextended('careeros-workspace-restore:' || $1, 0))`, [context.workspaceId]);
      }
      const result = await work(executor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(sql: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  async migrateVersion(version: string, checksum: string, sql: string): Promise<void> {
    await this.migrateVersions([{ version, checksum, sql }]);
  }

  async migrateVersions(migrations: readonly CloudMigration[]): Promise<void> {
    for (const migration of migrations) {
      if (!/^\d{4}_[a-z0-9_]+$/.test(migration.version) || !/^[a-f0-9]{64}$/.test(migration.checksum)) {
        throw new Error("Invalid cloud migration identity.");
      }
    }
    const client = await this.#pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('careeros-cloud-migrations'))");
      await client.query("CREATE SCHEMA IF NOT EXISTS careeros");
      await client.query("CREATE TABLE IF NOT EXISTS careeros.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL DEFAULT '', applied_at timestamptz NOT NULL DEFAULT now())");
      await client.query("ALTER TABLE careeros.schema_migrations ADD COLUMN IF NOT EXISTS checksum text NOT NULL DEFAULT ''");
      for (const migration of migrations) {
        const existing = await client.query<{ checksum: string }>("SELECT checksum FROM careeros.schema_migrations WHERE version=$1", [migration.version]);
        if (existing.rows[0]) {
          if (existing.rows[0].checksum && existing.rows[0].checksum !== migration.checksum) {
            throw new Error(`Cloud migration ${migration.version} checksum does not match the applied migration.`);
          }
          if (!existing.rows[0].checksum) {
            await client.query("UPDATE careeros.schema_migrations SET checksum=$2 WHERE version=$1", [migration.version, migration.checksum]);
          }
          continue;
        }
        const migrationBody = migration.sql
          .replace(/^\s*BEGIN\s*;\s*/i, "")
          .replace(/\s*COMMIT\s*;\s*$/i, "");
        await client.query("BEGIN");
        try {
          await client.query(migrationBody);
          await client.query(
            "INSERT INTO careeros.schema_migrations(version,checksum) VALUES ($1,$2) ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum",
            [migration.version, migration.checksum],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('careeros-cloud-migrations'))").catch(() => undefined);
      client.release();
    }
  }

  async administrativeTransaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL row_security = off");
        const result = await work(executor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (!retryableTransactionError(error) || attempt === 4) throw error;
      } finally {
        client.release();
      }
      await transactionRetryDelay(attempt);
    }
    throw new Error("PostgreSQL transaction retry limit was reached.");
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export function createSupabasePostgresProvider(connectionString: string, pool: PoolConfig = {}) {
  if (!connectionString.trim()) throw new Error("A Supabase PostgreSQL connection string is required.");
  return new PostgresCloudDataProvider({ connectionString, pool, provider: "supabase", applicationName: "careeros-supabase-api" });
}
