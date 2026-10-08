import type { PoolClient } from 'pg';
import type { DataCrypto } from './data-crypto.ts';
import { deliveryDigest, deliveryRecord, deliveryStorageUnavailable, openDelivery, sealDelivery } from './safety-delivery-review.ts';
import { OnboardingStorage, type IntakeOperationRow, type SafetySubmissionRow } from './onboarding-storage.ts';
import { publicSafetyResponse, readAuthenticatedSafetyResponseForSource } from './onboarding-safety-responses.ts';
import type { SafetyPublicationRow } from './onboarding-safety-followup-protocol.ts';

export interface QuestionScopeRow {user_id:string;draft_id:string;revision:number;latest_operation_id:string|null;journal_digest:string;payload_ciphertext:Buffer;}
export interface QuestionOccurrenceRow {
  id:string;user_id:string;draft_id:string;publication_id:string;submission_id:string;source_generation:number;occurrence:number;generation:number;
  phase:'reserved'|'claimed'|'declared';reservation_id:string;reservation_digest:string;session_hash:string;render_owner_id:string;reserved_until:Date;
  display_until:Date|null;evidence_until:Date|null;grant_id:string|null;grant_digest:string|null;question_digest:string;claimed_at:Date|null;receipt_received_at:Date|null;
}
export interface QuestionOperationRow {user_id:string;operation_id:string;draft_id:string;occurrence_id:string;kind:'reserve'|'claim'|'present';expected_revision:number;applied_revision:number;
  session_hash:string;render_owner_id:string;previous_digest:string;journal_digest:string;payload_ciphertext:Buffer;created_at:Date;}
const occurrenceKeys=['id','user_id','draft_id','publication_id','submission_id','source_generation','occurrence','generation','phase','reservation_id','reservation_digest','session_hash',
  'render_owner_id','grant_id','grant_digest','question_digest'] as const;
export type QuestionOccurrenceCapture=Pick<QuestionOccurrenceRow,typeof occurrenceKeys[number]>&{reservedUntil:string;displayUntil:string|null;evidenceUntil:string|null;claimedAt:string|null;receiptReceivedAt:string|null};
export function questionOccurrenceCapture(row:QuestionOccurrenceRow):QuestionOccurrenceCapture{return {...Object.fromEntries(occurrenceKeys.map(k=>[k,row[k]])),reservedUntil:row.reserved_until.toISOString(),
  displayUntil:row.display_until?.toISOString()??null,evidenceUntil:row.evidence_until?.toISOString()??null,claimedAt:row.claimed_at?.toISOString()??null,receiptReceivedAt:row.receipt_received_at?.toISOString()??null} as QuestionOccurrenceCapture;}
export function occurrenceFromCapture(raw:unknown):QuestionOccurrenceRow {
  const d=deliveryRecord(raw,[...occurrenceKeys,'reservedUntil','displayUntil','evidenceUntil','claimedAt','receiptReceivedAt']);
  const date=(v:unknown,nullable=false)=>{if(nullable&&v===null)return null;if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)throw deliveryStorageUnavailable();return new Date(v);};
  return {...Object.fromEntries(occurrenceKeys.map(k=>[k,d[k]])),reserved_until:date(d.reservedUntil),display_until:date(d.displayUntil,true),evidence_until:date(d.evidenceUntil,true),
    claimed_at:date(d.claimedAt,true),receipt_received_at:date(d.receiptReceivedAt,true)} as QuestionOccurrenceRow;
}
const operationKeys=['user_id','operation_id','draft_id','occurrence_id','kind','expected_revision','applied_revision','session_hash','render_owner_id'] as const;
export function questionOperationCore(row:QuestionOperationRow,request:unknown,after:QuestionOccurrenceRow,secret:string|null,question:string|null){
  return {schemaVersion:1,...Object.fromEntries(operationKeys.map(k=>[k,row[k]])),at:row.created_at.toISOString(),request,after:questionOccurrenceCapture(after),secret,question,previousDigest:row.previous_digest};
}
export function questionOperationCapture(row:QuestionOperationRow,request:unknown,after:QuestionOccurrenceRow,secret:string|null,question:string|null){
  return {...questionOperationCore(row,request,after,secret,question),journalDigest:row.journal_digest};
}
export function questionScopeCapture(row:QuestionScopeRow,legacyDigest:string){return {schemaVersion:1,userId:row.user_id,draftId:row.draft_id,revision:row.revision,
  latestOperationId:row.latest_operation_id,journalDigest:row.journal_digest,legacyDigest};}
/** Authenticate every actual old transported capsule without current intake,
 * terms, identity, prefix045 or whole later execution history. Never infer
 * absence from mutable response.level. Old body copy itself may contain a
 * question: until the public cutover is reviewed, every old capsule is a
 * possible exposure, not an asserted asked occurrence. */
export async function readLegacyQuestionPublications(client:PoolClient,crypto:DataCrypto,userId:string,draftId:string){
  const storage=new OnboardingStorage({dataCrypto:crypto,requireVerifiedEmail:false},null);
  const rows=(await client.query<SafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_publications WHERE user_id=$1 AND draft_id=$2 ORDER BY id FOR SHARE',[userId,draftId])).rows;
  const proofs:{id:string;proofDigest:string}[]=[];
  for(const row of rows){
    const source=(await client.query<SafetySubmissionRow>('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1 AND user_id=$2 FOR SHARE',[row.submission_id,userId])).rows[0];
    if(!source||source.status!=='detected'||source.draft_id!==draftId||source.generation!==row.source_generation)throw deliveryStorageUnavailable();
    const op=(await client.query<IntakeOperationRow&{user_id:string}>('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[userId,source.operation_id])).rows[0];
    if(!op||op.user_id!==userId||op.draft_id!==draftId||op.applied_revision!==source.submitted_revision)throw deliveryStorageUnavailable();
    const command=storage.decodeOperation(op,userId),result=storage.decodeResult(source);
    if(command.action.kind!=='text'||command.action.questionId!==source.question_id)throw deliveryStorageUnavailable();
    const original=await readAuthenticatedSafetyResponseForSource(client,storage,source),response=publicSafetyResponse(original.response!);
    if(original.row.id!==row.response_id||row.published_at<original.row.prepared_at!||row.retention_until.toISOString()!==original.row.retention_until!.toISOString())throw deliveryStorageUnavailable();
    const expected={schemaVersion:1,id:row.id,userId,draftId,responseId:row.response_id,submissionId:row.submission_id,sourceGeneration:row.source_generation,
      preparedAt:original.row.prepared_at!.toISOString(),publishedAt:row.published_at.toISOString(),retentionUntil:row.retention_until.toISOString(),projectionDigest:row.projection_digest,response};
    const raw=openDelivery(crypto,'platform_onboarding_safety_publications',row.id,userId,1,row.payload_ciphertext);
    if(JSON.stringify(raw)!==JSON.stringify(expected)||row.projection_digest!==deliveryDigest(JSON.stringify(response)))throw deliveryStorageUnavailable();
    if(!(await client.query<{past:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS past',[row.published_at])).rows[0].past)throw deliveryStorageUnavailable();
    proofs.push({id:row.id,proofDigest:deliveryDigest(JSON.stringify({publication:expected,command,result}))});
  }
  return proofs;
}
export async function readQuestionLegacy(client:PoolClient,crypto:DataCrypto,userId:string,draftId:string){
  const actual=await readLegacyQuestionPublications(client,crypto,userId,draftId);
  const rows=(await client.query<{user_id:string;draft_id:string;publication_id:string;recorded_at:Date;payload_ciphertext:Buffer}>('SELECT * FROM platform_safety_legacy_exposures WHERE user_id=$1 AND draft_id=$2 ORDER BY publication_id FOR SHARE',[userId,draftId])).rows;
  if(actual.length!==rows.length||actual.some((r,i)=>r.id!==rows[i].publication_id))throw deliveryStorageUnavailable();
  const values=rows.map((row,i)=>{const expected={schemaVersion:1,userId:row.user_id,draftId:row.draft_id,publicationId:row.publication_id,recordedAt:row.recorded_at.toISOString(),kind:'legacy_possible_exposure',proofDigest:actual[i].proofDigest};
    if(JSON.stringify(openDelivery(crypto,'platform_safety_legacy_exposures',row.publication_id,row.user_id,1,row.payload_ciphertext))!==JSON.stringify(expected))throw deliveryStorageUnavailable();return expected;});
  // Old V1 is not mounted into this new mechanism. A newly appearing legacy
  // publication after scope initialization needs an explicit cutover observation,
  // not an assumed never-asked source or a silently rewritten genesis.
  return {rows,digest:deliveryDigest(JSON.stringify(values))};
}
export async function readQuestionJournal(client:PoolClient,crypto:DataCrypto,scope:QuestionScopeRow){
  const legacy=await readQuestionLegacy(client,crypto,scope.user_id,scope.draft_id),genesis=deliveryDigest(JSON.stringify({userId:scope.user_id,draftId:scope.draft_id,legacyDigest:legacy.digest}));
  if(JSON.stringify(openDelivery(crypto,'platform_safety_question_scopes',scope.draft_id,scope.user_id,scope.revision,scope.payload_ciphertext))!==JSON.stringify(questionScopeCapture(scope,legacy.digest)))throw deliveryStorageUnavailable();
  const rows=(await client.query<QuestionOperationRow>('SELECT * FROM platform_safety_question_operations WHERE user_id=$1 AND draft_id=$2 ORDER BY applied_revision FOR UPDATE',[scope.user_id,scope.draft_id])).rows;
  if(rows.length!==scope.revision||scope.latest_operation_id!==(rows.at(-1)?.operation_id??null))throw deliveryStorageUnavailable();
  const actual=(await client.query<QuestionOccurrenceRow>('SELECT * FROM platform_safety_question_occurrences WHERE user_id=$1 AND draft_id=$2 ORDER BY id FOR UPDATE',[scope.user_id,scope.draft_id])).rows;
  const latest=new Map<string,QuestionOccurrenceRow>(),captures=new Map<string,ReturnType<typeof questionOperationCapture>>();let digest=genesis,priorTime:Date|null=null;
  for(let i=0;i<rows.length;i++){
    const op=rows[i];if(op.expected_revision!==i||op.applied_revision!==i+1||op.previous_digest!==digest||priorTime&&op.created_at<priorTime)throw deliveryStorageUnavailable();
    const raw=openDelivery(crypto,'platform_safety_question_operations',op.operation_id,op.user_id,op.applied_revision,op.payload_ciphertext);
    const d=deliveryRecord(raw,['schemaVersion',...operationKeys,'at','request','after','secret','question','previousDigest','journalDigest']);
    const after=occurrenceFromCapture(d.after),before=latest.get(op.occurrence_id),request=d.request as Record<string,unknown>;
    if(after.id!==op.occurrence_id||after.user_id!==op.user_id||after.draft_id!==op.draft_id||after.session_hash!==op.session_hash||after.render_owner_id!==op.render_owner_id)throw deliveryStorageUnavailable();
    if(before&&(after.submission_id!==before.submission_id||after.source_generation!==before.source_generation||after.occurrence!==before.occurrence))throw deliveryStorageUnavailable();
    if(op.kind==='reserve'){
      const q=deliveryRecord(request,['operationId','publicationId','expectedQuestionScopeRevision','renderOwnerId']);
      if(q.operationId!==op.operation_id||q.publicationId!==after.publication_id||q.expectedQuestionScopeRevision!==op.expected_revision||q.renderOwnerId!==op.render_owner_id
        ||after.phase!=='reserved'||d.secret!==null||d.question!==null||after.reserved_until<=op.created_at
        ||before&&(before.phase!=='reserved'||before.reserved_until>op.created_at||after.generation!==before.generation+1)
        ||!before&&after.generation!==1)throw deliveryStorageUnavailable();
    }else if(op.kind==='claim'){
      const q=deliveryRecord(request,['operationId','occurrenceId','reservationId','reservationDigest','generation','renderOwnerId']);
      if(!before||before.phase!=='reserved'||q.operationId!==op.operation_id||q.occurrenceId!==op.occurrence_id||q.reservationId!==before.reservation_id
        ||q.reservationDigest!==before.reservation_digest||q.generation!==before.generation||q.renderOwnerId!==op.render_owner_id
        ||before.session_hash!==op.session_hash||before.render_owner_id!==op.render_owner_id||before.reserved_until<=op.created_at||after.phase!=='claimed'
        ||after.generation!==before.generation||after.claimed_at?.toISOString()!==op.created_at.toISOString()||!after.display_until||after.display_until<=op.created_at
        ||!after.evidence_until||after.evidence_until<=op.created_at||typeof d.secret!=='string'
        ||/^[A-Za-z0-9_-]{43}$/.exec(d.secret)?.[0]!==d.secret||after.grant_digest!==deliveryDigest(d.secret)||typeof d.question!=='string'||after.question_digest!==deliveryDigest(d.question))throw deliveryStorageUnavailable();
      const unchanged={...after,phase:before.phase,grant_id:before.grant_id,grant_digest:before.grant_digest,claimed_at:before.claimed_at,display_until:before.display_until,evidence_until:before.evidence_until};
      if(JSON.stringify(questionOccurrenceCapture(unchanged))!==JSON.stringify(questionOccurrenceCapture(before)))throw deliveryStorageUnavailable();
    }else{
      const q=deliveryRecord(request,['operationId','occurrenceId','grantId','grantDigest','renderOwnerId']);
      if(!before||before.phase!=='claimed'||q.operationId!==op.operation_id||q.occurrenceId!==op.occurrence_id||q.grantId!==before.grant_id||q.grantDigest!==before.grant_digest
        ||q.renderOwnerId!==op.render_owner_id||before.session_hash!==op.session_hash||before.render_owner_id!==op.render_owner_id||after.phase!=='declared'
        ||after.receipt_received_at?.toISOString()!==op.created_at.toISOString()||!before.evidence_until||before.evidence_until<=op.created_at||d.secret!==null||d.question!==null)throw deliveryStorageUnavailable();
      if(JSON.stringify(questionOccurrenceCapture({...after,phase:before.phase,receipt_received_at:before.receipt_received_at}))!==JSON.stringify(questionOccurrenceCapture(before)))throw deliveryStorageUnavailable();
    }
    const capture=questionOperationCapture(op,request,after,d.secret as string|null,d.question as string|null);
    if(JSON.stringify(raw)!==JSON.stringify(capture)||op.journal_digest!==deliveryDigest(JSON.stringify(questionOperationCore(op,request,after,d.secret as string|null,d.question as string|null))))throw deliveryStorageUnavailable();
    latest.set(after.id,after);captures.set(op.operation_id,capture);digest=op.journal_digest;priorTime=op.created_at;
  }
  if(digest!==scope.journal_digest||actual.length!==latest.size||actual.some(row=>{const expected=latest.get(row.id);return !expected||JSON.stringify(questionOccurrenceCapture(row))!==JSON.stringify(questionOccurrenceCapture(expected));}))throw deliveryStorageUnavailable();
  if((await client.query('SELECT 1 FROM platform_safety_question_operations WHERE user_id=$1 AND draft_id=$2 AND created_at>clock_timestamp() LIMIT 1',[scope.user_id,scope.draft_id])).rowCount)throw deliveryStorageUnavailable();
  return {scope,legacy,rows,actual,captures};
}
export async function writeQuestionScope(client:PoolClient,crypto:DataCrypto,scope:QuestionScopeRow,legacyDigest:string){
  const cipher=sealDelivery(crypto,'platform_safety_question_scopes',scope.draft_id,scope.user_id,scope.revision,questionScopeCapture(scope,legacyDigest));
  const result=await client.query<QuestionScopeRow>('UPDATE platform_safety_question_scopes SET revision=$3,latest_operation_id=$4,journal_digest=$5,payload_ciphertext=$6 WHERE user_id=$1 AND draft_id=$2 AND revision=$7 RETURNING *',
    [scope.user_id,scope.draft_id,scope.revision,scope.latest_operation_id,scope.journal_digest,cipher,scope.revision-1]);if(result.rowCount!==1)throw deliveryStorageUnavailable();
  return result.rows[0];
}
