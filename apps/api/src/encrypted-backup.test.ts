import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeBackupKey, decryptBackup, encryptBackup, EncryptedBackupScheduler } from "./encrypted-backup.js";

describe("encrypted scheduled backups", () => {
  it("round trips authenticated bytes and rejects tampering or the wrong key", () => {
    const key = randomBytes(32);
    const encrypted = encryptBackup(Buffer.from("private CareerOS workspace"), key);
    expect(encrypted.toString()).not.toContain("private CareerOS workspace");
    expect(decryptBackup(encrypted, key).toString()).toBe("private CareerOS workspace");
    expect(() => decryptBackup(encrypted, randomBytes(32))).toThrow(/failed authentication/);
    const changed = Buffer.from(encrypted);
    changed[changed.length - 10] ^= 1;
    expect(() => decryptBackup(changed, key)).toThrow();
  });

  it("requires a full random key", () => {
    const key = randomBytes(32);
    expect(decodeBackupKey(key.toString("base64"))).toEqual(key);
    expect(decodeBackupKey(key.toString("hex"))).toEqual(key);
    expect(() => decodeBackupKey("short")).toThrow(/32 random bytes/);
  });

  it("deduplicates overlapping runs and records success without exposing the key", async () => {
    const onSuccess = vi.fn();
    const upload = vi.fn(async (input: { workspaceId: string; path: string; bytes: Uint8Array; contentType?: string }) => ({
      workspaceId: input.workspaceId, path: input.path, checksum: "checksum", sizeBytes: input.bytes.byteLength, contentType: input.contentType,
    }));
    const scheduler = new EncryptedBackupScheduler({
      storage: { upload, read: vi.fn(), delete: vi.fn() }, workspaceId: "workspace-a", key: randomBytes(32),
      createBundle: async () => Buffer.from("bundle"), intervalMs: 60_000, now: () => new Date("2026-08-09T05:00:00.000Z"), onSuccess,
    });
    const [first, second] = await Promise.all([scheduler.run(), scheduler.run()]);
    expect(first).toEqual(second);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toMatchObject({ workspaceId: "workspace-a", path: "backups/2026-08-09T05-00-00-000Z.careeros.enc" });
    expect(onSuccess).toHaveBeenCalledWith(first, "2026-08-09T05:00:00.000Z");
    expect(scheduler.status()).toMatchObject({ configured: true, running: false, lastSuccessfulAt: "2026-08-09T05:00:00.000Z", lastError: "", latest: first });
  });
});
