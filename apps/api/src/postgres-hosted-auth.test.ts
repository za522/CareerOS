import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresHostedAuthService } from "./postgres-hosted-auth.js";

function request(token: string) { return { headers: { authorization: `Bearer ${token}` } } as FastifyRequest; }
function executor(database:PGlite):QueryExecutor{return{async query<Row extends Record<string,unknown>>(text:string,values:readonly SqlValue[]=[]){const result=await database.query<Row>(text,values as unknown[]);return{rows:result.rows,rowCount:result.rows.length||(result.affectedRows??0)} satisfies QueryResult<Row>;}};}
class TestProvider {
  readonly provider="postgresql" as const;
  constructor(readonly database:PGlite){}
  async transaction<T>(context:WorkspaceContext,work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{await this.database.exec("SET LOCAL ROLE careeros_runtime");await this.database.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)",[context.workspaceId,context.userId,context.authSubject??""]);const result=await work(executor(this.database));await this.database.exec("COMMIT");return result;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async administrativeTransaction<T>(work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{const result=await work(executor(this.database));await this.database.exec("COMMIT");return result;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async close(){await this.database.close();}
}

const open: PGlite[]=[];
afterEach(async()=>{for(const database of open.splice(0))await database.close();});

describe("PostgreSQL hosted workspace repository",()=>{
  it("persists invited identities, enforces roles, comments, and audit history",async()=>{
    const database=new PGlite();open.push(database);for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);
    const identities={
      owner:{sub:"10000000-0000-4000-8000-000000000001",email:"owner@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true,full_name:"Owner"}},
      editor:{sub:"20000000-0000-4000-8000-000000000002",email:"editor@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true,full_name:"Editor"}},
      outsider:{sub:"30000000-0000-4000-8000-000000000003",email:"outside@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true,full_name:"Outside"}},
    } as const;
    const service=await PostgresHostedAuthService.create(new TestProvider(database) as never,{env:{CAREEROS_HOSTED:"1",SUPABASE_URL:"https://example.supabase.co",SUPABASE_ANON_KEY:"anon",CAREEROS_OWNER_EMAIL:"owner@example.com",CAREEROS_REALTIME_ENABLED:"0"},verifyJwt:async token=>identities[token as keyof typeof identities]});
    const owner=request("owner");await service.authenticate(owner);expect(service.requireOwner(owner).role).toBe("owner");
    const created=await service.createInvite(owner,{email:"editor@example.com",role:"editor"});expect((await service.invitations(owner))).toHaveLength(1);
    const outsider=request("outsider");await service.authenticate(outsider);expect(()=>service.requireMembership(outsider)).toThrow(/invitation-only/i);
    const editor=request("editor");await service.authenticate(editor);await service.acceptInvite(editor,created.token);expect(service.requireMembership(editor,true).role).toBe("editor");
    await database.exec("INSERT INTO companies(id,workspace_id,name) VALUES ('company-1','00000000-0000-4000-8000-000000000001','Example'); INSERT INTO job_postings(id,workspace_id,company_id,title) VALUES ('job-1','00000000-0000-4000-8000-000000000001','company-1','Role');");
    const comment=await service.createComment(editor,{entityType:"JobPosting",entityId:"job-1",targetPath:"notes",body:"Review this role"});expect(comment).toMatchObject({body:"Review this role",authorEmail:"editor@example.com"});
    await expect(service.createComment(editor,{entityType:"JobPosting",entityId:"missing",targetPath:"notes",body:"Orphan"})).rejects.toMatchObject({statusCode:404});
    await expect(service.createComment(editor,{entityType:"Unknown",entityId:"job-1",targetPath:"notes",body:"Invalid"})).rejects.toMatchObject({statusCode:400});
    expect(await service.comments(owner,"JobPosting","job-1")).toHaveLength(1);expect((await service.members(owner)).map((member:Record<string,unknown>)=>member.role)).toEqual(["owner","editor"]);expect((await service.auditEvents(owner)).map((event:Record<string,unknown>)=>event.action)).toEqual(expect.arrayContaining(["invitation.created","invitation.accepted","comment.created"]));
    expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM workspace_users WHERE email='outside@example.com'")).rows[0].count).toBe(0);
    const editorId=(await database.query<{id:string}>("SELECT id FROM workspace_users WHERE email='editor@example.com'")).rows[0].id;
    await service.removeMember(owner,editorId);
    const removed=request("editor");await service.authenticate(removed);expect(()=>service.requireMembership(removed)).toThrow(/invitation-only/i);
  },30000);

  it("commits membership changes with a durable Realtime outbox and reconciles after a network failure",async()=>{
    const database=new PGlite();open.push(database);for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);
    const identities={
      owner:{sub:"10000000-0000-4000-8000-000000000001",email:"owner@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true}},
      editor:{sub:"20000000-0000-4000-8000-000000000002",email:"editor@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true}},
    } as const;
    let available=false;
    const fetchMock=vi.fn(async()=>new Response(null,{status:available?204:503}));
    const service=await PostgresHostedAuthService.create(new TestProvider(database) as never,{env:{CAREEROS_HOSTED:"1",SUPABASE_URL:"https://example.supabase.co",SUPABASE_ANON_KEY:"anon",SUPABASE_SERVICE_ROLE_KEY:"service",CAREEROS_OWNER_EMAIL:"owner@example.com",CAREEROS_REALTIME_ENABLED:"1"},fetch:fetchMock as typeof fetch,verifyJwt:async token=>identities[token as keyof typeof identities]});
    const owner=request("owner");await service.authenticate(owner);const invite=await service.createInvite(owner,{email:"editor@example.com",role:"editor"});
    await vi.waitFor(async()=>expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM realtime_membership_outbox WHERE user_id=(SELECT id FROM workspace_users WHERE email='owner@example.com')")).rows[0]?.count).toBeGreaterThan(0));
    const ownerSyncCount=(await database.query<{count:number}>("SELECT count(*)::int AS count FROM realtime_membership_outbox WHERE user_id=(SELECT id FROM workspace_users WHERE email='owner@example.com')")).rows[0]!.count;
    await service.authenticate(request("owner"));
    expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM realtime_membership_outbox WHERE user_id=(SELECT id FROM workspace_users WHERE email='owner@example.com')")).rows[0]!.count).toBe(ownerSyncCount);
    const editor=request("editor");await service.authenticate(editor);await expect(service.acceptInvite(editor,invite.token)).resolves.toMatchObject({role:"editor"});
    await vi.waitFor(async()=>expect((await database.query<{state:string}>("SELECT state FROM realtime_membership_outbox WHERE user_id=(SELECT id FROM workspace_users WHERE email='editor@example.com') ORDER BY created_at DESC LIMIT 1")).rows[0]?.state).toBe("Failed"));
    expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM workspace_memberships m JOIN workspace_users u ON u.id=m.user_id WHERE u.email='editor@example.com' AND m.role='editor'")).rows[0]?.count).toBe(1);
    available=true;await database.exec("UPDATE realtime_membership_outbox SET available_at=now() WHERE state='Failed'");await service.drainRealtimeOutbox();
    expect((await database.query<{state:string}>("SELECT state FROM realtime_membership_outbox WHERE user_id=(SELECT id FROM workspace_users WHERE email='editor@example.com') ORDER BY created_at DESC LIMIT 1")).rows[0]?.state).toBe("Delivered");
    expect((await database.query<{outcome:string}>("SELECT outcome FROM realtime_membership_attempts WHERE user_id=(SELECT id FROM workspace_users WHERE email='editor@example.com') ORDER BY created_at,id")).rows.map(row=>row.outcome)).toEqual(["Failed","Delivered"]);
    const editorId=(await database.query<{id:string}>("SELECT id FROM workspace_users WHERE email='editor@example.com'")).rows[0].id;
    available=false;
    await expect(service.removeMember(owner,editorId)).rejects.toThrow(/Realtime delete returned 503/);
    expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM workspace_memberships WHERE user_id=$1",[editorId])).rows[0].count).toBe(1);
    available=true;
    await expect(service.removeMember(owner,editorId)).resolves.toEqual(expect.not.arrayContaining([expect.objectContaining({id:editorId})]));
    expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM workspace_memberships WHERE user_id=$1",[editorId])).rows[0].count).toBe(0);
    expect((await database.query<{outcome:string}>("SELECT outcome FROM realtime_membership_attempts WHERE user_id=$1 ORDER BY created_at,id",[editorId])).rows.map(row=>row.outcome)).toEqual(["Failed","Delivered","Failed","Delivered"]);
    await expect(database.exec("UPDATE realtime_membership_attempts SET error='rewritten'")).rejects.toThrow(/immutable/i);
    await service.close();
  },30000);

  it("bounds a stalled Realtime revocation and leaves local access intact",async()=>{
    const database=new PGlite();open.push(database);for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);
    const identities={owner:{sub:"10000000-0000-4000-8000-000000000001",email:"owner@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true}},editor:{sub:"20000000-0000-4000-8000-000000000002",email:"editor@example.com",app_metadata:{provider:"google"},user_metadata:{email_verified:true}}} as const;
    let stall=false;
    const service=await PostgresHostedAuthService.create(new TestProvider(database) as never,{env:{CAREEROS_HOSTED:"1",SUPABASE_URL:"https://example.supabase.co",SUPABASE_ANON_KEY:"anon",SUPABASE_SERVICE_ROLE_KEY:"service",CAREEROS_OWNER_EMAIL:"owner@example.com",CAREEROS_REALTIME_ENABLED:"1",CAREEROS_REALTIME_TIMEOUT_MS:"1000"},fetch:vi.fn(async()=>stall?await new Promise<Response>(()=>undefined):new Response(null,{status:204})) as typeof fetch,verifyJwt:async token=>identities[token as keyof typeof identities]});
    const owner=request("owner");await service.authenticate(owner);const invite=await service.createInvite(owner,{email:"editor@example.com",role:"editor"});const editor=request("editor");await service.authenticate(editor);await service.acceptInvite(editor,invite.token);await vi.waitFor(async()=>expect((await database.query<{state:string}>("SELECT state FROM realtime_membership_outbox WHERE user_id=(SELECT id FROM workspace_users WHERE email='editor@example.com') ORDER BY created_at DESC LIMIT 1")).rows[0]?.state).toBe("Delivered"));
    const editorId=(await database.query<{id:string}>("SELECT id FROM workspace_users WHERE email='editor@example.com'")).rows[0].id;stall=true;const started=Date.now();await expect(service.removeMember(owner,editorId)).rejects.toThrow(/timed out/i);expect(Date.now()-started).toBeLessThan(2500);expect((await database.query<{count:number}>("SELECT count(*)::int AS count FROM workspace_memberships WHERE user_id=$1",[editorId])).rows[0].count).toBe(1);expect((await database.query<{outcome:string}>("SELECT outcome FROM realtime_membership_attempts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[editorId])).rows[0].outcome).toBe("TimedOut");await service.close();
  },30000);
});
