import {
  COVER_LETTER_ATTACHMENT_PDF_FILE_NAME,
  MISSION_MATERIAL_HEADERS,
  MISSION_MATERIAL_MAX_BYTES,
  lookupCoverLetterAttachment,
  parseCoverLetterAttachmentLookupV1,
  parseCoverLetterAttachmentPrepareResultV1,
  parseCoverLetterAttachmentTextV1,
  parseSha256Digest,
  parseUuid,
  prepareCoverLetterAttachment,
  releaseCoverLetterAttachmentPdf,
  releaseCoverLetterAttachmentText,
  type CoverLetterAttachmentLookupV1,
  type CoverLetterAttachmentPrepareResultV1,
  type CoverLetterAttachmentTargetV1,
  type CoverLetterPageJobV1,
} from '@edaix/contracts';
import { readBoundedBytes, safeJson, sha256Hex, withDeadline } from './missionMaterialsClient';

/**
 * 按页面要求职信（2026-09-27，argoland #653）。只在 worker 里跑。
 *
 * 负责人 2026-09-27：申请表上有求职信栏（必填、可选都算）就附上为这个岗位写的那一封；岗位库里的岗位用核实过的
 * 职位描述写，不在库里的用插件从这一页读到的职位描述写（服务端只把它当写作素材）。四条路：
 *
 * - `lookup`：这一页现在有没有可以附的信（免费，不碰模型）；顺带说这一页是不是岗位库里的岗位。
 * - `prepare`：没有就写一封（计量 `vibeid_generation`，同一 `clientRequestId` 重放不重扣）；已有就原样交回、不扣。
 * - `text` / `pdf`：把那一封交给这一页（文字框要正文、上传栏要 PDF），经运营清单、留痕。
 *
 * 收件人（`target`）由调用方拿 worker 核对过的发信页组，页面给的东西不能证明页面。信的正文与 PDF 字节只在内存里、
 * 只为这一次填写，不存、不记、不进回执（RULE-GLOBAL-DATA-L1）。
 */
export type CoverLetterAttachmentFailure =
  /** 401（刷新之后仍然）：要重新连 ArgoLand。 */
  | 'AUTH_REQUIRED'
  /** 402 PAYWALL_REQUIRED：这个账号没有写信的额度（免费账号）。 */
  | 'PAYWALL_REQUIRED'
  /** 429 USAGE_EXHAUSTED：这个月的生成次数用完了。 */
  | 'USAGE_EXHAUSTED'
  /** 403 ATTACHMENT_TARGET_NOT_ALLOWED：运营清单不许把信交给这个网站。 */
  | 'TARGET_NOT_ALLOWED'
  /** 404 COVER_LETTER_NOT_FOUND：这一封此刻不能交给这一页（不是写给这一页的、没就绪……服务端不说是哪一种）。 */
  | 'NOT_FOUND'
  /** 409：同一个请求还在写（重放保护）。 */
  | 'BUSY'
  /** 网络、超时、别的非 200、答复形状或身份对不上。 */
  | 'UNAVAILABLE';

export type CoverLetterClientResult<T> =
  | Readonly<{ ok: true; value: T }>
  /** `serverCode`：服务端答复体里的稳定码，只进诊断码。 */
  | Readonly<{ ok: false; code: CoverLetterAttachmentFailure; serverCode?: string }>;

/** 交给这一页的求职信 PDF：名字、大小与摘要都对过了。 */
export interface CoverLetterPdf {
  readonly fileName: string;
  readonly size: number;
  /** `sha256:<hex>`，与答复头逐字相等、且是这一份字节算出来的。 */
  readonly sha256: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface CoverLetterAttachmentClient {
  lookup(target: CoverLetterAttachmentTargetV1): Promise<CoverLetterClientResult<CoverLetterAttachmentLookupV1>>;
  prepare(
    target: CoverLetterAttachmentTargetV1,
    input: Readonly<{ clientRequestId: string; pageJob?: CoverLetterPageJobV1 }>,
  ): Promise<CoverLetterClientResult<CoverLetterAttachmentPrepareResultV1>>;
  text(target: CoverLetterAttachmentTargetV1, artifactId: string): Promise<CoverLetterClientResult<string>>;
  pdf(target: CoverLetterAttachmentTargetV1, artifactId: string): Promise<CoverLetterClientResult<CoverLetterPdf>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 写一封信是一次模型调用；服务端给它五分钟，这边等三分钟（与任务材料入口同一个数）。 */
const PREPARE_TIMEOUT_MS = 180_000;
const PDF_MIME = 'application/pdf';

export function createCoverLetterAttachmentClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  prepareTimeoutMs?: number;
}>): CoverLetterAttachmentClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = positive(input.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const prepareTimeoutMs = positive(input.prepareTimeoutMs) ?? PREPARE_TIMEOUT_MS;
  const url = (path: string) => new URL(path, input.apiBase).toString();

  /** 带 bearer 的一次 POST；401 且答复说要登录时刷新一次再问。拿不到 token 是 null。 */
  async function send(path: string, body: unknown, accept: string): Promise<Response | null> {
    let token = await input.getAccessToken();
    if (!token) return null;
    const request = (bearer: string) => fetchFn(url(path), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let response = await request(token);
    if (response.status === 401 && input.refreshAccessToken) {
      token = await input.refreshAccessToken();
      if (!token) return response;
      response = await request(token);
    }
    return response;
  }

  /** 非 200 的答复按状态与答复体里的码分档（RULE-GLOBAL-ERROR-CONTRACT：不塌缩成一个 null）。 */
  async function refusal(response: Response | null): Promise<Readonly<{ ok: false; code: CoverLetterAttachmentFailure; serverCode?: string }>> {
    if (response === null) return { ok: false, code: 'AUTH_REQUIRED' };
    const serverCode = errorCode(await safeJson(response));
    const failure = (code: CoverLetterAttachmentFailure) =>
      serverCode === null ? { ok: false as const, code } : { ok: false as const, code, serverCode };
    if (response.status === 401) return failure('AUTH_REQUIRED');
    if (response.status === 402) return failure('PAYWALL_REQUIRED');
    if (response.status === 429) return failure('USAGE_EXHAUSTED');
    if (response.status === 403 && serverCode === 'ATTACHMENT_TARGET_NOT_ALLOWED') return failure('TARGET_NOT_ALLOWED');
    if (response.status === 404 && serverCode === 'COVER_LETTER_NOT_FOUND') return failure('NOT_FOUND');
    if (response.status === 409) return failure('BUSY');
    return failure('UNAVAILABLE');
  }

  async function json<T>(
    path: string,
    body: unknown,
    parse: (value: unknown) => T | null,
    deadlineMs: number,
  ): Promise<CoverLetterClientResult<T>> {
    const answered = await withDeadline((async (): Promise<CoverLetterClientResult<T>> => {
      const response = await send(path, body, 'application/json');
      if (response === null || response.status !== 200) return refusal(response);
      const parsed = parse(await safeJson(response));
      return parsed === null ? { ok: false, code: 'UNAVAILABLE' } : { ok: true, value: parsed };
    })(), deadlineMs);
    return answered ?? { ok: false, code: 'UNAVAILABLE' };
  }

  const client: CoverLetterAttachmentClient = {
    lookup(target) {
      return json(lookupCoverLetterAttachment.path, { schemaVersion: 1, target }, parseCoverLetterAttachmentLookupV1, timeoutMs);
    },

    prepare(target, request) {
      if (!parseUuid(request.clientRequestId)) return Promise.resolve({ ok: false, code: 'UNAVAILABLE' });
      return json(
        prepareCoverLetterAttachment.path,
        {
          schemaVersion: 1,
          clientRequestId: request.clientRequestId,
          target,
          ...(request.pageJob === undefined ? {} : { pageJob: request.pageJob }),
        },
        parseCoverLetterAttachmentPrepareResultV1,
        prepareTimeoutMs,
      );
    },

    async text(target, artifactId) {
      if (!parseUuid(artifactId)) return { ok: false, code: 'UNAVAILABLE' };
      const released = await json(
        releaseCoverLetterAttachmentText.path,
        { schemaVersion: 1, artifactId, target },
        parseCoverLetterAttachmentTextV1,
        timeoutMs,
      );
      if (!released.ok) return released;
      // 交回来的必须就是要的那一封。
      return released.value.artifactId === artifactId
        ? { ok: true, value: released.value.text }
        : { ok: false, code: 'UNAVAILABLE' };
    },

    async pdf(target, artifactId) {
      if (!parseUuid(artifactId)) return { ok: false, code: 'UNAVAILABLE' };
      const answered = await withDeadline((async (): Promise<CoverLetterClientResult<CoverLetterPdf>> => {
        const response = await send(releaseCoverLetterAttachmentPdf.path, { schemaVersion: 1, artifactId, target }, PDF_MIME);
        if (response === null || response.status !== 200) return refusal(response);
        if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(PDF_MIME)) return { ok: false, code: 'UNAVAILABLE' };
        if (response.headers.get(MISSION_MATERIAL_HEADERS.artifactId) !== artifactId) return { ok: false, code: 'UNAVAILABLE' };
        const expected = parseSha256Digest(response.headers.get(MISSION_MATERIAL_HEADERS.sha256));
        if (expected === null) return { ok: false, code: 'UNAVAILABLE' };
        const bytes = await readBoundedBytes(response, MISSION_MATERIAL_MAX_BYTES);
        if (bytes === null || bytes.byteLength === 0) return { ok: false, code: 'UNAVAILABLE' };
        if (`sha256:${await sha256Hex(bytes)}` !== expected) return { ok: false, code: 'UNAVAILABLE' };
        // 名字是契约钉死的那一个；答复头说别的就不挂。
        if (attachmentFileName(response.headers.get('content-disposition')) !== COVER_LETTER_ATTACHMENT_PDF_FILE_NAME) {
          return { ok: false, code: 'UNAVAILABLE' };
        }
        return {
          ok: true,
          value: Object.freeze({ fileName: COVER_LETTER_ATTACHMENT_PDF_FILE_NAME, size: bytes.byteLength, sha256: expected, bytes }),
        };
      })(), timeoutMs);
      return answered ?? { ok: false, code: 'UNAVAILABLE' };
    },
  };
  return Object.freeze(client);
}

function positive(value: number | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

function errorCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = (value as { code?: unknown; error?: { code?: unknown } }).code
    ?? (value as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null;
}

/** RFC 5987 `filename*` first, then a plain `filename`. */
function attachmentFileName(header: string | null): string | null {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '')?.[1];
  const plain = /filename="([^"]+)"/i.exec(header ?? '')?.[1];
  try {
    return (encoded !== undefined ? decodeURIComponent(encoded) : plain)?.trim() ?? null;
  } catch {
    return plain?.trim() ?? null;
  }
}
