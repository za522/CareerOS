import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCloudMigrations } from "./migrations.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ordered cloud migration discovery", () => {
  it("sorts valid SQL versions and computes content checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "careeros-migrations-"));
    directories.push(directory);
    await writeFile(join(directory, "0002_second.sql"), "SELECT 2;\n");
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(directory, "README.md"), "ignored");
    const migrations = await discoverCloudMigrations(directory);
    expect(migrations.map((migration) => migration.version)).toEqual(["0001_first", "0002_second"]);
    expect(migrations[0].checksum).toBe(createHash("sha256").update("SELECT 1;\n").digest("hex"));
  });

  it("fails clearly when no ordered migration exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "careeros-migrations-empty-"));
    directories.push(directory);
    await expect(discoverCloudMigrations(directory)).rejects.toThrow("No CareerOS cloud migrations were found");
  });

  it("discovers every append-only production migration in identity order", async () => {
    const migrations = await discoverCloudMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual([
      "0001_cloud_foundation",
      "0002_complete_workspace",
      "0003_notification_delivery_history",
      "0004_schema_identity_repairs",
      "0005_realtime_outbox",
      "0006_rapid_capture",
      "0007_realtime_membership_attempts",
      "0008_workspace_telegram_discovery_hardening",
      "0009_telegram_delivery_safety",
      "0010_discovery_reliability",
      "0011_discovery_backoff",
      "0012_document_version_immutability",
      "0013_document_version_pdf_atomicity",
      "0014_runtime_owner_rls_boundary",
    ]);
    expect(new Set(migrations.map((migration) => migration.checksum)).size).toBe(migrations.length);
  });
});
