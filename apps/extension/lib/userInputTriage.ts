/**
 * NEEDS_USER_INPUT 的三分语义（T10 验收 ⑤）。
 *
 * T10 卡片逐字：「契约与转发层齐、收口分流真被锁，但**唯一的真实生产者只产出
 * 一种**：`kernelFiller.ts` 只发 `IN_PAGE_ACTION`；`CHAT_ANSWER` /
 * `SENSITIVE_CONFIRM` 全仓只出现在契约常量、coordinator 透传分支、mock filler
 * 测试里。」
 *
 * 后果很具体：一道「期望薪资多少」的题，今天被告知"去页面上自己填"——而它本该
 * 在 chat 里问一次、答案按作用域记住、下次直接代填（PD-2026-08-18-PROFILE-QUESTION-MODEL
 * 的 `AnswerScopeRef`：USER/REGION/ROLE/COMPANY/JOB/APPLICATION）。每次都推回页面，
 * 等于把这条产品能力整个关掉。
 *
 * ## 分错档比不分档更危险
 *
 * 契约头注逐字：`CHAT_ANSWER` / `SENSITIVE_CONFIRM` **必收口**——发出去，本轮 run
 * 立刻停在 `USER_ACTION_REQUIRED`，不再进 DONE、不出回执。所以把一个本该
 * 「你去页面上勾一下」的东西误判成 CHAT_ANSWER，会让整轮在**还没填任何字段之前**
 * 就停掉。`IN_PAGE_ACTION` 不收口，run 照常跑完。
 *
 * 判据是**这个问题该在哪儿被回答**，不是"它有多重要"。
 */

import type { ApplyErrorCode } from '@edaix/apply-kernel/contracts';
import type { NeedsUserInputKind } from '@edaix/contracts/draft';

export interface TriageInput {
  readonly reason: ApplyErrorCode;
  /** canonical 档案键；认不出的字段是 null。 */
  readonly key: string | null;
  /**
   * chat 侧的「问答 → 存回档案 → 新一轮填上」闭环是否已经接通。
   *
   * **默认关，fail closed**（`RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED`）。
   *
   * `CHAT_ANSWER` 按契约**必收口**：run 停在 `USER_ACTION_REQUIRED`、不出 DONE。
   * 那条闭环没接通之前发它，用户得到的是一个停下来、而且**没人问他任何问题**
   * 的 run——比今天「跑完 + 告诉你去页面上填」更糟。真机彩排 2026-08-21 实测
   * 抓到过这一幕。
   *
   * 闭环归 T2（问题卡与作答回路）与 T3（答案写回 Profile）。它们落地之后把这里
   * 打开即可，分类判据本身不用改。
   */
  readonly chatAnswerEnabled?: boolean;
}

export interface TriageVerdict {
  /** null = 不提示。undefined 不该出现——闭集穷举测试锁死。 */
  readonly kind: NeedsUserInputKind | null;
  /** 只有 CHAT_ANSWER / SENSITIVE_CONFIRM 携带；IN_PAGE_ACTION 不带任何定位信息（契约逐字）。 */
  readonly fieldKey?: string;
}

/**
 * 绝不打扰用户的原因码。
 *
 *  · `HONEYPOT` —— 提示等于把陷阱指给用户，填了作废整份申请；
 *  · `OTHER_PERSON` —— 推荐人／紧急联系人，不是申请人的信息；
 *  · `SENSITIVE_OPT_OUT` —— 用户主动关掉了这一类，再问一遍就是把他关掉的东西推回来；
 *  · `DUPLICATE_FIELD` —— 同节同键仲裁掉的落选控件，胜出的那个已经处理了；
 *  · `NOT_EMPTY` —— 页面上本来就有内容，不用管。
 */
const SILENT: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>([
  'HONEYPOT',
  'OTHER_PERSON',
  'SENSITIVE_OPT_OUT',
  'DUPLICATE_FIELD',
  'NOT_EMPTY',
]);

/**
 * 该在 chat 里问的：答案是一句话，**且能存下来复用**。
 *
 * 名单刻意短。它是**收口**的——每多一条，就多一种"本该页面上弄一下的东西
 * 把整轮 run 提前收掉"的可能。
 *
 *  · `JOB_DEPENDENT` —— 期望薪资／到岗时间／搬迁意愿：f(候选人 × 岗位)，
 *    答一次按 scope 复用（工作授权那一半已被 IRONCLAD-5-SPLIT 改判为乙档）；
 *  · `NO_VALUE` —— 档案里没有这一项：问一次、写回档案，下次就不用问了。
 */
const CHAT_ANSWERABLE: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>([
  'JOB_DEPENDENT',
  'NO_VALUE',
]);

export function triageNeedsUserInput(input: TriageInput): TriageVerdict {
  if (SILENT.has(input.reason)) return { kind: null };

  // 没有 canonical key 就问不出去：答案存不回档案，chat 里问了也接不住。
  // 「Current company」这类今天 key 恒为 null（11 键档案装不下，归 T3 的 CAP-AF-018）。
  if (input.chatAnswerEnabled === true && CHAT_ANSWERABLE.has(input.reason) && input.key !== null) {
    return { kind: 'CHAT_ANSWER', fieldKey: input.key };
  }

  // ⚠️ `MANUAL_ONLY` 语义上属于 SENSITIVE_CONFIRM（铁律 5 乙档：EEO／工作授权／
  // 「信息属实」，预填 + 逐条阻塞放行），但今天**不能这么发**：
  //  ① 乙档三道闸一道没解（法律责任 T21 / 阻塞确认条 runtime / 写入路径授权链，
  //     登记为 CAP-AF-024），我们既没有值也没有写入路径；
  //  ② `MANUAL_ONLY` 今天同时承载当前硬拒绝闭集（密码／验证码／实质授权）与乙档，
  //     wire 上分不出来（guards.ts 头注逐字）。密码、背景调查、仲裁、信用／药检授权
  //     是 default-off pending proposal；验证码、营销等仍永久人工，但批准前行为完全相同。
  // 发 SENSITIVE_CONFIRM 等于承诺"我有值、你点一下我就写"——做不到的事不承诺。
  // 解闸之前 fail closed 回页面动作。
  return { kind: 'IN_PAGE_ACTION' };
}
