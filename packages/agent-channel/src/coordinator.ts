/**
 * 扩展侧运行协调器：通道原型的状态机（T10 的"血管"部分）。
 *
 * 第三刀重构（契约生效后对齐 §4.1/§5.6）：
 *  - **JWS 绝不经过网页通道**——chat 只发 `run/start`（任务引用），
 *    凭证由扩展在自己的隔离环境里向后端**自领**（acquirer）；
 *  - **重扫比对的权威判定在服务端 claim 时发生**：扩展先扫描页面得到
 *    actualFieldKeys + scanDigest，带着它们去 claim；对不上→服务端拒发
 *    lease（RESCAN_MISMATCH）。本地不再自行比对——授权链第 2 段的
 *    真相源是服务端（纯前端判定可被伪造，20 §2 的老原则）。
 *
 * 依赖全部接口化，原型用 mock、真实现按注释接入：
 *  - IntentAcquirer：issue + JWKS 验签（外壳阶段实现，JWS 只在扩展内存）
 *  - PageScanner：apply-kernel readApplyForm → fieldKeys + scanDigest
 *  - IntentClaimer：POST /execution-intents/claim（服务端原子 claim + 比对）
 *  - FieldFiller：apply-kernel 的 plan + runner
 *
 * Data-L1 纪律：本文件与它发出的每条消息只经手 key、计数与稳定原因码。
 */

import {
  parseChannelMessage,
  type ChannelErrorCode,
  type NeedsUserInputKind,
  type ReceiptFieldOutcome,
  type RunReceiptSummary,
  CHANNEL_PROTOCOL_VERSION,
} from '@edaix/contracts/draft';
import type { ChannelTransport } from './transport';

export interface RunStartRef {
  /** chat 生成的关联号——run/accepted 把权威 runId 对回发起方卡片。 */
  readonly clientRequestId: string;
  readonly missionId: string;
  readonly missionStepId: string;
  /** 签发端点（契约 §5.4）必填的乐观并发号。 */
  readonly missionRevision: string;
}

/** 自领到的凭证（原型收窄形状；真实现为 CompactExecutionIntent + 本地验签）。 */
export interface AcquiredIntent {
  readonly jws: string;
}

export interface IntentAcquirer {
  /** 失败只回 false——细节不进通道（避免成为探测器）。 */
  acquire(ref: RunStartRef): Promise<{ ok: true; intent: AcquiredIntent } | { ok: false }>;
}

export interface PageScan {
  readonly jobId: string;
  /** 当前页的 canonical origin（https://host[:port]，无路径）——claim 的目标复核输入。 */
  readonly canonicalOrigin: string;
  readonly fieldKeys: readonly string[];
  readonly scanDigest: string;
  /**
   * 本页题目身份派生出的 claim key（`question:q…`，只有摘要不含题干）。
   *
   * 缺省 = 本次扫描没有可复用的题目面，凭证里的记忆键因此一个都对不上、
   * 一个都不会写——fail-closed 的默认值。
   */
  readonly questionKeys?: readonly string[];
}

export interface PageScanner {
  /**
   * intent 一并入参：真实现按已验签 claims 的批准目标定位要扫哪个 tab
   * （§5.5.2——扫描的必须是批准目标所在页面，不是"当前活跃页"）。
   */
  scan(ref: RunStartRef, intent: AcquiredIntent): Promise<PageScan | null>;
}

/** claim 成功后服务端授予的执行范围（原型收窄自 ClaimedExecutionIntentView）。 */
export interface ExecutionGrant {
  readonly missionId: string;
  readonly missionStepId: string;
  /** 已批准的档案字段键。记忆键**不在这里**——见 questionKeys。 */
  readonly fieldKeys: readonly string[];
  /**
   * 已批准的记忆答案键（PRODUCT-AUTHORITY §3 Reuse）。缺省／空 = 一条记忆都不填。
   *
   * 与 fieldKeys 分开是因为下游多处把 fieldKeys 当"十一个档案键"用：§5.8 档案
   * 取数的 header、runtime bundle 的 allowedFieldKeys 围栏、回执分母。混进去会
   * 让那些围栏当场对不上，而它们本来就不该认识第二类键。
   */
  readonly questionKeys?: readonly string[];
  /** 动作面（§5.5.4：动作不在其中 → fail-closed）。档位 L1 票据只会含 FILL。 */
  readonly allowedActions: readonly string[];
  /** 服务端核销返回的 lease 标识——kernel 铸 Intent 票据的信任根（仅标识无值）。 */
  readonly executionLease: string;
  /** Unix 秒；lease 到期后不得再写（真实现为 leaseExpiresAt RFC3339）。 */
  readonly leaseExpiresAt: number;
  /** 回执收口（§5.7）的三个绑定值，全部源自已验签 claims——只有 id/hash。 */
  readonly intentVersion: number;
  readonly planDigest: string;
  readonly jobIdentityHash: string;
  /** §5.8 档案取数的绑定值（同样源自已验签 claims）：响应必须与之完全相等。 */
  readonly fieldSchemaVersion: number;
  readonly profileSnapshot: {
    readonly revision: string;
    readonly deletionEpoch: string;
    readonly snapshotDigest: string;
  };
}

export interface IntentClaimer {
  claim(request: {
    intent: AcquiredIntent;
    actualOrigin: string;
    actualFieldKeys: readonly string[];
    /** 本页题目派生出的记忆键；缺省 = 本页没有可复用的题。 */
    actualQuestionKeys?: readonly string[];
    scanDigest: string;
  }): Promise<
    | { ok: true; grant: ExecutionGrant }
    | { ok: false; code: 'INTENT_REJECTED' | 'RESCAN_MISMATCH' }
  >;
}

export interface FillProgress {
  onOutcome(outcome: ReceiptFieldOutcome): void;
  /**
   * 需要用户处理的字段（三分语义，channel.ts）。IN_PAGE_ACTION 不带
   * fieldKey（不给页面外泄露定位信息）；另两类带 key 便于 Chat 定位提问。
   */
  onNeedsUserInput?(kind: NeedsUserInputKind, fieldKey?: string): void;
  shouldStop(): boolean;
}

export interface FieldFiller {
  /** scan 一并入参：执行必须绑定 claim 时那一次扫描（scanDigest 是绑定键）。 */
  fill(
    grant: ExecutionGrant,
    scan: PageScan,
    progress: FillProgress,
  ): Promise<readonly ReceiptFieldOutcome[]>;
}

/**
 * §5.7 回执上行（扩展→后端直报）。失败只出诊断码——上传不阻塞通道回执。
 *
 * claim 成功后的**每条**退出路径都必须上传一次（含用户点停/断连）：
 * 取消 ≠ 不报告——契约把取消后的 lease 标成 receipt-only，专等这份回执
 * 收口；已发生的页面写入是事实，fail-closed 约束的是"不再继续写"，
 * 不是"不报告写过的"。
 */
export interface ReceiptUploader {
  upload(input: {
    grant: ExecutionGrant;
    receipt: RunReceiptSummary;
    /** Unix 秒（run 开始时刻；finishedAt 在 receipt 里）。 */
    startedAt: number;
    /** 用户点停/断连收口 → true（整单 outcome 报 CANCELLED）。 */
    cancelled: boolean;
  }): Promise<void>;
}

export interface CoordinatorDeps {
  transport: ChannelTransport;
  acquirer: IntentAcquirer;
  scanner: PageScanner;
  claimer: IntentClaimer;
  filler: FieldFiller;
  /** 缺省 = 不上传（原型/测试）；真实现 = receiptClient。 */
  receiptUploader?: ReceiptUploader;
  /** 注入时钟便于测试 lease 过期；默认真实时钟（Unix 秒）。 */
  now?: () => number;
  newRunId?: () => string;
  /** 畸形入站的诊断出口——只给稳定码，绝无消息内容（铁律 1/2）。 */
  onProtocolError?: (code: ChannelErrorCode) => void;
}

export interface RunCoordinator {
  dispose(): void;
}

const V = CHANNEL_PROTOCOL_VERSION;

export function createRunCoordinator(deps: CoordinatorDeps): RunCoordinator {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let runSeq = 0;
  const newRunId = deps.newRunId ?? (() => `run_${++runSeq}`);
  const stopRequested = new Set<string>();
  let disposed = false;

  function stopWith(runId: string, code: ChannelErrorCode): void {
    deps.transport.send({ v: V, kind: 'run/stopped', runId, code });
  }

  async function handleStart(ref: RunStartRef): Promise<void> {
    const runId = newRunId();
    try {
      await runStart(ref, runId);
    } catch {
      // 依赖按接口约定该回 Result 而不是抛；真抛了也必须有 run/stopped 收尾，
      // 且绝不读 Error 本体（message/stack 可能携带 URL/令牌片段——铁律 1/2）。
      stopWith(runId, 'RUN_ABORTED');
    }
  }

  async function runStart(ref: RunStartRef, runId: string): Promise<void> {
    const startedAt = now();
    // 接收确认：卡片从第一帧就拿到权威 runId（评审 Important 1）。
    deps.transport.send({
      v: V,
      kind: 'run/accepted',
      clientRequestId: ref.clientRequestId,
      runId,
      missionId: ref.missionId,
      missionStepId: ref.missionStepId,
    });
    const progress = (
      step: 'VERIFYING_INTENT' | 'SCANNING' | 'PLANNING' | 'FILLING' | 'VERIFYING' | 'DONE',
      jobId: string,
      filled: number,
      total: number,
    ) => deps.transport.send({ v: V, kind: 'run/progress', runId, jobId, step, filled, total });

    // ① 自领凭证（JWS 从后端直达扩展隔离环境，绝不经 chat/网页通道）。
    progress('VERIFYING_INTENT', '', 0, 0);
    const acquired = await deps.acquirer.acquire(ref);
    if (!acquired.ok) return stopWith(runId, 'INTENT_REJECTED');
    if (stopRequested.has(runId) || disposed) return stopWith(runId, 'RUN_ABORTED');

    // ② 先扫描：claim 需要 actualFieldKeys + scanDigest 作为服务端比对的输入。
    progress('SCANNING', '', 0, 0);
    const scan = await deps.scanner.scan(ref, acquired.intent);
    if (!scan) return stopWith(runId, 'RESCAN_MISMATCH');
    if (stopRequested.has(runId) || disposed) return stopWith(runId, 'RUN_ABORTED');

    // ③ 服务端原子 claim：一次性核销 + 权威比对，通过才有 lease。
    const claimed = await deps.claimer.claim({
      intent: acquired.intent,
      actualOrigin: scan.canonicalOrigin,
      actualFieldKeys: scan.fieldKeys,
      ...(scan.questionKeys === undefined ? {} : { actualQuestionKeys: scan.questionKeys }),
      scanDigest: scan.scanDigest,
    });
    if (!claimed.ok) return stopWith(runId, claimed.code);
    const grant = claimed.grant;

    // claim 一旦成功，lease 就在服务端记了账——之后的每条退出路径都要
    // 上传一次收口回执（取消也要报：审计 2026-08-14 [0]）。
    let receiptSettled = false;
    const uploadReceipt = (outcomes: readonly ReceiptFieldOutcome[], cancelled: boolean) => {
      receiptSettled = true;
      const filled = outcomes.filter((outcome) => outcome.ok).length;
      const receipt: RunReceiptSummary = {
        runId,
        jobId: scan.jobId,
        missionId: grant.missionId,
        missionStepId: grant.missionStepId,
        filled,
        total: grant.fieldKeys.length,
        outcomes,
        // 本通道是填写摘要：档位 L1 恒停在提交前；提交类状态只来自后端回执。
        submission: 'NOT_SUBMITTED',
        finishedAt: now(),
      };
      void deps.receiptUploader?.upload({ grant, receipt, startedAt, cancelled }).catch(() => {});
      return receipt;
    };

    // claim 一旦核销，异常逃逸也不豁免回执义务（审计 2026-08-15）：
    // catch 里绝不读 Error 本体（铁律 1/2），已上报过则不重复。
    try {
      if (now() >= grant.leaseExpiresAt) {
        uploadReceipt([], true);
        return stopWith(runId, 'INTENT_REJECTED');
      }
      // claim 往返是"授权生效瞬间"的检查点：断连/点停期间完成的 claim
      // 绝不启动填写（审计 2026-08-13；特征测试锁死）。
      if (stopRequested.has(runId) || disposed) {
        uploadReceipt([], true);
        return stopWith(runId, 'RUN_ABORTED');
      }

      progress('PLANNING', scan.jobId, 0, grant.fieldKeys.length);
      let filled = 0;
      let inputSeq = 0;
      // CHAT_ANSWER/SENSITIVE_CONFIRM 需要 chat 侧交互喂给下一次 run——
      // 本次 run 不得再宣告 DONE（channel.ts 收口状态机；评审 Blocking 1）。
      let chatInteractionRequired = false;
      const outcomes = await deps.filler.fill(grant, scan, {
        onOutcome: (outcome) => {
          if (outcome.ok) filled += 1;
          progress('FILLING', scan.jobId, filled, grant.fieldKeys.length);
        },
        onNeedsUserInput: (kind, fieldKey) => {
          inputSeq += 1;
          // 稳定关联号：T2 串起问题卡 ↔ 后端材料面回答 ↔ 下一次 run。
          const inputRequestId = `${runId}_input_${inputSeq}`;
          if (kind !== 'IN_PAGE_ACTION') chatInteractionRequired = true;
          // IN_PAGE_ACTION 的约定由 filler 侧保证（不传 fieldKey）；这里原样转发。
          deps.transport.send(
            fieldKey === undefined
              ? { v: V, kind: 'run/needs-user-input', runId, inputRequestId, inputKind: kind }
              : { v: V, kind: 'run/needs-user-input', runId, inputRequestId, inputKind: kind, fieldKey },
          );
        },
        shouldStop: () => stopRequested.has(runId) || disposed || now() >= grant.leaseExpiresAt,
      });
      if (stopRequested.has(runId) || disposed) {
        // 通道侧停止收尾；已发生的写入照实上报（outcome=CANCELLED）。
        uploadReceipt(outcomes, true);
        return stopWith(runId, 'RUN_ABORTED');
      }
      // 执行期间 lease 到期（评审 中2）：写入窗口关了就不再宣告 DONE——
      // 已发生的写入照实直报后端，通道以 INTENT_REJECTED 收尾。
      if (now() >= grant.leaseExpiresAt) {
        uploadReceipt(outcomes, false);
        return stopWith(runId, 'INTENT_REJECTED');
      }
      // CHAT_ANSWER/SENSITIVE_CONFIRM 收口（评审 Blocking 1）：本次 run 到此
      // 为止——不发 DONE/填写摘要（"需要回答"与"已完成"不同屏矛盾），已发生
      // 的写入照实直报后端；用户在 chat 完成交互后由 chat 发起新 run。
      if (chatInteractionRequired) {
        uploadReceipt(outcomes, false);
        return stopWith(runId, 'USER_ACTION_REQUIRED');
      }

      progress('VERIFYING', scan.jobId, filled, grant.fieldKeys.length);
      progress('DONE', scan.jobId, filled, grant.fieldKeys.length);
      // §5.7 直报与通道回执并行、不互相阻塞；上传失败由 uploader 自己出
      // 诊断码（幂等 clientReceiptId 保证重试安全，重试队列 = 后续扩项）。
      const receipt = uploadReceipt(outcomes, false);
      deps.transport.send({ v: V, kind: 'run/receipt', runId, receipt });
    } catch (error) {
      if (!receiptSettled) uploadReceipt([], true);
      throw error;
    }
  }

  const unsubscribe = deps.transport.onMessage((raw) => {
    if (disposed) return;
    const parsed = parseChannelMessage(raw);
    if (!parsed.ok) {
      deps.onProtocolError?.(parsed.code);
      return;
    }
    const message = parsed.value;
    if (message.kind === 'run/start') {
      void handleStart({
        clientRequestId: message.clientRequestId,
        missionId: message.missionId,
        missionStepId: message.missionStepId,
        missionRevision: message.missionRevision,
      });
    } else if (message.kind === 'run/stop') {
      stopRequested.add(message.runId);
    } else if (message.kind === 'channel/ping') {
      // 心跳应答：执行中也要回——回不回得动本身就是 SW 的活性信号。
      deps.transport.send({ v: V, kind: 'channel/pong', seq: message.seq });
    }
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
