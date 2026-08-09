import { randomUUID } from "node:crypto";
import type { QueryExecutor, TransactionManager, WorkspaceContext } from "./contracts.js";

export interface DiscoveryLease {
  sourceId: string;
  leaseToken: string;
  leaseUntil: Date;
  revision: number;
}

export class PostgresDiscoveryLeaseRepository {
  constructor(private readonly transactions: TransactionManager) {}

  async claimDue(
    context: WorkspaceContext,
    options: { limit?: number; leaseSeconds?: number; token?: string } = {},
  ): Promise<DiscoveryLease[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 300, 3600));
    const token = options.token ?? randomUUID();
    return this.transactions.transaction(context, async (transaction) => {
      const result = await transaction.query<{ source_id: string; lease_token: string; lease_until: Date; revision: number }>(`
        WITH due AS (
          SELECT id
          FROM discovery_sources
          WHERE workspace_id=$1
            AND enabled
            AND deleted_at IS NULL
            AND (lease_until IS NULL OR lease_until <= now())
            AND (last_checked_at IS NULL OR last_checked_at + check_interval_minutes * interval '1 minute' <= now())
          ORDER BY COALESCE(last_checked_at, '-infinity'::timestamptz), id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE discovery_sources source
        SET lease_token=$3,
            lease_until=now() + $4 * interval '1 second',
            updated_at=now(),
            revision=revision+1
        FROM due
        WHERE source.workspace_id=$1 AND source.id=due.id
        RETURNING source.id AS source_id,source.lease_token,source.lease_until,source.revision
      `, [context.workspaceId, limit, token, leaseSeconds]);
      return result.rows.map((row) => ({
        sourceId: row.source_id,
        leaseToken: row.lease_token,
        leaseUntil: new Date(row.lease_until),
        revision: Number(row.revision),
      }));
    }, { isolationLevel: "read committed" });
  }

  async renew(transaction: QueryExecutor, workspaceId: string, sourceId: string, leaseToken: string, leaseSeconds = 300): Promise<boolean> {
    const duration = Math.max(15, Math.min(leaseSeconds, 3600));
    const result = await transaction.query(`
      UPDATE discovery_sources
      SET lease_until=now() + $4 * interval '1 second',updated_at=now(),revision=revision+1
      WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND lease_until > now() AND deleted_at IS NULL
    `, [workspaceId, sourceId, leaseToken, duration]);
    return result.rowCount === 1;
  }

  async release(transaction: QueryExecutor, workspaceId: string, sourceId: string, leaseToken: string): Promise<boolean> {
    const result = await transaction.query(`
      UPDATE discovery_sources
      SET lease_token=NULL,lease_until=NULL,updated_at=now(),revision=revision+1
      WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND deleted_at IS NULL
    `, [workspaceId, sourceId, leaseToken]);
    return result.rowCount === 1;
  }
}
