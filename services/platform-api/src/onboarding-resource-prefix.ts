import type { PoolClient } from 'pg';
import { OnboardingStorage, type SafetySubmissionRow } from './onboarding-storage.ts';
import { readIntakeResourceCaptureInTransaction } from './onboarding-resource-source.ts';
import { followupStateCapture, readIntakePublicationCapture, readIntakeSafetyJournal, type IntakeSafetyPublicationRow,
  type IntakeSafetyFollowupRow, type IntakeSafetyProjectionRow, type IntakeSafetyStateRow } from './onboarding-safety-delivery-protocol.ts';
import { deliveryDigest, deliveryHash, deliveryInteger, deliveryRecord, deliveryStorageUnavailable, deliveryUuid } from './safety-delivery-review.ts';

interface PrefixRow { readonly id:string;readonly digest:string; }
/** V2-only arrays are descriptor snapshots. Do not evaluate a caller accessor,
 * skip a hole or accept side properties while constructing a sealed proof. */
export function intakeResourceProofArray(value:unknown):readonly unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw deliveryStorageUnavailable();
  const ds=Object.getOwnPropertyDescriptors(value) as Record<string,PropertyDescriptor>,length=ds.length?.value;
  if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>100000
    ||Reflect.ownKeys(value).length!==length+1||Reflect.ownKeys(value).some(k=>typeof k!=='string'||k!=='length'&&!/^(0|[1-9][0-9]*)$/.test(k)))throw deliveryStorageUnavailable();
  const result:unknown[]=[];
  for(let i=0;i<length;i++){const d=ds[String(i)];if(!d||!('value'in d)||!d.enumerable)throw deliveryStorageUnavailable();result.push(d.value);}
  return Object.freeze(result);
}
export interface IntakeResourcePrefixProof {
  readonly sourceKind:'onboarding';readonly submissionId:string;readonly sourceGeneration:number;readonly publicationId:string;
  readonly publicationDigest:string;readonly publicationOperationId:string;readonly publicationOperationDigest:string;
  readonly assetDigest:string;readonly activationDigest:string;readonly modelUsageDigest:string|null;
  readonly publishedAt:string;readonly journalRevision:number;readonly journalDigest:string;readonly journalStateDigest:string;
  readonly projectionCaptures:readonly PrefixRow[];readonly operationCaptures:readonly PrefixRow[];
  readonly handledOperationId:string;readonly handledAt:string;readonly handledDigest:string;
}
const keys=['sourceKind','submissionId','sourceGeneration','publicationId','publicationDigest','publicationOperationId','publicationOperationDigest',
  'assetDigest','activationDigest','modelUsageDigest','publishedAt','journalRevision','journalDigest','journalStateDigest','projectionCaptures','operationCaptures',
  'handledOperationId','handledAt','handledDigest'] as const;
function iso(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw deliveryStorageUnavailable();return value;}
function captures(value:unknown):readonly PrefixRow[]{const rows=intakeResourceProofArray(value).map(v=>{const d=deliveryRecord(v,['id','digest']);return Object.freeze({id:deliveryUuid(d.id),digest:deliveryHash(d.digest)});});
  if(new Set(rows.map(r=>r.id)).size!==rows.length)throw deliveryStorageUnavailable();return Object.freeze(rows);}
export function parseIntakeResourcePrefixProof(value:unknown):Readonly<IntakeResourcePrefixProof>{
  const d=deliveryRecord(value,keys);if(d.sourceKind!=='onboarding')throw deliveryStorageUnavailable();
  return Object.freeze({sourceKind:'onboarding',submissionId:deliveryUuid(d.submissionId),sourceGeneration:deliveryInteger(d.sourceGeneration,1),publicationId:deliveryUuid(d.publicationId),
    publicationDigest:deliveryHash(d.publicationDigest),publicationOperationId:deliveryUuid(d.publicationOperationId),publicationOperationDigest:deliveryHash(d.publicationOperationDigest),
    assetDigest:deliveryHash(d.assetDigest),activationDigest:deliveryHash(d.activationDigest),modelUsageDigest:d.modelUsageDigest===null?null:deliveryHash(d.modelUsageDigest),
    publishedAt:iso(d.publishedAt),journalRevision:deliveryInteger(d.journalRevision,1),journalDigest:deliveryHash(d.journalDigest),journalStateDigest:deliveryHash(d.journalStateDigest),
    projectionCaptures:captures(d.projectionCaptures),operationCaptures:captures(d.operationCaptures),handledOperationId:deliveryUuid(d.handledOperationId),handledAt:iso(d.handledAt),handledDigest:deliveryHash(d.handledDigest)});
}
/** Genuine original050 body chain. Initial capture authenticates the complete
 * live journal; verification reads only independently captured original IDs,
 * never borrowing a later handling or current reviewed edition. */
export async function intakeResourcePrefixProofs(client:PoolClient,storage:OnboardingStorage,userId:string,draftId:string,
  sources:SafetySubmissionRow[],capturedAt:string,original?:readonly IntakeResourcePrefixProof[]):Promise<readonly IntakeResourcePrefixProof[]>{
  if(!storage.crypto)throw deliveryStorageUnavailable();const cutoff=new Date(iso(capturedAt)),sourceIds=sources.map(s=>s.id);
  const handles=(await client.query<{submission_id:string;publication_id:string;operation_id:string;value:string}>(`SELECT h.*,row_to_json(h)::text AS value FROM platform_onboarding_safety_v2_handled h
    WHERE h.user_id=$1 AND h.submission_id=ANY($2::uuid[]) ${original?'AND h.submission_id=ANY($3::uuid[])':''} ORDER BY h.submission_id FOR SHARE`,
    original?[userId,sourceIds,original.map(p=>p.submissionId)]:[userId,sourceIds])).rows;
  if(original&&handles.length!==original.length)throw deliveryStorageUnavailable();const proofs:IntakeResourcePrefixProof[]=[];
  for(const handle of handles){
    const expected=original?.find(p=>p.submissionId===handle.submission_id),source=sources.find(s=>s.id===handle.submission_id);
    if(!source||source.draft_id!==draftId||source.user_id!==userId||source.level==='L0'||original&&!expected)throw deliveryStorageUnavailable();
    if(expected&&(expected.publicationId!==handle.publication_id||expected.handledOperationId!==handle.operation_id||expected.sourceGeneration!==source.generation))throw deliveryStorageUnavailable();
    const pub=(await client.query<IntakeSafetyPublicationRow>('SELECT * FROM platform_onboarding_safety_v2_publications WHERE id=$1 AND user_id=$2 FOR SHARE',[handle.publication_id,userId])).rows[0];
    const target=await readIntakeResourceCaptureInTransaction(client,storage.crypto,source.id);if(!pub||!target||pub.logical_draft_id!==draftId||pub.published_at>cutoff)throw deliveryStorageUnavailable();
    const actual=await readIntakePublicationCapture(client,storage,pub,target);
    let operations:IntakeSafetyFollowupRow[],projections:IntakeSafetyProjectionRow[],journalRevision:number,journalDigest:string;
    if(expected){
      const state=(await client.query<IntakeSafetyStateRow>('SELECT * FROM platform_onboarding_safety_v2_followup_states WHERE publication_id=$1 AND user_id=$2 FOR SHARE',[pub.id,userId])).rows[0];
      if(!state||state.revision<expected.journalRevision)throw deliveryStorageUnavailable();
      operations=(await client.query<IntakeSafetyFollowupRow>('SELECT * FROM platform_onboarding_safety_v2_followups WHERE publication_id=$1 AND user_id=$2 AND operation_id=ANY($3::uuid[]) ORDER BY applied_revision FOR SHARE',[pub.id,userId,expected.operationCaptures.map(p=>p.id)])).rows;
      projections=(await client.query<IntakeSafetyProjectionRow>('SELECT * FROM platform_onboarding_safety_v2_body_projections WHERE publication_id=$1 AND user_id=$2 AND id=ANY($3::uuid[]) ORDER BY issued_at,id FOR SHARE',[pub.id,userId,expected.projectionCaptures.map(p=>p.id)])).rows;
      if(operations.length!==expected.operationCaptures.length||projections.length!==expected.projectionCaptures.length||operations.length!==expected.journalRevision
        ||operations.some((op,i)=>op.expected_revision!==i||op.applied_revision!==i+1))throw deliveryStorageUnavailable();
      journalRevision=expected.journalRevision;journalDigest=operations.at(-1)!.journal_digest;
      // Later valid operations may advance the mutable head. The independent
      // original IDs/canonical digests prove its historical prefix. If it has
      // not advanced, its actual sealed head must still match exactly.
      if(state.revision===expected.journalRevision){const plain=storage.crypto.openUtf8(state.payload_ciphertext,{table:'platform_onboarding_safety_v2_followup_states',column:'payload_ciphertext',rowId:pub.id,ownerId:userId,revision:state.revision});
        if(deliveryDigest(plain)!==expected.journalStateDigest||plain!==JSON.stringify(followupStateCapture(state,pub)))throw deliveryStorageUnavailable();}
    }else{
      const journal=await readIntakeSafetyJournal(client,storage.crypto,pub,actual.body);
      if(!journal.handled||journal.handled.operation_id!==handle.operation_id)throw deliveryStorageUnavailable();
      operations=journal.operations;projections=journal.projections;journalRevision=journal.state.revision;journalDigest=journal.state.journal_digest;
    }
    const handled=operations.find(op=>op.operation_id===handle.operation_id);
    if(!handled||!handled.handled||!['continue_intake','clarify_exaggeration'].includes(handled.kind)||handled.created_at>cutoff
      ||operations.some(op=>op.created_at>cutoff)||projections.some(p=>p.issued_at>cutoff))throw deliveryStorageUnavailable();
    const state:IntakeSafetyStateRow={publication_id:pub.id,user_id:userId,revision:journalRevision,latest_operation_id:operations.at(-1)!.operation_id,journal_digest:journalDigest,payload_ciphertext:Buffer.alloc(0)};
    const publicationOperation=(await client.query<{payload_ciphertext:Buffer}>('SELECT payload_ciphertext FROM platform_onboarding_delivery_v2_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[userId,pub.publication_operation_id])).rows[0];
    if(!publicationOperation)throw deliveryStorageUnavailable();
    const usage=(await client.query<{value:string}>("SELECT row_to_json(u)::text AS value FROM platform_safety_model_usage u WHERE u.source_kind='onboarding' AND u.submission_id=$1 AND u.generation=$2 ORDER BY u.call_id FOR SHARE",[source.id,source.generation])).rows;
    if(source.detector_mode==='full'&&usage.length!==1)throw deliveryStorageUnavailable();
    const proof:IntakeResourcePrefixProof={sourceKind:'onboarding',submissionId:source.id,sourceGeneration:source.generation,publicationId:pub.id,
      publicationDigest:deliveryDigest(JSON.stringify(actual.capture)),publicationOperationId:pub.publication_operation_id,
      publicationOperationDigest:deliveryDigest(storage.crypto.openUtf8(publicationOperation.payload_ciphertext,{table:'platform_onboarding_delivery_v2_operations',column:'payload_ciphertext',rowId:pub.publication_operation_id,ownerId:userId,revision:1})),
      assetDigest:deliveryDigest(JSON.stringify(actual.assets)),activationDigest:deliveryDigest(JSON.stringify(actual.activation)),modelUsageDigest:usage.length?deliveryDigest(JSON.stringify(usage.map(u=>u.value))):null,
      publishedAt:pub.published_at.toISOString(),journalRevision,journalDigest,journalStateDigest:deliveryDigest(JSON.stringify(followupStateCapture(state,pub))),
      projectionCaptures:projections.map(p=>({id:p.id,digest:deliveryDigest(JSON.stringify({userId:p.user_id,publicationId:p.publication_id,edition:p.edition,bodyDigest:p.body_digest,sessionHash:p.session_hash,issuedAt:p.issued_at.toISOString(),
        plaintext:storage.crypto!.openUtf8(p.payload_ciphertext,{table:'platform_onboarding_safety_v2_body_projections',column:'payload_ciphertext',rowId:p.id,ownerId:userId,revision:1})}))})),
      operationCaptures:operations.map(op=>({id:op.operation_id,digest:deliveryDigest(JSON.stringify({userId:op.user_id,publicationId:op.publication_id,submissionId:op.submission_id,sourceGeneration:op.source_generation,kind:op.kind,
        expectedRevision:op.expected_revision,appliedRevision:op.applied_revision,sessionHash:op.session_hash,bodyProjectionId:op.body_projection_id,bodyDigest:op.body_digest,presentationDigest:op.presentation_digest,
        presentationOperationId:op.presentation_operation_id,acknowledgmentOperationId:op.acknowledgment_operation_id,presentationKind:op.presentation_kind,acknowledgmentKind:op.acknowledgment_kind,
        handled:op.handled,clarifiedAt:op.clarified_at?.toISOString()??null,createdAt:op.created_at.toISOString(),previousDigest:op.previous_digest,journalDigest:op.journal_digest,
        plaintext:storage.crypto!.openUtf8(op.payload_ciphertext,{table:'platform_onboarding_safety_v2_followups',column:'payload_ciphertext',rowId:op.operation_id,ownerId:userId,revision:op.applied_revision})}))})),
      handledOperationId:handle.operation_id,handledAt:handled.created_at.toISOString(),handledDigest:deliveryDigest(handle.value)};
    const canonical=parseIntakeResourcePrefixProof(proof);if(expected&&JSON.stringify(canonical)!==JSON.stringify(expected))throw deliveryStorageUnavailable();proofs.push(canonical);
  }
  return Object.freeze(proofs);
}
