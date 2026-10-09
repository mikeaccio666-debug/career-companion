import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {companionSealCandidates,companionSealCandidatesV2,validateCompanionName,validateCompanionNameV2,type CompanionDimensions} from '@companion/career-core';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {parseCompanionIdentityBundle} from './companion-identity-bundle.ts';
import {parseCompanionIdentityReview} from './companion-identity-review.ts';
import {selectionCommand} from './companion-identity-drafts.ts';
import {ApiError} from './errors.ts';

export const COMPANION_IDENTITY_EXPORT_TABLES=Object.freeze(['platform_companion_identity_drafts','platform_companion_identity_operations','platform_companion_identity_selections','platform_companion_identity_selection_operations'] as const);
export type CompanionIdentityExportSection='companionIdentityDrafts'|'companionIdentityOperations'|'companionIdentitySelections'|'companionIdentitySelectionOperations';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_COMPANION_IDENTITY_EXPORT_UNAVAILABLE','The retained companion name and seal choices could not be confirmed.');
function integer(v:unknown,min=1):number{if(!Number.isSafeInteger(v)||Object.is(v,-0)||Number(v)<min||Number(v)>2147483647)throw unavailable();return Number(v);}
function at(v:unknown){if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw unavailable();return v.toISOString();}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
/** These are private archive projections already fully checked by
 * AccountCompanionGenerationExport in this same transaction, not runtime grants.
 * Only the account coordinator supplies them; no request data enters this port. */
export interface IdentityGenerationArchive {readonly tasks:readonly unknown[];readonly revisions:readonly unknown[];}
function sources(owner:string,archive:IdentityGenerationArchive){
 const tasks=new Map<string,Row>(),result=new Map<string,{source:Row;dimensions:CompanionDimensions;inkToken:string}>();
 for(const value of archive.tasks){const row=value as Row;if(row.ownerId!==owner||tasks.has(id(row.id)))throw unavailable();tasks.set(row.id,row);}
 for(const value of archive.revisions){const row=value as Row,task=tasks.get(id(row.taskId));
  if(!task||task.status!=='completed'||row.userId!==owner||row.companionId!==task.companionId||row.revision!==1||row.generation!==task.generation
   ||row.answersId!==task.answersId||row.sourceDraftId!==task.sourceDraftId||row.sourceRevision!==task.sourceRevision||result.has(task.id)
   ||!same(row.dimensions,task.prepared.dimensions)||row.inkToken!==task.prepared.inkToken)throw unavailable();
  result.set(task.id,{source:{taskId:task.id,companionId:task.companionId,previewRevision:1,generation:integer(task.generation),
   sourceDraftId:task.sourceDraftId,sourceRevision:task.sourceRevision,answersId:task.answersId,questionnaireRevision:task.questionnaireRevision,rulesRevision:task.rulesRevision,generatorVersion:task.generatorVersion},
   dimensions:row.dimensions,inkToken:row.inkToken});
 }
 return result;
}
function nameCommand(value:unknown){
 const raw=object(value,['taskId','expectedRevision','operationId','name']),name=raw.name;
 if(typeof name!=='string'||name.length>128||name!==name.trim().normalize('NFC')||/[<>\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(name))throw unavailable();
 return {taskId:id(raw.taskId),expectedRevision:integer(raw.expectedRevision,0),operationId:id(raw.operationId),name};
}
/** Internal historical validator shared by private identity and source archives.
 * Its returned snapshots are data, never current name/preview execution grants. */
export function identityArchiveValidator(client:PoolClient,owner:string,archive:IdentityGenerationArchive) {
 const originals=sources(owner,archive);
   const assetCache=new Map<string,{bundle:ReturnType<typeof parseCompanionIdentityBundle>;review:ReturnType<typeof parseCompanionIdentityReview>}>();
   const assets=async(row:Row)=>{
    const key=row.content_digest+':'+row.review_digest;let saved=assetCache.get(key);
    if(!saved){const found=(await client.query('SELECT revision,bundle_json,review_json FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2',[row.content_digest,row.review_digest])).rows[0];
     if(!found)throw unavailable();const bundle=parseCompanionIdentityBundle(JSON.parse(found.bundle_json)),review=parseCompanionIdentityReview(JSON.parse(found.review_json));
     if(found.revision!==bundle.revision||review.bundleRevision!==bundle.revision||review.schemaVersion!==bundle.schemaVersion||bundle.contentDigest!==row.content_digest
      ||review.bundleDigest!==bundle.contentDigest||review.reviewDigest!==row.review_digest||JSON.stringify(bundle)!==found.bundle_json||JSON.stringify(review)!==found.review_json)throw unavailable();
     saved={bundle,review};
     // Shared resource bytes are not included in the archive size budget. Keep
     // their cache bounded while still reading every historical choice.
     if(assetCache.size>=8)assetCache.delete(assetCache.keys().next().value!);
     assetCache.set(key,saved);
    }
    if(saved.bundle.revision!==row.bundle_revision)throw unavailable();return saved;
   };
   const snapshot=async(row:Row,text:string)=>{
    const original=originals.get(row.task_id);if(!original||row.user_id!==owner||row.companion_id!==original.source.companionId||row.preview_revision!==1)throw unavailable();
    const data=JSON.parse(text),{bundle}=await assets(row);integer(row.revision);
    const name=bundle.schemaVersion===1?validateCompanionName({name:data?.name,userName:data?.userNameAtSave,policy:bundle.policy}):validateCompanionNameV2({name:data?.name,userName:data?.userNameAtSave,policy:bundle.policy});
    const sealCandidates=bundle.schemaVersion===1?companionSealCandidates({companionId:row.companion_id,name,dimensions:original.dimensions,policy:bundle.policy}):companionSealCandidatesV2({companionId:row.companion_id,name,dimensions:original.dimensions,policy:bundle.policy});
    const expected={schemaVersion:1,id:row.id,userId:owner,companionId:row.companion_id,taskId:row.task_id,previewRevision:1,revision:row.revision,
     source:original.source,bundleRevision:row.bundle_revision,contentDigest:row.content_digest,reviewDigest:row.review_digest,userNameAtSave:data.userNameAtSave,name,nameOrigin:'user_typed',sealCandidates,inkToken:original.inkToken};
    if(JSON.stringify(expected)!==text)throw unavailable();return expected;
   };
 return {originals,snapshot};
}
export class AccountCompanionIdentityExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 private open(row:Row,table:string,column:string,key:string,owner:string,revision:number){
  if(!this.config.dataCrypto)throw unavailable();const text=this.config.dataCrypto.openUtf8(row[column],{table,column,rowId:key,ownerId:owner,revision});
  const data=JSON.parse(text);return {text,data};
 }
 private async *rows(client:PoolClient,owner:string,table:typeof COMPANION_IDENTITY_EXPORT_TABLES[number],signal?:AbortSignal){
  const key=table.endsWith('_operations')?'operation_id':'id';let after:string|null=null;
  for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,[owner,after])).rows;
   for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner)throw unavailable();id(row[key]);yield row;}
   if(found.length<100)break;after=id(found.at(-1)![key]);
  }
 }
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,archive:IdentityGenerationArchive,signal?:AbortSignal):AsyncGenerator<{section:CompanionIdentityExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const drafts=new Map<string,{row:Row;snapshot:Row;names:Map<number,ReturnType<typeof nameCommand>>}>();
   const {originals,snapshot}=identityArchiveValidator(client,who.userId,archive);
   for await(const row of this.rows(client,who.userId,'platform_companion_identity_drafts',signal)){
    const decoded=await snapshot(row,this.open(row,'platform_companion_identity_drafts','payload_ciphertext',row.id,who.userId,integer(row.revision)).text);
    drafts.set(row.id,{row,snapshot:decoded,names:new Map()});yield {section:'companionIdentityDrafts',record:{...decoded,createdAt:at(row.created_at),updatedAt:at(row.updated_at)}};
   }
   for await(const row of this.rows(client,who.userId,'platform_companion_identity_operations',signal)){
    const draft=drafts.get(row.draft_id);if(!draft||integer(row.applied_revision)>draft.row.revision||draft.names.has(row.applied_revision))throw unavailable();
    const opened=this.open(row,'platform_companion_identity_operations','request_ciphertext',row.operation_id,who.userId,row.applied_revision),command=nameCommand(opened.data);
    if(JSON.stringify(command)!==opened.text||command.taskId!==draft.row.task_id||command.operationId!==row.operation_id||command.expectedRevision+1!==row.applied_revision)throw unavailable();
    draft.names.set(row.applied_revision,command);yield {section:'companionIdentityOperations',record:{ownerId:who.userId,draftId:row.draft_id,command,appliedRevision:row.applied_revision,createdAt:at(row.created_at)}};
   }
   for(const draft of drafts.values())if(draft.names.size!==draft.row.revision||draft.names.get(draft.row.revision)?.name!==draft.snapshot.name)throw unavailable();
   const selections=new Map<string,{row:Row;payload:Row;operations:Map<number,Row>}>();
   const historical=async(row:Row,data:unknown)=>{
    const draft=drafts.get(row.draft_id);if(!draft||integer(row.identity_revision)>draft.row.revision||row.companion_id!==draft.row.companion_id||row.task_id!==draft.row.task_id||row.preview_revision!==1)throw unavailable();
    const old=await snapshot({...draft.row,revision:row.identity_revision,bundle_revision:row.bundle_revision,content_digest:row.content_digest,review_digest:row.review_digest},JSON.stringify(data));
    if(draft.names.get(row.identity_revision)?.name!==old.name||row.identity_revision===draft.row.revision&&!same(old,draft.snapshot))throw unavailable();return old;
   };
   for await(const row of this.rows(client,who.userId,'platform_companion_identity_selections',signal)){
    const opened=this.open(row,'platform_companion_identity_selections','payload_ciphertext',row.id,who.userId,integer(row.revision));
    const old=await historical(row,opened.data?.identitySnapshot),source=originals.get(row.task_id)!.source;
    if(!old.sealCandidates.some(c=>c.char===opened.data?.sealChar))throw unavailable();
    const payload={schemaVersion:1,id:row.id,userId:who.userId,draftId:row.draft_id,companionId:row.companion_id,taskId:row.task_id,previewRevision:1,
     identityRevision:row.identity_revision,revision:row.revision,source,bundleRevision:row.bundle_revision,contentDigest:row.content_digest,reviewDigest:row.review_digest,identitySnapshot:old,sealChar:opened.data.sealChar};
    if(JSON.stringify(payload)!==opened.text)throw unavailable();selections.set(row.id,{row,payload,operations:new Map()});
    yield {section:'companionIdentitySelections',record:{...payload,currentForIdentity:row.identity_revision===drafts.get(row.draft_id)!.row.revision,createdAt:at(row.created_at),updatedAt:at(row.updated_at)}};
   }
   for await(const row of this.rows(client,who.userId,'platform_companion_identity_selection_operations',signal)){
    const selected=selections.get(row.selection_id);if(!selected||integer(row.applied_revision)>selected.row.revision||selected.operations.has(row.applied_revision)||integer(row.identity_revision)>selected.row.identity_revision)throw unavailable();
    const opened=this.open(row,'platform_companion_identity_selection_operations','request_ciphertext',row.operation_id,who.userId,row.applied_revision),request=selectionCommand(opened.data?.request);
    const old=await historical({...selected.row,identity_revision:row.identity_revision,bundle_revision:row.bundle_revision,content_digest:row.content_digest,review_digest:row.review_digest},opened.data?.identitySnapshot);
    const source=originals.get(selected.row.task_id)!.source;
    if(request.operationId!==row.operation_id||request.taskId!==source.taskId||request.expectedRevision+1!==row.applied_revision||request.expectedIdentityRevision!==row.identity_revision||!old.sealCandidates.some(c=>c.char===request.sealChar))throw unavailable();
    const payload={schemaVersion:1,userId:who.userId,operationId:row.operation_id,selectionId:row.selection_id,identityRevision:row.identity_revision,appliedRevision:row.applied_revision,
     source,bundleRevision:row.bundle_revision,contentDigest:row.content_digest,reviewDigest:row.review_digest,identitySnapshot:old,request};
    if(JSON.stringify(payload)!==opened.text)throw unavailable();selected.operations.set(row.applied_revision,payload);
    yield {section:'companionIdentitySelectionOperations',record:{...payload,createdAt:at(row.created_at)}};
   }
   for(const selected of selections.values()){
    const latest=selected.operations.get(selected.row.revision);if(selected.operations.size!==selected.row.revision||!latest||latest.identityRevision!==selected.row.identity_revision
     ||latest.bundleRevision!==selected.row.bundle_revision||latest.contentDigest!==selected.row.content_digest||latest.reviewDigest!==selected.row.review_digest
     ||!same(latest.identitySnapshot,selected.payload.identitySnapshot)||latest.request.sealChar!==selected.payload.sealChar)throw unavailable();
   }
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
