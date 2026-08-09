import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { QueryResult, SqlValue } from "../apps/api/src/postgres/contracts.js";
import { discoverCloudMigrations } from "../apps/api/src/postgres/migrations.js";
import { PostgresCloudDataProvider } from "../apps/api/src/postgres/provider.js";

const databasePort = Number(process.env.CAREEROS_HOSTED_E2E_DATABASE_PORT ?? 55_432);
const apiPort = Number(process.env.CAREEROS_HOSTED_E2E_API_PORT ?? 4_410);
const controlPort = Number(process.env.CAREEROS_HOSTED_E2E_CONTROL_PORT ?? 4_429);
const root = process.env.CAREEROS_HOSTED_E2E_ROOT?.trim()
  || join(tmpdir(), `careeros-hosted-e2e-${process.pid}`);
const externalDatabaseUrl = process.env.CAREEROS_HOSTED_E2E_DATABASE_URL?.trim() ?? "";
const databaseUrl = externalDatabaseUrl || `postgresql://postgres:postgres@127.0.0.1:${databasePort}/postgres`;

type HarnessDatabase = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>>;
  close(): Promise<void>;
};

let api: ChildProcess | null = null;
let apiEnvironment: NodeJS.ProcessEnv | null = null;
let closing = false;
let restarting = false;
let discoveryMode: "full" | "updated" | "partial" | "failed" = "full";
let telegramCalls = 0;

function discoveryPayload(updated = false, fixture = "default") {
  const safeFixture = fixture.replace(/[^a-z0-9-]/gi, "-").slice(0, 120) || "default";
  const jobs = [1, 2].map((id) => ({
    id,
    title: id === 1 ? "Graduate Quant Trader" : "Quant Engineering Intern",
    absolute_url: `https://job-boards.greenhouse.io/careeros-e2e-${safeFixture}/jobs/${id}`,
    location: { name: id === 1 ? "London" : "Singapore" },
    first_published: id === 1 ? "2026-05-21T09:00:00Z" : "2026-06-03T10:00:00Z",
    updated_at: updated ? "2026-08-09T12:00:00Z" : "2026-07-28T14:30:00Z",
    content: id === 1 ? "Trade electronic markets using probability and disciplined risk management." : "Build reliable low-latency trading systems.",
  }));
  return { jobs };
}

function describeError(error: unknown) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function waitForHealth(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Hosted API did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signalTree = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child if the process group already exited.
      }
    }
    child.kill(signal);
  };
  signalTree("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) signalTree("SIGKILL");
}

function launchApi() {
  if (!apiEnvironment) throw new Error("Hosted API environment is not ready.");
  apiEnvironment.CAREEROS_E2E_PARENT_PID = String(process.pid);
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./scripts/hosted-e2e-pg-pool-shim.mjs", "src/server.ts"], {
    cwd: process.cwd(),
    env: apiEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  api = child;
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.once("error", (error) => {
    console.error(`[CareerOS hosted E2E] Failed to launch API child:\n${describeError(error)}`);
    if (!restarting) void closeStack(1);
  });
  child.once("exit", (code, signal) => {
    if (!closing && !restarting && api === child) {
      console.error(`[CareerOS hosted E2E] API exited early (${code ?? signal ?? "unknown"}).`);
      void closeStack(code ?? 1);
    }
  });
}

async function restartApi() {
  restarting = true;
  const previous = api;
  api = null;
  await stopChild(previous);
  await new Promise((resolve) => setTimeout(resolve, 250));
  launchApi();
  await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 120_000);
  restarting = false;
}

let closeStack: (exitCode?: number) => Promise<void> = async () => undefined;

async function main() {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });

  let socket: PGLiteSocketServer | null = null;
  let database: HarnessDatabase;
  if (externalDatabaseUrl) {
    const provider = new PostgresCloudDataProvider({ connectionString: externalDatabaseUrl, pool: { max: 10, ssl: false }, applicationName: "careeros-hosted-e2e-harness" });
    await provider.migrateVersions(await discoverCloudMigrations());
    database = {
      query: (text, values = []) => provider.administrativeTransaction((tx) => tx.query(text, values)),
      close: () => provider.close(),
    };
  } else {
    const pglite = await PGlite.create(join(root, "postgres"), { extensions: { pg_trgm } });
    for (const migration of await discoverCloudMigrations()) await pglite.exec(migration.sql);
    socket = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: databasePort,
      maxConnections: 4,
    });
    await socket.start();
    database = {
      query: async (text, values = []) => {
        const result = await pglite.query(text, values as unknown[]);
        return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rows.length || (result.affectedRows ?? 0) };
      },
      close: () => pglite.close(),
    } as HarnessDatabase;
  }

  const control = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, databaseUrl, root }));
      return;
    }
    if (request.url === "/state") {
      try {
        const result = await database.query<{ jobs: number; evidence: number; saved: number }>(`SELECT
          (SELECT count(*)::int FROM job_postings WHERE deleted_at IS NULL) AS jobs,
          (SELECT count(*)::int FROM field_evidence WHERE deleted_at IS NULL) AS evidence,
          (SELECT count(*)::int FROM capture_queue_items WHERE state='Saved' AND deleted_at IS NULL) AS saved`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ...(result.rows[0] ?? { jobs: 0, evidence: 0, saved: 0 }), telegramCalls }));
      } catch (error) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (request.url === "/telegram/reset" && request.method === "POST") {
      telegramCalls = 0;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.startsWith("/telegram/bot") && request.url.endsWith("/sendMessage") && request.method === "POST") {
      for await (const _chunk of request) { /* Drain the request before responding. */ }
      telegramCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { message_id: telegramCalls } }));
      return;
    }
    if (request.url?.startsWith("/restart-api") && request.method === "POST") {
      try {
        await restartApi();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, restarted: true }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: describeError(error) }));
      }
      return;
    }
    if (request.url === "/discovery-mode" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requested = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { mode?: string };
      if (!["full", "updated", "partial", "failed"].includes(requested.mode ?? "")) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "Unknown discovery fixture mode." }));
        return;
      }
      discoveryMode = requested.mode as typeof discoveryMode;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ mode: discoveryMode }));
      return;
    }
    if (request.url === "/job-application/1") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en"><head><title>CareerOS E2E application</title></head><body><main><h1>Graduate Quant Trader application</h1><p data-testid="application-fixture">Deterministic hosted discovery destination</p></main></body></html>`);
      return;
    }
    if (request.url?.startsWith("/discovery-fixture")) {
      if (discoveryMode === "failed") {
        response.statusCode = 503;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "Fixture upstream unavailable" }));
        return;
      }
      const requestedUrl = new URL(request.url, `http://127.0.0.1:${controlPort}`);
      const payload = discoveryPayload(discoveryMode === "updated", requestedUrl.searchParams.get("fixture") || "default");
      if (discoveryMode === "partial") payload.jobs = payload.jobs.slice(0, 1);
      response.setHeader("content-type", "application/json");
      response.setHeader("x-total-count", "2");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => control.once("error", reject).listen(controlPort, "127.0.0.1", resolve));

  closeStack = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    await stopChild(api);
    await new Promise<void>((resolve) => control.close(() => resolve()));
    await socket?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void closeStack(130));
  process.once("SIGTERM", () => void closeStack(0));

  apiEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PGSSLMODE: "disable",
    PGSSL_REJECT_UNAUTHORIZED: "0",
    PORT: String(apiPort),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    CAREEROS_HOSTED: "1",
    CAREEROS_DATA_PROVIDER: "postgres",
    CAREEROS_E2E_AUTH: "1",
    CAREEROS_DATA_DIR: join(root, "api-data"),
    CAREEROS_OBJECT_STORAGE_DIR: join(root, "object-storage"),
    CAREEROS_STORAGE_PROVIDER: "filesystem",
    CAREEROS_CAPTURE_CONCURRENCY: "1",
    CAREEROS_POSTGRES_POOL_MAX: "2",
    CAREEROS_DISABLE_DISCOVERY_SCHEDULER: "1",
    CAREEROS_RATE_LIMIT_MAX: "20000",
    CAREEROS_REALTIME_ENABLED: "0",
    CAREEROS_HOSTED_E2E_DISCOVERY_CONTROL_URL: `http://127.0.0.1:${controlPort}/discovery-fixture`,
    CAREEROS_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    CAREEROS_INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64"),
    CAREEROS_TELEGRAM_API_BASE_URL: `http://127.0.0.1:${controlPort}/telegram`,
    SUPABASE_URL: "https://careeros-hosted-e2e.invalid",
    SUPABASE_ANON_KEY: "hosted-e2e-public-anon-key",
    CAREEROS_OWNER_EMAIL: "owner@example.com",
    OPENAI_API_KEY: "",
  };

  launchApi();

  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 120_000);
    console.info(`[CareerOS hosted E2E] Ready with PostgreSQL socket storage on ${databasePort}.`);
  } catch (error) {
    console.error(error);
    await closeStack(1);
  }
}

process.once("uncaughtException", (error) => {
  console.error(`[CareerOS hosted E2E] Uncaught stack error:\n${describeError(error)}`);
  void (async () => {
    await stopChild(api);
    process.exit(1);
  })();
});
process.once("unhandledRejection", (error) => {
  console.error(`[CareerOS hosted E2E] Unhandled stack rejection:\n${describeError(error)}`);
  void (async () => {
    await stopChild(api);
    process.exit(1);
  })();
});

void main().catch((error) => {
  console.error(`[CareerOS hosted E2E] Stack startup failed:\n${describeError(error)}`);
  process.exit(1);
});
