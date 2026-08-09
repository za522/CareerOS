import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { WorkspaceSessionRecord } from "@careeros/contracts";
import { getSupabaseClient, isRealtimeEnabled } from "./auth";

type Presence = { userId: string; name: string; color: string; path: string; activeField: string; onlineAt: string };
type Cursor = Presence & { x: number; y: number };
type WorkspaceMutation = { userId: string; path: string; at: string };

const cleanText = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";

export function canonicalPresence(
  payload: unknown,
  members: WorkspaceSessionRecord["members"],
): Presence | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<Presence>;
  const member = members.find((item) => item.id === candidate.userId);
  if (!member) return null;
  return {
    userId: member.id,
    name: member.displayName || member.email || "Collaborator",
    color: colorFor(member.id),
    path: cleanText(candidate.path, 500),
    activeField: cleanText(candidate.activeField, 240),
    onlineAt: cleanText(candidate.onlineAt, 40),
  };
}

export function canonicalCursor(payload: unknown, members: WorkspaceSessionRecord["members"]): Cursor | null {
  const presence = canonicalPresence(payload, members);
  if (!presence || !payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<Cursor>;
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number" || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return { ...presence, x: Math.max(0, Math.min(1, candidate.x)), y: Math.max(0, Math.min(1, candidate.y)) };
}

function colorFor(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const colors = ["#2f7f69", "#315fa8", "#9a4e38", "#7d5aa6", "#8b6b16"];
  return colors[Math.abs(hash) % colors.length];
}

export function CollaborationPresence({ session }: { session: WorkspaceSessionRecord | null }) {
  const [people, setPeople] = useState<Presence[]>([]);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const [path, setPath] = useState(() => window.location.pathname + window.location.hash);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const activeFieldRef = useRef("");
  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname + window.location.hash);
    window.addEventListener("popstate", updatePath);
    const timer = window.setInterval(updatePath, 500);
    return () => { window.removeEventListener("popstate", updatePath); window.clearInterval(timer); };
  }, []);
  const me = useMemo<Presence | null>(() => session?.hosted ? {
    userId: session.user.memberId,
    name: session.members.find((member) => member.id === session.user.memberId)?.displayName || session.user.email || "Collaborator",
    color: colorFor(session.user.memberId),
    path,
    activeField: activeFieldRef.current,
    onlineAt: new Date().toISOString(),
  } : null, [path, session]);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase || !me || !session || !isRealtimeEnabled()) {
      if (me) setConnection("offline");
      return;
    }
    let channel: RealtimeChannel | null = supabase.channel(`careeros:${session.workspace.id}`, { config: { private: true, presence: { key: me.userId } } });
    let lastSent = 0;
    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel?.presenceState<Presence>() ?? {};
        const canonical = Object.values(state).flat().map((item) => canonicalPresence(item, session.members)).filter((item): item is Presence => Boolean(item));
        setPeople(Array.from(new Map(canonical.filter((item) => item.userId !== me.userId).map((item) => [item.userId, item])).values()));
      })
      .on("broadcast", { event: "cursor" }, ({ payload }) => {
        const cursor = canonicalCursor(payload, session.members);
        if (cursor && cursor.userId !== me.userId) setCursors((current) => ({ ...current, [cursor.userId]: cursor }));
      })
      .on("broadcast", { event: "workspace-change" }, ({ payload }) => {
        const mutation = payload as WorkspaceMutation;
        const member = session.members.find((item) => item.id === mutation?.userId);
        if (member && member.id !== me.userId) {
          window.dispatchEvent(new CustomEvent("careeros:remote-mutation", { detail: { userId: member.id, path: cleanText(mutation.path, 500), at: cleanText(mutation.at, 40) } satisfies WorkspaceMutation }));
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          setConnection("online");
          await channel?.track({ ...me, activeField: activeFieldRef.current });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setConnection("offline");
        }
      });
    const move = (event: PointerEvent) => {
      const now = Date.now();
      if (now - lastSent < 80) return;
      lastSent = now;
      void channel?.send({ type: "broadcast", event: "cursor", payload: { ...me, activeField: activeFieldRef.current, x: event.clientX / Math.max(window.innerWidth, 1), y: event.clientY / Math.max(window.innerHeight, 1) } satisfies Cursor });
    };
    const focus = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      activeFieldRef.current = target?.getAttribute("aria-label") || target?.getAttribute("name") || target?.id || "";
      void channel?.track({ ...me, activeField: activeFieldRef.current });
    };
    const broadcastMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; at?: string }>).detail;
      void channel?.send({
        type: "broadcast",
        event: "workspace-change",
        payload: { userId: me.userId, path: detail?.path ?? "workspace", at: detail?.at ?? new Date().toISOString() } satisfies WorkspaceMutation,
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("focusin", focus);
    window.addEventListener("careeros:local-mutation", broadcastMutation);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("focusin", focus);
      window.removeEventListener("careeros:local-mutation", broadcastMutation);
      if (channel) void supabase.removeChannel(channel);
      channel = null;
    };
  }, [me, session]);

  if (!me) return null;
  return <>
    <div className={`collaboration-presence collaboration-${connection}`} aria-label={connection === "online" ? `${people.length + 1} people online` : "Live collaboration offline"}>
      <span className="collaboration-state" title={connection === "online" ? "Live collaboration connected" : connection === "connecting" ? "Connecting live collaboration" : "Live collaboration is offline"}>{connection === "online" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}</span>
      <span className="presence-avatar" style={{ background: me.color }} title={`${me.name} (you)`}>{me.name.slice(0, 2).toUpperCase()}</span>
      {people.slice(0, 3).map((person) => <span className="presence-avatar" style={{ background: person.color }} title={`${person.name} · ${person.path}${person.activeField ? ` · ${person.activeField}` : ""}`} key={person.userId}>{person.name.slice(0, 2).toUpperCase()}</span>)}
      {people.length > 3 && <small>+{people.length - 3}</small>}
    </div>
    {Object.values(cursors).map((cursor) => <div className="collaborator-cursor" style={{ left: `${cursor.x * 100}vw`, top: `${cursor.y * 100}vh`, color: cursor.color }} key={cursor.userId} aria-hidden="true"><span /><label>{cursor.name}</label></div>)}
  </>;
}
