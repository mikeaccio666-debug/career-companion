// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBundledApplyPolicy } from '@edaix/apply-kernel/policy';
import type { ExecutionGrant } from '@edaix/agent-channel';
import type { BridgeEvent, BridgePortLike } from '../lib/bridgeProtocol';
import {
  handleKernelBridgePort,
  invalidateRetainedContentScan,
  resetContentBridgeStateForTests,
} from '../lib/contentBridge';
import { scanCurrentPage, type KernelPageScan } from '../lib/kernelScanner';
import { fillFromGrant, type KernelFillInput } from '../lib/kernelFiller';
import type { SubmissionArmDescriptor } from '../lib/submissionBoundaryProtocol';
import type { RuntimeExecutionAuthorization } from '../lib/executionRuntimeAuthority';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * 刀六b 特征测试：桥的内容端——真扫描、真执行链，桥上只走 wire-safe 帧。
 */

const GH_LOC = {
  hostname: 'job-boards.greenhouse.io',
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/acme/jobs/12345',
};
const RUNTIME_AUTHORIZATION: RuntimeExecutionAuthorization = {
  schemaVersion: 1,
  purpose: 'EXECUTION',
  runtimeBundleVersion: `rb1_${'1'.repeat(64)}`,
  releaseRevision: '7',
  policyVersion: 'policy-v1',
  rulesReleaseVersion: 'rules-v1',
  rulesReleaseDigest: `sha256:${'2'.repeat(64)}`,
  atsProvider: 'GREENHOUSE',
  pathRuleId: 'greenhouse-application-v1',
  vendor: 'greenhouse',
  rulesetVersion: 'greenhouse-rules-v1',
  rulesetDigest: `sha256:${'3'.repeat(64)}`,
};
const DISCOVERY_AUTHORIZATION = {
  ...RUNTIME_AUTHORIZATION,
  purpose: 'DISCOVERY',
} as const satisfies RuntimeExecutionAuthorization;
const CURRENT_SCAN_FENCE = {
  isCurrentScanTarget: (scan: { canonicalOrigin: string; jobId: string }) =>
    scan.canonicalOrigin === GH_LOC.origin && scan.jobId === GH_LOC.pathname,
  isScanFresh: () => true,
  revalidateScan: async <T>(scan: T) => ({
    scan,
    activate: () => true,
    dispose: () => {},
  }),
};

function mountGreenhouseForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="last_name">Last name*</label>
      <input id="last_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
    </form>`;
}

function fakePort() {
  const sent: BridgeEvent[] = [];
  const messageHandlers: Array<(m: unknown) => void> = [];
  const disconnectHandlers: Array<() => void> = [];
  const port: BridgePortLike = {
    postMessage: (m) => sent.push(m as BridgeEvent),
    onMessage: { addListener: (h) => messageHandlers.push(h) },
    onDisconnect: { addListener: (h) => disconnectHandlers.push(h) },
    disconnect: () => disconnectHandlers.forEach((h) => h()),
  };
  return {
    port,
    sent,
    deliver: (m: unknown) => messageHandlers.forEach((h) => h(m)),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const GRANT = (keys: readonly string[]): ExecutionGrant => ({
  missionId: 'm_1',
  missionStepId: 'ms_1',
  fieldKeys: keys,
  allowedActions: ['FILL'],
  executionLease: 'lease_test_1',
  leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
  intentVersion: 1,
  planDigest: `sha256:${'b'.repeat(64)}`,
  jobIdentityHash: `sha256:${'a'.repeat(64)}`,
  fieldSchemaVersion: 1,
  profileSnapshot: {
    revision: '7',
    deletionEpoch: '0',
    snapshotDigest: `sha256:${'c'.repeat(64)}`,
  },
});

function harness() {
  const h = fakePort();
  handleKernelBridgePort(h.port, {
    ...CURRENT_SCAN_FENCE,
    scan: async () => (await scanCurrentPage(document, GH_LOC)).scan,
    fill: (input) => fillFromGrant({ ...input, policy: createBundledApplyPolicy(Date.now()) }),
    armSubmission: () => true,
  });
  return h;
}

const BLOCKED_ARM: SubmissionArmDescriptor = { mode: 'BLOCKED' };

beforeEach(() => {
  resetContentBridgeStateForTests();
  document.body.innerHTML = '';
});

describe('内容端桥（真内核）', () => {
  it('projection-only discovery never leaves a descriptor usable by fill or submission', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    const fill = vi.fn().mockResolvedValue([]);
    const armSubmission = vi.fn().mockReturnValue(true);
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      discover: async (runtime) => {
        const scan = (await scanCurrentPage(document, GH_LOC)).scan;
        return scan ? { ...scan, runtimeAuthorization: runtime } : null;
      },
      scan: async () => null,
      fill,
      armSubmission,
    });

    h.deliver({
      kind: 'bridge/discovery-scan',
      requestId: 'discover-1',
      runtime: DISCOVERY_AUTHORIZATION,
    });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/discovery-result'));
    const discovery = h.sent.find((event) =>
      event.kind === 'bridge/discovery-result') as Extract<
        BridgeEvent,
        { kind: 'bridge/discovery-result' }
      >;
    expect(discovery.scan?.fieldKeys).toEqual(['email', 'firstName', 'lastName']);

    h.deliver({
      kind: 'bridge/submission-arm',
      requestId: 'discover-arm',
      scanDigest: discovery.scan!.scanDigest,
      descriptor: BLOCKED_ARM,
    });
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'discover-fill',
      grant: GRANT(discovery.scan!.fieldKeys),
      scanDigest: discovery.scan!.scanDigest,
      profile: { firstName: 'must-not-write' },
      runtime: RUNTIME_AUTHORIZATION,
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'discover-fill'));

    expect(h.sent).toContainEqual({
      kind: 'bridge/submission-arm-result',
      requestId: 'discover-arm',
      accepted: false,
    });
    const fillResult = h.sent.find((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'discover-fill') as Extract<
        BridgeEvent,
        { kind: 'bridge/fill-result' }
      >;
    expect(fillResult.outcomes.every((outcome) =>
      !outcome.ok && outcome.reason === 'DETACHED')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('');
    expect(fill).not.toHaveBeenCalled();
    expect(armSubmission).not.toHaveBeenCalled();
  });

  it('rebuilds a supplied resume as an in-memory File for the kernel and drops one whose size or runtime binding is off', async () => {
    mountGreenhouseForm();
    document.querySelector('form')!.insertAdjacentHTML(
      'beforeend',
      '<label for="resume">Resume/CV*</label><input id="resume" name="resume" type="file" required />',
    );
    for (const element of document.querySelectorAll<HTMLInputElement>('input')) {
      element.getBoundingClientRect = () =>
        ({ width: 240, height: 32, top: 100, left: 20, right: 260, bottom: 132, x: 20, y: 100 }) as DOMRect;
    }
    const h = fakePort();
    const received: KernelFillInput[] = [];
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async (runtime) => {
        const scan = (await scanCurrentPage(document, GH_LOC)).scan;
        return scan ? { ...scan, runtimeAuthorization: runtime } : null;
      },
      fill: (input) => {
        received.push(input);
        return fillFromGrant({ ...input, policy: createBundledApplyPolicy(Date.now()) });
      },
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'resume-scan', runtime: RUNTIME_AUTHORIZATION });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/scan-result'));
    const scanEvent = h.sent.find((event) => event.kind === 'bridge/scan-result') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;
    const grant = GRANT([...scanEvent.scan!.fieldKeys, 'resumeFile']);
    const resume = {
      fileName: 'ada-resume.pdf',
      sha256: `sha256:${'d'.repeat(64)}`,
      size: 8,
      bytesBase64: btoa('%PDF-1.4'),
    };

    h.deliver({
      kind: 'bridge/fill',
      requestId: 'resume-fill',
      grant,
      scanDigest: scanEvent.scan!.scanDigest,
      profile: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      runtime: RUNTIME_AUTHORIZATION,
      resume,
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'resume-fill'));
    const supplied = received[0]?.resume;
    expect(supplied?.fileName).toBe('ada-resume.pdf');
    expect(supplied?.targetVerified).toBe(true);
    const file = await supplied!.resolve();
    expect([file?.name, file?.size, file?.type]).toEqual(['ada-resume.pdf', 8, 'application/pdf']);
    expect(document.querySelector<HTMLInputElement>('#resume')!.files?.[0]?.name).toBe('ada-resume.pdf');
    const result = h.sent.find((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'resume-fill') as Extract<
        BridgeEvent,
        { kind: 'bridge/fill-result' }
      >;
    expect(result.outcomes).toContainEqual({ key: 'resumeFile', ok: true });

    h.deliver({ kind: 'bridge/scan', requestId: 'resume-scan-2', runtime: RUNTIME_AUTHORIZATION });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'resume-scan-2'));
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'resume-fill-short',
      grant,
      scanDigest: scanEvent.scan!.scanDigest,
      profile: { firstName: 'Ada' },
      runtime: RUNTIME_AUTHORIZATION,
      resume: { ...resume, size: 9 },
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'resume-fill-short'));
    expect(received[1]).toBeDefined();
    expect(received[1]).not.toHaveProperty('resume');

    const fillCalls = received.length;
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'resume-fill-unbound',
      grant,
      scanDigest: scanEvent.scan!.scanDigest,
      profile: { firstName: 'Ada' },
      resume,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(fillCalls);
    expect(h.sent.some((event) => event.requestId === 'resume-fill-unbound')).toBe(false);
  });

  it('runtime-bound scan cannot be filled without the exact same bundle/ruleset binding', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    let fillCalls = 0;
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async (runtime) => {
        if (runtime !== RUNTIME_AUTHORIZATION) return null;
        const scan = (await scanCurrentPage(document, GH_LOC)).scan;
        return scan ? { ...scan, runtimeAuthorization: runtime } : null;
      },
      fill: async () => {
        fillCalls += 1;
        return [];
      },
    });
    h.deliver({
      kind: 'bridge/scan',
      requestId: 'runtime-scan',
      runtime: RUNTIME_AUTHORIZATION,
    });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/scan-result'));
    const scanEvent = h.sent.find((event) => event.kind === 'bridge/scan-result') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'runtime-fill-without-binding',
      grant: GRANT(scanEvent.scan!.fieldKeys),
      scanDigest: scanEvent.scan!.scanDigest,
      profile: { firstName: 'Ada' },
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' &&
      event.requestId === 'runtime-fill-without-binding'));
    const result = h.sent.find((event) =>
      event.kind === 'bridge/fill-result' &&
      event.requestId === 'runtime-fill-without-binding') as Extract<
      BridgeEvent,
      { kind: 'bridge/fill-result' }
    >;
    expect(result.outcomes.every((outcome) =>
      !outcome.ok && outcome.reason === 'POLICY_DISABLED')).toBe(true);
    expect(fillCalls).toBe(0);
  });

  it('在任何 SUBMIT fill 前同步安装提交阻断闸并回 ack', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    const armed: Array<{ descriptor: SubmissionArmDescriptor; digest: string }> = [];
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => (await scanCurrentPage(document, GH_LOC)).scan,
      fill: (input) => fillFromGrant({ ...input, policy: createBundledApplyPolicy(Date.now()) }),
      armSubmission: (descriptor, scan) => {
        armed.push({ descriptor, digest: scan.scanDigest });
        return true;
      },
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'scan-1' });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/scan-result'));
    const scan = h.sent.find((event) => event.kind === 'bridge/scan-result') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;
    const digest = scan.scan!.scanDigest;
    h.deliver({
      kind: 'bridge/submission-arm',
      requestId: 'arm-stale',
      scanDigest: `sha256:${'0'.repeat(64)}`,
      descriptor: BLOCKED_ARM,
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/submission-arm-result' && event.requestId === 'arm-stale'));
    expect(armed).toEqual([]);
    expect(h.sent).toContainEqual({
      kind: 'bridge/submission-arm-result', requestId: 'arm-stale', accepted: false,
    });

    h.deliver({
      kind: 'bridge/submission-arm',
      requestId: 'arm-1',
      scanDigest: digest,
      descriptor: BLOCKED_ARM,
    });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/submission-arm-result'));
    expect(armed).toEqual([{ descriptor: BLOCKED_ARM, digest }]);
    expect(h.sent).toContainEqual({
      kind: 'bridge/submission-arm-result', requestId: 'arm-1', accepted: true,
    });
  });

  it('submission arm 帧出现 CAP-AF-064/Data-L1 额外字段时整帧拒绝', async () => {
    const h = fakePort();
    const armed: SubmissionArmDescriptor[] = [];
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => (await scanCurrentPage(document, GH_LOC)).scan,
      fill: (input) => fillFromGrant({ ...input, policy: createBundledApplyPolicy(Date.now()) }),
      armSubmission: (descriptor) => {
        armed.push(descriptor);
        return true;
      },
    });
    h.deliver({
      kind: 'bridge/submission-arm',
      requestId: 'arm-bad',
      scanDigest: `sha256:${'0'.repeat(64)}`,
      descriptor: BLOCKED_ARM,
      screenshot: 'data:image/png;base64,secret',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(armed).toEqual([]);
    expect(h.sent).toEqual([]);
  });
  it('scan 往返：返回 wire-safe 摘要（无 descriptor、无值），descriptor 留在本地', async () => {
    mountGreenhouseForm();
    document.querySelector<HTMLInputElement>('#email')!.value = 'pre@existing.test';
    const h = harness();
    h.deliver({ kind: 'bridge/scan', requestId: 'r1' });
    await waitUntil(() => h.sent.length > 0);

    const result = h.sent[0]!;
    expect(result).toMatchObject({
      kind: 'bridge/scan-result',
      requestId: 'r1',
      scan: { canonicalOrigin: GH_LOC.origin, jobId: '/acme/jobs/12345' },
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toMatch(/descriptor|pre@existing|First name/);
  });

  it('fill 用同一次扫描的 descriptor：DOM 真写入 + 逐条流式上报 + 终帧收口', async () => {
    mountGreenhouseForm();
    const h = harness();
    h.deliver({ kind: 'bridge/scan', requestId: 'r1' });
    await waitUntil(() => h.sent.length > 0);
    const keys = (h.sent[0] as { scan: { fieldKeys: readonly string[] } }).scan.fieldKeys;

    const digest = (h.sent[0] as { scan: { scanDigest: string } }).scan.scanDigest;
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'r2',
      grant: GRANT(keys),
      scanDigest: digest,
      profile: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
    });
    await waitUntil(() => h.sent.some((e) => e.kind === 'bridge/fill-result'));

    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('Ada');
    expect(document.querySelector<HTMLInputElement>('#email')!.value).toBe('ada@example.test');

    const outcomes = h.sent.filter((e) => e.kind === 'bridge/fill-outcome');
    expect(outcomes).toHaveLength(3);
    const final = h.sent.find((e) => e.kind === 'bridge/fill-result')!;
    expect((final as { outcomes: readonly { ok: boolean }[] }).outcomes.every((o) => o.ok)).toBe(true);
    // Data-L1：上行帧里没有任何档案值/标签文案（下行 profile 是扩展内部必要流动）。
    expect(JSON.stringify(h.sent)).not.toMatch(/Ada|Lovelace|ada@example\.test|First name/);
  });

  it('没有在册扫描就来 fill → 全字段 DETACHED，一个节点都不碰', async () => {
    mountGreenhouseForm();
    const h = harness();
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'r1',
      grant: GRANT(['email', 'firstName', 'lastName']),
      scanDigest: `sha256:${'f'.repeat(64)}`,
      profile: { firstName: 'Ada' },
    });
    await waitUntil(() => h.sent.some((e) => e.kind === 'bridge/fill-result'));
    const final = h.sent.find((e) => e.kind === 'bridge/fill-result')!;
    const outcomes = (final as { outcomes: readonly { ok: boolean; reason?: string }[] }).outcomes;
    expect(outcomes.every((o) => !o.ok && o.reason === 'DETACHED')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('');
  });

  it('畸形帧丢弃不猜、不炸（含空壳 grant——parse 的承诺补齐后不再挂到超时）', async () => {
    mountGreenhouseForm();
    const h = harness();
    h.deliver(null);
    h.deliver({ kind: 'bridge/fill' }); // 缺 requestId/grant/profile
    h.deliver({ kind: 'bridge/什么', requestId: 'r' });
    h.deliver({ kind: 'bridge/fill', requestId: 'r', grant: {}, scanDigest: 'sha256:x', profile: {} });
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'r',
      grant: GRANT(['email']),
      scanDigest: `sha256:${'f'.repeat(64)}`,
      profile: { email: 42 }, // profile 值必须是字符串
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toHaveLength(0);
  });

  it('scanDigest 与本页最近扫描不符（交错 run）→ 全字段 DETACHED，不碰 DOM', async () => {
    mountGreenhouseForm();
    const h = harness();
    h.deliver({ kind: 'bridge/scan', requestId: 'r1' });
    await waitUntil(() => h.sent.length > 0);
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'r2',
      grant: GRANT(['email', 'firstName', 'lastName']),
      scanDigest: `sha256:${'0'.repeat(64)}`, // 别人那次扫描的 digest
      profile: { firstName: 'Ada' },
    });
    await waitUntil(() => h.sent.some((e) => e.kind === 'bridge/fill-result'));
    const final = h.sent.find((e) => e.kind === 'bridge/fill-result')!;
    const outcomes = (final as { outcomes: readonly { ok: boolean; reason?: string }[] }).outcomes;
    expect(outcomes.every((o) => !o.ok && o.reason === 'DETACHED')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('');
  });

  it('DOM mutation 只按 exact scan identity 失效 retained scan，随后 fill 稳定 DETACHED', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    let fillCalls = 0;
    let retainedScan: KernelPageScan | null = null;
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => {
        retainedScan = (await scanCurrentPage(document, GH_LOC)).scan;
        return retainedScan;
      },
      fill: async () => {
        fillCalls += 1;
        return [];
      },
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'mutation-scan' });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/scan-result'));
    const scan = h.sent.find((event) => event.kind === 'bridge/scan-result') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;

    expect(retainedScan).not.toBeNull();
    expect(invalidateRetainedContentScan({ ...retainedScan! })).toBe(false);
    expect(invalidateRetainedContentScan(retainedScan!)).toBe(true);
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'mutation-fill',
      grant: GRANT(scan.scan!.fieldKeys),
      scanDigest: scan.scan!.scanDigest,
      profile: { firstName: 'Ada' },
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'mutation-fill'));
    const result = h.sent.find((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'mutation-fill') as Extract<
      BridgeEvent,
      { kind: 'bridge/fill-result' }
    >;
    expect(result.outcomes.every((outcome) =>
      !outcome.ok && outcome.reason === 'DETACHED')).toBe(true);
    expect(fillCalls).toBe(0);
  });

  it('scan Promise 返回后 generation 已 dirty 时，不得重新留存或回传 usable scan', async () => {
    mountGreenhouseForm();
    const stale = (await scanCurrentPage(document, GH_LOC)).scan!;
    const h = fakePort();
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      isScanFresh: (scan) => scan !== stale,
      scan: async () => stale,
      fill: async () => [],
    });

    h.deliver({ kind: 'bridge/scan', requestId: 'dirty-before-retain' });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'dirty-before-retain'));
    const result = h.sent.find((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'dirty-before-retain') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;
    expect(result.scan).toBeNull();
    expect(invalidateRetainedContentScan(stale)).toBe(false);
  });

  it('same-digest 重扫后，旧 observer 的 scan identity 不能失效更新后的 retained scan', async () => {
    mountGreenhouseForm();
    const firstScan = (await scanCurrentPage(document, GH_LOC)).scan!;
    const secondScan = (await scanCurrentPage(document, GH_LOC)).scan!;
    expect(secondScan.scanDigest).toBe(firstScan.scanDigest);

    const h = fakePort();
    let scanCalls = 0;
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => (scanCalls++ === 0 ? firstScan : secondScan),
      fill: async () => [],
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'scan-old' });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'scan-old'));
    const oldScan = h.sent.find((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'scan-old') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;

    h.deliver({ kind: 'bridge/scan', requestId: 'scan-new' });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'scan-new'));
    const newScan = h.sent.find((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'scan-new') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;
    expect(newScan.scan!.scanDigest).toBe(oldScan.scan!.scanDigest);
    expect(invalidateRetainedContentScan(firstScan)).toBe(false);
    expect(invalidateRetainedContentScan(secondScan)).toBe(true);
  });

  it('overlapping scans 乱序完成时，旧 attempt 不得覆盖新的 retained scan', async () => {
    mountGreenhouseForm();
    const firstScan = (await scanCurrentPage(document, GH_LOC)).scan!;
    const secondScan = (await scanCurrentPage(document, GH_LOC)).scan!;
    let resolveFirst!: (scan: KernelPageScan) => void;
    let resolveSecond!: (scan: KernelPageScan) => void;
    const first = new Promise<KernelPageScan>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<KernelPageScan>((resolve) => { resolveSecond = resolve; });
    let calls = 0;
    const filledWith: KernelPageScan[] = [];
    const h = fakePort();
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => calls++ === 0 ? first : second,
      fill: async (input) => {
        filledWith.push(input.scan);
        return [];
      },
    });

    h.deliver({ kind: 'bridge/scan', requestId: 'scan-first' });
    h.deliver({ kind: 'bridge/scan', requestId: 'scan-second' });
    resolveSecond(secondScan);
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'scan-second'));
    resolveFirst(firstScan);
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/scan-result' && event.requestId === 'scan-first'));

    h.deliver({
      kind: 'bridge/fill',
      requestId: 'fill-newest',
      grant: GRANT(secondScan.fieldKeys),
      scanDigest: secondScan.scanDigest,
      profile: { firstName: 'Ada' },
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'fill-newest'));
    expect(filledWith).toEqual([secondScan]);
    expect(invalidateRetainedContentScan(firstScan)).toBe(false);
  });

  it('SPA pathname 漂移后 fill 重新验证失败并保持零写入', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    let currentPathname = GH_LOC.pathname;
    let fillCalls = 0;
    handleKernelBridgePort(h.port, {
      isCurrentScanTarget: (scan) =>
        scan.canonicalOrigin === GH_LOC.origin && scan.jobId === currentPathname,
      isScanFresh: () => true,
      revalidateScan: async (scan) =>
        scan.jobId === currentPathname
          ? { scan, activate: () => true, dispose: () => {} }
          : null,
      scan: async () => (await scanCurrentPage(document, GH_LOC)).scan,
      fill: async () => {
        fillCalls += 1;
        return [];
      },
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'spa-scan' });
    await waitUntil(() => h.sent.some((event) => event.kind === 'bridge/scan-result'));
    const scan = h.sent.find((event) => event.kind === 'bridge/scan-result') as Extract<
      BridgeEvent,
      { kind: 'bridge/scan-result' }
    >;
    currentPathname = '/acme/jobs/2';
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'spa-fill',
      grant: GRANT(scan.scan!.fieldKeys),
      scanDigest: scan.scan!.scanDigest,
      profile: { firstName: 'Ada', email: 'ada@example.test' },
    });
    await waitUntil(() => h.sent.some((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'spa-fill'));
    const result = h.sent.find((event) =>
      event.kind === 'bridge/fill-result' && event.requestId === 'spa-fill') as Extract<
      BridgeEvent,
      { kind: 'bridge/fill-result' }
    >;
    expect(result.outcomes.every((outcome) =>
      !outcome.ok && outcome.reason === 'DETACHED')).toBe(true);
    expect(fillCalls).toBe(0);
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('');
  });

  it('执行链裸抛 → 全字段 ABORTED 稳定收尾（不留悬空请求）', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => (await scanCurrentPage(document, GH_LOC)).scan,
      fill: async () => {
        throw new Error('kernel exploded');
      },
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'r1' });
    await waitUntil(() => h.sent.length > 0);
    const digest = (h.sent[0] as { scan: { scanDigest: string } }).scan.scanDigest;
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'r2',
      grant: GRANT(['email', 'firstName', 'lastName']),
      scanDigest: digest,
      profile: { firstName: 'Ada' },
    });
    await waitUntil(() => h.sent.some((e) => e.kind === 'bridge/fill-result'));
    const final = h.sent.find((e) => e.kind === 'bridge/fill-result')!;
    const outcomes = (final as { outcomes: readonly { ok: boolean; reason?: string }[] }).outcomes;
    expect(outcomes.every((o) => !o.ok && o.reason === 'ABORTED')).toBe(true);
  });

  it('bridge/stop 后执行链的 shouldStop 变 true（停止信号进检查点）', async () => {
    mountGreenhouseForm();
    const h = fakePort();
    let observedStop: boolean | null = null;
    handleKernelBridgePort(h.port, {
      ...CURRENT_SCAN_FENCE,
      scan: async () => (await scanCurrentPage(document, GH_LOC)).scan,
      fill: async (input) => {
        // 模拟长执行：等 stop 帧被记账后读取检查点。
        await new Promise((resolve) => setTimeout(resolve, 30));
        observedStop = input.progress.shouldStop();
        return [];
      },
    });
    h.deliver({ kind: 'bridge/scan', requestId: 'r1' });
    await waitUntil(() => h.sent.length > 0);
    const digest = (h.sent[0] as { scan: { scanDigest: string } }).scan.scanDigest;
    h.deliver({
      kind: 'bridge/fill',
      requestId: 'r2',
      grant: GRANT(['email']),
      scanDigest: digest,
      profile: { email: 'a@b.test' },
    });
    h.deliver({ kind: 'bridge/stop', requestId: 'r2' });
    await waitUntil(() => h.sent.some((e) => e.kind === 'bridge/fill-result'));
    expect(observedStop).toBe(true);
  });
});
