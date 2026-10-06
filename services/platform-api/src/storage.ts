import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PlatformConfig } from './config.ts';
import { ApiError, invalid } from './errors.ts';

export interface BlobStat { size: number; etag?: string; }
export interface BlobReadOptions {
  range?: { start: number; end: number }; signal?: AbortSignal; expected: BlobStat;
}
export interface BlobReadResult { stream: Readable; length: number; }

export interface BlobStorage {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  stat(key: string, signal?: AbortSignal): Promise<BlobStat>;
  openRead(key: string, options: BlobReadOptions): Promise<BlobReadResult>;
}

function storageError(error: unknown, signal?: AbortSignal): ApiError {
  if (error instanceof ApiError) return error;
  if (signal?.aborted) return new ApiError(499, 'STORAGE_ABORTED', 'The media read was cancelled.');
  const value = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } } | undefined;
  if (value?.code === 'ENOENT' || value?.name === 'NoSuchKey' || value?.name === 'NotFound' || value?.$metadata?.httpStatusCode === 404) return new ApiError(404, 'STORAGE_NOT_FOUND', 'The stored media is unavailable.');
  if (value?.code === 'ELOOP' || value?.name === 'PreconditionFailed' || value?.$metadata?.httpStatusCode === 412) return new ApiError(409, 'STORAGE_CHANGED', 'The stored media changed. Reload before reading it.');
  return new ApiError(503, 'STORAGE_READ_FAILED', 'The stored media could not be read.');
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw storageError(undefined, signal); }
function strongEtag(value: unknown): value is string { return typeof value === 'string' && /^"[\x21\x23-\x7e]{0,200}"$/.test(value); }
function size(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned invalid media metadata.');
  return value;
}
function readLength(options: BlobReadOptions): number {
  if (!options?.expected) throw new ApiError(409, 'STORAGE_CHANGED', 'Media metadata must be checked before reading.');
  const total = size(options.expected.size), range = options.range;
  if (options.expected.etag !== undefined && !strongEtag(options.expected.etag)) throw new ApiError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned an invalid media version.');
  if (!range) return total;
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= total) throw new ApiError(416, 'STORAGE_INVALID_RANGE', 'The requested media range is unavailable.');
  return range.end - range.start + 1;
}
function localMetadata(stat: BigIntStats): Required<BlobStat> {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(409, 'STORAGE_CHANGED', 'The stored media is not a regular immutable blob.');
  // Opaque version for wx-created immutable blobs: no content buffering or file-path disclosure.
  const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  return { size: Number(stat.size), etag: `"local-${createHash('sha256').update(version).digest('hex')}"` };
}
function checkExpected(actual: BlobStat, expected: BlobStat): void {
  if (actual.size !== expected.size || expected.etag !== undefined && actual.etag !== expected.etag) throw new ApiError(409, 'STORAGE_CHANGED', 'The stored media changed. Reload before reading it.');
}

/** A bounded, backpressured stream. Client destruction also tears down the source and request. */
function checkedStream(source: Readable, length: number, options: {
  signal?: AbortSignal; verifyEnd?: () => Promise<void>; close: () => Promise<void> | void;
}): Readable {
  let bytes = 0, cleanup: Promise<void> | undefined;
  const finish = () => cleanup ??= Promise.resolve().then(options.close);
  const output = new Transform({ highWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > length) return callback(new ApiError(502, 'STORAGE_TRUNCATED', 'The media stream did not match its recorded length.'));
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== length) return callback(new ApiError(502, 'STORAGE_TRUNCATED', 'The media stream ended before its recorded length.'));
      Promise.resolve().then(options.verifyEnd).then(() => callback(), error => callback(storageError(error, options.signal)));
    },
    destroy(error, callback) {
      options.signal?.removeEventListener('abort', aborted);
      // ReadStream.destroy() may start FileHandle.close(). A concurrent close()
      // can resolve before its native descriptor closes; the source close event
      // confirms that pending I/O and its physical close callback have settled.
      const sourceClosed = source.closed ? Promise.resolve() : new Promise<void>(resolve => source.once('close', resolve));
      source.destroy();
      const cleanupResult = finish().then(() => undefined, cause => storageError(cause, options.signal));
      Promise.all([sourceClosed, cleanupResult]).then(([, cause]) => callback(error ?? cause));
    },
  });
  const aborted = () => output.destroy(storageError(undefined, options.signal));
  // Install before pipeline so filesystem or SDK errors cannot expose private paths/messages.
  source.on('error', error => output.destroy(storageError(error, options.signal)));
  // _destroy reports cleanup failures as safe stream errors. Keep this secondary
  // completion observer from producing an unhandled duplicate rejection.
  pipeline(source, output, () => { void finish().catch(() => {}); });
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  return output;
}

export class LocalBlobStorage implements BlobStorage {
  constructor(private directory: string) {}
  private file(key: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid storage key');
    return path.join(this.directory, key);
  }
  async put(key: string, bytes: Uint8Array) { await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); await fs.writeFile(this.file(key), bytes, { mode: 0o600, flag: 'wx' }); }
  async get(key: string) { return new Uint8Array(await fs.readFile(this.file(key))); }
  async delete(key: string) { await fs.rm(this.file(key), { force: true }); }
  async stat(key: string, signal?: AbortSignal): Promise<BlobStat> {
    checkAbort(signal);let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.file(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const result = localMetadata(await file.stat({ bigint: true }));checkAbort(signal);return result;
    } catch (error) { throw storageError(error, signal); }
    finally { await file?.close().catch(() => {}); }
  }
  async openRead(key: string, options: BlobReadOptions): Promise<BlobReadResult> {
    const length = readLength(options);checkAbort(options.signal);let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.file(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const actual = localMetadata(await file.stat({ bigint: true }));checkExpected(actual, options.expected);checkAbort(options.signal);
      const opened = file;
      // FD stays open through the final version check; createReadStream never reopens the pathname.
      const source = length ? opened.createReadStream({ start: options.range?.start ?? 0, end: options.range?.end ?? actual.size - 1, autoClose: false, highWaterMark: 64 * 1024 }) : Readable.from([]);
      const stream = checkedStream(source, length, { signal: options.signal,
        verifyEnd: async () => { checkExpected(localMetadata(await opened.stat({ bigint: true })), actual); },
        close: () => opened.close(),
      });
      file = undefined;return { stream, length };
    } catch (error) { throw storageError(error, options.signal); }
    finally { await file?.close().catch(() => {}); }
  }
}
export class S3BlobStorage implements BlobStorage {
  private client: Pick<S3Client, 'send'>;
  constructor(private config: NonNullable<PlatformConfig['s3']>, client?: Pick<S3Client, 'send'>) {
    this.client = client ?? new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: Boolean(config.endpoint), credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  }
  async put(key: string, bytes: Uint8Array, mime: string) { await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: mime })); }
  async get(key: string) { const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key })); if (!result.Body) throw new Error('Missing object'); return await result.Body.transformToByteArray(); }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })); }
  async stat(key: string, signal?: AbortSignal): Promise<BlobStat> {
    checkAbort(signal);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: signal });checkAbort(signal);
      if (!strongEtag(result.ETag)) throw new ApiError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned an invalid media version.');
      return { size: size(result.ContentLength), etag: result.ETag };
    } catch (error) { throw storageError(error, signal); }
  }
  async openRead(key: string, options: BlobReadOptions): Promise<BlobReadResult> {
    const length = readLength(options);checkAbort(options.signal);
    const request = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
    let body: Readable | undefined;
    try {
      const version = options.expected.etag ?? (await this.stat(key, signal)).etag;
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key,
        ...(options.range ? { Range: `bytes=${options.range.start}-${options.range.end}` } : {}), IfMatch: version,
      }), { abortSignal: signal });
      if (!(result.Body instanceof Readable)) throw new ApiError(502, 'STORAGE_INVALID_RESPONSE', 'Storage did not return a readable media stream.');
      body = result.Body;checkAbort(signal);
      if (!strongEtag(result.ETag) || result.ETag !== version || size(result.ContentLength) !== length) throw new ApiError(409, 'STORAGE_CHANGED', 'The stored media changed or returned an inconsistent range.');
      if (options.range) {
        const expected = `bytes ${options.range.start}-${options.range.end}/${options.expected.size}`;
        if (result.ContentRange !== expected || result.$metadata?.httpStatusCode !== undefined && result.$metadata.httpStatusCode !== 206) throw new ApiError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned an inconsistent media range.');
      } else if (result.ContentRange !== undefined || result.$metadata?.httpStatusCode !== undefined && result.$metadata.httpStatusCode !== 200) throw new ApiError(502, 'STORAGE_INVALID_RESPONSE', 'Storage returned an unexpected partial media response.');
      const stream = checkedStream(body, length, { signal, close: () => { request.abort();body?.destroy(); } });
      return { stream, length };
    } catch (error) { body?.on('error', () => {});body?.destroy();request.abort();throw storageError(error, options.signal); }
  }
}
export function createStorage(config: PlatformConfig): BlobStorage { return config.s3 ? new S3BlobStorage(config.s3) : new LocalBlobStorage(config.storageDir); }

const mimeExtensions: Record<string, string[]> = {
  'application/pdf': ['.pdf'], 'text/plain': ['.txt'], 'text/markdown': ['.md'], 'text/csv': ['.csv'], 'application/json': ['.json'],
  'image/png': ['.png'], 'image/jpeg': ['.jpg','.jpeg'], 'image/webp': ['.webp'],
  'audio/webm': ['.webm'], 'video/webm': ['.webm'], 'audio/mpeg': ['.mp3'], 'audio/wav': ['.wav'], 'audio/x-wav': ['.wav'], 'audio/mp4': ['.m4a'], 'video/mp4': ['.mp4'],
};
export function validateUpload(filename: string, mime: string, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw invalid('Files must contain 1 byte to 20 MB.');
  const extension = path.extname(filename).toLowerCase();
  if (!mimeExtensions[mime]?.includes(extension)) throw invalid('Unsupported file type or extension.');
  const start = Buffer.from(bytes.subarray(0, 16));
  if (mime === 'application/pdf' && !start.toString('ascii').startsWith('%PDF-')) throw invalid('Invalid PDF file.');
  if (mime === 'image/png' && !start.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw invalid('Invalid PNG file.');
  if (mime === 'image/jpeg' && !(start[0] === 255 && start[1] === 216 && start[2] === 255)) throw invalid('Invalid JPEG file.');
  if (mime === 'image/webp' && !(start.toString('ascii',0,4)==='RIFF' && start.toString('ascii',8,12)==='WEBP')) throw invalid('Invalid WebP file.');
  if ((mime==='audio/webm' || mime==='video/webm') && !start.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) throw invalid('Invalid WebM file.');
  if ((mime==='audio/wav'||mime==='audio/x-wav') && !(start.toString('ascii',0,4)==='RIFF' && start.toString('ascii',8,12)==='WAVE')) throw invalid('Invalid WAV file.');
  if ((mime==='video/mp4'||mime==='audio/mp4') && start.toString('ascii',4,8)!=='ftyp') throw invalid('Invalid MP4 file.');
  if (mime==='audio/mpeg' && !(start.toString('ascii',0,3)==='ID3' || (start[0]===255 && (start[1]!&0xe0)===0xe0))) throw invalid('Invalid MP3 file.');
  if (mime.startsWith('text/') || mime==='application/json') {
    try { new TextDecoder('utf-8',{ fatal:true }).decode(bytes); } catch { throw invalid('Text files must use UTF-8 encoding.'); }
    if (bytes.includes(0)) throw invalid('Binary text files are not supported.');
  }
}
