import { describe, expect, it, vi } from "vitest";
import type { BackupBundle } from "./backup-bundle.js";
import { stageRestoreObjects } from "./restore-coordination.js";
import { ObjectStorageError, sha256, type ObjectStorageAdapter } from "./storage/object-storage.js";

function bundleWithFile(path = "documents/recovered.pdf"): BackupBundle {
  const bytes = Buffer.from("restored file");
  return {
    manifest: {
      bundleVersion: 1,
      schemaVersion: 4,
      applicationVersion: "0.1.0",
      exportedAt: "2026-08-09T00:00:00.000Z",
      structuredDataSha256: "unused",
      database: { path: "careeros.sqlite", sizeBytes: 0, sha256: sha256(Buffer.alloc(0)) },
      files: [{ path, sizeBytes: bytes.byteLength, sha256: sha256(bytes) }],
    },
    structuredData: { objects: [], tables: [] },
    databaseBase64: "",
    files: { [path]: bytes.toString("base64") },
  };
}

function missingStorage(options: { deleteFails?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const adapter: ObjectStorageAdapter = {
    read: vi.fn(async () => { throw new ObjectStorageError("not_found", "missing"); }),
    upload: vi.fn(async (input) => {
      objects.set(input.path, input.bytes);
      return { workspaceId: input.workspaceId, path: input.path, checksum: sha256(input.bytes), sizeBytes: input.bytes.byteLength };
    }),
    delete: vi.fn(async (input) => {
      if (options.deleteFails) throw new ObjectStorageError("provider_failure", "provider detail must stay private");
      objects.delete(input.path);
    }),
  };
  return { adapter, objects };
}

describe("restore object staging", () => {
  it("rolls back every newly uploaded object when the pending marker cannot be written", async () => {
    const storage = missingStorage();
    await expect(stageRestoreObjects({
      storage: storage.adapter,
      workspaceId: "workspace-a",
      bundle: bundleWithFile(),
      writePendingMarker: () => { throw new Error("marker write failed"); },
    })).rejects.toThrow("marker write failed");
    expect(storage.objects.size).toBe(0);
    expect(storage.adapter.delete).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "documents/recovered.pdf" });
  });

  it("surfaces cleanup failure without leaking provider details", async () => {
    const storage = missingStorage({ deleteFails: true });
    const onCleanupFailure = vi.fn();
    let error: Error & { statusCode?: number; cleanupFailed?: boolean };
    try {
      await stageRestoreObjects({
        storage: storage.adapter,
        workspaceId: "workspace-a",
        bundle: bundleWithFile(),
        writePendingMarker: () => { throw new Error("sensitive marker detail"); },
        onCleanupFailure,
      });
      throw new Error("Expected restore staging to fail.");
    } catch (caught) {
      error = caught as Error & { statusCode?: number; cleanupFailed?: boolean };
    }
    expect(error).toMatchObject({ statusCode: 502, cleanupFailed: true });
    expect(error.message).toContain("Manual storage cleanup is required");
    expect(error.message).not.toMatch(/provider detail|sensitive marker detail/);
    expect(onCleanupFailure).toHaveBeenCalledWith(expect.objectContaining({ failedPaths: ["documents/recovered.pdf"] }));
  });
});
