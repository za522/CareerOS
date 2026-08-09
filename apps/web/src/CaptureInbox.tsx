import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Check, ClipboardPaste, Clock3, Link2, LoaderCircle, RefreshCw, RotateCcw, Sparkles, X } from "lucide-react";
import type { CaptureBatchConflict, CaptureDraftRecord, CaptureQueueItem, CaptureQueueSummary } from "@careeros/contracts";
import { CareerOSRequestError, client } from "./api";

const emptySummary: CaptureQueueSummary = {
  total: 0,
  active: 0,
  counts: { Queued: 0, Extracting: 0, "Needs Review": 0, Duplicate: 0, Blocked: 0, Failed: 0, Saved: 0 },
};

function stateLabel(item: CaptureQueueItem) {
  if (item.state === "Extracting") return `${Math.round(item.progress * 100)}%`;
  return item.state;
}

export function CaptureInbox({ onReview, onBatchSaved }: { onReview: (item: CaptureQueueItem) => void; onBatchSaved?: () => void }) {
  const [mode, setMode] = useState<"pasted_text" | "url">("pasted_text");
  const [value, setValue] = useState("");
  const [items, setItems] = useState<CaptureQueueItem[]>([]);
  const [summary, setSummary] = useState<CaptureQueueSummary>(emptySummary);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedPages, setLoadedPages] = useState(1);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [enqueuePending, setEnqueuePending] = useState(0);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [recoveredDrafts, setRecoveredDrafts] = useState<CaptureDraftRecord[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textTabRef = useRef<HTMLButtonElement>(null);
  const urlTabRef = useRef<HTMLButtonElement>(null);
  const draftRevisions = useRef(new Map<string, number>());
  const draftPersistedValues = useRef(new Map<string, string>());
  const draftSaveChain = useRef<Promise<void>>(Promise.resolve());

  const refreshSequence = useRef(0);
  const refresh = async (pageCount = loadedPages) => {
    const sequence = ++refreshSequence.current;
    try {
      const combined: CaptureQueueItem[] = [];
      let cursor: string | undefined;
      let latestSummary = emptySummary;
      let remainingCursor: string | null = null;
      for (let page = 0; page < pageCount; page += 1) {
        const next = await client.listCaptureQueue({ limit: 50, cursor });
        combined.push(...next.items);
        latestSummary = next.summary;
        remainingCursor = next.nextCursor;
        if (!next.nextCursor) break;
        cursor = next.nextCursor;
      }
      if (sequence !== refreshSequence.current) return;
      setItems([...new Map(combined.map((item) => [item.id, item])).values()]);
      setSummary(latestSummary);
      setNextCursor(remainingCursor);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The capture queue could not be loaded.";
      setError((current) => current || message);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), summary.active > 0 ? 900 : 3_000);
    return () => window.clearInterval(timer);
  }, [summary.active, loadedPages]);

  const loadDrafts = async (recoverLatest = false) => {
    const drafts = await client.listCaptureDrafts();
    draftRevisions.current = new Map(drafts.map((draft) => [draft.id, draft.revision]));
    draftPersistedValues.current = new Map(drafts.map((draft) => [draft.id, draft.value.trim()]));
    setRecoveredDrafts(drafts);
    if (recoverLatest && drafts[0]) {
      setDraftId(drafts[0].id);
      setMode(drafts[0].sourceType);
      setValue(drafts[0].value);
      setError("Recovered an unsent capture from this device.");
    }
    setDraftsLoaded(true);
  };

  useEffect(() => { void loadDrafts(true).catch(() => setDraftsLoaded(true)); }, []);

  useEffect(() => {
    if (!draftsLoaded) return;
    const timer = window.setTimeout(() => {
      if (!value.trim()) {
        const expectedRevision = draftRevisions.current.get(draftId);
        if (expectedRevision === undefined) return;
        draftSaveChain.current = draftSaveChain.current.then(async () => {
          await client.deleteCaptureDraft(draftId, draftRevisions.current.get(draftId));
          draftRevisions.current.delete(draftId);
          draftPersistedValues.current.delete(draftId);
          setRecoveredDrafts((current) => current.filter((item) => item.id !== draftId));
        }).catch((cause) => {
          const message = cause instanceof Error ? cause.message : "That shared draft could not be cleared.";
          setError((current) => current || message);
        });
        return;
      }
      const capturedId = draftId;
      const capturedMode = mode;
      const capturedValue = value;
      draftSaveChain.current = draftSaveChain.current.then(async () => {
        const saved = await client.saveCaptureDraft(capturedId, {
          sourceType: capturedMode,
          value: capturedValue,
          expectedRevision: draftRevisions.current.get(capturedId),
        });
        draftRevisions.current.set(saved.id, saved.revision);
        draftPersistedValues.current.set(saved.id, capturedValue.trim());
        setRecoveredDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      }).catch((cause) => {
        const message = cause instanceof Error ? cause.message : "The shared draft could not be autosaved.";
        setError((current) => current || message);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftId, draftsLoaded, mode, value]);

  const canSubmit = value.trim().length > 0;
  const queuedCopy = useMemo(() => {
    if (summary.active > 0) return `${summary.active} processing`;
    if (summary.counts["Needs Review"] + summary.counts.Duplicate > 0) return `${summary.counts["Needs Review"] + summary.counts.Duplicate} ready to review`;
    return "Queue ready";
  }, [summary]);
  const visibleReadyCount = items.filter((item) => item.state === "Needs Review").length;

  const submit = async () => {
    if (!canSubmit) return;
    const captured = value.trim();
    const submittedDraftId = draftId;
    setEnqueuePending((current) => current + 1);
    setError("");
    try {
      await draftSaveChain.current;
      const saved = await client.saveCaptureDraft(submittedDraftId, {
        sourceType: mode,
        value: captured,
        expectedRevision: draftRevisions.current.get(submittedDraftId),
      });
      draftRevisions.current.set(saved.id, saved.revision);
      draftPersistedValues.current.set(saved.id, captured);
      setRecoveredDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setValue((current) => current.trim() === captured ? "" : current);
      setDraftId((current) => current === submittedDraftId ? crypto.randomUUID() : current);
      textareaRef.current?.focus();
      await client.enqueueCaptureDraft(submittedDraftId);
      draftRevisions.current.delete(submittedDraftId);
      draftPersistedValues.current.delete(submittedDraftId);
      setRecoveredDrafts((current) => current.filter((item) => item.id !== submittedDraftId));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Those captures could not be queued.";
      const persisted = draftPersistedValues.current.get(submittedDraftId) === captured;
      if (!persisted) {
        setDraftId(submittedDraftId);
        setMode(mode);
        setValue((current) => current.trim() ? current : captured);
      }
      setError(persisted
        ? `One capture was preserved and can be retried below. ${message}`
        : `One capture was not saved. Its text remains in the composer so you can retry. ${message}`);
      if (persisted) await loadDrafts(false).catch(() => undefined);
    } finally {
      setEnqueuePending((current) => Math.max(0, current - 1));
    }
  };

  const retryFailedEnqueue = async (failed: CaptureDraftRecord) => {
    setEnqueuePending((current) => current + 1);
    try {
      await client.enqueueCaptureDraft(failed.id);
      draftRevisions.current.delete(failed.id);
      draftPersistedValues.current.delete(failed.id);
      setRecoveredDrafts((current) => current.filter((item) => item.id !== failed.id));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "That capture still could not be queued.";
      setRecoveredDrafts((current) => current.map((item) => item.id === failed.id ? { ...item, error: message } : item));
      await loadDrafts(false).catch(() => undefined);
    } finally {
      setEnqueuePending((current) => Math.max(0, current - 1));
    }
  };

  const discardDraft = async (id: string) => {
    try {
      await draftSaveChain.current;
      await client.deleteCaptureDraft(id, draftRevisions.current.get(id));
      draftRevisions.current.delete(id);
      draftPersistedValues.current.delete(id);
      setRecoveredDrafts((current) => current.filter((item) => item.id !== id));
      if (draftId === id) { setValue(""); setDraftId(crypto.randomUUID()); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That recovered capture could not be discarded.");
      await loadDrafts(false).catch(() => undefined);
    }
  };

  const retry = async (id: string) => {
    try {
      await client.retryCapture(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That capture could not be retried.");
    }
  };

  const cancel = async (id: string) => {
    try {
      await client.cancelCapture(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That capture could not be cancelled.");
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const next = await client.listCaptureQueue({ cursor: nextCursor });
      setItems((current) => [...new Map([...current, ...next.items].map((item) => [item.id, item])).values()]);
      setSummary(next.summary);
      setNextCursor(next.nextCursor);
      setLoadedPages((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Older captures could not be loaded.");
    }
  };

  const approveValidBatch = async () => {
    const ready = items.filter((item) => item.state === "Needs Review");
    if (!ready.length) return;
    setSubmitting(true);
    setError("");
    try {
      await client.commitCaptureBatch({ items: ready.map((item) => ({ id: item.id })) });
      await refresh();
      onBatchSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The valid captures could not be saved as a batch.");
      if (cause instanceof CareerOSRequestError && Array.isArray(cause.details.conflicts) && cause.details.conflicts.length) {
        const conflicts = cause.details.conflicts as CaptureBatchConflict[];
        await refresh();
        const first = await client.getCapture(conflicts[0].id);
        onReview(first);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, next: "pasted_text" | "url") => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === "Home" ? "pasted_text" : event.key === "End" ? "url" : next;
    setMode(target);
    (target === "pasted_text" ? textTabRef : urlTabRef).current?.focus();
  };

  return <div className="capture-inbox">
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{queuedCopy}. {summary.counts.Failed + summary.counts.Blocked} need attention.</div>
    <section className="capture-command-band">
      <div className="capture-heading">
        <div><p className="eyebrow">CAPTURE INBOX</p><h1>Keep pasting. CareerOS will catch up.</h1></div>
        <div className={`queue-health ${summary.active ? "active" : ""}`}><span /><strong>{queuedCopy}</strong><small>{summary.total} total</small></div>
      </div>
      <div className="capture-mode" role="tablist" aria-label="Capture type">
        <button ref={textTabRef} role="tab" aria-selected={mode === "pasted_text"} tabIndex={mode === "pasted_text" ? 0 : -1} className={mode === "pasted_text" ? "active" : ""} onKeyDown={(event) => moveTab(event, "url")} onClick={() => setMode("pasted_text")}><ClipboardPaste size={16} /> LinkedIn text</button>
        <button ref={urlTabRef} role="tab" aria-selected={mode === "url"} tabIndex={mode === "url" ? 0 : -1} className={mode === "url" ? "active" : ""} onKeyDown={(event) => moveTab(event, "pasted_text")} onClick={() => setMode("url")}><Link2 size={16} /> Public links</button>
      </div>
      <label className="capture-composer">
        <span>{mode === "pasted_text" ? "Paste one complete job page" : "Paste one or many public job links"}</span>
        <textarea ref={textareaRef} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); }
        }} placeholder={mode === "pasted_text" ? "Copy the LinkedIn job page, paste it here, then press Command + Enter." : "https://company.example/jobs/123\nhttps://another.example/jobs/456"} autoFocus />
      </label>
      <div className="capture-submit-row">
        <span>{mode === "pasted_text" ? "The input clears after a recoverable draft is saved. Paste the next role while AI works." : "Each link gets its own progress and failure state."}</span>
        <button className="primary-button" disabled={!canSubmit} onClick={() => void submit()}><Sparkles size={16} /> Add to queue{enqueuePending ? ` (${enqueuePending})` : ""}</button>
      </div>
      {error && <div className="capture-inline-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
      {recoveredDrafts.filter((draft) => draft.id !== draftId).length > 0 && <div className="capture-failed-enqueues" aria-label="Captures waiting to be retried">{recoveredDrafts.filter((draft) => draft.id !== draftId).map((failed) => <div key={failed.id}><div><strong>{failed.sourceType === "url" ? "Public links" : "Pasted job page"}</strong><span>{failed.value.slice(0, 120)}</span><small>{failed.error || "Recovered before it reached the queue."}</small></div><div className="capture-recovery-actions"><button className="quiet-button" onClick={() => void retryFailedEnqueue(failed)}><RotateCcw size={14} /> Retry</button><button className="icon-button" aria-label="Discard recovered capture" title="Discard recovered capture" onClick={() => void discardDraft(failed.id)}><X size={14} /></button></div></div>)}</div>}
    </section>

    <section className="capture-queue-section">
      <header><div><h2>Import queue</h2><p>Review extracted rows when they are ready. One failure never stops the rest.</p></div><div className="capture-header-actions">{visibleReadyCount > 0 && <button className="quiet-button" disabled={submitting} onClick={() => void approveValidBatch()}><Check size={15} /> Save {visibleReadyCount} valid</button>}<button className="icon-button" title="Refresh capture queue" onClick={() => void refresh()}><RefreshCw size={16} /></button></div></header>
      {!items.length ? <div className="capture-empty"><ClipboardPaste size={22} /><strong>No captures queued</strong><span>Your first pasted job will appear here immediately.</span></div> : <div className="capture-queue-list">
        {items.map((item) => <article className="capture-queue-row" key={item.id}>
          <div className={`capture-state state-${item.state.toLowerCase().replaceAll(" ", "-")}`}>{item.state === "Extracting" || item.state === "Queued" ? <LoaderCircle className="spin" size={15} /> : item.state === "Saved" ? <Check size={15} /> : item.state === "Failed" || item.state === "Blocked" ? <AlertTriangle size={15} /> : <Clock3 size={15} />}<span>{stateLabel(item)}</span></div>
          <div className="capture-queue-copy"><strong>{item.draft?.title || (item.sourceType === "url" ? item.sourceUrl : item.textPreview) || "Queued capture"}</strong><span>{item.draft?.companyName || (item.sourceType === "url" ? "Public link" : "Pasted job text")}{item.draft?.location ? ` · ${item.draft.location}` : ""}</span>{item.progressMessage && <small className="capture-progress-copy">{item.progressMessage}</small>}{item.error && <details className="capture-error-details"><summary>Error details</summary><p>{item.error}</p></details>}{item.state === "Extracting" && <div className="capture-progress"><span style={{ width: `${Math.max(5, item.progress * 100)}%` }} /></div>}</div>
          <div className="capture-queue-actions">
            {(item.state === "Needs Review" || item.state === "Duplicate") && <button className="quiet-button" onClick={() => onReview(item)}>{item.state === "Duplicate" ? "Compare" : "Review"}</button>}
            {(item.state === "Failed" || item.state === "Blocked") && <button className="quiet-button" onClick={() => void retry(item.id)}><RotateCcw size={14} /> Retry</button>}
            {(item.state === "Queued" || item.state === "Extracting") && <button className="quiet-button" onClick={() => void cancel(item.id)}><X size={14} /> Cancel</button>}
          </div>
        </article>)}
      </div>}
      {nextCursor && <div className="capture-load-more"><button className="quiet-button" onClick={() => void loadMore()}>Load older captures</button></div>}
    </section>
  </div>;
}
