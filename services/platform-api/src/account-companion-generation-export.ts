import {projectCompanionSourceManifest} from './account-companion-source-export.ts';
import {createHash} from 'node:crypto';
import {decodeCompanionRequest} from './companion-request-snapshot.ts';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {parseCapturedCompanionAnswers,type CapturedCompanionAnswers} from './companion-captured-answers.ts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';

export const COMPANION_GENERATION_EXPORT_TABLES=Object.freeze(['platform_companion_answers','platform_companion_generation_tasks',
 'platform_companion_revisions','platform_companion_generation_calls','platform_companion_output_blocks',
 'platform_companion_generation_requests','platform_companion_generation_outbox','platform_companion_generation_checkpoints','platform_companion_source_prefixes'] as const);
export type CompanionGenerationExportSection='companionAnswers'|'companionGenerationTasks'|'companionRevisions'|'companionGenerationCalls'|'companionOutputBlocks'|'companionGenerationRequests'|'companionGenerationOutbox'|'companionGenerationCheckpoints'|'companionSourceManifests';
const unavailable=()=>new ApiError(503,'ACCOUNT_COMPANION_GENERATION_EXPORT_UNAVAILABLE','The saved companion generation records could not be confirmed.');
type Row=Record<string,any>;
const at=(v:Date|null)=>v===null?null:v.toISOString();
function text(v:unknown):string{if(typeof v!=='string'||!v.length)throw unavailable();return v;}
function natural(v:unknown,min=0):number{if(!Number.isSafeInteger(v)||Object.is(v,-0)||(v as number)<min)throw unavailable();return v as number;}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
/** Parse the saved version-1 shape, without compiling current style templates or
 * rerunning output rules. Archive values are records, never generation proofs. */
function style(v:Row){
 const dimensions=object(v.dimensions,['warmth','directness','drive','structure','levity','code_mix','length']);
 for(const k of ['warmth','directness','drive','structure','levity','code_mix'])if(![-1,0,1].includes(dimensions[k] as number)||Object.is(dimensions[k],-0))throw unavailable();
 if(!['short','medium','long'].includes(dimensions.length as string))throw unavailable();
 const quirks=object(v.quirks,['metaphorSource','openingStyle','signOff','catchphrase']);
 if(![null,'chess','hiking','cooking','sailing','running','gardening','weather','coding'].includes(quirks.metaphorSource as never)
  ||!['reflect','conclusion','clarify'].includes(quirks.openingStyle as string)||!['name','name_and_time','dash_name'].includes(quirks.signOff as string)
  ||quirks.catchphrase!==null&&typeof quirks.catchphrase!=='string'
  ||!['yanzhi','zheshi','ganlan','jiangzi','dai','yanzi','hehui'].includes(v.inkToken))throw unavailable();
 return {dimensions,quirks,inkToken:v.inkToken as string,styleCard:text(v.styleCard)};
}
async function* rows(client:PoolClient,owner:string,table:typeof COMPANION_GENERATION_EXPORT_TABLES[number],signal?:AbortSignal){
 const key=table==='platform_companion_generation_outbox'?'request_id':table==='platform_companion_generation_checkpoints'?'task_id':table==='platform_companion_revisions'?'companion_id':table==='platform_companion_generation_calls'||table==='platform_companion_output_blocks'?'call_id':'id';
 const composite=table==='platform_companion_revisions'?'revision':table==='platform_companion_generation_checkpoints'?'generation':null;
 let after:string|null=null,afterRevision=0;
 for(;;){
  signal?.throwIfAborted();
  // Use the complete revision primary key, so an unknown future revision is
  // encountered and rejected by its codec rather than silently skipped.
  const found:Row[]=(await client.query(table==='platform_companion_output_blocks'
   ?`SELECT b.*,c.user_id FROM platform_companion_output_blocks b JOIN platform_companion_generation_calls c ON c.call_id=b.call_id
     WHERE c.user_id=$1 AND ($2::uuid IS NULL OR b.call_id>$2) ORDER BY b.call_id LIMIT 100`
   :composite
    ?`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR (${key},${composite})>($2::uuid,$3::integer)) ORDER BY ${key},${composite} LIMIT 100`
   :`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,composite?[owner,after,afterRevision]:[owner,after])).rows;
  for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
  if(found.length<100)break;after=id(found.at(-1)![key]);if(composite)afterRevision=natural(found.at(-1)![composite],1);
 }
}
/** Closed projection of the original checkpoint's cost receipts. No current
 * price lookup, settlement, or reconstruction of historical model output. */
function savedCostReceipt(value:unknown,call:Row){
 const saved=object(value,['callId','reservationId','attempt','status','structuredOutcome','validationStatus','admittedAt','finishedAt',
  'usageStatus','units','costMicros','estimated','inputPriceId','outputPriceId','inputRate','outputRate','estimateMicros','rejectionRules'],
  ['pricingRevision','cachedInputPriceId','cacheWriteInputPriceId','cachedInputRate','cacheWriteInputRate']);
 if(!call||saved.callId!==call.call_id||saved.reservationId!==call.reservation_id||saved.attempt!==call.attempt
  ||saved.status!==call.status||saved.structuredOutcome!==call.structured_outcome||saved.validationStatus!==call.validation_status
  ||saved.admittedAt!==at(call.admitted_at)||saved.finishedAt!==at(call.finished_at)||saved.usageStatus!==call.usage_status
  ||!['complete','failed','cancelled','interrupted'].includes(saved.status as string)||typeof saved.estimated!=='boolean')throw unavailable();
 for(const key of ['costMicros','estimateMicros'])if(typeof saved[key]!=='string'||!/^(0|[1-9][0-9]*)$/.test(saved[key] as string))throw unavailable();
 for(const key of ['inputPriceId','outputPriceId'])id(saved[key]);
 const rates=['inputRate','outputRate'];
 const cacheKeys=['cachedInputPriceId','cacheWriteInputPriceId','cachedInputRate','cacheWriteInputRate'];
 if(saved.pricingRevision!==undefined){
  if(saved.pricingRevision!==2||cacheKeys.some(key=>saved[key]===undefined))throw unavailable();
  id(saved.cachedInputPriceId);id(saved.cacheWriteInputPriceId);rates.push('cachedInputRate','cacheWriteInputRate');
 }else if(cacheKeys.some(key=>saved[key]!==undefined))throw unavailable();
 for(const key of rates)if(typeof saved[key]!=='string'||!/^[0-9]+(?:\.[0-9]+)?$/.test(saved[key] as string))throw unavailable();
 const units=saved.usageStatus==='reported'?object(saved.units,['inputTokens','outputTokens'],['cachedInputTokens','cacheWriteInputTokens'])
  :object(saved.units,['maxInputTokens','maxOutputTokens']);
 for(const count of Object.values(units))natural(count);
 if(saved.usageStatus==='reported'){
  if(units.inputTokens!==call.input_tokens||units.outputTokens!==call.output_tokens
   ||units.cachedInputTokens!==undefined&&units.cachedInputTokens!==call.cached_input_tokens
   ||units.cacheWriteInputTokens!==undefined&&units.cacheWriteInputTokens!==call.cache_write_input_tokens)throw unavailable();
 }else if(!['missing','invalid'].includes(saved.usageStatus as string)||saved.estimated!==true)throw unavailable();
 if(!Array.isArray(saved.rejectionRules)||saved.rejectionRules.length>32||saved.rejectionRules.some(rule=>typeof rule!=='string'||!rule.length||rule.length>160))throw unavailable();
 return {...saved,units};
}
type SavedTask={row:Row;style:ReturnType<typeof style>};
function savedPreview(saved:unknown,task:SavedTask,calls:Map<string,Row>,owner:string,generation:number,generatedBy:string){
 const payload=object(saved,
  ['schemaVersion','userId','companionId','revision','taskId','generation','answersId','sourceDraftId','sourceRevision','generatedBy','policyRevision','assurance','callIds','summary','samples','dimensions','quirks','inkToken','styleCard']);
 if(payload.schemaVersion!==1||payload.userId!==owner||payload.companionId!==task.row.companion_id||payload.revision!==1
  ||payload.taskId!==task.row.id||payload.generation!==generation||payload.answersId!==task.row.answers_id||payload.sourceDraftId!==task.row.source_draft_id
  ||payload.sourceRevision!==task.row.source_revision||payload.generatedBy!==generatedBy||!['model','fallback'].includes(generatedBy)
  ||payload.policyRevision!==1||payload.assurance!=='deterministic_rules_with_heuristic_fact_detection'||!same(style(payload),task.style))throw unavailable();
 if(!Array.isArray(payload.callIds)||payload.callIds.length<1||payload.callIds.length>3||new Set(payload.callIds).size!==payload.callIds.length
  ||!Array.isArray(payload.samples)||payload.samples.length!==3)throw unavailable();
 for(const callId of payload.callIds){const call=calls.get(id(callId));if(!call||call.task_id!==task.row.id||call.companion_id!==task.row.companion_id||call.generation!==generation)throw unavailable();}
 text(payload.summary);payload.samples.forEach(text);
 return payload;
}
export class AccountCompanionGenerationExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 private open(row:Row,table:string,column:string,rowId:string,owner:string,revision:number):Row{
  if(!this.config.dataCrypto)throw unavailable();
  const raw=this.config.dataCrypto.openUtf8(row[column],{table,column,rowId,ownerId:owner,revision}),value=JSON.parse(raw);
  if(JSON.stringify(value)!==raw)throw unavailable();return value;
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:CompanionGenerationExportSection;record:unknown}>{
  const session=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(session.userId),tokenHash:session.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const answers=new Map<string,Readonly<CapturedCompanionAnswers>>();
   for await(const row of rows(client,who.userId,'platform_companion_answers',signal)){
    const capture=parseCapturedCompanionAnswers(this.open(row,'platform_companion_answers','payload_ciphertext',row.id,who.userId,row.source_revision));
    if(capture.id!==row.id||capture.userId!==who.userId||capture.sourceDraftId!==row.source_draft_id||capture.sourceRevision!==row.source_revision)throw unavailable();
    answers.set(row.id,capture);yield {section:'companionAnswers',record:{...capture,createdAt:at(row.created_at)}};
   }
   const tasks=new Map<string,{row:Row;style:ReturnType<typeof style>;seed:Row}>();
   for await(const row of rows(client,who.userId,'platform_companion_generation_tasks',signal)){
    const saved=this.open(row,'platform_companion_generation_tasks','seed_ciphertext',row.id,who.userId,row.source_revision);
    const seed=object(saved,['schemaVersion','taskId','userId','companionId','answersId','sourceDraftId','sourceRevision','authVersion','questionnaireRevision',
     'rulesRevision','generatorVersion','purpose','provider','model','dimensions','quirks','inkToken','styleCard'],[...(row.quirk_draw===1?['quirkDraw']:[]),...(row.source_receipt_version===null?[]:['sourceReceiptVersion','sourceReceiptDigest'])]);
    const answer=answers.get(row.answers_id);
    if(!answer||answer.sourceDraftId!==row.source_draft_id||answer.sourceRevision!==row.source_revision||seed.schemaVersion!==1
     ||seed.taskId!==row.id||seed.userId!==who.userId||seed.companionId!==row.companion_id||seed.answersId!==row.answers_id
     ||seed.sourceDraftId!==row.source_draft_id||seed.sourceRevision!==row.source_revision||seed.authVersion!==String(row.auth_version)
     ||seed.questionnaireRevision!==row.questionnaire_revision||seed.rulesRevision!==row.rules_revision||seed.generatorVersion!==row.generator_version
     ||row.questionnaire_revision!==1||row.rules_revision!==1||row.generator_version!==1||seed.purpose!=='companion_preview'||row.purpose!==seed.purpose
     ||![0,1].includes(row.quirk_draw)||(row.quirk_draw===1&&seed.quirkDraw!==1)||!['pending','running','completed','failed','uncertain','interrupted'].includes(row.status))throw unavailable();
    if(row.source_receipt_version!==null&&(![1,2].includes(row.source_receipt_version)||seed.sourceReceiptVersion!==row.source_receipt_version
     ||typeof seed.sourceReceiptDigest!=='string'||!/^[0-9a-f]{64}$/.test(seed.sourceReceiptDigest)))throw unavailable();
    const snapshot=style(seed);text(seed.provider);text(seed.model);natural(row.generation);
    tasks.set(row.id,{row,style:snapshot,seed});
    yield {section:'companionGenerationTasks',record:{id:row.id,ownerId:who.userId,companionId:row.companion_id,answersId:row.answers_id,
     sourceDraftId:row.source_draft_id,sourceRevision:row.source_revision,questionnaireRevision:row.questionnaire_revision,rulesRevision:row.rules_revision,
     generatorVersion:row.generator_version,purpose:row.purpose,status:row.status,generation:row.generation,quirkDraw:row.quirk_draw,
     sourceReceiptVersion:row.source_receipt_version,createdAt:at(row.created_at),finishedAt:at(row.finished_at),leaseUntil:at(row.lease_until),
     errorCode:row.error_code,prepared:{provider:seed.provider,model:seed.model,...snapshot}}};
   }
   const manifestTasks=new Set<string>();
   for await(const row of rows(client,who.userId,'platform_companion_source_prefixes',signal)){
    const task=tasks.get(row.task_id);
    if(!task||manifestTasks.has(row.task_id)||task.row.source_receipt_version!==row.schema_version)throw unavailable();
    const answer=answers.get(task.row.answers_id);
    if(!answer)throw unavailable();
    const manifest=projectCompanionSourceManifest(this.config.dataCrypto,row,task.row,task.seed,answer);
    manifestTasks.add(row.task_id);yield {section:'companionSourceManifests',record:manifest};
   }
   for(const [taskId,task] of tasks)if(task.row.source_receipt_version!==null&&!manifestTasks.has(taskId))throw unavailable();
   const requests=new Map<string,Row>();
   for await(const row of rows(client,who.userId,'platform_companion_generation_requests',signal)){
    const snapshot=decodeCompanionRequest(row as Parameters<typeof decodeCompanionRequest>[0],this.config.dataCrypto),task=tasks.get(row.task_id);
    if(!task||task.row.companion_id!==snapshot.companionId||task.row.source_draft_id!==snapshot.sourceDraftId
     ||task.row.source_revision!==snapshot.sourceRevision||String(task.row.auth_version)!==snapshot.authVersion)throw unavailable();
    requests.set(row.id,row);
    // Explicit projection: the authenticated original session and auth version
    // are required to read the receipt, but must never leave the archive reader.
    yield {section:'companionGenerationRequests',record:{schemaVersion:1,operationId:snapshot.operationId,ownerId:snapshot.userId,
     taskId:snapshot.taskId,companionId:snapshot.companionId,sourceDraftId:snapshot.sourceDraftId,sourceRevision:snapshot.sourceRevision,
     initialGeneration:snapshot.initialGeneration,command:snapshot.command,acceptedAt:at(row.accepted_at)}};
   }
   const delivered=new Set<string>();
   for await(const row of rows(client,who.userId,'platform_companion_generation_outbox',signal)){
    const request=requests.get(row.request_id);
    if(!request||request.task_id!==row.task_id||delivered.has(row.request_id)
     ||![null,'authorization','configuration','source_changed','storage','terminal'].includes(row.held_reason))throw unavailable();
    delivered.add(row.request_id);
    yield {section:'companionGenerationOutbox',record:{requestId:row.request_id,ownerId:who.userId,taskId:row.task_id,
     dispatchedAt:at(row.dispatched_at),heldReason:row.held_reason,createdAt:at(row.created_at)}};
   }
   if(delivered.size!==requests.size)throw unavailable();
   const calls=new Map<string,Row>();
   for await(const row of rows(client,who.userId,'platform_companion_generation_calls',signal)){
    const task=tasks.get(row.task_id);
    if(!task||task.row.companion_id!==row.companion_id||row.generation>task.row.generation)throw unavailable();
    const reservation=(await client.query('SELECT user_id FROM platform_cost_reservations WHERE id=$1',[row.reservation_id])).rows;
    if(reservation.length!==1||reservation[0].user_id!==who.userId)throw unavailable();
    calls.set(row.call_id,row);
    yield {section:'companionGenerationCalls',record:{id:row.call_id,taskId:row.task_id,companionId:row.companion_id,generation:row.generation,
     attempt:row.attempt,provider:row.provider,model:row.model,purpose:row.purpose,reservationId:row.reservation_id,status:row.status,usageStatus:row.usage_status,
     inputTokens:row.input_tokens,outputTokens:row.output_tokens,cachedInputTokens:row.cached_input_tokens,cacheWriteInputTokens:row.cache_write_input_tokens,
     validationStatus:row.validation_status,structuredOutcome:row.structured_outcome,admittedAt:at(row.admitted_at),finishedAt:at(row.finished_at),createdAt:at(row.created_at)}};
   }
   const published=new Map<string,Row>();
   for await(const row of rows(client,who.userId,'platform_companion_revisions',signal)){
    const task=tasks.get(row.task_id);
    if(!task||task.row.companion_id!==row.companion_id||row.revision!==1||row.generation!==task.row.generation)throw unavailable();
    const payload=savedPreview(this.open(row,'platform_companion_revisions','payload_ciphertext',row.companion_id,who.userId,row.revision),task,calls,who.userId,row.generation,row.generated_by);
    published.set(`${row.task_id}/${row.generation}`,payload);
    yield {section:'companionRevisions',record:{...payload,createdAt:at(row.created_at)}};
   }
   for await(const row of rows(client,who.userId,'platform_companion_generation_checkpoints',signal)){
    const task=tasks.get(row.task_id);
    if(!task||row.companion_id!==task.row.companion_id||row.source_draft_id!==task.row.source_draft_id
     ||row.source_revision!==task.row.source_revision||row.policy_revision!==1||natural(row.generation,1)>task.row.generation)throw unavailable();
    const saved=this.open(row,'platform_companion_generation_checkpoints','payload_ciphertext',row.task_id,who.userId,row.generation);
    const payload=object(saved,['schemaVersion','preview','costReceipts']);
    if(payload.schemaVersion!==1||createHash('sha256').update(JSON.stringify(saved)).digest('hex')!==row.payload_digest)throw unavailable();
    const preview=savedPreview(payload.preview,task,calls,who.userId,row.generation,'model');
    if(!same(preview.callIds,row.call_ids)||!Array.isArray(payload.costReceipts)||payload.costReceipts.length!==row.call_ids.length)throw unavailable();
    const receipts=payload.costReceipts.map((receipt,index)=>savedCostReceipt(receipt,calls.get(row.call_ids[index])!));
    const revision=published.get(`${row.task_id}/${row.generation}`);
    if(revision&&!same(revision,preview))throw unavailable();
    yield {section:'companionGenerationCheckpoints',record:{schemaVersion:1,taskId:row.task_id,ownerId:who.userId,companionId:row.companion_id,
     generation:row.generation,sourceDraftId:row.source_draft_id,sourceRevision:row.source_revision,policyRevision:row.policy_revision,
     callIds:[...row.call_ids],preview,costReceipts:receipts,publishedRevision:revision?1:null,createdAt:at(row.created_at)}};
   }
   for await(const row of rows(client,who.userId,'platform_companion_output_blocks',signal)){
    if(!calls.has(row.call_id))throw unavailable();
    yield {section:'companionOutputBlocks',record:{callId:row.call_id,rules:row.rules,createdAt:at(row.created_at)}};
   }
  }catch(error){signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
