import { APPLY_FIELD_KEYS } from '@edaix/apply-kernel/contracts';
import type { GestureRoot } from '@edaix/apply-kernel/grant';
import type { ApplyPolicy } from '@edaix/apply-kernel/policy';
import { fillFromGrant, type KernelFillInput } from './kernelFiller';


/**
 * 无 mission 的填写：用户站在**任何一家**我们认得的申请页上，按一下 Autofill，
 * 就用他自己已保存的档案把这张表填上。
 *
 * ## 为什么可以不要 mission
 *
 * 绑 mission 那条路（`fillFromGrant` + 服务端核销的 lease）证明的是
 * 「用户在 chat 里批准了**这个岗位、这些字段、这个档位**」。它存在的理由是
 * **代表用户对一个岗位做一次申请**——那是一次对外的、有后果的动作。
 *
 * 这条路要做的是另一件事：**把他自己的资料填进他自己正在看的表**。没有岗位
 * 身份要主张，没有回执要归档，没有申请要记账。所以它的信任根也不必是服务端
 * 的授权，而是 `mintAuthority` 认的那一个——**用户在我们自己浮层里的真实点击**：
 *
 *   isTrusted            页面 JS 造不出来（浏览器保证）
 *   事件来自我方 shadow   页面 JS 够不到（closed shadow root）
 *
 * 两个条件合起来，等价于「这个人此刻确实按了我们的按钮」。对「填我自己的资料」
 * 这件事，这就是完整的授权。
 *
 * ## 这条路**不**放松的东西
 *
 * · 永不提交。`.submit(` / `.requestSubmit(` 在产物字节上就没有（RULE-EXT-NEVER-SUBMIT）。
 * · 厂商闸照旧：policy.vendors 关着的厂商一个字都不写。
 * · 能力位照旧：他人信息、EEO、工作授权、富文本、加行——出厂全是 false，
 *   要后端按策略下发才开。所以这条路填的就是姓名、邮箱、电话、地址那一类
 *   **他自己的、非敏感的**字段。
 * · 逐项写入后读回核对照旧，填不上的照旧如实标出来。
 *
 * ## 票为什么不在这里铸
 *
 * 票据要绑 `plan.fingerprint`，而 fingerprint 是**每建一份计划换一个新随机数**。
 * 在这里建一份计划铸票、`fillFromGrant` 里再建一份去跑，两个 nonce 必然不同，
 * runner 第一行就判 `PLAN_STALE`——零写入，还一个异常都不抛。所以凭证原样传下去，
 * 由真正要跑的那一份计划铸票（见 `KernelFillInput.gesture`）。
 *
 * ## 「这是不是真点击」为什么也不在这里判
 *
 * 判不了了。走到这里之前是一串 await（问后台要授权、要档案、解运行时、扫这一页），
 * 而 `event.composedPath()` 在事件派发结束的那一刻就返回空数组——那时再问
 * 「来自哪个 shadow」必然判否，不是因为点击不成立，是因为问不出来。
 * 所以判定挪回点击当下（`captureTrustedShadowGesture`），这里收的是那张凭证。
 *
 * ## 字段面为什么是全部档案键
 *
 * 绑 mission 那条路里 `grant.fieldKeys` 是**用户在 chat 里逐项批准过的**子集，
 * 所以要围栏。这里没有那一层批准，围栏也就无从谈起——但它同时也不需要：
 * 能写的本来就只有他自己的档案，而他按下 Autofill 就是在说「用我的资料填」。
 * 真正的约束在能力位和策略上，不在这份键表上。
 *
 * 结构化集合（P1-8a）同理：教育 / 经历是他自己确认过的资料（worker 只投影确认过的事实），
 * `collections` 原样传下去，行内角色由 `fillFromGrant` 在写入面里放行；第 1 行取第 1 段。
 */
export interface GestureFillInput extends Omit<KernelFillInput, 'grant' | 'gesture' | 'policy'> {
  /**
   * 用户那一次点击的**凭证**，在点击当下取（`captureTrustedShadowGesture`）。
   *
   * 不是事件本身：走到这里之前全是 await，而 `composedPath()` 派发一结束就空了，
   * 那时再问「来自哪个 shadow」必然判否——不是因为点击不成立，是因为问不出来。
   *
   * 连填（2026-09-28）翻到的那几页，这里是那一下点击开出的一轮连填发给这一页的凭证（不是点击，见内核 `openAdvanceRun`）。
   */
  readonly proof: GestureRoot;
  /**
   * 准许写什么。**必填，没有默认值**。
   *
   * 这里曾经写 `input.policy ?? createBundledApplyPolicy()`。那个默认值有两个
   * 坏处，而且都是静默的：
   *
   * 1. 包内 policy 的 `notAfter` 是**构建时刻 + 30 天**。商店包装满三十天之后
   *    每一次手势填写都在 runner 里判 `POLICY_DISABLED`，零写入、零报错。
   * 2. 它绕开了 `execution-runtime-bundle-wiring` 那道闸。那道闸盯的是内容脚本
   *    不许出现 `createBundledApplyPolicy`——可默认值写在这里，等于内容脚本
   *    隔着一个模块照样用上了包内策略。
   *
   * 所以调用方必须把后端下发的那一份交进来（`fillPolicy`），
   * 取不到就根本不该走到这一步。
   */
  readonly policy: ApplyPolicy;
}

export type GestureFillRefusal = 'GESTURE_UNTRUSTED' | 'GESTURE_FOREIGN';


type FillOutcomes = Awaited<ReturnType<typeof fillFromGrant>>;

export type GestureFillResult =
  | Readonly<{ ok: true; outcomes: FillOutcomes }>
  | Readonly<{ ok: false; code: GestureFillRefusal }>;

export async function fillFromGesture(input: GestureFillInput): Promise<GestureFillResult> {
  const now = input.now ?? (() => Date.now());

  const outcomes = await fillFromGrant({
    ...input,
    gesture: input.proof,
    now,
    // 合成一份本地 grant。`fillFromGrant` 只读这五项，mission 那几个它一次都
    // 不读（它们是回执用的，而这条路不产生回执）。
    grant: {
      missionId: '',
      missionStepId: '',
      // 简历栏的键不在档案键表里（APPLY_ENTRY_KEYS 才有它）：只有接缝在——也就是
      // 后端已经证实收件人、报了文件名（P1-4，resumeSeam.ts）——才把它放进写入面，
      // 否则一栏都不多。
      fieldKeys: [
        ...APPLY_FIELD_KEYS,
        ...(input.resume === undefined ? [] : ['resumeFile' as const]),
        // 求职信（2026-09-24）同理：任务材料入口交来了正文才放进写入面。
        ...(input.coverLetter === undefined ? [] : ['coverLetter' as const]),
      ],
      allowedActions: ['FILL'],
      // 票由手势铸，`expiresAt` 因此来自 `mintAuthority` 自己的 TTL；这两项
      // 只喂给那道「lease 过期了没有」的逐写入检查，所以给一个不早于票据的窗口。
      executionLease: 'gesture',
      leaseExpiresAt: Math.floor(now() / 1000) + 3600,
      intentVersion: 0,
      planDigest: '',
      jobIdentityHash: '',
      fieldSchemaVersion: 0,
      profileSnapshot: { revision: '0', deletionEpoch: '0', snapshotDigest: '' },
    },
  });
  return { ok: true, outcomes };
}
