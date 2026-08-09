import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, userInfo } from "node:os";
import { inflateRawSync, inflateSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { createOpenAiProvider, enrichJobDraft, enrichProfileDraft, normaliseCvContent, type ProfileExtractionDraft } from "@careeros/ai";
import {
  applicationCreateSchema,
  cvChangeProposalSchema,
  cvDraftSaveSchema,
  cvProposalStateSchema,
  cvDocumentContentSchema,
  cvTailoringProposalSchema,
  cvTailoringRequestSchema,
  documentVersionCreateSchema,
  documentVersionPdfExportSchema,
  discoveryIssueCreateSchema,
  discoveryQuerySchema,
  discoverySourceCreateSchema,
  eventSchema,
  alertRuleCreateSchema,
  alertRuleUpdateSchema,
  telegramSettingsUpdateSchema,
  captureQueueBatchSchema,
  captureDraftSaveSchema,
  captureBatchCommitSchema,
  captureCommitSchema,
  importInputSchema,
  jobDraftSchema,
  jobUpdateSchema,
  openAiKeySaveSchema,
  salaryEstimateCreateSchema,
  salaryResearchProposalSchema,
  taskCreateSchema,
  taskUpdateSchema,
  profileDocumentImportCommitSchema,
  profileDocumentImportInputSchema,
  profileUpdateSchema,
  statusFromEvent,
  type AiRunRecord,
  type AiSettingsStatus,
  type ApplicationEventType,
  type ApplicationStatus,
  type ApplicationStudioDocument,
  type ApplicationStudioWorkspace,
  type CareerStudioWorkspace,
  type CaptureQueueItem,
  type CaptureQueueSummary,
  type CaptureDraftRecord,
  type DiscoverySourceRecord,
  type CvDocumentContent,
  type DocumentVersionRecord,
  type JobDraft,
  type ImportDraftResponse,
  type ImportInput,
  type JobRow,
  type SalaryEstimateCreateInput,
  type SalaryEstimateRecord,
  type SalaryResearchEvidence,
  type ProfileDocumentRecord,
  type ProfileDocumentPreview,
  type ProfileRecord,
  type ProfileSectionType,
} from "@careeros/contracts";
import { dataDir, db, migrate, pendingRestorePath, sqlite, startupRestoreReadOnly } from "./db.js";
import { aiRuns, applicationMaterials, applications, applicationEvents, companies, documentDrafts, documents, documentVersions, fieldEvidence, importRuns, jobPostings, profileEvidence, profiles, salaryEstimates, salaryResearchEvidence, sourceDocuments, tasks } from "./schema.js";
import { capturePastedText, captureUrl, contentHash, extractJobDraft, sourceId } from "./importer.js";
import { CaptureBlockedError, CaptureQueueCapacityError, CaptureQueueService, captureQueueStatuses, type CaptureQueueJob } from "./capture-queue.js";
import { SqliteCaptureQueueStore } from "./capture-queue-sqlite.js";
import { DiscoveryService } from "./discovery-service.js";
import { assertSafeBundlePath, createBackupBundle, encodeBackupBundle, prepareBackupRestore, validateBackupBundle, writePendingRestoreMarker, type BackupBundle } from "./backup-bundle.js";
import { DEFAULT_WORKSPACE_ID, HostedAuthService } from "./hosted-auth.js";
import { renderCvPdf, renderCvPdfHtml } from "./cv-pdf.js";
import { configuredBackupObjectStorage, configuredObjectStorage } from "./storage/configured-storage.js";
import { decodeBackupKey, decryptBackup, EncryptedBackupScheduler } from "./encrypted-backup.js";
import { ProcessMutationGate } from "./mutation-gate.js";
import { stageRestoreObjects } from "./restore-coordination.js";
import { HostedSessionService } from "./hosted-session.js";
import { createRuntimeDataProvider, postgresRouteConverted, postgresRouteRequiresConversion } from "./runtime-data-provider.js";
import { PostgresHostedAuthService } from "./postgres-hosted-auth.js";
import { PostgresTrackerRepository, SqliteTrackerRepository } from "./tracker-repository.js";
import { PostgresCaptureRepository, type ClaimedCapture, type CaptureCommitRequest as PostgresCaptureCommitRequest } from "./postgres-capture-repository.js";
import { PostgresCaptureWorker } from "./postgres-capture-worker.js";
import { assertSafeDirectUrl, PostgresDiscoveryRepository } from "./postgres-discovery-repository.js";
import { PostgresDiscoveryQueryRepository } from "./postgres-discovery-query.js";
import { PostgresDiscoveryService, runWorkspaceTasksIsolated } from "./postgres-discovery-service.js";
import { createHostedAtsFetcher } from "./postgres-discovery-adapters.js";
import { createTelegramProvider } from "./notifications.js";
import { PostgresTelegramSettingsRepository } from "./postgres-telegram-settings.js";
import { PostgresApplicationStudioRepository, type DocumentVersionSnapshot } from "./application-studio-repository.js";
import { createPostgresWorkspaceBundle, restorePostgresWorkspaceBundle } from "./postgres-workspace-backup.js";
import { PostgresHostedBackupService } from "./postgres-hosted-backup.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { preflightPublicAppUrl } from "./public-app-url.js";

const runtimeDataProvider = await createRuntimeDataProvider();
if (runtimeDataProvider.name === "sqlite") migrate();
const postgresSchemaVersion = runtimeDataProvider.name === "postgres"
  ? (await discoverCloudMigrations()).at(-1)?.version ?? "unknown"
  : null;

const app = Fastify({ logger: true });
const hostedAllowedOrigins = (process.env.CAREEROS_ALLOWED_ORIGINS ?? process.env.CAREEROS_APP_URL ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const supabaseConnectOrigins = (() => {
  try {
    const url = new URL(process.env.SUPABASE_URL ?? "");
    return [url.origin, `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`];
  } catch {
    return [];
  }
})();
await app.register(cors, {
  origin: hostedAllowedOrigins.length ? hostedAllowedOrigins : [/^http:\/\/(127\.0\.0\.1|localhost):\d+$/],
  credentials: true,
});
await app.register(helmet, { contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: ["'self'", ...supabaseConnectOrigins],
  fontSrc: ["'self'", "data:"],
  frameAncestors: ["'none'"],
  imgSrc: ["'self'", "data:", "https:"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
} } });
const configuredRateLimit = Number(process.env.CAREEROS_RATE_LIMIT_MAX ?? 1_200);
if (!Number.isSafeInteger(configuredRateLimit) || configuredRateLimit < 1) {
  throw new Error("CAREEROS_RATE_LIMIT_MAX must be a positive integer.");
}
await app.register(rateLimit, { max: configuredRateLimit, timeWindow: "1 minute" });

const now = () => new Date().toISOString();
const keychainService = "CareerOS.OpenAI";
const keychainAccount = userInfo().username;
const projectDir = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pendingInviteCookieName = "careeros_pending_invite";

function storedFilePath(relativePath: string) {
  const safePath = assertSafeBundlePath(relativePath.replaceAll(sep, "/"));
  const absolutePath = resolve(dataDir, ...safePath.split("/"));
  const fromRoot = relative(resolve(dataDir), absolutePath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw Object.assign(new Error("Stored file path is outside the CareerOS data directory."), { statusCode: 409 });
  return absolutePath;
}

function requestCookie(request: { headers: { cookie?: string } }, name: string) {
  const entry = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

function pendingInviteCookie(value: string, clear = false) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${pendingInviteCookieName}=${clear ? "" : encodeURIComponent(value)}; Path=/api/auth/invitations; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 900}${secure}`;
}

function readKeychainOpenAiKey() {
  if (process.platform !== "darwin" || process.env.CAREEROS_DISABLE_KEYCHAIN === "1") return "";
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
  } catch {
    return "";
  }
}

function createConfiguredAiProvider(apiKey?: string) {
  return createOpenAiProvider({
    apiKey,
    model: process.env.CAREEROS_AI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
    timeoutMs: Number(process.env.CAREEROS_AI_TIMEOUT_MS ?? 20_000),
  });
}

const environmentOpenAiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const bootKeychainOpenAiKey = environmentOpenAiKey ? "" : readKeychainOpenAiKey();
let aiKeySource: AiSettingsStatus["source"] = environmentOpenAiKey ? "environment" : bootKeychainOpenAiKey ? "keychain" : "none";
let aiProvider = createConfiguredAiProvider(environmentOpenAiKey || bootKeychainOpenAiKey);

function aiSettingsStatus(): AiSettingsStatus {
  return { configured: aiProvider.configured, provider: aiProvider.name, model: aiProvider.model, source: aiKeySource };
}

function saveKeychainOpenAiKey(apiKey: string) {
  if (process.platform !== "darwin" || process.env.CAREEROS_DISABLE_KEYCHAIN === "1") throw new Error("Secure key storage currently requires macOS Keychain.");
  execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", keychainService, "-a", keychainAccount, "-w", apiKey], {
    stdio: "ignore",
    timeout: 4_000,
  });
}

function deleteKeychainOpenAiKey() {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("/usr/bin/security", ["delete-generic-password", "-s", keychainService, "-a", keychainAccount], { stdio: "ignore", timeout: 4_000 });
  } catch {
    // Deleting a missing item is already the desired state.
  }
}


type AiRunInput = Omit<AiRunRecord, "id" | "createdAt">;

function aiRunState(mode: "ai" | "deterministic", skipped = false): AiRunRecord["state"] {
  if (skipped) return "skipped";
  return mode === "ai" ? "completed" : "fallback";
}

function recordAiRun(input: AiRunInput): AiRunRecord | null {
  try {
    const id = randomUUID();
    const timestamp = now();
    db.insert(aiRuns).values({
      id,
      operation: input.operation,
      contextId: input.contextId,
      sourceType: input.sourceType,
      state: input.state,
      provider: input.provider,
      model: input.model,
      durationMs: input.durationMs,
      totalDurationMs: input.totalDurationMs,
      evidenceCount: input.evidenceCount,
      warning: input.warning,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    }).run();
    return { id, createdAt: timestamp, ...input };
  } catch (error) {
    app.log.error(error, "Could not persist AI run metrics");
    return null;
  }
}

async function recordHostedAiRun(context: ReturnType<typeof trackerContext>, input: AiRunInput): Promise<AiRunRecord | null> {
  if (runtimeDataProvider.name !== "postgres") return recordAiRun(input);
  const id = randomUUID();
  const createdAt = now();
  try {
    await runtimeDataProvider.postgres.transaction(context, (tx) => tx.query(`INSERT INTO ai_runs
      (id,workspace_id,operation,context_id,source_type,state,provider,model,duration_ms,total_duration_ms,evidence_count,warning,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`, [
      id, context.workspaceId, input.operation, input.contextId, input.sourceType, input.state, input.provider, input.model,
      input.durationMs, input.totalDurationMs, input.evidenceCount, input.warning, createdAt,
    ]));
    return { id, createdAt, ...input };
  } catch (error) {
    app.log.error(error, "Could not persist hosted AI run metrics");
    return null;
  }
}

function parseArray(value: string | null | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    return JSON.parse(value ?? "[]") as string[];
  } catch {
    return [];
  }
}

type ApiJobRow = JobRow & { companyName: string; notes: string };

function rowToJob(row: Record<string, unknown>, visibleIndex = 0): ApiJobRow {
  return {
    id: row.id,
    companyId: row.companyId,
    visibleIndex,
    title: row.title,
    companyName: row.companyName,
    companySnapshot: row.companySnapshot ?? "",
    companyDescription: row.companyDescription ?? "",
    location: row.location ?? "",
    country: row.country ?? "",
    region: row.region ?? "",
    workMode: row.workMode ?? "",
    employmentType: row.employmentType ?? "",
    seniority: row.seniority ?? "",
    sector: row.sector ?? "",
    roleFamily: row.roleFamily ?? "",
    division: row.division ?? "",
    team: row.team ?? "",
    summary: row.summary ?? "",
    description: row.description ?? "",
    requiredRequirements: parseArray(row.requiredRequirements as string),
    preferredRequirements: parseArray(row.preferredRequirements as string),
    processSummary: row.processSummary ?? "",
    visaRequirements: row.visaRequirements ?? "",
    requisitionId: row.requisitionId ?? "",
    sourceUrl: row.sourceUrl ?? "",
    applyUrl: row.applyUrl ?? "",
    referralSource: row.referralSource ?? "",
    recruiterContact: row.recruiterContact ?? "",
    applicationDeadline: row.applicationDeadline ?? "",
    postingDate: row.postingDate ?? "",
    expiryDate: row.expiryDate ?? "",
    lastCheckedAt: row.lastCheckedAt ?? "",
    postingState: row.postingState ?? "Active",
    notes: row.notes ?? "",
    applicationId: row.applicationId ?? null,
    applicationStatus: row.applicationStatus ?? null,
    appliedAt: row.appliedAt ?? null,
    nextAction: row.nextAction ?? null,
    salaryEstimateId: row.salaryEstimateId ?? null,
    salaryEstimateType: row.salaryEstimateType ?? null,
    salaryMinAmount: typeof row.salaryMinAmount === "number" ? row.salaryMinAmount : null,
    salaryMaxAmount: typeof row.salaryMaxAmount === "number" ? row.salaryMaxAmount : null,
    salaryCurrency: row.salaryCurrency ?? "",
    salaryScope: row.salaryScope ?? null,
    salaryConfidence: typeof row.salaryConfidence === "number" ? row.salaryConfidence : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: Number(row.revision ?? 1),
  } as ApiJobRow;
}

function listRows(filters: Record<string, string | undefined> = {}) {
  const conditions = ["j.deleted_at IS NULL"];
  const params: string[] = [];
  if (filters.status && filters.status !== "All") { conditions.push("a.current_status = ?"); params.push(filters.status); }
  if (filters.sector && filters.sector !== "All") { conditions.push("j.sector = ?"); params.push(filters.sector); }
  if (filters.applied === "yes") conditions.push("a.applied_at IS NOT NULL");
  if (filters.applied === "no") conditions.push("a.applied_at IS NULL");
  if (filters.search) {
    const query = `%${filters.search.toLowerCase()}%`;
    conditions.push("(lower(j.title) LIKE ? OR lower(c.name) LIKE ? OR lower(j.summary) LIKE ? OR lower(j.description) LIKE ?)");
    params.push(query, query, query, query);
  }
  const rows = sqlite.prepare(`
    SELECT
      j.id AS id, j.company_id AS companyId, j.title AS title, c.name AS companyName,
      c.snapshot AS companySnapshot, c.description AS companyDescription,
      j.requisition_id AS requisitionId, j.location AS location, j.country AS country, j.region AS region,
      j.work_mode AS workMode, j.employment_type AS employmentType, j.seniority AS seniority,
      j.sector AS sector, j.role_family AS roleFamily, j.division AS division, j.team AS team,
      j.summary AS summary, j.description AS description, j.required_requirements AS requiredRequirements,
      j.preferred_requirements AS preferredRequirements, j.process_summary AS processSummary,
      j.visa_requirements AS visaRequirements, j.source_url AS sourceUrl, j.apply_url AS applyUrl,
      j.referral_source AS referralSource, j.recruiter_contact AS recruiterContact,
      j.application_deadline AS applicationDeadline, j.posting_date AS postingDate, j.expiry_date AS expiryDate,
      j.last_checked_at AS lastCheckedAt,
      j.posting_state AS postingState, j.notes AS notes, j.created_at AS createdAt, j.updated_at AS updatedAt, j.revision AS revision,
      a.id AS applicationId, a.current_status AS applicationStatus, a.applied_at AS appliedAt, a.next_action AS nextAction,
      s.id AS salaryEstimateId, s.estimate_type AS salaryEstimateType,
      COALESCE(s.base_min_amount, s.min_amount, s.total_comp_min_amount) AS salaryMinAmount,
      COALESCE(s.base_max_amount, s.max_amount, s.total_comp_max_amount) AS salaryMaxAmount,
      s.currency AS salaryCurrency, s.confidence AS salaryConfidence,
      CASE
        WHEN s.base_min_amount IS NOT NULL OR s.base_max_amount IS NOT NULL THEN 'base'
        WHEN s.min_amount IS NOT NULL OR s.max_amount IS NOT NULL THEN 'range'
        WHEN s.total_comp_min_amount IS NOT NULL OR s.total_comp_max_amount IS NOT NULL THEN 'total'
        ELSE NULL
      END AS salaryScope
    FROM job_postings j
    JOIN companies c ON c.id = j.company_id
    LEFT JOIN applications a ON a.job_posting_id = j.id AND a.deleted_at IS NULL
    LEFT JOIN salary_estimates s ON s.id = (
      SELECT candidate.id
      FROM salary_estimates candidate
      WHERE candidate.job_posting_id = j.id AND candidate.deleted_at IS NULL
      ORDER BY candidate.created_at DESC
      LIMIT 1
    )
    WHERE ${conditions.join(" AND ")}
    ORDER BY j.updated_at DESC
  `).all(...params) as Record<string, unknown>[];
  return rows.map((row, index) => rowToJob(row, index + 1));
}

function insertCompany(name: string, snapshot = "", description = "") {
  const existing = db.select().from(companies).where(eq(companies.name, name)).get();
  if (existing) return existing.id;
  const id = randomUUID();
  const timestamp = now();
  db.insert(companies).values({ id, name: name.trim() || "Unknown company", snapshot, description, createdAt: timestamp, updatedAt: timestamp, revision: 1 }).run();
  return id;
}

function insertJob(draft: JobDraft, sourceDocumentId?: string) {
  const timestamp = now();
  const companyId = insertCompany(draft.companyName, draft.companySnapshot, draft.companyDescription);
  const id = randomUUID();
  db.insert(jobPostings).values({
    id,
    companyId,
    title: draft.title,
    requisitionId: draft.requisitionId,
    location: draft.location,
    country: draft.country,
    region: draft.region,
    workMode: draft.workMode,
    employmentType: draft.employmentType,
    seniority: draft.seniority,
    sector: draft.sector,
    roleFamily: draft.roleFamily,
    division: draft.division,
    team: draft.team,
    summary: draft.summary,
    description: draft.description,
    requiredRequirements: JSON.stringify(draft.requiredRequirements),
    preferredRequirements: JSON.stringify(draft.preferredRequirements),
    processSummary: draft.processSummary,
    visaRequirements: draft.visaRequirements,
    sourceUrl: draft.sourceUrl,
    applyUrl: draft.applyUrl,
    referralSource: draft.referralSource,
    recruiterContact: draft.recruiterContact,
    applicationDeadline: draft.applicationDeadline,
    postingDate: draft.postingDate,
    expiryDate: draft.expiryDate,
    lastCheckedAt: draft.lastCheckedAt || (draft.sourceUrl ? timestamp : ""),
    postingState: draft.postingState,
    notes: (draft as JobDraft & { notes?: string }).notes ?? "",
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  }).run();
  if (sourceDocumentId) {
    db.insert(fieldEvidence).values({
      id: randomUUID(), entityType: "JobPosting", entityId: id, fieldPath: "description", sourceDocumentId,
      excerpt: draft.description.slice(0, 500), method: "deterministic", suggestedValue: draft.description,
      confidence: 0.65, userConfirmed: false, capturedAt: timestamp,
    }).run();
  }
  return id;
}

function serialiseDraftField(draft: JobDraft, fieldPath: string) {
  const value = draft[fieldPath as keyof JobDraft];
  return Array.isArray(value) ? JSON.stringify(value) : String(value ?? "");
}

function transferImportEvidence(importId: string, jobPostingId: string, draft: JobDraft) {
  const timestamp = now();
  const evidenceRows = sqlite.prepare(`
    SELECT field_path AS fieldPath, source_document_id AS sourceDocumentId, excerpt, method,
           suggested_value AS suggestedValue, confidence
    FROM field_evidence
    WHERE entity_type = 'ImportRun' AND entity_id = ?
  `).all(importId) as Array<{
    fieldPath: string;
    sourceDocumentId: string | null;
    excerpt: string;
    method: string;
    suggestedValue: string;
    confidence: number;
  }>;

  for (const evidence of evidenceRows) {
    const reviewedValue = serialiseDraftField(draft, evidence.fieldPath);
    db.insert(fieldEvidence).values({
      id: randomUUID(),
      entityType: "JobPosting",
      entityId: jobPostingId,
      fieldPath: evidence.fieldPath,
      sourceDocumentId: evidence.sourceDocumentId,
      excerpt: evidence.excerpt,
      method: evidence.method,
      suggestedValue: evidence.suggestedValue,
      confidence: evidence.confidence,
      userConfirmed: reviewedValue === evidence.suggestedValue,
      capturedAt: timestamp,
    }).run();
    if (reviewedValue !== evidence.suggestedValue) {
      db.insert(fieldEvidence).values({
        id: randomUUID(),
        entityType: "JobPosting",
        entityId: jobPostingId,
        fieldPath: evidence.fieldPath,
        sourceDocumentId: evidence.sourceDocumentId,
        excerpt: "",
        method: "user_confirmed",
        suggestedValue: reviewedValue,
        confidence: 1,
        userConfirmed: true,
        capturedAt: timestamp,
      }).run();
    }
  }
}

function blockedImportMessage(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("private") || normalized.includes("blocked") || normalized.includes("too long") || normalized.includes("timed out");
}

function getJobDetail(id: string) {
  const rows = listRows();
  const row = rows.find((item) => item.id === id);
  if (!row) return null;
  const applicationId = row.applicationId as string | null;
  const events = applicationId ? db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, applicationId)).all().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) : [];
  const taskRows = db.select().from(tasks).where(sql`${tasks.entityId} = ${id} AND ${tasks.deletedAt} IS NULL`).all();
  const salaryRows = db.select().from(salaryEstimates).where(sql`${salaryEstimates.jobPostingId} = ${id} AND ${salaryEstimates.deletedAt} IS NULL`).all();
  const evidenceRows = db.select().from(fieldEvidence).where(sql`${fieldEvidence.entityType} = 'JobPosting' AND ${fieldEvidence.entityId} = ${id}`).all();
  return {
    ...row,
    company: { id: row.companyId, name: row.companyName, snapshot: row.companySnapshot, description: row.companyDescription },
    events: events.map((event) => ({ id: event.id, applicationId: event.applicationId, type: event.type as ApplicationEventType, statusAfter: event.statusAfter as ApplicationStatus, occurredAt: event.occurredAt, note: event.note, createdAt: event.createdAt })),
    evidenceCount: evidenceRows.length,
    evidence: evidenceRows.map((evidence) => ({
      id: evidence.id,
      fieldPath: evidence.fieldPath,
      excerpt: evidence.excerpt,
      method: evidence.method,
      suggestedValue: evidence.suggestedValue,
      confidence: evidence.confidence,
      userConfirmed: evidence.userConfirmed,
      capturedAt: evidence.capturedAt,
    })),
    tasks: taskRows.map((task) => ({
      id: task.id,
      title: task.title,
      taskType: task.taskType as "follow_up" | "deadline" | "research" | "preparation" | "application",
      priority: task.priority as "Low" | "Medium" | "High",
      dueDate: task.dueDate,
      notes: task.notes,
      completed: Boolean(task.completedAt),
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      revision: task.revision,
    })),
    salaries: salaryRows.map((salary): SalaryEstimateRecord => ({
      id: salary.id,
      jobPostingId: salary.jobPostingId,
      estimateType: salary.estimateType as SalaryEstimateRecord["estimateType"],
      minAmount: salary.minAmount,
      maxAmount: salary.maxAmount,
      baseMinAmount: salary.baseMinAmount,
      baseMaxAmount: salary.baseMaxAmount,
      totalCompMinAmount: salary.totalCompMinAmount,
      totalCompMaxAmount: salary.totalCompMaxAmount,
      currency: salary.currency,
      paymentPeriod: salary.paymentPeriod as SalaryEstimateRecord["paymentPeriod"],
      baseSalary: salary.baseSalary,
      bonus: salary.bonus,
      equity: salary.equity,
      otherCompensation: salary.otherCompensation,
      country: salary.country,
      region: salary.region,
      seniorityAssumptions: salary.seniorityAssumptions,
      sourceName: salary.sourceName,
      sourceUrl: salary.sourceUrl,
      evidenceExcerpt: salary.evidenceExcerpt,
      sourceDate: salary.sourceDate,
      confidence: salary.confidence,
      annualisedEquivalent: salary.annualisedEquivalent,
      normalisedCurrency: salary.normalisedCurrency,
      exchangeRateDate: salary.exchangeRateDate,
      researchNotes: salary.researchNotes,
      createdAt: salary.createdAt,
      updatedAt: salary.updatedAt,
      evidence: db.select().from(salaryResearchEvidence).where(eq(salaryResearchEvidence.salaryEstimateId, salary.id)).all().map((item) => ({
        sourceName: item.sourceName,
        sourceUrl: item.sourceUrl,
        sourceDate: item.sourceDate,
        roleTitle: item.roleTitle,
        location: item.location,
        seniority: item.seniority,
        compensationScope: item.compensationScope as SalaryResearchEvidence["compensationScope"],
        minAmount: item.minAmount,
        maxAmount: item.maxAmount,
        currency: item.currency,
        paymentPeriod: item.paymentPeriod as SalaryResearchEvidence["paymentPeriod"],
        excerpt: item.excerpt,
        confidence: item.confidence,
      })),
    })),
  };
}

function trackerContext(request: Parameters<HostedAuthService["requireSession"]>[0]) {
  const session = hostedAuth.requireMembership(request);
  return { workspaceId: session.workspaceId, userId: session.userId, authSubject: session.actor.id };
}

async function getRuntimeJobDetail(request: Parameters<HostedAuthService["requireSession"]>[0], id: string) {
  if (runtimeDataProvider.name === "sqlite") return getJobDetail(id);
  const context = trackerContext(request);
  const detail = await trackerRepository.getJobDetail(context, id);
  if (!detail) return null;
  const row = rowToJob(detail.row as Record<string, unknown>);
  const evidence = (detail.evidence as Record<string, unknown>[]).map((item) => ({
    id: item.id, fieldPath: item.fieldPath, excerpt: item.excerpt, method: item.method,
    suggestedValue: item.suggestedValue, confidence: Number(item.confidence),
    userConfirmed: Boolean(item.userConfirmed), capturedAt: item.capturedAt,
  }));
  return {
    ...row,
    company: { id: row.companyId, name: row.companyName, snapshot: row.companySnapshot, description: row.companyDescription },
    events: detail.events,
    evidenceCount: evidence.length,
    evidence,
    tasks: (detail.tasks as Record<string, unknown>[]).map((task) => ({ ...task, completed: Boolean(task.completedAt) })),
    salaries: detail.salaries,
  };
}

function ensureProfile() {
  const existing = db.select().from(profiles).where(sql`${profiles.deletedAt} IS NULL`).get();
  if (existing) return existing;
  const timestamp = now();
  const id = randomUUID();
  db.insert(profiles).values({
    id,
    name: "Zain Ahmad",
    headline: "Imperial College London Design Engineering graduate",
    summary: "Interdisciplinary design engineer exploring finance, quantitative finance, big tech, software, startups, and founder work.",
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  }).run();
  const defaults = [
    {
      evidenceType: "education",
      title: "Imperial College London",
      content: "Design Engineering degree with interdisciplinary technical, product, systems, and design practice.",
    },
    {
      evidenceType: "preference",
      title: "Target tracks",
      content: "Finance, quantitative finance, big tech, software engineering, design engineering, startups, and founder or side-business work.",
    },
  ] as const;
  for (const section of defaults) {
    db.insert(profileEvidence).values({
      id: randomUUID(),
      profileId: id,
      evidenceType: section.evidenceType,
      title: section.title,
      content: section.content,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    }).run();
  }
  return db.select().from(profiles).where(eq(profiles.id, id)).get()!;
}

function getProfileRecord(): ProfileRecord {
  const profile = ensureProfile();
  const sections = db.select().from(profileEvidence).where(sql`${profileEvidence.profileId} = ${profile.id} AND ${profileEvidence.deletedAt} IS NULL`).all();
  return {
    id: profile.id,
    name: profile.name,
    headline: profile.headline,
    summary: profile.summary,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    revision: profile.revision,
    sections: sections.map((section) => ({
      id: section.id,
      profileId: section.profileId,
      evidenceType: section.evidenceType as ProfileSectionType,
      title: section.title,
      content: section.content,
      createdAt: section.createdAt,
      updatedAt: section.updatedAt,
      revision: section.revision,
    })),
  };
}

const maxDocumentBytes = 10_000_000;

function cleanExtractedText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type TextExtractionResult = {
  text: string;
  method: "pdf_pdftotext" | "pdf_basic" | "docx" | "rtf" | "text" | "unknown";
  warning: string | null;
};

function looksLikeGarbledText(text: string) {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 300) return false;
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const symbols = text.match(/[!"#$%&()*+,./:;<=>?@[\\\]^_`{|}~-]/g)?.length ?? 0;
  const longerWords = text.match(/[A-Za-z]{5,}/g)?.length ?? 0;
  const commonCvWords = text.match(/\b(the|and|with|for|from|experience|education|project|skills|university|college|engineer|design|work|team|developed|built|led)\b/gi)?.length ?? 0;

  return letters / compact.length < 0.25
    || symbols / compact.length > 0.45
    || (longerWords < 8 && commonCvWords < 3);
}

function extractionWarning(text: string, fileKind: string) {
  if (!text || text.length < 80) {
    return `CareerOS saved the ${fileKind}, but extracted very little text. If this is a scanned PDF or legacy .doc file, paste the text or export it as PDF/DOCX.`;
  }
  if (looksLikeGarbledText(text)) {
    return `CareerOS saved the ${fileKind}, but the extracted text looks garbled. For PDFs, install Poppler with brew install poppler, then re-import; otherwise paste the clean text or upload a DOCX export.`;
  }
  return null;
}

function safeFileName(fileName: string) {
  const cleaned = basename(fileName || "profile-document.txt").replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  return cleaned || "profile-document.txt";
}

function checksumBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function documentRowToRecord(row: Record<string, unknown>): ProfileDocumentRecord {
  return {
    id: String(row.id),
    documentType: row.documentType as ProfileDocumentRecord["documentType"],
    title: String(row.title ?? ""),
    relativePath: String(row.relativePath ?? ""),
    checksum: String(row.checksum ?? ""),
    mimeType: String(row.mimeType ?? ""),
    sizeBytes: Number(row.sizeBytes ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    revision: Number(row.revision ?? 1),
  };
}

async function storeProfileDocument(input: { documentType: string; title: string; fileName: string; mimeType: string; buffer: Buffer }) {
  if (input.buffer.byteLength > maxDocumentBytes) throw new Error("That document is too large. Keep profile imports under 10 MB for now.");
  const id = randomUUID();
  const timestamp = now();
  const fileName = safeFileName(input.fileName);
  const relativePath = ["documents", id, fileName].join("/");
  const checksum = checksumBuffer(input.buffer);
  await configuredStorage.adapter.upload({ workspaceId: DEFAULT_WORKSPACE_ID, path: relativePath, bytes: input.buffer, contentType: input.mimeType });
  try {
    db.insert(documents).values({
      id,
      documentType: input.documentType,
      title: input.title || fileName,
      relativePath,
      checksum,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    }).run();
  } catch (error) {
    await configuredStorage.adapter.delete({ workspaceId: DEFAULT_WORKSPACE_ID, path: relativePath }).catch(() => undefined);
    throw error;
  }
  const row = db.select().from(documents).where(eq(documents.id, id)).get() as unknown as Record<string, unknown>;
  return documentRowToRecord(row);
}

async function readStoredBytes(relativePath: string, expectedChecksum: string) {
  const legacyPath = storedFilePath(relativePath);
  let legacyChecksumFailed = false;
  if (existsSync(legacyPath)) {
    const bytes = readFileSync(legacyPath);
    if (expectedChecksum && checksumBuffer(bytes) === expectedChecksum) return bytes;
    legacyChecksumFailed = true;
  }
  try {
    const object = await configuredStorage.adapter.read({ workspaceId: DEFAULT_WORKSPACE_ID, path: relativePath.replaceAll(sep, "/"), expectedChecksum });
    return Buffer.from(object.bytes);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (legacyChecksumFailed && code === "not_found") {
      throw Object.assign(new Error("The stored file failed checksum verification."), { statusCode: 409 });
    }
    const statusCode = code === "not_found" ? 404 : code === "checksum_mismatch" ? 409 : 502;
    throw Object.assign(new Error(error instanceof Error ? error.message : "The stored file could not be read."), { statusCode });
  }
}

function referencedStorageFiles(bundle: BackupBundle) {
  const paths = new Map<string, string>();
  for (const table of ["documents", "document_versions"]) {
    const snapshot = bundle.structuredData.tables.find((candidate) => candidate.name === table);
    if (!snapshot) continue;
    const pathIndex = snapshot.columns.indexOf("relative_path");
    const checksumIndex = snapshot.columns.indexOf("checksum");
    if (pathIndex < 0 || checksumIndex < 0) continue;
    for (const row of snapshot.rows) {
      const path = String(row[pathIndex] ?? "").replaceAll(sep, "/");
      const checksum = String(row[checksumIndex] ?? "");
      if (path) paths.set(path, checksum);
    }
  }
  return [...paths.entries()].sort(([left], [right]) => left.localeCompare(right));
}

let restorePending = false;
const mutationGate = new ProcessMutationGate(startupRestoreReadOnly);
const mutationMarker = Symbol("careerosMutation");
const authenticatedMarker = Symbol("careerosAuthenticated");

function releaseMutation(request: Record<PropertyKey, unknown>) {
  const release = request[mutationMarker];
  if (typeof release !== "function") return;
  request[mutationMarker] = undefined;
  release();
}

async function createStorageBackedBundle() {
  const bundle = createBackupBundle({
    sqlite,
    dataDirectory: dataDir,
    schemaVersion: 4,
    applicationVersion: "0.1.0",
    associatedFilePaths: [],
  });
  for (const [path, checksum] of referencedStorageFiles(bundle)) {
    const bytes = await readStoredBytes(path, checksum);
    bundle.files[path] = bytes.toString("base64");
    bundle.manifest.files.push({ path, sizeBytes: bytes.byteLength, sha256: checksumBuffer(bytes) });
  }
  validateBackupBundle(bundle, { expectedSchemaVersion: 4, expectedApplicationVersion: "0.1.0" });
  return bundle;
}

function preflightRestore(bundle: BackupBundle) {
  const prepared = prepareBackupRestore({
    bundle,
    destinationDataDirectory: dataDir,
    expectedSchemaVersion: 4,
    expectedApplicationVersion: "0.1.0",
  });
  prepared.abort();
}

type BackupCatalogRecord = { id: string; workspaceId: string; path: string; checksum: string; sizeBytes: number; createdAt: string };

async function authenticatedBackupCatalog(): Promise<BackupCatalogRecord[]> {
  return sqlite.prepare(`SELECT id,workspace_id AS workspaceId,object_path AS path,checksum,size_bytes AS sizeBytes,created_at AS createdAt
    FROM backup_records WHERE workspace_id=? ORDER BY created_at`).all(DEFAULT_WORKSPACE_ID) as BackupCatalogRecord[];
}

function reconcileBackupCatalog(bundle: BackupBundle, records: BackupCatalogRecord[]): BackupBundle {
  if (!records.length) return bundle;
  const root = mkdtempSync(join(tmpdir(), "careeros-restore-catalog-"));
  try {
    const databasePath = join(root, "careeros.sqlite");
    writeFileSync(databasePath, Buffer.from(bundle.databaseBase64, "base64"), { mode: 0o600, flag: "wx" });
    for (const entry of bundle.manifest.files) {
      const target = join(root, ...assertSafeBundlePath(entry.path).split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, Buffer.from(bundle.files[entry.path], "base64"), { mode: 0o600, flag: "wx" });
    }
    const restored = new Database(databasePath);
    try {
      const merge = restored.transaction(() => {
        for (const record of records) {
          restored.prepare("DELETE FROM backup_records WHERE id=? OR object_path=?").run(record.id, record.path);
          restored.prepare(`INSERT INTO backup_records(id,workspace_id,object_path,checksum,size_bytes,created_at) VALUES (?,?,?,?,?,?)`)
            .run(record.id, record.workspaceId, record.path, record.checksum, record.sizeBytes, record.createdAt);
        }
      });
      merge();
    } finally {
      restored.close();
    }
    const reconciled = new Database(databasePath, { readonly: true });
    try {
      return createBackupBundle({
        sqlite: reconciled,
        dataDirectory: root,
        schemaVersion: 4,
        applicationVersion: "0.1.0",
        exportedAt: bundle.manifest.exportedAt,
        associatedFilePaths: bundle.manifest.files.map((entry) => entry.path),
      });
    } finally {
      reconciled.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function stageRestore(bundle: BackupBundle) {
  return mutationGate.exclusive(async () => {
    if (restorePending || existsSync(pendingRestorePath)) throw Object.assign(new Error("A verified restore is already waiting for restart."), { statusCode: 409 });
    const catalog = await authenticatedBackupCatalog();
    const reconciled = reconcileBackupCatalog(bundle, catalog);
    preflightRestore(reconciled);
    await stageRestoreObjects({
      storage: configuredStorage.adapter,
      workspaceId: DEFAULT_WORKSPACE_ID,
      bundle: reconciled,
      writePendingMarker: () => {
        const prepared = prepareBackupRestore({
          bundle: reconciled,
          destinationDataDirectory: dataDir,
          expectedSchemaVersion: 4,
          expectedApplicationVersion: "0.1.0",
        });
        writePendingRestoreMarker({ markerPath: pendingRestorePath, prepared, databaseSha256: reconciled.manifest.database.sha256 });
      },
      onCleanupFailure: ({ failedPaths }) => app.log.error({ failedObjectCount: failedPaths.length }, "Restore object cleanup failed"),
    });
    restorePending = true;
  }, { sealOnSuccess: true });
}

function sourceDocumentForProfileDocument(documentId: string) {
  const sources = db.select().from(sourceDocuments).all();
  return sources.find((source) => {
    try { return JSON.parse(source.metadata || "{}").documentId === documentId; }
    catch { return false; }
  }) ?? null;
}

function documentContentToText(content: CvDocumentContent) {
  return [
    content.name,
    content.contact?.email,
    content.contact?.phone,
    content.contact?.website,
    content.intro,
    ...content.sections.flatMap((section) => [section.title, section.content]),
  ].filter(Boolean).join("\n\n");
}

function extractCvContact(text: string) {
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? "";
  const phone = text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{3,4}/)?.[0]?.trim() ?? "";
  const urls = text.match(/https?:\/\/[^\s<>]+|(?:www\.)[^\s<>]+/gi) ?? [];
  const website = urls.find((url) => !/linkedin\.com|mailto:|jobs?\./i.test(url))?.replace(/[),.;]+$/, "") ?? "";
  return { email, phone, website };
}

function documentVersionRowToRecord(row: typeof documentVersions.$inferSelect): DocumentVersionRecord {
  let rawContent: unknown = {};
  let rawChanges: unknown = [];
  let rawDecisions: unknown = {};
  try { rawContent = JSON.parse(row.contentJson || "{}"); } catch { /* Preserve a readable empty version if legacy JSON is damaged. */ }
  try { rawChanges = JSON.parse(row.proposalChanges || "[]"); } catch { /* Legacy versions have no proposal history. */ }
  try { rawDecisions = JSON.parse(row.proposalDecisions || "{}"); } catch { /* Legacy versions have no proposal history. */ }
  const parsedContent = cvDocumentContentSchema.safeParse(rawContent);
  const parsedChanges = cvChangeProposalSchema.array().safeParse(rawChanges);
  const proposalDecisions = rawDecisions && typeof rawDecisions === "object" && !Array.isArray(rawDecisions)
    ? Object.fromEntries(Object.entries(rawDecisions).filter((entry): entry is [string, "accepted" | "rejected"] => entry[1] === "accepted" || entry[1] === "rejected"))
    : {};
  return {
    id: row.id,
    documentId: row.documentId,
    jobPostingId: row.jobPostingId ?? null,
    parentVersionId: row.parentVersionId ?? null,
    version: row.version,
    relativePath: row.relativePath,
    checksum: row.checksum,
    checkpointName: row.checkpointName,
    submittedAt: row.submittedAt ?? null,
    content: parsedContent.success ? normaliseCvContent(parsedContent.data) : { name: "", headline: "", sections: [] },
    plainText: row.plainText,
    acceptedChangeIds: parseArray(row.acceptedChangeIds),
    proposalChanges: parsedChanges.success ? parsedChanges.data : [],
    proposalDecisions,
    changeSummary: row.changeSummary,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  };
}

function studioDocument(document: typeof documents.$inferSelect, jobPostingId: string, profile: ProfileRecord): ApplicationStudioDocument {
  const source = sourceDocumentForProfileDocument(document.id);
  const linkedEvidenceIds = new Set(
    source
      ? db.select().from(fieldEvidence).where(eq(fieldEvidence.sourceDocumentId, source.id)).all()
        .filter((item) => item.entityType === "ProfileEvidence")
        .map((item) => item.entityId)
      : [],
  );
  const linkedSections = profile.sections.filter((section) => linkedEvidenceIds.has(section.id));
  const sections = linkedSections.length
    ? linkedSections.map((section) => ({
      id: section.id,
      evidenceType: section.evidenceType,
      title: section.title,
      content: section.content,
      sourceEvidenceIds: [section.id],
    }))
    : source?.rawText
      ? [{ id: `source:${source.id}`, evidenceType: "other" as const, title: "Imported CV", content: source.rawText.slice(0, 20_000), sourceEvidenceIds: [source.id] }]
      : [];
  const versions = db.select().from(documentVersions).where(eq(documentVersions.documentId, document.id)).all()
    .filter((version) => !version.deletedAt && version.jobPostingId === jobPostingId)
    .sort((a, b) => b.version - a.version)
    .map(documentVersionRowToRecord);
  const draft = db.select().from(documentDrafts).where(eq(documentDrafts.documentId, document.id)).all()
    .find((item) => !item.deletedAt && item.jobPostingId === jobPostingId) ?? null;
  let draftContent: CvDocumentContent | null = null;
  let draftProposalState = cvProposalStateSchema.parse({ turns: [], activeTurnId: null });
  if (draft) {
    try {
      const parsedDraft = cvDocumentContentSchema.safeParse(JSON.parse(draft.contentJson));
      if (parsedDraft.success) draftContent = normaliseCvContent(parsedDraft.data);
    } catch { /* A damaged draft never prevents the saved CV from opening. */ }
    try {
      const parsedState = cvProposalStateSchema.safeParse(JSON.parse(draft.proposalStateJson));
      if (parsedState.success) draftProposalState = parsedState.data;
    } catch { /* A damaged proposal history never prevents the saved CV from opening. */ }
  }
  const candidateText = versions[0]?.plainText || linkedSections.map((section) => section.content).join("\n") || source?.rawText || "";
  const qualityWarning = extractionWarning(candidateText, document.mimeType.includes("pdf") ? "PDF" : "CV");
  return {
    document: documentRowToRecord(document as unknown as Record<string, unknown>),
    sourceDocumentId: source?.id ?? null,
    usable: !qualityWarning,
    qualityWarning,
    baseContent: normaliseCvContent({
      name: profile.name,
      headline: profile.headline,
      intro: profile.summary || profile.headline,
      contact: extractCvContact(source?.rawText ?? candidateText),
      style: { fontFamily: "manrope", fontSize: 10.5, sectionSpacing: 12, entrySpacing: 3, headerSpacing: 4, lineHeight: 1.38, nameAlignment: "center" },
      inlineFormatting: [],
      sections,
    }),
    draftContent,
    draftProposalState,
    draftUpdatedAt: draft?.updatedAt ?? null,
    draftRevision: draft?.revision ?? null,
    versions,
  };
}

function getApplicationStudioWorkspace(jobPostingId: string): ApplicationStudioWorkspace | null {
  const job = getJobDetail(jobPostingId);
  if (!job) return null;
  const profile = getProfileRecord();
  const cvDocuments = db.select().from(documents).all()
    .filter((document) => !document.deletedAt && document.documentType === "cv")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    job,
    profile,
    documents: cvDocuments.map((document) => studioDocument(document, jobPostingId, profile)),
  };
}

function getCareerStudioWorkspace(): CareerStudioWorkspace {
  const profile = getProfileRecord();
  const cvDocuments = db.select().from(documents).all().filter((document) => !document.deletedAt && document.documentType === "cv");
  const allVersions = db.select().from(documentVersions).all().filter((version) => !version.deletedAt).map(documentVersionRowToRecord);
  const allDrafts = db.select().from(documentDrafts).all().filter((draft) => !draft.deletedAt);
  const roles = listRows().map((job) => {
    const versions = allVersions.filter((version) => version.jobPostingId === job.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const drafts = allDrafts.filter((draft) => draft.jobPostingId === job.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const baseDocumentId = versions[0]?.documentId ?? drafts[0]?.documentId ?? cvDocuments[0]?.id ?? null;
    return {
      jobPostingId: job.id,
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      applicationStatus: job.applicationStatus ?? "Untracked",
      latestVersion: versions[0] ?? null,
      versionCount: versions.length,
      baseDocumentId,
      baseDocumentTitle: cvDocuments.find((document) => document.id === baseDocumentId)?.title ?? "",
      draftUpdatedAt: drafts[0]?.updatedAt ?? null,
    };
  });
  return {
    profile,
    roles,
    documents: cvDocuments.map((document) => {
      const versions = allVersions.filter((version) => version.documentId === document.id);
      return {
        document: documentRowToRecord(document as unknown as Record<string, unknown>),
        versionCount: versions.length,
        roleCount: new Set(versions.flatMap((version) => version.jobPostingId ? [version.jobPostingId] : [])).size,
        latestUpdatedAt: versions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt ?? document.updatedAt,
      };
    }),
  };
}

function hostedVersionRecord(version: DocumentVersionSnapshot): DocumentVersionRecord {
  return {
    ...version,
    content: normaliseCvContent(version.content),
    proposalDecisions: Object.fromEntries(Object.entries(version.proposalDecisions).filter((entry): entry is [string, "accepted" | "rejected"] => entry[1] === "accepted" || entry[1] === "rejected")),
  };
}

async function ensureHostedProfile(context: ReturnType<typeof trackerContext>): Promise<ProfileRecord> {
  if (!postgresApplicationStudio || runtimeDataProvider.name !== "postgres") throw new Error("Hosted profile storage is unavailable.");
  const existing = await postgresApplicationStudio.getProfile(context);
  if (existing) return existing;
  await runtimeDataProvider.postgres.transaction(context, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`profile:${context.workspaceId}`]);
    const current = await tx.query<{ id: string }>("SELECT id FROM profiles WHERE workspace_id=$1 AND deleted_at IS NULL LIMIT 1", [context.workspaceId]);
    if (current.rows[0]) return;
    const id = randomUUID();
    await tx.query(`INSERT INTO profiles(id,workspace_id,name,headline,summary)
      VALUES($1,$2,'Zain Ahmad','Imperial College London Design Engineering graduate',
      'Interdisciplinary design engineer exploring finance, quantitative finance, big tech, software, startups, and founder work.')
      `, [id, context.workspaceId]);
    await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
      VALUES($1,$2,$3,'profile.created','Profile',$4,'Created the workspace career profile','{}'::jsonb)`,
    [randomUUID(), context.workspaceId, context.userId, id]);
  });
  const created = await postgresApplicationStudio.getProfile(context);
  if (!created) throw new Error("Hosted profile could not be created.");
  return created;
}

async function hostedDocumentSource(context: ReturnType<typeof trackerContext>, documentId: string) {
  if (runtimeDataProvider.name !== "postgres") return null;
  return runtimeDataProvider.postgres.transaction(context, async (tx) => {
    const result = await tx.query<Record<string, unknown>>(`SELECT id,raw_text,metadata FROM source_documents
      WHERE workspace_id=$1 AND metadata->>'documentId'=$2 ORDER BY captured_at DESC LIMIT 1`, [context.workspaceId, documentId]);
    const row = result.rows[0];
    if (!row) return null;
    return { id: String(row.id), rawText: String(row.raw_text ?? ""), metadata: row.metadata as Record<string, unknown> };
  }, { readOnly: true });
}

async function hostedStudioDocument(context: ReturnType<typeof trackerContext>, document: ProfileDocumentRecord, jobPostingId: string, profile: ProfileRecord): Promise<ApplicationStudioDocument> {
  if (!postgresApplicationStudio) throw new Error("Hosted Application Studio storage is unavailable.");
  const [source, versions, draft] = await Promise.all([
    hostedDocumentSource(context, document.id),
    postgresApplicationStudio.listVersions(context, document.id, jobPostingId),
    postgresApplicationStudio.loadDraft(context, document.id, jobPostingId),
  ]);
  const sourceSections = source?.rawText
    ? [{ id: `source:${source.id}`, evidenceType: "other" as const, title: "Imported CV", content: source.rawText.slice(0, 20_000), sourceEvidenceIds: [source.id] }]
    : profile.sections.map((section) => ({ id: section.id, evidenceType: section.evidenceType, title: section.title, content: section.content, sourceEvidenceIds: [section.id] }));
  const savedVersions = versions.map(hostedVersionRecord);
  const candidateText = savedVersions[0]?.plainText || source?.rawText || sourceSections.map((section) => section.content).join("\n");
  const warning = extractionWarning(candidateText, document.mimeType.includes("pdf") ? "PDF" : "CV");
  return {
    document,
    sourceDocumentId: source?.id ?? null,
    usable: !warning,
    qualityWarning: warning,
    baseContent: normaliseCvContent({
      name: profile.name,
      headline: profile.headline,
      intro: profile.summary || profile.headline,
      contact: extractCvContact(source?.rawText ?? candidateText),
      style: { fontFamily: "manrope", fontSize: 10.5, sectionSpacing: 12, entrySpacing: 3, headerSpacing: 4, lineHeight: 1.38, nameAlignment: "center" },
      inlineFormatting: [],
      sections: sourceSections,
    }),
    draftContent: draft ? normaliseCvContent(draft.content) : null,
    draftProposalState: draft?.proposalState ?? cvProposalStateSchema.parse({ turns: [], activeTurnId: null }),
    draftUpdatedAt: draft?.updatedAt ?? null,
    draftRevision: draft?.revision ?? null,
    versions: savedVersions,
  };
}

async function getHostedApplicationStudioWorkspace(request: Parameters<HostedAuthService["requireSession"]>[0], jobPostingId: string): Promise<ApplicationStudioWorkspace | null> {
  if (!postgresApplicationStudio) return null;
  const context = trackerContext(request);
  const job = await getRuntimeJobDetail(request, jobPostingId);
  if (!job) return null;
  const profile = await ensureHostedProfile(context);
  const documents = await postgresApplicationStudio.listDocuments(context, "cv");
  return { job: job as ApplicationStudioWorkspace["job"], profile, documents: await Promise.all(documents.map((document) => hostedStudioDocument(context, document, jobPostingId, profile))) };
}

async function getHostedCareerStudioWorkspace(request: Parameters<HostedAuthService["requireSession"]>[0]): Promise<CareerStudioWorkspace> {
  if (!postgresApplicationStudio) throw new Error("Hosted Application Studio storage is unavailable.");
  const context = trackerContext(request);
  const [profile, documents, jobs] = await Promise.all([
    ensureHostedProfile(context),
    postgresApplicationStudio.listDocuments(context, "cv"),
    trackerRepository.listJobs(context),
  ]);
  const documentVersions = new Map<string, DocumentVersionRecord[]>();
  for (const document of documents) documentVersions.set(document.id, (await postgresApplicationStudio.listVersions(context, document.id)).map(hostedVersionRecord));
  const roles = await Promise.all(jobs.map(async (job) => {
    const candidates = documents.flatMap((document) => (documentVersions.get(document.id) ?? []).filter((version) => version.jobPostingId === job.id));
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let latestDraft: { documentId: string; updatedAt: string } | null = null;
    for (const document of documents) {
      const draft = await postgresApplicationStudio.loadDraft(context, document.id, String(job.id));
      if (draft && (!latestDraft || draft.updatedAt > latestDraft.updatedAt)) latestDraft = { documentId: document.id, updatedAt: draft.updatedAt };
    }
    const baseDocumentId = candidates[0]?.documentId ?? latestDraft?.documentId ?? documents[0]?.id ?? null;
    return {
      jobPostingId: String(job.id), title: String(job.title), companyName: String(job.companyName), location: String(job.location ?? ""),
      applicationStatus: String(job.applicationStatus ?? "Untracked"), latestVersion: candidates[0] ?? null, versionCount: candidates.length,
      baseDocumentId, baseDocumentTitle: documents.find((document) => document.id === baseDocumentId)?.title ?? "", draftUpdatedAt: latestDraft?.updatedAt ?? null,
    };
  }));
  return {
    profile,
    roles,
    documents: documents.map((document) => {
      const versions = documentVersions.get(document.id) ?? [];
      return { document, versionCount: versions.length, roleCount: new Set(versions.flatMap((version) => version.jobPostingId ? [version.jobPostingId] : [])).size, latestUpdatedAt: versions[0]?.updatedAt ?? document.updatedAt };
    }),
  };
}

function decodeXmlEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractDocxEntry(buffer: Buffer, targetName: string) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66_000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return null;
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset < end && buffer.readUInt32LE(offset) === 0x02014b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    if (name === targetName) {
      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return data;
      if (compressionMethod === 8) return inflateRawSync(data);
      return null;
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return null;
}

function extractDocxText(buffer: Buffer) {
  const parts = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"].flatMap((entry) => {
    const xmlBuffer = extractDocxEntry(buffer, entry);
    if (!xmlBuffer) return [];
    const xml = xmlBuffer.toString("utf8")
      .replace(/<w:tab[^>]*\/>/g, " ")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    return [decodeXmlEntities(xml)];
  });
  return cleanExtractedText(parts.join("\n"));
}

function decodePdfLiteralString(value: string) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = value[++index];
    if (!next) continue;
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(value[index + 1] ?? ""); count += 1) octal += value[++index];
      output += String.fromCharCode(parseInt(octal, 8));
    } else {
      output += next;
    }
  }
  return output;
}

function decodePdfHexString(value: string) {
  const hex = value.replace(/\s+/g, "");
  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
  if (bytes.length > 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) output += String.fromCharCode(bytes.readUInt16BE(index));
    return output;
  }
  return bytes.toString("utf8");
}

function extractPdfStrings(content: string) {
  const chunks: string[] = [];
  const literalRegex = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  const arrayRegex = /\[((?:.|\n|\r)*?)\]\s*TJ/g;
  const hexRegex = /<([0-9A-Fa-f\s]{4,})>\s*Tj/g;
  for (const match of content.matchAll(literalRegex)) chunks.push(decodePdfLiteralString(match[0].replace(/\)\s*Tj$/, "").slice(1)));
  for (const match of content.matchAll(arrayRegex)) {
    const item = match[1];
    const literals = [...item.matchAll(/\((?:\\.|[^\\)])*\)/g)].map((literal) => decodePdfLiteralString(literal[0].slice(1, -1)));
    if (literals.length) chunks.push(literals.join(""));
  }
  for (const match of content.matchAll(hexRegex)) chunks.push(decodePdfHexString(match[1]));
  return chunks.join("\n");
}

function extractPdfText(buffer: Buffer) {
  const latin1 = buffer.toString("latin1");
  const chunks: string[] = [];
  const streamRegex = /(<<[\s\S]*?>>)\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  for (const match of latin1.matchAll(streamRegex)) {
    const dict = match[1];
    let stream = Buffer.from(match[2], "latin1");
    if (dict.includes("FlateDecode")) {
      try {
        stream = inflateSync(stream);
      } catch {
        try {
          stream = inflateRawSync(stream);
        } catch {
          continue;
        }
      }
    }
    const extracted = extractPdfStrings(stream.toString("latin1"));
    if (extracted) chunks.push(extracted);
  }
  return cleanExtractedText(chunks.join("\n"));
}

function extractPdfTextWithPdftotext(absolutePath?: string) {
  if (!absolutePath) return "";
  try {
    return cleanExtractedText(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", absolutePath, "-"], {
      encoding: "utf8",
      maxBuffer: 20_000_000,
      timeout: 15_000,
    }));
  } catch {
    return "";
  }
}

function extractRtfText(buffer: Buffer) {
  return cleanExtractedText(buffer.toString("utf8")
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\'[0-9a-fA-F]{2}/g, " ")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, ""));
}

function extractTextFromDocument(buffer: Buffer, fileName: string, mimeType: string, absolutePath?: string): TextExtractionResult {
  const extension = extname(fileName).toLowerCase();
  if (mimeType.includes("pdf") || extension === ".pdf") {
    const externalText = extractPdfTextWithPdftotext(absolutePath);
    const externalWarning = extractionWarning(externalText, "PDF");
    if (externalText && !externalWarning) return { text: externalText, method: "pdf_pdftotext", warning: null };

    const basicText = extractPdfText(buffer);
    const basicWarning = extractionWarning(basicText, "PDF");
    if (externalText && externalText.length > basicText.length) {
      return { text: externalText, method: "pdf_pdftotext", warning: externalWarning };
    }
    return { text: basicText, method: "pdf_basic", warning: basicWarning };
  }
  if (mimeType.includes("officedocument.wordprocessingml.document") || extension === ".docx") {
    const text = extractDocxText(buffer);
    return { text, method: "docx", warning: extractionWarning(text, "DOCX") };
  }
  if (mimeType.includes("rtf") || extension === ".rtf") {
    const text = extractRtfText(buffer);
    return { text, method: "rtf", warning: extractionWarning(text, "RTF") };
  }
  if (mimeType.startsWith("text/") || [".txt", ".md", ".markdown"].includes(extension)) {
    return { text: cleanExtractedText(buffer.toString("utf8")), method: "text", warning: null };
  }
  const text = cleanExtractedText(buffer.toString("utf8"));
  return { text, method: "unknown", warning: extractionWarning(text, "file") };
}

function inferProfileSectionType(heading: string): ProfileSectionType {
  const normalized = heading.toLowerCase();
  if (normalized.includes("education")) return "education";
  if (normalized.includes("experience") || normalized.includes("employment") || normalized.includes("work")) return "experience";
  if (normalized.includes("project") || normalized.includes("portfolio")) return "project";
  if (normalized.includes("skill") || normalized.includes("tools") || normalized.includes("technical")) return "skill";
  if (normalized.includes("award") || normalized.includes("achievement") || normalized.includes("honour")) return "achievement";
  if (normalized.includes("interest") || normalized.includes("target") || normalized.includes("preference")) return "preference";
  return "other";
}

function looksLikeProfileHeading(line: string) {
  const normalized = line.trim().toLowerCase();
  return /^(education|experience|work experience|employment|projects?|portfolio|skills?|technical skills?|achievements?|awards?|honours?|interests?|preferences?|profile|summary)$/i.test(normalized)
    || (line.length < 34 && line === line.toUpperCase() && /[A-Z]/.test(line));
}

function deterministicProfileDraft(text: string, documentType: string): ProfileExtractionDraft {
  const clean = cleanExtractedText(text);
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  const name = lines.find((line) => /^[A-Za-z][A-Za-z .'-]{3,80}$/.test(line) && !/curriculum|vitae|resume|portfolio|email|phone|linkedin/i.test(line)) ?? "";
  const headline = lines.find((line) => line !== name && line.length >= 12 && line.length <= 180 && !line.includes("@") && !/^https?:/i.test(line)) ?? "";
  const sections: ProfileExtractionDraft["sections"] = [];
  let currentTitle = documentType === "portfolio" ? "Imported portfolio evidence" : "Imported CV evidence";
  let currentType: ProfileSectionType = documentType === "portfolio" ? "project" : "other";
  let currentLines: string[] = [];
  const flush = () => {
    const content = cleanExtractedText(currentLines.join("\n"));
    if (!content) return;
    sections.push({
      evidenceType: currentType,
      title: currentTitle,
      content: content.slice(0, 4_500),
      sourceExcerpt: content.slice(0, 1_000),
      confidence: 0.45,
    });
  };
  for (const line of lines.slice(name ? 1 : 0)) {
    if (looksLikeProfileHeading(line)) {
      flush();
      currentTitle = line.replace(/:$/, "");
      currentType = inferProfileSectionType(line);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  if (!sections.length && clean) {
    sections.push({
      evidenceType: documentType === "portfolio" ? "project" : "other",
      title: documentType === "portfolio" ? "Imported portfolio evidence" : "Imported CV evidence",
      content: clean.slice(0, 4_500),
      sourceExcerpt: clean.slice(0, 1_000),
      confidence: 0.35,
    });
  }
  return {
    profilePatch: {
      name,
      headline,
      summary: clean.slice(0, 700),
    },
    sections: sections.slice(0, 24),
  };
}

app.get("/health", async (_request, reply) => {
  try {
    if (runtimeDataProvider.name === "postgres") {
      await runtimeDataProvider.postgres.administrativeTransaction(async (tx) => { await tx.query("SELECT 1"); });
    } else {
      sqlite.prepare("SELECT 1").get();
    }
    return { ok: true, service: "careeros-api", dataProvider: runtimeDataProvider.name, time: now() };
  } catch {
    return reply.code(503).send({ ok: false, service: "careeros-api", dataProvider: runtimeDataProvider.name, time: now() });
  }
});

app.get("/api/system/health", async (request) => {
  if (runtimeDataProvider.name === "postgres") {
    const auth = hostedAuth.config();
    const context = trackerContext(request);
    const health = await runtimeDataProvider.postgres.transaction(context, async (tx) => {
      const [capture, discovery, deliveries, backup, telegram] = await Promise.all([
        tx.query<{ state: string; count: number }>(`SELECT state,count(*)::int AS count FROM capture_queue_items
          WHERE workspace_id=$1 AND deleted_at IS NULL GROUP BY state`, [context.workspaceId]),
        tx.query<{ enabled_sources: number; unhealthy_sources: number; last_successful_at: string | null }>(`SELECT
          count(*) FILTER (WHERE enabled AND deleted_at IS NULL)::int AS enabled_sources,
          count(*) FILTER (WHERE enabled AND deleted_at IS NULL AND (
            last_error<>'' OR last_successful_at IS NULL OR
            last_successful_at + check_interval_minutes * interval '2 minutes' < now()
          ))::int AS unhealthy_sources,
          max(last_successful_at)::text AS last_successful_at
          FROM discovery_sources WHERE workspace_id=$1`, [context.workspaceId]),
        tx.query<{ pending: number; failed: number }>(`SELECT
          count(*) FILTER (WHERE state IN ('Pending','Retrying'))::int AS pending,
          count(*) FILTER (WHERE state='Failed')::int AS failed
          FROM notification_deliveries WHERE workspace_id=$1`, [context.workspaceId]),
        tx.query<{ last_successful_at: string | null }>(`SELECT max(created_at)::text AS last_successful_at FROM audit_events
          WHERE workspace_id=$1 AND action='workspace.exported'`, [context.workspaceId]),
        tx.query<{ configured: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM telegram_integrations WHERE workspace_id=$1
        ) AS configured`, [context.workspaceId]),
      ]);
      const counts = new Map(capture.rows.map((row) => [row.state, Number(row.count)]));
      return {
        capture: {
          active: (counts.get("Queued") ?? 0) + (counts.get("Extracting") ?? 0),
          needsReview: (counts.get("Needs Review") ?? 0) + (counts.get("Duplicate") ?? 0),
          failed: counts.get("Failed") ?? 0,
          blocked: counts.get("Blocked") ?? 0,
          lastError: postgresCaptureWorker?.status().lastFailure?.message ?? "",
          lastErrorAt: postgresCaptureWorker?.status().lastFailure?.at ?? null,
          lastSuccessfulAt: postgresCaptureWorker?.status().lastSuccessfulPumpAt ?? null,
        },
        discovery: {
          enabledSources: Number(discovery.rows[0]?.enabled_sources ?? 0),
          unhealthySources: Number(discovery.rows[0]?.unhealthy_sources ?? 0),
          lastSuccessfulAt: discovery.rows[0]?.last_successful_at ?? null,
        },
        notifications: {
          configured: Boolean(telegram.rows[0]?.configured),
          pending: Number(deliveries.rows[0]?.pending ?? 0),
          failed: Number(deliveries.rows[0]?.failed ?? 0),
        },
        backups: {
          provider: configuredBackupStorage.provider,
          configured: Boolean(hostedBackupService),
          running: hostedBackupService?.status().running ?? false,
          lastSuccessfulAt: hostedBackupService?.status().lastSuccessfulAt ?? backup.rows[0]?.last_successful_at ?? null,
          lastError: hostedBackupService?.status().lastError ?? (hostedBackupService ? "" : "Backup encryption key is not configured."),
        },
      };
    }, { readOnly: true });
    return {
      ...health,
      collaboration: { hosted: auth.hosted, realtimeEnabled: auth.realtimeEnabled },
    };
  }
  const queue = await captureQueue.summary();
  const discovery = sqlite.prepare(`SELECT
    SUM(CASE WHEN enabled=1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS enabledSources,
    SUM(CASE WHEN enabled=1 AND deleted_at IS NULL AND (last_error<>'' OR (last_checked_at IS NOT NULL AND successful_inventory_count=0)) THEN 1 ELSE 0 END) AS unhealthySources,
    MAX(last_successful_at) AS lastSuccessfulAt
    FROM discovery_sources`).get() as { enabledSources: number | null; unhealthySources: number | null; lastSuccessfulAt: string | null };
  const deliveries = sqlite.prepare(`SELECT
    SUM(CASE WHEN state='Pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN state='Failed' THEN 1 ELSE 0 END) AS failed
    FROM notification_deliveries`).get() as { pending: number | null; failed: number | null };
  const auth = hostedAuth.config();
  return {
    capture: {
      active: queue.pending,
      needsReview: queue.counts["Needs Review"] + queue.counts.Duplicate,
      failed: queue.counts.Failed,
      blocked: queue.counts.Blocked,
      lastError: "",
      lastErrorAt: null,
      lastSuccessfulAt: null,
    },
    discovery: {
      enabledSources: Number(discovery.enabledSources ?? 0),
      unhealthySources: Number(discovery.unhealthySources ?? 0),
      lastSuccessfulAt: discovery.lastSuccessfulAt,
    },
    notifications: {
      configured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
      pending: Number(deliveries.pending ?? 0),
      failed: Number(deliveries.failed ?? 0),
    },
    collaboration: { hosted: auth.hosted, realtimeEnabled: auth.realtimeEnabled },
    backups: {
      provider: configuredBackupStorage.provider,
      ...(backupScheduler?.status() ?? { configured: false, running: false, lastSuccessfulAt: null, lastError: "Backup encryption key is not configured." }),
    },
  };
});

app.get("/api/jobs", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  const rows = await trackerRepository.listJobs(trackerContext(request), query);
  return { jobs: rows.map((row, index) => rowToJob(row, index + 1)) };
});

app.get("/api/jobs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const detail = await getRuntimeJobDetail(request, id);
  if (!detail) return reply.code(404).send({ error: "Job posting not found." });
  return detail;
});

app.get("/api/profile", async (request) => runtimeDataProvider.name === "postgres" ? ensureHostedProfile(trackerContext(request)) : getProfileRecord());

app.get("/api/career-studio", async (request) => runtimeDataProvider.name === "postgres" ? getHostedCareerStudioWorkspace(request) : getCareerStudioWorkspace());

app.get("/api/profile/documents/:id/preview", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (postgresApplicationStudio) {
    const context = trackerContext(request);
    const document = await postgresApplicationStudio.getDocument(context, id);
    if (!document) return reply.code(404).send({ error: "Document not found." });
    const source = await hostedDocumentSource(context, id);
    const extractionWarning = typeof source?.metadata.extractionWarning === "string" ? source.metadata.extractionWarning : null;
    return { document, extractedText: source?.rawText ?? "", extractionWarning } satisfies ProfileDocumentPreview;
  }
  const document = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!document || document.deletedAt) return reply.code(404).send({ error: "Document not found." });
  const source = sourceDocumentForProfileDocument(id);
  let extractionWarning: string | null = null;
  if (source) {
    try { extractionWarning = JSON.parse(source.metadata || "{}").extractionWarning ?? null; }
    catch { /* Legacy source metadata may be empty. */ }
  }
  const preview: ProfileDocumentPreview = {
    document: documentRowToRecord(document as unknown as Record<string, unknown>),
    extractedText: source?.rawText ?? "",
    extractionWarning,
  };
  return preview;
});

app.get("/api/profile/documents/:id/file", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (postgresApplicationStudio) {
    const context = trackerContext(request);
    const document = await postgresApplicationStudio.getDocument(context, id);
    if (!document || !document.relativePath) return reply.code(404).send({ error: "Original document file not found." });
    try {
      const stored = await configuredStorage.adapter.read({ workspaceId: context.workspaceId, path: document.relativePath, expectedChecksum: document.checksum });
      reply.header("content-type", document.mimeType || "application/octet-stream");
      reply.header("content-disposition", `inline; filename="${basename(document.relativePath).replaceAll('"', "")}"`);
      return reply.send(Buffer.from(stored.bytes));
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Original document file could not be read." });
    }
  }
  const document = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!document || document.deletedAt || !document.relativePath) return reply.code(404).send({ error: "Original document file not found." });
  try {
    const bytes = await readStoredBytes(document.relativePath, document.checksum);
    reply.header("content-type", document.mimeType || "application/octet-stream");
    reply.header("content-disposition", `inline; filename="${basename(document.relativePath).replaceAll('"', "")}"`);
    return reply.send(bytes);
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 502;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Original document file could not be read." });
  }
});

app.get("/api/jobs/:id/application-studio", async (request, reply) => {
  const { id } = request.params as { id: string };
  const workspace = runtimeDataProvider.name === "postgres" ? await getHostedApplicationStudioWorkspace(request, id) : getApplicationStudioWorkspace(id);
  if (!workspace) return reply.code(404).send({ error: "Job posting not found." });
  return workspace;
});

app.put("/api/jobs/:id/document-drafts", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  const parsed = cvDraftSaveSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The CV draft is incomplete." });
  if (postgresApplicationStudio) {
    const result = await postgresApplicationStudio.upsertDraft(trackerContext(request), {
      documentId: parsed.data.documentId,
      jobPostingId,
      content: normaliseCvContent(parsed.data.content),
      proposalState: parsed.data.proposalState,
      expectedRevision: parsed.data.expectedRevision,
    });
    if (result.status === "not_found") return reply.code(404).send({ error: "Job posting or base CV not found." });
    if (result.status === "conflict") return reply.code(409).send({ error: "This CV changed in another session. Reopen it before saving so no edits are silently overwritten.", currentRevision: result.currentRevision });
    return { updatedAt: result.record.updatedAt, revision: result.record.revision };
  }
  const job = db.select().from(jobPostings).where(eq(jobPostings.id, jobPostingId)).get();
  const document = db.select().from(documents).where(eq(documents.id, parsed.data.documentId)).get();
  if (!job || job.deletedAt) return reply.code(404).send({ error: "Job posting not found." });
  if (!document || document.deletedAt || document.documentType !== "cv") return reply.code(404).send({ error: "Base CV not found." });
  const timestamp = now();
  const content = normaliseCvContent(parsed.data.content);
  const existing = db.select().from(documentDrafts).where(eq(documentDrafts.documentId, document.id)).all()
    .find((draft) => draft.jobPostingId === jobPostingId);
  if (existing) {
    if (parsed.data.expectedRevision !== existing.revision) return reply.code(409).send({ error: "This CV changed in another session. Reopen it before saving so no edits are silently overwritten." });
    const result = sqlite.prepare("UPDATE document_drafts SET content_json=?,proposal_state_json=?,updated_at=?,deleted_at=NULL,revision=revision+1 WHERE id=? AND revision=?").run(JSON.stringify(content), JSON.stringify(parsed.data.proposalState), timestamp, existing.id, existing.revision);
    if (result.changes !== 1) return reply.code(409).send({ error: "This CV changed while it was being saved. Reopen it to merge the latest edits." });
    return { updatedAt: timestamp, revision: existing.revision + 1 };
  } else {
    if (parsed.data.expectedRevision !== null) return reply.code(409).send({ error: "This CV draft was removed or replaced. Reopen it before saving." });
    db.insert(documentDrafts).values({ id: randomUUID(), documentId: document.id, jobPostingId, contentJson: JSON.stringify(content), proposalStateJson: JSON.stringify(parsed.data.proposalState), createdAt: timestamp, updatedAt: timestamp, revision: 1 }).run();
    return { updatedAt: timestamp, revision: 1 };
  }
});

app.post("/api/jobs/:id/cv-tailoring", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  const parsed = cvTailoringRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Choose a base CV before tailoring." });
  const workspace = runtimeDataProvider.name === "postgres" ? await getHostedApplicationStudioWorkspace(request, jobPostingId) : getApplicationStudioWorkspace(jobPostingId);
  if (!workspace) return reply.code(404).send({ error: "Job posting not found." });
  const selected = workspace.documents.find((item) => item.document.id === parsed.data.documentId);
  if (!selected) return reply.code(404).send({ error: "That imported CV could not be found." });
  if (!selected.usable) return reply.code(422).send({ error: selected.qualityWarning ?? "This CV needs to be re-imported before tailoring." });
  if (!aiProvider.configured || !aiProvider.adaptCv) {
    return reply.code(503).send({ error: "AI CV tailoring is not configured. Start CareerOS with the AI key enabled." });
  }
  const latestVersion = selected.versions[0] ?? null;
  const baseContent = normaliseCvContent(parsed.data.baseContent ?? selected.draftContent ?? latestVersion?.content ?? selected.baseContent);
  if (!baseContent.sections.length) return reply.code(422).send({ error: "This CV has no usable evidence sections. Re-import it in Career Studio first." });
  const source = runtimeDataProvider.name === "postgres"
    ? await hostedDocumentSource(trackerContext(request), selected.document.id)
    : selected.sourceDocumentId
      ? db.select().from(sourceDocuments).where(eq(sourceDocuments.id, selected.sourceDocumentId)).get()
      : null;
  const evidenceContext = workspace.profile.sections.map((section) => ({
    id: section.id,
    evidenceType: section.evidenceType,
    title: section.title,
    content: section.content,
  }));
  if (source && !evidenceContext.some((item) => item.id === source.id)) {
    evidenceContext.push({ id: source.id, evidenceType: "other", title: selected.document.title, content: source.rawText.slice(0, 20_000) });
  }
  const startedAt = Date.now();
  try {
    const tailored = await aiProvider.adaptCv({
      jobPostingId,
      documentId: selected.document.id,
      baseVersionId: latestVersion?.id ?? null,
      job: workspace.job,
      baseContent,
      profileEvidence: evidenceContext,
      instructions: parsed.data.instructions,
    });
    const durationMs = Date.now() - startedAt;
    const proposal = cvTailoringProposalSchema.parse({
      ...tailored,
      jobPostingId,
      documentId: selected.document.id,
      baseVersionId: latestVersion?.id ?? null,
      generatedAt: now(),
      durationMs,
    });
    await recordHostedAiRun(trackerContext(request), {
      operation: "cv_tailoring",
      contextId: jobPostingId,
      sourceType: "profile_evidence",
      state: "completed",
      provider: proposal.provider,
      model: proposal.model,
      durationMs,
      totalDurationMs: durationMs,
      evidenceCount: new Set(proposal.changes.flatMap((change) => change.evidenceIds)).size,
      warning: proposal.gaps.length ? `${proposal.gaps.length} unsupported requirement gap${proposal.gaps.length === 1 ? "" : "s"}.` : "",
    });
    return proposal;
  } catch (error) {
    const message = error instanceof Error ? error.message : "CV tailoring failed.";
    await recordHostedAiRun(trackerContext(request), {
      operation: "cv_tailoring",
      contextId: jobPostingId,
      sourceType: "profile_evidence",
      state: "fallback",
      provider: aiProvider.name,
      model: aiProvider.model,
      durationMs: Date.now() - startedAt,
      totalDurationMs: Date.now() - startedAt,
      evidenceCount: 0,
      warning: message,
    });
    return reply.code(422).send({ error: message });
  }
});

app.post("/api/jobs/:id/document-versions", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  const parsed = documentVersionCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The CV version is incomplete." });
  if (postgresApplicationStudio) {
    const content = normaliseCvContent(parsed.data.content);
    const result = await postgresApplicationStudio.createVersionSnapshot(trackerContext(request), {
      documentId: parsed.data.documentId,
      jobPostingId,
      parentVersionId: parsed.data.parentVersionId,
      expectedDraftRevision: parsed.data.expectedDraftRevision,
      checkpointName: parsed.data.checkpointName,
      content,
      plainText: documentContentToText(content),
      checksum: contentHash(documentContentToText(content)),
      acceptedChangeIds: parsed.data.acceptedChangeIds,
      proposalChanges: parsed.data.proposalChanges,
      proposalDecisions: parsed.data.proposalDecisions,
      changeSummary: parsed.data.changeSummary,
      provider: parsed.data.provider,
      model: parsed.data.model,
    });
    if (result.status === "not_found") return reply.code(404).send({ error: "Job posting, base CV, or parent snapshot not found." });
    if (result.status === "conflict") return reply.code(409).send({ error: "This CV changed in another session. Reopen it before creating a snapshot so newer edits are preserved.", currentRevision: result.currentRevision });
    return reply.code(201).send(hostedVersionRecord(result.record));
  }
  const job = listRows().find((item) => item.id === jobPostingId);
  if (!job) return reply.code(404).send({ error: "Job posting not found." });
  const document = db.select().from(documents).where(eq(documents.id, parsed.data.documentId)).get();
  if (!document || document.deletedAt || document.documentType !== "cv") return reply.code(404).send({ error: "Base CV not found." });
  const existingVersions = db.select().from(documentVersions).where(eq(documentVersions.documentId, document.id)).all();
  if (parsed.data.parentVersionId && !existingVersions.some((version) => version.id === parsed.data.parentVersionId)) {
    return reply.code(400).send({ error: "The parent CV version does not belong to this document." });
  }
  const timestamp = now();
  const activeDraft = db.select().from(documentDrafts).where(eq(documentDrafts.documentId, document.id)).all()
    .find((draft) => draft.jobPostingId === jobPostingId);
  if (activeDraft ? parsed.data.expectedDraftRevision !== activeDraft.revision : parsed.data.expectedDraftRevision !== null) {
    return reply.code(409).send({ error: "This CV changed in another session. Reopen it before creating a snapshot so newer edits are preserved." });
  }
  const id = randomUUID();
  const version = Math.max(0, ...existingVersions.map((item) => item.version)) + 1;
  const normalisedContent = normaliseCvContent(parsed.data.content);
  const plainText = documentContentToText(normalisedContent);
  sqlite.transaction(() => {
    db.insert(documentVersions).values({
      id,
      documentId: document.id,
      jobPostingId,
      parentVersionId: parsed.data.parentVersionId,
      version,
      relativePath: "",
      checksum: contentHash(plainText),
      checkpointName: parsed.data.checkpointName,
      submittedAt: null,
      contentJson: JSON.stringify(normalisedContent),
      plainText,
      acceptedChangeIds: JSON.stringify(parsed.data.acceptedChangeIds),
      proposalChanges: JSON.stringify(parsed.data.proposalChanges),
      proposalDecisions: JSON.stringify(parsed.data.proposalDecisions),
      changeSummary: parsed.data.changeSummary,
      provider: parsed.data.provider,
      model: parsed.data.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    }).run();
  })();
  const saved = db.select().from(documentVersions).where(eq(documentVersions.id, id)).get()!;
  return reply.code(201).send(documentVersionRowToRecord(saved));
});

app.post("/api/document-versions/:id/pdf", async (request, reply) => {
  const versionId = (request.params as { id: string }).id;
  const parsed = documentVersionPdfExportSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The PDF page layout is incomplete." });
  if (postgresApplicationStudio && runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    let version = await postgresApplicationStudio.getVersion(context, versionId);
    if (!version) return reply.code(404).send({ error: "CV snapshot not found." });
    const submit = async () => {
      if (!parsed.data.markAsSubmitted || !parsed.data.applicationId) return;
      const result = await postgresApplicationStudio.markVersionSubmitted(context, versionId, parsed.data.applicationId);
      if (result.status === "not_found") throw Object.assign(new Error("The selected application or CV snapshot was not found."), { statusCode: 404 });
      if (result.status === "conflict") throw Object.assign(new Error("The selected application does not belong to this CV snapshot."), { statusCode: 409 });
      version = result.version;
    };
    const verify = async (candidate: DocumentVersionSnapshot) => {
      if (!candidate.relativePath || !candidate.checksum) throw Object.assign(new Error("The immutable PDF has not been stored yet."), { statusCode: 409 });
      await configuredStorage.adapter.read({ workspaceId: context.workspaceId, path: candidate.relativePath, expectedChecksum: candidate.checksum });
    };
    try {
      if (version.relativePath) {
        await verify(version);
        await submit();
        return hostedVersionRecord(version);
      }
      const content = normaliseCvContent(version.content);
      const versionRevision = version.revision;
      const relativePath = ["documents", version.documentId, "versions", `${version.id}.pdf`].join("/");
      const temporaryDirectory = join(dataDir, "tmp", "pdf");
      mkdirSync(temporaryDirectory, { recursive: true });
      const htmlPath = join(temporaryDirectory, `${version.id}.html`);
      const renderedPdfPath = join(temporaryDirectory, `${version.id}.pdf`);
      const lockPath = join(temporaryDirectory, `${version.id}.lock`);
      let lockDescriptor: number;
      try { lockDescriptor = openSync(lockPath, "wx"); }
      catch { return reply.code(409).send({ error: "This PDF is already being exported. Wait for it to finish." }); }
      try {
        writeFileSync(htmlPath, renderCvPdfHtml(content, parsed.data.pageSectionIds), "utf8");
        const bytes = await renderCvPdf(htmlPath, renderedPdfPath, {
          expectedPageCount: parsed.data.pageSectionIds.length,
          expectedTextFragments: [
            content.name, content.intro ?? "", content.contact?.email ?? "", content.contact?.phone ?? "", content.contact?.website ?? "",
            ...content.sections.flatMap((section) => [section.title, section.subtitle ?? "", section.date ?? "", section.location ?? "", ...section.content.split(/\r?\n/)]),
          ],
          expectedLinks: [
            ...(content.contact?.email ? [`mailto:${content.contact.email}`] : []),
            ...(content.contact?.phone ? [`tel:${content.contact.phone.replace(/\s+/g, "")}`] : []),
            ...(content.contact?.website ? [/^https?:\/\//i.test(content.contact.website) ? content.contact.website : `https://${content.contact.website}`] : []),
            ...content.sections.flatMap((section) => section.content.match(/https?:\/\/[^\s),.;!?]+/gi) ?? []),
          ],
        });
        const checksum = checksumBuffer(bytes);
        await configuredStorage.adapter.upload({ workspaceId: context.workspaceId, path: relativePath, bytes, contentType: "application/pdf" });
        const updated = await runtimeDataProvider.postgres.transaction(context, async (tx) => {
          const result = await tx.query<Record<string, unknown>>(`UPDATE document_versions SET relative_path=$4,checksum=$5,updated_at=now(),revision=revision+1
            WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND relative_path='' AND deleted_at IS NULL RETURNING id`,
          [context.workspaceId, versionId, versionRevision, relativePath, checksum]);
          if (!result.rows[0]) return false;
          await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
            VALUES($1,$2,$3,'document.pdf_exported','DocumentVersion',$4,'Exported an immutable CV PDF',$5)`,
          [randomUUID(), context.workspaceId, context.userId, versionId, { relativePath, checksum }]);
          return true;
        });
        if (!updated) {
          const latest = await postgresApplicationStudio.getVersion(context, versionId);
          if (latest?.relativePath === relativePath && latest.checksum === checksum) {
            version = latest;
            await verify(version);
            await submit();
            return hostedVersionRecord(version);
          }
          if (!latest?.relativePath) await configuredStorage.adapter.delete({ workspaceId: context.workspaceId, path: relativePath }).catch(() => undefined);
          throw Object.assign(new Error("This CV snapshot changed while its PDF was rendering. Reopen it and export again."), { statusCode: 409 });
        }
        version = (await postgresApplicationStudio.getVersion(context, versionId))!;
        await submit();
        return hostedVersionRecord(version);
      } finally {
        closeSync(lockDescriptor);
        rmSync(lockPath, { force: true });
        rmSync(htmlPath, { force: true });
        rmSync(renderedPdfPath, { force: true });
      }
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 422;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "CareerOS could not render this PDF." });
    }
  }
  const version = db.select().from(documentVersions).where(eq(documentVersions.id, versionId)).get();
  if (!version || version.deletedAt) return reply.code(404).send({ error: "CV snapshot not found." });
  const markSubmitted = () => {
    if (!parsed.data.markAsSubmitted || !version.jobPostingId || !parsed.data.applicationId) return;
    const application = db.select().from(applications).where(eq(applications.id, parsed.data.applicationId)).get();
    if (!application || application.deletedAt || application.jobPostingId !== version.jobPostingId) {
      throw Object.assign(new Error("The selected application does not belong to this CV's job posting."), { statusCode: 409 });
    }
    const timestamp = now();
    sqlite.transaction(() => {
      const latest = db.select().from(documentVersions).where(eq(documentVersions.id, version.id)).get();
      const existingMaterial = db.select().from(applicationMaterials).where(eq(applicationMaterials.documentVersionId, version.id)).get();
      if (existingMaterial && existingMaterial.applicationId !== application.id) throw Object.assign(new Error("This immutable PDF is already linked to a different application."), { statusCode: 409 });
      if (!latest?.submittedAt) db.update(documentVersions).set({ submittedAt: timestamp, updatedAt: timestamp, revision: sql`${documentVersions.revision} + 1` }).where(eq(documentVersions.id, version.id)).run();
      if (!existingMaterial) {
        const document = db.select().from(documents).where(eq(documents.id, version.documentId)).get();
        db.insert(applicationMaterials).values({
          id: randomUUID(), applicationId: application.id, documentId: version.documentId, documentVersionId: version.id,
          materialType: "cv", title: document?.title || "Submitted CV", notes: "Explicitly marked as submitted after PDF export.",
          createdAt: timestamp, updatedAt: timestamp, revision: 1,
        }).run();
      }
    })();
  };
  const verifyStoredPdf = async (storedVersion: typeof version) => {
    if (!storedVersion.relativePath) return;
    if (!storedVersion.checksum) throw Object.assign(new Error("The recorded PDF has no checksum. Create a new immutable snapshot before marking it submitted."), { statusCode: 409 });
    try {
      await readStoredBytes(storedVersion.relativePath, storedVersion.checksum);
    } catch (error) {
      const storedStatus = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 502;
      const message = storedStatus === 404
        ? "The recorded PDF file is missing. Restore it from backup or create a new immutable snapshot before marking it submitted."
        : storedStatus === 409
          ? "The recorded PDF failed checksum verification. Restore it from backup or create a new immutable snapshot before marking it submitted."
          : "The recorded PDF could not be verified because storage is unavailable. Try again before marking it submitted.";
      throw Object.assign(new Error(message), { statusCode: storedStatus === 502 ? 502 : 409 });
    }
  };
  if (version.relativePath) {
    try {
      await verifyStoredPdf(version);
      markSubmitted();
      return documentVersionRowToRecord(db.select().from(documentVersions).where(eq(documentVersions.id, version.id)).get()!);
    } catch (error) {
      return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 409).send({ error: error instanceof Error ? error.message : "The exported PDF could not be linked to this application." });
    }
  }
  const content = cvDocumentContentSchema.safeParse(JSON.parse(version.contentJson || "{}"));
  if (!content.success) return reply.code(422).send({ error: "This CV snapshot contains invalid document data." });
  const relativePath = ["documents", version.documentId, "versions", `${version.id}.pdf`].join("/");
  const temporaryDirectory = join(dataDir, "tmp", "pdf");
  const htmlPath = join(temporaryDirectory, `${version.id}.html`);
  const renderedPdfPath = join(temporaryDirectory, `${version.id}.pdf`);
  const lockPath = join(temporaryDirectory, `${version.id}.lock`);
  mkdirSync(temporaryDirectory, { recursive: true });
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(lockPath, "wx");
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 2 * 60_000) {
        rmSync(lockPath, { force: true });
        lockDescriptor = openSync(lockPath, "wx");
      } else {
        return reply.code(409).send({ error: "This PDF is already being exported. Wait for that export to finish, then download the immutable result." });
      }
    } catch {
      return reply.code(409).send({ error: "This PDF is already being exported. Wait for that export to finish, then download the immutable result." });
    }
  }
  try {
    const latestVersion = db.select().from(documentVersions).where(eq(documentVersions.id, versionId)).get();
    if (latestVersion?.relativePath) {
      await verifyStoredPdf(latestVersion);
      markSubmitted();
      return documentVersionRowToRecord(latestVersion);
    }
    writeFileSync(htmlPath, renderCvPdfHtml(normaliseCvContent(content.data), parsed.data.pageSectionIds), "utf8");
    const bytes = await renderCvPdf(htmlPath, renderedPdfPath, {
      expectedPageCount: parsed.data.pageSectionIds.length,
      expectedTextFragments: [
        content.data.name,
        content.data.intro ?? "",
        content.data.contact?.email ?? "",
        content.data.contact?.phone ?? "",
        content.data.contact?.website ?? "",
        ...content.data.sections.flatMap((section) => [section.title, section.subtitle ?? "", section.date ?? "", section.location ?? "", ...section.content.split(/\r?\n/)]),
      ],
      expectedLinks: [
        ...(content.data.contact?.email ? [`mailto:${content.data.contact.email}`] : []),
        ...(content.data.contact?.phone ? [`tel:${content.data.contact.phone.replace(/\s+/g, "")}`] : []),
        ...(content.data.contact?.website ? [/^https?:\/\//i.test(content.data.contact.website) ? content.data.contact.website : `https://${content.data.contact.website}`] : []),
        ...content.data.sections.flatMap((section) => section.content.match(/https?:\/\/[^\s),.;!?]+/gi) ?? []),
      ],
    });
    await configuredStorage.adapter.upload({ workspaceId: DEFAULT_WORKSPACE_ID, path: relativePath, bytes, contentType: "application/pdf" });
    const timestamp = now();
    try {
      sqlite.transaction(() => {
        db.update(documentVersions).set({
          relativePath,
          checksum: checksumBuffer(bytes),
          updatedAt: timestamp,
          revision: sql`${documentVersions.revision} + 1`,
        }).where(eq(documentVersions.id, version.id)).run();
        markSubmitted();
      })();
    } catch (error) {
      await configuredStorage.adapter.delete({ workspaceId: DEFAULT_WORKSPACE_ID, path: relativePath }).catch(() => undefined);
      throw error;
    }
    return documentVersionRowToRecord(db.select().from(documentVersions).where(eq(documentVersions.id, version.id)).get()!);
  } catch (error) {
    rmSync(renderedPdfPath, { force: true });
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 422;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "CareerOS could not render this PDF." });
  } finally {
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
    rmSync(htmlPath, { force: true });
    rmSync(renderedPdfPath, { force: true });
  }
});

app.get("/api/document-versions/:id/pdf", async (request, reply) => {
  if (postgresApplicationStudio) {
    const context = trackerContext(request);
    const version = await postgresApplicationStudio.getVersion(context, (request.params as { id: string }).id);
    if (!version || !version.relativePath) return reply.code(404).send({ error: "No PDF has been exported for this snapshot." });
    try {
      const stored = await configuredStorage.adapter.read({ workspaceId: context.workspaceId, path: version.relativePath, expectedChecksum: version.checksum });
      const document = await postgresApplicationStudio.getDocument(context, version.documentId);
      const filename = `${(document?.title || "CareerOS CV").replace(/[^a-z0-9 _-]/gi, "").trim() || "CareerOS CV"} - v${version.version}.pdf`;
      reply.header("content-type", "application/pdf");
      reply.header("content-disposition", `attachment; filename="${filename.replaceAll('"', "")}"`);
      return reply.send(Buffer.from(stored.bytes));
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "The exported PDF file could not be read." });
    }
  }
  const version = db.select().from(documentVersions).where(eq(documentVersions.id, (request.params as { id: string }).id)).get();
  if (!version || version.deletedAt || !version.relativePath) return reply.code(404).send({ error: "No PDF has been exported for this snapshot." });
  let bytes: Buffer;
  try {
    bytes = await readStoredBytes(version.relativePath, version.checksum);
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 502;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "The exported PDF file could not be read." });
  }
  const document = db.select().from(documents).where(eq(documents.id, version.documentId)).get();
  const filename = `${(document?.title || "CareerOS CV").replace(/[^a-z0-9 _-]/gi, "").trim() || "CareerOS CV"} - v${version.version}.pdf`;
  reply.header("content-type", "application/pdf");
  reply.header("content-disposition", `attachment; filename="${filename.replaceAll('"', "")}"`);
  return reply.send(bytes);
});

app.put("/api/profile", async (request, reply) => {
  const parsed = profileUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid profile data." });
  if (postgresApplicationStudio) {
    if (parsed.data.expectedRevision == null) return reply.code(428).send({ error: "Reload this profile before saving shared changes." });
    const result = await postgresApplicationStudio.updateProfile(trackerContext(request), parsed.data.expectedRevision, parsed.data);
    if (result.status === "not_found") return reply.code(404).send({ error: "Profile or profile evidence was not found." });
    if (result.status === "conflict") return reply.code(409).send({ error: "This profile changed in another session. Reload before saving so nobody's work is overwritten.", currentRevision: result.currentRevision });
    return result.record;
  }
  const profile = ensureProfile();
  if (hostedAuth.enabled && parsed.data.expectedRevision == null) return reply.code(428).send({ error: "Reload this profile before saving shared changes." });
  if (parsed.data.expectedRevision != null && parsed.data.expectedRevision !== profile.revision) return reply.code(409).send({ error: "This profile changed in another session. Reload before saving so nobody's work is overwritten." });
  const timestamp = now();
  const input = parsed.data;
  sqlite.transaction(() => {
    db.update(profiles).set({
      name: input.name,
      headline: input.headline,
      summary: input.summary,
      updatedAt: timestamp,
      revision: profile.revision + 1,
    }).where(eq(profiles.id, profile.id)).run();

    const existing = db.select().from(profileEvidence).where(sql`${profileEvidence.profileId} = ${profile.id} AND ${profileEvidence.deletedAt} IS NULL`).all();
    const incomingIds = new Set(input.sections.flatMap((section) => section.id ? [section.id] : []));
    for (const section of existing) {
      if (!incomingIds.has(section.id)) {
        db.update(profileEvidence).set({ deletedAt: timestamp, updatedAt: timestamp, revision: section.revision + 1 }).where(eq(profileEvidence.id, section.id)).run();
      }
    }
    for (const section of input.sections) {
      if (section.id && existing.some((item) => item.id === section.id)) {
        const current = existing.find((item) => item.id === section.id)!;
        db.update(profileEvidence).set({
          evidenceType: section.evidenceType,
          title: section.title,
          content: section.content,
          updatedAt: timestamp,
          revision: current.revision + 1,
        }).where(eq(profileEvidence.id, section.id)).run();
      } else {
        db.insert(profileEvidence).values({
          id: randomUUID(),
          profileId: profile.id,
          evidenceType: section.evidenceType,
          title: section.title,
          content: section.content,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 1,
        }).run();
      }
    }
  })();
  return getProfileRecord();
});

app.post("/api/profile/imports", async (request, reply) => {
  const parsed = profileDocumentImportInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Provide a CV, portfolio, document file, or pasted profile text." });
  const input = parsed.data;
  const requestStartedAt = Date.now();
  if (postgresApplicationStudio && runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    let uploadedPath = "";
    let uploadedPersisted = false;
    try {
      const profile = await ensureHostedProfile(context);
      const timestamp = now();
      const fileName = input.fileName ?? `${input.title || "profile-document"}.txt`;
      const mimeType = input.mimeType || "application/octet-stream";
      let documentRecord: ProfileDocumentRecord | null = null;
      let extractedText = "";
      let extractionWarning: string | null = null;
      let extractionMethod = "text";
      if (input.sourceType === "file") {
        const base64 = (input.dataBase64 ?? "").includes(",") ? (input.dataBase64 ?? "").split(",").pop() ?? "" : input.dataBase64 ?? "";
        const buffer = Buffer.from(base64, "base64");
        if (!buffer.byteLength) throw new Error("That file could not be read.");
        if (buffer.byteLength > maxDocumentBytes) throw new Error("That document is too large. Keep profile imports under 10 MB for now.");
        const extractionDirectory = join(dataDir, "tmp", "imports");
        const extractionPath = join(extractionDirectory, `${randomUUID()}-${safeFileName(fileName)}`);
        mkdirSync(extractionDirectory, { recursive: true });
        try {
          writeFileSync(extractionPath, buffer, { mode: 0o600 });
          const extraction = extractTextFromDocument(buffer, fileName, mimeType, extractionPath);
          extractedText = extraction.text; extractionWarning = extraction.warning; extractionMethod = extraction.method;
        } finally { rmSync(extractionPath, { force: true }); }
        const documentId = randomUUID();
        uploadedPath = ["documents", documentId, safeFileName(fileName)].join("/");
        const stored = await configuredStorage.adapter.upload({ workspaceId: context.workspaceId, path: uploadedPath, bytes: buffer, contentType: mimeType });
        await runtimeDataProvider.postgres.transaction(context, async (tx) => {
          await tx.query(`INSERT INTO documents(id,workspace_id,document_type,title,relative_path,checksum,mime_type,size_bytes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [documentId, context.workspaceId, input.documentType, input.title || fileName, uploadedPath, stored.checksum, mimeType, buffer.byteLength]);
          await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
            VALUES($1,$2,$3,'document.imported','Document',$4,'Imported a profile document',$5)`, [randomUUID(), context.workspaceId, context.userId, documentId, { mimeType, sizeBytes: buffer.byteLength }]);
        });
        uploadedPersisted = true;
        documentRecord = await postgresApplicationStudio.getDocument(context, documentId);
      } else {
        extractedText = cleanExtractedText(input.text ?? "");
        if (!extractedText) throw new Error("Paste some CV or portfolio text first.");
      }
      const unusable = Boolean(extractionWarning && /garbled|very little text/i.test(extractionWarning));
      const sourceDocumentId = sourceId();
      await runtimeDataProvider.postgres.transaction(context, (tx) => tx.query(`INSERT INTO source_documents
        (id,workspace_id,source_type,url,raw_text,content_hash,captured_at,metadata) VALUES($1,$2,'profile_document',NULL,$3,$4,$5,$6)`, [
        sourceDocumentId, context.workspaceId, extractedText, contentHash(extractedText), timestamp,
        { documentId: documentRecord?.id ?? null, documentType: input.documentType, fileName, mimeType, extractionMethod, extractionWarning, expectedProfileRevision: profile.revision },
      ]));
      const deterministicDraft = unusable ? { profilePatch: { name: "", headline: "", summary: "" }, sections: [] } : deterministicProfileDraft(extractedText, input.documentType);
      const enrichmentStartedAt = Date.now();
      const enrichmentResult = unusable ? {
        draft: deterministicDraft, mode: "deterministic" as const, provider: null, model: null,
        warning: "The extracted text did not look reliable enough to turn into profile evidence.", evidenceCount: 0,
      } : await enrichProfileDraft({ provider: aiProvider, deterministicDraft, text: extractedText, documentType: input.documentType });
      const durationMs = unusable ? 0 : Date.now() - enrichmentStartedAt;
      const totalDurationMs = Date.now() - requestStartedAt;
      const aiRun = await recordHostedAiRun(context, {
        operation: "profile_import", contextId: sourceDocumentId, sourceType: input.sourceType,
        state: aiRunState(enrichmentResult.mode, unusable || !aiProvider.configured), provider: enrichmentResult.provider ?? aiProvider.name,
        model: enrichmentResult.model ?? aiProvider.model, durationMs, totalDurationMs, evidenceCount: enrichmentResult.evidenceCount,
        warning: enrichmentResult.warning ?? extractionWarning ?? "",
      });
      return {
        document: documentRecord, sourceDocumentId, extractedText, extractionWarning,
        enrichment: { mode: enrichmentResult.mode, provider: enrichmentResult.provider, model: enrichmentResult.model, warning: enrichmentResult.warning, evidenceCount: enrichmentResult.evidenceCount, aiRunId: aiRun?.id ?? null, durationMs, totalDurationMs },
        profilePatch: enrichmentResult.draft.profilePatch, sections: enrichmentResult.draft.sections, profileRevision: profile.revision,
      };
    } catch (error) {
      if (uploadedPath && !uploadedPersisted) await configuredStorage.adapter.delete({ workspaceId: context.workspaceId, path: uploadedPath }).catch(() => undefined);
      return reply.code(422).send({ error: error instanceof Error ? error.message : "Profile document import failed." });
    }
  }
  try {
    const timestamp = now();
    const profileRevision = ensureProfile().revision;
    let documentRecord: ProfileDocumentRecord | null = null;
    let extractedText = "";
    let extractionWarning: string | null = null;
    let extractionMethod = "text";
    const fileName = input.fileName ?? `${input.title || "profile-document"}.txt`;
    const mimeType = input.mimeType || "application/octet-stream";

    if (input.sourceType === "file") {
      const base64 = (input.dataBase64 ?? "").includes(",") ? (input.dataBase64 ?? "").split(",").pop() ?? "" : input.dataBase64 ?? "";
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.byteLength) throw new Error("That file could not be read.");
      const extractionDirectory = join(dataDir, "tmp", "imports");
      const extractionPath = join(extractionDirectory, `${randomUUID()}-${safeFileName(fileName)}`);
      mkdirSync(extractionDirectory, { recursive: true });
      let extraction: TextExtractionResult;
      try {
        writeFileSync(extractionPath, buffer, { mode: 0o600 });
        extraction = extractTextFromDocument(buffer, fileName, mimeType, extractionPath);
      } finally {
        rmSync(extractionPath, { force: true });
      }
      documentRecord = await storeProfileDocument({
        documentType: input.documentType,
        title: input.title || fileName,
        fileName,
        mimeType,
        buffer,
      });
      extractedText = extraction.text;
      extractionWarning = extraction.warning;
      extractionMethod = extraction.method;
    } else {
      extractedText = cleanExtractedText(input.text ?? "");
      if (!extractedText) throw new Error("Paste some CV or portfolio text first.");
    }

    const unusableExtraction = Boolean(extractionWarning && /garbled|very little text/i.test(extractionWarning));

    const sourceDocumentId = sourceId();
    db.insert(sourceDocuments).values({
      id: sourceDocumentId,
      sourceType: "profile_document",
      url: null,
      rawText: extractedText,
      contentHash: contentHash(extractedText),
      capturedAt: timestamp,
      metadata: JSON.stringify({
        documentId: documentRecord?.id ?? null,
        documentType: input.documentType,
        fileName,
        mimeType,
        extractionMethod,
        extractionWarning,
        expectedProfileRevision: profileRevision,
      }),
    }).run();

    const deterministicDraft = unusableExtraction
      ? { profilePatch: { name: "", headline: "", summary: "" }, sections: [] }
      : deterministicProfileDraft(extractedText, input.documentType);
    const enrichmentStartedAt = Date.now();
    const enrichmentResult = unusableExtraction
      ? {
        draft: deterministicDraft,
        mode: "deterministic" as const,
        provider: null,
        model: null,
        warning: "The extracted text did not look reliable enough to turn into profile evidence.",
        evidenceCount: 0,
      }
      : await enrichProfileDraft({
        provider: aiProvider,
        deterministicDraft,
        text: extractedText,
        documentType: input.documentType,
      });
    const durationMs = unusableExtraction ? 0 : Date.now() - enrichmentStartedAt;
    const totalDurationMs = Date.now() - requestStartedAt;
    const aiRun = recordAiRun({
      operation: "profile_import",
      contextId: sourceDocumentId,
      sourceType: input.sourceType,
      state: aiRunState(enrichmentResult.mode, unusableExtraction || !aiProvider.configured),
      provider: enrichmentResult.provider ?? aiProvider.name,
      model: enrichmentResult.model ?? aiProvider.model,
      durationMs,
      totalDurationMs,
      evidenceCount: enrichmentResult.evidenceCount,
      warning: enrichmentResult.warning ?? extractionWarning ?? "",
    });

    return {
      document: documentRecord,
      sourceDocumentId,
      extractedText,
      extractionWarning,
      enrichment: {
        mode: enrichmentResult.mode,
        provider: enrichmentResult.provider,
        model: enrichmentResult.model,
        warning: enrichmentResult.warning,
        evidenceCount: enrichmentResult.evidenceCount,
        aiRunId: aiRun?.id ?? null,
        durationMs,
        totalDurationMs,
      },
      profilePatch: enrichmentResult.draft.profilePatch,
      sections: enrichmentResult.draft.sections,
      profileRevision,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile document import failed.";
    return reply.code(422).send({ error: message });
  }
});

app.post("/api/profile/imports/commit", async (request, reply) => {
  const parsed = profileDocumentImportCommitSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The reviewed profile import is incomplete." });
  if (postgresApplicationStudio && runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    const profile = await ensureHostedProfile(context);
    const input = parsed.data;
    try {
      const result = await runtimeDataProvider.postgres.transaction(context, async (tx) => {
        let capturedRevision: number | null = null;
        if (input.sourceDocumentId) {
          const source = await tx.query<{ expected_revision: number | null }>(`SELECT NULLIF(metadata->>'expectedProfileRevision','')::int AS expected_revision
            FROM source_documents WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, input.sourceDocumentId]);
          if (!source.rows[0]) return "not_found" as const;
          capturedRevision = source.rows[0].expected_revision;
        }
        const expectedRevision = input.expectedRevision ?? capturedRevision;
        if (expectedRevision == null) return "precondition" as const;
        const locked = await tx.query<{ revision: number }>("SELECT revision FROM profiles WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [context.workspaceId, profile.id]);
        if (!locked.rows[0]) return "not_found" as const;
        if (locked.rows[0].revision !== expectedRevision) return "conflict" as const;
        await tx.query(`UPDATE profiles SET name=CASE WHEN trim($3)='' THEN name ELSE $3 END,
          headline=CASE WHEN trim($4)='' THEN headline ELSE $4 END,summary=CASE WHEN trim($5)='' THEN summary ELSE $5 END,
          updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
        [context.workspaceId, profile.id, input.profilePatch.name, input.profilePatch.headline, input.profilePatch.summary]);
        for (const section of input.sections) {
          const sectionId = randomUUID();
          await tx.query(`INSERT INTO profile_evidence(id,workspace_id,profile_id,evidence_type,title,content)
            VALUES($1,$2,$3,$4,$5,$6)`, [sectionId, context.workspaceId, profile.id, section.evidenceType, section.title, section.content]);
          if (input.sourceDocumentId) await tx.query(`INSERT INTO field_evidence
            (id,workspace_id,entity_type,entity_id,field_path,source_document_id,excerpt,method,suggested_value,confidence,user_confirmed,captured_at)
            VALUES($1,$2,'ProfileEvidence',$3,'content',$4,$5,$6,$7,$8,true,now())`, [
            randomUUID(), context.workspaceId, sectionId, input.sourceDocumentId, section.sourceExcerpt,
            section.confidence >= 0.5 ? "ai_generated" : "deterministic", section.content, section.confidence,
          ]);
        }
        await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
          VALUES($1,$2,$3,'profile.import_committed','Profile',$4,'Committed reviewed profile evidence',$5)`,
        [randomUUID(), context.workspaceId, context.userId, profile.id, { sourceDocumentId: input.sourceDocumentId, sectionCount: input.sections.length }]);
        return "updated" as const;
      });
      if (result === "precondition") return reply.code(428).send({ error: "Reopen this profile import before saving shared changes." });
      if (result === "conflict") return reply.code(409).send({ error: "The profile changed while this import was under review. Reopen the import before saving so nobody's work is overwritten." });
      if (result === "not_found") return reply.code(404).send({ error: "Profile import evidence was not found." });
      return await ensureHostedProfile(context);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "The profile import could not be committed." });
    }
  }
  const profile = ensureProfile();
  const input = parsed.data;
  const source = input.sourceDocumentId ? db.select().from(sourceDocuments).where(eq(sourceDocuments.id, input.sourceDocumentId)).get() : null;
  let capturedRevision: number | undefined;
  if (source?.metadata) {
    try {
      const metadata = JSON.parse(source.metadata) as { expectedProfileRevision?: unknown };
      if (Number.isInteger(metadata.expectedProfileRevision) && Number(metadata.expectedProfileRevision) > 0) capturedRevision = Number(metadata.expectedProfileRevision);
    } catch {
      capturedRevision = undefined;
    }
  }
  const expectedRevision = input.expectedRevision ?? capturedRevision;
  if (hostedAuth.enabled && expectedRevision == null) return reply.code(428).send({ error: "Reopen this profile import before saving shared changes." });
  if (expectedRevision != null && expectedRevision !== profile.revision) return reply.code(409).send({ error: "The profile changed while this import was under review. Reopen the import before saving so nobody's work is overwritten." });
  const timestamp = now();
  sqlite.transaction(() => {
    const patch = input.profilePatch;
    db.update(profiles).set({
      name: patch.name.trim() || profile.name,
      headline: patch.headline.trim() || profile.headline,
      summary: patch.summary.trim() || profile.summary,
      updatedAt: timestamp,
      revision: profile.revision + 1,
    }).where(eq(profiles.id, profile.id)).run();

    for (const section of input.sections) {
      const id = randomUUID();
      db.insert(profileEvidence).values({
        id,
        profileId: profile.id,
        evidenceType: section.evidenceType,
        title: section.title,
        content: section.content,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
      }).run();
      if (input.sourceDocumentId) {
        db.insert(fieldEvidence).values({
          id: randomUUID(),
          entityType: "ProfileEvidence",
          entityId: id,
          fieldPath: "content",
          sourceDocumentId: input.sourceDocumentId,
          excerpt: section.sourceExcerpt,
          method: section.confidence >= 0.5 ? "ai_generated" : "deterministic",
          suggestedValue: section.content,
          confidence: section.confidence,
          userConfirmed: true,
          capturedAt: timestamp,
        }).run();
      }
    }
  })();
  return getProfileRecord();
});

async function prepareImport(input: ImportInput, discoveryPostingId?: string, signal?: AbortSignal): Promise<ImportDraftResponse> {
  const requestStartedAt = Date.now();
  const importId = randomUUID();
  const importTimestamp = now();
  db.insert(importRuns).values({ id: importId, sourceType: input.sourceType, sourceUrl: input.url ?? null, discoveryPostingId: discoveryPostingId ?? null, state: "Created", error: null, createdAt: importTimestamp, updatedAt: importTimestamp, revision: 1 }).run();
  try {
    db.update(importRuns).set({ state: input.sourceType === "url" ? "Fetching" : "Extracting", updatedAt: now(), revision: 2 }).where(eq(importRuns.id, importId)).run();
    const captured = input.sourceType === "url" ? await captureUrl(input.url!, {}, signal) : capturePastedText(input.text ?? "", input.sourceType);
    const sourceDocumentId = sourceId();
    const timestamp = now();
    db.insert(sourceDocuments).values({ id: sourceDocumentId, sourceType: captured.sourceType, url: captured.url, rawText: captured.rawText, contentHash: contentHash(captured.rawText), capturedAt: timestamp, metadata: JSON.stringify(captured.metadata) }).run();
    const sourceUrl = captured.url ?? input.url ?? "";
    const applyUrl = input.applyUrl ?? (input.sourceType === "url" ? input.url ?? sourceUrl : "");
    const deterministicDraft = jobDraftSchema.parse(extractJobDraft(captured.rawText, sourceUrl, applyUrl));
    const enrichmentStartedAt = Date.now();
    const enrichmentResult = await enrichJobDraft({
      provider: aiProvider,
      deterministicDraft,
      text: captured.rawText,
      sourceUrl: captured.url ?? input.url ?? "",
      signal,
    });
    const durationMs = Date.now() - enrichmentStartedAt;
    const draft = jobDraftSchema.parse(enrichmentResult.draft);
    for (const evidence of enrichmentResult.evidence) {
      db.insert(fieldEvidence).values({
        id: randomUUID(),
        entityType: "ImportRun",
        entityId: importId,
        fieldPath: evidence.fieldPath,
        sourceDocumentId,
        excerpt: evidence.excerpt,
        method: enrichmentResult.mode === "ai" ? "ai_generated" : "deterministic",
        suggestedValue: evidence.suggestedValue,
        confidence: evidence.confidence,
        userConfirmed: false,
        capturedAt: timestamp,
      }).run();
    }
    const duplicates = findPostingDuplicates(draft);
    db.update(importRuns).set({ state: "Needs Review", sourceDocumentId, updatedAt: now(), revision: 3 }).where(eq(importRuns.id, importId)).run();
    const totalDurationMs = Date.now() - requestStartedAt;
    const aiRun = recordAiRun({
      operation: "job_import",
      contextId: importId,
      sourceType: input.sourceType,
      state: aiRunState(enrichmentResult.mode, !aiProvider.configured),
      provider: enrichmentResult.provider ?? aiProvider.name,
      model: enrichmentResult.model ?? aiProvider.model,
      durationMs,
      totalDurationMs,
      evidenceCount: enrichmentResult.evidence.length,
      warning: enrichmentResult.warning ?? "",
    });
    return {
      importRun: { id: importId, state: "Needs Review", sourceType: captured.sourceType, sourceUrl: captured.url, error: null },
      draft,
      duplicates,
      enrichment: {
        mode: enrichmentResult.mode,
        provider: enrichmentResult.provider,
        model: enrichmentResult.model,
        warning: enrichmentResult.warning,
        evidenceCount: enrichmentResult.evidence.length,
        aiRunId: aiRun?.id ?? null,
        durationMs,
        totalDurationMs,
      },
      fieldEvidence: enrichmentResult.evidence.map((evidence) => ({
        fieldPath: evidence.fieldPath,
        excerpt: evidence.excerpt,
        confidence: evidence.confidence,
        method: enrichmentResult.mode === "ai" ? "ai_generated" as const : "deterministic" as const,
      })),
    } satisfies ImportDraftResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    const state = blockedImportMessage(message) ? "Blocked" : "Failed";
    db.update(importRuns).set({ state, error: message, updatedAt: now(), revision: 2 }).where(eq(importRuns.id, importId)).run();
    if (state === "Blocked") throw new CaptureBlockedError(message);
    throw new Error(message);
  }
}

async function preparePostgresCaptureImport(claim: ClaimedCapture, input: ImportInput, signal?: AbortSignal): Promise<ImportDraftResponse> {
  if (!postgresCaptureRepository) throw new Error("Hosted capture storage is unavailable.");
  const requestStartedAt = Date.now();
  let captured: Awaited<ReturnType<typeof captureUrl>>;
  try {
    captured = input.sourceType === "url" ? await captureUrl(input.url!, {}, signal) : capturePastedText(input.text ?? "", input.sourceType);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    if (blockedImportMessage(message)) throw new CaptureBlockedError(message);
    throw error;
  }
  const sourceUrl = captured.url ?? input.url ?? "";
  const applyUrl = input.applyUrl ?? (input.sourceType === "url" ? input.url ?? sourceUrl : "");
  const deterministicDraft = jobDraftSchema.parse(extractJobDraft(captured.rawText, sourceUrl, applyUrl));
  const enrichmentStartedAt = Date.now();
  const enrichmentResult = await enrichJobDraft({ provider: aiProvider, deterministicDraft, text: captured.rawText, sourceUrl, signal });
  const durationMs = Date.now() - enrichmentStartedAt;
  const draft = jobDraftSchema.parse(enrichmentResult.draft);
  const duplicates = await postgresCaptureRepository.savedDuplicatesForWorkspace(claim.workspaceId, draft);
  const importId = randomUUID();
  const response: ImportDraftResponse = {
    importRun: { id: importId, state: "Needs Review", sourceType: captured.sourceType, sourceUrl: captured.url, error: null },
    draft,
    duplicates,
    enrichment: {
      mode: enrichmentResult.mode,
      provider: enrichmentResult.provider,
      model: enrichmentResult.model,
      warning: enrichmentResult.warning,
      evidenceCount: enrichmentResult.evidence.length,
      aiRunId: null,
      durationMs,
      totalDurationMs: Date.now() - requestStartedAt,
    },
    fieldEvidence: enrichmentResult.evidence.map((evidence) => ({ fieldPath: evidence.fieldPath, excerpt: evidence.excerpt, confidence: evidence.confidence, method: enrichmentResult.mode === "ai" ? "ai_generated" as const : "deterministic" as const })),
  };
  await postgresCaptureRepository.createImport(claim, {
    sourceType: captured.sourceType,
    url: captured.url,
    rawText: captured.rawText,
    contentHash: contentHash(captured.rawText),
    metadata: captured.metadata,
  }, response, enrichmentResult.evidence.map((item) => ({ ...item, method: enrichmentResult.mode === "ai" ? "ai_generated" as const : "deterministic" as const })));
  return response;
}

function comparableUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|gh_src|source|sourceid|ref|referrer|referral|tracking|trk|codes|partnerid|siteid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function comparableLabel(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function findPostingDuplicates(draft: JobDraft): ImportDraftResponse["duplicates"] {
  const sourceUrl = comparableUrl(draft.sourceUrl);
  const applyUrl = comparableUrl(draft.applyUrl);
  const rows = sqlite.prepare(`
    SELECT j.id, j.title, c.name AS companyName, j.source_url AS sourceUrl, j.apply_url AS applyUrl
    FROM job_postings j JOIN companies c ON c.id = j.company_id
    WHERE j.deleted_at IS NULL
  `).all() as Array<{ id: string; title: string; companyName: string; sourceUrl: string; applyUrl: string }>;
  return rows
    .filter((row) => {
      const rowSource = comparableUrl(row.sourceUrl);
      const rowApply = comparableUrl(row.applyUrl);
      if ((sourceUrl && (sourceUrl === rowSource || sourceUrl === rowApply)) || (applyUrl && (applyUrl === rowSource || applyUrl === rowApply))) return true;
      return comparableLabel(row.title) === comparableLabel(draft.title)
        && comparableLabel(row.companyName) === comparableLabel(draft.companyName);
    })
    .slice(0, 5)
    .map(({ id, title, companyName, sourceUrl: rowSource }) => ({ id, title, companyName, sourceUrl: rowSource }));
}

function queueJobToRecord(job: CaptureQueueJob, compact = false): CaptureQueueItem {
  const baseResponse = job.result?.response as ImportDraftResponse | undefined;
  const sourceText = !compact && baseResponse ? (sqlite.prepare(`SELECT sd.raw_text AS rawText FROM import_runs ir LEFT JOIN source_documents sd ON sd.id = ir.source_document_id WHERE ir.id = ?`).get(baseResponse.importRun.id) as { rawText?: string } | undefined)?.rawText : undefined;
  const response = baseResponse ? { ...baseResponse, ...(sourceText ? { sourceText } : {}) } : undefined;
  let counts = response?.duplicates ?? [];
  if (!compact && response) {
    const saved = findPostingDuplicates(response.draft);
    const stillQueued = counts.filter((duplicate) => {
      if (!duplicate.queued) return false;
      const candidate = sqlite.prepare("SELECT state FROM capture_queue_items WHERE id=? AND deleted_at IS NULL").get(duplicate.id) as { state?: string } | undefined;
      return candidate?.state !== "Saved";
    });
    counts = [...saved, ...stillQueued].filter((duplicate, index, all) => all.findIndex((candidate) => candidate.id === duplicate.id) === index);
  }
  const fullDraft = response?.draft ?? null;
  const draft = compact && fullDraft ? {
    ...fullDraft,
    description: "",
    requiredRequirements: [],
    preferredRequirements: [],
    processSummary: "",
    companyDescription: "",
  } : fullDraft;
  return {
    id: job.id,
    sourceType: job.input.kind === "url" ? "url" : "pasted_text",
    sourceUrl: job.input.kind === "url" ? job.input.url : response?.importRun.sourceUrl ?? "",
    applyUrl: response?.draft.applyUrl ?? job.input.applyUrl ?? "",
    textPreview: job.input.kind === "text" ? job.input.text.slice(0, 240) : "",
    sourceText: compact ? null : response?.sourceText ?? null,
    state: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    attemptCount: job.attempts,
    importRunId: response?.importRun.id ?? null,
    draft,
    duplicates: counts,
    enrichment: response?.enrichment ?? null,
    fieldEvidence: compact ? [] : response?.fieldEvidence ?? [],
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.finishedAt,
    revision: Math.max(1, job.attempts + 1),
  };
}

async function postgresQueueJobToRecord(context: ReturnType<typeof trackerContext>, job: CaptureQueueJob, compact = false): Promise<CaptureQueueItem> {
  if (!postgresCaptureRepository) throw new Error("Hosted capture storage is unavailable.");
  const response = job.result?.response as ImportDraftResponse | undefined;
  const sourceText = !compact && response ? await postgresCaptureRepository.sourceText(context, response.importRun.id) : "";
  const saved = !compact && response ? await postgresCaptureRepository.savedDuplicates(context, response.draft) : response?.duplicates ?? [];
  const duplicates = [...saved, ...(response?.duplicates ?? []).filter((item) => item.queued)].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  const fullDraft = response?.draft ?? null;
  const draft = compact && fullDraft ? { ...fullDraft, description: "", requiredRequirements: [], preferredRequirements: [], processSummary: "", companyDescription: "" } : fullDraft;
  return {
    id: job.id,
    sourceType: job.input.kind === "url" ? "url" : "pasted_text",
    sourceUrl: job.input.kind === "url" ? job.input.url : response?.importRun.sourceUrl ?? "",
    applyUrl: response?.draft.applyUrl ?? job.input.applyUrl ?? "",
    textPreview: job.input.kind === "text" ? job.input.text.slice(0, 240) : "",
    sourceText: compact ? null : sourceText || null,
    state: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    attemptCount: job.attempts,
    importRunId: response?.importRun.id ?? null,
    draft,
    duplicates,
    enrichment: response?.enrichment ?? null,
    fieldEvidence: compact ? [] : response?.fieldEvidence ?? [],
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.finishedAt,
    revision: Math.max(1, job.attempts + 1),
  };
}

const postgresCaptureRepository = runtimeDataProvider.name === "postgres" ? new PostgresCaptureRepository(runtimeDataProvider.postgres) : null;
const captureQueueStore = new SqliteCaptureQueueStore(sqlite);
const captureQueue = new CaptureQueueService(
  captureQueueStore,
  {
    async process(job, context) {
      await context.reportProgress(0.1, "Capturing source");
      const input: ImportInput = job.input.kind === "url"
        ? { sourceType: "url", url: job.input.url, applyUrl: job.input.applyUrl }
        : { sourceType: "pasted_text", text: job.input.text, applyUrl: job.input.applyUrl };
      await context.reportProgress(0.25, "Extracting job details");
      const response = await prepareImport(input, undefined, context.signal);
      const draftSource = comparableUrl(response.draft.sourceUrl);
      const draftApply = comparableUrl(response.draft.applyUrl);
      const queuedDuplicates = (await captureQueueStore.findPotentialDuplicates(job, response.draft.title, response.draft.companyName))
        .filter((candidate) => {
          const candidateResponse = candidate.result?.response as ImportDraftResponse | undefined;
          if (candidateResponse) {
            const source = comparableUrl(candidateResponse.draft.sourceUrl);
            const apply = comparableUrl(candidateResponse.draft.applyUrl);
            return Boolean((draftSource && (draftSource === source || draftSource === apply)) || (draftApply && (draftApply === source || draftApply === apply)))
              || (comparableLabel(candidateResponse.draft.title) === comparableLabel(response.draft.title)
                && comparableLabel(candidateResponse.draft.companyName) === comparableLabel(response.draft.companyName));
          }
          if (job.input.kind === "url" && candidate.input.kind === "url") return comparableUrl(job.input.url) === comparableUrl(candidate.input.url);
          if (job.input.kind === "text" && candidate.input.kind === "text") {
            if (contentHash(job.input.text) === contentHash(candidate.input.text)) return true;
            const candidateDraft = extractJobDraft(candidate.input.text);
            return comparableLabel(candidateDraft.title) === comparableLabel(response.draft.title)
              && comparableLabel(candidateDraft.companyName) === comparableLabel(response.draft.companyName);
          }
          return false;
        })
        .slice(0, 5)
        .map((candidate) => {
          const candidateResponse = candidate.result?.response as ImportDraftResponse | undefined;
          return {
            id: candidate.id,
            title: candidateResponse?.draft.title ?? "Queued duplicate",
            companyName: candidateResponse?.draft.companyName ?? "Another capture",
            sourceUrl: candidate.input.kind === "url" ? candidate.input.url : candidateResponse?.draft.sourceUrl ?? "",
            queued: true,
          };
        });
      response.duplicates = [...response.duplicates, ...queuedDuplicates].filter((duplicate, index, all) => all.findIndex((candidate) => candidate.id === duplicate.id) === index);
      await context.reportProgress(0.9, "Preparing review");
      return {
        status: response.duplicates.length ? "Duplicate" : "Needs Review",
        result: { response },
      };
    },
  },
  {
    concurrency: Math.max(1, Math.min(Number(process.env.CAREEROS_CAPTURE_CONCURRENCY ?? 3), 8)),
    capacity: 100,
    acquireMutation: () => mutationGate.acquire({ waitForExclusive: true }),
  },
);
if (runtimeDataProvider.name === "sqlite") await captureQueue.start();
app.addHook("onClose", async () => captureQueue.stop());
const postgresCaptureWorker = postgresCaptureRepository ? new PostgresCaptureWorker(
  postgresCaptureRepository,
  async (job, context) => {
    await context.reportProgress(0.1, "Capturing source");
    const input: ImportInput = job.input.kind === "url"
      ? { sourceType: "url", url: job.input.url, applyUrl: job.input.applyUrl }
      : { sourceType: "pasted_text", text: job.input.text, applyUrl: job.input.applyUrl };
    await context.reportProgress(0.25, "Extracting job details");
    const response = await preparePostgresCaptureImport(job, input, context.signal);
    const draftSource = comparableUrl(response.draft.sourceUrl);
    const draftApply = comparableUrl(response.draft.applyUrl);
    const queuedDuplicates = (await postgresCaptureRepository.queuedCandidates(job)).filter((candidate) => {
      const candidateResponse = candidate.result?.response as ImportDraftResponse | undefined;
      if (candidateResponse) {
        const source = comparableUrl(candidateResponse.draft.sourceUrl), apply = comparableUrl(candidateResponse.draft.applyUrl);
        return Boolean((draftSource && (draftSource === source || draftSource === apply)) || (draftApply && (draftApply === source || draftApply === apply)))
          || (comparableLabel(candidateResponse.draft.title) === comparableLabel(response.draft.title) && comparableLabel(candidateResponse.draft.companyName) === comparableLabel(response.draft.companyName));
      }
      if (job.input.kind === "url" && candidate.input.kind === "url") return comparableUrl(job.input.url) === comparableUrl(candidate.input.url);
      if (job.input.kind === "text" && candidate.input.kind === "text") return contentHash(job.input.text) === contentHash(candidate.input.text);
      return false;
    }).slice(0, 5).map((candidate) => {
      const candidateResponse = candidate.result?.response as ImportDraftResponse | undefined;
      return { id: candidate.id, title: candidateResponse?.draft.title ?? "Queued duplicate", companyName: candidateResponse?.draft.companyName ?? "Another capture", sourceUrl: candidate.input.kind === "url" ? candidate.input.url : candidateResponse?.draft.sourceUrl ?? "", queued: true };
    });
    response.duplicates = [...response.duplicates, ...queuedDuplicates].filter((duplicate, index, all) => all.findIndex((candidate) => candidate.id === duplicate.id) === index);
    await context.reportProgress(0.9, "Preparing review");
    return { status: response.duplicates.length ? "Duplicate" : "Needs Review", result: { response } };
  },
  Math.max(1, Math.min(Number(process.env.CAREEROS_CAPTURE_CONCURRENCY ?? 3), 8)),
  { onError: (error) => app.log.error({ error: error instanceof Error ? error.message : "Capture worker failed." }, "PostgreSQL capture worker paused after an error") },
) : null;
if (postgresCaptureWorker) await postgresCaptureWorker.start();
const discoveryService = runtimeDataProvider.name === "sqlite" ? new DiscoveryService(sqlite, {
  runMutation: (work) => mutationGate.run(work, { waitForExclusive: true }),
}) : null;
const sqliteDiscovery = () => {
  if (!discoveryService) throw Object.assign(new Error("Discovery has not yet been converted to hosted PostgreSQL storage."), { statusCode: 501 });
  return discoveryService;
};
discoveryService?.seedFinanceSources();
const e2eAuthEnabled = process.env.NODE_ENV === "test" && process.env.CAREEROS_E2E_AUTH === "1";
const e2eIdentities = {
  owner: { sub: "10000000-0000-4000-8000-000000000001", email: "owner@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Zain Owner" } },
  editor: { sub: "20000000-0000-4000-8000-000000000002", email: "editor@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Invited Editor" } },
  viewer: { sub: "30000000-0000-4000-8000-000000000003", email: "viewer@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Invited Viewer" } },
  uninvited: { sub: "40000000-0000-4000-8000-000000000004", email: "uninvited@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Uninvited User" } },
} as const;
const authOptions = e2eAuthEnabled ? {
  verifyJwt: async (token: string) => {
    const identity = e2eIdentities[token as keyof typeof e2eIdentities];
    if (!identity) throw new Error("Unknown test identity.");
    return identity;
  },
} : {};
const hostedAuth = runtimeDataProvider.name === "postgres"
  ? await PostgresHostedAuthService.create(runtimeDataProvider.postgres, authOptions)
  : new HostedAuthService(sqlite, authOptions);
const trackerRepository = runtimeDataProvider.name === "postgres"
  ? new PostgresTrackerRepository(runtimeDataProvider.postgres)
  : new SqliteTrackerRepository(sqlite);
const hostedSessions = new HostedSessionService();
const configuredStorage = configuredObjectStorage(dataDir, DEFAULT_WORKSPACE_ID);
const configuredBackupStorage = configuredBackupObjectStorage(dataDir, DEFAULT_WORKSPACE_ID);
const postgresApplicationStudio = runtimeDataProvider.name === "postgres"
  ? new PostgresApplicationStudioRepository(runtimeDataProvider.postgres)
  : null;
const postgresDiscoveryRepository = runtimeDataProvider.name === "postgres"
  ? new PostgresDiscoveryRepository(runtimeDataProvider.postgres)
  : null;
const postgresDiscoveryQuery = runtimeDataProvider.name === "postgres"
  ? new PostgresDiscoveryQueryRepository(runtimeDataProvider.postgres)
  : null;
const hostedIntegrationKey = process.env.CAREEROS_INTEGRATION_ENCRYPTION_KEY?.trim() ?? "";
const hostedPreviousIntegrationKeys = process.env.CAREEROS_INTEGRATION_ENCRYPTION_KEY_PREVIOUS?.trim() ?? "";
const postgresTelegramSettings = runtimeDataProvider.name === "postgres" && hostedIntegrationKey
  ? new PostgresTelegramSettingsRepository(runtimeDataProvider.postgres, hostedIntegrationKey, hostedPreviousIntegrationKeys)
  : null;
const postgresDiscovery = postgresDiscoveryRepository
  ? new PostgresDiscoveryService(postgresDiscoveryRepository, {
      resolveTelegram: async (context) => {
        const settings = await postgresTelegramSettings?.resolve(context) ?? null;
        return settings ? { provider: createTelegramProvider({
          botToken: settings.botToken,
          ...(process.env.NODE_ENV === "test" && process.env.CAREEROS_TELEGRAM_API_BASE_URL
            ? { apiBaseUrl: process.env.CAREEROS_TELEGRAM_API_BASE_URL }
            : {}),
        }), recipientId: settings.chatId } : null;
      },
    })
  : null;
const hostedDiscoveryFetcher = postgresDiscovery ? createHostedAtsFetcher() : null;

async function hostedWorkspaceContexts() {
  if (runtimeDataProvider.name !== "postgres") return [];
  return runtimeDataProvider.postgres.administrativeTransaction(async (tx) => {
    const result = await tx.query<{ workspace_id: string; user_id: string; auth_subject: string }>(`SELECT DISTINCT ON (m.workspace_id)
      m.workspace_id,u.id AS user_id,u.auth_subject::text AS auth_subject
      FROM workspace_memberships m JOIN workspace_users u ON u.id=m.user_id
      ORDER BY m.workspace_id,CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,m.created_at,u.id`);
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, userId: row.user_id, authSubject: row.auth_subject }));
  });
}

async function runHostedDiscoveryCycle(sourceId?: string) {
  if (!postgresDiscovery || !hostedDiscoveryFetcher || !postgresDiscoveryRepository) return [];
  const contexts = await hostedWorkspaceContexts();
  const batches = await runWorkspaceTasksIsolated(contexts, async (context) => sourceId
        ? await postgresDiscovery.runSourceNow(context, sourceId, hostedDiscoveryFetcher)
        : await postgresDiscovery.runDue(context, hostedDiscoveryFetcher, { limit: 10 }), (context, error) => {
      app.log.error({ workspaceId: context.workspaceId, error: error instanceof Error ? error.message : "Discovery failed." }, "Hosted discovery workspace failed");
    });
  await runWorkspaceTasksIsolated(contexts, async (context) => postgresDiscovery.dispatchTelegram(context, { limit: 25 }), (context, error) => {
      app.log.error({ workspaceId: context.workspaceId, error: error instanceof Error ? error.message : "Notification dispatch failed." }, "Hosted notification workspace failed");
    });
  return batches.flat();
}

async function runHostedDiscoveryForContext(context: ReturnType<typeof trackerContext>, sourceId?: string) {
  if (!postgresDiscovery || !hostedDiscoveryFetcher || runtimeDataProvider.name !== "postgres") return [];
  const runs = sourceId
    ? await postgresDiscovery.runSourceNow(context, sourceId, hostedDiscoveryFetcher)
    : await postgresDiscovery.runDue(context, hostedDiscoveryFetcher, { limit: 100 });
  await postgresDiscovery.dispatchTelegram(context, { limit: 25 });
  return runs;
}

let hostedDiscoveryTimer: NodeJS.Timeout | null = null;
const backupKeyValue = process.env.CAREEROS_BACKUP_ENCRYPTION_KEY?.trim() ?? "";
const backupScheduler = runtimeDataProvider.name === "sqlite" && backupKeyValue ? new EncryptedBackupScheduler({
  storage: configuredBackupStorage.adapter,
  workspaceId: DEFAULT_WORKSPACE_ID,
  key: decodeBackupKey(backupKeyValue),
  intervalMs: Math.max(1, Number(process.env.CAREEROS_BACKUP_INTERVAL_HOURS ?? 24)) * 60 * 60 * 1_000,
  createBundle: async () => encodeBackupBundle(await createStorageBackedBundle()),
  runExclusive: (work) => mutationGate.run(work, { waitForExclusive: true }),
  onSuccess: (result, completedAt) => {
    sqlite.prepare(`INSERT OR IGNORE INTO backup_records(id,workspace_id,object_path,checksum,size_bytes,created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), DEFAULT_WORKSPACE_ID, result.path, result.checksum, result.sizeBytes, completedAt);
  },
}) : null;
const hostedBackupService = runtimeDataProvider.name === "postgres" && backupKeyValue ? new PostgresHostedBackupService({
  provider: runtimeDataProvider.postgres,
  storage: configuredStorage.adapter,
  backupStorage: configuredBackupStorage.adapter,
  encryptionKey: backupKeyValue,
  schemaVersion: postgresSchemaVersion!,
  applicationVersion: "0.1.0",
  intervalMs: Math.max(1, Number(process.env.CAREEROS_BACKUP_INTERVAL_HOURS ?? 24)) * 60 * 60 * 1_000,
  contexts: hostedWorkspaceContexts,
}) : null;
backupScheduler?.start();
hostedBackupService?.start();
app.addHook("onClose", async () => { backupScheduler?.stop(); hostedBackupService?.stop(); });
app.addHook("onClose", async () => {
  if (hostedDiscoveryTimer) clearInterval(hostedDiscoveryTimer);
  hostedDiscoveryTimer = null;
});
app.addHook("onClose", async () => {
  // Preserve this order: active claims need the database in order to return to
  // the queue before any PostgreSQL-backed service closes its pool.
  await postgresCaptureWorker?.stop();
  if (hostedAuth instanceof PostgresHostedAuthService) await hostedAuth.close();
  await runtimeDataProvider.postgres?.close();
});

function mutationAuditDescriptor(request: Parameters<typeof hostedAuth.requireSession>[0]) {
  const route = request.routeOptions.url || request.url.split("?")[0];
  const params = request.params as { id?: unknown } | null;
  const id = typeof params?.id === "string" ? params.id : hostedAuth.requireSession(request).workspaceId;
  if (route === "/api/profile/imports/commit") return { entityType: "Profile", entityId: id, summary: "Committed reviewed profile evidence" };
  if (route === "/api/profile") return { entityType: "Profile", entityId: id, summary: "Updated career profile" };
  if (route === "/api/tasks/:id") return { entityType: "Task", entityId: id, summary: "Updated follow-up task" };
  if (route === "/api/jobs/:id/tasks") return { entityType: "Task", entityId: id, summary: "Added a follow-up task" };
  if (route.startsWith("/api/jobs")) return { entityType: "JobPosting", entityId: id, summary: request.method === "POST" ? "Added a job posting" : "Updated a job posting" };
  if (route.startsWith("/api/applications")) return { entityType: "Application", entityId: id, summary: "Updated an application" };
  if (route.startsWith("/api/capture-queue")) return { entityType: "CaptureQueue", entityId: id, summary: "Updated the capture queue" };
  return { entityType: "ApiMutation", entityId: id, summary: `${request.method} ${route}` };
}

app.addHook("preHandler", async (request, reply) => {
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const hostedAuthenticationMayWrite = hostedAuth.enabled && request.url.startsWith("/api/") && request.url !== "/api/auth/config";
  const protectedOperation = request.url === "/api/restore" || request.url === "/api/backups" || request.url.startsWith("/api/backups/");
  if ((!mutation && !hostedAuthenticationMayWrite) || protectedOperation) return;
  try {
    const release = await mutationGate.acquire();
    (request as unknown as Record<PropertyKey, unknown>)[mutationMarker] = release;
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 503;
    app.log.warn({ method: request.method, url: request.url, statusCode }, "Mutation gate rejected request");
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "CareerOS is temporarily read-only." });
  }
});

app.addHook("preHandler", async (request, reply) => {
  if (runtimeDataProvider.name === "postgres" && postgresRouteRequiresConversion(request.url)) {
    return reply.code(501).send({ error: "This feature has not yet been converted to hosted PostgreSQL storage. No SQLite fallback was used." });
  }
  if (request.url === "/health" || request.url === "/api/auth/config" || request.url === "/api/auth/invitations/stage"
    || request.url.startsWith("/api/auth/session/exchange") || request.url.startsWith("/api/auth/session/refresh") || request.url.startsWith("/api/auth/session/logout")) return;
  if (!request.url.startsWith("/api/")) return;
  const protectedOperation = request.url === "/api/restore" || request.url === "/api/backups" || request.url.startsWith("/api/backups/");
  if (hostedAuth.enabled && protectedOperation) {
    try {
      await mutationGate.run(async () => {
        await hostedAuth.authenticate(request);
        (request as unknown as Record<PropertyKey, unknown>)[authenticatedMarker] = true;
      }, { waitForExclusive: true });
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 503;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "CareerOS is temporarily read-only." });
    }
  }
  if (!hostedAuth.enabled) {
    await hostedAuth.authenticate(request);
    return;
  }
  try {
    if (!(request as unknown as Record<PropertyKey, unknown>)[authenticatedMarker]) await hostedAuth.authenticate(request);
    if (request.url === "/api/auth/session" || request.url === "/api/auth/invitations/accept") return;
    if (request.url.startsWith("/api/")) {
      const ownerOnlyDelete = request.method === "DELETE"
        && (request.url.startsWith("/api/auth/invitations/") || request.url.startsWith("/api/auth/members/"));
      const ownerOnly = ownerOnlyDelete || request.url === "/api/restore" || request.url === "/api/export" || request.url === "/api/backups" || request.url.startsWith("/api/backups/") || request.url.startsWith("/api/settings/openai-key") || request.url.startsWith("/api/settings/telegram") || request.url === "/api/system/open-terminal";
      if (ownerOnly) await hostedAuth.requireOwner(request);
      else await hostedAuth.requireMembership(request, !["GET", "HEAD", "OPTIONS"].includes(request.method));
    }
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 401;
    return reply.code(statusCode === 403 ? 403 : 401).send({ error: error instanceof Error ? error.message : "Authentication is required." });
  }
});

app.addHook("onResponse", async (request) => releaseMutation(request as unknown as Record<PropertyKey, unknown>));
app.addHook("onError", async (request) => releaseMutation(request as unknown as Record<PropertyKey, unknown>));

app.addHook("preSerialization", async (request, reply, payload) => {
  if (!request.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(request.method) || reply.statusCode >= 400) return payload;
  if (request.url.startsWith("/api/auth/") || request.url.startsWith("/api/workspace/comments") || request.url.startsWith("/api/settings/openai-key") || request.url === "/api/system/open-terminal") return payload;
  // PostgreSQL tracker repositories append audit rows inside the same transaction
  // as each mutation. Never add a second post-commit failure point here.
  if (runtimeDataProvider.name === "postgres" && postgresRouteConverted(request.url)) return payload;
  const session = await hostedAuth.requireMembership(request, true);
  const descriptor = mutationAuditDescriptor(request);
  await hostedAuth.audit(session, `api.${request.method.toLowerCase()}`, descriptor.entityType, descriptor.entityId, descriptor.summary, {
    route: request.routeOptions.url || request.url.split("?")[0],
    statusCode: reply.statusCode,
  });
  return payload;
});

app.get("/api/auth/config", async () => hostedAuth.config());

app.post("/api/auth/session/exchange", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
  const refreshToken = (request.body as { refreshToken?: unknown } | null)?.refreshToken;
  if (typeof refreshToken !== "string") return reply.code(400).send({ error: "The Google sign-in session is invalid." });
  try {
    const session = await hostedSessions.rotate(refreshToken);
    reply.header("set-cookie", hostedSessions.cookie(session, process.env.NODE_ENV === "production"));
    return hostedSessions.publicSession(session);
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 502;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Google sign-in could not be secured." });
  }
});

app.post("/api/auth/session/refresh", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
  const cookie = requestCookie(request, "careeros_session");
  if (!cookie) return reply.code(401).send({ error: "Sign in with Google to continue." });
  try {
    const session = await hostedSessions.rotate(hostedSessions.refreshTokenFromCookie(cookie));
    reply.header("set-cookie", hostedSessions.cookie(session, process.env.NODE_ENV === "production"));
    return hostedSessions.publicSession(session);
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 502;
    if (statusCode === 401 || statusCode === 403) {
      reply.header("set-cookie", hostedSessions.clearCookie(process.env.NODE_ENV === "production"));
    }
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Google sign-in could not be refreshed." });
  }
});

app.post("/api/auth/session/logout", async (_request, reply) => {
  reply.header("set-cookie", hostedSessions.clearCookie(process.env.NODE_ENV === "production"));
  return reply.code(204).send();
});

app.get("/api/auth/session", async (request) => {
  const session = hostedAuth.enabled ? await hostedAuth.requireMembership(request) : await hostedAuth.authenticate(request);
  return { hosted: session.hosted, user: { ...session.actor, memberId: session.userId }, workspace: { id: session.workspaceId, name: session.workspaceName, role: session.role }, members: await hostedAuth.members(request) };
});

app.post("/api/auth/invitations", async (request, reply) => {
  const body = (request.body ?? {}) as { email?: unknown; role?: unknown };
  if (typeof body.email !== "string" || (body.role !== "editor" && body.role !== "viewer")) return reply.code(400).send({ error: "Enter an email and collaborator role." });
  try { return reply.code(201).send(await hostedAuth.createInvite(request, { email: body.email, role: body.role })); }
  catch (error) { return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 400).send({ error: error instanceof Error ? error.message : "Invitation could not be created." }); }
});

app.get("/api/auth/invitations", async (request) => hostedAuth.invitations(request));

app.post("/api/auth/invitations/stage", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
  const token = (request.body as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length < 20) return reply.code(400).send({ error: "Invitation token is invalid." });
  try {
    const handle = await hostedAuth.stageInvite(token);
    reply.header("set-cookie", pendingInviteCookie(handle));
    return reply.code(204).send();
  } catch (error) {
    return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 403).send({ error: error instanceof Error ? error.message : "Invitation could not be staged." });
  }
});

app.delete("/api/auth/invitations/:id", async (request, reply) => {
  try { return await hostedAuth.revokeInvite(request, (request.params as { id: string }).id); }
  catch (error) { return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 400).send({ error: error instanceof Error ? error.message : "Invitation could not be revoked." }); }
});

app.post("/api/auth/invitations/accept", async (request, reply) => {
  const token = (request.body as { token?: unknown } | null)?.token;
  const stagedHandle = requestCookie(request, pendingInviteCookieName);
  if ((!stagedHandle || stagedHandle.length < 20) && (typeof token !== "string" || token.length < 20)) return reply.code(204).send();
  if (stagedHandle) reply.header("set-cookie", pendingInviteCookie("", true));
  try { return stagedHandle ? await hostedAuth.acceptStagedInvite(request, stagedHandle) : await hostedAuth.acceptInvite(request, token as string); }
  catch (error) { return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 403).send({ error: error instanceof Error ? error.message : "Invitation could not be accepted." }); }
});

app.patch("/api/auth/members/:id", async (request, reply) => {
  const role = (request.body as { role?: unknown } | null)?.role;
  if (role !== "editor" && role !== "viewer") return reply.code(400).send({ error: "Choose editor or viewer access." });
  try { return await hostedAuth.updateMember(request, (request.params as { id: string }).id, role); }
  catch (error) { return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 400).send({ error: error instanceof Error ? error.message : "Collaborator access could not be changed." }); }
});

app.delete("/api/auth/members/:id", async (request, reply) => {
  try { return await hostedAuth.removeMember(request, (request.params as { id: string }).id); }
  catch (error) { return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 400).send({ error: error instanceof Error ? error.message : "Collaborator access could not be revoked." }); }
});

app.get("/api/workspace/comments", async (request, reply) => {
  const query = request.query as { entityType?: string; entityId?: string };
  if (!query.entityType?.trim() || !query.entityId?.trim()) return reply.code(400).send({ error: "Choose a record to load comments." });
  return await hostedAuth.comments(request, query.entityType, query.entityId);
});

app.post("/api/workspace/comments", async (request, reply) => {
  const body = (request.body ?? {}) as { entityType?: unknown; entityId?: unknown; targetPath?: unknown; body?: unknown };
  if (typeof body.entityType !== "string" || typeof body.entityId !== "string" || typeof body.body !== "string") return reply.code(400).send({ error: "Choose a record and write a comment." });
  try {
    return reply.code(201).send(await hostedAuth.createComment(request, { entityType: body.entityType, entityId: body.entityId, targetPath: typeof body.targetPath === "string" ? body.targetPath : "", body: body.body }));
  } catch (error) {
    return reply.code(typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 400).send({ error: error instanceof Error ? error.message : "Comment could not be added." });
  }
});

app.get("/api/workspace/audit", async (request) => {
  const limit = Number((request.query as { limit?: string }).limit ?? 100);
  return await hostedAuth.auditEvents(request, limit);
});

app.post("/api/imports", async (request, reply) => {
  const parsed = importInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Provide a valid URL, pasted text, or manual source." });
  try {
    return await prepareImport(parsed.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    return reply.code(422).send({ error: message });
  }
});

app.post("/api/capture-queue", async (request, reply) => {
  const parsed = captureQueueBatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Add between 1 and 100 valid job captures." });
  try {
    const inputs = parsed.data.items.map((input) => input.sourceType === "url"
      ? { kind: "url" as const, url: input.url!, applyUrl: input.applyUrl }
      : { kind: "text" as const, text: input.text!, applyUrl: input.applyUrl });
    if (postgresCaptureRepository) {
      const context = trackerContext(request);
      const jobs = await postgresCaptureRepository.enqueue(context, inputs);
      postgresCaptureWorker?.kick();
      return reply.code(202).send(await Promise.all(jobs.map((job) => postgresQueueJobToRecord(context, job, true))));
    }
    const jobs = await captureQueue.enqueueBatch(inputs);
    return reply.code(202).send(jobs.map((job) => queueJobToRecord(job, true)));
  } catch (error) {
    if (error instanceof CaptureQueueCapacityError) return reply.code(409).send({ error: error.message });
    throw error;
  }
});

app.get("/api/capture-queue", async (request) => {
  const query = request.query as { limit?: string; cursor?: string; state?: string };
  const limit = Math.max(1, Math.min(Number(query.limit ?? 50) || 50, 100));
  const state = query.state && captureQueueStatuses.includes(query.state as never) ? query.state as CaptureQueueJob["status"] : undefined;
  if (postgresCaptureRepository) {
    const context = trackerContext(request);
    const [page, queueSummary] = await Promise.all([postgresCaptureRepository.listPage(context, { limit, cursor: query.cursor, state }), postgresCaptureRepository.summary(context)]);
    const counts = Object.fromEntries(captureQueueStatuses.map((itemState) => [itemState, queueSummary.counts[itemState]])) as CaptureQueueSummary["counts"];
    return { items: await Promise.all(page.jobs.map((job) => postgresQueueJobToRecord(context, job, true))), summary: { total: queueSummary.total, active: queueSummary.pending, counts }, nextCursor: page.nextCursor };
  }
  const [page, queueSummary] = await Promise.all([captureQueueStore.listPage({ limit, cursor: query.cursor, state }), captureQueue.summary()]);
  const counts = Object.fromEntries(captureQueueStatuses.map((state) => [state, queueSummary.counts[state]])) as CaptureQueueSummary["counts"];
  return { items: page.jobs.map((job) => queueJobToRecord(job, true)), summary: { total: queueSummary.total, active: queueSummary.pending, counts }, nextCursor: page.nextCursor };
});

app.get("/api/capture-queue/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (postgresCaptureRepository) {
    const context = trackerContext(request), job = await postgresCaptureRepository.get(context, id);
    return job ? await postgresQueueJobToRecord(context, job) : reply.code(404).send({ error: "Capture was not found." });
  }
  const job = await captureQueue.get(id);
  return job ? queueJobToRecord(job) : reply.code(404).send({ error: "Capture was not found." });
});

app.post("/api/capture-queue/:id/retry", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    if (postgresCaptureRepository) {
      const context = trackerContext(request), job = await postgresCaptureRepository.retry(context, id);
      if (!job) return reply.code(409).send({ error: "Capture cannot be retried from its current state." });
      postgresCaptureWorker?.kick();
      return await postgresQueueJobToRecord(context, job);
    }
    return queueJobToRecord(await captureQueue.retry(id));
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "Capture cannot be retried." });
  }
});

app.post("/api/capture-queue/:id/cancel", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    if (postgresCaptureRepository) {
      const context = trackerContext(request), job = await postgresCaptureRepository.cancel(context, id);
      return job ? await postgresQueueJobToRecord(context, job) : reply.code(404).send({ error: "Capture was not found." });
    }
    return queueJobToRecord(await captureQueue.cancel(id));
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "Capture cannot be cancelled." });
  }
});

type CaptureDraftRow = { id: string; sourceType: "url" | "pasted_text"; value: string; error: string | null; createdAt: string; updatedAt: string; revision: number };

function captureDraftRecord(row: CaptureDraftRow): CaptureDraftRecord {
  return row;
}

function readCaptureDraft(id: string) {
  return sqlite.prepare(`SELECT id, source_type AS sourceType, value, error, created_at AS createdAt,
    updated_at AS updatedAt, revision FROM capture_drafts WHERE id = ? AND deleted_at IS NULL`).get(id) as CaptureDraftRow | undefined;
}

app.get("/api/capture-drafts", async (request) => {
  if (postgresCaptureRepository) return postgresCaptureRepository.listDrafts(trackerContext(request));
  const rows = sqlite.prepare(`SELECT id, source_type AS sourceType, value, error, created_at AS createdAt,
    updated_at AS updatedAt, revision FROM capture_drafts WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all() as CaptureDraftRow[];
  return rows.map(captureDraftRecord);
});

app.put("/api/capture-drafts/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "Capture draft ID is invalid." });
  const parsed = captureDraftSaveSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Capture draft is invalid or too large." });
  if (postgresCaptureRepository) {
    const result = await postgresCaptureRepository.saveDraft(trackerContext(request), id, parsed.data);
    return result === "conflict" ? reply.code(409).send({ error: "This capture draft changed in another session. Your text is still here; reload the shared draft before replacing it." }) : result;
  }
  const timestamp = now();
  const existing = sqlite.prepare("SELECT revision FROM capture_drafts WHERE id=?").get(id) as { revision: number } | undefined;
  if (!existing) {
    if (parsed.data.expectedRevision !== undefined) return reply.code(409).send({ error: "This capture draft no longer exists. Reload your drafts before saving." });
    sqlite.prepare(`INSERT INTO capture_drafts (id, source_type, value, error, created_at, updated_at, deleted_at, revision)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, 1)`).run(id, parsed.data.sourceType, parsed.data.value, timestamp, timestamp);
  } else {
    if (parsed.data.expectedRevision === undefined || parsed.data.expectedRevision !== existing.revision) {
      return reply.code(409).send({ error: "This capture draft changed in another session. Your text is still here; reload the shared draft before replacing it." });
    }
    const updated = sqlite.prepare(`UPDATE capture_drafts SET source_type=?,value=?,error=NULL,updated_at=?,deleted_at=NULL,revision=revision+1
      WHERE id=? AND revision=?`).run(parsed.data.sourceType, parsed.data.value, timestamp, id, parsed.data.expectedRevision);
    if (updated.changes !== 1) return reply.code(409).send({ error: "This capture draft changed in another session. Your text is still here; reload the shared draft before replacing it." });
  }
  return captureDraftRecord(readCaptureDraft(id)!);
});

app.delete("/api/capture-drafts/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const expectedRevision = Number((request.query as { expectedRevision?: string }).expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return reply.code(400).send({ error: "The current draft revision is required." });
  if (postgresCaptureRepository) {
    const deleted = await postgresCaptureRepository.deleteDraft(trackerContext(request), id, expectedRevision);
    return deleted ? { deleted: true } : reply.code(409).send({ error: "This capture draft changed in another session. Reload it before discarding it." });
  }
  const timestamp = now();
  const deleted = sqlite.prepare("UPDATE capture_drafts SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL AND revision=?")
    .run(timestamp, timestamp, id, expectedRevision);
  if (deleted.changes !== 1) return reply.code(409).send({ error: "This capture draft changed in another session. Reload it before discarding it." });
  return { deleted: true };
});

app.post("/api/capture-drafts/:id/enqueue", async (request, reply) => {
  const { id } = request.params as { id: string };
  const context = trackerContext(request);
  const draft = postgresCaptureRepository ? await postgresCaptureRepository.getDraft(context, id) : readCaptureDraft(id);
  if (!draft) return reply.code(404).send({ error: "That recoverable capture draft was not found." });
  const inputs = draft.sourceType === "url"
    ? draft.value.split(/\s+/).map((url) => url.trim()).filter(Boolean).map((url) => ({ sourceType: "url" as const, url }))
    : [{ sourceType: "pasted_text" as const, text: draft.value }];
  const parsed = captureQueueBatchSchema.safeParse({ items: inputs });
  if (!parsed.success) return reply.code(400).send({ error: "The recovered capture is not a valid public link or pasted job page." });
  try {
    if (postgresCaptureRepository) {
      const queueInputs = parsed.data.items.map((input) => input.sourceType === "url" ? { kind: "url" as const, url: input.url!, applyUrl: input.applyUrl } : { kind: "text" as const, text: input.text!, applyUrl: input.applyUrl });
      const jobs = await postgresCaptureRepository.enqueueDraft(context, id, queueInputs);
      postgresCaptureWorker?.kick();
      return reply.code(202).send(await Promise.all(jobs.map((job) => postgresQueueJobToRecord(context, job, true))));
    }
    const jobs = await captureQueue.enqueueBatch(parsed.data.items.map((input) => input.sourceType === "url"
      ? { kind: "url" as const, url: input.url!, applyUrl: input.applyUrl }
      : { kind: "text" as const, text: input.text!, applyUrl: input.applyUrl }), () => {
      const timestamp = now();
      sqlite.prepare("UPDATE capture_drafts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL").run(timestamp, timestamp, id);
    });
    return reply.code(202).send(jobs.map((job) => queueJobToRecord(job, true)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The recoverable capture could not be queued.";
    if (postgresCaptureRepository) await postgresCaptureRepository.recordDraftError(context, id, message);
    else sqlite.prepare("UPDATE capture_drafts SET error = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL").run(message, now(), id);
    return reply.code(error instanceof CaptureQueueCapacityError ? 409 : 422).send({ error: message });
  }
});

type CaptureCommitRequest = { id: string; draft?: JobDraft; duplicateAction?: "create_anyway" | "link_existing"; existingJobPostingId?: string };

function commitCaptureRequests(requests: CaptureCommitRequest[]): JobRow[] {
  return sqlite.transaction((items: CaptureCommitRequest[]) => items.map((item) => {
    const queueJob = sqlite.prepare("SELECT state, draft_json AS draftJson FROM capture_queue_items WHERE id = ? AND deleted_at IS NULL").get(item.id) as { state: string; draftJson: string | null } | undefined;
    if (!queueJob) throw new Error("Capture was not found.");
    if (queueJob.state !== "Needs Review" && queueJob.state !== "Duplicate") throw new Error("Capture is not ready for review.");
    const response = queueJob.draftJson ? (JSON.parse(queueJob.draftJson).response as ImportDraftResponse | undefined) : undefined;
    if (!response) throw new Error("Capture review data is unavailable.");
    const draft = jobDraftSchema.parse(item.draft ?? response.draft);
    const importRun = db.select().from(importRuns).where(eq(importRuns.id, response.importRun.id)).get();
    if (!importRun || importRun.state !== "Needs Review") throw new Error("This import has already been committed or is no longer reviewable.");

    const currentDuplicates = findPostingDuplicates(draft);
    const isDuplicate = queueJob.state === "Duplicate" || currentDuplicates.length > 0;
    if (isDuplicate && !item.duplicateAction) throw new Error("Duplicate decision required: choose an existing opportunity or explicitly create another.");

    let result: JobRow | undefined;
    if (item.duplicateAction === "link_existing") {
      if (!item.existingJobPostingId || !currentDuplicates.some((duplicate) => duplicate.id === item.existingJobPostingId)) {
        throw new Error("Choose a matching saved opportunity before linking this capture.");
      }
      result = listRows().find((row) => row.id === item.existingJobPostingId);
    } else {
      const jobId = insertJob(draft, importRun.sourceDocumentId ?? undefined);
      transferImportEvidence(importRun.id, jobId, draft);
      result = listRows().find((row) => row.id === jobId);
    }
    if (!result) throw new Error("The saved opportunity could not be read back.");
    const timestamp = now();
    db.update(importRuns).set({ state: "Committed", updatedAt: timestamp, revision: importRun.revision + 1 }).where(eq(importRuns.id, importRun.id)).run();
    const queueUpdated = sqlite.prepare(`UPDATE capture_queue_items SET state = 'Saved', progress = 10000, progress_message = NULL,
      completed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND state IN ('Needs Review', 'Duplicate')`).run(timestamp, timestamp, item.id);
    if (queueUpdated.changes !== 1) throw new Error("Capture changed before it could be saved.");
    return result;
  }))(requests);
}

function refreshBatchDuplicateConflicts(requests: CaptureCommitRequest[]) {
  const conflicts: Array<{ id: string; error: string; duplicates: ImportDraftResponse["duplicates"] }> = [];
  for (const item of requests) {
    const queueJob = sqlite.prepare("SELECT state, draft_json AS draftJson FROM capture_queue_items WHERE id = ? AND deleted_at IS NULL").get(item.id) as { state: string; draftJson: string | null } | undefined;
    if (!queueJob || !queueJob.draftJson || (queueJob.state !== "Needs Review" && queueJob.state !== "Duplicate")) continue;
    const result = JSON.parse(queueJob.draftJson) as { response?: ImportDraftResponse };
    if (!result.response) continue;
    const draft = item.draft ?? result.response.draft;
    const duplicates = findPostingDuplicates(draft);
    if (!duplicates.length || item.duplicateAction) continue;
    result.response.duplicates = duplicates;
    sqlite.prepare(`UPDATE capture_queue_items SET state = 'Duplicate', draft_json = ?, error = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND state IN ('Needs Review', 'Duplicate')`).run(
      JSON.stringify(result),
      "A matching saved opportunity appeared after this capture was reviewed. Choose how to handle it.",
      now(),
      item.id,
    );
    conflicts.push({ id: item.id, error: "Duplicate decision required.", duplicates });
  }
  return conflicts;
}

app.post("/api/capture-queue/commit-batch", async (request, reply) => {
  const parsed = captureBatchCommitSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Select one or more valid captures to save." });
  try {
    if (postgresCaptureRepository) {
      const context = trackerContext(request);
      const committed = await postgresCaptureRepository.commit(context, parsed.data.items as PostgresCaptureCommitRequest[]);
      const ids = new Set(committed.map((row) => String(row.id)));
      const rows = (await trackerRepository.listJobs(context)).filter((row) => ids.has(String(row.id))).map((row) => rowToJob(row));
      return reply.code(201).send(rows);
    }
    return reply.code(201).send(commitCaptureRequests(parsed.data.items));
  } catch (error) {
    if (postgresCaptureRepository) {
      const conflict = error as Error & { captureId?: string; duplicates?: ImportDraftResponse["duplicates"] };
      const conflicts = conflict.duplicates ? [{ id: conflict.captureId ?? "", error: "Duplicate decision required.", duplicates: conflict.duplicates }] : [];
      return reply.code(409).send({ error: conflict.message || "The capture batch could not be saved.", conflicts });
    }
    const conflicts = refreshBatchDuplicateConflicts(parsed.data.items);
    return reply.code(409).send({ error: conflicts.length ? `${conflicts.length} capture${conflicts.length === 1 ? "" : "s"} need a duplicate decision before this batch can be saved.` : error instanceof Error ? error.message : "The capture batch could not be saved.", conflicts });
  }
});

app.post("/api/capture-queue/:id/commit", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = captureCommitSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The reviewed job data is incomplete." });
  try {
    if (postgresCaptureRepository) {
      const context = trackerContext(request);
      const committed = await postgresCaptureRepository.commit(context, [{ id, ...parsed.data }]);
      const savedId = String(committed[0]?.id ?? "");
      const row = (await trackerRepository.listJobs(context)).find((candidate) => String(candidate.id) === savedId);
      if (!row) throw new Error("The saved opportunity could not be read back.");
      return reply.code(201).send(rowToJob(row));
    }
    return reply.code(201).send(commitCaptureRequests([{ id, ...parsed.data }])[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The capture could not be saved.";
    return reply.code(message === "Capture was not found." ? 404 : 409).send({ error: message });
  }
});

app.get("/api/discovery", async (request, reply) => {
  const parsed = discoveryQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: "The discovery filters were invalid." });
  if (postgresDiscoveryQuery) {
    const context = trackerContext(request);
    await postgresDiscoveryRepository!.ensureStarterSources(context);
    return postgresDiscoveryQuery.workspace(context, parsed.data);
  }
  return sqliteDiscovery().workspace(parsed.data);
});

app.post("/api/discovery/sources", async (request, reply) => {
  const parsed = discoverySourceCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Add a valid approved public careers source." });
  try {
    if (postgresDiscoveryRepository) return reply.code(201).send(await postgresDiscoveryRepository.createSource(trackerContext(request), parsed.data));
    return reply.code(201).send(sqliteDiscovery().createSource(parsed.data));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "The source could not be added." });
  }
});

app.post("/api/discovery/runs", async (request, reply) => {
  const body = (request.body ?? {}) as { sourceId?: unknown };
  const sourceId = typeof body.sourceId === "string" && body.sourceId ? body.sourceId : undefined;
  try {
    const context = trackerContext(request);
    if (postgresDiscoveryRepository) await postgresDiscoveryRepository.ensureStarterSources(context);
    const runs = postgresDiscovery ? await runHostedDiscoveryForContext(context, sourceId) : await sqliteDiscovery().run(sourceId);
    if (sourceId && runs.length === 0) return reply.code(409).send({ error: "That source is already being checked or is not currently available." });
    return runs;
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "Discovery could not run." });
  }
});

app.post("/api/discovery/postings/:id/save", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (postgresDiscoveryQuery && runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    const posting = await runtimeDataProvider.postgres.transaction(context, async (tx) => (await tx.query<Record<string, unknown>>(
      "SELECT * FROM discovered_postings WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [context.workspaceId, id],
    )).rows[0] ?? null, { readOnly: true });
    if (!posting) return reply.code(404).send({ error: "Discovered posting was not found." });
    if (posting.saved_job_posting_id) return reply.code(409).send({ error: "This posting is already saved in Opportunities." });
    const sourceUrl = String(posting.canonical_url ?? "");
    const applyUrl = String(posting.apply_url || posting.canonical_url || "");
    const text = `${posting.title}\nCompany: ${posting.company_name}\nLocation: ${posting.location ?? ""}\nPosted: ${posting.source_posted_at ?? ""}\nDeadline: ${posting.deadline_at ?? ""}\nApply: ${applyUrl}\n\n${posting.description ?? ""}`;
    const startedAt = Date.now();
    const deterministicDraft = jobDraftSchema.parse(extractJobDraft(text, sourceUrl, applyUrl));
    const enrichmentStartedAt = Date.now();
    const enrichment = await enrichJobDraft({ provider: aiProvider, deterministicDraft, text, sourceUrl });
    const durationMs = Date.now() - enrichmentStartedAt;
    const validDate = (value: unknown) => {
      const candidate = String(value ?? "");
      return /^\d{4}-\d{2}-\d{2}/.test(candidate) ? candidate.slice(0, 10) : "";
    };
    const reviewedDraft = jobDraftSchema.parse({
      ...enrichment.draft,
      title: String(posting.title), companyName: String(posting.company_name), location: String(posting.location ?? ""),
      sourceUrl, applyUrl, postingDate: validDate(posting.source_posted_at), applicationDeadline: validDate(posting.deadline_at),
    });
    const importId = randomUUID();
    const sourceDocumentId = randomUUID();
    await runtimeDataProvider.postgres.transaction(context, async (tx) => {
      await tx.query(`INSERT INTO source_documents(id,workspace_id,source_type,url,raw_text,content_hash,captured_at,metadata)
        VALUES($1,$2,'pasted_text',$3,$4,$5,now(),$6)`, [sourceDocumentId, context.workspaceId, sourceUrl, text, contentHash(text), { discoveryPostingId: id }]);
      await tx.query(`INSERT INTO import_runs(id,workspace_id,source_type,source_url,state,source_document_id,discovery_posting_id)
        VALUES($1,$2,'pasted_text',$3,'Needs Review',$4,$5)`, [importId, context.workspaceId, sourceUrl, sourceDocumentId, id]);
      for (const item of enrichment.evidence) await tx.query(`INSERT INTO field_evidence
        (id,workspace_id,entity_type,entity_id,field_path,source_document_id,excerpt,method,suggested_value,confidence,user_confirmed,captured_at)
        VALUES($1,$2,'ImportRun',$3,$4,$5,$6,'ai_generated',$7,$8,false,now())`, [
        randomUUID(), context.workspaceId, importId, item.fieldPath, sourceDocumentId, item.excerpt, item.suggestedValue, item.confidence,
      ]);
    });
    const totalDurationMs = Date.now() - startedAt;
    const aiRun = await recordHostedAiRun(context, {
      operation: "job_import", contextId: importId, sourceType: "pasted_text", state: aiRunState(enrichment.mode, !aiProvider.configured),
      provider: enrichment.provider ?? aiProvider.name, model: enrichment.model ?? aiProvider.model, durationMs, totalDurationMs,
      evidenceCount: enrichment.evidence.length, warning: enrichment.warning ?? "",
    });
    return {
      importRun: { id: importId, state: "Needs Review", sourceType: "pasted_text", sourceUrl, error: null },
      draft: reviewedDraft, duplicates: await postgresCaptureRepository!.savedDuplicates(context, reviewedDraft),
      enrichment: { mode: enrichment.mode, provider: enrichment.provider, model: enrichment.model, warning: enrichment.warning, evidenceCount: enrichment.evidence.length, aiRunId: aiRun?.id ?? null, durationMs, totalDurationMs },
      fieldEvidence: enrichment.evidence.map((item) => ({ fieldPath: item.fieldPath, excerpt: item.excerpt, confidence: item.confidence, method: "ai_generated" as const })),
      discoveryPostingId: id,
    };
  }
  const posting = sqliteDiscovery().getPosting(id);
  if (!posting) return reply.code(404).send({ error: "Discovered posting was not found." });
  if (posting.savedJobPostingId) return reply.code(409).send({ error: "This posting is already saved in Opportunities." });
  try {
    const review = await prepareImport({
      sourceType: "pasted_text",
      text: `${posting.title}\nCompany: ${posting.companyName}\nLocation: ${posting.location}\nPosted: ${posting.sourcePostedAt ?? ""}\nDeadline: ${posting.deadlineAt ?? ""}\nApply: ${posting.applyUrl || posting.canonicalUrl}\n\n${posting.description}`,
      applyUrl: posting.applyUrl || posting.canonicalUrl,
    }, id);
    return { ...review, discoveryPostingId: id };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "The discovered posting could not be prepared for review." });
  }
});

app.patch("/api/discovery/postings/:id/hidden", async (request, reply) => {
  const hidden = (request.body as { hidden?: unknown } | null)?.hidden;
  if (typeof hidden !== "boolean") return reply.code(400).send({ error: "Choose whether to hide or restore this posting." });
  if (postgresDiscoveryQuery && runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    const id = (request.params as { id: string }).id;
    const expected = Number((request.body as { expectedRevision?: unknown }).expectedRevision);
    const revision = Number.isInteger(expected) && expected > 0 ? expected : await runtimeDataProvider.postgres.transaction(context, async (tx) => Number((await tx.query<{ revision: number }>(
      "SELECT revision FROM discovered_postings WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [context.workspaceId, id],
    )).rows[0]?.revision ?? 0), { readOnly: true });
    if (!revision) return reply.code(404).send({ error: "Discovered posting was not found." });
    try { return await postgresDiscoveryQuery.setPostingHidden(context, id, hidden, revision); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Posting changed before it could be updated." }); }
  }
  const posting = sqliteDiscovery().setHidden((request.params as { id: string }).id, hidden);
  return posting ?? reply.code(404).send({ error: "Discovered posting was not found." });
});

app.post("/api/discovery/postings/:id/issues", async (request, reply) => {
  const parsed = discoveryIssueCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Describe what is incorrect in at least three characters." });
  if (postgresDiscoveryRepository) {
    try { return reply.code(201).send(await postgresDiscoveryRepository.reportIssue(trackerContext(request), (request.params as { id: string }).id, parsed.data.reason)); }
    catch { return reply.code(404).send({ error: "Discovered posting was not found." }); }
  }
  const issue = sqliteDiscovery().reportIssue((request.params as { id: string }).id, parsed.data.reason);
  return issue ? reply.code(201).send(issue) : reply.code(404).send({ error: "Discovered posting was not found." });
});

app.post("/api/alerts/rules", async (request, reply) => {
  const parsed = alertRuleCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The alert rule is incomplete." });
  if (postgresDiscoveryRepository) return reply.code(201).send(await postgresDiscoveryRepository.createRule(trackerContext(request), parsed.data));
  return reply.code(201).send(sqliteDiscovery().createRule(parsed.data));
});

app.patch("/api/alerts/rules/:id", async (request, reply) => {
  const parsed = alertRuleUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The alert rule update is incomplete." });
  try {
    if (postgresDiscoveryQuery && runtimeDataProvider.name === "postgres") {
      const context = trackerContext(request); const id = (request.params as { id: string }).id;
      const current = (await postgresDiscoveryQuery.workspace(context, { limit: 1 })).alertRules.find((item) => item.id === id);
      if (!current) return reply.code(404).send({ error: "Alert rule not found." });
      if (parsed.data.expectedRevision != null && parsed.data.expectedRevision !== current.revision) return reply.code(409).send({ error: "The alert rule changed before it could be saved." });
      const updated = { ...current, ...parsed.data };
      const { name, enabled, telegramEnabled, expectedRevision: _expectedRevision, id: _id, createdAt: _createdAt, updatedAt: _updatedAt, revision: _revision, ...criteria } = updated;
      await runtimeDataProvider.postgres.transaction(context, async (tx) => {
        const result = await tx.query(`UPDATE alert_rules SET name=$4,enabled=$5,telegram_enabled=$6,criteria_json=$7,updated_at=now(),revision=revision+1
          WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`, [context.workspaceId, id, current.revision, name, enabled, telegramEnabled, criteria]);
        if (result.rowCount !== 1) throw new Error("The alert rule changed before it could be saved.");
      });
      return (await postgresDiscoveryQuery.workspace(context, { limit: 1 })).alertRules.find((item) => item.id === id);
    }
    const updated = sqliteDiscovery().updateRule((request.params as { id: string }).id, parsed.data);
    return updated ?? reply.code(404).send({ error: "Alert rule not found." });
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "The alert rule changed before it could be saved." });
  }
});

app.delete("/api/alerts/rules/:id", async (request, reply) => {
  const expectedRevision = Number((request.body as { expectedRevision?: unknown } | null)?.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return reply.code(400).send({ error: "The alert rule revision is required." });
  try {
    if (runtimeDataProvider.name === "postgres") {
      const context = trackerContext(request); const id = (request.params as { id: string }).id;
      const removed = await runtimeDataProvider.postgres.transaction(context, (tx) => tx.query(`UPDATE alert_rules SET deleted_at=now(),updated_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`, [context.workspaceId, id, expectedRevision]));
      return removed.rowCount ? reply.code(204).send() : reply.code(404).send({ error: "Alert rule not found or changed." });
    }
    const removed = sqliteDiscovery().deleteRule((request.params as { id: string }).id, expectedRevision);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Alert rule not found." });
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "The alert rule changed before it could be deleted." });
  }
});

app.patch("/api/alerts/:id/read", async (request, reply) => {
  const read = (request.body as { read?: unknown } | null)?.read;
  if (typeof read !== "boolean") return reply.code(400).send({ error: "Choose whether this alert is read or unread." });
  const alert = postgresDiscoveryQuery ? await postgresDiscoveryQuery.markAlertRead(trackerContext(request), (request.params as { id: string }).id, read) : sqliteDiscovery().markAlertRead((request.params as { id: string }).id, read);
  return alert ?? reply.code(404).send({ error: "Alert not found." });
});

app.get("/api/settings/telegram", async (request) => {
  if (runtimeDataProvider.name === "sqlite") return {
    hosted: false,
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
    chatIdHint: process.env.TELEGRAM_CHAT_ID?.trim() ? `••••${process.env.TELEGRAM_CHAT_ID!.trim().slice(-4)}` : "",
    lastTestedAt: null,
    lastSuccessfulTestAt: null,
    lastError: "",
    updatedAt: null,
  };
  if (!postgresTelegramSettings) return { hosted: true, configured: false, chatIdHint: "", lastTestedAt: null, lastSuccessfulTestAt: null, lastError: "Server encryption is not configured.", updatedAt: null };
  return postgresTelegramSettings.status(trackerContext(request));
});

app.put("/api/settings/telegram", async (request, reply) => {
  if (runtimeDataProvider.name !== "postgres") return reply.code(409).send({ error: "Local Telegram is configured through the local environment." });
  if (!postgresTelegramSettings) return reply.code(503).send({ error: "The server integration encryption key is not configured." });
  const parsed = telegramSettingsUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid Telegram bot token and chat ID." });
  try { return await postgresTelegramSettings.save(trackerContext(request), parsed.data); }
  catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : "Telegram settings could not be saved." }); }
});

app.delete("/api/settings/telegram", async (request, reply) => {
  if (runtimeDataProvider.name !== "postgres") return reply.code(409).send({ error: "Local Telegram is configured through the local environment." });
  if (!postgresTelegramSettings) return reply.code(503).send({ error: "The server integration encryption key is not configured." });
  return postgresTelegramSettings.remove(trackerContext(request));
});

app.post("/api/alerts/test", async (_request, reply) => {
  try {
    if (postgresDiscoveryRepository && postgresDiscovery && postgresDiscoveryQuery) {
      const context = trackerContext(_request);
      if (!postgresTelegramSettings) return reply.code(503).send({ error: "Telegram setup is unavailable until server-side integration encryption is configured." });
      if (!await postgresTelegramSettings.resolve(context)) return reply.code(409).send({ error: "Configure Telegram for this workspace before sending a test." });
      const appUrl = process.env.CAREEROS_APP_URL?.trim() ?? "";
      if (!appUrl) return reply.code(503).send({ error: "Set a public CAREEROS_APP_URL before testing Telegram links." });
      let safeAppUrl: string;
      try {
        safeAppUrl = (await preflightPublicAppUrl(assertSafeDirectUrl(appUrl).toString())).url;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The public CareerOS address could not be reached safely.";
        return reply.code(503).send({ error: message });
      }
      const created = await postgresDiscoveryRepository.createTestAlert(context, safeAppUrl);
      await postgresDiscovery.dispatchTelegram(context, { deliveryId: created.telegramDeliveryId });
      const alert = (await postgresDiscoveryQuery.workspace(context, { limit: 1 })).alerts.find((item) => item.id === created.eventId);
      const delivery = alert?.deliveries.find((item) => item.id === created.telegramDeliveryId);
      if (!alert || delivery?.state !== "Delivered") {
        const message = delivery?.lastError || "Telegram did not confirm delivery.";
        await postgresTelegramSettings.recordTest(context, message);
        return reply.code(502).send({ error: message });
      }
      await postgresTelegramSettings.recordTest(context);
      return alert;
    }
    return await sqliteDiscovery().sendTestAlert();
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "The test alert could not be sent." });
  }
});

app.get("/api/alerts/deliveries", async (request) => {
  const query = (request.query ?? {}) as { limit?: string; cursor?: string };
  const requestedLimit = query.limit ? Number(query.limit) : undefined;
  if (postgresDiscoveryQuery) return postgresDiscoveryQuery.listDeliveryHistory(trackerContext(request), {
    limit: Number.isInteger(requestedLimit) ? requestedLimit : undefined, cursor: typeof query.cursor === "string" ? query.cursor : undefined,
  });
  return sqliteDiscovery().listNotificationDeliveries({
    limit: Number.isInteger(requestedLimit) ? requestedLimit : undefined,
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
  });
});

app.post("/api/alerts/deliveries/:id/retry", async (request, reply) => {
  try {
    const confirmPossibleDuplicate = (request.body as { confirmPossibleDuplicate?: unknown } | null)?.confirmPossibleDuplicate === true;
    if (postgresDiscoveryRepository && postgresDiscovery && postgresDiscoveryQuery) {
      const context = trackerContext(request); const id = (request.params as { id: string }).id;
      await postgresDiscoveryRepository.retryTelegramDelivery(context, id, confirmPossibleDuplicate);
      await postgresDiscovery.dispatchTelegram(context, { deliveryId: id });
      const page = await postgresDiscoveryQuery.listDeliveryHistory(context, { limit: 100 });
      return page.items.find((item) => item.id === id) ?? reply.code(404).send({ error: "Telegram delivery was not found." });
    }
    return await sqliteDiscovery().retryTelegramDelivery((request.params as { id: string }).id, confirmPossibleDuplicate);
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "The delivery could not be retried." });
  }
});

app.post("/api/imports/:id/commit", async (request, reply) => {
  const { id: importId } = request.params as { id: string };
  const wrapped = captureCommitSchema.safeParse(request.body);
  const legacy = jobDraftSchema.safeParse(request.body);
  if (!wrapped.success && !legacy.success) return reply.code(400).send({ error: "The reviewed job data is incomplete." });
  const input = wrapped.success ? wrapped.data : { draft: legacy.data! };
  if (runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    const duplicates = await postgresCaptureRepository!.savedDuplicates(context, input.draft);
    if (duplicates.length && (!wrapped.success || !wrapped.data.duplicateAction)) {
      return reply.code(409).send({ error: "Duplicate decision required: choose an existing opportunity or explicitly create another.", duplicates });
    }
    try {
      const jobId = await runtimeDataProvider.postgres.transaction(context, async (tx) => {
      const run = (await tx.query<{ discovery_posting_id: string | null; state: string; source_document_id: string | null }>(
        "SELECT discovery_posting_id,state,source_document_id FROM import_runs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [context.workspaceId, importId],
      )).rows[0];
      if (!run || !run.discovery_posting_id) throw Object.assign(new Error("Use the durable Capture Inbox to commit hosted imports."), { statusCode: 409 });
      if (run.state !== "Needs Review") throw Object.assign(new Error("This import has already been committed or is no longer reviewable."), { statusCode: 409 });
      const discoveredPostingId = run.discovery_posting_id;
      const posting = (await tx.query<{ saved_job_posting_id: string | null }>(
        "SELECT saved_job_posting_id FROM discovered_postings WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [context.workspaceId, discoveredPostingId],
      )).rows[0];
      if (!posting) throw Object.assign(new Error("Discovered posting was not found."), { statusCode: 404 });
      if (posting.saved_job_posting_id) throw Object.assign(new Error("This posting is already saved in Opportunities."), { statusCode: 409 });
      const draft = input.draft;
      if (wrapped.success && wrapped.data.duplicateAction === "link_existing") {
        const existingId = wrapped.data.existingJobPostingId;
        if (!existingId || !duplicates.some((candidate) => candidate.id === existingId)) throw Object.assign(new Error("Choose a matching saved opportunity before linking this posting."), { statusCode: 409 });
        await tx.query("UPDATE discovered_postings SET saved_job_posting_id=$3,updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2", [context.workspaceId, discoveredPostingId, existingId]);
        await tx.query("UPDATE import_runs SET state='Committed',updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2", [context.workspaceId, importId]);
        await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
          VALUES($1,$2,$3,'discovery.posting_linked','JobPosting',$4,'Linked a discovered posting to an existing opportunity',$5)`, [randomUUID(), context.workspaceId, context.userId, existingId, { discoveredPostingId }]);
        return existingId;
      }
      const companyName = draft.companyName.trim() || "Unknown company";
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`company:${context.workspaceId}:${companyName.toLowerCase()}`]);
      let companyId = (await tx.query<{ id: string }>("SELECT id FROM companies WHERE workspace_id=$1 AND lower(name)=lower($2) AND deleted_at IS NULL FOR UPDATE", [context.workspaceId, companyName])).rows[0]?.id;
      if (!companyId) {
        companyId = randomUUID();
        await tx.query("INSERT INTO companies(id,workspace_id,name,snapshot,description) VALUES($1,$2,$3,$4,$5)", [companyId, context.workspaceId, companyName, draft.companySnapshot, draft.companyDescription]);
      }
      const id = randomUUID();
      const columns = ["id","workspace_id","company_id","title","requisition_id","location","country","region","work_mode","employment_type","seniority","sector","role_family","division","team","summary","description","required_requirements","preferred_requirements","process_summary","visa_requirements","source_url","apply_url","referral_source","recruiter_contact","application_deadline","posting_date","expiry_date","last_checked_at","posting_state","notes"];
      const values = [id,context.workspaceId,companyId,draft.title,draft.requisitionId,draft.location,draft.country,draft.region,draft.workMode,draft.employmentType,draft.seniority,draft.sector,draft.roleFamily,draft.division,draft.team,draft.summary,draft.description,JSON.stringify(draft.requiredRequirements),JSON.stringify(draft.preferredRequirements),draft.processSummary,draft.visaRequirements,draft.sourceUrl,draft.applyUrl,draft.referralSource,draft.recruiterContact,draft.applicationDeadline||null,draft.postingDate||null,draft.expiryDate||null,draft.lastCheckedAt||null,draft.postingState,""];
      await tx.query(`INSERT INTO job_postings(${columns.join(",")}) VALUES(${values.map((_,index) => `$${index + 1}`).join(",")})`, values as never[]);
      await tx.query("UPDATE discovered_postings SET saved_job_posting_id=$3,updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2", [context.workspaceId, discoveredPostingId, id]);
      await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
        VALUES($1,$2,$3,'discovery.posting_saved','JobPosting',$4,'Saved a discovered posting',$5)`, [randomUUID(), context.workspaceId, context.userId, id, { discoveredPostingId }]);
      const evidence = await tx.query<{ field_path: string; source_document_id: string | null; excerpt: string; method: string; confidence: number }>(
        "SELECT field_path,source_document_id,excerpt,method,confidence FROM field_evidence WHERE workspace_id=$1 AND entity_type='ImportRun' AND entity_id=$2 AND deleted_at IS NULL",
        [context.workspaceId, importId],
      );
      for (const item of evidence.rows) await tx.query(`INSERT INTO field_evidence
        (id,workspace_id,entity_type,entity_id,field_path,source_document_id,excerpt,method,suggested_value,confidence,user_confirmed,captured_at)
        VALUES($1,$2,'JobPosting',$3,$4,$5,$6,$7,$8,$9,true,now())`, [
        randomUUID(), context.workspaceId, id, item.field_path, item.source_document_id, item.excerpt, item.method,
        serialiseDraftField(draft, item.field_path), item.confidence,
      ]);
      await tx.query("UPDATE import_runs SET state='Committed',updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2", [context.workspaceId, importId]);
      return id;
    });
    const row = (await trackerRepository.listJobs(context)).find((candidate) => String(candidate.id) === jobId);
    return reply.code(201).send(row ? rowToJob(row) : { id: jobId });
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 409;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "The discovered posting could not be saved." });
    }
  }
  const importRun = db.select().from(importRuns).where(eq(importRuns.id, importId)).get();
  if (importId !== "manual" && (!importRun || importRun.state !== "Needs Review")) {
    return reply.code(409).send({ error: "This import has already been committed or is no longer reviewable." });
  }
  const duplicates = findPostingDuplicates(input.draft);
  if (duplicates.length && !input.duplicateAction) return reply.code(409).send({ error: "Duplicate decision required: choose the saved opportunity or explicitly create another." });
  if (input.duplicateAction === "link_existing" && (!input.existingJobPostingId || !duplicates.some((duplicate) => duplicate.id === input.existingJobPostingId))) {
    return reply.code(409).send({ error: "Choose a matching saved opportunity before linking this import." });
  }
  const id = sqlite.transaction(() => {
    const jobId = input.duplicateAction === "link_existing" ? input.existingJobPostingId! : insertJob(input.draft, importRun?.sourceDocumentId ?? undefined);
    if (importRun && input.duplicateAction !== "link_existing") transferImportEvidence(importId, jobId, input.draft);
    if (importRun) db.update(importRuns).set({ state: "Committed", updatedAt: now(), revision: importRun.revision + 1 }).where(eq(importRuns.id, importId)).run();
    if (importRun?.discoveryPostingId) sqliteDiscovery().markSaved(importRun.discoveryPostingId, jobId);
    return jobId;
  })();
  const rows = listRows({ search: input.draft.title });
  const created = rows.find((row) => row.id === id);
  return reply.code(201).send(created);
});

app.post("/api/jobs", async (request, reply) => {
  const parsed = jobDraftSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "The job data is incomplete." });
  const context = trackerContext(request);
  const id = await trackerRepository.createJob(context, parsed.data);
  const created = (await trackerRepository.listJobs(context)).find((row) => row.id === id);
  return reply.code(201).send(created ? rowToJob(created) : { id });
});

app.patch("/api/jobs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = jobUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid job update." });
  const input = parsed.data;
  if (hostedAuth.enabled && input.expectedRevision == null) return reply.code(428).send({ error: "Reload this opportunity before saving shared changes." });
  const context = trackerContext(request);
  const currentRevision = input.expectedRevision ?? Number((await trackerRepository.listJobs(context)).find((row) => row.id === id)?.revision ?? 0);
  const result = await trackerRepository.updateJob(context, id, currentRevision, input);
  if (result === "not_found") return reply.code(404).send({ error: "Job posting not found." });
  if (result === "conflict") return reply.code(409).send({ error: "This opportunity changed in another session. Reload before saving so nobody's work is overwritten." });
  return await getRuntimeJobDetail(request, id);
});

function valueOrUndefined(value: Record<string, unknown>, key: string) {
  return value[key];
}

app.post("/api/jobs/:id/tasks", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  const context = trackerContext(request);
  if (!(await trackerRepository.listJobs(context)).some((job) => job.id === jobPostingId)) return reply.code(404).send({ error: "Job posting not found." });
  const parsed = taskCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Add a task title and check its details." });
  const task = await trackerRepository.createTask(context, jobPostingId, parsed.data);
  return reply.code(201).send({ ...task, completed: Boolean(task.completedAt) });
});

app.get("/api/tasks/:id", async (request, reply) => {
  const task = await trackerRepository.getTask(trackerContext(request), (request.params as { id: string }).id);
  if (!task) return reply.code(404).send({ error: "Task not found." });
  return { ...task, completed: Boolean(task.completedAt) };
});

app.patch("/api/tasks/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = taskUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid task update." });
  if (parsed.data.expectedRevision == null) return reply.code(428).send({ error: "Reload this task before saving shared changes." });
  const task = await trackerRepository.updateTask(trackerContext(request), id, parsed.data.expectedRevision, parsed.data);
  if (!task) return reply.code(404).send({ error: "Task not found." });
  if (task === "conflict") return reply.code(409).send({ error: "This task changed in another session. Refresh it before saving so nobody's work is overwritten." });
  return { ...task, completed: Boolean(task.completedAt) };
});

function persistSalaryEstimate(jobPostingId: string, input: SalaryEstimateCreateInput, evidence: SalaryResearchEvidence[] = []) {
  const parsed = salaryEstimateCreateSchema.parse(input);
  const timestamp = now();
  const id = randomUUID();
  const transaction = sqlite.transaction(() => {
    db.insert(salaryEstimates).values({
      id, jobPostingId, ...parsed,
      minAmount: parsed.minAmount ?? null,
      maxAmount: parsed.maxAmount ?? null,
      baseMinAmount: parsed.baseMinAmount ?? null,
      baseMaxAmount: parsed.baseMaxAmount ?? null,
      totalCompMinAmount: parsed.totalCompMinAmount ?? null,
      totalCompMaxAmount: parsed.totalCompMaxAmount ?? null,
      baseSalary: parsed.baseSalary ?? null,
      bonus: parsed.bonus ?? null,
      annualisedEquivalent: parsed.annualisedEquivalent ?? null,
      createdAt: timestamp, updatedAt: timestamp, revision: 1,
    }).run();
    for (const item of evidence) {
      db.insert(salaryResearchEvidence).values({
        id: randomUUID(), salaryEstimateId: id, ...item, createdAt: timestamp,
      }).run();
    }
  });
  transaction();
  return getJobDetail(jobPostingId)?.salaries.find((salary) => salary.id === id) ?? null;
}

app.post("/api/jobs/:id/salary-estimates", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  if (!listRows().some((job) => job.id === jobPostingId)) return reply.code(404).send({ error: "Job posting not found." });
  const parsed = salaryEstimateCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Check the compensation amounts and source." });
  return reply.code(201).send(persistSalaryEstimate(jobPostingId, parsed.data));
});

app.post("/api/jobs/:id/salary-research", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  const job = listRows().find((item) => item.id === jobPostingId);
  if (!job) return reply.code(404).send({ error: "Job posting not found." });
  if (!aiProvider.configured || !aiProvider.researchSalary) {
    return reply.code(503).send({ error: "AI web research is not configured. Start CareerOS with the AI key enabled." });
  }
  const startedAt = Date.now();
  try {
    const researched = await aiProvider.researchSalary({
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      country: job.country,
      region: job.region,
      seniority: job.seniority,
      roleFamily: job.roleFamily,
      summary: job.summary,
    });
    const durationMs = Date.now() - startedAt;
    const proposal = salaryResearchProposalSchema.parse({
      ...researched,
      jobPostingId,
      researchedAt: now(),
      durationMs,
    });
    recordAiRun({
      operation: "salary_research",
      contextId: jobPostingId,
      sourceType: "web_search",
      state: "completed",
      provider: proposal.provider,
      model: proposal.model,
      durationMs,
      totalDurationMs: durationMs,
      evidenceCount: proposal.evidence.length,
      warning: proposal.warnings.join(" "),
    });
    return proposal;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Salary research failed.";
    recordAiRun({
      operation: "salary_research", contextId: jobPostingId, sourceType: "web_search", state: "fallback",
      provider: aiProvider.name, model: aiProvider.model, durationMs: Date.now() - startedAt,
      totalDurationMs: Date.now() - startedAt, evidenceCount: 0, warning: message,
    });
    return reply.code(422).send({ error: message });
  }
});

app.post("/api/jobs/:id/salary-research/commit", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  if (!listRows().some((job) => job.id === jobPostingId)) return reply.code(404).send({ error: "Job posting not found." });
  const parsed = salaryResearchProposalSchema.safeParse(request.body);
  if (!parsed.success || parsed.data.jobPostingId !== jobPostingId) {
    return reply.code(400).send({ error: "The salary proposal is invalid or belongs to another role." });
  }
  const saved = persistSalaryEstimate(jobPostingId, parsed.data.estimate, parsed.data.evidence);
  return reply.code(201).send(saved);
});

app.post("/api/jobs/:id/recheck", async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = listRows().find((item) => item.id === id);
  if (!job) return reply.code(404).send({ error: "Job posting not found." });
  const url = job.sourceUrl || job.applyUrl;
  if (!url) return reply.code(400).send({ error: "Add a source or Apply Now link before checking this posting." });
  try {
    const captured = await captureUrl(url);
    const checkedAt = now();
    db.insert(sourceDocuments).values({
      id: sourceId(), sourceType: "source_recheck", url: captured.url,
      rawText: captured.rawText, contentHash: contentHash(captured.rawText), capturedAt: checkedAt,
      metadata: JSON.stringify(captured.metadata),
    }).run();
    db.update(jobPostings).set({ lastCheckedAt: checkedAt, updatedAt: checkedAt, revision: sql`${jobPostings.revision} + 1` }).where(eq(jobPostings.id, id)).run();
    return { ok: true, checkedAt, resolvedUrl: captured.url ?? url, pageTitle: captured.metadata.title ?? "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The source could not be checked.";
    return reply.code(422).send({ error: message });
  }
});

app.post("/api/jobs/:id/applications", async (request, reply) => {
  const { id: jobPostingId } = request.params as { id: string };
  const parsed = applicationCreateSchema.safeParse({ ...(request.body as object), jobPostingId });
  if (!parsed.success) return reply.code(400).send({ error: "Invalid application." });
  const result = await trackerRepository.createApplication(trackerContext(request), jobPostingId, parsed.data);
  const detail = await getRuntimeJobDetail(request, jobPostingId);
  return reply.code(result.created ? 201 : 200).send(detail);
});

app.post("/api/applications/:id/events", async (request, reply) => {
  const { id: applicationId } = request.params as { id: string };
  const parsed = eventSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid application event." });
  const timestamp = now();
  const statusAfter = statusFromEvent[parsed.data.type];
  const event = await trackerRepository.appendApplicationEvent(trackerContext(request), applicationId, { type: parsed.data.type, statusAfter, occurredAt: parsed.data.occurredAt ?? timestamp, note: parsed.data.note });
  if (!event) return reply.code(404).send({ error: "Application not found." });
  return reply.code(201).send(event);
});

app.get("/api/export", async (request) => {
  const session = hostedAuth.requireSession(request);
  if (runtimeDataProvider.name === "postgres") {
    const bundle = await createPostgresWorkspaceBundle({
      provider: runtimeDataProvider.postgres,
      storage: configuredStorage.adapter,
      context: trackerContext(request),
      schemaVersion: postgresSchemaVersion!,
      applicationVersion: "0.1.0",
    });
    await hostedAuth.audit(session, "workspace.exported", "Workspace", session.workspaceId, "Exported a complete workspace backup", {});
    return bundle;
  }
  await hostedAuth.audit(session, "workspace.exported", "Workspace", session.workspaceId, "Exported a complete workspace backup", {});
  const bundle = await mutationGate.run(() => createStorageBackedBundle(), { waitForExclusive: true });
  const data = Object.fromEntries(bundle.structuredData.tables.map((table) => [
    table.name,
    table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column, row[index]]))),
  ]));
  return { ...bundle, data };
});

app.post("/api/backups/run", async (request, reply) => {
  if (!backupScheduler && !hostedBackupService) return reply.code(409).send({ error: "Configure CAREEROS_BACKUP_ENCRYPTION_KEY before running encrypted backups." });
  try {
    const result = hostedBackupService
      ? await hostedBackupService.run(trackerContext(request))
      : await backupScheduler!.run();
    const completedAt = hostedBackupService?.status().lastSuccessfulAt ?? backupScheduler?.status().lastSuccessfulAt ?? null;
    return { path: result.path, checksum: result.checksum, sizeBytes: result.sizeBytes, completedAt };
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Encrypted backup failed." });
  }
});

app.get("/api/backups", async (request) => ({
  backups: hostedBackupService
    ? await hostedBackupService.list(trackerContext(request))
    : sqlite.prepare(`SELECT id,object_path AS path,checksum,size_bytes AS sizeBytes,created_at AS createdAt FROM backup_records WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100`).all(DEFAULT_WORKSPACE_ID),
}));

app.post("/api/backups/:id/restore", async (request, reply) => {
  if ((!backupScheduler && !hostedBackupService) || !backupKeyValue) return reply.code(409).send({ error: "Configure CAREEROS_BACKUP_ENCRYPTION_KEY before restoring an encrypted backup." });
  if (hostedBackupService) {
    const session = hostedAuth.requireOwner(request);
    try {
      const result = await hostedBackupService.restoreStored(trackerContext(request), (request.params as { id: string }).id);
      await hostedAuth.audit(session, "workspace.backup_restored", "Workspace", session.workspaceId, "Restored an encrypted hosted backup", result);
      return reply.code(200).send({ accepted: true, restartRequired: false, message: "Encrypted backup restored. CareerOS is ready to use.", ...result });
    } catch (error) {
      await Promise.resolve(hostedAuth.audit(session, "workspace.backup_restore_failed", "Workspace", session.workspaceId, "Hosted encrypted backup restore failed", {
        error: error instanceof Error ? error.message : String(error),
        cleanupFailures: typeof error === "object" && error && "cleanupFailures" in error ? error.cleanupFailures : [],
      })).catch(() => undefined);
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 422;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Encrypted backup restore failed without changing current data." });
    }
  }
  const record = sqlite.prepare(`SELECT id,object_path AS path,checksum FROM backup_records WHERE id=? AND workspace_id=?`).get((request.params as { id: string }).id, DEFAULT_WORKSPACE_ID) as { id: string; path: string; checksum: string } | undefined;
  if (!record) return reply.code(404).send({ error: "Encrypted backup not found." });
  try {
    const encrypted = await configuredBackupStorage.adapter.read({ workspaceId: DEFAULT_WORKSPACE_ID, path: record.path, expectedChecksum: record.checksum });
    const bundle = validateBackupBundle(decryptBackup(encrypted.bytes, decodeBackupKey(backupKeyValue)), { expectedSchemaVersion: 4, expectedApplicationVersion: "0.1.0" });
    await stageRestore(bundle);
    return reply.code(202).send({ accepted: true, restartRequired: true, message: "Encrypted backup authenticated and verified. Restart CareerOS to apply it." });
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 422;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Encrypted backup restore failed without changing current data." });
  }
});

app.post("/api/restore", { bodyLimit: 250 * 1024 * 1024 }, async (request, reply) => {
  try {
    if (runtimeDataProvider.name === "postgres") {
      const session = hostedAuth.requireOwner(request);
      const result = await restorePostgresWorkspaceBundle({
        provider: runtimeDataProvider.postgres,
        storage: configuredStorage.adapter,
        context: trackerContext(request),
        bundle: request.body,
        expectedSchemaVersion: postgresSchemaVersion!,
        expectedApplicationVersion: "0.1.0",
        mode: "replace",
      });
      await hostedAuth.audit(session, "workspace.restored", "Workspace", session.workspaceId, "Restored a verified workspace backup", result);
      return reply.code(200).send({ accepted: true, restartRequired: false, message: "Backup restored. CareerOS is ready to use.", ...result });
    }
    const bundle = validateBackupBundle(request.body, { expectedSchemaVersion: 4, expectedApplicationVersion: "0.1.0" });
    await stageRestore(bundle);
    return reply.code(202).send({ accepted: true, restartRequired: true, message: "Backup verified. Restart CareerOS to apply it before the database opens." });
  } catch (error) {
    if (runtimeDataProvider.name === "postgres") {
      const session = hostedAuth.requireSession(request);
      await Promise.resolve(hostedAuth.audit(session, "workspace.restore_failed", "Workspace", session.workspaceId, "Hosted workspace restore failed", {
        error: error instanceof Error ? error.message : String(error),
        cleanupFailures: typeof error === "object" && error && "cleanupFailures" in error ? error.cleanupFailures : [],
      })).catch(() => undefined);
    }
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 422;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "The backup bundle is invalid. Current data was not changed." });
  }
});

app.get("/api/ai/runs", async (request) => {
  const requestedLimit = Number((request.query as { limit?: string }).limit ?? 10);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 10, 50));
  if (runtimeDataProvider.name === "postgres") {
    const context = trackerContext(request);
    const result = await runtimeDataProvider.postgres.transaction(context, (tx) => tx.query<{
      id: string; operation: AiRunRecord["operation"]; context_id: string; source_type: string;
      state: AiRunRecord["state"]; provider: string; model: string; duration_ms: number;
      total_duration_ms: number; evidence_count: number; warning: string; created_at: string;
    }>(`SELECT id,operation,context_id,source_type,state,provider,model,duration_ms,total_duration_ms,evidence_count,warning,created_at::text
      FROM ai_runs WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT $2`, [context.workspaceId, limit]), { readOnly: true });
    return { runs: result.rows.map((row) => ({
      id: row.id, operation: row.operation, contextId: row.context_id, sourceType: row.source_type,
      state: row.state, provider: row.provider, model: row.model, durationMs: Number(row.duration_ms),
      totalDurationMs: Number(row.total_duration_ms), evidenceCount: Number(row.evidence_count), warning: row.warning,
      createdAt: row.created_at,
    })) };
  }
  const runs = sqlite.prepare(`
    SELECT id, operation, context_id AS contextId, source_type AS sourceType, state,
           provider, model, duration_ms AS durationMs, total_duration_ms AS totalDurationMs,
           evidence_count AS evidenceCount, warning, created_at AS createdAt
    FROM ai_runs
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as AiRunRecord[];
  return { runs };
});

app.put("/api/settings/openai-key", async (request, reply) => {
  const parsed = openAiKeySaveSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid OpenAI API key." });
  try {
    saveKeychainOpenAiKey(parsed.data.apiKey);
    aiProvider = createConfiguredAiProvider(parsed.data.apiKey);
    aiKeySource = "keychain";
    return aiSettingsStatus();
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : "CareerOS could not save the key to macOS Keychain." });
  }
});

app.delete("/api/settings/openai-key", async (_request, reply) => {
  try {
    deleteKeychainOpenAiKey();
    aiProvider = createConfiguredAiProvider(environmentOpenAiKey || undefined);
    aiKeySource = environmentOpenAiKey ? "environment" : "none";
    return aiSettingsStatus();
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : "CareerOS could not remove the saved key." });
  }
});

app.post("/api/system/open-terminal", async (_request, reply) => {
  if (process.platform !== "darwin") return reply.code(501).send({ error: "Opening Terminal is currently supported on macOS." });
  try {
    execFileSync("/usr/bin/open", ["-a", "Terminal", projectDir], { stdio: "ignore", timeout: 4_000 });
    return { opened: true as const };
  } catch {
    return reply.code(500).send({ error: "CareerOS could not open Terminal." });
  }
});

app.get("/api/meta", async (request) => {
  if (runtimeDataProvider.name === "postgres") {
    const metadata = await trackerRepository.metadata(trackerContext(request));
    return { ...metadata, ai: aiSettingsStatus(), captureWorker: postgresCaptureWorker?.status() ?? null };
  }
  const jobs = listRows();
  return {
    sectors: [...new Set(jobs.map((job) => job.sector).filter(Boolean))],
    locations: [...new Set(jobs.map((job) => job.location).filter(Boolean))],
    ai: aiSettingsStatus(),
  };
});

const hostedWebRoot = join(projectDir, "apps/web/dist");
if (process.env.NODE_ENV === "production" && existsSync(join(hostedWebRoot, "index.html"))) {
  await app.register(fastifyStatic, { root: hostedWebRoot, wildcard: false, index: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/health") return reply.code(404).send({ error: "Not Found" });
    if (request.method === "GET" && request.headers.accept?.includes("text/html")) return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send({ error: "Not Found" });
  });
}

const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST?.trim() || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
if (process.env.CAREEROS_SKIP_LISTEN === "1") {
  console.info("[CareerOS API] Listen skipped because CAREEROS_SKIP_LISTEN=1.");
} else {
  try {
    console.info(`[CareerOS API] Starting Fastify on ${host}:${port}`);
    await app.listen({ port, host });
    console.info(`[CareerOS API] Ready on ${host}:${port}`);
    let signalCloseStarted = false;
    const closeForSignal = (signal: "SIGINT" | "SIGTERM") => {
      if (signalCloseStarted) return;
      signalCloseStarted = true;
      void app.close().then(() => process.exit(0)).catch((error) => {
        console.error(`[CareerOS API] Graceful ${signal} shutdown failed.`, error);
        process.exit(1);
      });
    };
    process.once("SIGINT", () => closeForSignal("SIGINT"));
    process.once("SIGTERM", () => closeForSignal("SIGTERM"));
    if (runtimeDataProvider.name === "sqlite" && process.env.CAREEROS_DISABLE_DISCOVERY_SCHEDULER !== "1") {
      const discoveryTimer = setInterval(() => {
        void sqliteDiscovery().runDue().catch((error) => app.log.error({ err: error }, "Scheduled discovery check failed"));
      }, 60_000);
      discoveryTimer.unref();
      void sqliteDiscovery().runDue().catch((error) => app.log.error({ err: error }, "Initial discovery check failed"));
    }
    if (runtimeDataProvider.name === "postgres" && process.env.CAREEROS_DISABLE_DISCOVERY_SCHEDULER !== "1") {
      hostedDiscoveryTimer = setInterval(() => {
        void runHostedDiscoveryCycle().catch((error) => app.log.error({ err: error }, "Scheduled hosted discovery check failed"));
      }, 60_000);
      hostedDiscoveryTimer.unref();
      void runHostedDiscoveryCycle().catch((error) => app.log.error({ err: error }, "Initial hosted discovery check failed"));
    }
  } catch (error) {
    console.error("[CareerOS API] Failed to start.", error);
    process.exitCode = 1;
  }
}

export { app };
