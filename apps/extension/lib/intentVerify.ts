/**
 * ExecutionIntent 的扩展侧验签与载荷校验（契约 §5.2/§5.3/§5.5，RFC 8725）。
 *
 * 只发生在扩展隔离环境（§4.1）：JWS 由 intentClient 自领后立即送来这里，
 * 验签通过才可能进入 claim。所有失败 fail-closed，只产出稳定原因码——
 * JWS 本体、任何载荷片段都不出现在诊断里。
 *
 * RFC 8725 §3.1 的算法收口：verifier 不从 token 自由选择算法。
 * 只接受 ES256 + 精确 typ + JWKS 里已知的 kid；header 出现 alg=none、
 * HMAC 系算法、jku、x5u、crit、b64 或任何白名单外的键 → 整份拒收。
 */

import {
  ATS_PROVIDER_CODES,
  EXECUTION_INTENT_ALGORITHM,
  EXECUTION_INTENT_AUDIENCE,
  EXECUTION_INTENT_TYPE,
  EXECUTION_INTENT_VERSION,
  SOURCE_PLATFORM_CODES,
  type ExecutionIntentClaims,
  type ExecutionIntentPublicJwk,
} from '@edaix/contracts';

export const INTENT_VERIFY_ERROR_CODES = [
  'INTENT_MALFORMED', // 结构不对：压缩 JWS 段数、JSON、必填字段、白名单外的键
  'INTENT_HEADER_REJECTED', // alg/typ 不符或出现被禁 header 参数（RFC 8725）
  'INTENT_KID_UNKNOWN', // kid 不在受信 JWKS（刷新一次后仍未知）
  'INTENT_SIGNATURE_INVALID', // 验签失败
  'INTENT_EXPIRED', // exp（含 30s skew）已过
  'INTENT_NOT_YET_VALID', // nbf（含 30s skew）未到
  'INTENT_TTL_TOO_LONG', // exp - iat > 120s——比契约上限长的票一律不收
  'INTENT_ISSUER_MISMATCH',
  'INTENT_AUDIENCE_MISMATCH',
  'INTENT_INSTALL_MISMATCH', // extensionInstallId 不是本安装
  'INTENT_SUBJECT_MISMATCH', // sub 不是当前登录用户（§5.5.1 五必查之一）
  'INTENT_FIELD_VALUE_SMUGGLED', // 载荷出现值类内容/容器——整份拒收（Data-L1 绊线）
] as const;
export type IntentVerifyErrorCode = (typeof INTENT_VERIFY_ERROR_CODES)[number];

export type IntentVerifyResult =
  | { readonly ok: true; readonly claims: ExecutionIntentClaims }
  | { readonly ok: false; readonly code: IntentVerifyErrorCode };

/** 契约 §5.3：`exp - iat <= 120s`；最大 clock skew 30s。 */
export const INTENT_MAX_TTL_SECONDS = 120;
export const INTENT_CLOCK_SKEW_SECONDS = 30;

const HEADER_KEYS = new Set(['alg', 'kid', 'typ']);
const CLAIM_KEYS = new Set([
  'ver', 'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp',
  'missionId', 'missionRevision', 'missionStepId', 'stepAttempt', 'intentVersion',
  'extensionInstallId', 'target', 'fieldKeys', 'fieldSchemaVersion',
  'automationLevel', 'allowedActions', 'planDigest', 'approvalMessageId',
  'profile', 'resume', 'policyVersion', 'killSwitchVersion', 'consentVersion',
]);
const TARGET_KEYS = new Set([
  'jobId', 'sourcePlatform', 'atsProvider', 'canonicalOrigin', 'pathRuleId', 'postingFingerprint',
]);
const PROFILE_KEYS = new Set(['revision', 'deletionEpoch', 'snapshotDigest']);
const RESUME_KEYS = new Set(['versionId', 'contentHash', 'contentRevision', 'libraryRevision']);

/** 值类容器名：出现即按走私处理，而不是普通畸形（同 draft 解析器的姿势）。 */
const SMUGGLE_KEYS = new Set([
  'values', 'answers', 'fields', 'profileValues', 'resumeText', 'jobDescription',
  'cookie', 'cookies', 'otp', 'password', 'token',
]);

/** 写入档位的 wire 闭集；L0 不签发写入 Intent（§5.3），收到即畸形。 */
const WRITE_AUTOMATION_LEVELS = new Set([
  'L1_FILL_STOP_BEFORE_SUBMIT', 'L2_CONFIRM_EACH_SUBMISSION', 'L3_MANAGED_BATCH',
]);
const ALLOWED_ACTIONS = new Set(['FILL', 'SUBMIT']);
/** §5.3 v1 闭集：新增 provider 必须先升级闭集/测试，不能任意 string 静默放行。 */
const SOURCE_PLATFORMS: ReadonlySet<string> = new Set(SOURCE_PLATFORM_CODES);
const ATS_PROVIDERS: ReadonlySet<string> = new Set(ATS_PROVIDER_CODES);
/** fieldSchemaVersion 选择 code-owned registry；本版本只认得 v1（§1.1 未知版本 fail-closed）。 */
const SUPPORTED_FIELD_SCHEMA_VERSIONS = new Set([1]);

export function base64UrlToBytes(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isShortIdentifier(value: unknown): value is string {
  return nonEmptyString(value) && value.length <= 64 && !/\s/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

type KeyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'INTENT_MALFORMED' | 'INTENT_FIELD_VALUE_SMUGGLED' };

function checkAllowlistedKeys(record: Record<string, unknown>, allowlist: ReadonlySet<string>): KeyCheck {
  for (const key of Object.keys(record)) {
    if (!allowlist.has(key)) {
      return { ok: false, code: SMUGGLE_KEYS.has(key) ? 'INTENT_FIELD_VALUE_SMUGGLED' : 'INTENT_MALFORMED' };
    }
  }
  return { ok: true };
}

interface ValidateClaimsInput {
  readonly payload: Record<string, unknown>;
  readonly expectedIssuer: string;
  readonly expectedInstallId: string;
  /** 当前登录用户（access JWT 的 user id）——§5.5.1 的 sub 必查。 */
  readonly expectedSubject: string;
  readonly nowSeconds: number;
}

/** 验签**之后**的载荷校验（§5.3 规则逐条）。导出仅供特征测试直接打靶。 */
export function validateIntentClaims(input: ValidateClaimsInput): IntentVerifyResult {
  const { payload, nowSeconds } = input;

  const topKeys = checkAllowlistedKeys(payload, CLAIM_KEYS);
  if (!topKeys.ok) return topKeys;

  if (payload['ver'] !== EXECUTION_INTENT_VERSION) return { ok: false, code: 'INTENT_MALFORMED' };
  if (payload['aud'] !== EXECUTION_INTENT_AUDIENCE) return { ok: false, code: 'INTENT_AUDIENCE_MISMATCH' };
  if (payload['iss'] !== input.expectedIssuer) return { ok: false, code: 'INTENT_ISSUER_MISMATCH' };
  if (payload['sub'] !== input.expectedSubject) return { ok: false, code: 'INTENT_SUBJECT_MISMATCH' };

  for (const key of ['sub', 'jti', 'missionId', 'missionRevision', 'missionStepId', 'policyVersion', 'killSwitchVersion', 'consentVersion', 'approvalMessageId'] as const) {
    if (!nonEmptyString(payload[key])) return { ok: false, code: 'INTENT_MALFORMED' };
  }
  const iat = payload['iat'];
  const nbf = payload['nbf'];
  const exp = payload['exp'];
  if (typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number' || exp <= iat) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  if (exp - iat > INTENT_MAX_TTL_SECONDS) return { ok: false, code: 'INTENT_TTL_TOO_LONG' };
  if (nbf - INTENT_CLOCK_SKEW_SECONDS > nowSeconds) return { ok: false, code: 'INTENT_NOT_YET_VALID' };
  // §5.3 公式 `nbf <= now+skew < exp+skew`：exp 侧两边 skew 相消 = 到点即死、
  // 无宽限（skew 只救 nbf 侧）。按契约字面执行（fail-closed 取严）；公式意图
  // 已列入后端对齐清单——若后端本意是 exp 侧也留 skew，改契约文字后再放宽。
  if (nowSeconds >= exp) return { ok: false, code: 'INTENT_EXPIRED' };

  if (typeof payload['stepAttempt'] !== 'number' || typeof payload['intentVersion'] !== 'number') {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  if (!SUPPORTED_FIELD_SCHEMA_VERSIONS.has(payload['fieldSchemaVersion'] as number)) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  if (payload['extensionInstallId'] !== input.expectedInstallId) {
    return { ok: false, code: 'INTENT_INSTALL_MISMATCH' };
  }
  if (!isSha256(payload['planDigest'])) return { ok: false, code: 'INTENT_MALFORMED' };

  const target = payload['target'];
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  const targetRecord = target as Record<string, unknown>;
  const targetKeys = checkAllowlistedKeys(targetRecord, TARGET_KEYS);
  if (!targetKeys.ok) return targetKeys;
  for (const key of ['jobId', 'sourcePlatform', 'atsProvider', 'pathRuleId'] as const) {
    if (!nonEmptyString(targetRecord[key])) return { ok: false, code: 'INTENT_MALFORMED' };
  }
  if (!SOURCE_PLATFORMS.has(targetRecord['sourcePlatform'] as string)) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  if (!ATS_PROVIDERS.has(targetRecord['atsProvider'] as string)) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  const origin = targetRecord['canonicalOrigin'];
  // §1.2：无 credential、无 path/query/fragment 的 HTTPS origin。
  if (!nonEmptyString(origin) || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  if (!isSha256(targetRecord['postingFingerprint'])) return { ok: false, code: 'INTENT_MALFORMED' };

  const fieldKeys = payload['fieldKeys'];
  if (!Array.isArray(fieldKeys) || fieldKeys.length === 0) return { ok: false, code: 'INTENT_MALFORMED' };
  for (const key of fieldKeys) {
    // 字段 key 是短标识符；出现空白/超长内容说明有人往"清单"里塞"内容"。
    if (!isShortIdentifier(key)) return { ok: false, code: 'INTENT_FIELD_VALUE_SMUGGLED' };
  }
  // §5.3：排序、去重的闭集——乱序/重复本身就是畸形，不做静默规范化。
  for (let i = 1; i < fieldKeys.length; i += 1) {
    if ((fieldKeys[i] as string) <= (fieldKeys[i - 1] as string)) {
      return { ok: false, code: 'INTENT_MALFORMED' };
    }
  }

  const level = payload['automationLevel'];
  if (typeof level !== 'string' || !WRITE_AUTOMATION_LEVELS.has(level)) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
  const actions = payload['allowedActions'];
  if (!Array.isArray(actions) || actions.length === 0) return { ok: false, code: 'INTENT_MALFORMED' };
  for (const action of actions) {
    if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
      return { ok: false, code: 'INTENT_MALFORMED' };
    }
  }
  // 与 fieldKeys 同姿势：§5.3 对两者同句要求"排序、去重"，只锁一半是漏。
  for (let i = 1; i < actions.length; i += 1) {
    if ((actions[i] as string) <= (actions[i - 1] as string)) {
      return { ok: false, code: 'INTENT_MALFORMED' };
    }
  }
  // 档位-动作耦合（§5.3）：档位 L1 只能 FILL 停在提交前——带 SUBMIT 的档位 L1 票拒收。
  if (level === 'L1_FILL_STOP_BEFORE_SUBMIT' && actions.includes('SUBMIT')) {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }

  const profile = payload['profile'];
  const resume = payload['resume'];
  for (const [nested, allowlist] of [
    [profile, PROFILE_KEYS],
    [resume, RESUME_KEYS],
  ] as const) {
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
      return { ok: false, code: 'INTENT_MALFORMED' };
    }
    const nestedKeys = checkAllowlistedKeys(nested as Record<string, unknown>, allowlist);
    if (!nestedKeys.ok) return nestedKeys;
  }
  const profileRecord = profile as Record<string, unknown>;
  const resumeRecord = resume as Record<string, unknown>;
  if (!isSha256(profileRecord['snapshotDigest'])) return { ok: false, code: 'INTENT_MALFORMED' };
  if (!isSha256(resumeRecord['contentHash'])) return { ok: false, code: 'INTENT_MALFORMED' };
  // 必填子字段的存在性（deletionEpoch 是"删除后旧数据复活"的防线，§1.2）。
  for (const key of ['revision', 'deletionEpoch'] as const) {
    if (!nonEmptyString(profileRecord[key])) return { ok: false, code: 'INTENT_MALFORMED' };
  }
  for (const key of ['versionId', 'contentRevision', 'libraryRevision'] as const) {
    if (!nonEmptyString(resumeRecord[key])) return { ok: false, code: 'INTENT_MALFORMED' };
  }

  return { ok: true, claims: payload as unknown as ExecutionIntentClaims };
}

function isTrustedJwk(candidate: unknown): candidate is ExecutionIntentPublicJwk {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const jwk = candidate as Record<string, unknown>;
  return (
    jwk['kty'] === 'EC' &&
    jwk['crv'] === 'P-256' &&
    nonEmptyString(jwk['kid']) &&
    nonEmptyString(jwk['x']) &&
    nonEmptyString(jwk['y']) &&
    // 公钥响应绝不能带私钥标量；带了按不受信处理。
    !('d' in jwk)
  );
}

export interface VerifyExecutionIntentInput {
  readonly jws: string;
  readonly keys: readonly ExecutionIntentPublicJwk[];
  readonly expectedIssuer: string;
  readonly expectedInstallId: string;
  readonly expectedSubject: string;
  readonly nowSeconds?: number;
}

export async function verifyExecutionIntent(
  input: VerifyExecutionIntentInput,
): Promise<IntentVerifyResult> {
  // 意外异常也收敛为稳定码：验签边界上抛裸错 = 上游无 run/stopped 收尾
  // （铁律 2；审计 2026-08-13 的异常逃逸漏斗）。
  try {
    return await verifyExecutionIntentInner(input);
  } catch {
    return { ok: false, code: 'INTENT_MALFORMED' };
  }
}

async function verifyExecutionIntentInner(
  input: VerifyExecutionIntentInput,
): Promise<IntentVerifyResult> {
  const parts = input.jws.split('.');
  if (parts.length !== 3) return { ok: false, code: 'INTENT_MALFORMED' };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeJsonSegment(headerSegment);
  if (!header) return { ok: false, code: 'INTENT_MALFORMED' };
  // RFC 8725：header 键白名单之外（jku/x5u/crit/b64/…）一律拒收。
  for (const key of Object.keys(header)) {
    if (!HEADER_KEYS.has(key)) return { ok: false, code: 'INTENT_HEADER_REJECTED' };
  }
  if (header['alg'] !== EXECUTION_INTENT_ALGORITHM || header['typ'] !== EXECUTION_INTENT_TYPE) {
    return { ok: false, code: 'INTENT_HEADER_REJECTED' };
  }
  const kid = header['kid'];
  if (!nonEmptyString(kid)) return { ok: false, code: 'INTENT_HEADER_REJECTED' };

  // 条目本身可能是畸形（null/非对象）——先形状后取 kid，坏条目跳过不炸。
  const jwk = input.keys.find((key) => isTrustedJwk(key) && key.kid === kid);
  if (!jwk) return { ok: false, code: 'INTENT_KID_UNKNOWN' };

  const signature = base64UrlToBytes(signatureSegment);
  // ES256 签名是 P1363 r||s 共 64 字节——WebCrypto 的原生格式，直接喂。
  if (!signature || signature.length !== 64) return { ok: false, code: 'INTENT_SIGNATURE_INVALID' };

  let verified = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signature as unknown as BufferSource,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    return { ok: false, code: 'INTENT_SIGNATURE_INVALID' };
  }
  if (!verified) return { ok: false, code: 'INTENT_SIGNATURE_INVALID' };

  const payload = decodeJsonSegment(payloadSegment);
  if (!payload) return { ok: false, code: 'INTENT_MALFORMED' };
  return validateIntentClaims({
    payload,
    expectedIssuer: input.expectedIssuer,
    expectedInstallId: input.expectedInstallId,
    expectedSubject: input.expectedSubject,
    nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
  });
}
