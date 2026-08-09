import { randomUUID } from "node:crypto";
import type {
  CvChangeProposal,
  CvDocumentContent,
  CvProposalState,
  ProfileDocumentRecord,
  ProfileRecord,
  ProfileSectionInput,
} from "@careeros/contracts";
import type { CloudDataProvider, QueryExecutor, WorkspaceContext } from "./postgres/contracts.js";

export type ApplicationStudioContext = WorkspaceContext;

export type RepositoryWriteResult<T> =
  | { status: "created" | "updated"; record: T }
  | { status: "conflict"; currentRevision: number }
  | { status: "not_found" };

export type ProfileUpdate = {
  name: string;
  headline: string;
  summary: string;
  sections: ProfileSectionInput[];
};

export type DocumentDraftRecord = {
  id: string;
  documentId: string;
  jobPostingId: string;
  content: CvDocumentContent;
  proposalState: CvProposalState;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type DocumentVersionSnapshot = {
  id: string;
  documentId: string;
  jobPostingId: string | null;
  parentVersionId: string | null;
  version: number;
  relativePath: string;
  checksum: string;
  checkpointName: string;
  submittedAt: string | null;
  content: CvDocumentContent;
  plainText: string;
  acceptedChangeIds: string[];
  proposalChanges: CvChangeProposal[];
  proposalDecisions: Record<string, "accepted" | "rejected" | "conflict">;
  changeSummary: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type DraftUpsertInput = {
  documentId: string;
  jobPostingId: string;
  content: CvDocumentContent;
  proposalState: CvProposalState;
  expectedRevision: number | null;
};

export type VersionSnapshotInput = {
  documentId: string;
  jobPostingId: string | null;
  parentVersionId: string | null;
  expectedDraftRevision: number | null;
  checkpointName: string;
  content: CvDocumentContent;
  plainText: string;
  checksum: string;
  acceptedChangeIds: string[];
  proposalChanges: CvChangeProposal[];
  proposalDecisions: Record<string, "accepted" | "rejected" | "conflict">;
  changeSummary: string;
  provider: string;
  model: string;
};

export type ApplicationMaterialRecord = {
  id: string;
  applicationId: string;
  documentId: string;
  documentVersionId: string;
  materialType: string;
  title: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type SubmissionResult =
  | { status: "submitted" | "already_submitted"; version: DocumentVersionSnapshot; material: ApplicationMaterialRecord }
  | { status: "conflict"; reason: "different_application" | "job_mismatch" }
  | { status: "not_found" };

export interface ApplicationStudioRepository {
  getProfile(context: ApplicationStudioContext): Promise<ProfileRecord | null>;
  updateProfile(context: ApplicationStudioContext, expectedRevision: number, input: ProfileUpdate): Promise<RepositoryWriteResult<ProfileRecord>>;
  listDocuments(context: ApplicationStudioContext, documentType?: string): Promise<ProfileDocumentRecord[]>;
  getDocument(context: ApplicationStudioContext, documentId: string): Promise<ProfileDocumentRecord | null>;
  loadDraft(context: ApplicationStudioContext, documentId: string, jobPostingId: string): Promise<DocumentDraftRecord | null>;
  upsertDraft(context: ApplicationStudioContext, input: DraftUpsertInput): Promise<RepositoryWriteResult<DocumentDraftRecord>>;
  createVersionSnapshot(context: ApplicationStudioContext, input: VersionSnapshotInput): Promise<RepositoryWriteResult<DocumentVersionSnapshot>>;
  listVersions(context: ApplicationStudioContext, documentId: string, jobPostingId?: string | null): Promise<DocumentVersionSnapshot[]>;
  getVersion(context: ApplicationStudioContext, versionId: string): Promise<DocumentVersionSnapshot | null>;
  markVersionSubmitted(context: ApplicationStudioContext, versionId: string, applicationId: string): Promise<SubmissionResult>;
}

type Row = Record<string, unknown>;

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? "");
const nullableIso = (value: unknown) => value == null ? null : iso(value);
const json = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

function profileSection(row: Row) {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    evidenceType: String(row.evidence_type) as ProfileRecord["sections"][number]["evidenceType"],
    title: String(row.title),
    content: String(row.content),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
  };
}

function profileRecord(row: Row, sections: ProfileRecord["sections"]): ProfileRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    headline: String(row.headline),
    summary: String(row.summary),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
    sections,
  };
}

function documentRecord(row: Row): ProfileDocumentRecord {
  return {
    id: String(row.id),
    documentType: String(row.document_type) as ProfileDocumentRecord["documentType"],
    title: String(row.title),
    relativePath: String(row.relative_path),
    checksum: String(row.checksum),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
  };
}

function draftRecord(row: Row): DocumentDraftRecord {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    jobPostingId: String(row.job_posting_id),
    content: json<CvDocumentContent>(row.content_json, { name: "", headline: "", sections: [] }),
    proposalState: json<CvProposalState>(row.proposal_state_json, { turns: [], activeTurnId: null }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
  };
}

function versionRecord(row: Row): DocumentVersionSnapshot {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    jobPostingId: row.job_posting_id == null ? null : String(row.job_posting_id),
    parentVersionId: row.parent_version_id == null ? null : String(row.parent_version_id),
    version: Number(row.version),
    relativePath: String(row.relative_path),
    checksum: String(row.checksum),
    checkpointName: String(row.checkpoint_name),
    submittedAt: nullableIso(row.submitted_at),
    content: json<CvDocumentContent>(row.content_json, { name: "", headline: "", sections: [] }),
    plainText: String(row.plain_text),
    acceptedChangeIds: json<string[]>(row.accepted_change_ids, []),
    proposalChanges: json<CvChangeProposal[]>(row.proposal_changes, []),
    proposalDecisions: json<Record<string, "accepted" | "rejected" | "conflict">>(row.proposal_decisions, {}),
    changeSummary: String(row.change_summary),
    provider: String(row.provider),
    model: String(row.model),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
  };
}

function materialRecord(row: Row): ApplicationMaterialRecord {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    documentId: String(row.document_id),
    documentVersionId: String(row.document_version_id),
    materialType: String(row.material_type),
    title: String(row.title),
    notes: String(row.notes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
  };
}

async function audit(tx: QueryExecutor, context: ApplicationStudioContext, action: string, entityType: string, entityId: string, summary: string) {
  await tx.query(
    "INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,now())",
    [randomUUID(), context.workspaceId, context.userId, action, entityType, entityId, summary],
  );
}

export class PostgresApplicationStudioRepository implements ApplicationStudioRepository {
  constructor(private readonly provider: CloudDataProvider) {}

  private run<T>(context: ApplicationStudioContext, work: (tx: QueryExecutor) => Promise<T>, readOnly = false) {
    return this.provider.transaction(context, work, { readOnly });
  }

  private async profileIn(tx: QueryExecutor, workspaceId: string, lock = false) {
    return (await tx.query(
      `SELECT * FROM profiles WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [workspaceId],
    )).rows[0] ?? null;
  }

  private async profileWithSections(tx: QueryExecutor, workspaceId: string, row: Row) {
    const sections = await tx.query(
      "SELECT * FROM profile_evidence WHERE workspace_id=$1 AND profile_id=$2 AND deleted_at IS NULL ORDER BY created_at,id",
      [workspaceId, String(row.id)],
    );
    return profileRecord(row, sections.rows.map(profileSection));
  }

  async getProfile(context: ApplicationStudioContext) {
    return this.run(context, async (tx) => {
      const row = await this.profileIn(tx, context.workspaceId);
      return row ? this.profileWithSections(tx, context.workspaceId, row) : null;
    }, true);
  }

  async updateProfile(context: ApplicationStudioContext, expectedRevision: number, input: ProfileUpdate) {
    return this.run(context, async (tx): Promise<RepositoryWriteResult<ProfileRecord>> => {
      const current = await this.profileIn(tx, context.workspaceId, true);
      if (!current) return { status: "not_found" };
      if (Number(current.revision) !== expectedRevision) return { status: "conflict", currentRevision: Number(current.revision) };

      const existingResult = await tx.query(
        "SELECT * FROM profile_evidence WHERE workspace_id=$1 AND profile_id=$2 AND deleted_at IS NULL FOR UPDATE",
        [context.workspaceId, String(current.id)],
      );
      const existing = new Map(existingResult.rows.map((row) => [String(row.id), row]));
      for (const section of input.sections) {
        if (section.id && !existing.has(section.id)) return { status: "not_found" };
      }

      const updated = (await tx.query(
        "UPDATE profiles SET name=$3,headline=$4,summary=$5,updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$6 RETURNING *",
        [context.workspaceId, String(current.id), input.name, input.headline, input.summary, expectedRevision],
      )).rows[0];
      if (!updated) return { status: "conflict", currentRevision: Number(current.revision) };

      const incomingIds = new Set(input.sections.flatMap((section) => section.id ? [section.id] : []));
      for (const row of existing.values()) {
        if (!incomingIds.has(String(row.id))) {
          await tx.query(
            "UPDATE profile_evidence SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND profile_id=$2 AND id=$3 AND deleted_at IS NULL",
            [context.workspaceId, String(current.id), String(row.id)],
          );
        }
      }
      for (const section of input.sections) {
        if (section.id) {
          await tx.query(
            "UPDATE profile_evidence SET evidence_type=$4,title=$5,content=$6,updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND profile_id=$2 AND id=$3 AND deleted_at IS NULL",
            [context.workspaceId, String(current.id), section.id, section.evidenceType, section.title, section.content],
          );
        } else {
          await tx.query(
            "INSERT INTO profile_evidence(id,workspace_id,profile_id,evidence_type,title,content,created_at,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,now(),now(),1)",
            [randomUUID(), context.workspaceId, String(current.id), section.evidenceType, section.title, section.content],
          );
        }
      }
      await audit(tx, context, "profile.updated", "Profile", String(current.id), "Updated the shared career profile");
      return { status: "updated", record: await this.profileWithSections(tx, context.workspaceId, updated) };
    }, false);
  }

  async listDocuments(context: ApplicationStudioContext, documentType?: string) {
    return this.run(context, async (tx) => {
      const result = documentType
        ? await tx.query("SELECT * FROM documents WHERE workspace_id=$1 AND document_type=$2 AND deleted_at IS NULL ORDER BY updated_at DESC,id", [context.workspaceId, documentType])
        : await tx.query("SELECT * FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id", [context.workspaceId]);
      return result.rows.map(documentRecord);
    }, true);
  }

  async getDocument(context: ApplicationStudioContext, documentId: string) {
    return this.run(context, async (tx) => {
      const row = (await tx.query("SELECT * FROM documents WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [context.workspaceId, documentId])).rows[0];
      return row ? documentRecord(row) : null;
    }, true);
  }

  async loadDraft(context: ApplicationStudioContext, documentId: string, jobPostingId: string) {
    return this.run(context, async (tx) => {
      const row = (await tx.query(
        "SELECT * FROM document_drafts WHERE workspace_id=$1 AND document_id=$2 AND job_posting_id=$3 AND deleted_at IS NULL",
        [context.workspaceId, documentId, jobPostingId],
      )).rows[0];
      return row ? draftRecord(row) : null;
    }, true);
  }

  async upsertDraft(context: ApplicationStudioContext, input: DraftUpsertInput) {
    return this.run(context, async (tx): Promise<RepositoryWriteResult<DocumentDraftRecord>> => {
      const parents = await tx.query(
        `SELECT d.id AS document_id,j.id AS job_id
         FROM documents d JOIN job_postings j ON j.workspace_id=d.workspace_id
         WHERE d.workspace_id=$1 AND d.id=$2 AND d.document_type='cv' AND d.deleted_at IS NULL AND j.id=$3 AND j.deleted_at IS NULL`,
        [context.workspaceId, input.documentId, input.jobPostingId],
      );
      if (!parents.rows[0]) return { status: "not_found" };

      const existing = (await tx.query(
        "SELECT * FROM document_drafts WHERE workspace_id=$1 AND document_id=$2 AND job_posting_id=$3 FOR UPDATE",
        [context.workspaceId, input.documentId, input.jobPostingId],
      )).rows[0];
      if (existing) {
        if (input.expectedRevision !== Number(existing.revision)) return { status: "conflict", currentRevision: Number(existing.revision) };
        const updated = (await tx.query(
          `UPDATE document_drafts SET content_json=$4::jsonb,proposal_state_json=$5::jsonb,deleted_at=NULL,updated_at=now(),revision=revision+1
           WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING *`,
          [context.workspaceId, String(existing.id), input.expectedRevision, JSON.stringify(input.content), JSON.stringify(input.proposalState)],
        )).rows[0];
        if (!updated) return { status: "conflict", currentRevision: Number(existing.revision) };
        await audit(tx, context, "document_draft.updated", "Document", input.documentId, "Autosaved an Application Studio draft");
        return { status: "updated", record: draftRecord(updated) };
      }
      if (input.expectedRevision !== null) return { status: "not_found" };
      const created = (await tx.query(
        `INSERT INTO document_drafts(id,workspace_id,document_id,job_posting_id,content_json,proposal_state_json,created_at,updated_at,revision)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,now(),now(),1) RETURNING *`,
        [randomUUID(), context.workspaceId, input.documentId, input.jobPostingId, JSON.stringify(input.content), JSON.stringify(input.proposalState)],
      )).rows[0]!;
      await audit(tx, context, "document_draft.created", "Document", input.documentId, "Created an Application Studio draft");
      return { status: "created", record: draftRecord(created) };
    });
  }

  async createVersionSnapshot(context: ApplicationStudioContext, input: VersionSnapshotInput) {
    return this.run(context, async (tx): Promise<RepositoryWriteResult<DocumentVersionSnapshot>> => {
      const document = (await tx.query(
        "SELECT id FROM documents WHERE workspace_id=$1 AND id=$2 AND document_type='cv' AND deleted_at IS NULL FOR UPDATE",
        [context.workspaceId, input.documentId],
      )).rows[0];
      if (!document) return { status: "not_found" };
      if (input.jobPostingId) {
        const job = await tx.query("SELECT id FROM job_postings WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [context.workspaceId, input.jobPostingId]);
        if (!job.rows[0]) return { status: "not_found" };
        const draft = (await tx.query(
          "SELECT revision FROM document_drafts WHERE workspace_id=$1 AND document_id=$2 AND job_posting_id=$3 AND deleted_at IS NULL FOR UPDATE",
          [context.workspaceId, input.documentId, input.jobPostingId],
        )).rows[0];
        const currentRevision = draft ? Number(draft.revision) : null;
        if (currentRevision !== input.expectedDraftRevision) {
          return currentRevision == null ? { status: "not_found" } : { status: "conflict", currentRevision };
        }
      } else if (input.expectedDraftRevision !== null) {
        return { status: "not_found" };
      }
      if (input.parentVersionId) {
        const parent = await tx.query(
          "SELECT id FROM document_versions WHERE workspace_id=$1 AND id=$2 AND document_id=$3 AND deleted_at IS NULL",
          [context.workspaceId, input.parentVersionId, input.documentId],
        );
        if (!parent.rows[0]) return { status: "not_found" };
      }
      const next = (await tx.query<{ next_version: number }>(
        "SELECT COALESCE(MAX(version),0)::int+1 AS next_version FROM document_versions WHERE workspace_id=$1 AND document_id=$2",
        [context.workspaceId, input.documentId],
      )).rows[0]!.next_version;
      const created = (await tx.query(
        `INSERT INTO document_versions(id,workspace_id,document_id,job_posting_id,parent_version_id,version,relative_path,checksum,checkpoint_name,submitted_at,
          content_json,plain_text,accepted_change_ids,proposal_changes,proposal_decisions,change_summary,provider,model,created_at,updated_at,revision)
         VALUES($1,$2,$3,$4,$5,$6,'',$7,$8,NULL,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,now(),now(),1) RETURNING *`,
        [randomUUID(), context.workspaceId, input.documentId, input.jobPostingId, input.parentVersionId, next, input.checksum, input.checkpointName,
          JSON.stringify(input.content), input.plainText, JSON.stringify(input.acceptedChangeIds), JSON.stringify(input.proposalChanges),
          JSON.stringify(input.proposalDecisions), input.changeSummary, input.provider, input.model],
      )).rows[0]!;
      await audit(tx, context, "document_version.created", "DocumentVersion", String(created.id), "Created an immutable CV snapshot");
      return { status: "created", record: versionRecord(created) };
    }, false);
  }

  async listVersions(context: ApplicationStudioContext, documentId: string, jobPostingId?: string | null) {
    return this.run(context, async (tx) => {
      const values: unknown[] = [context.workspaceId, documentId];
      let scope = "";
      if (jobPostingId !== undefined) {
        values.push(jobPostingId);
        scope = jobPostingId === null ? " AND job_posting_id IS NULL" : " AND job_posting_id=$3";
      }
      const result = await tx.query(
        `SELECT * FROM document_versions WHERE workspace_id=$1 AND document_id=$2${scope} AND deleted_at IS NULL ORDER BY version DESC,id`,
        values as never[],
      );
      return result.rows.map(versionRecord);
    }, true);
  }

  async getVersion(context: ApplicationStudioContext, versionId: string) {
    return this.run(context, async (tx) => {
      const row = (await tx.query("SELECT * FROM document_versions WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [context.workspaceId, versionId])).rows[0];
      return row ? versionRecord(row) : null;
    }, true);
  }

  async markVersionSubmitted(context: ApplicationStudioContext, versionId: string, applicationId: string) {
    return this.run(context, async (tx): Promise<SubmissionResult> => {
      const version = (await tx.query(
        "SELECT * FROM document_versions WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [context.workspaceId, versionId],
      )).rows[0];
      if (!version) return { status: "not_found" };
      const application = (await tx.query(
        "SELECT id,job_posting_id FROM applications WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [context.workspaceId, applicationId],
      )).rows[0];
      if (!application) return { status: "not_found" };
      if (!version.job_posting_id || String(version.job_posting_id) !== String(application.job_posting_id)) {
        return { status: "conflict", reason: "job_mismatch" };
      }
      const existing = (await tx.query(
        "SELECT * FROM application_materials WHERE workspace_id=$1 AND document_version_id=$2 AND deleted_at IS NULL FOR UPDATE",
        [context.workspaceId, versionId],
      )).rows[0];
      if (existing && String(existing.application_id) !== applicationId) return { status: "conflict", reason: "different_application" };

      let currentVersion = version;
      if (!version.submitted_at) {
        currentVersion = (await tx.query(
          "UPDATE document_versions SET submitted_at=now(),updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [context.workspaceId, versionId],
        )).rows[0]!;
      }
      let material = existing;
      if (!material) {
        const document = (await tx.query("SELECT title FROM documents WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [context.workspaceId, String(version.document_id)])).rows[0];
        if (!document) return { status: "not_found" };
        material = (await tx.query(
          `INSERT INTO application_materials(id,workspace_id,application_id,document_id,document_version_id,material_type,title,notes,created_at,updated_at,revision)
           VALUES($1,$2,$3,$4,$5,'cv',$6,'Explicitly marked as submitted.',now(),now(),1) RETURNING *`,
          [randomUUID(), context.workspaceId, applicationId, String(version.document_id), versionId, String(document.title)],
        )).rows[0]!;
        await audit(tx, context, "application_material.submitted", "ApplicationMaterial", String(material.id), "Linked an exact CV snapshot to an application");
      }
      return {
        status: existing ? "already_submitted" : "submitted",
        version: versionRecord(currentVersion),
        material: materialRecord(material),
      };
    });
  }
}
