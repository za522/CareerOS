import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { FilesystemObjectStorage } from "./filesystem-object-storage.js";
import { SupabaseObjectStorage } from "./supabase-object-storage.js";
import type { ObjectStorageAdapter } from "./object-storage.js";

export type ConfiguredStorage = { provider: "filesystem" | "supabase"; adapter: ObjectStorageAdapter };

export function defaultObjectStorageDirectory(dataDirectory: string) {
  return join(dirname(dataDirectory), `${basename(dataDirectory)}-object-storage`);
}

function checksum(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function migrateLegacyObjectStorage(dataDirectory: string, destination: string) {
  const legacy = join(dataDirectory, "object-storage");
  if (!existsSync(legacy) || legacy === destination) return { copied: 0, legacy };
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  let copied = 0;
  const visit = (sourceDirectory: string, targetDirectory: string) => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const source = join(sourceDirectory, entry.name);
      const target = join(targetDirectory, entry.name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error("Legacy object storage contains an unsafe symbolic link.");
      if (stat.isDirectory()) {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        visit(source, target);
        continue;
      }
      if (!stat.isFile()) throw new Error("Legacy object storage contains an unsupported filesystem entry.");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      try {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        copied += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (checksum(source) !== checksum(target)) throw new Error(`Legacy object conflicts with durable storage: ${entry.name}`);
      }
    }
  };
  visit(legacy, destination);
  return { copied, legacy };
}

export function configuredObjectStorage(dataDirectory: string, workspaceId: string, env: NodeJS.ProcessEnv = process.env): ConfiguredStorage {
  const provider = env.CAREEROS_STORAGE_PROVIDER?.trim().toLowerCase() || "filesystem";
  if (provider === "filesystem") {
    const root = env.CAREEROS_OBJECT_STORAGE_DIR?.trim() || defaultObjectStorageDirectory(dataDirectory);
    migrateLegacyObjectStorage(dataDirectory, root);
    return { provider, adapter: new FilesystemObjectStorage(root) };
  }
  if (provider !== "supabase") throw new Error(`Unsupported CAREEROS_STORAGE_PROVIDER: ${provider}.`);
  return {
    provider,
    adapter: new SupabaseObjectStorage({
      supabaseUrl: env.SUPABASE_URL?.trim() ?? "",
      bucket: env.CAREEROS_STORAGE_BUCKET?.trim() || "career-files",
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "",
      workspaceId,
    }),
  };
}

export function configuredBackupObjectStorage(dataDirectory: string, workspaceId: string, env: NodeJS.ProcessEnv = process.env): ConfiguredStorage {
  if (!env.CAREEROS_BACKUP_STORAGE_PROVIDER?.trim()
    && !env.CAREEROS_BACKUP_OBJECT_STORAGE_DIR?.trim()
    && !env.CAREEROS_BACKUP_STORAGE_BUCKET?.trim()) {
    return configuredObjectStorage(dataDirectory, workspaceId, env);
  }
  return configuredObjectStorage(dataDirectory, workspaceId, {
    ...env,
    CAREEROS_STORAGE_PROVIDER: env.CAREEROS_BACKUP_STORAGE_PROVIDER?.trim() || env.CAREEROS_STORAGE_PROVIDER,
    CAREEROS_OBJECT_STORAGE_DIR: env.CAREEROS_BACKUP_OBJECT_STORAGE_DIR?.trim()
      || `${defaultObjectStorageDirectory(dataDirectory)}-backups`,
    CAREEROS_STORAGE_BUCKET: env.CAREEROS_BACKUP_STORAGE_BUCKET?.trim() || "career-backups",
  });
}
