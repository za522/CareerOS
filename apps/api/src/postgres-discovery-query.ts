import type {
  AlertEventRecord,
  AlertRuleRecord,
  DiscoveredPostingRecord,
  DiscoveryQuery,
  DiscoveryRunRecord,
  DiscoverySourceRecord,
  DiscoveryWorkspace,
  NotificationDeliveryAttemptRecord,
  NotificationDeliveryHistoryPage,
  NotificationDeliveryRecord,
} from "@careeros/contracts";
import type { QueryExecutor, SqlValue, TransactionManager, WorkspaceContext } from "./postgres/contracts.js";

type Row = Record<string, unknown>;
const text = (row: Row, key: string) => String(row[key] ?? "");
const nullable = (row: Row, key: string) => row[key] == null ? null : String(row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]);
const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? "");
const bool = (value: unknown) => value === true || value === 1 || value === "1";

function posting(row: Row): DiscoveredPostingRecord {
  const roleFamily = text(row, "role_family");
  const side = text(row, "side") as DiscoveredPostingRecord["side"];
  const careerTrack = roleFamily === "Quantitative research" ? "Quantitative finance" : roleFamily === "Trading" ? "Trading & markets"
    : roleFamily === "Engineering" ? "Technology" : ["Risk", "Finance", "Legal & compliance"].includes(roleFamily) ? "Financial institutions"
      : side === "buy_side" ? "Buy side" : side === "sell_side" ? "Sell side" : "Business & operations";
  return {
    id: text(row, "id"), sourceId: text(row, "source_id"), externalId: text(row, "external_id"),
    canonicalUrl: text(row, "canonical_url"), applyUrl: text(row, "apply_url"), companyName: text(row, "company_name"),
    title: text(row, "title"), location: text(row, "location"), programme: text(row, "programme"), sector: text(row, "sector"),
    firmType: text(row, "firm_type"), roleFamily, careerTrack, workMode: text(row, "work_mode"), sponsorship: text(row, "sponsorship"), side,
    description: text(row, "description"), sourcePostedAt: nullable(row, "source_posted_at"), sourceUpdatedAt: nullable(row, "source_updated_at"), deadlineAt: nullable(row, "deadline_at"),
    firstSeenAt: timestamp(row.first_seen_at), lastSeenAt: timestamp(row.last_seen_at), lastCheckedAt: timestamp(row.last_checked_at),
    removedAt: nullable(row, "removed_at"), availability: text(row, "availability") as DiscoveredPostingRecord["availability"],
    missingCount: Number(row.missing_count ?? 0), contentHash: text(row, "content_hash"), savedJobPostingId: nullable(row, "saved_job_posting_id"),
    hiddenAt: nullable(row, "hidden_at"), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), revision: Number(row.revision),
  };
}

function source(row: Row): DiscoverySourceRecord {
  return {
    id: text(row, "id"), name: text(row, "name"), kind: text(row, "kind") as DiscoverySourceRecord["kind"],
    companyName: text(row, "company_name"), sourceUrl: text(row, "source_url"), externalKey: text(row, "external_key"),
    enabled: bool(row.enabled), checkIntervalMinutes: Number(row.check_interval_minutes), lastCheckedAt: nullable(row, "last_checked_at"),
    lastSuccessfulAt: nullable(row, "last_successful_at"), lastError: text(row, "last_error"), successfulInventoryCount: Number(row.successful_inventory_count ?? 0),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), revision: Number(row.revision),
  };
}

function run(row: Row): DiscoveryRunRecord {
  return {
    id: text(row, "id"), sourceId: text(row, "source_id"), state: text(row, "state") as DiscoveryRunRecord["state"],
    startedAt: timestamp(row.started_at), completedAt: nullable(row, "completed_at"), durationMs: Number(row.duration_ms ?? 0),
    foundCount: Number(row.found_count ?? 0), newCount: Number(row.new_count ?? 0), changedCount: Number(row.changed_count ?? 0),
    missingCount: Number(row.missing_count ?? 0), error: text(row, "error"),
  };
}

function rule(row: Row): AlertRuleRecord {
  const criteria = (row.criteria_json ?? {}) as Partial<AlertRuleRecord>;
  return {
    id: text(row, "id"), name: text(row, "name"), enabled: bool(row.enabled), companies: criteria.companies ?? [],
    side: criteria.side ?? "either", roleFamilies: criteria.roleFamilies ?? [], programmes: criteria.programmes ?? [],
    locations: criteria.locations ?? [], keywords: criteria.keywords ?? [], newWithinHours: criteria.newWithinHours ?? 24,
    telegramEnabled: bool(row.telegram_enabled), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), revision: Number(row.revision),
  };
}

function attempt(row: Row): NotificationDeliveryAttemptRecord {
  return {
    id: text(row, "id"), deliveryId: text(row, "delivery_id"), sequence: Number(row.sequence),
    state: text(row, "state") as NotificationDeliveryAttemptRecord["state"], error: text(row, "error"),
    providerMessageId: text(row, "provider_message_id"), retryAfterAt: nullable(row, "retry_after_at"),
    startedAt: timestamp(row.started_at), completedAt: nullable(row, "completed_at"),
  };
}

async function delivery(tx: QueryExecutor, workspaceId: string, row: Row): Promise<NotificationDeliveryRecord> {
  const attempts = await tx.query<Row>(`SELECT * FROM notification_delivery_attempts WHERE workspace_id=$1 AND delivery_id=$2 ORDER BY sequence DESC`,
  [workspaceId, text(row, "id")]);
  return {
    id: text(row, "id"), alertEventId: text(row, "alert_event_id"), provider: text(row, "provider") as NotificationDeliveryRecord["provider"],
    state: text(row, "state") as NotificationDeliveryRecord["state"], attemptCount: Number(row.attempt_count ?? 0), lastError: text(row, "last_error"),
    deliveredAt: nullable(row, "delivered_at"), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), attempts: attempts.rows.map(attempt),
  };
}

async function alert(tx: QueryExecutor, workspaceId: string, row: Row): Promise<AlertEventRecord> {
  const deliveries = await tx.query<Row>("SELECT * FROM notification_deliveries WHERE workspace_id=$1 AND alert_event_id=$2 ORDER BY created_at,id", [workspaceId, text(row, "id")]);
  return {
    id: text(row, "id"), ruleId: nullable(row, "rule_id"), discoveredPostingId: nullable(row, "discovered_posting_id"),
    eventType: text(row, "event_type") as AlertEventRecord["eventType"], title: text(row, "title"), body: text(row, "body"),
    directUrl: text(row, "direct_url"), deduplicationKey: text(row, "deduplication_key"), readAt: nullable(row, "read_at"),
    createdAt: timestamp(row.created_at), deliveries: await Promise.all(deliveries.rows.map((item) => delivery(tx, workspaceId, item))),
  };
}

function cursor(value?: string) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { timestamp?: string; id?: string };
    return decoded.timestamp && decoded.id ? decoded as { timestamp: string; id: string } : null;
  } catch { return null; }
}

function careerTrackSql() {
  return `CASE WHEN role_family='Quantitative research' THEN 'Quantitative finance' WHEN role_family='Trading' THEN 'Trading & markets'
    WHEN role_family='Engineering' THEN 'Technology' WHEN role_family IN ('Risk','Finance','Legal & compliance') THEN 'Financial institutions'
    WHEN side='buy_side' THEN 'Buy side' WHEN side='sell_side' THEN 'Sell side' ELSE 'Business & operations' END`;
}

export class PostgresDiscoveryQueryRepository {
  constructor(private readonly transactions: TransactionManager) {}

  async workspace(context: WorkspaceContext, query: DiscoveryQuery = { limit: 100 }): Promise<DiscoveryWorkspace> {
    return this.transactions.transaction(context, async (tx) => {
      const where = ["workspace_id=$1", "deleted_at IS NULL"];
      const values: SqlValue[] = [context.workspaceId];
      const add = (sql: string, value: SqlValue) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
      if (!query.showHidden) where.push("hidden_at IS NULL");
      if (query.q) {
        values.push(query.q);
        const position = `$${values.length}`;
        where.push(`(company_name || ' ' || title || ' ' || location || ' ' || description) ILIKE '%'||${position}||'%'`);
      }
      const exact = (column: string, value?: string) => { if (value) add(`${column}=?`, value); };
      exact("side", query.side); exact("programme", query.programme); exact("sector", query.sector); exact("firm_type", query.firmType);
      exact("role_family", query.roleFamily); exact("work_mode", query.workMode); exact("sponsorship", query.sponsorship);
      if (query.careerTrack) add(`${careerTrackSql()}=?`, query.careerTrack);
      if (query.location) add("location ILIKE '%'||?||'%'", query.location);
      if (query.tracked === "saved") where.push("saved_job_posting_id IS NOT NULL");
      if (query.tracked === "unsaved") where.push("saved_job_posting_id IS NULL");
      if (query.freshWithinHours) add("first_seen_at>=now()-?*interval '1 hour'", query.freshWithinHours);
      if (query.deadlineSoon) where.push("deadline_at>now() AND deadline_at<=now()+interval '7 days'");
      const countWhere = where.join(" AND ");
      const totals = await tx.query<{ total: number }>(`SELECT count(*)::int AS total FROM discovered_postings WHERE ${countWhere}`, values);
      const open = await tx.query<{ total: number }>("SELECT count(*)::int AS total FROM discovered_postings WHERE workspace_id=$1 AND deleted_at IS NULL AND hidden_at IS NULL AND availability='Open'", [context.workspaceId]);
      const paging = cursor(query.cursor);
      if (paging) {
        values.push(paging.timestamp, paging.id);
        where.push(`(first_seen_at<$${values.length - 1} OR (first_seen_at=$${values.length - 1} AND id<$${values.length}))`);
      }
      const limit = Math.max(1, Math.min(query.limit ?? 100, 200));
      values.push(limit + 1);
      const postings = await tx.query<Row>(`SELECT * FROM discovered_postings WHERE ${where.join(" AND ")}
        ORDER BY first_seen_at DESC,id DESC LIMIT $${values.length}`, values);
      const page = postings.rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = postings.rows.length > limit && last
        ? Buffer.from(JSON.stringify({ timestamp: timestamp(last.first_seen_at), id: text(last, "id") })).toString("base64url") : null;
      const sources = await tx.query<Row>("SELECT * FROM discovery_sources WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY name", [context.workspaceId]);
      const runs = await tx.query<Row>("SELECT * FROM discovery_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 100", [context.workspaceId]);
      const rules = await tx.query<Row>("SELECT * FROM alert_rules WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC", [context.workspaceId]);
      const alerts = await tx.query<Row>("SELECT * FROM alert_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100", [context.workspaceId]);
      return {
        postings: page.map(posting), sources: sources.rows.map(source), latestRuns: runs.rows.map(run), alertRules: rules.rows.map(rule),
        alerts: await Promise.all(alerts.rows.map((item) => alert(tx, context.workspaceId, item))),
        postingTotal: Number(totals.rows[0]?.total ?? 0), openPostingTotal: Number(open.rows[0]?.total ?? 0), nextCursor,
      };
    }, { readOnly: true });
  }

  async listDeliveryHistory(context: WorkspaceContext, options: { limit?: number; cursor?: string } = {}): Promise<NotificationDeliveryHistoryPage> {
    return this.transactions.transaction(context, async (tx) => {
      const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
      const paging = cursor(options.cursor);
      const values: SqlValue[] = [context.workspaceId];
      const page = paging ? "AND (d.created_at<$2 OR (d.created_at=$2 AND d.id<$3))" : "";
      if (paging) values.push(paging.timestamp, paging.id);
      values.push(limit + 1);
      const rows = await tx.query<Row>(`SELECT d.*,e.title AS alert_title,e.direct_url,e.created_at AS alert_created_at
        FROM notification_deliveries d JOIN alert_events e ON e.workspace_id=d.workspace_id AND e.id=d.alert_event_id
        WHERE d.workspace_id=$1 AND d.provider='telegram' ${page} ORDER BY d.created_at DESC,d.id DESC LIMIT $${values.length}`, values);
      const items = rows.rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: await Promise.all(items.map(async (item) => ({
          ...await delivery(tx, context.workspaceId, item), alertTitle: text(item, "alert_title"), directUrl: text(item, "direct_url"), alertCreatedAt: timestamp(item.alert_created_at),
        }))),
        nextCursor: rows.rows.length > limit && last ? Buffer.from(JSON.stringify({ timestamp: timestamp(last.created_at), id: text(last, "id") })).toString("base64url") : null,
      };
    }, { readOnly: true });
  }

  async markAlertRead(context: WorkspaceContext, alertId: string, read: boolean) {
    return this.transactions.transaction(context, async (tx) => {
      const result = await tx.query<Row>("UPDATE alert_events SET read_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE workspace_id=$1 AND id=$2 RETURNING *", [context.workspaceId, alertId, read]);
      return result.rows[0] ? alert(tx, context.workspaceId, result.rows[0]) : null;
    });
  }

  async setPostingHidden(context: WorkspaceContext, postingId: string, hidden: boolean, expectedRevision: number) {
    return this.transactions.transaction(context, async (tx) => {
      const result = await tx.query<Row>(`UPDATE discovered_postings SET hidden_at=CASE WHEN $4 THEN now() ELSE NULL END,updated_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL RETURNING *`, [context.workspaceId, postingId, expectedRevision, hidden]);
      if (!result.rows[0]) throw new Error("Posting changed or was not found. Refresh and try again.");
      return posting(result.rows[0]);
    });
  }
}
