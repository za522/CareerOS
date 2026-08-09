import type Database from "better-sqlite3";
import { captureQueueStatuses, CaptureQueueCapacityError, type CaptureInput, type CaptureQueueJob, type CaptureQueueJobUpdate, type CaptureQueueStatus, type CaptureQueueStore, type CaptureQueueSummary } from "./capture-queue.js";

type QueueRow = {
  id: string;
  source_type: string;
  source_url: string;
  apply_url: string;
  raw_text: string;
  state: string;
  progress: number;
  progress_message: string | null;
  attempt_count: number;
  draft_json: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseResult(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function rowToJob(row: QueueRow): CaptureQueueJob {
  const applyUrl = row.apply_url || undefined;
  const input: CaptureInput = row.source_type === "url"
    ? { kind: "url", url: row.source_url, ...(applyUrl ? { applyUrl } : {}) }
    : { kind: "text", text: row.raw_text, ...(applyUrl ? { applyUrl } : {}) };
  return {
    id: row.id,
    input,
    status: row.state as CaptureQueueStatus,
    attempts: row.attempt_count,
    progress: row.progress / 10_000,
    progressMessage: row.progress_message,
    result: parseResult(row.draft_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.completed_at,
  };
}

export class SqliteCaptureQueueStore implements CaptureQueueStore {
  constructor(private readonly sqlite: Database.Database) {}

  async create(job: CaptureQueueJob): Promise<void> {
    await this.createMany([job]);
  }

  async createMany(jobs: CaptureQueueJob[], capacity?: number, onPersist?: () => void): Promise<void> {
    if (jobs.length === 0) return;
    const insert = this.sqlite.prepare(`INSERT INTO capture_queue_items (
      id, source_type, source_url, apply_url, raw_text, state, progress, progress_message, attempt_count,
      draft_json, error, started_at, completed_at, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const insertRows = (rows: CaptureQueueJob[]) => {
      for (const job of rows) insert.run(
        job.id,
        job.input.kind === "url" ? "url" : "pasted_text",
        job.input.kind === "url" ? job.input.url : "",
        job.input.applyUrl ?? "",
        job.input.kind === "text" ? job.input.text : "",
        job.status,
        Math.round(job.progress * 10_000),
        job.progressMessage,
        job.attempts,
        job.result ? JSON.stringify(job.result) : null,
        job.error,
        job.startedAt,
        job.finishedAt,
        job.createdAt,
        job.updatedAt,
      );
    };
    if (this.sqlite.inTransaction) {
      if (capacity !== undefined) {
        const pending = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM capture_queue_items WHERE state IN ('Queued', 'Extracting') AND deleted_at IS NULL").get() as { count: number }).count;
        if (pending + jobs.length > capacity) throw new CaptureQueueCapacityError(capacity);
      }
      insertRows(jobs);
      onPersist?.();
      return;
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (capacity !== undefined) {
        const pending = (this.sqlite.prepare("SELECT COUNT(*) AS count FROM capture_queue_items WHERE state IN ('Queued', 'Extracting') AND deleted_at IS NULL").get() as { count: number }).count;
        if (pending + jobs.length > capacity) throw new CaptureQueueCapacityError(capacity);
      }
      insertRows(jobs);
      onPersist?.();
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async get(id: string): Promise<CaptureQueueJob | null> {
    const row = this.sqlite.prepare("SELECT * FROM capture_queue_items WHERE id = ? AND deleted_at IS NULL").get(id) as QueueRow | undefined;
    return row ? rowToJob(row) : null;
  }

  async list(): Promise<CaptureQueueJob[]> {
    const rows = this.sqlite.prepare("SELECT * FROM capture_queue_items WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as QueueRow[];
    return rows.map(rowToJob);
  }

  async countPending(): Promise<number> {
    return (this.sqlite.prepare("SELECT COUNT(*) AS count FROM capture_queue_items WHERE state IN ('Queued', 'Extracting') AND deleted_at IS NULL").get() as { count: number }).count;
  }

  async summary(): Promise<CaptureQueueSummary> {
    const rows = this.sqlite.prepare(`SELECT state, COUNT(*) AS count,
      SUM(CASE WHEN state IN ('Queued','Extracting') THEN progress ELSE 10000 END) AS progressUnits
      FROM capture_queue_items WHERE deleted_at IS NULL GROUP BY state`).all() as Array<{ state: CaptureQueueStatus; count: number; progressUnits: number }>;
    const counts = Object.fromEntries(captureQueueStatuses.map((status) => [status, 0])) as Record<CaptureQueueStatus, number>;
    let total = 0;
    let progressUnits = 0;
    for (const row of rows) {
      if (row.state in counts) counts[row.state] = row.count;
      total += row.count;
      progressUnits += row.progressUnits;
    }
    const pending = counts.Queued + counts.Extracting;
    return { total, pending, completed: total - pending, overallProgress: total === 0 ? 1 : Math.round(progressUnits / total) / 10_000, counts };
  }

  async claimNext(updatedAt: string, startedAt: string): Promise<CaptureQueueJob | null> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const row = this.sqlite.prepare("SELECT id FROM capture_queue_items WHERE state='Queued' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
      if (!row) { this.sqlite.exec("COMMIT"); return null; }
      const result = this.sqlite.prepare(`UPDATE capture_queue_items SET state='Extracting', attempt_count=attempt_count+1,
        progress=0, progress_message='Starting extraction', error=NULL, updated_at=?, started_at=?, completed_at=NULL, revision=revision+1
        WHERE id=? AND state='Queued' AND deleted_at IS NULL`).run(updatedAt, startedAt, row.id);
      this.sqlite.exec("COMMIT");
      return result.changes === 1 ? this.get(row.id) : null;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async listPage(options: { limit: number; cursor?: string; state?: CaptureQueueStatus }) {
    let cursor: { createdAt: string; id: string } | null = null;
    if (options.cursor) {
      try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as { createdAt: string; id: string }; }
      catch { cursor = null; }
    }
    const where = ["deleted_at IS NULL"];
    const values: unknown[] = [];
    if (options.state) { where.push("state = ?"); values.push(options.state); }
    if (cursor?.createdAt && cursor.id) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.sqlite.prepare(`SELECT id, source_type, source_url, apply_url,
      substr(raw_text, 1, 500) AS raw_text, state, progress, progress_message, attempt_count,
      draft_json, error, started_at, completed_at, created_at, updated_at
      FROM capture_queue_items WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values, options.limit + 1) as QueueRow[];
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      jobs: page.map(rowToJob),
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url") : null,
    };
  }

  async findPotentialDuplicates(job: CaptureQueueJob, _title: string, _companyName: string) {
    const rows = this.sqlite.prepare(`SELECT id,source_type,source_url,apply_url,substr(raw_text,1,20000) AS raw_text,
      state,progress,progress_message,attempt_count,
      CASE WHEN json_valid(draft_json) THEN json_object('response',json_object('draft',json_object(
        'title',json_extract(draft_json,'$.response.draft.title'),
        'companyName',json_extract(draft_json,'$.response.draft.companyName'),
        'sourceUrl',json_extract(draft_json,'$.response.draft.sourceUrl'),
        'applyUrl',json_extract(draft_json,'$.response.draft.applyUrl')))) ELSE NULL END AS draft_json,
      error,started_at,completed_at,created_at,updated_at
      FROM capture_queue_items
      WHERE deleted_at IS NULL
        AND (created_at < ? OR (created_at = ? AND id < ?))
        AND state IN ('Queued','Extracting','Needs Review','Duplicate')
      ORDER BY created_at DESC, id DESC LIMIT 100`).all(
        job.createdAt,
        job.createdAt,
        job.id,
      ) as QueueRow[];
    return rows.map(rowToJob);
  }

  async update(id: string, expectedStatuses: readonly CaptureQueueStatus[], update: CaptureQueueJobUpdate): Promise<CaptureQueueJob | null> {
    if (expectedStatuses.length === 0) return null;
    const current = await this.get(id);
    if (!current || !expectedStatuses.includes(current.status)) return null;
    const next = { ...current, ...update };
    const placeholders = expectedStatuses.map(() => "?").join(", ");
    const result = this.sqlite.prepare(`UPDATE capture_queue_items SET
      state = ?, progress = ?, progress_message = ?, attempt_count = ?, draft_json = ?, error = ?,
      started_at = ?, completed_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND state IN (${placeholders}) AND deleted_at IS NULL`).run(
      next.status,
      Math.round(next.progress * 10_000),
      next.progressMessage,
      next.attempts,
      next.result ? JSON.stringify(next.result) : null,
      next.error,
      next.startedAt,
      next.finishedAt,
      next.updatedAt,
      id,
      ...expectedStatuses,
    );
    return result.changes === 1 ? this.get(id) : null;
  }

  async requeueStale(cutoffTimestamp: string, updatedAt: string): Promise<number> {
    const result = this.sqlite.prepare(`UPDATE capture_queue_items SET
      state = 'Queued', progress = 0, progress_message = 'Resuming interrupted capture',
      started_at = NULL, updated_at = ?, revision = revision + 1
      WHERE state = 'Extracting' AND updated_at <= ? AND deleted_at IS NULL`).run(updatedAt, cutoffTimestamp);
    return result.changes;
  }

  async dismiss(id: string): Promise<boolean> {
    const result = this.sqlite.prepare(`UPDATE capture_queue_items SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND state NOT IN ('Queued', 'Extracting') AND deleted_at IS NULL`).run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes === 1;
  }
}
