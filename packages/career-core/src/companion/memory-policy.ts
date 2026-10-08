import { EXPERT_KEYS, SHARED_MEMORY_CATEGORIES as COMPANION_MEMORY_CATEGORIES, type AgentSpeakerKey } from '@companion/platform-contracts';

export { COMPANION_MEMORY_CATEGORIES };
export type CompanionMemoryCategory = typeof COMPANION_MEMORY_CATEGORIES[number];
export type ContextSensitivity = 'normal' | 'sensitive' | 'restricted';
export type ContextChannel = 'web' | 'discord' | 'voice';
export type MemoryPurpose = 'chat' | 'morning_brief' | 'self_set_reminder' | 'external_draft';
/** A server-read projection of the extended memory model (03 §8). Not a client grant or a persistence adapter. */
export interface ContextMemory {
  readonly id: string; readonly ownerId: string; readonly revision: number;
  readonly category: CompanionMemoryCategory; readonly sensitivity: ContextSensitivity;
  readonly status: 'proposed' | 'confirmed' | 'archived'; readonly confidence: 'high' | 'medium' | 'low';
  readonly usePolicy: 'normal' | 'only_if_user_raises'; readonly content: string;
  readonly confirmedAt: string | null; readonly validUntil: string | null;
  readonly speakerScope: AgentSpeakerKey | null; readonly intentKeys: readonly string[];
}
export interface MemoryContextScope {
  readonly ownerId: string; readonly speaker: AgentSpeakerKey; readonly channel: ContextChannel;
  readonly purpose: MemoryPurpose; readonly now: string; readonly intentKeys: readonly string[];
  /** IDs resolved by the trusted turn/reminder service, never inferred by this function. */
  readonly userRaisedMemoryIds: readonly string[]; readonly selfSetReminderMemoryIds: readonly string[];
}
export interface SelectedContextMemory {
  readonly id: string; readonly revision: number; readonly category: CompanionMemoryCategory;
  readonly sensitivity: ContextSensitivity; readonly confidence: 'high' | 'medium'; readonly content: string;
  readonly attribution: string | null;
}
export interface MemoryContextSelection {
  readonly policyRevision: 1; readonly stable: readonly SelectedContextMemory[];
  readonly current: readonly SelectedContextMemory[];
  /** The future authenticated caller must persist uses atomically. This is an intention, not a receipt. */
  readonly useReferences: readonly { readonly id: string; readonly revision: number }[];
}
export class MemoryContextError extends Error {
  readonly code = 'MEMORY_CONTEXT_INVALID';
  constructor() { super('The memory context could not be assembled.'); this.name = 'MemoryContextError'; }
}
function invalid(): never { throw new MemoryContextError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || /[\ud800-\udfff]/u.test(value)
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function identifier(value: unknown): string { const result = text(value, 240); if (result.trim() !== result || /\s/u.test(result)) invalid(); return result; }
function list(value: unknown, max: number, item: (value: unknown) => string): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))
    || Object.keys(descriptors).length !== value.length + 1) invalid();
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) { const d = descriptors[String(i)]; if (!d || !('value' in d)) invalid(); out.push(item(d.value)); }
  if (new Set(out).size !== out.length) invalid(); return out;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) invalid(); return value as T; }
function date(value: unknown): string { const result = text(value, 24); if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(); return result; }
function speaker(value: unknown): AgentSpeakerKey { return enumeration(value, ['companion', ...EXPERT_KEYS]); }
function parseScope(value: MemoryContextScope): MemoryContextScope {
  const r = record(value, ['ownerId', 'speaker', 'channel', 'purpose', 'now', 'intentKeys', 'userRaisedMemoryIds', 'selfSetReminderMemoryIds']);
  return { ownerId: identifier(r.ownerId), speaker: speaker(r.speaker), channel: enumeration(r.channel, ['web', 'discord', 'voice']),
    purpose: enumeration(r.purpose, ['chat', 'morning_brief', 'self_set_reminder', 'external_draft']), now: date(r.now),
    intentKeys: list(r.intentKeys, 30, identifier), userRaisedMemoryIds: list(r.userRaisedMemoryIds, 100, identifier),
    selfSetReminderMemoryIds: list(r.selfSetReminderMemoryIds, 100, identifier) };
}
function parseMemory(value: ContextMemory): ContextMemory {
  const r = record(value, ['id', 'ownerId', 'revision', 'category', 'sensitivity', 'status', 'confidence', 'usePolicy', 'content', 'confirmedAt', 'validUntil', 'speakerScope', 'intentKeys']);
  if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 1 || (r.revision as number) > 2147483647) invalid();
  const category = enumeration(r.category, COMPANION_MEMORY_CATEGORIES), status = enumeration(r.status, ['proposed', 'confirmed', 'archived']);
  if (r.speakerScope !== null && category !== 'communication' || status === 'confirmed' && r.confirmedAt === null) invalid();
  return { id: identifier(r.id), ownerId: identifier(r.ownerId), revision: r.revision as number, category,
    sensitivity: enumeration(r.sensitivity, ['normal', 'sensitive', 'restricted']), status,
    confidence: enumeration(r.confidence, ['high', 'medium', 'low']), usePolicy: enumeration(r.usePolicy, ['normal', 'only_if_user_raises']),
    content: text(r.content, 2000), confirmedAt: r.confirmedAt === null ? null : date(r.confirmedAt),
    validUntil: r.validUntil === null ? null : date(r.validUntil), speakerScope: r.speakerScope === null ? null : speaker(r.speakerScope),
    intentKeys: list(r.intentKeys, 30, identifier) };
}
function permitted(memory: ContextMemory, scope: MemoryContextScope): boolean {
  if (memory.status !== 'confirmed' || memory.confidence === 'low' || memory.confirmedAt! > scope.now
    || memory.validUntil !== null && memory.validUntil <= scope.now || memory.speakerScope !== null && memory.speakerScope !== scope.speaker) return false;
  const raised = scope.userRaisedMemoryIds.includes(memory.id);
  if (memory.usePolicy === 'only_if_user_raises' && !raised
    && !(scope.purpose === 'self_set_reminder' && scope.selfSetReminderMemoryIds.includes(memory.id))) return false;
  if (scope.purpose === 'external_draft' && memory.confidence !== 'high') return false;
  if (scope.speaker !== 'companion') {
    // Sensitive preferences travel only through the separately confirmed communication/handoff projection.
    // Never guess a harmless paraphrase of a sensitive or emotion_rhythm memory here.
    if (memory.sensitivity !== 'normal' || memory.category === 'emotion_rhythm') return false;
    if (memory.category === 'identity_timeline' && !['planner', 'guide', 'interviewer', 'applier'].includes(scope.speaker)) return false;
  }
  if (memory.sensitivity === 'normal') return true;
  // Redacted Discord summaries/reminder templates need their own reviewed projection; raw text is never substituted.
  if (scope.channel !== 'web') return false;
  if (memory.sensitivity === 'sensitive') return ['chat', 'external_draft'].includes(scope.purpose);
  return scope.purpose === 'chat' && raised || scope.purpose === 'self_set_reminder' && scope.selfSetReminderMemoryIds.includes(memory.id);
}
/** Pure, closed, bounded selection. It does not authenticate, classify, decrypt, confirm or save a use receipt. */
export function selectCompanionContextMemories(value: { scope: MemoryContextScope; memories: readonly ContextMemory[] }): MemoryContextSelection {
  const input = record(value, ['scope', 'memories']), scope = parseScope(input.scope as MemoryContextScope);
  // Validate dense arrays without reading getters before inspecting any private content.
  const encoded = input.memories;
  if (!Array.isArray(encoded) || Object.getPrototypeOf(encoded) !== Array.prototype || encoded.length > 2000) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(encoded);
  if (Reflect.ownKeys(encoded).length !== encoded.length + 1) invalid();
  const memories: ContextMemory[] = [];
  for (let i = 0; i < encoded.length; i++) { const d = descriptors[String(i)]; if (!d || !('value' in d)) invalid(); memories.push(parseMemory(d.value)); }
  if (memories.some(memory => memory.ownerId !== scope.ownerId) || new Set(memories.map(memory => memory.id)).size !== memories.length) invalid();
  const rank = (memory: ContextMemory) => memory.category === 'agreement' ? 0 : memory.category === 'communication' ? 1
    : memory.intentKeys.some(intent => scope.intentKeys.includes(intent)) ? 2 : 3;
  const selected = memories.filter(memory => permitted(memory, scope)).sort((a, b) => rank(a) - rank(b)
    || (a.confirmedAt! < b.confirmedAt! ? 1 : a.confirmedAt! > b.confirmedAt! ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, scope.speaker === 'companion' ? 30 : 15);
  const project = (memory: ContextMemory): SelectedContextMemory => Object.freeze({ id: memory.id, revision: memory.revision,
    category: memory.category, sensitivity: memory.sensitivity, confidence: memory.confidence as 'high' | 'medium', content: memory.content,
    attribution: memory.confidence === 'medium' ? `用户于 ${memory.confirmedAt!.slice(0, 10)} 确认过；尚需再次核对。` : null });
  // Only normal-sensitivity agreement/communication data belongs in the stable prefix.
  const stable = selected.filter(memory => memory.sensitivity === 'normal' && memory.usePolicy === 'normal' && ['agreement', 'communication'].includes(memory.category));
  const stableIds = new Set(stable.map(memory => memory.id));
  return Object.freeze({ policyRevision: 1, stable: Object.freeze(stable.map(project)),
    current: Object.freeze(selected.filter(memory => !stableIds.has(memory.id)).map(project)),
    useReferences: Object.freeze(selected.map(memory => Object.freeze({ id: memory.id, revision: memory.revision }))) });
}
