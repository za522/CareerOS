import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

type Row = Record<string, unknown>;

type AliasRow = Row & {
  source_id: string;
  external_id: string;
  discovered_posting_id: string;
  content_hash: string;
};

export type DiscoveryAliasRepairReport = {
  canonicalRowsRepaired: number;
  canonicalRowsCreated: number;
  aliasesMoved: number;
  observationsMoved: number;
};

function requisitionKey(value: unknown) {
  const key = String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return key.length >= 4 ? key : "";
}

function splitPostingId(postingId: string, requisition: string) {
  const suffix = createHash("sha256").update(`${postingId}\0${requisition}`).digest("hex").slice(0, 24);
  return `legacy-discovery-split-${suffix}`;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Repairs the legacy false merge where one source contributed multiple distinct
 * requisitions to one canonical posting. Exact cross-source requisition aliases
 * travel together; aliases with provider-specific identifiers stay untouched.
 */
export function repairLegacyMergedDiscoveryPostings(
  sqlite: Database.Database,
  repairedAt = new Date().toISOString(),
): DiscoveryAliasRepairReport {
  const report: DiscoveryAliasRepairReport = {
    canonicalRowsRepaired: 0,
    canonicalRowsCreated: 0,
    aliasesMoved: 0,
    observationsMoved: 0,
  };
  const postingColumns = (sqlite.prepare("PRAGMA table_info(discovered_postings)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!postingColumns.length) return report;

  const candidates = sqlite.prepare(`
    SELECT p.*
    FROM discovered_postings p
    WHERE EXISTS (
      SELECT 1 FROM discovery_posting_aliases a
      WHERE a.discovered_posting_id=p.id
      GROUP BY a.source_id
      HAVING COUNT(DISTINCT lower(replace(replace(replace(a.external_id, '-', ''), '_', ''), ' ', ''))) > 1
    )
  `).all() as Row[];

  sqlite.transaction(() => {
    for (const posting of candidates) {
      const postingId = String(posting.id);
      const aliases = sqlite.prepare("SELECT * FROM discovery_posting_aliases WHERE discovered_posting_id=? ORDER BY source_id,external_id")
        .all(postingId) as AliasRow[];
      const aliasesBySource = groupBy(aliases, (alias) => String(alias.source_id));
      const splitKeys = new Set<string>();

      for (const sourceAliases of aliasesBySource.values()) {
        const aliasesByRequisition = groupBy(sourceAliases, (alias) => requisitionKey(alias.external_id));
        const distinctGroups = [...aliasesByRequisition.entries()].filter(([key]) => key);
        if (distinctGroups.length <= 1) continue;
        const canonicalAlias = sourceAliases.find((alias) => alias.source_id === posting.source_id && alias.external_id === posting.external_id);
        const canonicalKey = requisitionKey(canonicalAlias?.external_id ?? posting.external_id);
        const keeperKey = distinctGroups.some(([key]) => key === canonicalKey)
          ? canonicalKey
          : distinctGroups
            .sort((left, right) => {
              const leftCoverage = aliases.filter((alias) => requisitionKey(alias.external_id) === left[0]).length;
              const rightCoverage = aliases.filter((alias) => requisitionKey(alias.external_id) === right[0]).length;
              return rightCoverage - leftCoverage || left[0].localeCompare(right[0]);
            })[0][0];
        for (const [key] of distinctGroups) if (key !== keeperKey) splitKeys.add(key);
      }

      if (!splitKeys.size) continue;
      const assignment = new Map(aliases.map((alias) => [`${alias.source_id}\0${alias.external_id}`, postingId]));
      for (const key of [...splitKeys].sort()) {
        const aliasesToMove = aliases.filter((alias) => requisitionKey(alias.external_id) === key);
        if (!aliasesToMove.length) continue;
        const anchor = aliasesToMove.find((alias) => alias.source_id === posting.source_id) ?? aliasesToMove[0];
        const newPostingId = splitPostingId(postingId, key);
        const clone: Row = { ...posting,
          id: newPostingId,
          source_id: anchor.source_id,
          external_id: anchor.external_id,
          first_seen_at: anchor.first_seen_at,
          last_seen_at: anchor.last_seen_at,
          last_checked_at: anchor.last_checked_at,
          removed_at: anchor.removed_at,
          availability: anchor.availability,
          missing_count: anchor.missing_count,
          content_hash: anchor.content_hash,
          saved_job_posting_id: null,
          updated_at: repairedAt,
        };
        sqlite.prepare(`INSERT OR IGNORE INTO discovered_postings (${postingColumns.map((column) => `"${column}"`).join(",")}) VALUES (${postingColumns.map(() => "?").join(",")})`)
          .run(...postingColumns.map((column) => clone[column] ?? null));
        report.canonicalRowsCreated += 1;
        for (const alias of aliasesToMove) {
          const moved = sqlite.prepare("UPDATE discovery_posting_aliases SET discovered_posting_id=? WHERE source_id=? AND external_id=? AND discovered_posting_id=?")
            .run(newPostingId, alias.source_id, alias.external_id, postingId);
          report.aliasesMoved += moved.changes;
          assignment.set(`${alias.source_id}\0${alias.external_id}`, newPostingId);
        }
      }

      const remainingAliases = aliases.filter((alias) => assignment.get(`${alias.source_id}\0${alias.external_id}`) === postingId);
      const keeper = remainingAliases.find((alias) => alias.source_id === posting.source_id && alias.external_id === posting.external_id)
        ?? remainingAliases.find((alias) => requisitionKey(alias.external_id) === requisitionKey(posting.external_id))
        ?? remainingAliases[0];
      if (!keeper) throw new Error(`Discovery repair would orphan canonical posting ${postingId}.`);
      sqlite.prepare(`UPDATE discovered_postings SET source_id=?,external_id=?,first_seen_at=?,last_seen_at=?,last_checked_at=?,removed_at=?,availability=?,missing_count=?,content_hash=?,updated_at=?,revision=revision+1 WHERE id=?`)
        .run(keeper.source_id, keeper.external_id, keeper.first_seen_at, keeper.last_seen_at, keeper.last_checked_at, keeper.removed_at,
          keeper.availability, keeper.missing_count, keeper.content_hash, repairedAt, postingId);

      const targetsByHash = new Map<string, Set<string>>();
      for (const alias of aliases) {
        if (!alias.content_hash) continue;
        const targets = targetsByHash.get(alias.content_hash) ?? new Set<string>();
        targets.add(assignment.get(`${alias.source_id}\0${alias.external_id}`) ?? postingId);
        targetsByHash.set(alias.content_hash, targets);
      }
      for (const [hash, targets] of targetsByHash) {
        if (targets.size !== 1) continue;
        const target = [...targets][0];
        if (target === postingId) continue;
        const moved = sqlite.prepare("UPDATE discovery_observations SET discovered_posting_id=? WHERE discovered_posting_id=? AND content_hash=?")
          .run(target, postingId, hash);
        report.observationsMoved += moved.changes;
      }
      report.canonicalRowsRepaired += 1;
    }
  })();
  return report;
}
