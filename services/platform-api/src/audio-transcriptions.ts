import { requireModelConsent } from './model-routing.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { platformAccountId, type AudioTranscriptionReceipt, type AudioTranscriptReference, type ChatAttachmentSupport, type PlatformProviderRuntime, type ProviderAttachment, type ProviderStatus, type ReviewedAudioTranscript } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { validateUpload } from './storage.ts';
import { ApiError, identifier, invalid, notFound, object, string } from './errors.ts';
import { acquireRuntimeLease } from './runtime-leases.ts';

export const AUDIO_TRANSCRIPTION_PROVIDER = 'faster-whisper';
export const AUDIO_TRANSCRIPTION_MODEL = 'whisper-tiny';
export const AUDIO_TRANSCRIPTION_MIMES = ['audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/webm','audio/ogg','audio/flac'] as const;
export const AUDIO_TRANSCRIPTION_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_TRANSCRIPT_MAX_CHARACTERS = 8_000;
export const AUDIO_TRANSCRIPTS_PER_MESSAGE = 2;
export type AudioTranscriptionAuthorization = (client: PoolClient, signal: AbortSignal) => Promise<void>;
const directMimes = ['image/png','image/jpeg','image/webp','image/gif','text/plain','text/markdown','text/csv','application/json','application/xml'];
const changed = () => new ApiError(409,'AUDIO_TRANSCRIPTION_SOURCE_CHANGED','The source audio changed. Create and review a new transcription.');
const inactive = () => new ApiError(409,'AUDIO_TRANSCRIPTION_LEASE_INACTIVE','This transcription request is no longer active. No receipt was saved.');
const isAudio = (mime: string) => (AUDIO_TRANSCRIPTION_MIMES as readonly string[]).includes(mime);

export function chatAttachmentSupport(runtime: PlatformProviderRuntime, provider: ProviderStatus): ChatAttachmentSupport | undefined {
  if (!provider.capabilities.some(capability => capability === 'chat' || capability === 'agent')) return;
  const local = runtime.capabilities().find(status => status.id === AUDIO_TRANSCRIPTION_PROVIDER);
  const available = !!local?.enabled && !!local.keyConfigured && local.capabilities.includes('transcription')
    && (local.modelsByCapability?.transcription?.[0] ?? local.models[0]) === AUDIO_TRANSCRIPTION_MODEL;
  return { directMimeTypes: [...directMimes,...(provider.id === 'openai' ? ['application/pdf'] : [])], maxAttachments: 8, maxTotalBytes: 25 * 1024 * 1024,
    audioTranscripts: { mimeTypes: [...AUDIO_TRANSCRIPTION_MIMES], provider: AUDIO_TRANSCRIPTION_PROVIDER, model: AUDIO_TRANSCRIPTION_MODEL,
      maxAudioBytes: AUDIO_TRANSCRIPTION_MAX_BYTES, maxDurationSeconds: 120, maxPerMessage: AUDIO_TRANSCRIPTS_PER_MESSAGE,
      maxReviewedCharacters: AUDIO_TRANSCRIPT_MAX_CHARACTERS, available, reviewRequired: true,
      ...(!available ? { reason: 'Configure and explicitly enable the local whisper-tiny transcription service. No paid or alternate provider is used.' } : {}) } };
}
export function providersWithChatAttachments(runtime: PlatformProviderRuntime): ProviderStatus[] {
  return runtime.capabilities().map(provider => ({ ...provider, ...(chatAttachmentSupport(runtime,provider) ? {chatAttachments:chatAttachmentSupport(runtime,provider)} : {}) }));
}
function textSafe(value: string) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function parseAudioTranscriptReferences(value: unknown): AudioTranscriptReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AUDIO_TRANSCRIPTS_PER_MESSAGE) throw invalid(`At most ${AUDIO_TRANSCRIPTS_PER_MESSAGE} explicitly reviewed audio transcripts may be sent.`);
  const references = value.map(item => {
    const input = object(item);
    if (Object.keys(input).some(key => !['receiptId','reviewedText'].includes(key))) throw invalid('Audio references accept only a receipt ID and explicitly reviewed text.');
    string(input.reviewedText,'reviewedText',AUDIO_TRANSCRIPT_MAX_CHARACTERS);
    const reviewedText = input.reviewedText as string;
    if (!textSafe(reviewedText)) throw invalid('Reviewed audio text must contain valid Unicode text.');
    return { receiptId: identifier(input.receiptId).toLowerCase(), reviewedText };
  });
  if (new Set(references.map(reference => reference.receiptId)).size !== references.length) throw invalid('Audio transcription receipts must be unique.');
  return references;
}
function receipt(row: any): AudioTranscriptionReceipt {
  return { id:row.id,sourceAttachmentId:row.source_upload_id,sourceName:row.source_name,sourceMime:row.source_mime,sourceSha256:row.source_sha256,
    provider:AUDIO_TRANSCRIPTION_PROVIDER,model:AUDIO_TRANSCRIPTION_MODEL,text:row.content,provenance:'untrusted_audio_transcript',createdAt:new Date(row.created_at).toISOString() };
}
function reviewed(row: any, reference: AudioTranscriptReference): ReviewedAudioTranscript {
  const source = receipt(row);
  return { receiptId:source.id,sourceAttachmentId:source.sourceAttachmentId,sourceName:source.sourceName,sourceMime:source.sourceMime,
    sourceSha256:source.sourceSha256,provider:source.provider,model:source.model,text:reference.reviewedText,textModified:reference.reviewedText !== source.text,provenance:'untrusted_audio_transcript' };
}

/** Server-created immutable ASR results. A user review selects text; it authenticates no speaker or achievement. */
export class AudioTranscriptions {
  constructor(readonly db: Database, readonly storage: BlobStorage, readonly runtime: PlatformProviderRuntime) { this.runtime=requireModelConsent(runtime); }
  private async source(userId: string, uploadId: string, client: Pick<PoolClient,'query'> | Database = this.db) {
    const result = await client.query('SELECT * FROM platform_uploads WHERE id=$1 AND user_id=$2',[uploadId,userId]);
    if (!result.rowCount) throw notFound();
    return result.rows[0];
  }
  private async load(row: any, signal?: AbortSignal): Promise<{attachment:ProviderAttachment;sha256:string}> {
    signal?.throwIfAborted();
    const expectedSize = Number(row.byte_size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > AUDIO_TRANSCRIPTION_MAX_BYTES) throw invalid('Attachments must contain at most 20 MiB.');
    const stat = await this.storage.stat(row.storage_key,signal);
    signal?.throwIfAborted();if (stat.size !== expectedSize) throw changed();
    const opened = await this.storage.openRead(row.storage_key,{expected:stat,signal});
    const abort = () => opened.stream.destroy(new Error('Attachment read interrupted.'));
    signal?.addEventListener('abort',abort,{once:true});
    const chunks: Buffer[] = []; let length = 0;
    try {
      for await (const part of opened.stream) { signal?.throwIfAborted(); const chunk = Buffer.from(part); length += chunk.byteLength; if (length > expectedSize || length > AUDIO_TRANSCRIPTION_MAX_BYTES) throw changed(); chunks.push(chunk); }
      signal?.throwIfAborted();if (length !== expectedSize || opened.length !== expectedSize) throw changed();
      const bytes = Buffer.concat(chunks,length);
      return {attachment:{name:row.filename,mime:row.mime,bytes},sha256:createHash('sha256').update(bytes).digest('hex')};
    } finally { signal?.removeEventListener('abort',abort);opened.stream.destroy(); }
  }
  private async assertSource(userId: string, row: any, signal?: AbortSignal) {
    const source = await this.source(userId,row.source_upload_id);
    if (source.mime !== row.source_mime || source.filename !== row.source_name || Number(source.byte_size) !== row.source_size) throw changed();
    const loaded = await this.load(source,signal);if (loaded.sha256 !== row.source_sha256) throw changed();
  }
  private async assertLease(userId: string, leaseId: string, signal: AbortSignal, client: Pick<PoolClient,'query'> | Database = this.db) {
    signal.throwIfAborted();
    const result = await client.query("SELECT id FROM platform_runtime_leases WHERE id=$1 AND user_id=$2 AND kind='voice' AND expires_at>clock_timestamp() FOR KEY SHARE",[leaseId,userId]);
    signal.throwIfAborted();if (!result.rowCount) throw inactive();
  }
  async get(userId: string, uploadId: string, clientRequestId: string, signal?: AbortSignal): Promise<AudioTranscriptionReceipt> {
    await this.source(userId,identifier(uploadId));
    const found = await this.db.query('SELECT * FROM platform_audio_transcriptions WHERE user_id=$1 AND client_request_id=$2 AND source_upload_id=$3',[userId,identifier(clientRequestId),uploadId]);
    if (!found.rowCount) throw notFound();
    await this.assertSource(userId,found.rows[0],signal);signal?.throwIfAborted();return receipt(found.rows[0]);
  }
  async getById(userId: string, receiptId: string, signal?: AbortSignal): Promise<AudioTranscriptionReceipt> {
    const found = await this.db.query('SELECT * FROM platform_audio_transcriptions WHERE user_id=$1 AND id=$2',[userId,identifier(receiptId)]);
    if (!found.rowCount) throw notFound();
    await this.assertSource(userId,found.rows[0],signal);signal?.throwIfAborted();return receipt(found.rows[0]);
  }
  async create(userId: string, uploadId: string, value: unknown, outerSignal: AbortSignal | undefined, authorize: AudioTranscriptionAuthorization, requestAdmission?: import('@companion/platform-contracts').ProviderRequestAdmission): Promise<{receipt:AudioTranscriptionReceipt;created:boolean}> {
    const controller = new AbortController(),signal = outerSignal ? AbortSignal.any([outerSignal,controller.signal]) : controller.signal;
    signal.throwIfAborted();
    const input = object(value);
    if (Object.keys(input).some(key => key !== 'clientRequestId')) throw invalid('Choose a client request ID. The local transcription provider and model are fixed by the server.');
    if (!platformAccountId(input.clientRequestId)) throw invalid('Choose a valid UUID client request ID.');
    const clientRequestId = identifier(input.clientRequestId).toLowerCase();uploadId = identifier(uploadId).toLowerCase();
    const source = await this.source(userId,uploadId);
    if (!isAudio(source.mime)) throw new ApiError(400,'AUDIO_TRANSCRIPTION_UNSUPPORTED','Choose an audio attachment. Video frame and audio extraction requires its own reviewed route.');
    signal.throwIfAborted();await this.db.transaction(client=>authorize(client,signal));
    const existing = await this.db.query('SELECT * FROM platform_audio_transcriptions WHERE user_id=$1 AND client_request_id=$2',[userId,clientRequestId]);
    if (existing.rowCount) {
      if (existing.rows[0].source_upload_id !== uploadId) throw new ApiError(409,'AUDIO_TRANSCRIPTION_CONFLICT','This request ID already belongs to a different audio attachment.');
      await this.assertSource(userId,existing.rows[0],signal);await this.db.transaction(client=>authorize(client,signal));signal.throwIfAborted();return {receipt:receipt(existing.rows[0]),created:false};
    }
    const local = this.runtime.capabilities().find(provider => provider.id === AUDIO_TRANSCRIPTION_PROVIDER);
    if (!local || !chatAttachmentSupport(this.runtime,{...local,capabilities:['chat']})?.audioTranscripts.available)
      throw new ApiError(503,'LOCAL_TRANSCRIPTION_UNAVAILABLE','Configure and explicitly enable local whisper-tiny transcription. No paid or alternate provider is used.');
    const leaseId = await this.db.transaction(async client=>{await authorize(client,signal);const id=await acquireRuntimeLease(client,userId,'voice');signal.throwIfAborted();return id;});
    const heartbeat = setInterval(() => {
      void this.db.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1 AND user_id=$2 AND kind='voice' AND expires_at>clock_timestamp() RETURNING id",[leaseId,userId])
        .then(result => { if (!result.rowCount) controller.abort(inactive()); }).catch(() => controller.abort(inactive()));
    },15_000);heartbeat.unref();
    const deadline = setTimeout(() => controller.abort(new ApiError(504,'AUDIO_TRANSCRIPTION_TIMEOUT','The local transcription exceeded its request deadline.')),120_000);deadline.unref();
    try {
      const loaded = await this.load(source,signal);validateUpload(source.filename,source.mime,loaded.attachment.bytes);
      await this.db.transaction(async client=>{await authorize(client,signal);await this.assertLease(userId,leaseId,signal,client);});
      const result = await this.runtime.transcribe(loaded.attachment,{provider:AUDIO_TRANSCRIPTION_PROVIDER,signal,requestAdmission});
      signal.throwIfAborted();
      if (!result || typeof result.text !== 'string' || !textSafe(result.text) || Buffer.byteLength(result.text,'utf8') > 64 * 1024)
        throw new ApiError(502,'INVALID_TRANSCRIPTION_RESULT','The local service did not return valid bounded transcription text.');
      const current = await this.source(userId,uploadId),confirmed = await this.load(current,signal);
      if (confirmed.sha256 !== loaded.sha256 || current.mime !== source.mime || current.filename !== source.filename) throw changed();
      const saved = await this.db.transaction(async client => {
        await authorize(client,signal);await this.assertLease(userId,leaseId,signal,client);
        const owned = await client.query('SELECT id FROM platform_uploads WHERE id=$1 AND user_id=$2 AND storage_key=$3 AND mime=$4 AND byte_size=$5 FOR KEY SHARE',[uploadId,userId,source.storage_key,source.mime,source.byte_size]);
        signal.throwIfAborted();if (!owned.rowCount) throw changed();
        await this.assertLease(userId,leaseId,signal,client);
        const found = await client.query('SELECT * FROM platform_audio_transcriptions WHERE user_id=$1 AND client_request_id=$2',[userId,clientRequestId]);
        signal.throwIfAborted();
        if (found.rowCount) { if (found.rows[0].source_upload_id !== uploadId || found.rows[0].source_sha256 !== loaded.sha256) throw changed();return {receipt:receipt(found.rows[0]),created:false}; }
        const created = await client.query(`INSERT INTO platform_audio_transcriptions(id,user_id,client_request_id,source_upload_id,source_sha256,source_name,source_mime,source_size,provider,model,content,content_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[randomUUID(),userId,clientRequestId,uploadId,loaded.sha256,source.filename,source.mime,Number(source.byte_size),AUDIO_TRANSCRIPTION_PROVIDER,AUDIO_TRANSCRIPTION_MODEL,result.text,Buffer.byteLength(result.text,'utf8')]);
        await authorize(client,signal);await this.assertLease(userId,leaseId,signal,client);return {receipt:receipt(created.rows[0]),created:true};
      });
      signal.throwIfAborted();return saved;
    } finally { clearTimeout(deadline);clearInterval(heartbeat);await this.db.query("DELETE FROM platform_runtime_leases WHERE id=$1 AND user_id=$2 AND kind='voice'",[leaseId,userId]); }
  }
  async validateMessage(userId: string, provider: ProviderStatus, attachmentIds: string[], references: AudioTranscriptReference[], signal?: AbortSignal, client: Pick<PoolClient,'query'> | Database = this.db, verifyBytes = true): Promise<ReviewedAudioTranscript[]> {
    signal?.throwIfAborted();
    if (new Set(attachmentIds).size !== attachmentIds.length) throw invalid('Message attachments must be unique.');
    const support = chatAttachmentSupport(this.runtime,provider);
    if (!support) throw invalid('This provider has no chat attachment route.');
    const uploads = attachmentIds.length ? await client.query('SELECT * FROM platform_uploads WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,attachmentIds]) : {rows:[],rowCount:0};
    if (uploads.rowCount !== attachmentIds.length) throw notFound();
    if (attachmentIds.length > support.maxAttachments || uploads.rows.reduce((bytes,row) => bytes + Number(row.byte_size),0) > support.maxTotalBytes)
      throw new ApiError(413,'CONTEXT_ATTACHMENTS_TOO_LARGE','The message contains too many attachments. Keep at most eight files totaling 25 MiB.');
    const resolved: ReviewedAudioTranscript[] = [];
    for (const reference of references) {
      const found = await client.query('SELECT * FROM platform_audio_transcriptions WHERE id=$1 AND user_id=$2',[reference.receiptId,userId]);
      if (!found.rowCount) throw notFound();const row = found.rows[0];
      if (!attachmentIds.includes(row.source_upload_id)) throw new ApiError(400,'AUDIO_TRANSCRIPT_SOURCE_MISMATCH','Keep the original audio attachment with its reviewed transcription.');
      if (resolved.some(item => item.sourceAttachmentId === row.source_upload_id)) throw invalid('Each audio attachment may have only one reviewed transcription.');
      if (verifyBytes) await this.assertSource(userId,row,signal);
      resolved.push(reviewed(row,reference));
    }
    for (const upload of uploads.rows) {
      if (isAudio(upload.mime)) { if (!resolved.some(item => item.sourceAttachmentId === upload.id)) throw new ApiError(400,'AUDIO_TRANSCRIPT_REQUIRED','Transcribe and explicitly review this audio attachment before sending.'); }
      else if (!support.directMimeTypes.includes(upload.mime)) throw new ApiError(400,'CHAT_ATTACHMENT_UNSUPPORTED','This chat route cannot read this file directly. Keep it private and choose a compatible reviewed media route.');
    }
    signal?.throwIfAborted();return resolved;
  }
  async readMessageAttachment(userId: string, uploadId: string, references: ReviewedAudioTranscript[], signal?: AbortSignal): Promise<ProviderAttachment> {
    const source = await this.source(userId,uploadId),loaded = await this.load(source,signal);
    if (isAudio(source.mime)) {
      const reference = references.find(item => item.sourceAttachmentId === uploadId);
      if (!reference) throw new ApiError(400,'AUDIO_TRANSCRIPT_REQUIRED','Transcribe and explicitly review this audio attachment before sending.');
      if (loaded.sha256 !== reference.sourceSha256 || source.mime !== reference.sourceMime || source.filename !== reference.sourceName) throw changed();
    }
    return loaded.attachment;
  }
  async forMessage(userId: string, references: unknown, signal?: AbortSignal): Promise<ReviewedAudioTranscript[]> {
    const result: ReviewedAudioTranscript[] = [];
    for (const reference of parseAudioTranscriptReferences(references)) {
      const found = await this.db.query('SELECT * FROM platform_audio_transcriptions WHERE id=$1 AND user_id=$2',[reference.receiptId,userId]);
      if (!found.rowCount) throw notFound();signal?.throwIfAborted();result.push(reviewed(found.rows[0],reference));
    }
    return result;
  }
}
