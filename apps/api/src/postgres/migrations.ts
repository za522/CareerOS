import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PostgresCloudDataProvider } from "./provider.js";

export const CLOUD_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migrations/", import.meta.url));
export const CLOUD_FOUNDATION_MIGRATION = fileURLToPath(new URL("./migrations/0001_cloud_foundation.sql", import.meta.url));

export interface DiscoveredCloudMigration {
  version: string;
  checksum: string;
  sql: string;
  path: string;
}

export async function discoverCloudMigrations(directory = CLOUD_MIGRATIONS_DIRECTORY): Promise<DiscoveredCloudMigration[]> {
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error("No CareerOS cloud migrations were found.");
  const versions = new Set<string>();
  const migrations: DiscoveredCloudMigration[] = [];
  for (const file of files) {
    const version = file.slice(0, -4);
    if (versions.has(version)) throw new Error(`Duplicate cloud migration version: ${version}`);
    versions.add(version);
    const path = directory === CLOUD_MIGRATIONS_DIRECTORY ? fileURLToPath(new URL(`./migrations/${file}`, import.meta.url)) : join(directory, file);
    const sql = await readFile(path, "utf8");
    migrations.push({ version, checksum: createHash("sha256").update(sql).digest("hex"), sql, path });
  }
  return migrations;
}

export async function migrateCloudFoundation(provider: PostgresCloudDataProvider): Promise<void> {
  await provider.migrateVersions(await discoverCloudMigrations());
}
