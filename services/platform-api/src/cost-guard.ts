import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';

export type CostCapability = 'chat' | 'background';
export interface CostReservationBinding {
  readonly id: string; readonly userId: string; readonly sourceKind: 'chat_call' | 'job'; readonly sourceId: string;
  readonly capability: CostCapability; readonly purpose: string; readonly provider: string; readonly model: string;
}
export interface CostReserveInput extends Omit<CostReservationBinding, 'id'> {
  readonly maxInputTokens: number; readonly maxOutputTokens: number; readonly ttlSeconds?: number; readonly reservationId?: string;
}
export interface CostReservation {
  readonly binding: Readonly<CostReservationBinding>; readonly estimateMicros: string; readonly expiresAt: string;
}
export type CostReason = 'global_policy_unavailable' | 'user_policy_unavailable' | 'price_unavailable'
  | 'global_month_limit' | 'global_day_limit' | 'user_hard_limit' | 'user_soft_limit' | 'user_day_limit' | 'global_budget_warning';
export type CostDecision = Readonly<{ decision: 'ok' | 'degrade'; reservation: CostReservation; reasons: readonly CostReason[] }>
  | Readonly<{ decision: 'block'; reason: CostReason; resumeAt?: string }>;
export type CostActualUsage = Readonly<{ status: 'reported'; inputTokens: number; outputTokens: number }>
  | Readonly<{ status: 'missing' | 'invalid' }>;
export interface CostSettlement { readonly costMicros: string; readonly estimated: boolean; }
const MAX_MICROS = 9_223_372_036_854_775_807n;
const unavailable = () => new ApiError(503, 'COST_RECORD_UNCONFIRMED', 'The model cost record could not be confirmed.');
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) throw unavailable();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) throw unavailable();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > maximum
    || /[\p{Cc}\ud800-\udfff]/u.test(value)) throw unavailable(); return value;
}
function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0) || value > 2_147_483_647) throw unavailable();
  return value;
}
function money(value: unknown): bigint {
  if (typeof value !== 'string' || /^(0|[1-9][0-9]{0,18})$/.exec(value)?.[0] !== value) throw unavailable();
  const result = BigInt(value); if (result > MAX_MICROS) throw unavailable(); return result;
}
function rate(value: unknown): bigint {
  if (typeof value !== 'string' || /^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/.exec(value)?.[0] !== value) throw unavailable();
  const [whole, fraction = ''] = value.split('.'), result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result <= 0n) throw unavailable(); return result;
}
/** Decimal micros per token are server price data, never IEEE-754 currency arithmetic. */
export function tokenCostMicros(inputTokens: number, outputTokens: number, inputRate: string, outputRate: string): string {
  const numerator = BigInt(tokens(inputTokens)) * rate(inputRate) + BigInt(tokens(outputTokens)) * rate(outputRate);
  const result = (numerator + 999_999n) / 1_000_000n;
  if (result > MAX_MICROS) throw unavailable(); return result.toString();
}
const bindingKeys = ['id', 'userId', 'sourceKind', 'sourceId', 'capability', 'purpose', 'provider', 'model'] as const;
function parseBinding(value: unknown): Readonly<CostReservationBinding> {
  const data = record(value, bindingKeys), capability = data.capability, sourceKind = data.sourceKind;
  if (typeof capability !== 'string' || !['chat', 'background'].includes(capability)
    || typeof sourceKind !== 'string' || !['chat_call', 'job'].includes(sourceKind)) throw unavailable();
  if (capability === 'chat' && sourceKind !== 'chat_call' || capability === 'background' && sourceKind !== 'job') throw unavailable();
  const provider = text(data.provider, 80);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.exec(provider)?.[0] !== provider) throw unavailable();
  return Object.freeze({ id: uuid(data.id), userId: uuid(data.userId), sourceKind: sourceKind as 'chat_call' | 'job',
    sourceId: uuid(data.sourceId), capability: capability as CostCapability, purpose: text(data.purpose, 80), provider, model: text(data.model, 150) });
}
function parseReserve(value: unknown) {
  const data = record(value, [...bindingKeys.filter(key => key !== 'id'), 'maxInputTokens', 'maxOutputTokens'], ['ttlSeconds', 'reservationId']);
  const ttlSeconds = data.ttlSeconds ?? 120;
  if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw unavailable();
  const binding = parseBinding({ id: data.reservationId ?? randomUUID(), userId: data.userId, sourceKind: data.sourceKind,
    sourceId: data.sourceId, capability: data.capability, purpose: data.purpose, provider: data.provider, model: data.model });
  const maxInputTokens = tokens(data.maxInputTokens), maxOutputTokens = tokens(data.maxOutputTokens);
  if (maxInputTokens + maxOutputTokens === 0) throw unavailable();
  return Object.freeze({ binding, maxInputTokens, maxOutputTokens, ttlSeconds });
}
function parseUsage(value: unknown): CostActualUsage {
  const data = record(value, ['status'], ['inputTokens', 'outputTokens']);
  if (data.status === 'reported') {
    record(value, ['status', 'inputTokens', 'outputTokens']);
    return Object.freeze({ status: 'reported', inputTokens: tokens(data.inputTokens), outputTokens: tokens(data.outputTokens) });
  }
  record(value, ['status']); if (data.status !== 'missing' && data.status !== 'invalid') throw unavailable();
  return Object.freeze({ status: data.status });
}
interface ReservationRow {
  id: string; user_id: string | null; source_kind: string; source_id: string; capability: string; purpose: string;
  provider: string; model: string; max_input_tokens: number; max_output_tokens: number; estimate_micros: string;
  input_micros_per_unit: string; output_micros_per_unit: string; status: string; expires_at: Date;
  input_price_id: string; output_price_id: string; ttl_seconds: number; admitted_at: Date | null; created_at: Date;
}
function matches(row: ReservationRow | undefined, binding: CostReservationBinding): row is ReservationRow {
  return !!row && row.id === binding.id && row.user_id === binding.userId && row.source_kind === binding.sourceKind
    && row.source_id === binding.sourceId && row.capability === binding.capability && row.purpose === binding.purpose
    && row.provider === binding.provider && row.model === binding.model;
}
function reservation(row: ReservationRow, binding: Readonly<CostReservationBinding>): CostReservation {
  return Object.freeze({ binding, estimateMicros: money(row.estimate_micros).toString(), expiresAt: row.expires_at.toISOString() });
}
const block = (reason: CostReason, resumeAt?: Date): CostDecision => Object.freeze({ decision: 'block', reason, ...(resumeAt ? { resumeAt: resumeAt.toISOString() } : {}) });
interface Periods { now: Date; day: Date; day_end: Date; week: Date; week_end: Date; month: Date; month_end: Date; }

/** Accounting only. Callers must independently fence the real source, identity, consent and execution lease. */
export class CostGuard {
  constructor(private readonly db: Database) {}
  private async lock(client: PoolClient, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // One advisory money lock also serializes the initially empty global-policy case and late settlements.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('companion-cost-guard'))");
    signal?.throwIfAborted();
  }
  private async recover(client: PoolClient) {
    await client.query(`UPDATE platform_cost_reservations SET status='released',finished_at=clock_timestamp()
      WHERE status='reserved' AND expires_at<=clock_timestamp()`);
    // A dispatched request may still have spent money. It can never expire into an uncharged release.
    await client.query(`INSERT INTO platform_cost_ledger(reservation_id,user_id,capability,source_kind,source_id,provider,model,
      units,cost_micros,estimated,usage_status,purpose,created_at)
      SELECT id,user_id,capability,source_kind,source_id,provider,model,
        jsonb_build_object('maxInputTokens',max_input_tokens,'maxOutputTokens',max_output_tokens),estimate_micros,true,'expired',purpose,admitted_at
      FROM platform_cost_reservations WHERE status='admitted' AND expires_at<=clock_timestamp()
      ON CONFLICT(reservation_id) DO NOTHING`);
    await client.query(`UPDATE platform_cost_reservations SET status='committed',finished_at=clock_timestamp()
      WHERE status='admitted' AND expires_at<=clock_timestamp()
        AND EXISTS(SELECT 1 FROM platform_cost_ledger l WHERE l.reservation_id=platform_cost_reservations.id)`);
  }
  private async periods(client: PoolClient): Promise<Periods> {
    const row = (await client.query(`WITH t AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS n)
      SELECT n AT TIME ZONE 'UTC' AS now,date_trunc('day',n) AT TIME ZONE 'UTC' AS day,
        (date_trunc('day',n)+interval '1 day') AT TIME ZONE 'UTC' AS day_end,
        date_trunc('week',n) AT TIME ZONE 'UTC' AS week,(date_trunc('week',n)+interval '1 week') AT TIME ZONE 'UTC' AS week_end,
        date_trunc('month',n) AT TIME ZONE 'UTC' AS month,(date_trunc('month',n)+interval '1 month') AT TIME ZONE 'UTC' AS month_end FROM t`)).rows[0];
    return row as Periods;
  }
  private async sums(client: PoolClient, userId: string | null, from: Date, until: Date, daily = false) {
    const result = (await client.query(`SELECT
      COALESCE((SELECT sum(cost_micros) FROM platform_cost_ledger WHERE ($1::uuid IS NULL OR user_id=$1)
        AND created_at>=$2 AND created_at<$3 AND (NOT $4::boolean OR capability IN ('chat','background'))),0)::text AS settled,
      COALESCE((SELECT sum(estimate_micros) FROM platform_cost_reservations WHERE ($1::uuid IS NULL OR user_id=$1)
        AND status IN ('reserved','admitted')),0)::text AS reserved`, [userId, from, until, daily])).rows[0];
    return { settled: money(result.settled), reserved: money(result.reserved) };
  }
  async reserveInTransaction(client: PoolClient, value: CostReserveInput, signal?: AbortSignal): Promise<CostDecision> {
    const input = parseReserve(value); return this.reserveParsed(client, input, signal);
  }
  private async reserveParsed(client: PoolClient, input: ReturnType<typeof parseReserve>, signal?: AbortSignal): Promise<CostDecision> {
    await this.lock(client, signal); await this.recover(client);
    const { binding, maxInputTokens, maxOutputTokens, ttlSeconds } = input, t = await this.periods(client);
    const existing = (await client.query<ReservationRow>('SELECT * FROM platform_cost_reservations WHERE id=$1 FOR UPDATE', [binding.id])).rows[0];
    if (existing) {
      if (!matches(existing, binding) || existing.max_input_tokens !== maxInputTokens || existing.max_output_tokens !== maxOutputTokens
        || existing.ttl_seconds !== ttlSeconds || existing.status !== 'reserved' || existing.expires_at <= t.now) throw unavailable();
    }
    const global = (await client.query(`SELECT * FROM platform_cost_global_policy WHERE singleton=true AND approved_by IS NOT NULL
      AND approved_at<=clock_timestamp() AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp()) FOR UPDATE`)).rows[0];
    if (!global) return block('global_policy_unavailable');
    const policy = (await client.query(`SELECT * FROM platform_cost_user_policy WHERE user_id=$1 AND approved_by IS NOT NULL
      AND approved_at<=clock_timestamp() AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp()) FOR UPDATE`, [binding.userId])).rows[0];
    if (!policy) return block('user_policy_unavailable');
    const prices = (await client.query(`SELECT id,unit,micros_per_unit::text FROM platform_model_prices WHERE provider=$1 AND model=$2 AND capability=$3
      AND unit IN ('input_token','output_token') AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp())`,
    [binding.provider, binding.model, binding.capability])).rows;
    const inPrices = prices.filter(p => p.unit === 'input_token'), outPrices = prices.filter(p => p.unit === 'output_token');
    if (inPrices.length !== 1 || outPrices.length !== 1) return block('price_unavailable');
    const estimate = money(tokenCostMicros(maxInputTokens, maxOutputTokens, inPrices[0].micros_per_unit, outPrices[0].micros_per_unit));
    if (estimate === 0n) throw unavailable();
    if (existing && (existing.input_price_id !== inPrices[0].id || existing.output_price_id !== outPrices[0].id
      || rate(existing.input_micros_per_unit) !== rate(inPrices[0].micros_per_unit)
      || rate(existing.output_micros_per_unit) !== rate(outPrices[0].micros_per_unit) || money(existing.estimate_micros) !== estimate)) throw unavailable();
    const month = await this.sums(client, null, t.month, t.month_end), day = await this.sums(client, null, t.day, t.day_end, true);
    const period = policy.period === 'week' ? [t.week, t.week_end] : [t.month, t.month_end];
    const owner = await this.sums(client, binding.userId, period[0], period[1]);
    const ownerDay = await this.sums(client, binding.userId, t.day, t.day_end, true);
    const additional = existing ? 0n : estimate;
    if (month.settled + month.reserved + additional > money(global.month_hard_micros)) return block('global_month_limit', t.month_end);
    if (day.settled + day.reserved + additional > money(global.day_hard_micros)) return block('global_day_limit', t.day_end);
    if (owner.settled + owner.reserved + additional > money(policy.hard_micros)) return block('user_hard_limit', period[1]);
    const reasons: CostReason[] = [];
    if (month.settled * 5n >= money(global.month_hard_micros) * 4n) reasons.push('global_budget_warning');
    if (owner.settled >= money(policy.soft_micros)) reasons.push('user_soft_limit');
    if (policy.day_micros !== null && ownerDay.settled >= money(policy.day_micros)) reasons.push('user_day_limit');
    const inserted = existing ?? (await client.query<ReservationRow>(`INSERT INTO platform_cost_reservations(id,user_id,source_kind,source_id,capability,purpose,provider,model,
      max_input_tokens,max_output_tokens,input_price_id,output_price_id,input_micros_per_unit,output_micros_per_unit,estimate_micros,ttl_seconds,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'reserved',clock_timestamp()+$16::int*interval '1 second') RETURNING *`,
    [binding.id, binding.userId, binding.sourceKind, binding.sourceId, binding.capability, binding.purpose, binding.provider, binding.model,
      maxInputTokens, maxOutputTokens, inPrices[0].id, outPrices[0].id, inPrices[0].micros_per_unit, outPrices[0].micros_per_unit, estimate.toString(), ttlSeconds])).rows[0];
    signal?.throwIfAborted();
    return Object.freeze({ decision: policy.soft_behavior === 'degrade' && reasons.some(r => r === 'user_soft_limit' || r === 'user_day_limit') ? 'degrade' : 'ok',
      reservation: reservation(inserted, binding), reasons: Object.freeze(reasons) });
  }
  async reserve(value: CostReserveInput, signal?: AbortSignal): Promise<CostDecision> {
    const input = parseReserve(value);
    return this.db.withBoundedTransaction(client => this.reserveParsed(client, input, signal));
  }
  async admitInTransaction(client: PoolClient, value: CostReservationBinding, signal?: AbortSignal): Promise<void> {
    const binding = parseBinding(value); await this.lock(client, signal); await this.recover(client);
    const row = (await client.query<ReservationRow>('SELECT * FROM platform_cost_reservations WHERE id=$1 FOR UPDATE', [binding.id])).rows[0];
    if (!matches(row, binding) || row.status !== 'reserved') throw unavailable();
    const policy = (await client.query(`SELECT g.month_hard_micros,g.day_hard_micros,u.period,u.hard_micros FROM platform_cost_global_policy g JOIN platform_cost_user_policy u ON u.user_id=$1
      WHERE g.singleton=true AND g.approved_by IS NOT NULL AND u.approved_by IS NOT NULL
        AND g.approved_at<=clock_timestamp() AND u.approved_at<=clock_timestamp()
        AND g.effective_from<=clock_timestamp() AND u.effective_from<=clock_timestamp()
        AND (g.effective_to IS NULL OR g.effective_to>clock_timestamp()) AND (u.effective_to IS NULL OR u.effective_to>clock_timestamp()) FOR UPDATE OF g,u`, [binding.userId])).rows[0];
    if (!policy) throw unavailable();
    const t = await this.periods(client), period = policy.period === 'week' ? [t.week, t.week_end] : [t.month, t.month_end];
    const month = await this.sums(client, null, t.month, t.month_end), owner = await this.sums(client, binding.userId, period[0], period[1]);
    const day = await this.sums(client, null, t.day, t.day_end, true);
    if (month.settled + month.reserved > money(policy.month_hard_micros)
      || owner.settled + owner.reserved > money(policy.hard_micros) || day.settled + day.reserved > money(policy.day_hard_micros)) throw unavailable();
    // There is no price-mutation API. Hold the complete route stable through the caller's launch transaction.
    await client.query('LOCK TABLE platform_model_prices IN SHARE MODE');
    const prices = (await client.query(`SELECT id,unit,micros_per_unit::text FROM platform_model_prices WHERE provider=$1 AND model=$2 AND capability=$3
      AND unit IN ('input_token','output_token') AND effective_from<=clock_timestamp()
      AND (effective_to IS NULL OR effective_to>clock_timestamp()) FOR SHARE`, [binding.provider, binding.model, binding.capability])).rows;
    const inputPrice = prices.find(p => p.id === row.input_price_id && p.unit === 'input_token'), outputPrice = prices.find(p => p.id === row.output_price_id && p.unit === 'output_token');
    if (prices.length !== 2 || !inputPrice || !outputPrice || rate(inputPrice.micros_per_unit) !== rate(row.input_micros_per_unit)
      || rate(outputPrice.micros_per_unit) !== rate(row.output_micros_per_unit)) throw unavailable();
    const changed = await client.query(`UPDATE platform_cost_reservations SET status='admitted',admitted_at=clock_timestamp()
      WHERE id=$1 AND status='reserved' AND expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM platform_cost_global_policy g JOIN platform_cost_user_policy u ON u.user_id=$2
          WHERE g.singleton=true AND g.approved_by IS NOT NULL AND u.approved_by IS NOT NULL
            AND g.approved_at<=clock_timestamp() AND u.approved_at<=clock_timestamp()
            AND g.effective_from<=clock_timestamp() AND u.effective_from<=clock_timestamp()
            AND (g.effective_to IS NULL OR g.effective_to>clock_timestamp()) AND (u.effective_to IS NULL OR u.effective_to>clock_timestamp()))
        AND EXISTS(SELECT 1 FROM platform_model_prices p WHERE p.id=platform_cost_reservations.input_price_id
          AND p.effective_from<=clock_timestamp() AND (p.effective_to IS NULL OR p.effective_to>clock_timestamp()))
        AND EXISTS(SELECT 1 FROM platform_model_prices p WHERE p.id=platform_cost_reservations.output_price_id
          AND p.effective_from<=clock_timestamp() AND (p.effective_to IS NULL OR p.effective_to>clock_timestamp()))`, [binding.id, binding.userId]);
    signal?.throwIfAborted(); if (changed.rowCount !== 1) throw unavailable();
  }
  async commitInTransaction(client: PoolClient, value: CostReservationBinding, actual: CostActualUsage, signal?: AbortSignal): Promise<CostSettlement> {
    const binding = parseBinding(value), usage = parseUsage(actual);
    return this.commitParsed(client, binding, usage, signal);
  }
  private async commitParsed(client: PoolClient, binding: Readonly<CostReservationBinding>, usage: CostActualUsage, signal?: AbortSignal): Promise<CostSettlement> {
    await this.lock(client, signal);
    const row = (await client.query<ReservationRow>('SELECT * FROM platform_cost_reservations WHERE id=$1 FOR UPDATE', [binding.id])).rows[0];
    if (!matches(row, binding) || !['admitted', 'committed'].includes(row.status) || !row.admitted_at) throw unavailable();
    const estimated = usage.status !== 'reported', units = usage.status === 'reported'
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
      : { maxInputTokens: row.max_input_tokens, maxOutputTokens: row.max_output_tokens };
    const costMicros = estimated ? money(row.estimate_micros).toString()
      : tokenCostMicros(usage.inputTokens, usage.outputTokens, row.input_micros_per_unit, row.output_micros_per_unit);
    const ledger = (await client.query('SELECT * FROM platform_cost_ledger WHERE reservation_id=$1 FOR UPDATE', [binding.id])).rows[0];
    if (ledger) {
      if (ledger.user_id !== binding.userId || ledger.source_id !== binding.sourceId || ledger.source_kind !== binding.sourceKind
        || ledger.provider !== binding.provider || ledger.model !== binding.model || ledger.capability !== binding.capability || ledger.purpose !== binding.purpose) throw unavailable();
      if (ledger.usage_status === usage.status && ledger.cost_micros === costMicros && JSON.stringify(ledger.units) === JSON.stringify(units)) {
        signal?.throwIfAborted(); return Object.freeze({ costMicros, estimated });
      }
      if (!ledger.estimated || usage.status !== 'reported' && ledger.usage_status !== 'expired') throw unavailable();
      await client.query(`UPDATE platform_cost_ledger SET units=$2::jsonb,cost_micros=$3,estimated=$4,usage_status=$5,settled_at=clock_timestamp()
        WHERE reservation_id=$1 AND estimated=true`, [binding.id, JSON.stringify(units), costMicros, estimated, usage.status]);
    } else {
      await client.query(`INSERT INTO platform_cost_ledger(reservation_id,user_id,capability,source_kind,source_id,provider,model,units,cost_micros,estimated,usage_status,purpose,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
      [binding.id, binding.userId, binding.capability, binding.sourceKind, binding.sourceId, binding.provider, binding.model, JSON.stringify(units), costMicros, estimated, usage.status, binding.purpose, row.admitted_at]);
    }
    await client.query(`UPDATE platform_cost_reservations SET status='committed',finished_at=clock_timestamp() WHERE id=$1 AND status='admitted'`, [binding.id]);
    signal?.throwIfAborted(); return Object.freeze({ costMicros, estimated });
  }
  async commit(value: CostReservationBinding, actual: CostActualUsage, signal?: AbortSignal): Promise<CostSettlement> {
    const binding = parseBinding(value), usage = parseUsage(actual);
    return this.db.withBoundedTransaction(client => this.commitParsed(client, binding, usage, signal));
  }
  async releaseInTransaction(client: PoolClient, value: CostReservationBinding, signal?: AbortSignal): Promise<void> {
    const binding = parseBinding(value); return this.releaseParsed(client, binding, signal);
  }
  private async releaseParsed(client: PoolClient, binding: Readonly<CostReservationBinding>, signal?: AbortSignal): Promise<void> {
    await this.lock(client, signal);
    const row = (await client.query<ReservationRow>('SELECT * FROM platform_cost_reservations WHERE id=$1 FOR UPDATE', [binding.id])).rows[0];
    if (!matches(row, binding) || !['reserved', 'released'].includes(row.status) || row.admitted_at) throw unavailable();
    await client.query(`UPDATE platform_cost_reservations SET status='released',finished_at=clock_timestamp() WHERE id=$1 AND status='reserved'`, [binding.id]);
    signal?.throwIfAborted();
  }
  async release(value: CostReservationBinding, signal?: AbortSignal): Promise<void> {
    const binding = parseBinding(value); return this.db.withBoundedTransaction(client => this.releaseParsed(client, binding, signal));
  }
}
