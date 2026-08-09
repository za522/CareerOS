import type { QueryExecutor, RevisionMetadata, RevisionRepository, RevisionWriteResult, SqlValue } from "./contracts.js";
import { assertUuid, sqlIdentifier } from "./identifiers.js";

type RowMapper<Row> = (row: Record<string, unknown>) => Row;

export interface RevisionRepositoryDefinition<Row, Create extends Record<string, unknown>, Changes extends Record<string, unknown>> {
  table: string;
  createColumns: readonly (keyof Create & string)[];
  mutableColumns: readonly (keyof Changes & string)[];
  mapRow: RowMapper<Row>;
}

function valuesFor(input: Record<string, unknown>, columns: readonly string[]): SqlValue[] {
  return columns.map((column) => (input[column] ?? null) as SqlValue);
}

export class PostgresRevisionRepository<
  Row extends RevisionMetadata,
  Create extends Record<string, unknown>,
  Changes extends Record<string, unknown>,
> implements RevisionRepository<Row, Create, Changes> {
  readonly #table: string;
  readonly #createColumns: readonly string[];
  readonly #mutableColumns: ReadonlySet<string>;
  readonly #mapRow: RowMapper<Row>;

  constructor(definition: RevisionRepositoryDefinition<Row, Create, Changes>) {
    this.#table = sqlIdentifier(definition.table);
    this.#createColumns = definition.createColumns.map(sqlIdentifier);
    this.#mutableColumns = new Set(definition.mutableColumns);
    definition.mutableColumns.forEach(sqlIdentifier);
    this.#mapRow = definition.mapRow;
  }

  async get(transaction: QueryExecutor, workspaceId: string, id: string): Promise<Row | null> {
    assertUuid(workspaceId, "workspaceId");
    assertUuid(id, "id");
    const result = await transaction.query(`SELECT * FROM ${this.#table} WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [workspaceId, id]);
    return result.rows[0] ? this.#mapRow(result.rows[0]) : null;
  }

  async create(transaction: QueryExecutor, workspaceId: string, input: Create): Promise<Row> {
    assertUuid(workspaceId, "workspaceId");
    const rawColumns = this.#createColumns.map((column) => column.slice(1, -1));
    const columns = ["workspace_id", ...rawColumns].map(sqlIdentifier);
    const values = [workspaceId, ...valuesFor(input, rawColumns)];
    const placeholders = values.map((_, index) => `$${index + 1}`);
    const result = await transaction.query(`INSERT INTO ${this.#table} (${columns.join(",")}) VALUES (${placeholders.join(",")}) RETURNING *`, values);
    if (!result.rows[0]) throw new Error("PostgreSQL insert did not return the created record.");
    return this.#mapRow(result.rows[0]);
  }

  async update(
    transaction: QueryExecutor,
    workspaceId: string,
    id: string,
    expectedRevision: number,
    changes: Changes,
  ): Promise<RevisionWriteResult<Row>> {
    assertUuid(workspaceId, "workspaceId");
    assertUuid(id, "id");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("expectedRevision must be a positive integer.");
    const selected = Object.entries(changes).filter(([column, value]) => value !== undefined && this.#mutableColumns.has(column));
    const unknown = Object.keys(changes).filter((column) => !this.#mutableColumns.has(column));
    if (unknown.length) throw new Error(`Unsupported revision fields: ${unknown.join(", ")}`);
    if (!selected.length) throw new Error("At least one revision-aware change is required.");
    const values = selected.map(([, value]) => value as SqlValue);
    const assignments = selected.map(([column], index) => `${sqlIdentifier(column)}=$${index + 1}`);
    const workspaceParameter = values.length + 1;
    const idParameter = values.length + 2;
    const revisionParameter = values.length + 3;
    const result = await transaction.query(
      `UPDATE ${this.#table} SET ${assignments.join(",")},updated_at=now(),revision=revision+1 WHERE workspace_id=$${workspaceParameter} AND id=$${idParameter} AND revision=$${revisionParameter} AND deleted_at IS NULL RETURNING *`,
      [...values, workspaceId, id, expectedRevision],
    );
    if (result.rows[0]) return { status: "updated", record: this.#mapRow(result.rows[0]) };
    const current = await transaction.query<{ revision: number }>(
      `SELECT revision FROM ${this.#table} WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [workspaceId, id],
    );
    return current.rows[0]
      ? { status: "conflict", currentRevision: Number(current.rows[0].revision) }
      : { status: "not_found" };
  }
}
