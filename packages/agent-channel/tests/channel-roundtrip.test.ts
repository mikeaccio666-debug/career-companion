import { describe, expect, it } from 'vitest';

import type { ChannelErrorCode, ChannelEvent, ReceiptFieldOutcome, ReceiptReasonCode } from '@edaix/contracts/draft';
import { createChannelClient } from '../src/client';
import { createRunCoordinator, type CoordinatorDeps, type ExecutionGrant } from '../src/coordinator';
import { createMockTransportPair } from '../src/transport';

/**
 * T10 通道原型端到端特征测试（第三刀：扩展自领凭证版）。
 *
 * 链路：chat 发 run/start（只有任务引用）→ 扩展自领凭证 → 扫描页面 →
 * 服务端 claim（权威比对 + 一次性核销，通过才有 lease）→ 逐字段执行 →
 * 回执。锁死三件事：JWS 绝不出现在通道上、claim 拒绝的两种停法、
 * Data-L1（回执无值）。真实 HTTP/验签属外壳阶段，此处 mock 依赖。
 */

const REF = { clientRequestId: 'req_1', missionId: 'm_1', missionStepId: 'ms_1', missionRevision: '8' };

const GRANT: ExecutionGrant = {
  missionId: 'm_1',
  missionStepId: 'ms_1',
  fieldKeys: ['fullName', 'email', 'phone'],
  allowedActions: ['FILL'],
  executionLease: 'lease_test_1',
  leaseExpiresAt: 2_000, // 测试时钟 now=1_500，lease 有效
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

function outcome(key: string, ok: boolean, reason?: ReceiptReasonCode): ReceiptFieldOutcome {
  return reason === undefined ? { key, ok } : { key, ok, reason };
}

function harness(
  overrides: Partial<CoordinatorDeps> = {},
  onCoordinatorSend?: (message: unknown) => void,
) {
  const pair = createMockTransportPair();
  const events: ChannelEvent[] = [];
  const protocolErrors: ChannelErrorCode[] = [];
  const sentByChat: unknown[] = [];
  const client = createChannelClient(pair.chatSide);
  client.onEvent((event) => events.push(event));
  // 窃听 chat→扩展方向的原始流量，用于断言"凭证绝不经通道"。
  pair.extensionSide.onMessage((raw) => sentByChat.push(raw));

  const extensionTransport: typeof pair.extensionSide = onCoordinatorSend
    ? {
        send: (message) => {
          onCoordinatorSend(message);
          pair.extensionSide.send(message);
        },
        onMessage: (handler) => pair.extensionSide.onMessage(handler),
      }
    : pair.extensionSide;
  const coordinator = createRunCoordinator({
    transport: extensionTransport,
    acquirer: { acquire: async () => ({ ok: true, intent: { jws: 'ext.only.jws' } }) },
    scanner: {
      scan: async () => ({ jobId: 'j_42', canonicalOrigin: 'https://host.test', fieldKeys: ['fullName', 'email', 'phone'], scanDigest: 'sha256:abc' }),
    },
    claimer: { claim: async () => ({ ok: true, grant: GRANT }) },
    filler: {
      fill: async (grant, _scan, progress) => {
        const outcomes = grant.fieldKeys.map((key, index) =>
          index === grant.fieldKeys.length - 1 ? outcome(key, false, 'NO_VALUE') : outcome(key, true),
        );
        for (const entry of outcomes) {
          if (progress.shouldStop()) break;
          progress.onOutcome(entry);
        }
        return outcomes;
      },
    },
    now: () => 1_500,
    onProtocolError: (code) => protocolErrors.push(code),
    ...overrides,
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, coordinator, events, protocolErrors, sentByChat, settle, pair };
}

describe('通道端到端（扩展自领凭证）', () => {
  it('happy path：阶段推进、回执 2/3 绑定任务引用，且通道上无凭证无字段值', async () => {
    const h = harness();
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();

    const steps = h.events.filter((e) => e.kind === 'run/progress').map((e) => e.step);
    for (const expected of ['VERIFYING_INTENT', 'SCANNING', 'PLANNING', 'FILLING', 'VERIFYING', 'DONE']) {
      expect(steps, `进度流缺 ${expected}`).toContain(expected);
    }

    const receipts = h.events.filter((e) => e.kind === 'run/receipt');
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!.receipt;
    expect(receipt).toMatchObject({ missionId: 'm_1', missionStepId: 'ms_1', filled: 2, total: 3 });
    expect(receipt.outcomes[2]).toEqual({ key: 'phone', ok: false, reason: 'NO_VALUE' });

    // §4.1 绊线：chat→扩展方向的全部流量里不得出现凭证；回执里不得出现值。
    expect(JSON.stringify(h.sentByChat)).not.toMatch(/jws|lease|intent/i);
    expect(JSON.stringify(receipt)).not.toMatch(/value|label|jws/);
    h.coordinator.dispose();
  });

  it('claim 后异常逃逸：run/stopped 收口且仍上传恰好一次取消回执（每条退出路径必上报）', async () => {
    const uploads: Array<{ cancelled: boolean }> = [];
    const h = harness({
      // filler 直接抛（接口约定该回 Result；真抛了 = 异常逃逸路径）。
      filler: {
        fill: async () => {
          throw new Error('bridge exploded with https://internal?token=secret');
        },
      },
      receiptUploader: {
        upload: async ({ cancelled }) => {
          uploads.push({ cancelled });
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    await h.settle();

    const stopped = h.events.filter((e) => e.kind === 'run/stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ code: 'RUN_ABORTED' });
    // "需要处理"与"已完成"不同屏：异常收口不得再发填写摘要帧。
    expect(h.events.filter((e) => e.kind === 'run/receipt')).toHaveLength(0);
    // claim 已核销——lease 在服务端记了账，异常逃逸也必须收口回执，且只一次。
    expect(uploads).toEqual([{ cancelled: true }]);
    h.coordinator.dispose();
  });

  it('自领失败 → INTENT_REJECTED，不进入扫描', async () => {
    let scanned = false;
    const h = harness({
      acquirer: { acquire: async () => ({ ok: false }) },
      scanner: {
        scan: async () => {
          scanned = true;
          return null;
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'INTENT_REJECTED' });
    expect(scanned).toBe(false);
    h.coordinator.dispose();
  });

  it('服务端 claim 判定不一致 → RESCAN_MISMATCH（授权链第 2 段的权威在服务端）', async () => {
    const h = harness({ claimer: { claim: async () => ({ ok: false, code: 'RESCAN_MISMATCH' }) } });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'RESCAN_MISMATCH' });
    expect(h.events.map((e) => e.kind)).not.toContain('run/receipt');
    h.coordinator.dispose();
  });

  it('lease 已过期 → INTENT_REJECTED（短 TTL 不留宽限）', async () => {
    const h = harness({ now: () => 3_000 });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'INTENT_REJECTED' });
    h.coordinator.dispose();
  });

  it('中途 run/stop → RUN_ABORTED，绝不发回执', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      filler: {
        fill: async (grant, _scan, progress) => {
          progress.onOutcome(outcome(grant.fieldKeys[0]!, true));
          await gate;
          return grant.fieldKeys.map((key) => outcome(key, true));
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    const runId = h.events.find((e) => e.kind === 'run/progress')!.runId;
    h.client.requestStop(runId);
    await h.settle();
    release();
    await h.settle();
    expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'RUN_ABORTED' });
    expect(h.events.map((e) => e.kind)).not.toContain('run/receipt');
    h.coordinator.dispose();
  });

  it('IN_PAGE_ACTION 不收口：run 正常 DONE + 填写摘要（页面动作与摘要并存不矛盾）', async () => {
    const h = harness({
      filler: {
        fill: async (grant, _scan, progress) => {
          progress.onNeedsUserInput?.('IN_PAGE_ACTION');
          return grant.fieldKeys.map((key) => outcome(key, true));
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();

    const needs = h.events.filter((e) => e.kind === 'run/needs-user-input');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ inputKind: 'IN_PAGE_ACTION' });
    expect('fieldKey' in needs[0]!).toBe(false);
    expect(needs[0]!.inputRequestId).toMatch(/^run_\d+_input_1$/); // 稳定关联号
    expect(h.events.filter((e) => e.kind === 'run/progress').map((e) => e.step)).toContain('DONE');
    expect(h.events.filter((e) => e.kind === 'run/receipt')).toHaveLength(1);
    h.coordinator.dispose();
  });

  it.each(['CHAT_ANSWER', 'SENSITIVE_CONFIRM'] as const)(
    '%s 必收口：不进 DONE/摘要，USER_ACTION_REQUIRED 停止，已写照实直报后端',
    async (inputKind) => {
      const uploads: Array<{ cancelled: boolean; filled: number }> = [];
      const h = harness({
        filler: {
          fill: async (grant, _scan, progress) => {
            progress.onOutcome(outcome(grant.fieldKeys[0]!, true));
            progress.onNeedsUserInput?.(inputKind, 'workAuthorization');
            // filler 返回"成功"也压不住收口——状态机在协调器，不靠 filler 自觉。
            return [outcome(grant.fieldKeys[0]!, true)];
          },
        },
        receiptUploader: {
          upload: async (input) => {
            uploads.push({ cancelled: input.cancelled, filled: input.receipt.filled });
          },
        },
      });
      h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
      await h.settle();

      const needs = h.events.filter((e) => e.kind === 'run/needs-user-input');
      expect(needs).toHaveLength(1);
      expect(needs[0]).toMatchObject({ inputKind, fieldKey: 'workAuthorization' });
      expect(needs[0]!.inputRequestId).not.toBe('');
      // "需要回答"与"已完成"绝不同屏：无 DONE、无摘要，闭集码收口。
      expect(h.events.filter((e) => e.kind === 'run/progress').map((e) => e.step)).not.toContain('DONE');
      expect(h.events.map((e) => e.kind)).not.toContain('run/receipt');
      expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'USER_ACTION_REQUIRED' });
      expect(uploads).toEqual([{ cancelled: false, filled: 1 }]); // 事实照报
      h.coordinator.dispose();
    },
  );

  it('回执直报：uploader 收到 grant+receipt+起止时间；uploader 炸不影响通道', async () => {
    const uploads: Array<{ lease: string; filled: number; startedAt: number; cancelled: boolean }> = [];
    const h = harness({
      now: () => 1_500,
      receiptUploader: {
        upload: async (input) => {
          uploads.push({
            lease: input.grant.executionLease,
            filled: input.receipt.filled,
            startedAt: input.startedAt,
            cancelled: input.cancelled,
          });
          throw new Error('upload infra down'); // 抛错必须被吞掉
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.filter((e) => e.kind === 'run/receipt')).toHaveLength(1);
    expect(uploads).toEqual([{ lease: 'lease_test_1', filled: 2, startedAt: 1_500, cancelled: false }]);
    h.coordinator.dispose();
  });

  it('claim 后被点停：协调器不发 run/receipt（spy 扩展侧 send），收口回执仍直报后端', async () => {
    const uploads: Array<{ cancelled: boolean; outcomes: number }> = [];
    // 直接窃听协调器的出站 send——mock 传输死不掉，"chat 没收到"不够硬，
    // 这里断言的是"根本没尝试发"（评审 中1）。
    const sentByCoordinator: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(
      {
        filler: {
          fill: async (grant, _scan, progress) => {
            progress.onOutcome(outcome(grant.fieldKeys[0]!, true));
            await gate;
            return [outcome(grant.fieldKeys[0]!, true)];
          },
        },
        receiptUploader: {
          upload: async (input) => {
            uploads.push({ cancelled: input.cancelled, outcomes: input.receipt.outcomes.length });
          },
        },
      },
      (send) => sentByCoordinator.push((send as { kind: string }).kind),
    );
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    const runId = h.events.find((e) => e.kind === 'run/progress')!.runId;
    h.client.requestStop(runId);
    await h.settle();
    release();
    await h.settle();
    expect(sentByCoordinator).not.toContain('run/receipt');
    expect(h.events.map((e) => e.kind)).not.toContain('run/receipt');
    expect(uploads).toEqual([{ cancelled: true, outcomes: 1 }]); // 已发生的写入照实上报
    h.coordinator.dispose();
  });

  it('执行期间 lease 到期：不宣告 DONE，通道 INTENT_REJECTED 收尾，已写照实直报', async () => {
    const uploads: Array<{ cancelled: boolean }> = [];
    let clock = 1_500;
    const h = harness({
      now: () => clock,
      filler: {
        fill: async (grant, _scan, progress) => {
          progress.onOutcome(outcome(grant.fieldKeys[0]!, true));
          clock = 2_500; // 写着写着跨过了 leaseExpiresAt=2_000
          return [outcome(grant.fieldKeys[0]!, true)];
        },
      },
      receiptUploader: {
        upload: async (input) => {
          uploads.push({ cancelled: input.cancelled });
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'INTENT_REJECTED' });
    expect(h.events.map((e) => e.kind)).not.toContain('run/receipt');
    const steps = h.events.filter((e) => e.kind === 'run/progress').map((e) => e.step);
    expect(steps).not.toContain('DONE');
    expect(uploads).toEqual([{ cancelled: false }]);
    h.coordinator.dispose();
  });

  it('依赖抛裸错（违反 Result 约定）→ 仍有 run/stopped 收尾，绝不无声挂起', async () => {
    const h = harness({
      acquirer: {
        acquire: async () => {
          throw new Error('deps must not throw, but if they do…');
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.find((e) => e.kind === 'run/stopped')).toMatchObject({ code: 'RUN_ABORTED' });
    expect(h.events.map((e) => e.kind)).not.toContain('run/receipt');
    h.coordinator.dispose();
  });

  it('claim 往返期间断连/点停 → 绝不启动填写（授权生效瞬间的检查点）', async () => {
    let filled = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      claimer: {
        claim: async () => {
          await gate; // claim HTTP 往返悬停中……
          return { ok: true, grant: GRANT };
        },
      },
      filler: {
        fill: async (grant, _scan) => {
          filled = true;
          return grant.fieldKeys.map((key) => outcome(key, true));
        },
      },
    });
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    h.coordinator.dispose(); // ……期间端口断开
    release();
    await h.settle();
    expect(filled).toBe(false);
    const stopped = h.events.find((e) => e.kind === 'run/stopped');
    expect(stopped).toMatchObject({ code: 'RUN_ABORTED' });
  });

  it('试图从 chat 侧走私凭证：带 jws 的 run/start 整份拒收', async () => {
    const h = harness();
    h.pair.chatSide.send({ v: 1, kind: 'run/start', missionId: 'm', missionStepId: 's', missionRevision: '1', jws: 'evil' } as never);
    await h.settle();
    expect(h.protocolErrors).toEqual(['CHANNEL_MALFORMED']);
    expect(h.events.some((e) => e.kind === 'run/receipt')).toBe(false);
    h.coordinator.dispose();
  });

  it('畸形与超版本入站：丢弃 + 稳定诊断码，协调器不崩', async () => {
    const h = harness();
    h.pair.chatSide.send({ v: 2, kind: 'run/stop', runId: 'r' } as never);
    h.pair.chatSide.send({ hello: 'world' } as never);
    await h.settle();
    expect(h.protocolErrors).toEqual(['CHANNEL_VERSION_TOO_NEW', 'CHANNEL_MALFORMED']);
    h.client.startRun(REF.missionId, REF.missionStepId, REF.missionRevision);
    await h.settle();
    expect(h.events.some((e) => e.kind === 'run/receipt')).toBe(true);
    h.coordinator.dispose();
  });
});
