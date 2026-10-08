import { COMPANION_INK_TOKENS, type CompanionPublicInkToken } from './companion-entry.ts';

/**
 * Structural codecs for the birth boundary. They validate closed shapes and
 * projection links; they do not establish a current session, account ownership,
 * consent, source completeness, name eligibility, live asset review, rendered
 * assets, a committed birth, or permission to call a model or execute a tool.
 * The service must establish those facts from actual persisted sources.
 */
export interface CompanionBirthRequest {
  readonly name: string;
  readonly sealChar: string;
}

/** Idempotency-Key is a transport header, separate from the documented body. */
export interface CompanionBirthCommand {
  readonly idempotencyKey: string;
  readonly request: Readonly<CompanionBirthRequest>;
}

/** A main room belongs to this companion; this ID does not prove session ownership. */
export interface PublicCompanionMainRoom {
  readonly id: string;
  readonly kind: 'main';
  readonly companionId: string;
}

export interface PublicCompanionBirthIdentity {
  readonly companionId: string;
  readonly name: string;
  /** The current saved naming path supports user-typed names only. */
  readonly nameOrigin: 'user_typed';
  readonly sealChar: string;
  readonly inkToken: CompanionPublicInkToken;
  readonly personaRevision: 1;
  readonly identityRevision: number;
  readonly selectionRevision: number;
  readonly sealAssetId: string;
}

/** The birth line is a system event. Its subject's identity is in the receipt;
 * the system snapshot does not impersonate a companion's ordinary message. */
export interface PublicCompanionBirthSystemSnapshot {
  readonly displayName: '系统';
  readonly roleLabel: '系统';
  readonly sealChar: null;
  readonly inkToken: null;
  readonly personaRevision: null;
}

export interface PublicCompanionBirthEvent {
  readonly id: string;
  readonly conversationId: string;
  readonly companionId: string;
  readonly kind: 'event';
  readonly event: 'companion_born';
  readonly speakerKind: 'system';
  readonly speakerSnapshot: Readonly<PublicCompanionBirthSystemSnapshot>;
  readonly createdAt: string;
}

/** Immutable origin for an account-scoped replay or receipt observation.
 * No raw source text, auth, review, provider, model, or persona data is public. */
export interface PublicCompanionBirthReceipt {
  readonly kind: 'birth_receipt';
  readonly id: string;
  readonly idempotencyKey: string;
  readonly bornAt: string;
  readonly identity: Readonly<PublicCompanionBirthIdentity>;
  readonly main: Readonly<PublicCompanionMainRoom>;
  readonly event: Readonly<PublicCompanionBirthEvent>;
}

/** POST writes only the main room and birth event; C1 and the first letter have
 * separate generation paths. A replay result is not a new birth command. */
export interface CompanionBirthResult {
  readonly kind: 'birth_result';
  readonly receipt: Readonly<PublicCompanionBirthReceipt>;
  readonly replayed: boolean;
}

export interface PublicActiveCompanion {
  readonly kind: 'active_companion';
  readonly companionId: string;
  readonly status: 'active';
  readonly bornAt: string;
  readonly currentRevision: 1;
  /** Current profile, distinct from the immutable identity in a birth receipt. */
  readonly identity: Readonly<{
    name: string;
    nameOrigin: 'user_typed';
    sealChar: string;
    inkToken: CompanionPublicInkToken;
    sealAssetId: string;
  }>;
  readonly relationshipStage: 'acquainting' | 'familiar' | 'dormant';
  readonly main: Readonly<PublicCompanionMainRoom>;
}

/** Observation only; 'active' grants no turn, tool, or model authority. */
export type CompanionBirthViewerState =
  | Readonly<{ kind: 'not_born' }>
  | Readonly<{ kind: 'active'; companion: Readonly<PublicActiveCompanion> }>;

/** The server scopes a lookup to the authenticated account, using only the key. */
export type CompanionBirthReceiptObservation =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'found'; receipt: Readonly<PublicCompanionBirthReceipt> }>;

export class CompanionBirthContractError extends Error {
  readonly code = 'INVALID_COMPANION_BIRTH_DATA';

  constructor() {
    super('Use the documented companion birth data.');
    this.name = 'CompanionBirthContractError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_NAME = /[<>\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const INK_TOKENS: readonly string[] = COMPANION_INK_TOKENS;

function invalid(): never {
  throw new CompanionBirthContractError();
}

/** Read data descriptors so malformed accessors are rejected without invoking them. */
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) invalid();

  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function discriminator(value: unknown): unknown {
  const descriptor = value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, 'kind') : undefined;
  if (!descriptor || !('value' in descriptor)) invalid();
  return descriptor.value;
}

function uuid(value: unknown): string {
  // Exact-match comparison also rejects a trailing newline despite the $ anchor.
  if (typeof value !== 'string' || UUID.exec(value)?.[0] !== value) invalid();
  return value;
}

/** UUID syntax only: an idempotency key does not itself identify a saved receipt. */
export function parseCompanionBirthIdempotencyKey(value: unknown): string {
  return uuid(value);
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)
    || (value as number) < 1 || (value as number) > 2147483647) invalid();
  return value as number;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || UTC_TIMESTAMP.exec(value)?.[0] !== value
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function companionName(value: unknown, canonical: boolean): string {
  if (typeof value !== 'string' || value.length > 128 || UNSAFE_NAME.test(value)) invalid();

  // Match the existing naming path: preserve case/spelling, trim, then NFC before
  // counting Unicode characters. Reads must already be canonical, never repaired.
  const normalized = value.trim().normalize('NFC');
  const chars = Array.from(normalized);
  const han = /^\p{Unified_Ideograph}+$/u.test(normalized)
    && chars.length >= 1 && chars.length <= 6;
  const latin = /^[\p{Script=Latin} -]+$/u.test(normalized)
    && /\p{L}/u.test(normalized)
    && chars.every(char => char === ' ' || char === '-' || /\p{L}/u.test(char))
    && chars.length >= 1 && chars.length <= 16;
  if ((!han && !latin) || (canonical && normalized !== value)) invalid();
  return normalized;
}

function sealChar(value: unknown): string {
  // Shape only. The service checks the actual saved choice and reviewed inventory.
  if (typeof value !== 'string' || /^\p{Script=Han}$/u.exec(value)?.[0] !== value) invalid();
  return value;
}

function inkToken(value: unknown): CompanionPublicInkToken {
  if (typeof value !== 'string' || !INK_TOKENS.includes(value)) invalid();
  return value as CompanionPublicInkToken;
}

export function parseCompanionBirthRequest(value: unknown): Readonly<CompanionBirthRequest> {
  const data = fields(value, ['name', 'sealChar']);
  return Object.freeze({
    name: companionName(data.name, false),
    sealChar: sealChar(data.sealChar),
  });
}

export function parseCompanionBirthCommand(
  body: unknown,
  header: unknown,
): Readonly<CompanionBirthCommand> {
  return Object.freeze({
    idempotencyKey: parseCompanionBirthIdempotencyKey(header),
    request: parseCompanionBirthRequest(body),
  });
}

function mainRoom(value: unknown): Readonly<PublicCompanionMainRoom> {
  const data = fields(value, ['id', 'kind', 'companionId']);
  if (data.kind !== 'main') invalid();
  return Object.freeze({ id: uuid(data.id), kind: 'main', companionId: uuid(data.companionId) });
}

function birthIdentity(value: unknown): Readonly<PublicCompanionBirthIdentity> {
  const data = fields(value, [
    'companionId', 'name', 'nameOrigin', 'sealChar', 'inkToken', 'personaRevision',
    'identityRevision', 'selectionRevision', 'sealAssetId',
  ]);
  if (data.nameOrigin !== 'user_typed' || data.personaRevision !== 1) invalid();
  return Object.freeze({
    companionId: uuid(data.companionId),
    name: companionName(data.name, true),
    nameOrigin: 'user_typed',
    sealChar: sealChar(data.sealChar),
    inkToken: inkToken(data.inkToken),
    personaRevision: 1,
    identityRevision: positiveRevision(data.identityRevision),
    selectionRevision: positiveRevision(data.selectionRevision),
    sealAssetId: uuid(data.sealAssetId),
  });
}

function birthEvent(value: unknown): Readonly<PublicCompanionBirthEvent> {
  const data = fields(value, [
    'id', 'conversationId', 'companionId', 'kind', 'event', 'speakerKind',
    'speakerSnapshot', 'createdAt',
  ]);
  if (data.kind !== 'event' || data.event !== 'companion_born' || data.speakerKind !== 'system') invalid();

  const snapshot = fields(data.speakerSnapshot, [
    'displayName', 'roleLabel', 'sealChar', 'inkToken', 'personaRevision',
  ]);
  if (snapshot.displayName !== '系统' || snapshot.roleLabel !== '系统'
    || snapshot.sealChar !== null || snapshot.inkToken !== null
    || snapshot.personaRevision !== null) invalid();

  return Object.freeze({
    id: uuid(data.id),
    conversationId: uuid(data.conversationId),
    companionId: uuid(data.companionId),
    kind: 'event',
    event: 'companion_born',
    speakerKind: 'system',
    speakerSnapshot: Object.freeze({
      displayName: '系统',
      roleLabel: '系统',
      sealChar: null,
      inkToken: null,
      personaRevision: null,
    }),
    createdAt: timestamp(data.createdAt),
  });
}

export function parseCompanionBirthReceipt(value: unknown): Readonly<PublicCompanionBirthReceipt> {
  const data = fields(value, ['kind', 'id', 'idempotencyKey', 'bornAt', 'identity', 'main', 'event']);
  if (data.kind !== 'birth_receipt') invalid();

  const identity = birthIdentity(data.identity);
  const main = mainRoom(data.main);
  const event = birthEvent(data.event);
  const bornAt = timestamp(data.bornAt);
  if (main.companionId !== identity.companionId || event.companionId !== identity.companionId
    || event.conversationId !== main.id || event.createdAt !== bornAt) invalid();

  return Object.freeze({
    kind: 'birth_receipt',
    id: uuid(data.id),
    idempotencyKey: uuid(data.idempotencyKey),
    bornAt,
    identity,
    main,
    event,
  });
}

export function parseCompanionBirthResult(value: unknown): Readonly<CompanionBirthResult> {
  const data = fields(value, ['kind', 'receipt', 'replayed']);
  if (data.kind !== 'birth_result' || typeof data.replayed !== 'boolean') invalid();
  return Object.freeze({
    kind: 'birth_result',
    receipt: parseCompanionBirthReceipt(data.receipt),
    replayed: data.replayed,
  });
}

export function parseActiveCompanion(value: unknown): Readonly<PublicActiveCompanion> {
  const data = fields(value, [
    'kind', 'companionId', 'status', 'bornAt', 'currentRevision', 'identity',
    'relationshipStage', 'main',
  ]);
  if (data.kind !== 'active_companion' || data.status !== 'active' || data.currentRevision !== 1
    || !['acquainting', 'familiar', 'dormant'].includes(data.relationshipStage as string)) invalid();

  const companionId = uuid(data.companionId);
  const main = mainRoom(data.main);
  if (main.companionId !== companionId) invalid();

  const current = fields(data.identity, ['name', 'nameOrigin', 'sealChar', 'inkToken', 'sealAssetId']);
  if (current.nameOrigin !== 'user_typed') invalid();
  return Object.freeze({
    kind: 'active_companion',
    companionId,
    status: 'active',
    bornAt: timestamp(data.bornAt),
    currentRevision: 1,
    identity: Object.freeze({
      name: companionName(current.name, true),
      nameOrigin: 'user_typed',
      sealChar: sealChar(current.sealChar),
      inkToken: inkToken(current.inkToken),
      sealAssetId: uuid(current.sealAssetId),
    }),
    relationshipStage: data.relationshipStage as PublicActiveCompanion['relationshipStage'],
    main,
  });
}

export function parseCompanionBirthViewerState(value: unknown): Readonly<CompanionBirthViewerState> {
  if (discriminator(value) === 'not_born') {
    fields(value, ['kind']);
    return Object.freeze({ kind: 'not_born' });
  }

  const data = fields(value, ['kind', 'companion']);
  if (data.kind !== 'active') invalid();
  return Object.freeze({ kind: 'active', companion: parseActiveCompanion(data.companion) });
}

export function parseCompanionBirthReceiptObservation(
  value: unknown,
): Readonly<CompanionBirthReceiptObservation> {
  if (discriminator(value) === 'not_found') {
    fields(value, ['kind']);
    return Object.freeze({ kind: 'not_found' });
  }

  const data = fields(value, ['kind', 'receipt']);
  if (data.kind !== 'found') invalid();
  return Object.freeze({ kind: 'found', receipt: parseCompanionBirthReceipt(data.receipt) });
}
