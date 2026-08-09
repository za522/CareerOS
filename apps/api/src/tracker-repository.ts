import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JobDraft } from "@careeros/contracts";
import type { CloudDataProvider, QueryExecutor, WorkspaceContext } from "./postgres/contracts.js";

export type TrackerContext = WorkspaceContext;
export type TrackerFilters = { status?: string; sector?: string; applied?: string; search?: string };

export interface TrackerRepository {
  listJobs(context: TrackerContext, filters?: TrackerFilters): Promise<Record<string, unknown>[]>;
  getJobDetail(context: TrackerContext, id: string): Promise<Record<string, unknown> | null>;
  metadata(context: TrackerContext): Promise<{ sectors: string[]; locations: string[] }>;
  createJob(context: TrackerContext, draft: JobDraft): Promise<string>;
  updateJob(context: TrackerContext, id: string, expectedRevision: number, changes: Record<string, unknown>): Promise<"updated" | "conflict" | "not_found">;
  listApplicationEvents(context: TrackerContext, applicationId: string): Promise<Record<string, unknown>[]>;
  listTasksForJob(context: TrackerContext, jobPostingId: string): Promise<Record<string, unknown>[]>;
  createTask(context: TrackerContext, jobPostingId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getTask(context: TrackerContext, id: string): Promise<Record<string, unknown> | null>;
  updateTask(context: TrackerContext, id: string, expectedRevision: number, changes: Record<string, unknown>): Promise<Record<string, unknown> | "conflict" | null>;
  createApplication(context: TrackerContext, jobPostingId: string, input: Record<string, unknown>): Promise<{ applicationId: string; created: boolean }>;
  appendApplicationEvent(context: TrackerContext, applicationId: string, input: { type: string; statusAfter: string; occurredAt: string; note: string }): Promise<Record<string, unknown> | null>;
}

const now = () => new Date().toISOString();
const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const dateFields = new Set(["applicationDeadline", "postingDate", "expiryDate", "dueDate", "followUpDate"]);
const jsonFields = new Set(["requiredRequirements", "preferredRequirements"]);
class AtomicTrackerConflict extends Error {}

function jobSelect(where: string) {
  return `SELECT j.*, c.name AS company_name, c.snapshot AS company_snapshot, c.description AS company_description,
    a.id AS application_id, a.current_status AS application_status, a.applied_at, a.next_action,
    s.id AS salary_estimate_id, s.estimate_type AS salary_estimate_type,
    COALESCE(s.base_min_amount,s.min_amount,s.total_comp_min_amount) AS salary_min_amount,
    COALESCE(s.base_max_amount,s.max_amount,s.total_comp_max_amount) AS salary_max_amount,
    s.currency AS salary_currency,s.confidence AS salary_confidence,
    CASE WHEN s.base_min_amount IS NOT NULL OR s.base_max_amount IS NOT NULL THEN 'base'
         WHEN s.min_amount IS NOT NULL OR s.max_amount IS NOT NULL THEN 'range'
         WHEN s.total_comp_min_amount IS NOT NULL OR s.total_comp_max_amount IS NOT NULL THEN 'total' ELSE NULL END AS salary_scope
    FROM job_postings j JOIN companies c ON c.workspace_id=j.workspace_id AND c.id=j.company_id
    LEFT JOIN applications a ON a.workspace_id=j.workspace_id AND a.job_posting_id=j.id AND a.deleted_at IS NULL
    LEFT JOIN salary_estimates s ON s.id=(SELECT candidate.id FROM salary_estimates candidate WHERE candidate.workspace_id=j.workspace_id AND candidate.job_posting_id=j.id AND candidate.deleted_at IS NULL ORDER BY candidate.created_at DESC LIMIT 1)
    WHERE ${where} ORDER BY j.updated_at DESC`;
}

function camelRow(row: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  const dates = new Set(["application_deadline","posting_date","expiry_date","due_date","follow_up_date","source_date","exchange_rate_date"]);
  for (const [key, value] of Object.entries(row)) output[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value instanceof Date ? (dates.has(key) ? value.toISOString().slice(0,10) : value.toISOString()) : value;
  return output;
}

async function writeAudit(tx: QueryExecutor, context: TrackerContext, action: string, entityType: string, entityId: string, summary: string) {
  await tx.query(
    "INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,now())",
    [randomUUID(), context.workspaceId, context.userId, action, entityType, entityId, summary],
  );
}

export class PostgresTrackerRepository implements TrackerRepository {
  constructor(private readonly provider: CloudDataProvider) {}

  private run<T>(context: TrackerContext, work: (tx: QueryExecutor) => Promise<T>, readOnly = false) {
    return this.provider.transaction(context, work, { readOnly });
  }

  async listJobs(context: TrackerContext, filters: TrackerFilters = {}) {
    return this.run(context, async (tx) => {
      const clauses = ["j.workspace_id=$1", "j.deleted_at IS NULL"];
      const values: unknown[] = [context.workspaceId];
      const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
      if (filters.status && filters.status !== "All") add("a.current_status=?", filters.status);
      if (filters.sector && filters.sector !== "All") add("j.sector=?", filters.sector);
      if (filters.applied === "yes") clauses.push("a.applied_at IS NOT NULL");
      if (filters.applied === "no") clauses.push("a.applied_at IS NULL");
      if (filters.search) add("(lower(j.title) LIKE ? OR lower(c.name) LIKE ? OR lower(j.summary) LIKE ? OR lower(j.description) LIKE ?)", `%${filters.search.toLowerCase()}%`);
      if (filters.search) {
        const value = values.at(-1); const parameter = `$${values.length}`;
        clauses[clauses.length - 1] = clauses.at(-1)!.replaceAll("?", parameter); values[values.length - 1] = value;
      }
      const result = await tx.query(jobSelect(clauses.join(" AND ")), values as never[]);
      return result.rows.map(camelRow);
    }, true);
  }

  async metadata(context: TrackerContext) {
    return this.run(context, async (tx) => {
      const result = await tx.query<{ sector: string; location: string }>(
        "SELECT sector,location FROM job_postings WHERE workspace_id=$1 AND deleted_at IS NULL",
        [context.workspaceId],
      );
      return {
        sectors: [...new Set(result.rows.map((row) => row.sector).filter(Boolean))],
        locations: [...new Set(result.rows.map((row) => row.location).filter(Boolean))],
      };
    }, true);
  }

  async getJobDetail(context: TrackerContext, id: string) {
    return this.run(context, async (tx) => {
      const raw = (await tx.query(jobSelect("j.workspace_id=$1 AND j.id=$2 AND j.deleted_at IS NULL"), [context.workspaceId, id])).rows[0];
      if (!raw) return null;
      const row = camelRow(raw);
      const applicationId = row.applicationId ? String(row.applicationId) : null;
      const [events, tasks, evidence, salaries, salaryEvidence] = await Promise.all([
        applicationId ? tx.query("SELECT * FROM application_events WHERE workspace_id=$1 AND application_id=$2 ORDER BY occurred_at,created_at,id", [context.workspaceId, applicationId]) : Promise.resolve({ rows: [], rowCount: 0 }),
        tx.query("SELECT * FROM tasks WHERE workspace_id=$1 AND entity_id=$2 AND deleted_at IS NULL ORDER BY created_at,id", [context.workspaceId, id]),
        tx.query("SELECT * FROM field_evidence WHERE workspace_id=$1 AND entity_type='JobPosting' AND entity_id=$2 ORDER BY captured_at,id", [context.workspaceId, id]),
        tx.query("SELECT * FROM salary_estimates WHERE workspace_id=$1 AND job_posting_id=$2 AND deleted_at IS NULL ORDER BY created_at,id", [context.workspaceId, id]),
        tx.query("SELECT sre.* FROM salary_research_evidence sre JOIN salary_estimates se ON se.workspace_id=sre.workspace_id AND se.id=sre.salary_estimate_id WHERE sre.workspace_id=$1 AND se.job_posting_id=$2 ORDER BY sre.created_at,sre.id", [context.workspaceId, id]),
      ]);
      const salaryEvidenceById = new Map<string, Record<string, unknown>[]>();
      for (const item of salaryEvidence.rows.map(camelRow)) {
        const key = String(item.salaryEstimateId);
        salaryEvidenceById.set(key, [...(salaryEvidenceById.get(key) ?? []), item]);
      }
      return {
        row,
        events: events.rows.map(camelRow),
        tasks: tasks.rows.map(camelRow),
        evidence: evidence.rows.map(camelRow),
        salaries: salaries.rows.map(camelRow).map((salary) => ({ ...salary, evidence: salaryEvidenceById.get(String(salary.id)) ?? [] })),
      };
    }, true);
  }

  async createJob(context: TrackerContext, draft: JobDraft) {
    return this.run(context, async (tx) => {
      const timestamp = now();
      const companyName = draft.companyName.trim() || "Unknown company";
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`company:${context.workspaceId}:${companyName.toLowerCase()}`]);
      const existingCompany = (await tx.query<{ id:string;snapshot:string;description:string }>(
        "SELECT id,snapshot,description FROM companies WHERE workspace_id=$1 AND lower(name)=lower($2) AND deleted_at IS NULL FOR UPDATE",
        [context.workspaceId,companyName],
      )).rows[0];
      let companyId:string;
      if(existingCompany){
        companyId=existingCompany.id;
        const snapshot=existingCompany.snapshot || draft.companySnapshot;
        const description=existingCompany.description || draft.companyDescription;
        const changed=snapshot!==existingCompany.snapshot||description!==existingCompany.description;
        if(changed){
          await tx.query("UPDATE companies SET snapshot=$3,description=$4,updated_at=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2",[context.workspaceId,companyId,snapshot,description,timestamp]);
          await tx.query("UPDATE job_postings SET updated_at=$3,revision=revision+1 WHERE workspace_id=$1 AND company_id=$2 AND deleted_at IS NULL",[context.workspaceId,companyId,timestamp]);
        }
      }else{
        companyId=randomUUID();
        await tx.query("INSERT INTO companies(id,workspace_id,name,snapshot,description,created_at,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,$6,1)",[companyId,context.workspaceId,companyName,draft.companySnapshot,draft.companyDescription,timestamp]);
      }
      const id = randomUUID();
      const columns = ["id","workspace_id","company_id","title","requisition_id","location","country","region","work_mode","employment_type","seniority","sector","role_family","division","team","summary","description","required_requirements","preferred_requirements","process_summary","visa_requirements","source_url","apply_url","referral_source","recruiter_contact","application_deadline","posting_date","expiry_date","last_checked_at","posting_state","notes","created_at","updated_at","revision"];
      const values = [id,context.workspaceId,companyId,draft.title,draft.requisitionId,draft.location,draft.country,draft.region,draft.workMode,draft.employmentType,draft.seniority,draft.sector,draft.roleFamily,draft.division,draft.team,draft.summary,draft.description,JSON.stringify(draft.requiredRequirements),JSON.stringify(draft.preferredRequirements),draft.processSummary,draft.visaRequirements,draft.sourceUrl,draft.applyUrl,draft.referralSource,draft.recruiterContact,draft.applicationDeadline||null,draft.postingDate||null,draft.expiryDate||null,draft.lastCheckedAt||null,draft.postingState,(draft as JobDraft & {notes?:string}).notes??"",timestamp,timestamp,1];
      await tx.query(`INSERT INTO job_postings(${columns.join(",")}) VALUES(${values.map((_,i)=>`$${i+1}`).join(",")})`, values as never[]);
      await writeAudit(tx, context, "job.created", "JobPosting", id, "Added a job posting");
      return id;
    });
  }

  async updateJob(context: TrackerContext, id: string, expectedRevision: number, changes: Record<string, unknown>) {
    try {
      return await this.run(context, async (tx) => {
      const entries = Object.entries(changes).filter(([key,value]) => !["expectedRevision","companyName","companySnapshot","companyDescription"].includes(key) && value !== undefined);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`company-edits:${context.workspaceId}`]);
      const current = await tx.query<{company_id:string;revision:number;company_revision:number}>("SELECT j.company_id,j.revision,c.revision AS company_revision FROM job_postings j JOIN companies c ON c.workspace_id=j.workspace_id AND c.id=j.company_id WHERE j.workspace_id=$1 AND j.id=$2 AND j.deleted_at IS NULL FOR UPDATE OF j,c",[context.workspaceId,id]);
      if (!current.rows[0]) return "not_found" as const;
      if (Number(current.rows[0].revision)!==expectedRevision) return "conflict" as const;
      const companyChanges = Object.entries({name:changes.companyName,snapshot:changes.companySnapshot,description:changes.companyDescription}).filter(([,value])=>value!==undefined);
      let targetCompanyId=current.rows[0].company_id,targetCompanyRevision=current.rows[0].company_revision;
      if(typeof changes.companyId==="string"&&changes.companyId!==targetCompanyId){const target=(await tx.query<{id:string;revision:number}>("SELECT id,revision FROM companies WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",[context.workspaceId,changes.companyId])).rows[0];if(!target)return"not_found" as const;targetCompanyId=target.id;targetCompanyRevision=target.revision;}
      if (!entries.length && !companyChanges.length) return "updated" as const;
      const values: unknown[] = [];
      if(entries.length){const assignments = entries.map(([key,value]) => { values.push(jsonFields.has(key) ? JSON.stringify(value) : dateFields.has(key) && value === "" ? null : value); return `${snake(key)}=$${values.length}`; });values.push(context.workspaceId,id,expectedRevision);const result=await tx.query(`UPDATE job_postings SET ${assignments.join(",")},updated_at=now() WHERE workspace_id=$${values.length-2} AND id=$${values.length-1} AND revision=$${values.length}`,values as never[]);if(result.rowCount!==1)return"conflict" as const;}
      else await tx.query("UPDATE job_postings SET updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$3",[context.workspaceId,id,expectedRevision]);
      if(companyChanges.length){const companyValues:unknown[]=companyChanges.map(([,value])=>String(value??""));companyValues.push(context.workspaceId,targetCompanyId,targetCompanyRevision);const companyResult=await tx.query(`UPDATE companies SET ${companyChanges.map(([key],index)=>`${key}=$${index+1}`).join(",")},updated_at=now() WHERE workspace_id=$${companyValues.length-2} AND id=$${companyValues.length-1} AND revision=$${companyValues.length}`,companyValues as never[]);if(companyResult.rowCount!==1)throw new AtomicTrackerConflict();await tx.query("UPDATE job_postings SET updated_at=now() WHERE workspace_id=$1 AND company_id=$2 AND id<>$3 AND deleted_at IS NULL",[context.workspaceId,targetCompanyId,id]);}
      await writeAudit(tx, context, "job.updated", "JobPosting", id, "Updated a job posting");
      return "updated" as const;
      });
    } catch (error) {
      if (error instanceof AtomicTrackerConflict) return "conflict" as const;
      throw error;
    }
  }

  async listApplicationEvents(context: TrackerContext, applicationId: string) { return this.run(context, async tx => (await tx.query("SELECT * FROM application_events WHERE workspace_id=$1 AND application_id=$2 ORDER BY occurred_at",[context.workspaceId,applicationId])).rows.map(camelRow), true); }
  async listTasksForJob(context: TrackerContext, jobPostingId: string) { return this.run(context, async tx => (await tx.query("SELECT * FROM tasks WHERE workspace_id=$1 AND entity_id=$2 AND deleted_at IS NULL ORDER BY created_at",[context.workspaceId,jobPostingId])).rows.map(camelRow), true); }
  async createTask(context: TrackerContext, jobPostingId: string, input: Record<string, unknown>) { return this.run(context, async tx => { const id=randomUUID(), timestamp=now(); const result=await tx.query(`INSERT INTO tasks(id,workspace_id,title,task_type,priority,due_date,notes,entity_type,entity_id,created_at,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,'JobPosting',$8,$9,$9,1) RETURNING *`,[id,context.workspaceId,String(input.title??""),String(input.taskType??"follow_up"),String(input.priority??"Medium"),input.dueDate?String(input.dueDate):null,String(input.notes??""),jobPostingId,timestamp]); await writeAudit(tx,context,"task.created","Task",id,"Added a follow-up task"); return camelRow(result.rows[0]!); }); }
  async getTask(context: TrackerContext,id:string){ return this.run(context,async tx=>{const row=(await tx.query("SELECT * FROM tasks WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",[context.workspaceId,id])).rows[0]; return row?camelRow(row):null;},true); }
  async updateTask(context:TrackerContext,id:string,expectedRevision:number,changes:Record<string,unknown>){return this.run(context,async tx=>{const updates:Record<string,unknown>={}; if("completed" in changes) updates.completedAt=changes.completed?now():null; for(const key of ["title","taskType","priority","dueDate","notes"]){if(changes[key]!==undefined)updates[key]=changes[key];} const entries=Object.entries(updates); const values:unknown[]=[]; const assignments=entries.map(([key,value])=>{values.push(key==="dueDate"&&value===""?null:value);return `${snake(key)}=$${values.length}`;}); values.push(context.workspaceId,id,expectedRevision); const result=await tx.query(`UPDATE tasks SET ${assignments.join(",")},updated_at=now() WHERE workspace_id=$${values.length-2} AND id=$${values.length-1} AND revision=$${values.length} RETURNING *`,values as never[]); if(result.rows[0]){await writeAudit(tx,context,"task.updated","Task",id,"Updated a follow-up task");return camelRow(result.rows[0]);} const exists=await tx.query("SELECT 1 FROM tasks WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",[context.workspaceId,id]); return exists.rowCount?"conflict":null;});}
  async createApplication(context:TrackerContext,jobPostingId:string,input:Record<string,unknown>){return this.run(context,async tx=>{const existing=await tx.query<{id:string}>("SELECT id FROM applications WHERE workspace_id=$1 AND job_posting_id=$2 AND deleted_at IS NULL",[context.workspaceId,jobPostingId]);if(existing.rows[0])return{applicationId:existing.rows[0].id,created:false};const id=randomUUID(),timestamp=now();await tx.query("INSERT INTO applications(id,workspace_id,job_posting_id,current_status,priority,notes,created_at,updated_at,revision) VALUES($1,$2,$3,'Saved',$4,$5,$6,$6,1)",[id,context.workspaceId,jobPostingId,String(input.priority??"Medium"),String(input.notes??""),timestamp]);await tx.query("INSERT INTO application_events(id,workspace_id,application_id,type,status_after,occurred_at,note,created_at) VALUES($1,$2,$3,'posting_saved','Saved',$4,'Application record created.',$4)",[randomUUID(),context.workspaceId,id,timestamp]);await writeAudit(tx,context,"application.created","Application",id,"Created an application");return{applicationId:id,created:true};});}
  async appendApplicationEvent(context:TrackerContext,applicationId:string,input:{type:string;statusAfter:string;occurredAt:string;note:string}){return this.run(context,async tx=>{const application=(await tx.query<{applied_at:string|Date|null}>("SELECT applied_at FROM applications WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",[context.workspaceId,applicationId])).rows[0];if(!application)return null;const id=randomUUID(),createdAt=now();await tx.query("INSERT INTO application_events(id,workspace_id,application_id,type,status_after,occurred_at,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,context.workspaceId,applicationId,input.type,input.statusAfter,input.occurredAt,input.note,createdAt]);const projected=(await tx.query<{status_after:string;occurred_at:string|Date}>("SELECT status_after,occurred_at FROM application_events WHERE workspace_id=$1 AND application_id=$2 ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1",[context.workspaceId,applicationId])).rows[0]!;const submitted=(await tx.query<{occurred_at:string|Date}>("SELECT occurred_at FROM application_events WHERE workspace_id=$1 AND application_id=$2 AND type='application_submitted' ORDER BY occurred_at LIMIT 1",[context.workspaceId,applicationId])).rows[0];await tx.query("UPDATE applications SET current_status=$3,applied_at=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2",[context.workspaceId,applicationId,projected.status_after,submitted?.occurred_at??null,createdAt]);await writeAudit(tx,context,"application.event_appended","Application",applicationId,"Updated an application");return{id,applicationId,type:input.type,statusAfter:input.statusAfter,occurredAt:input.occurredAt,note:input.note,createdAt};});}
}

export class SqliteTrackerRepository implements TrackerRepository {
  constructor(private readonly sqlite: Database.Database) {}
  async listJobs(_context:TrackerContext,filters:TrackerFilters={}) { const conditions=["j.deleted_at IS NULL"],params:unknown[]=[];if(filters.status&&filters.status!=="All"){conditions.push("a.current_status = ?");params.push(filters.status);}if(filters.sector&&filters.sector!=="All"){conditions.push("j.sector = ?");params.push(filters.sector);}if(filters.applied==="yes")conditions.push("a.applied_at IS NOT NULL");if(filters.applied==="no")conditions.push("a.applied_at IS NULL");if(filters.search){const q=`%${filters.search.toLowerCase()}%`;conditions.push("(lower(j.title) LIKE ? OR lower(c.name) LIKE ? OR lower(j.summary) LIKE ? OR lower(j.description) LIKE ?)");params.push(q,q,q,q);}const query=jobSelect(conditions.join(" AND ")).replace("c.workspace_id=j.workspace_id AND ","").replace("a.workspace_id=j.workspace_id AND ","").replace("candidate.workspace_id=j.workspace_id AND ","");return (this.sqlite.prepare(query).all(...params) as Record<string,unknown>[]).map(camelRow); }
  async metadata(_context:TrackerContext){const rows=this.sqlite.prepare("SELECT sector,location FROM job_postings WHERE deleted_at IS NULL").all() as Array<{sector:string;location:string}>;return{sectors:[...new Set(rows.map(row=>row.sector).filter(Boolean))],locations:[...new Set(rows.map(row=>row.location).filter(Boolean))]};}
  async getJobDetail(context:TrackerContext,id:string){const row=(await this.listJobs(context)).find(item=>item.id===id);if(!row)return null;const applicationId=row.applicationId?String(row.applicationId):null;const events=applicationId?(this.sqlite.prepare("SELECT * FROM application_events WHERE application_id=? ORDER BY occurred_at,created_at,id").all(applicationId) as Record<string,unknown>[]).map(camelRow):[];const tasks=(this.sqlite.prepare("SELECT * FROM tasks WHERE entity_id=? AND deleted_at IS NULL ORDER BY created_at,id").all(id) as Record<string,unknown>[]).map(camelRow);return{row,events,tasks,evidence:[],salaries:[]};}
  async createJob(_context:TrackerContext,draft:JobDraft){const timestamp=now();return this.sqlite.transaction(()=>{let company=this.sqlite.prepare("SELECT id FROM companies WHERE lower(name)=lower(?) AND deleted_at IS NULL").get(draft.companyName) as {id:string}|undefined;if(!company){company={id:randomUUID()};this.sqlite.prepare("INSERT INTO companies(id,name,snapshot,description,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,1)").run(company.id,draft.companyName.trim()||"Unknown company",draft.companySnapshot,draft.companyDescription,timestamp,timestamp);}const id=randomUUID();const columns=["id","company_id","title","requisition_id","location","country","region","work_mode","employment_type","seniority","sector","role_family","division","team","summary","description","required_requirements","preferred_requirements","process_summary","visa_requirements","source_url","apply_url","referral_source","recruiter_contact","application_deadline","posting_date","expiry_date","last_checked_at","posting_state","notes","created_at","updated_at","revision"];const values=[id,company.id,draft.title,draft.requisitionId,draft.location,draft.country,draft.region,draft.workMode,draft.employmentType,draft.seniority,draft.sector,draft.roleFamily,draft.division,draft.team,draft.summary,draft.description,JSON.stringify(draft.requiredRequirements),JSON.stringify(draft.preferredRequirements),draft.processSummary,draft.visaRequirements,draft.sourceUrl,draft.applyUrl,draft.referralSource,draft.recruiterContact,draft.applicationDeadline,draft.postingDate,draft.expiryDate,draft.lastCheckedAt,draft.postingState,(draft as JobDraft&{notes?:string}).notes??"",timestamp,timestamp,1];this.sqlite.prepare(`INSERT INTO job_postings(${columns.join(",")}) VALUES(${values.map(()=>"?").join(",")})`).run(...values);return id;})();}
  async updateJob(_c:TrackerContext,id:string,expectedRevision:number,changes:Record<string,unknown>){return this.sqlite.transaction(()=>{const current=this.sqlite.prepare("SELECT company_id AS companyId,revision FROM job_postings WHERE id=? AND deleted_at IS NULL").get(id)as{companyId:string;revision:number}|undefined;if(!current)return"not_found" as const;if(current.revision!==expectedRevision)return"conflict" as const;const entries=Object.entries(changes).filter(([k,v])=>!['expectedRevision','companyName','companySnapshot','companyDescription'].includes(k)&&v!==undefined);const company=Object.entries({name:changes.companyName,snapshot:changes.companySnapshot,description:changes.companyDescription}).filter(([,v])=>v!==undefined);const timestamp=now();if(entries.length){const values=entries.map(([k,v])=>jsonFields.has(k)?JSON.stringify(v):v);this.sqlite.prepare(`UPDATE job_postings SET ${entries.map(([k])=>`${snake(k)}=?`).join(",")},updated_at=?,revision=revision+1 WHERE id=? AND revision=?`).run(...values,timestamp,id,expectedRevision);}else if(company.length)this.sqlite.prepare("UPDATE job_postings SET updated_at=?,revision=revision+1 WHERE id=? AND revision=?").run(timestamp,id,expectedRevision);if(company.length)this.sqlite.prepare(`UPDATE companies SET ${company.map(([k])=>`${k}=?`).join(',')},updated_at=?,revision=revision+1 WHERE id=?`).run(...company.map(([,v])=>String(v??'')),timestamp,current.companyId);try{const statement=this.sqlite.prepare("INSERT INTO field_evidence(id,entity_type,entity_id,field_path,source_document_id,excerpt,method,suggested_value,confidence,user_confirmed,captured_at) VALUES(?,?,?,?,NULL,'','user_confirmed',?,1,1,?)");for(const[key,value]of entries)statement.run(randomUUID(),"JobPosting",id,key,Array.isArray(value)?JSON.stringify(value):String(value??""),timestamp);}catch(error){if(!(error instanceof Error)||!/no such table/i.test(error.message))throw error;}return"updated" as const;})();}
  async listApplicationEvents(_c:TrackerContext,id:string){return (this.sqlite.prepare("SELECT * FROM application_events WHERE application_id=? ORDER BY occurred_at").all(id) as Record<string,unknown>[]).map(camelRow);}
  async listTasksForJob(_c:TrackerContext,id:string){return (this.sqlite.prepare("SELECT * FROM tasks WHERE entity_id=? AND deleted_at IS NULL ORDER BY created_at").all(id) as Record<string,unknown>[]).map(camelRow);}
  async createTask(_c:TrackerContext,jobId:string,input:Record<string,unknown>){const id=randomUUID(),t=now();this.sqlite.prepare("INSERT INTO tasks(id,title,task_type,priority,due_date,notes,entity_type,entity_id,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,1)").run(id,input.title,input.taskType,input.priority,input.dueDate??"",input.notes??"","JobPosting",jobId,t,t);return camelRow(this.sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string,unknown>);}
  async getTask(_c:TrackerContext,id:string){const row=this.sqlite.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(id) as Record<string,unknown>|undefined;return row?camelRow(row):null;}
  async updateTask(_c:TrackerContext,id:string,rev:number,changes:Record<string,unknown>){const updates:Record<string,unknown>={};if("completed"in changes)updates.completedAt=changes.completed?now():null;for(const k of["title","taskType","priority","dueDate","notes"])if(changes[k]!==undefined)updates[k]=changes[k];const entries=Object.entries(updates);const result=this.sqlite.prepare(`UPDATE tasks SET ${entries.map(([k])=>`${snake(k)}=?`).join(",")},updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL`).run(...entries.map(([,v])=>v),now(),id,rev);if(result.changes)return camelRow(this.sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string,unknown>);return this.sqlite.prepare("SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL").get(id)?"conflict":null;}
  async createApplication(_c:TrackerContext,jobId:string,input:Record<string,unknown>){const existing=this.sqlite.prepare("SELECT id FROM applications WHERE job_posting_id=? AND deleted_at IS NULL").get(jobId)as{id:string}|undefined;if(existing)return{applicationId:existing.id,created:false};const id=randomUUID(),t=now();this.sqlite.transaction(()=>{this.sqlite.prepare("INSERT INTO applications(id,job_posting_id,current_status,priority,notes,created_at,updated_at,revision) VALUES(?,?,'Saved',?,?,?,?,1)").run(id,jobId,input.priority??"Medium",input.notes??"",t,t);this.sqlite.prepare("INSERT INTO application_events(id,application_id,type,status_after,occurred_at,note,created_at) VALUES(?,?,'posting_saved','Saved',?,'Application record created.',?)").run(randomUUID(),id,t,t);})();return{applicationId:id,created:true};}
  async appendApplicationEvent(_c:TrackerContext,appId:string,input:{type:string;statusAfter:string;occurredAt:string;note:string}){const app=this.sqlite.prepare("SELECT id FROM applications WHERE id=? AND deleted_at IS NULL").get(appId)as{id:string}|undefined;if(!app)return null;const id=randomUUID(),t=now();this.sqlite.transaction(()=>{this.sqlite.prepare("INSERT INTO application_events(id,application_id,type,status_after,occurred_at,note,created_at) VALUES(?,?,?,?,?,?,?)").run(id,appId,input.type,input.statusAfter,input.occurredAt,input.note,t);const projected=this.sqlite.prepare("SELECT status_after AS statusAfter FROM application_events WHERE application_id=? ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1").get(appId)as{statusAfter:string};const submitted=this.sqlite.prepare("SELECT occurred_at AS occurredAt FROM application_events WHERE application_id=? AND type='application_submitted' ORDER BY occurred_at LIMIT 1").get(appId)as{occurredAt:string}|undefined;this.sqlite.prepare("UPDATE applications SET current_status=?,applied_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(projected.statusAfter,submitted?.occurredAt??null,t,appId);})();return{id,applicationId:appId,...input,createdAt:t};}
}
