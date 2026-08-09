import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Bold,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Clock3,
  Coins,
  Copy,
  DatabaseBackup,
  Download,
  Eye,
  FileText,
  FilePenLine,
  Filter,
  FolderKanban,
  GripVertical,
  Italic,
  Link2,
  ListFilter,
  LoaderCircle,
  LogOut,
  Minus,
  PencilLine,
  Plus,
  RefreshCw,
  Redo2,
  Search,
  Send,
  Save,
  Sparkles,
  SquareCheckBig,
  Target,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { applicationEventTypes, applicationStatuses, profileDocumentTypes, profileSectionTypes, type ApplicationEventInput, type ApplicationStatus, type ApplicationStudioDocument, type ApplicationStudioWorkspace, type CaptureQueueItem, type CareerStudioWorkspace, type CvChangeProposal, type CvDocumentContent, type CvDocumentSection, type CvInlineFormatMark, type CvProposalState, type CvTailoringProposal, type DocumentVersionRecord, type ImportDraftResponse, type JobDetail, type JobDraft, type JobRow, type ProfileDocumentImportResponse, type ProfileDocumentPreview, type ProfileDocumentType, type ProfileImportProfilePatch, type ProfileImportSection, type ProfileRecord, type ProfileSectionInput, type SalaryEstimateCreateInput, type SalaryResearchProposal, type TaskCreateInput, type WorkspaceSessionRecord } from "@careeros/contracts";
import { CareerOSRequestError, client, downloadBundle, downloadDocumentVersionPdf, loadProfileDocumentFile } from "./api";
import { SystemStatus } from "./SystemStatus";
import { CaptureInbox } from "./CaptureInbox";
import { DiscoverFeed } from "./DiscoverFeed";
import { ShareWorkspace } from "./ShareWorkspace";
import { WorkspaceComments } from "./WorkspaceComments";
import { CollaborationPresence } from "./CollaborationPresence";
import { signOut } from "./auth";

type Page = "opportunities" | "capture" | "discover" | "profile" | "studio";
type AppRoute = { page: Page; selectedId: string | null; studioJobId: string | null };
const CvReadOnlyContext = createContext(false);

function readAppRoute(pathname = window.location.pathname): AppRoute {
  const segments = pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (segments[0] === "career-studio" && segments[1] === "jobs" && segments[2] && segments[3] === "cv") {
    return { page: "studio", selectedId: null, studioJobId: segments[2] };
  }
  if (segments[0] === "career-studio") return { page: "profile", selectedId: null, studioJobId: null };
  if (segments[0] === "capture") return { page: "capture", selectedId: null, studioJobId: null };
  if (segments[0] === "discover") return { page: "discover", selectedId: null, studioJobId: null };
  if (segments[0] === "opportunities" && segments[1]) return { page: "opportunities", selectedId: segments[1], studioJobId: null };
  return { page: "opportunities", selectedId: null, studioJobId: null };
}

function appRoutePath(route: AppRoute) {
  if (route.page === "studio" && route.studioJobId) return `/career-studio/jobs/${encodeURIComponent(route.studioJobId)}/cv`;
  if (route.page === "profile") return "/career-studio";
  if (route.page === "capture") return "/capture";
  if (route.page === "discover") return "/discover";
  if (route.selectedId) return `/opportunities/${encodeURIComponent(route.selectedId)}`;
  return "/opportunities";
}

const blankDraft: JobDraft = {
  title: "",
  companyName: "",
  companySnapshot: "",
  companyDescription: "",
  location: "",
  country: "",
  region: "",
  workMode: "",
  employmentType: "",
  seniority: "",
  sector: "",
  roleFamily: "",
  division: "",
  team: "",
  summary: "",
  description: "",
  requiredRequirements: [],
  preferredRequirements: [],
  processSummary: "",
  visaRequirements: "",
  requisitionId: "",
  sourceUrl: "",
  applyUrl: "",
  referralSource: "",
  recruiterContact: "",
  applicationDeadline: "",
  postingDate: "",
  expiryDate: "",
  lastCheckedAt: "",
  postingState: "Active",
};

const eventLabels: Record<string, string> = {
  posting_saved: "Posting saved",
  application_started: "Application started",
  application_submitted: "Application submitted",
  recruiter_response: "Recruiter response",
  online_assessment_received: "Assessment received",
  assessment_completed: "Assessment completed",
  interview_scheduled: "Interview scheduled",
  interview_completed: "Interview completed",
  next_round_received: "Next round received",
  final_round_reached: "Final round reached",
  offer_received: "Offer received",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  rejection_received: "Rejection received",
  application_withdrawn: "Application withdrawn",
  follow_up_sent: "Follow-up sent",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "No date";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
}

function formatRelativeDate(value: string | null | undefined) {
  if (!value) return "Not captured";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const parsedStart = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const daysFromToday = Math.round((parsedStart.valueOf() - todayStart.valueOf()) / 86_400_000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const absoluteDays = Math.abs(daysFromToday);

  if (absoluteDays < 7) return formatter.format(daysFromToday, "day");
  if (absoluteDays < 60) return formatter.format(Math.round(daysFromToday / 7), "week");
  if (absoluteDays < 730) return formatter.format(Math.round(daysFromToday / 30), "month");
  return formatter.format(Math.round(daysFromToday / 365), "year");
}

function formatDuration(milliseconds: number) {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}

function formatMoney(amount: number | null | undefined, currency: string) {
  if (amount == null) return "";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP", maximumFractionDigits: 0 }).format(amount);
}

function statusClass(status: string | null) {
  if (!status) return "status status-muted";
  return `status status-${status.toLowerCase().replaceAll(" ", "-")}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

export function App() {
  const initialRoute = useMemo(() => readAppRoute(), []);
  const [page, setPage] = useState<Page>(initialRoute.page);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialRoute.selectedId);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [salaryResearchId, setSalaryResearchId] = useState<string | null>(null);
  const [studioJobId, setStudioJobId] = useState<string | null>(initialRoute.studioJobId);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sectorFilter, setSectorFilter] = useState("All");
  const [appliedFilter, setAppliedFilter] = useState("All");
  const [sectors, setSectors] = useState<string[]>([]);
  const [isImportOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<"url" | "pasted_text" | "manual">("url");
  const [importUrl, setImportUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [review, setReview] = useState<{ response: ImportDraftResponse; draft: JobDraft } | null>(null);
  const [reviewCaptureId, setReviewCaptureId] = useState<string | null>(null);
  const [captureDuplicateDecision, setCaptureDuplicateDecision] = useState<{ action: "create_anyway" | "link_existing"; existingJobPostingId?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importError, setImportError] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSessionRecord | null>(null);
  const [remoteMutationTick, setRemoteMutationTick] = useState(0);
  const [restoreNotice, setRestoreNotice] = useState("");
  const restoreFileRef = useRef<HTMLInputElement>(null);
  const activeRouteRef = useRef<AppRoute>(initialRoute);
  const navigationGuardRef = useRef<(() => Promise<boolean>) | null>(null);

  const applyRoute = (route: AppRoute) => {
    activeRouteRef.current = route;
    setPage(route.page);
    setSelectedId(route.selectedId);
    setStudioJobId(route.studioJobId);
    if (route.page !== "opportunities") setSalaryResearchId(null);
  };

  const navigate = (route: AppRoute, replace = false) => {
    const complete = async () => {
      const leavingStudio = activeRouteRef.current.page === "studio" && route.page !== "studio";
      if (leavingStudio && navigationGuardRef.current && !(await navigationGuardRef.current())) return;
      const path = appRoutePath(route);
      const state = { careeros: true, fromPath: replace ? null : window.location.pathname };
      window.history[replace ? "replaceState" : "pushState"](state, "", path);
      applyRoute(route);
    };
    void complete();
  };

  useEffect(() => {
    const initialPath = appRoutePath(initialRoute);
    if (initialRoute.page === "studio" && !window.history.state?.careeros) {
      window.history.replaceState({ careeros: true, fromPath: null }, "", appRoutePath({ page: "profile", selectedId: null, studioJobId: null }));
      window.history.pushState({ careeros: true, fromPath: "/career-studio" }, "", initialPath);
    } else if (window.location.pathname !== initialPath || !window.history.state?.careeros) {
      window.history.replaceState({ careeros: true, fromPath: null }, "", initialPath);
    }
    const onPopState = () => {
      const priorRoute = activeRouteRef.current;
      const nextRoute = readAppRoute();
      const guard = navigationGuardRef.current;
      if (!guard || priorRoute.page !== "studio" || nextRoute.page === "studio") {
        applyRoute(nextRoute);
        return;
      }
      void guard().then((safeToLeave) => {
        if (safeToLeave) applyRoute(nextRoute);
        else window.history.replaceState({ careeros: true, fromPath: null }, "", appRoutePath(priorRoute));
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadJobs = async () => {
    setLoading(true);
    setError("");
    try {
      const [nextJobs, meta] = await Promise.all([
        client.listJobs({ search, status: statusFilter, sector: sectorFilter, applied: appliedFilter === "All" ? "" : appliedFilter === "Applied" ? "yes" : "no" }),
        client.getMeta(),
      ]);
      setJobs(nextJobs);
      setSectors(meta.sectors ?? []);
      if (selectedId && !nextJobs.some((job) => job.id === selectedId)) setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The local API is not available yet.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadJobs(); }, [search, statusFilter, sectorFilter, appliedFilter]);

  useEffect(() => {
    void client.getWorkspaceSession().then(setWorkspaceSession).catch(() => setWorkspaceSession(null));
  }, []);

  useEffect(() => {
    if (workspaceSession?.workspace.role === "viewer" && page === "capture") {
      navigate({ page: "opportunities", selectedId: null, studioJobId: null }, true);
      setError("Capture is unavailable with view-only access.");
    }
  }, [workspaceSession?.workspace.role, page]);

  useEffect(() => {
    const refreshFromCollaborator = () => {
      setRemoteMutationTick((current) => current + 1);
      void loadJobs();
      if (selectedId) void client.getJob(selectedId).then(setSelectedJob).catch(() => undefined);
    };
    window.addEventListener("careeros:remote-mutation", refreshFromCollaborator);
    return () => window.removeEventListener("careeros:remote-mutation", refreshFromCollaborator);
  }, [selectedId, search, statusFilter, sectorFilter, appliedFilter]);

  useEffect(() => {
    if (!workspaceSession?.hosted) return;
    const timer = window.setInterval(() => {
      void loadJobs();
      if (selectedId) void client.getJob(selectedId).then(setSelectedJob).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [workspaceSession?.hosted, selectedId, search, statusFilter, sectorFilter, appliedFilter]);

  useEffect(() => {
    if (!selectedId) { setSelectedJob(null); return; }
    void client.getJob(selectedId).then(setSelectedJob).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load that job."));
  }, [selectedId]);

  const counts = useMemo(() => ({
    total: jobs.length,
    active: jobs.filter((job) => !["Rejected", "Withdrawn", "Archived"].includes(job.applicationStatus ?? "")).length,
    applied: jobs.filter((job) => Boolean(job.appliedAt)).length,
  }), [jobs]);

  const openManual = () => {
    setReviewCaptureId(null);
    setReview({ response: { importRun: { id: "manual", state: "Needs Review", sourceType: "manual", sourceUrl: null, error: null }, draft: blankDraft, duplicates: [] }, draft: blankDraft });
    setImportOpen(true);
  };

  const startImport = async () => {
    setBusy(true);
    setError("");
    setImportError("");
    try {
      if (importMode === "manual") { openManual(); return; }
      setReviewCaptureId(null);
      const response = await client.createImport(importMode === "url" ? { sourceType: "url", url: importUrl } : { sourceType: "pasted_text", text: importText });
      setReview({ response, draft: response.draft });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Import failed.";
      setImportError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const commitReview = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const created = reviewCaptureId ? await client.commitCapture(reviewCaptureId, {
        draft: review.draft,
        duplicateAction: captureDuplicateDecision?.action,
        existingJobPostingId: captureDuplicateDecision?.existingJobPostingId,
      }) : review.response.importRun.id === "manual" ? await client.commitImport("manual", review.draft, captureDuplicateDecision ?? undefined) : await client.commitImport(review.response.importRun.id, review.draft, captureDuplicateDecision ?? undefined);
      setImportOpen(false);
      setReview(null);
      setReviewCaptureId(null);
      setCaptureDuplicateDecision(null);
      setImportUrl("");
      setImportText("");
      await loadJobs();
      navigate({ page: "opportunities", selectedId: created.id, studioJobId: null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save that opportunity.";
      setImportError(message);
      setError(message);
      if (reviewCaptureId) {
        try {
          const refreshed = await client.getCapture(reviewCaptureId);
          if (refreshed.draft && refreshed.duplicates.length) {
            setCaptureDuplicateDecision(null);
            setReview((current) => current ? { ...current, response: { ...current.response, duplicates: refreshed.duplicates } } : current);
          }
        } catch {
          // Keep the original review open with the actionable save error.
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const createApplication = async () => {
    if (!selectedJob) return;
    setBusy(true);
    try {
      const detail = await client.createApplication({ jobPostingId: selectedJob.id });
      setSelectedJob(detail);
      await loadJobs();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start application."); }
    finally { setBusy(false); }
  };

  const addEvent = async (input: ApplicationEventInput) => {
    if (!selectedJob?.applicationId) return;
    setBusy(true);
    try {
      await client.addEvent(selectedJob.applicationId, input);
      setSelectedJob(await client.getJob(selectedJob.id));
      await loadJobs();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add event."); }
    finally { setBusy(false); }
  };

  const restoreBackup = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setRestoreNotice("");
    try {
      if (file.size > 250 * 1024 * 1024) throw new Error("That backup is larger than the 250 MB restore limit.");
      const bundle = JSON.parse(await file.text()) as unknown;
      if (!window.confirm("Validate this backup and stage it for restore? Your current data will remain unchanged unless validation succeeds.")) return;
      const result = await client.restoreBundle(bundle);
      setRestoreNotice(result.message || "Backup verified. Restart the CareerOS backend once to apply it.");
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "That file is not a valid CareerOS JSON backup." : cause instanceof Error ? cause.message : "The backup could not be restored.");
    } finally {
      if (restoreFileRef.current) restoreFileRef.current.value = "";
    }
  };

  const canEditWorkspace = workspaceSession?.workspace.role !== "viewer";

  if (page === "studio" && studioJobId) {
    return <ApplicationStudio session={workspaceSession} readOnly={!canEditWorkspace} jobPostingId={studioJobId} remoteMutationTick={remoteMutationTick} registerNavigationGuard={(guard) => { navigationGuardRef.current = guard; }} onBack={() => { if (window.history.state?.fromPath) window.history.back(); else navigate({ page: "profile", selectedId: null, studioJobId: null }); }} onOpenProfile={() => navigate({ page: "profile", selectedId: null, studioJobId: null })} />;
  }

  return (
    <div className={`app-shell ${canEditWorkspace ? "" : "viewer-mode"}`}>
      <Sidebar session={workspaceSession} page={page} onNavigate={(nextPage) => navigate({ page: nextPage, selectedId: null, studioJobId: null })} onShare={() => setShareOpen(true)} onExport={() => void downloadBundle()} onRestore={() => restoreFileRef.current?.click()} />
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>CareerOS</span><span className="crumb-divider">/</span><strong>{page === "profile" ? "Career Studio" : page === "capture" ? "Capture Inbox" : page === "discover" ? "Discover" : "Opportunities"}</strong></div>
          <div className="top-actions">
            {page === "opportunities" && <button className="icon-button" title="Refresh opportunities" onClick={() => void loadJobs()}><RefreshCw size={17} /></button>}
            <input ref={restoreFileRef} className="visually-hidden" type="file" aria-label="Choose CareerOS backup to restore" accept="application/json,.json" onChange={(event) => void restoreBackup(event.target.files?.[0])} />
            <CollaborationPresence session={workspaceSession} compact />
            <SystemStatus />
            {page === "opportunities" && canEditWorkspace && <button className="primary-button" onClick={() => { setReview(null); setImportOpen(true); }}><Plus size={17} /> Add opportunity</button>}
          </div>
        </header>

        {!canEditWorkspace && <div className="viewer-banner" role="status"><Eye size={16} /><span>View-only workspace. You can review shared work, but editing controls are unavailable.</span></div>}
        {restoreNotice && <div className="alert alert-success" role="status"><CircleCheck size={17} /><span>{restoreNotice}</span><button className="alert-close" title="Dismiss restore message" onClick={() => setRestoreNotice("")}><X size={15} /></button></div>}

        {page === "opportunities" ? <>
        <section className="page-heading">
          <div>
            <h1>Opportunities</h1>
          </div>
          <div className="heading-stats" aria-label="Opportunity summary">
            <div><strong>{counts.total}</strong><span>visible</span></div>
            <div><strong>{counts.applied}</strong><span>applied</span></div>
            <div><strong>{counts.active}</strong><span>in play</span></div>
          </div>
        </section>

        {error && <div className="alert"><CircleAlert size={17} /><span>{error}</span><button className="alert-close" title="Dismiss error" onClick={() => setError("")}><X size={15} /></button></div>}

        <section className="toolbar" aria-label="Opportunity filters">
          <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search role, company, description..." /></label>
          <div className="toolbar-divider" />
          <label className="select-control"><ListFilter size={16} /><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>All</option>{applicationStatuses.map((status) => <option key={status}>{status}</option>)}</select><ChevronDown size={14} /></label>
          <label className="select-control"><Target size={16} /><span>Track</span><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option>All</option>{sectors.map((sector) => <option key={sector}>{sector}</option>)}</select><ChevronDown size={14} /></label>
          <label className="select-control"><Filter size={16} /><span>Applied</span><select value={appliedFilter} onChange={(event) => setAppliedFilter(event.target.value)}><option>All</option><option>Applied</option><option>Not applied</option></select><ChevronDown size={14} /></label>
          <span className="toolbar-result">{loading ? "Updating" : `${jobs.length} ${jobs.length === 1 ? "opportunity" : "opportunities"}`}</span>
        </section>

        <section className="workspace-table" aria-label="Opportunities table">
          <div className="table-head table-grid"><span className="index-cell">#</span><span>Opportunity</span><span>Track</span><span>Where</span><span>Deadline</span><span>Salary</span><span>Application</span><span>Employer posted</span><span>CareerOS updated</span></div>
          {loading ? <div className="table-state"><LoaderCircle className="spin" size={20} /><span>Loading your pipeline...</span></div> : jobs.length === 0 ? (canEditWorkspace ? <EmptyState onAdd={() => { setReview(null); setImportOpen(true); }} onManual={openManual} /> : <div className="table-state"><BriefcaseBusiness size={20} /><span>No shared opportunities yet.</span></div>) : jobs.map((job) => <JobRowItem key={job.id} job={job} selected={job.id === selectedId} canResearchSalary={canEditWorkspace} onClick={() => navigate({ page: "opportunities", selectedId: job.id, studioJobId: null })} onResearchSalary={() => { navigate({ page: "opportunities", selectedId: job.id, studioJobId: null }); setSalaryResearchId(job.id); }} />)}
        </section>
        </> : page === "capture" ? <CaptureInbox onBatchSaved={() => void loadJobs()} onReview={(item: CaptureQueueItem) => {
          void client.getCapture(item.id).then((fullItem) => {
            if (!fullItem.draft) return;
            setReviewCaptureId(fullItem.id);
            setCaptureDuplicateDecision(null);
            setReview({ response: {
              importRun: { id: fullItem.importRunId ?? fullItem.id, state: "Needs Review", sourceType: fullItem.sourceType, sourceUrl: fullItem.sourceUrl || null, error: fullItem.error },
              draft: fullItem.draft,
              duplicates: fullItem.duplicates,
              ...(fullItem.sourceText ? { sourceText: fullItem.sourceText } : {}),
              ...(fullItem.enrichment ? { enrichment: fullItem.enrichment } : {}),
              ...(fullItem.fieldEvidence?.length ? { fieldEvidence: fullItem.fieldEvidence } : {}),
            }, draft: fullItem.draft });
            setImportOpen(true);
          }).catch((cause) => setError(cause instanceof Error ? cause.message : "That capture could not be opened."));
        }} /> : page === "discover" ? <DiscoverFeed readOnly={!canEditWorkspace} onReview={(response) => {
          setReviewCaptureId(null);
          setReview({ response, draft: response.draft });
          setImportOpen(true);
        }} /> : <ProfileStudio readOnly={!canEditWorkspace} onOpenStudio={(jobPostingId) => navigate({ page: "studio", selectedId: null, studioJobId: jobPostingId })} />}
      </main>

      {selectedJob && <DetailPanel readOnly={!canEditWorkspace} job={selectedJob} busy={busy} researchSalaryOnOpen={canEditWorkspace && salaryResearchId === selectedJob.id} onSalaryResearchStarted={() => setSalaryResearchId(null)} onTailorCv={() => navigate({ page: "studio", selectedId: null, studioJobId: selectedJob.id })} onClose={() => { navigate({ page: "opportunities", selectedId: null, studioJobId: null }); setSalaryResearchId(null); }} onCreateApplication={createApplication} onAddEvent={addEvent} onRefresh={() => { void client.getJob(selectedJob.id).then(setSelectedJob); void loadJobs(); }} />}
      {isImportOpen && <ImportPanel mode={importMode} setMode={(value) => { setImportMode(value); setImportError(""); }} url={importUrl} setUrl={setImportUrl} text={importText} setText={setImportText} review={review} setReview={setReview} busy={busy} importError={importError} requiresDuplicateDecision={Boolean(reviewCaptureId) || Boolean(review?.response.discoveryPostingId) || Boolean(review?.response.duplicates.length)} duplicateDecision={captureDuplicateDecision} setDuplicateDecision={setCaptureDuplicateDecision} onStart={startImport} onCommit={commitReview} onClose={() => { setImportOpen(false); setReview(null); setReviewCaptureId(null); setCaptureDuplicateDecision(null); setImportError(""); }} />}
      {shareOpen && <ShareWorkspace onClose={() => setShareOpen(false)} />}
    </div>
  );
}

function Sidebar({ page, session, onNavigate, onShare, onExport, onRestore }: { page: Page; session: WorkspaceSessionRecord | null; onNavigate: (page: Page) => void; onShare: () => void; onExport: () => void; onRestore: () => void }) {
  const canEdit = session?.workspace.role !== "viewer";
  const isOwner = session?.workspace.role === "owner";
  const member = session?.members.find((item) => item.id === session.user.memberId);
  const displayName = member?.displayName || session?.user.email || "CareerOS user";
  const initials = displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <aside className="sidebar">
    <div className="brand-mark"><div className="brand-glyph">C</div><div><strong>CareerOS</strong></div></div>
    <nav className="side-nav">
      <div className="nav-label">WORKSPACE</div>
      <button className={`nav-item ${page === "opportunities" ? "active" : ""}`} onClick={() => onNavigate("opportunities")}><BriefcaseBusiness size={17} /><span>Opportunities</span><span className="nav-count">01</span></button>
      {canEdit && <button className={`nav-item ${page === "capture" ? "active" : ""}`} onClick={() => onNavigate("capture")}><ClipboardCheck size={17} /><span>Capture inbox</span></button>}
      <button className={`nav-item ${page === "discover" ? "active" : ""}`} onClick={() => onNavigate("discover")}><Eye size={17} /><span>Discover</span></button>
      <button className={`nav-item ${page === "profile" ? "active" : ""}`} onClick={() => onNavigate("profile")}><UserRound size={17} /><span>Career studio</span></button>
    </nav>
    <div className="sidebar-footer">
      <details className="account-menu">
        <summary><span className="avatar">{initials || "C"}</span><span><strong>{displayName}</strong><small>{session?.workspace.name ?? "Workspace"}</small></span><ChevronDown size={14} /></summary>
        <div className="account-popover">
          <button onClick={onShare}><Users size={15} /> Share workspace</button>
          {isOwner && <button onClick={onExport}><Download size={15} /> Export backup</button>}
          {isOwner && <button onClick={onRestore}><DatabaseBackup size={15} /> Restore backup</button>}
          <button onClick={() => void signOut()}><LogOut size={15} /> Sign out</button>
        </div>
      </details>
    </div>
  </aside>;
}

function EmptyState({ onAdd, onManual }: { onAdd: () => void; onManual: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><BriefcaseBusiness size={23} /></div><h2>Make the first move</h2><p>Your pipeline is empty. Capture a role from a public link, paste its description, or add the details yourself.</p><div className="empty-actions"><button className="primary-button" onClick={onAdd}><Link2 size={16} /> Capture a role</button><button className="quiet-button" onClick={onManual}><FileText size={16} /> Add manually</button></div></div>;
}

function ProfileStudio({ onOpenStudio, readOnly }: { onOpenStudio: (jobPostingId: string) => void; readOnly: boolean }) {
  const [workspace, setWorkspace] = useState<CareerStudioWorkspace | null>(null);
  const [draft, setDraft] = useState<ProfileRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [isDocumentImportOpen, setDocumentImportOpen] = useState(false);
  const [previewDocumentId, setPreviewDocumentId] = useState("");

  const loadWorkspace = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await client.getCareerStudio();
      setWorkspace(next);
      setDraft(next.profile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Career Studio.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadWorkspace(); }, []);

  const updateProfileField = (key: "name" | "headline" | "summary", value: string) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  };

  const updateSection = (index: number, patch: Partial<ProfileSectionInput>) => {
    if (!draft) return;
    const sections = draft.sections.map((section, currentIndex) => currentIndex === index ? { ...section, ...patch } : section);
    setDraft({ ...draft, sections });
  };

  const addSection = () => {
    if (!draft) return;
    setDraft({
      ...draft,
      sections: [...draft.sections, {
        evidenceType: "project",
        title: "New CV evidence",
        content: "",
      } as ProfileRecord["sections"][number]],
    });
  };

  const removeSection = (index: number) => {
    if (!draft) return;
    setDraft({ ...draft, sections: draft.sections.filter((_, currentIndex) => currentIndex !== index) });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const saved = await client.updateProfile({
        name: draft.name,
        headline: draft.headline,
        summary: draft.summary,
        expectedRevision: draft.revision,
        sections: draft.sections.map((section) => ({
          id: section.id,
          evidenceType: section.evidenceType,
          title: section.title,
          content: section.content,
        })),
      });
      setDraft(saved);
      setWorkspace((current) => current ? { ...current, profile: saved } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  };

  const changed = Boolean(workspace && draft && JSON.stringify(workspace.profile) !== JSON.stringify(draft));
  const onImported = () => {
    setDocumentImportOpen(false);
    void loadWorkspace();
  };

  const tailoredRoles = workspace?.roles.filter((role) => role.versionCount > 0 || role.draftUpdatedAt) ?? [];
  const untouchedRoles = workspace?.roles.filter((role) => role.versionCount === 0 && !role.draftUpdatedAt) ?? [];
  const roleCount = new Set(tailoredRoles.map((role) => role.jobPostingId)).size;
  const versionCount = workspace?.roles.reduce((total, role) => total + role.versionCount, 0) ?? 0;

  return <section className="profile-workspace">
    <div className="page-heading career-studio-heading">
      <div>
        <h1>Career Studio</h1>
      </div>
      <div className="profile-actions">
        <button className="quiet-button" onClick={() => void loadWorkspace()} disabled={loading || saving}><RefreshCw size={16} /> Refresh</button>
        {!readOnly && <button className="primary-button" onClick={() => setDocumentImportOpen(true)}><Upload size={16} /> Import source CV</button>}
      </div>
    </div>
    {error && <div className="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {loading || !draft || !workspace ? <div className="table-state"><LoaderCircle className="spin" size={20} /><span>Loading CV workspaces...</span></div> : <>
      <div className="career-studio-metrics" aria-label="Career Studio summary"><div><strong>{workspace.documents.length}</strong><span>source CVs</span></div><div><strong>{roleCount}</strong><span>roles tailored</span></div><div><strong>{versionCount}</strong><span>saved versions</span></div><div><strong>{tailoredRoles.filter((role) => role.draftUpdatedAt).length}</strong><span>active drafts</span></div></div>

      <section className="career-studio-section">
        <div className="career-section-heading"><div><h2>CVs by role</h2></div></div>
        {tailoredRoles.length ? <div className="career-role-list">
          <div className="career-role-head"><span>Role</span><span>Application</span><span>CV state</span><span>Source</span><span>Updated</span><span /></div>
          {tailoredRoles.map((role) => <button className="career-role-row" key={role.jobPostingId} onClick={() => onOpenStudio(role.jobPostingId)}>
            <span className="career-role-title"><strong>{role.title}</strong><small>{role.companyName}{role.location ? ` · ${role.location}` : ""}</small></span>
            <span><span className={`status status-${role.applicationStatus.toLowerCase().replaceAll(" ", "-")}`}>{role.applicationStatus}</span></span>
            <span className="career-version-state"><strong>{role.draftUpdatedAt ? "Draft in progress" : `Version ${role.latestVersion?.version ?? role.versionCount}`}</strong><small>{role.versionCount} saved {role.versionCount === 1 ? "version" : "versions"}</small></span>
            <span className="career-source-name">{role.baseDocumentTitle || "Choose in studio"}</span>
            <span className="career-updated">{formatDate(role.draftUpdatedAt ?? role.latestVersion?.updatedAt ?? "")}</span>
            <span className="career-open-action">Open <ArrowUpRight size={14} /></span>
          </button>)}
        </div> : <div className="career-studio-empty"><FilePenLine size={22} /><div><strong>No tailored CVs yet</strong><p>Choose an opportunity below to create its first job-specific draft.</p></div></div>}
      </section>

      <section className="career-studio-section">
        <div className="career-section-heading"><div><h2>Opportunities without a CV</h2></div></div>
        {untouchedRoles.length ? <div className="career-opportunity-grid">{untouchedRoles.map((role) => <article className="career-opportunity-row" key={role.jobPostingId}><div><strong>{role.title}</strong><span>{role.companyName}{role.location ? ` · ${role.location}` : ""}</span></div>{!readOnly && <button className="quiet-button" disabled={!workspace.documents.length} onClick={() => onOpenStudio(role.jobPostingId)}><FilePenLine size={14} /> Create CV</button>}</article>)}</div> : <p className="career-all-started">Every saved opportunity already has a CV draft or version.</p>}
      </section>

      <section className="career-studio-section career-source-library">
        <div className="career-section-heading"><div><h2>Imported CVs</h2></div>{!readOnly && <button className="text-button" onClick={() => setDocumentImportOpen(true)}><Plus size={14} /> Add source</button>}</div>
        {workspace.documents.length ? <div className="career-document-list">{workspace.documents.map((item) => <button className="career-document-row" onClick={() => setPreviewDocumentId(item.document.id)} key={item.document.id}><FileText size={18} /><div><strong>{item.document.title}</strong><span>{item.document.mimeType || "Imported document"}</span></div><span>{item.roleCount} {item.roleCount === 1 ? "role" : "roles"}</span><span>{item.versionCount} {item.versionCount === 1 ? "version" : "versions"}</span><small>{formatDate(item.latestUpdatedAt)}</small><span className="career-document-preview-action">Preview <ArrowUpRight size={13} /></span></button>)}</div> : <div className="career-studio-empty"><Upload size={22} /><div><strong>No source CVs yet</strong><p>{readOnly ? "An editor can import the first factual CV." : "CareerOS needs at least one factual CV before it can create role-specific versions."}</p></div>{!readOnly && <button className="primary-button" onClick={() => setDocumentImportOpen(true)}>Import CV</button>}</div>}
      </section>

      <details className="career-evidence-drawer">
        <summary><div><strong>Profile evidence and factual source</strong><span>{draft.sections.length} evidence records · used to prevent invented CV claims</span></div><ChevronDown size={16} /></summary>
        <div className="career-evidence-body">
          <div className="career-profile-fields"><label className="field-label">Name<input value={draft.name} readOnly={readOnly} onChange={(event) => updateProfileField("name", event.target.value)} /></label><label className="field-label">Headline<input value={draft.headline} readOnly={readOnly} onChange={(event) => updateProfileField("headline", event.target.value)} /></label><label className="field-label wide">Profile summary<textarea value={draft.summary} readOnly={readOnly} onChange={(event) => updateProfileField("summary", event.target.value)} /></label></div>
          <div className="section-heading"><h3>Evidence records</h3>{!readOnly && <button className="quiet-button small-button" onClick={addSection}><Plus size={15} /> Add evidence</button>}</div>
          <div className="career-evidence-list">{draft.sections.map((section, index) => <div className="career-evidence-row" key={section.id ?? `new-${index}`}><label className="compact-select">Type<select value={section.evidenceType} disabled={readOnly} onChange={(event) => updateSection(index, { evidenceType: event.target.value as ProfileSectionInput["evidenceType"] })}>{profileSectionTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><input value={section.title} readOnly={readOnly} onChange={(event) => updateSection(index, { title: event.target.value })} aria-label="Evidence title" /><textarea value={section.content} readOnly={readOnly} onChange={(event) => updateSection(index, { content: event.target.value })} aria-label={`${section.title} evidence`} />{!readOnly && <button className="icon-button" title="Remove evidence" onClick={() => removeSection(index)}><Trash2 size={14} /></button>}</div>)}</div>
          {!readOnly && <div className="career-evidence-actions"><span>{changed ? "Unsaved evidence changes" : "Evidence is saved locally"}</span><button className="primary-button" onClick={save} disabled={!changed || saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save evidence</button></div>}
        </div>
      </details>
    </>}
    {previewDocumentId && <DocumentPreviewOverlay documentId={previewDocumentId} onClose={() => setPreviewDocumentId("")} />}
    {!readOnly && isDocumentImportOpen && <ProfileImportPanel onClose={() => setDocumentImportOpen(false)} onImported={onImported} />}
  </section>;
}

function DocumentPreviewOverlay({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<ProfileDocumentPreview | null>(null);
  const [fileUrl, setFileUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let createdUrl = "";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    void Promise.all([client.getProfileDocumentPreview(documentId), loadProfileDocumentFile(documentId)]).then(([nextPreview, nextUrl]) => { createdUrl = nextUrl; setPreview(nextPreview); setFileUrl(nextUrl); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Document preview could not be loaded."));
    return () => { window.removeEventListener("keydown", closeOnEscape); if (createdUrl) URL.revokeObjectURL(createdUrl); };
  }, [documentId, onClose]);

  const isPdf = preview?.document.mimeType.includes("pdf") || preview?.document.relativePath.toLowerCase().endsWith(".pdf");
  return <div className="document-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="document-preview-dialog" role="dialog" aria-modal="true" aria-label="Source CV preview">
      <header className="document-preview-header"><div><span>SOURCE CV</span><strong>{preview?.document.title ?? "Opening document..."}</strong><small>{preview ? `${preview.document.mimeType || "Document"} · ${Math.max(1, Math.round(preview.document.sizeBytes / 1024))} KB` : "Loading local file"}</small></div><div className="document-preview-actions">{preview && <><a className="quiet-button" href={fileUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={14} /> Open original</a><a className="quiet-button" href={fileUrl} download><Download size={14} /> Download</a></>}<button className="icon-button" title="Close preview" onClick={onClose}><X size={18} /></button></div></header>
      <div className="document-preview-body">{error ? <div className="document-preview-state"><CircleAlert size={22} /><strong>Preview unavailable</strong><p>{error}</p></div> : !preview ? <div className="document-preview-state"><LoaderCircle className="spin" size={22} /><span>Preparing preview...</span></div> : isPdf ? <iframe src={fileUrl} title={`${preview.document.title} PDF preview`} /> : <div className="document-text-preview"><div className="document-text-sheet"><h1>{preview.document.title}</h1>{preview.extractionWarning && <p className="document-preview-warning">{preview.extractionWarning}</p>}<pre>{preview.extractedText || "No extracted text is available for this document."}</pre></div></div>}</div>
    </section>
  </div>;
}

function ProfileImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (profile: ProfileRecord) => void }) {
  const [sourceType, setSourceType] = useState<"file" | "pasted_text">("file");
  const [documentType, setDocumentType] = useState<ProfileDocumentType>("cv");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [review, setReview] = useState<{ response: ProfileDocumentImportResponse; profilePatch: ProfileImportProfilePatch; sections: ProfileImportSection[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startImport = async () => {
    setBusy(true);
    setError("");
    try {
      const response = sourceType === "file" ? await client.createProfileDocumentImport({
        sourceType: "file",
        documentType,
        title: title || file?.name || "Imported profile document",
        fileName: file?.name,
        mimeType: file?.type || "application/octet-stream",
        dataBase64: file ? await readFileAsDataUrl(file) : "",
      }) : await client.createProfileDocumentImport({
        sourceType: "pasted_text",
        documentType,
        title: title || "Pasted profile evidence",
        mimeType: "text/plain",
        text,
      });
      setReview({ response, profilePatch: response.profilePatch, sections: response.sections });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import that profile document.");
    } finally {
      setBusy(false);
    }
  };

  const updatePatch = (key: keyof ProfileImportProfilePatch, value: string) => {
    if (!review) return;
    setReview({ ...review, profilePatch: { ...review.profilePatch, [key]: value } });
  };

  const updateSection = (index: number, patch: Partial<ProfileImportSection>) => {
    if (!review) return;
    setReview({ ...review, sections: review.sections.map((section, currentIndex) => currentIndex === index ? { ...section, ...patch } : section) });
  };

  const removeSection = (index: number) => {
    if (!review) return;
    setReview({ ...review, sections: review.sections.filter((_, currentIndex) => currentIndex !== index) });
  };

  const addSection = () => {
    if (!review) return;
    setReview({
      ...review,
      sections: [...review.sections, {
        evidenceType: documentType === "portfolio" ? "project" : "other",
        title: "Imported evidence",
        content: "",
        sourceExcerpt: "",
        confidence: 0.5,
      }],
    });
  };

  const commit = async () => {
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      const saved = await client.commitProfileDocumentImport({
        documentId: review.response.document?.id,
        sourceDocumentId: review.response.sourceDocumentId,
        profilePatch: review.profilePatch,
        sections: review.sections,
      });
      onImported(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save imported profile evidence.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="overlay"><aside className="import-panel profile-import-panel">
    <div className="import-header">
      <div><span className="detail-kicker">PROFILE IMPORT</span><h2>{review ? "Review extracted evidence" : "Import CV or portfolio"}</h2></div>
      <button className="icon-button" title="Close profile import" onClick={onClose}><X size={18} /></button>
    </div>

    {!review ? <>
      <div className="capture-tabs">
        <button className={sourceType === "file" ? "active" : ""} onClick={() => setSourceType("file")}><Upload size={15} /> File</button>
        <button className={sourceType === "pasted_text" ? "active" : ""} onClick={() => setSourceType("pasted_text")}><FileText size={15} /> Paste text</button>
      </div>
      <div className="capture-form">
        <div className="review-grid">
          <label className="field-label">Document type<select value={documentType} onChange={(event) => setDocumentType(event.target.value as ProfileDocumentType)}>{profileDocumentTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
          <label className="field-label">Label<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Finance CV, portfolio, quant CV..." /></label>
        </div>
        {sourceType === "file" ? <label className="file-drop">
          <input type="file" accept=".pdf,.docx,.rtf,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/rtf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <Upload size={22} />
          <strong>{file ? file.name : "Choose a PDF, DOCX, RTF, TXT, or Markdown file"}</strong>
          <span>{file ? `${Math.round(file.size / 1024)} KB ready to import` : "CareerOS stores the original file, extracts text locally, then proposes profile evidence."}</span>
        </label> : <label className="field-label">CV or portfolio text<textarea className="large-textarea" value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste CV, portfolio, project, or profile text here..." autoFocus /></label>}
        <p className="field-hint">Imports are review-first. The app will not silently add claims to your profile.</p>
      </div>
      {error && <div className="import-error"><CircleAlert size={16} /><span>{error}</span></div>}
      <div className="import-footer"><button className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={startImport} disabled={busy || (sourceType === "file" ? !file : !text.trim())}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} {busy ? "Extracting..." : "Extract evidence"}</button></div>
    </> : <div className="review-form">
      <div className={`review-note ${review.response.enrichment.mode === "ai" ? "review-note-ai" : ""}`}><Sparkles size={16} /><span>{review.response.enrichment.mode === "ai" ? `AI-assisted profile import from ${review.response.enrichment.model} in ${formatDuration(review.response.enrichment.totalDurationMs)}. ${review.response.enrichment.evidenceCount} evidenced section${review.response.enrichment.evidenceCount === 1 ? "" : "s"} ready for review.` : `${review.response.enrichment.warning ?? "Review the extracted evidence, remove anything wrong, then save it."} Ready in ${formatDuration(review.response.enrichment.totalDurationMs)}.`}{review.response.extractionWarning ? ` ${review.response.extractionWarning}` : ""}</span></div>
      <div className="review-grid">
        <label className="field-label">Name<input value={review.profilePatch.name} onChange={(event) => updatePatch("name", event.target.value)} /></label>
        <label className="field-label">Headline<input value={review.profilePatch.headline} onChange={(event) => updatePatch("headline", event.target.value)} /></label>
        <label className="field-label wide">Profile summary<textarea value={review.profilePatch.summary} onChange={(event) => updatePatch("summary", event.target.value)} /></label>
      </div>
      <div className="section-heading import-section-heading"><h3>Extracted evidence</h3><button className="quiet-button small-button" onClick={addSection}><Plus size={15} /> Add section</button></div>
      <div className="section-list">
        {!review.sections.length && <div className="inline-empty">
          <CircleAlert size={16} />
          <span>No reliable evidence sections were extracted. Check the extracted text below, paste clean text instead, or re-import after installing a better PDF text extractor.</span>
        </div>}
        {review.sections.map((section, index) => <div className="section-row imported-section" key={`${section.title}-${index}`}>
          <div className="section-row-top">
            <label className="compact-select">Type<select value={section.evidenceType} onChange={(event) => updateSection(index, { evidenceType: event.target.value as ProfileImportSection["evidenceType"] })}>{profileSectionTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <button className="icon-button" title="Remove section" onClick={() => removeSection(index)}><Trash2 size={15} /></button>
          </div>
          <label className="field-label">Title<input value={section.title} onChange={(event) => updateSection(index, { title: event.target.value })} /></label>
          <label className="field-label">Evidence<textarea value={section.content} onChange={(event) => updateSection(index, { content: event.target.value })} /></label>
          <label className="field-label">Source excerpt<textarea value={section.sourceExcerpt} onChange={(event) => updateSection(index, { sourceExcerpt: event.target.value })} /></label>
          <small className="confidence-line">{Math.round(section.confidence * 100)}% confidence</small>
        </div>)}
      </div>
      {review.response.extractedText && <details className="source-preview"><summary><FileText size={15} /> Extracted document text <ChevronDown size={15} /></summary><textarea value={review.response.extractedText} readOnly /></details>}
      {error && <div className="import-error"><CircleAlert size={16} /><span>{error}</span></div>}
      <div className="import-footer"><button className="quiet-button" onClick={() => setReview(null)}>Back</button><button className="primary-button" onClick={commit} disabled={busy || !review.sections.length}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save evidence</button></div>
    </div>}
  </aside></div>;
}

function applyCvChange(content: CvDocumentContent, change: CvChangeProposal): CvDocumentContent {
  if (change.targetField) {
    const value = change.operation === "remove" ? "" : change.proposedContent;
    const next = { ...content, inlineFormatting: (content.inlineFormatting ?? []).filter((mark) => mark.field !== change.targetField) };
    const contact = { email: next.contact?.email ?? "", phone: next.contact?.phone ?? "", website: next.contact?.website ?? "" };
    if (change.targetField === "name") return { ...next, name: value };
    if (change.targetField === "headline") return { ...next, headline: value };
    if (change.targetField === "intro") return { ...next, intro: value };
    if (change.targetField === "contact.email") return { ...next, contact: { ...contact, email: value } };
    if (change.targetField === "contact.phone") return { ...next, contact: { ...contact, phone: value } };
    if (change.targetField === "contact.website") return { ...next, contact: { ...contact, website: value } };
  }
  const sections = content.sections.map((section) => ({ ...section, sourceEvidenceIds: [...section.sourceEvidenceIds] }));
  if (change.targetSectionField && change.targetSectionId) {
    const index = sections.findIndex((section) => section.id === change.targetSectionId);
    if (index < 0 || change.operation === "reorder") return content;
    const value = change.operation === "remove" ? "" : change.proposedContent;
    sections[index] = { ...sections[index], [change.targetSectionField]: value, sourceEvidenceIds: [...new Set([...sections[index].sourceEvidenceIds, ...change.evidenceIds])] };
    const formattingField = `section:${change.targetSectionId}:${change.targetSectionField}`;
    return { ...content, inlineFormatting: (content.inlineFormatting ?? []).filter((mark) => mark.field !== formattingField), sections };
  }
  if (change.operation === "add") {
    const position = Math.min(change.proposedPosition ?? sections.length, sections.length);
    sections.splice(position, 0, { id: `new:${change.changeKey}`, evidenceType: change.proposedEvidenceType, title: change.proposedTitle, content: change.proposedContent, sourceEvidenceIds: change.evidenceIds });
    return { ...content, sections: arrangeCvGroups(sections) };
  }
  const index = sections.findIndex((section) => section.id === change.targetSectionId);
  if (index < 0) return content;
  if (change.operation === "remove") sections.splice(index, 1);
  if (change.operation === "rewrite") sections[index] = { ...sections[index], evidenceType: change.proposedEvidenceType, title: change.proposedTitle, content: change.proposedContent, sourceEvidenceIds: change.evidenceIds };
  if (change.operation === "reorder") {
    const [section] = sections.splice(index, 1);
    sections.splice(Math.min(change.proposedPosition ?? index, sections.length), 0, section);
  }
  const sectionPrefix = change.targetSectionId ? `section:${change.targetSectionId}:` : "";
  return { ...content, inlineFormatting: sectionPrefix ? (content.inlineFormatting ?? []).filter((mark) => !mark.field.startsWith(sectionPrefix)) : content.inlineFormatting, sections: arrangeCvGroups(sections) };
}

function previewCvChange(content: CvDocumentContent, change: CvChangeProposal | null) {
  if (!change || change.operation === "remove" || change.targetField || change.targetSectionField) return content;
  return applyCvChange(content, change);
}

type CvProposalDecision = "accepted" | "rejected" | "conflict";
type CvProposalDecisions = Record<string, CvProposalDecision>;

function replaceFieldMarks(content: CvDocumentContent, resolved: CvDocumentContent, field: string) {
  return {
    ...content,
    inlineFormatting: [
      ...(content.inlineFormatting ?? []).filter((mark) => mark.field !== field),
      ...(resolved.inlineFormatting ?? []).filter((mark) => mark.field === field),
    ],
  };
}

function resolveCvProposal(proposal: CvTailoringProposal, decisions: CvProposalDecisions) {
  return proposal.changes.reduce(
    (next, change) => decisions[change.id] === "accepted" ? applyCvChange(next, change) : next,
    structuredClone(proposal.baseContent),
  );
}

function fieldMarks(content: CvDocumentContent, field: string) {
  return (content.inlineFormatting ?? []).filter((mark) => mark.field === field);
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function globalFieldValue(content: CvDocumentContent, field: NonNullable<CvChangeProposal["targetField"]>) {
  if (field === "name") return content.name;
  if (field === "headline") return content.headline;
  if (field === "intro") return content.intro ?? "";
  const contact = content.contact ?? { email: "", phone: "", website: "" };
  if (field === "contact.email") return contact.email;
  if (field === "contact.phone") return contact.phone;
  return contact.website;
}

function setGlobalField(content: CvDocumentContent, source: CvDocumentContent, field: NonNullable<CvChangeProposal["targetField"]>) {
  const value = globalFieldValue(source, field);
  let next = structuredClone(content);
  if (field === "name") next.name = value;
  else if (field === "headline") next.headline = value;
  else if (field === "intro") next.intro = value;
  else {
    const contact = next.contact ?? { email: "", phone: "", website: "" };
    if (field === "contact.email") next.contact = { ...contact, email: value };
    if (field === "contact.phone") next.contact = { ...contact, phone: value };
    if (field === "contact.website") next.contact = { ...contact, website: value };
  }
  return replaceFieldMarks(next, source, field);
}

function transitionCvProposalChange(current: CvDocumentContent, proposal: CvTailoringProposal, previous: CvProposalDecisions, nextDecisions: CvProposalDecisions, change: CvChangeProposal) {
  const expected = resolveCvProposal(proposal, previous);
  const desired = resolveCvProposal(proposal, nextDecisions);
  let next = structuredClone(current);
  if (change.targetField) {
    const field = change.targetField;
    if (!sameValue(globalFieldValue(current, field), globalFieldValue(expected, field)) || !sameValue(fieldMarks(current, field), fieldMarks(expected, field))) return { content: current, conflict: true };
    return { content: setGlobalField(next, desired, field), conflict: false };
  }

  const sectionId = change.operation === "add" ? `new:${change.changeKey}` : change.targetSectionId;
  if (!sectionId) return { content: current, conflict: true };
  const currentSection = current.sections.find((section) => section.id === sectionId);
  const expectedSection = expected.sections.find((section) => section.id === sectionId);
  const desiredSection = desired.sections.find((section) => section.id === sectionId);
  const prefix = `section:${sectionId}:`;

  if (change.targetSectionField) {
    const field = change.targetSectionField;
    const formatField = `${prefix}${field}`;
    if (!currentSection || !expectedSection || !desiredSection || !sameValue(currentSection[field] ?? "", expectedSection[field] ?? "") || !sameValue(fieldMarks(current, formatField), fieldMarks(expected, formatField))) return { content: current, conflict: true };
    next.sections = next.sections.map((section) => section.id === sectionId ? { ...section, [field]: desiredSection[field], sourceEvidenceIds: [...desiredSection.sourceEvidenceIds] } : section);
    return { content: replaceFieldMarks(next, desired, formatField), conflict: false };
  }

  if (change.operation === "rewrite") {
    const currentMarks = (current.inlineFormatting ?? []).filter((mark) => mark.field.startsWith(prefix));
    const expectedMarks = (expected.inlineFormatting ?? []).filter((mark) => mark.field.startsWith(prefix));
    if (!desiredSection || !sameValue(currentSection ?? null, expectedSection ?? null) || !sameValue(currentMarks, expectedMarks)) return { content: current, conflict: true };
    next.sections = next.sections.map((section) => section.id === sectionId ? { ...section, ...structuredClone(desiredSection) } : section);
    next.inlineFormatting = [...(next.inlineFormatting ?? []).filter((mark) => !mark.field.startsWith(prefix)), ...(desired.inlineFormatting ?? []).filter((mark) => mark.field.startsWith(prefix))];
    return { content: next, conflict: false };
  }

  if (change.operation === "add" || change.operation === "remove") {
    if (!sameValue(currentSection ?? null, expectedSection ?? null)) return { content: current, conflict: true };
    if (desiredSection) {
      const desiredIndex = desired.sections.findIndex((section) => section.id === sectionId);
      next.sections.splice(Math.min(desiredIndex, next.sections.length), 0, structuredClone(desiredSection));
    } else next.sections = next.sections.filter((section) => section.id !== sectionId);
    next.inlineFormatting = [...(next.inlineFormatting ?? []).filter((mark) => !mark.field.startsWith(prefix)), ...(desired.inlineFormatting ?? []).filter((mark) => mark.field.startsWith(prefix))];
    return { content: next, conflict: false };
  }

  const knownIds = new Set(proposal.baseContent.sections.map((section) => section.id));
  const currentOrder = current.sections.filter((section) => knownIds.has(section.id)).map((section) => section.id);
  const expectedOrder = expected.sections.filter((section) => knownIds.has(section.id)).map((section) => section.id);
  if (!sameValue(currentOrder, expectedOrder)) return { content: current, conflict: true };
  const currentById = new Map(current.sections.map((section) => [section.id, section]));
  const desiredKnown = desired.sections.filter((section) => knownIds.has(section.id)).map((section) => currentById.get(section.id)).filter((section): section is CvDocumentSection => Boolean(section));
  let knownIndex = 0;
  next.sections = next.sections.map((section) => knownIds.has(section.id) ? structuredClone(desiredKnown[knownIndex++] ?? section) : section);
  return { content: next, conflict: false };
}

type TextDiffPart = { kind: "same" | "add" | "remove"; text: string };

function textDiff(before: string, after: string): TextDiffPart[] {
  const tokenize = (value: string) => value.match(/\s+|[A-Za-z0-9]+|[^A-Za-z0-9\s]/g) ?? [];
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length * right.length > 160_000) return [{ kind: "remove", text: before }, { kind: "add", text: after }];
  const width = right.length + 1;
  const matrix = new Uint16Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      matrix[row * width + column] = left[row] === right[column]
        ? matrix[(row + 1) * width + column + 1] + 1
        : Math.max(matrix[(row + 1) * width + column], matrix[row * width + column + 1]);
    }
  }
  const parts: TextDiffPart[] = [];
  const append = (kind: TextDiffPart["kind"], text: string) => {
    if (!text) return;
    const previous = parts[parts.length - 1];
    if (previous?.kind === kind) previous.text += text;
    else parts.push({ kind, text });
  };
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      append("same", left[row]);
      row += 1;
      column += 1;
    } else if (matrix[(row + 1) * width + column] >= matrix[row * width + column + 1]) {
      append("remove", left[row]);
      row += 1;
    } else {
      append("add", right[column]);
      column += 1;
    }
  }
  while (row < left.length) append("remove", left[row++]);
  while (column < right.length) append("add", right[column++]);
  return parts;
}

function InlineTextDiff({ before, after }: { before: string; after: string }) {
  return <>{textDiff(before, after).map((part, index) => <span className={`diff-${part.kind}`} key={`${part.kind}-${index}`}>{part.text}</span>)}</>;
}

type InlineFormatCommand = "bold" | "italic";
type RichTextController = { element: HTMLDivElement; field: string; commit: () => void };

function normaliseInlineMarks(marks: CvInlineFormatMark[]) {
  const sorted = marks
    .filter((mark) => mark.end > mark.start && (mark.bold || mark.italic))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CvInlineFormatMark[] = [];
  for (const mark of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.field === mark.field && previous.end === mark.start && previous.bold === mark.bold && previous.italic === mark.italic) previous.end = mark.end;
    else merged.push({ ...mark });
  }
  return merged;
}

function writeRichText(element: HTMLElement, value: string, marks: CvInlineFormatMark[]) {
  const fragment = document.createDocumentFragment();
  const boundaries = new Set([0, value.length]);
  marks.forEach((mark) => {
    boundaries.add(Math.max(0, Math.min(value.length, mark.start)));
    boundaries.add(Math.max(0, Math.min(value.length, mark.end)));
  });
  const points = [...boundaries].sort((left, right) => left - right);
  const appendText = (parent: Node, text: string) => {
    text.split("\n").forEach((part, index) => {
      if (index > 0) parent.appendChild(document.createElement("br"));
      if (part) parent.appendChild(document.createTextNode(part));
    });
  };
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const active = marks.filter((mark) => mark.start <= start && mark.end >= end);
    const bold = active.some((mark) => mark.bold);
    const italic = active.some((mark) => mark.italic);
    let container: HTMLElement | null = null;
    if (bold) container = document.createElement("strong");
    if (italic) {
      const emphasis = document.createElement("em");
      if (container) container.appendChild(emphasis);
      else container = emphasis;
      appendText(emphasis, value.slice(start, end));
    } else if (container) appendText(container, value.slice(start, end));
    if (container) fragment.appendChild(container);
    else appendText(fragment, value.slice(start, end));
  }
  element.replaceChildren(fragment);
}

function readRichText(element: HTMLElement, field: string) {
  let value = "";
  const marks: CvInlineFormatMark[] = [];
  const walk = (node: Node, inheritedBold = false, inheritedItalic = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      const start = value.length;
      value += text;
      if (text && (inheritedBold || inheritedItalic)) marks.push({ field, start, end: value.length, bold: inheritedBold, italic: inheritedItalic });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") { value += "\n"; return; }
    const weight = node.style.fontWeight;
    const bold = inheritedBold || node.tagName === "B" || node.tagName === "STRONG" || weight === "bold" || Number(weight) >= 600;
    const italic = inheritedItalic || node.tagName === "I" || node.tagName === "EM" || node.style.fontStyle === "italic";
    const block = node !== element && ["DIV", "P"].includes(node.tagName);
    if (block && value && !value.endsWith("\n")) value += "\n";
    node.childNodes.forEach((child) => walk(child, bold, italic));
    if (block && !value.endsWith("\n")) value += "\n";
  };
  element.childNodes.forEach((child) => walk(child));
  return { value: value.replace(/\n$/, ""), marks: normaliseInlineMarks(marks) };
}

function RichTextEditor({ value, marks, field, className = "", label, placeholder = "", multiline = false, onChange, onActivate, onFormatStateChange }: {
  value: string;
  marks: CvInlineFormatMark[];
  field: string;
  className?: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  onChange: (value: string, marks: CvInlineFormatMark[]) => void;
  onActivate: (controller: RichTextController) => void;
  onFormatStateChange: () => void;
}) {
  const readOnly = useContext(CvReadOnlyContext);
  const ref = useRef<HTMLDivElement>(null);
  const commit = () => {
    if (!ref.current) return;
    const next = readRichText(ref.current, field);
    onChange(next.value, next.marks);
    onFormatStateChange();
  };
  useLayoutEffect(() => {
    if (!ref.current || document.activeElement === ref.current) return;
    writeRichText(ref.current, value, marks);
  }, [value, marks]);
  return <div
    ref={ref}
    className={`studio-rich-text ${multiline ? "studio-rich-text-multiline" : "studio-rich-text-singleline"} ${className}`}
    contentEditable={!readOnly}
    suppressContentEditableWarning
    role="textbox"
    aria-label={label}
    aria-multiline={multiline}
    data-placeholder={placeholder}
    onFocus={() => { if (!readOnly && ref.current) onActivate({ element: ref.current, field, commit }); onFormatStateChange(); }}
    onInput={readOnly ? undefined : commit}
    onKeyUp={onFormatStateChange}
    onMouseUp={onFormatStateChange}
    onPaste={readOnly ? undefined : (event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); commit(); }}
    onKeyDown={(event) => {
      if (readOnly) return;
      const command = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && (command === "b" || command === "i")) {
        event.preventDefault();
        document.execCommand(command === "b" ? "bold" : "italic", false);
        commit();
        return;
      }
      if (!multiline && event.key === "Enter") event.preventDefault();
    }}
  />;
}

function ReadOnlyRichText({ content, field, value }: { content: CvDocumentContent; field: string; value: string }) {
  const marks = fieldMarks(content, field);
  const boundaries = [...new Set([0, value.length, ...marks.flatMap((mark) => [Math.max(0, Math.min(value.length, mark.start)), Math.max(0, Math.min(value.length, mark.end))])])].sort((left, right) => left - right);
  return <>{boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const active = marks.filter((mark) => mark.start <= start && mark.end >= end);
    let node = <>{value.slice(start, end)}</>;
    if (active.some((mark) => mark.italic)) node = <em>{node}</em>;
    if (active.some((mark) => mark.bold)) node = <strong>{node}</strong>;
    return <span key={`${start}-${end}`}>{node}</span>;
  })}</>;
}

type CvDraftDifference = { label: string; local: string; remote: string };

function readableDraftValue(value: unknown) {
  if (typeof value === "string") return value || "(empty)";
  return JSON.stringify(value, null, 2) || "(empty)";
}

function draftDifferences(local: CvDraftSnapshot, remoteDocument: ApplicationStudioDocument): CvDraftDifference[] {
  const remote = remoteDocument.draftContent ?? remoteDocument.versions[0]?.content ?? remoteDocument.baseContent;
  const differences: CvDraftDifference[] = [];
  const add = (label: string, localValue: unknown, remoteValue: unknown) => {
    if (!sameValue(localValue, remoteValue)) differences.push({ label, local: readableDraftValue(localValue), remote: readableDraftValue(remoteValue) });
  };
  add("Name", local.content.name, remote.name);
  add("Introduction", local.content.intro ?? "", remote.intro ?? "");
  add("Contact details", local.content.contact, remote.contact);
  add("Document formatting", local.content.style, remote.style);
  add("CV sections and ordering", local.content.sections, remote.sections);
  add("AI proposal history", local.proposalState, remoteDocument.draftProposalState ?? { turns: [], activeTurnId: null });
  return differences;
}

function snapshotProvenance(state: CvProposalState, manualSummary: string) {
  const turns = state.turns;
  const changes = turns.flatMap((turn) => turn.proposal.changes).slice(-40);
  const decisions: CvProposalDecisions = Object.fromEntries(changes.map((change) => {
    const turn = [...turns].reverse().find((item) => item.proposal.changes.some((candidate) => candidate.id === change.id));
    return [change.id, turn?.decisions[change.id] ?? "rejected"];
  }));
  const acceptedChangeIds = changes.filter((change) => decisions[change.id] === "accepted").map((change) => change.id);
  const latestTurn = turns.at(-1) ?? null;
  const summaries = turns.map((turn) => turn.proposal.summary.trim()).filter(Boolean);
  return {
    parentVersionId: latestTurn?.proposal.baseVersionId ?? null,
    acceptedChangeIds,
    proposalChanges: changes,
    proposalDecisions: decisions,
    changeSummary: summaries.length ? `${summaries.join("; ")} Manual edits may follow reviewed changes.` : manualSummary,
    provider: latestTurn?.proposal.provider ?? "manual",
    model: latestTurn?.proposal.model ?? "",
  };
}

function SnapshotDocument({ content }: { content: CvDocumentContent }) {
  const style = content.style;
  const documentStyle = {
    "--cv-font-family": style?.fontFamily === "georgia" ? "Georgia, 'Times New Roman', serif" : style?.fontFamily === "cambria" ? "'Times New Roman', Times, serif" : style?.fontFamily === "inter" ? "'Helvetica Neue', Helvetica, Arial, sans-serif" : "Arial, Helvetica, sans-serif",
    "--cv-font-size": `${style?.fontSize ?? 10.5}px`,
    "--cv-line-height": style?.lineHeight ?? 1.38,
    "--cv-entry-spacing": `${style?.entrySpacing ?? 3}px`,
    "--cv-header-spacing": `${style?.headerSpacing ?? 4}px`,
  } as CSSProperties;
  return <div className="studio-snapshot-sheet cv-name-center" style={documentStyle}>
    <header className="studio-cv-header"><div className="studio-cv-identity"><div className="studio-name-input"><ReadOnlyRichText content={content} field="name" value={content.name} /></div></div><div className="studio-contact-fields">{([['contact.email', content.contact?.email], ['contact.phone', content.contact?.phone], ['contact.website', content.contact?.website]] as const).map(([field, value]) => value ? <span key={field}><ReadOnlyRichText content={content} field={field} value={value} /></span> : null)}</div>{content.intro && <p className="studio-cv-intro"><ReadOnlyRichText content={content} field="intro" value={content.intro} /></p>}</header>
    {content.sections.map((section, index) => {
      const compact = isCompactCvSection(section);
      const group = cvGroupTitle(section);
      const previousGroup = index ? cvGroupTitle(content.sections[index - 1]) : "";
      return <div className="studio-cv-record" key={section.id}>{group !== previousGroup && !compact && <h3 className="studio-cv-group-heading" style={{ marginTop: section.spacingBefore ?? style?.sectionSpacing ?? 12 }}>{group}</h3>}{compact ? <section className="studio-cv-section studio-cv-section-compact"><div><strong><ReadOnlyRichText content={content} field={`section:${section.id}:title`} value={section.title} /></strong><span>:</span><p><ReadOnlyRichText content={content} field={`section:${section.id}:content`} value={section.content} /></p></div></section> : <section className="studio-cv-section studio-cv-entry"><div className="studio-entry-heading"><strong><ReadOnlyRichText content={content} field={`section:${section.id}:title`} value={section.title} /></strong><span className="studio-entry-date"><ReadOnlyRichText content={content} field={`section:${section.id}:date`} value={section.date ?? ""} /></span></div><div className="studio-entry-meta"><span><ReadOnlyRichText content={content} field={`section:${section.id}:subtitle`} value={section.subtitle ?? ""} /></span><span><ReadOnlyRichText content={content} field={`section:${section.id}:location`} value={section.location ?? ""} /></span></div><p><ReadOnlyRichText content={content} field={`section:${section.id}:content`} value={section.content} /></p></section>}</div>;
    })}
  </div>;
}

function CvSectionFieldDiff({ change, className = "" }: { change: CvChangeProposal; className?: string }) {
  return <div className={`studio-entry-field-diff ${className}`}><InlineTextDiff before={change.originalContent} after={change.operation === "remove" ? "" : change.proposedContent} /></div>;
}

function CvEntryDiff({ section, change, compact }: { section: CvDocumentSection; change: CvChangeProposal; compact: boolean }) {
  const beforeTitle = change.operation === "add" ? "" : change.originalTitle || section.title;
  const afterTitle = change.operation === "remove" ? "" : change.proposedTitle || section.title;
  const beforeContent = change.operation === "add" ? "" : change.originalContent || section.content;
  const afterContent = change.operation === "remove" ? "" : change.proposedContent || section.content;
  if (compact) return <section className="studio-cv-section studio-cv-section-compact studio-diff-entry"><div><strong><InlineTextDiff before={beforeTitle} after={afterTitle} /></strong><span aria-hidden="true">:</span><p><InlineTextDiff before={beforeContent} after={afterContent} /></p></div></section>;
  return <section className="studio-cv-section studio-cv-entry studio-diff-entry">
    <div className="studio-entry-heading"><strong><InlineTextDiff before={beforeTitle} after={afterTitle} /></strong><span className="studio-entry-date">{section.date}</span></div>
    {(section.subtitle || section.location) && <div className="studio-entry-meta"><span>{section.subtitle}</span><span>{section.location}</span></div>}
    <p className="studio-diff-content"><InlineTextDiff before={beforeContent} after={afterContent} /></p>
  </section>;
}

function isCompactCvSection(section: CvDocumentSection) {
  return section.evidenceType === "skill" || /^(technical skills?|skills?|interests?|languages?|additional information)$/i.test(section.title.trim());
}

function cvGroupTitle(section: CvDocumentSection) {
  if (isCompactCvSection(section)) return "Skills";
  if (section.groupTitle?.trim()) return section.groupTitle.trim();
  if (section.evidenceType === "education") return "Education";
  if (section.evidenceType === "experience") return "Professional Experience";
  if (section.evidenceType === "project") return "Projects";
  if (section.evidenceType === "achievement") return "Awards & Achievements";
  return "Additional Information";
}

function arrangeCvGroups(sections: CvDocumentSection[]) {
  const order: string[] = [];
  const grouped = new Map<string, CvDocumentSection[]>();
  for (const section of sections) {
    const group = cvGroupTitle(section);
    if (!grouped.has(group)) {
      order.push(group);
      grouped.set(group, []);
    }
    grouped.get(group)!.push(section);
  }
  return order.flatMap((group) => grouped.get(group) ?? []);
}

function estimatedWrappedLines(text: string, charactersPerLine = 96) {
  return text.split(/\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.trim().length / charactersPerLine)), 0);
}

type CvMeasurements = { entries: Record<string, number>; groupHeadings: Record<string, number>; firstHeader: number };
type CvProposalTurn = { id: string; prompt: string; proposal: CvTailoringProposal; decisions: CvProposalDecisions };
type CvPreflightIssue = { id: string; severity: "error" | "warning"; message: string };
type CvDraftSnapshot = { content: CvDocumentContent; proposalState: CvProposalState };
type CvDraftConflict = { local: CvDraftSnapshot; remote: ApplicationStudioDocument; compareOpen: boolean; remoteLoaded: boolean };

function serializeCvDraft(snapshot: CvDraftSnapshot) {
  return JSON.stringify(snapshot);
}

function FormatStepper({ label, value, onDecrease, onIncrease }: { label: string; value: string | number; onDecrease: () => void; onIncrease: () => void }) {
  return <div className="studio-spacing-control"><span>{label}</span><button className="icon-button" title={`Reduce ${label.toLowerCase()}`} onClick={onDecrease}><Minus size={12} /></button><output>{value}</output><button className="icon-button" title={`Increase ${label.toLowerCase()}`} onClick={onIncrease}><Plus size={12} /></button></div>;
}

function paginateCvSections(sections: CvDocumentSection[], measurements: CvMeasurements | null, sectionSpacing: number, entrySpacing: number) {
  const pages: CvDocumentSection[][] = [[]];
  let usedHeight = measurements ? measurements.firstHeader + 8 : 5;
  let previousGroup = "";
  for (const section of sections) {
    const compact = isCompactCvSection(section);
    const group = cvGroupTitle(section);
    const topGap = compact ? entrySpacing : section.spacingBefore ?? sectionSpacing;
    const estimatedUnits = estimatedWrappedLines(section.content) + (compact ? 1.25 : 3.5);
    let sectionHeight = measurements
      ? (measurements.entries[section.id] ?? estimatedUnits * 14.5) + entrySpacing + (group === previousGroup ? 0 : compact ? topGap : (measurements.groupHeadings[group] ?? 20) + topGap)
      : estimatedUnits + entrySpacing / 14.5 + (group === previousGroup ? 0 : compact ? topGap / 14.5 : 2.25 + topGap / 14.5);
    const pageCapacity = measurements ? 892 : (pages.length === 1 ? 58 : 62);
    if (pages[pages.length - 1].length && usedHeight + sectionHeight > pageCapacity) {
      pages.push([]);
      usedHeight = measurements ? 31 : 2;
      previousGroup = "";
      sectionHeight = measurements
        ? (measurements.entries[section.id] ?? estimatedUnits * 14.5) + entrySpacing + (compact ? topGap : (measurements.groupHeadings[group] ?? 20) + topGap)
        : estimatedUnits + entrySpacing / 14.5 + (compact ? topGap / 14.5 : 2.25 + topGap / 14.5);
    }
    pages[pages.length - 1].push(section);
    usedHeight += sectionHeight;
    previousGroup = group;
  }
  return pages;
}

function ApplicationStudio({ session, jobPostingId, remoteMutationTick, readOnly, registerNavigationGuard, onBack, onOpenProfile }: { session: WorkspaceSessionRecord | null; jobPostingId: string; remoteMutationTick: number; readOnly: boolean; registerNavigationGuard: (guard: (() => Promise<boolean>) | null) => void; onBack: () => void; onOpenProfile: () => void }) {
  const [workspace, setWorkspace] = useState<ApplicationStudioWorkspace | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [content, setContent] = useState<CvDocumentContent>({ name: "", headline: "", inlineFormatting: [], sections: [] });
  const [proposal, setProposal] = useState<CvTailoringProposal | null>(null);
  const [decisions, setDecisions] = useState<CvProposalDecisions>({});
  const [proposalTurns, setProposalTurns] = useState<CvProposalTurn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [draftSaveState, setDraftSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState("");
  const [draggedSectionId, setDraggedSectionId] = useState("");
  const [draggedGroupTitle, setDraggedGroupTitle] = useState("");
  const [hoveredChangeId, setHoveredChangeId] = useState("");
  const [activeChangeId, setActiveChangeId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [formatNotice, setFormatNotice] = useState("");
  const [inlineFormatState, setInlineFormatState] = useState({ bold: false, italic: false });
  const [measurements, setMeasurements] = useState<CvMeasurements | null>(null);
  const [preflightIssues, setPreflightIssues] = useState<CvPreflightIssue[] | null>(null);
  const [snapshotPreview, setSnapshotPreview] = useState<DocumentVersionRecord | null>(null);
  const [checkpointName, setCheckpointName] = useState("");
  const [markExportSubmitted, setMarkExportSubmitted] = useState(false);
  const [draftConflict, setDraftConflict] = useState<CvDraftConflict | null>(null);
  const [mobilePane, setMobilePane] = useState<"context" | "document" | "proposals">("document");
  const documentPagesRef = useRef<HTMLDivElement>(null);
  const persistedDraftJsonRef = useRef("");
  const latestDraftRef = useRef<{ documentId: string; content: CvDocumentContent; proposalState: CvProposalState; expectedRevision: number | null } | null>(null);
  const draftRevisionRef = useRef<number | null>(null);
  const draftStateByDocumentRef = useRef(new Map<string, { revision: number | null; persistedJson: string }>());
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const draftSaveTimerRef = useRef<number | null>(null);
  const draftConflictDocumentRef = useRef("");
  const draftConflictRemoteLoadedRef = useRef(false);
  const formatNoticeTimerRef = useRef<number | null>(null);
  const activeRichEditorRef = useRef<RichTextController | null>(null);
  const commentDraftDirtyRef = useRef(false);
  const contentRef = useRef(content);
  const proposalStateRef = useRef<CvProposalState>({ turns: [], activeTurnId: null });
  const undoStackRef = useRef<CvDraftSnapshot[]>([]);
  const redoStackRef = useRef<CvDraftSnapshot[]>([]);
  const historyGroupRef = useRef<{ key: string; at: number } | null>(null);

  const resetContent = (next: CvDocumentContent) => {
    contentRef.current = next;
    undoStackRef.current = [];
    redoStackRef.current = [];
    historyGroupRef.current = null;
    setContent(next);
  };
  const restoreDraftSnapshot = (snapshot: CvDraftSnapshot) => {
    const restored = structuredClone(snapshot);
    contentRef.current = restored.content;
    proposalStateRef.current = restored.proposalState;
    setContent(restored.content);
    setProposalTurns(restored.proposalState.turns);
    setActiveTurnId(restored.proposalState.activeTurnId ?? "");
    const turn = restored.proposalState.turns.find((item) => item.id === restored.proposalState.activeTurnId) ?? restored.proposalState.turns.at(-1) ?? null;
    setProposal(turn?.proposal ?? null);
    setDecisions(turn?.decisions ?? {});
    setHoveredChangeId("");
    setActiveChangeId("");
  };
  const commitDraft = (nextContent: CvDocumentContent, nextProposalState: CvProposalState, historyKey = "discrete") => {
    const current = contentRef.current;
    const currentProposalState = proposalStateRef.current;
    if (serializeCvDraft({ content: nextContent, proposalState: nextProposalState }) === serializeCvDraft({ content: current, proposalState: currentProposalState })) return;
    const now = Date.now();
    const previousGroup = historyGroupRef.current;
    const grouped = historyKey.startsWith("text:") && previousGroup?.key === historyKey && now - previousGroup.at < 900;
    if (!grouped) undoStackRef.current = [...undoStackRef.current.slice(-99), structuredClone({ content: current, proposalState: currentProposalState })];
    redoStackRef.current = [];
    historyGroupRef.current = { key: historyKey, at: now };
    restoreDraftSnapshot({ content: nextContent, proposalState: nextProposalState });
  };
  const commitContent = (update: CvDocumentContent | ((current: CvDocumentContent) => CvDocumentContent), historyKey = "discrete") => {
    const current = contentRef.current;
    const next = typeof update === "function" ? update(current) : update;
    commitDraft(next, proposalStateRef.current, historyKey);
  };
  const undoContent = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    activeRichEditorRef.current?.element.blur();
    redoStackRef.current.push(structuredClone({ content: contentRef.current, proposalState: proposalStateRef.current }));
    historyGroupRef.current = null;
    restoreDraftSnapshot(previous);
  };
  const redoContent = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    activeRichEditorRef.current?.element.blur();
    undoStackRef.current.push(structuredClone({ content: contentRef.current, proposalState: proposalStateRef.current }));
    historyGroupRef.current = null;
    restoreDraftSnapshot(next);
  };

  const useDocument = (document: ApplicationStudioDocument) => {
    setSelectedDocumentId(document.document.id);
    const sourceContent = document.draftContent ?? document.versions[0]?.content ?? document.baseContent;
    const nextContent: CvDocumentContent = {
      ...sourceContent,
      style: {
        fontFamily: "manrope",
        fontSize: 10.5,
        sectionSpacing: 12,
        entrySpacing: 3,
        headerSpacing: 4,
        lineHeight: 1.38,
        ...sourceContent.style,
        nameAlignment: "center",
      },
      inlineFormatting: sourceContent.inlineFormatting ?? [],
    };
    resetContent(nextContent);
    const restoredProposalState = document.draftProposalState ?? { turns: [], activeTurnId: null };
    proposalStateRef.current = restoredProposalState;
    const restoredTurn = restoredProposalState.turns.find((turn) => turn.id === restoredProposalState.activeTurnId)
      ?? restoredProposalState.turns[restoredProposalState.turns.length - 1]
      ?? null;
    const persistedSnapshot = serializeCvDraft({ content: sourceContent, proposalState: restoredProposalState });
    persistedDraftJsonRef.current = persistedSnapshot;
    draftRevisionRef.current = document.draftRevision;
    draftStateByDocumentRef.current.set(document.document.id, { revision: document.draftRevision, persistedJson: persistedSnapshot });
    latestDraftRef.current = { documentId: document.document.id, content: nextContent, proposalState: restoredProposalState, expectedRevision: document.draftRevision };
    setDraftSaveState(document.draftContent ? "saved" : "idle");
    setLastDraftSavedAt(document.draftUpdatedAt ?? "");
    setProposal(restoredTurn?.proposal ?? null);
    setDecisions(restoredTurn?.decisions ?? {});
    setHoveredChangeId("");
    setActiveChangeId("");
    setProposalTurns(restoredProposalState.turns);
    setActiveTurnId(restoredTurn?.id ?? "");
    setHistoryOpen(false);
    setError("");
    setMessage("");
  };

  const loadWorkspace = async (preferredDocumentId?: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await client.getApplicationStudio(jobPostingId);
      setWorkspace(next);
      const selected = next.documents.find((item) => item.document.id === (preferredDocumentId || selectedDocumentId))
        ?? next.documents.find((item) => item.usable)
        ?? next.documents[0];
      if (selected) useDocument(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Application Studio could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadWorkspace(); }, [jobPostingId]);

  const currentProposalState = useMemo<CvProposalState>(() => ({ turns: proposalTurns, activeTurnId: activeTurnId || null }), [proposalTurns, activeTurnId]);
  useEffect(() => { proposalStateRef.current = currentProposalState; }, [currentProposalState]);

  const queueLatestDraftSave = () => {
    const latest = latestDraftRef.current;
    if (!latest || draftConflictDocumentRef.current === latest.documentId) return draftSaveChainRef.current;
    const documentId = latest.documentId;
    const snapshot = structuredClone(latest.content);
    const proposalStateSnapshot = structuredClone(latest.proposalState);
    const serialized = serializeCvDraft({ content: snapshot, proposalState: proposalStateSnapshot });
    if (serialized === draftStateByDocumentRef.current.get(documentId)?.persistedJson) return draftSaveChainRef.current;
    setDraftSaveState("saving");
    draftSaveChainRef.current = draftSaveChainRef.current.then(async () => {
        if (draftConflictDocumentRef.current === documentId) return;
        const currentState = draftStateByDocumentRef.current.get(documentId) ?? { revision: null, persistedJson: "" };
        if (currentState.persistedJson === serialized) return;
        const saved = await client.saveCvDraft(jobPostingId, { documentId, content: snapshot, proposalState: proposalStateSnapshot, expectedRevision: currentState.revision });
        draftStateByDocumentRef.current.set(documentId, { revision: saved.revision, persistedJson: serialized });
        if (latestDraftRef.current?.documentId !== documentId) return;
        draftRevisionRef.current = saved.revision;
        persistedDraftJsonRef.current = serialized;
        setLastDraftSavedAt(saved.updatedAt);
        const latest = latestDraftRef.current;
        const latestSerialized = latest?.documentId === documentId
          ? serializeCvDraft({ content: latest.content, proposalState: latest.proposalState })
          : "";
        setDraftSaveState(latestSerialized === serialized ? "saved" : "saving");
      }).catch(async (cause) => {
        if (latestDraftRef.current?.documentId !== documentId) return;
        setDraftSaveState("error");
        if (cause instanceof CareerOSRequestError && cause.statusCode === 409) {
          draftConflictDocumentRef.current = documentId;
          draftConflictRemoteLoadedRef.current = false;
          try {
            const remoteWorkspace = await client.getApplicationStudio(jobPostingId);
            const remote = remoteWorkspace.documents.find((item) => item.document.id === documentId);
            if (remote) {
              const latest = latestDraftRef.current;
              const local = latest?.documentId === documentId ? { content: latest.content, proposalState: latest.proposalState } : { content: snapshot, proposalState: proposalStateSnapshot };
              setDraftConflict({ local: structuredClone(local), remote, compareOpen: false, remoteLoaded: false });
              setError("");
              return;
            }
          } catch { /* Keep the original conflict message when recovery data cannot be loaded. */ }
        }
        setError(cause instanceof Error ? cause.message : "This CV could not be autosaved.");
      });
    return draftSaveChainRef.current;
  };

  const flushDraftSave = async () => {
    if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = null;
    await queueLatestDraftSave();
    await draftSaveChainRef.current;
    const latest = latestDraftRef.current;
    const persisted = latest ? draftStateByDocumentRef.current.get(latest.documentId)?.persistedJson : "";
    if (latest && serializeCvDraft({ content: latest.content, proposalState: latest.proposalState }) !== persisted) {
      throw new Error("This CV has not finished saving.");
    }
  };

  useEffect(() => {
    if (!selectedDocumentId) return;
    latestDraftRef.current = { documentId: selectedDocumentId, content, proposalState: currentProposalState, expectedRevision: draftRevisionRef.current };
    if (draftConflictDocumentRef.current === selectedDocumentId && !draftConflictRemoteLoadedRef.current) {
      setDraftConflict((current) => current?.remote.document.id === selectedDocumentId ? { ...current, local: structuredClone({ content, proposalState: currentProposalState }) } : current);
      return;
    }
    const serialized = serializeCvDraft({ content, proposalState: currentProposalState });
    if (serialized === draftStateByDocumentRef.current.get(selectedDocumentId)?.persistedJson) return;
    setDraftSaveState("saving");
    if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
    const timer = window.setTimeout(() => {
      if (draftSaveTimerRef.current === timer) draftSaveTimerRef.current = null;
      void queueLatestDraftSave();
    }, 350);
    draftSaveTimerRef.current = timer;
    return () => {
      if (draftSaveTimerRef.current === timer) {
        window.clearTimeout(timer);
        draftSaveTimerRef.current = null;
      }
    };
  }, [content, currentProposalState, jobPostingId, selectedDocumentId]);

  useEffect(() => {
    const protectUnsavedDraft = (event: BeforeUnloadEvent) => {
      const latest = latestDraftRef.current;
      const persisted = latest ? draftStateByDocumentRef.current.get(latest.documentId)?.persistedJson : "";
      if (draftSaveState !== "saving" && (!latest || serializeCvDraft({ content: latest.content, proposalState: latest.proposalState }) === persisted)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedDraft);
    return () => window.removeEventListener("beforeunload", protectUnsavedDraft);
  }, [draftSaveState]);

  useEffect(() => {
    const saveBeforeSuspension = () => {
      if (document.visibilityState === "hidden") void queueLatestDraftSave();
    };
    const saveBeforePageHide = () => { void queueLatestDraftSave(); };
    document.addEventListener("visibilitychange", saveBeforeSuspension);
    window.addEventListener("pagehide", saveBeforePageHide);
    return () => {
      document.removeEventListener("visibilitychange", saveBeforeSuspension);
      window.removeEventListener("pagehide", saveBeforePageHide);
    };
  }, []);

  useEffect(() => {
    registerNavigationGuard(async () => {
      try {
        await flushDraftSave();
        const latest = latestDraftRef.current;
        const persisted = latest ? draftStateByDocumentRef.current.get(latest.documentId)?.persistedJson : "";
        if (latest && serializeCvDraft({ content: latest.content, proposalState: latest.proposalState }) !== persisted) {
          setError("This CV has not finished saving. Wait a moment, then go back again.");
          return false;
        }
        if (commentDraftDirtyRef.current) {
          setError("Send or clear the unsent collaborator comment before leaving Application Studio.");
          return false;
        }
        return true;
      } catch {
        setError("This CV has not finished saving. Resolve the autosave error before leaving.");
        return false;
      }
    });
    return () => registerNavigationGuard(null);
  }, [registerNavigationGuard]);

  useEffect(() => {
    const handleUndo = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const command = event.key.toLowerCase();
      if (command !== "z" && !(event.ctrlKey && command === "y")) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const insideDocument = Boolean(target.closest(".studio-document-pane"));
      const insideUnrelatedEditor = Boolean(target.closest('input, textarea, [contenteditable="true"]'));
      if (!insideDocument && (!activeRichEditorRef.current || insideUnrelatedEditor)) return;
      event.preventDefault();
      if (event.shiftKey || command === "y") redoContent();
      else undoContent();
    };
    window.addEventListener("keydown", handleUndo, true);
    return () => window.removeEventListener("keydown", handleUndo, true);
  }, []);

  useEffect(() => () => {
    if (formatNoticeTimerRef.current) window.clearTimeout(formatNoticeTimerRef.current);
    if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
  }, []);

  const selectedDocument = workspace?.documents.find((item) => item.document.id === selectedDocumentId) ?? null;
  const selectDocument = async (document: ApplicationStudioDocument) => {
    if (document.document.id === selectedDocumentId || busy) return;
    setBusy(true);
    setError("");
    try {
      await flushDraftSave();
      useDocument(document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CareerOS could not finish saving the current CV before switching.");
    } finally {
      setBusy(false);
    }
  };
  const evidenceById = useMemo(() => new Map((workspace?.profile.sections ?? []).map((section) => [section.id, section])), [workspace]);
  const activeTurn = proposalTurns.find((turn) => turn.id === activeTurnId) ?? null;
  const proposalEditable = Boolean(activeTurn);
  const hasUndecidedChanges = proposal?.changes.some((change) => !decisions[change.id] || decisions[change.id] === "conflict") ?? false;
  const pendingChanges = useMemo(() => proposal?.changes.filter((change) => !decisions[change.id] || decisions[change.id] === "conflict") ?? [], [proposal, decisions]);

  useEffect(() => {
    if (!remoteMutationTick || pendingChanges.length || draftSaveState === "error") return;
    void draftSaveChainRef.current.then(() => {
      const latest = latestDraftRef.current;
      const persisted = latest ? draftStateByDocumentRef.current.get(latest.documentId)?.persistedJson : "";
      if (!latest || serializeCvDraft({ content: latest.content, proposalState: latest.proposalState }) !== persisted) return;
      const documentId = latest.documentId;
      const baseline = persisted;
      const revision = draftStateByDocumentRef.current.get(documentId)?.revision ?? null;
      void client.getApplicationStudio(jobPostingId).then((next) => {
        const current = latestDraftRef.current;
        const currentPersisted = draftStateByDocumentRef.current.get(documentId)?.persistedJson ?? "";
        if (!current || current.documentId !== documentId || currentPersisted !== baseline
          || serializeCvDraft({ content: current.content, proposalState: current.proposalState }) !== baseline) return;
        setWorkspace(next);
        const remote = next.documents.find((item) => item.document.id === documentId);
        if (remote && remote.draftRevision !== revision) useDocument(remote);
      }).catch(() => undefined);
    });
  }, [remoteMutationTick, jobPostingId]);
  const focusedChange = pendingChanges.find((change) => change.id === (hoveredChangeId || activeChangeId)) ?? null;
  const previewChanges = useMemo(() => focusedChange ? [focusedChange] : pendingChanges, [focusedChange, pendingChanges]);
  const previewContent = useMemo(() => previewChanges.reduce(previewCvChange, content), [content, previewChanges]);
  const previewChangeBySectionId = useMemo(() => new Map(previewChanges.flatMap((change) => change.targetField ? [] : [[change.operation === "add" ? `new:${change.changeKey}` : change.targetSectionId ?? "", change] as const])), [previewChanges]);
  const previewFieldChange = (targetField: CvChangeProposal["targetField"]) => previewChanges.find((change) => change.targetField === targetField) ?? null;
  const introPreviewChange = previewFieldChange("intro");
  const namePreviewChange = previewFieldChange("name");
  const emailPreviewChange = previewFieldChange("contact.email");
  const phonePreviewChange = previewFieldChange("contact.phone");
  const websitePreviewChange = previewFieldChange("contact.website");
  const wordCount = useMemo(() => [previewContent.name, previewContent.intro, ...previewContent.sections.flatMap((section) => [section.title, section.content])].join(" ").trim().split(/\s+/).filter(Boolean).length, [previewContent]);
  const cvStyle = { fontFamily: "manrope", fontSize: 10.5, sectionSpacing: 12, entrySpacing: 3, headerSpacing: 4, lineHeight: 1.38, ...content.style, nameAlignment: "center" } as const;
  const cvPages = useMemo(() => paginateCvSections(previewContent.sections, measurements, cvStyle.sectionSpacing, cvStyle.entrySpacing), [previewContent.sections, measurements, cvStyle.sectionSpacing, cvStyle.entrySpacing]);
  const pageCount = cvPages.length;
  const overflow = pageCount > 1;
  const previewScale = 700 / (210 * 96 / 25.4);
  const documentStyle = {
    "--cv-font-family": cvStyle.fontFamily === "georgia" ? "Georgia, 'Times New Roman', serif" : cvStyle.fontFamily === "cambria" ? "'Times New Roman', Times, serif" : cvStyle.fontFamily === "inter" ? "'Helvetica Neue', Helvetica, Arial, sans-serif" : "Arial, Helvetica, sans-serif",
    // The editor displays a 210 mm A4 page at 700 px. Scale type by the same
    // factor so the preview and the full-size PDF retain identical proportions.
    "--cv-preview-scale": previewScale,
    "--cv-font-size": `${cvStyle.fontSize * previewScale}pt`,
    "--cv-section-spacing": `${cvStyle.sectionSpacing * previewScale}px`,
    "--cv-entry-spacing": `${cvStyle.entrySpacing * previewScale}px`,
    "--cv-header-spacing": `${cvStyle.headerSpacing * previewScale}px`,
    "--cv-line-height": cvStyle.lineHeight,
  } as CSSProperties;

  const generate = async (direction: string) => {
    if (!selectedDocumentId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const exactBaseContent = structuredClone(contentRef.current);
      const response = await client.tailorCv(jobPostingId, { documentId: selectedDocumentId, instructions: direction, baseContent: exactBaseContent });
      const next = { ...response, baseContent: exactBaseContent };
      setProposal(next);
      setDecisions({});
      const turnId = crypto.randomUUID();
      setProposalTurns((current) => [...current, { id: turnId, prompt: direction, proposal: next, decisions: {} }].slice(-30));
      setActiveTurnId(turnId);
      setHoveredChangeId("");
      setActiveChangeId("");
      setMessage(`${next.changes.length} reviewable change${next.changes.length === 1 ? "" : "s"} ready in ${formatDuration(next.durationMs)}.`);
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : "CareerOS could not tailor this CV.";
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const sendChat = () => {
    const direction = chatInput.trim();
    if (!direction || busy) return;
    setChatInput("");
    void generate(direction);
  };

  const flushActiveRichEditor = () => {
    activeRichEditorRef.current?.commit();
  };

  const updateDecisions = (next: CvProposalDecisions) => {
    flushActiveRichEditor();
    const nextState: CvProposalState = {
      ...proposalStateRef.current,
      turns: proposalStateRef.current.turns.map((turn) => turn.id === activeTurnId ? { ...turn, decisions: next } : turn),
    };
    commitDraft(contentRef.current, nextState);
  };

  const openProposalTurn = (turn: CvProposalTurn) => {
    setProposal(turn.proposal);
    setDecisions(turn.decisions);
    setActiveTurnId(turn.id);
    setHoveredChangeId("");
    setActiveChangeId("");
  };

  const acceptChange = (change: CvChangeProposal) => {
    flushActiveRichEditor();
    if (!proposal || (decisions[change.id] && decisions[change.id] !== "conflict")) return;
    const nextDecisions = { ...decisions, [change.id]: "accepted" as const };
    const transition = transitionCvProposalChange(contentRef.current, proposal, decisions, nextDecisions, change);
    const resolvedDecisions = transition.conflict ? { ...decisions, [change.id]: "conflict" as const } : nextDecisions;
    const nextState: CvProposalState = { ...proposalStateRef.current, turns: proposalStateRef.current.turns.map((turn) => turn.id === activeTurnId ? { ...turn, decisions: resolvedDecisions } : turn) };
    commitDraft(transition.content, nextState);
    setActiveChangeId("");
  };

  const rejectChange = (changeId: string) => {
    flushActiveRichEditor();
    updateDecisions({ ...decisions, [changeId]: "rejected" });
    setActiveChangeId("");
  };

  const undoDecision = (changeId: string) => {
    flushActiveRichEditor();
    if (!proposal) return;
    const nextDecisions = Object.fromEntries(Object.entries(decisions).filter(([id]) => id !== changeId));
    const transition = decisions[changeId] === "accepted"
      ? transitionCvProposalChange(contentRef.current, proposal, decisions, nextDecisions, proposal.changes.find((change) => change.id === changeId)!)
      : { content: contentRef.current, conflict: false };
    const resolvedDecisions = transition.conflict ? { ...decisions, [changeId]: "conflict" as const } : nextDecisions;
    const nextState: CvProposalState = { ...proposalStateRef.current, turns: proposalStateRef.current.turns.map((turn) => turn.id === activeTurnId ? { ...turn, decisions: resolvedDecisions } : turn) };
    commitDraft(transition.content, nextState);
    setActiveChangeId("");
  };

  const acceptAll = () => {
    flushActiveRichEditor();
    if (!proposal) return;
    const undecided = proposal.changes.filter((change) => !decisions[change.id] || decisions[change.id] === "conflict");
    let nextContent = contentRef.current;
    let nextDecisions = { ...decisions };
    for (const change of undecided) {
      const requested = { ...nextDecisions, [change.id]: "accepted" as const };
      const transition = transitionCvProposalChange(nextContent, proposal, nextDecisions, requested, change);
      nextContent = transition.content;
      nextDecisions = transition.conflict ? { ...nextDecisions, [change.id]: "conflict" } : requested;
    }
    const nextState: CvProposalState = { ...proposalStateRef.current, turns: proposalStateRef.current.turns.map((turn) => turn.id === activeTurnId ? { ...turn, decisions: nextDecisions } : turn) };
    commitDraft(nextContent, nextState);
    setActiveChangeId("");
  };

  const rejectAll = () => {
    flushActiveRichEditor();
    if (!proposal) return;
    updateDecisions({ ...decisions, ...Object.fromEntries(proposal.changes.filter((change) => !decisions[change.id] || decisions[change.id] === "conflict").map((change) => [change.id, "rejected" as const])) });
    setActiveChangeId("");
  };

  const inlineMarksFor = (field: string) => (content.inlineFormatting ?? []).filter((mark) => mark.field === field);
  const replaceInlineMarks = (current: CvDocumentContent, field: string, marks: CvInlineFormatMark[]) => ({
    ...current,
    inlineFormatting: [...(current.inlineFormatting ?? []).filter((mark) => mark.field !== field), ...marks],
  });
  const updateRichField = (field: string, value: string, marks: CvInlineFormatMark[], applyValue: (current: CvDocumentContent, value: string) => CvDocumentContent) => {
    commitContent((current) => applyValue(replaceInlineMarks(current, field, marks), value), `text:${field}`);
  };
  const refreshInlineFormatState = () => {
    const controller = activeRichEditorRef.current;
    const selection = window.getSelection();
    if (!controller || !selection?.anchorNode || !controller.element.contains(selection.anchorNode)) {
      setInlineFormatState({ bold: false, italic: false });
      return;
    }
    setInlineFormatState({ bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic") });
  };
  const activateRichEditor = (controller: RichTextController) => {
    activeRichEditorRef.current = controller;
    window.setTimeout(refreshInlineFormatState, 0);
  };
  const applyInlineFormat = (command: InlineFormatCommand) => {
    const controller = activeRichEditorRef.current;
    const selection = window.getSelection();
    if (!controller || !selection?.anchorNode || !controller.element.contains(selection.anchorNode)) {
      showFormatNotice("Select text in the CV first");
      return;
    }
    document.execCommand(command, false);
    controller.commit();
    refreshInlineFormatState();
  };
  const updateSection = (id: string, patch: Partial<CvDocumentSection>) => commitContent((current) => ({ ...current, sections: current.sections.map((section) => section.id === id ? { ...section, ...patch } : section) }), `text:section:${id}`);
  const updateGroupTitle = (currentTitle: string, nextTitle: string) => commitContent((current) => ({ ...current, sections: current.sections.map((section) => cvGroupTitle(section) === currentTitle ? { ...section, groupTitle: nextTitle } : section) }), `text:group:${currentTitle}`);
  const updateCvStyle = (patch: Partial<NonNullable<CvDocumentContent["style"]>>) => commitContent((current) => ({ ...current, style: { ...cvStyle, ...patch } }));
  const showFormatNotice = (value: string) => {
    setFormatNotice(value);
    if (formatNoticeTimerRef.current) window.clearTimeout(formatNoticeTimerRef.current);
    formatNoticeTimerRef.current = window.setTimeout(() => setFormatNotice(""), 1_200);
  };
  const nudgeStyle = (label: string, key: "lineHeight" | "sectionSpacing" | "entrySpacing" | "headerSpacing", value: number, amount: number, minimum: number, maximum: number, precision = 0) => {
    const next = Math.min(maximum, Math.max(minimum, Number((value + amount).toFixed(precision))));
    if (next === value) { showFormatNotice(`${label} ${amount < 0 ? "minimum" : "maximum"} reached`); return; }
    updateCvStyle({ [key]: next });
  };
  const removeSection = (id: string) => commitContent((current) => ({ ...current, inlineFormatting: (current.inlineFormatting ?? []).filter((mark) => !mark.field.startsWith(`section:${id}:`)), sections: current.sections.filter((section) => section.id !== id) }));
  const addEntry = () => commitContent((current) => {
    const activeField = activeRichEditorRef.current?.field ?? "";
    const activeSection = current.sections.find((section) => activeField.startsWith(`section:${section.id}:`));
    const groupTitle = activeSection && !isCompactCvSection(activeSection) ? cvGroupTitle(activeSection) : "Professional Experience";
    const section: CvDocumentSection = { id: `manual:${crypto.randomUUID()}`, evidenceType: activeSection?.evidenceType === "education" || activeSection?.evidenceType === "project" ? activeSection.evidenceType : "experience", groupTitle, title: "Organisation or project", subtitle: "Role or qualification", date: "", location: "", content: "- Achievement or responsibility", sourceEvidenceIds: [] };
    return { ...current, sections: arrangeCvGroups([...current.sections, section]) };
  });
  const addDocumentSection = (kind: "education" | "experience" | "project" | "skill" | "custom") => commitContent((current) => {
    const existing = new Set(current.sections.map(cvGroupTitle));
    let customIndex = 1;
    let customTitle = "New Section";
    while (existing.has(customTitle)) { customIndex += 1; customTitle = `New Section ${customIndex}`; }
    const templates = {
      education: { evidenceType: "education", groupTitle: "Education", title: "Institution", subtitle: "Qualification", content: "- Add education details" },
      experience: { evidenceType: "experience", groupTitle: "Professional Experience", title: "Organisation", subtitle: "Role", content: "- Add experience details" },
      project: { evidenceType: "project", groupTitle: "Projects", title: "Project", subtitle: "Project type", content: "- Add project details" },
      skill: { evidenceType: "skill", groupTitle: "Skills", title: "Skills", subtitle: "", content: "Add concise skills" },
      custom: { evidenceType: "other", groupTitle: customTitle, title: "Entry title", subtitle: "", content: "- Add details" },
    } as const;
    const template = templates[kind];
    const section: CvDocumentSection = { id: `manual:${crypto.randomUUID()}`, ...template, date: "", location: "", sourceEvidenceIds: [] };
    return { ...current, sections: arrangeCvGroups([...current.sections, section]) };
  });
  const moveSection = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    commitContent((current) => {
      const sections = [...current.sections];
      const sourceIndex = sections.findIndex((section) => section.id === sourceId);
      const targetIndex = sections.findIndex((section) => section.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const [moved] = sections.splice(sourceIndex, 1);
      const adjustedTarget = sections.findIndex((section) => section.id === targetId);
      const targetGroup = cvGroupTitle(sections[adjustedTarget]);
      sections.splice(adjustedTarget, 0, { ...moved, groupTitle: targetGroup });
      return { ...current, sections: arrangeCvGroups(sections) };
    });
    setDraggedSectionId("");
  };
  const moveGroup = (sourceGroup: string, targetGroup: string) => {
    if (!sourceGroup || sourceGroup === targetGroup) return;
    commitContent((current) => {
      const moved = current.sections.filter((section) => cvGroupTitle(section) === sourceGroup);
      const remaining = current.sections.filter((section) => cvGroupTitle(section) !== sourceGroup);
      const targetIndex = remaining.findIndex((section) => cvGroupTitle(section) === targetGroup);
      if (!moved.length || targetIndex < 0) return current;
      remaining.splice(targetIndex, 0, ...moved);
      return { ...current, sections: remaining };
    });
    setDraggedGroupTitle("");
  };
  const moveGroupByOffset = (group: string, offset: -1 | 1) => {
    commitContent((current) => {
      const groups = [...new Set(current.sections.map(cvGroupTitle))];
      const index = groups.indexOf(group);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= groups.length) return current;
      [groups[index], groups[target]] = [groups[target], groups[index]];
      return { ...current, sections: groups.flatMap((title) => current.sections.filter((section) => cvGroupTitle(section) === title)) };
    });
    showFormatNotice(`${group} moved ${offset < 0 ? "up" : "down"}`);
  };

  useLayoutEffect(() => {
    const root = documentPagesRef.current;
    if (!root) return;
    const entries: Record<string, number> = {};
    const groupHeadings: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>(".studio-cv-record[data-section-id]").forEach((record) => {
      const id = record.dataset.sectionId;
      const group = record.dataset.group;
      const section = record.querySelector<HTMLElement>(".studio-cv-section");
      const heading = record.querySelector<HTMLElement>(".studio-cv-group-heading");
      if (id && section) entries[id] = section.offsetHeight;
      if (group && heading) groupHeadings[group] = heading.offsetHeight;
    });
    const firstHeader = root.querySelector<HTMLElement>(".studio-cv-header")?.offsetHeight ?? 66;
    const next = { entries, groupHeadings, firstHeader };
    setMeasurements((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, [previewContent, pageCount, cvStyle.fontFamily, cvStyle.fontSize, cvStyle.lineHeight, cvStyle.nameAlignment, cvStyle.sectionSpacing, cvStyle.entrySpacing, cvStyle.headerSpacing]);

  const saveVersion = async () => {
    if (!selectedDocument) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await flushDraftSave();
      const provenance = snapshotProvenance(proposalStateRef.current, "Manual job-specific CV edits.");
      const saved = await client.createDocumentVersion(jobPostingId, {
        documentId: selectedDocument.document.id,
        ...provenance,
        parentVersionId: provenance.parentVersionId ?? selectedDocument.versions[0]?.id ?? null,
        expectedDraftRevision: draftRevisionRef.current,
        checkpointName: checkpointName.trim(),
        content,
      });
      await loadWorkspace(selectedDocument.document.id);
      setCheckpointName("");
      setMessage(`Snapshot ${saved.version} saved for ${workspace?.job.companyName}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CareerOS could not save this CV version.");
    } finally {
      setSaving(false);
    }
  };

  const restoreSnapshotAsDraft = async (snapshot: DocumentVersionRecord) => {
    if (!selectedDocument) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await flushDraftSave();
      const recoveryTurns = proposalStateRef.current.turns;
      const recoveryChanges = recoveryTurns.flatMap((turn) => turn.proposal.changes);
      const recoveryDecisions = Object.assign({}, ...recoveryTurns.map((turn) => turn.decisions));
      const safetySnapshot = await client.createDocumentVersion(jobPostingId, {
        documentId: selectedDocument.document.id,
        parentVersionId: selectedDocument.versions[0]?.id ?? null,
        expectedDraftRevision: draftRevisionRef.current,
        checkpointName: `Before restoring ${snapshot.checkpointName || `snapshot ${snapshot.version}`}`.slice(0, 120),
        content: structuredClone(contentRef.current),
        acceptedChangeIds: recoveryChanges.filter((change) => recoveryDecisions[change.id] === "accepted").map((change) => change.id),
        proposalChanges: recoveryChanges,
        proposalDecisions: recoveryDecisions,
        changeSummary: `Automatic recovery point before restoring immutable snapshot ${snapshot.version}.`,
        provider: recoveryTurns.at(-1)?.proposal.provider ?? "manual",
        model: recoveryTurns.at(-1)?.proposal.model ?? "",
      });
      setWorkspace((current) => current ? {
        ...current,
        documents: current.documents.map((item) => item.document.id === selectedDocument.document.id
          ? { ...item, versions: [safetySnapshot, ...item.versions] }
          : item),
      } : current);
      const restored = structuredClone(snapshot.content);
      const restoredProposalState: CvProposalState = { turns: [], activeTurnId: null };
      commitDraft(restored, restoredProposalState, "snapshot-restore");
      const savedDraft = await client.saveCvDraft(jobPostingId, {
        documentId: selectedDocument.document.id,
        content: restored,
        proposalState: restoredProposalState,
        expectedRevision: draftRevisionRef.current,
      });
      const serialized = serializeCvDraft({ content: restored, proposalState: restoredProposalState });
      draftStateByDocumentRef.current.set(selectedDocument.document.id, { revision: savedDraft.revision, persistedJson: serialized });
      draftRevisionRef.current = savedDraft.revision;
      persistedDraftJsonRef.current = serialized;
      latestDraftRef.current = { documentId: selectedDocument.document.id, content: restored, proposalState: restoredProposalState, expectedRevision: savedDraft.revision };
      setDraftSaveState("saved");
      setLastDraftSavedAt(savedDraft.updatedAt);
      setSnapshotPreview(null);
      setMessage(`Snapshot ${snapshot.version} restored into the active draft. A recovery snapshot was saved first.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This snapshot could not be restored safely.");
    } finally {
      setSaving(false);
    }
  };

  const runExportPreflight = () => {
    const issues: CvPreflightIssue[] = [];
    const pages = [...(documentPagesRef.current?.querySelectorAll<HTMLElement>(".studio-document-page") ?? [])];
    if (!content.name.trim()) issues.push({ id: "name", severity: "error", message: "Add your name before exporting." });
    if (!content.sections.length) issues.push({ id: "sections", severity: "error", message: "The CV has no content sections." });
    if (pendingChanges.length) issues.push({ id: "proposals", severity: "error", message: `Accept or reject the ${pendingChanges.length} pending AI change${pendingChanges.length === 1 ? "" : "s"} before exporting so the PDF exactly matches the editor.` });
    pages.forEach((page, index) => {
      if (page.innerText.replace(/\s+/g, " ").trim().length < 20) issues.push({ id: `blank-${index}`, severity: "error", message: `Page ${index + 1} is unexpectedly blank.` });
      if (page.scrollHeight > page.clientHeight + 2) issues.push({ id: `overflow-${index}`, severity: "error", message: `Page ${index + 1} overflows its A4 boundary. Reduce spacing or move content before exporting.` });
      page.querySelectorAll<HTMLElement>(".studio-entry-date, .studio-entry-location, .studio-contact-fields > *").forEach((field, fieldIndex) => {
        if (field.scrollWidth > field.clientWidth + 1) issues.push({ id: `clipped-${index}-${fieldIndex}`, severity: "error", message: `Page ${index + 1} contains a clipped date, location, or contact field.` });
      });
      page.querySelectorAll<HTMLElement>(".studio-entry-heading, .studio-entry-meta").forEach((row, rowIndex) => {
        const children = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains("icon-button"));
        if (children.length >= 2 && children[0].getBoundingClientRect().right > children[children.length - 1].getBoundingClientRect().left - 2) issues.push({ id: `overlap-${index}-${rowIndex}`, severity: "error", message: `Page ${index + 1} has overlapping entry text. Shorten the date or location before exporting.` });
      });
    });
    const website = content.contact?.website?.trim() ?? "";
    if (website && !/^(https?:\/\/|www\.)/i.test(website)) issues.push({ id: "website", severity: "warning", message: "The website is missing http:// or https://, so the exported link may not open correctly." });
    const email = content.contact?.email?.trim() ?? "";
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push({ id: "email", severity: "warning", message: "The email address does not look complete." });
    for (const mark of content.inlineFormatting ?? []) {
      const sectionMatch = mark.field.match(/^section:([^:]+):(title|subtitle|date|location|content)$/);
      const section = sectionMatch ? content.sections.find((item) => item.id === sectionMatch[1]) : null;
      const fieldValue = mark.field === "name" ? content.name
        : mark.field === "headline" ? content.headline
          : mark.field === "intro" ? content.intro ?? ""
            : mark.field === "contact.email" ? content.contact?.email ?? ""
              : mark.field === "contact.phone" ? content.contact?.phone ?? ""
                : mark.field === "contact.website" ? content.contact?.website ?? ""
                  : sectionMatch?.[2] === "title" ? section?.title ?? ""
                    : sectionMatch?.[2] === "subtitle" ? section?.subtitle ?? ""
                      : sectionMatch?.[2] === "date" ? section?.date ?? ""
                        : sectionMatch?.[2] === "location" ? section?.location ?? ""
                          : sectionMatch?.[2] === "content" ? section?.content ?? "" : null;
      if (mark.start < 0 || mark.end <= mark.start || fieldValue === null || mark.end > fieldValue.length) { issues.push({ id: `format-${mark.field}-${mark.start}`, severity: "error", message: "One bold or italic range is invalid. Reapply the formatting before export." }); break; }
    }
    setPreflightIssues(issues);
  };

  const exportAcceptedDraft = async () => {
    if (!selectedDocument || preflightIssues?.some((issue) => issue.severity === "error")) return;
    setSaving(true);
    setError("");
    try {
      await flushDraftSave();
      const provenance = snapshotProvenance(proposalStateRef.current, "Immutable PDF export snapshot.");
      const saved = await client.createDocumentVersion(jobPostingId, {
        documentId: selectedDocument.document.id,
        ...provenance,
        parentVersionId: provenance.parentVersionId ?? selectedDocument.versions[0]?.id ?? null,
        expectedDraftRevision: draftRevisionRef.current,
        checkpointName: checkpointName.trim() || `PDF export ${new Date().toLocaleDateString("en-GB")}`,
        content,
      });
      const exported = await client.exportDocumentVersionPdf(saved.id, { pageSectionIds: cvPages.map((page) => page.map((section) => section.id)), markAsSubmitted: markExportSubmitted, applicationId: markExportSubmitted ? workspace?.job.applicationId ?? null : null });
      await downloadDocumentVersionPdf(exported);
      setPreflightIssues(null);
      setCheckpointName("");
      setMarkExportSubmitted(false);
      await loadWorkspace(selectedDocument.document.id);
      setMessage(`PDF exported from immutable snapshot ${saved.version}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The export snapshot could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const leaveStudio = async () => {
    try {
      await flushDraftSave();
      onBack();
    } catch {
      setError("This CV has not finished saving. Resolve the autosave error before leaving.");
    }
  };

  const reloadConflictRemote = () => {
    if (!draftConflict) return;
    draftConflictRemoteLoadedRef.current = true;
    useDocument(draftConflict.remote);
    setDraftConflict({ ...draftConflict, remoteLoaded: true, compareOpen: true });
    setMessage("Latest saved draft loaded. Your local copy is still available here.");
  };

  const retryDraftConflict = async () => {
    if (!draftConflict) return;
    const { local, remote } = draftConflict;
    setDraftSaveState("saving");
    setError("");
    try {
      const saved = await client.saveCvDraft(jobPostingId, {
        documentId: remote.document.id,
        content: local.content,
        proposalState: local.proposalState,
        expectedRevision: remote.draftRevision,
      });
      const serialized = serializeCvDraft(local);
      draftStateByDocumentRef.current.set(remote.document.id, { revision: saved.revision, persistedJson: serialized });
      draftRevisionRef.current = saved.revision;
      persistedDraftJsonRef.current = serialized;
      draftConflictDocumentRef.current = "";
      draftConflictRemoteLoadedRef.current = false;
      restoreDraftSnapshot(local);
      setLastDraftSavedAt(saved.updatedAt);
      setDraftSaveState("saved");
      setDraftConflict(null);
      setMessage("Local work saved over the reviewed remote draft.");
    } catch (cause) {
      setDraftSaveState("error");
      if (cause instanceof CareerOSRequestError && cause.statusCode === 409) {
        const nextWorkspace = await client.getApplicationStudio(jobPostingId).catch(() => null);
        const nextRemote = nextWorkspace?.documents.find((item) => item.document.id === remote.document.id);
        if (nextRemote) setDraftConflict({ local, remote: nextRemote, compareOpen: true, remoteLoaded: false });
      }
      setError(cause instanceof Error ? cause.message : "The local draft could not be retried.");
    }
  };

  if (loading) return <div className="studio-loading"><LoaderCircle className="spin" size={22} /><span>Opening Application Studio...</span></div>;
  if (!workspace) return <div className="studio-loading"><CircleAlert size={22} /><span>{error || "Application Studio is unavailable."}</span><button className="quiet-button" onClick={onBack}>Back to opportunities</button></div>;

  return <CvReadOnlyContext.Provider value={readOnly}><main className={`application-studio ${readOnly ? "studio-read-only" : ""}`}>
    <header className="studio-header">
      <button className="icon-button" title="Back to opportunity" onClick={() => void leaveStudio()}><ArrowLeft size={18} /></button>
      <div className="studio-app-title"><strong>Application Studio</strong></div>
      {workspace.documents.length > 0 && <label className="studio-document-select"><span>Base CV</span><select value={selectedDocumentId} disabled={busy} onChange={(event) => { const selected = workspace.documents.find((item) => item.document.id === event.target.value); if (selected) void selectDocument(selected); }}>{workspace.documents.map((item) => <option key={item.document.id} value={item.document.id}>{item.document.title}{item.usable ? "" : " (re-import needed)"}</option>)}</select><ChevronDown size={13} /></label>}
      <div className="studio-header-actions"><CollaborationPresence session={session} compact /><SystemStatus />{!readOnly && <><button className="quiet-button" onClick={runExportPreflight} disabled={!selectedDocument?.usable || !content.sections.length || saving}><Download size={15} /> Export PDF</button><button className="primary-button" onClick={() => void saveVersion()} disabled={!selectedDocument?.usable || !content.sections.length || saving || !checkpointName.trim()} title={!checkpointName.trim() ? "Name the checkpoint in Snapshot history first" : "Save immutable snapshot"}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} Save snapshot</button></>}</div>
    </header>

    {preflightIssues && <div className="overlay studio-preflight-overlay"><section className="studio-preflight" role="dialog" aria-modal="true" aria-labelledby="studio-preflight-title"><header><div><p className="eyebrow">PDF PREFLIGHT</p><h2 id="studio-preflight-title">{preflightIssues.some((issue) => issue.severity === "error") ? "Fix export problems" : "Ready to export"}</h2></div><button className="icon-button" aria-label="Close PDF preflight" onClick={() => setPreflightIssues(null)}><X size={17} /></button></header>{preflightIssues.length ? <div className="studio-preflight-list">{preflightIssues.map((issue) => <div className={`preflight-${issue.severity}`} key={issue.id}>{issue.severity === "error" ? <CircleAlert size={15} /> : <TriangleAlert size={15} />}<span>{issue.message}</span></div>)}</div> : <div className="studio-preflight-clear"><CircleCheck size={17} /><span>No overflow, blank pages, malformed links, or unsupported formatting detected.</span></div>}<label className="studio-submitted-choice"><input type="checkbox" checked={markExportSubmitted} disabled={!workspace?.job.applicationId} onChange={(event) => setMarkExportSubmitted(event.target.checked)} /><span>{workspace?.job.applicationId ? "Record this exact PDF as the CV submitted for this application" : "Create an application record before marking a PDF as submitted"}</span></label><footer><button className="quiet-button" onClick={() => setPreflightIssues(null)}>Back to editor</button><button className="primary-button" disabled={preflightIssues.some((issue) => issue.severity === "error") || saving} onClick={() => void exportAcceptedDraft()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />} Export verified PDF</button></footer></section></div>}
    {snapshotPreview && <div className="overlay studio-snapshot-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSnapshotPreview(null); }}><section className="studio-snapshot-dialog" role="dialog" aria-modal="true" aria-labelledby="snapshot-preview-title"><header><div><p className="eyebrow">IMMUTABLE SNAPSHOT {snapshotPreview.version}</p><h2 id="snapshot-preview-title">{snapshotPreview.content.name || "CV snapshot"}</h2><span>{formatDate(snapshotPreview.createdAt)} · read-only</span></div><button className="icon-button" aria-label="Close snapshot preview" onClick={() => setSnapshotPreview(null)}><X size={17} /></button></header><SnapshotDocument content={snapshotPreview.content} /><footer><button className="quiet-button" onClick={() => setSnapshotPreview(null)}>Close</button>{!readOnly && <button className="quiet-button" disabled={saving} onClick={() => void restoreSnapshotAsDraft(snapshotPreview)}><RefreshCw size={15} /> Restore as draft</button>}{snapshotPreview.relativePath && <button className="primary-button" onClick={() => void downloadDocumentVersionPdf(snapshotPreview)}><Download size={15} /> Download PDF</button>}</footer></section></div>}

    {!workspace.documents.length ? <section className="studio-empty"><FilePenLine size={25} /><h1>Import a CV first</h1><p>Application Studio needs one of your imported CV files as the factual starting document.</p><button className="primary-button" onClick={onOpenProfile}><Upload size={16} /> Open Career Studio</button></section> : <>
      {readOnly && <div className="viewer-banner studio-viewer-banner" role="status"><Eye size={16} /><span>View only. Ask the workspace owner for editing access to change or export this CV.</span></div>}
      <div className="studio-workspace-bar">
        <div className="studio-role-focus"><strong>{workspace.job.title}</strong><span>{workspace.job.companyName} · {workspace.job.location || "Location not specified"}</span></div>
      </div>
      {selectedDocument && !selectedDocument.usable && <div className="studio-quality-warning"><CircleAlert size={16} /><div><strong>This CV cannot be tailored yet</strong><span>{selectedDocument.qualityWarning}</span></div><button className="quiet-button" onClick={onOpenProfile}><Upload size={14} /> Re-import CV</button></div>}
      {(error || message) && <div className={`studio-feedback ${error ? "studio-feedback-error" : ""}`}>{error ? <CircleAlert size={15} /> : <CircleCheck size={15} />}<span>{error || message}</span></div>}
      {draftConflict && <section className="studio-draft-conflict" role="alert" aria-labelledby="draft-conflict-title"><CircleAlert size={17} /><div><strong id="draft-conflict-title">Newer saved draft found</strong><p>Your local work is preserved in this tab. Compare the exact content before choosing which copy to continue with.</p>{draftConflict.compareOpen && <div className="studio-conflict-comparison">{draftDifferences(draftConflict.local, draftConflict.remote).map((difference) => <article key={difference.label}><strong>{difference.label}</strong><div><section><span>Your local copy</span><pre>{difference.local}</pre></section><section><span>Latest saved copy</span><pre>{difference.remote}</pre></section></div></article>)}</div>}</div><div className="studio-conflict-actions"><button className="quiet-button" onClick={() => setDraftConflict({ ...draftConflict, compareOpen: !draftConflict.compareOpen })}><Eye size={14} /> {draftConflict.compareOpen ? "Hide comparison" : "Compare exact text"}</button><button className="quiet-button" onClick={reloadConflictRemote}><RefreshCw size={14} /> Use latest saved</button><button className="primary-button" onClick={() => void retryDraftConflict()}><Save size={14} /> {draftConflict.remoteLoaded ? "Restore local and retry" : "Keep local and save"}</button></div></section>}
      <div className="studio-mobile-tabs" role="tablist" aria-label="Application Studio areas">
        <button role="tab" aria-selected={mobilePane === "context"} onClick={() => setMobilePane("context")}>Job</button>
        <button role="tab" aria-selected={mobilePane === "document"} onClick={() => setMobilePane("document")}>CV</button>
        <button role="tab" aria-selected={mobilePane === "proposals"} onClick={() => setMobilePane("proposals")}>AI changes</button>
      </div>
      <div className="studio-panes">
        <aside className="studio-pane studio-context-pane" data-mobile-active={mobilePane === "context"}>
          <div className="studio-pane-heading"><span>01</span><h2>Job context</h2></div>
          <div className="studio-pane-scroll">
            <section><h3>Role</h3><p>{workspace.job.summary || "No concise job summary has been saved."}</p></section>
            <section><h3>Required</h3>{workspace.job.requiredRequirements.length ? workspace.job.requiredRequirements.map((requirement) => { const match = proposal?.matches.find((item) => item.requirement === requirement || item.requirement.includes(requirement) || requirement.includes(item.requirement)); return <div className="studio-requirement" key={requirement}><strong>{requirement}</strong>{match ? <><span className="match-state">{Math.round(match.confidence * 100)}% supported</span><p>{match.note}</p>{match.evidenceIds.map((id) => <small key={id}>{evidenceById.get(id)?.title ?? "Imported CV evidence"}</small>)}</> : <span className="match-state match-pending">Not assessed</span>}</div>; }) : <p className="studio-muted">No required criteria captured.</p>}</section>
            {proposal?.gaps.length ? <section><h3>Honest gaps</h3><ul className="studio-gap-list">{proposal.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></section> : null}
            <details className="studio-description"><summary>Full job description <ChevronDown size={13} /></summary><p>{workspace.job.description}</p></details>
          </div>
        </aside>

        <section className="studio-document-pane" data-mobile-active={mobilePane === "document"}>
          <div className="studio-document-toolbar">
            <div className="studio-document-status"><span>{wordCount} words</span><span>{pageCount} A4 {pageCount === 1 ? "page" : "pages"}</span><span className={overflow ? "document-overflow" : "document-fit"}>{overflow ? `Continues on page ${pageCount}` : "Fits one page"}</span><span className={`studio-draft-state draft-${draftSaveState}`}>{draftSaveState === "saving" ? "Saving..." : draftSaveState === "saved" ? `All edits saved${lastDraftSavedAt ? ` · ${formatDate(lastDraftSavedAt)}` : ""}` : draftSaveState === "error" ? "Autosave failed" : "All edits saved"}</span></div>
            <div className="studio-format-controls">
              <label>Font<select value={cvStyle.fontFamily} onChange={(event) => updateCvStyle({ fontFamily: event.target.value as NonNullable<CvDocumentContent["style"]>["fontFamily"] })}><option value="manrope">Arial</option><option value="inter">Helvetica</option><option value="georgia">Georgia</option><option value="cambria">Times</option></select></label>
              <label>Size<select value={cvStyle.fontSize} onChange={(event) => updateCvStyle({ fontSize: Number(event.target.value) })}>{[9, 9.5, 10, 10.5, 11, 11.5, 12].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              <div className="studio-emphasis-controls" aria-label="CV body text emphasis">
                <button className="icon-button" title="Undo (Command+Z)" aria-label="Undo CV edit" aria-keyshortcuts="Meta+Z Control+Z" onClick={undoContent}><Undo2 size={14} /></button>
                <button className="icon-button" title="Redo (Command+Shift+Z or Control+Y)" aria-label="Redo CV edit" aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y" onClick={redoContent}><Redo2 size={14} /></button>
                <button className={`icon-button ${inlineFormatState.bold ? "active" : ""}`} title="Bold selected text (Command+B)" aria-label="Bold selected text" aria-keyshortcuts="Meta+B Control+B" aria-pressed={inlineFormatState.bold} onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineFormat("bold")}><Bold size={14} /></button>
                <button className={`icon-button ${inlineFormatState.italic ? "active" : ""}`} title="Italicise selected text (Command+I)" aria-label="Italicise selected text" aria-keyshortcuts="Meta+I Control+I" aria-pressed={inlineFormatState.italic} onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineFormat("italic")}><Italic size={14} /></button>
              </div>
              <div className="studio-spacing-cluster">
                <FormatStepper label="Lines" value={cvStyle.lineHeight.toFixed(2)} onDecrease={() => nudgeStyle("Line spacing", "lineHeight", cvStyle.lineHeight, -0.05, 1.1, 1.8, 2)} onIncrease={() => nudgeStyle("Line spacing", "lineHeight", cvStyle.lineHeight, 0.05, 1.1, 1.8, 2)} />
                <details className="studio-spacing-details">
                  <summary title="More spacing controls" aria-label="More spacing controls"><ChevronDown size={13} /></summary>
                  <div className="studio-spacing-popover">
                    <FormatStepper label="Headings" value={cvStyle.sectionSpacing} onDecrease={() => nudgeStyle("Heading spacing", "sectionSpacing", cvStyle.sectionSpacing, -1, 0, 24)} onIncrease={() => nudgeStyle("Heading spacing", "sectionSpacing", cvStyle.sectionSpacing, 1, 0, 24)} />
                    <FormatStepper label="Entries" value={cvStyle.entrySpacing} onDecrease={() => nudgeStyle("Entry spacing", "entrySpacing", cvStyle.entrySpacing, -1, 0, 16)} onIncrease={() => nudgeStyle("Entry spacing", "entrySpacing", cvStyle.entrySpacing, 1, 0, 16)} />
                    <FormatStepper label="Header" value={cvStyle.headerSpacing} onDecrease={() => nudgeStyle("Header spacing", "headerSpacing", cvStyle.headerSpacing, -1, 0, 16)} onIncrease={() => nudgeStyle("Header spacing", "headerSpacing", cvStyle.headerSpacing, 1, 0, 16)} />
                  </div>
                </details>
              </div>
              <div className="studio-add-controls">
                <button className="text-button" onClick={addEntry}><Plus size={13} /> Add entry</button>
                <details className="studio-add-section-menu">
                  <summary className="text-button"><FolderKanban size={13} /> Add section <ChevronDown size={12} /></summary>
                  <div>{([['education', 'Education'], ['experience', 'Experience'], ['project', 'Projects'], ['skill', 'Skills'], ['custom', 'Custom']] as const).map(([kind, label]) => <button key={kind} onClick={(event) => { addDocumentSection(kind); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{label}</button>)}</div>
                </details>
              </div>
            </div>
          </div>
          {formatNotice && <div className="studio-format-notice" role="status" aria-live="polite">{formatNotice}</div>}
          <div className="studio-document-pages" ref={documentPagesRef}>
            {cvPages.map((pageSections, pageIndex) => <div className={`studio-document-page cv-name-center ${overflow ? "multi-page" : ""} ${selectedDocument?.usable ? "" : "document-unusable"}`} style={documentStyle} key={`page-${pageIndex + 1}`}>
              <span className="studio-page-number">{pageIndex + 1} / {pageCount}</span>
              {pageIndex === 0 ? <div className="studio-cv-header">
                <div className="studio-cv-identity">{namePreviewChange ? <div className={`studio-name-input studio-field-diff change-preview-${namePreviewChange.operation}`}><InlineTextDiff before={namePreviewChange.originalContent} after={namePreviewChange.operation === "remove" ? "" : namePreviewChange.proposedContent} /></div> : <RichTextEditor className="studio-name-input" field="name" value={content.name} marks={inlineMarksFor("name")} label="CV name" placeholder="Your name" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField("name", value, marks, (current, next) => ({ ...current, name: next }))} />}</div>
                <div className="studio-contact-fields">
                  {emailPreviewChange ? <div className={`studio-field-diff change-preview-${emailPreviewChange.operation}`}><InlineTextDiff before={emailPreviewChange.originalContent} after={emailPreviewChange.operation === "remove" ? "" : emailPreviewChange.proposedContent} /></div> : <RichTextEditor field="contact.email" value={content.contact?.email ?? ""} marks={inlineMarksFor("contact.email")} label="Email address" placeholder="email@example.com" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField("contact.email", value, marks, (current, next) => ({ ...current, contact: { ...(current.contact ?? { email: "", phone: "", website: "" }), email: next } }))} />}
                  {phonePreviewChange ? <div className={`studio-field-diff change-preview-${phonePreviewChange.operation}`}><InlineTextDiff before={phonePreviewChange.originalContent} after={phonePreviewChange.operation === "remove" ? "" : phonePreviewChange.proposedContent} /></div> : <RichTextEditor field="contact.phone" value={content.contact?.phone ?? ""} marks={inlineMarksFor("contact.phone")} label="Phone number" placeholder="+44 0000 000000" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField("contact.phone", value, marks, (current, next) => ({ ...current, contact: { ...(current.contact ?? { email: "", phone: "", website: "" }), phone: next } }))} />}
                  {websitePreviewChange ? <div className={`studio-field-diff change-preview-${websitePreviewChange.operation}`}><InlineTextDiff before={websitePreviewChange.originalContent} after={websitePreviewChange.operation === "remove" ? "" : websitePreviewChange.proposedContent} /></div> : <RichTextEditor field="contact.website" value={content.contact?.website ?? ""} marks={inlineMarksFor("contact.website")} label="Website" placeholder="portfolio.com" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField("contact.website", value, marks, (current, next) => ({ ...current, contact: { ...(current.contact ?? { email: "", phone: "", website: "" }), website: next } }))} />}
                </div>
                {introPreviewChange ? <div className={`studio-cv-intro studio-intro-diff change-preview-${introPreviewChange.operation}`}><InlineTextDiff before={introPreviewChange.originalContent} after={introPreviewChange.operation === "remove" ? "" : introPreviewChange.proposedContent} /></div> : <RichTextEditor className="studio-cv-intro" field="intro" value={content.intro ?? ""} marks={inlineMarksFor("intro")} label="CV introduction" placeholder="Two or three concise sentences introducing your background, strengths, and direction." multiline onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField("intro", value, marks, (current, next) => ({ ...current, intro: next }))} />}
              </div> : <div className="studio-continuation-header"><strong>{content.name}</strong><span>CV continued</span></div>}
              {pageSections.map((section, sectionIndex) => {
                const compact = isCompactCvSection(section);
                const group = cvGroupTitle(section);
                const previousGroup = sectionIndex > 0 ? cvGroupTitle(pageSections[sectionIndex - 1]) : "";
                const groupGap = section.spacingBefore ?? cvStyle.sectionSpacing;
                const sectionPreviewChange = previewChangeBySectionId.get(section.id) ?? null;
                const previewOperation = sectionPreviewChange?.operation ?? null;
                const sectionFieldChange = sectionPreviewChange?.targetSectionField ? sectionPreviewChange : null;
                const wholeEntryChange = sectionPreviewChange && !sectionPreviewChange.targetSectionField ? sectionPreviewChange : null;
                return <div className={`studio-cv-record ${draggedSectionId === section.id || draggedGroupTitle === group ? "dragging" : ""} ${previewOperation ? `change-preview change-preview-${previewOperation}` : ""}`} data-section-id={section.id} data-group={group} onDragOver={(event) => { if (draggedSectionId || draggedGroupTitle) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { event.preventDefault(); if (draggedGroupTitle) moveGroup(draggedGroupTitle, group); else moveSection(draggedSectionId, section.id); }} key={section.id}>
                  {group !== previousGroup && !compact && <div className="studio-cv-group-heading" style={{ marginTop: `${groupGap * previewScale}px` }}><button className="icon-button studio-group-drag" title={`Drag ${group} section, or use Arrow Up and Arrow Down`} aria-label={`Reorder ${group} section`} aria-keyshortcuts="ArrowUp ArrowDown" draggable onDragStart={(event) => { setDraggedGroupTitle(group); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggedGroupTitle("")} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveGroupByOffset(group, event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={13} /></button><input value={group} onChange={(event) => updateGroupTitle(group, event.target.value)} aria-label="CV group heading" />{pageIndex > 0 && content.sections.findIndex((item) => item.id === section.id) > 0 && <span>continued</span>}<div className="studio-group-spacing-controls" aria-label={`${group} spacing`}><button className="icon-button" aria-label={`Reduce spacing before ${group}`} title={`Reduce spacing before ${group}`} onClick={() => updateSection(section.id, { spacingBefore: Math.max(0, groupGap - 1) })}><Minus size={10} /></button><output>{groupGap}</output><button className="icon-button" aria-label={`Increase spacing before ${group}`} title={`Increase spacing before ${group}`} onClick={() => updateSection(section.id, { spacingBefore: Math.min(24, groupGap + 1) })}><Plus size={10} /></button></div></div>}
                  {wholeEntryChange && previewOperation !== "reorder" ? <CvEntryDiff section={section} change={wholeEntryChange} compact={compact} /> : compact ? <section className="studio-cv-section studio-cv-section-compact"><div><button className="icon-button studio-entry-drag" title="Drag to reorder entry" draggable onDragStart={(event) => { setDraggedSectionId(section.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggedSectionId("")}><GripVertical size={13} /></button><button className="icon-button studio-entry-remove" title="Remove entry" onClick={() => removeSection(section.id)}><Trash2 size={13} /></button>{sectionFieldChange?.targetSectionField === "title" ? <CvSectionFieldDiff change={sectionFieldChange} className="studio-entry-title" /> : <RichTextEditor field={`section:${section.id}:title`} value={section.title} marks={inlineMarksFor(`section:${section.id}:title`)} label="CV entry label" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:title`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, title: next } : item) }))} />}<span aria-hidden="true">:</span>{sectionFieldChange?.targetSectionField === "content" ? <CvSectionFieldDiff change={sectionFieldChange} className="studio-entry-content-diff" /> : <RichTextEditor field={`section:${section.id}:content`} value={section.content} marks={inlineMarksFor(`section:${section.id}:content`)} label={`${section.title} content`} multiline onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:content`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, content: next } : item) }))} />}</div></section> : <section className="studio-cv-section studio-cv-entry">
                    <div className="studio-entry-heading"><button className="icon-button studio-entry-drag" title="Drag to reorder entry" draggable onDragStart={(event) => { setDraggedSectionId(section.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggedSectionId("")}><GripVertical size={13} /></button><button className="icon-button studio-entry-remove" title="Remove entry" onClick={() => removeSection(section.id)}><Trash2 size={13} /></button>{sectionFieldChange?.targetSectionField === "title" ? <CvSectionFieldDiff change={sectionFieldChange} className="studio-entry-title" /> : <RichTextEditor field={`section:${section.id}:title`} value={section.title} marks={inlineMarksFor(`section:${section.id}:title`)} label="Organisation, institution, or project" placeholder="Organisation, institution, or project" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:title`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, title: next } : item) }))} />}{sectionFieldChange?.targetSectionField === "date" ? <CvSectionFieldDiff change={sectionFieldChange} className="studio-entry-date" /> : <RichTextEditor className="studio-entry-date" field={`section:${section.id}:date`} value={section.date ?? ""} marks={inlineMarksFor(`section:${section.id}:date`)} label={`${section.title} date`} placeholder="2024 - Present" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:date`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, date: next } : item) }))} />}</div>
                    <div className="studio-entry-meta">{sectionFieldChange?.targetSectionField === "subtitle" ? <CvSectionFieldDiff change={sectionFieldChange} /> : <RichTextEditor field={`section:${section.id}:subtitle`} value={section.subtitle ?? ""} marks={inlineMarksFor(`section:${section.id}:subtitle`)} label={`${section.title} role or qualification`} placeholder="Role, qualification, or project type" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:subtitle`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, subtitle: next } : item) }))} />}{sectionFieldChange?.targetSectionField === "location" ? <CvSectionFieldDiff change={sectionFieldChange} className="studio-entry-location" /> : <RichTextEditor className="studio-entry-location" field={`section:${section.id}:location`} value={section.location ?? ""} marks={inlineMarksFor(`section:${section.id}:location`)} label={`${section.title} location`} placeholder="Location" onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:location`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, location: next } : item) }))} />}</div>
                    {sectionFieldChange?.targetSectionField === "content" ? <CvSectionFieldDiff change={sectionFieldChange} className="studio-entry-content-diff" /> : <RichTextEditor field={`section:${section.id}:content`} value={section.content} marks={inlineMarksFor(`section:${section.id}:content`)} label={`${section.title} bullet points`} placeholder="- Achievement or responsibility" multiline onActivate={activateRichEditor} onFormatStateChange={refreshInlineFormatState} onChange={(value, marks) => updateRichField(`section:${section.id}:content`, value, marks, (current, next) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, content: next } : item) }))} />}
                  </section>}
                </div>;
              })}
            </div>)}
          </div>
        </section>

        <aside className="studio-pane studio-proposal-pane" data-mobile-active={mobilePane === "proposals"}>
          <div className="studio-pane-heading"><span>03</span><h2>AI changes</h2></div>
          <div className="studio-ai-chat">
            {proposalTurns.length > 0 && <div className="studio-chat-history">
              <button className="text-button" onClick={() => setHistoryOpen((value) => !value)} aria-expanded={historyOpen}><Clock3 size={13} /> {proposalTurns.length} request{proposalTurns.length === 1 ? "" : "s"}<ChevronDown className={historyOpen ? "history-chevron-open" : ""} size={13} /></button>
              {historyOpen && <div className="studio-chat-turns">{proposalTurns.map((turn, index) => { const unresolved = turn.proposal.changes.filter((change) => !turn.decisions[change.id] || turn.decisions[change.id] === "conflict").length; return <div className={`studio-chat-turn ${turn.id === activeTurnId ? "active" : ""} ${unresolved ? "has-pending" : ""}`} key={turn.id}><button className="studio-chat-turn-open" onClick={() => openProposalTurn(turn)} title={turn.prompt}><span>{String(index + 1).padStart(2, "0")}</span><strong>{turn.prompt}</strong><small>{unresolved ? `${unresolved} awaiting review` : "Reviewed"} · {formatDuration(turn.proposal.durationMs)}</small></button><button className="icon-button studio-chat-turn-copy" title="Copy full request" aria-label={`Copy request ${index + 1}`} onClick={() => void navigator.clipboard.writeText(turn.prompt)}><Copy size={12} /></button></div>; })}</div>}
            </div>}
            <form onSubmit={(event) => { event.preventDefault(); sendChat(); }}><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); } }} placeholder="Tell AI exactly what to change..." aria-label="Ask AI to propose CV changes" disabled={busy || !selectedDocument?.usable} /><button className="primary-button icon-button" type="submit" title="Generate reviewable changes" disabled={busy || !chatInput.trim() || !selectedDocument?.usable}>{busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button></form>
            {busy && <div className="studio-chat-working"><Sparkles size={12} /><span>Working</span><i /><i /><i /></div>}
          </div>
          <div className="studio-pane-scroll">
            {!proposal ? <div className="studio-proposal-empty"><Sparkles size={20} /><strong>Ready for a change</strong></div> : <>
              {activeTurn && <div className="proposal-request"><div><span>Request</span><button className="icon-button" title="Copy full request" aria-label="Copy full request" onClick={() => void navigator.clipboard.writeText(activeTurn.prompt)}><Copy size={12} /></button></div><p>{activeTurn.prompt}</p></div>}
              <div className="proposal-summary"><p>{proposal.summary}</p><small>{proposal.model} · {formatDuration(proposal.durationMs)} · {proposal.changes.length} changes</small>{proposalEditable && hasUndecidedChanges && <div><button className="quiet-button small-button" onClick={rejectAll}><X size={13} /> Reject all</button><button className="primary-button small-button" onClick={acceptAll}><Check size={13} /> Accept all</button></div>}</div>
              <div className="studio-change-list">{proposal.changes.map((change) => { const decision = decisions[change.id]; const selected = change.id === (hoveredChangeId || activeChangeId); return <article className={`studio-change change-kind-${change.operation} ${selected ? "change-active" : ""} ${decision ? `change-${decision}` : ""}`} key={change.id} tabIndex={0} onMouseEnter={() => setHoveredChangeId(change.id)} onMouseLeave={() => setHoveredChangeId("")} onFocus={() => setActiveChangeId(change.id)} onClick={() => setActiveChangeId((current) => current === change.id ? "" : change.id)}><div className="studio-change-heading"><span>{change.operation}</span><strong>{change.proposedTitle || change.originalTitle}</strong><small>{Math.round(change.confidence * 100)}%</small></div>{change.operation !== "reorder" && <div className="studio-change-copy">{change.originalContent && <p><span>Before</span>{change.originalContent}</p>}{change.operation !== "remove" && <p><span>After</span>{change.proposedContent}</p>}</div>}<p className="change-rationale">{change.rationale}</p><div className="change-evidence">{change.evidenceIds.map((id) => <span key={id}>{evidenceById.get(id)?.title ?? "Imported CV"}</span>)}{change.provenance?.kind === "user_instruction" && <span title={change.provenance.excerpt}>Supplied in this request</span>}</div>{proposalEditable && (decision === "conflict" ? <div className="change-conflict" role="status"><TriangleAlert size={13} /><span>Manual edit preserved. Restore the earlier value and retry, or keep your edit.</span><button className="quiet-button small-button" onClick={(event) => { event.stopPropagation(); rejectChange(change.id); }}>Keep manual</button><button className="primary-button small-button" onClick={(event) => { event.stopPropagation(); acceptChange(change); }}><RefreshCw size={11} /> Retry</button></div> : decision ? <div className="change-decision"><CircleCheck size={13} /> {decision}<button className="text-button" onClick={(event) => { event.stopPropagation(); undoDecision(change.id); }}><RefreshCw size={11} /> Undo</button></div> : <div className="change-actions"><button className="quiet-button small-button" onClick={(event) => { event.stopPropagation(); rejectChange(change.id); }}><X size={13} /> Reject</button><button className="primary-button small-button" onClick={(event) => { event.stopPropagation(); acceptChange(change); }}><Check size={13} /> Accept</button></div>)}</article>; })}</div>
            </>}
            {selectedDocument && <section className="studio-version-list"><h3>Snapshot history</h3><div className="studio-checkpoint-control"><input value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} maxLength={120} placeholder="Name this checkpoint" aria-label="Checkpoint name" /><button className="quiet-button" onClick={() => void saveVersion()} disabled={saving || !content.sections.length || !checkpointName.trim()}><Save size={13} /> Save</button></div>{selectedDocument.versions.length ? selectedDocument.versions.map((version) => <button key={version.id} onClick={() => setSnapshotPreview(version)}><strong>{version.checkpointName || `Snapshot ${version.version}`}</strong><span>{formatDate(version.createdAt)}</span><small>{version.relativePath ? "PDF saved · " : ""}{version.provider === "manual" ? "Manual edits" : `${version.model} · ${version.acceptedChangeIds.length}/${version.proposalChanges.length} changes accepted`}</small></button>) : <p className="studio-muted">No snapshots yet. Your current draft still autosaves.</p>}</section>}
            {selectedDocument && <WorkspaceComments readOnly={readOnly} entityType="JobPosting" entityId={jobPostingId} targetPath={`document:${selectedDocument.document.id}`} onDraftStateChange={(dirty) => { commentDraftDirtyRef.current = dirty; }} />}
          </div>
        </aside>
      </div>
    </>}
  </main></CvReadOnlyContext.Provider>;
}

function JobRowItem({ job, selected, canResearchSalary, onClick, onResearchSalary }: { job: JobRow; selected: boolean; canResearchSalary: boolean; onClick: () => void; onResearchSalary: () => void }) {
  const salaryRange = job.salaryMinAmount != null || job.salaryMaxAmount != null
    ? `${formatMoney(job.salaryMinAmount, job.salaryCurrency)}${job.salaryMinAmount != null && job.salaryMaxAmount != null ? " - " : ""}${formatMoney(job.salaryMaxAmount, job.salaryCurrency)}`
    : "Recorded";
  return <div className={`table-row table-grid ${selected ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`Open ${job.title} at ${job.companyName}`} onClick={onClick} onKeyDown={(event) => { if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return; event.preventDefault(); onClick(); }}>
    <span className="index-cell">{String(job.visibleIndex).padStart(2, "0")}</span>
    <span className="opportunity-cell" data-label="Opportunity"><strong>{job.title}</strong><small>{job.companyName}</small></span>
    <span className="track-cell" data-label="Track"><strong>{job.sector || "Uncategorised"}</strong><small>{job.roleFamily || "Role family pending"}</small></span>
    <span className="where-cell" data-label="Where"><strong>{job.location || "Location not specified"}</strong><small>{job.workMode || "Work mode not specified"}</small></span>
    <span className="date-cell deadline-cell" data-label="Deadline">
      <span>{job.applicationDeadline ? formatDate(job.applicationDeadline) : <span className="muted-text">No deadline</span>}</span>
      <span className="compact-date-meta" aria-hidden="true">
        <small title={job.postingDate ? `Employer posted: ${formatDate(job.postingDate)}` : "The employer posting date was not captured"}>Posted: {formatRelativeDate(job.postingDate)}</small>
        <small title={`CareerOS record updated: ${formatDate(job.updatedAt)}`}>CareerOS: {formatRelativeDate(job.updatedAt)}</small>
      </span>
    </span>
    <span className={`tracker-salary-cell ${job.salaryEstimateId ? "has-salary" : "salary-empty"}`} data-label="Salary">
      {job.salaryEstimateId && <span className="tracker-salary-value"><strong>{salaryRange}</strong>{job.salaryConfidence != null && job.salaryConfidence > 0 && <small className="tracker-salary-confidence">{Math.round(job.salaryConfidence * 100)}% confidence</small>}</span>}
      {canResearchSalary && <button className={`salary-research-button ${job.salaryEstimateId ? "icon-only" : ""}`} title={job.salaryEstimateId ? "Research another salary estimate" : "Research salary estimate"} aria-label={job.salaryEstimateId ? "Research another salary estimate" : "Research salary estimate"} onClick={(event) => { event.stopPropagation(); onResearchSalary(); }}><Sparkles size={12} />{!job.salaryEstimateId && <span>Research</span>}</button>}
    </span>
    <span data-label="Application">{job.applicationStatus ? <span className={statusClass(job.applicationStatus)}>{job.applicationStatus}</span> : <span className="status status-muted">Untracked</span>}</span>
    <span className={`date-cell relative-date-cell ${job.postingDate ? "" : "muted-text"}`} title={job.postingDate ? `Employer posted: ${formatDate(job.postingDate)}` : "The employer posting date was not captured"}>{formatRelativeDate(job.postingDate)}</span>
    <span className="date-cell relative-date-cell" title={`CareerOS record updated: ${formatDate(job.updatedAt)}`}>{formatRelativeDate(job.updatedAt)}</span>
  </div>;
}

function DetailPanel({ job, busy, readOnly, researchSalaryOnOpen, onSalaryResearchStarted, onTailorCv, onClose, onCreateApplication, onAddEvent, onRefresh }: { job: JobDetail; busy: boolean; readOnly: boolean; researchSalaryOnOpen: boolean; onSalaryResearchStarted: () => void; onTailorCv: () => void; onClose: () => void; onCreateApplication: () => void; onAddEvent: (input: ApplicationEventInput) => void; onRefresh: () => void }) {
  const [eventOpen, setEventOpen] = useState(false);
  const [eventType, setEventType] = useState<ApplicationEventInput["type"]>("follow_up_sent");
  const [eventNote, setEventNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<JobDraft>(job);
  const [notes, setNotes] = useState(job.notes);
  const [taskOpen, setTaskOpen] = useState(false);
  const [task, setTask] = useState<TaskCreateInput>({ title: "", taskType: "follow_up", priority: "Medium", dueDate: null, notes: "" });
  const [salaryOpen, setSalaryOpen] = useState(false);
  const [salary, setSalary] = useState({ estimateType: "manual", minAmount: "", maxAmount: "", currency: "GBP", paymentPeriod: "annual", sourceName: "", sourceUrl: "", researchNotes: "" });
  const [salaryProposal, setSalaryProposal] = useState<SalaryResearchProposal | null>(null);
  const [actionBusy, setActionBusy] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setDraft(job);
    setNotes(job.notes);
    setSalaryProposal(null);
    setActionMessage("");
    setActionError("");
  }, [job]);

  const updateDraft = (key: keyof JobDraft, value: string | string[]) => setDraft((current) => ({ ...current, [key]: value }));
  const refreshAfter = async (operation: string, work: () => Promise<unknown>, success: string) => {
    setActionBusy(operation);
    setActionError("");
    setActionMessage("");
    try { await work(); onRefresh(); setActionMessage(success); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "CareerOS could not complete that action."); }
    finally { setActionBusy(""); }
  };
  const save = () => refreshAfter("save", () => client.updateJob(job.id, { ...draft, notes, expectedRevision: job.revision }), "Details saved.").then(() => setEditing(false));
  const addTask = () => refreshAfter("task", () => client.createTask(job.id, task), "Task added.").then(() => {
    setTask({ title: "", taskType: "follow_up", priority: "Medium", dueDate: null, notes: "" });
    setTaskOpen(false);
  });
  const addSalary = () => {
    const input: SalaryEstimateCreateInput = {
      estimateType: salary.estimateType as SalaryEstimateCreateInput["estimateType"],
      minAmount: salary.minAmount ? Number(salary.minAmount) : null,
      maxAmount: salary.maxAmount ? Number(salary.maxAmount) : null,
      currency: salary.currency,
      paymentPeriod: salary.paymentPeriod as SalaryEstimateCreateInput["paymentPeriod"],
      sourceName: salary.sourceName,
      sourceUrl: salary.sourceUrl,
      researchNotes: salary.researchNotes,
    };
    return refreshAfter("salary", () => client.createSalaryEstimate(job.id, input), "Compensation saved.").then(() => {
      setSalary({ estimateType: "manual", minAmount: "", maxAmount: "", currency: "GBP", paymentPeriod: "annual", sourceName: "", sourceUrl: "", researchNotes: "" });
      setSalaryOpen(false);
    });
  };
  const researchSalary = async () => {
    setActionBusy("salary-research");
    setActionError("");
    setActionMessage("");
    try { setSalaryProposal(await client.researchSalary(job.id)); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "CareerOS could not research compensation."); }
    finally { setActionBusy(""); }
  };
  useEffect(() => {
    if (!researchSalaryOnOpen) return;
    onSalaryResearchStarted();
    void researchSalary();
  }, [researchSalaryOnOpen, job.id]);
  const saveSalaryResearch = () => {
    if (!salaryProposal) return Promise.resolve();
    return refreshAfter("salary-commit", () => client.commitSalaryResearch(job.id, salaryProposal), "Salary estimate and its sources were saved.").then(() => setSalaryProposal(null));
  };
  const money = formatMoney;

  return <aside className="detail-panel" aria-label={`${job.title} details`}>
    <div className="detail-top"><span className="detail-kicker">JOB WORKSPACE</span><div className="detail-actions"><button className="icon-button" title="Reload saved details" onClick={onRefresh}><RefreshCw size={16} /></button><button className="icon-button" title="Close details" onClick={onClose}><X size={17} /></button></div></div>
    <div className="detail-heading"><div className="company-badge">{job.companyName.slice(0, 1).toUpperCase()}</div><div><h2>{job.title}</h2><p>{job.companyName} <span>·</span> {job.location || "Location pending"}</p></div></div>
    <div className="detail-quick-row"><span className="status status-muted">{job.sector || "Uncategorised"}</span>{job.workMode && <span className="plain-chip">{job.workMode}</span>}{job.employmentType && <span className="plain-chip">{job.employmentType}</span>}<span className={`source-state ${job.lastCheckedAt ? "source-current" : "source-unknown"}`}><span />{job.lastCheckedAt ? `Checked ${formatRelativeDate(job.lastCheckedAt)}` : "Not checked"}</span></div>
    <div className="detail-cta-row">{job.applyUrl && <a className="primary-button link-button" href={job.applyUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={16} /> Open application</a>}<button className="quiet-button" onClick={onTailorCv}><FilePenLine size={15} /> {readOnly ? "View CV" : "Tailor CV"}</button>{!readOnly && (!job.applicationId ? <button className="quiet-button" onClick={onCreateApplication} disabled={busy}><Send size={15} /> Start application</button> : <button className="quiet-button" onClick={() => setEventOpen(!eventOpen)}><Activity size={15} /> Log event</button>)}{!readOnly && <button className="quiet-button" onClick={() => void refreshAfter("recheck", () => client.recheckJobSource(job.id), "Source is reachable and the check time was saved.")} disabled={actionBusy === "recheck"}>{actionBusy === "recheck" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Check source</button>}</div>
    {actionMessage && <div className="detail-feedback detail-feedback-good"><CircleCheck size={15} />{actionMessage}</div>}
    {actionError && <div className="detail-feedback detail-feedback-bad"><CircleAlert size={15} />{actionError}</div>}
    {eventOpen && <div className="event-composer"><label>Event<select value={eventType} onChange={(event) => setEventType(event.target.value as ApplicationEventInput["type"])}>{applicationEventTypes.filter((type) => type !== "posting_saved").map((type) => <option key={type} value={type}>{eventLabels[type]}</option>)}</select></label><label>Note<textarea value={eventNote} onChange={(event) => setEventNote(event.target.value)} placeholder="What happened?" /></label><button className="primary-button" onClick={() => { onAddEvent({ type: eventType, note: eventNote }); setEventOpen(false); setEventNote(""); }} disabled={busy}><Check size={16} /> Add to timeline</button></div>}
    <div className="detail-scroll">
      <section className="detail-section"><div className="section-heading"><h3>At a glance</h3>{!readOnly && <button className="text-button" onClick={() => { setEditing(!editing); setDraft(job); setNotes(job.notes); }}><PencilLine size={13} />{editing ? "Cancel editing" : "Edit details"}</button>}</div><div className="meta-grid detail-meta-grid"><div><span>Role family</span><strong>{job.roleFamily || "Not set"}</strong></div><div><span>Deadline</span><strong>{job.applicationDeadline ? formatDate(job.applicationDeadline) : "Not set"}</strong></div><div><span>Employer posted</span><strong>{job.postingDate ? `${formatRelativeDate(job.postingDate)} · ${formatDate(job.postingDate)}` : "Not captured"}</strong></div><div><span>CareerOS record</span><strong>Updated {formatRelativeDate(job.updatedAt)}</strong></div><div><span>Posting state</span><strong>{job.postingState}</strong></div><div><span>Evidence</span><strong>{job.evidenceCount} captured fields</strong></div></div>{editing && !readOnly ? <div className="detail-edit-form">
        <div className="detail-form-grid"><label className="field-label wide">Role name<input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} /></label><label className="field-label">Company<input value={draft.companyName} onChange={(event) => updateDraft("companyName", event.target.value)} /></label><label className="field-label">Location<input value={draft.location} onChange={(event) => updateDraft("location", event.target.value)} /></label><label className="field-label">Sector<input value={draft.sector} onChange={(event) => updateDraft("sector", event.target.value)} /></label><label className="field-label">Role family<input value={draft.roleFamily} onChange={(event) => updateDraft("roleFamily", event.target.value)} /></label><label className="field-label">Work mode<input value={draft.workMode} onChange={(event) => updateDraft("workMode", event.target.value)} placeholder="On-site, hybrid, remote" /></label><label className="field-label">Employment type<input value={draft.employmentType} onChange={(event) => updateDraft("employmentType", event.target.value)} /></label><label className="field-label">Division<input value={draft.division} onChange={(event) => updateDraft("division", event.target.value)} /></label><label className="field-label">Team<input value={draft.team} onChange={(event) => updateDraft("team", event.target.value)} /></label><label className="field-label">Posting date<input value={draft.postingDate} onChange={(event) => updateDraft("postingDate", event.target.value)} placeholder="YYYY-MM-DD" /></label><label className="field-label">Deadline<input value={draft.applicationDeadline} onChange={(event) => updateDraft("applicationDeadline", event.target.value)} placeholder="YYYY-MM-DD" /></label><label className="field-label">Posting state<select value={draft.postingState} onChange={(event) => updateDraft("postingState", event.target.value)}><option>Active</option><option>Closed</option><option>Expired</option><option>Unknown</option></select></label><label className="field-label">Requisition ID<input value={draft.requisitionId} onChange={(event) => updateDraft("requisitionId", event.target.value)} /></label><label className="field-label wide">Apply Now link<input value={draft.applyUrl} onChange={(event) => updateDraft("applyUrl", event.target.value)} /></label><label className="field-label wide">Source link<input value={draft.sourceUrl} onChange={(event) => updateDraft("sourceUrl", event.target.value)} /></label><label className="field-label">Recruiter or contact<input value={draft.recruiterContact} onChange={(event) => updateDraft("recruiterContact", event.target.value)} /></label><label className="field-label">Referral source<input value={draft.referralSource} onChange={(event) => updateDraft("referralSource", event.target.value)} /></label><label className="field-label wide">Job summary<textarea value={draft.summary} onChange={(event) => updateDraft("summary", event.target.value)} /></label><label className="field-label wide">Required requirements<textarea value={draft.requiredRequirements.join("\n")} onChange={(event) => updateDraft("requiredRequirements", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></label><label className="field-label wide">Preferred requirements<textarea value={draft.preferredRequirements.join("\n")} onChange={(event) => updateDraft("preferredRequirements", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></label><label className="field-label wide">Hiring process<textarea value={draft.processSummary} onChange={(event) => updateDraft("processSummary", event.target.value)} /></label><label className="field-label wide">Visa and work authorisation<textarea value={draft.visaRequirements} onChange={(event) => updateDraft("visaRequirements", event.target.value)} /></label><label className="field-label wide">Company snapshot<textarea value={draft.companySnapshot} onChange={(event) => updateDraft("companySnapshot", event.target.value)} /></label><label className="field-label wide">Personal notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label></div>
        <button className="primary-button small-button" onClick={() => void save()} disabled={actionBusy === "save"}>{actionBusy === "save" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save changes</button>
      </div> : <p className="detail-copy">{job.summary || "No summary captured yet. Edit the posting to keep the useful signal here."}</p>}</section>

      <div className="detail-two-column"><section className="detail-section"><h3>Required</h3>{job.requiredRequirements.length ? <ul className="requirement-list">{job.requiredRequirements.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted-text">No required criteria captured.</p>}</section><section className="detail-section"><h3>Preferred</h3>{job.preferredRequirements.length ? <ul className="requirement-list preferred-list">{job.preferredRequirements.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted-text">No preferred criteria captured.</p>}</section></div>

      <div className="detail-two-column"><section className="detail-section"><h3>Hiring process</h3><p className="detail-copy">{job.processSummary || "No hiring process captured yet."}</p></section><section className="detail-section"><h3>Work authorisation</h3><p className="detail-copy">{job.visaRequirements || "No visa or work-authorisation detail captured."}</p></section></div>

      <section className="detail-section"><div className="section-heading"><div><h3>Tasks and follow-up</h3><p className="section-caption">Deadlines, preparation, research, and next actions.</p></div>{!readOnly && <button className="text-button" onClick={() => setTaskOpen(!taskOpen)}><Plus size={13} /> Add task</button>}</div>{!readOnly && taskOpen && <div className="inline-composer"><div className="detail-form-grid"><label className="field-label wide">Task<input value={task.title} onChange={(event) => setTask({ ...task, title: event.target.value })} placeholder="Follow up with recruiter" autoFocus /></label><label className="field-label">Type<select value={task.taskType} onChange={(event) => setTask({ ...task, taskType: event.target.value as TaskCreateInput["taskType"] })}><option value="follow_up">Follow-up</option><option value="deadline">Deadline</option><option value="research">Research</option><option value="preparation">Preparation</option><option value="application">Application</option></select></label><label className="field-label">Due date<input type="date" value={task.dueDate ?? ""} onChange={(event) => setTask({ ...task, dueDate: event.target.value || null })} /></label></div><div className="composer-actions"><button className="quiet-button" onClick={() => setTaskOpen(false)}>Cancel</button><button className="primary-button" disabled={!task.title.trim() || actionBusy === "task"} onClick={() => void addTask()}>{actionBusy === "task" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Add task</button></div></div>}{job.tasks.length ? <div className="task-list">{job.tasks.map((item) => <label className={`task-row ${item.completed ? "task-complete" : ""}`} key={item.id}><input type="checkbox" checked={item.completed} disabled={readOnly} onChange={(event) => void refreshAfter(`task-${item.id}`, () => client.updateTask(item.id, { completed: event.target.checked, expectedRevision: item.revision }), event.target.checked ? "Task completed." : "Task reopened.")} /><span><strong>{item.title}</strong><small>{item.taskType.replace("_", " ")}{item.dueDate ? ` · Due ${formatDate(item.dueDate)}` : ""}</small></span><span className={`priority priority-${item.priority.toLowerCase()}`}>{item.priority}</span></label>)}</div> : <div className="workspace-empty"><ClipboardCheck size={17} /><span>No tasks yet.</span></div>}</section>

      <section className="detail-section">
        <div className="section-heading">
          <div><h3>Compensation</h3><p className="section-caption">Employer figures and researched estimates stay visibly distinct.</p></div>
          {!readOnly && <div className="section-actions">
            <button className="text-button" onClick={() => void researchSalary()} disabled={Boolean(actionBusy)}>{actionBusy === "salary-research" ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />} Research salary</button>
            <button className="text-button" onClick={() => setSalaryOpen(!salaryOpen)}><Plus size={13} /> Add estimate</button>
          </div>}
        </div>
        {salaryProposal && <div className="salary-proposal" aria-live="polite">
          <div className="salary-proposal-header">
            <div><span className="proposal-kicker"><Sparkles size={12} /> Research ready</span><strong>{salaryProposal.inferredRoleTitle}{salaryProposal.inferredLevel ? `, ${salaryProposal.inferredLevel}` : ""}</strong></div>
            <span>{Math.round(salaryProposal.confidence * 100)}% confidence</span>
          </div>
          <div className="salary-proposal-metrics">
            <div><span>Estimated base</span><strong>{salaryProposal.estimate.baseMinAmount != null || salaryProposal.estimate.baseMaxAmount != null ? `${money(salaryProposal.estimate.baseMinAmount, salaryProposal.estimate.currency)}${salaryProposal.estimate.baseMinAmount != null && salaryProposal.estimate.baseMaxAmount != null ? " to " : ""}${money(salaryProposal.estimate.baseMaxAmount, salaryProposal.estimate.currency)}` : "Not enough evidence"}</strong></div>
            <div><span>Estimated total compensation</span><strong>{salaryProposal.estimate.totalCompMinAmount != null || salaryProposal.estimate.totalCompMaxAmount != null ? `${money(salaryProposal.estimate.totalCompMinAmount, salaryProposal.estimate.currency)}${salaryProposal.estimate.totalCompMinAmount != null && salaryProposal.estimate.totalCompMaxAmount != null ? " to " : ""}${money(salaryProposal.estimate.totalCompMaxAmount, salaryProposal.estimate.currency)}` : "Not enough evidence"}</strong></div>
            <div><span>Research run</span><strong>{salaryProposal.evidence.length} source{salaryProposal.evidence.length === 1 ? "" : "s"} in {formatDuration(salaryProposal.durationMs)}</strong></div>
          </div>
          <p className="salary-rationale">{salaryProposal.rationale}</p>
          {salaryProposal.warnings.map((warning) => <p className="salary-warning" key={warning}><CircleAlert size={13} /> {warning}</p>)}
          <details className="salary-evidence"><summary><Search size={14} /> Review source evidence <ChevronDown size={14} /></summary><div className="salary-evidence-list">{salaryProposal.evidence.map((evidence) => <div className="salary-evidence-row" key={`${evidence.sourceUrl}-${evidence.excerpt}`}><div><a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.sourceName} <ArrowUpRight size={11} /></a><span>{evidence.compensationScope} · {evidence.roleTitle || "Comparable role"}{evidence.location ? ` · ${evidence.location}` : ""}</span></div><strong>{evidence.minAmount != null || evidence.maxAmount != null ? `${money(evidence.minAmount, evidence.currency)}${evidence.minAmount != null && evidence.maxAmount != null ? " to " : ""}${money(evidence.maxAmount, evidence.currency)}` : "Context only"}</strong><p>{evidence.excerpt}</p></div>)}</div></details>
          <div className="composer-actions"><button className="quiet-button" onClick={() => setSalaryProposal(null)}>Discard</button><button className="primary-button" onClick={() => void saveSalaryResearch()} disabled={actionBusy === "salary-commit"}>{actionBusy === "salary-commit" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save estimate</button></div>
        </div>}
        {salaryOpen && <div className="inline-composer"><div className="detail-form-grid"><label className="field-label">Type<select value={salary.estimateType} onChange={(event) => setSalary({ ...salary, estimateType: event.target.value })}><option value="employer">Employer listed</option><option value="researched">Researched</option><option value="ai_assisted">AI assisted</option><option value="manual">Manual</option></select></label><label className="field-label">Currency<input value={salary.currency} onChange={(event) => setSalary({ ...salary, currency: event.target.value.toUpperCase() })} /></label><label className="field-label">Minimum<input type="number" min="0" value={salary.minAmount} onChange={(event) => setSalary({ ...salary, minAmount: event.target.value })} /></label><label className="field-label">Maximum<input type="number" min="0" value={salary.maxAmount} onChange={(event) => setSalary({ ...salary, maxAmount: event.target.value })} /></label><label className="field-label">Period<select value={salary.paymentPeriod} onChange={(event) => setSalary({ ...salary, paymentPeriod: event.target.value })}><option value="annual">Annual</option><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="hourly">Hourly</option></select></label><label className="field-label">Source<input value={salary.sourceName} onChange={(event) => setSalary({ ...salary, sourceName: event.target.value })} placeholder="Employer, Glassdoor..." /></label><label className="field-label wide">Source link<input value={salary.sourceUrl} onChange={(event) => setSalary({ ...salary, sourceUrl: event.target.value })} /></label><label className="field-label wide">Research notes<textarea value={salary.researchNotes} onChange={(event) => setSalary({ ...salary, researchNotes: event.target.value })} /></label></div><div className="composer-actions"><button className="quiet-button" onClick={() => setSalaryOpen(false)}>Cancel</button><button className="primary-button" disabled={(!salary.minAmount && !salary.maxAmount) || actionBusy === "salary"} onClick={() => void addSalary()}>{actionBusy === "salary" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save estimate</button></div></div>}
        {job.salaries.length ? <div className="salary-list">{job.salaries.map((item) => <div className="salary-row" key={item.id}><Coins size={17} /><div><strong>{item.baseMinAmount != null || item.baseMaxAmount != null ? `Base ${money(item.baseMinAmount, item.currency)}${item.baseMinAmount != null && item.baseMaxAmount != null ? " to " : ""}${money(item.baseMaxAmount, item.currency)}` : item.minAmount != null || item.maxAmount != null ? `${money(item.minAmount, item.currency)}${item.minAmount != null && item.maxAmount != null ? " to " : ""}${money(item.maxAmount, item.currency)}` : "Compensation noted"}</strong>{(item.totalCompMinAmount != null || item.totalCompMaxAmount != null) && <strong className="salary-secondary-range">Total {money(item.totalCompMinAmount, item.currency)}{item.totalCompMinAmount != null && item.totalCompMaxAmount != null ? " to " : ""}{money(item.totalCompMaxAmount, item.currency)}</strong>}<small>{item.paymentPeriod} · {item.sourceName || "No source named"}{item.confidence != null ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}</small>{item.researchNotes && <p>{item.researchNotes}</p>}{item.evidence.length > 0 && <details className="saved-salary-evidence"><summary>{item.evidence.length} research source{item.evidence.length === 1 ? "" : "s"}</summary>{item.evidence.map((evidence) => <a href={evidence.sourceUrl} target="_blank" rel="noreferrer" key={`${evidence.sourceUrl}-${evidence.excerpt}`}>{evidence.sourceName} <ArrowUpRight size={10} /></a>)}</details>}</div><span className={`evidence-kind evidence-${item.estimateType}`}>{item.estimateType.replace("_", " ")}</span></div>)}</div> : <div className="workspace-empty"><Coins size={17} /><span>No compensation captured. Research comparable public data or add a known figure.</span></div>}
      </section>

      <section className="detail-section"><h3>Company</h3><p className="detail-copy">{job.companySnapshot || job.companyDescription || "Company context has not been captured yet."}</p>{job.companyDescription && job.companySnapshot && <p className="detail-copy secondary-copy">{job.companyDescription}</p>}</section>

      <section className="detail-section"><div className="section-heading"><div><h3>Source and evidence</h3><p className="section-caption">What CareerOS used, how it was obtained, and whether you confirmed it.</p></div>{(job.sourceUrl || job.applyUrl) && <a className="text-link" href={job.sourceUrl || job.applyUrl} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={12} /></a>}</div>{job.evidence.length ? <div className="job-evidence-list">{job.evidence.map((item) => <div className="job-evidence-row" key={item.id}><SquareCheckBig size={15} /><div><strong>{item.fieldPath}</strong><p>{item.excerpt || item.suggestedValue.slice(0, 220)}</p></div><span>{item.userConfirmed ? "Confirmed" : `${Math.round(item.confidence * 100)}%`}</span></div>)}</div> : <div className="workspace-empty"><FileText size={17} /><span>No field-level evidence is attached to this record yet.</span></div>}{job.description && <details className="source-details"><summary><FileText size={15} /> Full captured description <ChevronDown size={15} /></summary><p>{job.description}</p></details>}</section>

      <section className="detail-section"><div className="section-heading"><h3>Application timeline</h3>{job.applicationId && <span className="status status-muted">{job.applicationStatus}</span>}</div>{job.events.length ? <div className="timeline">{job.events.map((event) => <div className="timeline-item" key={event.id}><span className="timeline-dot" /><div><strong>{eventLabels[event.type] ?? event.type}</strong><small>{formatDate(event.occurredAt)}</small>{event.note && <p>{event.note}</p>}</div></div>)}</div> : <p className="muted-text">This posting has not been converted into an application yet.</p>}</section>
    </div>
  </aside>;
}

function ImportPanel({ mode, setMode, url, setUrl, text, setText, review, setReview, busy, importError, requiresDuplicateDecision, duplicateDecision, setDuplicateDecision, onStart, onCommit, onClose }: { mode: "url" | "pasted_text" | "manual"; setMode: (mode: "url" | "pasted_text" | "manual") => void; url: string; setUrl: (value: string) => void; text: string; setText: (value: string) => void; review: { response: ImportDraftResponse; draft: JobDraft } | null; setReview: (value: { response: ImportDraftResponse; draft: JobDraft } | null) => void; busy: boolean; importError: string; requiresDuplicateDecision: boolean; duplicateDecision: { action: "create_anyway" | "link_existing"; existingJobPostingId?: string } | null; setDuplicateDecision: (value: { action: "create_anyway" | "link_existing"; existingJobPostingId?: string } | null) => void; onStart: () => void; onCommit: () => void; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const containFocus = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { onCloseRef.current(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); panelRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", containFocus);
    return () => { window.removeEventListener("keydown", containFocus); previousFocus?.focus(); };
  }, []);
  const updateDraft = (key: keyof JobDraft, value: string) => { if (review) setReview({ ...review, draft: { ...review.draft, [key]: value } }); };
  const updateDraftList = (key: "requiredRequirements" | "preferredRequirements", value: string) => {
    if (review) setReview({ ...review, draft: { ...review.draft, [key]: value.split("\n").map((item) => item.trim()).filter(Boolean) } });
  };
  return <div className="overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={panelRef} tabIndex={-1} className="import-panel" role="dialog" aria-modal="true" aria-labelledby="import-panel-title">
    <div className="import-header">
      <div><span className="detail-kicker">CAPTURE</span><h2 id="import-panel-title">{review ? "Review opportunity" : "Add an opportunity"}</h2></div>
      <button className="icon-button" aria-label="Close capture panel" title="Close capture panel" onClick={onClose}><X size={18} /></button>
    </div>

    {!review ? <>
      <div className="capture-tabs">
        <button className={mode === "url" ? "active" : ""} onClick={() => setMode("url")}><Link2 size={15} /> URL</button>
        <button className={mode === "pasted_text" ? "active" : ""} onClick={() => setMode("pasted_text")}><FileText size={15} /> Paste text</button>
        <button className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}><Target size={15} /> Manual</button>
      </div>
      {mode === "url" && <div className="capture-form"><label className="field-label">Public job link<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." autoFocus /></label><p className="field-hint">The app will try to turn a public job page into a reviewable tracker row. If the portal blocks capture, paste the job text instead.</p></div>}
      {mode === "pasted_text" && <div className="capture-form"><label className="field-label">Job description<textarea className="large-textarea" value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste the role, company, requirements, and process here..." autoFocus /></label><p className="field-hint">Paste only the useful job content where possible: title, company, location, description, requirements, deadline, and apply link.</p></div>}
      {mode === "manual" && <div className="capture-form"><p className="field-hint">Start with a blank, editable record. You can add the rest in the detail view.</p></div>}
      {importError && <div className="import-error"><CircleAlert size={16} /><span>{importError}</span></div>}
      <div className="import-footer"><button className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={onStart} disabled={busy || (mode === "url" && !url) || (mode === "pasted_text" && !text)}>{busy ? <LoaderCircle className="spin" size={16} /> : mode === "manual" ? <FileText size={16} /> : <Sparkles size={16} />} {mode === "manual" ? "Open blank record" : busy ? "Preparing..." : "Prepare review"}</button></div>
    </> : <div className="review-form">
      {importError && <div className="import-error" role="alert"><CircleAlert size={16} /><span>{importError}</span></div>}
      <div className={`review-note ${review.response.enrichment?.mode === "ai" ? "review-note-ai" : ""}`}><Sparkles size={16} /><span>{review.response.enrichment?.mode === "ai" ? `AI-assisted proposal from ${review.response.enrichment.model} in ${formatDuration(review.response.enrichment.totalDurationMs)}. ${review.response.enrichment.evidenceCount} evidenced field${review.response.enrichment.evidenceCount === 1 ? "" : "s"} ready for review.` : review.response.enrichment ? `${review.response.enrichment.warning ?? "Review the proposed tracker row, correct anything wrong, then save it."} Ready in ${formatDuration(review.response.enrichment.totalDurationMs)}.` : "Review the proposed tracker row, correct anything wrong, then save it."}{review.response.duplicates.length ? ` ${review.response.duplicates.length} possible duplicate${review.response.duplicates.length === 1 ? "" : "s"} found.` : ""}</span></div>
      <div className="review-grid">
        <label className="field-label wide">Role or internship name<input value={review.draft.title} onChange={(event) => updateDraft("title", event.target.value)} /></label>
        <label className="field-label">Company<input value={review.draft.companyName} onChange={(event) => updateDraft("companyName", event.target.value)} /></label>
        <label className="field-label">Location<input value={review.draft.location} onChange={(event) => updateDraft("location", event.target.value)} /></label>
        <label className="field-label">Country<input value={review.draft.country} onChange={(event) => updateDraft("country", event.target.value)} /></label>
        <label className="field-label">Employment type<input value={review.draft.employmentType} onChange={(event) => updateDraft("employmentType", event.target.value)} /></label>
        <label className="field-label">Sector<input value={review.draft.sector} onChange={(event) => updateDraft("sector", event.target.value)} placeholder="Finance, software..." /></label>
        <label className="field-label">Role family<input value={review.draft.roleFamily} onChange={(event) => updateDraft("roleFamily", event.target.value)} placeholder="Quant, product, engineering..." /></label>
        <label className="field-label">Work mode<input value={review.draft.workMode} onChange={(event) => updateDraft("workMode", event.target.value)} /></label>
        <label className="field-label">Seniority<input value={review.draft.seniority} onChange={(event) => updateDraft("seniority", event.target.value)} /></label>
        <label className="field-label">Application deadline<input value={review.draft.applicationDeadline} onChange={(event) => updateDraft("applicationDeadline", event.target.value)} placeholder="2026-09-01" /></label>
        <label className="field-label">Posting date<input value={review.draft.postingDate} onChange={(event) => updateDraft("postingDate", event.target.value)} /></label>
        <label className="field-label">Requisition ID<input value={review.draft.requisitionId} onChange={(event) => updateDraft("requisitionId", event.target.value)} /></label>
        <label className="field-label">Apply Now link<input value={review.draft.applyUrl} onChange={(event) => updateDraft("applyUrl", event.target.value)} placeholder="https://..." /></label>
        <label className="field-label wide">Job summary<textarea value={review.draft.summary} onChange={(event) => updateDraft("summary", event.target.value)} /></label>
        <label className="field-label wide">Company snapshot<textarea value={review.draft.companySnapshot} onChange={(event) => updateDraft("companySnapshot", event.target.value)} /></label>
        <label className="field-label wide">Company description<textarea value={review.draft.companyDescription} onChange={(event) => updateDraft("companyDescription", event.target.value)} /></label>
        <label className="field-label wide">Required requirements<textarea value={review.draft.requiredRequirements.join("\n")} onChange={(event) => updateDraftList("requiredRequirements", event.target.value)} /></label>
        <label className="field-label wide">Preferred requirements<textarea value={review.draft.preferredRequirements.join("\n")} onChange={(event) => updateDraftList("preferredRequirements", event.target.value)} /></label>
        <label className="field-label wide">Hiring process<textarea value={review.draft.processSummary} onChange={(event) => updateDraft("processSummary", event.target.value)} /></label>
        <label className="field-label wide">Visa and work authorisation<textarea value={review.draft.visaRequirements} onChange={(event) => updateDraft("visaRequirements", event.target.value)} /></label>
      </div>
      {Boolean(review.response.fieldEvidence?.length) && <details className="evidence-preview"><summary><Sparkles size={15} /> Field evidence <ChevronDown size={15} /></summary><div className="evidence-list">{review.response.fieldEvidence?.map((evidence, index) => <div key={`${evidence.fieldPath}-${index}`}><span>{evidence.fieldPath}</span><p>{evidence.excerpt}</p><small>{evidence.method.replaceAll("_", " ")} · {Math.round(evidence.confidence * 100)}% confidence</small></div>)}</div></details>}
      {(review.response.sourceText || review.draft.description) && <details className="source-preview"><summary><FileText size={15} /> Source text captured <ChevronDown size={15} /></summary><textarea value={review.response.sourceText || review.draft.description} readOnly={Boolean(review.response.sourceText)} onChange={(event) => updateDraft("description", event.target.value)} /></details>}
      {review.response.duplicates.length > 0 && <fieldset className="duplicate-list"><legend>Choose what to do with this possible duplicate</legend>{review.response.duplicates.map((duplicate) => <label key={duplicate.id}>{!duplicate.queued && <input type="radio" name="duplicate-decision" checked={duplicateDecision?.action === "link_existing" && duplicateDecision.existingJobPostingId === duplicate.id} onChange={() => setDuplicateDecision({ action: "link_existing", existingJobPostingId: duplicate.id })} />}<span>{duplicate.queued ? "Already in capture queue" : "Use saved opportunity"}</span><strong>{duplicate.title}</strong><small>{duplicate.companyName}</small></label>)}<label><input type="radio" name="duplicate-decision" checked={duplicateDecision?.action === "create_anyway"} onChange={() => setDuplicateDecision({ action: "create_anyway" })} /><span>Create another opportunity</span><small>I have checked that these are genuinely different postings.</small></label></fieldset>}
      <div className="import-footer"><button className="quiet-button" onClick={() => setReview(null)}>Back</button><button className="primary-button" onClick={onCommit} disabled={busy || !review.draft.title || !review.draft.companyName || (requiresDuplicateDecision && review.response.duplicates.length > 0 && !duplicateDecision)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save opportunity</button></div>
    </div>}
  </aside></div>;
}
