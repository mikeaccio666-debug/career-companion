import { parseNameSafetyPublicationCommand, parseNameSafetyResourceCommand, parseSafetyQuestionReserveCommand,
  type NameSafetyResourceBody, type NameSafetyResourceState, type NameSafetyBodyProjection,
  type NameSafetyResourceResult, type NameSafetyResourceAction, type SafetyQuestionReserveCommand } from './companion-name-safety-resources.ts';

/** Real source families. Onboarding references a genuine 027 text submission,
 * companion_name a genuine 043 submission. A discriminator is never authority. */
export type CompanionSafetySourceKind = 'onboarding' | 'companion_name';
export interface CompanionSafetySourceRef { readonly kind: CompanionSafetySourceKind; readonly submissionId: string; }
export interface CompanionSafetyPublicationRequest { readonly sourceRef: CompanionSafetySourceRef; readonly operationId: string; readonly expectedEdition: number; }
export interface CompanionSafetyTargetRequest { readonly sourceKind: CompanionSafetySourceKind; readonly publicationId: string; }
export interface CompanionSafetyResourceState extends NameSafetyResourceState { readonly sourceKind: CompanionSafetySourceKind; }
export interface CompanionSafetyBodyProjection extends NameSafetyBodyProjection { readonly sourceKind: CompanionSafetySourceKind; }
export interface CompanionSafetyResourceResult extends Omit<NameSafetyResourceResult, 'state'> { readonly state: CompanionSafetyResourceState; }
export type CompanionSafetyResourceBody = NameSafetyResourceBody;
export interface CompanionSafetyResourceIndex {
  readonly sources: readonly Readonly<{ sourceRef: CompanionSafetySourceRef;
    readonly availability: 'pending' | 'ready' | 'unavailable'; readonly publication: CompanionSafetyResourceState | null }>[];
}
export type CompanionSafetyResourceAction = NameSafetyResourceAction | Readonly<{ kind: 'continue_intake'; presentationReceipt: string }>;
export interface CompanionSafetyResourceCommand extends CompanionSafetyTargetRequest {
  readonly operationId: string; readonly expectedPublicationRevision: number; readonly action: CompanionSafetyResourceAction;
}
export interface CompanionSafetyQuestionReserveCommand extends SafetyQuestionReserveCommand { readonly sourceKind: CompanionSafetySourceKind; }
export interface CompanionSafetyQuestionState extends CompanionSafetyTargetRequest {
  readonly submissionId: string; readonly scopeRevision: number; readonly possibleLegacyExposure: boolean;
  readonly deliveryUncertain: boolean; readonly receiptReceivedAt: string | null;
  readonly sourcePhase: 'reserved' | 'claimed' | 'declared' | null;
}
export interface CompanionSafetyQuestionReserveResult {
  readonly sourceKind: CompanionSafetySourceKind; readonly publicationId: string;
  readonly occurrenceId: string; readonly reservationId: string; readonly generation: number;
  readonly reservedUntil: string; readonly scopeRevision: number;
  /** Hash-only reservation: exact retry cannot recreate a lost secret. */
  readonly reservationToken?: string;
  readonly operation: Readonly<{ id: string; appliedRevision: number; replayed: boolean }>;
}
interface CompanionSafetyQuestionClaimBase extends CompanionSafetyTargetRequest {
  readonly occurrenceId: string; readonly grantId: string; readonly generation: number; readonly renderOwnerId: string;
  readonly scopeRevision: number; readonly operation: Readonly<{ id: string; appliedRevision: number; replayed: boolean }>;
}
export type CompanionSafetyQuestionClaimResult =
  | (CompanionSafetyQuestionClaimBase & { readonly status: 'display_granted'; readonly grantPresentationToken: string;
      readonly question: string; readonly displayUntil: string;
      /** Actual final database clock; browser uses request-start monotonic time
       * and a conservative margin, never its wall clock, for a live DOM ticket. */
      readonly serverNow: string; readonly remainingDisplayMs: number })
  | (CompanionSafetyQuestionClaimBase & { readonly status: 'declared' | 'delivery_uncertain' });
export interface CompanionSafetyQuestionPresentResult {
  readonly occurrenceId: string; readonly receiptReceivedAt: string; readonly scopeRevision: number;
  readonly operation: Readonly<{ id: string; appliedRevision: number; replayed: boolean }>;
}
export class CompanionSafetyResourceContractError extends Error { readonly code = 'INVALID_INPUT'; constructor() { super('Use an actual resource source and operation.'); } }
function invalid(): never { throw new CompanionSafetyResourceContractError(); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function sourceKind(value: unknown): CompanionSafetySourceKind { if (value !== 'onboarding' && value !== 'companion_name') invalid(); return value; }
function uuid(value: unknown): string { if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) invalid(); return value; }
export function parseCompanionSafetySourceRef(value: unknown): Readonly<CompanionSafetySourceRef> {
  const data = fields(value, ['kind', 'submissionId']); return Object.freeze({ kind: sourceKind(data.kind), submissionId: uuid(data.submissionId) });
}
export function parseCompanionSafetyTargetRequest(value: unknown): Readonly<CompanionSafetyTargetRequest> {
  const data = fields(value, ['sourceKind', 'publicationId']); return Object.freeze({ sourceKind: sourceKind(data.sourceKind), publicationId: uuid(data.publicationId) });
}
export function parseCompanionSafetyPublicationRequest(value: unknown): Readonly<CompanionSafetyPublicationRequest> {
  const data = fields(value, ['sourceRef', 'operationId', 'expectedEdition']), sourceRef = parseCompanionSafetySourceRef(data.sourceRef);
  const parsed = parseNameSafetyPublicationCommand({ operationId: data.operationId, submissionId: sourceRef.submissionId, expectedEdition: data.expectedEdition });
  return Object.freeze({ sourceRef, operationId: parsed.operationId, expectedEdition: parsed.expectedEdition });
}
export function parseCompanionSafetyResourceCommand(value: unknown): Readonly<CompanionSafetyResourceCommand> {
  const data = fields(value, ['sourceKind', 'publicationId', 'operationId', 'expectedPublicationRevision', 'action']), kind = sourceKind(data.sourceKind);
  const actionDescriptors = data.action && typeof data.action === 'object' ? Object.getOwnPropertyDescriptors(data.action) : undefined;
  const actionKind = actionDescriptors?.kind && 'value' in actionDescriptors.kind ? actionDescriptors.kind.value : undefined;
  if (kind === 'onboarding' && actionKind === 'continue_naming' || kind === 'companion_name' && actionKind === 'continue_intake') invalid();
  let action = data.action;
  if (actionKind === 'continue_intake') { const original = fields(action, ['kind', 'presentationReceipt']); action = { kind: 'continue_naming', presentationReceipt: original.presentationReceipt }; }
  const parsed = parseNameSafetyResourceCommand({ operationId: data.operationId, publicationId: data.publicationId, expectedPublicationRevision: data.expectedPublicationRevision, action });
  return Object.freeze({ sourceKind: kind, ...parsed, action: actionKind === 'continue_intake'
    ? Object.freeze({ kind: 'continue_intake' as const, presentationReceipt: (parsed.action as { presentationReceipt: string }).presentationReceipt }) : parsed.action });
}
export function parseCompanionSafetyQuestionReserveCommand(value: unknown): Readonly<CompanionSafetyQuestionReserveCommand> {
  const data = fields(value, ['sourceKind', 'operationId', 'publicationId', 'expectedQuestionScopeRevision', 'renderOwnerId']);
  const parsed = parseSafetyQuestionReserveCommand({ operationId: data.operationId, publicationId: data.publicationId, expectedQuestionScopeRevision: data.expectedQuestionScopeRevision, renderOwnerId: data.renderOwnerId });
  return Object.freeze({ sourceKind: sourceKind(data.sourceKind), ...parsed });
}
