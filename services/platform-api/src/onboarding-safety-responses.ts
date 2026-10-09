import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseSafetyResponseRenderResult, renderSafetyResponse, type SafetyResponseRenderResult } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage, type SafetySubmissionRow } from './onboarding-storage.ts';
import { assertSafetyResponseSource, responseStorageUnavailable, safetyResponseUnavailable, type SafetyResponseRow } from './onboarding-safety-response-outbox.ts';
import { parseSafetyResponseBundle, readSafetyResponseBundle, type SafetyResponseBundle } from './safety-response-bundle.ts';
import { optionalSafetyUserName as optionalName, publicSafetyResponse } from './safety-response-view.ts';
export { publicSafetyResponse } from './safety-response-view.ts';

const coordinates = ['id','user_id','submission_id','operation_id','draft_id','question_id','submitted_revision',
  'source_generation','detector_revision','level','detector_mode','bundle_revision','content_digest','review_digest','locale'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function submissionId(value: string): string {
  if (typeof value !== 'string' || uuid.exec(value)?.[0] !== value) throw new ApiError(400, 'INVALID_INPUT', 'Use an actual submission identifier.');
  return value;
}
function capture(row: SafetyResponseRow, response: SafetyResponseRenderResult) {
  return { schemaVersion: 1, ...Object.fromEntries(coordinates.map(key => [key, row[key]])),
    preparedAt: row.prepared_at!.toISOString(), retentionUntil: row.retention_until!.toISOString(), response };
}
export function decodeSafetyResponse(storage: OnboardingStorage, row: SafetyResponseRow): SafetyResponseRenderResult {
  try {
    const value: unknown = JSON.parse(storage.crypto!.openUtf8(row.payload_ciphertext!, {
      table:'platform_onboarding_safety_responses',column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:1,
    }));
    if (!value || typeof value!=='object' || Array.isArray(value)) throw responseStorageUnavailable();
    const data=value as Record<string,unknown>, keys=['schemaVersion',...coordinates,'preparedAt','retentionUntil','response'];
    if (Object.keys(data).length!==keys.length || Object.keys(data).some(key=>!keys.includes(key)) || data.schemaVersion!==1
      || coordinates.some(key=>data[key]!==row[key]) || data.preparedAt!==row.prepared_at!.toISOString()
      || data.retentionUntil!==row.retention_until!.toISOString()) throw responseStorageUnavailable();
    const response=parseSafetyResponseRenderResult(data.response);
    if ((row.level==='L2') !== Object.hasOwn(response,'question') || response.resourceCard.contacts.length !== (row.level==='L2'?3:1)) throw responseStorageUnavailable();
    return response;
  } catch { throw responseStorageUnavailable(); }
}

/** Shared, transaction-local authentication of the complete captured response history.
 * A captured response is not evidence of transport, presentation or user acknowledgment.
 */
export async function readAuthenticatedSafetyResponses(client: PoolClient, storage: OnboardingStorage,
  userId: string, sources: SafetySubmissionRow[]) {
  const rows=(await client.query<SafetyResponseRow>(`SELECT * FROM platform_onboarding_safety_responses
    WHERE user_id=$1 ORDER BY submitted_revision,id FOR UPDATE`,[userId])).rows;
  return authenticateResponseRows(client,storage,sources,rows);
}
/** Historical composition only: the caller must separately prove that sources
 * is the entire original prefix. Later responses are not part of that evidence.
 * Current readers continue to authenticate their complete account history. */
export async function readAuthenticatedSafetyResponsesForSources(client: PoolClient, storage: OnboardingStorage,
  userId: string, sources: SafetySubmissionRow[]) {
  if (sources.some(source=>source.user_id!==userId)) throw responseStorageUnavailable();
  const rows=(await client.query<SafetyResponseRow>(`SELECT * FROM platform_onboarding_safety_responses
    WHERE user_id=$1 AND submission_id=ANY($2::uuid[]) ORDER BY submitted_revision,id FOR UPDATE`,
  [userId,sources.map(source=>source.id)])).rows;
  return authenticateResponseRows(client,storage,sources,rows);
}
/** Target-only archived resource proof, not an intake prefix or write admission.
 * Caller proves the actual original raw operation and target classified source. */
export async function readAuthenticatedSafetyResponseForSource(client:PoolClient,storage:OnboardingStorage,source:SafetySubmissionRow){
  const rows=(await client.query<SafetyResponseRow>('SELECT * FROM platform_onboarding_safety_responses WHERE user_id=$1 AND submission_id=$2 FOR UPDATE',[source.user_id,source.id])).rows;
  const captures=await authenticateResponseRows(client,storage,[source],rows);
  if(captures.length!==1||!captures[0].response||captures[0].row.status!=='ready')throw responseStorageUnavailable();return captures[0];
}
async function authenticateResponseRows(client: PoolClient, storage: OnboardingStorage,
  sources: SafetySubmissionRow[], rows: SafetyResponseRow[]) {
  if (rows.length!==sources.filter(source=>source.status==='detected'&&source.level!=='L0').length) throw responseStorageUnavailable();
  const captures: {row: SafetyResponseRow;response: SafetyResponseRenderResult|null}[]=[];
  for (const row of rows) {
    const source=sources.find(source=>source.id===row.submission_id);
    if (!source) throw responseStorageUnavailable();
    assertSafetyResponseSource(row,source,storage.decodeResult(source));
    const events=(await client.query(`SELECT * FROM platform_safety_events WHERE response_id=$1 FOR UPDATE`,[row.id])).rows;
    if (row.status==='pending') {
      if (events.length) throw responseStorageUnavailable();
      captures.push({row,response:null}); continue;
    }
    const event=events[0];
    if (events.length!==1 || event.user_id!==row.user_id || event.submission_id!==row.submission_id
      || event.source_kind!=='onboarding' || event.event_kind!=='response_prepared' || event.level!==row.level
      || event.detector_revision!==row.detector_revision || event.detector_mode!==row.detector_mode
      || event.created_at.toISOString()!==row.prepared_at!.toISOString() || event.retention_until.toISOString()!==row.retention_until!.toISOString()) throw responseStorageUnavailable();
    captures.push({row,response:decodeSafetyResponse(storage,row)});
  }
  return captures;
}

/** Server-only preparation and authenticated private read. Ready means captured, not sent/seen/asked.
 * Publication and its per-conversation 24-hour/new-signal rule must consume real delivery evidence later.
 */
export class OnboardingSafetyResponses {
  private readonly storage: OnboardingStorage;
  private readonly bundle: SafetyResponseBundle | null;
  constructor(private readonly db: Database, config: Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,
    legal: LegalBundle | null, bundle: SafetyResponseBundle | null) {
    this.storage=new OnboardingStorage(config,legal);
    this.bundle=bundle===null?null:parseSafetyResponseBundle(bundle);
  }
  private async history(client: PoolClient, userId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const row=await this.storage.row(client,userId);
    if (!row || !this.storage.crypto) throw responseStorageUnavailable();
    const draft=this.storage.decode(row), sources=await this.storage.recover(client,draft);
    signal?.throwIfAborted(); return { draft,sources };
  }
  private async rows(client: PoolClient, userId: string, sources: SafetySubmissionRow[]) {
    return (await readAuthenticatedSafetyResponses(client,this.storage,userId,sources)).map(capture=>capture.row);
  }
  async prepareSubmission(value: string, signal?: AbortSignal) {
    const id=submissionId(value);
    signal?.throwIfAborted();
    return this.db.withBoundedTransaction(async client=>{
      signal?.throwIfAborted();
      const source=(await client.query<SafetySubmissionRow>('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1',[id])).rows[0];
      if (!source) throw new ApiError(404,'NOT_FOUND','The submission is not available.');
      // Fixed-response capture has no model/quota/provider/lease/feature/legal-consent dependency.
      // The owning real account is locked first; deleted accounts cannot receive a resurrected response.
      const account=(await client.query<{ name:string;account_kind:string }>('SELECT name,account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[source.user_id])).rows[0];
      if (!account || account.account_kind!=='student') throw responseStorageUnavailable();
      const { draft,sources }=await this.history(client,source.user_id,signal), rows=await this.rows(client,source.user_id,sources);
      const row=rows.find(row=>row.submission_id===id);
      if (!row) throw safetyResponseUnavailable();
      if (row.status==='ready') { signal?.throwIfAborted(); return { responseId:row.id,submissionId:id,status:'ready' as const,replayed:true }; }
      const bundle=this.bundle;
      if (!bundle) throw safetyResponseUnavailable();
      const active=(await client.query('SELECT revision,content_digest,review_digest FROM platform_safety_response_policy WHERE singleton=true FOR SHARE')).rows[0];
      if (!active || active.revision!==bundle.revision || active.content_digest!==bundle.contentDigest || active.review_digest!==bundle.reviewDigest) throw safetyResponseUnavailable();
      const language=draft.answersPartial.emotion_language;
      const locale=language?.kind==='answered'&&language.value==='en'?'en':'zh';
      let response: SafetyResponseRenderResult;
      try { response=renderSafetyResponse({ level:row.level,locale,templateFromBundle:bundle.locales[locale],
        contactsFromBundle:bundle.resources.contacts,outsideUsTranslation:bundle.resources.outsideUs[locale],
        companionName:locale==='en'?'Your companion':'你的主理人',userName:optionalName(account.name),askSafetyQuestion:row.level==='L2' }); }
      catch { throw safetyResponseUnavailable(); }
      const times=(await client.query<{ at:Date;until:Date }>(`SELECT clock_timestamp() AS at,
        clock_timestamp()+($1::int*interval '1 day') AS until`,[bundle.retentionDays])).rows[0];
      const ready:SafetyResponseRow={...row,status:'ready',bundle_revision:bundle.revision,content_digest:bundle.contentDigest,
        review_digest:bundle.reviewDigest,locale,prepared_at:times.at,retention_until:times.until};
      let ciphertext:Buffer;
      try { ciphertext=this.storage.crypto!.sealUtf8(JSON.stringify(capture(ready,response)),{
        table:'platform_onboarding_safety_responses',column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:1 }); }
      catch { throw safetyResponseUnavailable(); }
      await client.query(`INSERT INTO platform_safety_events(id,user_id,source_kind,submission_id,response_id,event_kind,level,detector_revision,detector_mode,created_at,retention_until)
        VALUES($1,$2,'onboarding',$3,$4,'response_prepared',$5,$6,$7,$8,$9)`,
      [randomUUID(),row.user_id,row.submission_id,row.id,row.level,row.detector_revision,row.detector_mode,times.at,times.until]);
      const saved=await client.query(`UPDATE platform_onboarding_safety_responses SET status='ready',payload_ciphertext=$2,
        bundle_revision=$3,content_digest=$4,review_digest=$5,locale=$6,prepared_at=$7,retention_until=$8
        WHERE id=$1 AND status='pending' RETURNING id`,[row.id,ciphertext,bundle.revision,bundle.contentDigest,bundle.reviewDigest,locale,times.at,times.until]);
      if (!saved.rowCount) throw responseStorageUnavailable();
      signal?.throwIfAborted(); return { responseId:row.id,submissionId:id,status:'ready' as const,replayed:false };
    });
  }
  /** A server recovery driver can call this after restart. No scheduler or public endpoint is installed by this class. */
  async prepareNext(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const source=await this.db.withBoundedTransaction(async client=>{
      signal?.throwIfAborted();
      const row=(await client.query(`SELECT s.id FROM platform_onboarding_safety_submissions s
        LEFT JOIN platform_onboarding_safety_responses r ON r.submission_id=s.id
        WHERE s.status='detected' AND s.level IN ('L1','L2') AND (r.id IS NULL OR r.status='pending')
        ORDER BY (s.level='L2') DESC,s.submitted_revision,s.id LIMIT 1`)).rows[0];
      signal?.throwIfAborted(); return row;
    },{readOnly:true});
    return source?this.prepareSubmission(source.id,signal):null;
  }
  async read(context: FixedSessionContext, signal?: AbortSignal) {
    const fixed=Object.freeze({userId:context.userId,tokenHash:context.tokenHash});
    return this.db.withBoundedTransaction(async client=>{
      await this.storage.authorizeSession(client,fixed,signal);
      const draft=await this.storage.row(client,fixed.userId);
      if (!draft) { await authorizeFixedSession(client,fixed,signal); return []; }
      const sources=await this.storage.recover(client,this.storage.decode(draft)), rows=await this.rows(client,fixed.userId,sources);
      const at=(await client.query<{ at:Date }>('SELECT clock_timestamp() AS at')).rows[0].at;
      const result=rows.map(row=>Object.freeze({responseId:row.id,submissionId:row.submission_id,level:row.level,
        status:row.status==='ready' && row.retention_until!<=at?'expired' as const:row.status,
        ...(row.status==='ready'&&row.retention_until!>at?{response:publicSafetyResponse(decodeSafetyResponse(this.storage,row))}:{})}));
      await authorizeFixedSession(client,fixed,signal); return Object.freeze(result);
    });
  }
}
export async function createOnboardingSafetyResponses(db: Database,
  config: Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'|'safetyResponseBundlePath'>, legal: LegalBundle|null) {
  return new OnboardingSafetyResponses(db,config,legal,await readSafetyResponseBundle(config.safetyResponseBundlePath));
}
