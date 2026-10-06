import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Attachment, VoiceRecord, VoiceRecordInput, VoiceRecordSource } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { ApiError, identifier, invalid, notFound, object, string } from './errors.ts';

export const VOICE_HISTORY_LIMITS = {
  textCharacters: 8_000,
  textBytes: 32_768,
  attachmentCount: 2,
  attachmentBytes: 20 * 1024 * 1024,
  conversationRecords: 500,
  conversationTextBytes: 1024 * 1024,
  userRecords: 10_000,
  userTextBytes: 20 * 1024 * 1024,
} as const;

const fields = new Set(['clientRecordId', 'source', 'role', 'text', 'sessionId', 'attachmentIds']);
const sources: VoiceRecordSource[] = ['realtime_transcript', 'transcription_excerpt', 'speech_excerpt'];
const audioTypes = new Set(['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/x-wav']);

function parseRecord(value: unknown): VoiceRecordInput {
  const input = object(value);
  if (Object.keys(input).some(key => !fields.has(key))) throw invalid('Voice records only accept explicitly selected text and audio attachment identifiers.');
  if (!sources.includes(input.source as VoiceRecordSource)) throw invalid('Unsupported voice-record source.');
  if (!['user', 'assistant', 'unknown'].includes(String(input.role))) throw invalid('Choose the speaker of the voice excerpt.');
  const text = string(input.text, 'text', VOICE_HISTORY_LIMITS.textCharacters);
  if (Buffer.byteLength(text, 'utf8') > VOICE_HISTORY_LIMITS.textBytes) throw new ApiError(413, 'VOICE_RECORD_TOO_LARGE', 'The voice excerpt exceeds the text-size limit.');
  const attachmentIds = input.attachmentIds === undefined ? [] : input.attachmentIds;
  if (!Array.isArray(attachmentIds) || attachmentIds.length > VOICE_HISTORY_LIMITS.attachmentCount) throw invalid('At most two audio attachments may be saved with a voice excerpt.');
  const ids = attachmentIds.map(identifier).sort();
  if (new Set(ids).size !== ids.length) throw invalid('Audio attachment identifiers must be unique.');
  const sessionId = input.sessionId === undefined ? undefined : identifier(input.sessionId);
  if (input.source === 'realtime_transcript' && !sessionId) throw invalid('Realtime transcripts must reference a server-issued voice session.');
  if (input.source !== 'realtime_transcript' && sessionId) throw invalid('Only realtime transcripts may reference a realtime voice session.');
  return { clientRecordId: identifier(input.clientRecordId), source: input.source as VoiceRecordSource, role: input.role as VoiceRecordInput['role'], text, sessionId, attachmentIds: ids };
}

function mapRecord(row: any, attachments: Attachment[]): VoiceRecord {
  return {
    id: row.id, conversationId: row.conversation_id, clientRecordId: row.client_record_id,
    source: row.source, role: row.role, text: row.content, provenance: 'client_submitted',
    sessionId: row.session_id ?? undefined, provider: row.provider ?? undefined, model: row.model ?? undefined,
    attachments, createdAt: new Date(row.created_at).toISOString(),
  };
}

async function readAudioAttachments(client: Pick<PoolClient, 'query'>, userId: string, ids: string[]): Promise<Attachment[]> {
  if (!ids.length) return [];
  const found = await client.query('SELECT id,filename,mime,byte_size FROM platform_uploads WHERE user_id=$1 AND id=ANY($2::uuid[])', [userId, ids]);
  if (found.rowCount !== ids.length) throw notFound();
  let bytes = 0;
  const attachments = ids.map(id => {
    const row = found.rows.find(row => row.id === id)!;
    if (!audioTypes.has(row.mime)) throw invalid('Voice history only accepts audio attachments.');
    bytes += Number(row.byte_size);
    return { id, name: row.filename, mime: row.mime, size: Number(row.byte_size), url: `/api/platform/uploads/${id}` };
  });
  if (bytes > VOICE_HISTORY_LIMITS.attachmentBytes) throw new ApiError(413, 'VOICE_AUDIO_TOO_LARGE', 'Audio attachments must total at most 20 MB per excerpt.');
  return attachments;
}

export async function rememberVoiceSession(db: Database, userId: string, sessionId: string, provider: string, model: string) {
  await db.transaction(async client => {
    const lease = await client.query("SELECT id FROM platform_runtime_leases WHERE id=$1 AND user_id=$2 AND kind='voice' AND expires_at>now() FOR SHARE", [sessionId, userId]);
    if (!lease.rowCount) throw new ApiError(409, 'VOICE_SESSION_EXPIRED', 'The voice session ended before it could be connected.');
    await client.query("INSERT INTO platform_voice_sessions(id,user_id,provider,model,expires_at,save_until) SELECT id,user_id,$3,$4,expires_at,now()+interval '24 hours' FROM platform_runtime_leases WHERE id=$1 AND user_id=$2", [sessionId, userId, string(provider, 'voice provider', 80), string(model, 'voice model', 150)]);
  });
}

export async function releaseVoiceSession(db: Database, userId: string, sessionId: string) {
  await db.transaction(async client => {
    await client.query('UPDATE platform_voice_sessions SET released_at=coalesce(released_at,now()) WHERE id=$1 AND user_id=$2', [sessionId, userId]);
    await client.query("DELETE FROM platform_runtime_leases WHERE id=$1 AND user_id=$2 AND kind='voice'", [sessionId, userId]);
  });
}

export async function listVoiceRecords(db: Database, userId: string, conversationId: string): Promise<VoiceRecord[]> {
  return db.transaction(async client => {
    const conversation = await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR SHARE', [conversationId, userId]);
    if (!conversation.rowCount) throw notFound();
    const result = await client.query('SELECT * FROM platform_voice_records WHERE conversation_id=$1 AND user_id=$2 ORDER BY ordinal LIMIT $3', [conversationId, userId, VOICE_HISTORY_LIMITS.conversationRecords]);
    const records = [];
    for (const row of result.rows) records.push(mapRecord(row, await readAudioAttachments(client, userId, row.attachment_ids)));
    return records;
  });
}

export async function saveVoiceRecord(db: Database, userId: string, conversationId: string, value: unknown): Promise<{ record: VoiceRecord; created: boolean }> {
  const input = parseRecord(value);
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.transaction(async client => {
    // Serialize this feature's cumulative limits without reversing the chat lease's lock order.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-voice:' || $1::text))", [userId]);
    const conversation = await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE', [conversationId, userId]);
    if (!conversation.rowCount) throw notFound();
    const existing = await client.query('SELECT * FROM platform_voice_records WHERE user_id=$1 AND client_record_id=$2', [userId, input.clientRecordId]);
    if (existing.rowCount) {
      if (existing.rows[0].conversation_id !== conversationId || existing.rows[0].request_hash !== requestHash) throw new ApiError(409, 'VOICE_RECORD_CONFLICT', 'This voice-record identifier was already used for a different excerpt.');
      return { record: mapRecord(existing.rows[0], await readAudioAttachments(client, userId, existing.rows[0].attachment_ids)), created: false };
    }

    let provider: string | undefined, model: string | undefined;
    if (input.sessionId) {
      const issued = await client.query('SELECT * FROM platform_voice_sessions WHERE id=$1 AND user_id=$2 FOR SHARE', [input.sessionId, userId]);
      if (!issued.rowCount) throw notFound();
      if (new Date(issued.rows[0].save_until).getTime() <= Date.now()) throw new ApiError(409, 'VOICE_SESSION_SAVE_EXPIRED', 'Save realtime excerpts within 24 hours of starting the session.');
      const lease = await client.query('SELECT user_id,kind FROM platform_runtime_leases WHERE id=$1 FOR SHARE', [input.sessionId]);
      if (lease.rowCount && (lease.rows[0].user_id !== userId || lease.rows[0].kind !== 'voice')) throw notFound();
      provider = issued.rows[0].provider; model = issued.rows[0].model;
    }
    const attachments = await readAudioAttachments(client, userId, input.attachmentIds ?? []);
    const total = await client.query('SELECT count(*)::integer AS count,coalesce(sum(content_bytes),0)::bigint AS bytes,count(*) FILTER (WHERE conversation_id=$2)::integer AS conversation_count,coalesce(sum(content_bytes) FILTER (WHERE conversation_id=$2),0)::bigint AS conversation_bytes FROM platform_voice_records WHERE user_id=$1', [userId, conversationId]);
    const textBytes = Buffer.byteLength(input.text, 'utf8'), counts = total.rows[0];
    if (counts.count >= VOICE_HISTORY_LIMITS.userRecords || Number(counts.bytes) + textBytes > VOICE_HISTORY_LIMITS.userTextBytes || counts.conversation_count >= VOICE_HISTORY_LIMITS.conversationRecords || Number(counts.conversation_bytes) + textBytes > VOICE_HISTORY_LIMITS.conversationTextBytes) throw new ApiError(413, 'VOICE_HISTORY_LIMIT', 'The saved voice-history limit has been reached. Use another conversation or remove an older conversation.');
    const id = randomUUID();
    const saved = await client.query('INSERT INTO platform_voice_records(id,user_id,conversation_id,client_record_id,source,role,content,content_bytes,session_id,provider,model,attachment_ids,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [id, userId, conversationId, input.clientRecordId, input.source, input.role, input.text, textBytes, input.sessionId ?? null, provider ?? null, model ?? null, JSON.stringify(input.attachmentIds ?? []), requestHash]);
    await client.query('UPDATE platform_conversations SET updated_at=now() WHERE id=$1', [conversationId]);
    return { record: mapRecord(saved.rows[0], attachments), created: true };
  });
}
