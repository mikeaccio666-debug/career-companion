import { careerRecordId, careerRecordObject, CAREER_ROLE_FAMILIES } from './career-record-values.ts';
import { careerLibraryTime } from './career-stories.ts';
export interface OrgKnowledgeReference {
  readonly sourceId: string; readonly revision: number; readonly passageId: string;
}
export interface StudentOrgKnowledgePassage extends OrgKnowledgeReference {
  readonly title: string; readonly text: string; readonly updatedAt: string;
  readonly scope: 'org'; readonly assetClass: 'question' | 'method_card';
  readonly provenanceLabel: string; readonly provenance: 'untrusted_knowledge';
  readonly deidentified: true; readonly older: boolean;
  readonly brand: string; readonly assetRevision: number | null;
}
function invalid(): never { throw Error('内容出处暂时无法核对。'); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647 || Object.is(value, -0)) return invalid();
  return value as number;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) return invalid();
  return value;
}
export function orgKnowledgeBrand(value: unknown): string {
  const brand = text(value, 40);
  if (brand !== brand.trim() || /[<>\r\n·]/.test(brand)) return invalid();
  return brand;
}
export function parseOrgKnowledgeReference(value: unknown): Readonly<OrgKnowledgeReference> {
  const v = careerRecordObject(value, ['sourceId', 'revision', 'passageId']);
  const sourceId = careerRecordId(v.sourceId), revision = integer(v.revision);
  if (typeof v.passageId !== 'string' || !/^[1-9][0-9]*:(?:0|[1-9][0-9]{0,2})$/.test(v.passageId) ||
      !v.passageId.startsWith(String(revision) + ':') || Number(v.passageId.split(':')[1]) > 127) return invalid();
  return Object.freeze({ sourceId, revision, passageId: v.passageId });
}
/** Closed server response only, never a parser for model-written claims. */
export function parseStudentOrgKnowledgePassage(value: unknown): Readonly<StudentOrgKnowledgePassage> {
  const v = careerRecordObject(value, ['sourceId', 'revision', 'passageId', 'title', 'text', 'updatedAt',
    'scope', 'assetClass', 'provenanceLabel', 'provenance', 'deidentified', 'older', 'brand', 'assetRevision']);
  const ref = parseOrgKnowledgeReference({ sourceId: v.sourceId, revision: v.revision, passageId: v.passageId });
  if (v.scope !== 'org' || !['question', 'method_card'].includes(v.assetClass as string) ||
      v.provenance !== 'untrusted_knowledge' || v.deidentified !== true || typeof v.older !== 'boolean' || v.older && v.assetClass !== 'method_card') return invalid();
  const brand = orgKnowledgeBrand(v.brand), assetClass = v.assetClass as 'question' | 'method_card';
  const assetRevision = assetClass === 'question' ? null : integer(v.assetRevision);
  if (assetClass === 'question' && v.assetRevision !== null) return invalid();
  const label = assetClass === 'question' ? brand + '题库' : brand + '方法 · v' + assetRevision;
  if (v.provenanceLabel !== label) return invalid();
  return Object.freeze({ ...ref, title: text(v.title, 120), text: text(v.text, 1200),
    updatedAt: careerLibraryTime(v.updatedAt), scope: 'org', assetClass,
    provenanceLabel: label, provenance: 'untrusted_knowledge', deidentified: true, older: v.older, brand, assetRevision });
}

export interface OrgMethodContent {
  readonly whenToUse: string;
  readonly appliesTo: { readonly role_families: readonly import('./career-record-values.ts').CareerRoleFamily[]; readonly stages: readonly string[]; readonly situations: readonly string[] };
  readonly prerequisites: readonly string[];
  readonly evidenceNature: '经验建议' | '公开数据' | '内部统计';
  readonly steps: readonly { readonly goal: string; readonly method: string; readonly output: string }[];
  readonly rubricRef: string | null;
  readonly stopWhen: readonly string[];
  readonly counterexamples: readonly string[];
  readonly escalateWhen: readonly string[];
}
function methodList<T>(value: unknown, parse: (value: unknown) => T, minimum = 0, maximum = 50): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return invalid();
  return Object.freeze(Array.from({ length: value.length }, (_, i) => {
    if (!descriptors[i] || !('value' in descriptors[i]) || !descriptors[i].enumerable) return invalid();
    return parse(descriptors[i].value);
  }));
}
function methodToken(value: unknown) {
  const token = text(value, 100);
  if (!/^[a-z][a-z0-9_.-]*$/.test(token)) return invalid();
  return token;
}
export function parseOrgMethodContent(value: unknown): Readonly<OrgMethodContent> {
  const v = careerRecordObject(value, ['whenToUse', 'appliesTo', 'prerequisites', 'evidenceNature', 'steps', 'rubricRef', 'stopWhen', 'counterexamples', 'escalateWhen']);
  const applies = careerRecordObject(v.appliesTo, ['role_families', 'stages', 'situations']);
  const role_families = methodList(applies.role_families, x => {
    if (!(CAREER_ROLE_FAMILIES as readonly unknown[]).includes(x)) return invalid();
    return x as import('./career-record-values.ts').CareerRoleFamily;
  }, 1, 7);
  if (new Set(role_families).size !== role_families.length || !['经验建议', '公开数据', '内部统计'].includes(v.evidenceNature as string)) return invalid();
  const result: OrgMethodContent = Object.freeze({
    whenToUse: text(v.whenToUse, 80),
    appliesTo: Object.freeze({ role_families, stages: methodList(applies.stages, methodToken), situations: methodList(applies.situations, methodToken) }),
    prerequisites: methodList(v.prerequisites, methodToken), evidenceNature: v.evidenceNature as OrgMethodContent['evidenceNature'],
    steps: methodList(v.steps, step => {
      const s = careerRecordObject(step, ['goal', 'method', 'output']);
      return Object.freeze({ goal: text(s.goal, 2000), method: text(s.method, 4000), output: text(s.output, 2000) });
    }, 1),
    rubricRef: v.rubricRef === null ? null : methodToken(v.rubricRef),
    stopWhen: methodList(v.stopWhen, x => text(x, 2000)), counterexamples: methodList(v.counterexamples, x => text(x, 2000), 1),
    escalateWhen: methodList(v.escalateWhen, x => text(x, 2000)),
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > 65536) return invalid();
  return result;
}
export type StudentOrgMethod = Readonly<Omit<StudentOrgKnowledgePassage, 'text' | 'assetClass' | 'assetRevision'> & {
  assetClass: 'method_card'; assetRevision: number; content: Readonly<OrgMethodContent>;
}>;
/** Human-readable full method only. Staff identities and executable tool bindings are not part of this DTO. */
export function parseStudentOrgMethod(value: unknown): StudentOrgMethod {
  const v = careerRecordObject(value, ['sourceId', 'revision', 'passageId', 'title', 'updatedAt', 'scope', 'assetClass',
    'provenanceLabel', 'provenance', 'deidentified', 'older', 'brand', 'assetRevision', 'content']);
  const { content, ...metadata } = v;
  const passage = parseStudentOrgKnowledgePassage({ ...metadata, text: '方法依据' });
  if (passage.assetClass !== 'method_card' || passage.assetRevision === null) return invalid();
  const { text: _unused, ...header } = passage;
  return Object.freeze({ ...header, assetClass: 'method_card', assetRevision: passage.assetRevision, content: parseOrgMethodContent(content) });
}
