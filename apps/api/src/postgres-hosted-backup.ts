import { randomUUID } from "node:crypto";
import { decodeBackupKey, decryptBackup, encryptBackup } from "./encrypted-backup.js";
import type { CloudDataProvider, WorkspaceContext } from "./postgres/contracts.js";
import type { ObjectStorageAdapter, StoredObjectMetadata } from "./storage/object-storage.js";
import {
  createPostgresWorkspaceBundle,
  encodePostgresWorkspaceBundle,
  restorePostgresWorkspaceBundle,
  type PostgresWorkspaceRestoreResult,
} from "./postgres-workspace-backup.js";

export type HostedBackupRecord = {
  id: string;
  path: string;
  checksum: string;
  sizeBytes: number;
  createdAt: string;
};

export class PostgresHostedBackupService {
  #running = new Map<string, Promise<StoredObjectMetadata>>();
  #timer: NodeJS.Timeout | null = null;
  #lastSuccessfulAt: string | null = null;
  #lastError = "";

  constructor(private readonly options: {
    provider: CloudDataProvider;
    storage: ObjectStorageAdapter;
    backupStorage?: ObjectStorageAdapter;
    encryptionKey: string;
    schemaVersion: string;
    applicationVersion: string;
    intervalMs: number;
    contexts?: () => Promise<WorkspaceContext[]>;
    now?: () => Date;
  }) {
    if (options.intervalMs < 60_000) throw new Error("Scheduled backup intervals must be at least one minute.");
    decodeBackupKey(options.encryptionKey);
  }

  status() {
    return {
      configured: true,
      running: this.#running.size > 0,
      lastSuccessfulAt: this.#lastSuccessfulAt,
      lastError: this.#lastError,
    };
  }

  start() {
    if (this.#timer || !this.options.contexts) return;
    this.#timer = setInterval(() => void this.runScheduledCycle().catch(() => undefined), this.options.intervalMs);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  private async runScheduledCycle() {
    const contexts = await this.options.contexts?.() ?? [];
    for (const context of contexts) await this.run(context).catch(() => undefined);
  }

  run(context: WorkspaceContext): Promise<StoredObjectMetadata> {
    const active = this.#running.get(context.workspaceId);
    if (active) return active;
    const operation = this.performRun(context)
      .catch((error) => {
        this.#lastError = error instanceof Error ? error.message : "Hosted encrypted backup failed.";
        throw error;
      })
      .finally(() => this.#running.delete(context.workspaceId));
    this.#running.set(context.workspaceId, operation);
    return operation;
  }

  private async performRun(context: WorkspaceContext) {
    const startedAt = (this.options.now ?? (() => new Date()))();
    const id = randomUUID();
    const path = `backups/${startedAt.toISOString().replace(/[:.]/g, "-")}-${id}.careeros.enc`;
    const bundle = await createPostgresWorkspaceBundle({
      provider: this.options.provider,
      storage: this.options.storage,
      context,
      schemaVersion: this.options.schemaVersion,
      applicationVersion: this.options.applicationVersion,
      exportedAt: startedAt.toISOString(),
    });
    const bytes = encryptBackup(encodePostgresWorkspaceBundle(bundle), decodeBackupKey(this.options.encryptionKey));
    const backupStorage = this.options.backupStorage ?? this.options.storage;
    const stored = await backupStorage.upload({
      workspaceId: context.workspaceId,
      path,
      bytes,
      contentType: "application/vnd.careeros.backup+json",
    });
    try {
      await this.options.provider.transaction(context, async (tx) => {
        await tx.query(
          "INSERT INTO backup_records(id,workspace_id,object_path,checksum,size_bytes,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [id, context.workspaceId, stored.path, stored.checksum, stored.sizeBytes, startedAt.toISOString()],
        );
      });
    } catch (error) {
      try {
        await backupStorage.delete({ workspaceId: context.workspaceId, path });
      } catch (cleanupError) {
        throw new Error(`Backup history could not be recorded and staged object cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error });
      }
      throw error;
    }
    this.#lastSuccessfulAt = startedAt.toISOString();
    this.#lastError = "";
    return stored;
  }

  async list(context: WorkspaceContext, limit = 100): Promise<HostedBackupRecord[]> {
    return this.options.provider.transaction(context, async (tx) => (await tx.query<{
      id: string; object_path: string; checksum: string; size_bytes: number | string; created_at: string | Date;
    }>(`SELECT id,object_path,checksum,size_bytes,created_at FROM backup_records
      WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [context.workspaceId, Math.max(1, Math.min(limit, 100))])).rows.map((row) => ({
        id: row.id,
        path: row.object_path,
        checksum: row.checksum,
        sizeBytes: Number(row.size_bytes),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      })), { readOnly: true });
  }

  async restoreStored(context: WorkspaceContext, id: string): Promise<PostgresWorkspaceRestoreResult> {
    const record = await this.options.provider.transaction(context, async (tx) => (await tx.query<{
      id: string; object_path: string; checksum: string;
    }>("SELECT id,object_path,checksum FROM backup_records WHERE workspace_id=$1 AND id=$2", [context.workspaceId, id])).rows[0], { readOnly: true });
    if (!record) throw Object.assign(new Error("Encrypted backup not found."), { statusCode: 404 });
    const encrypted = await (this.options.backupStorage ?? this.options.storage).read({ workspaceId: context.workspaceId, path: record.object_path, expectedChecksum: record.checksum });
    const bundle = decryptBackup(encrypted.bytes, decodeBackupKey(this.options.encryptionKey));
    return restorePostgresWorkspaceBundle({
      provider: this.options.provider,
      storage: this.options.storage,
      context,
      bundle,
      expectedSchemaVersion: this.options.schemaVersion,
      expectedApplicationVersion: this.options.applicationVersion,
      mode: "replace",
      restoreId: `stored-${record.id}`,
    });
  }
}
