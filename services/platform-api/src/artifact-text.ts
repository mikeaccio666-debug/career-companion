import { ARTIFACT_TEXT_MIME_TYPES, ARTIFACT_TEXT_SOURCE_MAX_BYTES, type ArtifactTextInput, type ArtifactTextResult } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, identifier, invalid, notFound, object } from './errors.ts';

export const ARTIFACT_TEXT_SOURCE_BYTES = ARTIFACT_TEXT_SOURCE_MAX_BYTES;
export const ARTIFACT_TEXT_PAGE_BYTES = 16 * 1024;
const DEFAULT_PAGE_BYTES = 12 * 1024;
const MAX_ENCODED_RESULT = 48_000;
const textMimes = new Set<string>(ARTIFACT_TEXT_MIME_TYPES);
const strongVersion = (value: unknown): value is string => typeof value === 'string' && /^"[\x21\x23-\x7e]{0,200}"$/.test(value);

export function parseArtifactTextInput(value: unknown): ArtifactTextInput {
  const data = object(value);
  if (Object.keys(data).some(key => !['artifactId', 'offset', 'version', 'maxBytes'].includes(key))) throw invalid('Unsupported artifact-text field.');
  const offset = data.offset === undefined ? 0 : data.offset;
  const maxBytes = data.maxBytes === undefined ? DEFAULT_PAGE_BYTES : data.maxBytes;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > ARTIFACT_TEXT_SOURCE_BYTES) throw invalid('offset must be a safe byte offset between 0 and 1 MiB.');
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > ARTIFACT_TEXT_PAGE_BYTES) throw invalid('maxBytes is a page size from 4 to 16384, not the 1 MiB source limit. Omit maxBytes to use the 12288-byte default.');
  if (data.version !== undefined && !strongVersion(data.version)) throw invalid('Omit version on the first page. For another page use the exact strong version returned by this reader.');
  if (offset && data.version === undefined) throw new ApiError(400, 'ARTIFACT_VERSION_REQUIRED', 'Use the returned version when reading another page.');
  return { artifactId: identifier(data.artifactId), offset, maxBytes, ...(data.version === undefined ? {} : { version: data.version as string }) };
}

export function parseArtifactTextQuery(artifactId: string, value: unknown): ArtifactTextInput {
  const query = object(value);
  if (Object.keys(query).some(key => !['offset', 'version', 'maxBytes'].includes(key))) throw invalid('Unsupported artifact-text query field.');
  const data: Record<string, unknown> = { artifactId, ...query };
  for (const field of ['offset', 'maxBytes']) {
    if (query[field] === undefined) continue;
    if (typeof query[field] !== 'string' || !/^[0-9]{1,7}$/.test(query[field] as string)) throw invalid(`${field} must be a decimal integer.`);
    data[field] = Number(query[field]);
  }
  return parseArtifactTextInput(data);
}

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new ApiError(499, 'ARTIFACT_READ_CANCELLED', 'Reading the saved artifact was cancelled.'); }
function storageFailure(error: unknown): ApiError {
  if (error instanceof ApiError && error.code === 'STORAGE_CHANGED') return new ApiError(409, 'ARTIFACT_CHANGED', 'The saved artifact changed. Read it again from the beginning.');
  if (error instanceof ApiError && error.code === 'STORAGE_NOT_FOUND') return notFound();
  return new ApiError(503, 'ARTIFACT_READ_FAILED', 'The saved artifact could not be read. Try again later.');
}
function binaryPrefix(bytes: Buffer): boolean {
  const prefix = bytes.subarray(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0);
  return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff ||
    ['%PDF-', 'GIF87a', 'GIF89a', 'RIFF', 'ID3', 'PK\x03\x04', 'PK\x05\x06', 'PK\x07\x08', 'Rar!'].some(signature => prefix.subarray(0, signature.length).equals(Buffer.from(signature, 'binary'))) ||
    prefix[0] === 0x1f && prefix[1] === 0x8b || prefix.subarray(4, 8).toString('ascii') === 'ftyp';
}
function boundary(bytes: Buffer, offset: number): boolean { return offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80; }
function endBoundary(bytes: Buffer, offset: number, end: number): number { while (end > offset && !boundary(bytes, end)) --end; return end; }

export async function readArtifactText(db: Database, storage: BlobStorage, userId: string, value: unknown, signal?: AbortSignal): Promise<ArtifactTextResult> {
  const input = parseArtifactTextInput(value);
  aborted(signal);
  const found = await db.query('SELECT a.id,a.job_id,a.filename,a.mime,a.metadata,u.mime AS upload_mime,u.byte_size,u.storage_key,j.kind AS job_kind FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id JOIN platform_jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.user_id=$2 AND u.user_id=$2 AND j.user_id=$2', [input.artifactId, userId]);
  if (!found.rowCount) throw notFound();
  aborted(signal);
  const row = found.rows[0];
  if (row.job_kind === 'browser') throw new ApiError(415, 'ARTIFACT_TEXT_UNSUPPORTED', 'Use get_browser_observation for approved browser observations.');
  if (!textMimes.has(row.mime)) throw new ApiError(415, 'ARTIFACT_TEXT_UNSUPPORTED', 'This reader supports private UTF-8 text, Markdown, CSV and JSON artifacts.');
  if (row.mime !== row.upload_mime) throw new ApiError(409, 'ARTIFACT_METADATA_MISMATCH', 'The saved artifact media types do not match.');
  const size = Number(row.byte_size), name = row.filename;
  if (!Number.isSafeInteger(size) || size < 0 || typeof name !== 'string' || !name.length || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new ApiError(409, 'ARTIFACT_METADATA_MISMATCH', 'The saved artifact metadata is inconsistent.');
  if (size > ARTIFACT_TEXT_SOURCE_BYTES) throw new ApiError(413, 'ARTIFACT_TEXT_TOO_LARGE', 'Text reading supports source files of at most 1 MiB. The original remains available for download.');
  let stat;
  try { stat = await storage.stat(row.storage_key, signal); } catch (error) { aborted(signal); throw storageFailure(error); }
  aborted(signal);
  if (stat.size !== size) throw new ApiError(409, 'ARTIFACT_METADATA_MISMATCH', 'The saved artifact no longer matches its size metadata.');
  if (!strongVersion(stat.etag)) throw new ApiError(503, 'ARTIFACT_VERSION_UNAVAILABLE', 'A stable saved-file version is unavailable. Try again later.');
  if (input.version !== undefined && input.version !== stat.etag) throw new ApiError(409, 'ARTIFACT_CHANGED', 'The saved artifact changed. Read it again from the beginning.');
  const offset = input.offset ?? 0;
  if (offset > size) throw new ApiError(400, 'ARTIFACT_OFFSET_INVALID', 'The requested offset is outside the saved artifact.');
  let stream: Awaited<ReturnType<BlobStorage['openRead']>>['stream'] | undefined;
  let closed: Promise<void> | undefined, cleanupError: unknown, readFailure: unknown;
  const cleanupFailed = (error: unknown) => { cleanupError = error; };
  let bytes: Buffer;
  try {
    const opened = await storage.openRead(row.storage_key, { expected: stat, signal }); stream = opened.stream;
    // Attach before consuming/destroying: end alone does not confirm that storage's
    // asynchronous _destroy and physical descriptor/request cleanup have settled.
    stream.on('error', cleanupFailed);
    closed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream!.once('close', resolve));
    if (opened.length !== size) throw new ApiError(503, 'ARTIFACT_READ_FAILED', 'The saved artifact could not be read consistently.');
    const chunks: Buffer[] = []; let received = 0;
    for await (const chunk of stream) {
      aborted(signal);
      if (!(chunk instanceof Uint8Array) || (received += chunk.byteLength) > size || received > ARTIFACT_TEXT_SOURCE_BYTES) throw new ApiError(503, 'ARTIFACT_READ_FAILED', 'The saved artifact response was inconsistent.');
      chunks.push(Buffer.from(chunk));
    }
    aborted(signal);
    if (received !== size) throw new ApiError(503, 'ARTIFACT_READ_FAILED', 'The saved artifact response ended early.');
    bytes = Buffer.concat(chunks, received);
  } catch (error) { readFailure = error; aborted(signal); if (error instanceof ApiError && error.code === 'ARTIFACT_READ_FAILED') throw error; throw storageFailure(error); }
  finally {
    if (stream) {
      stream.destroy(); await closed; stream.removeListener('error', cleanupFailed);
      aborted(signal);
      if (!readFailure && cleanupError) throw storageFailure(cleanupError);
    }
  }
  if (binaryPrefix(bytes)) throw new ApiError(415, 'ARTIFACT_TEXT_INVALID', 'The saved artifact contains binary data instead of supported text.');
  let fullText: string;
  try { fullText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ApiError(415, 'ARTIFACT_TEXT_INVALID', 'The saved artifact is not valid UTF-8 text.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(fullText)) throw new ApiError(415, 'ARTIFACT_TEXT_INVALID', 'The saved artifact contains unsupported binary control characters.');
  if (!boundary(bytes, offset)) throw new ApiError(400, 'ARTIFACT_OFFSET_INVALID', 'Use a returned nextOffset so UTF-8 characters are not split.');
  const step = row.metadata?.workflowStep;
  const source = { artifactId: row.id, jobId: row.job_id, name, mime: row.mime, size, ...(row.job_kind === 'workflow' && Number.isSafeInteger(step) && step >= 0 && step < 8 ? { workflowStep: step } : {}) };
  let end = endBoundary(bytes, offset, Math.min(size, offset + (input.maxBytes ?? DEFAULT_PAGE_BYTES)));
  const result = (): ArtifactTextResult => ({ source, provenance: 'untrusted_artifact', encoding: 'utf-8', version: stat.etag!, offset, nextOffset: end < size ? end : null, truncated: end < size, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset, end)) });
  let page = result();
  while (JSON.stringify(page).length > MAX_ENCODED_RESULT) { end = endBoundary(bytes, offset, offset + Math.floor((end - offset) / 2)); page = result(); }
  aborted(signal);
  return page;
}
