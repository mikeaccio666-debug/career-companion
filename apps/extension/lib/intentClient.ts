/**
 * 凭证 HTTP 客户端（刀六a）：IntentAcquirer / IntentClaimer 的真实现。
 *
 * 全流程只发生在扩展隔离环境（契约 §4.1）：
 *   acquire  = POST §5.4 签发 → 取 JWKS（§5.2，缓存 + kid 未知强刷一次）
 *              → 本地验签与载荷校验（intentVerify，RFC 8725）
 *   claim    = §5.5 本地复核（目标 origin / 字段集合相等）→ POST §5.6
 *              服务端原子 claim → 换取 opaque lease
 *
 * 服务端仍是比对的权威（协调器注释的老原则不变）；这里的本地复核是契约
 * §5.5 明文要求的第一道 fail-closed——一次注定失败的 claim 没必要上网。
 *
 * ⚠️ 已知缺口（2026-08-13 审计确认，规则下发落地前放行）：§5.5.2 要求
 * 从当前 tab 独立重算 path rule 与 posting fingerprint，v1 只独立复核了
 * canonicalOrigin，actualTarget 其余两项回显批准值——同 origin 换岗位的
 * 检测因此依赖 scanDigest（内含 pathname）与服务端组成对齐。收口条件 =
 * 后端 pathRule/岗位指纹规则可下发（对齐清单第 1 项）；届时本地重算并比对。
 *
 * Data-L1 / 凭证纪律：JWS 与 lease 只存在于本模块闭包内存；诊断出口
 * 只给稳定原因码，绝无 JWS/lease/载荷片段/URL；注入的 provider 抛错
 * 也不读其内容，一律收敛为稳定码。
 */

import type {
  ClaimExecutionIntentRequest,
  ExecutionIntentClaims,
  ExecutionIntentPublicJwk,
} from '@edaix/contracts';
import {
  EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS,
  partitionExecutionIntentClaimKeys,
} from '@edaix/contracts';
import type {
  AcquiredIntent,
  ExecutionGrant,
  IntentAcquirer,
  IntentClaimer,
  RunStartRef,
} from '@edaix/agent-channel';
import { INTENT_CLOCK_SKEW_SECONDS, base64UrlToBytes, verifyExecutionIntent } from './intentVerify';
import { sha256CanonicalJson } from './canonicalDigest';
import type { VerifiedIntentRuntimeTarget } from './executionRuntimeAuthority';

export const INTENT_CLIENT_DIAG_CODES = [
  'AUTH_UNAVAILABLE', // 拿不到 access token / 用户标识（T22 未接或已登出）——fail-closed
  'INSTALL_ID_UNAVAILABLE', // 本安装无 install id——fail-closed
  'ISSUE_HTTP_FAILED', // 签发请求网络/状态码失败
  'ISSUE_RESPONSE_MALFORMED',
  'JWKS_UNAVAILABLE', // JWKS 拉取失败（验签绝不降级跳过，§5.2）
  'JWKS_MALFORMED', // 200 但 keyset 不合严格制——原子拒绝，沿用最后一份已验证缓存
  'INTENT_REF_MISMATCH', // 验签通过但 claims 里的任务引用与 run/start 不符
  'CLAIM_LOCAL_ORIGIN_MISMATCH', // §5.5.2：当前页 origin ≠ 批准目标
  'CLAIM_LOCAL_FIELDSET_MISMATCH', // §5.5.3：实际字段集合 ≠ 批准集合（相等制）
  'CLAIM_LOCAL_QUESTION_SET_MISMATCH', // 批准的记忆答案对应的题已不在本页上
  'CLAIM_INTENT_KEY_SET_MALFORMED', // 已验签 claims 的 key 集合不是合法的两类闭集
  'CLAIM_SCAN_DIGEST_MALFORMED', // scanDigest 不是 §1.2 约定的 sha256:<hex> 形状
  'CLAIM_HTTP_FAILED',
  'CLAIM_RESPONSE_MALFORMED',
  'CLAIM_UNKNOWN_INTENT', // claim 时找不到已验签记录（顺序错乱/已核销/已过期清扫）
  'CLIENT_INTERNAL_ERROR', // 兜底：意外异常收敛为稳定码，绝不裸抛出边界
] as const;
export type IntentClientDiagCode = (typeof INTENT_CLIENT_DIAG_CODES)[number];

export interface IntentClientDeps {
  /** API origin（wxt define __VIBE_API_BASE__；商店包/staging 闸在 wxt.config）。 */
  readonly apiBase: string;
  /** 环境固定的 iss 常量（§5.3）。联调环境方案落地前 = API origin。 */
  readonly expectedIssuer: string;
  /** T22 auth 集成的注入口；返回 null = 未登录 → 一律拒绝。 */
  readonly getAccessToken: () => Promise<string | null>;
  /** 401 时强制换新一次再重试（authClient.forceRefresh；缺省不重试）。 */
  readonly refreshAccessToken?: () => Promise<string | null>;
  /** 当前登录用户 id（access JWT 的 sub）——§5.5.1 sub 必查；null → 拒绝。 */
  readonly getUserId: () => Promise<string | null>;
  /** 本安装的稳定 UUID（§5.4 install binding）；null → 一律拒绝。 */
  readonly getInstallId: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
  /** Unix 秒。 */
  readonly now?: () => number;
  /** 诊断出口：只收稳定码（intentVerify 码 + 本模块码），铁律 1/2。 */
  readonly onDiagnostic?: (code: string) => void;
  /**
   * 签发前的 value-free 记忆探针（PRODUCT-AUTHORITY §3 Reuse）。
   *
   * 返回本次目标页上题目**身份摘要**——只有 `sha256:<hex>`，绝无题干或选项文本。
   * 它不是授权：服务端拿它当过滤条件，自己按 owner 的 autoReuse、记忆是否存在、
   * scope 是否覆盖本次申请来决定签发哪些记忆键。
   *
   * 不注入 = 一个摘要都不上报 = 一个记忆键都不会被签发（default-off）。
   */
  readonly readReusableQuestionDigests?: (ref: RunStartRef) => Promise<readonly string[]>;
}

export interface IntentClient {
  readonly acquirer: IntentAcquirer;
  readonly claimer: IntentClaimer;
  /** 已验签凭证的批准目标 origin（给 tab 定位用）；未验签/已核销 → null。 */
  getVerifiedTargetOrigin(intent: AcquiredIntent): string | null;
  /** Value-free exact runtime facts from the same verified in-memory record. */
  getVerifiedRuntimeTarget(intent: AcquiredIntent): VerifiedIntentRuntimeTarget | null;
}

const JWKS_PATH = '/.well-known/edaix-execution-intent-jwks.json';
const JWKS_CACHE_SECONDS = 300;
/**
 * 旧缓存兜底的硬性陈旧上限：网络失败时可以用旧 JWKS（比"跳过验签"安全），
 * 但不能无限期——否则撤 key 的时效被取数失败无限拖长（插件时代"远程开关
 * 必须有取数通道"教训的密钥版）。24h 覆盖契约要求的 rotation overlap。
 */
const JWKS_MAX_STALE_SECONDS = 86_400;

/** claim 端点的这三个码 = 页面与批准不一致——停法与本地重扫失配相同。 */
const RESCAN_MISMATCH_CODES = new Set([
  'EXECUTION_TARGET_MISMATCH',
  'EXECUTION_FIELD_SET_MISMATCH',
  'EXECUTION_PLAN_MISMATCH',
]);

interface VerifiedRecord {
  readonly claims: ExecutionIntentClaims;
  readonly exp: number;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

const JWK_EXACT_KEYS = ['kty', 'crv', 'use', 'alg', 'kid', 'x', 'y'] as const;

/** P-256 坐标必须是 canonical 32 字节的 base64url。 */
function isCanonicalCoordinate(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  const bytes = base64UrlToBytes(value);
  return bytes !== null && bytes.length === 32;
}

/**
 * §5.2 严格 keyset 解析（源契约 1ce3288c 镜像）：整体 2–4 把；每把**恰好**
 * 七字段且取固定值；拒 d/未知字段/非法或重复 kid/重复 key material/
 * 非 canonical 坐标。任何一处不合 → 整份 null（原子拒绝——绝不用空/
 * 部分结果覆盖最后一份已验证缓存）。
 */
export function parseJwksStrict(body: unknown): readonly ExecutionIntentPublicJwk[] | null {
  const rawKeys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(rawKeys) || rawKeys.length < 2 || rawKeys.length > 4) return null;

  const kids = new Set<string>();
  const material = new Set<string>();
  const keys: ExecutionIntentPublicJwk[] = [];
  for (const candidate of rawKeys) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
    const jwk = candidate as Record<string, unknown>;
    const names = Object.keys(jwk);
    if (names.length !== JWK_EXACT_KEYS.length) return null;
    for (const name of names) if (!(JWK_EXACT_KEYS as readonly string[]).includes(name)) return null;
    if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256' || jwk['use'] !== 'sig' || jwk['alg'] !== 'ES256') {
      return null;
    }
    const kid = jwk['kid'];
    if (typeof kid !== 'string' || kid === '' || kids.has(kid)) return null;
    if (!isCanonicalCoordinate(jwk['x']) || !isCanonicalCoordinate(jwk['y'])) return null;
    const materialKey = `${jwk['x'] as string}.${jwk['y'] as string}`;
    if (material.has(materialKey)) return null;
    kids.add(kid);
    material.add(materialKey);
    keys.push(jwk as unknown as ExecutionIntentPublicJwk);
  }
  return keys;
}

export function createIntentClient(deps: IntentClientDeps): IntentClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const diag = (code: string) => deps.onDiagnostic?.(code);

  /**
   * 带一次 401 重试的 bearer 请求——**看码分流，不做 status-only**：
   * 只有 LOGIN_REQUIRED（auth 类）才换新重放。EXECUTION_INTENT_INVALID
   * 等同为 401，但恢复动作是重新签发整单，盲重放只会白烧一次 token
   * 轮转（后端 §2.2 切片 952b818f 的明确警告）。
   */
  async function bearerRequest(
    token: string,
    doRequest: (bearer: string) => Promise<Response>,
  ): Promise<Response> {
    const response = await doRequest(token);
    if (response.status !== 401 || !deps.refreshAccessToken) return response;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 非 JSON 的 401 按非 auth 类处理，不换新。
    }
    // body 已被消费——非重试路径回一个保留了错误体的等价响应。
    const replay = { ok: false, status: 401, json: async () => body } as Response;
    if ((body as { code?: unknown } | null)?.code !== 'LOGIN_REQUIRED') return replay;
    const renewed = await deps.refreshAccessToken();
    if (renewed === null) return replay;
    return doRequest(renewed);
  }

  // 已验签凭证：JWS → claims。只在本 SW 实例内存中；claim 后即删（一次性），
  // 未 claim 的条目按 exp 惰性清扫（凭证最小化：不留过期的活票据）。
  const verified = new Map<string, VerifiedRecord>();

  function sweepVerified(): void {
    const cutoff = now() - INTENT_CLOCK_SKEW_SECONDS;
    for (const [jws, record] of verified) {
      if (record.exp < cutoff) verified.delete(jws);
    }
  }

  let jwksCache: { keys: readonly ExecutionIntentPublicJwk[]; fetchedAt: number } | null = null;

  function staleFallback(): readonly ExecutionIntentPublicJwk[] | null {
    if (!jwksCache) return null;
    // 陈旧上限：超过就宁可 fail-closed，也不无限信任可能已撤下的 key。
    return now() - jwksCache.fetchedAt <= JWKS_MAX_STALE_SECONDS ? jwksCache.keys : null;
  }

  async function fetchJwks(forceRefresh: boolean): Promise<readonly ExecutionIntentPublicJwk[] | null> {
    if (!forceRefresh && jwksCache && now() - jwksCache.fetchedAt < JWKS_CACHE_SECONDS) {
      return jwksCache.keys;
    }
    try {
      const response = await fetchFn(new URL(JWKS_PATH, deps.apiBase).toString());
      if (!response.ok) return staleFallback();
      const body: unknown = await response.json();
      const keys = parseJwksStrict(body);
      if (keys === null) {
        // §5.2 原子拒绝：畸形 200 不得覆盖最后一份已验证缓存。
        diag('JWKS_MALFORMED');
        return staleFallback();
      }
      jwksCache = { keys, fetchedAt: now() };
      return keys;
    } catch {
      return staleFallback();
    }
  }

  async function acquireInner(
    ref: RunStartRef,
  ): Promise<{ ok: true; intent: AcquiredIntent } | { ok: false }> {
    sweepVerified();

    let token: string | null;
    let userId: string | null;
    let installId: string | null;
    try {
      token = await deps.getAccessToken();
      userId = token === null ? null : await deps.getUserId();
    } catch {
      token = null;
      userId = null;
    }
    if (token === null || userId === null) {
      diag('AUTH_UNAVAILABLE');
      return { ok: false };
    }
    try {
      installId = await deps.getInstallId();
    } catch {
      installId = null;
    }
    if (installId === null) {
      diag('INSTALL_ID_UNAVAILABLE');
      return { ok: false };
    }

    // Value-free probe, before the ticket exists. An unavailable or unusable answer
    // means no digests at all: the run proceeds with the profile fields alone rather
    // than with a set nobody can vouch for.
    const reusableQuestionDigests = await readQuestionDigests(ref);

    let jws: string;
    try {
      const response = await bearerRequest(token, (bearer) =>
        fetchFn(
          new URL(`/api/v1/agent/missions/${encodeURIComponent(ref.missionId)}/execution-intents`, deps.apiBase).toString(),
          {
            method: 'POST',
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              missionRevision: ref.missionRevision,
              missionStepId: ref.missionStepId,
              extensionInstallId: installId,
              ...(reusableQuestionDigests.length === 0
                ? {}
                : { reusableQuestionDigests }),
            }),
          },
        ),
      );
      if (!response.ok) {
        diag('ISSUE_HTTP_FAILED');
        return { ok: false };
      }
      const body = (await response.json()) as { schemaVersion?: unknown; executionIntent?: unknown };
      // §1.1：unknown schemaVersion fail-closed——语义可能已破坏性变更。
      if (body?.schemaVersion !== 1 || typeof body.executionIntent !== 'string' || body.executionIntent === '') {
        diag('ISSUE_RESPONSE_MALFORMED');
        return { ok: false };
      }
      jws = body.executionIntent;
    } catch {
      diag('ISSUE_HTTP_FAILED');
      return { ok: false };
    }

    let keys = await fetchJwks(false);
    if (keys === null) {
      diag('JWKS_UNAVAILABLE');
      return { ok: false };
    }
    const verifyOnce = (trusted: readonly ExecutionIntentPublicJwk[]) =>
      verifyExecutionIntent({
        jws,
        keys: trusted,
        expectedIssuer: deps.expectedIssuer,
        expectedInstallId: installId,
        expectedSubject: userId,
        nowSeconds: now(),
      });
    let result = await verifyOnce(keys);
    if (!result.ok && result.code === 'INTENT_KID_UNKNOWN') {
      // key rotation 的正常路径：强刷一次 JWKS 再试；仍未知才拒。
      keys = await fetchJwks(true);
      if (keys === null) {
        diag('JWKS_UNAVAILABLE');
        return { ok: false };
      }
      result = await verifyOnce(keys);
    }
    if (!result.ok) {
      diag(result.code);
      return { ok: false };
    }
    // §5.4 切片 e4191043：JWS 的 missionStepId 指向签发时新建的 execution
    // step，**必然不等于**请求的 approval step id；missionRevision 同理为
    // R+1。本地只核 missionId 归属——step/revision 的权威绑定在服务端。
    if (result.claims.missionId !== ref.missionId) {
      diag('INTENT_REF_MISMATCH');
      return { ok: false };
    }

    verified.set(jws, { claims: result.claims, exp: result.claims.exp });
    return { ok: true, intent: { jws } };
  }

  async function readQuestionDigests(ref: RunStartRef): Promise<readonly string[]> {
    if (!deps.readReusableQuestionDigests) return [];
    let digests: readonly string[];
    try {
      digests = await deps.readReusableQuestionDigests(ref);
    } catch {
      return [];
    }
    const sorted = [...new Set(digests)].sort();
    // The server refuses a malformed or oversized list outright, and it is right to:
    // sending one would fail the whole issuance. Drop the probe instead, so a defective
    // probe costs the reuse, never the run.
    if (
      sorted.length === 0 ||
      sorted.length > EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS ||
      sorted.some((digest) => !/^sha256:[0-9a-f]{64}$/.test(digest))
    ) {
      return [];
    }
    return sorted;
  }

  async function claimInner(request: {
    intent: AcquiredIntent;
    actualOrigin: string;
    actualFieldKeys: readonly string[];
    actualQuestionKeys?: readonly string[];
    scanDigest: string;
  }): Promise<{ ok: true; grant: ExecutionGrant } | { ok: false; code: 'INTENT_REJECTED' | 'RESCAN_MISMATCH' }> {
    sweepVerified();
    const record = verified.get(request.intent.jws);
    if (!record) {
      diag('CLAIM_UNKNOWN_INTENT');
      return { ok: false, code: 'INTENT_REJECTED' };
    }
    const claims = record.claims;

    // §5.5 本地复核（第一道 fail-closed；服务端 §5.6 仍是权威）。
    if (request.actualOrigin !== claims.target.canonicalOrigin) {
      diag('CLAIM_LOCAL_ORIGIN_MISMATCH');
      return { ok: false, code: 'RESCAN_MISMATCH' };
    }
    // 已验签 claims 的 key 集合拆成两类：档案键与记忆答案键。拆不开 = 票据畸形。
    const partitioned = partitionExecutionIntentClaimKeys(claims.fieldKeys);
    if (!partitioned) {
      diag('CLAIM_INTENT_KEY_SET_MALFORMED');
      return { ok: false, code: 'INTENT_REJECTED' };
    }
    // v1 相等制（不是 subset）：批准字段消失或页面新增待写字段都停。
    if (!sameStringSet(request.actualFieldKeys, partitioned.profileKeys)) {
      diag('CLAIM_LOCAL_FIELDSET_MISMATCH');
      return { ok: false, code: 'RESCAN_MISMATCH' };
    }
    // 记忆键走**子集**制而不是相等制：页面上没被记住的题是常态，它们照旧进审阅
    // 面板，不该让整轮停。反过来，凭证点名的每一条记忆都必须在本页上仍能按同一
    // 身份找到——找不到就是页面变了，停，零写入。
    const pageQuestionKeys = new Set(request.actualQuestionKeys ?? []);
    if (partitioned.questionKeys.some((key) => !pageQuestionKeys.has(key))) {
      diag('CLAIM_LOCAL_QUESTION_SET_MISMATCH');
      return { ok: false, code: 'RESCAN_MISMATCH' };
    }
    const scanDigest = request.scanDigest;
    if (!/^sha256:[0-9a-f]{64}$/.test(scanDigest)) {
      diag('CLAIM_SCAN_DIGEST_MALFORMED');
      return { ok: false, code: 'INTENT_REJECTED' };
    }

    let token: string | null;
    try {
      token = await deps.getAccessToken();
    } catch {
      token = null;
    }
    if (token === null) {
      diag('AUTH_UNAVAILABLE');
      return { ok: false, code: 'INTENT_REJECTED' };
    }

    const wireRequest: ClaimExecutionIntentRequest = {
      executionIntent: request.intent.jws,
      extensionInstallId: claims.extensionInstallId,
      actualTarget: {
        // origin 已本地验证与当前页一致；pathRuleId/postingFingerprint 见
        // 文件头"已知缺口"——规则可下发前回显批准值，服务端 trusted job
        // resolver 仍做权威复核（§5.6.4），同 origin 换岗检测靠 scanDigest。
        canonicalOrigin: claims.target.canonicalOrigin,
        pathRuleId: claims.target.pathRuleId,
        postingFingerprint: claims.target.postingFingerprint,
      },
      // 服务端那一侧仍是**相等**制：这里送的就是凭证点名的那一套（档案键已本地
      // 验过与本页相等，记忆键已本地验过仍在本页上）。
      actualFieldKeys: [...partitioned.profileKeys, ...partitioned.questionKeys],
      scanDigest: scanDigest as ClaimExecutionIntentRequest['scanDigest'],
    };

    try {
      const response = await bearerRequest(token, (bearer) =>
        fetchFn(new URL('/api/v1/agent/execution-intents/claim', deps.apiBase).toString(), {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(wireRequest),
        }),
      );
      // 无论成败，这份 JWS 的本地记录就此作废：claim 是一次性的（§5.6.8），
      // 失败重试必须从 issue 重新走（服务端会开新 attempt/version）。
      verified.delete(request.intent.jws);

      if (!response.ok) {
        let code: unknown = null;
        try {
          code = ((await response.json()) as { code?: unknown })?.code;
        } catch {
          // body 不是 JSON 也照常拒绝——码留 null。
        }
        diag('CLAIM_HTTP_FAILED');
        if (typeof code === 'string' && RESCAN_MISMATCH_CODES.has(code)) {
          return { ok: false, code: 'RESCAN_MISMATCH' };
        }
        return { ok: false, code: 'INTENT_REJECTED' };
      }

      const body = (await response.json()) as { schemaVersion?: unknown; claim?: unknown };
      if (body?.schemaVersion !== 1) {
        diag('CLAIM_RESPONSE_MALFORMED');
        return { ok: false, code: 'INTENT_REJECTED' };
      }
      const view = body.claim as Record<string, unknown> | undefined;
      const lease = view?.['executionLease'];
      const leaseExpiresAt = view?.['leaseExpiresAt'];
      const grantedActions = view?.['allowedActions'];
      if (
        typeof view !== 'object' || view === null ||
        typeof lease !== 'string' || lease === '' ||
        typeof leaseExpiresAt !== 'string' ||
        !Array.isArray(grantedActions)
      ) {
        diag('CLAIM_RESPONSE_MALFORMED');
        return { ok: false, code: 'INTENT_REJECTED' };
      }
      const leaseExpiresAtSeconds = Math.floor(Date.parse(leaseExpiresAt) / 1000);
      if (!Number.isFinite(leaseExpiresAtSeconds)) {
        diag('CLAIM_RESPONSE_MALFORMED');
        return { ok: false, code: 'INTENT_REJECTED' };
      }
      // §5.6.7：服务端取交集后必须仍精确等于 JWS scope——响应动作面与
      // 验签 claims 不一致说明有一侧变了，fail-closed。
      if (!sameStringSet(grantedActions as string[], claims.allowedActions)) {
        diag('CLAIM_RESPONSE_MALFORMED');
        return { ok: false, code: 'INTENT_REJECTED' };
      }

      // jobIdentityHash v1 组成（代码定义，§1.2；对齐清单第 ⑤ 项）：
      // JCS({schemaVersion:1, ...已验签 target 六字段}) → sha256:<hex>。
      const jobIdentityHash = await sha256CanonicalJson({
        schemaVersion: 1,
        jobId: claims.target.jobId,
        sourcePlatform: claims.target.sourcePlatform,
        atsProvider: claims.target.atsProvider,
        canonicalOrigin: claims.target.canonicalOrigin,
        pathRuleId: claims.target.pathRuleId,
        postingFingerprint: claims.target.postingFingerprint,
      });

      return {
        ok: true,
        grant: {
          missionId: claims.missionId,
          missionStepId: claims.missionStepId,
          // 授权范围以验签过的 claims 为准（claim 成功 = 服务端确认同一集合）。
          fieldKeys: partitioned.profileKeys,
          questionKeys: partitioned.questionKeys,
          allowedActions: claims.allowedActions,
          executionLease: lease,
          leaseExpiresAt: leaseExpiresAtSeconds,
          intentVersion: claims.intentVersion,
          planDigest: claims.planDigest,
          jobIdentityHash,
          fieldSchemaVersion: claims.fieldSchemaVersion,
          profileSnapshot: {
            revision: claims.profile.revision,
            deletionEpoch: claims.profile.deletionEpoch,
            snapshotDigest: claims.profile.snapshotDigest,
          },
        },
      };
    } catch {
      verified.delete(request.intent.jws);
      diag('CLAIM_HTTP_FAILED');
      return { ok: false, code: 'INTENT_REJECTED' };
    }
  }

  // 最外层兜底：任何意外异常都收敛为稳定码 + 拒绝，绝不向协调器裸抛
  // （协调器侧另有自己的兜底，两层都在才叫 fail-closed）。
  return {
    getVerifiedTargetOrigin(intent) {
      return verified.get(intent.jws)?.claims.target.canonicalOrigin ?? null;
    },
    getVerifiedRuntimeTarget(intent) {
      const claims = verified.get(intent.jws)?.claims;
      if (!claims) return null;
      return Object.freeze({
        canonicalOrigin: claims.target.canonicalOrigin,
        atsProvider: claims.target.atsProvider,
        pathRuleId: claims.target.pathRuleId,
        policyVersion: claims.policyVersion,
        killSwitchVersion: claims.killSwitchVersion,
        automationLevel: claims.automationLevel,
        allowedActions: claims.allowedActions,
        // bundle 的 allowedFieldKeys 围栏只认十一个档案键，且这份 wire 不变——
        // 把记忆键递进去只会让每一次合法票据都被判成 INTENT_MISMATCH。
        fieldKeys: partitionExecutionIntentClaimKeys(claims.fieldKeys)?.profileKeys ?? [],
      });
    },
    acquirer: {
      async acquire(ref) {
        try {
          return await acquireInner(ref);
        } catch {
          diag('CLIENT_INTERNAL_ERROR');
          return { ok: false };
        }
      },
    },
    claimer: {
      async claim(request) {
        try {
          return await claimInner(request);
        } catch {
          diag('CLIENT_INTERNAL_ERROR');
          return { ok: false, code: 'INTENT_REJECTED' };
        }
      },
    },
  };
}
