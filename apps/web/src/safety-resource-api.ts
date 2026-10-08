import {
  parseCompanionSafetyPublicationRequest, parseCompanionSafetyResourceCommand,
  parseCompanionSafetyQuestionReserveCommand, parseCompanionSafetyTargetRequest,
  parseSafetyQuestionClaimCommand, parseSafetyQuestionPresentCommand,
  type CompanionSafetyBodyProjection, type CompanionSafetyPublicationRequest,
  type CompanionSafetyQuestionClaimResult, type CompanionSafetyQuestionPresentResult,
  type CompanionSafetyQuestionReserveCommand, type CompanionSafetyQuestionReserveResult,
  type CompanionSafetyQuestionState, type CompanionSafetyResourceBody, type CompanionSafetyResourceCommand,
  type CompanionSafetyResourceIndex, type CompanionSafetyResourceResult, type CompanionSafetyResourceState,
  type CompanionSafetySourceKind, type CompanionSafetyTargetRequest,
  type SafetyQuestionClaimCommand, type SafetyQuestionPresentCommand,
} from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';

function invalid(): never { throw new Error('支持资源的记录暂时无法确认，请重新读取。'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const ds = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(ds, key))
    || Object.values(ds).some(d => !('value' in d) || !d.enumerable)) invalid();
  return Object.fromEntries(Object.keys(ds).map(key => [key, ds[key].value]));
}
function array(value: unknown, maximum = 1000): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const ds: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const n = ds.length?.value;
  if (!Number.isSafeInteger(n) || n < 0 || n > maximum || Reflect.ownKeys(value).length !== n + 1) invalid();
  const result: unknown[] = [];
  for (let i = 0; i < n; i++) { const d = ds[String(i)]; if (!d || !('value' in d) || !d.enumerable) invalid(); result.push(d.value); }
  return result;
}
function text(value: unknown, maximum = 10000): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum) invalid(); return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) invalid(); return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || /^[A-Za-z0-9_-]{43}$/.exec(value)?.[0] !== value) invalid(); return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > 2147483647) invalid(); return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(); return value as T;
}
function kind(value: unknown): CompanionSafetySourceKind { return member(value, ['onboarding', 'companion_name']); }
function timestamp(value: unknown): string {
  const t = text(value, 50); if (!Number.isFinite(Date.parse(t)) || new Date(t).toISOString() !== t) invalid(); return t;
}
function operation(value: unknown) {
  const d = record(value, ['id', 'appliedRevision', 'replayed']);
  return Object.freeze({ id: uuid(d.id), appliedRevision: integer(d.appliedRevision), replayed: boolean(d.replayed) });
}
type ContactAction = CompanionSafetyResourceBody['resourceCard']['contacts'][number]['actions'][number];
function contactAction(value: unknown): ContactAction {
  const base = record(value, ['kind', 'label'], ['number', 'body', 'url']), label = text(base.label, 500);
  if (base.kind === 'web') {
    const d = record(value, ['kind', 'label', 'url']), url = text(d.url, 2048), parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) invalid();
    return Object.freeze({ kind: 'web', label, url });
  }
  const k = member(base.kind, ['call', 'sms']), d = record(value, ['kind', 'label', 'number', ...(k === 'sms' ? ['body'] : [])]);
  const number = text(d.number, 40); if (/^\+?[0-9]{3,15}$/.exec(number)?.[0] !== number) invalid();
  return k === 'call' ? Object.freeze({ kind: k, label, number })
    : Object.freeze({ kind: k, label, number, body: d.body === null ? null : text(d.body, 1000) });
}
export function safetyResourceHref(value: ContactAction): string {
  const action = contactAction(value);
  return action.kind === 'web' ? action.url : action.kind === 'call' ? `tel:${action.number}`
    : `sms:${action.number}${action.body === null ? '' : '?body=' + encodeURIComponent(action.body)}`;
}
/** The body is deliberately closed: an old embedded question can never reach the resource DOM. */
export function parseSafetyResourceBody(value: unknown): CompanionSafetyResourceBody {
  const d = record(value, ['text', 'resourceCard']), card = record(d.resourceCard, ['title', 'contacts', 'schoolUnknown', 'footer', 'outsideUs']);
  const outside = record(card.outsideUs, ['label', 'text']);
  const contacts = array(card.contacts, 32).map(value => {
    const c = record(value, ['id', 'verifiedAt', 'name', 'description', 'actions']);
    const actions = array(c.actions, 3).map(contactAction); if (!actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) invalid();
    return Object.freeze({ id: text(c.id, 100), verifiedAt: timestamp(c.verifiedAt), name: text(c.name, 500),
      description: text(c.description, 3000), actions: Object.freeze(actions) });
  });
  if (!contacts.length || new Set(contacts.map(c => c.id)).size !== contacts.length) invalid();
  return Object.freeze({ text: text(d.text), resourceCard: Object.freeze({ title: text(card.title, 500), contacts: Object.freeze(contacts),
    schoolUnknown: text(card.schoolUnknown, 3000), footer: text(card.footer, 3000),
    outsideUs: Object.freeze({ label: text(outside.label, 500), text: text(outside.text, 3000) }) }) });
}
export function parseSafetyResourceState(value: unknown): CompanionSafetyResourceState {
  const d = record(value, ['sourceKind', 'publicationId', 'submissionId', 'edition', 'revision', 'status', 'level', 'mode',
    'preparedAt', 'publishedAt', 'retentionUntil', 'presented', 'acknowledged', 'handled', 'clarifiedAt']);
  const parsed = { sourceKind: kind(d.sourceKind), publicationId: uuid(d.publicationId), submissionId: uuid(d.submissionId),
    edition: integer(d.edition, 1), revision: integer(d.revision), status: member(d.status, ['ready', 'expired']),
    level: member(d.level, ['L1', 'L2']), mode: member(d.mode, ['full', 'keyword_only']),
    preparedAt: timestamp(d.preparedAt), publishedAt: timestamp(d.publishedAt), retentionUntil: timestamp(d.retentionUntil),
    presented: boolean(d.presented), acknowledged: boolean(d.acknowledged), handled: boolean(d.handled),
    clarifiedAt: d.clarifiedAt === null ? null : timestamp(d.clarifiedAt) };
  if (parsed.acknowledged && !parsed.presented || parsed.handled && !parsed.acknowledged
    || parsed.clarifiedAt !== null && !parsed.handled || Date.parse(parsed.publishedAt) < Date.parse(parsed.preparedAt)
    || Date.parse(parsed.retentionUntil) <= Date.parse(parsed.publishedAt)) invalid();
  return Object.freeze(parsed);
}
export function parseSafetyResourceIndex(value: unknown): CompanionSafetyResourceIndex {
  const d = record(value, ['sources']), seen = new Set<string>();
  const sources = array(d.sources).map(value => {
    const r = record(value, ['sourceRef', 'availability', 'publication']), ref = record(r.sourceRef, ['kind', 'submissionId']);
    const sourceRef = Object.freeze({ kind: kind(ref.kind), submissionId: uuid(ref.submissionId) });
    const availability = member(r.availability, ['pending', 'ready', 'unavailable']);
    const publication = r.publication === null ? null : parseSafetyResourceState(r.publication), key = sourceRef.kind + ':' + sourceRef.submissionId;
    if (seen.has(key) || publication && (availability !== 'ready' || publication.sourceKind !== sourceRef.kind || publication.submissionId !== sourceRef.submissionId)) invalid();
    seen.add(key); return Object.freeze({ sourceRef, availability, publication });
  });
  return Object.freeze({ sources: Object.freeze(sources) });
}
export function parseSafetyBodyProjection(value: unknown): CompanionSafetyBodyProjection {
  const d = record(value, ['sourceKind', 'publicationId', 'submissionId', 'revision', 'bodyProjectionId', 'body', 'retentionUntil']);
  return Object.freeze({ sourceKind: kind(d.sourceKind), publicationId: uuid(d.publicationId), submissionId: uuid(d.submissionId),
    revision: integer(d.revision), bodyProjectionId: uuid(d.bodyProjectionId), body: parseSafetyResourceBody(d.body), retentionUntil: timestamp(d.retentionUntil) });
}
export function parseSafetyQuestionState(value: unknown): CompanionSafetyQuestionState {
  const d = record(value, ['sourceKind', 'publicationId', 'submissionId', 'scopeRevision', 'possibleLegacyExposure', 'deliveryUncertain', 'receiptReceivedAt', 'sourcePhase']);
  return Object.freeze({ sourceKind: kind(d.sourceKind), publicationId: uuid(d.publicationId), submissionId: uuid(d.submissionId),
    scopeRevision: integer(d.scopeRevision), possibleLegacyExposure: boolean(d.possibleLegacyExposure), deliveryUncertain: boolean(d.deliveryUncertain),
    receiptReceivedAt: d.receiptReceivedAt === null ? null : timestamp(d.receiptReceivedAt),
    sourcePhase: d.sourcePhase === null ? null : member(d.sourcePhase, ['reserved', 'claimed', 'declared']) });
}
export function parseSafetyQuestionReservation(value: unknown): CompanionSafetyQuestionReserveResult {
  const d = record(value, ['sourceKind', 'publicationId', 'occurrenceId', 'reservationId', 'generation', 'reservedUntil', 'scopeRevision', 'operation'], ['reservationToken']);
  const parsed = { sourceKind: kind(d.sourceKind), publicationId: uuid(d.publicationId), occurrenceId: uuid(d.occurrenceId), reservationId: uuid(d.reservationId),
    generation: integer(d.generation, 1), reservedUntil: timestamp(d.reservedUntil), scopeRevision: integer(d.scopeRevision), operation: operation(d.operation),
    ...(Object.hasOwn(d, 'reservationToken') ? { reservationToken: token(d.reservationToken) } : {}) };
  if (parsed.operation.appliedRevision > parsed.scopeRevision || parsed.operation.replayed && parsed.reservationToken !== undefined) invalid(); return Object.freeze(parsed);
}
export function parseSafetyQuestionClaim(value: unknown): CompanionSafetyQuestionClaimResult {
  const ds = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'status') : undefined;
  if (!ds || !('value' in ds)) invalid();
  const live = ds.value === 'display_granted';
  const d = record(value, ['sourceKind', 'publicationId', 'occurrenceId', 'grantId', 'generation', 'renderOwnerId', 'scopeRevision', 'status', 'operation',
    ...(live ? ['grantPresentationToken', 'question', 'displayUntil', 'serverNow', 'remainingDisplayMs'] : [])]);
  const common = { sourceKind: kind(d.sourceKind), publicationId: uuid(d.publicationId), occurrenceId: uuid(d.occurrenceId), grantId: uuid(d.grantId),
    generation: integer(d.generation, 1), renderOwnerId: uuid(d.renderOwnerId), scopeRevision: integer(d.scopeRevision), operation: operation(d.operation) };
  if (common.operation.appliedRevision > common.scopeRevision) invalid();
  if (!live) return Object.freeze({ ...common, status: member(d.status, ['declared', 'delivery_uncertain']) });
  const serverNow = timestamp(d.serverNow), displayUntil = timestamp(d.displayUntil), remainingDisplayMs = d.remainingDisplayMs;
  if (typeof remainingDisplayMs !== 'number' || !Number.isFinite(remainingDisplayMs) || remainingDisplayMs <= 0
    || remainingDisplayMs > 86400000 || Math.abs(Date.parse(displayUntil) - Date.parse(serverNow) - remainingDisplayMs) >= 1) invalid();
  return Object.freeze({ ...common, status: 'display_granted', grantPresentationToken: token(d.grantPresentationToken),
    question: text(d.question, 1000), displayUntil, serverNow, remainingDisplayMs });
}
function matchTarget(actual: CompanionSafetyTargetRequest, expected: CompanionSafetyTargetRequest): void {
  if (actual.sourceKind !== expected.sourceKind || actual.publicationId !== expected.publicationId) invalid();
}
const post = (client: BoundPlatformClient, path: string, body: unknown, signal?: AbortSignal) => client.request<unknown>(path, { method: 'POST', body: JSON.stringify(body), signal });
export async function readSafetyResources(client: BoundPlatformClient, signal?: AbortSignal): Promise<CompanionSafetyResourceIndex> {
  return parseSafetyResourceIndex(record(await client.request('/companion/support', { signal }), ['index']).index);
}
export async function publishSafetyResource(client: BoundPlatformClient, value: CompanionSafetyPublicationRequest, recovery = false, signal?: AbortSignal) {
  const command = parseCompanionSafetyPublicationRequest(value), data = record(await post(client,
    '/companion/support/publications' + (recovery ? '/recovery' : ''), command, signal), ['publication']);
  if (data.publication === null) return null;
  const d = record(data.publication, ['sourceKind', 'publicationId', 'submissionId', 'edition', 'replayed']);
  const result = Object.freeze({ sourceKind: kind(d.sourceKind), publicationId: uuid(d.publicationId), submissionId: uuid(d.submissionId), edition: integer(d.edition, 1), replayed: boolean(d.replayed) });
  if (result.sourceKind !== command.sourceRef.kind || result.submissionId !== command.sourceRef.submissionId) invalid(); return result;
}
export async function readSafetyResource(client: BoundPlatformClient, target: CompanionSafetyTargetRequest, signal?: AbortSignal) {
  const t = parseCompanionSafetyTargetRequest(target), parsed = parseSafetyResourceState(record(await client.request(`/companion/support/${t.sourceKind}/${t.publicationId}`, { signal }), ['state']).state);
  matchTarget(parsed, t); return parsed;
}
export async function readSafetyBody(client: BoundPlatformClient, target: CompanionSafetyTargetRequest, signal?: AbortSignal) {
  const t = parseCompanionSafetyTargetRequest(target), p = parseSafetyBodyProjection(record(await post(client, '/companion/support/body', t, signal), ['projection']).projection);
  matchTarget(p, t); return p;
}
export async function actSafetyResource(client: BoundPlatformClient, value: CompanionSafetyResourceCommand, signal?: AbortSignal): Promise<CompanionSafetyResourceResult> {
  const command = parseCompanionSafetyResourceCommand(value), d = record(record(await post(client, '/companion/support/actions', command, signal), ['result']).result, ['state', 'operation'], ['presentationReceipt']);
  const result = Object.freeze({ state: parseSafetyResourceState(d.state), operation: operation(d.operation),
    ...(Object.hasOwn(d, 'presentationReceipt') ? { presentationReceipt: token(d.presentationReceipt) } : {}) });
  matchTarget(result.state, command);
  if (result.operation.id !== command.operationId || result.operation.appliedRevision !== command.expectedPublicationRevision + 1
    || result.state.revision < result.operation.appliedRevision || result.presentationReceipt !== undefined && (command.action.kind !== 'present_body' || result.operation.replayed)) invalid();
  return result;
}
export async function readSafetyQuestion(client: BoundPlatformClient, target: CompanionSafetyTargetRequest, signal?: AbortSignal) {
  const t = parseCompanionSafetyTargetRequest(target), s = parseSafetyQuestionState(record(await client.request(`/companion/support/questions/${t.sourceKind}/${t.publicationId}`, { signal }), ['state']).state);
  matchTarget(s, t); return s;
}
export async function reserveSafetyQuestion(client: BoundPlatformClient, value: CompanionSafetyQuestionReserveCommand, signal?: AbortSignal) {
  const command = parseCompanionSafetyQuestionReserveCommand(value), r = parseSafetyQuestionReservation(record(await post(client, '/companion/support/questions/reservations', command, signal), ['reservation']).reservation);
  matchTarget(r, command); if (r.operation.id !== command.operationId || r.operation.appliedRevision !== command.expectedQuestionScopeRevision + 1) invalid(); return r;
}
export async function claimSafetyQuestion(client: BoundPlatformClient, value: SafetyQuestionClaimCommand, target: CompanionSafetyTargetRequest, signal?: AbortSignal) {
  const command = parseSafetyQuestionClaimCommand(value), claim = parseSafetyQuestionClaim(record(await post(client, '/companion/support/questions/claims', command, signal), ['claim']).claim);
  matchTarget(claim, target);
  if (claim.operation.id !== command.operationId || claim.occurrenceId !== command.occurrenceId || claim.generation !== command.generation || claim.renderOwnerId !== command.renderOwnerId) invalid(); return claim;
}
export async function presentSafetyQuestion(client: BoundPlatformClient, value: SafetyQuestionPresentCommand, signal?: AbortSignal): Promise<CompanionSafetyQuestionPresentResult> {
  const command = parseSafetyQuestionPresentCommand(value), d = record(record(await post(client, '/companion/support/questions/presentations', command, signal), ['presentation']).presentation, ['occurrenceId', 'receiptReceivedAt', 'scopeRevision', 'operation']);
  const result = Object.freeze({ occurrenceId: uuid(d.occurrenceId), receiptReceivedAt: timestamp(d.receiptReceivedAt), scopeRevision: integer(d.scopeRevision), operation: operation(d.operation) });
  if (result.occurrenceId !== command.occurrenceId || result.operation.id !== command.operationId || result.operation.appliedRevision > result.scopeRevision) invalid(); return result;
}
