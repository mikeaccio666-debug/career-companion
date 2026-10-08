import { careerRecordId, careerRecordObject } from './career-record-values.ts';
import { careerLibraryTime } from './career-stories.ts';
export interface OrgKnowledgeReference {
  readonly sourceId: string; readonly revision: number; readonly passageId: string;
}
export interface StudentOrgKnowledgePassage extends OrgKnowledgeReference {
  readonly title: string; readonly text: string; readonly updatedAt: string;
  readonly scope: 'org'; readonly assetClass: 'question' | 'method_card';
  readonly provenanceLabel: string; readonly provenance: 'untrusted_knowledge';
  readonly deidentified: true; readonly older: false;
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
      v.provenance !== 'untrusted_knowledge' || v.deidentified !== true || v.older !== false) return invalid();
  const brand = orgKnowledgeBrand(v.brand), assetClass = v.assetClass as 'question' | 'method_card';
  const assetRevision = assetClass === 'question' ? null : integer(v.assetRevision);
  if (assetClass === 'question' && v.assetRevision !== null) return invalid();
  const label = assetClass === 'question' ? brand + '题库' : brand + '方法 · v' + assetRevision;
  if (v.provenanceLabel !== label) return invalid();
  return Object.freeze({ ...ref, title: text(v.title, 120), text: text(v.text, 1200),
    updatedAt: careerLibraryTime(v.updatedAt), scope: 'org', assetClass,
    provenanceLabel: label, provenance: 'untrusted_knowledge', deidentified: true, older: false, brand, assetRevision });
}
