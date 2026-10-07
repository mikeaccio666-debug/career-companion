import type { ModelCallEvent } from '@companion/platform-contracts';

export type EvalPriceTier = 'development' | 'formal';
export type EvalStage = 'pilot' | 'full' | 'formal_pilot' | 'formal';
export type EvalModelPurpose = 'companion_reply' | 'expert_consult' | 'room_turn';
/** A human-reviewed upper tariff for this exact configured route, not an invoice guarantee. */
export interface EvalPriceSnapshot {
  id: string;
  provider: string;
  model: string;
  tier: EvalPriceTier;
  sourceUrl: string;
  checkedAt: string;
  expiresAt: string;
  reviewedBy: 'human';
  approvedConfigId: string;
  tariffProfileId: string;
  maxContextInputTokens: number;
  maxOutputTokens: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
}
export interface EvalCaseBinding {
  caseId: string;
  stage: EvalStage;
  provider: string;
  model: string;
  purpose: EvalModelPurpose;
  priceSnapshotId: string;
  maxOutputTokens: number;
  /** Includes retries and any final tools-disabled model call. */
  maxModelCalls: number;
}
export type EvalBudgetStopReason = 'binding_invalid' | 'duplicate_call' | 'inflight_call' | 'usage_missing' | 'usage_invalid' | 'usage_exceeds_reservation' | 'persistence_failure' | 'price_unconfirmed' | 'budget_limit' | 'stage_blocked' | 'cancelled';
export class EvalBudgetError extends Error {
  readonly code: 'EVAL_BUDGET_CONFIG_INVALID' | 'EVAL_PRICE_UNCONFIRMED' | 'EVAL_STAGE_BLOCKED' | 'USAGE_RECORD_UNCONFIRMED';
  constructor(code: EvalBudgetError['code'], readonly reason: EvalBudgetStopReason) {
    super('The evaluation budget record or allowance could not be confirmed.');
    this.name = 'EvalBudgetError'; this.code = code;
  }
}
interface CallRecordIds {
  runId: string; caseId: string; stage: EvalStage; callId: string; index: number;
  provider: string; model: string; purpose: EvalModelPurpose; priceSnapshotId: string;
  approvedConfigId: string; tariffProfileId: string; atMs: number;
}
/** Deliberately contains only IDs, fixed enums, timestamps and integer measurements. */
export type EvalBudgetLedgerEvent =
  | CallRecordIds & { type: 'started_reserve'; inputReserveTokens: number; outputReserveTokens: number; reservedMicroUsd: number }
  | CallRecordIds & { type: 'finished_settled'; status: 'complete' | 'failed' | 'cancelled' | 'interrupted'; usageStatus: 'reported'; inputTokens: number; outputTokens: number; actualMicroUsd: number; reservedMicroUsd: number }
  | CallRecordIds & { type: 'finished_uncertain'; status: 'complete' | 'failed' | 'cancelled' | 'interrupted'; usageStatus: 'missing' | 'invalid' | 'out_of_bounds'; actualMicroUsd: null; reservedMicroUsd: number }
  | { type: 'case_completed'; runId: string; caseId: string; stage: EvalStage; calls: number; actualMicroUsd: number; atMs: number }
  | { type: 'forecast_approved'; runId: string; totalEstimatedMicroUsd: number; formalBasis: 'own_pilot' | 'full_context'; atMs: number }
  | { type: 'batch_stopped'; runId: string; reason: EvalBudgetStopReason; atMs: number };
export interface EvalBudgetOptions {
  runId: string;
  /** Strictly below USD 20. This guards the reviewed tariff estimate, not the upstream invoice. */
  capMicroUsd: number;
  prices: readonly EvalPriceSnapshot[];
  cases: readonly EvalCaseBinding[];
  /** Must durably write before resolving. Rejection leaves the reservation uncertain and stops the batch. */
  persist: (event: Readonly<EvalBudgetLedgerEvent>) => Promise<void>;
  signal?: AbortSignal;
  now?: () => Date;
}
export interface EvalBudgetSnapshot {
  status: 'active' | 'blocked' | 'cancelled';
  reason: EvalBudgetStopReason | null;
  capMicroUsd: number; actualSpentMicroUsd: number; pendingReservedMicroUsd: number; committedMicroUsd: number;
  startedCalls: number; reportedCalls: number; uncertainCalls: number; inflightCalls: number;
  completedCaseIds: readonly string[]; revision: number;
}
export interface EvalBudgetForecastRequest { fullCaseIds: readonly string[]; formalCaseIds: readonly string[]; }
export interface EvalBudgetForecast {
  status: 'ready' | 'blocked';
  reasons: readonly ('batch_stopped' | 'invalid_suite' | 'pilot_incomplete' | 'mixed_price_profiles' | 'inflight_call' | 'over_budget' | 'price_unconfirmed')[];
  developmentPilotCases: number; formalPilotCases: number; formalBasis: 'own_pilot' | 'full_context';
  developmentTotalMicroUsd: number | null; formalTotalMicroUsd: number | null;
  totalEstimatedMicroUsd: number | null; remainingEstimatedMicroUsd: number | null;
  committedMicroUsd: number; capMicroUsd: number; revision: number;
}
export interface EvalBudget {
  readonly signal: AbortSignal;
  accountingFor(caseId: string): (event: ModelCallEvent) => Promise<void>;
  completeCase(caseId: string): Promise<void>;
  snapshot(): EvalBudgetSnapshot;
  forecast(request: EvalBudgetForecastRequest): EvalBudgetForecast;
  /** Only accepts the unchanged, frozen forecast produced by this instance. It grants no provider or user authorization. */
  approveForecast(forecast: EvalBudgetForecast): Promise<void>;
  abort(): void;
}

const purposes = new Set(['companion_reply', 'expert_consult', 'room_turn']);
const stages = new Set(['pilot', 'full', 'formal_pilot', 'formal']);
const statuses = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
const fullMatch = (pattern: RegExp, value: string): boolean => pattern.exec(value)?.[0] === value;
const id = (value: unknown): value is string => typeof value === 'string' && fullMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,149}$/, value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const tokens = (value: unknown, minimum = 0): value is number => integer(value, minimum) && value <= 2_147_483_647;
function invalid(reason: EvalBudgetStopReason = 'binding_invalid'): never { throw new EvalBudgetError('EVAL_BUDGET_CONFIG_INVALID', reason); }
function safeNumber(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(value); }
function ceilRatio(value: bigint, divisor: bigint) { return safeNumber((value + divisor - 1n) / divisor); }

/** Decimal USD/M -> integer microUSD/M, without a floating point conversion. */
export function usdPerMillionToMicroUsd(decimal: string): number {
  if (typeof decimal !== 'string' || !fullMatch(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, decimal)) invalid('price_unconfirmed');
  const [whole, fraction = ''] = decimal.split('.');
  return safeNumber(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')));
}
export function estimateMicroUsd(price: Pick<EvalPriceSnapshot, 'inputMicroUsdPerMillion' | 'outputMicroUsdPerMillion'>, inputTokens: number, outputTokens: number): number {
  if (!tokens(inputTokens) || !tokens(outputTokens) || !integer(price.inputMicroUsdPerMillion) || !integer(price.outputMicroUsdPerMillion)) invalid('price_unconfirmed');
  return ceilRatio(BigInt(inputTokens) * BigInt(price.inputMicroUsdPerMillion) + BigInt(outputTokens) * BigInt(price.outputMicroUsdPerMillion), 1_000_000n);
}
function validatePrice(price: EvalPriceSnapshot, now: number) {
  let url: URL; try { url = new URL(price.sourceUrl); } catch { throw new EvalBudgetError('EVAL_PRICE_UNCONFIRMED', 'price_unconfirmed'); }
  if (!integer(now) || ![price.id, price.provider, price.model, price.approvedConfigId, price.tariffProfileId].every(id) ||
      !['development', 'formal'].includes(price.tier) || price.reviewedBy !== 'human' || url!.protocol !== 'https:' || url!.username || url!.password || url!.search || url!.hash ||
      !Number.isFinite(Date.parse(price.checkedAt)) || !Number.isFinite(Date.parse(price.expiresAt)) || Date.parse(price.checkedAt) > now || Date.parse(price.expiresAt) <= now || Date.parse(price.expiresAt) <= Date.parse(price.checkedAt) ||
      !tokens(price.maxContextInputTokens, 1) || !tokens(price.maxOutputTokens, 1) || !integer(price.inputMicroUsdPerMillion, 1) || !integer(price.outputMicroUsdPerMillion, 1)) {
    throw new EvalBudgetError('EVAL_PRICE_UNCONFIRMED', 'price_unconfirmed');
  }
}
function clockMs(now: () => Date): number {
  try { const value = now().getTime(); if (!integer(value)) invalid(); return value; }
  catch { invalid(); }
}
interface CallState { binding: Readonly<EvalCaseBinding>; price: Readonly<EvalPriceSnapshot>; callId: string; index: number; reserve: number; state: 'inflight' | 'settled' | 'uncertain'; actual: number | null; finish?: ModelCallEvent & { type: 'finished' }; }
interface CaseState { binding: Readonly<EvalCaseBinding>; calls: CallState[]; complete: boolean; }

/** Fresh-process budget only: no resume API, no main application tables, no secrets or model transport. */
export function createEvalBudget(options: EvalBudgetOptions): EvalBudget {
  const now = options.now ?? (() => new Date());
  const runId = options.runId, capMicroUsd = options.capMicroUsd, persistRecord = options.persist;
  if (!id(options.runId) || !integer(options.capMicroUsd, 1) || options.capMicroUsd >= 20_000_000 || typeof options.persist !== 'function' ||
      !Array.isArray(options.prices) || !options.prices.length || options.prices.length > 16 || !Array.isArray(options.cases) || options.cases.length > 512) invalid();
  const prices = new Map<string, Readonly<EvalPriceSnapshot>>(), cases = new Map<string, CaseState>(), calls = new Map<string, CallState>();
  for (const candidate of options.prices) {
    const price = Object.freeze({ ...candidate }); validatePrice(price, clockMs(now));
    if (prices.has(price.id)) invalid(); prices.set(price.id, price);
  }
  for (const candidate of options.cases) {
    const binding = Object.freeze({ ...candidate }), price = prices.get(binding.priceSnapshotId);
    if (!id(binding.caseId) || cases.has(binding.caseId) || !stages.has(binding.stage) || !purposes.has(binding.purpose) || !price ||
        binding.provider !== price.provider || binding.model !== price.model || !tokens(binding.maxOutputTokens, 1) || binding.maxOutputTokens > price.maxOutputTokens ||
        !integer(binding.maxModelCalls, 1) || binding.maxModelCalls > 64 ||
        (binding.stage === 'pilot' || binding.stage === 'full' ? price.tier !== 'development' : price.tier !== 'formal')) invalid();
    cases.set(binding.caseId, { binding, calls: [], complete: false });
  }
  const controller = new AbortController();
  let state: EvalBudgetSnapshot['status'] = 'active', reason: EvalBudgetStopReason | null = null, spent = 0, reserved = 0, revision = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const approvedCases = new Set<string>(), forecastObjects = new WeakMap<EvalBudgetForecast, EvalBudgetForecastRequest>();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation); tail = next.catch(() => {}); return next;
  };
  const timestamp = () => { try { return clockMs(now); } catch { fail('persistence_failure'); } };
  const stop = (nextReason: EvalBudgetStopReason) => {
    if (state === 'active') { state = nextReason === 'cancelled' ? 'cancelled' : 'blocked'; reason = nextReason; revision++; }
    if (!controller.signal.aborted) controller.abort(new EvalBudgetError('USAGE_RECORD_UNCONFIRMED', nextReason));
  };
  function fail(nextReason: EvalBudgetStopReason): never { stop(nextReason); throw new EvalBudgetError('USAGE_RECORD_UNCONFIRMED', nextReason); }
  const requireActive = () => { if (state !== 'active' || controller.signal.aborted) throw new EvalBudgetError('USAGE_RECORD_UNCONFIRMED', reason ?? 'cancelled'); };
  const persist = async (event: EvalBudgetLedgerEvent) => {
    try { await persistRecord(Object.freeze(event)); } catch { fail('persistence_failure'); }
  };
  const recordIds = (call: CallState): CallRecordIds => ({ runId, caseId: call.binding.caseId, stage: call.binding.stage, callId: call.callId, index: call.index,
    provider: call.binding.provider, model: call.binding.model, purpose: call.binding.purpose, priceSnapshotId: call.price.id,
    approvedConfigId: call.price.approvedConfigId, tariffProfileId: call.price.tariffProfileId, atMs: timestamp() });
  const snapshot = (): EvalBudgetSnapshot => Object.freeze({ status: state, reason, capMicroUsd, actualSpentMicroUsd: spent, pendingReservedMicroUsd: reserved,
    committedMicroUsd: spent + reserved, startedCalls: calls.size, reportedCalls: [...calls.values()].filter(call => call.state === 'settled').length,
    uncertainCalls: [...calls.values()].filter(call => call.state === 'uncertain').length, inflightCalls: [...calls.values()].filter(call => call.state === 'inflight').length,
    completedCaseIds: Object.freeze([...cases.values()].filter(item => item.complete).map(item => item.binding.caseId)), revision });
  const accounting = async (caseId: string, event: ModelCallEvent) => serialized(async () => {
    const item = cases.get(caseId);
    if (!item || !event || !id(event.callId)) fail('binding_invalid');
    if (event.type === 'started') {
      requireActive();
      if (calls.has(event.callId)) fail('duplicate_call');
      const binding = item.binding, price = prices.get(binding.priceSnapshotId)!;
      if (item.complete || event.provider !== binding.provider || event.model !== binding.model || event.purpose !== binding.purpose ||
          event.index !== item.calls.length + 1 || event.index > binding.maxModelCalls) fail('binding_invalid');
      if ([...calls.values()].some(call => call.state === 'inflight')) fail('inflight_call');
      if ((binding.stage === 'full' || binding.stage === 'formal') && !approvedCases.has(caseId)) fail('stage_blocked');
      try { validatePrice(price, clockMs(now)); } catch { fail('price_unconfirmed'); }
      const reserve = estimateMicroUsd(price, price.maxContextInputTokens, binding.maxOutputTokens);
      if (spent + reserved + reserve > capMicroUsd) fail('budget_limit');
      const call: CallState = { binding, price, callId: event.callId, index: event.index, reserve, state: 'inflight', actual: null };
      calls.set(call.callId, call); item.calls.push(call); reserved += reserve; revision++;
      try { await persist({ type: 'started_reserve', ...recordIds(call), inputReserveTokens: price.maxContextInputTokens, outputReserveTokens: binding.maxOutputTokens, reservedMicroUsd: reserve }); }
      catch (error) { call.state = 'uncertain'; revision++; throw error; }
      requireActive(); // Cancellation while awaiting the durable reservation must not permit HTTP.
      try { validatePrice(price, clockMs(now)); } catch { call.state = 'uncertain'; fail('price_unconfirmed'); }
      return;
    }
    if (event.type !== 'finished' || !statuses.has(event.status)) fail('binding_invalid');
    const call = calls.get(event.callId);
    if (!call || call.binding.caseId !== caseId) fail('binding_invalid');
    if (call.state === 'settled' && call.finish?.status === event.status && call.finish.usage.status === 'reported' && event.usage?.status === 'reported' &&
        call.finish.usage.inputTokens === event.usage.inputTokens && call.finish.usage.outputTokens === event.usage.outputTokens) return; // No second settlement/refund.
    if (call.state !== 'inflight') fail('duplicate_call');
    const usage = event.usage;
    let bad: EvalBudgetStopReason | undefined;
    if (!usage || !['reported', 'missing', 'invalid'].includes(usage.status)) bad = 'usage_invalid';
    else if (usage.status !== 'reported') bad = usage.status === 'missing' ? 'usage_missing' : 'usage_invalid';
    else if (!tokens(usage.inputTokens) || !tokens(usage.outputTokens)) bad = 'usage_invalid';
    else if (usage.inputTokens > call.price.maxContextInputTokens || usage.outputTokens > call.binding.maxOutputTokens) bad = 'usage_exceeds_reservation';
    const actual = !bad && usage.status === 'reported' ? estimateMicroUsd(call.price, usage.inputTokens, usage.outputTokens) : null;
    if (actual !== null && (actual > call.reserve || spent + reserved - call.reserve + actual > capMicroUsd)) bad = 'usage_exceeds_reservation';
    if (bad) {
      call.state = 'uncertain'; revision++; stop(bad);
      await persist({ type: 'finished_uncertain', ...recordIds(call), status: event.status, usageStatus: bad === 'usage_missing' ? 'missing' : bad === 'usage_exceeds_reservation' ? 'out_of_bounds' : 'invalid', actualMicroUsd: null, reservedMicroUsd: call.reserve });
      throw new EvalBudgetError('USAGE_RECORD_UNCONFIRMED', bad);
    }
    if (usage.status !== 'reported' || actual === null) fail('usage_invalid');
    try { await persist({ type: 'finished_settled', ...recordIds(call), status: event.status, usageStatus: 'reported', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, actualMicroUsd: actual, reservedMicroUsd: call.reserve }); }
    catch (error) { call.state = 'uncertain'; revision++; throw error; }
    // Release only a durably confirmed unused reservation, including reported failed/cancelled calls.
    reserved -= call.reserve; spent += actual; call.state = 'settled'; call.actual = actual;
    call.finish = { type: 'finished', callId: event.callId, status: event.status, usage: { status: 'reported', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }; revision++;
  });
  const completeCase = async (caseId: string) => serialized(async () => {
    requireActive(); const item = cases.get(caseId);
    if (!item || item.complete || !item.calls.length || item.calls.some(call => call.state !== 'settled')) fail('binding_invalid');
    await persist({ type: 'case_completed', runId, caseId, stage: item.binding.stage, calls: item.calls.length, actualMicroUsd: item.calls.reduce((sum, call) => sum + call.actual!, 0), atMs: timestamp() });
    requireActive(); item.complete = true; revision++;
  });
  const forecast = (request: EvalBudgetForecastRequest): EvalBudgetForecast => {
    const reasons: EvalBudgetForecast['reasons'][number][] = [];
    if (state !== 'active') reasons.push('batch_stopped');
    if (reserved) reasons.push('inflight_call');
    const fullIds = request?.fullCaseIds, formalIds = request?.formalCaseIds;
    const validIds = (ids: readonly string[] | undefined, count: number) => Array.isArray(ids) && ids.length === count && new Set(ids).size === count && ids.every(value => typeof value === 'string' && cases.has(value));
    if (!validIds(fullIds, 120) || !validIds(formalIds, 20) || fullIds.some(value => formalIds.includes(value))) reasons.push('invalid_suite');
    const full = Array.isArray(fullIds) ? fullIds.flatMap(value => cases.get(value) ?? []) : [], formal = Array.isArray(formalIds) ? formalIds.flatMap(value => cases.get(value) ?? []) : [];
    for (const priceId of new Set([...full, ...formal].map(item => item.binding.priceSnapshotId))) {
      try { validatePrice(prices.get(priceId)!, clockMs(now)); } catch { reasons.push('price_unconfirmed'); }
    }
    if (full.some(item => !['pilot', 'full'].includes(item.binding.stage)) || formal.some(item => !['formal_pilot', 'formal'].includes(item.binding.stage))) reasons.push('invalid_suite');
    const pilots = full.filter(item => item.binding.stage === 'pilot'), formalPilots = formal.filter(item => item.binding.stage === 'formal_pilot');
    if (pilots.length !== 12 || pilots.some(item => !item.complete)) reasons.push('pilot_incomplete');
    const oneProfile = (items: CaseState[]) => new Set(items.map(item => item.binding.priceSnapshotId)).size === 1;
    if (!oneProfile(full) || !oneProfile(formal)) reasons.push('mixed_price_profiles');
    const caseCost = (item: CaseState) => item.calls.reduce((sum, call) => sum + (call.actual ?? 0), 0);
    const meanCost = (items: CaseState[], count: number) => ceilRatio(items.reduce((sum, item) => sum + BigInt(caseCost(item)), 0n) * BigInt(count), BigInt(items.length));
    let developmentTotalMicroUsd: number | null = null, formalTotalMicroUsd: number | null = null;
    const formalBasis = formalPilots.length >= 2 && formalPilots.every(item => item.complete) ? 'own_pilot' : 'full_context';
    if (!reasons.includes('pilot_incomplete') && oneProfile(full)) developmentTotalMicroUsd = meanCost(pilots, 120);
    if (oneProfile(formal)) formalTotalMicroUsd = formalBasis === 'own_pilot' ? meanCost(formalPilots, 20) : safeNumber(formal.reduce((sum, item) => {
      const price = prices.get(item.binding.priceSnapshotId)!;
      return sum + BigInt(estimateMicroUsd(price, price.maxContextInputTokens, item.binding.maxOutputTokens)) * BigInt(item.binding.maxModelCalls);
    }, 0n));
    const totalEstimatedMicroUsd = developmentTotalMicroUsd === null || formalTotalMicroUsd === null ? null : safeNumber(BigInt(developmentTotalMicroUsd) + BigInt(formalTotalMicroUsd));
    const observedInSuite = [...full, ...formal].reduce((sum, item) => sum + caseCost(item), 0);
    const remainingEstimatedMicroUsd = totalEstimatedMicroUsd === null ? null : Math.max(0, totalEstimatedMicroUsd - observedInSuite);
    if (totalEstimatedMicroUsd !== null && (totalEstimatedMicroUsd > capMicroUsd || spent + reserved + remainingEstimatedMicroUsd! > capMicroUsd)) reasons.push('over_budget');
    const result: EvalBudgetForecast = Object.freeze({ status: reasons.length ? 'blocked' : 'ready', reasons: Object.freeze([...new Set(reasons)]),
      developmentPilotCases: pilots.filter(item => item.complete).length, formalPilotCases: formalPilots.filter(item => item.complete).length, formalBasis,
      developmentTotalMicroUsd, formalTotalMicroUsd, totalEstimatedMicroUsd, remainingEstimatedMicroUsd,
      committedMicroUsd: spent + reserved, capMicroUsd, revision });
    forecastObjects.set(result, { fullCaseIds: Object.freeze(Array.isArray(fullIds) ? [...fullIds] : []), formalCaseIds: Object.freeze(Array.isArray(formalIds) ? [...formalIds] : []) }); return result;
  };
  const approveForecast = async (result: EvalBudgetForecast) => serialized(async () => {
    requireActive(); const request = forecastObjects.get(result);
    if (!request || result.revision !== revision || result.status !== 'ready') throw new EvalBudgetError('EVAL_STAGE_BLOCKED', 'stage_blocked');
    const current = forecast(request);
    if (current.status !== 'ready') throw new EvalBudgetError('EVAL_STAGE_BLOCKED', 'stage_blocked');
    await persist({ type: 'forecast_approved', runId, totalEstimatedMicroUsd: current.totalEstimatedMicroUsd!, formalBasis: current.formalBasis, atMs: timestamp() });
    requireActive();
    for (const caseId of [...request.fullCaseIds, ...request.formalCaseIds]) approvedCases.add(caseId);
    revision++;
  });
  const abort = () => { stop('cancelled'); void serialized(async () => { await persist({ type: 'batch_stopped', runId, reason: reason ?? 'cancelled', atMs: timestamp() }); }).catch(() => {}); };
  if (options.signal) {
    if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
  }
  return Object.freeze({ signal: controller.signal, accountingFor: (caseId: string) => {
    if (!cases.has(caseId)) invalid(); return (event: ModelCallEvent) => accounting(caseId, event);
  }, completeCase, snapshot, forecast, approveForecast, abort });
}
