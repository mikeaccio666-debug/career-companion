/**
 * §5.7 回执上行客户端（刀七）：run 完成后扩展直报后端。
 *
 * 契约红线（SubmitApplicationReceiptRequest 的 never 绊线同源）：
 * 不带字段值、value digest、DOM、截图、raw error、带参 URL、cookie、OTP。
 * fieldResults 只允许 claimed field subset + 稳定 outcome/reason 码——
 * 通道回执里超出 grant 的条目（页面异常字段）在这里被滤掉。
 *
 * 幂等：clientReceiptId（UUID）+ 同 payload digest 幂等返回（服务端），
 * 所以单次失败不补偿也安全——重试队列是后续扩项，失败只出诊断码。
 */

import type {
  ApplicationFieldOutcomeCode,
  ApplicationFieldReasonCode,
  ApplicationReceiptFieldResult,
  ClientReceiptOutcomeCode,
  SubmitApplicationReceiptRequest,
} from '@edaix/contracts';
import type { ReceiptUploader } from '@edaix/agent-channel';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';

export const RECEIPT_CLIENT_DIAG_CODES = [
  'RECEIPT_AUTH_UNAVAILABLE',
  'RECEIPT_UPLOAD_FAILED', // 网络/5xx（基础设施抖动；幂等 id 让重试安全）
  'RECEIPT_REJECTED', // 4xx——服务端不认这份回执（如 digest 组成失配），必须可被发现
  'RECEIPT_BINDING_MISSING', // grant 缺回执绑定值（不该发生的程序性错误）
] as const;

export interface ReceiptClientDeps {
  readonly apiBase: string;
  readonly getAccessToken: () => Promise<string | null>;
  /** 401 时强制换新一次再重试（authClient.forceRefresh；缺省不重试）。 */
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
  readonly newReceiptId?: () => string;
  readonly onDiagnostic?: (code: string) => void;
}

/**
 * kernel 稳定码 → 契约 §5.7 字段结果码。没见过的码一律
 * FAILED/UNKNOWN_SAFE_FAILURE——契约专门给了这个兜底，不猜语义。
 */
const REASON_MAP: Readonly<
  Record<string, { outcome: ApplicationFieldOutcomeCode; reason?: ApplicationFieldReasonCode }>
> = {
  NO_VALUE: { outcome: 'NEEDS_USER_INPUT' },
  CHOICE_NO_DATA: { outcome: 'NEEDS_USER_INPUT' },
  // 字段在页面上且已有值（fillEmptyOnly 不覆盖）——请本人核对，与轻确认条
  // 同语义。绝不是 FIELD_NOT_PRESENT：那是对页面事实的相反断言。
  NOT_EMPTY: { outcome: 'NEEDS_USER_INPUT' },
  DETACHED: { outcome: 'FAILED', reason: 'PAGE_CHANGED' },
  IDENTITY_CHANGED: { outcome: 'FAILED', reason: 'PAGE_CHANGED' },
  HOST_SUBMITTED: { outcome: 'FAILED', reason: 'PAGE_CHANGED' },
  WRITE_REVERTED: { outcome: 'VALIDATION_REJECTED', reason: 'VALIDATION_FAILED' },
  VALUE_COERCED: { outcome: 'VALIDATION_REJECTED', reason: 'VALIDATION_FAILED' },
  // 读回确认超时 = 结果不确定——用兜底码，不向后端断言"宿主拒绝"。
  VERIFY_TIMEOUT: { outcome: 'FAILED', reason: 'UNKNOWN_SAFE_FAILURE' },
  // ABORTED 的三个来源里只有"用户点停"是取消——那条信息在 cancelled 入参，
  // 不在字段码里；非取消场景（安全级联/lease 到期）不虚构用户动作。
  ABORTED: { outcome: 'FAILED', reason: 'UNKNOWN_SAFE_FAILURE' },
  LEASE_INVALID: { outcome: 'FAILED', reason: 'FIELD_NOT_APPROVED' },
  LEASE_EXPIRED: { outcome: 'FAILED', reason: 'POLICY_CHANGED' },
  CAPABILITY_DISABLED: { outcome: 'FAILED', reason: 'POLICY_CHANGED' },
  POLICY_DISABLED: { outcome: 'FAILED', reason: 'POLICY_CHANGED' },
};

function toFieldResult(
  outcome: ReceiptFieldOutcome,
  cancelled: boolean,
): ApplicationReceiptFieldResult {
  if (outcome.ok) return { fieldKey: outcome.key, outcomeCode: 'FILLED' };
  // 取消收口的 run 里，未写字段的 ABORTED 才真是用户取消。
  if (cancelled && outcome.reason === 'ABORTED') {
    return { fieldKey: outcome.key, outcomeCode: 'FAILED', reasonCode: 'USER_CANCELLED' };
  }
  const mapped = outcome.reason === undefined ? undefined : REASON_MAP[outcome.reason];
  if (!mapped) {
    return { fieldKey: outcome.key, outcomeCode: 'FAILED', reasonCode: 'UNKNOWN_SAFE_FAILURE' };
  }
  return mapped.reason === undefined
    ? { fieldKey: outcome.key, outcomeCode: mapped.outcome }
    : { fieldKey: outcome.key, outcomeCode: mapped.outcome, reasonCode: mapped.reason };
}

/**
 * 整单结论。分母是 **claimed 字段数**：结果没覆盖到全部批准字段
 * （计划期跳过/字段消失）就不许报"全部成功"。取消一律 CANCELLED——
 * fieldResults 记录事实，整单码记录收口方式。
 */
export function deriveReceiptOutcome(
  fieldResults: readonly ApplicationReceiptFieldResult[],
  claimedCount: number,
  cancelled: boolean,
): ClientReceiptOutcomeCode {
  if (cancelled) return 'CANCELLED';
  const filled = fieldResults.filter((result) => result.outcomeCode === 'FILLED').length;
  if (claimedCount > 0 && filled === claimedCount) return 'FILL_SUCCEEDED';
  if (filled > 0) return 'FILL_PARTIAL';
  if (fieldResults.some((result) => result.outcomeCode === 'NEEDS_USER_INPUT')) {
    return 'USER_ACTION_REQUIRED';
  }
  return 'FAILED';
}

/**
 * 浮层任务那一轮的回执（2026-09-24）：claim 过的每一个键各一条，没有结果的键如实记
 * NEEDS_USER_INPUT（这一栏要他自己看），同一个键多条结果时有一条填上就算填上。
 * 浮层的逐项结果里不属于 claim 的条目（记忆答案、行内角色、简历栏）一律不报。
 */
export function dockReceiptFieldResults(
  claimedKeys: readonly string[],
  outcomes: readonly ReceiptFieldOutcome[],
): ApplicationReceiptFieldResult[] {
  return [...new Set(claimedKeys)].sort().map((key) => {
    const forKey = outcomes.filter((outcome) => outcome.key === key);
    const filled = forKey.find((outcome) => outcome.ok);
    if (filled) return toFieldResult(filled, false);
    const first = forKey[0];
    return first ? toFieldResult(first, false) : { fieldKey: key, outcomeCode: 'NEEDS_USER_INPUT' };
  });
}

/**
 * 浮层任务那一轮的整单结论只有两种（2026-09-24）：全部 claim 的键都填上是 FILL_SUCCEEDED，
 * 否则 USER_ACTION_REQUIRED。**不报 FILL_PARTIAL**：后端把它当终局（任务 PARTIALLY_SUCCEEDED），
 * 多页申请的第二页就再也批不下来；而「还有几栏要你补」本来就是等用户动手。
 */
export function deriveDockReceiptOutcome(
  fieldResults: readonly ApplicationReceiptFieldResult[],
  claimedCount: number,
): Extract<ClientReceiptOutcomeCode, 'FILL_SUCCEEDED' | 'USER_ACTION_REQUIRED'> {
  const filled = fieldResults.filter((result) => result.outcomeCode === 'FILLED').length;
  return claimedCount > 0 && filled === claimedCount ? 'FILL_SUCCEEDED' : 'USER_ACTION_REQUIRED';
}

/** 浮层任务那一轮交回执：结果已经算好，只管上行（幂等 id 与 401 处理与 run 协调器那条同一套）。 */
export async function uploadDockReceipt(
  deps: ReceiptClientDeps,
  input: Readonly<{
    grant: Pick<
      Parameters<ReceiptUploader['upload']>[0]['grant'],
      'missionId' | 'missionStepId' | 'intentVersion' | 'executionLease' | 'planDigest' | 'jobIdentityHash' | 'fieldKeys'
    >;
    fieldResults: readonly ApplicationReceiptFieldResult[];
    startedAt: Date;
    finishedAt: Date;
  }>,
): Promise<boolean> {
  const diag = (code: string) => deps.onDiagnostic?.(code);
  const { grant } = input;
  if (!grant.executionLease || !grant.planDigest || !grant.jobIdentityHash) {
    diag('RECEIPT_BINDING_MISSING');
    return false;
  }
  type Wire = SubmitApplicationReceiptRequest;
  const wire: Wire = {
    clientReceiptId: (deps.newReceiptId ?? (() => crypto.randomUUID()))() as Wire['clientReceiptId'],
    executionLease: grant.executionLease,
    missionStepId: grant.missionStepId as Wire['missionStepId'],
    intentVersion: grant.intentVersion,
    jobIdentityHash: grant.jobIdentityHash as Wire['jobIdentityHash'],
    planDigest: grant.planDigest as Wire['planDigest'],
    outcome: deriveDockReceiptOutcome(input.fieldResults, grant.fieldKeys.length),
    fieldResults: input.fieldResults,
    executionStartedAt: input.startedAt.toISOString() as Wire['executionStartedAt'],
    executionFinishedAt: input.finishedAt.toISOString() as Wire['executionFinishedAt'],
  };
  return postReceipt(deps, grant.missionId, wire);
}

async function postReceipt(
  deps: ReceiptClientDeps,
  missionId: string,
  wire: SubmitApplicationReceiptRequest,
): Promise<boolean> {
  const fetchFn = deps.fetchFn ?? fetch;
  const diag = (code: string) => deps.onDiagnostic?.(code);
  const token = await deps.getAccessToken().catch(() => null);
  if (token === null) {
    diag('RECEIPT_AUTH_UNAVAILABLE');
    return false;
  }
  try {
    const doUpload = (bearer: string) =>
      fetchFn(
        new URL(`/api/v1/agent/missions/${encodeURIComponent(missionId)}/receipts`, deps.apiBase).toString(),
        {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(wire),
        },
      );
    let response = await doUpload(token);
    // 401 看码分流（§2.2 警告）：仅 LOGIN_REQUIRED 换新重放
    // （clientReceiptId 幂等，重放安全）；其余 401 原样收口。
    if (response.status === 401 && deps.refreshAccessToken) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // 非 JSON 401 → 不换新。
      }
      if ((body as { code?: unknown } | null)?.code === 'LOGIN_REQUIRED') {
        const renewed = await deps.refreshAccessToken();
        if (renewed !== null) response = await doUpload(renewed);
      } else {
        response = { ok: false, status: 401, json: async () => body } as Response;
      }
    }
    if (!response.ok) {
      // 4xx 是"服务端不认这份回执"（如 digest 组成失配），与网络抖动
      // 分码——组成对齐问题必须能被发现，不能淹在重试噪音里。
      diag(response.status >= 400 && response.status < 500 ? 'RECEIPT_REJECTED' : 'RECEIPT_UPLOAD_FAILED');
      return false;
    }
    return true;
  } catch {
    diag('RECEIPT_UPLOAD_FAILED');
    return false;
  }
}

export function createReceiptUploader(deps: ReceiptClientDeps): ReceiptUploader {
  const newReceiptId = deps.newReceiptId ?? (() => crypto.randomUUID());
  const diag = (code: string) => deps.onDiagnostic?.(code);

  return {
    async upload({ grant, receipt, startedAt, cancelled }) {
      if (!grant.executionLease || !grant.planDigest || !grant.jobIdentityHash) {
        diag('RECEIPT_BINDING_MISSING');
        return;
      }
      // 只报 claimed field subset：通道回执里超出 grant 的条目滤掉。
      const approved = new Set(grant.fieldKeys);
      const fieldResults = receipt.outcomes
        .filter((outcome) => approved.has(outcome.key))
        .map((outcome) => toFieldResult(outcome, cancelled));

      // 契约的 Uuid/Sha256Digest/IsoDateTime 是品牌类型（wire 层防混用）；
      // 运行时来源就是对应形状，这里做一次显式窄化。
      type Wire = SubmitApplicationReceiptRequest;
      const wire: Wire = {
        clientReceiptId: newReceiptId() as Wire['clientReceiptId'],
        executionLease: grant.executionLease,
        missionStepId: grant.missionStepId as Wire['missionStepId'],
        intentVersion: grant.intentVersion,
        jobIdentityHash: grant.jobIdentityHash as Wire['jobIdentityHash'],
        planDigest: grant.planDigest as Wire['planDigest'],
        outcome: deriveReceiptOutcome(fieldResults, grant.fieldKeys.length, cancelled),
        fieldResults,
        executionStartedAt: new Date(startedAt * 1000).toISOString() as Wire['executionStartedAt'],
        executionFinishedAt: new Date(receipt.finishedAt * 1000).toISOString() as Wire['executionFinishedAt'],
      };

      await postReceipt(deps, grant.missionId, wire);
    },
  };
}
