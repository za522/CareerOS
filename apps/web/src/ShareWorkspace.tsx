import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, Copy, LoaderCircle, LockKeyhole, Trash2, UserPlus, Users, X } from "lucide-react";
import type { WorkspaceAuditEventRecord, WorkspaceInvitationRecord, WorkspaceSessionRecord } from "@careeros/contracts";
import { client } from "./api";
import { useDialogFocus } from "./useDialogFocus";

export function ShareWorkspace({ onClose }: { onClose: () => void }) {
  const close = useCallback(() => onClose(), [onClose]);
  const panelRef = useDialogFocus<HTMLElement>({ open: true, onClose: close });
  const [session, setSession] = useState<WorkspaceSessionRecord | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memberBusy, setMemberBusy] = useState("");
  const [audit, setAudit] = useState<WorkspaceAuditEventRecord[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitationRecord[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void client.getWorkspaceSession().then(async (nextSession) => {
      const [nextAudit, nextInvitations] = await Promise.all([
        client.listWorkspaceAudit(20),
        nextSession.workspace.role === "owner" ? client.listWorkspaceInvitations() : Promise.resolve([]),
      ]);
      setSession(nextSession); setAudit(nextAudit); setInvitations(nextInvitations);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Sharing could not be loaded."));
  }, []);

  const invite = async () => {
    setBusy(true); setError(""); setInviteUrl("");
    try {
      const created = await client.createWorkspaceInvitation({ email, role });
      setInviteUrl(`${window.location.origin}/#invite=${encodeURIComponent(created.token)}`);
      setEmail("");
      setInvitations(await client.listWorkspaceInvitations());
      setAudit(await client.listWorkspaceAudit(20));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The invitation could not be created."); }
    finally { setBusy(false); }
  };

  const revokeInvitation = async (id: string) => {
    if (!window.confirm("Revoke this pending invitation?")) return;
    setMemberBusy(id); setError("");
    try { setInvitations(await client.revokeWorkspaceInvitation(id)); setAudit(await client.listWorkspaceAudit(20)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invitation could not be revoked."); }
    finally { setMemberBusy(""); }
  };

  const updateMember = async (userId: string, nextRole: "editor" | "viewer") => {
    if (!session) return;
    setMemberBusy(userId); setError("");
    try { setSession({ ...session, members: await client.updateWorkspaceMember(userId, nextRole) }); setAudit(await client.listWorkspaceAudit(20)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Collaborator access could not be changed."); }
    finally { setMemberBusy(""); }
  };

  const removeMember = async (userId: string) => {
    if (!session || !window.confirm("Revoke this collaborator's CareerOS access?")) return;
    setMemberBusy(userId); setError("");
    try { setSession({ ...session, members: await client.removeWorkspaceMember(userId) }); setAudit(await client.listWorkspaceAudit(20)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Collaborator access could not be revoked."); }
    finally { setMemberBusy(""); }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return <div className="overlay share-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><aside ref={panelRef} tabIndex={-1} className="share-panel" role="dialog" aria-modal="true" aria-labelledby="share-workspace-title">
    <header><div><h2 id="share-workspace-title">Share CareerOS</h2></div><button className="icon-button" aria-label="Close sharing" title="Close sharing" onClick={close}><X size={18} /></button></header>
    {!session ? <div className="share-loading"><LoaderCircle className="spin" size={20} /> Loading access...</div> : !session.hosted ? <div className="share-unavailable"><LockKeyhole size={22} /><strong>Hosted sharing is not configured</strong><p>Your local workspace remains private. Add the Supabase and hosted app settings during deployment to enable Google sign-in and invitations.</p></div> : <>
      {session.workspace.role === "owner" && <section className="share-invite"><h3>Invite a collaborator</h3><p>Only this exact Google account will be able to join.</p><label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="dad@example.com" /></label><label><span>Access</span><select aria-label="Invitation access" value={role} onChange={(event) => setRole(event.target.value as "editor" | "viewer")}><option value="editor">Can edit</option><option value="viewer">Can view</option></select></label><button className="primary-button" disabled={busy || !email.trim()} onClick={() => void invite()}>{busy ? <LoaderCircle className="spin" size={15} /> : <UserPlus size={15} />} Create private link</button></section>}
      {inviteUrl && <section className="share-link"><strong>Invitation ready</strong><div><input readOnly value={inviteUrl} aria-label="Private invitation link" /><button className="quiet-button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button></div><small>The link expires in seven days and only works for the invited email.</small></section>}
      {session.workspace.role === "owner" && invitations.length > 0 && <section className="share-members"><h3><Clock3 size={15} /> Pending invitations</h3>{invitations.map((invitation) => <div className="share-member" key={invitation.id}><div className="avatar">{invitation.email.slice(0, 2).toUpperCase()}</div><div><strong>{invitation.email}</strong><span>{invitation.role} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}</span></div><button className="icon-button" aria-label={`Revoke invitation for ${invitation.email}`} title="Revoke invitation" disabled={memberBusy === invitation.id} onClick={() => void revokeInvitation(invitation.id)}>{memberBusy === invitation.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div>)}</section>}
      <section className="share-members"><h3><Users size={15} /> People with access</h3>{session.members.map((member) => <div className="share-member" key={member.id}><div className="avatar">{(member.displayName || member.email).slice(0, 2).toUpperCase()}</div><div><strong>{member.displayName || member.email}</strong><span>{member.email}</span></div>{session.workspace.role === "owner" && member.role !== "owner" ? <div className="share-member-controls"><select aria-label={`Access for ${member.email}`} value={member.role} disabled={memberBusy === member.id} onChange={(event) => void updateMember(member.id, event.target.value as "editor" | "viewer")}><option value="editor">Can edit</option><option value="viewer">Can view</option></select><button className="icon-button" aria-label={`Revoke access for ${member.email}`} title="Revoke access" disabled={memberBusy === member.id} onClick={() => void removeMember(member.id)}>{memberBusy === member.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div> : <small>{member.role}</small>}</div>)}</section>
      {!!audit.length && <section className="share-audit"><h3><Clock3 size={15} /> Recent workspace activity</h3>{audit.slice(0, 10).map((event) => <div key={event.id}><span>{event.summary}</span><small>{event.actorName || event.actorEmail || "CareerOS"} · {new Date(event.createdAt).toLocaleString()}</small></div>)}</section>}
    </>}
    {error && <div className="capture-inline-error" role="alert">{error}</div>}
  </aside></div>;
}
