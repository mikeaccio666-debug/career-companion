import { careerRecordObject, parseOrgKnowledgeReference, parseStudentOrgKnowledgePassage, parseStudentOrgMethod,
  type OrgKnowledgeReference } from '@companion/platform-contracts';
export interface OrgSourceClient {
  readonly account: { readonly accountId: string };
  isCurrent(): boolean; subscribe(listener: () => void): () => void;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}
function failed(): never { throw Error('内容出处暂时无法核对。'); }
export function orgSourcePath(reference: OrgKnowledgeReference) {
  const r = parseOrgKnowledgeReference(reference);
  return '/sources/org/' + r.sourceId + '/' + r.revision + '/' + encodeURIComponent(r.passageId);
}
export function orgSourceReferenceFromPath(path: unknown): Readonly<OrgKnowledgeReference> | null {
  if (typeof path !== 'string' || path.length > 160) return null;
  const m = /^\/sources\/org\/([0-9a-f-]{36})\/([1-9][0-9]{0,9})\/([0-9:%A-Fa-f]+)$/.exec(path);
  if (!m) return null;
  try { return parseOrgKnowledgeReference({ sourceId: m[1], revision: Number(m[2]), passageId: decodeURIComponent(m[3]) }); }
  catch { return null; }
}
export async function readOrgSource(client: OrgSourceClient, reference: OrgKnowledgeReference, signal?: AbortSignal) {
  const r = parseOrgKnowledgeReference(reference);
  if (!client.isCurrent()) return failed();
  signal?.throwIfAborted();
  const raw = await client.request('/org-knowledge/passages/' + r.sourceId + '/' + r.revision + '/' + encodeURIComponent(r.passageId),
    { signal, cache: 'no-store' });
  signal?.throwIfAborted();
  const v = careerRecordObject(raw, ['passage']), passage = parseStudentOrgKnowledgePassage(v.passage);
  if (!client.isCurrent() || passage.sourceId !== r.sourceId || passage.revision !== r.revision || passage.passageId !== r.passageId) return failed();
  return passage;
}

export async function readOrgMethod(client: OrgSourceClient, reference: OrgKnowledgeReference, signal?: AbortSignal) {
  const r = parseOrgKnowledgeReference(reference);
  if (!client.isCurrent()) return failed();
  signal?.throwIfAborted();
  const raw = await client.request('/org-knowledge/methods/' + r.sourceId + '/' + r.revision + '/' + encodeURIComponent(r.passageId),
    { signal, cache: 'no-store' });
  signal?.throwIfAborted();
  const v = careerRecordObject(raw, ['method']), method = parseStudentOrgMethod(v.method);
  if (!client.isCurrent() || method.sourceId !== r.sourceId || method.revision !== r.revision || method.passageId !== r.passageId) return failed();
  return method;
}
