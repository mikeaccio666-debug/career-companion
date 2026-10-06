import { Transform, type Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, invalid, notFound } from './errors.ts';

type ByteRange = { start: number; end: number };
type RangeSelection = { type: 'full' } | { type: 'range'; range: ByteRange } | { type: 'unsatisfiable' };
const inlineMimes = new Set(['image/png','image/jpeg','image/webp','video/mp4','video/webm','audio/mpeg','audio/wav','audio/x-wav','audio/webm','audio/mp4']);

// RFC 9110 §§14.1–14.2: this endpoint supports one byte range. Ignore malformed,
// unsupported and multipart requests; valid single ranges outside the file get 416.
export function selectPrivateFileRange(value: string | string[] | undefined, size: number): RangeSelection {
  if (typeof value !== 'string' || value.length > 4096) return { type: 'full' };
  const match = /^bytes=\s*([0-9]*)-([0-9]*)\s*$/i.exec(value.trim());
  if (!match || !match[1] && !match[2]) return { type: 'full' };
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (!suffix || !size) return { type: 'unsatisfiable' };
    return { type: 'range', range: { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 } };
  }
  const start = BigInt(match[1]), requestedEnd = match[2] ? BigInt(match[2]) : length - 1n;
  if (match[2] && requestedEnd < start) return { type: 'full' };
  if (start >= length) return { type: 'unsatisfiable' };
  return { type: 'range', range: { start: Number(start), end: Number(requestedEnd >= length ? length - 1n : requestedEnd) } };
}
function strongTag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
}
function safeStorageError(cause: unknown): ApiError {
  const codes: Record<string,number> = { STORAGE_NOT_FOUND:404, STORAGE_CHANGED:409, STORAGE_INVALID_RANGE:416, STORAGE_INVALID_RESPONSE:502, STORAGE_TRUNCATED:502, STORAGE_READ_FAILED:503, STORAGE_ABORTED:499 };
  const code = cause instanceof ApiError && Object.hasOwn(codes,cause.code) ? cause.code : 'STORAGE_READ_FAILED';
  return new ApiError(codes[code]!,code,'The saved file could not be read. Try again or refresh its task.');
}
function clearFileHeaders(reply: FastifyReply) {
  for (const name of ['Content-Length','Content-Range','Content-Disposition','ETag','Content-Type']) reply.removeHeader(name);
}

export async function servePrivateFile(db: Database, storage: BlobStorage, request: FastifyRequest, reply: FastifyReply, userId: string, id: string, artifact = false) {
  const controller = new AbortController();
  let source: Readable | undefined, body: Transform | undefined;
  const cleanup = () => {
    request.raw.removeListener('aborted', interrupted);
    reply.raw.removeListener('close', closed);
    reply.raw.removeListener('finish', cleanup);
  };
  const interrupted = () => { controller.abort(); source?.destroy(); body?.destroy(); cleanup(); };
  const closed = () => { if (!reply.raw.writableFinished) interrupted(); else cleanup(); };
  request.raw.once('aborted',interrupted); reply.raw.once('close',closed); reply.raw.once('finish',cleanup);
  try {
    const owned = await db.query(artifact
      ? 'SELECT u.* FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id JOIN platform_jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.user_id=$2 AND u.user_id=$2 AND j.user_id=$2'
      : 'SELECT * FROM platform_uploads WHERE id=$1 AND user_id=$2',[id,userId]);
    if (!owned.rowCount) throw notFound();
    const download = (request.query as Record<string, unknown> | undefined)?.download;
    if (download !== undefined && download !== '1') throw invalid('Unsupported file download option.');
    controller.signal.throwIfAborted();
    const row = owned.rows[0], persistedSize = Number(row.byte_size);
    if (!Number.isSafeInteger(persistedSize) || persistedSize < 0) throw new ApiError(409,'PRIVATE_FILE_SIZE_MISMATCH','The saved file metadata is inconsistent.');
    let stat;
    try { stat = await storage.stat(row.storage_key,controller.signal); } catch (cause) { throw safeStorageError(cause); }
    controller.signal.throwIfAborted();
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size !== persistedSize) throw new ApiError(409,'PRIVATE_FILE_SIZE_MISMATCH','The saved file no longer matches its recorded size.');
    const etag = strongTag(stat.etag) ? stat.etag : undefined;
    let selection: RangeSelection = { type: 'full' };
    if (request.method === 'GET' && (request.headers['if-range'] === undefined || etag && request.headers['if-range'] === etag)) selection = selectPrivateFileRange(request.headers.range,stat.size);
    reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox")
      .header('Accept-Ranges','bytes').header('Content-Disposition',`${download === '1' || !inlineMimes.has(row.mime)?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`).type(row.mime);
    if (etag) reply.header('ETag',etag);
    if (selection.type === 'unsatisfiable') return reply.code(416).header('Content-Range',`bytes */${stat.size}`).header('Content-Length',0).send();
    const range = selection.type === 'range' ? selection.range : undefined, length = range ? range.end-range.start+1 : stat.size;
    if (request.method === 'HEAD') return reply.code(200).header('Content-Length',length).send();
    let opened;
    try { opened = await storage.openRead(row.storage_key,{ ...(range ? {range} : {}), signal:controller.signal, expected:stat }); } catch (cause) { throw safeStorageError(cause); }
    source = opened.stream;
    if (controller.signal.aborted) { source.destroy(); controller.signal.throwIfAborted(); }
    if (opened.length !== length) { source.destroy(); throw new ApiError(502,'STORAGE_INVALID_RESPONSE','The saved file could not be read consistently.'); }
    let transferred = 0;
    body = new Transform({
      transform(chunk:Buffer,_encoding,done) {
        transferred += chunk.byteLength;
        if (transferred > length) { done(new ApiError(502,'STORAGE_INVALID_RESPONSE','The saved file response was inconsistent.')); return; }
        done(null,chunk);
      },
      flush(done) { done(transferred === length ? undefined : new ApiError(502,'STORAGE_TRUNCATED','The saved file response ended early.')); },
    });
    const streamBody = body, storageSource = source;
    const sourceError = (cause:unknown) => { if (!reply.raw.headersSent) clearFileHeaders(reply); streamBody.destroy(safeStorageError(cause)); };
    storageSource.on('error',sourceError);
    storageSource.once('close',() => {
      storageSource.removeListener('error',sourceError);
      if (!storageSource.readableEnded && !streamBody.destroyed) streamBody.destroy(new ApiError(502,'STORAGE_TRUNCATED','The saved file response ended early.'));
    });
    streamBody.on('error',() => { if (!reply.raw.headersSent) clearFileHeaders(reply); controller.abort(); storageSource.destroy(); });
    streamBody.once('close',() => storageSource.destroy());
    storageSource.pipe(streamBody);
    reply.code(range ? 206 : 200).header('Content-Length',length);
    if (range) reply.header('Content-Range',`bytes ${range.start}-${range.end}/${stat.size}`);
    return reply.send(streamBody);
  } catch (cause) {
    source?.destroy(); body?.destroy(); cleanup();
    // Header values describing file bytes must not corrupt a JSON error response.
    clearFileHeaders(reply);
    throw cause;
  }
}
