import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import { parseSafetyResponseBundle, type SafetyResponseBundle } from './safety-response-bundle.ts';

export const deliveryUnavailable = () => new ApiError(503,'SAFETY_DELIVERY_UNAVAILABLE','The reviewed resource delivery is not available.');
export const deliveryStorageUnavailable = () => new ApiError(503,'DATA_STORAGE_UNAVAILABLE','The private resource delivery could not be confirmed.');
export const deliveryDigest = (text:string) => createHash('sha256').update(text,'utf8').digest('hex');
export function deliveryRecord(value:unknown, keys:readonly string[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw deliveryStorageUnavailable();
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length || Reflect.ownKeys(value).some(k=>typeof k!=='string'||!keys.includes(k))
    || keys.some(k=>!Object.hasOwn(ds,k)) || Object.values(ds).some(d=>!('value'in d)||!d.enumerable)) throw deliveryStorageUnavailable();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
export function deliveryUuid(value:unknown):string {
  if(typeof value!=='string'||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0]!==value) throw deliveryStorageUnavailable(); return value;
}
export function deliveryHash(value:unknown):string {
  if(typeof value!=='string'||/^[0-9a-f]{64}$/.exec(value)?.[0]!==value) throw deliveryStorageUnavailable(); return value;
}
export function deliveryInteger(value:unknown,min=0,max=2147483647):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||Object.is(value,-0)||value<min||value>max) throw deliveryStorageUnavailable();return value;
}
export function sealDelivery(crypto:DataCrypto,table:string,id:string,user:string,revision:number,value:unknown):Buffer {
  try{return crypto.sealUtf8(JSON.stringify(value),{table,column:'payload_ciphertext',rowId:id,ownerId:user,revision});}catch{throw deliveryStorageUnavailable();}
}
export function openDelivery(crypto:DataCrypto,table:string,id:string,user:string,revision:number,cipher:Buffer):unknown {
  try{return JSON.parse(crypto.openUtf8(cipher,{table,column:'payload_ciphertext',rowId:id,ownerId:user,revision}));}catch{throw deliveryStorageUnavailable();}
}
export interface SafetyDeliveryReview {
  readonly schemaVersion:1;readonly bundleRevision:number;readonly contentDigest:string;readonly bundleReviewDigest:string;
  readonly reviewerUserId:string;readonly orgId:string;readonly reviewedAt:string;readonly reviewEvidenceRef:string;
  readonly coverage:'body_question_separated';readonly variablePolicy:'unnamed_empty_user';readonly evidenceRetentionDays:number;
  readonly legacyPolicy:'no_auto_reask_possible_exposure';readonly reviewDigest:string;
}
const reviewKeys=['schemaVersion','bundleRevision','contentDigest','bundleReviewDigest','reviewerUserId','orgId','reviewedAt','reviewEvidenceRef',
  'coverage','variablePolicy','evidenceRetentionDays','legacyPolicy'] as const;
function reviewContent(value:unknown,withDigest:boolean) {
  const d=deliveryRecord(value,withDigest?[...reviewKeys,'reviewDigest']:reviewKeys);
  if(d.schemaVersion!==1||d.coverage!=='body_question_separated'||d.variablePolicy!=='unnamed_empty_user'||d.legacyPolicy!=='no_auto_reask_possible_exposure'
    ||typeof d.reviewedAt!=='string'||new Date(d.reviewedAt).toISOString()!==d.reviewedAt
    ||typeof d.reviewEvidenceRef!=='string'||!d.reviewEvidenceRef.trim()||d.reviewEvidenceRef!==d.reviewEvidenceRef.trim()
    ||d.reviewEvidenceRef.length>600||/[<>\p{Cc}]/u.test(d.reviewEvidenceRef)) throw deliveryUnavailable();
  const content={schemaVersion:1 as const,bundleRevision:deliveryInteger(d.bundleRevision,1),contentDigest:deliveryHash(d.contentDigest),
    bundleReviewDigest:deliveryHash(d.bundleReviewDigest),reviewerUserId:deliveryUuid(d.reviewerUserId),orgId:deliveryUuid(d.orgId),
    reviewedAt:d.reviewedAt,reviewEvidenceRef:d.reviewEvidenceRef,coverage:'body_question_separated' as const,
    variablePolicy:'unnamed_empty_user' as const,evidenceRetentionDays:deliveryInteger(d.evidenceRetentionDays,1,3650),legacyPolicy:'no_auto_reask_possible_exposure' as const};
  return {content,digest:deliveryDigest(JSON.stringify(content)),supplied:d.reviewDigest};
}
/** Integrity only. Labels, role and hashes cannot establish professional competence or actual review. */
export function expectedSafetyDeliveryReviewDigest(value:unknown):string {try{return reviewContent(value,false).digest;}catch{throw deliveryUnavailable();}}
export function parseSafetyDeliveryReview(value:unknown):Readonly<SafetyDeliveryReview> {
  try{const r=reviewContent(value,true);if(r.supplied!==r.digest)throw deliveryUnavailable();return Object.freeze({...r.content,reviewDigest:r.digest});}catch{throw deliveryUnavailable();}
}
export async function readSafetyDeliveryReview(filename?:string):Promise<Readonly<SafetyDeliveryReview>|null> {
  if(filename===undefined)return null;
  try{const data=await fs.readFile(filename);if(data.length>32768)throw deliveryUnavailable();return parseSafetyDeliveryReview(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(data)));}catch{throw deliveryUnavailable();}
}
/** All new-edition and review/activation paths acquire this BEFORE ANY actor account lock.
 * Invalid student staff calls also obey this order. Archive replay does not acquire it. */
export async function acquireDeliveryReviewCoordinator(client:PoolClient,signal?:AbortSignal) {
  signal?.throwIfAborted();await client.query('SELECT pg_advisory_xact_lock(71047,1)');signal?.throwIfAborted();
}
interface AssetRow {id:string;bundle_revision:number;content_digest:string;bundle_review_digest:string;review_digest:string;bundle_json:string;review_json:string;
  reviewer_id:string;org_id:string;reviewer_session_hash:string;auth_version:string;reviewed_at:Date;recorded_at:Date;decision_ciphertext:Buffer;}
interface ReviewOperation {user_id:string;operation_id:string;asset_id:string;kind:'review'|'activate';input_digest:string;capture_ciphertext:Buffer;created_at:Date;}
export interface ArchivedDeliveryAssets {readonly id:string;readonly bundle:Readonly<SafetyResponseBundle>;readonly review:Readonly<SafetyDeliveryReview>;}
export interface ActivatedDeliveryAssets extends ArchivedDeliveryAssets {readonly activation:Readonly<{userId:string;operationId:string;at:string}>;}
function assetCapture(row:AssetRow,bundle:SafetyResponseBundle,review:SafetyDeliveryReview) {
  return {schemaVersion:1,id:row.id,bundle,review,actor:{userId:row.reviewer_id,orgId:row.org_id,sessionHash:row.reviewer_session_hash,
    authVersion:row.auth_version,role:'safety_reviewer'},reviewedAt:row.reviewed_at.toISOString(),recordedAt:row.recorded_at.toISOString()};
}
function assertAssetTimes(bundle:SafetyResponseBundle,review:SafetyDeliveryReview,at:Date) {
  const approved=Date.parse(bundle.review.approvedAt),reviewed=Date.parse(review.reviewedAt);
  if(approved>reviewed||reviewed>at.getTime()||bundle.resources.contacts.some(c=>Date.parse(c.verifiedAt)>reviewed))throw deliveryUnavailable();
}
/** Original authorized decision snapshot only: later role/config changes do not redraw or invalidate an existing valid publication.
 * Bounded REPEATABLE READ archives may disable locks; execution callers retain the default. */
export async function readArchivedDeliveryAssets(client:PoolClient,crypto:DataCrypto,id:string,lock=true):Promise<ArchivedDeliveryAssets> {
  const row=(await client.query<AssetRow>(`SELECT * FROM platform_safety_delivery_assets WHERE id=$1${lock?' FOR SHARE':''}`,[deliveryUuid(id)])).rows[0];
  try{
    if(!row)throw deliveryStorageUnavailable();const bundle=parseSafetyResponseBundle(JSON.parse(row.bundle_json)),review=parseSafetyDeliveryReview(JSON.parse(row.review_json));
    if(bundle.revision!==row.bundle_revision||bundle.contentDigest!==row.content_digest||bundle.reviewDigest!==row.bundle_review_digest
      ||review.reviewDigest!==row.review_digest||review.bundleRevision!==bundle.revision||review.contentDigest!==bundle.contentDigest||review.bundleReviewDigest!==bundle.reviewDigest
      ||review.reviewerUserId!==row.reviewer_id||review.orgId!==row.org_id||review.reviewedAt!==row.reviewed_at.toISOString()
      ||JSON.stringify(bundle)!==row.bundle_json||JSON.stringify(review)!==row.review_json)throw deliveryStorageUnavailable();
    const actual=crypto.openUtf8(row.decision_ciphertext,{table:'platform_safety_delivery_assets',column:'decision_ciphertext',rowId:row.id,ownerId:row.reviewer_id,revision:1});
    if(actual!==JSON.stringify(assetCapture(row,bundle,review)))throw deliveryStorageUnavailable();
    assertAssetTimes(bundle,review,row.recorded_at);return Object.freeze({id:row.id,bundle,review});
  }catch{throw deliveryStorageUnavailable();}
}
function operationCapture(row:ReviewOperation,sessionHash:string,authVersion:string,request:unknown) {
  return {schemaVersion:1,userId:row.user_id,operationId:row.operation_id,assetId:row.asset_id,kind:row.kind,inputDigest:row.input_digest,
    sessionHash,authVersion,request,at:row.created_at.toISOString()};
}
export async function readArchivedDeliveryActivation(client:PoolClient,crypto:DataCrypto,assetId:string,userId:string,operationId:string,lock=true) {
  const row=(await client.query<ReviewOperation>(`SELECT * FROM platform_safety_delivery_review_operations WHERE user_id=$1 AND operation_id=$2${lock?' FOR SHARE':''}`,[userId,operationId])).rows[0];
  try{
    if(!row||row.kind!=='activate'||row.asset_id!==assetId)throw deliveryStorageUnavailable();
    const text=crypto.openUtf8(row.capture_ciphertext,{table:'platform_safety_delivery_review_operations',column:'capture_ciphertext',rowId:row.operation_id,ownerId:row.user_id,revision:1});
    const d=deliveryRecord(JSON.parse(text),['schemaVersion','userId','operationId','assetId','kind','inputDigest','sessionHash','authVersion','request','at']);
    const request=deliveryRecord(d.request,['operationId','assetId']);if(request.operationId!==operationId||request.assetId!==assetId
      ||typeof d.authVersion!=='string'||text!==JSON.stringify(operationCapture(row,deliveryHash(d.sessionHash),d.authVersion,request))
      ||row.input_digest!==deliveryDigest(JSON.stringify(request)))throw deliveryStorageUnavailable();
    return Object.freeze({userId,operationId,at:row.created_at.toISOString()});
  }catch{throw deliveryStorageUnavailable();}
}
async function staffRole(client:PoolClient,userId:string,orgId:string,roles:readonly string[]) {
  const user=(await client.query<{account_kind:string;auth_version:string}>('SELECT account_kind,auth_version::text FROM platform_users WHERE id=$1 FOR SHARE',[userId])).rows[0];
  const org=(await client.query('SELECT id FROM platform_orgs WHERE id=$1 AND status=\'active\' FOR SHARE',[orgId])).rows[0];
  const found=await client.query(`SELECT role FROM platform_org_roles WHERE org_id=$1 AND user_id=$2 AND role=ANY($3::text[])
    AND status='active' AND revoked_at IS NULL ORDER BY role FOR SHARE`,[orgId,userId,roles]);
  if(!user||user.account_kind!=='staff'||!org||!found.rowCount)throw new ApiError(403,'STAFF_ACCESS_REQUIRED','Use an authorized safety reviewer or operator account.');return user.auth_version;
}
/** Caller must already hold the coordinator acquired before any actor account lock. */
export async function assertActiveDeliveryAssets(client:PoolClient,crypto:DataCrypto,bundle:SafetyResponseBundle|null,review:SafetyDeliveryReview|null,signal?:AbortSignal):Promise<ActivatedDeliveryAssets> {
  if(!bundle||!review)throw deliveryUnavailable();const fixedBundle=parseSafetyResponseBundle(bundle),fixedReview=parseSafetyDeliveryReview(review);
  const p=(await client.query(`SELECT * FROM platform_safety_delivery_policy WHERE singleton=true FOR SHARE`)).rows[0];
  if(!p)throw deliveryUnavailable();const a=await readArchivedDeliveryAssets(client,crypto,p.asset_id);
  if(JSON.stringify(a.bundle)!==JSON.stringify(fixedBundle)||JSON.stringify(a.review)!==JSON.stringify(fixedReview))throw deliveryUnavailable();
  const activation=await readArchivedDeliveryActivation(client,crypto,a.id,p.activated_by,p.activation_operation_id);
  if(activation.at!==p.activated_at.toISOString())throw deliveryStorageUnavailable();
  assertAssetTimes(a.bundle,a.review,p.activated_at);
  await staffRole(client,a.review.reviewerUserId,a.review.orgId,['safety_reviewer']);await staffRole(client,p.activated_by,a.review.orgId,['ops','org_admin']);
  const current=await client.query(`SELECT p.singleton FROM platform_safety_delivery_policy p JOIN platform_safety_response_policy r ON r.singleton=true
    WHERE p.singleton=true AND p.asset_id=$1 AND p.activated_at<=clock_timestamp() AND $2::timestamptz<=p.activated_at
    AND r.revision=$3 AND r.content_digest=$4 AND r.review_digest=$5 AND r.activated_at<=clock_timestamp() FOR SHARE OF p,r`,
    [a.id,a.review.reviewedAt,a.bundle.revision,a.bundle.contentDigest,a.bundle.reviewDigest]);
  signal?.throwIfAborted();if(current.rowCount!==1)throw deliveryUnavailable();return Object.freeze({...a,activation});
}
export class SafetyDeliveryReviewRegistry {
  private readonly bundle:SafetyResponseBundle|null;private readonly review:SafetyDeliveryReview|null;
  constructor(private readonly db:Database,private readonly crypto:DataCrypto|undefined,bundle:SafetyResponseBundle|null,review:SafetyDeliveryReview|null){
    this.bundle=bundle===null?null:parseSafetyResponseBundle(bundle);this.review=review===null?null:parseSafetyDeliveryReview(review);
  }
  private async writeOperation(client:PoolClient,crypto:DataCrypto,fixed:FixedSessionContext,row:ReviewOperation,authVersion:string,request:unknown) {
    const capture=operationCapture(row,fixed.tokenHash,authVersion,request),cipher=crypto.sealUtf8(JSON.stringify(capture),{
      table:'platform_safety_delivery_review_operations',column:'capture_ciphertext',rowId:row.operation_id,ownerId:row.user_id,revision:1});
    await client.query(`INSERT INTO platform_safety_delivery_review_operations(user_id,operation_id,asset_id,kind,input_digest,capture_ciphertext,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[row.user_id,row.operation_id,row.asset_id,row.kind,row.input_digest,cipher,row.created_at]);
  }
  private async replay(client:PoolClient,fixed:FixedSessionContext,operationId:string,kind:ReviewOperation['kind'],request:unknown) {
    const row=(await client.query<ReviewOperation>('SELECT * FROM platform_safety_delivery_review_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',[fixed.userId,operationId])).rows[0];
    if(!row)return null;
    const text=this.crypto!.openUtf8(row.capture_ciphertext,{table:'platform_safety_delivery_review_operations',column:'capture_ciphertext',rowId:row.operation_id,ownerId:row.user_id,revision:1});
    const d=deliveryRecord(JSON.parse(text),['schemaVersion','userId','operationId','assetId','kind','inputDigest','sessionHash','authVersion','request','at']);
    if(row.kind!==kind||row.input_digest!==deliveryDigest(JSON.stringify(request))||d.sessionHash!==fixed.tokenHash
      ||JSON.stringify(d.request)!==JSON.stringify(request))throw new ApiError(409,'SAFETY_DELIVERY_OPERATION_CONFLICT','Use a new review operation identifier.');
    if(typeof d.authVersion!=='string'||text!==JSON.stringify(operationCapture(row,fixed.tokenHash,d.authVersion,request)))throw deliveryStorageUnavailable();
    await readArchivedDeliveryAssets(client,this.crypto!,row.asset_id);return row;
  }
  async recordReview(context:FixedSessionContext,value:unknown,signal?:AbortSignal) {
    const fixed=Object.freeze({...context}),d=deliveryRecord(value,['operationId']),request={operationId:deliveryUuid(d.operationId)};
    return this.db.withBoundedTransaction(async client=>{
      await acquireDeliveryReviewCoordinator(client,signal);await authorizeFixedSession(client,fixed,signal);
      if(!this.crypto||!this.bundle||!this.review)throw deliveryUnavailable();const b=parseSafetyResponseBundle(this.bundle),r=parseSafetyDeliveryReview(this.review);
      if(r.reviewerUserId!==fixed.userId||r.bundleRevision!==b.revision||r.contentDigest!==b.contentDigest||r.bundleReviewDigest!==b.reviewDigest)throw deliveryUnavailable();
      const authVersion=await staffRole(client,fixed.userId,r.orgId,['safety_reviewer']),old=await this.replay(client,fixed,request.operationId,'review',request);
      if(old){await authorizeFixedSession(client,fixed,signal);return {assetId:old.asset_id,replayed:true};}
      const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
      assertAssetTimes(b,r,at);
      const existing=(await client.query<AssetRow>('SELECT * FROM platform_safety_delivery_assets WHERE review_digest=$1 FOR UPDATE',[r.reviewDigest])).rows[0];
      const row:AssetRow=existing??{id:randomUUID(),bundle_revision:b.revision,content_digest:b.contentDigest,bundle_review_digest:b.reviewDigest,review_digest:r.reviewDigest,
        bundle_json:JSON.stringify(b),review_json:JSON.stringify(r),reviewer_id:fixed.userId,org_id:r.orgId,reviewer_session_hash:fixed.tokenHash,auth_version:authVersion,
        reviewed_at:new Date(r.reviewedAt),recorded_at:at,decision_ciphertext:Buffer.alloc(0)};
      if(existing)await readArchivedDeliveryAssets(client,this.crypto,row.id);
      else{
        row.decision_ciphertext=this.crypto.sealUtf8(JSON.stringify(assetCapture(row,b,r)),{table:'platform_safety_delivery_assets',column:'decision_ciphertext',rowId:row.id,ownerId:fixed.userId,revision:1});
        await client.query(`INSERT INTO platform_safety_delivery_assets(id,bundle_revision,content_digest,bundle_review_digest,review_digest,bundle_json,review_json,
          reviewer_id,org_id,reviewer_session_hash,auth_version,reviewed_at,recorded_at,decision_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [row.id,row.bundle_revision,row.content_digest,row.bundle_review_digest,row.review_digest,row.bundle_json,row.review_json,row.reviewer_id,row.org_id,row.reviewer_session_hash,row.auth_version,row.reviewed_at,row.recorded_at,row.decision_ciphertext]);
      }
      await this.writeOperation(client,this.crypto,fixed,{user_id:fixed.userId,operation_id:request.operationId,asset_id:row.id,kind:'review',input_digest:deliveryDigest(JSON.stringify(request)),capture_ciphertext:Buffer.alloc(0),created_at:at},authVersion,request);
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {assetId:row.id,replayed:false};
    });
  }
  async activate(context:FixedSessionContext,value:unknown,signal?:AbortSignal) {
    const fixed=Object.freeze({...context}),d=deliveryRecord(value,['operationId','assetId']),request={operationId:deliveryUuid(d.operationId),assetId:deliveryUuid(d.assetId)};
    return this.db.withBoundedTransaction(async client=>{
      await acquireDeliveryReviewCoordinator(client,signal);await authorizeFixedSession(client,fixed,signal);if(!this.crypto)throw deliveryUnavailable();
      const a=await readArchivedDeliveryAssets(client,this.crypto,request.assetId),authVersion=await staffRole(client,fixed.userId,a.review.orgId,['ops','org_admin']);
      await staffRole(client,a.review.reviewerUserId,a.review.orgId,['safety_reviewer']);
      const old=await this.replay(client,fixed,request.operationId,'activate',request);if(old){await authorizeFixedSession(client,fixed,signal);return {assetId:old.asset_id,replayed:true};}
      const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;assertAssetTimes(a.bundle,a.review,at);
      await this.writeOperation(client,this.crypto,fixed,{user_id:fixed.userId,operation_id:request.operationId,asset_id:a.id,kind:'activate',input_digest:deliveryDigest(JSON.stringify(request)),capture_ciphertext:Buffer.alloc(0),created_at:at},authVersion,request);
      await client.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
        VALUES(true,$1,$2,$3,$4,$5) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,
        review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,[a.bundle.revision,a.bundle.contentDigest,a.bundle.reviewDigest,at,fixed.userId]);
      await client.query(`INSERT INTO platform_safety_delivery_policy(singleton,asset_id,activated_by,activation_operation_id,activated_at) VALUES(true,$1,$2,$3,$4)
        ON CONFLICT(singleton) DO UPDATE SET asset_id=EXCLUDED.asset_id,activated_by=EXCLUDED.activated_by,activation_operation_id=EXCLUDED.activation_operation_id,activated_at=EXCLUDED.activated_at`,[a.id,fixed.userId,request.operationId,at]);
      await authorizeFixedSession(client,fixed,signal);signal?.throwIfAborted();return {assetId:a.id,replayed:false};
    });
  }
}
