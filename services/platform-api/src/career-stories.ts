import {ProductEvents} from './product-events.ts';
import { todayWeekWindow, type TodayWeekWindow } from '@companion/platform-contracts';
import { accountExportRows } from './account-export-rows.ts';
import type { OwnedCareerEvidence,OwnedCareerInput } from './career-run-context.ts';
import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,parseCareerLibraryCommand,parseCareerProject,parseCareerStory,careerLibrarySummary,type CareerLibraryKind,type CareerLibraryAction,type CareerLibraryRecord,type CareerProject,type CareerStory,type CareerStoryEvidenceAvailability } from '@companion/platform-contracts';
import { type CareerEvidence, careerProgress } from '@companion/career-core';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const tables={project:'platform_career_evidence',story:'platform_career_stories'} as const;
const unavailable=()=>new ApiError(503,'CAREER_LIBRARY_STORAGE_UNAVAILABLE','The saved experience could not be confirmed.');
const bad=()=>new ApiError(400,'CAREER_LIBRARY_INPUT_INVALID','Use explicit experience fields.');
const missing=()=>new ApiError(404,'NOT_FOUND','The saved experience was not found.');
const changed=()=>new ApiError(409,'CAREER_LIBRARY_REVISION_CHANGED','Read the current experience before changing it.');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
interface Receipt {schemaVersion:1;ownerId:string;operationId:string;recordKind:CareerLibraryKind;recordId:string;action:CareerLibraryAction;commandDigest:string;appliedRevision:number;acceptedAuthVersion:string;createdAt:string;}
interface PreparationProofs {latest:Map<string,any>;confirmed:Map<string,any>;withdrawn:Map<string,any>;}
const proofKey=(kind:CareerLibraryKind,id:string)=>kind+':'+id;
/** Owner facts and story decisions only. This does not produce expert proposals,
 * source safety classification, model use, mentor review or execution permission. */
export class CareerStories {
 private readonly storage:OnboardingStorage;
 private readonly productEvents:ProductEvents;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'|'productEventsEnabled'>,legal:LegalBundle|null){this.storage=new OnboardingStorage(config,legal);this.productEvents=new ProductEvents(config);}
 private kind(value:CareerLibraryKind){if(value!=='project'&&value!=='story')throw bad();return value;}
 private fixed(value:FixedSessionContext){try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw bad();return Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}}
 private async authorize(client:PoolClient,context:FixedSessionContext,signal?:AbortSignal){await authorizeFixedSession(client,context,signal);const row=(await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[context.userId])).rows[0];if(row?.account_kind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');if(!this.storage.crypto)throw unavailable();signal?.throwIfAborted();return row;}
 private async receipt(client:PoolClient,context:FixedSessionContext,row:any):Promise<Receipt>{try{
  const raw=this.storage.crypto!.openUtf8(row.receipt_ciphertext,{table:'platform_career_library_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:context.userId,revision:row.applied_revision});
  const r=careerRecordObject(JSON.parse(raw),['schemaVersion','ownerId','operationId','recordKind','recordId','action','commandDigest','appliedRevision','acceptedAuthVersion','createdAt']);
  if(canonical(r)!==raw||r.schemaVersion!==1||r.ownerId!==context.userId||r.operationId!==row.operation_id||r.recordKind!==row.record_kind||r.recordId!==row.record_id||r.action!==row.action||r.appliedRevision!==row.applied_revision||r.createdAt!==row.created_at.toISOString()||typeof r.commandDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.commandDigest)||typeof r.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion))throw unavailable();return r as unknown as Receipt;
 }catch{throw unavailable();}}
 private async latest(client:PoolClient,context:FixedSessionContext,kind:CareerLibraryKind,id:string){const row=(await client.query('SELECT * FROM platform_career_library_operations WHERE user_id=$1 AND record_kind=$2 AND record_id=$3 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE',[context.userId,kind,id])).rows[0];if(!row)throw unavailable();return this.receipt(client,context,row);}
 private async record(client:PoolClient,context:FixedSessionContext,kind:CareerLibraryKind,row:any,proofs?:PreparationProofs):Promise<Readonly<CareerLibraryRecord>>{try{
  const raw=this.storage.crypto!.openUtf8(row.record_ciphertext,{table:tables[kind],column:'record_ciphertext',rowId:row.id,ownerId:context.userId,revision:row.revision}),record=kind==='project'?parseCareerProject(JSON.parse(raw)):parseCareerStory(JSON.parse(raw)),latest=proofs?await this.receipt(client,context,proofs.latest.get(proofKey(kind,row.id))):await this.latest(client,context,kind,row.id);
  if(canonical(record)!==raw||record.id!==row.id||record.ownerId!==context.userId||record.revision!==row.revision||record.createdAt!==row.created_at.toISOString()||record.updatedAt!==row.updated_at.toISOString()||record.sensitivity!==row.sensitivity||record.lastOperationId!==row.last_operation_id||row.record_kind!==kind||latest.action==='delete'||latest.appliedRevision!==record.revision||latest.operationId!==record.lastOperationId||latest.createdAt!==record.updatedAt)throw unavailable();
  if(kind==='project'){const p=record as CareerProject;if(p.kind!==row.kind||p.state!==row.state||p.verification!==row.verification||row.mentor_review!==null)throw unavailable();if(p.state==='active'){if(row.withdrawn_at!==null)throw unavailable();}else{const r=proofs?proofs.withdrawn.get(p.id):(await client.query("SELECT * FROM platform_career_library_operations WHERE user_id=$1 AND record_kind='project' AND record_id=$2 AND action='withdraw' ORDER BY applied_revision DESC LIMIT 1 FOR SHARE",[context.userId,p.id])).rows[0];if(!r)throw unavailable();const withdrawal=await this.receipt(client,context,r);if(withdrawal.appliedRevision>p.revision||withdrawal.createdAt!==row.withdrawn_at?.toISOString())throw unavailable();}}else if((record as CareerStory).status!==row.status)throw unavailable();
  if(record.confirmedRevision!==null){const row=proofs?proofs.confirmed.get(proofKey(kind,record.id)):(await client.query('SELECT * FROM platform_career_library_operations WHERE user_id=$1 AND record_kind=$2 AND record_id=$3 AND applied_revision=$4 FOR SHARE',[context.userId,kind,record.id,record.confirmedRevision])).rows[0];if(!row)throw unavailable();const confirmation=await this.receipt(client,context,row);if(confirmation.action!=='confirm'||confirmation.recordId!==record.id||confirmation.recordKind!==kind||confirmation.appliedRevision!==record.confirmedRevision||confirmation.createdAt!==record.confirmedAt)throw unavailable();}
  return record;
 }catch{throw unavailable();}}
 private async row(client:PoolClient,context:FixedSessionContext,kind:CareerLibraryKind,id:string){return (await client.query('SELECT * FROM '+tables[kind]+' WHERE user_id=$1 AND id=$2 FOR UPDATE',[context.userId,id])).rows[0];}
 private async availability(client:PoolClient,context:FixedSessionContext,story:Readonly<CareerStory>,signal?:AbortSignal):Promise<CareerStoryEvidenceAvailability>{
  let state:CareerStoryEvidenceAvailability='current';
  for(const ref of story.projects){signal?.throwIfAborted();const row=await this.row(client,context,'project',ref.id);if(!row)return 'missing';const p=await this.record(client,context,'project',row) as CareerProject;if(p.state==='withdrawn')return 'withdrawn';if(p.revision!==ref.revision)state='stale';else if(p.verification!=='user_confirmed'&&state==='current')state='unconfirmed';}
  return state;
 }
 private async linked(client:PoolClient,context:FixedSessionContext,story:Readonly<CareerStory>,signal?:AbortSignal){const rank={normal:0,sensitive:1,restricted:2};
  for(const ref of story.projects){signal?.throwIfAborted();const row=await this.row(client,context,'project',ref.id);if(!row)throw missing();const p=await this.record(client,context,'project',row) as CareerProject;
   if(p.revision!==ref.revision||p.state!=='active')throw new ApiError(409,'CAREER_STORY_EVIDENCE_CHANGED','Read the current project facts before linking them.');
   if(p.experienceKind!==story.experienceKind)throw new ApiError(400,'CAREER_STORY_SOURCE_KIND','Keep the actual experience label when linking project facts.');
   if(rank[story.sensitivity]<rank[p.sensitivity])throw new ApiError(400,'CAREER_STORY_SENSITIVITY','The story privacy level must also protect its linked facts.');
  }
 }
 /** Internal reader for the account-export transaction: the coordinator
  * consumes the fresh password proof and commits before exposing any section. */
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
  const s=this.fixed(value);await this.authorize(client,s,signal);
  for await(const row of accountExportRows(client,s.userId,'platform_career_evidence',signal)){
   const record=await this.record(client,s,'project',row);yield {section:'careerProjects' as const,record};
  }
  for await(const row of accountExportRows(client,s.userId,'platform_career_stories',signal)){
   const record=await this.record(client,s,'story',row);yield {section:'careerStories' as const,record};
  }
  for await(const row of accountExportRows(client,s.userId,'platform_career_library_operations',signal)){
   const r=await this.receipt(client,s,row);yield {section:'careerLibraryOperations' as const,record:{id:r.operationId,recordId:r.recordId,recordKind:r.recordKind,action:r.action,revision:r.appliedRevision,createdAt:r.createdAt}};
  }
  await authorizeFixedSession(client,s,signal);
 }
 async get(value:FixedSessionContext,inputKind:CareerLibraryKind,key:unknown,signal?:AbortSignal){const context=this.fixed(value),kind=this.kind(inputKind);let id:string;try{id=careerRecordId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);const row=await this.row(client,context,kind,id);if(!row)throw missing();const record=await this.record(client,context,kind,row),evidenceAvailability=kind==='story'?await this.availability(client,context,record as CareerStory,signal):null;await authorizeFixedSession(client,context,signal);return Object.freeze({record,evidenceAvailability});});}
 /** Read an existing operation without repeating its write. Missing records
  * require a later authenticated delete receipt, never an inferred deletion. */
 async observe(value:FixedSessionContext,inputKind:CareerLibraryKind,key:unknown,signal?:AbortSignal){
  const context=this.fixed(value),kind=this.kind(inputKind);let id:string;try{id=careerRecordId(key);}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{
   await this.authorize(client,context,signal);
   const row=(await client.query('SELECT * FROM platform_career_library_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,id])).rows[0];
   if(!row)throw missing();const receipt=await this.receipt(client,context,row);if(receipt.recordKind!==kind)throw missing();
   const current=await this.row(client,context,kind,receipt.recordId);
   const record=current?await this.record(client,context,kind,current):null;
   if(record){if(record.revision<receipt.appliedRevision)throw unavailable();}
   else {const latest=await this.latest(client,context,kind,receipt.recordId);if(latest.action!=='delete'||latest.appliedRevision<receipt.appliedRevision)throw unavailable();}
   const evidenceAvailability=kind==='story'&&record?await this.availability(client,context,record as CareerStory,signal):null;
   await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
   return Object.freeze({record,evidenceAvailability,operation:Object.freeze({id:receipt.operationId,recordId:receipt.recordId,recordKind:kind,appliedRevision:receipt.appliedRevision,replayed:true})});
  });
 }
 async list(value:FixedSessionContext,inputKind:CareerLibraryKind,query:unknown={},signal?:AbortSignal){const context=this.fixed(value),kind=this.kind(inputKind);let after:string|null;try{const q=careerRecordObject(query,[],['after']);after=Object.hasOwn(q,'after')?careerRecordId(q.after):null;}catch{throw bad();}
  return this.db.withBoundedTransaction(async client=>{await this.authorize(client,context,signal);let cursor:any=null;if(after){cursor=await this.row(client,context,kind,after);if(!cursor)throw missing();await this.record(client,context,kind,cursor);}
   const rows=(await client.query('SELECT * FROM '+tables[kind]+' WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE',[context.userId,cursor?.created_at??null,after])).rows,records=[];
   for(const row of rows.slice(0,50)){signal?.throwIfAborted();const record=await this.record(client,context,kind,row);records.push(Object.freeze({record:careerLibrarySummary(kind,record),evidenceAvailability:kind==='story'?await this.availability(client,context,record as CareerStory,signal):null}));}await authorizeFixedSession(client,context,signal);return Object.freeze({records:Object.freeze(records),nextAfter:rows.length>50?records.at(-1)!.record.id:null});
  });}
 /** Metadata-only internal index. Actual source text has its own classification,
  * speaker privacy and frozen-version gates; these references authorize no read
  * or model request. Authenticated current projects remain distinct from proof. */
 async readPreparationIndexInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
  const context=this.fixed(value);await this.authorize(client,context,signal);await this.storage.authorizeSession(client,context,signal);
  const projectRows=(await client.query('SELECT * FROM platform_career_evidence WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE',[context.userId])).rows;
  const storyRows=(await client.query('SELECT * FROM platform_career_stories WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE',[context.userId])).rows;
  if(projectRows.length>500||storyRows.length>500)throw unavailable();
  // Fetch bounded immutable proofs together; each record still authenticates
  // its own ciphertext, current maximum revision and actual confirmation.
  const kinds:string[]=[],ids:string[]=[],confirmed:number[]=[];
  try{for(const [kind,rows] of [['project',projectRows],['story',storyRows]] as const)for(const row of rows){signal?.throwIfAborted();
   const raw=this.storage.crypto!.openUtf8(row.record_ciphertext,{table:tables[kind],column:'record_ciphertext',rowId:row.id,ownerId:context.userId,revision:row.revision});
   const r=kind==='project'?parseCareerProject(JSON.parse(raw)):parseCareerStory(JSON.parse(raw));kinds.push(kind);ids.push(row.id);confirmed.push(r.confirmedRevision??0);
  }
  }catch(error){signal?.throwIfAborted();throw unavailable();}
  const latest=(await client.query("SELECT o.* FROM unnest($2::text[],$3::uuid[]) c(kind,id) JOIN LATERAL (SELECT operation_id FROM platform_career_library_operations WHERE user_id=$1 AND record_kind=c.kind AND record_id=c.id ORDER BY applied_revision DESC LIMIT 1) chosen ON true JOIN platform_career_library_operations o ON o.user_id=$1 AND o.operation_id=chosen.operation_id FOR SHARE OF o",[context.userId,kinds,ids])).rows;
  const confirmations=(await client.query("SELECT o.* FROM unnest($2::text[],$3::uuid[],$4::int[]) c(kind,id,revision) JOIN platform_career_library_operations o ON o.user_id=$1 AND o.record_kind=c.kind AND o.record_id=c.id AND o.applied_revision=c.revision FOR SHARE OF o",[context.userId,kinds,ids,confirmed])).rows;
  const withdrawals=(await client.query("SELECT o.* FROM unnest($2::uuid[]) c(id) JOIN LATERAL (SELECT operation_id FROM platform_career_library_operations WHERE user_id=$1 AND record_kind='project' AND record_id=c.id AND action='withdraw' ORDER BY applied_revision DESC LIMIT 1) chosen ON true JOIN platform_career_library_operations o ON o.user_id=$1 AND o.operation_id=chosen.operation_id FOR SHARE OF o",[context.userId,projectRows.filter(r=>r.state==='withdrawn').map(r=>r.id)])).rows;
  const proofs:PreparationProofs={latest:new Map(latest.map(r=>[proofKey(r.record_kind,r.record_id),r])),confirmed:new Map(confirmations.map(r=>[proofKey(r.record_kind,r.record_id),r])),withdrawn:new Map(withdrawals.map(r=>[r.record_id,r]))};
  const projects=new Map<string,Readonly<CareerProject>>(),evidence:Readonly<OwnedCareerEvidence>[]=[],stories:Readonly<OwnedCareerInput>[]=[];
  const labels={course_project:'课程项目',independent_project:'独立项目',internship:'实习',employment:'工作经历',volunteering:'志愿经历',other:'其他经历'};
  for(const row of projectRows){
   signal?.throwIfAborted();const p=await this.record(client,context,'project',row,proofs) as Readonly<CareerProject>;projects.set(p.id,p);
   if(p.state!=='active'||p.sensitivity!=='normal')continue;
   evidence.push(Object.freeze({ownerId:context.userId,id:p.id,revision:p.revision,state:'current',kind:'project',normalSummary:'经历类型：'+labels[p.experienceKind]+'；事实状态：'+(p.verification==='user_confirmed'?'本人已确认':'本人填写，待确认')+'。'}));
  }
  for(const row of storyRows){
   signal?.throwIfAborted();const s=await this.record(client,context,'story',row,proofs) as Readonly<CareerStory>;
   if(s.status!=='confirmed'||s.sensitivity!=='normal')continue;
   if(s.projects.some(ref=>{const p=projects.get(ref.id);return !p||p.state!=='active'||p.revision!==ref.revision||p.verification!=='user_confirmed'||p.sensitivity!=='normal'||p.experienceKind!==s.experienceKind;}))continue;
   stories.push(Object.freeze({ownerId:context.userId,id:s.id,revision:s.revision,state:'current',normalSummary:'经历类型：'+labels[s.experienceKind]+'；故事状态：本人已确认；关联事实为当前确认版本。'}));
  }
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
  return Object.freeze({projects:Object.freeze(evidence),stories:Object.freeze(stories)});
 }
 /** Private owner ledger projection. Does not filter by model visibility or
  * grant access to project facts; no body or sensitivity leaves this reader. */
 async readProgressEvidenceInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):Promise<readonly Readonly<CareerEvidence>[]> {
  const context=this.fixed(value);await this.authorize(client,context,signal);
  const rows=(await client.query('SELECT * FROM platform_career_evidence WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE',[context.userId])).rows;
  if(rows.length>500)throw unavailable();
  const ids=rows.map(r=>r.id);
  const latest=(await client.query("SELECT o.* FROM unnest($2::uuid[]) c(id) JOIN LATERAL (SELECT operation_id FROM platform_career_library_operations WHERE user_id=$1 AND record_kind='project' AND record_id=c.id ORDER BY applied_revision DESC LIMIT 1) chosen ON true JOIN platform_career_library_operations o ON o.user_id=$1 AND o.operation_id=chosen.operation_id FOR SHARE OF o",[context.userId,ids])).rows;
  const confirmations=(await client.query("SELECT o.* FROM unnest($2::uuid[]) c(id) JOIN LATERAL (SELECT operation_id FROM platform_career_library_operations WHERE user_id=$1 AND record_kind='project' AND record_id=c.id AND action='confirm' ORDER BY applied_revision DESC LIMIT 1) chosen ON true JOIN platform_career_library_operations o ON o.user_id=$1 AND o.operation_id=chosen.operation_id FOR SHARE OF o",[context.userId,ids])).rows;
  const withdrawals=(await client.query("SELECT o.* FROM unnest($2::uuid[]) c(id) JOIN LATERAL (SELECT operation_id FROM platform_career_library_operations WHERE user_id=$1 AND record_kind='project' AND record_id=c.id AND action='withdraw' ORDER BY applied_revision DESC LIMIT 1) chosen ON true JOIN platform_career_library_operations o ON o.user_id=$1 AND o.operation_id=chosen.operation_id FOR SHARE OF o",[context.userId,rows.filter(r=>r.state==='withdrawn').map(r=>r.id)])).rows;
  const proofs:PreparationProofs={latest:new Map(latest.map(r=>[proofKey(r.record_kind,r.record_id),r])),confirmed:new Map(confirmations.map(r=>[proofKey(r.record_kind,r.record_id),r])),withdrawn:new Map(withdrawals.map(r=>[r.record_id,r]))};
  const evidence:Readonly<CareerEvidence>[]=[];
  for(const row of rows){signal?.throwIfAborted();const p=await this.record(client,context,'project',row,proofs) as CareerProject;
   evidence.push(Object.freeze({id:p.id,ownerId:p.ownerId,subjectId:p.subjectId,kind:p.kind,state:p.state,verification:p.verification,referenceId:p.referenceId,occurredAt:p.occurredAt}));
  }
  await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze(evidence);
 }
 /** Count distinct retained stories edited in the local week, not confirmations
  * or current updatedAt. The event receipt is the authority for the edit time. */
 async readWeeklyEditsInTransaction(client:PoolClient,value:FixedSessionContext,window:TodayWeekWindow,signal?:AbortSignal){
  const context=this.fixed(value);await this.authorize(client,context,signal);
  const w=todayWeekWindow(window.capturedAt,window.timeZone);if(w.weekStart!==window.weekStart||w.localDate!==window.localDate)throw bad();
  const rows=(await client.query(`SELECT o.* FROM platform_career_library_operations o
   JOIN platform_career_stories s ON s.user_id=o.user_id AND s.id=o.record_id
   WHERE o.user_id=$1 AND o.record_kind='story' AND o.action='edit'
    AND (o.created_at AT TIME ZONE $2)::date >= $3::date AND o.created_at<=$4::timestamptz
   ORDER BY o.created_at,o.operation_id LIMIT 1001 FOR SHARE OF o,s`,[context.userId,w.timeZone,w.weekStart,w.capturedAt])).rows;
  if(rows.length>1000)throw unavailable();
  const ids=new Set<string>();
  for(const row of rows){
   signal?.throwIfAborted();const proof=await this.receipt(client,context,row);
   if(proof.recordKind!=='story'||proof.action!=='edit')throw unavailable();
   if(!ids.has(proof.recordId)){
    const current=await this.row(client,context,'story',proof.recordId);if(!current)throw unavailable();
    const story=await this.record(client,context,'story',current);
    if(story.revision<proof.appliedRevision)throw unavailable();ids.add(proof.recordId);
   }
  }
  if(ids.size>500)throw unavailable();await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();
  return Object.freeze({ownerId:context.userId,count:ids.size});
 }
 async progress(value:FixedSessionContext,signal?:AbortSignal){const context=this.fixed(value);return this.db.withBoundedTransaction(async client=>{const evidence=await this.readProgressEvidenceInTransaction(client,context,signal);return Object.freeze({progress:careerProgress(context.userId,evidence),coverage:Object.freeze(['project'])});});}
 async mutate(value:FixedSessionContext,inputKind:CareerLibraryKind,action:CareerLibraryAction,key:unknown,input:unknown,signal?:AbortSignal){const context=this.fixed(value),kind=this.kind(inputKind);let command:ReturnType<typeof parseCareerLibraryCommand>,requested:string|null;try{command=parseCareerLibraryCommand(kind,action,input);requested=action==='create'?null:careerRecordId(key);}catch{throw bad();}
  const digest=createHash('sha256').update(canonical({kind,action,recordId:requested,command})).digest('hex');
  return this.db.withBoundedTransaction(async client=>{const auth=await this.authorize(client,context,signal),prior=(await client.query('SELECT * FROM platform_career_library_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,command.operationId])).rows[0];
   if(prior){const receipt=await this.receipt(client,context,prior);if(receipt.commandDigest!==digest||receipt.recordKind!==kind||receipt.action!==action||requested!==null&&receipt.recordId!==requested)throw new ApiError(409,'CAREER_LIBRARY_OPERATION_CONFLICT','The experience operation was already used.');
    const row=await this.row(client,context,kind,receipt.recordId);let record:Readonly<CareerLibraryRecord>|null=null;if(row)record=await this.record(client,context,kind,row);else if((await this.latest(client,context,kind,receipt.recordId)).action!=='delete')throw unavailable();const evidenceAvailability=kind==='story'&&record?await this.availability(client,context,record as CareerStory,signal):null;await authorizeFixedSession(client,context,signal);return Object.freeze({record,evidenceAvailability,operation:Object.freeze({id:receipt.operationId,recordId:receipt.recordId,recordKind:kind,appliedRevision:receipt.appliedRevision,replayed:true})});}
   const id=requested??randomUUID();let base:Readonly<CareerLibraryRecord>|null=null;if(action!=='create'){const row=await this.row(client,context,kind,id);if(!row)throw missing();base=await this.record(client,context,kind,row);if(base.revision!==command.expectedRevision)throw changed();}
   if(action!=='delete'&&action!=='withdraw')await this.storage.authorizeSession(client,context,signal);
   if(action==='create'&&(await client.query('SELECT count(*)::int count FROM '+tables[kind]+' WHERE user_id=$1',[context.userId])).rows[0].count>=500)throw new ApiError(409,'CAREER_LIBRARY_CAPACITY','Remove an old experience before saving another.');
   const revision=(base?.revision??0)+1;if(revision>2147483647)throw changed();const at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();let record:Readonly<CareerLibraryRecord>|null=null;
   if(action!=='delete'){const {operationId,expectedRevision,...fields}=command,confirmed=action==='confirm',keep=action==='withdraw';
    const common={...base,...fields,id,ownerId:context.userId,revision,createdAt:base?.createdAt??at,updatedAt:at,lastOperationId:operationId,source:'user_entered',confirmedAt:confirmed?at:keep?base!.confirmedAt:null,confirmedRevision:confirmed?revision:keep?base!.confirmedRevision:null};
    if(kind==='project'){record=parseCareerProject({...common,kind:'project',subjectId:id,referenceId:'career-project:'+id+':'+revision,state:action==='withdraw'?'withdrawn':action==='confirm'?'active':base?(base as CareerProject).state:'active',verification:confirmed?'user_confirmed':keep?(base as CareerProject).verification:'self_reported'});if(confirmed&&!(record as CareerProject).contribution.trim())throw new ApiError(400,'CAREER_PROJECT_CONTRIBUTION','Record what you personally did before confirming the facts.');}
    else {if(confirmed&&Object.values((base as CareerStory).english).some(v=>!v.trim()))throw new ApiError(400,'CAREER_STORY_INCOMPLETE','Complete the four English STAR sections before confirming this story.');record=parseCareerStory({...common,status:confirmed?'confirmed':'draft'});await this.linked(client,context,record,signal);if(confirmed&&(await this.availability(client,context,record,signal))!=='current')throw new ApiError(409,'CAREER_STORY_EVIDENCE_UNCONFIRMED','Confirm the linked project facts before confirming this story.');}
   }
   const receipt:Receipt={schemaVersion:1,ownerId:context.userId,operationId:command.operationId,recordKind:kind,recordId:id,action,commandDigest:digest,appliedRevision:revision,acceptedAuthVersion:String(auth.auth_version),createdAt:at};const sealed=this.storage.crypto!.sealUtf8(canonical(receipt),{table:'platform_career_library_operations',column:'receipt_ciphertext',rowId:receipt.operationId,ownerId:context.userId,revision});
   await client.query('INSERT INTO platform_career_library_operations(user_id,operation_id,record_kind,record_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[context.userId,command.operationId,kind,id,action,revision,at,sealed]);
   if(record){const cipher=this.storage.crypto!.sealUtf8(canonical(record),{table:tables[kind],column:'record_ciphertext',rowId:id,ownerId:context.userId,revision});
    if(kind==='project'){const p=record as CareerProject;let withdrawnAt:string|null=null;if(p.state==='withdrawn'){const wr=(await client.query("SELECT * FROM platform_career_library_operations WHERE user_id=$1 AND record_kind='project' AND record_id=$2 AND action='withdraw' ORDER BY applied_revision DESC LIMIT 1 FOR SHARE",[context.userId,id])).rows[0];if(!wr)throw unavailable();withdrawnAt=(await this.receipt(client,context,wr)).createdAt;}
     await client.query("INSERT INTO platform_career_evidence(id,user_id,kind,state,verification,sensitivity,revision,last_operation_id,record_ciphertext,created_at,updated_at,withdrawn_at) VALUES($1,$2,'project',$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,verification=EXCLUDED.verification,sensitivity=EXCLUDED.sensitivity,revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,record_ciphertext=EXCLUDED.record_ciphertext,updated_at=EXCLUDED.updated_at,withdrawn_at=EXCLUDED.withdrawn_at",[id,context.userId,p.state,p.verification,p.sensitivity,revision,command.operationId,cipher,p.createdAt,at,withdrawnAt]);}
    else {const s=record as CareerStory;await client.query('INSERT INTO platform_career_stories(id,user_id,status,sensitivity,revision,last_operation_id,record_ciphertext,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,sensitivity=EXCLUDED.sensitivity,revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,record_ciphertext=EXCLUDED.record_ciphertext,updated_at=EXCLUDED.updated_at',[id,context.userId,s.status,s.sensitivity,revision,command.operationId,cipher,s.createdAt,at]);}
   }else await client.query('DELETE FROM '+tables[kind]+' WHERE user_id=$1 AND id=$2',[context.userId,id]);
   if(kind==='story'&&(action==='create'||action==='edit'))await this.productEvents.record(client,context.userId,command.operationId,{event:'story_saved',props:{source:'user_entered'}});
   const evidenceAvailability=kind==='story'&&record?await this.availability(client,context,record as CareerStory,signal):null;await authorizeFixedSession(client,context,signal);return Object.freeze({record,evidenceAvailability,operation:Object.freeze({id:command.operationId,recordId:id,recordKind:kind,appliedRevision:revision,replayed:false})});
  });}
}
