import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { repairLegacyMergedDiscoveryPostings } from "./discovery-repair.js";

describe("legacy discovery alias repair", () => {
  it("splits same-source requisitions idempotently while preserving cross-source aliases and data", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE discovered_postings (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL, apply_url TEXT NOT NULL, company_name TEXT NOT NULL, title TEXT NOT NULL,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_checked_at TEXT NOT NULL, removed_at TEXT,
        availability TEXT NOT NULL, missing_count INTEGER NOT NULL, content_hash TEXT NOT NULL,
        saved_job_posting_id TEXT, hidden_at TEXT, metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(source_id, external_id)
      );
      CREATE TABLE discovery_posting_aliases (
        source_id TEXT NOT NULL, external_id TEXT NOT NULL, discovered_posting_id TEXT NOT NULL REFERENCES discovered_postings(id),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_checked_at TEXT NOT NULL, removed_at TEXT,
        availability TEXT NOT NULL, missing_count INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(source_id, external_id)
      );
      CREATE TABLE discovery_observations (
        id TEXT PRIMARY KEY, discovered_posting_id TEXT NOT NULL REFERENCES discovered_postings(id),
        discovery_run_id TEXT NOT NULL, state TEXT NOT NULL, content_hash TEXT NOT NULL, note TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE discovery_issues (id TEXT PRIMARY KEY, discovered_posting_id TEXT NOT NULL REFERENCES discovered_postings(id));
      CREATE TABLE alert_events (id TEXT PRIMARY KEY, discovered_posting_id TEXT REFERENCES discovered_postings(id));
      INSERT INTO discovered_postings VALUES
        ('canonical','source-a','REQ-100','https://jobs/100','https://jobs/100','Acme','Engineer','t0','t1','t1',NULL,'Open',0,'hash-200','saved-job','hidden-at','{"owner":"kept"}','t0','t1',NULL,7);
      INSERT INTO discovery_posting_aliases VALUES
        ('source-a','REQ-100','canonical','t0','t1','t1',NULL,'Open',0,'hash-100','t0'),
        ('source-a','REQ-200','canonical','t0','t1','t1',NULL,'Open',0,'hash-200','t0'),
        ('source-b','REQ-100','canonical','t0','t1','t1',NULL,'Open',0,'hash-100','t0');
      INSERT INTO discovery_observations VALUES
        ('obs-100','canonical','run','Open','hash-100','','t1'),
        ('obs-200','canonical','run','Open','hash-200','','t1'),
        ('obs-old','canonical','old-run','Open','old-hash','','t0');
      INSERT INTO discovery_issues VALUES ('issue','canonical');
      INSERT INTO alert_events VALUES ('alert','canonical');
    `);

    const first = repairLegacyMergedDiscoveryPostings(sqlite, "repair-time");
    const second = repairLegacyMergedDiscoveryPostings(sqlite, "later-time");

    expect(first).toEqual({ canonicalRowsRepaired: 1, canonicalRowsCreated: 1, aliasesMoved: 1, observationsMoved: 1 });
    expect(second).toEqual({ canonicalRowsRepaired: 0, canonicalRowsCreated: 0, aliasesMoved: 0, observationsMoved: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovered_postings").get()).toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT source_id,external_id,saved_job_posting_id,hidden_at,metadata,content_hash FROM discovered_postings WHERE id='canonical'").get()).toEqual({
      source_id: "source-a", external_id: "REQ-100", saved_job_posting_id: "saved-job", hidden_at: "hidden-at", metadata: '{"owner":"kept"}', content_hash: "hash-100",
    });
    const split = sqlite.prepare("SELECT id,source_id,external_id,saved_job_posting_id,hidden_at,metadata,content_hash FROM discovered_postings WHERE id<>'canonical'").get() as Record<string, unknown>;
    expect(split).toMatchObject({ source_id: "source-a", external_id: "REQ-200", saved_job_posting_id: null, hidden_at: "hidden-at", metadata: '{"owner":"kept"}', content_hash: "hash-200" });
    expect(sqlite.prepare("SELECT source_id,external_id,discovered_posting_id FROM discovery_posting_aliases ORDER BY source_id,external_id").all()).toEqual([
      { source_id: "source-a", external_id: "REQ-100", discovered_posting_id: "canonical" },
      { source_id: "source-a", external_id: "REQ-200", discovered_posting_id: split.id },
      { source_id: "source-b", external_id: "REQ-100", discovered_posting_id: "canonical" },
    ]);
    expect(sqlite.prepare("SELECT id,discovered_posting_id FROM discovery_observations ORDER BY id").all()).toEqual([
      { id: "obs-100", discovered_posting_id: "canonical" },
      { id: "obs-200", discovered_posting_id: split.id },
      { id: "obs-old", discovered_posting_id: "canonical" },
    ]);
    expect(sqlite.prepare("SELECT discovered_posting_id FROM discovery_issues").get()).toEqual({ discovered_posting_id: "canonical" });
    expect(sqlite.prepare("SELECT discovered_posting_id FROM alert_events").get()).toEqual({ discovered_posting_id: "canonical" });
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    sqlite.close();
  });
});
