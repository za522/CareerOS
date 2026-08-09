import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellRing, Building2, Check, CheckCheck, Clock3, ExternalLink, Eye, EyeOff, Flag, LoaderCircle, Pencil, Plus, Radar, RefreshCw, RotateCcw, Search, Send, Settings2, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import type { AlertRuleCreateInput, DiscoveryRunRecord, DiscoverySourceCreateInput, DiscoveryWorkspace, ImportDraftResponse, NotificationDeliveryHistoryPage, NotificationDeliveryRecord, TelegramSettingsStatus } from "@careeros/contracts";
import { client } from "./api";

function relative(value: string | null) {
  if (!value) return "Not supplied";
  const milliseconds = Date.now() - new Date(value).getTime();
  const future = milliseconds < 0;
  const hours = Math.max(0, Math.floor(Math.abs(milliseconds) / 3_600_000));
  if (hours < 1) return future ? "in less than an hour" : "Less than an hour ago";
  const label = hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  return future ? `in ${label}` : `${label} ago`;
}

function exactDate(value: string | null) {
  if (!value) return "Not supplied";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function duration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function runSummary(run: DiscoveryRunRecord | undefined) {
  if (!run) return "No checks recorded";
  return `${run.foundCount} found · ${run.newCount} new · ${run.changedCount} changed · ${run.missingCount} missing`;
}

const blankSource: DiscoverySourceCreateInput = {
  name: "", kind: "greenhouse", companyName: "", sourceUrl: "", externalKey: "", enabled: true, checkIntervalMinutes: 180,
};

const blankRule: AlertRuleCreateInput = {
  name: "Finance roles", enabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: ["London", "Singapore"], keywords: ["trading", "markets", "quant"], newWithinHours: 24, telegramEnabled: true,
};

export function DiscoverFeed({ onReview, readOnly = false }: { onReview: (review: ImportDraftResponse) => void; readOnly?: boolean }) {
  const [workspace, setWorkspace] = useState<DiscoveryWorkspace | null>(null);
  const [search, setSearch] = useState("");
  const [sideFilter, setSideFilter] = useState("all");
  const [programmeFilter, setProgrammeFilter] = useState("all");
  const [sectorFilter, setSectorFilter] = useState("all");
  const [firmTypeFilter, setFirmTypeFilter] = useState("all");
  const [roleFamilyFilter, setRoleFamilyFilter] = useState("all");
  const [careerTrackFilter, setCareerTrackFilter] = useState("all");
  const [workModeFilter, setWorkModeFilter] = useState("all");
  const [sponsorshipFilter, setSponsorshipFilter] = useState("all");
  const [trackedFilter, setTrackedFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("");
  const [freshOnly, setFreshOnly] = useState(false);
  const [deadlineSoon, setDeadlineSoon] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<TelegramSettingsStatus | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [source, setSource] = useState<DiscoverySourceCreateInput>(blankSource);
  const [rule, setRule] = useState<AlertRuleCreateInput>(blankRule);
  const [editingRuleId, setEditingRuleId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reportPostingId, setReportPostingId] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [deliveryPage, setDeliveryPage] = useState<NotificationDeliveryHistoryPage>({ items: [], nextCursor: null });
  const workspaceRef = useRef<DiscoveryWorkspace | null>(null);
  const requestVersionRef = useRef(0);
  const deliveryLimitRef = useRef(25);

  const commitWorkspace = (next: DiscoveryWorkspace) => {
    workspaceRef.current = next;
    setWorkspace(next);
  };

  const queryParams = (cursor?: string) => ({
    ...(cursor ? { cursor } : {}), limit: "100", ...(search.trim() ? { q: search.trim() } : {}),
    ...(sideFilter !== "all" ? { side: sideFilter } : {}), ...(programmeFilter !== "all" ? { programme: programmeFilter } : {}),
    ...(locationFilter.trim() ? { location: locationFilter.trim() } : {}), ...(sectorFilter !== "all" ? { sector: sectorFilter } : {}),
    ...(firmTypeFilter !== "all" ? { firmType: firmTypeFilter } : {}), ...(roleFamilyFilter !== "all" ? { roleFamily: roleFamilyFilter } : {}),
    ...(careerTrackFilter !== "all" ? { careerTrack: careerTrackFilter } : {}),
    ...(workModeFilter !== "all" ? { workMode: workModeFilter } : {}), ...(sponsorshipFilter !== "all" ? { sponsorship: sponsorshipFilter } : {}),
    ...(trackedFilter !== "all" ? { tracked: trackedFilter } : {}), ...(freshOnly ? { freshWithinHours: "24" } : {}),
    ...(deadlineSoon ? { deadlineSoon: "true" } : {}), ...(showHidden ? { showHidden: "true" } : {}),
  });

  const load = async () => {
    const version = ++requestVersionRef.current;
    try {
      const [next, deliveries] = await Promise.all([client.getDiscoveryWorkspace(queryParams()), client.listAlertDeliveries({ limit: deliveryLimitRef.current })]);
      if (version === requestVersionRef.current) { commitWorkspace(next); setDeliveryPage(deliveries); setError(""); }
    }
    catch (cause) { if (version === requestVersionRef.current) setError(cause instanceof Error ? cause.message : "The discovery feed could not be loaded."); }
  };

  useEffect(() => { void client.listAlertDeliveries({ limit: 25 }).then(setDeliveryPage).catch(() => undefined); }, []);

  useEffect(() => {
    if (!deliveryPage.items.some((item) => item.state === "Pending" || item.state === "Sending")) return;
    const timer = window.setInterval(() => {
      void client.listAlertDeliveries({ limit: deliveryLimitRef.current }).then(setDeliveryPage).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deliveryPage.items]);

  useEffect(() => {
    let active = true;
    const version = ++requestVersionRef.current;
    const timer = window.setTimeout(() => { void client.getDiscoveryWorkspace(queryParams()).then((next) => { if (active && version === requestVersionRef.current) { commitWorkspace(next); setError(""); } }).catch((cause) => { if (active && version === requestVersionRef.current) setError(cause instanceof Error ? cause.message : "The discovery feed could not be loaded."); }); }, search ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, sideFilter, programmeFilter, locationFilter, sectorFilter, firmTypeFilter, roleFamilyFilter, careerTrackFilter, workModeFilter, sponsorshipFilter, trackedFilter, freshOnly, deadlineSoon, showHidden]);

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const version = ++requestVersionRef.current;
      try {
        const wanted = Math.max(100, workspaceRef.current?.postings.length ?? 100);
        let next = await client.getDiscoveryWorkspace(queryParams());
        while (version === requestVersionRef.current && next.postings.length < wanted && next.nextCursor) {
          const page = await client.getDiscoveryWorkspace(queryParams(next.nextCursor));
          next = { ...page, postings: [...next.postings, ...page.postings] };
        }
        if (active && version === requestVersionRef.current) { commitWorkspace(next); setError(""); }
      } catch (cause) {
        if (active && version === requestVersionRef.current) setError(cause instanceof Error ? cause.message : "The discovery feed could not be refreshed.");
      }
    };
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [search, sideFilter, programmeFilter, locationFilter, sectorFilter, firmTypeFilter, roleFamilyFilter, careerTrackFilter, workModeFilter, sponsorshipFilter, trackedFilter, freshOnly, deadlineSoon, showHidden]);

  const postings = workspace?.postings ?? [];

  const run = async (sourceId?: string) => {
    setBusy(sourceId ?? "all"); setError("");
    try {
      const runs = await client.runDiscovery(sourceId);
      await load();
      const needsAttention = runs.filter((item) => item.state === "Failed" || item.state === "Partial");
      const completed = runs.length - needsAttention.length;
      setAnnouncement(needsAttention.length
        ? `${completed} source check${completed === 1 ? "" : "s"} completed; ${needsAttention.length} need attention.`
        : `${runs.length} source check${runs.length === 1 ? "" : "s"} completed.`);
      if (needsAttention.length) setError(needsAttention.map((item) => item.error).filter(Boolean).join(" ") || "One or more source checks returned an incomplete inventory and need attention.");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The source check failed."); }
    finally { setBusy(""); }
  };

  const saveSource = async () => {
    setBusy("source"); setError("");
    try { await client.createDiscoverySource(source); setSource(blankSource); setSourceOpen(false); await load(); setAnnouncement("Discovery source saved."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The source could not be added."); }
    finally { setBusy(""); }
  };

  const saveRule = async () => {
    setBusy("rule"); setError("");
    try {
      const current = workspace?.alertRules.find((item) => item.id === editingRuleId);
      if (current) await client.updateAlertRule(current.id, { ...rule, expectedRevision: current.revision });
      else await client.createAlertRule(rule);
      setRule(blankRule); setEditingRuleId(""); setRuleOpen(false); await load(); setAnnouncement(current ? "Alert rule updated." : "Alert rule saved.");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The alert could not be saved."); }
    finally { setBusy(""); }
  };

  const updateRule = async (id: string, patch: Partial<AlertRuleCreateInput>) => {
    const current = workspace?.alertRules.find((item) => item.id === id);
    if (!current) return;
    setBusy(`rule-${id}`); setError("");
    try { await client.updateAlertRule(id, { ...patch, expectedRevision: current.revision }); await load(); setAnnouncement("Alert rule updated."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The alert rule could not be updated."); }
    finally { setBusy(""); }
  };

  const deleteRule = async (id: string) => {
    setBusy(`rule-${id}`); setError("");
    try { await client.deleteAlertRule(id, workspace?.alertRules.find((item) => item.id === id)?.revision ?? 0); await load(); setAnnouncement("Alert rule deleted."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The alert rule could not be deleted."); }
    finally { setBusy(""); }
  };

  const markAlert = async (id: string, read: boolean) => {
    setBusy(`alert-${id}`); setError("");
    try { await client.markAlertRead(id, read); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The alert could not be updated."); }
    finally { setBusy(""); }
  };

  const loadMore = async () => {
    if (!workspace?.nextCursor) return;
    const version = ++requestVersionRef.current;
    setBusy("more");
    try {
      const next = await client.getDiscoveryWorkspace(queryParams(workspace.nextCursor));
      if (version === requestVersionRef.current) commitWorkspace({ ...next, postings: [...workspace.postings, ...next.postings] });
    } catch (cause) { if (version === requestVersionRef.current) setError(cause instanceof Error ? cause.message : "More roles could not be loaded."); }
    finally { setBusy(""); }
  };

  const savePosting = async (id: string) => {
    setBusy(id); setError("");
    try { onReview(await client.saveDiscoveredPosting(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The posting could not be prepared for review."); }
    finally { setBusy(""); }
  };

  const retryDelivery = async (delivery: NotificationDeliveryRecord) => {
    setBusy(`delivery-${delivery.id}`); setError("");
    try {
      const confirmed = delivery.state !== "Ambiguous" || window.confirm("Telegram may already have delivered this alert. Send it again anyway?");
      if (!confirmed) return;
      const result = await client.retryAlertDelivery(delivery.id, delivery.state === "Ambiguous");
      await load();
      if (result.state !== "Delivered") throw new Error(result.lastError || "Telegram did not confirm delivery.");
      setAnnouncement("Telegram delivery confirmed.");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Telegram delivery could not be retried."); }
    finally { setBusy(""); }
  };

  const sendTestTelegram = async () => {
    setBusy("telegram-test"); setError(""); setAnnouncement("Sending a Telegram test...");
    try { await client.sendTestAlert(); await load(); setTelegramStatus(await client.getTelegramSettings().catch(() => telegramStatus)); setAnnouncement("Telegram test delivered. The direct CareerOS link was reachable when tested."); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "Test failed."; await load(); setTelegramStatus(await client.getTelegramSettings().catch(() => telegramStatus)); setError(message); }
    finally { setBusy(""); }
  };

  const openTelegram = async () => {
    const next = !telegramOpen;
    setTelegramOpen(next); setError("");
    if (!next) return;
    setBusy("telegram-status");
    try { setTelegramStatus(await client.getTelegramSettings()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Telegram settings could not be loaded."); }
    finally { setBusy(""); }
  };

  const saveTelegram = async () => {
    setBusy("telegram-save"); setError("");
    try {
      const status = await client.saveTelegramSettings({ botToken: telegramToken, chatId: telegramChatId });
      setTelegramStatus(status); setTelegramToken(""); setTelegramChatId(""); setShowTelegramToken(false);
      setAnnouncement("Telegram saved securely for this workspace. Send a test to verify delivery.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Telegram settings could not be saved."); }
    finally { setBusy(""); }
  };

  const removeTelegram = async () => {
    setBusy("telegram-remove"); setError("");
    try { setTelegramStatus(await client.deleteTelegramSettings()); setAnnouncement("Telegram disconnected from this workspace."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Telegram could not be disconnected."); }
    finally { setBusy(""); }
  };

  const loadOlderDeliveries = async () => {
    if (!deliveryPage.nextCursor) return;
    setBusy("older-deliveries");
    try {
      const next = await client.listAlertDeliveries({ limit: 25, cursor: deliveryPage.nextCursor });
      setDeliveryPage((current) => {
        const items = [...current.items, ...next.items];
        deliveryLimitRef.current = Math.max(25, items.length);
        return { items, nextCursor: next.nextCursor };
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Older delivery history could not be loaded."); }
    finally { setBusy(""); }
  };

  const setHidden = async (id: string, hidden: boolean) => {
    setBusy(`hidden-${id}`); setError("");
    try { await client.hideDiscoveredPosting(id, hidden); await load(); setAnnouncement(hidden ? "Posting hidden." : "Posting restored."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The posting visibility could not be changed."); }
    finally { setBusy(""); }
  };

  const reportPosting = async (id: string) => {
    setBusy(`report-${id}`); setError("");
    try { await client.reportDiscoveredPosting(id, { reason: reportReason }); setReportPostingId(""); setReportReason(""); setAnnouncement("Incorrect data report saved."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The issue could not be reported."); }
    finally { setBusy(""); }
  };

  const latestRunBySource = useMemo(() => {
    const runs = new Map<string, DiscoveryRunRecord>();
    for (const item of workspace?.latestRuns ?? []) if (!runs.has(item.sourceId)) runs.set(item.sourceId, item);
    return runs;
  }, [workspace]);
  return <div className="discover-feed">
    <section className="discover-hero">
      <div><p className="eyebrow">LIVE FINANCE WATCHLIST</p><h1>Discover</h1><p>Approved company sources, checked repeatedly. A failed check never closes a role.</p></div>
      {!readOnly && <div className="discover-actions"><button className="quiet-button" aria-expanded={ruleOpen} onClick={() => setRuleOpen((value) => !value)}><Bell size={15} /> Alerts</button><button className="quiet-button" aria-expanded={telegramOpen} onClick={() => void openTelegram()}><Send size={15} /> Telegram</button><button className="quiet-button" aria-expanded={sourceOpen} onClick={() => setSourceOpen((value) => !value)}><Plus size={15} /> Source</button><button className="primary-button" disabled={Boolean(busy) || !workspace?.sources.length} onClick={() => void run()}>{busy === "all" ? <LoaderCircle className="spin" size={15} /> : <Radar size={15} />} Check now</button></div>}
    </section>

    {error && <div className="capture-inline-error" role="alert"><TriangleAlert size={16} />{error}</div>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

    {!readOnly && (sourceOpen || ruleOpen || telegramOpen) && <section className="discover-setup-band">
      {sourceOpen && <div className="discover-setup-form"><header><Building2 size={16} /><strong>Add an approved public source</strong></header><div className="discover-form-grid">
        <label><span>Company</span><input value={source.companyName} onChange={(event) => setSource({ ...source, companyName: event.target.value, name: event.target.value ? `${event.target.value} careers` : "" })} /></label>
        <label><span>Provider</span><select value={source.kind} onChange={(event) => setSource({ ...source, kind: event.target.value as DiscoverySourceCreateInput["kind"] })}><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option></select></label>
        <label className="wide"><span>Public API URL</span><input value={source.sourceUrl} onChange={(event) => setSource({ ...source, sourceUrl: event.target.value })} placeholder={source.kind === "greenhouse" ? "https://boards-api.greenhouse.io/v1/boards/company/jobs?content=true" : "https://api.lever.co/v0/postings/company?mode=json"} /></label>
      </div><footer><small>Only official public Greenhouse and Lever feeds are accepted.</small><button className="primary-button" disabled={busy === "source"} onClick={() => void saveSource()}><Check size={14} /> Save source</button></footer></div>}
      {ruleOpen && <div className="discover-setup-form"><header><BellRing size={16} /><strong>{editingRuleId ? "Edit alert" : "New-role alert"}</strong></header><div className="discover-form-grid">
        <label><span>Name</span><input value={rule.name} onChange={(event) => setRule({ ...rule, name: event.target.value })} /></label>
        <label><span>Side</span><select value={rule.side} onChange={(event) => setRule({ ...rule, side: event.target.value as AlertRuleCreateInput["side"] })}><option value="either">Buy or sell side</option><option value="buy_side">Buy side</option><option value="sell_side">Sell side</option></select></label>
        <label><span>Companies</span><input value={rule.companies.join(", ")} onChange={(event) => setRule({ ...rule, companies: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="Jane Street, Blackstone" /></label>
        <label><span>Role families</span><input value={rule.roleFamilies.join(", ")} onChange={(event) => setRule({ ...rule, roleFamilies: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="Trading, research, quant" /></label>
        <label><span>Programmes</span><input value={rule.programmes.join(", ")} onChange={(event) => setRule({ ...rule, programmes: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="Graduate, internship" /></label>
        <label><span>Locations</span><input value={rule.locations.join(", ")} onChange={(event) => setRule({ ...rule, locations: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label>
        <label><span>Keywords</span><input value={rule.keywords.join(", ")} onChange={(event) => setRule({ ...rule, keywords: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label>
        <label><span>Freshness</span><select value={rule.newWithinHours} onChange={(event) => setRule({ ...rule, newWithinHours: Number(event.target.value) })}><option value={24}>First detected in 24 hours</option><option value={72}>First detected in 3 days</option><option value={168}>First detected in 7 days</option><option value={720}>First detected in 30 days</option></select></label>
      </div><footer><small>Alerts are deduplicated. Telegram is used when configured.</small><div><button className="quiet-button" disabled={busy === "telegram-test"} onClick={() => void sendTestTelegram()}>{busy === "telegram-test" ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />} {busy === "telegram-test" ? "Testing..." : "Test Telegram"}</button><button className="primary-button" disabled={busy === "rule"} onClick={() => void saveRule()}><Check size={14} /> {editingRuleId ? "Update alert" : "Save alert"}</button></div></footer></div>}
      {telegramOpen && <div className="discover-setup-form telegram-setup"><header><ShieldCheck size={16} /><div><strong>Telegram notifications</strong><span>{telegramStatus?.configured ? `Connected to ${telegramStatus.chatIdHint}` : "Not connected"}</span></div></header>
        {telegramStatus?.hosted === false ? <p className="telegram-setup-note">This local app uses the Telegram values from its private local environment.</p> : <div className="discover-form-grid">
          <label className="wide"><span>Bot token</span><div className="secret-input"><input type={showTelegramToken ? "text" : "password"} autoComplete="new-password" value={telegramToken} onChange={(event) => setTelegramToken(event.target.value)} placeholder={telegramStatus?.configured ? "Enter a new token to replace the saved one" : "Paste the token from BotFather"} /><button className="icon-button" type="button" aria-label={showTelegramToken ? "Hide bot token" : "Show bot token"} onClick={() => setShowTelegramToken((value) => !value)}>{showTelegramToken ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          <label><span>Chat ID</span><input value={telegramChatId} onChange={(event) => setTelegramChatId(event.target.value)} placeholder={telegramStatus?.chatIdHint || "Your Telegram chat ID"} /></label>
        </div>}
        <footer><small>{telegramStatus?.lastTestedAt ? `Last attempted ${relative(telegramStatus.lastTestedAt)}.` : telegramStatus?.hosted === false ? "Local credentials stay in the API process environment and are never sent to the browser." : "The token is encrypted on the server and is never shown again."}{telegramStatus?.lastSuccessfulTestAt ? ` Last successful ${relative(telegramStatus.lastSuccessfulTestAt)}.` : ""}{telegramStatus?.lastError ? ` ${telegramStatus.lastError}` : ""}</small><div>{telegramStatus?.configured && telegramStatus.hosted && <button className="quiet-button" disabled={Boolean(busy)} onClick={() => void removeTelegram()}><Trash2 size={14} /> Disconnect</button>}<button className="quiet-button" disabled={Boolean(busy) || !telegramStatus?.configured} onClick={() => void sendTestTelegram()}>{busy === "telegram-test" ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />} Test delivery</button>{telegramStatus?.hosted !== false && <button className="primary-button" disabled={Boolean(busy) || telegramToken.length < 20 || !telegramChatId.trim()} onClick={() => void saveTelegram()}>{busy === "telegram-save" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save securely</button>}</div></footer>
      </div>}
    </section>}

    <section className="discover-status-strip">
      <div><strong>{workspace?.openPostingTotal ?? 0}</strong><span>open roles</span></div>
      <div><strong>{workspace?.sources.length ?? 0}</strong><span>approved sources</span></div>
      <div><strong>{workspace?.alerts.filter((alert) => !alert.readAt).length ?? 0}</strong><span>unread alerts</span></div>
      <div className="discover-last-check"><Clock3 size={14} /><span>Last checked {relative(workspace?.latestRuns[0]?.completedAt ?? null)}</span></div>
    </section>

    <section className="discover-toolbar"><label><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search every discovered role..." /></label><span>{workspace?.postingTotal ?? 0} matches</span></section>
    <section className="discover-filters" aria-label="Discovery filters">
      <select aria-label="Buy or sell side" value={sideFilter} onChange={(event) => setSideFilter(event.target.value)}><option value="all">All sides</option><option value="buy_side">Buy side</option><option value="sell_side">Sell side</option><option value="unknown">Not classified</option></select>
      <select aria-label="Programme" value={programmeFilter} onChange={(event) => setProgrammeFilter(event.target.value)}><option value="all">All programmes</option><option>Graduate</option><option>Internship</option><option>Off-cycle</option><option>Spring week</option><option>Placement</option><option>Entry-level</option></select>
      <input aria-label="Location filter" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)} placeholder="Any location" />
      <select aria-label="Sector" value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="all">All sectors</option><option>Financial services</option><option>Technology</option><option>Risk, finance &amp; legal</option></select>
      <select aria-label="Firm type" value={firmTypeFilter} onChange={(event) => setFirmTypeFilter(event.target.value)}><option value="all">All firm types</option><option>Market maker / proprietary trading</option><option>Hedge fund</option><option>Asset manager</option><option>Private equity</option><option>Investment bank</option><option>Financial services</option></select>
      <select aria-label="Role family" value={roleFamilyFilter} onChange={(event) => setRoleFamilyFilter(event.target.value)}><option value="all">All role families</option><option>Trading</option><option>Quantitative research</option><option>Engineering</option><option>Risk</option><option>Finance</option><option>Operations</option><option>People</option><option>Legal &amp; compliance</option><option>Business</option></select>
      <select aria-label="Career track" value={careerTrackFilter} onChange={(event) => setCareerTrackFilter(event.target.value)}><option value="all">All career tracks</option><option>Quantitative finance</option><option>Trading &amp; markets</option><option>Technology</option><option>Financial institutions</option><option>Buy side</option><option>Sell side</option><option>Business &amp; operations</option></select>
      <select aria-label="Work mode" value={workModeFilter} onChange={(event) => setWorkModeFilter(event.target.value)}><option value="all">Any work mode</option><option>Remote</option><option>Hybrid</option><option>On-site</option><option>Not stated</option></select>
      <select aria-label="Sponsorship evidence" value={sponsorshipFilter} onChange={(event) => setSponsorshipFilter(event.target.value)}><option value="all">Any sponsorship</option><option>Yes</option><option>No</option><option>Not stated</option></select>
      <select aria-label="Saved state" value={trackedFilter} onChange={(event) => setTrackedFilter(event.target.value)}><option value="all">Saved or unsaved</option><option value="saved">Saved</option><option value="unsaved">Not saved</option></select>
      <label><input type="checkbox" checked={freshOnly} onChange={(event) => setFreshOnly(event.target.checked)} /> New in 24h</label>
      <label><input type="checkbox" checked={deadlineSoon} onChange={(event) => setDeadlineSoon(event.target.checked)} /> Deadline soon</label>
      <label><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> Show hidden</label>
    </section>

    {!workspace ? <div className="table-state" role="status"><LoaderCircle className="spin" size={20} /><span>Loading discovery feed...</span></div> : !workspace.sources.length ? <div className="discover-empty"><Radar size={24} /><strong>{readOnly ? "No discovery sources configured" : "Add your first approved careers source"}</strong><span>CareerOS supports the official public Greenhouse and Lever job-board APIs.</span>{!readOnly && <button className="primary-button" onClick={() => setSourceOpen(true)}><Plus size={15} /> Add source</button>}</div> : !postings.length ? <div className="discover-empty"><Search size={24} /><strong>No roles match these filters</strong><span>Clear a filter or include hidden roles to widen the feed.</span></div> : <div className="discover-table" role="table" aria-label="Live discovered roles">
      <div className="discover-table-row discover-table-head" role="row"><span role="columnheader">Company</span><span role="columnheader">Role</span><span role="columnheader">Programme</span><span role="columnheader">Location</span><span role="columnheader">Deadline</span><span role="columnheader">Employer posted</span><span role="columnheader">CareerOS detected</span><span role="columnheader">Last checked</span><span role="columnheader">Availability</span><span role="columnheader" aria-label="Actions" /></div>
      {postings.map((posting) => <div className="discover-table-row" role="row" key={posting.id}>
        <div role="cell" data-label="Company"><strong>{posting.companyName}</strong><small>{posting.side === "unknown" ? "Side not classified" : posting.side.replace("_", " ")}</small></div>
        <div role="cell" data-label="Role"><strong>{posting.title}</strong><small>{posting.roleFamily} · {posting.careerTrack}</small></div>
        <span role="cell" data-label="Programme">{posting.programme || "-"}</span><span role="cell" data-label="Location">{posting.location || "-"}<small>{posting.workMode} · sponsorship {posting.sponsorship.toLowerCase()}</small></span><span className="discover-date" role="cell" data-label="Deadline"><span>{posting.deadlineAt ? relative(posting.deadlineAt) : "-"}</span>{posting.deadlineAt && <small>{exactDate(posting.deadlineAt)}</small>}</span>
        <span className="discover-date" role="cell" data-label="Employer posted"><span>{relative(posting.sourcePostedAt)}</span>{posting.sourcePostedAt && <small>{exactDate(posting.sourcePostedAt)}</small>}</span><span className="discover-date" role="cell" data-label="CareerOS detected"><span>{relative(posting.firstSeenAt)}</span><small>{exactDate(posting.firstSeenAt)}</small></span><span className="discover-date" role="cell" data-label="Last checked"><span>{relative(posting.lastCheckedAt)}</span><small>{exactDate(posting.lastCheckedAt)}</small></span>
        <span role="cell" data-label="Availability"><span className={`availability-badge availability-${posting.availability.toLowerCase()}`}>{posting.availability}</span></span>
        <div className="discover-row-actions" role="cell" data-label="Actions">
          <a className="icon-button" aria-label={`Open ${posting.title} at ${posting.companyName}`} title="Open direct application" href={posting.applyUrl || posting.canonicalUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>
          {!readOnly && <button className="icon-button" aria-label={posting.hiddenAt ? `Restore ${posting.title}` : `Hide ${posting.title}`} title={posting.hiddenAt ? "Restore posting" : "Hide posting"} disabled={busy === `hidden-${posting.id}`} onClick={() => void setHidden(posting.id, !posting.hiddenAt)}>{posting.hiddenAt ? <RotateCcw size={15} /> : <EyeOff size={15} />}</button>}
          {!readOnly && <button className="icon-button" aria-label={`Report incorrect data for ${posting.title}`} title="Report incorrect data" onClick={() => { setReportPostingId(reportPostingId === posting.id ? "" : posting.id); setReportReason(""); }}><Flag size={15} /></button>}
          {!readOnly && <button className="quiet-button" disabled={busy === posting.id || Boolean(posting.savedJobPostingId)} onClick={() => void savePosting(posting.id)}>{posting.savedJobPostingId ? "Saved" : busy === posting.id ? <><LoaderCircle className="spin" size={14} /> Preparing</> : "Review"}</button>}
          {!readOnly && reportPostingId === posting.id && <div className="discover-report-popover"><label><span>What is incorrect?</span><textarea autoFocus value={reportReason} onChange={(event) => setReportReason(event.target.value)} /></label><div><button className="quiet-button" onClick={() => setReportPostingId("")}>Cancel</button><button className="primary-button" disabled={reportReason.trim().length < 3 || busy === `report-${posting.id}`} onClick={() => void reportPosting(posting.id)}>Send report</button></div></div>}
        </div>
      </div>)}
    </div>}
    {workspace?.nextCursor && <div className="discover-load-more"><button className="quiet-button" disabled={busy === "more"} onClick={() => void loadMore()}>{busy === "more" ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Load more roles</button><span>Showing {workspace.postings.length} of {workspace.postingTotal}</span></div>}

    {!!workspace?.alerts.length && <section className="alert-inbox" aria-labelledby="alert-inbox-heading"><header><div><BellRing size={15} /><strong id="alert-inbox-heading">In-app alerts</strong></div><span>{workspace.alerts.filter((alert) => !alert.readAt).length} unread</span></header>{workspace.alerts.slice(0, 12).map((alert) => <article className={alert.readAt ? "alert-inbox-row" : "alert-inbox-row unread"} key={alert.id}><div><strong>{alert.title}</strong><p>{alert.body}</p><small>{exactDate(alert.createdAt)}</small></div><div>{alert.directUrl && <a className="quiet-button" href={alert.directUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open role</a>}{!readOnly && <button className="icon-button" disabled={busy === `alert-${alert.id}`} title={alert.readAt ? "Mark unread" : "Mark read"} aria-label={alert.readAt ? `Mark ${alert.title} unread` : `Mark ${alert.title} read`} onClick={() => void markAlert(alert.id, !alert.readAt)}><CheckCheck size={15} /></button>}</div></article>)}</section>}

    {!!workspace?.alertRules.length && <section className="alert-rule-list" aria-labelledby="alert-rules-heading"><header><Bell size={15} /><strong id="alert-rules-heading">Saved alert rules</strong></header>{workspace.alertRules.map((item) => <div className="alert-rule-row" key={item.id}><div><strong>{item.name}</strong><span>{[...item.locations, ...item.roleFamilies, ...item.keywords].slice(0, 5).join(" · ") || "All matching roles"}</span></div><label><input type="checkbox" checked={item.enabled} disabled={readOnly || busy === `rule-${item.id}`} onChange={(event) => void updateRule(item.id, { enabled: event.target.checked })} /> Active</label><label><input type="checkbox" checked={item.telegramEnabled} disabled={readOnly || busy === `rule-${item.id}`} onChange={(event) => void updateRule(item.id, { telegramEnabled: event.target.checked })} /> Telegram</label>{!readOnly && <><button className="icon-button" title="Edit alert rule" aria-label={`Edit ${item.name}`} onClick={() => { const { id, createdAt, updatedAt, revision, ...draft } = item; void id; void createdAt; void updatedAt; void revision; setRule(draft); setEditingRuleId(item.id); setRuleOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}><Pencil size={14} /></button><button className="icon-button" disabled={busy === `rule-${item.id}`} title="Delete alert rule" aria-label={`Delete ${item.name}`} onClick={() => void deleteRule(item.id)}><Trash2 size={14} /></button></>}</div>)}</section>}

    {!!workspace?.sources.length && <section className="source-monitor" aria-labelledby="source-monitor-heading"><header><div><Settings2 size={15} /><strong id="source-monitor-heading">Source monitor</strong></div><button className="icon-button" aria-label="Refresh source status" title="Refresh source status" onClick={() => void load()}><RefreshCw size={15} /></button></header>{workspace.sources.map((item) => {
      const latestRun = latestRunBySource.get(item.id);
      const overdue = Boolean(item.lastSuccessfulAt && Date.now() - new Date(item.lastSuccessfulAt).getTime() > item.checkIntervalMinutes * 2 * 60_000);
      const noInventory = item.successfulInventoryCount === 0 && Boolean(item.lastCheckedAt);
      const health = busy === item.id ? "Checking" : item.lastError || noInventory ? "Needs attention" : overdue ? "Overdue" : item.lastSuccessfulAt ? "Healthy" : "Not checked";
      return <div className="source-monitor-row" key={item.id}>
        <div className="source-identity"><strong>{item.name}</strong><span>{item.kind} · every {item.checkIntervalMinutes} minutes</span></div>
        <div className="source-health"><span className={item.lastError || overdue || noInventory ? "source-error" : item.lastSuccessfulAt ? "source-ok" : "source-neutral"}><i aria-hidden="true" />{health}</span><small>Checked {relative(item.lastCheckedAt)} · inventory high-water {item.successfulInventoryCount}</small>{item.lastError && <small className="source-error-copy">{item.lastError}</small>}</div>
        <div className="source-run-summary"><strong>{latestRun ? `${latestRun.state} in ${duration(latestRun.durationMs)}` : "No run history"}</strong><span>{runSummary(latestRun)}</span></div>
        {!readOnly && <button className="quiet-button" disabled={busy === item.id} onClick={() => void run(item.id)}>{busy === item.id ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Check</button>}
      </div>;
    })}</section>}

    {!!workspace?.latestRuns.length && <section className="discover-history" aria-labelledby="run-history-heading"><header><Clock3 size={15} /><strong id="run-history-heading">Recent source runs</strong></header><div className="discover-history-list">{workspace.latestRuns.slice(0, 8).map((run) => {
      const sourceName = workspace.sources.find((item) => item.id === run.sourceId)?.name ?? "Unknown source";
      return <div className="discover-history-row" key={run.id}><div><strong>{sourceName}</strong><span title={exactDate(run.startedAt)}>{relative(run.startedAt)}</span></div><span className={`run-state run-state-${run.state.toLowerCase()}`}>{run.state}</span><span>{duration(run.durationMs)}</span><span>{runSummary(run)}</span>{run.error && <small>{run.error}</small>}</div>;
    })}</div></section>}

    {!!deliveryPage.items.length && <section className="delivery-monitor" aria-labelledby="delivery-monitor-heading"><header><Send size={15} /><strong id="delivery-monitor-heading">Telegram delivery history</strong></header>{deliveryPage.items.map((delivery) => <div className="delivery-monitor-row" key={delivery.id}><div><strong>{delivery.alertTitle}</strong><span>{relative(delivery.createdAt)} · {delivery.attemptCount} {delivery.attemptCount === 1 ? "send" : "sends"}</span></div><span className={`delivery-state delivery-${delivery.state.toLowerCase()}`}>{delivery.state === "ConfigurationRequired" ? "Setup required" : delivery.state}</span><div className="delivery-message">{delivery.lastError || (delivery.deliveredAt ? `Delivered ${relative(delivery.deliveredAt)}` : delivery.state === "Sending" ? "Telegram is processing this message" : "Waiting to send")}{delivery.attempts.length > 0 && <details><summary>{delivery.attempts.length} history {delivery.attempts.length === 1 ? "entry" : "entries"}</summary>{delivery.attempts.map((attempt) => <p key={attempt.id}><strong>{attempt.state}</strong> · {exactDate(attempt.startedAt)}{attempt.error ? ` · ${attempt.error}` : ""}</p>)}</details>}</div><div className="delivery-actions">{delivery.directUrl && <a className="icon-button" href={delivery.directUrl} target="_blank" rel="noreferrer" title="Open alert link" aria-label={`Open link for ${delivery.alertTitle}`}><ExternalLink size={14} /></a>}{["Failed", "Ambiguous", "ConfigurationRequired"].includes(delivery.state) && <button className="quiet-button" disabled={busy === `delivery-${delivery.id}`} title={delivery.state === "Ambiguous" ? "Send again; this may duplicate a message" : "Retry Telegram delivery"} onClick={() => void retryDelivery(delivery)}>{busy === `delivery-${delivery.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} {delivery.state === "Ambiguous" ? "Send again" : "Retry"}</button>}</div></div>)}{deliveryPage.nextCursor && <button className="quiet-button delivery-load-more" disabled={busy === "older-deliveries"} onClick={() => void loadOlderDeliveries()}>{busy === "older-deliveries" ? <LoaderCircle className="spin" size={14} /> : <Clock3 size={14} />} Load older deliveries</button>}</section>}
  </div>;
}
