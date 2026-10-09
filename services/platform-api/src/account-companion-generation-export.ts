import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {parseCapturedCompanionAnswers,type CapturedCompanionAnswers} from './companion-captured-answers.ts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';

export const COMPANION_GENERATION_EXPORT_TABLES=Object.freeze(['platform_companion_answers','platform_companion_generation_tasks',
 'platform_companion_revisions','platform_companion_generation_calls','platform_companion_output_blocks'] as const);
export type CompanionGenerationExportSection='companionAnswers'|'companionGenerationTasks'|'companionRevisions'|'companionGenerationCalls'|'companionOutputBlocks';
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
 const key=table==='platform_companion_revisions'?'companion_id':table==='platform_companion_generation_calls'||table==='platform_companion_output_blocks'?'call_id':'id';
 let after:string|null=null,afterRevision=0;
 for(;;){
  signal?.throwIfAborted();
  // Use the complete revision primary key, so an unknown future revision is
  // encountered and rejected by its codec rather than silently skipped.
  const found:Row[]=(await client.query(table==='platform_companion_output_blocks'
   ?`SELECT b.*,c.user_id FROM platform_companion_output_blocks b JOIN platform_companion_generation_calls c ON c.call_id=b.call_id
     WHERE c.user_id=$1 AND ($2::uuid IS NULL OR b.call_id>$2) ORDER BY b.call_id LIMIT 100`
   :table==='platform_companion_revisions'
    ?`SELECT * FROM platform_companion_revisions WHERE user_id=$1 AND ($2::uuid IS NULL OR (companion_id,revision)>($2::uuid,$3::integer)) ORDER BY companion_id,revision LIMIT 100`
   :`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,table==='platform_companion_revisions'?[owner,after,afterRevision]:[owner,after])).rows;
  for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();yield row;}
  if(found.length<100)break;after=id(found.at(-1)![key]);if(table==='platform_companion_revisions')afterRevision=natural(found.at(-1)!.revision,1);
 }
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
   const tasks=new Map<string,{row:Row;style:ReturnType<typeof style>}>();
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
    tasks.set(row.id,{row,style:snapshot});
    yield {section:'companionGenerationTasks',record:{id:row.id,ownerId:who.userId,companionId:row.companion_id,answersId:row.answers_id,
     sourceDraftId:row.source_draft_id,sourceRevision:row.source_revision,questionnaireRevision:row.questionnaire_revision,rulesRevision:row.rules_revision,
     generatorVersion:row.generator_version,purpose:row.purpose,status:row.status,generation:row.generation,quirkDraw:row.quirk_draw,
     sourceReceiptVersion:row.source_receipt_version,createdAt:at(row.created_at),finishedAt:at(row.finished_at),leaseUntil:at(row.lease_until),
     errorCode:row.error_code,prepared:{provider:seed.provider,model:seed.model,...snapshot}}};
   }
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
   for await(const row of rows(client,who.userId,'platform_companion_revisions',signal)){
    const task=tasks.get(row.task_id);
    if(!task||task.row.companion_id!==row.companion_id||row.revision!==1||row.generation!==task.row.generation)throw unavailable();
    const payload=object(this.open(row,'platform_companion_revisions','payload_ciphertext',row.companion_id,who.userId,row.revision),
     ['schemaVersion','userId','companionId','revision','taskId','generation','answersId','sourceDraftId','sourceRevision','generatedBy','policyRevision','assurance','callIds','summary','samples','dimensions','quirks','inkToken','styleCard']);
    if(payload.schemaVersion!==1||payload.userId!==who.userId||payload.companionId!==row.companion_id||payload.revision!==row.revision
     ||payload.taskId!==row.task_id||payload.generation!==row.generation||payload.answersId!==task.row.answers_id||payload.sourceDraftId!==task.row.source_draft_id
     ||payload.sourceRevision!==task.row.source_revision||payload.generatedBy!==row.generated_by||!['model','fallback'].includes(row.generated_by)
     ||payload.policyRevision!==1||payload.assurance!=='deterministic_rules_with_heuristic_fact_detection'||!same(style(payload),task.style))throw unavailable();
    if(!Array.isArray(payload.callIds)||payload.callIds.length<1||payload.callIds.length>3||new Set(payload.callIds).size!==payload.callIds.length
     ||!Array.isArray(payload.samples)||payload.samples.length!==3)throw unavailable();
    for(const callId of payload.callIds){const call=calls.get(id(callId));if(!call||call.task_id!==row.task_id||call.companion_id!==row.companion_id||call.generation!==row.generation)throw unavailable();}
    text(payload.summary);payload.samples.forEach(text);
    yield {section:'companionRevisions',record:{...payload,createdAt:at(row.created_at)}};
   }
   for await(const row of rows(client,who.userId,'platform_companion_output_blocks',signal)){
    if(!calls.has(row.call_id))throw unavailable();
    yield {section:'companionOutputBlocks',record:{callId:row.call_id,rules:row.rules,createdAt:at(row.created_at)}};
   }
  }catch(error){signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
