import {
  ObjectStorageError,
  sha256,
  verifyChecksum,
  type ObjectStorageAdapter,
  type ObjectStorageDelete,
  type ObjectStorageRead,
  type ObjectStorageWrite,
  type StoredObject,
  type StoredObjectMetadata,
} from "./object-storage.js";
import { assertStoragePath, assertWorkspaceId, encodeObjectKey, workspaceObjectKey } from "./storage-path.js";

export type SupabaseObjectStorageOptions = {
  supabaseUrl: string;
  bucket: string;
  serviceRoleKey: string;
  workspaceId: string;
  fetch?: typeof globalThis.fetch;
};

export class SupabaseObjectStorage implements ObjectStorageAdapter {
  readonly #baseUrl: string;
  readonly #bucket: string;
  readonly #serviceRoleKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #workspaceId: string;

  constructor(options: SupabaseObjectStorageOptions) {
    let url: URL;
    try {
      url = new URL(options.supabaseUrl);
    } catch {
      throw new ObjectStorageError("provider_failure", "A valid Supabase URL is required.");
    }
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new ObjectStorageError("provider_failure", "Supabase storage requires HTTPS outside local development.");
    }
    if (!options.bucket || options.bucket.includes("/") || options.bucket.includes("\\")) {
      throw new ObjectStorageError("invalid_path", "A valid Supabase storage bucket is required.");
    }
    if (!options.serviceRoleKey) throw new ObjectStorageError("provider_failure", "A Supabase service role key is required.");
    this.#workspaceId = assertWorkspaceId(options.workspaceId);
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#bucket = options.bucket;
    this.#serviceRoleKey = options.serviceRoleKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async upload(input: ObjectStorageWrite): Promise<StoredObjectMetadata> {
    const checksum = sha256(input.bytes);
    const response = await this.#request(input.workspaceId, input.path, {
      method: "POST",
      headers: {
        "content-type": input.contentType ?? "application/octet-stream",
        "x-upsert": "false",
        "x-metadata": JSON.stringify({ sha256: checksum }),
      },
      body: Buffer.from(input.bytes),
    });
    if (response.status === 409) {
      try {
        await this.read({ workspaceId: input.workspaceId, path: input.path, expectedChecksum: checksum });
      } catch (error) {
        if (error instanceof ObjectStorageError && error.code === "checksum_mismatch") {
          throw new ObjectStorageError("conflict", "An immutable object already exists at this path with different content.", { status: 409 });
        }
        throw error;
      }
    } else {
      await this.#expectSuccess(response, "upload");
    }
    return {
      workspaceId: input.workspaceId,
      path: input.path,
      checksum,
      sizeBytes: input.bytes.byteLength,
      contentType: input.contentType,
    };
  }

  async read(input: ObjectStorageRead): Promise<StoredObject> {
    const response = await this.#request(input.workspaceId, input.path, { method: "GET" });
    await this.#expectSuccess(response, "read");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const checksum = verifyChecksum(bytes, input.expectedChecksum);
    return {
      workspaceId: input.workspaceId,
      path: input.path,
      bytes,
      checksum,
      sizeBytes: bytes.byteLength,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async delete(input: ObjectStorageDelete): Promise<void> {
    const response = await this.#request(input.workspaceId, input.path, { method: "DELETE" });
    if (response.status === 404) return;
    await this.#expectSuccess(response, "delete");
  }

  #request(workspaceId: string, path: string, init: RequestInit): Promise<Response> {
    if (workspaceId !== this.#workspaceId) throw new ObjectStorageError("invalid_path", "This storage adapter is bound to a different workspace.");
    const key = workspaceObjectKey(assertWorkspaceId(workspaceId), assertStoragePath(path));
    const url = `${this.#baseUrl}/storage/v1/object/${encodeURIComponent(this.#bucket)}/${encodeObjectKey(key)}`;
    return this.#fetch(url, {
      ...init,
      headers: {
        apikey: this.#serviceRoleKey,
        authorization: `Bearer ${this.#serviceRoleKey}`,
        ...init.headers,
      },
    }).catch(() => {
      throw new ObjectStorageError("provider_failure", "Supabase storage could not be reached.");
    });
  }

  async #expectSuccess(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    if (response.status === 404) {
      throw new ObjectStorageError("not_found", "The stored object was not found.", { status: 404 });
    }
    if (response.status === 409) throw new ObjectStorageError("conflict", "An immutable object already exists at this path.", { status: 409 });
    throw new ObjectStorageError(
      "provider_failure",
      `Supabase storage ${operation} failed with HTTP ${response.status}.`,
      { status: response.status },
    );
  }
}
