import {createHash} from 'node:crypto';
import type {CapturedCompanionAnswers} from './companion-captured-answers.ts';
import {decodeCompanionSourcePrefix,type CompanionSourcePrefixBinding} from './companion-source-prefix.ts';
import type {PlatformConfig} from './config.ts';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row=Record<string,any>;
// Positive field lists are intentional: auth versions, session hashes and
// hashes derived from execution credentials are nested in the original manifest.
const fields={
 operations:['operationId','appliedRevision','createdAt'],
 submissions:['submissionId','operationId','questionId','submittedRevision','status','generation','detectorRevision','originalLevel','originalDetectorMode','createdAt','updatedAt'],
 responses:['responseId','submissionId','operationId','questionId','submittedRevision','sourceGeneration','detectorRevision','originalLevel','originalDetectorMode','status','bundleRevision','locale','createdAt','preparedAt','retentionUntil'],
 events:['eventId','responseId','submissionId','sourceKind','eventKind','originalLevel','detectorRevision','originalDetectorMode','createdAt','retentionUntil'],
 publications:['publicationId','responseId','submissionId','sourceGeneration','publishedAt','retentionUntil'],
 followups:['operationId','publicationId','actionKind','expectedRevision','appliedRevision','presentationOperationId','acknowledgmentOperationId','handled','clarifiedAt','createdAt','resumeStatus'],
} as const;
/** Saved source coordinates, not a new proof that current source rows match or
 * permission to use them. Historical source content is exported by its own reader. */
export function projectCompanionSourceManifest(crypto:PlatformConfig['dataCrypto'],row:Row,task:Row,seed:Row,answers:Readonly<CapturedCompanionAnswers>){
 const {sourceReceiptVersion:_version,sourceReceiptDigest:receiptDigest,...originalSeed}=seed;
 const binding:CompanionSourcePrefixBinding={taskId:task.id,userId:task.user_id,companionId:task.companion_id,answersId:task.answers_id,
  sourceDraftId:task.source_draft_id,sourceRevision:task.source_revision,authVersion:String(task.auth_version),questionnaireRevision:1,
  rulesRevision:1,generatorVersion:1,purpose:'companion_preview',canonicalAnswersDigest:hash(answers),canonicalSeedDigest:hash(originalSeed)};
 const saved=decodeCompanionSourcePrefix(crypto,row,binding,receiptDigest);
 const groups=Object.fromEntries(Object.entries(fields).map(([group,keys])=>[group,saved[group as keyof typeof fields].map(entry=>
  Object.fromEntries(keys.map(key=>[key,entry[key]])))]));
 return {schemaVersion:saved.schemaVersion,manifestId:saved.manifestId,taskId:saved.taskId,ownerId:saved.userId,
  companionId:saved.companionId,answersId:saved.answersId,sourceDraftId:saved.sourceDraftId,sourceRevision:saved.sourceRevision,
  questionnaireRevision:saved.questionnaireRevision,rulesRevision:saved.rulesRevision,generatorVersion:saved.generatorVersion,
  purpose:saved.purpose,capturedAt:saved.capturedAt,...groups,handledSubmissionIds:[...saved.handledSubmissionIds],
  ...(saved.intakeResources?{intakeResources:saved.intakeResources.map(proof=>({sourceKind:proof.sourceKind,submissionId:proof.submissionId,
   sourceGeneration:proof.sourceGeneration,publicationId:proof.publicationId,publicationOperationId:proof.publicationOperationId,
   publishedAt:proof.publishedAt,journalRevision:proof.journalRevision,projectionIds:proof.projectionCaptures.map(item=>item.id),
   operationIds:proof.operationCaptures.map(item=>item.id),handledOperationId:proof.handledOperationId,handledAt:proof.handledAt}))}:{})};
}
