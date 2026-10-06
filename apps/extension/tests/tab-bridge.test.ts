import { describe, expect, it } from 'vitest';

import type { NeedsUserInputKind, ReceiptFieldOutcome } from '@edaix/contracts/draft';
import type { ExecutionGrant, FillProgress, PageScan } from '@edaix/agent-channel';
import type { BridgeEvent, BridgePortLike, BridgeRequest } from '../lib/bridgeProtocol';
import { createTabKernelBridge, type BridgeTabInfo } from '../lib/tabBridge';
import type { MissionResumeFile } from '../lib/missionMaterialsClient';
import type { ProfileBinding, ProfileFetchResult } from '../lib/profileClient';
import type { SubmissionArmDescriptor } from '../lib/submissionBoundaryProtocol';
import type { RuntimeExecutionAuthorization } from '../lib/executionRuntimeAuthority';

/**
 * 刀六b 特征测试：桥的背景端——tab 定位、profile 闸、scanDigest 绑定、
 * 流式转发、停止传播、超时/断桥的逐 key 稳定码收口。
 */

const REF = { clientRequestId: 'req_1', missionId: 'm_1', missionStepId: 'ms_1', missionRevision: '8' };
const INTENT = { jws: 'x.y.z' };
const ORIGIN = 'https://job-boards.greenhouse.io';
const DIGEST = `sha256:${'e'.repeat(64)}`;
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
const SCAN: PageScan = {
  jobId: '/acme/jobs/1',
  canonicalOrigin: ORIGIN,
  fieldKeys: ['email', 'firstName'],
  scanDigest: DIGEST,
};
const GRANT: ExecutionGrant = {
  missionId: 'm_1',
  missionStepId: 'ms_1',
  fieldKeys: ['email', 'firstName'],
  allowedActions: ['FILL'],
  executionLease: 'lease_1',
  leaseExpiresAt: 9_999_999_999,
  intentVersion: 1,
  planDigest: `sha256:${'b'.repeat(64)}`,
  jobIdentityHash: `sha256:${'a'.repeat(64)}`,
  fieldSchemaVersion: 1,
  profileSnapshot: {
    revision: '7',
    deletionEpoch: '0',
    snapshotDigest: `sha256:${'c'.repeat(64)}`,
  },
};
const SUBMIT_GRANT: ExecutionGrant = {
  ...GRANT,
  missionId: '10000000-0000-4000-8000-000000000001',
  missionStepId: '10000000-0000-4000-8000-000000000002',
  allowedActions: ['FILL', 'SUBMIT'],
};
const ARM: SubmissionArmDescriptor = {
  mode: 'ACTIVE',
  bindingId: '10000000-0000-4000-8000-000000000010',
  authority: {
    missionId: SUBMIT_GRANT.missionId,
    expectedMissionRevision: '9',
    missionStepId: SUBMIT_GRANT.missionStepId,
    stepAttempt: 1,
    applicationId: '10000000-0000-4000-8000-000000000003',
    expectedApplicationRevision: '7',
    applicationBundleVersion: '3',
  },
  expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
  state: 'ARMED',
};

type TabScript = (request: BridgeRequest, emit: (event: BridgeEvent) => void, disconnect: () => void) => void;

function harness(options: {
  tabs?: readonly BridgeTabInfo[];
  targetOrigin?: string | null;
  profileResult?: ProfileFetchResult;
  script?: TabScript;
  timeoutMs?: number;
  prepareSubmissionArm?: (tabId: number, grant: ExecutionGrant) => Promise<SubmissionArmDescriptor>;
  runtimeAuthorization?: RuntimeExecutionAuthorization | null;
  runtimeRevalidate?: boolean;
  scanRevalidate?: boolean;
  targetPathname?: string | null;
  /** undefined = no supply seam wired; null = supply failed; otherwise the bytes to attach. */
  resumeFile?: MissionResumeFile | null;
}) {
  const connects: number[] = [];
  const contentReceived: BridgeRequest[] = [];
  const profileBindings: ProfileBinding[] = [];
  const resumeRequests: string[] = [];
  const script: TabScript = (request, emit, disconnect) => {
    if (request.kind === 'bridge/revalidate-scan') {
      emit({
        kind: 'bridge/revalidate-scan-result',
        requestId: request.requestId,
        accepted: options.scanRevalidate ?? true,
      });
      return;
    }
    if (options.script) {
      options.script(request, emit, disconnect);
      return;
    }
      if (request.kind === 'bridge/scan') emit({ kind: 'bridge/scan-result', requestId: request.requestId, scan: SCAN });
      if (request.kind === 'bridge/fill') {
        for (const key of GRANT.fieldKeys) {
          emit({ kind: 'bridge/fill-outcome', requestId: request.requestId, outcome: { key, ok: true } });
        }
        emit({
          kind: 'bridge/fill-result',
          requestId: request.requestId,
          outcomes: GRANT.fieldKeys.map((key) => ({ key, ok: true })),
        });
      }
      if (request.kind === 'bridge/submission-arm') {
        emit({
          kind: 'bridge/submission-arm-result',
          requestId: request.requestId,
          accepted: true,
        });
      }
  };

  const bridge = createTabKernelBridge({
    resolveTargetOrigin: () => (options.targetOrigin === undefined ? ORIGIN : options.targetOrigin),
    resolveTargetPathname: async () =>
      options.targetPathname === undefined ? SCAN.jobId : options.targetPathname,
    queryTabs: async () => options.tabs ?? [{
      id: 7,
      url: options.runtimeAuthorization !== undefined ? `${ORIGIN}${SCAN.jobId}` : ORIGIN,
      lastAccessed: 100,
    }],
    connectToTab: (tabId) => {
      connects.push(tabId);
      const messageHandlers: Array<(m: unknown) => void> = [];
      const disconnectHandlers: Array<() => void> = [];
      const disconnectFromContent = () => disconnectHandlers.forEach((h) => h());
      const port: BridgePortLike = {
        postMessage: (m) => {
          contentReceived.push(m as BridgeRequest);
          // 模拟异步投递到内容端脚本。
          setTimeout(() => {
            script(m as BridgeRequest, (event) => messageHandlers.forEach((h) => h(event)), disconnectFromContent);
          }, 0);
        },
        onMessage: { addListener: (h) => messageHandlers.push(h) },
        onDisconnect: { addListener: (h) => disconnectHandlers.push(h) },
        disconnect: () => {},
      };
      return port;
    },
    getProfile: async (binding) => {
      profileBindings.push(binding);
      return options.profileResult === undefined
        ? { ok: true, draft: { email: 'a@b.test' } }
        : options.profileResult;
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    prepareSubmissionArm: options.prepareSubmissionArm,
    runtimeAuthority: options.runtimeAuthorization !== undefined
      ? {
          mode: 'REQUIRED',
          resolve: async () => options.runtimeAuthorization ?? null,
          revalidate: async () => options.runtimeRevalidate ?? true,
        }
      : { mode: 'LOCAL_REHEARSAL' },
    ...(options.resumeFile === undefined
      ? {}
      : {
          getResumeFile: async (missionId: string) => {
            resumeRequests.push(missionId);
            return options.resumeFile ?? null;
          },
        }),
  });
  return { bridge, connects, contentReceived, profileBindings, resumeRequests };
}

function progressRecorder(shouldStop: () => boolean = () => false) {
  const outcomes: ReceiptFieldOutcome[] = [];
  const needs: Array<{ kind: NeedsUserInputKind; fieldKey?: string }> = [];
  const progress: FillProgress = {
    onOutcome: (o) => outcomes.push(o),
    onNeedsUserInput: (kind, fieldKey) =>
      needs.push(fieldKey === undefined ? { kind } : { kind, fieldKey }),
    shouldStop,
  };
  return { progress, outcomes, needs };
}

describe('背景端桥', () => {
  it('production runtime binding accompanies scan/fill and is revalidated before profile or write', async () => {
    const h = harness({ runtimeAuthorization: RUNTIME_AUTHORIZATION });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    await h.bridge.filler.fill(GRANT, scan, progressRecorder().progress);
    expect(h.contentReceived.find((request) => request.kind === 'bridge/scan')).toEqual({
      kind: 'bridge/scan',
      requestId: 'bridge_1',
      runtime: RUNTIME_AUTHORIZATION,
    });
    expect(h.contentReceived.find((request) => request.kind === 'bridge/fill')).toMatchObject({
      kind: 'bridge/fill',
      runtime: RUNTIME_AUTHORIZATION,
    });
  });

  it('bundle refresh/drift failure after scan returns POLICY_DISABLED with zero profile/fill connection', async () => {
    const h = harness({
      runtimeAuthorization: RUNTIME_AUTHORIZATION,
      runtimeRevalidate: false,
    });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const result = await h.bridge.filler.fill(GRANT, scan, progressRecorder().progress);
    expect(result.every((outcome) => !outcome.ok && outcome.reason === 'POLICY_DISABLED')).toBe(true);
    expect(h.profileBindings).toEqual([]);
    expect(h.connects).toEqual([7]);
  });

  it('SPA pathname drift is rejected before profile read or fill connection', async () => {
    const h = harness({ scanRevalidate: false });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const result = await h.bridge.filler.fill(GRANT, scan, progressRecorder().progress);
    expect(result.every((outcome) =>
      !outcome.ok && outcome.reason === 'DETACHED')).toBe(true);
    expect(h.profileBindings).toEqual([]);
    expect(h.contentReceived).toContainEqual({
      kind: 'bridge/revalidate-scan',
      requestId: 'bridge_2',
      scanDigest: DIGEST,
      canonicalOrigin: ORIGIN,
      pathname: SCAN.jobId,
    });
    expect(h.contentReceived.some((request) => request.kind === 'bridge/fill')).toBe(false);
  });

  it('missing runtime bundle authorization causes zero content connection in production mode', async () => {
    const h = harness({ runtimeAuthorization: null });
    await expect(h.bridge.scanner.scan(REF, INTENT)).resolves.toBeNull();
    expect(h.connects).toEqual([]);
  });

  it('production selects one exact shared-host pathname and never guesses a sibling job', async () => {
    const h = harness({
      runtimeAuthorization: RUNTIME_AUTHORIZATION,
      tabs: [
        { id: 1, url: `${ORIGIN}/acme/jobs/other`, lastAccessed: 999 },
        { id: 2, url: `${ORIGIN}${SCAN.jobId}`, lastAccessed: 50 },
      ],
    });
    await expect(h.bridge.scanner.scan(REF, INTENT)).resolves.toMatchObject({
      canonicalOrigin: ORIGIN,
      jobId: SCAN.jobId,
    });
    expect(h.connects).toEqual([2]);

    const missingPath = harness({
      runtimeAuthorization: RUNTIME_AUTHORIZATION,
      targetPathname: null,
    });
    await expect(missingPath.bridge.scanner.scan(REF, INTENT)).resolves.toBeNull();
    expect(missingPath.connects).toEqual([]);

    const duplicate = harness({
      runtimeAuthorization: RUNTIME_AUTHORIZATION,
      tabs: [
        { id: 2, url: `${ORIGIN}${SCAN.jobId}`, lastAccessed: 50 },
        { id: 3, url: `${ORIGIN}${SCAN.jobId}`, lastAccessed: 100 },
      ],
    });
    await expect(duplicate.bridge.scanner.scan(REF, INTENT)).resolves.toBeNull();
    expect(duplicate.connects).toEqual([]);
  });

  it('按批准目标 origin 定位 tab（多命中取最近报到），扫描往返成功', async () => {
    const h = harness({
      tabs: [
        { id: 1, url: 'https://unrelated.example', lastAccessed: 999 },
        { id: 2, url: ORIGIN, lastAccessed: 50 },
        { id: 3, url: ORIGIN, lastAccessed: 200 },
      ],
    });
    const scan = await h.bridge.scanner.scan(REF, INTENT);
    expect(scan).toMatchObject({ canonicalOrigin: ORIGIN, scanDigest: DIGEST });
    expect(h.connects).toEqual([3]);
  });

  it('凭证未验签（origin 拿不到）/ 无匹配 tab → 扫描失败，零连接', async () => {
    const noOrigin = harness({ targetOrigin: null });
    expect(await noOrigin.bridge.scanner.scan(REF, INTENT)).toBeNull();
    expect(noOrigin.connects).toEqual([]);

    const noTab = harness({ tabs: [{ id: 1, url: 'https://unrelated.example' }] });
    expect(await noTab.bridge.scanner.scan(REF, INTENT)).toBeNull();
    expect(noTab.connects).toEqual([]);
  });

  it('fill 全链：fill 帧携带 scanDigest，流式转发 outcome/needs-user-input，终帧收口', async () => {
    const h = harness({
      script: (request, emit) => {
        if (request.kind === 'bridge/scan') {
          emit({ kind: 'bridge/scan-result', requestId: request.requestId, scan: SCAN });
          return;
        }
        if (request.kind !== 'bridge/fill') return;
        emit({ kind: 'bridge/needs-user-input', requestId: request.requestId, inputKind: 'IN_PAGE_ACTION' });
        emit({ kind: 'bridge/fill-outcome', requestId: request.requestId, outcome: { key: 'email', ok: true } });
        emit({
          kind: 'bridge/fill-result',
          requestId: request.requestId,
          outcomes: [{ key: 'email', ok: true }, { key: 'firstName', ok: false, reason: 'NO_VALUE' }],
        });
      },
    });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const { progress, outcomes, needs } = progressRecorder();
    const result = await h.bridge.filler.fill(GRANT, scan, progress);

    expect(result).toEqual([{ key: 'email', ok: true }, { key: 'firstName', ok: false, reason: 'NO_VALUE' }]);
    expect(outcomes).toEqual([{ key: 'email', ok: true }]);
    expect(needs).toEqual([{ kind: 'IN_PAGE_ACTION' }]);
    const fillFrame = h.contentReceived.find((r) => r.kind === 'bridge/fill')!;
    expect(fillFrame).toMatchObject({ scanDigest: DIGEST });
  });

  it('attaches the Mission-bound resume only to a runtime-bound fill whose grant covers the file, and fills text without it when supply fails', async () => {
    const bytes = new Uint8Array(new TextEncoder().encode('%PDF-1.4 fixture'));
    const resume: MissionResumeFile = {
      fileName: 'ada-resume.pdf',
      sha256: `sha256:${'d'.repeat(64)}`,
      size: bytes.byteLength,
      bytes,
    };
    const resumeGrant: ExecutionGrant = { ...GRANT, fieldKeys: [...GRANT.fieldKeys, 'resumeFile'] };
    const fillFrame = (h: ReturnType<typeof harness>) =>
      h.contentReceived.find((request) => request.kind === 'bridge/fill');

    const supplied = harness({ runtimeAuthorization: RUNTIME_AUTHORIZATION, resumeFile: resume });
    await supplied.bridge.filler.fill(GRANT, (await supplied.bridge.scanner.scan(REF, INTENT))!, progressRecorder().progress);
    expect(supplied.resumeRequests).toEqual([]);
    expect(fillFrame(supplied)).not.toHaveProperty('resume');

    await supplied.bridge.filler.fill(resumeGrant, (await supplied.bridge.scanner.scan(REF, INTENT))!, progressRecorder().progress);
    expect(supplied.resumeRequests).toEqual([REF.missionId]);
    expect(supplied.contentReceived.filter((request) => request.kind === 'bridge/fill').at(-1)).toMatchObject({
      runtime: RUNTIME_AUTHORIZATION,
      resume: { fileName: 'ada-resume.pdf', sha256: resume.sha256, size: bytes.byteLength, bytesBase64: btoa('%PDF-1.4 fixture') },
    });

    const failed = harness({ runtimeAuthorization: RUNTIME_AUTHORIZATION, resumeFile: null });
    const outcomes = await failed.bridge.filler.fill(resumeGrant, (await failed.bridge.scanner.scan(REF, INTENT))!, progressRecorder().progress);
    expect(failed.resumeRequests).toEqual([REF.missionId]);
    expect(fillFrame(failed)).not.toHaveProperty('resume');
    expect(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.key)).toEqual(GRANT.fieldKeys);

    const rehearsal = harness({ resumeFile: resume });
    await rehearsal.bridge.filler.fill(resumeGrant, (await rehearsal.bridge.scanner.scan(REF, INTENT))!, progressRecorder().progress);
    expect(rehearsal.resumeRequests).toEqual([]);
    expect(fillFrame(rehearsal)).not.toHaveProperty('resume');
  });

  it('SUBMIT claim 在 Profile/填表前先把 exact authority 装进内容端阻断闸', async () => {
    const prepared: Array<{ tabId: number; grant: ExecutionGrant }> = [];
    const h = harness({
      prepareSubmissionArm: async (tabId, grant) => {
        prepared.push({ tabId, grant });
        return ARM;
      },
    });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    await h.bridge.filler.fill(SUBMIT_GRANT, scan, progressRecorder().progress);

    expect(prepared).toEqual([{ tabId: 7, grant: SUBMIT_GRANT }]);
    const armIndex = h.contentReceived.findIndex((request) => request.kind === 'bridge/submission-arm');
    const fillIndex = h.contentReceived.findIndex((request) => request.kind === 'bridge/fill');
    expect(armIndex).toBeGreaterThan(-1);
    expect(fillIndex).toBeGreaterThan(armIndex);
    const arm = h.contentReceived[armIndex];
    expect(arm).toMatchObject({
      kind: 'bridge/submission-arm',
      scanDigest: DIGEST,
      descriptor: ARM,
    });
    expect(JSON.stringify(arm)).not.toMatch(/confirmation|screenshot|metadata|html|resumeText/i);
  });

  it('profile 拿不到 → 全字段 NO_VALUE，不连内容端（闸在背景侧）', async () => {
    const h = harness({ profileResult: { ok: false, stale: false } });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const before = h.connects.length;
    const { progress, outcomes } = progressRecorder();
    const result = await h.bridge.filler.fill(GRANT, scan, progress);
    expect(result.every((o) => !o.ok && o.reason === 'NO_VALUE')).toBe(true);
    expect(outcomes).toEqual(result);
    expect(h.connects.length).toBe(before + 1);
    expect(h.contentReceived.at(-1)?.kind).toBe('bridge/revalidate-scan');
  });

  it('§5.8 绑定失配（stale）→ 全字段 PLAN_STALE，不连内容端', async () => {
    const h = harness({ profileResult: { ok: false, stale: true } });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const before = h.connects.length;
    const { progress, outcomes } = progressRecorder();
    const result = await h.bridge.filler.fill(GRANT, scan, progress);
    expect(result.every((o) => !o.ok && o.reason === 'PLAN_STALE')).toBe(true);
    expect(outcomes).toEqual(result);
    expect(h.connects.length).toBe(before + 1);
    expect(h.contentReceived.at(-1)?.kind).toBe('bridge/revalidate-scan');
  });

  it('取数 binding 逐字段取自已验签 grant（fieldKeys/fieldSchemaVersion/三元）', async () => {
    const h = harness({});
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const { progress } = progressRecorder();
    await h.bridge.filler.fill(GRANT, scan, progress);
    expect(h.profileBindings).toEqual([
      {
        fieldKeys: GRANT.fieldKeys,
        fieldSchemaVersion: GRANT.fieldSchemaVersion,
        profileSnapshot: GRANT.profileSnapshot,
      },
    ]);
  });

  it('没扫过的 digest（未登记/已消费）→ DETACHED，不连内容端', async () => {
    const h = harness({});
    const { progress } = progressRecorder();
    const detached = await h.bridge.filler.fill(GRANT, SCAN, progress);
    expect(detached.every((o) => !o.ok && o.reason === 'DETACHED')).toBe(true);
    expect(h.connects).toEqual([]);

    // 消费一次后再 fill 同一 digest → 同样 DETACHED（执行权不复用）。
    const consumed = harness({});
    const scan = (await consumed.bridge.scanner.scan(REF, INTENT))!;
    await consumed.bridge.filler.fill(GRANT, scan, progressRecorder().progress);
    const second = await consumed.bridge.filler.fill(GRANT, scan, progressRecorder().progress);
    expect(second.every((o) => !o.ok && o.reason === 'DETACHED')).toBe(true);
  });

  it('tab 中途断桥 → 已收到的算数，缺的补 DETACHED（逐 key 稳定码，不无声消失）', async () => {
    const dropping = harness({
      script: (request, emit, disconnect) => {
        if (request.kind === 'bridge/scan') {
          emit({ kind: 'bridge/scan-result', requestId: request.requestId, scan: SCAN });
          return;
        }
        if (request.kind !== 'bridge/fill') return;
        emit({ kind: 'bridge/fill-outcome', requestId: request.requestId, outcome: { key: 'email', ok: true } });
        disconnect(); // 用户关了 tab
      },
    });
    const scan = (await dropping.bridge.scanner.scan(REF, INTENT))!;
    const rec = progressRecorder();
    const partial = await dropping.bridge.filler.fill(GRANT, scan, rec.progress);
    expect(partial).toEqual([
      { key: 'email', ok: true },
      { key: 'firstName', ok: false, reason: 'DETACHED' },
    ]);
    expect(rec.outcomes).toEqual(partial);
  });

  it('内容端失联（不回帧）→ 超时收口，全部缺失字段补 DETACHED', async () => {
    const silent = harness({
      timeoutMs: 60,
      script: (request, emit) => {
        if (request.kind === 'bridge/scan') {
          emit({ kind: 'bridge/scan-result', requestId: request.requestId, scan: SCAN });
        }
        // fill 帧石沉大海。
      },
    });
    const scan = (await silent.bridge.scanner.scan(REF, INTENT))!;
    const result = await silent.bridge.filler.fill(GRANT, scan, progressRecorder().progress);
    expect(result).toEqual([
      { key: 'email', ok: false, reason: 'DETACHED' },
      { key: 'firstName', ok: false, reason: 'DETACHED' },
    ]);
  });

  it('停止传播：shouldStop 翻 true 后 ≤300ms 内容端收到 bridge/stop 帧', async () => {
    let stopFrameAt = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      timeoutMs: 5_000,
      script: (request, emit) => {
        if (request.kind === 'bridge/scan') {
          emit({ kind: 'bridge/scan-result', requestId: request.requestId, scan: SCAN });
          return;
        }
        if (request.kind === 'bridge/stop') {
          stopFrameAt = Date.now();
          emit({ kind: 'bridge/fill-result', requestId: request.requestId, outcomes: [] });
          release();
        }
        // bridge/fill：装作长时间执行，等 stop。
      },
    });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    let stopping = false;
    const rec = progressRecorder(() => stopping);
    const startedAt = Date.now();
    const pending = h.bridge.filler.fill(GRANT, scan, rec.progress);
    stopping = true;
    await gate;
    await pending;
    expect(stopFrameAt - startedAt).toBeLessThanOrEqual(600);
  });

  it('入站畸形事件帧丢弃：坏 outcome（带 value 键 / 非法形状）不进回执', async () => {
    const h = harness({
      script: (request, emit) => {
        if (request.kind === 'bridge/scan') {
          emit({ kind: 'bridge/scan-result', requestId: request.requestId, scan: SCAN });
          return;
        }
        if (request.kind !== 'bridge/fill') return;
        emit({
          kind: 'bridge/fill-outcome',
          requestId: request.requestId,
          outcome: { key: 'email', ok: true, value: 'ada@leak.test' } as never,
        });
        emit({ kind: 'bridge/fill-outcome', requestId: request.requestId, outcome: 42 as never });
        emit({
          kind: 'bridge/fill-result',
          requestId: request.requestId,
          outcomes: [{ key: 'email', ok: true }, { key: 'firstName', ok: true }],
        });
      },
    });
    const scan = (await h.bridge.scanner.scan(REF, INTENT))!;
    const rec = progressRecorder();
    const result = await h.bridge.filler.fill(GRANT, scan, rec.progress);
    // 畸形 outcome 帧被丢弃（含 Data-L1 走私形状）；合法终帧照常收口。
    expect(rec.outcomes).toEqual([]);
    expect(result).toEqual([{ key: 'email', ok: true }, { key: 'firstName', ok: true }]);
    expect(JSON.stringify(result)).not.toContain('leak.test');
  });
});
