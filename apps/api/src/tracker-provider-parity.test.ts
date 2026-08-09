import Database from "better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { jobDraftSchema } from "@careeros/contracts";
import type { CloudDataProvider, QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresTrackerRepository, SqliteTrackerRepository, type TrackerRepository } from "./tracker-repository.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "33333333-3333-4333-8333-333333333333";
const context = { workspaceId: WORKSPACE, userId: USER, authSubject: SUBJECT };
const databases: Array<{ close(): unknown }> = [];
afterEach(async () => { for (const database of databases.splice(0)) await database.close(); });

function draft(title = "Quant Trading Graduate") {
  return jobDraftSchema.parse({ title, companyName: "Example Capital", location: "London", sector: "Finance", roleFamily: "Trading", requiredRequirements: ["Python"], preferredRequirements: ["Markets interest"] });
}

function sqliteRepository() {
  const database = new Database(":memory:"); databases.push(database);
  database.exec(`
    CREATE TABLE companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,snapshot TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE UNIQUE INDEX company_name ON companies(lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE job_postings(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),title TEXT NOT NULL,requisition_id TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',region TEXT NOT NULL DEFAULT '',work_mode TEXT NOT NULL DEFAULT '',employment_type TEXT NOT NULL DEFAULT '',seniority TEXT NOT NULL DEFAULT '',sector TEXT NOT NULL DEFAULT '',role_family TEXT NOT NULL DEFAULT '',division TEXT NOT NULL DEFAULT '',team TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',required_requirements TEXT NOT NULL DEFAULT '[]',preferred_requirements TEXT NOT NULL DEFAULT '[]',process_summary TEXT NOT NULL DEFAULT '',visa_requirements TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',apply_url TEXT NOT NULL DEFAULT '',referral_source TEXT NOT NULL DEFAULT '',recruiter_contact TEXT NOT NULL DEFAULT '',application_deadline TEXT NOT NULL DEFAULT '',posting_date TEXT NOT NULL DEFAULT '',expiry_date TEXT NOT NULL DEFAULT '',last_checked_at TEXT NOT NULL DEFAULT '',posting_state TEXT NOT NULL DEFAULT 'Active',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE applications(id TEXT PRIMARY KEY,job_posting_id TEXT NOT NULL UNIQUE,current_status TEXT NOT NULL DEFAULT 'Saved',applied_at TEXT,priority TEXT NOT NULL DEFAULT 'Medium',next_action TEXT,follow_up_date TEXT,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE application_events(id TEXT PRIMARY KEY,application_id TEXT NOT NULL,type TEXT NOT NULL,status_after TEXT NOT NULL,occurred_at TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,task_type TEXT NOT NULL DEFAULT 'follow_up',priority TEXT NOT NULL DEFAULT 'Medium',due_date TEXT,completed_at TEXT,notes TEXT NOT NULL DEFAULT '',entity_type TEXT,entity_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE salary_estimates(id TEXT PRIMARY KEY,job_posting_id TEXT NOT NULL,estimate_type TEXT,min_amount REAL,max_amount REAL,base_min_amount REAL,base_max_amount REAL,total_comp_min_amount REAL,total_comp_max_amount REAL,currency TEXT,confidence REAL,created_at TEXT,deleted_at TEXT);
  `);
  return new SqliteTrackerRepository(database);
}

function executor(database: PGlite): QueryExecutor { return { async query<Row extends Record<string,unknown>>(text:string,values:readonly SqlValue[]=[]){const result=await database.query<Row>(text,values as unknown[]);return{rows:result.rows,rowCount:result.rows.length||(result.affectedRows??0)} satisfies QueryResult<Row>;} }; }
class PgliteProvider implements CloudDataProvider {
  readonly provider="postgresql" as const;
  constructor(readonly database:PGlite){}
  async transaction<T>(ctx:WorkspaceContext,work:(tx:QueryExecutor)=>Promise<T>){await this.database.exec("BEGIN");try{await this.database.exec("SET LOCAL ROLE careeros_runtime");await this.database.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)",[ctx.workspaceId,ctx.userId,ctx.authSubject??""]);const value=await work(executor(this.database));await this.database.exec("COMMIT");return value;}catch(error){await this.database.exec("ROLLBACK");throw error;}}
  async close(){await this.database.close();}
}
async function postgresRepository(){const database=new PGlite();databases.push(database);for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Parity')",[WORKSPACE]);await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'owner@example.com')",[USER,SUBJECT]);await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[WORKSPACE,USER]);return new PostgresTrackerRepository(new PgliteProvider(database));}

async function exercise(repository:TrackerRepository){const id=await repository.createJob(context,draft());const siblingId=await repository.createJob(context,draft("Sales and Trading Internship"));let jobs=await repository.listJobs(context,{search:"quant"});expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({id,title:"Quant Trading Graduate",companyName:"Example Capital",location:"London",revision:1});expect(await repository.updateJob(context,id,1,{location:"Singapore",companySnapshot:"Global markets firm"})).toBe("updated");expect(await repository.updateJob(context,id,1,{location:"Paris"})).toBe("conflict");jobs=await repository.listJobs(context);expect(jobs.find(job=>job.id===id)).toMatchObject({location:"Singapore",companySnapshot:"Global markets firm",revision:2});if(repository instanceof PostgresTrackerRepository)expect(await repository.updateJob(context,siblingId,1,{companySnapshot:"Silent overwrite"})).toBe("conflict");const task=await repository.createTask(context,id,{title:"Submit application",taskType:"application",priority:"High",dueDate:"2026-08-15",notes:"Check answers"});expect(task).toMatchObject({title:"Submit application",revision:1});const updated=await repository.updateTask(context,String(task.id),1,{completed:true});expect(updated).toMatchObject({revision:2});expect(await repository.updateTask(context,String(task.id),1,{completed:false})).toBe("conflict");const application=await repository.createApplication(context,id,{priority:"High",notes:"Priority role"});expect(application.created).toBe(true);expect((await repository.createApplication(context,id,{})).created).toBe(false);const event=await repository.appendApplicationEvent(context,application.applicationId,{type:"application_submitted",statusAfter:"Applied",occurredAt:"2026-08-09T10:00:00.000Z",note:"Submitted"});expect(event).toMatchObject({statusAfter:"Applied"});await repository.appendApplicationEvent(context,application.applicationId,{type:"application_started",statusAfter:"Reviewing",occurredAt:"2026-08-08T10:00:00.000Z",note:"Backfilled historical event"});expect(await repository.listApplicationEvents(context,application.applicationId)).toHaveLength(3);expect((await repository.listJobs(context)).find(job=>job.id===id)).toMatchObject({applicationStatus:"Applied",appliedAt:"2026-08-09T10:00:00.000Z"});}

describe("tracker provider parity",()=>{
  it("preserves tracker behavior in SQLite local mode",async()=>exercise(sqliteRepository()));
  it("preserves tracker behavior in PostgreSQL hosted mode",async()=>exercise(await postgresRepository()),30000);
  it("invalidates existing job revisions when a newly created role enriches their shared company",async()=>{
    const repository=await postgresRepository();
    const first=await repository.createJob(context,draft());
    await repository.createJob(context,jobDraftSchema.parse({...draft("Research Analyst"),companySnapshot:"Independent markets firm"}));
    const existing=(await repository.listJobs(context)).find(job=>job.id===first);
    expect(existing).toMatchObject({companySnapshot:"Independent markets firm",revision:2});
    await expect(repository.updateJob(context,first,1,{location:"Paris"})).resolves.toBe("conflict");
  },30000);
  it("rolls back the job half when a combined company update conflicts",async()=>{
    const database=new PGlite();databases.push(database);for(const migration of await discoverCloudMigrations())await database.exec(migration.sql);await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Parity')",[WORKSPACE]);await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'owner@example.com')",[USER,SUBJECT]);await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[WORKSPACE,USER]);
    const base=new PgliteProvider(database);
    const provider:CloudDataProvider={provider:"postgresql",close:()=>base.close(),transaction:(ctx,work)=>base.transaction(ctx,tx=>work({query:(text,values)=>text.startsWith("UPDATE companies SET")?Promise.resolve({rows:[],rowCount:0}):tx.query(text,values)}))};
    const repository=new PostgresTrackerRepository(provider);
    const id=await repository.createJob(context,draft());
    expect(await repository.updateJob(context,id,1,{location:"Singapore",companySnapshot:"Should not commit"})).toBe("conflict");
    expect((await repository.listJobs(context)).find(job=>job.id===id)).toMatchObject({location:"London",companySnapshot:"",revision:1});
  },30000);
  it("applies company details to the reassignment target without changing the former company",async()=>{
    const repository=await postgresRepository();
    const first=await repository.createJob(context,draft());
    const formerSibling=await repository.createJob(context,draft("Sales Internship"));
    const target=await repository.createJob(context,jobDraftSchema.parse({...draft("Software Engineer"),companyName:"Target Technology"}));
    const targetCompanyId=String((await repository.listJobs(context)).find(job=>job.id===target)!.companyId);
    expect(await repository.updateJob(context,first,1,{companyId:targetCompanyId,companyName:"Target Technology Ltd",companySnapshot:"New target snapshot"})).toBe("updated");
    const rows=await repository.listJobs(context);
    expect(rows.find(job=>job.id===first)).toMatchObject({companyId:targetCompanyId,companyName:"Target Technology Ltd",companySnapshot:"New target snapshot"});
    expect(rows.find(job=>job.id===target)).toMatchObject({companyName:"Target Technology Ltd",companySnapshot:"New target snapshot",revision:2});
    expect(rows.find(job=>job.id===formerSibling)).toMatchObject({companyName:"Example Capital",companySnapshot:"",revision:1});
  },30000);
});
