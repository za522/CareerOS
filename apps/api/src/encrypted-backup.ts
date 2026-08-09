import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ObjectStorageAdapter, StoredObjectMetadata } from "./storage/object-storage.js";

const FORMAT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";

export type EncryptedBackupEnvelope = {
  version: typeof FORMAT_VERSION;
  algorithm: typeof ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export function decodeBackupKey(value: string) {
  const trimmed = value.trim();
  const bytes = /^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (bytes.byteLength !== 32) throw new Error("CAREEROS_BACKUP_ENCRYPTION_KEY must contain exactly 32 random bytes in base64 or hex.");
  return bytes;
}

export function encryptBackup(plaintext: Uint8Array, key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error("Backup encryption requires a 32-byte key.");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: FORMAT_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  } satisfies EncryptedBackupEnvelope));
}

export function decryptBackup(encrypted: Uint8Array, key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error("Backup decryption requires a 32-byte key.");
  let envelope: EncryptedBackupEnvelope;
  try { envelope = JSON.parse(Buffer.from(encrypted).toString("utf8")) as EncryptedBackupEnvelope; }
  catch { throw new Error("Encrypted CareerOS backup is not valid JSON."); }
  if (envelope.version !== FORMAT_VERSION || envelope.algorithm !== ALGORITHM) throw new Error("Encrypted CareerOS backup format is unsupported.");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  try { return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]); }
  catch { throw new Error("Encrypted CareerOS backup failed authentication."); }
}

export class EncryptedBackupScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<StoredObjectMetadata> | null = null;
  #lastSuccessfulAt: string | null = null;
  #lastError = "";
  #latest: StoredObjectMetadata | null = null;

  constructor(private readonly options: {
    storage: ObjectStorageAdapter;
    workspaceId: string;
    key: Uint8Array;
    createBundle: () => Uint8Array | Promise<Uint8Array>;
    intervalMs: number;
    now?: () => Date;
    onSuccess?: (result: StoredObjectMetadata, completedAt: string) => void | Promise<void>;
    runExclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  }) {
    if (options.intervalMs < 60_000) throw new Error("Scheduled backup intervals must be at least one minute.");
  }

  status() { return { configured: true, running: Boolean(this.#running), lastSuccessfulAt: this.#lastSuccessfulAt, lastError: this.#lastError, latest: this.#latest }; }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.run().catch(() => undefined), this.options.intervalMs);
    this.#timer.unref();
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  run(): Promise<StoredObjectMetadata> {
    if (this.#running) return this.#running;
    const startedAt = (this.options.now ?? (() => new Date()))();
    const path = `backups/${startedAt.toISOString().replace(/[:.]/g, "-")}.careeros.enc`;
    const execute = async () => {
      const bundle = await this.options.createBundle();
      const bytes = encryptBackup(bundle, this.options.key);
      const result = await this.options.storage.upload({ workspaceId: this.options.workspaceId, path, bytes, contentType: "application/vnd.careeros.backup+json" });
      const completedAt = startedAt.toISOString();
      await this.options.onSuccess?.(result, completedAt);
      this.#lastSuccessfulAt = completedAt;
      this.#lastError = "";
      this.#latest = result;
      return result;
    };
    this.#running = (this.options.runExclusive ? this.options.runExclusive(execute) : execute())
      .catch((error) => { this.#lastError = error instanceof Error ? error.message : "Scheduled backup failed."; throw error; })
      .finally(() => { this.#running = null; });
    return this.#running;
  }
}
