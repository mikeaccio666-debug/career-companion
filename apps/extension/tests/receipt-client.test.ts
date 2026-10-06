import { describe, expect, it } from 'vitest';

import type { ExecutionGrant } from '@edaix/agent-channel';
import type { RunReceiptSummary } from '@edaix/contracts/draft';
import { createReceiptUploader, deriveReceiptOutcome } from '../lib/receiptClient';

/**
 * 刀七特征测试：§5.7 回执上行——wire 形状、码表映射、subset 过滤、
 * Data-L1 绊线、fail-closed 分支。
 */

const GRANT: ExecutionGrant = {
  missionId: 'm_1',
  missionStepId: 'ms_1',
  fieldKeys: ['email', 'firstName', 'lastName'],
  allowedActions: ['FILL'],
  executionLease: 'opaque-lease-1',
  leaseExpiresAt: 2_000,
  intentVersion: 3,
  planDigest: `sha256:${'b'.repeat(64)}`,
  jobIdentityHash: `sha256:${'a'.repeat(64)}`,
  fieldSchemaVersion: 1,
  profileSnapshot: {
    revision: '7',
    deletionEpoch: '0',
    snapshotDigest: `sha256:${'c'.repeat(64)}`,
  },
};

const RECEIPT: RunReceiptSummary = {
  runId: 'run_1',
  jobId: '/acme/jobs/1',
  missionId: 'm_1',
  missionStepId: 'ms_1',
  filled: 1,
  total: 3,
  outcomes: [
    { key: 'email', ok: true },
    { key: 'firstName', ok: false, reason: 'NO_VALUE' },
    { key: 'lastName', ok: false, reason: 'HONEYPOT' }, // 映射表外的码 → 兜底
    { key: 'phone', ok: false, reason: 'LEASE_INVALID' }, // grant 之外——须滤掉
  ],
  submission: 'NOT_SUBMITTED',
  finishedAt: 1_800_000_100,
};

function harness(options: { token?: string | null; status?: number; throwNetwork?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const diags: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    if (options.throwNetwork) throw new Error('down');
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    const status = options.status ?? 201;
    return { ok: status < 400, status, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const uploader = createReceiptUploader({
    apiBase: 'https://api.test.invalid',
    getAccessToken: async () => (options.token === undefined ? 'tok_1' : options.token),
    fetchFn,
    newReceiptId: () => 'receipt-uuid-1',
    onDiagnostic: (code) => diags.push(code),
  });
  return { uploader, calls, diags };
}

describe('回执上行（§5.7）', () => {
  it('wire 形状：绑定值齐全、RFC3339 时间、码表映射、grant 外字段滤掉', async () => {
    const h = harness();
    await h.uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1_800_000_000, cancelled: false });

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toContain('/api/v1/agent/missions/m_1/receipts');
    expect(call.headers['authorization']).toBe('Bearer tok_1');
    expect(call.body).toEqual({
      clientReceiptId: 'receipt-uuid-1',
      executionLease: 'opaque-lease-1',
      missionStepId: 'ms_1',
      intentVersion: 3,
      jobIdentityHash: GRANT.jobIdentityHash,
      planDigest: GRANT.planDigest,
      outcome: 'FILL_PARTIAL',
      fieldResults: [
        { fieldKey: 'email', outcomeCode: 'FILLED' },
        { fieldKey: 'firstName', outcomeCode: 'NEEDS_USER_INPUT' },
        // 没见过的 kernel 码 → 契约兜底码，不猜语义。
        { fieldKey: 'lastName', outcomeCode: 'FAILED', reasonCode: 'UNKNOWN_SAFE_FAILURE' },
      ],
      executionStartedAt: new Date(1_800_000_000 * 1000).toISOString(),
      executionFinishedAt: new Date(1_800_000_100 * 1000).toISOString(),
    });
    expect(h.diags).toEqual([]);
  });

  it('Data-L1 绊线：wire 序列化后无值类键与字段值', async () => {
    const h = harness();
    await h.uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1_800_000_000, cancelled: false });
    const wire = JSON.stringify(h.calls[0]!.body);
    expect(wire).not.toMatch(/"value"|"label"|"dom"|"screenshot"|"rawError"|"pageUrl"|"cookie"|"otp"/);
  });

  it('取消收口：整单 CANCELLED，未写字段的 ABORTED 报 USER_CANCELLED，已写照实 FILLED', async () => {
    const h = harness();
    await h.uploader.upload({
      grant: GRANT,
      receipt: {
        ...RECEIPT,
        outcomes: [
          { key: 'email', ok: true },
          { key: 'firstName', ok: false, reason: 'ABORTED' },
          { key: 'lastName', ok: false, reason: 'ABORTED' },
        ],
      },
      startedAt: 1_800_000_000,
      cancelled: true,
    });
    expect(h.calls[0]!.body).toMatchObject({
      outcome: 'CANCELLED',
      fieldResults: [
        { fieldKey: 'email', outcomeCode: 'FILLED' },
        { fieldKey: 'firstName', outcomeCode: 'FAILED', reasonCode: 'USER_CANCELLED' },
        { fieldKey: 'lastName', outcomeCode: 'FAILED', reasonCode: 'USER_CANCELLED' },
      ],
    });
  });

  it('4xx（服务端不认）与网络/5xx 分码——digest 组成失配必须可被发现', async () => {
    const rejected = harness({ status: 409 });
    await rejected.uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1, cancelled: false });
    expect(rejected.diags).toEqual(['RECEIPT_REJECTED']);
  });

  it('未登录 → 不上传只出诊断码；非 2xx / 网络抛错 → RECEIPT_UPLOAD_FAILED 不外逸', async () => {
    const noAuth = harness({ token: null });
    await noAuth.uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1, cancelled: false });
    expect(noAuth.calls).toHaveLength(0);
    expect(noAuth.diags).toEqual(['RECEIPT_AUTH_UNAVAILABLE']);

    const http500 = harness({ status: 500 });
    await http500.uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1, cancelled: false });
    expect(http500.diags).toEqual(['RECEIPT_UPLOAD_FAILED']);

    const down = harness({ throwNetwork: true });
    await down.uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1, cancelled: false });
    expect(down.diags).toEqual(['RECEIPT_UPLOAD_FAILED']);
  });

  it('401 → 强制换新一次并重放（clientReceiptId 幂等，重放安全）', async () => {
    let hits = 0;
    const bearers: string[] = [];
    const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
      hits += 1;
      bearers.push(((init?.headers ?? {}) as Record<string, string>)['authorization'] ?? '');
      if (hits === 1) return { ok: false, status: 401, json: async () => ({ code: 'LOGIN_REQUIRED' }) };
      return { ok: true, status: 201, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const diags: string[] = [];
    const uploader = createReceiptUploader({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => 'tok_stale',
      refreshAccessToken: async () => 'tok_fresh',
      fetchFn,
      newReceiptId: () => 'receipt-uuid-1',
      onDiagnostic: (code) => diags.push(code),
    });
    await uploader.upload({ grant: GRANT, receipt: RECEIPT, startedAt: 1, cancelled: false });
    expect(bearers).toEqual(['Bearer tok_stale', 'Bearer tok_fresh']);
    expect(diags).toEqual([]); // 重放成功，不出失败码
  });

  it('grant 缺绑定值（程序性错误）→ 不上传，RECEIPT_BINDING_MISSING', async () => {
    const h = harness();
    await h.uploader.upload({
      grant: { ...GRANT, jobIdentityHash: '' },
      receipt: RECEIPT,
      startedAt: 1,
      cancelled: false,
    });
    expect(h.calls).toHaveLength(0);
    expect(h.diags).toEqual(['RECEIPT_BINDING_MISSING']);
  });
});

describe('deriveReceiptOutcome（整单结论）', () => {
  const filled = { fieldKey: 'a', outcomeCode: 'FILLED' } as const;
  const needs = { fieldKey: 'b', outcomeCode: 'NEEDS_USER_INPUT' } as const;
  const failed = { fieldKey: 'c', outcomeCode: 'FAILED' } as const;

  it('分母 = claimed 数：覆盖不全不许报全部成功；取消一律 CANCELLED', () => {
    expect(deriveReceiptOutcome([filled, filled], 2, false)).toBe('FILL_SUCCEEDED');
    // 批准 3 个、结果只有 2 个 FILLED（有字段消失/被计划跳过）→ 只算部分。
    expect(deriveReceiptOutcome([filled, filled], 3, false)).toBe('FILL_PARTIAL');
    expect(deriveReceiptOutcome([filled, failed], 2, false)).toBe('FILL_PARTIAL');
    expect(deriveReceiptOutcome([needs, failed], 2, false)).toBe('USER_ACTION_REQUIRED');
    // 全部字段已被用户预填（NOT_EMPTY→NEEDS_USER_INPUT）→ 等用户核对，不是失败。
    expect(deriveReceiptOutcome([needs, needs], 2, false)).toBe('USER_ACTION_REQUIRED');
    expect(deriveReceiptOutcome([failed], 1, false)).toBe('FAILED');
    expect(deriveReceiptOutcome([], 1, false)).toBe('FAILED');
    expect(deriveReceiptOutcome([filled, filled], 2, true)).toBe('CANCELLED');
  });
});
