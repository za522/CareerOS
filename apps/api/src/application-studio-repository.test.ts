import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CvDocumentContent, CvProposalState } from "@careeros/contracts";
import { PostgresApplicationStudioRepository } from "./application-studio-repository.js";
import type { CloudDataProvider, QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const SUBJECT_A = "55555555-5555-4555-8555-555555555555";
const SUBJECT_B = "66666666-6666-4666-8666-666666666666";
const PROFILE_A = "77777777-7777-4777-8777-777777777777";
const PROFILE_B = "88888888-8888-4888-8888-888888888888";
const DOCUMENT_A = "99999999-9999-4999-8999-999999999999";
const DOCUMENT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APPLICATION_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPLICATION_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const contextA = { workspaceId: WORKSPACE_A, userId: USER_A, authSubject: SUBJECT_A };
const contextB = { workspaceId: WORKSPACE_B, userId: USER_B, authSubject: SUBJECT_B };

function executor(database: PGlite): QueryExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
      const result = await database.query<Row>(text, values as unknown[]);
      return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) } satisfies QueryResult<Row>;
    },
  };
}

class PgliteProvider implements CloudDataProvider {
  readonly provider = "postgresql" as const;
  constructor(readonly database: PGlite) {}
  async transaction<T>(context: WorkspaceContext, work: (tx: QueryExecutor) => Promise<T>) {
    await this.database.exec("BEGIN");
    try {
      await this.database.exec("SET LOCAL ROLE careeros_runtime");
      await this.database.query(
        "SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)",
        [context.workspaceId, context.userId, context.authSubject ?? ""],
      );
      const result = await work(executor(this.database));
      await this.database.exec("COMMIT");
      return result;
    } catch (error) {
      await this.database.exec("ROLLBACK");
      throw error;
    }
  }
  async close() { await this.database.close(); }
}

const content = (intro: string): CvDocumentContent => ({
  name: "Zain Ahmad",
  headline: "Design Engineer",
  intro,
  sections: [{ id: "experience", evidenceType: "experience", title: "Krislite", content: "Built a product.", sourceEvidenceIds: [] }],
});
const proposalState: CvProposalState = { turns: [], activeTurnId: null };

describe("PostgresApplicationStudioRepository", () => {
  let database: PGlite;
  let repository: PostgresApplicationStudioRepository;

  beforeEach(async () => {
    database = new PGlite();
    for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
    await database.query("INSERT INTO workspaces(id,name) VALUES($1,'A'),($2,'B')", [WORKSPACE_A, WORKSPACE_B]);
    await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'a@example.com'),($3,$4::uuid,'b@example.com')", [USER_A, SUBJECT_A, USER_B, SUBJECT_B]);
    await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [WORKSPACE_A, USER_A, WORKSPACE_B, USER_B]);
    await database.query("INSERT INTO profiles(id,workspace_id,name,headline,summary) VALUES($1,$2,'Zain','Engineer','Original'),($3,$4,'Other','Other','Hidden')", [PROFILE_A, WORKSPACE_A, PROFILE_B, WORKSPACE_B]);
    await database.query("INSERT INTO profile_evidence(id,workspace_id,profile_id,evidence_type,title,content) VALUES('evidence-a',$1,$2,'education','Imperial','MEng'),('evidence-b',$3,$4,'education','Hidden','Hidden')", [WORKSPACE_A, PROFILE_A, WORKSPACE_B, PROFILE_B]);
    await database.query("INSERT INTO documents(id,workspace_id,document_type,title,mime_type) VALUES($1,$2,'cv','Primary CV','application/pdf'),($3,$4,'cv','Hidden CV','application/pdf')", [DOCUMENT_A, WORKSPACE_A, DOCUMENT_B, WORKSPACE_B]);
    await database.query("INSERT INTO companies(id,workspace_id,name) VALUES('company-a',$1,'A'),('company-b',$2,'B')", [WORKSPACE_A, WORKSPACE_B]);
    await database.query("INSERT INTO job_postings(id,workspace_id,company_id,title) VALUES($1,$2,'company-a','Quant'),($3,$4,'company-b','Hidden')", [JOB_A, WORKSPACE_A, JOB_B, WORKSPACE_B]);
    await database.query("INSERT INTO applications(id,workspace_id,job_posting_id) VALUES($1,$2,$3),($4,$5,$6)", [APPLICATION_A, WORKSPACE_A, JOB_A, APPLICATION_B, WORKSPACE_B, JOB_B]);
    repository = new PostgresApplicationStudioRepository(new PgliteProvider(database));
  }, 30_000);

  afterEach(async () => { await database.close(); });

  it("workspace-scopes profiles, documents, drafts, versions, and submissions", async () => {
    expect((await repository.getProfile(contextA))?.name).toBe("Zain");
    expect(await repository.getDocument(contextA, DOCUMENT_B)).toBeNull();
    expect(await repository.listDocuments(contextA)).toHaveLength(1);
    expect((await repository.upsertDraft(contextA, { documentId: DOCUMENT_B, jobPostingId: JOB_A, content: content("No"), proposalState, expectedRevision: null })).status).toBe("not_found");
    expect((await repository.upsertDraft(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_B, content: content("No"), proposalState, expectedRevision: null })).status).toBe("not_found");
    expect(await repository.loadDraft(contextA, DOCUMENT_B, JOB_B)).toBeNull();
  });

  it("updates the complete profile atomically and rejects stale or foreign section revisions", async () => {
    const first = await repository.updateProfile(contextA, 1, {
      name: "Zain Ahmad", headline: "Design Engineer", summary: "Updated",
      sections: [{ id: "evidence-a", evidenceType: "education", title: "Imperial College London", content: "MEng Design Engineering" }, { evidenceType: "project", title: "Apollo", content: "AI rescue drone" }],
    });
    expect(first.status).toBe("updated");
    if (first.status === "updated") expect(first.record).toMatchObject({ revision: 2, summary: "Updated", sections: expect.arrayContaining([expect.objectContaining({ title: "Apollo" })]) });
    expect((await repository.updateProfile(contextA, 1, { name: "Stale", headline: "", summary: "", sections: [] })).status).toBe("conflict");
    const foreign = await repository.updateProfile(contextA, 2, { name: "No", headline: "", summary: "", sections: [{ id: "evidence-b", evidenceType: "education", title: "No", content: "No" }] });
    expect(foreign.status).toBe("not_found");
    expect((await repository.getProfile(contextA))?.name).toBe("Zain Ahmad");
  });

  it("autosaves, reopens, and rejects stale drafts without losing the newer edit", async () => {
    const created = await repository.upsertDraft(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, content: content("First"), proposalState, expectedRevision: null });
    expect(created.status).toBe("created");
    const saved = await repository.upsertDraft(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, content: content("Newer collaborator edit"), proposalState, expectedRevision: 1 });
    expect(saved.status).toBe("updated");
    const stale = await repository.upsertDraft(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, content: content("Stale overwrite"), proposalState, expectedRevision: 1 });
    expect(stale).toEqual({ status: "conflict", currentRevision: 2 });
    expect((await repository.loadDraft(contextA, DOCUMENT_A, JOB_A))?.content.intro).toBe("Newer collaborator edit");
  });

  it("creates immutable ordered snapshots from the exact draft revision", async () => {
    await repository.upsertDraft(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, content: content("Draft"), proposalState, expectedRevision: null });
    const first = await repository.createVersionSnapshot(contextA, {
      documentId: DOCUMENT_A, jobPostingId: JOB_A, parentVersionId: null, expectedDraftRevision: 1, checkpointName: "Amazon draft",
      content: content("Snapshot one"), plainText: "Snapshot one", checksum: "checksum-one", acceptedChangeIds: [], proposalChanges: [], proposalDecisions: {}, changeSummary: "First", provider: "manual", model: "",
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error("Expected snapshot");
    const second = await repository.createVersionSnapshot(contextA, {
      documentId: DOCUMENT_A, jobPostingId: JOB_A, parentVersionId: first.record.id, expectedDraftRevision: 1, checkpointName: "Amazon final",
      content: content("Snapshot two"), plainText: "Snapshot two", checksum: "checksum-two", acceptedChangeIds: [], proposalChanges: [], proposalDecisions: {}, changeSummary: "Second", provider: "openai", model: "test",
    });
    expect(second.status).toBe("created");
    expect((await repository.listVersions(contextA, DOCUMENT_A, JOB_A)).map((item) => [item.version, item.content.intro])).toEqual([[2, "Snapshot two"], [1, "Snapshot one"]]);
    await database.query("UPDATE document_drafts SET content_json=$1::jsonb,revision=2 WHERE workspace_id=$2 AND document_id=$3", [JSON.stringify(content("Later draft")), WORKSPACE_A, DOCUMENT_A]);
    expect((await repository.createVersionSnapshot(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, parentVersionId: null, expectedDraftRevision: 1, checkpointName: "Stale", content: content("Bad"), plainText: "Bad", checksum: "bad", acceptedChangeIds: [], proposalChanges: [], proposalDecisions: {}, changeSummary: "", provider: "manual", model: "" })).status).toBe("conflict");
    expect((await repository.getVersion(contextA, first.record.id))?.content.intro).toBe("Snapshot one");
  });

  it("atomically links the exact immutable version submitted to the matching application", async () => {
    await repository.upsertDraft(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, content: content("Draft"), proposalState, expectedRevision: null });
    const snapshot = await repository.createVersionSnapshot(contextA, { documentId: DOCUMENT_A, jobPostingId: JOB_A, parentVersionId: null, expectedDraftRevision: 1, checkpointName: "Submitted CV", content: content("Exact submitted text"), plainText: "Exact submitted text", checksum: "exact", acceptedChangeIds: [], proposalChanges: [], proposalDecisions: {}, changeSummary: "", provider: "manual", model: "" });
    if (snapshot.status !== "created") throw new Error("Expected snapshot");
    expect((await repository.markVersionSubmitted(contextA, snapshot.record.id, APPLICATION_B)).status).toBe("not_found");
    const submitted = await repository.markVersionSubmitted(contextA, snapshot.record.id, APPLICATION_A);
    expect(submitted.status).toBe("submitted");
    if (submitted.status !== "submitted") throw new Error("Expected submission");
    expect(submitted.version).toMatchObject({ id: snapshot.record.id, submittedAt: expect.any(String), content: { intro: "Exact submitted text" } });
    expect(submitted.material).toMatchObject({ applicationId: APPLICATION_A, documentVersionId: snapshot.record.id, documentId: DOCUMENT_A });
    expect((await repository.markVersionSubmitted(contextA, snapshot.record.id, APPLICATION_A)).status).toBe("already_submitted");
    const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM application_materials WHERE document_version_id=$1", [snapshot.record.id]);
    expect(rows.rows[0].count).toBe(1);
  });
});
