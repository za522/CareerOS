import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { chmod, lstat, link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
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
import { workspaceObjectKey } from "./storage-path.js";

export class FilesystemObjectStorage implements ObjectStorageAdapter {
  readonly #root: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new ObjectStorageError("invalid_path", "A storage root is required.");
    this.#root = resolve(rootDirectory);
    this.#secureExistingTree(this.#root);
  }

  async upload(input: ObjectStorageWrite): Promise<StoredObjectMetadata> {
    const target = this.#target(input.workspaceId, input.path);
    await this.#ensureSafeParent(target);
    await this.#assertRealParentInsideRoot(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(target);
        if (sha256(existing) !== sha256(input.bytes)) throw new ObjectStorageError("conflict", "An immutable object already exists at this path with different content.");
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      workspaceId: input.workspaceId,
      path: input.path,
      checksum: sha256(input.bytes),
      sizeBytes: input.bytes.byteLength,
      contentType: input.contentType,
    };
  }

  async read(input: ObjectStorageRead): Promise<StoredObject> {
    const target = this.#target(input.workspaceId, input.path);
    try {
      await this.#assertRealParentInsideRoot(target);
      const bytes = await readFile(target);
      const checksum = verifyChecksum(bytes, input.expectedChecksum);
      return {
        workspaceId: input.workspaceId,
        path: input.path,
        bytes,
        checksum,
        sizeBytes: bytes.byteLength,
      };
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectStorageError("not_found", "The stored object was not found.", { cause: error });
      }
      throw new ObjectStorageError("provider_failure", "The filesystem storage operation failed.", { cause: error });
    }
  }

  async delete(input: ObjectStorageDelete): Promise<void> {
    const target = this.#target(input.workspaceId, input.path);
    try {
      await this.#assertRealParentInsideRoot(target);
      await rm(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ObjectStorageError("provider_failure", "The filesystem storage operation failed.", { cause: error });
    }
  }

  #target(workspaceId: string, path: string): string {
    const target = resolve(this.#root, ...workspaceObjectKey(workspaceId, path).split("/"));
    if (target !== this.#root && !target.startsWith(`${this.#root}${sep}`)) {
      throw new ObjectStorageError("invalid_path", "The object path escapes its storage workspace.");
    }
    return target;
  }

  async #assertRealParentInsideRoot(target: string): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const [realRoot, realParent] = await Promise.all([realpath(this.#root), realpath(dirname(target))]);
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
      throw new ObjectStorageError("invalid_path", "The object path escapes its storage workspace.");
    }
    try {
      const targetStat = await lstat(target, { bigint: false });
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new ObjectStorageError("invalid_path", "The object path is not a regular file.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #ensureSafeParent(target: string) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const parent = dirname(target);
    const pathFromRoot = relative(this.#root, parent);
    let current = this.#root;
    for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
      current = resolve(current, segment);
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ObjectStorageError("invalid_path", "The object path crosses a symbolic link or non-directory.");
        await chmod(current, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
  }

  #secureExistingTree(directory: string) {
    if (!existsSync(directory)) return;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ObjectStorageError("invalid_path", "The storage root must be a real directory.");
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const entryStat = lstatSync(path);
      if (entryStat.isSymbolicLink()) throw new ObjectStorageError("invalid_path", "Object storage contains an unsafe symbolic link.");
      if (entryStat.isDirectory()) this.#secureExistingTree(path);
      else if (entryStat.isFile()) chmodSync(path, 0o600);
      else throw new ObjectStorageError("invalid_path", "Object storage contains an unsupported filesystem entry.");
    }
  }
}
