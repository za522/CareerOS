import { randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyRequest } from "fastify";
import { hashInviteToken, requireUsableInvitation, type AuthenticatedActor, type WorkspaceInvitation, type WorkspaceRole } from "./auth.js";
import { DEFAULT_WORKSPACE_ID, type HostedSession } from "./hosted-auth.js";
import type { QueryExecutor } from "./postgres/contracts.js";
import type { PostgresCloudDataProvider } from "./postgres/provider.js";

type Row = Record<string, unknown>;
type Options = { verifyJwt?: (token: string) => Promise<JWTPayload>; fetch?: typeof fetch; env?: NodeJS.ProcessEnv };
const normalizeUrl = (value: string) => value.trim().replace(/\/+$/, "");
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? "");
const invitation = (row: Row): WorkspaceInvitation => ({ id:String(row.id),workspaceId:String(row.workspace_id),email:String(row.email),role:String(row.role) as "editor"|"viewer",tokenHash:String(row.token_hash),invitedByActorId:String(row.created_by_user_id),createdAt:new Date(iso(row.created_at)),expiresAt:new Date(iso(row.expires_at)),acceptedAt:row.accepted_at?new Date(iso(row.accepted_at)):null,revokedAt:row.revoked_at?new Date(iso(row.revoked_at)):null });

function verifiedMetadata(payload: JWTPayload): Row {
  const app = typeof payload.app_metadata === "object" && payload.app_metadata ? payload.app_metadata as Row : {};
  const providers = Array.isArray(app.providers) ? app.providers.map(String) : [];
  if (app.provider !== "google" && !providers.includes("google")) throw Object.assign(new Error("Sign in with Google to continue."), { statusCode: 403 });
  const user = typeof payload.user_metadata === "object" && payload.user_metadata ? payload.user_metadata as Row : {};
  if (user.email_verified !== true && typeof payload.email_confirmed_at !== "string") throw Object.assign(new Error("Use a verified Google email address."), { statusCode: 403 });
  return user;
}

export class PostgresHostedAuthService {
  readonly enabled = true;
  readonly realtimeEnabled: boolean;
  readonly #url: string;
  readonly #anonKey: string;
  readonly #ownerEmail: string;
  readonly #serviceRoleKey: string;
  readonly #testIdentityEnabled: boolean;
  readonly #verifyJwt: (token: string) => Promise<JWTPayload>;
  readonly #fetch: typeof fetch;
  readonly #realtimeTimeoutMs: number;
  readonly #sessions = new WeakMap<FastifyRequest, HostedSession>();
  #membershipTail: Promise<void> = Promise.resolve();
  #outboxTimer: ReturnType<typeof setInterval> | null = null;
  #outboxDrain: Promise<number> | null = null;

  private constructor(private readonly provider: PostgresCloudDataProvider, options: Options) {
    const env=options.env??process.env;
    this.#url=normalizeUrl(env.SUPABASE_URL??"");this.#anonKey=env.SUPABASE_ANON_KEY?.trim()??"";this.#ownerEmail=env.CAREEROS_OWNER_EMAIL?.trim().toLowerCase()??"";this.#serviceRoleKey=env.SUPABASE_SERVICE_ROLE_KEY?.trim()??"";
    this.#testIdentityEnabled=env.NODE_ENV==="test"&&env.CAREEROS_E2E_AUTH==="1";
    if(!this.#url||!this.#anonKey||!this.#ownerEmail)throw new Error("Hosted CareerOS requires SUPABASE_URL, SUPABASE_ANON_KEY, and CAREEROS_OWNER_EMAIL. Refusing to start without complete authentication configuration.");
    if(env.CAREEROS_REALTIME_ENABLED==="1"&&!this.#serviceRoleKey)throw new Error("Hosted realtime requires SUPABASE_SERVICE_ROLE_KEY.");
    this.realtimeEnabled=env.CAREEROS_REALTIME_ENABLED!=="0"&&Boolean(this.#serviceRoleKey);this.#fetch=options.fetch??globalThis.fetch;
    this.#realtimeTimeoutMs=Math.max(1000,Math.min(30_000,Number(env.CAREEROS_REALTIME_TIMEOUT_MS??8000)||8000));
    if(options.verifyJwt)this.#verifyJwt=options.verifyJwt;else{const jwks=createRemoteJWKSet(new URL(`${this.#url}/auth/v1/.well-known/jwks.json`));this.#verifyJwt=async token=>(await jwtVerify(token,jwks,{issuer:`${this.#url}/auth/v1`,audience:"authenticated"})).payload;}
  }

  static async create(provider: PostgresCloudDataProvider, options: Options={}) { const service=new PostgresHostedAuthService(provider,options);await provider.administrativeTransaction(async tx=>{await tx.query("INSERT INTO workspaces(id,name,created_at,updated_at,revision) VALUES($1,'CareerOS',now(),now(),1) ON CONFLICT(id) DO NOTHING",[DEFAULT_WORKSPACE_ID]);});service.startRealtimeOutbox();return service; }
  config(){return{hosted:true,realtimeEnabled:this.realtimeEnabled,supabaseUrl:this.#url,supabaseAnonKey:this.#anonKey,testIdentityEnabled:this.#testIdentityEnabled};}
  requireSession(request:FastifyRequest){const session=this.#sessions.get(request);if(!session)throw Object.assign(new Error("Authentication is required."),{statusCode:401});return session;}
  requireMembership(request:FastifyRequest,write=false){const session=this.requireSession(request);if(session.userId.startsWith("unpersisted:")||!session.role)throw Object.assign(new Error("This workspace is invitation-only."),{statusCode:403});if(write&&session.role==="viewer")throw Object.assign(new Error("Your workspace access is view-only."),{statusCode:403});return session;}
  requireOwner(request:FastifyRequest){const session=this.requireMembership(request,true);if(session.role!=="owner")throw Object.assign(new Error("Only the workspace owner can invite collaborators."),{statusCode:403});return session;}
  private admin<T>(work:(tx:QueryExecutor)=>Promise<T>){return this.provider.administrativeTransaction(work);}
  private scoped<T>(session:HostedSession,work:(tx:QueryExecutor)=>Promise<T>,readOnly=false){return this.provider.transaction({workspaceId:session.workspaceId,userId:session.userId,authSubject:session.actor.id},work,{readOnly});}

  async authenticate(request:FastifyRequest){
    const header=request.headers.authorization;
    if(!header?.startsWith("Bearer "))throw Object.assign(new Error("Sign in with Google to continue."),{statusCode:401});
    try{
      const payload=await this.#verifyJwt(header.slice(7).trim());
      if(!payload.sub||typeof payload.email!=="string")throw new Error("Missing identity claims.");
      const metadata=verifiedMetadata(payload),actor:AuthenticatedActor={id:payload.sub,email:payload.email.toLowerCase(),provider:"supabase"};
      const state=await this.admin(async tx=>{
        const display=typeof metadata.full_name==="string"?metadata.full_name.slice(0,180):"";
        const avatar=typeof metadata.avatar_url==="string"?metadata.avatar_url.slice(0,2000):"";
        const user=(await tx.query<{id:string;email:string;display_name:string;avatar_url:string}>("SELECT id,email,display_name,avatar_url FROM workspace_users WHERE auth_subject=$1::uuid AND deleted_at IS NULL",[actor.id])).rows[0];
        const invited=(await tx.query("SELECT 1 FROM workspace_invites WHERE workspace_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() LIMIT 1",[DEFAULT_WORKSPACE_ID,actor.email!])).rowCount>0;
        const may=Boolean(user||invited||actor.email===this.#ownerEmail);
        let userId=user?.id??`unpersisted:${actor.id}`;
        let identityChanged=false;
        let membershipCreated=false;
        if(may){
          identityChanged=!user||user.email!==actor.email||user.display_name!==display||user.avatar_url!==avatar;
          if(user&&identityChanged){
            await tx.query("UPDATE workspace_users SET email=$2,display_name=$3,avatar_url=$4,updated_at=now(),revision=revision+1 WHERE id=$1",[user.id,actor.email!,display,avatar]);
          }else if(!user){
            userId=(await tx.query<{id:string}>("INSERT INTO workspace_users(id,auth_subject,email,display_name,avatar_url,created_at,updated_at,revision) VALUES($1,$2::uuid,$3,$4,$5,now(),now(),1) RETURNING id",[randomUUID(),actor.id,actor.email!,display,avatar])).rows[0]!.id;
          }
          if(actor.email===this.#ownerEmail){
            membershipCreated=(await tx.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,'owner',now(),now()) ON CONFLICT(workspace_id,user_id) DO NOTHING",[DEFAULT_WORKSPACE_ID,userId])).rowCount===1;
          }
        }
        const membership=may?(await tx.query<{role:WorkspaceRole}>("SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",[DEFAULT_WORKSPACE_ID,userId])).rows[0]:undefined;
        if(membership&&(identityChanged||membershipCreated||await this.realtimeSyncMissing(tx,DEFAULT_WORKSPACE_ID,userId,"upsert",membership.role,actor)))await this.enqueueRealtime(tx,{workspaceId:DEFAULT_WORKSPACE_ID,userId,actor},"upsert",membership.role);
        return{userId:membership?userId:`unpersisted:${actor.id}`,role:membership?.role??"viewer" as WorkspaceRole};
      });
      const session:HostedSession={hosted:true,actor,userId:state.userId,workspaceId:DEFAULT_WORKSPACE_ID,workspaceName:"CareerOS",role:state.role,identityMetadata:metadata};
      this.#sessions.set(request,session);this.kickRealtimeOutbox();return session;
    }catch(error){if(error instanceof Error&&"statusCode"in error)throw error;throw Object.assign(new Error("Your sign-in session is invalid or expired."),{statusCode:401});}
  }

  async createInvite(request:FastifyRequest,input:{email:string;role:"editor"|"viewer"}){const session=this.requireOwner(request),email=input.email.trim().toLowerCase();if(!email.includes("@"))throw Object.assign(new Error("Enter a valid email address."),{statusCode:400});const token=randomBytes(32).toString("base64url"),id=randomUUID(),expiresAt=new Date(Date.now()+7*86400000).toISOString();await this.admin(async tx=>{await tx.query("INSERT INTO workspace_invites(id,workspace_id,email,role,token_hash,expires_at,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())",[id,session.workspaceId,email,input.role,hashInviteToken(token),expiresAt,session.userId]);await this.writeAudit(tx,session,"invitation.created","WorkspaceInvite",id,`Invited ${email} as ${input.role}`,{email,role:input.role,expiresAt});});return{id,email,role:input.role,token,expiresAt};}
  async invitations(request:FastifyRequest){const s=this.requireOwner(request);return this.admin(async tx=>(await tx.query("SELECT id,email,role,expires_at AS \"expiresAt\",created_at AS \"createdAt\" FROM workspace_invites WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC",[s.workspaceId])).rows);}
  async revokeInvite(request:FastifyRequest,id:string){const s=this.requireOwner(request);await this.admin(async tx=>{const row=(await tx.query<{email:string;role:string}>("UPDATE workspace_invites SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email,role",[id,s.workspaceId])).rows[0];if(!row)throw Object.assign(new Error("That pending invitation was not found."),{statusCode:404});await this.writeAudit(tx,s,"invitation.revoked","WorkspaceInvite",id,`Revoked invitation for ${row.email}`,row);});return this.invitations(request);}
  async stageInvite(token:string){const row=await this.admin(async tx=>(await tx.query("SELECT * FROM workspace_invites WHERE token_hash=$1",[hashInviteToken(token)])).rows[0]);if(!row)throw Object.assign(new Error("This invitation is invalid or unavailable."),{statusCode:403});const invite=invitation(row);if(invite.acceptedAt||invite.revokedAt||invite.expiresAt.getTime()<=Date.now())throw Object.assign(new Error("This invitation is invalid or unavailable."),{statusCode:403});const handle=randomBytes(32).toString("base64url"),expiresAt=new Date(Math.min(invite.expiresAt.getTime(),Date.now()+900000)).toISOString();await this.admin(async tx=>{await tx.query("DELETE FROM workspace_invite_sessions WHERE expires_at<=now()");await tx.query("INSERT INTO workspace_invite_sessions(id_hash,workspace_id,invite_id,expires_at,created_at) VALUES($1,$2,$3,$4,now())",[hashInviteToken(handle),invite.workspaceId,invite.id,expiresAt]);});return handle;}
  async acceptInvite(request:FastifyRequest,token:string){const row=await this.admin(async tx=>(await tx.query("SELECT * FROM workspace_invites WHERE token_hash=$1",[hashInviteToken(token)])).rows[0]);if(!row)throw Object.assign(new Error("This invitation is invalid or unavailable."),{statusCode:403});const invite=invitation(row),s=this.requireSession(request);requireUsableInvitation(invite,{token,email:s.actor.email??"",workspaceId:s.workspaceId});return this.acceptValidated(request,s,invite);}
  async acceptStagedInvite(request:FastifyRequest,handle:string){const row=await this.admin(async tx=>(await tx.query("SELECT wi.* FROM workspace_invite_sessions wis JOIN workspace_invites wi ON wi.workspace_id=wis.workspace_id AND wi.id=wis.invite_id WHERE wis.id_hash=$1 AND wis.expires_at>now()",[hashInviteToken(handle)])).rows[0]);if(!row)throw Object.assign(new Error("This invitation is invalid or unavailable."),{statusCode:403});try{return await this.acceptValidated(request,this.requireSession(request),invitation(row));}finally{await this.admin(tx=>tx.query("DELETE FROM workspace_invite_sessions WHERE id_hash=$1",[hashInviteToken(handle)]).then(()=>undefined));}}
  private async acceptValidated(request:FastifyRequest,session:HostedSession,invite:WorkspaceInvitation){return this.serial(async()=>{if(invite.workspaceId!==session.workspaceId||invite.email.toLowerCase()!==session.actor.email?.toLowerCase()||invite.acceptedAt||invite.revokedAt||invite.expiresAt.getTime()<=Date.now())throw Object.assign(new Error("This invitation is invalid or unavailable."),{statusCode:403});const persisted=await this.admin(async tx=>{let userId=session.userId;if(userId.startsWith("unpersisted:")){const metadata=session.identityMetadata??{};userId=(await tx.query<{id:string}>(`INSERT INTO workspace_users(id,auth_subject,email,display_name,avatar_url,created_at,updated_at,revision) VALUES($1,$2::uuid,$3,$4,$5,now(),now(),1) ON CONFLICT(auth_subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=now() RETURNING id`,[randomUUID(),session.actor.id,session.actor.email??"",typeof metadata.full_name==="string"?metadata.full_name:"",typeof metadata.avatar_url==="string"?metadata.avatar_url:""])).rows[0]!.id;}const accepted=await tx.query("UPDATE workspace_invites SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()",[invite.id]);if(accepted.rowCount!==1)throw Object.assign(new Error("This invitation is no longer available."),{statusCode:409});await tx.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,now(),now()) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,updated_at=now()",[session.workspaceId,userId,invite.role]);const acceptedSession={...session,userId,role:invite.role};await this.enqueueRealtime(tx,acceptedSession,"upsert",invite.role);await this.writeAudit(tx,acceptedSession,"invitation.accepted","WorkspaceInvite",invite.id,`${session.actor.email??"A collaborator"} accepted an ${invite.role} invitation`,{role:invite.role});return acceptedSession;});this.#sessions.set(request,persisted);this.kickRealtimeOutbox();return persisted;});}
  async members(request:FastifyRequest){const s=this.requireMembership(request);return this.scoped(s,async tx=>(await tx.query(`SELECT u.id,u.email,u.display_name AS "displayName",u.avatar_url AS "avatarUrl",m.role,m.created_at AS "joinedAt" FROM workspace_memberships m JOIN workspace_users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at`,[s.workspaceId])).rows,true);}
  private async member(s:HostedSession,userId:string){return this.admin(async tx=>{const r=(await tx.query<{auth_subject:string;email:string;role:WorkspaceRole;workspace_name:string}>("SELECT u.auth_subject::text,u.email,m.role,w.name AS workspace_name FROM workspace_memberships m JOIN workspace_users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.user_id=$2",[s.workspaceId,userId])).rows[0];return r?{hosted:true,actor:{id:r.auth_subject,email:r.email,provider:"supabase"},userId,workspaceId:s.workspaceId,workspaceName:r.workspace_name,role:r.role} as HostedSession:null;});}
  async updateMember(request:FastifyRequest,userId:string,role:"editor"|"viewer"){return this.serial(async()=>{const s=this.requireOwner(request);if(userId===s.userId)throw Object.assign(new Error("The workspace owner cannot demote their own account."),{statusCode:409});const member=await this.member(s,userId);if(!member||member.role==="owner")throw Object.assign(new Error("That collaborator was not found."),{statusCode:404});await this.admin(async tx=>{const result=await tx.query("UPDATE workspace_memberships SET role=$3,updated_at=now() WHERE workspace_id=$1 AND user_id=$2 AND role=$4",[s.workspaceId,userId,role,member.role]);if(result.rowCount!==1)throw Object.assign(new Error("That collaborator changed in another session."),{statusCode:409});await this.enqueueRealtime(tx,member,"upsert",role);await this.writeAudit(tx,s,"membership.role_changed","WorkspaceMembership",userId,`Changed ${member.actor.email} to ${role}`,{previousRole:member.role,role});});this.kickRealtimeOutbox();return this.members(request);});}
  async removeMember(request:FastifyRequest,userId:string){return this.serial(async()=>{
    const s=this.requireOwner(request);
    if(userId===s.userId)throw Object.assign(new Error("The workspace owner cannot remove their own account."),{statusCode:409});
    const member=await this.member(s,userId);
    if(!member||member.role==="owner")throw Object.assign(new Error("That collaborator was not found."),{statusCode:404});
    const startedAt=new Date().toISOString();
    try{
      await this.admin(async tx=>{
        const lockedMembership=(await tx.query<{role:WorkspaceRole}>("SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",[s.workspaceId,userId])).rows[0];
        if(!lockedMembership||lockedMembership.role!==member.role)throw Object.assign(new Error("That collaborator changed in another session."),{statusCode:409});
        if(this.realtimeEnabled){
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`realtime:${member.workspaceId}:${member.userId}`]);
          await this.deliverRealtime(member,"delete",null);
          await tx.query("DELETE FROM realtime_membership_outbox WHERE workspace_id=$1 AND user_id=$2 AND state IN ('Pending','Failed')",[member.workspaceId,member.userId]);
          const outboxId=randomUUID();
          await tx.query("INSERT INTO realtime_membership_outbox(id,workspace_id,user_id,auth_subject,email,operation,role,state,attempts,available_at,delivered_at,created_at,updated_at) VALUES($1,$2,$3,$4::uuid,$5,'delete',NULL,'Delivered',1,now(),now(),now(),now())",[outboxId,member.workspaceId,member.userId,member.actor.id,member.actor.email??""]);
          await this.writeRealtimeAttempt(tx,member.workspaceId,member.userId,outboxId,"delete","Delivered","",startedAt);
        }
        const result=await tx.query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role=$3",[s.workspaceId,userId,member.role]);
        if(result.rowCount!==1)throw Object.assign(new Error("That collaborator changed in another session."),{statusCode:409});
        await this.writeAudit(tx,s,"membership.removed","WorkspaceMembership",userId,`Removed ${member.actor.email} from the workspace`,{previousRole:member.role});
      });
    }catch(error){
      if(this.realtimeEnabled)await this.admin(tx=>this.writeRealtimeAttempt(tx,member.workspaceId,member.userId,null,"delete",error instanceof Error&&/timed out/i.test(error.message)?"TimedOut":"Failed",error instanceof Error?error.message:String(error),startedAt)).catch(()=>undefined);
      throw error;
    }
    return this.members(request);
  });}
  async comments(request:FastifyRequest,entityType:string,entityId:string){const s=this.requireMembership(request);return this.scoped(s,async tx=>(await tx.query(`SELECT c.id,c.entity_type AS "entityType",c.entity_id AS "entityId",c.target_path AS "targetPath",c.body,c.resolved_at AS "resolvedAt",c.created_at AS "createdAt",c.updated_at AS "updatedAt",c.revision,u.id AS "authorId",u.email AS "authorEmail",u.display_name AS "authorName",u.avatar_url AS "authorAvatarUrl" FROM workspace_comments c JOIN workspace_users u ON u.id=c.author_user_id WHERE c.workspace_id=$1 AND c.entity_type=$2 AND c.entity_id=$3 AND c.deleted_at IS NULL ORDER BY c.created_at`,[s.workspaceId,entityType,entityId])).rows,true);}
  async createComment(request:FastifyRequest,input:{entityType:string;entityId:string;targetPath:string;body:string}) {
    const s=this.requireMembership(request,true),body=input.body.trim();
    if(!body||body.length>5000)throw Object.assign(new Error("Write a comment of up to 5,000 characters."),{statusCode:400});
    const targetTables:Record<string,string>={JobPosting:"job_postings",Application:"applications",Document:"documents",DocumentVersion:"document_versions"};
    const targetTable=targetTables[input.entityType];
    if(!targetTable)throw Object.assign(new Error("Choose a supported CareerOS record to comment on."),{statusCode:400});
    const id=randomUUID();
    await this.scoped(s,async tx=>{
      const target=await tx.query(`SELECT 1 FROM ${targetTable} WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,[s.workspaceId,input.entityId]);
      if(target.rowCount!==1)throw Object.assign(new Error("The comment target was not found in this workspace."),{statusCode:404});
      await tx.query("INSERT INTO workspace_comments(id,workspace_id,author_user_id,entity_type,entity_id,target_path,body,created_at,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,now(),now(),1)",[id,s.workspaceId,s.userId,input.entityType,input.entityId.slice(0,160),input.targetPath.slice(0,240),body]);
      await this.writeAudit(tx,s,"comment.created",input.entityType,input.entityId,`Commented on ${input.entityType}`,{commentId:id,targetPath:input.targetPath});
    });
    return (await this.comments(request,input.entityType,input.entityId)).find((c:Row)=>c.id===id);
  }
  async auditEvents(request:FastifyRequest,limit=100){const s=this.requireMembership(request);return this.scoped(s,async tx=>(await tx.query(`SELECT a.id,a.action,a.entity_type AS "entityType",a.entity_id AS "entityId",a.summary,a.created_at AS "createdAt",u.email AS "actorEmail",u.display_name AS "actorName" FROM audit_events a LEFT JOIN workspace_users u ON u.id=a.actor_user_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT $2`,[s.workspaceId,Math.max(1,Math.min(limit,250))])).rows,true);}
  async audit(s:HostedSession,action:string,entityType:string,entityId:string,summary:string,details:Row={}){await this.scoped(s,tx=>this.writeAudit(tx,s,action,entityType,entityId,summary,details));}
  private async writeAudit(tx:QueryExecutor,s:HostedSession,action:string,entityType:string,entityId:string,summary:string,details:Row){await tx.query("INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())",[randomUUID(),s.workspaceId,s.userId,action,entityType,entityId,summary.slice(0,500),JSON.stringify(details)]);}
  private serial<T>(operation:()=>Promise<T>){const run=this.#membershipTail.then(operation,operation);this.#membershipTail=run.then(()=>undefined,()=>undefined);return run;}
  private async realtimeSyncMissing(tx:QueryExecutor,workspaceId:string,userId:string,operation:"upsert"|"delete",role:WorkspaceRole|null,actor?:AuthenticatedActor){
    if(!this.realtimeEnabled)return false;
    const latest=(await tx.query<{operation:string;role:string|null;auth_subject:string;email:string}>("SELECT operation,role,auth_subject::text,email FROM realtime_membership_outbox WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[workspaceId,userId])).rows[0];
    return !latest||latest.operation!==operation||(latest.role??null)!==role||(actor&&latest.auth_subject!==actor.id)||(actor&&latest.email!==(actor.email??""));
  }
  private async enqueueRealtime(tx:QueryExecutor,s:Pick<HostedSession,"workspaceId"|"userId"|"actor">,operation:"upsert"|"delete",role:WorkspaceRole|null){
    if(!this.realtimeEnabled)return;
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`realtime:${s.workspaceId}:${s.userId}`]);
    const latest=(await tx.query<{operation:string;role:string|null;auth_subject:string;email:string}>("SELECT operation,role,auth_subject::text,email FROM realtime_membership_outbox WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[s.workspaceId,s.userId])).rows[0];
    if(latest&&latest.operation===operation&&(latest.role??null)===role&&latest.auth_subject===s.actor.id&&latest.email===(s.actor.email??""))return;
    await tx.query("DELETE FROM realtime_membership_outbox WHERE workspace_id=$1 AND user_id=$2 AND state IN ('Pending','Failed')",[s.workspaceId,s.userId]);
    await tx.query("INSERT INTO realtime_membership_outbox(id,workspace_id,user_id,auth_subject,email,operation,role,state,available_at,created_at,updated_at) VALUES($1,$2,$3,$4::uuid,$5,$6,$7,'Pending',now(),now(),now())",[randomUUID(),s.workspaceId,s.userId,s.actor.id,s.actor.email??"",operation,role]);
  }
  private startRealtimeOutbox(){if(!this.realtimeEnabled||this.#outboxTimer)return;this.#outboxTimer=setInterval(()=>this.kickRealtimeOutbox(),15_000);this.#outboxTimer.unref();this.kickRealtimeOutbox();}
  private kickRealtimeOutbox(){if(!this.realtimeEnabled||this.#outboxDrain)return;this.#outboxDrain=this.drainRealtimeOutbox().catch(()=>0).finally(()=>{this.#outboxDrain=null;});}
  async close(){if(this.#outboxTimer){clearInterval(this.#outboxTimer);this.#outboxTimer=null;}}
  private async fetchRealtime(url:string,init:RequestInit){const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;const expired=new Promise<Response>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new Error(`Realtime request timed out after ${this.#realtimeTimeoutMs}ms.`));},this.#realtimeTimeoutMs);});try{return await Promise.race([this.#fetch(url,{...init,signal:controller.signal}),expired]);}finally{if(timeout)clearTimeout(timeout);}}
  private async writeRealtimeAttempt(tx:QueryExecutor,workspaceId:string,userId:string,outboxId:string|null,operation:"upsert"|"delete",outcome:"Delivered"|"Failed"|"TimedOut",error:string,startedAt:string){await tx.query("INSERT INTO realtime_membership_attempts(id,workspace_id,outbox_id,user_id,operation,outcome,error,started_at,completed_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now())",[randomUUID(),workspaceId,outboxId,userId,operation,outcome,error.slice(0,1000),startedAt]);}
  private async deliverRealtime(item:Pick<HostedSession,"workspaceId"|"userId"|"actor">,operation:"upsert"|"delete",role:WorkspaceRole|null){if(operation==="delete"){const q=new URLSearchParams({workspace_id:`eq.${item.workspaceId}`,user_id:`eq.${item.actor.id}`});const response=await this.fetchRealtime(`${this.#url}/rest/v1/careeros_workspace_members?${q}`,{method:"DELETE",headers:{apikey:this.#serviceRoleKey,authorization:`Bearer ${this.#serviceRoleKey}`,prefer:"return=minimal"}});if(!response.ok)throw new Error(`Realtime delete returned ${response.status}.`);return;}const response=await this.fetchRealtime(`${this.#url}/rest/v1/careeros_workspace_members?on_conflict=workspace_id,user_id`,{method:"POST",headers:{apikey:this.#serviceRoleKey,authorization:`Bearer ${this.#serviceRoleKey}`,"content-type":"application/json",prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{workspace_id:item.workspaceId,user_id:item.actor.id,email:item.actor.email??"",role,updated_at:new Date().toISOString()}])});if(!response.ok)throw new Error(`Realtime upsert returned ${response.status}.`);}
  async drainRealtimeOutbox(limit=20){if(!this.realtimeEnabled)return 0;let delivered=0;for(let index=0;index<Math.max(1,Math.min(limit,100));index+=1){const outcome=await this.admin(async tx=>{await tx.query("UPDATE realtime_membership_outbox SET state='Pending',locked_at=NULL,available_at=now(),updated_at=now() WHERE state='Processing' AND locked_at<now()-interval '5 minutes'");const candidate=(await tx.query<Row>("SELECT id,workspace_id,user_id FROM realtime_membership_outbox WHERE state IN ('Pending','Failed') AND available_at<=now() ORDER BY created_at,id LIMIT 1")).rows[0];if(!candidate)return "empty" as const;const lock=(await tx.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",[`realtime:${String(candidate.workspace_id)}:${String(candidate.user_id)}`])).rows[0]?.locked;if(!lock)return "busy" as const;const item=(await tx.query<Row>("UPDATE realtime_membership_outbox SET state='Processing',attempts=attempts+1,locked_at=now(),updated_at=now() WHERE id=$1 AND state IN ('Pending','Failed') AND available_at<=now() RETURNING *",[String(candidate.id)])).rows[0];if(!item)return "busy" as const;const startedAt=new Date().toISOString();try{await this.deliverRealtime({workspaceId:String(item.workspace_id),userId:String(item.user_id),actor:{id:String(item.auth_subject),email:String(item.email),provider:"supabase"}},String(item.operation) as "upsert"|"delete",item.role as WorkspaceRole|null);await tx.query("UPDATE realtime_membership_outbox SET state='Delivered',delivered_at=now(),locked_at=NULL,last_error='',updated_at=now() WHERE id=$1",[String(item.id)]);await this.writeRealtimeAttempt(tx,String(item.workspace_id),String(item.user_id),String(item.id),String(item.operation) as "upsert"|"delete","Delivered","",startedAt);await tx.query("DELETE FROM realtime_membership_outbox WHERE id IN (SELECT id FROM realtime_membership_outbox WHERE workspace_id=$1 AND user_id=$2 AND state='Delivered' ORDER BY delivered_at DESC NULLS LAST,created_at DESC,id DESC OFFSET 20)",[String(item.workspace_id),String(item.user_id)]);return "delivered" as const;}catch(error){const message=error instanceof Error?error.message:String(error);await tx.query("UPDATE realtime_membership_outbox SET state='Failed',locked_at=NULL,last_error=$2,available_at=now()+make_interval(secs=>LEAST(3600,power(2,LEAST(attempts,10))::int)),updated_at=now() WHERE id=$1",[String(item.id),message.slice(0,1000)]);await this.writeRealtimeAttempt(tx,String(item.workspace_id),String(item.user_id),String(item.id),String(item.operation) as "upsert"|"delete",/timed out/i.test(message)?"TimedOut":"Failed",message,startedAt);return "failed" as const;}});if(outcome==="delivered")delivered+=1;else if(outcome==="empty"||outcome==="busy"||outcome==="failed")break;}
    return delivered;
  }
}
