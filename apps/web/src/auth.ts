import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { apiBaseUrl } from "./diagnostics";

export type AuthConfig = { hosted: boolean; realtimeEnabled: boolean; supabaseUrl: string; supabaseAnonKey: string; testIdentityEnabled?: boolean };

let client: SupabaseClient | null = null;
let currentSession: Session | null = null;
let realtimeEnabled = false;
let refreshTimer: number | null = null;
const authListeners = new Set<(session: Session | null) => void>();

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createPkceOnlyStorage(storage: BrowserStorage) {
  const isVerifier = (key: string) => key.endsWith("-code-verifier");
  return {
    getItem: (key: string) => isVerifier(key) ? storage.getItem(key) : null,
    setItem: (key: string, value: string) => { if (isVerifier(key)) storage.setItem(key, value); },
    removeItem: (key: string) => { if (isVerifier(key)) storage.removeItem(key); },
  };
}

function setCurrentSession(session: Session | null) {
  currentSession = session;
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  if (session?.access_token) {
    client?.realtime.setAuth(session.access_token);
    const refreshInMs = Math.max(30_000, ((session.expires_at ?? Math.floor(Date.now() / 1_000) + 3_600) * 1_000) - Date.now() - 60_000);
    refreshTimer = window.setTimeout(() => void refreshServerSession(), refreshInMs);
  }
  for (const listener of authListeners) listener(session);
}

async function sessionResponse(response: Response) {
  if (!response.ok) return null;
  const session = await response.json() as Omit<Session, "refresh_token">;
  return { ...session, refresh_token: "" } as Session;
}

async function exchangeServerSession(refreshToken: string) {
  const response = await fetch(`${apiBaseUrl}/api/auth/session/exchange`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const session = await sessionResponse(response);
  if (!session) throw new Error("CareerOS could not secure the Google sign-in session.");
  setCurrentSession(session);
  return session;
}

async function refreshServerSession() {
  const response = await fetch(`${apiBaseUrl}/api/auth/session/refresh`, { method: "POST", credentials: "include" });
  const session = await sessionResponse(response);
  setCurrentSession(session);
  return session;
}

export async function loadAuthConfig(): Promise<AuthConfig> {
  const response = await fetch(`${apiBaseUrl}/api/auth/config`);
  if (!response.ok) throw new Error("CareerOS could not load sharing configuration.");
  const config = await response.json() as AuthConfig;
  realtimeEnabled = config.realtimeEnabled;
  if (config.testIdentityEnabled) {
    if (!/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) throw new Error("Test identity mode is only available on localhost.");
    const identity = new URLSearchParams(window.location.search).get("__e2eUser") || "owner";
    if (!["owner", "editor", "viewer", "uninvited"].includes(identity)) throw new Error("Unknown browser test identity.");
    setCurrentSession({
      access_token: identity,
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: "",
      user: { id: identity, aud: "authenticated", role: "authenticated", email: `${identity}@example.com`, app_metadata: { provider: "google" }, user_metadata: {}, created_at: new Date().toISOString() },
    } as Session);
    return config;
  }
  if (config.hosted && !client) {
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        storage: createPkceOnlyStorage(window.sessionStorage),
        autoRefreshToken: false,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    });
    const session = await client.auth.getSession();
    if (session.data.session?.refresh_token) await exchangeServerSession(session.data.session.refresh_token);
    else await refreshServerSession().catch(() => null);
    client.auth.onAuthStateChange((_event, next) => {
      if (next?.refresh_token && next.access_token !== currentSession?.access_token) void exchangeServerSession(next.refresh_token).catch(() => setCurrentSession(null));
    });
  }
  return config;
}

export function getAccessToken() {
  return currentSession?.access_token ?? "";
}

export function getCurrentSession() {
  return currentSession;
}

export function getSupabaseClient() {
  return client;
}

export function isRealtimeEnabled() {
  return realtimeEnabled;
}

export async function signInWithGoogle() {
  if (!client) throw new Error("Hosted Google sign-in is not configured.");
  const redirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  if (error) throw error;
}

export async function signOut() {
  await fetch(`${apiBaseUrl}/api/auth/session/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
  if (client) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  setCurrentSession(null);
  window.location.reload();
}

export function onAuthChange(callback: (session: Session | null) => void) {
  authListeners.add(callback);
  return () => authListeners.delete(callback);
}
