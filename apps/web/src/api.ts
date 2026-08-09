import type { AiRunRecord, AiSettingsStatus, AlertEventRecord, AlertRuleCreateInput, AlertRuleRecord, AlertRuleUpdateInput, ApplicationEventInput, ApplicationStudioWorkspace, CaptureDraftRecord, CaptureDraftSaveInput, CaptureQueueBatchInput, CaptureQueueItem, CaptureQueueSummary, CareerOSClient, CareerOSMeta, CareerStudioWorkspace, CvDraftSaveInput, CvTailoringProposal, CvTailoringRequest, DiscoveryRunRecord, DiscoverySourceCreateInput, DiscoverySourceRecord, DiscoveryWorkspace, DocumentVersionCreateInput, DocumentVersionPdfExportInput, DocumentVersionRecord, ImportDraftResponse, ImportInput, JobDetail, JobDraft, JobRow, JobTask, OpenAiKeySaveInput, ProfileDocumentImportCommitInput, ProfileDocumentImportInput, ProfileDocumentImportResponse, ProfileDocumentPreview, ProfileRecord, ProfileUpdateInput, SalaryEstimateCreateInput, SalaryEstimateRecord, SalaryResearchProposal, SourceCheckResult, SystemServiceHealth, TaskCreateInput, TaskUpdateInput, WorkspaceSessionRecord } from "@careeros/contracts";
import { apiBaseUrl, reportDiagnostic } from "./diagnostics";
import { getAccessToken } from "./auth";

const defaultTimeoutMs = 15_000;

async function request<T>(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? defaultTimeoutMs);
  let statusCode: number | undefined;
  const headers = new Headers(options?.headers);
  const accessToken = getAccessToken();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (options?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers,
    });
    statusCode = response.status;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new CareerOSRequestError(body.error ?? "CareerOS could not complete that request.", response.status, body);
    const method = (options?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      window.dispatchEvent(new CustomEvent("careeros:local-mutation", { detail: { path, at: new Date().toISOString() } }));
    }
    return body as T;
  } catch (error) {
    let message: string;
    if (error instanceof DOMException && error.name === "AbortError") {
      if (path.endsWith("/cv-tailoring")) message = "CV tailoring is taking too long. Try again in a moment.";
      else if (path.endsWith("/salary-research")) message = "Salary research is taking too long. Try again in a moment.";
      else if (path.startsWith("/api/imports") || path.startsWith("/api/profile/imports")) message = "That import is taking too long. Try pasted text or a smaller document.";
      else message = "CareerOS did not receive a response in time.";
    } else if (error instanceof TypeError) {
      message = "CareerOS API is not running on port 4310.";
    } else {
      message = error instanceof Error ? error.message : "CareerOS could not complete that request.";
    }
    reportDiagnostic({
      source: "API",
      operation: `${options?.method ?? "GET"} ${path}`,
      message,
      statusCode,
    });
    if (error instanceof CareerOSRequestError) throw error;
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

export class CareerOSRequestError extends Error {
  constructor(message: string, readonly statusCode: number, readonly details: Record<string, unknown>) {
    super(message);
    this.name = "CareerOSRequestError";
  }
}

export const client: CareerOSClient = {
  getMeta() {
    return request<CareerOSMeta>("/api/meta");
  },
  getSystemHealth() {
    return request<SystemServiceHealth>("/api/system/health");
  },
  async listJobs(params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => Boolean(value)) as Array<[string, string]>).toString();
    const result = await request<{ jobs: JobRow[] }>(`/api/jobs${query ? `?${query}` : ""}`);
    return result.jobs;
  },
  getJob(id) {
    return request<JobDetail>(`/api/jobs/${id}`);
  },
  getProfile() {
    return request<ProfileRecord>("/api/profile");
  },
  updateProfile(input: ProfileUpdateInput) {
    return request<ProfileRecord>("/api/profile", { method: "PUT", body: JSON.stringify(input) });
  },
  createProfileDocumentImport(input: ProfileDocumentImportInput) {
    return request<ProfileDocumentImportResponse>("/api/profile/imports", { method: "POST", body: JSON.stringify(input), timeoutMs: 60_000 });
  },
  commitProfileDocumentImport(input: ProfileDocumentImportCommitInput) {
    return request<ProfileRecord>("/api/profile/imports/commit", { method: "POST", body: JSON.stringify(input) });
  },
  getApplicationStudio(jobPostingId: string) {
    return request<ApplicationStudioWorkspace>(`/api/jobs/${jobPostingId}/application-studio`);
  },
  getCareerStudio() {
    return request<CareerStudioWorkspace>("/api/career-studio");
  },
  getProfileDocumentPreview(documentId: string) {
    return request<ProfileDocumentPreview>(`/api/profile/documents/${documentId}/preview`);
  },
  saveOpenAiKey(input: OpenAiKeySaveInput) {
    return request<AiSettingsStatus>("/api/settings/openai-key", { method: "PUT", body: JSON.stringify(input) });
  },
  deleteOpenAiKey() {
    return request<AiSettingsStatus>("/api/settings/openai-key", { method: "DELETE" });
  },
  openTerminal() {
    return request<{ opened: true }>("/api/system/open-terminal", { method: "POST" });
  },
  saveCvDraft(jobPostingId: string, input: CvDraftSaveInput) {
    return request<{ updatedAt: string; revision: number }>(`/api/jobs/${jobPostingId}/document-drafts`, { method: "PUT", body: JSON.stringify(input) });
  },
  tailorCv(jobPostingId: string, input: CvTailoringRequest) {
    return request<CvTailoringProposal>(`/api/jobs/${jobPostingId}/cv-tailoring`, { method: "POST", body: JSON.stringify(input), timeoutMs: 70_000 });
  },
  createDocumentVersion(jobPostingId: string, input: DocumentVersionCreateInput) {
    return request<DocumentVersionRecord>(`/api/jobs/${jobPostingId}/document-versions`, { method: "POST", body: JSON.stringify(input) });
  },
  exportDocumentVersionPdf(versionId: string, input: DocumentVersionPdfExportInput) {
    return request<DocumentVersionRecord>(`/api/document-versions/${versionId}/pdf`, { method: "POST", body: JSON.stringify(input), timeoutMs: 60_000 });
  },
  createImport(input: ImportInput) {
    return request<ImportDraftResponse>("/api/imports", { method: "POST", body: JSON.stringify(input), timeoutMs: 35_000 });
  },
  enqueueCaptures(input: CaptureQueueBatchInput) {
    return request<CaptureQueueItem[]>("/api/capture-queue", { method: "POST", body: JSON.stringify(input) });
  },
  listCaptureQueue(params: { limit?: number; cursor?: string; state?: CaptureQueueItem["state"] } = {}) {
    const query = new URLSearchParams();
    query.set("limit", String(params.limit ?? 50));
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.state) query.set("state", params.state);
    return request<{ items: CaptureQueueItem[]; summary: CaptureQueueSummary; nextCursor: string | null }>(`/api/capture-queue?${query}`);
  },
  getCapture(id: string) {
    return request<CaptureQueueItem>(`/api/capture-queue/${id}`);
  },
  retryCapture(id: string) {
    return request<CaptureQueueItem>(`/api/capture-queue/${id}/retry`, { method: "POST" });
  },
  cancelCapture(id: string) {
    return request<CaptureQueueItem>(`/api/capture-queue/${id}/cancel`, { method: "POST" });
  },
  listCaptureDrafts() {
    return request<CaptureDraftRecord[]>("/api/capture-drafts");
  },
  saveCaptureDraft(id: string, input: CaptureDraftSaveInput) {
    return request<CaptureDraftRecord>(`/api/capture-drafts/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  async deleteCaptureDraft(id: string, expectedRevision?: number) {
    await request<{ deleted: true }>(`/api/capture-drafts/${id}?expectedRevision=${encodeURIComponent(String(expectedRevision ?? 0))}`, { method: "DELETE" });
  },
  enqueueCaptureDraft(id: string) {
    return request<CaptureQueueItem[]>(`/api/capture-drafts/${id}/enqueue`, { method: "POST" });
  },
  commitCapture(id: string, input: Parameters<CareerOSClient["commitCapture"]>[1]) {
    return request<JobRow>(`/api/capture-queue/${id}/commit`, { method: "POST", body: JSON.stringify(input) });
  },
  commitCaptureBatch(input: Parameters<CareerOSClient["commitCaptureBatch"]>[0]) {
    return request<JobRow[]>("/api/capture-queue/commit-batch", { method: "POST", body: JSON.stringify(input) });
  },
  getDiscoveryWorkspace(params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => Boolean(value)) as Array<[string, string]>).toString();
    return request<DiscoveryWorkspace>(`/api/discovery${query ? `?${query}` : ""}`);
  },
  runDiscovery(sourceId?: string) {
    return request<DiscoveryRunRecord[]>("/api/discovery/runs", { method: "POST", body: JSON.stringify(sourceId ? { sourceId } : {}), timeoutMs: 300_000 });
  },
  saveDiscoveredPosting(id: string) {
    return request<ImportDraftResponse>(`/api/discovery/postings/${id}/save`, { method: "POST" });
  },
  hideDiscoveredPosting(id: string, hidden: boolean) {
    return request<import("@careeros/contracts").DiscoveredPostingRecord>(`/api/discovery/postings/${id}/hidden`, { method: "PATCH", body: JSON.stringify({ hidden }) });
  },
  reportDiscoveredPosting(id: string, input: import("@careeros/contracts").DiscoveryIssueCreateInput) {
    return request<{ id: string; createdAt: string }>(`/api/discovery/postings/${id}/issues`, { method: "POST", body: JSON.stringify(input) });
  },
  createDiscoverySource(input: DiscoverySourceCreateInput) {
    return request<DiscoverySourceRecord>("/api/discovery/sources", { method: "POST", body: JSON.stringify(input) });
  },
  createAlertRule(input: AlertRuleCreateInput) {
    return request<AlertRuleRecord>("/api/alerts/rules", { method: "POST", body: JSON.stringify(input) });
  },
  updateAlertRule(id: string, input: AlertRuleUpdateInput) {
    return request<AlertRuleRecord>(`/api/alerts/rules/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  async deleteAlertRule(id: string, expectedRevision: number) {
    await request<unknown>(`/api/alerts/rules/${id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision }) });
  },
  markAlertRead(id: string, read: boolean) {
    return request<AlertEventRecord>(`/api/alerts/${id}/read`, { method: "PATCH", body: JSON.stringify({ read }) });
  },
  sendTestAlert() {
    return request<AlertEventRecord>("/api/alerts/test", { method: "POST" });
  },
  getTelegramSettings() {
    return request<import("@careeros/contracts").TelegramSettingsStatus>("/api/settings/telegram");
  },
  saveTelegramSettings(input: import("@careeros/contracts").TelegramSettingsUpdateInput) {
    return request<import("@careeros/contracts").TelegramSettingsStatus>("/api/settings/telegram", { method: "PUT", body: JSON.stringify(input) });
  },
  deleteTelegramSettings() {
    return request<import("@careeros/contracts").TelegramSettingsStatus>("/api/settings/telegram", { method: "DELETE" });
  },
  retryAlertDelivery(deliveryId: string, confirmPossibleDuplicate = false) {
    return request<import("@careeros/contracts").NotificationDeliveryHistoryItem>(`/api/alerts/deliveries/${deliveryId}/retry`, { method: "POST", body: JSON.stringify({ confirmPossibleDuplicate }) });
  },
  listAlertDeliveries(params = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    return request<import("@careeros/contracts").NotificationDeliveryHistoryPage>(`/api/alerts/deliveries?${query.toString()}`);
  },
  async listAiRuns(limit = 10) {
    const result = await request<{ runs: AiRunRecord[] }>(`/api/ai/runs?limit=${Math.max(1, Math.min(limit, 50))}`);
    return result.runs;
  },
  commitImport(id: string, draft: JobDraft, duplicateDecision) {
    return request<JobRow>(`/api/imports/${id}/commit`, { method: "POST", body: JSON.stringify({ draft, duplicateAction: duplicateDecision?.action, existingJobPostingId: duplicateDecision?.existingJobPostingId }) });
  },
  createApplication(input) {
    return request<JobDetail>(`/api/jobs/${input.jobPostingId}/applications`, { method: "POST", body: JSON.stringify(input) });
  },
  addEvent(applicationId: string, input: ApplicationEventInput) {
    return request(`/api/applications/${applicationId}/events`, { method: "POST", body: JSON.stringify(input) });
  },
  updateJob(id: string, input) {
    return request<JobRow>(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  createTask(jobPostingId: string, input: TaskCreateInput) {
    return request<JobTask>(`/api/jobs/${jobPostingId}/tasks`, { method: "POST", body: JSON.stringify(input) });
  },
  updateTask(id: string, input: TaskUpdateInput) {
    return request<JobTask>(`/api/tasks/${id}`).then((current) => request<JobTask>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...input, expectedRevision: current.revision }),
    }));
  },
  createSalaryEstimate(jobPostingId: string, input: SalaryEstimateCreateInput) {
    return request<SalaryEstimateRecord>(`/api/jobs/${jobPostingId}/salary-estimates`, { method: "POST", body: JSON.stringify(input) });
  },
  researchSalary(jobPostingId: string) {
    return request<SalaryResearchProposal>(`/api/jobs/${jobPostingId}/salary-research`, { method: "POST", timeoutMs: 70_000 });
  },
  commitSalaryResearch(jobPostingId: string, proposal: SalaryResearchProposal) {
    return request<SalaryEstimateRecord>(`/api/jobs/${jobPostingId}/salary-research/commit`, { method: "POST", body: JSON.stringify(proposal) });
  },
  recheckJobSource(id: string) {
    return request<SourceCheckResult>(`/api/jobs/${id}/recheck`, { method: "POST", timeoutMs: 20_000 });
  },
  exportBundle() {
    return request("/api/export");
  },
  restoreBundle(bundle: unknown) {
    return request<{ accepted: true; restartRequired: boolean; message: string }>("/api/restore", { method: "POST", body: JSON.stringify(bundle), timeoutMs: 60_000 });
  },
  getWorkspaceSession() {
    return request<WorkspaceSessionRecord>("/api/auth/session");
  },
  createWorkspaceInvitation(input) {
    return request<{ id: string; email: string; role: "editor" | "viewer"; token: string; expiresAt: string }>("/api/auth/invitations", { method: "POST", body: JSON.stringify(input) });
  },
  listWorkspaceInvitations() {
    return request<import("@careeros/contracts").WorkspaceInvitationRecord[]>("/api/auth/invitations");
  },
  revokeWorkspaceInvitation(id) {
    return request<import("@careeros/contracts").WorkspaceInvitationRecord[]>(`/api/auth/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  updateWorkspaceMember(userId, role) {
    return request<WorkspaceSessionRecord["members"]>(`/api/auth/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ role }) });
  },
  removeWorkspaceMember(userId) {
    return request<WorkspaceSessionRecord["members"]>(`/api/auth/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  },
  listWorkspaceComments(entityType, entityId) {
    const query = new URLSearchParams({ entityType, entityId });
    return request<import("@careeros/contracts").WorkspaceCommentRecord[]>(`/api/workspace/comments?${query}`);
  },
  createWorkspaceComment(input) {
    return request<import("@careeros/contracts").WorkspaceCommentRecord>("/api/workspace/comments", { method: "POST", body: JSON.stringify(input) });
  },
  listWorkspaceAudit(limit = 100) {
    return request<import("@careeros/contracts").WorkspaceAuditEventRecord[]>(`/api/workspace/audit?limit=${Math.max(1, Math.min(limit, 250))}`);
  },
};

export function profileDocumentFileUrl(documentId: string) {
  return `${apiBaseUrl}/api/profile/documents/${encodeURIComponent(documentId)}/file`;
}

export async function loadProfileDocumentFile(documentId: string) {
  const headers = new Headers();
  const accessToken = getAccessToken();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(profileDocumentFileUrl(documentId), { headers });
  if (!response.ok) throw new Error("The original document could not be loaded.");
  return URL.createObjectURL(await response.blob());
}

export async function downloadBundle() {
  const bundle = await client.exportBundle();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `careeros-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function downloadDocumentVersionPdf(version: DocumentVersionRecord) {
  const headers = new Headers();
  const accessToken = getAccessToken();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${apiBaseUrl}/api/document-versions/${encodeURIComponent(version.id)}/pdf`, { headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "The exported PDF could not be downloaded.");
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `CareerOS-CV-v${version.version}.pdf`;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
