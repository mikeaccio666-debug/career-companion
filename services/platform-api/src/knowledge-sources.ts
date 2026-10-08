import type { PoolClient } from 'pg';
import { knowledgeHanBigrams, knowledgeHanSearch } from './knowledge-tokenization.ts';
import { randomUUID } from 'node:crypto';
import {
  KNOWLEDGE_PASSAGE_MAX_CHARACTERS, KNOWLEDGE_RESULT_MAX_BYTES, KNOWLEDGE_SEARCH_MAX_RESULTS, KNOWLEDGE_SOURCE_LIMIT, KNOWLEDGE_SOURCE_MAX_BYTES,
  type KnowledgePassage, type KnowledgePassageInput, type KnowledgeSearchInput, type KnowledgeSearchResult,
  type KnowledgeSource, type KnowledgeSourceInput, type KnowledgeSourceSummary,
} from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { ApiError, invalid, notFound, object } from './errors.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
function fields(data: Record<string, unknown>, names: string[]): void {
  if (Object.keys(data).some(key => !names.includes(key))) throw invalid('Unsupported knowledge field.');
}
function text(value: unknown, field: string, maxCharacters: number, preserve = false): string {
  if (typeof value !== 'string' || !value.trim() || controls.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value || Array.from(value).length > maxCharacters)
    throw invalid(`${field} must be valid non-empty text within its character limit.`);
  return preserve ? value : value.trim();
}
function sourceId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid('A knowledge source ID must be a UUID.');
  return value.toLowerCase();
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw invalid('revision must be a positive supported integer.');
  return value;
}
export function parseKnowledgeSourceInput(value: unknown): KnowledgeSourceInput {
  const data = object(value); fields(data, ['title', 'content', 'sourceLabel', 'sourceUrl']);
  const title = text(data.title, 'title', 120), content = text(data.content, 'content', KNOWLEDGE_SOURCE_MAX_BYTES, true);
  if (Buffer.byteLength(content, 'utf8') > KNOWLEDGE_SOURCE_MAX_BYTES) throw invalid('Knowledge content must be at most 64 KiB of UTF-8.');
  const sourceLabel = data.sourceLabel === undefined ? undefined : text(data.sourceLabel, 'sourceLabel', 200);
  let sourceUrl: string | undefined;
  if (data.sourceUrl !== undefined) {
    const raw = text(data.sourceUrl, 'sourceUrl', 2048, true);
    if (/\s/.test(raw)) throw invalid('sourceUrl must be a HTTPS URL without whitespace or credentials.');
    let parsed: URL; try { parsed = new URL(raw); } catch { throw invalid('sourceUrl must be a HTTPS URL.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname || parsed.href.length > 2048)
      throw invalid('sourceUrl must be a HTTPS URL without credentials.');
    sourceUrl = parsed.href; // Provenance metadata only; this module never fetches a URL.
  }
  return { title, content, ...(sourceLabel === undefined ? {} : { sourceLabel }), ...(sourceUrl === undefined ? {} : { sourceUrl }) };
}
export function parseKnowledgeSearchInput(value: unknown): KnowledgeSearchInput & { limit: number } {
  const data = object(value); fields(data, ['query', 'limit', 'sourceIds']);
  const query = text(data.query, 'query', 240), limit = data.limit === undefined ? 5 : data.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > KNOWLEDGE_SEARCH_MAX_RESULTS) throw invalid('limit must be an integer from 1 to 8.');
  let sourceIds: string[] | undefined;
  if (data.sourceIds !== undefined) {
    if (!Array.isArray(data.sourceIds) || !data.sourceIds.length || data.sourceIds.length > 10) throw invalid('sourceIds must contain from 1 to 10 distinct UUIDs.');
    sourceIds = data.sourceIds.map(sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) throw invalid('sourceIds must be distinct.');
  }
  return { query, limit, ...(sourceIds === undefined ? {} : { sourceIds }) };
}
export function parseKnowledgePassageInput(value: unknown): KnowledgePassageInput {
  const data = object(value); fields(data, ['sourceId', 'revision', 'passageId']);
  const current = revision(data.revision);
  if (typeof data.passageId !== 'string' || !/^[1-9][0-9]{0,9}:[0-9]{1,3}$/.test(data.passageId) || !data.passageId.startsWith(`${current}:`)) throw invalid('passageId must identify a passage in the requested revision.');
  return { sourceId: sourceId(data.sourceId), revision: current, passageId: data.passageId };
}
export function splitKnowledgePassages(id: string, current: number, content: string): { passageId: string; passageIndex: number; text: string }[] {
  sourceId(id); revision(current);
  const characters = Array.from(content), passages: { passageId: string; passageIndex: number; text: string }[] = [];
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + KNOWLEDGE_PASSAGE_MAX_CHARACTERS, characters.length);
    if (end < characters.length) {
      const minimum = start + Math.floor(KNOWLEDGE_PASSAGE_MAX_CHARACTERS / 2);
      // Prefer a line boundary, then whitespace/sentence punctuation; preserve every character.
      for (const boundary of [/\n/, /[\s。！？.!?]/u]) {
        let found = false;
        for (let index = end - 1; index >= minimum; --index) {
          if (boundary.test(characters[index]!)) { end = index + 1; found = true; break; }
        }
        if (found) break;
      }
    }
    const passageIndex = passages.length;
    passages.push({ passageId: `${current}:${passageIndex}`, passageIndex, text: characters.slice(start, end).join('') });
    start = end;
  }
  return passages;
}
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new ApiError(499, 'KNOWLEDGE_CANCELLED', 'The private knowledge operation was cancelled.'); }
function stale(): ApiError { return new ApiError(409, 'KNOWLEDGE_REVISION_CONFLICT', 'The knowledge source changed or was removed. Load its current version before continuing.'); }
function nextRevision(current: number): number {
  if (current === 2_147_483_647) throw new ApiError(409, 'KNOWLEDGE_REVISION_LIMIT', 'This source reached its version limit. Save a new source instead.');
  return current + 1;
}
function summary(row: any): KnowledgeSourceSummary {
  return { id: row.id, title: row.title, revision: Number(row.revision), passageCount: Number(row.passage_count), byteSize: Number(row.byte_size),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.source_label === null ? {} : { sourceLabel: row.source_label }), ...(row.source_url === null ? {} : { sourceUrl: row.source_url }) };
}
function passage(row: any): KnowledgePassage {
  return { sourceId: row.source_id, revision: Number(row.revision), passageId: row.passage_id, passageIndex: Number(row.passage_index), text: row.passage_text,
    title: row.title, updatedAt: new Date(row.updated_at).toISOString(), provenance: 'untrusted_knowledge',
    ...(row.source_label === null ? {} : { sourceLabel: row.source_label }), ...(row.source_url === null ? {} : { sourceUrl: row.source_url }) };
}
export class KnowledgeSources {
  constructor(private readonly db: Database) {}
  async list(ownerId: string): Promise<KnowledgeSourceSummary[]> {
    const result = await this.db.query('SELECT id,title,source_label,source_url,revision,passage_count,byte_size,created_at,updated_at FROM platform_knowledge_sources WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id', [ownerId]);
    return result.rows.map(summary);
  }
  async get(ownerId: string, id: string): Promise<KnowledgeSource> {
    const found = await this.db.query('SELECT * FROM platform_knowledge_sources WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [sourceId(id), ownerId]);
    if (!found.rowCount) throw notFound();
    return { ...summary(found.rows[0]), content: found.rows[0].content };
  }
  async create(ownerId: string, value: unknown): Promise<KnowledgeSource> {
    const input = parseKnowledgeSourceInput(value), id = randomUUID(), parts = splitKnowledgePassages(id, 1, input.content);
    return this.db.transaction(async client => {
      const owner = await client.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE', [ownerId]); if (!owner.rowCount) throw notFound();
      const count = await client.query('SELECT count(*)::integer AS count FROM platform_knowledge_sources WHERE user_id=$1 AND deleted_at IS NULL', [ownerId]);
      if (count.rows[0].count >= KNOWLEDGE_SOURCE_LIMIT) throw new ApiError(409, 'KNOWLEDGE_SOURCE_LIMIT', 'At most 200 active private knowledge sources are supported. Remove one before adding another.');
      const result = await client.query('INSERT INTO platform_knowledge_sources(id,user_id,title,content,source_label,source_url,revision,passage_count,byte_size) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8) RETURNING *',
        [id, ownerId, input.title, input.content, input.sourceLabel ?? null, input.sourceUrl ?? null, parts.length, Buffer.byteLength(input.content)]);
      for (const part of parts) await client.query("INSERT INTO platform_knowledge_passages(source_id,revision,passage_id,passage_index,content,han_search_vector) VALUES($1,1,$2,$3,$4,to_tsvector('simple',$5))", [id, part.passageId, part.passageIndex, part.text, knowledgeHanBigrams(part.text).join(' ')]);
      return { ...summary(result.rows[0]), content: input.content };
    });
  }
  async update(ownerId: string, id: string, value: unknown): Promise<KnowledgeSource> {
    const data = object(value); fields(data, ['title', 'content', 'sourceLabel', 'sourceUrl', 'revision']);
    const expected = revision(data.revision), { revision: _revision, ...rest } = data, input = parseKnowledgeSourceInput(rest), key = sourceId(id);
    return this.db.transaction(async client => {
      const found = await client.query('SELECT * FROM platform_knowledge_sources WHERE id=$1 AND user_id=$2 FOR UPDATE', [key, ownerId]);
      if (!found.rowCount) throw notFound();
      if (found.rows[0].deleted_at || Number(found.rows[0].revision) !== expected) throw stale();
      const next = nextRevision(expected), parts = splitKnowledgePassages(key, next, input.content);
      await client.query('DELETE FROM platform_knowledge_passages WHERE source_id=$1', [key]);
      const result = await client.query('UPDATE platform_knowledge_sources SET title=$3,content=$4,source_label=$5,source_url=$6,revision=$7,passage_count=$8,byte_size=$9,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revision=$10 RETURNING *',
        [key, ownerId, input.title, input.content, input.sourceLabel ?? null, input.sourceUrl ?? null, next, parts.length, Buffer.byteLength(input.content), expected]);
      if (!result.rowCount) throw stale();
      for (const part of parts) await client.query("INSERT INTO platform_knowledge_passages(source_id,revision,passage_id,passage_index,content,han_search_vector) VALUES($1,$2,$3,$4,$5,to_tsvector('simple',$6))", [key, next, part.passageId, part.passageIndex, part.text, knowledgeHanBigrams(part.text).join(' ')]);
      return { ...summary(result.rows[0]), content: input.content };
    });
  }
  async remove(ownerId: string, id: string, value: unknown): Promise<void> {
    const data = object(value); fields(data, ['revision']); const expected = revision(data.revision), key = sourceId(id);
    await this.db.transaction(async client => {
      const found = await client.query('SELECT revision,deleted_at FROM platform_knowledge_sources WHERE id=$1 AND user_id=$2 FOR UPDATE', [key, ownerId]);
      if (!found.rowCount) throw notFound();
      if (found.rows[0].deleted_at || Number(found.rows[0].revision) !== expected) throw stale();
      nextRevision(expected);
      await client.query('DELETE FROM platform_knowledge_passages WHERE source_id=$1', [key]);
      // Retain only a content-free tombstone so old citations fail instead of silently mixing versions.
      await client.query("UPDATE platform_knowledge_sources SET title='[removed]',content=NULL,source_label=NULL,source_url=NULL,byte_size=0,passage_count=0,revision=revision+1,updated_at=clock_timestamp(),deleted_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revision=$3", [key, ownerId, expected]);
    });
  }
  async search(ownerId: string, value: unknown, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    return this.searchUsing(this.db, ownerId, value, signal);
  }
  /** The authenticated consumer supplies its actual bounded transaction. */
  async searchInTransaction(client: PoolClient, ownerId: string, value: unknown, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    return this.searchUsing(client, ownerId, value, signal);
  }
  private async searchUsing(client: Pick<Database, 'query'>, ownerId: string, value: unknown, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    const input = parseKnowledgeSearchInput(value); aborted(signal);
    const queryTerms = input.query.split(/\s+/u);
    // Literal fallback preserves complete long/Chinese queries and escapes wildcard syntax.
    const terms = /\p{Script=Han}/u.test(input.query) || queryTerms.length > 8 ? [input.query] : queryTerms;
    const patterns = terms.map(term => `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    const fullText = queryTerms.every(term => /^[\p{L}\p{N}\p{M}-]+$/u.test(term));
    const han = knowledgeHanSearch(input.query);
    const requiredPatterns = han.requiredLiteral.map(term => `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    const found = await client.query(`WITH owned AS MATERIALIZED (
      SELECT id,title,source_label,source_url,revision,updated_at FROM platform_knowledge_sources WHERE user_id=$1 AND deleted_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
    ), query AS (SELECT plainto_tsquery('simple',$3) AS value,
      CASE WHEN $7::text<>'' THEN to_tsquery('simple',$7) ELSE NULL::tsquery END AS han_value,
      plainto_tsquery('simple',$8) AS latin_value)
    SELECT s.id AS source_id,s.title,s.source_label,s.source_url,s.updated_at,p.revision,p.passage_id,p.passage_index,p.content AS passage_text,
      CASE WHEN $7::text<>'' THEN ts_rank_cd(p.han_search_vector,q.han_value)+ts_rank_cd(p.search_vector,q.latin_value)
        WHEN $4::boolean THEN ts_rank_cd(p.search_vector,q.value) ELSE 0 END AS rank
    FROM owned s JOIN platform_knowledge_passages p ON p.source_id=s.id AND p.revision=s.revision CROSS JOIN query q
    WHERE ($7::text<>'' AND p.han_search_vector @@ q.han_value AND
      NOT EXISTS (SELECT 1 FROM unnest($9::text[]) AS required(pattern) WHERE p.content NOT ILIKE required.pattern ESCAPE '\\'))
      OR ($7::text='' AND $4::boolean AND p.search_vector @@ q.value)
      OR NOT EXISTS (SELECT 1 FROM unnest($5::text[]) AS term(pattern) WHERE p.content NOT ILIKE term.pattern ESCAPE '\\')
    ORDER BY rank DESC,s.updated_at DESC,s.id,p.passage_index LIMIT $6`,
      [ownerId, input.sourceIds ?? null, input.query, fullText, patterns, input.limit, han.tsquery, han.latin, requiredPatterns]);
    aborted(signal);
    const result: KnowledgeSearchResult = { query: input.query, method: 'lexical', matches: [] };
    for (const row of found.rows) {
      aborted(signal); const match = passage(row); result.matches.push(match);
      if (Buffer.byteLength(JSON.stringify(result)) > KNOWLEDGE_RESULT_MAX_BYTES) { result.matches.pop(); break; }
    }
    aborted(signal); return result;
  }
  async readPassage(ownerId: string, value: unknown, signal?: AbortSignal): Promise<KnowledgePassage> {
    const input = parseKnowledgePassageInput(value); aborted(signal);
    const found = await this.db.query(`SELECT s.id AS source_id,s.title,s.source_label,s.source_url,s.updated_at,s.revision AS source_revision,s.deleted_at,
      p.revision,p.passage_id,p.passage_index,p.content AS passage_text
      FROM platform_knowledge_sources s LEFT JOIN platform_knowledge_passages p ON p.source_id=s.id AND p.revision=$3 AND p.passage_id=$4
      WHERE s.id=$1 AND s.user_id=$2`, [input.sourceId, ownerId, input.revision, input.passageId]);
    aborted(signal);
    if (!found.rowCount) throw notFound(); const row = found.rows[0];
    if (row.deleted_at || Number(row.source_revision) !== input.revision) throw stale();
    if (!row.passage_id) throw notFound();
    const result = passage(row); aborted(signal); return result;
  }
}
