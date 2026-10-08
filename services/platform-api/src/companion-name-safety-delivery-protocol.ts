import type { PoolClient } from 'pg';
import type { NameSafetyResourceCommand } from '@companion/platform-contracts';
import type { DataCrypto } from './data-crypto.ts';
import { deliveryDigest, deliveryHash, deliveryRecord, deliveryStorageUnavailable, openDelivery, sealDelivery } from './safety-delivery-review.ts';

export interface NameSafetyPublicationRow {
  id:string;user_id:string;submission_id:string;response_id:string;source_generation:number;detector_revision:number;
  level:'L1'|'L2';detector_mode:'full'|'keyword_only';logical_draft_id:string;edition:number;publication_operation_id:string;
  asset_id:string;activation_user_id:string;activation_operation_id:string;activation_kind:'activate';body_digest:string;question_digest:string|null;
  payload_ciphertext:Buffer;prepared_at:Date;published_at:Date;retention_until:Date;evidence_retention_until:Date;
}
export interface NameSafetyStateRow {publication_id:string;user_id:string;revision:number;latest_operation_id:string|null;journal_digest:string;payload_ciphertext:Buffer;}
export interface NameSafetyProjectionRow {id:string;user_id:string;publication_id:string;edition:number;body_digest:string;session_hash:string;issued_at:Date;payload_ciphertext:Buffer;}
export interface NameSafetyFollowupRow {
  user_id:string;operation_id:string;publication_id:string;submission_id:string;source_generation:number;
  kind:NameSafetyResourceCommand['action']['kind']|'present_body_evidence';expected_revision:number;applied_revision:number;
  session_hash:string;body_projection_id:string|null;body_digest:string|null;presentation_digest:string|null;
  presentation_operation_id:string|null;acknowledgment_operation_id:string|null;presentation_kind:'present_body'|null;acknowledgment_kind:'acknowledge'|null;
  handled:boolean;clarified_at:Date|null;created_at:Date;previous_digest:string;journal_digest:string;payload_ciphertext:Buffer;
}
export function resourceCanonicalInput(command:NameSafetyResourceCommand) {
  const a=command.action;
  return {operationId:command.operationId,publicationId:command.publicationId,expectedPublicationRevision:command.expectedPublicationRevision,
    action:a.kind==='present_body'?{kind:a.kind,bodyProjectionId:a.bodyProjectionId}:a.kind==='need_support'?{kind:a.kind}
      :{kind:a.kind,presentationDigest:deliveryDigest(a.presentationReceipt),...(a.kind==='clarify_exaggeration'?{safe:true,exaggeration:true}:{})}};
}
export const namePublicationColumns=['id','user_id','submission_id','response_id','source_generation','detector_revision','level','detector_mode','logical_draft_id',
  'edition','publication_operation_id','asset_id','activation_user_id','activation_operation_id','activation_kind','body_digest','question_digest'] as const;
export function publicationCoordinates(row:NameSafetyPublicationRow) {
  return {...Object.fromEntries(namePublicationColumns.map(k=>[k,row[k]])),preparedAt:row.prepared_at.toISOString(),publishedAt:row.published_at.toISOString(),
    retentionUntil:row.retention_until.toISOString(),evidenceRetentionUntil:row.evidence_retention_until.toISOString()};
}
export function publicationGenesis(row:NameSafetyPublicationRow) {
  return deliveryDigest(JSON.stringify({publicationId:row.id,userId:row.user_id,submissionId:row.submission_id,sourceGeneration:row.source_generation,bodyDigest:row.body_digest}));
}
export function followupStateCapture(row:NameSafetyStateRow,p:NameSafetyPublicationRow) {
  return {schemaVersion:1,publicationId:row.publication_id,userId:row.user_id,submissionId:p.submission_id,sourceGeneration:p.source_generation,
    bodyDigest:p.body_digest,revision:row.revision,latestOperationId:row.latest_operation_id,journalDigest:row.journal_digest};
}
const operationKeys=['user_id','operation_id','publication_id','submission_id','source_generation','kind','expected_revision','applied_revision','session_hash',
  'body_projection_id','body_digest','presentation_digest','presentation_operation_id','acknowledgment_operation_id','presentation_kind','acknowledgment_kind','handled'] as const;
export function followupCore(row:NameSafetyFollowupRow,request:unknown,authority:unknown) {
  return {schemaVersion:1,...Object.fromEntries(operationKeys.map(k=>[k,row[k]])),clarifiedAt:row.clarified_at?.toISOString()??null,
    at:row.created_at.toISOString(),request,authority,previousDigest:row.previous_digest};
}
export function followupCapture(row:NameSafetyFollowupRow,request:unknown,authority:unknown) {
  return {...followupCore(row,request,authority),journalDigest:row.journal_digest};
}
export function followupDigest(row:NameSafetyFollowupRow,request:unknown,authority:unknown) {return deliveryDigest(JSON.stringify(followupCore(row,request,authority)));}
export function bodyProjectionCapture(row:NameSafetyProjectionRow,body:unknown) {
  return {schemaVersion:1,id:row.id,userId:row.user_id,publicationId:row.publication_id,edition:row.edition,
    bodyDigest:row.body_digest,sessionHash:row.session_hash,issuedAt:row.issued_at.toISOString(),body};
}
/** Validate only this publication, including its sealed head and EVERY original operation.
 * Rows are never re-counted into a new state after a suffix/projection disappears. */
export async function readNameSafetyJournal(client:PoolClient,crypto:DataCrypto,p:NameSafetyPublicationRow,body:unknown) {
  const state=(await client.query<NameSafetyStateRow>('SELECT * FROM platform_companion_name_safety_followup_states WHERE publication_id=$1 FOR UPDATE',[p.id])).rows[0];
  if(!state||state.user_id!==p.user_id)throw deliveryStorageUnavailable();
  const s=openDelivery(crypto,'platform_companion_name_safety_followup_states',p.id,p.user_id,state.revision,state.payload_ciphertext);
  if(JSON.stringify(s)!==JSON.stringify(followupStateCapture(state,p)))throw deliveryStorageUnavailable();
  const operations=(await client.query<NameSafetyFollowupRow>('SELECT * FROM platform_companion_name_safety_followups WHERE publication_id=$1 ORDER BY applied_revision FOR UPDATE',[p.id])).rows;
  if(operations.length!==state.revision||state.latest_operation_id!==(operations.at(-1)?.operation_id??null))throw deliveryStorageUnavailable();
  const projections=(await client.query<NameSafetyProjectionRow>('SELECT * FROM platform_companion_name_safety_body_projections WHERE publication_id=$1 ORDER BY issued_at,id FOR SHARE',[p.id])).rows;
  for(const r of projections){
    if(r.user_id!==p.user_id||r.edition!==p.edition||r.body_digest!==p.body_digest||r.issued_at<p.published_at||r.issued_at>=p.retention_until)throw deliveryStorageUnavailable();
    const value=openDelivery(crypto,'platform_companion_name_safety_body_projections',r.id,r.user_id,1,r.payload_ciphertext);
    if(JSON.stringify(value)!==JSON.stringify(bodyProjectionCapture(r,body)))throw deliveryStorageUnavailable();
  }
  let digest=publicationGenesis(p),previousTime=p.published_at;const captures=new Map<string,ReturnType<typeof followupCapture>>();
  for(let i=0;i<operations.length;i++){
    const r=operations[i];if(r.user_id!==p.user_id||r.submission_id!==p.submission_id||r.source_generation!==p.source_generation
      ||r.expected_revision!==i||r.applied_revision!==i+1||r.previous_digest!==digest||r.created_at<previousTime||r.created_at<p.published_at)throw deliveryStorageUnavailable();
    const raw=openDelivery(crypto,'platform_companion_name_safety_followups',r.operation_id,r.user_id,r.applied_revision,r.payload_ciphertext);
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
  if((await client.query(`SELECT 1 FROM platform_companion_name_safety_followups WHERE publication_id=$1 AND created_at>clock_timestamp()
    UNION ALL SELECT 1 FROM platform_companion_name_safety_body_projections WHERE publication_id=$1 AND issued_at>clock_timestamp() LIMIT 1`,[p.id])).rowCount)throw deliveryStorageUnavailable();
  const handled=(await client.query<{submission_id:string;user_id:string;source_generation:number;detector_revision:number;level:string;detector_mode:string;publication_id:string;operation_id:string;kind:string}>('SELECT * FROM platform_companion_name_safety_handled WHERE submission_id=$1 FOR SHARE',[p.submission_id])).rows[0];
  const ownHandled=operations.filter(r=>r.handled);
  if(ownHandled.length>1||ownHandled.length===1&&(!handled||handled.user_id!==p.user_id||handled.publication_id!==p.id||handled.operation_id!==ownHandled[0].operation_id
    ||handled.source_generation!==p.source_generation||handled.detector_revision!==p.detector_revision||handled.level!==p.level||handled.detector_mode!==p.detector_mode||handled.kind!==ownHandled[0].kind))throw deliveryStorageUnavailable();
  if(handled?.publication_id===p.id&&ownHandled.length!==1)throw deliveryStorageUnavailable();
  return {state,operations,captures,projections,handled};
}
export async function writeNameSafetyState(client:PoolClient,crypto:DataCrypto,p:NameSafetyPublicationRow,row:NameSafetyStateRow) {
  const cipher=sealDelivery(crypto,'platform_companion_name_safety_followup_states',p.id,p.user_id,row.revision,followupStateCapture(row,p));
  const found=await client.query(`UPDATE platform_companion_name_safety_followup_states SET revision=$2,latest_operation_id=$3,journal_digest=$4,payload_ciphertext=$5
    WHERE publication_id=$1 AND revision=$6 RETURNING publication_id`,[p.id,row.revision,row.latest_operation_id,deliveryHash(row.journal_digest),cipher,row.revision-1]);
  if(found.rowCount!==1)throw deliveryStorageUnavailable();
}
