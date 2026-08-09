export type SqlValue = string | number | boolean | Date | null | Buffer | Record<string, unknown> | unknown[];

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface QueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly SqlValue[],
  ): Promise<QueryResult<Row>>;
}

export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  authSubject?: string;
}

export interface TransactionOptions {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
  workspaceLock?: "shared" | "exclusive" | "none";
}

export interface TransactionManager {
  transaction<T>(
    context: WorkspaceContext,
    work: (transaction: QueryExecutor) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export interface RevisionMetadata {
  id: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  revision: number;
}

export type RevisionWriteResult<Row> =
  | { status: "updated"; record: Row }
  | { status: "conflict"; currentRevision: number }
  | { status: "not_found" };

export interface RevisionRepository<Row extends RevisionMetadata, Create, Changes> {
  get(transaction: QueryExecutor, workspaceId: string, id: string): Promise<Row | null>;
  create(transaction: QueryExecutor, workspaceId: string, input: Create): Promise<Row>;
  update(
    transaction: QueryExecutor,
    workspaceId: string,
    id: string,
    expectedRevision: number,
    changes: Changes,
  ): Promise<RevisionWriteResult<Row>>;
}

export interface CloudDataProvider extends TransactionManager {
  readonly provider: "postgresql" | "supabase";
  close(): Promise<void>;
}
