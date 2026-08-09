import { createHash, randomUUID } from "node:crypto";
import type {
  AlertRuleCreateInput,
  AlertRuleRecord,
  DiscoveryRunRecord,
  DiscoverySourceCreateInput,
  DiscoverySourceRecord,
} from "@careeros/contracts";
import type { QueryExecutor, TransactionManager, WorkspaceContext } from "./postgres/contracts.js";
import { financeStarterSources } from "./discovery-service.js";

export type HostedRoleObservation = {
  externalId: string;
  canonicalUrl: string;
  applyUrl?: string;
  companyName: string;
  title: string;
  location?: string;
  programme?: string;
  sector?: string;
  firmType?: string;
  roleFamily?: string;
  workMode?: string;
  sponsorship?: string;
  side?: "buy_side" | "sell_side" | "unknown";
  description?: string;
  sourcePostedAt?: string | null;
  sourceUpdatedAt?: string | null;
  deadlineAt?: string | null;
};

export type HostedDiscoveryClaim = {
  source: DiscoverySourceRecord;
  leaseToken: string;
  leaseUntil: string;
  runId: string;
  startedAt: string;
};

export type HostedDeliveryClaim = {
  id: string;
  claimToken: string;
  alertEventId: string;
  title: string;
  body: string;
  directUrl: string;
  deduplicationKey: string;
  providerAttempt: number;
};

type Row = Record<string, unknown>;

const stringValue = (row: Row, key: string) => String(row[key] ?? "");
const nullableString = (row: Row, key: string) => row[key] == null ? null : String(row[key]);
const dateString = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? "");
const booleanValue = (value: unknown) => value === true || value === 1 || value === "1";

function sourceRecord(row: Row): DiscoverySourceRecord {
  return {
    id: stringValue(row, "id"),
    name: stringValue(row, "name"),
    kind: stringValue(row, "kind") as DiscoverySourceRecord["kind"],
    companyName: stringValue(row, "company_name"),
    sourceUrl: stringValue(row, "source_url"),
    externalKey: stringValue(row, "external_key"),
    enabled: booleanValue(row.enabled),
    checkIntervalMinutes: Number(row.check_interval_minutes),
    lastCheckedAt: row.last_checked_at == null ? null : dateString(row.last_checked_at),
    lastSuccessfulAt: row.last_successful_at == null ? null : dateString(row.last_successful_at),
    lastError: stringValue(row, "last_error"),
    successfulInventoryCount: Number(row.successful_inventory_count ?? 0),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    revision: Number(row.revision),
  };
}

function ruleRecord(row: Row): AlertRuleRecord {
  const criteria = (row.criteria_json ?? {}) as Omit<AlertRuleCreateInput, "name" | "enabled" | "telegramEnabled">;
  return {
    id: stringValue(row, "id"),
    name: stringValue(row, "name"),
    enabled: booleanValue(row.enabled),
    companies: criteria.companies ?? [],
    side: criteria.side ?? "either",
    roleFamilies: criteria.roleFamilies ?? [],
    programmes: criteria.programmes ?? [],
    locations: criteria.locations ?? [],
    keywords: criteria.keywords ?? [],
    newWithinHours: criteria.newWithinHours ?? 24,
    telegramEnabled: booleanValue(row.telegram_enabled),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    revision: Number(row.revision),
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeUrl(value: string) {
  const url = assertSafeDirectUrl(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|source$|ref$|gh_src$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString().replace(/\/$/, "");
}

export function assertSafeDirectUrl(value: string) {
  if (!value || value.length > 2_048) throw new Error("A public job link is required.");
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error("Only public HTTP job links are allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blocked = host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0"
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^fc/i.test(host) || /^fd/i.test(host) || /^fe[89ab]/i.test(host);
  if (blocked) throw new Error("Private-network job links are not allowed.");
  return url;
}

function roleHash(role: HostedRoleObservation) {
  return hash({
    title: role.title.trim(), location: role.location?.trim() ?? "", programme: role.programme?.trim() ?? "",
    description: role.description?.trim() ?? "", deadlineAt: role.deadlineAt ?? null,
    applyUrl: role.applyUrl ?? role.canonicalUrl,
  });
}

function includesAny(value: string, candidates: string[]) {
  const normalized = value.toLocaleLowerCase();
  return !candidates.length || candidates.some((candidate) => normalized.includes(candidate.toLocaleLowerCase()));
}

function matchesRule(role: HostedRoleObservation, rule: AlertRuleRecord, detectedAt: Date, requireFresh: boolean) {
  const haystack = `${role.companyName} ${role.title} ${role.location ?? ""} ${role.description ?? ""}`;
  const fresh = Date.now() - detectedAt.getTime() <= rule.newWithinHours * 3_600_000;
  return (!requireFresh || fresh) && includesAny(role.companyName, rule.companies)
    && (rule.side === "either" || (role.side ?? "unknown") === rule.side)
    && includesAny(role.roleFamily ?? "", rule.roleFamilies)
    && includesAny(role.programme ?? "", rule.programmes)
    && includesAny(role.location ?? "", rule.locations)
    && includesAny(haystack, rule.keywords);
}

async function nextAttemptSequence(tx: QueryExecutor, workspaceId: string, deliveryId: string) {
  const result = await tx.query<{ sequence: number }>(
    "SELECT COALESCE(MAX(sequence),0)::int+1 AS sequence FROM notification_delivery_attempts WHERE workspace_id=$1 AND delivery_id=$2",
    [workspaceId, deliveryId],
  );
  return Number(result.rows[0]?.sequence ?? 1);
}

export class PostgresDiscoveryRepository {
  constructor(private readonly transactions: TransactionManager) {}

  async ensureStarterSources(context: WorkspaceContext): Promise<DiscoverySourceRecord[]> {
    return this.transactions.transaction(context, async (tx) => {
      for (const input of financeStarterSources.filter((source) => source.kind === "greenhouse" || source.kind === "lever" || source.kind === "ashby")) {
        await tx.query(`INSERT INTO discovery_sources
          (id,workspace_id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(workspace_id,kind,external_key) DO NOTHING`, [
          randomUUID(), context.workspaceId, input.name, input.kind, input.companyName, input.sourceUrl,
          input.externalKey, input.enabled, input.checkIntervalMinutes,
        ]);
      }
      const result = await tx.query<Row>("SELECT * FROM discovery_sources WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY name", [context.workspaceId]);
      return result.rows.map(sourceRecord);
    });
  }

  async createSource(context: WorkspaceContext, input: DiscoverySourceCreateInput): Promise<DiscoverySourceRecord> {
    assertSafeDirectUrl(input.sourceUrl);
    return this.transactions.transaction(context, async (tx) => {
      const result = await tx.query<Row>(`INSERT INTO discovery_sources
        (id,workspace_id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [
        randomUUID(), context.workspaceId, input.name, input.kind, input.companyName, input.sourceUrl,
        input.externalKey, input.enabled, input.checkIntervalMinutes,
      ]);
      return sourceRecord(result.rows[0]!);
    });
  }

  async createRule(context: WorkspaceContext, input: AlertRuleCreateInput): Promise<AlertRuleRecord> {
    const { name, enabled, telegramEnabled, ...criteria } = input;
    return this.transactions.transaction(context, async (tx) => {
      const result = await tx.query<Row>(`INSERT INTO alert_rules
        (id,workspace_id,name,enabled,criteria_json,telegram_enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), context.workspaceId, name, enabled, criteria, telegramEnabled]);
      return ruleRecord(result.rows[0]!);
    });
  }

  async claimDueSources(context: WorkspaceContext, options: { limit?: number; leaseSeconds?: number } = {}): Promise<HostedDiscoveryClaim[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 300, 3_600));
    return this.transactions.transaction(context, async (tx) => {
      await tx.query(`UPDATE discovery_runs r SET state='Failed',completed_at=now(),
        duration_ms=GREATEST(0,extract(epoch from (now()-r.started_at))*1000)::int,
        error='The discovery worker stopped before completing this run.'
        FROM discovery_sources s WHERE r.workspace_id=$1 AND s.workspace_id=r.workspace_id AND s.id=r.source_id
          AND r.state='Running' AND r.lease_token=s.lease_token AND s.lease_until<=now()`, [context.workspaceId]);
      const result = await tx.query<Row>(`WITH due AS (
        SELECT id FROM discovery_sources WHERE workspace_id=$1 AND enabled AND deleted_at IS NULL
          AND (lease_until IS NULL OR lease_until<=now())
          AND (next_attempt_at IS NULL OR next_attempt_at<=now())
          AND (last_checked_at IS NULL OR last_checked_at + check_interval_minutes * interval '1 minute'<=now())
        ORDER BY COALESCE(last_checked_at,'-infinity'::timestamptz),id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE discovery_sources s SET lease_token=gen_random_uuid(),lease_until=now()+$3*interval '1 second',updated_at=now(),revision=revision+1
        FROM due WHERE s.workspace_id=$1 AND s.id=due.id RETURNING s.*`, [context.workspaceId, limit, leaseSeconds]);
      const claims: HostedDiscoveryClaim[] = [];
      for (const row of result.rows) {
        const runId = randomUUID();
        const started = new Date().toISOString();
        await tx.query(`INSERT INTO discovery_runs(id,workspace_id,source_id,lease_token,state,started_at)
          VALUES($1,$2,$3,$4,'Running',$5)`, [runId, context.workspaceId, stringValue(row, "id"), stringValue(row, "lease_token"), started]);
        claims.push({ source: sourceRecord(row), leaseToken: stringValue(row, "lease_token"), leaseUntil: dateString(row.lease_until), runId, startedAt: started });
      }
      return claims;
    });
  }

  async claimSourceNow(context: WorkspaceContext, sourceId: string, leaseSeconds = 300): Promise<HostedDiscoveryClaim | null> {
    const duration = Math.max(15, Math.min(leaseSeconds, 3_600));
    return this.transactions.transaction(context, async (tx) => {
      await tx.query(`UPDATE discovery_runs r SET state='Failed',completed_at=now(),
        duration_ms=GREATEST(0,extract(epoch from (now()-r.started_at))*1000)::int,error='The discovery worker stopped before completing this run.'
        FROM discovery_sources s WHERE r.workspace_id=$1 AND r.source_id=$2 AND s.workspace_id=r.workspace_id AND s.id=r.source_id
          AND r.state='Running' AND r.lease_token=s.lease_token AND s.lease_until<=now()`, [context.workspaceId, sourceId]);
      const result = await tx.query<Row>(`UPDATE discovery_sources SET lease_token=gen_random_uuid(),
        lease_until=now()+$3*interval '1 second',updated_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND enabled AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until<=now()) RETURNING *`,
      [context.workspaceId, sourceId, duration]);
      const row = result.rows[0];
      if (!row) return null;
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      await tx.query(`INSERT INTO discovery_runs(id,workspace_id,source_id,lease_token,state,started_at)
        VALUES($1,$2,$3,$4,'Running',$5)`, [runId, context.workspaceId, sourceId, stringValue(row, "lease_token"), startedAt]);
      return { source: sourceRecord(row), leaseToken: stringValue(row, "lease_token"), leaseUntil: dateString(row.lease_until), runId, startedAt };
    });
  }

  async renewSourceClaim(context: WorkspaceContext, claim: HostedDiscoveryClaim, leaseSeconds = 300) {
    const duration = Math.max(15, Math.min(leaseSeconds, 3_600));
    return this.transactions.transaction(context, async (tx) => {
      const result = await tx.query<{ lease_until: Date }>(`UPDATE discovery_sources
        SET lease_until=now()+$4*interval '1 second',updated_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() AND deleted_at IS NULL
        RETURNING lease_until`, [context.workspaceId, claim.source.id, claim.leaseToken, duration]);
      if (!result.rows[0]) return false;
      claim.leaseUntil = dateString(result.rows[0].lease_until);
      return true;
    });
  }

  async completeSuccessfulRun(
    context: WorkspaceContext,
    claim: HostedDiscoveryClaim,
    observations: HostedRoleObservation[],
    options: { inventoryComplete?: boolean; startedAt?: Date } = {},
  ): Promise<DiscoveryRunRecord> {
    const reportedComplete = options.inventoryComplete ?? true;
    const runId = claim.runId;
    const unique = new Map<string, HostedRoleObservation>();
    for (const raw of observations) {
      const externalId = raw.externalId.trim();
      if (!externalId || !raw.title.trim() || !raw.companyName.trim()) throw new Error("Discovery observations require an external id, company, and title.");
      unique.set(externalId, { ...raw, externalId, canonicalUrl: normalizeUrl(raw.canonicalUrl), applyUrl: normalizeUrl(raw.applyUrl || raw.canonicalUrl) });
    }
    return this.transactions.transaction(context, async (tx) => {
      const lease = await tx.query<Row>(`SELECT * FROM discovery_sources WHERE workspace_id=$1 AND id=$2 AND lease_token=$3
        AND lease_until>now() AND deleted_at IS NULL FOR UPDATE`, [context.workspaceId, claim.source.id, claim.leaseToken]);
      if (!lease.rows[0]) throw new Error("Discovery source lease was lost before reconciliation.");
      const priorInventory = Number(lease.rows[0].trusted_inventory_count ?? lease.rows[0].successful_inventory_count ?? 0);
      const previousCandidate = lease.rows[0].candidate_inventory_count == null ? null : Number(lease.rows[0].candidate_inventory_count);
      const previousCandidateStreak = Number(lease.rows[0].candidate_inventory_streak ?? 0);
      const abruptDrop = reportedComplete && priorInventory >= 20 && unique.size < Math.ceil(priorInventory * 0.5);
      const candidateStreak = abruptDrop ? (previousCandidate === unique.size ? previousCandidateStreak + 1 : 1) : 0;
      const adoptLowerBaseline = abruptDrop && candidateStreak >= 3;
      const inventoryComplete = reportedComplete && (!abruptDrop || adoptLowerBaseline);
      const nextTrustedInventory = inventoryComplete ? unique.size : priorInventory;
      const inventoryWarning = !reportedComplete
        ? "Incomplete inventory: the provider indicated that more roles may exist. No missing roles were advanced."
        : abruptDrop && !adoptLowerBaseline
          ? `Inventory quarantine: provider returned ${unique.size} roles after a trusted baseline of ${priorInventory}. Stable complete observation ${candidateStreak} of 3; no missing roles were advanced.`
          : "";
      const running = await tx.query<{ id: string }>(`SELECT id FROM discovery_runs WHERE workspace_id=$1 AND id=$2
        AND source_id=$3 AND lease_token=$4 AND state='Running' FOR UPDATE`,
      [context.workspaceId, runId, claim.source.id, claim.leaseToken]);
      if (!running.rows[0]) throw new Error("Discovery run is no longer active.");
      const rules = (await tx.query<Row>("SELECT * FROM alert_rules WHERE workspace_id=$1 AND enabled AND deleted_at IS NULL", [context.workspaceId])).rows.map(ruleRecord);
      let created = 0;
      let changed = 0;
      const seen = [...unique.keys()];
      for (const role of unique.values()) {
        const contentHash = roleHash(role);
        const alias = await tx.query<Row>(`SELECT a.*,p.content_hash AS posting_hash,p.availability AS posting_availability,p.first_seen_at AS posting_first_seen_at
          FROM discovery_posting_aliases a JOIN discovered_postings p ON p.workspace_id=a.workspace_id AND p.id=a.discovered_posting_id
          WHERE a.workspace_id=$1 AND a.source_id=$2 AND a.external_id=$3 FOR UPDATE`, [context.workspaceId, claim.source.id, role.externalId]);
        let postingId = stringValue(alias.rows[0] ?? {}, "discovered_posting_id");
        const previousHash = stringValue(alias.rows[0] ?? {}, "content_hash");
        const priorAvailability = stringValue(alias.rows[0] ?? {}, "availability");
        let eventType: "new_match" | "posting_changed" | null = null;
        if (!postingId) {
          const existing = await tx.query<{ id: string }>(`SELECT id FROM discovered_postings
            WHERE workspace_id=$1 AND deleted_at IS NULL AND (canonical_url=$2 OR apply_url=$3) ORDER BY first_seen_at LIMIT 1 FOR UPDATE`,
          [context.workspaceId, role.canonicalUrl, role.applyUrl ?? role.canonicalUrl]);
          postingId = existing.rows[0]?.id ?? randomUUID();
          if (!existing.rows[0]) {
            await tx.query(`INSERT INTO discovered_postings
              (id,workspace_id,source_id,external_id,canonical_url,apply_url,company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,source_posted_at,source_updated_at,deadline_at,first_seen_at,last_seen_at,last_checked_at,availability,content_hash)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),now(),now(),'Open',$21)`, [
              postingId, context.workspaceId, claim.source.id, role.externalId, role.canonicalUrl, role.applyUrl ?? role.canonicalUrl,
              role.companyName, role.title, role.location ?? "", role.programme ?? "", role.sector ?? "", role.firmType ?? "",
              role.roleFamily ?? "", role.workMode ?? "Not stated", role.sponsorship ?? "Not stated", role.side ?? "unknown",
              role.description ?? "", role.sourcePostedAt ?? null, role.sourceUpdatedAt ?? null, role.deadlineAt ?? null, contentHash,
            ]);
            created += 1;
            eventType = "new_match";
          }
          await tx.query(`INSERT INTO discovery_posting_aliases
            (workspace_id,source_id,external_id,discovered_posting_id,first_seen_at,last_seen_at,last_checked_at,availability,content_hash)
            VALUES($1,$2,$3,$4,now(),now(),now(),'Open',$5)`, [context.workspaceId, claim.source.id, role.externalId, postingId, contentHash]);
        } else {
          const restored = priorAvailability !== "Open";
          if (previousHash !== contentHash) { changed += 1; eventType = "posting_changed"; }
          else if (restored) eventType = "posting_changed";
          await tx.query(`UPDATE discovery_posting_aliases SET last_seen_at=now(),last_checked_at=now(),removed_at=NULL,
            availability='Open',missing_count=0,content_hash=$4 WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3`,
          [context.workspaceId, claim.source.id, role.externalId, contentHash]);
        }
        await tx.query(`UPDATE discovered_postings SET canonical_url=$3,apply_url=$4,company_name=$5,title=$6,location=$7,
          programme=$8,sector=$9,firm_type=$10,role_family=$11,work_mode=$12,sponsorship=$13,side=$14,description=$15,
          source_posted_at=$16,source_updated_at=$17,deadline_at=$18,last_seen_at=now(),last_checked_at=now(),removed_at=NULL,availability='Open',
          missing_count=0,content_hash=$19,updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [
          context.workspaceId, postingId, role.canonicalUrl, role.applyUrl ?? role.canonicalUrl, role.companyName, role.title,
          role.location ?? "", role.programme ?? "", role.sector ?? "", role.firmType ?? "", role.roleFamily ?? "",
          role.workMode ?? "Not stated", role.sponsorship ?? "Not stated", role.side ?? "unknown", role.description ?? "",
          role.sourcePostedAt ?? null, role.sourceUpdatedAt ?? null, role.deadlineAt ?? null, contentHash,
        ]);
        await tx.query(`INSERT INTO discovery_observations(id,workspace_id,discovered_posting_id,discovery_run_id,state,content_hash,note)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), context.workspaceId, postingId, runId,
          eventType === "new_match" ? "Created" : priorAvailability && priorAvailability !== "Open" ? "Restored" : previousHash && previousHash !== contentHash ? "Changed" : "Checked",
          contentHash, ""]);
        if (eventType) await this.createMatchingAlerts(
          tx, context.workspaceId, postingId, role, rules, eventType,
          eventType === "posting_changed" ? runId : contentHash,
          new Date(alias.rows[0]?.posting_first_seen_at ? dateString(alias.rows[0].posting_first_seen_at) : Date.now()),
        );
        const deadlineAt = role.deadlineAt ? new Date(role.deadlineAt) : null;
        if (deadlineAt && deadlineAt.getTime() >= Date.now() && deadlineAt.getTime() <= Date.now() + 7 * 86_400_000) {
          await this.createMatchingAlerts(tx, context.workspaceId, postingId, role, rules, "deadline_soon", role.deadlineAt!, new Date());
        }
      }

      let missingCount = 0;
      if (inventoryComplete) {
        const missingRows = await tx.query<Row>(`SELECT * FROM discovery_posting_aliases WHERE workspace_id=$1 AND source_id=$2
          AND NOT (external_id=ANY($3::text[])) FOR UPDATE`, [context.workspaceId, claim.source.id, seen.length ? seen : ["__none__"]]);
        for (const alias of missingRows.rows) {
          const misses = Number(alias.missing_count ?? 0) + 1;
          const availability = misses >= 3 ? "Removed" : "Unknown";
          missingCount += 1;
          await tx.query(`UPDATE discovery_posting_aliases SET last_checked_at=now(),missing_count=$4,availability=$5,
            removed_at=CASE WHEN $5='Removed' THEN now() ELSE removed_at END WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3`,
          [context.workspaceId, claim.source.id, stringValue(alias, "external_id"), misses, availability]);
          const postingId = stringValue(alias, "discovered_posting_id");
          const aggregate = await tx.query<{ open_count: number; alias_count: number; maximum_missing: number }>(`SELECT
            count(*) FILTER (WHERE availability='Open')::int AS open_count,count(*)::int AS alias_count,max(missing_count)::int AS maximum_missing
            FROM discovery_posting_aliases WHERE workspace_id=$1 AND discovered_posting_id=$2`, [context.workspaceId, postingId]);
          const open = Number(aggregate.rows[0]?.open_count ?? 0) > 0;
          const nextAvailability = open ? "Open" : availability === "Removed" ? "Removed" : "Unknown";
          await tx.query(`UPDATE discovered_postings SET last_checked_at=now(),availability=$3,missing_count=$4,
            removed_at=CASE WHEN $3='Removed' THEN COALESCE(removed_at,now()) ELSE NULL END,updated_at=now(),revision=revision+1
            WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, postingId, nextAvailability, Number(aggregate.rows[0]?.maximum_missing ?? misses)]);
          await tx.query(`INSERT INTO discovery_observations(id,workspace_id,discovered_posting_id,discovery_run_id,state,content_hash,note)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), context.workspaceId, postingId, runId,
            availability === "Removed" ? "Removed" : "Missing", stringValue(alias, "content_hash"),
            `Missing from complete successful inventory ${misses} of 3.`]);
        }
      }
      const state = inventoryComplete ? "Completed" : "Partial";
      const completed = await tx.query<Row>(`UPDATE discovery_runs SET state=$3,completed_at=now(),
        duration_ms=GREATEST(0,extract(epoch from (now()-started_at))*1000)::int,found_count=$4,new_count=$5,changed_count=$6,missing_count=$7,error=$8
        WHERE workspace_id=$1 AND id=$2 RETURNING *`, [context.workspaceId, runId, state, unique.size, created, changed, missingCount, inventoryWarning]);
      await tx.query(`UPDATE discovery_sources SET last_checked_at=now(),last_successful_at=CASE WHEN $4 THEN now() ELSE last_successful_at END,last_error=$8,
        successful_inventory_count=$5,trusted_inventory_count=$5,candidate_inventory_count=$6,candidate_inventory_streak=$7,
        consecutive_failure_count=0,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3`, [
        context.workspaceId, claim.source.id, claim.leaseToken, inventoryComplete, nextTrustedInventory,
        abruptDrop && !adoptLowerBaseline ? unique.size : null, abruptDrop && !adoptLowerBaseline ? candidateStreak : 0, inventoryWarning,
      ]);
      return this.runRecord(completed.rows[0]!);
    });
  }

  async completeFailedRun(context: WorkspaceContext, claim: HostedDiscoveryClaim, error: unknown, _startedAt = new Date()): Promise<DiscoveryRunRecord> {
    const message = (error instanceof Error ? error.message : "Discovery source failed.").slice(0, 2_000);
    return this.transactions.transaction(context, async (tx) => {
      const source = await tx.query<Row>(`SELECT id FROM discovery_sources WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 FOR UPDATE`,
      [context.workspaceId, claim.source.id, claim.leaseToken]);
      if (!source.rows[0]) throw new Error("Discovery source lease was lost before failure recording.");
      const result = await tx.query<Row>(`UPDATE discovery_runs SET state='Failed',completed_at=now(),
        duration_ms=GREATEST(0,extract(epoch from (now()-started_at))*1000)::int,error=$5
        WHERE workspace_id=$1 AND id=$2 AND source_id=$3 AND lease_token=$4 AND state='Running' RETURNING *`,
      [context.workspaceId, claim.runId, claim.source.id, claim.leaseToken, message]);
      if (!result.rows[0]) throw new Error("Discovery run is no longer active.");
      await tx.query(`UPDATE discovery_sources SET last_checked_at=now(),last_error=$4,
        consecutive_failure_count=consecutive_failure_count+1,
        next_attempt_at=now()+LEAST(1440,check_interval_minutes*power(2,LEAST(consecutive_failure_count+1,6))) * interval '1 minute',
        lease_token=NULL,lease_until=NULL,
        updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3`,
      [context.workspaceId, claim.source.id, claim.leaseToken, message]);
      return this.runRecord(result.rows[0]!);
    });
  }

  async reportIssue(context: WorkspaceContext, postingId: string, reason: string) {
    return this.transactions.transaction(context, async (tx) => {
      const result = await tx.query<{ id: string; created_at: Date }>(`INSERT INTO discovery_issues
        (id,workspace_id,discovered_posting_id,reason) SELECT $1,$2,id,$4 FROM discovered_postings
        WHERE workspace_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING id,created_at`,
      [randomUUID(), context.workspaceId, postingId, reason.slice(0, 2_000)]);
      if (!result.rows[0]) throw new Error("Discovered posting was not found.");
      return { id: result.rows[0].id, createdAt: dateString(result.rows[0].created_at) };
    });
  }

  async createTestAlert(context: WorkspaceContext, directUrl = "https://example.com/careeros-test") {
    const safeUrl = normalizeUrl(directUrl);
    return this.transactions.transaction(context, async (tx) => {
      const eventId = randomUUID();
      const dedupe = hash({ workspaceId: context.workspaceId, eventId, eventType: "test" });
      await tx.query(`INSERT INTO alert_events
        (id,workspace_id,event_type,title,body,direct_url,deduplication_key)
        VALUES($1,$2,'test','CareerOS test alert',$3,$4,$5)`, [
        eventId, context.workspaceId,
        `Company: CareerOS\nRole: test alert\nLocation: not applicable\nDetected: ${new Date().toISOString()}\nReason: verify in-app and Telegram delivery.\nDirect link: ${safeUrl}`,
        safeUrl, dedupe,
      ]);
      const inAppId = randomUUID();
      await tx.query(`INSERT INTO notification_deliveries
        (id,workspace_id,alert_event_id,provider,state,attempt_count,provider_attempt_count,delivered_at)
        VALUES($1,$2,$3,'in_app','Delivered',1,1,now())`, [inAppId, context.workspaceId, eventId]);
      await tx.query(`INSERT INTO notification_delivery_attempts
        (id,workspace_id,delivery_id,sequence,state,started_at,completed_at) VALUES($1,$2,$3,1,'Delivered',now(),now())`,
      [randomUUID(), context.workspaceId, inAppId]);
      const telegramId = randomUUID();
      await tx.query(`INSERT INTO notification_deliveries
        (id,workspace_id,alert_event_id,provider,state,next_attempt_at) VALUES($1,$2,$3,'telegram','Pending',now())`,
      [telegramId, context.workspaceId, eventId]);
      return { eventId, telegramDeliveryId: telegramId };
    });
  }

  async claimTelegramDeliveries(context: WorkspaceContext, options: { limit?: number; leaseSeconds?: number } = {}): Promise<HostedDeliveryClaim[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 600));
    return this.transactions.transaction(context, async (tx) => {
      const abandoned = await tx.query<Row>(`SELECT id,claimed_until FROM notification_deliveries WHERE workspace_id=$1
        AND provider='telegram' AND state='Sending' AND claimed_until<=now() FOR UPDATE SKIP LOCKED`, [context.workspaceId]);
      for (const row of abandoned.rows) {
        const deliveryId = stringValue(row, "id");
        const sequence = await nextAttemptSequence(tx, context.workspaceId, deliveryId);
        await tx.query(`UPDATE notification_deliveries SET state='Ambiguous',last_error=$3,claim_token=NULL,claimed_until=NULL,updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND state='Sending'`, [context.workspaceId, deliveryId, "The delivery lease expired; Telegram may already have received the message."]);
        await tx.query(`INSERT INTO notification_delivery_attempts
          (id,workspace_id,delivery_id,sequence,state,error,started_at,completed_at) VALUES($1,$2,$3,$4,'Ambiguous',$5,$6,now())`,
        [randomUUID(), context.workspaceId, deliveryId, sequence, "The prior worker stopped before recording Telegram's response.", dateString(row.claimed_until)]);
      }
      const claimed = await tx.query<Row>(`WITH due AS (
        SELECT id FROM notification_deliveries WHERE workspace_id=$1 AND provider='telegram' AND state='Pending'
          AND provider_attempt_count<3 AND (next_attempt_at IS NULL OR next_attempt_at<=now())
          AND (claim_token IS NULL OR claimed_until IS NULL OR claimed_until<=now())
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE notification_deliveries d SET state='Sending',claim_token=gen_random_uuid(),
        claimed_until=now()+$3*interval '1 second',attempt_count=attempt_count+1,provider_attempt_count=provider_attempt_count+1,updated_at=now()
        FROM due WHERE d.workspace_id=$1 AND d.id=due.id
        RETURNING d.id,d.claim_token,d.alert_event_id,d.provider_attempt_count`, [context.workspaceId, limit, leaseSeconds]);
      const output: HostedDeliveryClaim[] = [];
      for (const row of claimed.rows) {
        const alert = await tx.query<Row>("SELECT * FROM alert_events WHERE workspace_id=$1 AND id=$2", [context.workspaceId, stringValue(row, "alert_event_id")]);
        if (!alert.rows[0]) continue;
        const sequence = await nextAttemptSequence(tx, context.workspaceId, stringValue(row, "id"));
        await tx.query(`INSERT INTO notification_delivery_attempts
          (id,workspace_id,delivery_id,sequence,state,started_at) VALUES($1,$2,$3,$4,'Started',now())`,
        [randomUUID(), context.workspaceId, stringValue(row, "id"), sequence]);
        output.push({
          id: stringValue(row, "id"), claimToken: stringValue(row, "claim_token"), alertEventId: stringValue(row, "alert_event_id"),
          title: stringValue(alert.rows[0], "title"), body: stringValue(alert.rows[0], "body"),
          directUrl: stringValue(alert.rows[0], "direct_url"), deduplicationKey: stringValue(alert.rows[0], "deduplication_key"),
          providerAttempt: Number(row.provider_attempt_count),
        });
      }
      return output;
    });
  }

  async claimTelegramDelivery(context: WorkspaceContext, deliveryId: string, options: { leaseSeconds?: number } = {}): Promise<HostedDeliveryClaim | null> {
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 600));
    return this.transactions.transaction(context, async (tx) => {
      const claimed = await tx.query<Row>(`UPDATE notification_deliveries SET state='Sending',claim_token=gen_random_uuid(),
        claimed_until=now()+$3*interval '1 second',attempt_count=attempt_count+1,provider_attempt_count=provider_attempt_count+1,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND provider='telegram' AND state='Pending'
          AND provider_attempt_count<3 AND (next_attempt_at IS NULL OR next_attempt_at<=now())
          AND (claim_token IS NULL OR claimed_until IS NULL OR claimed_until<=now())
        RETURNING id,claim_token,alert_event_id,provider_attempt_count`, [context.workspaceId, deliveryId, leaseSeconds]);
      const row = claimed.rows[0];
      if (!row) return null;
      const alert = (await tx.query<Row>("SELECT * FROM alert_events WHERE workspace_id=$1 AND id=$2", [context.workspaceId, stringValue(row, "alert_event_id")])).rows[0];
      if (!alert) throw new Error("Telegram alert was not found for the requested delivery.");
      const sequence = await nextAttemptSequence(tx, context.workspaceId, deliveryId);
      await tx.query(`INSERT INTO notification_delivery_attempts
        (id,workspace_id,delivery_id,sequence,state,started_at) VALUES($1,$2,$3,$4,'Started',now())`,
      [randomUUID(), context.workspaceId, deliveryId, sequence]);
      return {
        id: deliveryId, claimToken: stringValue(row, "claim_token"), alertEventId: stringValue(row, "alert_event_id"),
        title: stringValue(alert, "title"), body: stringValue(alert, "body"), directUrl: stringValue(alert, "direct_url"),
        deduplicationKey: stringValue(alert, "deduplication_key"), providerAttempt: Number(row.provider_attempt_count),
      };
    });
  }

  async finishTelegramDelivery(context: WorkspaceContext, claim: HostedDeliveryClaim, providerMessageId = "") {
    return this.transactions.transaction(context, async (tx) => {
      const updated = await tx.query(`UPDATE notification_deliveries SET state='Delivered',last_error='',provider_message_id=$4,
        next_attempt_at=NULL,claim_token=NULL,claimed_until=NULL,delivered_at=now(),updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 AND state='Sending'`,
      [context.workspaceId, claim.id, claim.claimToken, providerMessageId]);
      if (updated.rowCount !== 1) throw new Error("Telegram delivery claim was lost before completion.");
      const sequence = await nextAttemptSequence(tx, context.workspaceId, claim.id);
      await tx.query(`INSERT INTO notification_delivery_attempts
        (id,workspace_id,delivery_id,sequence,state,provider_message_id,started_at,completed_at)
        VALUES($1,$2,$3,$4,'Delivered',$5,now(),now())`, [randomUUID(), context.workspaceId, claim.id, sequence, providerMessageId]);
    });
  }

  async failTelegramDelivery(context: WorkspaceContext, claim: HostedDeliveryClaim, failure: { kind: "retryable" | "permanent" | "ambiguous" | "configuration"; message: string; retryAfterMs?: number }) {
    return this.transactions.transaction(context, async (tx) => {
      const state = failure.kind === "ambiguous" ? "Ambiguous" : failure.kind === "configuration" ? "ConfigurationRequired"
        : failure.kind === "permanent" || claim.providerAttempt >= 3 ? "Failed" : "Pending";
      const retryAt = state === "Pending" ? new Date(Date.now() + (failure.retryAfterMs ?? claim.providerAttempt * 60_000)) : null;
      const updated = await tx.query(`UPDATE notification_deliveries SET state=$4,last_error=$5,next_attempt_at=$6,
        claim_token=NULL,claimed_until=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 AND state='Sending'`,
      [context.workspaceId, claim.id, claim.claimToken, state, failure.message.slice(0, 2_000), retryAt]);
      if (updated.rowCount !== 1) throw new Error("Telegram delivery claim was lost before failure recording.");
      const sequence = await nextAttemptSequence(tx, context.workspaceId, claim.id);
      const attemptState = state === "Ambiguous" ? "Ambiguous" : state === "ConfigurationRequired" ? "ConfigurationRequired" : "Failed";
      await tx.query(`INSERT INTO notification_delivery_attempts
        (id,workspace_id,delivery_id,sequence,state,error,retry_after_at,started_at,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now(),now())`,
      [randomUUID(), context.workspaceId, claim.id, sequence, attemptState, failure.message.slice(0, 2_000), retryAt]);
    });
  }

  async retryTelegramDelivery(context: WorkspaceContext, deliveryId: string, confirmPossibleDuplicate = false) {
    return this.transactions.transaction(context, async (tx) => {
      const current = await tx.query<Row>(`SELECT state FROM notification_deliveries WHERE workspace_id=$1 AND id=$2 AND provider='telegram' FOR UPDATE`,
      [context.workspaceId, deliveryId]);
      if (!current.rows[0]) throw new Error("Telegram delivery was not found.");
      if (current.rows[0].state === "Ambiguous" && !confirmPossibleDuplicate) throw new Error("Telegram may already have delivered this alert. Confirm before retrying.");
      const reset = await tx.query(`UPDATE notification_deliveries SET state='Pending',provider_attempt_count=0,next_attempt_at=now(),claim_token=NULL,claimed_until=NULL,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND state IN ('Failed','Ambiguous','ConfigurationRequired')`, [context.workspaceId, deliveryId]);
      if (reset.rowCount !== 1) throw new Error("This Telegram delivery is already pending or being sent.");
    });
  }

  private async createMatchingAlerts(tx: QueryExecutor, workspaceId: string, postingId: string, role: HostedRoleObservation, rules: AlertRuleRecord[], eventType: "new_match" | "posting_changed" | "deadline_soon", version: string, detectedAt: Date) {
    const directUrl = normalizeUrl(role.applyUrl || role.canonicalUrl);
    for (const rule of rules) {
      // Freshness limits discovery noise for newly detected roles. A material
      // employer change is actionable regardless of when CareerOS first saw it.
      if (!matchesRule(role, rule, detectedAt, eventType === "new_match")) continue;
      const dedupe = hash({ workspaceId, ruleId: rule.id, postingId, eventType, version });
      const eventId = randomUUID();
      const reason = eventType === "new_match" ? `New role matched alert rule “${rule.name}”.`
        : eventType === "posting_changed" ? `The employer changed this posting; it matches alert rule “${rule.name}”.`
        : `Deadline ${new Date(role.deadlineAt!).toLocaleDateString("en-GB")} is within 7 days; matched alert rule “${rule.name}”.`;
      const title = eventType === "deadline_soon" ? `${role.companyName}: deadline soon` : `${role.companyName}: ${role.title}`;
      const body = [`Company: ${role.companyName}`, `Role: ${role.title}`, `Location: ${role.location || "Not listed"}`, `Detected: ${detectedAt.toISOString()}`, `Reason: ${reason}`, `Direct link: ${directUrl}`].join("\n");
      const inserted = await tx.query<{ id: string }>(`INSERT INTO alert_events
        (id,workspace_id,rule_id,discovered_posting_id,event_type,title,body,direct_url,deduplication_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,deduplication_key) DO NOTHING RETURNING id`,
      [eventId, workspaceId, rule.id, postingId, eventType, title, body, directUrl, dedupe]);
      const persistedEventId = inserted.rows[0]?.id;
      if (!persistedEventId) continue;
      const inAppId = randomUUID();
      await tx.query(`INSERT INTO notification_deliveries
        (id,workspace_id,alert_event_id,provider,state,attempt_count,provider_attempt_count,delivered_at)
        VALUES($1,$2,$3,'in_app','Delivered',1,1,now())`, [inAppId, workspaceId, persistedEventId]);
      await tx.query(`INSERT INTO notification_delivery_attempts
        (id,workspace_id,delivery_id,sequence,state,started_at,completed_at) VALUES($1,$2,$3,1,'Delivered',now(),now())`,
      [randomUUID(), workspaceId, inAppId]);
      if (rule.telegramEnabled) await tx.query(`INSERT INTO notification_deliveries
        (id,workspace_id,alert_event_id,provider,state,next_attempt_at) VALUES($1,$2,$3,'telegram','Pending',now())
        ON CONFLICT(workspace_id,alert_event_id,provider) DO NOTHING`, [randomUUID(), workspaceId, persistedEventId]);
    }
  }

  private runRecord(row: Row): DiscoveryRunRecord {
    return {
      id: stringValue(row, "id"), sourceId: stringValue(row, "source_id"), state: stringValue(row, "state") as DiscoveryRunRecord["state"],
      startedAt: dateString(row.started_at), completedAt: row.completed_at == null ? null : dateString(row.completed_at),
      durationMs: Number(row.duration_ms ?? 0), foundCount: Number(row.found_count ?? 0), newCount: Number(row.new_count ?? 0),
      changedCount: Number(row.changed_count ?? 0), missingCount: Number(row.missing_count ?? 0), error: stringValue(row, "error"),
    };
  }
}
