import type { KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeSource, KnowledgeSourceInput, KnowledgeSourceSummary } from '@companion/platform-contracts';
import { request } from './api.ts';

export type KnowledgeTransport = <T>(path: string, init?: RequestInit) => Promise<T>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function sourcePath(id: string) { if (!uuid.test(id)) throw new Error('资料 ID 无效。'); return `/knowledge-sources/${encodeURIComponent(id)}`; }
function currentRevision(revision: number) { if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('资料版本无效，请重新加载。'); return revision; }

/** Injectable private API transport. No source URL is fetched and no request is made on import. */
export function createKnowledgeClient(transport: KnowledgeTransport = request) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    init.signal?.throwIfAborted(); const result = await transport<T>(path, init); init.signal?.throwIfAborted(); return result;
  }
  function source(data: { source?: KnowledgeSource }) { if (!data?.source || !uuid.test(data.source.id) || !Number.isSafeInteger(data.source.revision) || data.source.revision < 1 || typeof data.source.content !== 'string') throw new Error('服务没有返回完整资料，请重新加载确认。'); return data.source; }
  return {
    async list(signal?: AbortSignal): Promise<KnowledgeSourceSummary[]> { const data = await call<{ sources: KnowledgeSourceSummary[] }>('/knowledge-sources', { signal }); if (!Array.isArray(data?.sources)) throw new Error('服务没有返回资料列表。'); return data.sources; },
    async read(id: string, signal?: AbortSignal): Promise<KnowledgeSource> { return source(await call(sourcePath(id), { signal })); },
    async save(input: KnowledgeSourceInput, current: Pick<KnowledgeSourceSummary, 'id' | 'revision'> | null, signal?: AbortSignal): Promise<KnowledgeSource> {
      return source(await call(current ? sourcePath(current.id) : '/knowledge-sources', { method: current ? 'PUT' : 'POST', body: JSON.stringify({ ...input, ...(current ? { revision: currentRevision(current.revision) } : {}) }), signal }));
    },
    async delete(current: Pick<KnowledgeSourceSummary, 'id' | 'revision'>, signal?: AbortSignal): Promise<void> { const result = await call<{ ok: boolean }>(sourcePath(current.id), { method: 'DELETE', body: JSON.stringify({ revision: currentRevision(current.revision) }), signal }); if (result?.ok !== true) throw new Error('服务没有确认删除，请重新加载列表确认。'); },
    async search(input: KnowledgeSearchInput, signal?: AbortSignal): Promise<KnowledgeSearchResult> { const result = await call<KnowledgeSearchResult>('/knowledge-search', { method: 'POST', body: JSON.stringify(input), signal }); if (result?.method !== 'lexical' || !Array.isArray(result.matches)) throw new Error('服务没有返回可读取的搜索结果。'); return result; },
  };
}
