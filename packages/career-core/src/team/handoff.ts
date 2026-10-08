import { selectCompanionContextMemories, type ContextMemory, type MemoryContextScope } from '../companion/memory-policy.ts';
export interface HandoffResultSummary {
  readonly ownerId: string; readonly id: string; readonly revision: number;
  readonly sensitivity: 'normal'; readonly status: 'confirmed'; readonly content: string;
}
export interface HandoffNote {
  readonly policyRevision: 1; readonly text: string;
  readonly memoryReferences: readonly { readonly id: string; readonly revision: number }[];
  readonly resultReference: { readonly id: string; readonly revision: number } | null;
}
export class HandoffNoteError extends Error {
  readonly code = 'HANDOFF_NOTE_INVALID';
  constructor() { super('The expert handoff could not be assembled.'); this.name = 'HandoffNoteError'; }
}
function invalid(): never { throw new HandoffNoteError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(ds, key))
    || Object.values(ds).some(d => !('value' in d) || !d.enumerable)) invalid();
  return Object.fromEntries(keys.map(key => [key, ds[key].value]));
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || /[\ud800-\udfff]/u.test(value)
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(); return value;
}
/** 15 §5.2: deterministic visible note. No model inference or paraphrase of private traits. */
export function buildHandoffNote(value: { scope: MemoryContextScope; memories: readonly ContextMemory[]; objective: string; lastResultSummary: HandoffResultSummary | null }): HandoffNote {
  const input = record(value, ['scope', 'memories', 'objective', 'lastResultSummary']);
  const scope = record(input.scope, ['ownerId', 'speaker', 'channel', 'purpose', 'now', 'intentKeys', 'userRaisedMemoryIds', 'selfSetReminderMemoryIds']) as unknown as MemoryContextScope;
  let selected;
  try { selected = selectCompanionContextMemories({ scope, memories: input.memories as ContextMemory[] }); } catch { invalid(); }
  if (scope.speaker === 'companion' || scope.purpose !== 'chat') invalid();
  const objective = text(input.objective, 160);
  let last: string | null = null, resultReference: HandoffNote['resultReference'] = null;
  if (input.lastResultSummary !== null) {
    const result = record(input.lastResultSummary, ['ownerId', 'id', 'revision', 'sensitivity', 'status', 'content']);
    if (result.ownerId !== scope.ownerId || result.sensitivity !== 'normal' || result.status !== 'confirmed'
      || !Number.isSafeInteger(result.revision) || (result.revision as number) < 1 || (result.revision as number) > 2147483647) invalid();
    const id = text(result.id, 240); if (/\s/u.test(id)) invalid();
    last = text(result.content, 120); resultReference = Object.freeze({ id, revision: result.revision as number });
  }
  const memories = [...selected.stable, ...selected.current];
  const preferences = memories.filter(memory => memory.category === 'communication' && memory.sensitivity === 'normal'
    && memory.confidence === 'high' && Array.from(memory.content).length <= 80).slice(0, 1);
  const base = `目标：${objective}；偏好：${preferences.map(memory => memory.content).join('；') || '尚无已确认沟通偏好'}；上次：${last ?? '尚无本队员的结果摘要'}`;
  const facts = [] as typeof memories;
  for (const memory of memories) {
    if (memory.category === 'communication' || memory.sensitivity !== 'normal' || facts.length >= 4) continue;
    const quote = memory.attribution ? `${memory.content}（${memory.attribution}）` : memory.content;
    if (Array.from(quote).length > 120) continue;
    const parts = [...facts.map(item => item.attribution ? `${item.content}（${item.attribution}）` : item.content), quote];
    if (Array.from(`${base}；事实：${parts.join('；')}`).length <= 600) facts.push(memory);
  }
  const note = `${base}；事实：${facts.map(memory => memory.attribution ? `${memory.content}（${memory.attribution}）` : memory.content).join('；') || '尚无可引用的简短已确认事实'}`;
  if (Array.from(note).length > 600) invalid();
  return Object.freeze({ policyRevision: 1, text: note, resultReference,
    memoryReferences: Object.freeze([...facts, ...preferences].map(memory => Object.freeze({ id: memory.id, revision: memory.revision }))) });
}
