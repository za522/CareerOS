import { migrateCloudFoundation } from "./postgres/migrations.js";
import { PostgresCloudDataProvider } from "./postgres/provider.js";

export type CareerOsDataProviderName = "sqlite" | "postgres";

export type RuntimeDataProvider =
  | { name: "sqlite"; postgres: null }
  | { name: "postgres"; postgres: PostgresCloudDataProvider };

export function configuredDataProvider(env: NodeJS.ProcessEnv = process.env): CareerOsDataProviderName {
  const explicit = env.CAREEROS_DATA_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit !== "sqlite" && explicit !== "postgres") {
    throw new Error("CAREEROS_DATA_PROVIDER must be either sqlite or postgres.");
  }
  const hosted = env.CAREEROS_HOSTED === "1" || env.NODE_ENV === "production";
  const e2eSqliteFixture = env.NODE_ENV === "test"
    && env.CAREEROS_E2E_AUTH === "1"
    && explicit === "sqlite";
  const provider = (explicit || (hosted ? "postgres" : "sqlite")) as CareerOsDataProviderName;
  if (hosted && provider !== "postgres" && !e2eSqliteFixture) {
    throw new Error("Hosted CareerOS requires CAREEROS_DATA_PROVIDER=postgres. Refusing to start with SQLite.");
  }
  return provider;
}

export async function createRuntimeDataProvider(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeDataProvider> {
  const name = configuredDataProvider(env);
  if (name === "sqlite") return { name, postgres: null };
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) {
    throw new Error("PostgreSQL mode requires DATABASE_URL. Refusing to start without hosted storage.");
  }
  const requestedPoolMax = Number(env.CAREEROS_POSTGRES_POOL_MAX ?? "");
  const poolMax = Number.isInteger(requestedPoolMax) && requestedPoolMax >= 1 && requestedPoolMax <= 50
    ? requestedPoolMax
    : undefined;
  const postgres = new PostgresCloudDataProvider({
    connectionString,
    ...(poolMax ? { pool: { max: poolMax } } : {}),
    provider: env.SUPABASE_URL ? "supabase" : "postgresql",
    runtimeRole: env.CAREEROS_POSTGRES_RUNTIME_ROLE?.trim() || "careeros_runtime",
  });
  try {
    await migrateCloudFoundation(postgres);
    await postgres.administrativeTransaction(async (tx) => {
      await tx.query("SELECT 1 AS ok");
    });
    return { name, postgres };
  } catch (error) {
    await postgres.close().catch(() => undefined);
    throw new Error(`PostgreSQL startup check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const POSTGRES_CONVERTED_API_PATHS = [
  /^\/api\/auth\//,
  /^\/api\/workspace\/(comments|audit)(?:\?|$)/,
  /^\/api\/jobs(?:\/[^/]+)?(?:\?|$)/,
  /^\/api\/jobs\/[^/]+\/(applications|tasks)(?:\?|$)/,
  /^\/api\/applications\/[^/]+\/events(?:\?|$)/,
  /^\/api\/tasks\/[^/]+(?:\?|$)/,
  /^\/api\/capture-queue(?:\/.*)?(?:\?|$)/,
  /^\/api\/capture-drafts(?:\/.*)?(?:\?|$)/,
  /^\/api\/imports\/[^/]+\/commit(?:\?|$)/,
  /^\/api\/discovery(?:\/.*)?(?:\?|$)/,
  /^\/api\/alerts(?:\/.*)?(?:\?|$)/,
  /^\/api\/settings\/telegram(?:\?|$)/,
  /^\/api\/profile(?:\/.*)?(?:\?|$)/,
  /^\/api\/career-studio(?:\?|$)/,
  /^\/api\/jobs\/[^/]+\/(application-studio|document-drafts|cv-tailoring|document-versions)(?:\?|$)/,
  /^\/api\/document-versions\/[^/]+\/pdf(?:\?|$)/,
  /^\/api\/ai\/runs(?:\?|$)/,
  /^\/api\/(export|restore)(?:\?|$)/,
  /^\/api\/backups(?:\/.*)?(?:\?|$)/,
] as const;

export function postgresRouteConverted(url: string) {
  return url === "/health" || url === "/api/meta" || url.startsWith("/api/system/health") || POSTGRES_CONVERTED_API_PATHS.some((pattern) => pattern.test(url));
}

export function postgresRouteRequiresConversion(url: string) {
  return url.startsWith("/api/") && !postgresRouteConverted(url);
}
