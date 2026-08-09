import { useEffect, useState } from "react";
import { LoaderCircle, MessageSquare, Send } from "lucide-react";
import type { WorkspaceCommentRecord } from "@careeros/contracts";
import { client } from "./api";

export function WorkspaceComments({ entityType, entityId, targetPath, readOnly = false, onDraftStateChange }: { entityType: string; entityId: string; targetPath: string; readOnly?: boolean; onDraftStateChange?: (dirty: boolean) => void }) {
  const [comments, setComments] = useState<WorkspaceCommentRecord[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async (quiet = false) => {
    try { setComments(await client.listWorkspaceComments(entityType, entityId)); if (!quiet) setError(""); }
    catch (cause) { if (!quiet) setError(cause instanceof Error ? cause.message : "Comments could not be loaded."); }
  };

  useEffect(() => {
    onDraftStateChange?.(Boolean(body.trim()));
    return () => onDraftStateChange?.(false);
  }, [body, onDraftStateChange]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 4_000);
    const refresh = () => void load(true);
    window.addEventListener("careeros:remote-mutation", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("careeros:remote-mutation", refresh); };
  }, [entityType, entityId]);

  useEffect(() => {
    if (!body.trim()) return;
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [body]);

  const send = async () => {
    const next = body.trim();
    if (!next || busy) return;
    setBusy(true); setError("");
    try {
      await client.createWorkspaceComment({ entityType, entityId, targetPath, body: next });
      setBody("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Comment could not be added."); }
    finally { setBusy(false); }
  };

  const visible = comments.filter((comment) => !targetPath || !comment.targetPath || comment.targetPath === targetPath);
  return <section className="workspace-comments" aria-labelledby="workspace-comments-title">
    <h3 id="workspace-comments-title"><MessageSquare size={14} /> Comments <span>{visible.length}</span></h3>
    <div className="workspace-comment-list">{visible.length ? visible.map((comment) => <article key={comment.id}><header><strong>{comment.authorName || comment.authorEmail || "Collaborator"}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></header><p>{comment.body}</p></article>) : <p className="studio-muted">No comments on this CV yet.</p>}</div>
    {!readOnly && <form onSubmit={(event) => { event.preventDefault(); void send(); }}><label><span>Comment on this CV{body.trim() ? " · Not sent" : ""}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Leave a note for your collaborator..." /></label><button className="primary-button icon-button" type="submit" aria-label="Send comment" title="Send comment" disabled={busy || !body.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}</button></form>}
    {error && <p className="workspace-comment-error" role="alert">{error}</p>}
  </section>;
}
