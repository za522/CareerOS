import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chrome, LoaderCircle, LockKeyhole } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { apiBaseUrl } from "./diagnostics";
import { getAccessToken, getCurrentSession, loadAuthConfig, onAuthChange, signInWithGoogle, type AuthConfig } from "./auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [access, setAccess] = useState<"checking" | "allowed" | "uninvited">("checking");
  const [error, setError] = useState("");
  const invitationStage = useRef<Promise<void> | null>(null);
  const acceptedSession = useRef("");

  useEffect(() => {
    const inviteFromFragment = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invite");
    let cancelled = false;
    let unsubscribe: () => void = () => {};
    if (!invitationStage.current) {
      invitationStage.current = inviteFromFragment
        ? fetch(`${apiBaseUrl}/api/auth/invitations/stage`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: inviteFromFragment }),
        }).then(async (response) => {
          window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
          if (!response.ok) throw new Error((await response.json()).error ?? "Invitation could not be secured for sign-in.");
        })
        : Promise.resolve();
    }
    void invitationStage.current.then(() => loadAuthConfig()).then((next) => {
      if (cancelled) return;
      setConfig(next);
      setSession(getCurrentSession());
      if (!next.hosted) setAccess("allowed");
      unsubscribe = onAuthChange(setSession);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Sharing configuration could not be loaded."); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!config?.hosted || !session) return;
    const sessionKey = `${session.user.id}:${session.access_token}`;
    if (acceptedSession.current === sessionKey) return;
    acceptedSession.current = sessionKey;
    const headers = { authorization: `Bearer ${getAccessToken()}` };
    void fetch(`${apiBaseUrl}/api/auth/invitations/accept`, { method: "POST", credentials: "include", headers }).then(async (accepted) => {
      if (!accepted.ok) throw new Error((await accepted.json()).error ?? "Invitation could not be accepted.");
      const response = await fetch(`${apiBaseUrl}/api/auth/session`, { headers });
      if (response.status === 403) { setAccess("uninvited"); return; }
      if (!response.ok) throw new Error("Your workspace session could not be loaded.");
      setAccess("allowed");
    }).catch((cause) => {
      acceptedSession.current = "";
      setError(cause instanceof Error ? cause.message : "Sign-in could not be completed.");
    });
  }, [config, session]);

  if (error) return <div className="auth-screen"><div className="auth-panel"><LockKeyhole size={24} /><h1>CareerOS could not open</h1><p>{error}</p><button className="quiet-button" onClick={() => window.location.reload()}>Try again</button></div></div>;
  if (!config || access === "checking" && (!config.hosted || session)) return <div className="auth-screen"><LoaderCircle className="spin" size={24} /><span>Opening your workspace...</span></div>;
  if (config.hosted && !session) return <div className="auth-screen"><div className="auth-panel"><div className="auth-mark">C</div><h1>CareerOS</h1><p>Sign in with an invited Google account.</p><button className="primary-button auth-google" onClick={() => void signInWithGoogle().catch((cause) => setError(cause instanceof Error ? cause.message : "Google sign-in failed."))}><Chrome size={17} /> Continue with Google</button></div></div>;
  if (access === "uninvited") return <div className="auth-screen"><div className="auth-panel"><LockKeyhole size={24} /><h1>Invitation required</h1><p>This Google account does not have access to the private CareerOS workspace.</p></div></div>;
  return children;
}
