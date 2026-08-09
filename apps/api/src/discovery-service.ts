import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AlertEventRecord,
  AlertRuleCreateInput,
  AlertRuleUpdateInput,
  AlertRuleRecord,
  DiscoveredPostingRecord,
  DiscoveryRunRecord,
  DiscoverySourceCreateInput,
  DiscoverySourceRecord,
  DiscoveryQuery,
  DiscoveryWorkspace,
  NotificationDeliveryAttemptRecord,
  NotificationDeliveryHistoryPage,
  NotificationDeliveryRecord,
} from "@careeros/contracts";
import {
  parseGreenhouseResponse,
  parseLeverResponse,
  reconcileDiscoveryRun,
  roleIdentityKey,
  sourceDeduplicationKey,
  type RoleObservation,
  type SourceRunResult,
} from "./discovery.js";
import { createTelegramProvider, TelegramDeliveryError } from "./notifications.js";

type Row = Record<string, unknown>;

const isoNow = () => new Date().toISOString();

export const financeStarterSources: DiscoverySourceCreateInput[] = [
  { name: "Schonfeld careers", kind: "greenhouse", companyName: "Schonfeld", sourceUrl: "https://boards-api.greenhouse.io/v1/boards/schonfeld/jobs?content=true", externalKey: "schonfeld", enabled: true, checkIntervalMinutes: 180 },
  { name: "Point72 careers", kind: "greenhouse", companyName: "Point72", sourceUrl: "https://boards-api.greenhouse.io/v1/boards/point72/jobs?content=true", externalKey: "point72", enabled: true, checkIntervalMinutes: 180 },
  { name: "Optiver careers", kind: "optiver", companyName: "Optiver", sourceUrl: "https://optiver.com/en/api/v1/jobs", externalKey: "optiver-official", enabled: true, checkIntervalMinutes: 180 },
  { name: "IMC careers", kind: "greenhouse", companyName: "IMC", sourceUrl: "https://boards-api.greenhouse.io/v1/boards/imc/jobs?content=true", externalKey: "imc", enabled: true, checkIntervalMinutes: 180 },
  { name: "DV Trading careers", kind: "greenhouse", companyName: "DV Trading", sourceUrl: "https://boards-api.greenhouse.io/v1/boards/dvtrading/jobs?content=true", externalKey: "dvtrading", enabled: true, checkIntervalMinutes: 180 },
  { name: "Wintermute careers", kind: "lever", companyName: "Wintermute", sourceUrl: "https://api.lever.co/v0/postings/wintermute-trading?mode=json", externalKey: "wintermute-trading", enabled: true, checkIntervalMinutes: 180 },
  { name: "Intropic careers", kind: "lever", companyName: "Intropic", sourceUrl: "https://api.lever.co/v0/postings/intropic?mode=json", externalKey: "intropic", enabled: true, checkIntervalMinutes: 180 },
];

function text(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function nullableText(row: Row, key: string): string | null {
  return row[key] == null ? null : String(row[key]);
}

function number(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function bool(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

function sourceRecord(row: Row): DiscoverySourceRecord {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    kind: text(row, "kind") as DiscoverySourceRecord["kind"],
    companyName: text(row, "company_name"),
    sourceUrl: text(row, "source_url"),
    externalKey: text(row, "external_key"),
    enabled: bool(row, "enabled"),
    checkIntervalMinutes: number(row, "check_interval_minutes"),
    lastCheckedAt: nullableText(row, "last_checked_at"),
    lastSuccessfulAt: nullableText(row, "last_successful_at"),
    lastError: text(row, "last_error"),
    successfulInventoryCount: number(row, "successful_inventory_count"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    revision: number(row, "revision"),
  };
}

function runRecord(row: Row): DiscoveryRunRecord {
  return {
    id: text(row, "id"),
    sourceId: text(row, "source_id"),
    state: text(row, "state") as DiscoveryRunRecord["state"],
    startedAt: text(row, "started_at"),
    completedAt: nullableText(row, "completed_at"),
    durationMs: number(row, "duration_ms"),
    foundCount: number(row, "found_count"),
    newCount: number(row, "new_count"),
    changedCount: number(row, "changed_count"),
    missingCount: number(row, "missing_count"),
    error: text(row, "error"),
  };
}

function postingRecord(row: Row): DiscoveredPostingRecord {
  const roleFamily = text(row, "role_family");
  const side = text(row, "side") as DiscoveredPostingRecord["side"];
  return {
    id: text(row, "id"),
    sourceId: text(row, "source_id"),
    externalId: text(row, "external_id"),
    canonicalUrl: text(row, "canonical_url"),
    applyUrl: text(row, "apply_url"),
    companyName: text(row, "company_name"),
    title: text(row, "title"),
    location: text(row, "location"),
    programme: text(row, "programme"),
    sector: text(row, "sector"),
    firmType: text(row, "firm_type"),
    roleFamily,
    careerTrack: inferCareerTrack(roleFamily, side),
    workMode: text(row, "work_mode") || "Not stated",
    sponsorship: text(row, "sponsorship") || "Not stated",
    side,
    description: text(row, "description"),
    sourcePostedAt: nullableText(row, "source_posted_at"),
    sourceUpdatedAt: nullableText(row, "source_updated_at"),
    deadlineAt: nullableText(row, "deadline_at"),
    firstSeenAt: text(row, "first_seen_at"),
    lastSeenAt: text(row, "last_seen_at"),
    lastCheckedAt: text(row, "last_checked_at"),
    removedAt: nullableText(row, "removed_at"),
    availability: text(row, "availability") as DiscoveredPostingRecord["availability"],
    missingCount: number(row, "missing_count"),
    contentHash: text(row, "content_hash"),
    savedJobPostingId: nullableText(row, "saved_job_posting_id"),
    hiddenAt: nullableText(row, "hidden_at"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    revision: number(row, "revision"),
  };
}

function ruleRecord(row: Row): AlertRuleRecord {
  const criteria = parseJson<Omit<AlertRuleCreateInput, "name" | "enabled" | "telegramEnabled">>(row.criteria_json, {
    companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: [], newWithinHours: 24,
  });
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    enabled: bool(row, "enabled"),
    telegramEnabled: bool(row, "telegram_enabled"),
    ...criteria,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    revision: number(row, "revision"),
  };
}

function attemptRecord(row: Row): NotificationDeliveryAttemptRecord {
  return {
    id: text(row, "id"), deliveryId: text(row, "delivery_id"), sequence: number(row, "sequence"),
    state: text(row, "state") as NotificationDeliveryAttemptRecord["state"], error: text(row, "error"),
    providerMessageId: text(row, "provider_message_id"), retryAfterAt: nullableText(row, "retry_after_at"),
    startedAt: text(row, "started_at"), completedAt: nullableText(row, "completed_at"),
  };
}

function deliveryRecord(sqlite: Database.Database, row: Row): NotificationDeliveryRecord {
  const attempts = sqlite.prepare("SELECT * FROM notification_delivery_attempts WHERE delivery_id=? ORDER BY sequence DESC").all(text(row, "id")) as Row[];
  return {
    id: text(row, "id"), alertEventId: text(row, "alert_event_id"),
    provider: text(row, "provider") as NotificationDeliveryRecord["provider"],
    state: text(row, "state") as NotificationDeliveryRecord["state"],
    attemptCount: number(row, "attempt_count"), lastError: text(row, "last_error"),
    deliveredAt: nullableText(row, "delivered_at"), createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
    attempts: attempts.map(attemptRecord),
  };
}

function eventRecord(sqlite: Database.Database, row: Row): AlertEventRecord {
  const deliveries = sqlite.prepare("SELECT * FROM notification_deliveries WHERE alert_event_id = ? ORDER BY created_at").all(text(row, "id")) as Row[];
  return {
    id: text(row, "id"), ruleId: nullableText(row, "rule_id"), discoveredPostingId: nullableText(row, "discovered_posting_id"),
    eventType: text(row, "event_type") as AlertEventRecord["eventType"], title: text(row, "title"), body: text(row, "body"),
    directUrl: text(row, "direct_url"), deduplicationKey: text(row, "deduplication_key"), readAt: nullableText(row, "read_at"),
    createdAt: text(row, "created_at"), deliveries: deliveries.map((delivery) => deliveryRecord(sqlite, delivery)),
  };
}

function contentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function roleContentHash(role: RoleObservation) {
  return contentHash({
    title: role.title, location: role.location, team: role.team, employmentType: role.employmentType,
    description: role.description,
    postedAt: role.postedAt, deadlineAt: role.deadlineAt,
  });
}

function identityUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|source$|ref$|gh_src$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function inferProgramme(title: string) {
  const value = title.toLowerCase();
  if (/spring week|insight week/.test(value)) return "Spring week";
  if (/off[- ]?cycle/.test(value)) return "Off-cycle";
  if (/industrial placement|year in industry|sandwich year|placement (?:student|programme|year)|12[- ]month placement/.test(value)) return "Placement";
  if (/graduate|new grad|analyst programme/.test(value)) return "Graduate";
  if (/intern|summer/.test(value)) return "Internship";
  if (/entry[- ]level|junior|early career|analyst i\b|associate i\b/.test(value)) return "Entry-level";
  return "";
}

function inferCareerTrack(roleFamily: string, side: DiscoveredPostingRecord["side"]) {
  if (roleFamily === "Quantitative research") return "Quantitative finance";
  if (roleFamily === "Trading") return "Trading & markets";
  if (roleFamily === "Engineering") return "Technology";
  if (["Risk", "Finance", "Legal & compliance"].includes(roleFamily)) return "Financial institutions";
  if (side === "buy_side") return "Buy side";
  if (side === "sell_side") return "Sell side";
  return "Business & operations";
}

function identityPart(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function roleIdentitySignature(company: string, title: string, location: string) {
  return [company, title, location].map(identityPart).join("|");
}

function requisitionKey(value: string) {
  const key = identityPart(value).replaceAll(" ", "");
  return key.length >= 4 ? key : "";
}

function descriptionSimilarity(left: string, right: string) {
  const tokens = (value: string) => new Set(identityPart(value).split(" ").filter((item) => item.length > 2));
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / Math.max(a.size, b.size);
}

function careerTrackSql() {
  return `CASE
    WHEN role_family='Quantitative research' THEN 'Quantitative finance'
    WHEN role_family='Trading' THEN 'Trading & markets'
    WHEN role_family='Engineering' THEN 'Technology'
    WHEN role_family IN ('Risk','Finance','Legal & compliance') THEN 'Financial institutions'
    WHEN side='buy_side' THEN 'Buy side'
    WHEN side='sell_side' THEN 'Sell side'
    ELSE 'Business & operations' END`;
}

type FetchedSourceResult = (SourceRunResult & { organization: string }) & { expectedCount?: number; inventoryComplete?: boolean };

function inferSide(company: string, title: string): DiscoveredPostingRecord["side"] {
  const value = `${company} ${title}`.toLowerCase();
  if (/point72|schonfeld|asset management|hedge fund|private equity|venture capital|investment management/.test(value)) return "buy_side";
  if (/optiver|imc|dv trading|wintermute|intropic|market maker|proprietary trading|sales and trading|investment bank|capital markets|markets analyst/.test(value)) return "sell_side";
  return "unknown";
}

function inferClassifications(company: string, title: string, description: string, team = "") {
  const value = `${company} ${title} ${description} ${team}`.toLowerCase();
  const firmType = /optiver|imc|dv trading|wintermute|market mak|proprietary trad/.test(value) ? "Market maker / proprietary trading"
    : /point72|schonfeld|hedge fund/.test(value) ? "Hedge fund"
      : /asset management|investment management/.test(value) ? "Asset manager"
        : /private equity/.test(value) ? "Private equity"
          : /investment bank|capital markets|sales and trading/.test(value) ? "Investment bank"
            : "Financial services";
  const roleFamily = /quant|research scientist|researcher/.test(value) ? "Quantitative research"
    : /trader|trading|market maker/.test(value) ? "Trading"
      : /software|engineer|developer|technology|platform|data/.test(value) ? "Engineering"
        : /risk/.test(value) ? "Risk"
          : /finance|account|treasury/.test(value) ? "Finance"
            : /operations|procurement/.test(value) ? "Operations"
              : /recruit|human resources|talent/.test(value) ? "People"
                : /legal|compliance/.test(value) ? "Legal & compliance"
                  : "Business";
  const sector = /technology|software|engineer|developer|data|platform/.test(value) ? "Technology"
    : /risk|legal|compliance|finance|account|treasury/.test(value) ? "Risk, finance & legal"
      : "Financial services";
  const workMode = /\bhybrid\b/.test(value) ? "Hybrid" : /\bremote\b|work from home/.test(value) ? "Remote" : /\bon[- ]?site\b|in[- ]office/.test(value) ? "On-site" : "Not stated";
  const sponsorship = /(?:no|not|without)\s+(?:visa\s+)?sponsor|unable to sponsor|must (?:already )?have (?:the )?right to work/.test(value) ? "No"
    : /visa sponsorship|sponsorship (?:is )?(?:available|provided)|will sponsor/.test(value) ? "Yes"
      : "Not stated";
  return { firmType, roleFamily, sector, workMode, sponsorship };
}

function assertSourceUrl(source: DiscoverySourceRecord) {
  const url = new URL(source.sourceUrl);
  if (process.env.NODE_ENV === "test" && process.env.CAREEROS_E2E_DISCOVERY_BASE_URL) {
    const allowed = new URL(process.env.CAREEROS_E2E_DISCOVERY_BASE_URL);
    if (url.origin === allowed.origin) return;
  }
  if (url.protocol !== "https:") throw new Error("Discovery sources must use HTTPS.");
  const host = url.hostname.toLowerCase();
  if (source.kind === "greenhouse" && host !== "boards-api.greenhouse.io") throw new Error("Greenhouse sources must use the public boards-api.greenhouse.io endpoint.");
  if (source.kind === "lever" && host !== "api.lever.co") throw new Error("Lever sources must use the public api.lever.co endpoint.");
  if (source.kind === "optiver" && (host !== "optiver.com" || url.pathname !== "/en/api/v1/jobs")) throw new Error("Optiver sources must use its approved official jobs endpoint.");
  if (source.kind === "public_page") throw new Error("Public page monitoring is not enabled yet; add an approved Greenhouse or Lever source.");
}

async function fetchSource(source: DiscoverySourceRecord): Promise<FetchedSourceResult> {
  try {
    assertSourceUrl(source);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      if (source.kind === "optiver") {
        const roles: RoleObservation[] = [];
        let totalBytes = 0;
        let from = 0;
        let total = 1;
        let rawItemCount = 0;
        let declaredTotal: number | null = null;
        while (from < total && from < 1_000) {
          const pageUrl = new URL(source.sourceUrl);
          pageUrl.searchParams.set("from", String(from));
          pageUrl.searchParams.set("size", "16");
          const response = await fetch(pageUrl, { signal: controller.signal, headers: { accept: "application/json" } });
          if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
          const raw = await response.text();
          totalBytes += raw.length;
          if (totalBytes > 5_000_000) throw new Error("Source response is too large.");
          const payload = JSON.parse(raw) as { items?: Array<Record<string, unknown>>; totalCount?: number };
          const items = Array.isArray(payload.items) ? payload.items : [];
          const pageTotal = Number(payload.totalCount);
          if (!Number.isInteger(pageTotal) || pageTotal < 0 || pageTotal > 1_000) throw new Error("Incomplete inventory: Optiver returned an invalid totalCount.");
          if (declaredTotal !== null && declaredTotal !== pageTotal) throw new Error("Incomplete inventory: Optiver changed totalCount while pages were being read.");
          declaredTotal = pageTotal;
          total = pageTotal;
          rawItemCount += items.length;
          for (const item of items) {
            const title = String(item.title ?? "").trim();
            const href = String(item.href ?? "").trim();
            const externalId = String(item.componentID ?? href);
            if (!title || !href || !externalId) continue;
            const sourceUrl = new URL(href, "https://optiver.com").toString();
            const base = {
              sourceId: source.id, provider: source.kind, externalId, organization: source.companyName, title,
              location: String(item.location ?? ""), team: String(item.domain ?? ""), employmentType: String(item.experience ?? ""),
              description: [item.domain, item.experience].filter(Boolean).join(". "), sourceUrl, applyUrl: sourceUrl,
              postedAt: null, deadlineAt: null, sourceKey: sourceDeduplicationKey(source.id, externalId), status: "open" as const,
              firstSeenAt: isoNow(), lastSeenAt: isoNow(), missingRuns: 0, closedAt: null,
            };
            roles.push({ ...base, identityKey: roleIdentityKey(base) });
          }
          if (!items.length && from < total) throw new Error(`Incomplete inventory: Optiver stopped at ${from} of ${total} declared roles.`);
          from += items.length;
        }
        if (rawItemCount !== total || roles.length !== total) throw new Error(`Incomplete inventory: Optiver returned ${roles.length} valid roles for totalCount ${total}.`);
        return { sourceId: source.id, provider: source.kind, organization: source.companyName, ok: true, roles, expectedCount: total, inventoryComplete: true };
      }
      const response = await fetch(source.sourceUrl, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > 5_000_000) throw new Error("Source response is too large.");
      const raw = await response.text();
      if (raw.length > 5_000_000) throw new Error("Source response is too large.");
      const payload = JSON.parse(raw) as unknown;
      const roles = source.kind === "greenhouse" ? parseGreenhouseResponse(payload) : parseLeverResponse(payload);
      return { sourceId: source.id, provider: source.kind, organization: source.companyName, ok: true, roles, expectedCount: roles.length, inventoryComplete: true };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { sourceId: source.id, provider: source.kind, organization: source.companyName, ok: false, error: error instanceof Error ? error.message : "Discovery failed." };
  }
}

function previousObservations(rows: Row[]): RoleObservation[] {
  return rows.map((row) => {
    const base = {
    sourceId: text(row, "observed_source_id") || text(row, "source_id"), provider: text(row, "kind"), externalId: text(row, "observed_external_id") || text(row, "external_id"),
    organization: text(row, "company_name"), title: text(row, "title"), location: text(row, "location"), team: "",
    employmentType: "", description: text(row, "description"), sourceUrl: text(row, "canonical_url"), applyUrl: text(row, "apply_url"),
    postedAt: nullableText(row, "source_posted_at"), deadlineAt: nullableText(row, "deadline_at"), sourceKey: sourceDeduplicationKey(text(row, "observed_source_id") || text(row, "source_id"), text(row, "observed_external_id") || text(row, "external_id")),
    status: text(row, "alias_availability") === "Removed" ? "closed" as const : number(row, "alias_missing_count") ? "missing" as const : "open" as const,
    firstSeenAt: text(row, "alias_first_seen_at") || text(row, "first_seen_at"), lastSeenAt: text(row, "alias_last_seen_at") || text(row, "last_seen_at"), missingRuns: number(row, "alias_missing_count"),
    closedAt: nullableText(row, "alias_removed_at"),
    };
    return { ...base, identityKey: roleIdentityKey(base) };
  });
}

function includes(value: string, candidates: string[]) {
  const lower = value.toLowerCase();
  return candidates.some((candidate) => lower.includes(candidate.toLowerCase()));
}

function matchesRule(posting: DiscoveredPostingRecord, rule: AlertRuleRecord, requireFresh = true) {
  if (!rule.enabled) return false;
  if (rule.companies.length && !includes(posting.companyName, rule.companies)) return false;
  if (rule.side !== "either" && posting.side !== rule.side) return false;
  if (rule.roleFamilies.length && !includes(`${posting.roleFamily} ${posting.title}`, rule.roleFamilies)) return false;
  if (rule.programmes.length && !includes(`${posting.programme} ${posting.title}`, rule.programmes)) return false;
  if (rule.locations.length && !includes(posting.location, rule.locations)) return false;
  if (rule.keywords.length && !includes(`${posting.title} ${posting.description}`, rule.keywords)) return false;
  return !requireFresh || Date.now() - new Date(posting.firstSeenAt).getTime() <= rule.newWithinHours * 3_600_000;
}

export class DiscoveryService {
  readonly #activeRuns = new Map<string, Promise<DiscoveryRunRecord>>();
  #deliveryDispatchScheduled = false;
  readonly #leaseDurationMs: number;
  readonly #heartbeatMs: number;
  readonly #deliveryConcurrency: number;
  readonly #deliveryLeaseMs: number;
  readonly #runMutation: <T>(work: () => Promise<T> | T) => Promise<T>;
  constructor(private readonly sqlite: Database.Database, options: { leaseDurationMs?: number; heartbeatMs?: number; deliveryConcurrency?: number; deliveryLeaseMs?: number; runMutation?: <T>(work: () => Promise<T> | T) => Promise<T> } = {}) {
    this.#leaseDurationMs = options.leaseDurationMs ?? 2 * 60_000;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#deliveryConcurrency = Math.max(1, options.deliveryConcurrency ?? 4);
    this.#deliveryLeaseMs = Math.max(1_000, options.deliveryLeaseMs ?? 30_000);
    this.#runMutation = options.runMutation ?? (async (work) => work());
    this.sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS discovered_postings_fts USING fts5(
        posting_id UNINDEXED, company_name, title, location, programme, role_family, sector, firm_type, description,
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS discovered_postings_fts_insert AFTER INSERT ON discovered_postings BEGIN
        INSERT INTO discovered_postings_fts(posting_id,company_name,title,location,programme,role_family,sector,firm_type,description)
        VALUES(new.id,new.company_name,new.title,new.location,new.programme,new.role_family,new.sector,new.firm_type,new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS discovered_postings_fts_update AFTER UPDATE ON discovered_postings BEGIN
        DELETE FROM discovered_postings_fts WHERE posting_id=old.id;
        INSERT INTO discovered_postings_fts(posting_id,company_name,title,location,programme,role_family,sector,firm_type,description)
        VALUES(new.id,new.company_name,new.title,new.location,new.programme,new.role_family,new.sector,new.firm_type,new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS discovered_postings_fts_delete AFTER DELETE ON discovered_postings BEGIN
        DELETE FROM discovered_postings_fts WHERE posting_id=old.id;
      END;
      INSERT INTO discovered_postings_fts(posting_id,company_name,title,location,programme,role_family,sector,firm_type,description)
      SELECT p.id,p.company_name,p.title,p.location,p.programme,p.role_family,p.sector,p.firm_type,p.description
      FROM discovered_postings p WHERE NOT EXISTS (SELECT 1 FROM discovered_postings_fts f WHERE f.posting_id=p.id);
    `);
    const timestamp = isoNow();
    const abandoned = this.sqlite.prepare("SELECT id FROM notification_deliveries WHERE provider='telegram' AND state='Sending' AND claimed_until<=?").all(timestamp) as Row[];
    this.sqlite.transaction(() => {
      for (const row of abandoned) {
        const deliveryId = text(row, "id");
        this.sqlite.prepare(`UPDATE notification_deliveries SET state='Ambiguous',last_error=?,claim_token=NULL,claimed_until=NULL,updated_at=? WHERE id=? AND state='Sending'`)
          .run("CareerOS restarted while Telegram was processing this message. It may already have been delivered.", timestamp, deliveryId);
        this.recordAttempt(deliveryId, "Ambiguous", timestamp, "CareerOS restarted before Telegram's response could be recorded.");
      }
    })();
  }

  createSource(input: DiscoverySourceCreateInput): DiscoverySourceRecord {
    const timestamp = isoNow();
    const id = randomUUID();
    const candidate = { id, ...input, lastCheckedAt: null, lastSuccessfulAt: null, lastError: "", successfulInventoryCount: 0, createdAt: timestamp, updatedAt: timestamp, revision: 1 } satisfies DiscoverySourceRecord;
    assertSourceUrl(candidate);
    this.sqlite.prepare(`INSERT INTO discovery_sources (id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes,last_error,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      id, input.name, input.kind, input.companyName, input.sourceUrl, input.externalKey, input.enabled ? 1 : 0, input.checkIntervalMinutes, "", timestamp, timestamp,
    );
    return candidate;
  }

  seedFinanceSources() {
    const optiver = financeStarterSources.find((item) => item.kind === "optiver");
    if (optiver) {
      this.sqlite.prepare(`UPDATE discovery_sources SET kind=?,source_url=?,external_key=?,updated_at=?,revision=revision+1
        WHERE lower(company_name)='optiver' AND (kind<>? OR source_url<>? OR external_key<>?) AND deleted_at IS NULL`).run(
        optiver.kind, optiver.sourceUrl, optiver.externalKey, isoNow(), optiver.kind, optiver.sourceUrl, optiver.externalKey,
      );
    }
    const existing = new Set((this.sqlite.prepare("SELECT source_url FROM discovery_sources WHERE deleted_at IS NULL").all() as Row[]).map((row) => text(row, "source_url")));
    const created: DiscoverySourceRecord[] = [];
    for (const input of financeStarterSources) if (!existing.has(input.sourceUrl)) created.push(this.createSource(input));
    return created;
  }

  createRule(input: AlertRuleCreateInput): AlertRuleRecord {
    const timestamp = isoNow();
    const id = randomUUID();
    const { name, enabled, telegramEnabled, ...criteria } = input;
    this.sqlite.prepare(`INSERT INTO alert_rules (id,name,enabled,criteria_json,telegram_enabled,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,1)`).run(
      id, name, enabled ? 1 : 0, JSON.stringify(criteria), telegramEnabled ? 1 : 0, timestamp, timestamp,
    );
    return { id, ...input, createdAt: timestamp, updatedAt: timestamp, revision: 1 };
  }

  updateRule(id: string, input: AlertRuleUpdateInput): AlertRuleRecord | null {
    const existingRow = this.sqlite.prepare("SELECT * FROM alert_rules WHERE id=? AND deleted_at IS NULL").get(id) as Row | undefined;
    if (!existingRow) return null;
    const existing = ruleRecord(existingRow);
    const { expectedRevision, ...changes } = input;
    const updated: AlertRuleCreateInput = {
      name: changes.name ?? existing.name,
      enabled: changes.enabled ?? existing.enabled,
      companies: changes.companies ?? existing.companies,
      side: changes.side ?? existing.side,
      roleFamilies: changes.roleFamilies ?? existing.roleFamilies,
      programmes: changes.programmes ?? existing.programmes,
      locations: changes.locations ?? existing.locations,
      keywords: changes.keywords ?? existing.keywords,
      newWithinHours: changes.newWithinHours ?? existing.newWithinHours,
      telegramEnabled: changes.telegramEnabled ?? existing.telegramEnabled,
    };
    const { name, enabled, telegramEnabled, ...criteria } = updated;
    const timestamp = isoNow();
    const result = this.sqlite.prepare(`UPDATE alert_rules SET name=?,enabled=?,criteria_json=?,telegram_enabled=?,updated_at=?,revision=revision+1
      WHERE id=? AND deleted_at IS NULL AND revision=?`).run(name, enabled ? 1 : 0, JSON.stringify(criteria), telegramEnabled ? 1 : 0, timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new Error("Alert rule changed since it was opened. Refresh and try again.");
    return ruleRecord(this.sqlite.prepare("SELECT * FROM alert_rules WHERE id=?").get(id) as Row);
  }

  deleteRule(id: string, expectedRevision: number): boolean {
    const timestamp = isoNow();
    const result = this.sqlite.prepare(`UPDATE alert_rules SET deleted_at=?,updated_at=?,revision=revision+1
      WHERE id=? AND deleted_at IS NULL AND revision=?`).run(timestamp, timestamp, id, expectedRevision);
    if (result.changes !== 1) {
      const exists = this.sqlite.prepare("SELECT 1 FROM alert_rules WHERE id=? AND deleted_at IS NULL").get(id);
      if (!exists) return false;
      throw new Error("Alert rule changed since it was opened. Refresh and try again.");
    }
    return true;
  }

  markAlertRead(id: string, read: boolean): AlertEventRecord | null {
    const result = this.sqlite.prepare("UPDATE alert_events SET read_at=? WHERE id=?").run(read ? isoNow() : null, id);
    if (result.changes !== 1) return null;
    return eventRecord(this.sqlite, this.sqlite.prepare("SELECT * FROM alert_events WHERE id=?").get(id) as Row);
  }

  workspace(query: DiscoveryQuery = { limit: 100 }): DiscoveryWorkspace {
    const where = ["deleted_at IS NULL"];
    const params: Array<string | number> = [];
    const addExact = (column: string, value?: string) => {
      if (!value) return;
      where.push(`${column} = ?`);
      params.push(value);
    };
    if (!query.showHidden) where.push("hidden_at IS NULL");
    if (query.q) {
      const tokens = query.q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
      if (tokens.length) {
        where.push("id IN (SELECT posting_id FROM discovered_postings_fts WHERE discovered_postings_fts MATCH ?)");
        params.push(tokens.map((token) => `\"${token.replaceAll('"', '""')}\"*`).join(" AND "));
      } else {
        where.push("0=1");
      }
    }
    addExact("side", query.side);
    addExact("programme", query.programme);
    addExact("sector", query.sector);
    addExact("firm_type", query.firmType);
    addExact("role_family", query.roleFamily);
    if (query.careerTrack) { where.push(`${careerTrackSql()} = ?`); params.push(query.careerTrack); }
    addExact("work_mode", query.workMode);
    addExact("sponsorship", query.sponsorship);
    if (query.location) { where.push("location LIKE ? ESCAPE '\\'"); params.push(`%${query.location.replace(/[\\%_]/g, "\\$&")}%`); }
    if (query.tracked === "saved") where.push("saved_job_posting_id IS NOT NULL");
    if (query.tracked === "unsaved") where.push("saved_job_posting_id IS NULL");
    if (query.freshWithinHours) { where.push("first_seen_at >= ?"); params.push(new Date(Date.now() - query.freshWithinHours * 3_600_000).toISOString()); }
    if (query.deadlineSoon) { where.push("deadline_at > ? AND deadline_at <= ?"); params.push(isoNow(), new Date(Date.now() + 7 * 86_400_000).toISOString()); }
    const countWhere = where.join(" AND ");
    const postingTotal = Number((this.sqlite.prepare(`SELECT COUNT(*) AS count FROM discovered_postings WHERE ${countWhere}`).get(...params) as Row).count ?? 0);
    const openPostingTotal = Number((this.sqlite.prepare("SELECT COUNT(*) AS count FROM discovered_postings WHERE deleted_at IS NULL AND hidden_at IS NULL AND availability='Open'").get() as Row).count ?? 0);
    const pageWhere = [...where];
    const pageParams = [...params];
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as { firstSeenAt: string; id: string };
        if (cursor.firstSeenAt && cursor.id) {
          pageWhere.push("(first_seen_at < ? OR (first_seen_at = ? AND id < ?))");
          pageParams.push(cursor.firstSeenAt, cursor.firstSeenAt, cursor.id);
        }
      } catch {
        // Invalid cursors safely restart from the first page.
      }
    }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 200));
    const rows = this.sqlite.prepare(`SELECT * FROM discovered_postings WHERE ${pageWhere.join(" AND ")} ORDER BY first_seen_at DESC,id DESC LIMIT ?`).all(...pageParams, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const postings = page.map(postingRecord);
    const last = page.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ firstSeenAt: text(last, "first_seen_at"), id: text(last, "id") })).toString("base64url") : null;
    const sources = (this.sqlite.prepare("SELECT * FROM discovery_sources WHERE deleted_at IS NULL ORDER BY name").all() as Row[]).map(sourceRecord);
    const latestRuns = (this.sqlite.prepare("SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 100").all() as Row[]).map(runRecord);
    const alertRules = (this.sqlite.prepare("SELECT * FROM alert_rules WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as Row[]).map(ruleRecord);
    const alerts = (this.sqlite.prepare("SELECT * FROM alert_events ORDER BY created_at DESC LIMIT 100").all() as Row[]).map((row) => eventRecord(this.sqlite, row));
    return { postings, sources, latestRuns, alertRules, alerts, postingTotal, openPostingTotal, nextCursor };
  }

  listNotificationDeliveries(options: { limit?: number; cursor?: string } = {}): NotificationDeliveryHistoryPage {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const where = ["d.provider='telegram'"];
    const params: string[] = [];
    if (options.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
        if (cursor.createdAt && cursor.id) {
          where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
          params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
      } catch {
        // Invalid cursors safely restart from the newest delivery.
      }
    }
    const rows = this.sqlite.prepare(`SELECT d.*,e.title AS alert_title,e.direct_url,e.created_at AS alert_created_at
      FROM notification_deliveries d JOIN alert_events e ON e.id=d.alert_event_id
      WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`).all(...params, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        ...deliveryRecord(this.sqlite, row),
        alertTitle: text(row, "alert_title"), directUrl: text(row, "direct_url"), alertCreatedAt: text(row, "alert_created_at"),
      })),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: text(last, "created_at"), id: text(last, "id") })).toString("base64url")
        : null,
    };
  }

  getPosting(id: string): DiscoveredPostingRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM discovered_postings WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
    return row ? postingRecord(row) : null;
  }

  markSaved(id: string, jobPostingId: string) {
    this.sqlite.prepare("UPDATE discovered_postings SET saved_job_posting_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(jobPostingId, isoNow(), id);
  }

  setHidden(id: string, hidden: boolean): DiscoveredPostingRecord | null {
    const timestamp = isoNow();
    const result = this.sqlite.prepare("UPDATE discovered_postings SET hidden_at=?, updated_at=?, revision=revision+1 WHERE id=? AND deleted_at IS NULL")
      .run(hidden ? timestamp : null, timestamp, id);
    return result.changes === 1 ? this.getPosting(id) : null;
  }

  reportIssue(id: string, reason: string) {
    if (!this.getPosting(id)) return null;
    const createdAt = isoNow();
    const issueId = randomUUID();
    this.sqlite.prepare("INSERT INTO discovery_issues (id,discovered_posting_id,reason,state,created_at) VALUES (?,?,?,?,?)")
      .run(issueId, id, reason, "Open", createdAt);
    return { id: issueId, createdAt };
  }

  async run(sourceId?: string): Promise<DiscoveryRunRecord[]> {
    const rows = sourceId
      ? this.sqlite.prepare("SELECT * FROM discovery_sources WHERE id = ? AND enabled = 1 AND deleted_at IS NULL").all(sourceId) as Row[]
      : this.sqlite.prepare("SELECT * FROM discovery_sources WHERE enabled = 1 AND deleted_at IS NULL ORDER BY name").all() as Row[];
    const records = await this.runWithConcurrency(rows.map(sourceRecord));
    this.scheduleNotificationDelivery();
    return records;
  }

  async runDue(): Promise<DiscoveryRunRecord[]> {
    const rows = this.sqlite.prepare(`SELECT * FROM discovery_sources
      WHERE enabled=1 AND deleted_at IS NULL
        AND (last_checked_at IS NULL OR datetime(last_checked_at, '+' || check_interval_minutes || ' minutes') <= datetime('now'))
      ORDER BY COALESCE(last_checked_at, '') ASC`).all() as Row[];
    const records = await this.runWithConcurrency(rows.map(sourceRecord));
    this.scheduleNotificationDelivery();
    return records;
  }

  private scheduleNotificationDelivery() {
    if (this.#deliveryDispatchScheduled) return;
    this.#deliveryDispatchScheduled = true;
    const timer = setTimeout(() => {
      this.#deliveryDispatchScheduled = false;
      void this.processNotificationDeliveries().catch(() => {
        // Delivery state and safe error text are persisted by the worker for later retry.
      });
    }, 0);
    timer.unref();
  }

  async runOne(source: DiscoverySourceRecord): Promise<DiscoveryRunRecord> {
    const active = this.#activeRuns.get(source.id);
    if (active) return active;
    const run = this.#runMutation(() => this.executeRun(source)).finally(() => this.#activeRuns.delete(source.id));
    this.#activeRuns.set(source.id, run);
    return run;
  }

  private async runWithConcurrency(sources: DiscoverySourceRecord[], limit = 6) {
    const results: DiscoveryRunRecord[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, sources.length) }, async () => {
      while (cursor < sources.length) {
        const source = sources[cursor++];
        results.push(await this.runOne(source));
      }
    });
    await Promise.all(workers);
    return results.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private async executeRun(source: DiscoverySourceRecord): Promise<DiscoveryRunRecord> {
    const runId = randomUUID();
    const leaseToken = randomUUID();
    const startedAt = isoNow();
    const leaseUntil = new Date(Date.now() + this.#leaseDurationMs).toISOString();
    const acquired = this.sqlite.prepare("UPDATE discovery_sources SET lease_until=?,lease_token=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)").run(leaseUntil, leaseToken, source.id, startedAt);
    if (acquired.changes !== 1) {
      const existing = this.sqlite.prepare("SELECT * FROM discovery_runs WHERE source_id=? AND state='Running' ORDER BY started_at DESC LIMIT 1").get(source.id) as Row | undefined;
      if (existing) return runRecord(existing);
      throw new Error(`${source.name} is already being checked.`);
    }
    this.sqlite.prepare("UPDATE discovery_runs SET state='Failed',completed_at=?,error='The previous worker lease expired.' WHERE source_id=? AND state='Running'")
      .run(startedAt, source.id);
    this.sqlite.prepare("INSERT INTO discovery_runs (id,source_id,state,started_at) VALUES (?,?,?,?)").run(runId, source.id, "Running", startedAt);
    const heartbeat = setInterval(() => {
      this.sqlite.prepare("UPDATE discovery_sources SET lease_until=? WHERE id=? AND lease_token=?")
        .run(new Date(Date.now() + this.#leaseDurationMs).toISOString(), source.id, leaseToken);
    }, this.#heartbeatMs);
    heartbeat.unref();
    try {
      let result = await fetchSource(source);
      const finishedAt = isoNow();
      const ownsLease = this.sqlite.prepare("SELECT 1 FROM discovery_sources WHERE id=? AND lease_token=?").get(source.id, leaseToken);
      if (!ownsLease) throw new Error("The discovery worker lost its source lease before commit.");
      const previousRows = this.sqlite.prepare(`SELECT p.*, ? AS kind, a.source_id AS observed_source_id,
        a.external_id AS observed_external_id, a.first_seen_at AS alias_first_seen_at,
        a.last_seen_at AS alias_last_seen_at, a.removed_at AS alias_removed_at,
        a.availability AS alias_availability, a.missing_count AS alias_missing_count,
        a.content_hash AS alias_content_hash
        FROM discovery_posting_aliases a
        JOIN discovered_postings p ON p.id=a.discovered_posting_id
        WHERE a.source_id=? AND p.deleted_at IS NULL`).all(source.kind, source.id) as Row[];
      const observedCount = result.ok ? result.roles.length : 0;
      const latestCompleted = this.sqlite.prepare("SELECT found_count FROM discovery_runs WHERE source_id=? AND state='Completed' AND id<>? ORDER BY started_at DESC,rowid DESC LIMIT 1").get(source.id, runId) as Row | undefined;
      const trustedInventoryCount = latestCompleted ? number(latestCompleted, "found_count") : previousRows.length || source.successfulInventoryCount;
      const previousRun = this.sqlite.prepare("SELECT state,found_count,error FROM discovery_runs WHERE source_id=? AND id<>? AND completed_at IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1").get(source.id, runId) as Row | undefined;
      const repeatedDrop = Boolean(previousRun && text(previousRun, "state") === "Failed"
        && text(previousRun, "error").startsWith("Inventory drop needs confirmation:")
        && number(previousRun, "found_count") === observedCount);
      if (result.ok && result.inventoryComplete === false) {
        result = { sourceId: source.id, provider: source.kind, organization: source.companyName, ok: false, error: `Incomplete inventory: ${source.name} did not return a complete result.` };
      } else if (result.ok && source.successfulInventoryCount === 0 && previousRows.length === 0 && observedCount === 0) {
        result = {
          sourceId: source.id,
          provider: source.kind,
          organization: source.companyName,
          ok: false,
          error: "Incomplete inventory: the source returned no roles and has never yielded inventory. Verify its official endpoint before treating it as healthy.",
        };
      } else if (result.ok && trustedInventoryCount > 0 && observedCount < trustedInventoryCount && !repeatedDrop) {
        result = {
          sourceId: source.id,
          provider: source.kind,
          organization: source.companyName,
          ok: false,
          error: `Inventory drop needs confirmation: received ${observedCount} roles after ${trustedInventoryCount}. No availability changes were applied.`,
        };
      }
      const reconciled = reconcileDiscoveryRun({ previous: previousObservations(previousRows), sources: [result], observedAt: finishedAt, startedAt, removalThreshold: 3 });
      const summary = reconciled.summary;
      const error = result.ok ? "" : result.error;
      const state: DiscoveryRunRecord["state"] = result.ok ? "Completed" : "Failed";
      const changedPostingIds: string[] = [];
      const changedAliasKeys = new Set<string>();
      const deadlinePostingIds: string[] = [];
      this.sqlite.transaction(() => {
        if (result.ok) {
          for (const role of reconciled.observations.filter((item) => item.sourceId === source.id)) {
            let previous = previousRows.find((item) => text(item, "observed_external_id") === role.externalId);
            if (!previous && role.status === "open") {
              const candidateRows = this.sqlite.prepare(`SELECT p.*,a.external_id AS alias_external_id,s.kind AS candidate_source_kind
                FROM discovered_postings p LEFT JOIN discovery_posting_aliases a ON a.discovered_posting_id=p.id
                LEFT JOIN discovery_sources s ON s.id=p.source_id
                WHERE p.deleted_at IS NULL AND lower(trim(p.company_name))=lower(trim(?))`).all(source.companyName) as Row[];
              const candidates = [...new Map(candidateRows.map((candidate) => [text(candidate, "id"), candidate])).values()];
              const roleUrls = new Set([identityUrl(role.sourceUrl), identityUrl(role.applyUrl)].filter(Boolean));
              const roleRequisition = requisitionKey(role.externalId);
              const requisitionMatches = roleRequisition ? candidateRows.filter((candidate) => requisitionKey(text(candidate, "alias_external_id")) === roleRequisition) : [];
              const requisitionIds = new Set(requisitionMatches.map((candidate) => text(candidate, "id")));
              if (requisitionIds.size === 1) previous = requisitionMatches[0];
              if (!previous) previous = candidates.find((candidate) => [identityUrl(text(candidate, "canonical_url")), identityUrl(text(candidate, "apply_url"))].some((url) => roleUrls.has(url)));
              if (!previous) {
                const signature = roleIdentitySignature(source.companyName, role.title, role.location);
                const identityMatches = candidates.filter((candidate) => text(candidate, "candidate_source_kind") !== source.kind
                  && role.location.trim()
                  && roleIdentitySignature(text(candidate, "company_name"), text(candidate, "title"), text(candidate, "location")) === signature
                  && descriptionSimilarity(text(candidate, "description"), role.description) >= 0.75);
                if (identityMatches.length === 1) previous = identityMatches[0];
              }
            }
            const id = previous ? text(previous, "id") : randomUUID();
            const hash = role.status === "open" ? roleContentHash(role) : text(previous ?? {}, "alias_content_hash") || roleContentHash(role);
            const programme = previous ? text(previous, "programme") : inferProgramme(role.title);
            const side = previous ? text(previous, "side") : inferSide(source.companyName, role.title);
            const classifications = inferClassifications(source.companyName, role.title, role.description, role.team);
            const priorAvailability = previous ? text(previous, "alias_availability") || text(previous, "availability") : "";
            const priorHash = previous ? text(previous, "alias_content_hash") : "";
            const contentChanged = Boolean(previous && priorHash && priorHash !== hash);
            const restored = Boolean(previous && role.status === "open" && (priorAvailability === "Removed" || priorAvailability === "Expired"));
            if (!previous) {
              this.sqlite.prepare(`INSERT INTO discovered_postings (id,source_id,external_id,canonical_url,apply_url,company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,source_posted_at,deadline_at,first_seen_at,last_seen_at,last_checked_at,availability,missing_count,content_hash,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
                id, source.id, role.externalId, role.sourceUrl, role.applyUrl, source.companyName, role.title, role.location, programme,
                classifications.sector, classifications.firmType, classifications.roleFamily, classifications.workMode, classifications.sponsorship, side,
                role.description, role.postedAt, role.deadlineAt, role.firstSeenAt, role.lastSeenAt, finishedAt, "Open", 0, hash, finishedAt, finishedAt,
              );
            } else if (role.status === "open") {
              if (contentChanged) {
                changedPostingIds.push(id);
                changedAliasKeys.add(role.sourceKey);
              }
              if (restored) {
                changedPostingIds.push(id);
                changedAliasKeys.add(role.sourceKey);
              }
              this.sqlite.prepare(`UPDATE discovered_postings SET canonical_url=?,apply_url=?,company_name=?,title=?,location=?,programme=?,sector=?,firm_type=?,role_family=?,work_mode=?,sponsorship=?,description=?,
                source_posted_at=COALESCE(?,source_posted_at),deadline_at=?,last_seen_at=?,last_checked_at=?,content_hash=?,updated_at=?,revision=revision+1 WHERE id=?`).run(
                role.sourceUrl, role.applyUrl, source.companyName, role.title, role.location, programme,
                classifications.sector, classifications.firmType, classifications.roleFamily, classifications.workMode, classifications.sponsorship, role.description,
                role.postedAt, role.deadlineAt, role.lastSeenAt, finishedAt, hash, finishedAt, id,
              );
            }
            const effectiveDeadline = role.deadlineAt || nullableText(previous ?? {}, "deadline_at");
            const closedAfterDeadline = role.status === "closed" && Boolean(effectiveDeadline && new Date(effectiveDeadline).getTime() <= new Date(finishedAt).getTime());
            const aliasAvailability = role.status === "closed" ? (closedAfterDeadline ? "Expired" : "Removed") : role.status === "missing" ? "Unknown" : "Open";
            this.sqlite.prepare(`INSERT INTO discovery_posting_aliases
              (source_id,external_id,discovered_posting_id,first_seen_at,last_seen_at,last_checked_at,removed_at,availability,missing_count,content_hash,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET
              discovered_posting_id=excluded.discovered_posting_id,last_seen_at=excluded.last_seen_at,last_checked_at=excluded.last_checked_at,
              removed_at=excluded.removed_at,availability=excluded.availability,missing_count=excluded.missing_count,content_hash=excluded.content_hash`).run(
              source.id, role.externalId, id, role.firstSeenAt, role.lastSeenAt, finishedAt, role.closedAt, aliasAvailability, role.missingRuns, hash, finishedAt,
            );
            const aliasStates = this.sqlite.prepare("SELECT availability,missing_count FROM discovery_posting_aliases WHERE discovered_posting_id=?").all(id) as Row[];
            const current = this.sqlite.prepare("SELECT deadline_at FROM discovered_postings WHERE id=?").get(id) as Row;
            const deadline = nullableText(current, "deadline_at");
            const hasOpenAlias = aliasStates.some((alias) => text(alias, "availability") === "Open");
            const allUnavailable = aliasStates.length > 0 && aliasStates.every((alias) => ["Removed", "Expired"].includes(text(alias, "availability")));
            const hasExpiredAlias = aliasStates.some((alias) => text(alias, "availability") === "Expired");
            const availability = hasOpenAlias ? "Open" : allUnavailable ? (hasExpiredAlias ? "Expired" : "Removed") : "Unknown";
            const missingCount = hasOpenAlias ? 0 : Math.max(0, ...aliasStates.map((alias) => number(alias, "missing_count")));
            this.sqlite.prepare(`UPDATE discovered_postings SET availability=?,missing_count=?,removed_at=?,last_checked_at=?,updated_at=?,revision=revision+1 WHERE id=?`).run(
              availability, missingCount, ["Removed", "Expired"].includes(availability) ? finishedAt : null, finishedAt, finishedAt, id,
            );
            if (deadline && new Date(deadline).getTime() > Date.now() && new Date(deadline).getTime() - Date.now() <= 7 * 86_400_000) deadlinePostingIds.push(id);
            const primaryObservation = !previous ? "Created"
              : role.status === "missing" ? "Missing"
                : aliasAvailability === "Expired" && priorAvailability !== "Expired" ? "Expired"
                  : aliasAvailability === "Removed" && priorAvailability !== "Removed" ? "Removed"
                    : restored ? "Restored" : "Checked";
            const observationStates = contentChanged ? [primaryObservation, "Changed"] : [primaryObservation];
            for (const observationState of observationStates) {
              const note = observationState === "Missing"
                ? `Missing from successful run ${role.missingRuns} of 3 for ${source.name}.`
                : observationState === "Changed"
                  ? `Content changed for ${source.name}. Previous hash: ${priorHash || "not recorded"}. Current hash: ${hash}.`
                  : ["Restored", "Removed", "Expired"].includes(observationState)
                    ? `${source.name} availability changed from ${priorAvailability || "Unknown"} to ${aliasAvailability}.`
                    : "";
              this.sqlite.prepare("INSERT INTO discovery_observations (id,discovered_posting_id,discovery_run_id,state,content_hash,note,observed_at) VALUES (?,?,?,?,?,?,?)").run(
                randomUUID(), id, runId, observationState, hash, note, finishedAt,
              );
            }
          }
        }
        this.sqlite.prepare(`UPDATE discovery_runs SET state=?,completed_at=?,duration_ms=?,found_count=?,new_count=?,changed_count=?,missing_count=?,error=? WHERE id=?`).run(
          state, finishedAt, Date.now() - new Date(startedAt).getTime(), result.ok ? summary.unique : observedCount, summary.created, changedAliasKeys.size,
          summary.markedMissing + summary.closed, error, runId,
        );
        this.sqlite.prepare("UPDATE discovery_sources SET last_checked_at=?, last_successful_at=CASE WHEN ?='' THEN ? ELSE last_successful_at END, successful_inventory_count=CASE WHEN ?='' THEN MAX(successful_inventory_count,?) ELSE successful_inventory_count END, last_error=?, lease_until=NULL, lease_token=NULL, updated_at=?, revision=revision+1 WHERE id=? AND lease_token=?").run(
          finishedAt, error, finishedAt, error, result.ok ? result.roles.length : 0, error, finishedAt, source.id, leaseToken,
        );
        if (result.ok) this.createAlerts(source.id, startedAt, [...new Set(changedPostingIds)], [...new Set(deadlinePostingIds)], runId);
      })();
      const row = this.sqlite.prepare("SELECT * FROM discovery_runs WHERE id=?").get(runId) as Row;
      return runRecord(row);
    } catch (error) {
      const completedAt = isoNow();
      const message = error instanceof Error ? error.message : "Discovery processing failed.";
      this.sqlite.transaction(() => {
        this.sqlite.prepare(`UPDATE discovery_runs SET state='Failed',completed_at=?,duration_ms=?,error=? WHERE id=?`)
          .run(completedAt, Date.now() - new Date(startedAt).getTime(), message, runId);
        this.sqlite.prepare("UPDATE discovery_sources SET last_checked_at=?,last_error=?,lease_until=NULL,lease_token=NULL,updated_at=?,revision=revision+1 WHERE id=? AND lease_token=?")
          .run(completedAt, message, completedAt, source.id, leaseToken);
      })();
      const row = this.sqlite.prepare("SELECT * FROM discovery_runs WHERE id=?").get(runId) as Row;
      return runRecord(row);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async sendTestAlert(): Promise<AlertEventRecord> {
    const directUrl = "https://optiver.com/join-us/jobs/";
    const event = this.createAlert(null, null, "test", "CareerOS test alert", `Reason: verify Telegram delivery and its direct-link button.\nCompany: CareerOS\nRole: test alert\nLocation: not applicable\nDetected: now\nDirect link: ${directUrl}`, directUrl, randomUUID(), true);
    await this.processNotificationDeliveries({ deliveryIds: event.deliveries.filter((item) => item.provider === "telegram").map((item) => item.id), throwOnFailure: true });
    const row = this.sqlite.prepare("SELECT * FROM alert_events WHERE id=?").get(event.id) as Row;
    return eventRecord(this.sqlite, row);
  }

  async retryTelegramDelivery(deliveryId: string, confirmPossibleDuplicate = false): Promise<AlertEventRecord> {
    const row = this.sqlite.prepare("SELECT * FROM notification_deliveries WHERE id=? AND provider='telegram'").get(deliveryId) as Row | undefined;
    if (!row) throw new Error("Telegram delivery was not found.");
    const eventRow = this.sqlite.prepare("SELECT * FROM alert_events WHERE id=?").get(text(row, "alert_event_id")) as Row | undefined;
    if (!eventRow) throw new Error("Alert event was not found.");
    const state = text(row, "state");
    if (state === "Ambiguous" && !confirmPossibleDuplicate) {
      throw new Error("Telegram may already have delivered this message. Confirm that you want to send it again.");
    }
    const timestamp = isoNow();
    const reset = this.sqlite.prepare(`UPDATE notification_deliveries
      SET state='Pending',next_attempt_at=?,claim_token=NULL,claimed_until=NULL,updated_at=?
      WHERE id=? AND state IN ('Failed','Ambiguous','ConfigurationRequired') AND (claim_token IS NULL OR claimed_until IS NULL OR claimed_until<=?)`)
      .run(timestamp, timestamp, deliveryId, timestamp);
    if (reset.changes !== 1) throw new Error("This Telegram delivery is already pending or being sent.");
    await this.processNotificationDeliveries({ deliveryIds: [deliveryId], throwOnFailure: true });
    return eventRecord(this.sqlite, eventRow);
  }

  private createAlert(ruleId: string | null, postingId: string | null, eventType: AlertEventRecord["eventType"], title: string, body: string, directUrl: string, version = "", telegram = false) {
    const timestamp = isoNow();
    const deduplicationKey = contentHash({ ruleId, postingId, eventType, version });
    const existing = this.sqlite.prepare("SELECT * FROM alert_events WHERE deduplication_key=?").get(deduplicationKey) as Row | undefined;
    if (existing) {
      if (telegram) this.ensureTelegramDelivery(text(existing, "id"), timestamp);
      return eventRecord(this.sqlite, existing);
    }
    const id = randomUUID();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("INSERT INTO alert_events (id,rule_id,discovered_posting_id,event_type,title,body,direct_url,deduplication_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        id, ruleId, postingId, eventType, title, body, directUrl, deduplicationKey, timestamp,
      );
      this.sqlite.prepare("INSERT INTO notification_deliveries (id,alert_event_id,provider,state,attempt_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
        randomUUID(), id, "in_app", "Delivered", 1, timestamp, timestamp,
      );
      if (telegram) this.ensureTelegramDelivery(id, timestamp);
    })();
    return eventRecord(this.sqlite, this.sqlite.prepare("SELECT * FROM alert_events WHERE id=?").get(id) as Row);
  }

  private ensureTelegramDelivery(eventId: string, timestamp = isoNow()) {
    this.sqlite.prepare(`INSERT INTO notification_deliveries (id,alert_event_id,provider,state,attempt_count,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(alert_event_id,provider) DO NOTHING`).run(
      randomUUID(), eventId, "telegram", "Pending", 0, timestamp, timestamp, timestamp,
    );
  }

  private alertBody(posting: DiscoveredPostingRecord, reason: string) {
    const directUrl = posting.applyUrl || posting.canonicalUrl;
    return [
      `Company: ${posting.companyName}`,
      `Role: ${posting.title}`,
      `Location: ${posting.location || "Not listed"}`,
      `Detected: ${new Date(posting.firstSeenAt).toLocaleString("en-GB")}`,
      `Reason: ${reason}`,
      `Direct link: ${directUrl}`,
    ].join("\n");
  }

  private createAlerts(sourceId: string, since: string, changedPostingIds: string[], deadlinePostingIds: string[], transitionId: string) {
    const postings = (this.sqlite.prepare("SELECT * FROM discovered_postings WHERE source_id=? AND first_seen_at>=? AND availability='Open'").all(sourceId, since) as Row[]).map(postingRecord);
    const rules = (this.sqlite.prepare("SELECT * FROM alert_rules WHERE enabled=1 AND deleted_at IS NULL").all() as Row[]).map(ruleRecord);
    for (const posting of postings) {
      for (const rule of rules.filter((candidate) => matchesRule(posting, candidate))) {
        this.createAlert(rule.id, posting.id, "new_match", `${posting.companyName}: ${posting.title}`, this.alertBody(posting, `New role matched alert rule “${rule.name}”.`), posting.applyUrl || posting.canonicalUrl, "", rule.telegramEnabled);
      }
    }
    for (const postingId of changedPostingIds) {
      const posting = this.getPosting(postingId);
      if (!posting) continue;
      for (const rule of rules.filter((candidate) => matchesRule(posting, candidate, false))) {
        this.createAlert(rule.id, posting.id, "posting_changed", `${posting.companyName}: posting updated`, this.alertBody(posting, `The employer changed this posting; it matches alert rule “${rule.name}”.`), posting.applyUrl || posting.canonicalUrl, `${transitionId}:${posting.id}`, rule.telegramEnabled);
      }
    }
    for (const postingId of deadlinePostingIds) {
      const posting = this.getPosting(postingId);
      if (!posting?.deadlineAt) continue;
      for (const rule of rules.filter((candidate) => matchesRule(posting, candidate, false))) {
        this.createAlert(rule.id, posting.id, "deadline_soon", `${posting.companyName}: deadline soon`, this.alertBody(posting, `Deadline ${new Date(posting.deadlineAt).toLocaleDateString("en-GB")} is within 7 days; matched alert rule “${rule.name}”.`), posting.applyUrl || posting.canonicalUrl, posting.deadlineAt, rule.telegramEnabled);
      }
    }
  }

  async processNotificationDeliveries(options: { limit?: number; deliveryIds?: string[]; throwOnFailure?: boolean } = {}) {
    return this.#runMutation(() => this.processNotificationDeliveriesWithinMutation(options));
  }

  private async processNotificationDeliveriesWithinMutation(options: { limit?: number; deliveryIds?: string[]; throwOnFailure?: boolean } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const now = isoNow();
    const claimedUntil = new Date(Date.now() + this.#deliveryLeaseMs).toISOString();
    const requested = options.deliveryIds?.filter(Boolean) ?? [];
    const placeholders = requested.map(() => "?").join(",");
    this.recoverAbandonedTelegramClaims(now);
    const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
    const candidateSql = `SELECT id FROM notification_deliveries
      WHERE provider='telegram' AND (state='Pending' ${telegramConfigured ? "OR state='ConfigurationRequired'" : ""})
        AND (${requested.length ? "1=1" : "provider_attempt_count<3"})
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        AND (claim_token IS NULL OR claimed_until IS NULL OR claimed_until<=?)
        ${requested.length ? `AND id IN (${placeholders})` : ""}
      ORDER BY created_at LIMIT ?`;
    const candidates = this.sqlite.prepare(candidateSql).all(now, now, ...requested, limit) as Row[];
    const claims = this.sqlite.transaction(() => {
      const owned: Array<{ id: string; token: string }> = [];
      for (const candidate of candidates) {
        const token = randomUUID();
        const result = this.sqlite.prepare(`UPDATE notification_deliveries SET state='Sending',claim_token=?,claimed_until=?,updated_at=?
          WHERE id=? AND state IN ('Pending','ConfigurationRequired') AND (claim_token IS NULL OR claimed_until IS NULL OR claimed_until<=?)`).run(
          token, claimedUntil, now, text(candidate, "id"), now,
        );
        if (result.changes === 1) owned.push({ id: text(candidate, "id"), token });
      }
      return owned;
    })();

    const results: NotificationDeliveryRecord[] = [];
    let cursor = 0;
    let firstFailure: Error | null = null;
    const workers = Array.from({ length: Math.min(this.#deliveryConcurrency, claims.length) }, async () => {
      while (cursor < claims.length) {
        const claim = claims[cursor++];
        try {
          results.push(await this.deliverClaimedTelegram(claim.id, claim.token));
        } catch (error) {
          firstFailure ??= error instanceof Error ? error : new Error("Telegram delivery failed.");
        }
      }
    });
    await Promise.all(workers);
    if (options.throwOnFailure && firstFailure) throw firstFailure;
    return results;
  }

  private async deliverClaimedTelegram(deliveryId: string, claimToken: string): Promise<NotificationDeliveryRecord> {
    const row = this.sqlite.prepare(`SELECT d.*,e.title,e.body,e.direct_url,e.deduplication_key
      FROM notification_deliveries d JOIN alert_events e ON e.id=d.alert_event_id
      WHERE d.id=? AND d.claim_token=? AND d.state='Sending'`).get(deliveryId, claimToken) as Row | undefined;
    if (!row) throw new Error("Notification delivery claim was lost.");
    const timestamp = isoNow();
    const providerAttempt = number(row, "provider_attempt_count") + 1;
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
    if (!token || !chatId) {
      this.sqlite.transaction(() => {
        this.sqlite.prepare(`UPDATE notification_deliveries SET state='ConfigurationRequired',last_error=?,next_attempt_at=NULL,claim_token=NULL,claimed_until=NULL,updated_at=?
          WHERE id=? AND claim_token=?`).run("Telegram is not configured.", timestamp, deliveryId, claimToken);
        this.recordAttempt(deliveryId, "ConfigurationRequired", timestamp, "Telegram is not configured.");
      })();
      throw new Error("Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to send Telegram alerts.");
    }
    this.sqlite.transaction(() => {
      this.sqlite.prepare("UPDATE notification_deliveries SET attempt_count=?,provider_attempt_count=?,updated_at=? WHERE id=? AND claim_token=?")
        .run(providerAttempt, providerAttempt, timestamp, deliveryId, claimToken);
      this.recordAttempt(deliveryId, "Started", timestamp);
    })();
    try {
      const provider = createTelegramProvider({
        botToken: token,
        ...(process.env.NODE_ENV === "test" && process.env.CAREEROS_TELEGRAM_API_BASE_URL
          ? { apiBaseUrl: process.env.CAREEROS_TELEGRAM_API_BASE_URL }
          : {}),
      });
      const delivered = await provider.deliver({
        notificationId: text(row, "alert_event_id"), channel: "telegram", recipientId: chatId,
        deduplicationKey: text(row, "deduplication_key"),
        content: { title: text(row, "title"), body: text(row, "body"), directLink: text(row, "direct_url"), directLinkLabel: "Open job" },
      });
      this.sqlite.transaction(() => {
        this.sqlite.prepare(`UPDATE notification_deliveries SET state='Delivered',last_error='',provider_message_id=?,next_attempt_at=NULL,
          claim_token=NULL,claimed_until=NULL,delivered_at=?,updated_at=? WHERE id=? AND claim_token=?`).run(
          delivered.providerMessageId ?? "", timestamp, timestamp, deliveryId, claimToken,
        );
        this.recordAttempt(deliveryId, "Delivered", timestamp, "", delivered.providerMessageId ?? "");
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram delivery failed.";
      const failure = error instanceof TelegramDeliveryError ? error : new TelegramDeliveryError(message, "ambiguous");
      const terminal = failure.kind === "permanent" || providerAttempt >= 3;
      const state = failure.kind === "ambiguous" ? "Ambiguous" : terminal ? "Failed" : "Pending";
      const delay = failure.retryAfterMs ?? providerAttempt * 60_000;
      const next = state === "Pending" ? new Date(Date.now() + delay).toISOString() : null;
      this.sqlite.transaction(() => {
        this.sqlite.prepare(`UPDATE notification_deliveries SET state=?,last_error=?,next_attempt_at=?,claim_token=NULL,claimed_until=NULL,updated_at=?
          WHERE id=? AND claim_token=?`).run(state, message, next, timestamp, deliveryId, claimToken);
        this.recordAttempt(deliveryId, state === "Ambiguous" ? "Ambiguous" : "Failed", timestamp, message, "", next);
      })();
      throw new Error(message);
    }
    return deliveryRecord(this.sqlite, this.sqlite.prepare("SELECT * FROM notification_deliveries WHERE id=?").get(deliveryId) as Row);
  }

  private recoverAbandonedTelegramClaims(timestamp = isoNow()) {
    const rows = this.sqlite.prepare("SELECT id FROM notification_deliveries WHERE provider='telegram' AND state='Sending' AND claimed_until<=?").all(timestamp) as Row[];
    this.sqlite.transaction(() => {
      for (const row of rows) {
        const id = text(row, "id");
        this.sqlite.prepare(`UPDATE notification_deliveries SET state='Ambiguous',last_error=?,claim_token=NULL,claimed_until=NULL,updated_at=? WHERE id=? AND state='Sending'`)
          .run("Telegram may have accepted this message before CareerOS lost contact.", timestamp, id);
        this.recordAttempt(id, "Ambiguous", timestamp, "The delivery lease expired before Telegram's response was recorded.");
      }
    })();
  }

  private recordAttempt(
    deliveryId: string,
    state: NotificationDeliveryAttemptRecord["state"],
    timestamp: string,
    error = "",
    providerMessageId = "",
    retryAfterAt: string | null = null,
  ) {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM notification_delivery_attempts WHERE delivery_id=?").get(deliveryId) as Row;
    this.sqlite.prepare(`INSERT INTO notification_delivery_attempts
      (id,delivery_id,sequence,state,error,provider_message_id,retry_after_at,started_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), deliveryId, number(row, "sequence"), state, error, providerMessageId, retryAfterAt,
      timestamp, state === "Started" ? null : timestamp,
    );
  }
}
