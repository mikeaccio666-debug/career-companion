import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject, careerRecordId, MENTOR_INTENT_PRIVACY, parseMentorServiceTerms,
  parseMentorServiceOffer, mentorServiceInteger, mentorServiceText, mentorServiceTime, type MentorServiceTerms, type MentorServiceOffer } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError } from './errors.ts';
import type { FixedSessionContext } from './auth.ts';
import { StaffAccess } from './staff-access.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
const unavailable = () => new ApiError(503, 'SERVICE_OFFER_STORAGE_UNAVAILABLE', '暂时无法确认真人服务信息。');
const invalid = () => new ApiError(400, 'SERVICE_OFFER_INPUT_INVALID', '请使用完整、已确认的服务资料。');
const changed = () => new ApiError(409, 'SERVICE_OFFER_REVISION_CHANGED', '请先查看最新服务版本。');
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x)).digest('hex');
function fixed(v: FixedSessionContext) {
  try { const o = careerRecordObject(v, ['userId','tokenHash']);
    if (typeof o.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.tokenHash)) throw Error();
    return Object.freeze({userId: careerRecordId(o.userId), tokenHash: o.tokenHash});
  } catch { throw new ApiError(401,'AUTH_REQUIRED','请重新登录。'); }
}
interface OfferState {
  id: string; orgId: string; revision: number; status: 'active'|'withdrawn'; terms: Readonly<MentorServiceTerms>;
  reviewedAt: string; reviewEvidenceRef: string; configuredBy: string; updatedAt: string; withdrawalReason: string|null;
}
interface OfferRow {
  id: string; org_id: string; revision: number; service_kind: string; duration_min: number; price_cents: number; currency: string;
  status: string; valid_from: Date; valid_until: Date; earliest_slot_at: Date|null; updated_at: Date; payload_ciphertext: Buffer;
}
export interface OfferReceipt { readonly offerId: string; readonly revision: number; readonly status: 'active'|'withdrawn'; }
/** Server-side configuration is independent of paid suggestions, booking, cohort grants and payment.
 * Review evidence records an operator's declaration; its legal adequacy remains a release gate. */
export class MentorServiceOffers {
  private readonly store: OnboardingStorage;
  private readonly staff: StaffAccess;
  constructor(private readonly db: Database, config: Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,
    legal: LegalBundle|null, private readonly blobs: Pick<BlobStorage,'stat'>, staff?: StaffAccess) {
    this.store = new OnboardingStorage(config, legal); this.staff = staff ?? new StaffAccess(db);
  }
  private seal(table: string, id: string, org: string, revision: number, value: unknown): Buffer {
    try { if (!this.store.crypto) throw Error(); return this.store.crypto.sealUtf8(JSON.stringify(value),
      {table,column:'payload',rowId:id,ownerId:org,revision}); } catch { throw unavailable(); }
  }
  private open(table: string, id: string, org: string, revision: number, cipher: Buffer): unknown {
    try { if (!this.store.crypto) throw Error(); return JSON.parse(this.store.crypto.openUtf8(cipher,
      {table,column:'payload',rowId:id,ownerId:org,revision})); } catch { throw unavailable(); }
  }
  private async decode(c: PoolClient, row: OfferRow): Promise<OfferState> {
    try {
      const v = careerRecordObject(this.open('service_offer',row.id,row.org_id,row.revision,row.payload_ciphertext),
        ['id','orgId','revision','status','terms','reviewedAt','reviewEvidenceRef','configuredBy','updatedAt','withdrawalReason']);
      const s: OfferState = {id:careerRecordId(v.id),orgId:careerRecordId(v.orgId),revision:mentorServiceInteger(v.revision,1),
        status:v.status as OfferState['status'],terms:parseMentorServiceTerms(v.terms),reviewedAt:mentorServiceTime(v.reviewedAt),
        reviewEvidenceRef:careerRecordId(v.reviewEvidenceRef),configuredBy:careerRecordId(v.configuredBy),
        updatedAt:mentorServiceTime(v.updatedAt),withdrawalReason:v.withdrawalReason === null ? null : mentorServiceText(v.withdrawalReason,500)};
      if (s.id !== row.id || s.orgId !== row.org_id || s.revision !== row.revision || s.status !== row.status ||
        !['active','withdrawn'].includes(s.status) || (s.status === 'withdrawn') !== (s.withdrawalReason !== null) ||
        s.terms.kind !== row.service_kind || s.terms.durationMin !== row.duration_min || s.terms.priceCents !== row.price_cents ||
        s.terms.currency !== row.currency || s.terms.validFrom !== row.valid_from.toISOString() ||
        s.terms.validUntil !== row.valid_until.toISOString() || s.terms.earliestSlotAt !== (row.earliest_slot_at?.toISOString() ?? null) ||
        s.updatedAt !== row.updated_at.toISOString() || s.reviewedAt > s.updatedAt) throw Error();
      const proof = (await c.query('SELECT revision,proof_ciphertext FROM platform_service_offer_proofs WHERE org_id=$1 AND offer_id=$2 ORDER BY revision DESC LIMIT 1 FOR SHARE',[s.orgId,s.id])).rows[0];
      if (!proof || proof.revision !== s.revision) throw Error();
      const value = careerRecordObject(this.open('service_offer_proof',s.id,s.orgId,s.revision,proof.proof_ciphertext),['digest']);
      if (value.digest !== digest(s)) throw Error(); return s;
    } catch { throw unavailable(); }
  }
  private public(s: OfferState, at: string): Readonly<MentorServiceOffer> {
    const availability = s.terms.earliestSlotAt !== null && s.terms.earliestSlotAt > at ? 'available' : 'unavailable';
    return parseMentorServiceOffer({...s.terms,id:s.id,organizationId:s.orgId,revision:s.revision,updatedAt:s.updatedAt,
      availability,intentPrivacy:MENTOR_INTENT_PRIVACY});
  }
  async list(session: FixedSessionContext, organizationId: string, signal?: AbortSignal): Promise<readonly MentorServiceOffer[]> {
    const context = fixed(session), org = careerRecordId(organizationId);
    return this.db.withBoundedTransaction(c => this.listInTransaction(c,context,org,signal));
  }
  /** Internal read shares the caller transaction and holds actual catalog locks. */
  async listInTransaction(c:PoolClient,session:FixedSessionContext,organizationId:string,signal?:AbortSignal):Promise<readonly MentorServiceOffer[]> {
    const context=fixed(session),org=careerRecordId(organizationId);
    await this.store.authorizeSession(c,context,signal);
    const active = (await c.query("SELECT id FROM platform_orgs WHERE id=$1 AND status='active' FOR SHARE",[org])).rowCount;
    if (!active) throw new ApiError(404,'NOT_FOUND','服务目录不存在。');
    const at = (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    // Inspect every current row, not only rows SQL claims are valid. Corruption must not hide a service.
    const rows = (await c.query<OfferRow>('SELECT * FROM platform_service_offers WHERE org_id=$1 ORDER BY service_kind,id LIMIT 101 FOR SHARE',[org])).rows;
    if (rows.length > 100) throw unavailable();
    const states: OfferState[] = [];
    for (const row of rows) {
      signal?.throwIfAborted(); const s = await this.decode(c,row);
      if (s.status !== 'active' || s.terms.validFrom > at || s.terms.validUntil <= at) continue;
      const evidence = (await c.query('SELECT id,storage_key,byte_size FROM platform_uploads WHERE id=$1 AND user_id=$2 AND byte_size>0 FOR SHARE',[s.reviewEvidenceRef,s.configuredBy])).rows[0];
      if (evidence) {
        const actual = await this.blobs.stat(evidence.storage_key,signal).catch(() => { throw unavailable(); });
        if (actual.size !== Number(evidence.byte_size)) throw unavailable(); states.push(s);
      }
    }
    await this.store.authorizeSession(c,context,signal); signal?.throwIfAborted();
    const finalAt = (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    signal?.throwIfAborted();
    return Object.freeze(states.filter(s => s.terms.validFrom <= finalAt && s.terms.validUntil > finalAt).map(s => this.public(s,finalAt)));
  }
  async staffList(session: FixedSessionContext, organizationId: string, signal?: AbortSignal) {
    const context = fixed(session),org = careerRecordId(organizationId);
    return this.staff.readWithAccess(context,org,{roles:['ops','org_admin'],action:'service_offers_viewed'},async c => {
      const rows = (await c.query<OfferRow>('SELECT * FROM platform_service_offers WHERE org_id=$1 ORDER BY service_kind,id LIMIT 101 FOR SHARE',[org])).rows;
      if (rows.length > 100) throw unavailable();
      const offers: OfferReceipt[] = [];
      for (const row of rows) { signal?.throwIfAborted(); const s = await this.decode(c,row); offers.push({offerId:s.id,revision:s.revision,status:s.status}); }
      return {value:offers,recordCount:offers.length};
    },signal);
  }
  async set(session: FixedSessionContext, organizationId: string, input: unknown, signal?: AbortSignal): Promise<OfferReceipt> {
    let command: {operationId:string;offerId:string;expectedRevision:number;terms:Readonly<MentorServiceTerms>;reviewedAt:string;reviewEvidenceRef:string};
    try { const v = careerRecordObject(input,['operationId','offerId','expectedRevision','terms','reviewedAt','reviewEvidenceRef']);
      command = {operationId:careerRecordId(v.operationId),offerId:careerRecordId(v.offerId),
        expectedRevision:mentorServiceInteger(v.expectedRevision,0,2147483646),terms:parseMentorServiceTerms(v.terms),
        reviewedAt:mentorServiceTime(v.reviewedAt),reviewEvidenceRef:careerRecordId(v.reviewEvidenceRef)};
    } catch { throw invalid(); }
    return this.mutate(session,organizationId,'service_offer_set',command,async (c,context,org,at) => {
      const row = (await c.query<OfferRow>('SELECT * FROM platform_service_offers WHERE id=$1 AND org_id=$2 FOR UPDATE',[command.offerId,org])).rows[0];
      const old = row ? await this.decode(c,row) : null;
      if ((old?.revision ?? 0) !== command.expectedRevision) throw changed();
      if (command.reviewedAt > at || command.terms.validUntil <= at ||
          command.terms.earliestSlotAt !== null && command.terms.earliestSlotAt <= at) throw invalid();
      const other = await c.query("SELECT id FROM platform_service_offers WHERE org_id=$1 AND service_kind=$2 AND status='active' AND id<>$3 FOR SHARE",[org,command.terms.kind,command.offerId]);
      if (other.rowCount) throw new ApiError(409,'SERVICE_OFFER_KIND_CONFLICT','请更新或撤下现有服务价目。');
      const evidence = (await c.query('SELECT id,storage_key,byte_size FROM platform_uploads WHERE id=$1 AND user_id=$2 AND byte_size>0 FOR SHARE',[command.reviewEvidenceRef,context.userId])).rows[0];
      if (!evidence) throw new ApiError(404,'NOT_FOUND','请先保存本人的私有服务审核凭据。');
      const actual = await this.blobs.stat(evidence.storage_key,signal).catch(() => {throw unavailable();});
      if (actual.size !== Number(evidence.byte_size)) throw unavailable();
      const acceptedAt = (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
      if (command.terms.validUntil <= acceptedAt || command.terms.earliestSlotAt !== null && command.terms.earliestSlotAt <= acceptedAt) throw invalid();
      const s: OfferState = {id:command.offerId,orgId:org,revision:command.expectedRevision+1,status:'active',terms:command.terms,
        reviewedAt:command.reviewedAt,reviewEvidenceRef:command.reviewEvidenceRef,configuredBy:context.userId,updatedAt:acceptedAt,withdrawalReason:null};
      await this.write(c,s); return {offerId:s.id,revision:s.revision,status:s.status};
    },signal);
  }
  async withdraw(session: FixedSessionContext, organizationId: string, input: unknown, signal?: AbortSignal): Promise<OfferReceipt> {
    let command: {operationId:string;offerId:string;expectedRevision:number;reason:string};
    try {const v = careerRecordObject(input,['operationId','offerId','expectedRevision','reason']);
      command = {operationId:careerRecordId(v.operationId),offerId:careerRecordId(v.offerId),expectedRevision:mentorServiceInteger(v.expectedRevision,1,2147483646),reason:mentorServiceText(v.reason,500)};
    } catch { throw invalid(); }
    return this.mutate(session,organizationId,'service_offer_withdrawn',command,async (c,_context,org,at) => {
      const row = (await c.query<OfferRow>('SELECT * FROM platform_service_offers WHERE id=$1 AND org_id=$2 FOR UPDATE',[command.offerId,org])).rows[0];
      if (!row) throw new ApiError(404,'NOT_FOUND','服务不存在。'); const old = await this.decode(c,row);
      if (old.revision !== command.expectedRevision || old.status !== 'active') throw changed();
      const s: OfferState = {...old,revision:old.revision+1,status:'withdrawn',updatedAt:at,withdrawalReason:command.reason};
      await this.write(c,s);return {offerId:s.id,revision:s.revision,status:s.status};
    },signal);
  }
  private async write(c: PoolClient,s: OfferState) {
    const t = s.terms;
    const saved = await c.query(`INSERT INTO platform_service_offers(id,org_id,service_kind,duration_min,price_cents,currency,status,revision,valid_from,valid_until,earliest_slot_at,updated_at,payload_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET service_kind=EXCLUDED.service_kind,duration_min=EXCLUDED.duration_min,price_cents=EXCLUDED.price_cents,
      currency=EXCLUDED.currency,status=EXCLUDED.status,revision=EXCLUDED.revision,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,
      earliest_slot_at=EXCLUDED.earliest_slot_at,updated_at=EXCLUDED.updated_at,payload_ciphertext=EXCLUDED.payload_ciphertext
      WHERE platform_service_offers.org_id=EXCLUDED.org_id`,
      [s.id,s.orgId,t.kind,t.durationMin,t.priceCents,t.currency,s.status,s.revision,t.validFrom,t.validUntil,t.earliestSlotAt,s.updatedAt,this.seal('service_offer',s.id,s.orgId,s.revision,s)]);
    if (saved.rowCount !== 1) throw changed();
    await c.query('INSERT INTO platform_service_offer_proofs(org_id,offer_id,revision,proof_ciphertext) VALUES($1,$2,$3,$4)',
      [s.orgId,s.id,s.revision,this.seal('service_offer_proof',s.id,s.orgId,s.revision,{digest:digest(s)})]);
  }
  private async mutate(session:FixedSessionContext,organizationId:string,action:'service_offer_set'|'service_offer_withdrawn',
    command:{operationId:string;offerId:string},run:(c:PoolClient,s:FixedSessionContext,org:string,at:string)=>Promise<OfferReceipt>,signal?:AbortSignal) {
    const context = fixed(session),org = careerRecordId(organizationId);
    return this.staff.readWithAccess(context,org,{roles:['ops','org_admin'],action,targetId:command.offerId,exclusiveOrganization:true},async c => {
      const old = (await c.query('SELECT receipt_ciphertext FROM platform_service_offer_operations WHERE org_id=$1 AND operation_id=$2 FOR SHARE',[org,command.operationId])).rows[0];
      let result: OfferReceipt;
      if (old) {
        const p = careerRecordObject(this.open('service_offer_operation',command.operationId,org,1,old.receipt_ciphertext),['actorId','action','digest','result']);
        if (p.actorId !== context.userId || p.action !== action || p.digest !== digest(command)) throw new ApiError(409,'SERVICE_OFFER_OPERATION_CONFLICT','操作编号已用于其他请求。');
        const r = careerRecordObject(p.result,['offerId','revision','status']);
        if (r.offerId !== command.offerId || !['active','withdrawn'].includes(r.status as string)) throw unavailable();
        result = {offerId:careerRecordId(r.offerId),revision:mentorServiceInteger(r.revision,1),status:r.status as OfferReceipt['status']};
      } else {
        const at = (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
        signal?.throwIfAborted();result = await run(c,context,org,at);signal?.throwIfAborted();
        await c.query('INSERT INTO platform_service_offer_operations(org_id,operation_id,receipt_ciphertext) VALUES($1,$2,$3)',
          [org,command.operationId,this.seal('service_offer_operation',command.operationId,org,1,{actorId:context.userId,action,digest:digest(command),result})]);
      }
      return {value:Object.freeze(result),recordCount:1};
    },signal);
  }
}
