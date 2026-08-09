import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const end = vi.fn();
  return { query, release, connect, end };
});

vi.mock("pg", () => ({
  default: { Pool: class MockPool { connect = mocks.connect; end = mocks.end; } },
}));

import { PostgresCloudDataProvider } from "./provider.js";

const context = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authSubject: "33333333-3333-4333-8333-333333333333",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("PostgresCloudDataProvider", () => {
  it("sets transaction-local workspace and actor context before repository work", async () => {
    const provider = new PostgresCloudDataProvider({ connectionString: "postgres://test.invalid/test", provider: "supabase" });
    await expect(provider.transaction(context, async (transaction) => {
      await transaction.query("SELECT 1");
      return "done";
    }, { isolationLevel: "serializable" })).resolves.toBe("done");

    expect(mocks.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      'SET LOCAL ROLE "careeros_runtime"',
      "SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true), set_config('app.auth_subject', $3, true)",
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('careeros-workspace-restore:' || $1, 0))",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(mocks.query.mock.calls[2][1]).toEqual([context.workspaceId, context.userId, context.authSubject]);
    expect(mocks.query.mock.calls[3][1]).toEqual([context.workspaceId]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("takes an exclusive workspace lock for destructive restore transactions", async () => {
    const provider = new PostgresCloudDataProvider({ connectionString: "postgres://test.invalid/test" });
    await provider.transaction(context, async (transaction) => transaction.query("SELECT 'restore'"), { workspaceLock: "exclusive" });
    expect(mocks.query.mock.calls.map((call) => call[0])).toContain(
      "SELECT pg_advisory_xact_lock(hashtextextended('careeros-workspace-restore:' || $1, 0))",
    );
  });

  it("rolls back and releases the connection when work fails", async () => {
    const provider = new PostgresCloudDataProvider({ connectionString: "postgres://test.invalid/test" });
    await expect(provider.transaction(context, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(mocks.query.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["ROLLBACK"]));
    expect(mocks.query.mock.calls.map((call) => call[0])).not.toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("holds one advisory lock while applying ordered migration versions", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT checksum")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const provider = new PostgresCloudDataProvider({ connectionString: "postgres://test.invalid/test" });
    await provider.migrateVersions([
      { version: "0001_first", checksum: "a".repeat(64), sql: "SELECT 'first'" },
      { version: "0002_second", checksum: "b".repeat(64), sql: "SELECT 'second'" },
    ]);
    const sql = mocks.query.mock.calls.map((call) => call[0]);
    expect(sql.filter((query) => query.includes("pg_advisory_lock"))).toHaveLength(1);
    expect(sql.indexOf("SET search_path TO public, pg_temp")).toBeLessThan(sql.indexOf("CREATE SCHEMA IF NOT EXISTS careeros"));
    expect(sql.some((query) => query.includes("NO FORCE ROW LEVEL SECURITY"))).toBe(true);
    expect(sql.indexOf("SELECT 'first'")).toBeLessThan(sql.indexOf("SELECT 'second'"));
    expect(sql.filter((query) => query.includes("pg_advisory_unlock"))).toHaveLength(1);
  });

  it("runs administrative copies atomically without switching to the runtime role", async () => {
    const provider = new PostgresCloudDataProvider({ connectionString: "postgres://test.invalid/test" });
    await provider.administrativeTransaction(async (transaction) => transaction.query("SELECT 'copy'"));
    expect(mocks.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE", "SET LOCAL row_security = off", "SELECT 'copy'", "COMMIT",
    ]);
  });

  it("rolls back a failed SQL migration before returning the pooled connection", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT checksum")) return { rows: [], rowCount: 0 };
      if (sql === "BROKEN MIGRATION") throw new Error("syntax failure");
      return { rows: [], rowCount: 0 };
    });
    const provider = new PostgresCloudDataProvider({ connectionString: "postgres://test.invalid/test" });
    await expect(provider.migrateVersions([{ version: "0001_broken", checksum: "a".repeat(64), sql: "BROKEN MIGRATION" }]))
      .rejects.toThrow("syntax failure");
    const sql = mocks.query.mock.calls.map((call) => call[0]);
    expect(sql).toContain("ROLLBACK");
    expect(sql).toContain("SELECT pg_advisory_unlock(hashtext('careeros-cloud-migrations'))");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
