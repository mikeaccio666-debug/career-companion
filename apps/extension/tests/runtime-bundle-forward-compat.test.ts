import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';
import {
  canonicalizeExecutionRuntimeJsonV1,
  type ExecutionRuntimeBundleV1,
  type ExecutionRuntimeBundleWithoutVersionV1,
} from '@edaix/contracts';
import {
  createBackgroundExecutionRuntimeAuthority,
  resolveStoredExecutionRuntimeAuthority,
  type VerifiedIntentRuntimeTarget,
} from '../lib/executionRuntimeAuthority';
import { createExecutionRuntimeBundleClient } from '../lib/executionRuntimeBundleClient';

/**
 * 后端先发、商店包还没跟上：运行时包多了这一版不认识的**加法**（2026-09-28）。
 *
 * 这一组走真实的契约解码器与真实的规范正文校验（不是测试替身）：运行时包是所有填写的
 * 总闸，旧包读不懂它，每一家、每一条路（手势、翻页、提交、代填、mission）一起停。
 * 在此之前顶层、`compatibility`、`policy` 任何一处多一个键，旧包就整包拒收。
 *
 * 钉的是三件事：
 *  · 多出来的成员不拖垮整包，也**不进本地策略**（能力位、厂商位按本地已知集合重建）；
 *  · 它们仍在摘要与规范正文里——缓存里的原文被改一个字，内容脚本那一侧照旧拒；
 *  · 这一版不认识的自动化级别：mission 路按「超出上限」拒，不猜它比哪一档高。
 */

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const TARGET: VerifiedIntentRuntimeTarget = {
  canonicalOrigin: 'https://careers.acme.test',
  atsProvider: 'GREENHOUSE',
  pathRuleId: 'greenhouse-application-v1',
  policyVersion: 'policy-v1',
  killSwitchVersion: '7',
  automationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT',
  allowedActions: ['FILL'],
  fieldKeys: ['email', 'firstName', 'lastName'],
};

function digest(value: unknown): `sha256:${string}` {
  const canonical = canonicalizeExecutionRuntimeJsonV1(value);
  if (!canonical.ok) throw new Error(canonical.code);
  return `sha256:${createHash('sha256').update(canonical.value).digest('hex')}`;
}

function sealed(withoutVersion: Record<string, unknown>): ExecutionRuntimeBundleV1 {
  const runtimeBundleVersion = `rb1_${digest(withoutVersion).slice('sha256:'.length)}`;
  return { runtimeBundleVersion, ...withoutVersion } as unknown as ExecutionRuntimeBundleV1;
}

function baseWithoutVersion(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    releaseRevision: '7',
    issuedAt: '2026-08-24T11:50:00.000Z',
    notBefore: '2026-08-24T11:51:00.000Z',
    freshUntil: '2026-08-24T12:10:00.000Z',
    notAfter: '2026-08-24T13:00:00.000Z',
    compatibility: { minExtensionVersion: '0.0.0', rulesSchemaVersion: 2, contractVersion: 1 },
    policy: {
      version: 'policy-v1',
      killSwitchVersion: '7',
      enabled: true,
      automationLevelCeiling: 'L1_FILL_STOP_BEFORE_SUBMIT',
      allowedActions: ['FILL'],
      allowedFieldKeys: ['email', 'firstName', 'lastName'],
      vendors: { greenhouse: true, lever: true, ashby: true, workable: true },
      capabilities: { 'set-text': true, 'set-select': true },
      minConfidence: 0.7,
      inferredRequiresConfirm: true,
      deniedHostSuffixes: [],
    },
    rules: APPLY_RULES_RUNTIME_RELEASE_V1 as unknown as ExecutionRuntimeBundleWithoutVersionV1['rules'],
  };
}

/** 后端下一版会发的那种：每一层都多一点这个包不认识的东西。 */
function additiveBundle(policyPatch: Record<string, unknown> = {}): ExecutionRuntimeBundleV1 {
  const base = baseWithoutVersion();
  const policy = base['policy'] as Record<string, unknown>;
  return sealed({
    ...base,
    recommendedExtensionVersion: '1.2.0',
    compatibility: { ...(base['compatibility'] as object), maxTestedExtensionVersion: '9.9.9' },
    policy: {
      ...policy,
      rateLimits: { perMinute: 5 },
      allowedActions: ['FILL', 'REHEARSE'],
      allowedFieldKeys: ['email', 'favoriteColor', 'firstName', 'lastName'],
      capabilities: { ...(policy['capabilities'] as object), 'set-future-thing': true },
      vendors: { ...(policy['vendors'] as object), paradox: true },
      ...policyPatch,
    },
  });
}

function canonicalBody(value: ExecutionRuntimeBundleV1): string {
  const canonical = canonicalizeExecutionRuntimeJsonV1(value);
  if (!canonical.ok) throw new Error(canonical.code);
  return canonical.value;
}

/** 真实的客户端：真实的解码器、规范正文校验、ETag 校验；网络是一个只回这一份的替身。 */
function networkClient(value: ExecutionRuntimeBundleV1) {
  const writes: Array<{ etag: string; rawBody: string }> = [];
  const client = createExecutionRuntimeBundleClient({
    apiBase: 'https://api.example.test',
    store: {
      read: async () => undefined,
      write: async (etag, _bundle, rawBody) => {
        writes.push({ etag, rawBody });
      },
    },
    extensionVersion: () => '1.0.0',
    now: () => NOW,
    fetchFn: (async () => new Response(canonicalBody(value), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: `"${value.runtimeBundleVersion}"` },
    })) as typeof fetch,
  });
  return { client, writes };
}

function stored(value: ExecutionRuntimeBundleV1, rawBody = canonicalBody(value)) {
  return {
    schemaVersion: 1,
    etag: `"${value.runtimeBundleVersion}"`,
    runtimeBundleVersion: value.runtimeBundleVersion,
    releaseRevision: value.releaseRevision,
    rawBody,
  };
}

describe('运行时包多了这一版不认识的成员：整条链照常', () => {
  it('客户端收下、落盘的是原文；worker 授权、内容脚本二次校验都过', async () => {
    const value = additiveBundle();
    const { client, writes } = networkClient(value);
    const refreshed = await client.refresh();
    expect(refreshed, refreshed.ok ? '' : refreshed.code).toMatchObject({ ok: true, source: 'NETWORK' });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.rawBody).toBe(canonicalBody(value));

    const authorized = await createBackgroundExecutionRuntimeAuthority({ client }).authorize(TARGET);
    expect(authorized.ok, authorized.ok ? '' : authorized.code).toBe(true);
    if (!authorized.ok) return;

    const resolved = await resolveStoredExecutionRuntimeAuthority({
      stored: stored(value),
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    expect(resolved.ok, resolved.ok ? '' : resolved.code).toBe(true);
    if (!resolved.ok) return;
    // 多出来的能力位与厂商位进不了本地策略：本地策略只按这一版认得的键集重建。
    expect(Object.keys(resolved.value.policy.capabilities)).not.toContain('set-future-thing');
    expect(Object.keys(resolved.value.policy.vendors)).not.toContain('paradox');
    expect(resolved.value.policy.capabilities['set-text']).toBe(true);
  });

  it('多出来的成员也受摘要保护：缓存原文里改一个字，内容脚本那一侧拒', async () => {
    const value = additiveBundle();
    const { client } = networkClient(value);
    const authorized = await createBackgroundExecutionRuntimeAuthority({ client }).authorize(TARGET);
    if (!authorized.ok) throw new Error(authorized.code);
    const tampered = canonicalBody(value).replace('"perMinute":5', '"perMinute":500');
    expect(tampered).not.toBe(canonicalBody(value));
    const resolved = await resolveStoredExecutionRuntimeAuthority({
      stored: stored(value, tampered),
      authorization: authorized.value,
      nowMs: NOW,
      extensionVersion: '1.0.0',
    });
    expect(resolved).toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_UNAVAILABLE' });
  });

  it('这一版不认识的自动化级别：包照常收下，mission 路按超出上限拒', async () => {
    const value = additiveBundle({ automationLevelCeiling: 'L4_FUTURE_LEVEL' });
    const { client } = networkClient(value);
    expect((await client.refresh()).ok).toBe(true);
    await expect(createBackgroundExecutionRuntimeAuthority({ client }).authorize(TARGET)).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_AUTHORITY_INTENT_MISMATCH',
    });
  });

  it('只读档（L0）多了这一版不认识的动作与能力位：只读识别照常；认得的能力位一开就不算只读档', async () => {
    const discovery = additiveBundle({
      automationLevelCeiling: 'L0_PREVIEW_ONLY',
      allowedActions: ['REHEARSE'],
      capabilities: { 'set-text': false, 'set-future-thing': true },
    });
    const discoveryClient = networkClient(discovery).client;
    const allowed = await createBackgroundExecutionRuntimeAuthority({ client: discoveryClient })
      .authorizeDiscovery({ atsProvider: TARGET.atsProvider, pathRuleId: TARGET.pathRuleId });
    expect(allowed.ok, allowed.ok ? '' : allowed.code).toBe(true);

    const notReadOnly = additiveBundle({
      automationLevelCeiling: 'L0_PREVIEW_ONLY',
      allowedActions: ['REHEARSE'],
      capabilities: { 'set-text': true },
    });
    await expect(
      createBackgroundExecutionRuntimeAuthority({ client: networkClient(notReadOnly).client })
        .authorizeDiscovery({ atsProvider: TARGET.atsProvider, pathRuleId: TARGET.pathRuleId }),
    ).resolves.toEqual({ ok: false, code: 'RUNTIME_AUTHORITY_POLICY_DISABLED' });
  });
});
