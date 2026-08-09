import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bug,
  Bell,
  DatabaseBackup,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Inbox,
  Radio,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { AiRunRecord, SystemServiceHealth } from "@careeros/contracts";
import {
  apiBaseUrl,
  checkSystemStatus,
  diagnosticEventName,
  type DiagnosticEntry,
  type SystemSnapshot,
} from "./diagnostics";
import { client } from "./api";
import { useDialogFocus } from "./useDialogFocus";

const storageKey = "careeros-diagnostics";
const initialStatus: SystemSnapshot = {
  backend: "checking",
  ai: "checking",
  provider: "openai",
  model: "",
  keySource: "none",
  checkedAt: "",
};
const aiSetupCommand = `cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack pnpm dev`;

function sanitiseDiagnosticText(value: string | undefined) {
  if (!value) return value;
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/gi, "[redacted API key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|service[_ -]?role[_ -]?key|supabase[_ -]?service[_ -]?role[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\/Users\/[^/\s]+\//g, "/Users/[redacted]/");
}

function sanitiseDiagnostic(entry: DiagnosticEntry): DiagnosticEntry {
  return { ...entry, message: sanitiseDiagnosticText(entry.message) ?? "An action failed.", detail: sanitiseDiagnosticText(entry.detail) };
}

function storedDiagnostics() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? (stored.slice(0, 30) as DiagnosticEntry[]).map(sanitiseDiagnostic) : [];
  } catch {
    return [];
  }
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function durationLabel(milliseconds: number) {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}

function operationLabel(operation: AiRunRecord["operation"]) {
  if (operation === "profile_import") return "Profile import";
  if (operation === "salary_research") return "Salary research";
  if (operation === "cv_tailoring") return "CV tailoring";
  return "Job import";
}

function StatusPill({ state, label }: { state: "checking" | "online" | "offline" | "ready" | "missing" | "unknown"; label: string }) {
  const tone = state === "online" || state === "ready" ? "good" : state === "checking" || state === "unknown" ? "waiting" : "bad";
  return <span className={`service-pill service-${tone}`}><span className="service-dot" />{label}</span>;
}

export function SystemStatus() {
  const [status, setStatus] = useState<SystemSnapshot>(initialStatus);
  const [errors, setErrors] = useState<DiagnosticEntry[]>(storedDiagnostics);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"setup" | "diagnostics" | null>(null);
  const [checking, setChecking] = useState(false);
  const [aiRuns, setAiRuns] = useState<AiRunRecord[]>([]);
  const [services, setServices] = useState<SystemServiceHealth | null>(null);
  const [aiRunsOpen, setAiRunsOpen] = useState(true);
  const [errorsOpen, setErrorsOpen] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState("");
  const previousBackend = useRef<SystemSnapshot["backend"]>("checking");
  const refreshInFlight = useRef(false);
  const closePanel = useCallback(() => setOpen(false), []);
  const panelRef = useDialogFocus<HTMLElement>({ open, onClose: closePanel });

  const addDiagnostic = useCallback((entry: DiagnosticEntry) => {
    const safeEntry = sanitiseDiagnostic(entry);
    setErrors((current) => {
      const previous = current[0];
      const isDuplicate = previous && previous.message === safeEntry.message &&
        Math.abs(new Date(previous.timestamp).valueOf() - new Date(safeEntry.timestamp).valueOf()) < 4_000;
      return isDuplicate ? current : [safeEntry, ...current].slice(0, 30);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setChecking(true);
    try {
      const next = await checkSystemStatus();
      if (previousBackend.current === "online" && next.backend === "offline") {
        addDiagnostic({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          source: "System",
          operation: "Backend health check",
          message: "CareerOS API stopped responding on port 4310.",
        });
      }
      previousBackend.current = next.backend;
      setStatus(next);
      if (next.backend === "online") {
        const [runs, serviceHealth, meta] = await Promise.all([client.listAiRuns(6), client.getSystemHealth(), client.getMeta()]);
        setAiRuns(runs);
        setServices(serviceHealth);
        setStatus((current) => ({
          ...current,
          ai: meta.ai.configured ? "ready" : "missing",
          provider: meta.ai.provider,
          model: meta.ai.model,
          keySource: meta.ai.configured ? "environment" : "none",
        }));
      }
    } catch {
      // Request diagnostics already capture the failure; keep the last known ledger rows.
    } finally {
      setChecking(false);
      refreshInFlight.current = false;
    }
  }, [addDiagnostic]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    const onFocus = () => void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const onDiagnostic = (event: Event) => addDiagnostic((event as CustomEvent<DiagnosticEntry>).detail);
    const onWindowError = (event: ErrorEvent) => addDiagnostic({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: "Interface",
      operation: "Browser runtime",
      message: event.message || "An unexpected interface error occurred.",
      detail: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    });
    const onRejection = (event: PromiseRejectionEvent) => addDiagnostic({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: "Interface",
      operation: "Background action",
      message: event.reason instanceof Error ? event.reason.message : String(event.reason ?? "An action failed unexpectedly."),
    });
    window.addEventListener(diagnosticEventName, onDiagnostic);
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener(diagnosticEventName, onDiagnostic);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [addDiagnostic]);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(errors));
  }, [errors]);

  const copyText = async (kind: "setup" | "diagnostics", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_800);
    } catch {
      addDiagnostic({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        source: "Interface",
        operation: "Copy to clipboard",
        message: "The browser could not copy that text. Select it manually instead.",
      });
    }
  };

  const diagnosticsText = [
    `CareerOS diagnostics ${new Date().toISOString()}`,
    `Frontend: ${window.location.origin}`,
    `API: ${apiBaseUrl}`,
    `Backend: ${status.backend}`,
    `AI: ${status.ai}${status.model ? ` (${status.provider}/${status.model})` : ""}`,
    ...aiRuns.map((run) => `AI run: ${run.operation}, ${run.state}, ${run.totalDurationMs}ms total, ${run.durationMs}ms model, ${run.evidenceCount} evidence`),
    "",
    ...errors.map((entry) => `[${entry.timestamp}] ${entry.source} / ${entry.operation}: ${entry.message}${entry.statusCode ? ` (HTTP ${entry.statusCode})` : ""}`),
  ].join("\n");

  const backendLabel = status.backend === "online" ? "Backend on" : status.backend === "offline" ? "Backend off" : "Backend checking";
  const aiLabel = status.ai === "ready" ? "AI on" : status.ai === "missing" ? "API key off" : status.ai === "unknown" ? "AI unknown" : "AI checking";

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    setKeyBusy(true);
    setKeyFeedback("");
    try {
      await client.saveOpenAiKey({ apiKey: apiKey.trim() });
      setApiKey("");
      setRevealKey(false);
      setKeyFeedback("Saved securely in macOS Keychain. AI is ready now.");
      await refresh();
    } catch (cause) {
      setKeyFeedback(cause instanceof Error ? cause.message : "CareerOS could not save the API key.");
    } finally {
      setKeyBusy(false);
    }
  };

  const removeApiKey = async () => {
    setKeyBusy(true);
    setKeyFeedback("");
    try {
      await client.deleteOpenAiKey();
      setApiKey("");
      setKeyFeedback("The Keychain copy was removed.");
      await refresh();
    } catch (cause) {
      setKeyFeedback(cause instanceof Error ? cause.message : "CareerOS could not remove the saved key.");
    } finally {
      setKeyBusy(false);
    }
  };

  const openTerminal = async () => {
    setKeyFeedback("");
    try {
      await client.openTerminal();
      setKeyFeedback("Terminal opened at the CareerOS project folder.");
    } catch (cause) {
      setKeyFeedback(cause instanceof Error ? cause.message : "CareerOS could not open Terminal.");
    }
  };

  const statusAnnouncement = `${backendLabel}. ${aiLabel}.${errors.length > 0 ? ` ${errors.length} recorded ${errors.length === 1 ? "error" : "errors"}.` : " No recorded errors."}`;

  return <div className="system-console">
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{statusAnnouncement}</span>
    {open && <aside ref={panelRef} id="careeros-system-status" tabIndex={-1} className="system-panel" role="dialog" aria-modal="true" aria-labelledby="careeros-system-status-title">
      <header className="system-panel-header">
        <div><h2 id="careeros-system-status-title">System health</h2></div>
        <button className="icon-button" aria-label="Close system status" title="Close system status" onClick={closePanel}><X size={17} /></button>
      </header>

      <section className="system-section" aria-label="Service health">
        <div className="system-service-row">
          <Server size={17} />
          <div><strong>Fastify backend</strong><span>{apiBaseUrl}</span></div>
          <StatusPill state={status.backend} label={status.backend === "online" ? "Online" : status.backend === "offline" ? "Offline" : "Checking"} />
        </div>
        <div className="system-service-row">
          <KeyRound size={17} />
          <div><strong>AI extraction</strong><span>{status.ai === "ready" ? `${status.provider} · ${status.model}` : status.backend === "offline" ? "Waiting for backend" : "OpenAI key not loaded"}</span></div>
          <StatusPill state={status.ai} label={status.ai === "ready" ? "Ready" : status.ai === "missing" ? "Key off" : "Unknown"} />
        </div>
        {services && <>
          <div className="system-service-row">
            <Inbox size={17} />
            <div><strong>Capture queue</strong><span>{services.capture.lastError
              ? `${services.capture.lastError}${services.capture.lastErrorAt ? ` · ${timeLabel(services.capture.lastErrorAt)}` : ""}${services.capture.lastSuccessfulAt && (!services.capture.lastErrorAt || services.capture.lastSuccessfulAt > services.capture.lastErrorAt) ? " · recovered" : ""}`
              : `${services.capture.active} processing · ${services.capture.needsReview} to review`}</span></div>
            <StatusPill
              state={(services.capture.lastError && (!services.capture.lastSuccessfulAt || !services.capture.lastErrorAt || services.capture.lastSuccessfulAt < services.capture.lastErrorAt)) || services.capture.failed + services.capture.blocked > 0 ? "offline" : "online"}
              label={services.capture.lastError && (!services.capture.lastSuccessfulAt || !services.capture.lastErrorAt || services.capture.lastSuccessfulAt < services.capture.lastErrorAt) ? "Worker error" : services.capture.failed + services.capture.blocked > 0 ? `${services.capture.failed + services.capture.blocked} need attention` : services.capture.lastError ? "Recovered" : "Healthy"}
            />
          </div>
          <div className="system-service-row">
            <Radio size={17} />
            <div><strong>Job watcher</strong><span>{services.discovery.enabledSources} sources · {services.discovery.lastSuccessfulAt ? `last success ${timeLabel(services.discovery.lastSuccessfulAt)}` : "not run yet"}</span></div>
            <StatusPill state={services.discovery.unhealthySources > 0 ? "offline" : "online"} label={services.discovery.unhealthySources > 0 ? `${services.discovery.unhealthySources} source errors` : "Healthy"} />
          </div>
          <div className="system-service-row">
            <Bell size={17} />
            <div><strong>Telegram alerts</strong><span>{services.notifications.pending} pending · {services.notifications.failed} failed</span></div>
            <StatusPill state={services.notifications.configured ? services.notifications.failed > 0 ? "offline" : "ready" : "missing"} label={services.notifications.configured ? services.notifications.failed > 0 ? "Needs attention" : "Ready" : "Not configured"} />
          </div>
          <div className="system-service-row">
            <Users size={17} />
            <div><strong>Live collaboration</strong><span>{services.collaboration.hosted ? "Private hosted workspace" : "Local single-user mode"}</span></div>
            <StatusPill state={services.collaboration.hosted ? services.collaboration.realtimeEnabled ? "online" : "offline" : "unknown"} label={services.collaboration.hosted ? services.collaboration.realtimeEnabled ? "Live" : "Offline" : "Local"} />
          </div>
          <div className="system-service-row">
            <DatabaseBackup size={17} />
            <div><strong>Encrypted backups</strong><span>{services.backups.configured ? `${services.backups.provider} · ${services.backups.lastSuccessfulAt ? `last saved ${timeLabel(services.backups.lastSuccessfulAt)}` : "ready for first run"}` : "Encryption key not configured"}</span></div>
            <StatusPill state={services.backups.configured ? services.backups.lastError ? "offline" : "ready" : "missing"} label={services.backups.configured ? services.backups.lastError ? "Needs attention" : services.backups.running ? "Saving" : "Ready" : "Not configured"} />
          </div>
        </>}
        <button className="quiet-button system-action" onClick={() => void refresh()} disabled={checking}><RefreshCw className={checking ? "spin" : ""} size={15} /> Check again</button>
      </section>

      {services?.collaboration.hosted ? <section className="system-section ai-key-section">
        <div className="system-section-title"><KeyRound size={16} /><div><strong>OpenAI API key</strong><span>Managed securely in the hosted deployment. The key is never sent to this browser or included in exports.</span></div></div>
        <StatusPill state={status.ai} label={status.ai === "ready" ? "Ready" : "Not configured"} />
      </section> : <section className="system-section ai-key-section">
        <div className="system-section-title"><KeyRound size={16} /><div><strong>OpenAI API key</strong><span>{status.backend === "offline" ? "Start the backend before saving a key." : status.keySource === "keychain" ? "Saved securely in macOS Keychain. The secret is never returned to this page." : status.keySource === "environment" ? "Loaded from the Terminal environment. You can save a replacement in Keychain." : "Paste once to enable AI without restarting CareerOS."}</span></div></div>
        <div className="api-key-field"><input type={revealKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-proj-..." autoComplete="new-password" spellCheck={false} disabled={status.backend !== "online" || keyBusy} aria-label="OpenAI API key" /><button className="icon-button" title={revealKey ? "Hide API key" : "Reveal API key"} onClick={() => setRevealKey((value) => !value)} disabled={!apiKey}>{revealKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        <div className="api-key-actions"><button className="primary-button" onClick={() => void saveApiKey()} disabled={status.backend !== "online" || keyBusy || !apiKey.trim()}>{keyBusy ? <RefreshCw className="spin" size={14} /> : <KeyRound size={14} />} Save to Keychain</button>{status.keySource === "keychain" && <button className="text-button" onClick={() => void removeApiKey()} disabled={keyBusy}>Remove saved key</button>}</div>
        {keyFeedback && <p className={`api-key-feedback ${/could not|invalid|beginning/i.test(keyFeedback) ? "api-key-feedback-error" : ""}`}>{keyFeedback}</p>}
        <details className="terminal-setup"><summary><SquareTerminal size={14} /> Terminal setup</summary><p>Open Terminal at the CareerOS folder or copy the normal start command.</p><pre>{aiSetupCommand}</pre><div><button className="quiet-button" onClick={() => void openTerminal()} disabled={status.backend !== "online"}><SquareTerminal size={14} /> Open Terminal</button><button className="quiet-button" onClick={() => void copyText("setup", aiSetupCommand)}>{copied === "setup" ? <Check size={14} /> : <Copy size={14} />}{copied === "setup" ? "Copied" : "Copy command"}</button></div></details>
      </section>}

      <details className="system-section system-collapsible ai-history-section" open={aiRunsOpen} onToggle={(event) => setAiRunsOpen(event.currentTarget.open)}>
        <summary className="system-collapse-summary"><div className="system-section-title"><Clock3 size={16} /><div><strong>Recent AI runs</strong><span>Stored with the workspace, without source text or secrets.</span></div></div><div className="system-collapse-meta"><span>{aiRuns.length}</span><ChevronDown size={15} /></div></summary>
        <div className="system-collapse-body">{aiRuns.length === 0 ? <p className="diagnostic-empty">Timing starts with your next import.</p> : <div className="ai-run-list">{aiRuns.map((run) => <div className="ai-run-row" key={run.id}>
          <div className="ai-run-copy">
            <div className="ai-run-heading"><strong>{operationLabel(run.operation)}</strong><span className={`ai-run-state ai-run-${run.state}`}>{run.state}</span></div>
            <small>{run.sourceType.replaceAll("_", " ")} · {timeLabel(run.createdAt)} · {run.model || run.provider}</small>
          </div>
          <div className="ai-run-metrics"><strong>{durationLabel(run.totalDurationMs)}</strong><span>{durationLabel(run.durationMs)} AI · {run.evidenceCount} evidenced</span></div>
        </div>)}</div>}</div>
      </details>

      <details className="system-section system-collapsible diagnostics-section" open={errorsOpen} onToggle={(event) => setErrorsOpen(event.currentTarget.open)}>
        <summary className="system-collapse-summary"><div className="system-section-title"><Bug size={16} /><div><strong>Recent errors</strong><span>Saved in this browser until you clear them.</span></div></div><div className="system-collapse-meta"><span>{errors.length}</span><ChevronDown size={15} /></div></summary>
        <div className="system-collapse-body">
          {errors.length > 0 && <div className="system-section-heading system-list-actions"><span>{errors.length} recorded</span><button className="icon-button" title="Clear error history" onClick={() => setErrors([])}><Trash2 size={15} /></button></div>}
          {errors.length === 0 ? <p className="diagnostic-empty">No errors recorded.</p> : <div className="diagnostic-list">{errors.map((entry) => <div className="diagnostic-entry" key={entry.id}>
            <CircleAlert size={15} />
            <div><strong>{entry.operation}</strong><p>{entry.message}</p><small>{entry.source} · {timeLabel(entry.timestamp)}{entry.statusCode ? ` · HTTP ${entry.statusCode}` : ""}</small></div>
          </div>)}</div>}
          <button className="quiet-button system-action" onClick={() => void copyText("diagnostics", diagnosticsText)}>{copied === "diagnostics" ? <Check size={15} /> : <Copy size={15} />}{copied === "diagnostics" ? "Copied" : "Copy diagnostics"}</button>
        </div>
      </details>
    </aside>}

    <button className="system-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="careeros-system-status" aria-label={`${open ? "Close" : "Open"} CareerOS system status. ${statusAnnouncement}`}>
      <StatusPill state={status.backend} label={backendLabel} />
      <span className="system-summary-divider" />
      <StatusPill state={status.ai} label={aiLabel} />
      {errors.length > 0 && <span className="error-count" aria-label={`${errors.length} recorded errors`}>{errors.length}</span>}
    </button>
  </div>;
}
