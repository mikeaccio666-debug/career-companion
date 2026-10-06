/**
 * The Mission materials entry (2026-09-24, argoland §4.15): the tailored resume the
 * Mission's application bundle pins and the cover letter its job needs.
 *
 * Background-only. Every release names the Mission's own verified application page as its
 * recipient and is audited server-side before a byte leaves; the bytes and the letter text
 * exist only for the fill they were fetched for -- never stored, logged or echoed into a
 * receipt (RULE-GLOBAL-DATA-L1). The dock never chooses what it gets: the Mission does.
 *
 * Replaces the `GET /missions/:id/resume-file` read this repo once assumed; the backend
 * never implemented it.
 */

import {
  MISSION_MATERIAL_HEADERS,
  MISSION_MATERIAL_MAX_BYTES,
  parseMissionMaterialsV1,
  parseReleaseMissionCoverLetterTextV1,
  parseRequestMissionCoverLetterResultV1,
  parseSha256Digest,
  parseUuid,
  type MissionCoverLetterTrigger,
  type MissionMaterialsV1,
  type MissionResumeMaterialV1,
  type RequestMissionCoverLetterResultV1,
} from '@edaix/contracts';

/** A released material file, verified against its digest header and declared size. */
export interface MissionResumeFile {
  readonly fileName: string;
  /** `sha256:<hex>` from the API header, verified against the downloaded bytes. */
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export type ReadyMissionResume = Extract<MissionResumeMaterialV1, { state: 'READY' }>;

export interface MissionMaterialsClient {
  manifest(missionId: string): Promise<MissionMaterialsV1 | null>;
  releaseResume(missionId: string, resume: ReadyMissionResume): Promise<MissionResumeFile | null>;
  /** Manifest, then release: the pinned tailored resume, or null. */
  resumeFile(missionId: string): Promise<MissionResumeFile | null>;
  requestCoverLetter(
    missionId: string,
    trigger: MissionCoverLetterTrigger,
  ): Promise<RequestMissionCoverLetterResultV1 | null>;
  coverLetterText(missionId: string, artifactId: string): Promise<string | null>;
  coverLetterPdf(missionId: string, artifactId: string): Promise<MissionResumeFile | null>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Writing a letter is a model call; the backend bounds it at five minutes. */
const COVER_LETTER_TIMEOUT_MS = 180_000;
const PDF_MIME = 'application/pdf';
const MAX_FILE_NAME_LENGTH = 255;

export function createMissionMaterialsClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  coverLetterTimeoutMs?: number;
  newRequestId?: () => string;
}>): MissionMaterialsClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = positive(input.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const coverLetterTimeoutMs = positive(input.coverLetterTimeoutMs) ?? COVER_LETTER_TIMEOUT_MS;
  const newRequestId = input.newRequestId ?? (() => crypto.randomUUID());

  const url = (missionId: string, suffix: string) =>
    new URL(`/api/v1/agent/missions/${encodeURIComponent(missionId)}/materials${suffix}`, input.apiBase).toString();

  /** Bearer request with one refresh on LOGIN_REQUIRED; any other failure is null. */
  async function send(target: string, init: Readonly<{ method: 'GET' | 'POST'; body?: unknown; accept: string }>) {
    let token = await input.getAccessToken();
    if (!token) return null;
    const request = (bearer: string) => fetchFn(target, {
      method: init.method,
      cache: 'no-store',
      headers: {
        accept: init.accept,
        authorization: `Bearer ${bearer}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    let response = await request(token);
    if (response.status === 401 && input.refreshAccessToken) {
      if (!isLoginRequired(await safeJson(response))) return null;
      token = await input.refreshAccessToken();
      if (!token) return null;
      response = await request(token);
    }
    return response;
  }

  async function readFile(response: Response | null, expectedSize?: number): Promise<MissionResumeFile | null> {
    if (response === null || response.status !== 200) return null;
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(PDF_MIME)) return null;
    const expected = parseSha256Digest(response.headers.get(MISSION_MATERIAL_HEADERS.sha256));
    if (expected === null) return null;
    const bytes = await readBoundedBytes(response, MISSION_MATERIAL_MAX_BYTES);
    if (bytes === null || bytes.byteLength === 0) return null;
    if (expectedSize !== undefined && bytes.byteLength !== expectedSize) return null;
    if (`sha256:${await sha256Hex(bytes)}` !== expected) return null;
    const fileName = attachmentFileName(response.headers.get('content-disposition'));
    if (fileName === null) return null;
    return Object.freeze({ fileName, sha256: expected, size: bytes.byteLength, bytes });
  }

  const client: MissionMaterialsClient = {
    async manifest(missionId) {
      if (!parseUuid(missionId)) return null;
      return withDeadline((async () => {
        const response = await send(url(missionId, ''), { method: 'GET', accept: 'application/json' });
        if (response === null || response.status !== 200) return null;
        const manifest = parseMissionMaterialsV1(await safeJson(response));
        return manifest !== null && manifest.missionId === missionId ? manifest : null;
      })(), timeoutMs);
    },

    async releaseResume(missionId, resume) {
      if (!parseUuid(missionId)) return null;
      return withDeadline((async () => readFile(await send(url(missionId, '/resume'), {
        method: 'POST',
        accept: PDF_MIME,
        body: {
          schemaVersion: 1,
          artifactId: resume.artifactId,
          expectedContentRevision: resume.contentRevision,
          expectedLibraryRevision: resume.libraryRevision,
        },
      }), resume.size))(), timeoutMs);
    },

    async resumeFile(missionId) {
      const manifest = await client.manifest(missionId);
      if (manifest === null || manifest.resume.state !== 'READY') return null;
      return client.releaseResume(missionId, manifest.resume);
    },

    async requestCoverLetter(missionId, trigger) {
      if (!parseUuid(missionId)) return null;
      return withDeadline((async () => {
        const response = await send(url(missionId, '/cover-letter'), {
          method: 'POST',
          accept: 'application/json',
          body: { schemaVersion: 1, clientRequestId: newRequestId(), trigger },
        });
        if (response === null || response.status !== 200) return null;
        return parseRequestMissionCoverLetterResultV1(await safeJson(response));
      })(), coverLetterTimeoutMs);
    },

    async coverLetterText(missionId, artifactId) {
      if (!parseUuid(missionId) || !parseUuid(artifactId)) return null;
      return withDeadline((async () => {
        const response = await send(url(missionId, '/cover-letter/text'), {
          method: 'POST',
          accept: 'application/json',
          body: { schemaVersion: 1, artifactId },
        });
        if (response === null || response.status !== 200) return null;
        const released = parseReleaseMissionCoverLetterTextV1(await safeJson(response));
        return released !== null && released.artifactId === artifactId ? released.text : null;
      })(), timeoutMs);
    },

    async coverLetterPdf(missionId, artifactId) {
      if (!parseUuid(missionId) || !parseUuid(artifactId)) return null;
      return withDeadline((async () => readFile(await send(url(missionId, '/cover-letter/pdf'), {
        method: 'POST',
        accept: PDF_MIME,
        body: { schemaVersion: 1, artifactId },
      })))(), timeoutMs);
    },
  };
  return Object.freeze(client);
}

function positive(value: number | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

/** Declared or streamed length above the cap ends the read; nothing partial is returned. */
export async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(part.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * RFC 5987 `filename*` first, then a plain `filename`. The name must be writable into a
 * host file input as-is (a `.pdf`, no separators or controls); anything else is refused
 * rather than renamed, because the recipient sees exactly this name.
 */
function attachmentFileName(header: string | null): string | null {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '')?.[1];
  const plain = /filename="([^"]+)"/i.exec(header ?? '')?.[1];
  let candidate: string | undefined;
  try {
    candidate = encoded !== undefined ? decodeURIComponent(encoded) : plain;
  } catch {
    candidate = plain;
  }
  const name = candidate?.trim() ?? '';
  return name.length > 0 && name.length <= MAX_FILE_NAME_LENGTH &&
    // eslint-disable-next-line no-control-regex -- a file name never carries separators or controls
    !/[/\\\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..' &&
    name.toLowerCase().endsWith('.pdf')
    ? name
    : null;
}

export function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    void operation.then(finish, () => finish(null));
  });
}

export async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isLoginRequired(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (value as { code?: unknown }).code === 'LOGIN_REQUIRED';
}
