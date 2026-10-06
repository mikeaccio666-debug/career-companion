import {
  getResumeAtsAttachmentPlan,
  getResumeAtsAttachmentPrepared,
  parseResumeAtsAttachmentPreparedV1,
  type ResumeAtsAttachmentPreparedV1,
  parseResumeAtsAttachmentPlanV1,
  releaseResumeAtsAttachment,
  RESUME_ATS_ATTACHMENT_HEADERS,
  RESUME_ATS_ATTACHMENT_MAX_BYTES,
  type ResumeAtsAttachmentPlanRequestV1,
  type ResumeAtsAttachmentPlanV1,
  type ResumeAtsAttachmentReleaseRequestV1,
  type ResumeAtsAttachmentTargetV1,
} from '@edaix/contracts';

/**
 * 把简历作为附件交给雇主的两个读（T9，argoland #514/#534）。只在 worker 里跑。
 *
 * 与 `missionResumeFileClient` 是两条路：那一条取的是 **mission 绑定的**那份文件，
 * 身份由 sha256 头证明；这一条没有 mission——用户站在任何一家申请页上按了 Autofill，
 * 附的是他账号里的默认简历，身份由**问询答复里钉死的三个值**证明（artifactId +
 * 两个 revision），释出时原样带回，对不上后端答 409。
 *
 * ## 两步，且第二步的输入只能来自第一步
 *
 * `release(plan, target)` 收的是 `plan()` 的答复本体，不收零散的 id：调用方没有
 * 机会自己凑一份「取最新」的请求。用户以为投的是 A 版、实际附上 B 版，比不附更糟。
 *
 * ## 释出的答复要过四道核对才算拿到文件
 *
 * 1. `content-type` 是 PDF；
 * 2. 回执头里的 resumeVersionId / artifactId 与问询逐字相等（缺头即拒）；
 * 3. 字节数不超过契约上限，而且**恰好等于**问询报的 size；
 * 4. 文件名用问询给的那一个——它已经过契约校验（无路径分隔符、.pdf 结尾），
 *    不再从 `content-disposition` 里解第二遍。
 *
 * 任一不过，一个字节都不交出去。字节只在内存里、只为这一次填写，不存不记。
 *
 * ## 失败分档
 *
 * 与 `applyMaterialsClient` 同一姿势：显式 Result、稳定码（RULE-GLOBAL-ERROR-CONTRACT），
 * 不塌缩成 null。`TARGET_NOT_ALLOWED` 单独一档，因为它对用户是一句不同的话——
 * 账号完全有权，是这个收件域名被运营清单拒了；把它并进付费墙那一档会让他去查
 * 自己的订阅。
 */
export type ResumeAttachmentFailureCode =
  | 'AUTH_REQUIRED'
  | 'PAYWALL_REQUIRED'
  /** 403 ATTACHMENT_TARGET_NOT_ALLOWED：这个收件域名不许收。 */
  | 'TARGET_NOT_ALLOWED'
  /** 404 / 409：这一份此刻给不出（找不到、还没渲染好、版本过期、library 变了）。 */
  | 'RESUME_UNAVAILABLE'
  /** 网络、超时、非 200、答复形状或身份对不上——都归这里。 */
  | 'UNAVAILABLE';

export type ResumeAttachmentResult<T> =
  | Readonly<{ ok: true; value: T }>
  /** `serverCode`：服务端答复体里的稳定错误码（如 VERSION_NOT_READY），只进诊断码，不改闭集。 */
  | Readonly<{ ok: false; code: ResumeAttachmentFailureCode; serverCode?: string }>;

export interface ReleasedResumeFile {
  readonly fileName: string;
  readonly size: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface ResumeAttachmentClient {
  /** 这一页有没有为它准备好的简历（用户在 ArgoLand 里为这个岗位改出的那一版）：有就是它的 id，没有是 null。 */
  prepared(target: ResumeAtsAttachmentTargetV1): Promise<ResumeAttachmentResult<ResumeAtsAttachmentPreparedV1>>;
  /** 释出前的问询：这一份现在还能不能附、附出去的文件叫什么。不取字节。 */
  plan(request: ResumeAtsAttachmentPlanRequestV1): Promise<ResumeAttachmentResult<ResumeAtsAttachmentPlanV1>>;
  /** 释出：带着问询钉死的三个值取字节。后端留痕，这里不留。 */
  release(
    plan: ResumeAtsAttachmentPlanV1,
    target: ResumeAtsAttachmentTargetV1,
  ): Promise<ResumeAttachmentResult<ReleasedResumeFile>>;
}

const PLAN_TIMEOUT_MS = 8_000;
const RELEASE_TIMEOUT_MS = 20_000;
const PDF_MIME = 'application/pdf';

export function createResumeAttachmentClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  planTimeoutMs?: number;
  releaseTimeoutMs?: number;
}>): ResumeAttachmentClient {
  const fetchFn = input.fetchFn ?? fetch;
  const planTimeoutMs = positive(input.planTimeoutMs) ?? PLAN_TIMEOUT_MS;
  const releaseTimeoutMs = positive(input.releaseTimeoutMs) ?? RELEASE_TIMEOUT_MS;

  function request(path: string, body: unknown, accept: string, token: string): Promise<Response> {
    return fetchFn(new URL(path, input.apiBase).toString(), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  /** 凭据、一次 401 续期、状态码分档。200 才把 Response 交出去。 */
  async function exchange(path: string, body: unknown, accept: string): Promise<ResumeAttachmentResult<Response>> {
    let token = await input.getAccessToken();
    if (token === null || token === '') return failure('AUTH_REQUIRED');
    let response = await request(path, body, accept, token);
    if (response.status === 401 && input.refreshAccessToken !== undefined) {
      token = await input.refreshAccessToken();
      if (token === null || token === '') return failure('AUTH_REQUIRED');
      response = await request(path, body, accept, token);
    }
    if (response.status === 401) return failure('AUTH_REQUIRED');
    if (response.status === 402) return failure('PAYWALL_REQUIRED');
    if (response.status === 403) {
      const code = errorCode(await safeJson(response));
      return code === 'ATTACHMENT_TARGET_NOT_ALLOWED'
        ? failure('TARGET_NOT_ALLOWED', code)
        : failure('PAYWALL_REQUIRED', code);
    }
    // 404 / 409 都归 RESUME_UNAVAILABLE，但服务端的码（RESUME_VERSION_NOT_FOUND / VERSION_NOT_READY /
    // RESUME_VERSION_STALE …）要带出来进诊断：2026-09-21 生产实测「简历没附上」，浮层只剩一个笼统码，
    // 分不清是没上传、没渲染好还是版本过期——三种下一步完全不同。
    if (response.status === 404 || response.status === 409) return failure('RESUME_UNAVAILABLE', errorCode(await safeJson(response)));
    if (response.status !== 200) return failure('UNAVAILABLE', errorCode(await safeJson(response)));
    return { ok: true, value: response };
  }

  return Object.freeze({
    async prepared(target: ResumeAtsAttachmentTargetV1): Promise<ResumeAttachmentResult<ResumeAtsAttachmentPreparedV1>> {
      return guard((async (): Promise<ResumeAttachmentResult<ResumeAtsAttachmentPreparedV1>> => {
        const exchanged = await exchange(getResumeAtsAttachmentPrepared.path, { target }, 'application/json');
        if (!exchanged.ok) return exchanged;
        const parsed = parseResumeAtsAttachmentPreparedV1(await safeJson(exchanged.value));
        if (parsed === null) return failure('UNAVAILABLE');
        return { ok: true, value: parsed };
      })(), planTimeoutMs);
    },

    async plan(planRequest: ResumeAtsAttachmentPlanRequestV1): Promise<ResumeAttachmentResult<ResumeAtsAttachmentPlanV1>> {
      return guard((async (): Promise<ResumeAttachmentResult<ResumeAtsAttachmentPlanV1>> => {
        const exchanged = await exchange(getResumeAtsAttachmentPlan.path, planRequest, 'application/json');
        if (!exchanged.ok) return exchanged;
        const parsed = parseResumeAtsAttachmentPlanV1(await safeJson(exchanged.value));
        // 解不出、或答的不是问的那一份——都当没问到。
        if (parsed === null || parsed.resumeVersionId !== planRequest.resumeVersionId) return failure('UNAVAILABLE');
        return { ok: true, value: parsed };
      })(), planTimeoutMs);
    },

    async release(
      plan: ResumeAtsAttachmentPlanV1,
      target: ResumeAtsAttachmentTargetV1,
    ): Promise<ResumeAttachmentResult<ReleasedResumeFile>> {
      return guard((async (): Promise<ResumeAttachmentResult<ReleasedResumeFile>> => {
        const releaseRequest: ResumeAtsAttachmentReleaseRequestV1 = {
          resumeVersionId: plan.resumeVersionId,
          artifactId: plan.artifactId,
          expectedContentRevision: plan.contentRevision,
          expectedLibraryRevision: plan.libraryRevision,
          target,
        };
        const exchanged = await exchange(releaseResumeAtsAttachment.path, releaseRequest, PDF_MIME);
        if (!exchanged.ok) return exchanged;
        const response = exchanged.value;
        if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(PDF_MIME)) return failure('UNAVAILABLE');
        if (
          response.headers.get(RESUME_ATS_ATTACHMENT_HEADERS.resumeVersionId) !== plan.resumeVersionId ||
          response.headers.get(RESUME_ATS_ATTACHMENT_HEADERS.artifactId) !== plan.artifactId
        ) return failure('UNAVAILABLE');
        if (plan.size > RESUME_ATS_ATTACHMENT_MAX_BYTES) return failure('UNAVAILABLE');
        const bytes = await readBoundedBytes(response, plan.size);
        if (bytes === null || bytes.byteLength !== plan.size) return failure('UNAVAILABLE');
        return { ok: true, value: Object.freeze({ fileName: plan.fileName, size: bytes.byteLength, bytes }) };
      })(), releaseTimeoutMs);
    },
  });
}

function failure(
  code: ResumeAttachmentFailureCode,
  serverCode: string | null = null,
): Readonly<{ ok: false; code: ResumeAttachmentFailureCode; serverCode?: string }> {
  // 只认闭集形状的码：答复体是不可信边界，任意文本不进诊断。
  return Object.freeze(serverCode !== null && /^[A-Z0-9_]{3,64}$/.test(serverCode)
    ? { ok: false as const, code, serverCode }
    : { ok: false as const, code });
}

function positive(value: number | undefined): number | undefined {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** 超时与抛错都收进 UNAVAILABLE：问的是事实，不确定就得说不确定。 */
async function guard<T>(
  operation: Promise<ResumeAttachmentResult<T>>,
  timeoutMs: number,
): Promise<ResumeAttachmentResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ResumeAttachmentResult<T>>((resolve) => {
    timer = setTimeout(() => resolve(failure('UNAVAILABLE')), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return failure('UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

/** 声明的或实际流过来的长度一超上限就停，半份文件不交出去。 */
async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
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

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * 答复体里的稳定错误码（`{ code }` 或错误信封 `{ error: { code } }`），只认闭集形状（与求职信客户端同一个判据）：它要缀进
 * 诊断码（RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY），像主机名、带点或冒号的一律不认（RULE-GLOBAL-DATA-L1）。
 */
function errorCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = (value as { code?: unknown; error?: { code?: unknown } }).code
    ?? (value as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null;
}
