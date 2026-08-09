import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationProvider } from "./notifications.js";
import { PostgresDiscoveryRepository } from "./postgres-discovery-repository.js";
import { PostgresDiscoveryService } from "./postgres-discovery-service.js";
import type { CloudDataProvider, QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresTelegramSettingsRepository } from "./postgres-telegram-settings.js";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const contextA = { workspaceId: WORKSPACE_A, userId: USER_A, authSubject: "55555555-5555-4555-8555-555555555555" };
const contextB = { workspaceId: WORKSPACE_B, userId: USER_B, authSubject: "66666666-6666-4666-8666-666666666666" };

function executor(database: PGlite): QueryExecutor {
  return { async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
    const result = await database.query<Row>(text, values as unknown[]);
    return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) } satisfies QueryResult<Row>;
  } };
}

class Provider implements CloudDataProvider {
  readonly provider = "postgresql" as const;
  constructor(readonly database: PGlite) {}
  async transaction<T>(context: WorkspaceContext, work: (tx: QueryExecutor) => Promise<T>) {
    await this.database.exec("BEGIN");
    try {
      await this.database.exec("SET LOCAL ROLE careeros_runtime");
      await this.database.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)", [context.workspaceId, context.userId, context.authSubject ?? ""]);
      const result = await work(executor(this.database));
      await this.database.exec("COMMIT");
      return result;
    } catch (error) { await this.database.exec("ROLLBACK"); throw error; }
  }
  async close() { await this.database.close(); }
}

describe("workspace Telegram settings", () => {
  let database: PGlite;
  let provider: Provider;
  let settings: PostgresTelegramSettingsRepository;
  let discovery: PostgresDiscoveryRepository;

  beforeEach(async () => {
    database = new PGlite();
    for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('${WORKSPACE_A}','A'),('${WORKSPACE_B}','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES
        ('${USER_A}','${contextA.authSubject}','a@example.com'),('${USER_B}','${contextB.authSubject}','b@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES
        ('${WORKSPACE_A}','${USER_A}','owner'),('${WORKSPACE_B}','${USER_B}','owner'),('${WORKSPACE_A}','${USER_B}','editor');
    `);
    provider = new Provider(database);
    settings = new PostgresTelegramSettingsRepository(provider, Buffer.alloc(32, 4).toString("base64"));
    discovery = new PostgresDiscoveryRepository(provider);
  });

  afterEach(async () => provider.close());

  it("encrypts distinct workspace credentials and never cross-delivers", async () => {
    await settings.save(contextA, { botToken: "token-for-workspace-a-12345", chatId: "chat-a" });
    await settings.save(contextB, { botToken: "token-for-workspace-b-67890", chatId: "chat-b" });
    const raw = await database.query<Record<string, unknown>>("SELECT * FROM telegram_integrations ORDER BY workspace_id");
    expect(JSON.stringify(raw.rows)).not.toContain("token-for-workspace");
    expect(JSON.stringify(raw.rows)).not.toContain("chat-a");
    expect(await settings.resolve(contextA)).toEqual({ botToken: "token-for-workspace-a-12345", chatId: "chat-a" });
    expect(await settings.resolve(contextB)).toEqual({ botToken: "token-for-workspace-b-67890", chatId: "chat-b" });

    const delivered: Array<{ token: string; recipient: string }> = [];
    const service = new PostgresDiscoveryService(discovery, { resolveTelegram: async (context) => {
      const resolved = await settings.resolve(context);
      if (!resolved) return null;
      const provider: NotificationProvider = { channel: "telegram", deliver: vi.fn(async (request) => {
        delivered.push({ token: resolved.botToken, recipient: request.recipientId });
        return { providerMessageId: `${context.workspaceId}-message` };
      }) };
      return { provider, recipientId: resolved.chatId };
    } });
    await discovery.createTestAlert(contextA);
    await discovery.createTestAlert(contextB);
    await service.dispatchTelegram(contextA);
    await service.dispatchTelegram(contextB);
    expect(delivered).toEqual([
      { token: "token-for-workspace-a-12345", recipient: "chat-a" },
      { token: "token-for-workspace-b-67890", recipient: "chat-b" },
    ]);
  });

  it("denies non-owner configuration writes", async () => {
    await expect(settings.save({ ...contextB, workspaceId: WORKSPACE_A }, { botToken: "editor-token-value-123456", chatId: "wrong-chat" }))
      .rejects.toThrow();
    expect(await settings.status(contextA)).toMatchObject({ configured: false });
  });

  it("decrypts with a previous key and atomically re-encrypts with the current key", async () => {
    const oldKey = Buffer.alloc(32, 5).toString("base64");
    const newKey = Buffer.alloc(32, 6).toString("base64");
    const old = new PostgresTelegramSettingsRepository(provider, oldKey);
    await old.save(contextA, { botToken: "rotation-token-123456789", chatId: "rotation-chat" });
    const before = (await database.query<Record<string, unknown>>("SELECT * FROM telegram_integrations WHERE workspace_id=$1", [WORKSPACE_A])).rows[0];

    const rotated = new PostgresTelegramSettingsRepository(provider, newKey, oldKey);
    await expect(rotated.resolve(contextA)).resolves.toEqual({ botToken: "rotation-token-123456789", chatId: "rotation-chat" });
    const after = (await database.query<Record<string, unknown>>("SELECT * FROM telegram_integrations WHERE workspace_id=$1", [WORKSPACE_A])).rows[0];
    expect(after.key_fingerprint).toBe(createHash("sha256").update(Buffer.alloc(32, 6)).digest("hex").slice(0, 16));
    expect(after.bot_token_ciphertext).not.toBe(before.bot_token_ciphertext);
    await expect(new PostgresTelegramSettingsRepository(provider, newKey).resolve(contextA))
      .resolves.toEqual({ botToken: "rotation-token-123456789", chatId: "rotation-chat" });
    await expect(new PostgresTelegramSettingsRepository(provider, oldKey).resolve(contextA)).rejects.toThrow(/previous integration key|re-save/i);
  });

  it("records attempts separately from confirmed successful tests", async () => {
    await settings.save(contextA, { botToken: "test-status-token-123456", chatId: "status-chat" });
    await settings.recordTest(contextA, "Telegram rejected the request.");
    expect(await settings.status(contextA)).toMatchObject({ lastTestedAt: expect.any(String), lastSuccessfulTestAt: null, lastError: "Telegram rejected the request." });
    await settings.recordTest(contextA);
    expect(await settings.status(contextA)).toMatchObject({ lastTestedAt: expect.any(String), lastSuccessfulTestAt: expect.any(String), lastError: "" });
  });
});
