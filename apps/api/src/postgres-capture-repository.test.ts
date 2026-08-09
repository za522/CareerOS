import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresCaptureRepository } from "./postgres-capture-repository.js";
import type { PostgresCloudDataProvider } from "./postgres/provider.js";

function executor(database:PGlite):QueryExecutor{return{async query<Row extends Record<string,unknown>>(text:string,values:readonly SqlValue[]=[]){const result=await database.query<Row>(text,values as unknown[]);return{rows:result.rows,rowCount:result.rows.length||(result.affectedRows??0)} satisfies QueryResult<Row>;}};}
class TestProvider{
  readonly provider="postgresql" as const;
  constructor(readonly database:PGlite){}
  async transaction<T>(context:WorkspaceContext,work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{await this.database.exec("SET LOCAL ROLE careeros_runtime");await this.database.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)",[context.workspaceId,context.userId,context.authSubject??""]);const result=await work(executor(this.database));await this.database.exec("COMMIT");return result;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async administrativeTransaction<T>(work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{const result=await work(executor(this.database));await this.database.exec("COMMIT");return result;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async close(){}
}

describe("PostgreSQL rapid capture repository",()=>{
  const database=new PGlite(), provider=new TestProvider(database);
  const repository=new PostgresCaptureRepository(provider as unknown as PostgresCloudDataProvider);
  const workspaceId="00000000-0000-4000-8000-000000000001",userId="10000000-0000-4000-8000-000000000001";
  const context={workspaceId,userId,authSubject:"10000000-0000-4000-8000-000000000001"};
  beforeAll(async()=>{for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Capture Test')",[workspaceId]);await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'owner@example.com')",[userId,userId]);await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId]);},30000);
  afterAll(()=>database.close());

  it("durably pages 100 captures and atomically enforces capacity",async()=>{
    const items=Array.from({length:100},(_,index)=>index%2?{kind:"url" as const,url:`https://example.com/jobs/${index}`}:{kind:"text" as const,text:`Role ${index} Company ${index}`});
    await expect(repository.enqueue(context,items)).resolves.toHaveLength(100);
    await expect(repository.enqueue(context,[{kind:"text",text:"overflow"}])).rejects.toThrow(/capacity/i);
    const first=await repository.listPage(context,{limit:40}),second=await repository.listPage(context,{limit:40,cursor:first.nextCursor!}),third=await repository.listPage(context,{limit:40,cursor:second.nextCursor!});
    const ids=[...first.jobs,...second.jobs,...third.jobs].map(job=>job.id);
    expect(ids).toHaveLength(100);expect(new Set(ids).size).toBe(100);expect((await repository.summary(context)).pending).toBe(100);
  });

  it("uses skip-locked claims so concurrent workers never claim one item twice",async()=>{
    const claims=await Promise.all(Array.from({length:12},()=>repository.claimNext()));
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map(item=>item!.id)).size).toBe(12);
    await Promise.all(claims.map(item=>repository.finish(item!.id,item!.leaseToken,"Needs Review",{response:{marker:item!.id}},null)));
  });

  it("recovers an expired worker lease and permits an explicit retry after failure",async()=>{
    const claimed=await repository.claimNext();expect(claimed).not.toBeNull();
    await database.query("UPDATE capture_queue_items SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[claimed!.id]);
    expect(await repository.recoverExpired()).toBe(1);
    const reclaimed=await repository.claimNext();expect(reclaimed?.id).toBe(claimed!.id);
    await repository.finish(reclaimed!.id,reclaimed!.leaseToken,"Failed",null,"temporary failure");
    expect(await repository.retry(context,reclaimed!.id)).toMatchObject({status:"Queued",error:null});
  });

  it("rejects stale concurrent draft updates without losing the winning text",async()=>{
    const id="50000000-0000-4000-8000-000000000005";
    const created=await repository.saveDraft(context,id,{sourceType:"pasted_text",value:"first"});
    expect(created).toMatchObject({revision:1,value:"first"});
    const [winner,stale]=await Promise.all([
      repository.saveDraft(context,id,{sourceType:"pasted_text",value:"winner",expectedRevision:1}),
      repository.saveDraft(context,id,{sourceType:"pasted_text",value:"stale",expectedRevision:1}),
    ]);
    expect([winner,stale].filter(value=>value==="conflict")).toHaveLength(1);
    expect((await repository.getDraft(context,id))?.value).toBe("winner");
  });

  it("turns simultaneous first saves into one durable draft and one conflict",async()=>{
    const id="50000000-0000-4000-8000-000000000006";
    const results=await Promise.all([
      repository.saveDraft(context,id,{sourceType:"pasted_text",value:"first tab"}),
      repository.saveDraft(context,id,{sourceType:"pasted_text",value:"second tab"}),
    ]);
    expect(results.filter(value=>value==="conflict")).toHaveLength(1);
    const stored=await repository.getDraft(context,id);
    expect(["first tab","second tab"]).toContain(stored?.value);
    expect(stored?.revision).toBe(1);
  });

  it("keeps another workspace unable to read or mutate captures",async()=>{
    const otherWorkspace="00000000-0000-4000-8000-000000000002",otherUser="20000000-0000-4000-8000-000000000002";
    await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Other')",[otherWorkspace]);await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'other@example.com')",[otherUser,otherUser]);await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[otherWorkspace,otherUser]);
    const other={workspaceId:otherWorkspace,userId:otherUser,authSubject:otherUser};
    expect((await repository.listPage(other,{limit:100})).jobs).toHaveLength(0);
    const ours=(await repository.listPage(context,{limit:1})).jobs[0]!;
    expect(await repository.get(other,ours.id)).toBeNull();
  });
});
