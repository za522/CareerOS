import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { jobDraftSchema, type ImportDraftResponse, type JobDraft } from "@careeros/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresCaptureRepository } from "./postgres-capture-repository.js";
import type { PostgresCloudDataProvider } from "./postgres/provider.js";

function executor(database:PGlite):QueryExecutor{return{async query<Row extends Record<string,unknown>>(text:string,values:readonly SqlValue[]=[]){const result=await database.query<Row>(text,values as unknown[]);return{rows:result.rows,rowCount:result.rows.length||(result.affectedRows??0)} satisfies QueryResult<Row>;}};}
class Provider{
  readonly provider="postgresql" as const;
  constructor(readonly database:PGlite){}
  async transaction<T>(context:WorkspaceContext,work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{await this.database.exec("SET LOCAL ROLE careeros_runtime");await this.database.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)",[context.workspaceId,context.userId,context.authSubject??""]);const result=await work(executor(this.database));await this.database.exec("COMMIT");return result;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async administrativeTransaction<T>(work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{const result=await work(executor(this.database));await this.database.exec("COMMIT");return result;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async close(){await this.database.close();}
}

const workspaceId="00000000-0000-4000-8000-000000000011",userId="10000000-0000-4000-8000-000000000011";
const context={workspaceId,userId,authSubject:userId};
const draft=():JobDraft=>jobDraftSchema.parse({title:"Quant Trading Graduate",companyName:"Example Capital",location:"London",sourceUrl:"https://example.com/jobs/quant",applyUrl:"https://example.com/jobs/quant/apply",requiredRequirements:["Python"]});

describe("PostgreSQL capture crash and duplicate safety",()=>{
  let database:PGlite,repository:PostgresCaptureRepository;
  beforeEach(async()=>{database=new PGlite();for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Reliability')",[workspaceId]);await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'owner@example.com')",[userId,userId]);await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId]);repository=new PostgresCaptureRepository(new Provider(database) as unknown as PostgresCloudDataProvider);},30000);
  afterEach(()=>database.close());

  async function reviewed(value=draft(),status:"Needs Review"|"Duplicate"="Needs Review",duplicates:ImportDraftResponse["duplicates"]=[]){
    const [queued]=await repository.enqueue(context,[{kind:"text",text:`${value.title} at ${value.companyName} in ${value.location}`}]);
    const claim=await repository.claimNext();expect(claim?.id).toBe(queued!.id);
    const importId=randomUUID();
    const response:ImportDraftResponse={importRun:{id:importId,state:"Needs Review",sourceType:"pasted_text",sourceUrl:null,error:null},draft:value,duplicates,enrichment:{mode:"deterministic",provider:null,model:null,warning:null,evidenceCount:1,aiRunId:null,durationMs:1,totalDurationMs:1},fieldEvidence:[{fieldPath:"title",excerpt:value.title,confidence:0.8,method:"deterministic"}]};
    await repository.createImport(claim!,{sourceType:"pasted_text",url:null,rawText:`${value.title} at ${value.companyName}`,contentHash:randomUUID(),metadata:{}},response,[{fieldPath:"title",excerpt:value.title,suggestedValue:value.title,confidence:0.8,method:"deterministic"}]);
    await repository.finish(claim!.id,claim!.leaseToken,status,{response},null);
    return {id:claim!.id,importId,response};
  }

  it("removes uncommitted import artifacts before reclaiming an expired lease",async()=>{
    const [queued]=await repository.enqueue(context,[{kind:"text",text:"Engineer at Example"}]);
    const claim=await repository.claimNext();expect(claim?.id).toBe(queued!.id);
    const importId=randomUUID(),value=draft();
    const response={importRun:{id:importId,state:"Needs Review" as const,sourceType:"pasted_text",sourceUrl:null,error:null},draft:value,duplicates:[],enrichment:{mode:"deterministic" as const,provider:null,model:null,warning:null,evidenceCount:1,aiRunId:null,durationMs:1,totalDurationMs:1},fieldEvidence:[]};
    await repository.createImport(claim!,{sourceType:"pasted_text",url:null,rawText:value.title,contentHash:randomUUID(),metadata:{}},response,[{fieldPath:"title",excerpt:value.title,suggestedValue:value.title,confidence:0.8,method:"deterministic"}]);
    await database.query("UPDATE capture_queue_items SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[claim!.id]);
    expect(await repository.recoverExpired()).toBe(1);
    expect((await database.query("SELECT id FROM import_runs WHERE id=$1",[importId])).rows).toHaveLength(0);
    expect((await database.query("SELECT id FROM field_evidence WHERE entity_id=$1",[importId])).rows).toHaveLength(0);
    expect((await database.query("SELECT id FROM source_documents WHERE workspace_id=$1",[workspaceId])).rows).toHaveLength(1);
    expect(await repository.get(context,claim!.id)).toMatchObject({status:"Queued",result:null});
  },30000);

  it("quarantines a queued capture with no creator without blocking later work",async()=>{
    const malformedId=randomUUID();
    await database.query(`INSERT INTO capture_queue_items(id,workspace_id,created_by_user_id,source_type,raw_text,state,progress,attempt_count,created_at,updated_at,revision)
      VALUES($1,$2,NULL,'pasted_text','Orphaned capture','Queued',0,0,'2000-01-01T00:00:00Z','2000-01-01T00:00:00Z',1)`,[malformedId,workspaceId]);
    const [valid]=await repository.enqueue(context,[{kind:"text",text:"Valid later role"}]);
    const claim=await repository.claimNext();
    expect(claim?.id).toBe(valid!.id);
    expect(await repository.get(context,malformedId)).toMatchObject({status:"Failed",error:expect.stringMatching(/creator identity/i)});
  },30000);

  it("assigns the active member when retrying a creatorless capture",async()=>{
    const malformedId=randomUUID();
    await database.query(`INSERT INTO capture_queue_items(id,workspace_id,created_by_user_id,source_type,raw_text,state,progress,attempt_count,created_at,updated_at,revision)
      VALUES($1,$2,NULL,'pasted_text','Orphaned capture','Queued',0,0,now(),now(),1)`,[malformedId,workspaceId]);
    expect(await repository.claimNext()).toBeNull();
    expect(await repository.retry(context,malformedId)).toMatchObject({status:"Queued"});
    const claim=await repository.claimNext();
    expect(claim).toMatchObject({id:malformedId,userId});
  },30000);

  it("requeues an owned active lease immediately on graceful release",async()=>{
    const [queued]=await repository.enqueue(context,[{kind:"text",text:"Interrupted role"}]);
    const claim=await repository.claimNext();
    expect(claim?.id).toBe(queued!.id);
    expect(await repository.releaseClaim(claim!.id,claim!.leaseToken)).toBe(true);
    expect(await repository.get(context,claim!.id)).toMatchObject({status:"Queued",progressMessage:"Resuming interrupted capture"});
  },30000);

  it("removes abandoned import evidence before retrying a failed capture",async()=>{
    const item=await reviewed();
    await database.query("UPDATE capture_queue_items SET state='Failed',error='late failure' WHERE id=$1",[item.id]);
    const source=(await database.query<{source_document_id:string}>("SELECT source_document_id FROM import_runs WHERE id=$1",[item.importId])).rows[0]!.source_document_id;
    expect(await repository.retry(context,item.id)).toMatchObject({status:"Queued",result:null,error:null});
    expect((await database.query("SELECT id FROM import_runs WHERE id=$1",[item.importId])).rows).toHaveLength(0);
    expect((await database.query("SELECT id FROM field_evidence WHERE entity_id=$1",[item.importId])).rows).toHaveLength(0);
    expect((await database.query("SELECT id FROM source_documents WHERE id=$1",[source])).rows).toHaveLength(1);
  },30000);

  it("serializes equivalent commits and requires an explicit duplicate decision",async()=>{
    const first=await reviewed(),second=await reviewed();
    await expect(repository.commit(context,[{id:first.id}])).resolves.toHaveLength(1);
    await expect(repository.commit(context,[{id:second.id}])).rejects.toMatchObject({duplicates:[expect.objectContaining({title:"Quant Trading Graduate"})]});
    expect(Number((await database.query<{count:number}>("SELECT count(*)::int AS count FROM job_postings WHERE workspace_id=$1",[workspaceId])).rows[0]?.count)).toBe(1);
  },30000);

  it("copies reviewed evidence when linking a capture to an existing posting",async()=>{
    const first=await reviewed();const [saved]=await repository.commit(context,[{id:first.id}]);
    const second=await reviewed();await repository.commit(context,[{id:second.id,duplicateAction:"link_existing",existingJobPostingId:String(saved!.id)}]);
    expect(Number((await database.query<{count:number}>("SELECT count(*)::int AS count FROM field_evidence WHERE workspace_id=$1 AND entity_type='JobPosting' AND entity_id=$2",[workspaceId,String(saved!.id)])).rows[0]?.count)).toBe(2);
  },30000);

  it("normalizes review date text before writing PostgreSQL date columns",async()=>{
    const value=draft();
    value.postingDate="Reposted 2 weeks ago";
    value.applicationDeadline="12-Aug-2026";
    const item=await reviewed(value);
    const [saved]=await repository.commit(context,[{id:item.id}]);
    const row=(await database.query<{posting_date:string|null;application_deadline:string|null}>("SELECT posting_date::text,application_deadline::text FROM job_postings WHERE id=$1",[String(saved!.id)])).rows[0];
    expect(row).toEqual({posting_date:null,application_deadline:"2026-08-12"});
  },30000);

  it("dismisses a completed queue item without deleting its saved opportunity",async()=>{
    const item=await reviewed();
    const [saved]=await repository.commit(context,[{id:item.id}]);
    expect(await repository.dismiss(context,item.id)).toBe(true);
    expect(await repository.get(context,item.id)).toBeNull();
    expect((await database.query("SELECT id FROM job_postings WHERE id=$1",[String(saved!.id)])).rows).toHaveLength(1);
  },30000);

  it("unsticks a duplicate when its queued match has failed",async()=>{
    const original=await reviewed();
    const duplicate=await reviewed(draft(),"Duplicate",[{id:original.id,title:"Quant Trading Graduate",companyName:"Example Capital",sourceUrl:"",queued:true}]);
    await database.query("UPDATE capture_queue_items SET state='Failed' WHERE id=$1",[original.id]);
    expect(await repository.get(context,duplicate.id)).toMatchObject({status:"Needs Review"});
    const stored=(await repository.get(context,duplicate.id))!.result as {response:ImportDraftResponse};
    expect(stored.response.duplicates).toHaveLength(0);
  },30000);

  it("unsticks stale duplicates in paginated queue results",async()=>{
    const original=await reviewed();
    const duplicate=await reviewed(draft(),"Duplicate",[{id:original.id,title:"Quant Trading Graduate",companyName:"Example Capital",sourceUrl:"",queued:true}]);
    await database.query("UPDATE capture_queue_items SET state='Failed' WHERE id=$1",[original.id]);
    const listed=(await repository.listPage(context,{limit:20})).jobs.find(item=>item.id===duplicate.id);
    expect(listed).toMatchObject({status:"Needs Review"});
  },30000);
});
