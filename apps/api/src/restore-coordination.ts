import type { BackupBundle } from "./backup-bundle.js";
import type { ObjectStorageAdapter } from "./storage/object-storage.js";

type UploadedRestoreObject = { path: string };

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "not_found";
}

export async function stageRestoreObjects(options: {
  storage: ObjectStorageAdapter;
  workspaceId: string;
  bundle: BackupBundle;
  writePendingMarker: () => void | Promise<void>;
  onCleanupFailure?: (details: { failedPaths: string[]; cause: unknown }) => void;
}) {
  const missing: Array<{ path: string; bytes: Buffer; contentType: string }> = [];
  for (const entry of options.bundle.manifest.files) {
    try {
      await options.storage.read({ workspaceId: options.workspaceId, path: entry.path, expectedChecksum: entry.sha256 });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      missing.push({
        path: entry.path,
        bytes: Buffer.from(options.bundle.files[entry.path], "base64"),
        contentType: entry.path.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
      });
    }
  }

  const uploaded: UploadedRestoreObject[] = [];
  try {
    for (const file of missing) {
      await options.storage.upload({ workspaceId: options.workspaceId, path: file.path, bytes: file.bytes, contentType: file.contentType });
      uploaded.push({ path: file.path });
    }
    await options.writePendingMarker();
  } catch (cause) {
    const cleanup = await Promise.allSettled(uploaded.map((file) => options.storage.delete({ workspaceId: options.workspaceId, path: file.path })));
    const failedPaths = cleanup.flatMap((result, index) => result.status === "rejected" ? [uploaded[index]!.path] : []);
    if (failedPaths.length) {
      options.onCleanupFailure?.({ failedPaths, cause });
      const error = Object.assign(new Error(`Restore staging failed and ${failedPaths.length} newly uploaded object${failedPaths.length === 1 ? "" : "s"} could not be cleaned up. Manual storage cleanup is required.`), {
        statusCode: 502,
        cleanupFailed: true,
      });
      throw error;
    }
    throw cause;
  }

  return { uploadedPaths: uploaded.map((file) => file.path) };
}
