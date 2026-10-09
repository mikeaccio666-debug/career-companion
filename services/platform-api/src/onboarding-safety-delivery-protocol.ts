import type { PoolClient } from 'pg';
import type { IntakeSafetyResourceCommand } from './onboarding-safety-delivery.ts';
import { renderSafetyResponse } from '@companion/career-core';
import { parseNameSafetyPublicationCommand } from '@companion/platform-contracts';
import { OnboardingStorage, type SafetySubmissionRow } from './onboarding-storage.ts';
import { readIntakeResourceCaptureInTransaction } from './onboarding-resource-source.ts';
import { publicSafetyResponseBody } from './safety-response-view.ts';
import { readArchivedDeliveryAssets, readArchivedDeliveryActivation } from './safety-delivery-review.ts';
import type { DataCrypto } from './data-crypto.ts';
import { deliveryDigest, deliveryHash, deliveryRecord, deliveryStorageUnavailable, openDelivery, sealDelivery } from './safety-delivery-review.ts';

export interface IntakeSafetyPublicationRow {
  id:string;user_id:string;submission_id:string;response_id:string;source_generation:number;detector_revision:number;
  level:'L1'|'L2';detector_mode:'full'|'keyword_only';logical_draft_id:string;edition:number;publication_operation_id:string;
  asset_id:string;activation_user_id:string;activation_operation_id:string;activation_kind:'activate';body_digest:string;question_digest:string|null;
  payload_ciphertext:Buffer;prepared_at:Date;published_at:Date;retention_until:Date;evidence_retention_until:Date;
}
export interface IntakeSafetyStateRow {publication_id:string;user_id:string;revision:number;latest_operation_id:string|null;journal_digest:string;payload_ciphertext:Buffer;}
export interface IntakeSafetyProjectionRow {id:string;user_id:string;publication_id:string;edition:number;body_digest:string;session_hash:string;issued_at:Date;payload_ciphertext:Buffer;}
export interface IntakeSafetyFollowupRow {
  user_id:string;operation_id:string;publication_id:string;submission_id:string;source_generation:number;
  kind:IntakeSafetyResourceCommand['action']['kind']|'present_body_evidence';expected_revision:number;applied_revision:number;
  session_hash:string;body_projection_id:string|null;body_digest:string|null;presentation_digest:string|null;
  presentation_operation_id:string|null;acknowledgment_operation_id:string|null;presentation_kind:'present_body'|null;acknowledgment_kind:'acknowledge'|null;
  handled:boolean;clarified_at:Date|null;created_at:Date;previous_digest:string;journal_digest:string;payload_ciphertext:Buffer;
}
export function resourceCanonicalInput(command:IntakeSafetyResourceCommand) {
  const a=command.action;
  return {operationId:command.operationId,publicationId:command.publicationId,expectedPublicationRevision:command.expectedPublicationRevision,
    action:a.kind==='present_body'?{kind:a.kind,bodyProjectionId:a.bodyProjectionId}:a.kind==='need_support'?{kind:a.kind}
      :{kind:a.kind,presentationDigest:deliveryDigest(a.presentationReceipt),...(a.kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})}};
}
export const intakePublicationColumns=['id','user_id','submission_id','response_id','source_generation','detector_revision','level','detector_mode','logical_draft_id',
  'edition','publication_operation_id','asset_id','activation_user_id','activation_operation_id','activation_kind','body_digest','question_digest'] as const;
export function publicationCoordinates(row:IntakeSafetyPublicationRow) {
  return {...Object.fromEntries(intakePublicationColumns.map(k=>[k,row[k]])),preparedAt:row.prepared_at.toISOString(),publishedAt:row.published_at.toISOString(),
    retentionUntil:row.retention_until.toISOString(),evidenceRetentionUntil:row.evidence_retention_until.toISOString()};
}
export function publicationGenesis(row:IntakeSafetyPublicationRow) {
  return deliveryDigest(JSON.stringify({publicationId:row.id,userId:row.user_id,submissionId:row.submission_id,sourceGeneration:row.source_generation,bodyDigest:row.body_digest}));
}
export function followupStateCapture(row:IntakeSafetyStateRow,p:IntakeSafetyPublicationRow) {
  return {schemaVersion:1,publicationId:row.publication_id,userId:row.user_id,submissionId:p.submission_id,sourceGeneration:p.source_generation,
    bodyDigest:p.body_digest,revision:row.revision,latestOperationId:row.latest_operation_id,journalDigest:row.journal_digest};
}
const operationKeys=['user_id','operation_id','publication_id','submission_id','source_generation','kind','expected_revision','applied_revision','session_hash',
  'body_projection_id','body_digest','presentation_digest','presentation_operation_id','acknowledgment_operation_id','presentation_kind','acknowledgment_kind','handled'] as const;
export function followupCore(row:IntakeSafetyFollowupRow,request:unknown,authority:unknown) {
  return {schemaVersion:1,...Object.fromEntries(operationKeys.map(k=>[k,row[k]])),clarifiedAt:row.clarified_at?.toISOString()??null,
    at:row.created_at.toISOString(),request,authority,previousDigest:row.previous_digest};
}
export function followupCapture(row:IntakeSafetyFollowupRow,request:unknown,authority:unknown) {
  return {...followupCore(row,request,authority),journalDigest:row.journal_digest};
}
export function followupDigest(row:IntakeSafetyFollowupRow,request:unknown,authority:unknown) {return deliveryDigest(JSON.stringify(followupCore(row,request,authority)));}
export function bodyProjectionCapture(row:IntakeSafetyProjectionRow,body:unknown) {
  return {schemaVersion:1,id:row.id,userId:row.user_id,publicationId:row.publication_id,edition:row.edition,
    bodyDigest:row.body_digest,sessionHash:row.session_hash,issuedAt:row.issued_at.toISOString(),body};
}
/** Pure original-operation authentication; no current policy or execution grant. */
export function decodeIntakeSafetyFollowup(crypto:DataCrypto,p:IntakeSafetyPublicationRow,r:IntakeSafetyFollowupRow) {
    const raw=openDelivery(crypto,'platform_onboarding_safety_v2_followups',r.operation_id,r.user_id,r.applied_revision,r.payload_ciphertext);
    const data=deliveryRecord(raw,['schemaVersion',...operationKeys,'clarifiedAt','at','request','authority','previousDigest','journalDigest']);
    const request=deliveryRecord(data.request,['operationId','publicationId','expectedPublicationRevision','action']),action=request.action as Record<string,unknown>;
    const publicKind=r.kind==='present_body_evidence'?'present_body':r.kind;
    const a=deliveryRecord(action,publicKind==='present_body'?['kind','bodyProjectionId']:publicKind==='need_support'?['kind']:
      publicKind==='clarify_exaggeration'?['kind','presentationDigest','safe','exaggeration']:['kind','presentationDigest']);
    if(request.operationId!==r.operation_id||request.publicationId!==p.id||request.expectedPublicationRevision!==r.expected_revision||a.kind!==publicKind
      ||publicKind==='present_body'&&a.bodyProjectionId!==r.body_projection_id
      ||'presentationDigest'in a&&a.presentationDigest!==r.presentation_digest
      ||publicKind==='clarify_exaggeration'&&(a.safe!==true||a.exaggeration!==true))throw deliveryStorageUnavailable();
    const authority=deliveryRecord(data.authority,['authVersion','legalVersion']);
    if(r.handled?(typeof authority.authVersion!=='string'||typeof authority.legalVersion!=='string'):(authority.authVersion!==null||authority.legalVersion!==null))throw deliveryStorageUnavailable();
    const capture=followupCapture(r,request,authority);
    if(JSON.stringify(raw)!==JSON.stringify(capture)||r.journal_digest!==followupDigest(r,request,authority))throw deliveryStorageUnavailable();
    return capture;
}
/** Validate only this publication, including its sealed head and EVERY original operation.
 * Rows are never re-counted into a new state after a suffix/projection disappears. */
export async function readIntakeSafetyJournal(client:PoolClient,crypto:DataCrypto,p:IntakeSafetyPublicationRow,body:unknown) {
  const state=(await client.query<IntakeSafetyStateRow>('SELECT * FROM platform_onboarding_safety_v2_followup_states WHERE publication_id=$1 FOR UPDATE',[p.id])).rows[0];
  if(!state||state.user_id!==p.user_id)throw deliveryStorageUnavailable();
  const s=openDelivery(crypto,'platform_onboarding_safety_v2_followup_states',p.id,p.user_id,state.revision,state.payload_ciphertext);
  if(JSON.stringify(s)!==JSON.stringify(followupStateCapture(state,p)))throw deliveryStorageUnavailable();
  const operations=(await client.query<IntakeSafetyFollowupRow>('SELECT * FROM platform_onboarding_safety_v2_followups WHERE publication_id=$1 ORDER BY applied_revision FOR UPDATE',[p.id])).rows;
  if(operations.length!==state.revision||state.latest_operation_id!==(operations.at(-1)?.operation_id??null))throw deliveryStorageUnavailable();
  const projections=(await client.query<IntakeSafetyProjectionRow>('SELECT * FROM platform_onboarding_safety_v2_body_projections WHERE publication_id=$1 ORDER BY issued_at,id FOR SHARE',[p.id])).rows;
  for(const r of projections){
    if(r.user_id!==p.user_id||r.edition!==p.edition||r.body_digest!==p.body_digest||r.issued_at<p.published_at||r.issued_at>=p.retention_until)throw deliveryStorageUnavailable();
    const value=openDelivery(crypto,'platform_onboarding_safety_v2_body_projections',r.id,r.user_id,1,r.payload_ciphertext);
    if(JSON.stringify(value)!==JSON.stringify(bodyProjectionCapture(r,body)))throw deliveryStorageUnavailable();
  }
  let digest=publicationGenesis(p),previousTime=p.published_at;const captures=new Map<string,ReturnType<typeof followupCapture>>();
  for(let i=0;i<operations.length;i++){
    const r=operations[i];if(r.user_id!==p.user_id||r.submission_id!==p.submission_id||r.source_generation!==p.source_generation
      ||r.expected_revision!==i||r.applied_revision!==i+1||r.previous_digest!==digest||r.created_at<previousTime||r.created_at<p.published_at)throw deliveryStorageUnavailable();
    const capture=decodeIntakeSafetyFollowup(crypto,p,r);
    if(r.kind==='present_body_evidence'){
      if(r.created_at<p.retention_until||r.created_at>=p.evidence_retention_until)throw deliveryStorageUnavailable();
    }else if(!r.handled&&r.created_at>=p.retention_until)throw deliveryStorageUnavailable();
    if(r.kind!=='need_support'){
      const projection=projections.find(x=>x.id===r.body_projection_id);
      if(!projection||projection.user_id!==r.user_id||projection.session_hash!==r.session_hash||projection.body_digest!==r.body_digest||projection.issued_at>r.created_at)throw deliveryStorageUnavailable();
      if(r.kind!=='present_body'&&r.kind!=='present_body_evidence'){
        const present=operations.slice(0,i).find(x=>x.operation_id===r.presentation_operation_id);
        if(!present||present.kind!=='present_body'||present.session_hash!==r.session_hash||present.body_projection_id!==r.body_projection_id||present.presentation_digest!==r.presentation_digest)throw deliveryStorageUnavailable();
        if(r.handled){const ack=operations.slice(0,i).find(x=>x.operation_id===r.acknowledgment_operation_id);
          if(!ack||ack.kind!=='acknowledge'||ack.session_hash!==r.session_hash||ack.presentation_operation_id!==present.operation_id||ack.body_projection_id!==present.body_projection_id||ack.presentation_digest!==present.presentation_digest)throw deliveryStorageUnavailable();}
      }
    }
    captures.set(r.operation_id,capture);digest=r.journal_digest;previousTime=r.created_at;
  }
  if(state.journal_digest!==digest)throw deliveryStorageUnavailable();
  if((await client.query(`SELECT 1 FROM platform_onboarding_safety_v2_followups WHERE publication_id=$1 AND created_at>clock_timestamp()
    UNION ALL SELECT 1 FROM platform_onboarding_safety_v2_body_projections WHERE publication_id=$1 AND issued_at>clock_timestamp() LIMIT 1`,[p.id])).rowCount)throw deliveryStorageUnavailable();
  const handled=(await client.query<{submission_id:string;user_id:string;source_generation:number;detector_revision:number;level:string;detector_mode:string;publication_id:string;operation_id:string;kind:string}>('SELECT * FROM platform_onboarding_safety_v2_handled WHERE submission_id=$1 FOR SHARE',[p.submission_id])).rows[0];
  const ownHandled=operations.filter(r=>r.handled);
  if(ownHandled.length>1||ownHandled.length===1&&(!handled||handled.user_id!==p.user_id||handled.publication_id!==p.id||handled.operation_id!==ownHandled[0].operation_id
    ||handled.source_generation!==p.source_generation||handled.detector_revision!==p.detector_revision||handled.level!==p.level||handled.detector_mode!==p.detector_mode||handled.kind!==ownHandled[0].kind))throw deliveryStorageUnavailable();
  if(handled?.publication_id===p.id&&ownHandled.length!==1)throw deliveryStorageUnavailable();
  return {state,operations,captures,projections,handled};
}
export async function writeIntakeSafetyState(client:PoolClient,crypto:DataCrypto,p:IntakeSafetyPublicationRow,row:IntakeSafetyStateRow) {
  const cipher=sealDelivery(crypto,'platform_onboarding_safety_v2_followup_states',p.id,p.user_id,row.revision,followupStateCapture(row,p));
  const found=await client.query(`UPDATE platform_onboarding_safety_v2_followup_states SET revision=$2,latest_operation_id=$3,journal_digest=$4,payload_ciphertext=$5
    WHERE publication_id=$1 AND revision=$6 RETURNING publication_id`,[p.id,row.revision,row.latest_operation_id,deliveryHash(row.journal_digest),cipher,row.revision-1]);
  if(found.rowCount!==1)throw deliveryStorageUnavailable();
}

export interface PublicationOperation {user_id:string;operation_id:string;submission_id:string;source_generation:number;publication_id:string;kind:'publish'|'recover';expected_edition:number;session_hash:string;payload_ciphertext:Buffer;created_at:Date;}
export function decodeIntakePublicationOperation(storage:OnboardingStorage,row:PublicationOperation){
 const raw=openDelivery(storage.crypto!,'platform_onboarding_delivery_v2_operations',row.operation_id,row.user_id,1,row.payload_ciphertext);
 const d=deliveryRecord(raw,['schemaVersion','userId','operationId','submissionId','sourceGeneration','publicationId','kind','expectedEdition','sessionHash','at','request']);
 const request=parseNameSafetyPublicationCommand(d.request);
 const expected={schemaVersion:1,userId:row.user_id,operationId:row.operation_id,submissionId:row.submission_id,sourceGeneration:row.source_generation,publicationId:row.publication_id,
 kind:row.kind,expectedEdition:row.expected_edition,sessionHash:row.session_hash,at:row.created_at.toISOString(),request};
 if(request.operationId!==row.operation_id||request.submissionId!==row.submission_id||request.expectedEdition!==row.expected_edition||JSON.stringify(raw)!==JSON.stringify(expected))throw deliveryStorageUnavailable();return request;
}
export async function readIntakePublicationCapture(client:PoolClient,storage:OnboardingStorage,r:IntakeSafetyPublicationRow,
 original:NonNullable<Awaited<ReturnType<typeof readIntakeResourceCaptureInTransaction>>>,lock=true){
    const t=original.target,source=t.source;
    if(r.user_id!==source.user_id||r.submission_id!==source.id||r.response_id!==original.row.id||r.source_generation!==source.generation
      ||r.detector_revision!==source.detector_revision||r.level!==t.decision.level||r.detector_mode!==t.decision.mode
      ||r.logical_draft_id!==t.source.draft_id||r.prepared_at.toISOString()!==r.published_at.toISOString()
      ||r.prepared_at<original.row.prepared_at!)throw deliveryStorageUnavailable();
    const a=await readArchivedDeliveryAssets(client,storage.crypto!,r.asset_id,lock);
    const activation=await readArchivedDeliveryActivation(client,storage.crypto!,a.id,r.activation_user_id,r.activation_operation_id,lock);
    if(Date.parse(activation.at)>r.prepared_at.getTime())throw deliveryStorageUnavailable();
    const locale=original.row.locale!;
    const response=renderSafetyResponse({level:r.level,locale,templateFromBundle:a.bundle.locales[locale],contactsFromBundle:a.bundle.resources.contacts,
      outsideUsTranslation:a.bundle.resources.outsideUs[locale],companionName:locale==='en'?'Your companion':'你的主理人',userName:'',askSafetyQuestion:r.level==='L2'});
    const body=publicSafetyResponseBody(response),questionDigest=response.question===undefined?null:deliveryDigest(response.question);
    const capture={schemaVersion:1,...publicationCoordinates(r),activation,locale,response};
    const actual=openDelivery(storage.crypto!,'platform_onboarding_safety_v2_publications',r.id,r.user_id,1,r.payload_ciphertext);
    const dates=await client.query(`SELECT $1::timestamptz<=clock_timestamp() AND $2::timestamptz=$1::timestamptz+($4::int*interval '1 day')
      AND $3::timestamptz=$1::timestamptz+($5::int*interval '1 day') AS actual`,[r.prepared_at,r.retention_until,r.evidence_retention_until,a.bundle.retentionDays,a.review.evidenceRetentionDays]);
    if(r.body_digest!==deliveryDigest(JSON.stringify(body))||r.question_digest!==questionDigest||JSON.stringify(actual)!==JSON.stringify(capture)||dates.rows[0].actual!==true)throw deliveryStorageUnavailable();
    const request=(await client.query<PublicationOperation>(`SELECT * FROM platform_onboarding_delivery_v2_operations WHERE user_id=$1 AND operation_id=$2${lock?' FOR SHARE':''}`,[r.user_id,r.publication_operation_id])).rows[0];
    if(!request||request.publication_id!==r.id||request.submission_id!==r.submission_id||request.source_generation!==r.source_generation)throw deliveryStorageUnavailable();
    decodeIntakePublicationOperation(storage,request);return {row:r,target:t,original,assets:a,activation,response,body,capture};
}
/** Current execution composers consume only this authentic source-bound handling fact. */
export async function readHandledIntakeV2Sources(client:PoolClient,storage:OnboardingStorage,draft:{id:string;userId:string},sources:SafetySubmissionRow[]):Promise<ReadonlySet<string>>{
 const rows=(await client.query<{submission_id:string;publication_id:string}>('SELECT submission_id,publication_id FROM platform_onboarding_safety_v2_handled WHERE user_id=$1 FOR SHARE',[draft.userId])).rows;
 const handled=new Set<string>();
 for(const h of rows){const source=sources.find(x=>x.id===h.submission_id);if(!source||source.draft_id!==draft.id)throw deliveryStorageUnavailable();
  const p=(await client.query<IntakeSafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_v2_publications WHERE id=$1 AND user_id=$2 FOR UPDATE',[h.publication_id,draft.userId])).rows[0];
  const original=await readIntakeResourceCaptureInTransaction(client,storage.crypto,source.id);if(!p||!original)throw deliveryStorageUnavailable();
  const record=await readIntakePublicationCapture(client,storage,p,original),journal=await readIntakeSafetyJournal(client,storage.crypto!,p,record.body);
  if(!journal.handled||!journal.operations.some(x=>x.handled&&x.operation_id===journal.handled!.operation_id))throw deliveryStorageUnavailable();handled.add(source.id);
 }
 return handled;
}
