import { accountExportRows } from './account-export-rows.ts';
import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,parseManualJob,parseManualJobCommand,manualJobSummary,manualJobsDuplicate,type ManualJob,type ManualJobAction } from '@companion/platform-contracts';
import type { OwnedCareerSavedJob } from './career-run-context.ts';
import { manualJobEvidence } from '@companion/career-core';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const unavailable=()=>new ApiError(503,'MANUAL_JOB_STORAGE_UNAVAILABLE','The saved job could not be confirmed.');
const bad=()=>new ApiError(400,'MANUAL_JOB_INPUT_INVALID','Use the original job text and explicit fields.');
const missing=()=>new ApiError(404,'NOT_FOUND','The saved job was not found.');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
interface Receipt {schemaVersion:1;ownerId:string;operationId:string;observationId:string;action:ManualJobAction;commandDigest:string;appliedRevision:number;acceptedAuthVersion:string;createdAt:string;}
/** Private owner records only. No fetch, provider request, agent use or application submission. */
export class ManualJobs {
 private readonly storage:OnboardingStorage;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null){this.storage=new OnboardingStorage(config,legal);}
 private fixed(value:FixedSessionContext){try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw bad();return Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}}
 private async authorize(client:PoolClient,context:FixedSessionContext,signal?:AbortSignal){await authorizeFixedSession(client,context,signal);const row=(await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[context.userId])).rows[0];if(row?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');if(!this.storage.crypto)throw unavailable();signal?.throwIfAborted();return row;}
 private async receipt(client:PoolClient,context:FixedSessionContext,row:any):Promise<Receipt>{try{
  const raw=this.storage.crypto!.openUtf8(row.receipt_ciphertext,{table:'platform_career_job_observation_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:context.userId,revision:row.applied_revision});
  const r=careerRecordObject(JSON.parse(raw),['schemaVersion','ownerId','operationId','observationId','action','commandDigest','appliedRevision','acceptedAuthVersion','createdAt']);
  if(canonical(r)!==raw||r.schemaVersion!==1||r.ownerId!==context.userId||r.operationId!==row.operation_id||r.observationId!==row.observation_id||r.action!==row.action||r.appliedRevision!==row.applied_revision||r.createdAt!==row.created_at.toISOString()||typeof r.commandDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.commandDigest)||typeof r.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion))throw unavailable();return r as unknown as Receipt;
 }catch{throw unavailable();}}
 private async latest(client:PoolClient,context:FixedSessionContext,id:string){const row=(await client.query('SELECT * FROM platform_career_job_observation_operations WHERE user_id=$1 AND observation_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE',[context.userId,id])).rows[0];if(!row)throw unavailable();return this.receipt(client,context,row);}
    private async record(client: PoolClient, context: FixedSessionContext, row: any, known?: Receipt): Promise<Readonly<ManualJob>> {
        try {
            const raw = this.storage.crypto!.openUtf8(row.record_ciphertext, { table: 'platform_career_job_observations', column: 'record_ciphertext', rowId: row.id, ownerId: context.userId, revision: row.revision }), job = parseManualJob(JSON.parse(raw)), latest = known ?? await this.latest(client, context, row.id);
            const evidence = manualJobEvidence(job.jobText);
            if (canonical(job) !== raw || job.id !== row.id || job.ownerId !== context.userId || job.source !== row.source || job.state !== row.state || job.revision !== row.revision || job.observedAt !== row.observed_at.toISOString() || job.checkedAt !== row.checked_at.toISOString() || job.observedAt !== row.created_at.toISOString() || job.observedAt !== row.updated_at.toISOString() || job.lastOperationId !== row.last_operation_id || latest.action !== 'create' || latest.operationId !== job.lastOperationId || latest.appliedRevision !== job.revision || latest.createdAt !== job.observedAt
                || canonical(evidence) !== canonical({ sponsorship: job.sponsorship, sponsorshipEvidence: job.sponsorshipEvidence, evidenceOverflow: job.evidenceOverflow, ruleRevision: job.ruleRevision }))
                throw unavailable();
            return job;
        }
        catch {
            throw unavailable();
        }
    }
 private async row(client:PoolClient,context:FixedSessionContext,id:string){return (await client.query('SELECT * FROM platform_career_job_observations WHERE user_id=$1 AND id=$2 FOR UPDATE',[context.userId,id])).rows[0];}
 async readInTransaction(client:PoolClient,value:FixedSessionContext,key:unknown,signal?:AbortSignal){const context=this.fixed(value);let id:string;try{id=careerRecordId(key);}catch{throw bad();}await this.authorize(client,context,signal);const row=await this.row(client,context,id);if(!row)throw missing();const job=await this.record(client,context,row);await authorizeFixedSession(client,context,signal);return job;}
    /** Complete authenticated metadata, never a page of user-entered body. */
    private async readPreparationAndDailySources(client: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
        const context = this.fixed(value);
        await this.authorize(client, context, signal);
        await this.storage.authorizeSession(client, context, signal);
        const rows = (await client.query('SELECT * FROM platform_career_job_observations WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE', [context.userId])).rows;
        if (rows.length > 500)
            throw unavailable();
        const latestRows = rows.length ? (await client.query(`SELECT o.* FROM platform_career_job_observation_operations o JOIN
   (SELECT observation_id,max(applied_revision) AS revision FROM platform_career_job_observation_operations WHERE user_id=$1 AND observation_id=ANY($2::uuid[]) GROUP BY observation_id) latest
   ON latest.observation_id=o.observation_id AND latest.revision=o.applied_revision WHERE o.user_id=$1 FOR SHARE OF o`, [context.userId, rows.map(r => r.id)])).rows : [];
        const receipts = new Map<string, Receipt>();
        for (const row of latestRows) {
            signal?.throwIfAborted();
            const r = await this.receipt(client, context, row);
            if (receipts.has(r.observationId))
                throw unavailable();
            receipts.set(r.observationId, r);
        }
        const metadata: Readonly<OwnedCareerSavedJob>[] = [];
        const daily = [];
        for (const row of rows) {
            signal?.throwIfAborted();
            const proof = receipts.get(row.id);
            if (!proof)
                throw unavailable();
            const job = await this.record(client, context, row, proof);
            daily.push(Object.freeze({id:job.id,ownerId:context.userId,revision:job.revision,track:job.roleFamily,observedAt:job.observedAt,deadlineAt:job.deadlineAt,deadlineTimeZone:job.deadlineTimeZone,source:job.source}));
            metadata.push(Object.freeze({ ownerId: context.userId, id: job.id, revision: job.revision, state: 'current', source: 'manual', track: job.roleFamily, observedAt: job.observedAt,
                normalSummary: '本人粘贴的岗位 · ' + job.roleFamily + ' · 未核实是否仍开放。' }));
        }
        await authorizeFixedSession(client, context, signal);
        return Object.freeze({preparation:Object.freeze(metadata),daily:Object.freeze(daily)});
    }
    async readForPreparationInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal) { return (await this.readPreparationAndDailySources(client,value,signal)).preparation; }
    /** Verified coordinates/deadlines only. Never promises the job is open. */
    async readForDailyPlanningInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal) { return (await this.readPreparationAndDailySources(client,value,signal)).daily; }

 /** Internal reader for the account-export transaction: the coordinator
  * consumes the fresh password proof and commits before exposing any section. */
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
  const s=this.fixed(value);await this.authorize(client,s,signal);
  for await(const row of accountExportRows(client,s.userId,'platform_career_job_observations',signal)){
   const record=await this.record(client,s,row);yield {section:'savedJobs' as const,record};
  }
  for await(const row of accountExportRows(client,s.userId,'platform_career_job_observation_operations',signal)){
   const r=await this.receipt(client,s,row);yield {section:'savedJobOperations' as const,record:{id:r.operationId,observationId:r.observationId,action:r.action,revision:r.appliedRevision,createdAt:r.createdAt}};
  }
  await authorizeFixedSession(client,s,signal);
 }
 async get(value:FixedSessionContext,key:unknown,signal?:AbortSignal){const context=this.fixed(value);return this.db.withBoundedTransaction(client=>this.readInTransaction(client,context,key,signal));}
 async list(value:FixedSessionContext,query:unknown={},signal?:AbortSignal){const context=this.fixed(value);let after:string|null;try{const q=careerRecordObject(query,[],['after']);after=Object.hasOwn(q,'after')?careerRecordId(q.after):null;}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);let cursor:any=null;if(after){cursor=await this.row(client,context,after);if(!cursor)throw missing();await this.record(client,context,cursor);}
   const rows=(await client.query('SELECT * FROM platform_career_job_observations WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (observed_at,id)<($2::timestamptz,$3::uuid)) ORDER BY observed_at DESC,id DESC LIMIT 51 FOR SHARE',[context.userId,cursor?.observed_at??null,after])).rows;
   const jobs=[];for(const row of rows.slice(0,50)){signal?.throwIfAborted();jobs.push(manualJobSummary(await this.record(client,context,row)));}await authorizeFixedSession(client,context,signal);return Object.freeze({jobs:Object.freeze(jobs),nextAfter:rows.length>50?jobs.at(-1)!.id:null});});
 }
 async duplicates(value:FixedSessionContext,input:unknown,signal?:AbortSignal){const context=this.fixed(value);let command:ReturnType<typeof parseManualJobCommand>;try{command=parseManualJobCommand('create',input);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);const rows=(await client.query('SELECT * FROM platform_career_job_observations WHERE user_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 501 FOR SHARE',[context.userId])).rows;if(rows.length>500)throw unavailable();const jobs=[];for(const row of rows){signal?.throwIfAborted();const job=await this.record(client,context,row);if(manualJobsDuplicate(job,command as Pick<ManualJob,'canonicalUrl'|'employer'|'title'>))jobs.push(manualJobSummary(job));}await authorizeFixedSession(client,context,signal);return Object.freeze({jobs:Object.freeze(jobs)});});
 }
 async mutate(value:FixedSessionContext,action:ManualJobAction,key:unknown,input:unknown,signal?:AbortSignal){const context=this.fixed(value);let command:ReturnType<typeof parseManualJobCommand>,requested:string|null;
  try{command=parseManualJobCommand(action,input);requested=action==='create'?null:careerRecordId(key);}catch{throw bad();}const digest=createHash('sha256').update(canonical({action,observationId:requested,command})).digest('hex');
  return this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),prior=(await client.query('SELECT * FROM platform_career_job_observation_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,command.operationId])).rows[0];
   if(prior){const r=await this.receipt(client,context,prior);if(r.commandDigest!==digest||r.action!==action||requested!==null&&r.observationId!==requested)throw new ApiError(409,'MANUAL_JOB_OPERATION_CONFLICT','The saved-job operation was already used.');const row=await this.row(client,context,r.observationId);let job:Readonly<ManualJob>|null=null;if(row)job=await this.record(client,context,row);else if((await this.latest(client,context,r.observationId)).action!=='delete')throw unavailable();await authorizeFixedSession(client,context,signal);return Object.freeze({job,operation:Object.freeze({id:r.operationId,observationId:r.observationId,appliedRevision:r.appliedRevision,replayed:true})});}
   const id=requested??randomUUID();let base:Readonly<ManualJob>|null=null;
   if(action==='delete'){const row=await this.row(client,context,id);if(!row)throw missing();base=await this.record(client,context,row);if(base.revision!==command.expectedRevision)throw new ApiError(409,'MANUAL_JOB_REVISION_CHANGED','Read the current job before removing it.');}
   else {await this.storage.authorizeSession(client,context,signal);const rows=(await client.query('SELECT * FROM platform_career_job_observations WHERE user_id=$1 FOR SHARE',[context.userId])).rows;if(rows.length>=500)throw new ApiError(409,'MANUAL_JOB_CAPACITY','Remove an old saved job before saving another.');
    if(!command.allowDuplicate)for(const row of rows){signal?.throwIfAborted();const existing=await this.record(client,context,row);if(manualJobsDuplicate(existing,command as Pick<ManualJob,'canonicalUrl'|'employer'|'title'>))throw new ApiError(409,'MANUAL_JOB_DUPLICATE','This job was saved before. Open it, or explicitly confirm a new copy.');}}
   const revision=action==='create'?1:2,at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();let job:Readonly<ManualJob>|null=null;
   if(action==='create'){const {operationId,expectedRevision,allowDuplicate,...fields}=command;job=parseManualJob({...fields,id,ownerId:context.userId,sourceId:id,source:'manual',state:'unknown',...manualJobEvidence(command.jobText!),observedAt:at,checkedAt:at,revision,lastOperationId:command.operationId});}
   const receipt:Receipt={schemaVersion:1,ownerId:context.userId,operationId:command.operationId,observationId:id,action,commandDigest:digest,appliedRevision:revision,acceptedAuthVersion:String(auth.auth_version),createdAt:at};
   const sealed=this.storage.crypto!.sealUtf8(canonical(receipt),{table:'platform_career_job_observation_operations',column:'receipt_ciphertext',rowId:receipt.operationId,ownerId:context.userId,revision});
   await client.query('INSERT INTO platform_career_job_observation_operations(user_id,operation_id,observation_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',[context.userId,command.operationId,id,action,revision,at,sealed]);
   if(job){const cipher=this.storage.crypto!.sealUtf8(canonical(job),{table:'platform_career_job_observations',column:'record_ciphertext',rowId:id,ownerId:context.userId,revision});await client.query("INSERT INTO platform_career_job_observations(id,user_id,source,state,revision,last_operation_id,observed_at,checked_at,created_at,updated_at,record_ciphertext) VALUES($1,$2,'manual','unknown',1,$3,$4,$4,$4,$4,$5)",[id,context.userId,command.operationId,at,cipher]);}
   else await client.query('DELETE FROM platform_career_job_observations WHERE user_id=$1 AND id=$2',[context.userId,id]);
   await authorizeFixedSession(client,context,signal);return Object.freeze({job,operation:Object.freeze({id:command.operationId,observationId:id,appliedRevision:revision,replayed:false})});
  });
 }
}
