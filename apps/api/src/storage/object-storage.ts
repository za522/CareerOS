import { createHash } from "node:crypto";

export type ObjectStorageWrite = {
  workspaceId: string;
  path: string;
  bytes: Uint8Array;
  contentType?: string;
};

export type ObjectStorageRead = {
  workspaceId: string;
  path: string;
  expectedChecksum: string;
};

export type ObjectStorageDelete = {
  workspaceId: string;
  path: string;
};

export type StoredObject = {
  workspaceId: string;
  path: string;
  bytes: Uint8Array;
  checksum: string;
  sizeBytes: number;
  contentType?: string;
};

export type StoredObjectMetadata = Omit<StoredObject, "bytes">;

export interface ObjectStorageAdapter {
  upload(input: ObjectStorageWrite): Promise<StoredObjectMetadata>;
  read(input: ObjectStorageRead): Promise<StoredObject>;
  delete(input: ObjectStorageDelete): Promise<void>;
}

export class ObjectStorageError extends Error {
  readonly code: "invalid_path" | "not_found" | "conflict" | "checksum_mismatch" | "provider_failure";
  readonly status?: number;

  constructor(
    code: ObjectStorageError["code"],
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ObjectStorageError";
    this.code = code;
    this.status = options.status;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyChecksum(bytes: Uint8Array, expectedChecksum: string): string {
  const checksum = sha256(bytes);
  if (!/^[a-f0-9]{64}$/i.test(expectedChecksum) || checksum !== expectedChecksum.toLowerCase()) {
    throw new ObjectStorageError(
      "checksum_mismatch",
      "The stored object failed checksum verification.",
    );
  }
  return checksum;
}
