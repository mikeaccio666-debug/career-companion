import { parseCompanionBirthIdempotencyKey } from './companion-birth.ts';
import { COMPANION_INK_TOKENS, type CompanionPublicInkToken } from './companion-entry.ts';
/** C1 is a documented server-rendered introduction, not generated model output.
 * C2/C7 here record the user's selected next path, not completion of that path. */
export interface CompanionWelcome {
    readonly kind: 'welcome';
    readonly id: string;
    readonly companionId: string;
    readonly conversationId: string;
    readonly revision: 1 | 2;
    readonly step: 'C1' | 'C2' | 'C7';
    readonly choice: 'begin' | 'direct_letter' | null;
    readonly openedAt: string;
    readonly updatedAt: string;
    readonly intro: {
        readonly id: string;
        readonly kind: 'text';
        readonly rendering: 'fixed_intro_v1';
        readonly content: string;
        readonly createdAt: string;
        readonly speaker: {
            readonly name: string;
            readonly sealChar: string;
            readonly inkToken: CompanionPublicInkToken;
            readonly personaRevision: 1;
        };
    };
}
export type CompanionWelcomeObservation = {
    readonly kind: 'not_opened';
} | CompanionWelcome;
export interface CompanionWelcomeChoice {
    readonly operationId: string;
    readonly welcomeId: string;
    readonly expectedRevision: 1;
    readonly choice: 'begin' | 'direct_letter';
}
export interface CompanionWelcomeChoiceResult {
    readonly state: CompanionWelcome;
    readonly operation: {
        readonly id: string;
        readonly appliedRevision: 2;
        readonly replayed: boolean;
    };
}
export class CompanionWelcomeContractError extends Error {
    constructor() { super('Invalid companion welcome value.'); this.name = 'CompanionWelcomeContractError'; }
}
function fail(): never { throw new CompanionWelcomeContractError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        fail();
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(k => typeof k !== 'string' || !keys.includes(k))
        || keys.some(k => !descriptors[k] || !('value' in descriptors[k]) || !descriptors[k].enumerable))
        fail();
    return Object.fromEntries(keys.map(k => [k, descriptors[k].value]));
}
function uuid(value: unknown) { try {
    return parseCompanionBirthIdempotencyKey(value);
}
catch {
    return fail();
} }
function text(value: unknown, max: number) { if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    fail(); return value; }
function date(value: unknown) { const s = text(value, 30); if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s)
    fail(); return s; }
export function parseCompanionWelcomeChoice(value: unknown): Readonly<CompanionWelcomeChoice> {
    const v = record(value, ['operationId', 'welcomeId', 'expectedRevision', 'choice']);
    if (v.expectedRevision !== 1 || !['begin', 'direct_letter'].includes(v.choice as string))
        fail();
    return Object.freeze({ operationId: uuid(v.operationId), welcomeId: uuid(v.welcomeId), expectedRevision: 1, choice: v.choice as CompanionWelcomeChoice['choice'] });
}
export function parseCompanionWelcomeObservation(value: unknown): Readonly<CompanionWelcomeObservation> {
    if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'not_opened') {
        record(value, ['kind']);
        return Object.freeze({ kind: 'not_opened' });
    }
    const v = record(value, ['kind', 'id', 'companionId', 'conversationId', 'revision', 'step', 'choice', 'openedAt', 'updatedAt', 'intro']);
    if (v.kind !== 'welcome' || !(v.revision === 1 && v.step === 'C1' && v.choice === null
        || v.revision === 2 && (v.step === 'C2' && v.choice === 'begin' || v.step === 'C7' && v.choice === 'direct_letter')))
        fail();
    const i = record(v.intro, ['id', 'kind', 'rendering', 'content', 'createdAt', 'speaker']);
    const s = record(i.speaker, ['name', 'sealChar', 'inkToken', 'personaRevision']);
    if (i.kind !== 'text' || i.rendering !== 'fixed_intro_v1' || s.personaRevision !== 1 || !COMPANION_INK_TOKENS.includes(s.inkToken as CompanionPublicInkToken))
        fail();
    const openedAt = date(v.openedAt), updatedAt = date(v.updatedAt), createdAt = date(i.createdAt);
    if (createdAt !== openedAt || updatedAt < openedAt)
        fail();
    return Object.freeze({ kind: 'welcome', id: uuid(v.id), companionId: uuid(v.companionId), conversationId: uuid(v.conversationId),
        revision: v.revision as 1 | 2, step: v.step as CompanionWelcome['step'], choice: v.choice as CompanionWelcome['choice'], openedAt, updatedAt,
        intro: Object.freeze({ id: uuid(i.id), kind: 'text', rendering: 'fixed_intro_v1', content: text(i.content, 500), createdAt,
            speaker: Object.freeze({ name: text(s.name, 80), sealChar: text(s.sealChar, 4), inkToken: s.inkToken as CompanionPublicInkToken, personaRevision: 1 }) }) });
}
export function parseCompanionWelcomeChoiceResult(value: unknown): Readonly<CompanionWelcomeChoiceResult> {
    const v = record(value, ['state', 'operation']), o = record(v.operation, ['id', 'appliedRevision', 'replayed']);
    const state = parseCompanionWelcomeObservation(v.state);
    if (state.kind !== 'welcome' || state.revision !== 2 || o.appliedRevision !== 2 || typeof o.replayed !== 'boolean')
        fail();
    return Object.freeze({ state, operation: Object.freeze({ id: uuid(o.id), appliedRevision: 2, replayed: o.replayed }) });
}
export function parseCompanionWelcomeOpen(value: unknown) { const v = record(value, ['expectedCompanionId']); return Object.freeze({ expectedCompanionId: uuid(v.expectedCompanionId) }); }
