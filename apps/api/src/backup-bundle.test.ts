import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeBundlePath,
  applyPendingBackupRestore,
  createBackupBundle,
  encodeBackupBundle,
  prepareBackupRestore,
  readStructuredDatabase,
  validateBackupBundle,
  writePendingRestoreMarker,
  type BackupBundle,
} from "./backup-bundle.js";

const schemaVersion = 7;
const applicationVersion = "0.1.0-test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "careeros-backup-test-"));
  const dataDirectory = join(root, "data");
  mkdirSync(join(dataDirectory, "documents", "cv-1"), { recursive: true });
  const filePath = join("documents", "cv-1", "cv.pdf");
  const file = Buffer.from("%PDF-1.7\nCareerOS CV fixture\n", "utf8");
  writeFileSync(join(dataDirectory, filePath), file);
  const sqlite = new Database(join(dataDirectory, "careeros.sqlite"));
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      attachment BLOB
    );
  `);
  sqlite.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run("cv-1", "Primary CV", filePath, "fixture-checksum");
  sqlite.prepare("INSERT INTO notes (body, attachment) VALUES (?, ?)").run("Preserve this", Buffer.from([0, 1, 2, 255]));
  const bundle = createBackupBundle({ sqlite, dataDirectory, schemaVersion, applicationVersion, exportedAt: "2026-08-08T12:00:00.000Z" });
  return { root, dataDirectory, filePath, file, sqlite, bundle };
}

function clone(bundle: BackupBundle): BackupBundle {
  return JSON.parse(JSON.stringify(bundle)) as BackupBundle;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === "object") {
    const sorted = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, JSON.parse(stable(item))]));
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

function replaceSnapshot(bundle: BackupBundle, mutate: (sqlite: Database.Database) => void) {
  const root = mkdtempSync(join(tmpdir(), "careeros-mutated-snapshot-"));
  const path = join(root, "snapshot.sqlite");
  writeFileSync(path, Buffer.from(bundle.databaseBase64, "base64"));
  const sqlite = new Database(path);
  try {
    mutate(sqlite);
    const database = sqlite.serialize();
    bundle.databaseBase64 = database.toString("base64");
    bundle.manifest.database.sizeBytes = database.byteLength;
    bundle.manifest.database.sha256 = createHash("sha256").update(database).digest("hex");
    bundle.structuredData = readStructuredDatabase(sqlite);
    bundle.manifest.structuredDataSha256 = createHash("sha256").update(stable(bundle.structuredData)).digest("hex");
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("backup bundle", () => {
  it("never includes pending invitation credentials in an export", () => {
    const root = mkdtempSync(join(tmpdir(), "careeros-credential-backup-"));
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE workspace_invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
      CREATE TABLE workspace_invite_sessions (id_hash TEXT PRIMARY KEY, invite_id TEXT NOT NULL);
      CREATE TABLE workspace_memberships (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL);
      INSERT INTO workspace_invites VALUES ('invite-1','secret-invite-hash');
      INSERT INTO workspace_invite_sessions VALUES ('secret-session-hash','invite-1');
      INSERT INTO workspace_memberships VALUES ('workspace-1','collaborator','editor');
    `);
    try {
      const bundle = createBackupBundle({ sqlite, dataDirectory: root, schemaVersion, applicationVersion });
      expect(bundle.structuredData.tables.find((table) => table.name === "workspace_invites")?.rows).toEqual([]);
      expect(bundle.structuredData.tables.find((table) => table.name === "workspace_invite_sessions")?.rows).toEqual([]);
      expect(bundle.structuredData.tables.find((table) => table.name === "workspace_memberships")?.rows).toHaveLength(1);
      expect(JSON.stringify(bundle)).not.toContain("secret-");
      const snapshotPath = join(root, "snapshot.sqlite");
      writeFileSync(snapshotPath, Buffer.from(bundle.databaseBase64, "base64"));
      const snapshot = new Database(snapshotPath, { readonly: true });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM workspace_invites").get()).toEqual({ count: 0 });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM workspace_invite_sessions").get()).toEqual({ count: 0 });
      expect(snapshot.prepare("SELECT role FROM workspace_memberships WHERE user_id='collaborator'").get()).toEqual({ role: "editor" });
      snapshot.close();
    } finally {
      sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitises case-variant SQLite control-plane names", () => {
    const root = mkdtempSync(join(tmpdir(), "careeros-case-credential-backup-"));
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE Workspace_Invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL); INSERT INTO Workspace_Invites VALUES ('invite','case-secret');`);
    try {
      const bundle = createBackupBundle({ sqlite, dataDirectory: root, schemaVersion, applicationVersion });
      expect(JSON.stringify(bundle.structuredData)).not.toContain("case-secret");
      const snapshotPath = join(root, "case-snapshot.sqlite");
      writeFileSync(snapshotPath, Buffer.from(bundle.databaseBase64, "base64"));
      const snapshot = new Database(snapshotPath, { readonly: true });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM Workspace_Invites").get()).toEqual({ count: 0 });
      snapshot.close();
    } finally {
      sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a realistic CareerOS workspace through export and staged restore", () => {
    const root = mkdtempSync(join(tmpdir(), "careeros-portability-acceptance-"));
    const dataDirectory = join(root, "live-data");
    const restoredDirectory = join(root, "restored-data");
    const importedCvPath = "documents/profile/source-cv.pdf";
    const tailoredCvPath = "documents/versions/quant-cv-v2.pdf";
    const importedCv = Buffer.from("%PDF-1.7\nImported source CV\n", "utf8");
    const tailoredCv = Buffer.from("%PDF-1.7\nTailored quant CV\n", "utf8");
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

    mkdirSync(join(dataDirectory, "documents", "profile"), { recursive: true });
    mkdirSync(join(dataDirectory, "documents", "versions"), { recursive: true });
    writeFileSync(join(dataDirectory, importedCvPath), importedCv);
    writeFileSync(join(dataDirectory, tailoredCvPath), tailoredCv);

    const sqlite = new Database(join(dataDirectory, "careeros.sqlite"));
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        job_posting_id TEXT NOT NULL,
        current_status TEXT NOT NULL,
        notes TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE application_events (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id),
        type TEXT NOT NULL,
        status_after TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE source_documents (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        url TEXT,
        raw_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE TABLE field_evidence (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        source_document_id TEXT REFERENCES source_documents(id),
        excerpt TEXT NOT NULL,
        method TEXT NOT NULL,
        suggested_value TEXT NOT NULL,
        confidence REAL NOT NULL,
        user_confirmed INTEGER NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE capture_queue_items (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_url TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        state TEXT NOT NULL,
        draft_json TEXT,
        duplicates_json TEXT NOT NULL,
        enrichment_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        document_type TEXT NOT NULL,
        title TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE document_drafts (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        job_posting_id TEXT NOT NULL,
        content_json TEXT NOT NULL,
        proposal_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        job_posting_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        checkpoint_name TEXT NOT NULL,
        content_json TEXT NOT NULL,
        proposal_changes TEXT NOT NULL,
        proposal_decisions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE application_materials (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id),
        document_id TEXT REFERENCES documents(id),
        document_version_id TEXT REFERENCES document_versions(id),
        material_type TEXT NOT NULL,
        title TEXT NOT NULL
      );
    `);

    const capturedAt = "2026-08-08T09:15:00.000Z";
    const draftContent = {
      name: "Zain Ahmad",
      intro: "Design engineer applying quantitative reasoning to markets.",
      sections: [{ id: "section-1", group: "Experience", title: "SageCare", content: "Built an accessible TypeScript product." }],
      style: { fontFamily: "Manrope", fontSize: 10.5, lineHeight: 1.1 },
    };
    const proposalState = {
      activeTurnId: "turn-1",
      turns: [{
        id: "turn-1",
        request: "Make the SageCare bullet more concise.",
        decisions: { "change-1": "pending" },
        proposal: { changes: [{ id: "change-1", targetSectionId: "section-1", proposedContent: "Built an accessible TypeScript product." }] },
      }],
    };
    const captureDraft = {
      title: "Quantitative Trading Analyst",
      companyName: "Meridian Capital",
      location: "London",
      sourceUrl: "https://example.com/jobs/quant-1",
      requiredRequirements: ["Python", "Probability"],
    };

    sqlite.prepare("INSERT INTO applications VALUES (?, ?, ?, ?, ?)")
      .run("application-1", "job-1", "Interview", "Prepare probability examples", 4);
    const insertEvent = sqlite.prepare("INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?)");
    insertEvent.run("event-1", "application-1", "application_submitted", "Applied", "2026-08-08T10:00:00.000Z", "Submitted directly", "2026-08-08T10:00:00.000Z");
    insertEvent.run("event-2", "application-1", "interview_scheduled", "Interview", "2026-08-10T14:00:00.000Z", "First-round interview", "2026-08-09T11:00:00.000Z");
    sqlite.prepare("INSERT INTO source_documents VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("source-1", "pasted_text", "https://example.com/jobs/quant-1", "Quantitative Trading Analyst. Python and probability required.", "source-hash", capturedAt, JSON.stringify({ employer: "Meridian Capital" }));
    sqlite.prepare("INSERT INTO field_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("evidence-1", "JobPosting", "job-1", "requiredRequirements[0]", "source-1", "Python and probability required", "deterministic", "Python", 0.98, 1, capturedAt);
    sqlite.prepare("INSERT INTO capture_queue_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("capture-1", "pasted_text", "https://example.com/jobs/quant-1", "Full raw pasted job text that must survive backup.", "Needs Review", JSON.stringify(captureDraft), JSON.stringify([{ entityId: "job-existing", score: 0.91 }]), JSON.stringify({ provider: "openai", evidenceCount: 5 }), null, capturedAt, capturedAt, 3);
    sqlite.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("document-1", "cv", "Quant master CV", importedCvPath, digest(importedCv), "application/pdf", importedCv.byteLength, capturedAt, capturedAt, 2);
    sqlite.prepare("INSERT INTO document_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("draft-1", "document-1", "job-1", JSON.stringify(draftContent), JSON.stringify(proposalState), capturedAt, capturedAt, 7);
    sqlite.prepare("INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("version-1", "document-1", "job-1", 2, tailoredCvPath, digest(tailoredCv), "Quant application snapshot", JSON.stringify(draftContent), JSON.stringify(proposalState.turns[0].proposal.changes), JSON.stringify({ "change-1": "accepted" }), capturedAt, capturedAt, 1);
    sqlite.prepare("INSERT INTO application_materials VALUES (?, ?, ?, ?, ?, ?)")
      .run("material-1", "application-1", "document-1", "version-1", "cv", "Quant application CV");

    try {
      const expectedTables = readStructuredDatabase(sqlite);
      const bundle = createBackupBundle({ sqlite, dataDirectory, schemaVersion, applicationVersion, exportedAt: "2026-08-08T12:00:00.000Z" });
      const prepared = prepareBackupRestore({ bundle: encodeBackupBundle(bundle), destinationDataDirectory: restoredDirectory, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });

      expect(existsSync(restoredDirectory)).toBe(false);
      expect(existsSync(join(prepared.stagingDirectory, "careeros.sqlite"))).toBe(true);
      expect(readFileSync(join(prepared.stagingDirectory, importedCvPath))).toEqual(importedCv);
      expect(readFileSync(join(prepared.stagingDirectory, tailoredCvPath))).toEqual(tailoredCv);
      prepared.commit();

      const restored = new Database(join(restoredDirectory, "careeros.sqlite"), { readonly: true });
      try {
        expect(readStructuredDatabase(restored)).toEqual(expectedTables);
        expect(restored.prepare("SELECT type, status_after AS statusAfter, occurred_at AS occurredAt, note FROM application_events ORDER BY occurred_at").all()).toEqual([
          { type: "application_submitted", statusAfter: "Applied", occurredAt: "2026-08-08T10:00:00.000Z", note: "Submitted directly" },
          { type: "interview_scheduled", statusAfter: "Interview", occurredAt: "2026-08-10T14:00:00.000Z", note: "First-round interview" },
        ]);
        expect(JSON.parse((restored.prepare("SELECT draft_json AS draftJson FROM capture_queue_items WHERE id = ?").get("capture-1") as { draftJson: string }).draftJson)).toEqual(captureDraft);
        expect(JSON.parse((restored.prepare("SELECT proposal_state_json AS proposalState FROM document_drafts WHERE id = ?").get("draft-1") as { proposalState: string }).proposalState)).toEqual(proposalState);
      } finally {
        restored.close();
      }

      for (const entry of bundle.manifest.files) {
        const bytes = readFileSync(join(restoredDirectory, entry.path));
        expect(bytes.byteLength).toBe(entry.sizeBytes);
        expect(digest(bytes)).toBe(entry.sha256);
      }
      expect(readFileSync(join(restoredDirectory, importedCvPath))).toEqual(importedCv);
      expect(readFileSync(join(restoredDirectory, tailoredCvPath))).toEqual(tailoredCv);
      prepared.finalize();
    } finally {
      sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round trips structured rows, blobs, the SQLite snapshot, and associated files", () => {
    const value = fixture();
    const destination = join(value.root, "restored");
    try {
      const encoded = encodeBackupBundle(value.bundle);
      const prepared = prepareBackupRestore({ bundle: encoded, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(prepared.stagingDirectory)).toBe(true);
      prepared.commit();

      const restored = new Database(join(destination, "careeros.sqlite"), { readonly: true });
      expect(restored.prepare("SELECT body FROM notes").get()).toEqual({ body: "Preserve this" });
      expect((restored.prepare("SELECT attachment FROM notes").get() as { attachment: Buffer }).attachment).toEqual(Buffer.from([0, 1, 2, 255]));
      restored.close();
      expect(readFileSync(join(destination, value.filePath))).toEqual(value.file);
      expect(prepared.recoveryDirectory).toBeNull();
      prepared.finalize();
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("keeps the live directory untouched until commit and supports rollback", () => {
    const value = fixture();
    const destination = join(value.root, "live");
    mkdirSync(destination);
    writeFileSync(join(destination, "original.txt"), "keep me");
    try {
      const prepared = prepareBackupRestore({ bundle: value.bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });
      expect(readFileSync(join(destination, "original.txt"), "utf8")).toBe("keep me");
      prepared.commit();
      expect(existsSync(join(destination, "careeros.sqlite"))).toBe(true);
      expect(prepared.recoveryDirectory).not.toBeNull();
      prepared.rollback();
      expect(readFileSync(join(destination, "original.txt"), "utf8")).toBe("keep me");
      expect(existsSync(join(destination, "careeros.sqlite"))).toBe(false);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("truthfully resumes finalization after marker cleanup fails with restored data already active", () => {
    const value = fixture();
    const destination = join(value.root, "live-restart-data");
    const markerPath = join(value.root, ".live-restart-data-restore-pending.json");
    mkdirSync(destination);
    writeFileSync(join(destination, "original.txt"), "old workspace");
    try {
      const prepared = prepareBackupRestore({ bundle: value.bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });
      writePendingRestoreMarker({ markerPath, prepared, databaseSha256: value.bundle.manifest.database.sha256 });
      expect(() => applyPendingBackupRestore({
        markerPath, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion,
        operations: { removeMarker: () => { throw new Error("simulated marker cleanup failure"); }, removeRecovery: () => undefined },
      })).toThrow(expect.objectContaining({ restoreApplied: true }));
      expect(existsSync(join(destination, "careeros.sqlite"))).toBe(true);
      expect(existsSync(markerPath)).toBe(true);

      const completed = applyPendingBackupRestore({ markerPath, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });
      expect(completed).toEqual({ applied: true, recoveryRetained: null });
      expect(existsSync(markerPath)).toBe(false);
      expect(new Database(join(destination, "careeros.sqlite"), { readonly: true }).prepare("SELECT body FROM notes").get()).toEqual({ body: "Preserve this" });
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("keeps restored data active and reports the exact recovery directory when old-data cleanup fails", () => {
    const value = fixture();
    const destination = join(value.root, "live-cleanup-data");
    const markerPath = join(value.root, ".live-cleanup-data-restore-pending.json");
    mkdirSync(destination);
    writeFileSync(join(destination, "original.txt"), "old workspace");
    try {
      const prepared = prepareBackupRestore({ bundle: value.bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });
      writePendingRestoreMarker({ markerPath, prepared, databaseSha256: value.bundle.manifest.database.sha256 });
      const result = applyPendingBackupRestore({
        markerPath, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion,
        operations: { removeMarker: (path) => rmSync(path), removeRecovery: () => { throw new Error("simulated cleanup failure"); } },
      });
      expect(result.recoveryRetained).toEqual(expect.stringContaining(".recovery-"));
      expect(existsSync(result.recoveryRetained!)).toBe(true);
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(join(destination, "careeros.sqlite"))).toBe(true);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("recovers the retained previous database when an activated restore later fails checksum verification", () => {
    const value = fixture();
    const destination = join(value.root, "live-damaged-active");
    const markerPath = join(value.root, ".live-damaged-active-restore-pending.json");
    mkdirSync(destination);
    writeFileSync(join(destination, "original.txt"), "previous workspace");
    try {
      const prepared = prepareBackupRestore({ bundle: value.bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion });
      writePendingRestoreMarker({ markerPath, prepared, databaseSha256: value.bundle.manifest.database.sha256 });
      expect(() => applyPendingBackupRestore({
        markerPath, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion,
        operations: { removeMarker: () => { throw new Error("leave marker for restart"); }, removeRecovery: () => undefined },
      })).toThrow(expect.objectContaining({ restoreApplied: true }));
      writeFileSync(join(destination, "careeros.sqlite"), "damaged active database");
      expect(() => applyPendingBackupRestore({ markerPath, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(expect.objectContaining({ restoreRecovered: true }));
      expect(readFileSync(join(destination, "original.txt"), "utf8")).toBe("previous workspace");
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered database snapshot", () => {
    const value = fixture();
    try {
      const bundle = clone(value.bundle);
      bundle.databaseBase64 = Buffer.from("tampered database").toString("base64");
      expect(() => validateBackupBundle(bundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/Database snapshot checksum/);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("validates a multi-megabyte database snapshot without overflowing the validator", () => {
    const value = fixture();
    try {
      value.sqlite.prepare("INSERT INTO notes (body, attachment) VALUES (?, ?)")
        .run("Large realistic attachment", Buffer.alloc(5 * 1024 * 1024, 0x5a));
      const bundle = createBackupBundle({
        sqlite: value.sqlite,
        dataDirectory: value.dataDirectory,
        schemaVersion,
        applicationVersion,
      });
      expect(bundle.databaseBase64.length).toBeGreaterThan(5_000_000);
      expect(() => validateBackupBundle(bundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .not.toThrow();
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects tampered structured data", () => {
    const value = fixture();
    try {
      const bundle = clone(value.bundle);
      bundle.structuredData.tables[0]!.rows = [];
      expect(() => validateBackupBundle(bundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/Structured database checksum/);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered associated file", () => {
    const value = fixture();
    try {
      const bundle = clone(value.bundle);
      bundle.files[value.filePath] = Buffer.from("not the CV").toString("base64");
      expect(() => validateBackupBundle(bundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/Checksum or size mismatch/);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects missing associated files during export and restore validation", () => {
    const value = fixture();
    try {
      rmSync(join(value.dataDirectory, value.filePath));
      expect(() => createBackupBundle({ sqlite: value.sqlite, dataDirectory: value.dataDirectory, schemaVersion, applicationVersion }))
        .toThrow(/Associated file is missing/);

      const bundle = clone(value.bundle);
      delete bundle.files[value.filePath];
      expect(() => validateBackupBundle(bundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/not valid base64/);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects bundle, schema, and application version mismatches", () => {
    const value = fixture();
    try {
      const wrongBundle = clone(value.bundle);
      (wrongBundle.manifest as unknown as { bundleVersion: number }).bundleVersion = 2;
      expect(() => validateBackupBundle(wrongBundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/Unsupported backup bundle version/);
      expect(() => validateBackupBundle(value.bundle, { expectedSchemaVersion: 8, expectedApplicationVersion: applicationVersion }))
        .toThrow(/schema version/);
      expect(() => validateBackupBundle(value.bundle, { expectedSchemaVersion: schemaVersion, expectedApplicationVersion: "0.2.0" }))
        .toThrow(/application version/);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each(["../outside", "documents/../../outside", "/absolute/file", "documents\\outside", "documents//file", "./file", ""])(
    "rejects traversal or unsafe path %j",
    (path) => expect(() => assertSafeBundlePath(path)).toThrow(/Unsafe backup path/),
  );

  it("rejects a manifest traversal path before writing anything", () => {
    const value = fixture();
    const destination = join(value.root, "never-created");
    try {
      const bundle = clone(value.bundle);
      bundle.manifest.files[0]!.path = "../escaped.pdf";
      bundle.files["../escaped.pdf"] = bundle.files[value.filePath]!;
      delete bundle.files[value.filePath];
      expect(() => prepareBackupRestore({ bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/Unsafe backup path/);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(value.root, "escaped.pdf"))).toBe(false);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects a validly checksummed bundle when its SQLite snapshot and structured export disagree", () => {
    const value = fixture();
    const destination = join(value.root, "not-restored");
    try {
      const otherDbPath = join(value.root, "other.sqlite");
      const other = new Database(otherDbPath);
      other.exec("CREATE TABLE different (id TEXT PRIMARY KEY); INSERT INTO different VALUES ('x');");
      const database = other.serialize();
      other.close();
      const bundle = clone(value.bundle);
      bundle.databaseBase64 = database.toString("base64");
      bundle.manifest.database.sizeBytes = database.byteLength;
      bundle.manifest.database.sha256 = createHash("sha256").update(database).digest("hex");
      expect(() => prepareBackupRestore({ bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/does not agree/);
      expect(existsSync(destination)).toBe(false);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects a checksum-valid snapshot containing a traversal path before replacing current data", () => {
    const value = fixture();
    const destination = join(value.root, "current-data");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "current workspace");
    try {
      const bundle = clone(value.bundle);
      replaceSnapshot(bundle, (sqlite) => sqlite.prepare("UPDATE documents SET relative_path = ? WHERE id = ?").run("../../.zshrc", "cv-1"));
      expect(() => prepareBackupRestore({ bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/Unsafe backup path/);
      expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("current workspace");
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects checksum-valid invitation secrets instead of importing access credentials", () => {
    const value = fixture();
    const destination = join(value.root, "not-restored");
    try {
      const bundle = clone(value.bundle);
      replaceSnapshot(bundle, (sqlite) => sqlite.exec(`
        CREATE TABLE workspace_invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
        INSERT INTO workspace_invites (id, token_hash) VALUES ('attacker', 'secret-token-hash');
      `));
      expect(() => prepareBackupRestore({ bundle, destinationDataDirectory: destination, expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/non-portable authentication state/);
      expect(existsSync(destination)).toBe(false);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it("rejects checksum-valid case-variant invitation session secrets", () => {
    const value = fixture();
    try {
      const bundle = clone(value.bundle);
      replaceSnapshot(bundle, (sqlite) => sqlite.exec(`CREATE TABLE Workspace_Invite_Sessions (id TEXT PRIMARY KEY, token_hash TEXT); INSERT INTO Workspace_Invite_Sessions VALUES ('secret','hash');`));
      expect(() => prepareBackupRestore({ bundle, destinationDataDirectory: join(value.root, "not-restored-case"), expectedSchemaVersion: schemaVersion, expectedApplicationVersion: applicationVersion }))
        .toThrow(/non-portable authentication state/);
    } finally {
      value.sqlite.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
