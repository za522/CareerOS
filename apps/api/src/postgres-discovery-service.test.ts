import { PGlite } from "@electric-sql/pglite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { QueryExecutor, QueryResult, SqlValue, TransactionManager, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresDiscoveryRepository, assertSafeDirectUrl, type HostedRoleObservation } from "./postgres-discovery-repository.js";
import { PostgresDiscoveryService, runWorkspaceTasksIsolated } from "./postgres-discovery-service.js";
import { PostgresDiscoveryQueryRepository } from "./postgres-discovery-query.js";
import { TelegramDeliveryError, type NotificationProvider } from "./notifications.js";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const contextA: WorkspaceContext = { workspaceId: WORKSPACE_A, userId: USER_A };
const contextB: WorkspaceContext = { workspaceId: WORKSPACE_B, userId: USER_B };

function executor(database: PGlite): QueryExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []): Promise<QueryResult<Row>> {
      const result = await database.query<Row>(text, values as unknown[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

class PGliteTransactions implements TransactionManager {
  constructor(private readonly database: PGlite) {}
  async transaction<T>(_context: WorkspaceContext, work: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
    await this.database.exec("BEGIN");
    try {
      const result = await work(executor(this.database));
      await this.database.exec("COMMIT");
      return result;
    } catch (error) {
      await this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const sourceInput = {
  name: "Example Greenhouse",
  kind: "greenhouse" as const,
  companyName: "Example Capital",
  sourceUrl: "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true",
  externalKey: "example",
  enabled: true,
  checkIntervalMinutes: 15,
};

const role: HostedRoleObservation = {
  externalId: "role-1",
  canonicalUrl: "https://job-boards.greenhouse.io/example/jobs/role-1?gh_src=tracking",
  applyUrl: "https://job-boards.greenhouse.io/example/jobs/role-1?gh_src=tracking",
  companyName: "Example Capital",
  title: "Graduate Quantitative Trader",
  location: "London",
  programme: "Graduate",
  sector: "Financial services",
  firmType: "Hedge fund",
  roleFamily: "Trading",
  side: "buy_side",
  description: "Trading and quantitative research.",
};

describe("hosted PostgreSQL discovery and alert vertical slice", () => {
  let database: PGlite;
  let repository: PostgresDiscoveryRepository;

  beforeEach(async () => {
    database = new PGlite();
    for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('${WORKSPACE_A}','A'),('${WORKSPACE_B}','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES
        ('${USER_A}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a@example.com'),
        ('${USER_B}','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES
        ('${WORKSPACE_A}','${USER_A}','owner'),('${WORKSPACE_B}','${USER_B}','owner');
    `);
    repository = new PostgresDiscoveryRepository(new PGliteTransactions(database));
  });

  afterEach(async () => database.close());

  it("claims a due source only once across competing workers and isolates workspaces", async () => {
    await repository.createSource(contextA, sourceInput);
    await repository.createSource(contextB, { ...sourceInput, externalKey: "workspace-b" });
    const [first, second] = await Promise.all([
      repository.claimDueSources(contextA),
      repository.claimDueSources(contextA),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(await repository.claimDueSources(contextB)).toHaveLength(1);
    const owned = first[0] ?? second[0]!;
    expect(await repository.renewSourceClaim(contextA, owned, 60)).toBe(true);
    expect(await repository.renewSourceClaim(contextB, owned, 60)).toBe(false);
  });

  it("seeds only approved hosted starter sources idempotently and per workspace", async () => {
    const firstA = await repository.ensureStarterSources(contextA);
    const secondA = await repository.ensureStarterSources(contextA);
    const firstB = await repository.ensureStarterSources(contextB);
    expect(firstA).toHaveLength(6);
    expect(secondA.map((source) => source.id)).toEqual(firstA.map((source) => source.id));
    expect(firstB).toHaveLength(6);
    expect(firstA.every((source) => source.kind === "greenhouse" || source.kind === "lever")).toBe(true);
    expect(firstA.some((source) => /optiver/i.test(source.name))).toBe(false);
    expect(new Set([...firstA, ...firstB].map((source) => source.id)).size).toBe(12);
    expect((await database.query<{ workspace_id: string; count: number }>(
      "SELECT workspace_id,count(*)::int AS count FROM discovery_sources GROUP BY workspace_id ORDER BY workspace_id",
    )).rows).toEqual([{ workspace_id: WORKSPACE_A, count: 6 }, { workspace_id: WORKSPACE_B, count: 6 }]);
  });

  it("persists Running before fetch and records an abandoned lease before reclaiming it", async () => {
    await repository.createSource(contextA, sourceInput);
    const first = (await repository.claimDueSources(contextA))[0]!;
    expect((await database.query<{ state: string }>("SELECT state FROM discovery_runs WHERE workspace_id=$1 AND id=$2", [WORKSPACE_A, first.runId])).rows[0].state).toBe("Running");
    await database.exec(`UPDATE discovery_sources SET lease_until=now()-interval '1 second' WHERE workspace_id='${WORKSPACE_A}'`);
    const second = (await repository.claimDueSources(contextA))[0]!;
    expect(second.runId).not.toBe(first.runId);
    expect((await database.query<{ state: string; error: string }>("SELECT state,error FROM discovery_runs WHERE workspace_id=$1 AND id=$2", [WORKSPACE_A, first.runId])).rows[0])
      .toMatchObject({ state: "Failed", error: "The discovery worker stopped before completing this run." });
  });

  it("never steals a live lease when an owner requests an immediate check", async () => {
    const source = await repository.createSource(contextA, sourceInput);
    const active = await repository.claimSourceNow(contextA, source.id, 300);
    expect(active).not.toBeNull();
    expect(await repository.claimSourceNow(contextA, source.id, 300)).toBeNull();
    const row = (await database.query<{ lease_token: string }>("SELECT lease_token::text FROM discovery_sources WHERE workspace_id=$1 AND id=$2", [WORKSPACE_A, source.id])).rows[0];
    expect(row.lease_token).toBe(active!.leaseToken);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM discovery_runs WHERE workspace_id=$1 AND source_id=$2 AND state='Running'", [WORKSPACE_A, source.id])).rows[0].count).toBe(1);
  });

  it("persists increasing retry backoff after hosted source failures and resets it after success", async () => {
    const source = await repository.createSource(contextA, sourceInput);
    const first = (await repository.claimDueSources(contextA))[0]!;
    await repository.completeFailedRun(contextA, first, new Error("rate limited"));
    const failedOnce = (await database.query<{ consecutive_failure_count: number; next_attempt_at: string }>(
      "SELECT consecutive_failure_count,next_attempt_at::text FROM discovery_sources WHERE workspace_id=$1 AND id=$2",
      [WORKSPACE_A, source.id],
    )).rows[0];
    expect(failedOnce.consecutive_failure_count).toBe(1);
    expect(new Date(failedOnce.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(await repository.claimDueSources(contextA)).toHaveLength(0);

    const manual = await repository.claimSourceNow(contextA, source.id);
    expect(manual).not.toBeNull();
    await repository.completeSuccessfulRun(contextA, manual!, [role]);
    expect((await database.query<{ consecutive_failure_count: number; next_attempt_at: string | null }>(
      "SELECT consecutive_failure_count,next_attempt_at::text FROM discovery_sources WHERE workspace_id=$1 AND id=$2",
      [WORKSPACE_A, source.id],
    )).rows[0]).toEqual({ consecutive_failure_count: 0, next_attempt_at: null });
  });

  it("creates one deduplicated hosted deadline alert when a matching role closes within seven days", async () => {
    await repository.createSource(contextA, sourceInput);
    await repository.createRule(contextA, {
      name: "Deadline watch", enabled: true, telegramEnabled: true,
      companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: [], newWithinHours: 24,
    });
    const deadlineAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [{ ...role, deadlineAt }]);
    expect((await database.query<{ event_type: string }>(
      "SELECT event_type FROM alert_events WHERE workspace_id=$1 ORDER BY event_type", [WORKSPACE_A],
    )).rows).toEqual([{ event_type: "deadline_soon" }, { event_type: "new_match" }]);

    await database.exec(`UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='${WORKSPACE_A}'`);
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [{ ...role, deadlineAt }]);
    expect((await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM alert_events WHERE workspace_id=$1 AND event_type='deadline_soon'", [WORKSPACE_A],
    )).rows[0].count).toBe(1);
  });

  it("persists postings, aliases, observations, in-app alerts and deduplicated Telegram work", async () => {
    await repository.createSource(contextA, sourceInput);
    await repository.createRule(contextA, {
      name: "London trading",
      enabled: true,
      companies: [], side: "either", roleFamilies: ["Trading"], programmes: [], locations: ["London"], keywords: ["quant"],
      newWithinHours: 24, telegramEnabled: true,
    });
    const claim = (await repository.claimDueSources(contextA))[0]!;
    const run = await repository.completeSuccessfulRun(contextA, claim, [role]);
    expect(run).toMatchObject({ state: "Completed", foundCount: 1, newCount: 1 });
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM discovered_postings WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].count).toBe(1);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM discovery_posting_aliases WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].count).toBe(1);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM discovery_observations WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].count).toBe(1);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM alert_events WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].count).toBe(1);
    expect((await database.query<{ provider: string; state: string }>("SELECT provider,state FROM notification_deliveries WHERE workspace_id=$1 ORDER BY provider", [WORKSPACE_A])).rows)
      .toEqual([{ provider: "in_app", state: "Delivered" }, { provider: "telegram", state: "Pending" }]);

    await database.exec("UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='" + WORKSPACE_A + "'");
    const repeat = (await repository.claimDueSources(contextA))[0]!;
    await repository.completeSuccessfulRun(contextA, repeat, [role]);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM alert_events WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].count).toBe(1);

    for (const description of ["Materially changed requirements.", role.description!]) {
      await database.exec("UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='" + WORKSPACE_A + "'");
      const changedClaim = (await repository.claimDueSources(contextA))[0]!;
      await repository.completeSuccessfulRun(contextA, changedClaim, [{ ...role, description }]);
    }
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM alert_events WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].count).toBe(3);
  });

  it("serves a filtered, paginated workspace and workspace-scoped delivery history", async () => {
    await repository.createSource(contextA, sourceInput);
    await repository.createRule(contextA, {
      name: "Trading", enabled: true, companies: [], side: "either", roleFamilies: ["Trading"], programmes: [], locations: [], keywords: [],
      newWithinHours: 24, telegramEnabled: true,
    });
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [{ ...role, roleFamily: "Trading" }]);
    const queries = new PostgresDiscoveryQueryRepository(new PGliteTransactions(database));
    const workspace = await queries.workspace(contextA, { limit: 1, q: "Quantitative", roleFamily: "Trading" });
    expect(workspace).toMatchObject({ postingTotal: 1, openPostingTotal: 1 });
    expect(workspace.postings[0].careerTrack).toBe("Trading & markets");
    expect((await queries.workspace(contextB, { limit: 100 })).postingTotal).toBe(0);
    expect((await queries.listDeliveryHistory(contextA)).items).toHaveLength(1);
    const marked = await queries.markAlertRead(contextA, workspace.alerts[0].id, true);
    expect(marked?.readAt).not.toBeNull();
    await queries.setPostingHidden(contextA, workspace.postings[0].id, true, workspace.postings[0].revision);
    expect((await queries.workspace(contextA, { limit: 100 })).postings).toHaveLength(0);
    await expect(queries.setPostingHidden(contextA, workspace.postings[0].id, false, workspace.postings[0].revision)).rejects.toThrow(/changed/i);
  });

  it("never false-closes on failure or partial inventory and requires three complete omissions", async () => {
    await repository.createSource(contextA, sourceInput);
    let claim = (await repository.claimDueSources(contextA))[0]!;
    await repository.completeSuccessfulRun(contextA, claim, [role]);

    await database.exec("UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='" + WORKSPACE_A + "'");
    claim = (await repository.claimDueSources(contextA))[0]!;
    await repository.completeFailedRun(contextA, claim, new Error("upstream timeout"));
    expect((await database.query<{ availability: string }>("SELECT availability FROM discovered_postings WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].availability).toBe("Open");

    await database.exec("UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour',next_attempt_at=NULL WHERE workspace_id='" + WORKSPACE_A + "'");
    claim = (await repository.claimDueSources(contextA))[0]!;
    await repository.completeSuccessfulRun(contextA, claim, [], { inventoryComplete: false });
    expect((await database.query<{ availability: string }>("SELECT availability FROM discovered_postings WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].availability).toBe("Open");

    for (const expected of ["Unknown", "Unknown", "Removed"]) {
      await database.exec("UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='" + WORKSPACE_A + "'");
      claim = (await repository.claimDueSources(contextA))[0]!;
      await repository.completeSuccessfulRun(contextA, claim, []);
      expect((await database.query<{ availability: string }>("SELECT availability FROM discovered_postings WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].availability).toBe(expected);
    }
  });

  it("quarantines an abrupt inventory drop even when a provider claims completeness", async () => {
    await repository.createSource(contextA, sourceInput);
    const inventory = Array.from({ length: 30 }, (_, index) => ({
      ...role,
      externalId: `role-${index}`,
      canonicalUrl: `https://job-boards.greenhouse.io/example/jobs/role-${index}`,
      applyUrl: `https://job-boards.greenhouse.io/example/jobs/role-${index}`,
      title: `Graduate Trader ${index}`,
    }));
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, inventory);
    await database.exec("UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='" + WORKSPACE_A + "'");
    const run = await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, inventory.slice(0, 2), { inventoryComplete: true });
    expect(run.state).toBe("Partial");
    expect((await database.query<{ advanced: number }>("SELECT count(*) FILTER (WHERE missing_count>0)::int AS advanced FROM discovery_posting_aliases WHERE workspace_id=$1", [WORKSPACE_A])).rows[0].advanced).toBe(0);
    expect((await database.query<{ last_error: string; successful_inventory_count: number }>("SELECT last_error,successful_inventory_count FROM discovery_sources WHERE workspace_id=$1", [WORKSPACE_A])).rows[0])
      .toMatchObject({ successful_inventory_count: 30, last_error: expect.stringMatching(/quarantine/i) });
  });

  it("adopts a stable lower inventory baseline before applying the three-success removal rule", async () => {
    await repository.createSource(contextA, sourceInput);
    const inventory = Array.from({ length: 30 }, (_, index) => ({
      ...role,
      externalId: `cycle-role-${index}`,
      canonicalUrl: `https://job-boards.greenhouse.io/example/jobs/cycle-role-${index}`,
      applyUrl: `https://job-boards.greenhouse.io/example/jobs/cycle-role-${index}`,
      title: `Cycle Trader ${index}`,
    }));
    const reduced = inventory.slice(0, 2);
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, inventory);

    for (const expectedState of ["Partial", "Partial", "Completed", "Completed", "Completed"] as const) {
      await database.exec(`UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='${WORKSPACE_A}'`);
      const run = await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, reduced, { inventoryComplete: true });
      expect(run.state).toBe(expectedState);
    }

    const source = (await database.query<{ successful_inventory_count: number; trusted_inventory_count: number; candidate_inventory_count: number | null; candidate_inventory_streak: number }>(
      "SELECT successful_inventory_count,trusted_inventory_count,candidate_inventory_count,candidate_inventory_streak FROM discovery_sources WHERE workspace_id=$1",
      [WORKSPACE_A],
    )).rows[0];
    expect(source).toEqual({ successful_inventory_count: 2, trusted_inventory_count: 2, candidate_inventory_count: null, candidate_inventory_streak: 0 });
    expect((await database.query<{ removed: number; open: number }>(`SELECT
      count(*) FILTER (WHERE availability='Removed')::int AS removed,
      count(*) FILTER (WHERE availability='Open')::int AS open
      FROM discovered_postings WHERE workspace_id=$1`, [WORKSPACE_A])).rows[0]).toEqual({ removed: 28, open: 2 });
  });

  it("persists provider update dates without producing changed alerts", async () => {
    await repository.createSource(contextA, sourceInput);
    const original = { ...role, sourcePostedAt: "2026-05-21T09:00:00Z", sourceUpdatedAt: "2026-07-28T14:30:00Z" };
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [original]);
    await database.exec(`UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='${WORKSPACE_A}'`);
    const repeat = await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [{
      ...original, sourceUpdatedAt: "2026-08-08T11:00:00Z",
    }]);
    expect(repeat.changedCount).toBe(0);
    expect((await database.query<{ source_posted_at: string; source_updated_at: string }>(
      "SELECT source_posted_at::text,source_updated_at::text FROM discovered_postings WHERE workspace_id=$1",
      [WORKSPACE_A],
    )).rows[0]).toMatchObject({ source_posted_at: expect.stringContaining("2026-05-21"), source_updated_at: expect.stringContaining("2026-08-08") });
  });

  it("enforces alert freshness for new roles but still alerts on material changes to older roles", async () => {
    await repository.createSource(contextA, sourceInput);
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [role]);
    await database.exec(`UPDATE discovered_postings SET first_seen_at=now()-interval '2 days' WHERE workspace_id='${WORKSPACE_A}';
      UPDATE discovery_sources SET last_checked_at=now()-interval '1 hour' WHERE workspace_id='${WORKSPACE_A}'`);
    await repository.createRule(contextA, {
      name: "Fresh only", enabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: [],
      newWithinHours: 1, telegramEnabled: true,
    });
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [{ ...role, description: "Changed after two days." }]);
    expect((await database.query<{ event_type: string }>("SELECT event_type FROM alert_events WHERE workspace_id=$1", [WORKSPACE_A])).rows)
      .toEqual([{ event_type: "posting_changed" }]);
  });

  it("uses cross-instance-safe Telegram claims and records immutable delivery history", async () => {
    await repository.createTestAlert(contextA, "https://example.com/jobs/test");
    const deliver = vi.fn(async () => ({ providerMessageId: "telegram-123" }));
    const provider: NotificationProvider = { channel: "telegram", deliver };
    const resolveTelegram = async () => ({ provider, recipientId: "42" });
    const first = new PostgresDiscoveryService(repository, { resolveTelegram });
    const second = new PostgresDiscoveryService(repository, { resolveTelegram });
    const [a, b] = await Promise.all([first.dispatchTelegram(contextA), second.dispatchTelegram(contextA)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const delivery = (await database.query<{ state: string; provider_message_id: string }>("SELECT state,provider_message_id FROM notification_deliveries WHERE workspace_id=$1 AND provider='telegram'", [WORKSPACE_A])).rows[0];
    expect(delivery).toEqual({ state: "Delivered", provider_message_id: "telegram-123" });
    expect((await database.query<{ state: string }>("SELECT state FROM notification_delivery_attempts WHERE workspace_id=$1 AND delivery_id=(SELECT id FROM notification_deliveries WHERE workspace_id=$1 AND provider='telegram') ORDER BY sequence", [WORKSPACE_A])).rows)
      .toEqual([{ state: "Started" }, { state: "Delivered" }]);
  });

  it("dispatches only the explicitly targeted delivery when older work is queued", async () => {
    const older = await repository.createTestAlert(contextA, "https://example.com/jobs/older");
    const target = await repository.createTestAlert(contextA, "https://example.com/jobs/target");
    const links: string[] = [];
    const provider: NotificationProvider = { channel: "telegram", deliver: vi.fn(async (request) => { links.push(request.content.directLink ?? ""); return { providerMessageId: "target-message" }; }) };
    const service = new PostgresDiscoveryService(repository, { resolveTelegram: async () => ({ provider, recipientId: "42" }) });
    const result = await service.dispatchTelegram(contextA, { deliveryId: target.telegramDeliveryId });
    expect(result).toEqual({ claimed: 1, delivered: [target.telegramDeliveryId] });
    expect(provider.deliver).toHaveBeenCalledTimes(1);
    expect(links).toEqual(["https://example.com/jobs/target"]);
    const rows = await database.query<{ id: string; state: string }>("SELECT id,state FROM notification_deliveries WHERE workspace_id=$1 AND provider='telegram' ORDER BY created_at,id", [WORKSPACE_A]);
    expect(new Map(rows.rows.map((row) => [row.id, row.state]))).toEqual(new Map([
      [older.telegramDeliveryId, "Pending"],
      [target.telegramDeliveryId, "Delivered"],
    ]));
  });

  it("contains a failed workspace task and continues with later workspaces", async () => {
    const visited: string[] = [];
    const errors: string[] = [];
    const results = await runWorkspaceTasksIsolated([contextA, contextB], async (context) => {
      visited.push(context.workspaceId);
      if (context.workspaceId === WORKSPACE_A) throw new Error("credential cannot decrypt");
      return context.workspaceId;
    }, (context) => errors.push(context.workspaceId));
    expect(visited).toEqual([WORKSPACE_A, WORKSPACE_B]);
    expect(errors).toEqual([WORKSPACE_A]);
    expect(results).toEqual([WORKSPACE_B]);
  });

  it("persists retryable and ambiguous Telegram outcomes without blind duplicate retries", async () => {
    await repository.createSource(contextA, sourceInput);
    await repository.createRule(contextA, {
      name: "Everything", enabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: [],
      newWithinHours: 24, telegramEnabled: true,
    });
    await repository.completeSuccessfulRun(contextA, (await repository.claimDueSources(contextA))[0]!, [role]);
    const retryable: NotificationProvider = { channel: "telegram", deliver: vi.fn(async () => { throw new TelegramDeliveryError("rate limited", "retryable", 1); }) };
    await new PostgresDiscoveryService(repository, { resolveTelegram: async () => ({ provider: retryable, recipientId: "42" }) }).dispatchTelegram(contextA);
    expect((await database.query<{ state: string }>("SELECT state FROM notification_deliveries WHERE workspace_id=$1 AND provider='telegram'", [WORKSPACE_A])).rows[0].state).toBe("Pending");

    await database.exec("UPDATE notification_deliveries SET next_attempt_at=now() WHERE workspace_id='" + WORKSPACE_A + "' AND provider='telegram'");
    const ambiguous: NotificationProvider = { channel: "telegram", deliver: vi.fn(async () => { throw new Error("socket closed"); }) };
    await new PostgresDiscoveryService(repository, { resolveTelegram: async () => ({ provider: ambiguous, recipientId: "42" }) }).dispatchTelegram(contextA);
    const row = (await database.query<{ id: string; state: string }>("SELECT id,state FROM notification_deliveries WHERE workspace_id=$1 AND provider='telegram'", [WORKSPACE_A])).rows[0];
    expect(row.state).toBe("Ambiguous");
    await expect(repository.retryTelegramDelivery(contextA, row.id)).rejects.toThrow(/Confirm/i);
    await expect(repository.retryTelegramDelivery(contextA, row.id, true)).resolves.toBeUndefined();
    expect((await database.query<{ provider_attempt_count: number }>("SELECT provider_attempt_count FROM notification_deliveries WHERE workspace_id=$1 AND id=$2", [WORKSPACE_A, row.id])).rows[0].provider_attempt_count).toBe(0);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM notification_delivery_attempts WHERE workspace_id=$1 AND delivery_id=$2", [WORKSPACE_A, row.id])).rows[0].count).toBe(4);
  });

  it("rejects unsafe direct links before persistence or delivery", () => {
    expect(() => assertSafeDirectUrl("file:///etc/passwd")).toThrow(/public HTTP/i);
    expect(() => assertSafeDirectUrl("http://127.0.0.1:4310/private")).toThrow(/Private-network/i);
    expect(() => assertSafeDirectUrl("https://user:secret@example.com/job")).toThrow(/public HTTP/i);
    expect(assertSafeDirectUrl("https://example.com/jobs/1").hostname).toBe("example.com");
  });
});
