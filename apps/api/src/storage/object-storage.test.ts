import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesystemObjectStorage } from "./filesystem-object-storage.js";
import { ObjectStorageError, sha256 } from "./object-storage.js";
import { SupabaseObjectStorage } from "./supabase-object-storage.js";
import { configuredBackupObjectStorage, configuredObjectStorage, defaultObjectStorageDirectory } from "./configured-storage.js";
import { workspaceObjectKey } from "./storage-path.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "careeros-storage-"));
  temporaryRoots.push(root);
  return root;
}

describe("workspace storage paths", () => {
  it.each(["../secret", "files/../../secret", "/absolute", "files\\secret", "files/%2e%2e/secret", "files/%252e%252e/secret"])(
    "rejects traversal path %s",
    (path) => expect(() => workspaceObjectKey("workspace-a", path)).toThrow(ObjectStorageError),
  );

  it("keeps workspace IDs as an explicit object-key boundary", () => {
    expect(workspaceObjectKey("workspace-a", "documents/cv.pdf")).toBe("workspaces/workspace-a/documents/cv.pdf");
    expect(() => workspaceObjectKey("../workspace-b", "documents/cv.pdf")).toThrow(ObjectStorageError);
  });
});

describe("FilesystemObjectStorage", () => {
  it("tightens existing storage directories and files to owner-only permissions", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "existing", "documents");
    const file = join(directory, "cv.pdf");
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await writeFile(file, "private CV", { mode: 0o644 });
    await chmod(join(root, "existing"), 0o755);
    await chmod(directory, 0o755);
    await chmod(file, 0o644);

    new FilesystemObjectStorage(join(root, "existing"));

    expect((await stat(join(root, "existing"))).mode & 0o777).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("uses a durable sibling root and non-destructively migrates legacy objects", async () => {
    const root = await temporaryRoot();
    const dataDirectory = join(root, "data");
    const legacyObject = join(dataDirectory, "object-storage", "workspaces", "workspace-a", "documents", "cv.pdf");
    await mkdir(join(legacyObject, ".."), { recursive: true });
    await writeFile(legacyObject, "legacy CV");

    const configured = configuredObjectStorage(dataDirectory, "workspace-a", {});
    const durableRoot = defaultObjectStorageDirectory(dataDirectory);
    expect(durableRoot).toBe(join(root, "data-object-storage"));
    await expect(readFile(join(durableRoot, "workspaces", "workspace-a", "documents", "cv.pdf"), "utf8")).resolves.toBe("legacy CV");
    await expect(readFile(legacyObject, "utf8")).resolves.toBe("legacy CV");
    await expect(configured.adapter.read({ workspaceId: "workspace-a", path: "documents/cv.pdf", expectedChecksum: sha256(Buffer.from("legacy CV")) }))
      .resolves.toMatchObject({ sizeBytes: 9 });

    configuredObjectStorage(dataDirectory, "workspace-a", {});
    await expect(readFile(legacyObject, "utf8")).resolves.toBe("legacy CV");
  });

  it("fails closed when legacy and durable immutable objects conflict", async () => {
    const root = await temporaryRoot();
    const dataDirectory = join(root, "data");
    const relative = join("workspaces", "workspace-a", "documents", "cv.pdf");
    await mkdir(join(dataDirectory, "object-storage", "workspaces", "workspace-a", "documents"), { recursive: true });
    await mkdir(join(defaultObjectStorageDirectory(dataDirectory), "workspaces", "workspace-a", "documents"), { recursive: true });
    await writeFile(join(dataDirectory, "object-storage", relative), "legacy");
    await writeFile(join(defaultObjectStorageDirectory(dataDirectory), relative), "different");
    expect(() => configuredObjectStorage(dataDirectory, "workspace-a", {})).toThrow(/conflicts with durable storage/);
  });

  it("keeps existing local backups compatible unless a separate backup store is explicitly configured", async () => {
    const root = await temporaryRoot();
    const dataDirectory = join(root, "data");
    const primary = configuredObjectStorage(dataDirectory, "workspace-a", {});
    const compatible = configuredBackupObjectStorage(dataDirectory, "workspace-a", {});
    const existingBytes = Buffer.from("existing");
    await primary.adapter.upload({ workspaceId: "workspace-a", path: "backups/existing.enc", bytes: existingBytes });
    await expect(compatible.adapter.read({ workspaceId: "workspace-a", path: "backups/existing.enc", expectedChecksum: sha256(existingBytes) })).resolves.toMatchObject({ sizeBytes: 8 });

    const separateRoot = join(root, "separate-backups");
    const separate = configuredBackupObjectStorage(dataDirectory, "workspace-a", {
      CAREEROS_BACKUP_STORAGE_PROVIDER: "filesystem",
      CAREEROS_BACKUP_OBJECT_STORAGE_DIR: separateRoot,
    });
    await separate.adapter.upload({ workspaceId: "workspace-a", path: "backups/new.enc", bytes: Buffer.from("separate") });
    await expect(readFile(join(separateRoot, "workspaces", "workspace-a", "backups", "new.enc"), "utf8")).resolves.toBe("separate");
    await expect(primary.adapter.read({ workspaceId: "workspace-a", path: "backups/new.enc", expectedChecksum: sha256(Buffer.from("separate")) })).rejects.toMatchObject({ code: "not_found" });
  });

  it("uploads, verifies, reads, and deletes a workspace-scoped object", async () => {
    const root = await temporaryRoot();
    const storage = new FilesystemObjectStorage(root);
    const bytes = Buffer.from("CareerOS CV");
    const uploaded = await storage.upload({ workspaceId: "workspace-a", path: "documents/cv.pdf", bytes, contentType: "application/pdf" });

    expect(uploaded).toMatchObject({ checksum: sha256(bytes), sizeBytes: bytes.byteLength });
    await expect(storage.read({ workspaceId: "workspace-a", path: "documents/cv.pdf", expectedChecksum: uploaded.checksum }))
      .resolves.toMatchObject({ checksum: uploaded.checksum, sizeBytes: bytes.byteLength });
    await expect(storage.read({ workspaceId: "workspace-b", path: "documents/cv.pdf", expectedChecksum: uploaded.checksum })).rejects.toMatchObject({ code: "not_found" });

    await storage.delete({ workspaceId: "workspace-a", path: "documents/cv.pdf" });
    await expect(storage.read({ workspaceId: "workspace-a", path: "documents/cv.pdf", expectedChecksum: uploaded.checksum })).rejects.toMatchObject({ code: "not_found" });
  });

  it("detects checksum failures and refuses symlink escapes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const storage = new FilesystemObjectStorage(root);
    await storage.upload({ workspaceId: "workspace-a", path: "documents/cv.pdf", bytes: Buffer.from("original") });
    await expect(storage.read({ workspaceId: "workspace-a", path: "documents/cv.pdf", expectedChecksum: sha256(Buffer.from("different")) }))
      .rejects.toMatchObject({ code: "checksum_mismatch" });

    await symlink(outside, join(root, "workspaces", "workspace-a", "escape"));
    await expect(storage.upload({ workspaceId: "workspace-a", path: "escape/nested/stolen.pdf", bytes: Buffer.from("blocked") }))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(access(join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats paths as immutable and permits only idempotent same-byte uploads", async () => {
    const root = await temporaryRoot();
    const storage = new FilesystemObjectStorage(root);
    const input = { workspaceId: "workspace-a", path: "documents/immutable.pdf", bytes: Buffer.from("version one") };
    await storage.upload(input);
    await expect(storage.upload(input)).resolves.toMatchObject({ checksum: sha256(input.bytes) });
    await expect(storage.upload({ ...input, bytes: Buffer.from("silently replaced") })).rejects.toMatchObject({ code: "conflict" });
    await expect(storage.read({ workspaceId: input.workspaceId, path: input.path, expectedChecksum: sha256(input.bytes) }))
      .resolves.toMatchObject({ checksum: sha256(input.bytes) });
  });
});

describe("SupabaseObjectStorage", () => {
  function adapter(fetchMock: ReturnType<typeof vi.fn>) {
    return new SupabaseObjectStorage({
      supabaseUrl: "https://project.supabase.co",
      bucket: "career-files",
      serviceRoleKey: "test-service-role-secret",
      workspaceId: "workspace-a",
      fetch: fetchMock as typeof fetch,
    });
  }

  it("uses encoded workspace-scoped URLs and never sends credentials in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const storage = adapter(fetchMock);
    const bytes = Buffer.from("private CV");
    const result = await storage.upload({ workspaceId: "workspace-a", path: "CVs/Zain Ahmad.pdf", bytes, contentType: "application/pdf" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://project.supabase.co/storage/v1/object/career-files/workspaces/workspace-a/CVs/Zain%20Ahmad.pdf");
    expect(url).not.toContain("test-service-role-secret");
    expect(init).toMatchObject({ method: "POST" });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-service-role-secret");
    expect(result.checksum).toBe(sha256(bytes));
  });

  it("verifies downloaded bytes and preserves workspace isolation", async () => {
    const bytes = Buffer.from("trusted bytes");
    const fetchMock = vi.fn().mockImplementation(async () => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }));
    const storage = adapter(fetchMock);

    await expect(storage.read({ workspaceId: "workspace-b", path: "documents/cv.pdf", expectedChecksum: sha256(bytes) }))
      .rejects.toMatchObject({ code: "invalid_path" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.read({ workspaceId: "workspace-a", path: "documents/cv.pdf", expectedChecksum: sha256(Buffer.from("tampered")) }))
      .rejects.toMatchObject({ code: "checksum_mismatch" });
  });

  it("maps HTTP and network failures without exposing response bodies or secrets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("internal details containing a secret", { status: 503 }))
      .mockRejectedValueOnce(new Error("socket failure with credentials"));
    const storage = adapter(fetchMock);

    await expect(storage.upload({ workspaceId: "workspace-a", path: "documents/cv.pdf", bytes: Buffer.from("cv") }))
      .rejects.toMatchObject({ code: "provider_failure", status: 503, message: "Supabase storage upload failed with HTTP 503." });
    const failure = await storage.read({ workspaceId: "workspace-a", path: "documents/cv.pdf", expectedChecksum: sha256(Buffer.from("cv")) }).catch((error) => error);
    expect(failure).toMatchObject({ code: "provider_failure", message: "Supabase storage could not be reached.", cause: undefined });
  });

  it("refuses provider overwrite conflicts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("already exists", { status: 409 }))
      .mockResolvedValueOnce(new Response("old", { status: 200 }));
    await expect(adapter(fetchMock).upload({ workspaceId: "workspace-a", path: "documents/immutable.pdf", bytes: Buffer.from("new") }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("x-upsert")).toBe("false");
  });

  it("treats a provider conflict with identical bytes as an idempotent upload", async () => {
    const bytes = Buffer.from("same immutable bytes");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("already exists", { status: 409 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    await expect(adapter(fetchMock).upload({ workspaceId: "workspace-a", path: "documents/immutable.pdf", bytes }))
      .resolves.toMatchObject({ checksum: sha256(bytes), sizeBytes: bytes.byteLength });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports idempotent delete and rejects traversal before making a request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const storage = adapter(fetchMock);
    await expect(storage.delete({ workspaceId: "workspace-a", path: "documents/missing.pdf" })).resolves.toBeUndefined();
    await expect(storage.delete({ workspaceId: "workspace-a", path: "../workspace-b/private.pdf" })).rejects.toMatchObject({ code: "invalid_path" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
