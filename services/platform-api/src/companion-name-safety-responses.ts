import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseSafetyResponseRenderResult, renderSafetyResponse, type SafetyResponseRenderResult } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import { companionNameUuid } from './companion-name-safety-protocol.ts';
import { parseCapturedCompanionAnswers } from './companion-captured-answers.ts';
import { readNameResourceSourceInTransaction, type AuthenticatedNameResourceSource } from './companion-name-resource-source.ts';
import { assertNameSafetyResponseSource, enqueueNameSafetyResponse, nameResponseStorageUnavailable,
  nameSafetyResponseUnavailable, type CompanionNameSafetyResponseRow } from './companion-name-safety-response-outbox.ts';
import { parseSafetyResponseBundle, readSafetyResponseBundle, type SafetyResponseBundle } from './safety-response-bundle.ts';
import { optionalSafetyUserName, publicSafetyResponseBody } from './safety-response-view.ts';

const coordinates = ['id','user_id','submission_id','operation_id','entry_id','task_id','companion_id','preview_revision','submitted_revision',
  'expected_identity_revision','source_generation','detector_revision','level','detector_mode','bundle_revision','content_digest','review_digest','locale','locale_origin'] as const;
type LocaleProof = Readonly<{kind:'default_zh'}> | Readonly<{kind:'captured_answers';answersId:string;sourceDraftId:string;sourceRevision:number;answersDigest:string}>;
function closed(value: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw nameResponseStorageUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors,key)) || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw nameResponseStorageUnavailable();
  return value as Record<string,unknown>;
}
function readRequest(value: unknown): string {
  try { return companionNameUuid(closed(value,['submissionId']).submissionId); }
  catch { throw new ApiError(400,'INVALID_INPUT','Use an actual name resource submission identifier.'); }
}
function localeProof(value: unknown, row: CompanionNameSafetyResponseRow, target: AuthenticatedNameResourceSource): LocaleProof {
  if (row.locale_origin === 'default_zh') {
    const data = closed(value,['kind']);
    if (data.kind !== 'default_zh' || row.locale !== 'zh') throw nameResponseStorageUnavailable();
    return Object.freeze({kind:'default_zh'});
  }
  const data = closed(value,['kind','answersId','sourceDraftId','sourceRevision','answersDigest']), source = target.previewSource;
  if (row.locale_origin !== 'captured_answers' || data.kind !== 'captured_answers' || data.answersId !== source.answersId
    || data.sourceDraftId !== source.sourceDraftId || data.sourceRevision !== source.sourceRevision
    || typeof data.answersDigest !== 'string' || /^[0-9a-f]{64}$/.exec(data.answersDigest)?.[0] !== data.answersDigest) throw nameResponseStorageUnavailable();
  return Object.freeze({kind:'captured_answers',answersId:source.answersId,sourceDraftId:source.sourceDraftId,
    sourceRevision:source.sourceRevision,answersDigest:data.answersDigest});
}
function capture(row: CompanionNameSafetyResponseRow, proof: LocaleProof, response: SafetyResponseRenderResult) {
  return {schemaVersion:1,...Object.fromEntries(coordinates.map(key => [key,row[key]])),
    preparedAt:row.prepared_at!.toISOString(),retentionUntil:row.retention_until!.toISOString(),localeProof:proof,response};
}
function decode(crypto: DataCrypto, row: CompanionNameSafetyResponseRow, target: AuthenticatedNameResourceSource): SafetyResponseRenderResult {
  try {
    const text = crypto.openUtf8(row.payload_ciphertext!,{table:'platform_companion_name_safety_responses',column:'payload_ciphertext',
      rowId:row.id,ownerId:row.user_id,revision:1});
    const data = closed(JSON.parse(text),['schemaVersion',...coordinates,'preparedAt','retentionUntil','localeProof','response']);
    if (data.schemaVersion !== 1 || coordinates.some(key => data[key] !== row[key]) || data.preparedAt !== row.prepared_at!.toISOString()
      || data.retentionUntil !== row.retention_until!.toISOString()) throw nameResponseStorageUnavailable();
    const proof = localeProof(data.localeProof,row,target), response = parseSafetyResponseRenderResult(data.response);
    if ((row.level === 'L2') !== Object.hasOwn(response,'question') || response.resourceCard.contacts.length !== (row.level === 'L2'?3:1)
      || text !== JSON.stringify(capture(row,proof,response))) throw nameResponseStorageUnavailable();
    return response;
  } catch { throw nameResponseStorageUnavailable(); }
}

/** Server-only internal foundation. Captured is not published, displayed,
 * asked, acknowledged, handled, clinically safe or permission to name/apply. */
export class CompanionNameSafetyResponses {
  private readonly crypto: DataCrypto | undefined;
  private readonly bundle: SafetyResponseBundle | null;
  constructor(private readonly db: Database, config: Pick<PlatformConfig,'dataCrypto'>, bundle: SafetyResponseBundle | null) {
    this.crypto = config.dataCrypto;
    this.bundle = bundle === null ? null : parseSafetyResponseBundle(bundle);
  }
  private async row(client: PoolClient, target: AuthenticatedNameResourceSource) {
    return (await client.query<CompanionNameSafetyResponseRow>('SELECT * FROM platform_companion_name_safety_responses WHERE submission_id=$1 AND user_id=$2 FOR UPDATE',
      [target.source.id,target.source.user_id])).rows[0];
  }
  private async authenticate(client: PoolClient, target: AuthenticatedNameResourceSource, row: CompanionNameSafetyResponseRow) {
    assertNameSafetyResponseSource(row,target.source,target.decision);
    const events = (await client.query(`SELECT *,created_at<=clock_timestamp() AS actual_time
      FROM platform_safety_events WHERE name_response_id=$1 FOR UPDATE`,[row.id])).rows;
    if (row.status === 'pending') {
      if (events.length) throw nameResponseStorageUnavailable(); return null;
    }
    const event = events[0];
    if (row.status !== 'ready' || !this.crypto || !row.prepared_at || !row.retention_until || events.length !== 1
      || event.user_id !== row.user_id || event.name_submission_id !== row.submission_id || event.name_response_id !== row.id
      || event.name_source_generation !== row.source_generation || event.submission_id !== null || event.response_id !== null
      || event.source_kind !== 'companion_name' || event.event_kind !== 'response_prepared' || event.actual_time !== true || event.level !== row.level
      || event.detector_revision !== row.detector_revision || event.detector_mode !== row.detector_mode
      || event.created_at.toISOString() !== row.prepared_at.toISOString() || event.retention_until.toISOString() !== row.retention_until.toISOString()) throw nameResponseStorageUnavailable();
    return decode(this.crypto,row,target);
  }
  private async optionalLocale(client: PoolClient, target: AuthenticatedNameResourceSource): Promise<Readonly<{locale:'zh'|'en';proof:LocaleProof}>> {
    const source = target.previewSource, fallback = Object.freeze({locale:'zh' as const,proof:Object.freeze({kind:'default_zh' as const})});
    // SQL failures propagate; only missing/unverifiable optional plaintext can
    // use the explicit default. No current intake/history gate is consulted.
    const row = (await client.query<{id:string;user_id:string;source_draft_id:string;source_revision:number;payload_ciphertext:Buffer}>(`SELECT * FROM platform_companion_answers
      WHERE id=$1 AND user_id=$2 AND source_draft_id=$3 AND source_revision=$4 FOR SHARE`,
      [source.answersId,target.source.user_id,source.sourceDraftId,source.sourceRevision])).rows[0];
    if (!row || !this.crypto) return fallback;
    try {
      const text = this.crypto.openUtf8(row.payload_ciphertext,{table:'platform_companion_answers',column:'payload_ciphertext',rowId:row.id,
        ownerId:row.user_id,revision:row.source_revision});
      const answers = parseCapturedCompanionAnswers(JSON.parse(text));
      if (answers.id !== row.id || answers.userId !== row.user_id || answers.sourceDraftId !== row.source_draft_id
        || answers.sourceRevision !== row.source_revision || text !== JSON.stringify(answers)) return fallback;
      const preference = answers.answersPartial.emotion_language;
      return Object.freeze({locale:preference?.kind === 'answered' && preference.value === 'en'?'en':'zh',
        proof:Object.freeze({kind:'captured_answers',answersId:row.id,sourceDraftId:row.source_draft_id,sourceRevision:row.source_revision,
          answersDigest:createHash('sha256').update(text,'utf8').digest('hex')})});
    } catch { return fallback; }
  }
  /** Reference-only recovery. Never writes source/claim/result/usage/prefix or an invented grade. */
  async recoverSubmission(value: string, signal?: AbortSignal) {
    const id = companionNameUuid(value); signal?.throwIfAborted();
    return this.db.withBoundedTransaction(async client => {
      const target = await readNameResourceSourceInTransaction(client,this.crypto,id,signal);
      if (target.decision.level === 'L0') return null;
      const previous = await this.row(client,target), row = await enqueueNameSafetyResponse(client,target.source,target.decision);
      if (!row) throw nameResponseStorageUnavailable();
      signal?.throwIfAborted(); return Object.freeze({responseId:row.id,submissionId:id,replayed:!!previous});
    });
  }
  async prepareSubmission(value: string, signal?: AbortSignal) {
    const id = companionNameUuid(value); signal?.throwIfAborted();
    return this.db.withBoundedTransaction(async client => {
      const target = await readNameResourceSourceInTransaction(client,this.crypto,id,signal);
      if (target.decision.level === 'L0') return null;
      const row = await enqueueNameSafetyResponse(client,target.source,target.decision);
      if (!row) throw nameResponseStorageUnavailable();
      await this.authenticate(client,target,row);
      if (row.status === 'ready') {
        signal?.throwIfAborted(); return Object.freeze({responseId:row.id,submissionId:id,status:'ready' as const,replayed:true});
      }
      const bundle = this.bundle;
      if (!bundle) throw nameSafetyResponseUnavailable();
      const active = (await client.query<{revision:number;content_digest:string;review_digest:string;at:Date}>(`SELECT revision,content_digest,review_digest,clock_timestamp() AS at
        FROM platform_safety_response_policy WHERE singleton=true AND activated_at<=clock_timestamp() FOR SHARE`)).rows[0];
      if (!active || active.revision !== bundle.revision || active.content_digest !== bundle.contentDigest || active.review_digest !== bundle.reviewDigest
        || Date.parse(bundle.review.approvedAt)>active.at.getTime()) throw nameSafetyResponseUnavailable();
      const account = (await client.query<{name:string}>('SELECT name FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[target.source.user_id])).rows[0];
      if (!account || !this.crypto) throw nameResponseStorageUnavailable();
      const selected = await this.optionalLocale(client,target), locale = selected.locale;
      let response: SafetyResponseRenderResult;
      try { response = renderSafetyResponse({level:row.level,locale,templateFromBundle:bundle.locales[locale],contactsFromBundle:bundle.resources.contacts,
        outsideUsTranslation:bundle.resources.outsideUs[locale],companionName:locale === 'en'?'Your companion':'你的主理人',
        userName:optionalSafetyUserName(account.name),askSafetyQuestion:row.level === 'L2'}); }
      catch { throw nameSafetyResponseUnavailable(); }
      const times = (await client.query<{at:Date;until:Date}>(`SELECT t.at,t.at+($1::int*interval '1 day') AS until
        FROM (SELECT clock_timestamp() AS at) t`,[bundle.retentionDays])).rows[0];
      const ready: CompanionNameSafetyResponseRow = {...row,status:'ready',bundle_revision:bundle.revision,content_digest:bundle.contentDigest,
        review_digest:bundle.reviewDigest,locale,locale_origin:selected.proof.kind,prepared_at:times.at,retention_until:times.until};
      let ciphertext: Buffer;
      try { ciphertext = this.crypto.sealUtf8(JSON.stringify(capture(ready,selected.proof,response)),{table:'platform_companion_name_safety_responses',
        column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:1}); }
      catch { throw nameResponseStorageUnavailable(); }
      await client.query(`INSERT INTO platform_safety_events
        (id,user_id,source_kind,name_submission_id,name_response_id,name_source_generation,event_kind,level,detector_revision,detector_mode,created_at,retention_until)
        VALUES($1,$2,'companion_name',$3,$4,$5,'response_prepared',$6,$7,$8,$9,$10)`,
      [randomUUID(),row.user_id,row.submission_id,row.id,row.source_generation,row.level,row.detector_revision,row.detector_mode,times.at,times.until]);
      const saved = await client.query(`UPDATE platform_companion_name_safety_responses SET status='ready',payload_ciphertext=$2,bundle_revision=$3,
        content_digest=$4,review_digest=$5,locale=$6,locale_origin=$7,prepared_at=$8,retention_until=$9 WHERE id=$1 AND status='pending' RETURNING id`,
      [row.id,ciphertext,bundle.revision,bundle.contentDigest,bundle.reviewDigest,locale,selected.proof.kind,times.at,times.until]);
      if (!saved.rowCount) throw nameResponseStorageUnavailable();
      signal?.throwIfAborted(); return Object.freeze({responseId:row.id,submissionId:id,status:'ready' as const,replayed:false});
    });
  }
  /** Explicit internal recovery driver only; no scheduler or public endpoint is installed. */
  async prepareNext(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const source = await this.db.withBoundedTransaction(async client => {
      const row = (await client.query<{id:string}>(`SELECT s.id FROM platform_companion_name_submissions s
        LEFT JOIN platform_companion_name_safety_responses r ON r.submission_id=s.id
        WHERE s.status='detected' AND s.level IN ('L1','L2') AND (r.id IS NULL OR r.status='pending')
        ORDER BY (s.level='L2') DESC,s.submitted_revision,s.id LIMIT 1`)).rows[0];
      signal?.throwIfAborted(); return row;
    },{readOnly:true});
    return source ? this.prepareSubmission(source.id,signal) : null;
  }
  async readBody(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const fixed = Object.freeze({userId:context.userId,tokenHash:context.tokenHash}), id = readRequest(value);
    return this.db.withBoundedTransaction(async client => {
      await authorizeFixedSession(client,fixed,signal);
      const account = (await client.query<{account_kind:string}>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[fixed.userId])).rows[0];
      if (!account || account.account_kind !== 'student') throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account for private name resources.');
      if (!(await client.query('SELECT id FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2',[id,fixed.userId])).rowCount) throw new ApiError(404,'NOT_FOUND','The name resource is not available.');
      const target = await readNameResourceSourceInTransaction(client,this.crypto,id,signal);
      if (target.decision.level === 'L0') { await authorizeFixedSession(client,fixed,signal); signal?.throwIfAborted(); return null; }
      const row = await this.row(client,target), response = row ? await this.authenticate(client,target,row) : null;
      const state = {responseId:row?.id ?? null,submissionId:id,level:target.decision.level,mode:target.decision.mode};
      const at = (await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
      if (row?.prepared_at && row.prepared_at > at) throw nameResponseStorageUnavailable();
      await authorizeFixedSession(client,fixed,signal); signal?.throwIfAborted();
      if (!row || !response) return Object.freeze({...state,status:'pending' as const});
      const dates = {preparedAt:row.prepared_at!.toISOString(),retentionUntil:row.retention_until!.toISOString()};
      if (row.retention_until! <= at) return Object.freeze({...state,status:'expired' as const,...dates});
      return Object.freeze({...state,status:'ready' as const,...dates,body:publicSafetyResponseBody(response)});
    });
  }
}
export async function createCompanionNameSafetyResponses(db: Database, config: Pick<PlatformConfig,'dataCrypto'|'safetyResponseBundlePath'>) {
  return new CompanionNameSafetyResponses(db,config,await readSafetyResponseBundle(config.safetyResponseBundlePath));
}
