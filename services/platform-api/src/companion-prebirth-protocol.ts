import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DataCrypto } from './data-crypto.ts';
import { OnboardingStorage, type IntakeOperationRow, type SafetySubmissionRow } from './onboarding-storage.ts';
import { readNameRawSourceInTransaction } from './companion-name-resource-source.ts';
import { ApiError } from './errors.ts';

export const prebirthInventoryUnavailable = () => new ApiError(503,'COMPANION_PREBIRTH_INVENTORY_UNAVAILABLE','The complete private prebirth source inventory could not be confirmed.');
type Kind = 'intake_operation'|'name_entry'|'name_submission';
interface Coordinates {
  intakeDraftId:string|null; intakeOperationId:string|null; intakeRevision:number|null; intakeSubmissionId:string|null; intakeQuestionId:string|null;
  nameEntryId:string|null; nameSubmissionId:string|null; nameOperationId:string|null; nameTaskId:string|null; nameCompanionId:string|null;
  namePreviewRevision:number|null; nameSubmittedRevision:number|null; nameExpectedIdentityRevision:number|null;
}
interface Observation { kind:Kind; sourceId:string; coordinates:Coordinates; sourceDigest:string; }
interface Head { user_id:string; revision:number; adopted_at:Date; tip_id:string|null; tip_digest:string; payload_ciphertext:Buffer; }
interface Enrollment {
  id:string; user_id:string; revision:number; kind:Kind; source_id:string; source_digest:string; chain_digest:string; enrolled_at:Date; payload_ciphertext:Buffer;
  intake_draft_id:string|null; intake_operation_id:string|null; intake_revision:number|null; intake_submission_id:string|null; intake_question_id:string|null;
  name_entry_id:string|null; name_submission_id:string|null; name_operation_id:string|null; name_task_id:string|null; name_companion_id:string|null;
  name_preview_revision:number|null; name_submitted_revision:number|null; name_expected_identity_revision:number|null;
}
const digest = (text:string) => createHash('sha256').update(text,'utf8').digest('hex');
const zero = '0'.repeat(64);
const empty = ():Coordinates => ({intakeDraftId:null,intakeOperationId:null,intakeRevision:null,intakeSubmissionId:null,intakeQuestionId:null,
  nameEntryId:null,nameSubmissionId:null,nameOperationId:null,nameTaskId:null,nameCompanionId:null,namePreviewRevision:null,
  nameSubmittedRevision:null,nameExpectedIdentityRevision:null});
const coordinates = (row:Enrollment):Coordinates => ({intakeDraftId:row.intake_draft_id,intakeOperationId:row.intake_operation_id,
  intakeRevision:row.intake_revision,intakeSubmissionId:row.intake_submission_id,intakeQuestionId:row.intake_question_id,
  nameEntryId:row.name_entry_id,nameSubmissionId:row.name_submission_id,nameOperationId:row.name_operation_id,nameTaskId:row.name_task_id,
  nameCompanionId:row.name_companion_id,namePreviewRevision:row.name_preview_revision,nameSubmittedRevision:row.name_submitted_revision,
  nameExpectedIdentityRevision:row.name_expected_identity_revision});
const key = (row:Observation) => `${row.kind}:${row.sourceId}`;
const descriptor = (row:Observation) => ({kind:row.kind,sourceId:row.sourceId,coordinates:row.coordinates,sourceDigest:row.sourceDigest});
const headPayload = (head:Head) => ({schemaVersion:1,userId:head.user_id,revision:head.revision,adoptedAt:head.adopted_at.toISOString(),
  tipId:head.tip_id,tipDigest:head.tip_digest});
const unsignedPayload = (row:Enrollment,head:Head,previousDigest:string) => ({schemaVersion:1,id:row.id,userId:row.user_id,
  revision:row.revision,kind:row.kind,sourceId:row.source_id,coordinates:coordinates(row),sourceDigest:row.source_digest,
  previousDigest,adoptedAt:head.adopted_at.toISOString(),enrolledAt:row.enrolled_at.toISOString()});
const payload = (row:Enrollment,head:Head,previousDigest:string) => ({...unsignedPayload(row,head,previousDigest),digest:row.chain_digest});

/** Enumerate and authenticate original raw records. Mutable detection progress,
 * identity, current preview and safety grades are deliberately not inputs. */
async function observe(client:PoolClient,crypto:DataCrypto,userId:string,signal?:AbortSignal):Promise<Observation[]> {
  const storage = new OnboardingStorage({dataCrypto:crypto,requireVerifiedEmail:false},null), observations:Observation[]=[];
  const draftRow = await storage.row(client,userId), draft = draftRow ? storage.decode(draftRow) : null;
  const operations = (await client.query<IntakeOperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision,operation_id FOR UPDATE',[userId])).rows;
  const submissions = (await client.query<SafetySubmissionRow>('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision,id FOR UPDATE',[userId])).rows;
  const seenRevisions = new Set<number>(), textIds = new Set<string>();
  for (const row of operations) {
    if (!draft || row.draft_id !== draft.id || row.applied_revision > draft.revision || seenRevisions.has(row.applied_revision)) throw prebirthInventoryUnavailable();
    seenRevisions.add(row.applied_revision);
    const command = storage.decodeOperation(row,userId), text = crypto.openUtf8(row.request_ciphertext,{table:'platform_onboarding_operations',column:'request_ciphertext',rowId:row.operation_id,ownerId:userId,revision:row.applied_revision});
    if (text !== JSON.stringify(command)) throw prebirthInventoryUnavailable();
    const c = {...empty(),intakeDraftId:row.draft_id,intakeOperationId:row.operation_id,intakeRevision:row.applied_revision};
    if (command.action.kind === 'text') {
      const source = submissions.find(item=>item.operation_id===row.operation_id);
      if (!source || source.draft_id !== row.draft_id || source.submitted_revision !== row.applied_revision || source.question_id !== command.action.questionId) throw prebirthInventoryUnavailable();
      c.intakeSubmissionId=source.id; c.intakeQuestionId=source.question_id; textIds.add(source.id);
    }
    observations.push({kind:'intake_operation',sourceId:row.operation_id,coordinates:c,sourceDigest:digest(text)});
  }
  if (submissions.length !== textIds.size || submissions.some(row=>!textIds.has(row.id))) throw prebirthInventoryUnavailable();
  const entries = (await client.query<{id:string;user_id:string;task_id:string;companion_id:string;preview_revision:number;revision:number;latest_submission_id:string;payload_ciphertext:Buffer}>(
    'SELECT * FROM platform_companion_name_entries WHERE user_id=$1 ORDER BY task_id,id FOR UPDATE',[userId])).rows;
  const rawRows = (await client.query<{id:string;entry_id:string;submitted_revision:number}>('SELECT id,entry_id,submitted_revision FROM platform_companion_name_submissions WHERE user_id=$1 ORDER BY entry_id,submitted_revision,id FOR UPDATE',[userId])).rows;
  let observedNames=0;
  for (const entry of entries) {
    const rows=rawRows.filter(row=>row.entry_id===entry.id);
    if (entry.preview_revision!==1 || rows.length!==entry.revision || rows.at(-1)?.id!==entry.latest_submission_id) throw prebirthInventoryUnavailable();
    let originalPreview:unknown;
    for (let index=0;index<rows.length;index++) {
      if (rows[index].submitted_revision!==index+1) throw prebirthInventoryUnavailable();
      const raw=await readNameRawSourceInTransaction(client,crypto,rows[index].id,signal), row=raw.source, capture=raw.sourceCapture;
      if (row.user_id!==userId || row.entry_id!==entry.id) throw prebirthInventoryUnavailable();
      if (index===0) originalPreview=capture.previewCapture;
      else if (JSON.stringify(capture.previewCapture)!==JSON.stringify(originalPreview)) throw prebirthInventoryUnavailable();
      observations.push({kind:'name_submission',sourceId:row.id,coordinates:{...empty(),nameEntryId:row.entry_id,nameSubmissionId:row.id,
        nameOperationId:row.operation_id,nameTaskId:row.task_id,nameCompanionId:row.companion_id,namePreviewRevision:row.preview_revision,
        nameSubmittedRevision:row.submitted_revision,nameExpectedIdentityRevision:row.expected_identity_revision},sourceDigest:digest(JSON.stringify(capture))});
      observedNames++;
    }
    const stable={id:entry.id,userId:userId,taskId:entry.task_id,companionId:entry.companion_id,previewRevision:1};
    const text=crypto.openUtf8(entry.payload_ciphertext,{table:'platform_companion_name_entries',column:'payload_ciphertext',rowId:entry.id,ownerId:userId,revision:entry.revision});
    if (text!==JSON.stringify({schemaVersion:1,...stable,revision:entry.revision,latestSubmissionId:entry.latest_submission_id,previewCapture:originalPreview})) throw prebirthInventoryUnavailable();
    observations.push({kind:'name_entry',sourceId:entry.id,coordinates:{...empty(),nameEntryId:entry.id,nameTaskId:entry.task_id,
      nameCompanionId:entry.companion_id,namePreviewRevision:1},sourceDigest:digest(JSON.stringify(stable))});
  }
  if (observedNames!==rawRows.length) throw prebirthInventoryUnavailable();
  signal?.throwIfAborted(); return observations.sort((a,b)=>key(a).localeCompare(key(b),'en'));
}
async function read(client:PoolClient,crypto:DataCrypto|undefined,userId:string,signal?:AbortSignal) {
  signal?.throwIfAborted(); if(!crypto) throw prebirthInventoryUnavailable();
  const owner=(await client.query<{account_kind:string;prebirth_inventory_owner_id:string|null}>('SELECT account_kind,prebirth_inventory_owner_id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId])).rows[0];
  if (!owner || owner.account_kind!=='student') throw prebirthInventoryUnavailable();
  const head=(await client.query<Head>('SELECT * FROM platform_companion_prebirth_heads WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
  const rows=(await client.query<Enrollment>('SELECT * FROM platform_companion_prebirth_inventory WHERE user_id=$1 ORDER BY revision,id FOR UPDATE',[userId])).rows;
  if (owner.prebirth_inventory_owner_id===null) {
    if (head || rows.length) throw prebirthInventoryUnavailable();
    return {head:undefined,rows,crypto}; // A virgin legacy owner, not a missing adopted history.
  }
  if (owner.prebirth_inventory_owner_id!==userId || !head || head.revision!==rows.length) throw prebirthInventoryUnavailable();
  if (crypto.openUtf8(head.payload_ciphertext,{table:'platform_companion_prebirth_heads',column:'payload_ciphertext',rowId:userId,ownerId:userId,revision:head.revision})!==JSON.stringify(headPayload(head))) throw prebirthInventoryUnavailable();
  let previous=zero;
  for (let index=0;index<rows.length;index++) {
    const row=rows[index];
    if (row.user_id!==userId || row.revision!==index+1 || row.enrolled_at<head.adopted_at || row.chain_digest!==digest(JSON.stringify(unsignedPayload(row,head,previous)))
      || crypto.openUtf8(row.payload_ciphertext,{table:'platform_companion_prebirth_inventory',column:'payload_ciphertext',rowId:row.id,ownerId:userId,revision:row.revision})!==JSON.stringify(payload(row,head,previous))) throw prebirthInventoryUnavailable();
    previous=row.chain_digest;
  }
  if (head.tip_digest!==previous || head.tip_id!==(rows.at(-1)?.id??null)) throw prebirthInventoryUnavailable();
  return {head,rows,crypto};
}
function match(rows:Enrollment[],observations:Observation[],allowAppend:boolean) {
  const map=new Map(observations.map(row=>[key(row),row]));
  for (const row of rows) {
    const current=map.get(`${row.kind}:${row.source_id}`);
    if (!current || JSON.stringify(descriptor(current))!==JSON.stringify(descriptor({kind:row.kind,sourceId:row.source_id,coordinates:coordinates(row),sourceDigest:row.source_digest}))) throw prebirthInventoryUnavailable();
  }
  if(!allowAppend && rows.length!==observations.length) throw prebirthInventoryUnavailable();
}
/** Verification cannot initialize, repair or resign a missing adopted history.
 * NULL legacy roots are explicitly adopted by sync in the same owner transaction. */
export async function verifyPrebirthInventoryInTransaction(client:PoolClient,crypto:DataCrypto|undefined,userId:string,signal?:AbortSignal):Promise<void> {
  try {const state=await read(client,crypto,userId,signal); if(state.head) match(state.rows,await observe(client,state.crypto,userId,signal),false);}
  catch(error) {if(signal?.aborted) signal.throwIfAborted(); if(error instanceof ApiError && error.code==='AUTH_REQUIRED') throw error; throw prebirthInventoryUnavailable();}
}
/** Called by every authentic raw writer, and explicitly by first composition.
 * Only actual canonical records are appended. No safety result is manufactured. */
export async function syncPrebirthInventoryInTransaction(client:PoolClient,crypto:DataCrypto|undefined,userId:string,signal?:AbortSignal):Promise<void> {
  try {
    const state=await read(client,crypto,userId,signal), observations=await observe(client,state.crypto,userId,signal);
    match(state.rows,observations,true);
    let head=state.head;
    const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
    if (!head) {
      head={user_id:userId,revision:0,adopted_at:at,tip_id:null,tip_digest:zero,payload_ciphertext:Buffer.alloc(0)};
      head.payload_ciphertext=state.crypto.sealUtf8(JSON.stringify(headPayload(head)),{table:'platform_companion_prebirth_heads',column:'payload_ciphertext',rowId:userId,ownerId:userId,revision:0});
      await client.query('INSERT INTO platform_companion_prebirth_heads(user_id,revision,adopted_at,tip_id,tip_digest,payload_ciphertext) VALUES($1,0,$2,NULL,$3,$4)',[userId,at,zero,head.payload_ciphertext]);
      await client.query('UPDATE platform_users SET prebirth_inventory_owner_id=$1 WHERE id=$1 AND prebirth_inventory_owner_id IS NULL',[userId]);
    }
    const known=new Set(state.rows.map(row=>`${row.kind}:${row.source_id}`)), originalRevision=head.revision;
    for (const observed of observations.filter(row=>!known.has(key(row)))) {
      const c=observed.coordinates, row:Enrollment={id:randomUUID(),user_id:userId,revision:head.revision+1,kind:observed.kind,source_id:observed.sourceId,
        source_digest:observed.sourceDigest,chain_digest:'',enrolled_at:at,payload_ciphertext:Buffer.alloc(0),
        intake_draft_id:c.intakeDraftId,intake_operation_id:c.intakeOperationId,intake_revision:c.intakeRevision,intake_submission_id:c.intakeSubmissionId,
        intake_question_id:c.intakeQuestionId,name_entry_id:c.nameEntryId,name_submission_id:c.nameSubmissionId,name_operation_id:c.nameOperationId,
        name_task_id:c.nameTaskId,name_companion_id:c.nameCompanionId,name_preview_revision:c.namePreviewRevision,
        name_submitted_revision:c.nameSubmittedRevision,name_expected_identity_revision:c.nameExpectedIdentityRevision};
      if(row.revision>2147483647) throw prebirthInventoryUnavailable();
      row.chain_digest=digest(JSON.stringify(unsignedPayload(row,head,head.tip_digest)));
      row.payload_ciphertext=state.crypto.sealUtf8(JSON.stringify(payload(row,head,head.tip_digest)),{table:'platform_companion_prebirth_inventory',column:'payload_ciphertext',rowId:row.id,ownerId:userId,revision:row.revision});
      await client.query(`INSERT INTO platform_companion_prebirth_inventory(id,user_id,revision,kind,source_id,intake_draft_id,intake_operation_id,intake_revision,intake_submission_id,intake_question_id,
        name_entry_id,name_submission_id,name_operation_id,name_task_id,name_companion_id,name_preview_revision,name_submitted_revision,name_expected_identity_revision,source_digest,chain_digest,enrolled_at,payload_ciphertext)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,[row.id,userId,row.revision,row.kind,row.source_id,
        row.intake_draft_id,row.intake_operation_id,row.intake_revision,row.intake_submission_id,row.intake_question_id,row.name_entry_id,row.name_submission_id,
        row.name_operation_id,row.name_task_id,row.name_companion_id,row.name_preview_revision,row.name_submitted_revision,row.name_expected_identity_revision,
        row.source_digest,row.chain_digest,row.enrolled_at,row.payload_ciphertext]);
      head={...head,revision:row.revision,tip_id:row.id,tip_digest:row.chain_digest};
    }
    if (head.revision!==originalRevision) {
      const cipher=state.crypto.sealUtf8(JSON.stringify(headPayload(head)),{table:'platform_companion_prebirth_heads',column:'payload_ciphertext',rowId:userId,ownerId:userId,revision:head.revision});
      const updated=await client.query('UPDATE platform_companion_prebirth_heads SET revision=$2,tip_id=$3,tip_digest=$4,payload_ciphertext=$5 WHERE user_id=$1 AND revision=$6 RETURNING user_id',[userId,head.revision,head.tip_id,head.tip_digest,cipher,originalRevision]);
      if(updated.rowCount!==1) throw prebirthInventoryUnavailable();
    }
    signal?.throwIfAborted();
  } catch(error) {if(signal?.aborted) signal.throwIfAborted(); if(error instanceof ApiError && error.code==='AUTH_REQUIRED') throw error; throw prebirthInventoryUnavailable();}
}
