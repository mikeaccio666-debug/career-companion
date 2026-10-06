/**
 * FieldFiller 的 kernel 真实现（刀五收尾件）：拿服务端 claim 授予的 grant
 * 铸 Intent 票据（apply-kernel/grant 的第二条铸造路径），跑完整执行链
 * buildApplyPlan → mintIntentAuthority → runApplyPlan，产出通道回执结果。
 *
 * 与 kernelScanner 同属**内容脚本**环境（页面 DOM 所在地）；背景 SW 的
 * 协调器经内部消息桥调它（桥 + profile 的鉴权取数 = 刀六，与 HTTP 客户端
 * 同批——它们都是"把协调器的接口接到真实传输上"）。
 *
 * Data-L1：回执只有 key/ok/原因码。kernel 结果里的 label 在此丢弃，
 * 字段值从头到尾不出 runner。
 */

import {
  buildAuditView,
  mergeAuditViews,
  overlayAuditView,
  type AuditOverlayPlacement,
  type AuditRow,
  type AuditView,
} from '@edaix/apply-kernel/audit';
import {
  buildAnswerPlan,
  buildApplyPlan,
  buildFillPlan,
  capabilitiesForPlan,
  SIGN_ON_BEHALF_ENTRY_KEY,
  type QuestionAnswer,
} from '@edaix/apply-kernel/engine';
import {
  describeQuestion,
  questionIdentity,
  type QuestionDescription,
  type QuestionIdentity,
} from '@edaix/apply-kernel/questions';
import { questionClaimKeyFor } from './questionClaimKey';
import { runApplyPlan, type ApplyRunSummary, type RunApplyPlanInput } from '@edaix/apply-kernel/runner';
import { createUndoJournal } from '@edaix/apply-kernel/undo';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import {
  gestureRootRemainingMs,
  mintAuthority,
  mintAuthorityFromGesture,
  mintIntentAuthority,
  mintRowActionAuthorityFromGesture,
} from '@edaix/apply-kernel/grant';
import {
  MAX_ROW_ADDS,
  clickAddRow,
  clickSaveRow,
  collectionsForRow,
  describeRowAdds,
  entryEditorState,
  entryPlanSlice,
  presentRowCounts,
  remainingEntries,
  rowAddAnchor,
  rowElementAt,
  rowNeedsSave,
  rowPlanSlice,
  rowSaveControl,
  type RowCollection,
  type RowPlan,
} from '@edaix/apply-kernel/rowActions';
import type { GestureRoot } from '@edaix/apply-kernel/grant';
import type { ApplyErrorCode, ApplyPlan, ApplyPlanEntry, ApplyWriteResult } from '@edaix/apply-kernel/contracts';
import type { HoneypotGeometry } from '@edaix/apply-kernel/guards';
import type { SexualOrientationAnswer, TransgenderAnswer } from '@edaix/apply-kernel/selfIdentificationAnswers';
import {
  employerContactKinds,
  SIGNING_CONSENT_KINDS,
  type EmployerContactAnswer,
  type SignOnBehalfKind,
} from '@edaix/apply-kernel/signOnBehalf';
import type { HostValidationSignals } from '@edaix/apply-kernel/verify';
import type { ApplyProfileDraft } from '@edaix/apply-kernel/profileDraft';
import type { ApplyProfileCollections } from '@edaix/apply-kernel/profileCollections';
import { COLLECTION_FIELD_ROLES } from '@edaix/apply-kernel/collectionProjection';
import type { ExecutionGrant, FillProgress } from '@edaix/agent-channel';
import type { NeedsUserInputKind } from '@edaix/contracts/draft';
import { triageNeedsUserInput } from './userInputTriage';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import type { KernelPageScan } from './kernelScanner';
import type { RuntimeExecutionAuthorization } from './executionRuntimeAuthority';
import type { ApplyFieldDescriptor, ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import { captureScanRootObservationTargets } from '@edaix/apply-kernel/scanRoot';
import { hostFieldHasValue } from './dock/hostField';
import { waitForHostQuiet, watchTrustedEdits, type HostQuietResult } from './hostSettle';

export interface KernelFillInput {
  readonly grant: ExecutionGrant;
  /**
   * 无 mission 那条路的信任根：**用户在我们自己浮层里的那一次真实点击**。
   * `mintAuthority` 验的是 `isTrusted` 加「事件来自我方 shadow」，页面 JS
   * 两者都伪造不了。给了它就用手势铸票，不给就照旧从服务端核销的 lease 铸。
   *
   * ⚠️ 传进来的是**点击当下取到的凭证**，不是事件本身、也不是铸好的票据。
   * 事件本身在这里已经问不出「来自哪个 shadow」了——`composedPath()` 派发一结束
   * 就返回空数组，而这条路上铸票之前全是 await（见 grant.ts 的
   * `captureTrustedShadowGesture`）。这不是风格问题：票据要绑
   * `plan.fingerprint`，而 fingerprint 是**每建一份计划就换一个新随机数**
   * （engine.ts `newPlanFingerprint`）。调用方先建一份计划铸票、这里再建一份
   * 去跑，两个 nonce 必然不同，runner 第一行 `auth.fingerprint !== plan.fingerprint`
   * 必然成立 → 整轮 `PLAN_STALE`、零写入、且**全程无异常**（2026-09-17 在真实
   * Greenhouse 页上实测：浮层画出「填写需要核对」，44 个控件一个值都没有）。
   *
   * 所以票必须在这里、对着**真正要跑的那份计划**铸。两条路因此只差
   * 「凭什么说用户要填」这一件事，其余逐字同源。
   *
   * 连填（2026-09-28）：也可以是那一下点击开出的一轮连填里「这一页」的凭证（`AdvanceRunPageProof`）——
   * 不是点击，铸票走同一个口子、同样的收窄；它活多久由那一轮说了算（见内核 `openAdvanceRun`）。
   */
  readonly gesture?: GestureRoot;
  /** 必须是 claim 前那次扫描的同一份产物——descriptor 里的活元素引用还在。 */
  readonly scan: KernelPageScan;
  readonly profile: ApplyProfileDraft;
  /**
   * 结构化档案（教育 / 经历 / 技能，P1-8a）。与扁平档案是**两份契约**（见 engine.ts 的
   * `ApplyPlanOptions.collections`）：行内格（`education.school` 这类角色）从这里按行取值，
   * 第 1 行取第 1 段。不给就等于「没有分段内容」——行内格一律 NO_VALUE，不猜。
   *
   * 写入面：grant 的 `fieldKeys` 是后端契约的扁平键，表达不了行内角色，所以交来集合的
   * 调用方就是在为它们担保——手势路由用户那一次点击担保（这是他自己确认过的资料，
   * worker 只投影确认过的事实）；mission 路在 JWS 能点名集合之前不该交它。
   */
  readonly collections?: ApplyProfileCollections;
  /**
   * 用户自己确认过、此刻有效的工作授权记录（2026-09-21 起手势路由 worker 从 Profile V2 投影）。
   * 内核只在题目点名国家、且恰好是有记录的那一个时直接写（2026-09-21 起：那条记录是用户自己填的）；
   * 面板预选、用户点头才写。不给就等于「没有记录」，这类题退回 JOB_DEPENDENT。
   */
  readonly workAuthorizations?: readonly Readonly<{
    regionCode: string;
    authorizedToWork: 'YES' | 'NO' | 'UNSPECIFIED';
    requiresSponsorship: 'YES' | 'NO' | 'UNSPECIFIED';
  }>[];
  /**
   * 岗位所在国家（ISO alpha-2），从申请卡片的地点确定性解出（P1-7）。工作授权题一个地方都没点名
   * 时按它答，且这是**唯一**仍走 PREFILLED_NEEDS_CONFIRMATION 的一档、面板写明「按岗位地点推断」。解不出恰好一个
   * 国家就别传。
   */
  readonly jobRegionCode?: string;
  /**
   * 岗位地点原文（2026-09-24，从页面或同站点详情页的 JobPosting 读出）。只给搬迁题：题目没写搬去哪儿时
   * （「Are you local to or willing to relocate?」）拿它对他住的城市与他列的搬迁城市。读不出就别传。
   */
  readonly jobLocation?: string;
  /**
   * 用户亲手存的推荐人（P1-9）与本次申请的公司名（来自申请卡片）。推荐人栏只在恰好有一条推荐到
   * 这家公司的记录时直接写姓名（2026-09-21 起不再等确认：那条记录是用户自己存的）。
   */
  readonly referrals?: readonly Readonly<{ name: string; company: string }>[];
  readonly jobCompany?: string;
  /**
   * 代填条款、声明与签名（2026-09-23）：worker 读到用户在资料页单独同意过当前文案版本才给 true（2026-09-28 起只有当前
   * 版本算数）。与生效策略里的 `sign-on-behalf` **同时**成立才代填；缺省 = 没同意。
   */
  readonly signOnBehalf?: boolean;
  /**
   * 资料里对「可以联系你现在的雇主吗？」的回答（2026-09-28）。那一类题照它答（只问以前的雇主或推荐人的题也照同一个
   * 回答答），不看同意书，但照样只在生效策略放行 `sign-on-behalf` 时才答；缺省 = 没答，交还本人。
   */
  readonly employerContact?: EmployerContactAnswer;
  /** 签名日期用的「当天」（用户本地时区的 ISO `YYYY-MM-DD`）；不给就不代填签名日期。 */
  readonly signingDate?: string;
  /**
   * 用户本地的「当天」（ISO `YYYY-MM-DD`，2026-10-04）：按资料推「工作年限」与「你现在在读吗」要用（内核不碰时钟）。
   * 不给就不答这两类。
   */
  readonly today?: string;
  /**
   * 资料里「出差最多能接受多少？」确认过的回答（2026-10-04，argoland #738）：工作时间的百分比上限（0／25／50／75／100）。
   * 出差题照它答；缺省 = 没答，出差题交还本人。
   */
  readonly travelPercentMax?: 0 | 25 | 50 | 75 | 100;
  /**
   * 用户在门户对「是否拉美裔」亲口的回答（2026-09-23）。「Are you Hispanic/Latino?」照它答；
   * 自我认同的能力位仍由生效策略决定。缺省 = 没答。
   */
  readonly hispanicLatino?: 'YES' | 'NO' | 'DECLINE';
  /**
   * 用户在门户对「是否跨性别」与性取向亲口的回答（2026-09-23）。跨性别题、性取向题照它答，
   * 「是否 LGBTQ+」由这两句推出；自我认同的能力位仍由生效策略决定。缺省 = 没答。
   */
  readonly transgenderStatus?: TransgenderAnswer;
  readonly sexualOrientation?: SexualOrientationAnswer;
  readonly progress: FillProgress;
  /**
   * 加行（P1-8b）：档案里的段数多于页面上的行数时，按厂商声明的「加一行」控件加行，加完重扫、
   * 只填新加的那一行，逐段推进。四道闸一条不少：手势路（专用票从同一次点击铸）、交来了集合、
   * 远程策略放行 `manage-rows`、调用方给了重扫手段——少一样就只填页面上已有的行。
   *
   * 不提供「加满再填」：每加一行页面结构就变，必须重扫。加不动（控件不见了、行数没涨、票据
   * 过期、重扫失败）就停在那里，已填的行都是完整的；停的原因记在审计里。
   *
   * 每一段要单独保存的区（规则声明了 `actions.save`，Workable 的「Update」；2026-09-24 负责人：全加全存）：
   * 每一段填完、回读过，再用同一次点击铸的保存票按那一段自己的保存钮，等编辑框收起才加下一段。存不上的那一段
   * 编辑框留着、单子上照实说还差什么，这个区这一轮不再加。
   *
   * 同一个 `rescan` 也是手势路「第二遍」的重扫手段（2026-09-23，见 fillFromGrant 里「第二遍」那一段）：
   * 第一遍里页面重渲染过、或第一遍写成过选择题（可能冒出了条件题），就在同一次点击里重扫一次、
   * 补填一次。不给它就没有第二遍。
   */
  readonly rowAdds?: Readonly<{
    /** 重新扫这一页；null = 这一页现在扫不出表单，加行与第二遍到此为止。 */
    rescan: () => Promise<KernelPageScan | null>;
    /** 点完「加一行」等宿主渲染多久再重扫；缺省 ROW_ADD_SETTLE_MS。 */
    settleMs?: number;
    /** 点完之后最多等新行出现多久（行数涨了就不再等）；缺省 ROW_ADD_APPEAR_CAP_MS。 */
    appearCapMs?: number;
  }>;
  /**
   * 附上简历之后等宿主安静下来的窗口（2026-09-24）：缺省连续 600 毫秒没有变动、最多 4 秒。
   * 注入只为测试不真等；生产上不传。
   */
  readonly hostSettle?: Readonly<{ quietMs?: number; capMs?: number }>;
  /** Immediate scan-generation invalidation supplied by the content entry. */
  readonly signal?: AbortSignal;
  /** Sealed DOM/shadow generation fence, rechecked between host interactions. */
  readonly scanStillCurrent?: () => boolean;
  /** 测试注入用；缺省 bundled policy（自带 30 天硬过期 + 厂商开关）。 */
  readonly policy?: ApplyPolicy;
  /** Production bridge binding; local rehearsal tests may omit it. */
  readonly runtimeAuthorization?: RuntimeExecutionAuthorization;
  readonly now?: () => number;
  /**
   * Optional resume supply seam (CAP-AF-053). Omission remains fail closed:
   * no seam, no file, and the resume field is reported as NO_VALUE.
   * `targetVerified` may only be true after the fresh runtime mapping and
   * verified canonical application target have both been revalidated; it must
   * never be inferred from hostname/DOM.
   *
   * 两条路各有自己的字节源（2026-09-21 起都有了）：mission 路由 background 取
   * mission 绑定的文件（`missionResumeFileClient`，bridge 上带 sha256）；手势路
   * 由 worker 向 argoland `resume-attachments`（#514/#534）先问询再释出，
   * `targetVerified` 只在后端 plan 答了 200 之后为真（`resumeSeam.ts`）。
   */
  readonly resume?: {
    readonly fileName: string;
    readonly targetVerified: boolean;
    readonly resolve: () => Promise<File | null>;
  };
  /**
   * 任务的求职信正文（2026-09-24，浮层任务接线）：只在这一页绑着用户在门户「开始申请」的任务、表单要
   * 一封求职信、worker 从任务材料入口取回了正文时才有。收件人已由后端核实为任务自己的申请页，内核只把它
   * 写进认得出的求职信文本框（空的才写），别的栏一概不碰。
   */
  readonly coverLetter?: KernelCoverLetterMaterial;
  /**
   * 中段屏：一轮**正在跑**的时候，逐栏亮起来（CAP-AF-063）。
   *
   * 与 `onAudit` 同一条本地通道、同一个边界：视图带着宿主标签，永不过桥。
   * 差别只在时机——`onProgress` 在这一轮开始时先交出整张单子（分母齐、一栏未亮），
   * 之后每结算一栏交一次；`onAudit` 交的是跑完之后那一份终局。
   *
   * 交出去的是完整 `AuditView` 而不是 `key → { label, required }`，是因为按 key
   * 把结果对回行正是 `audit.ts` 明文禁止的那件事（2026-08-22 修）：行内角色接进来
   * 之后，两段经历就是两个 `experience.company`，按 key 对回会把第 1 行的结果贴到
   * 每一行上——第 2 行明明写失败了，面板显示绿色"已填"。中段屏若自己拼一次，
   * 等于把那个 bug 请回到用户提交前唯一会看的那张单子上。
   *
   * ⚠️ 这是**进度**不是判决：还没轮到的条目在视图里按"这一轮没跑到"计。
   * 调用方只该读 label、required 与"确认填入"这一档，别拿它当失败清单。
   *
   * 第二个参数（2026-09-23）说的是还没结算的那几栏走到哪了：`current` 是正在写的那一栏的宿主
   * 控件，`written` 是值已经写进网页、还在等回读确认的那些。按控件对回行（`AuditRow.element`），
   * 不按 key——理由同上。
   */
  readonly onProgress?: (view: AuditView, live: KernelFillLive) => void;
  /**
   * 逐字段审计面板的出口（CAP-AF-063）。
   *
   * 刻意做成**回调**而不是并进返回值：`fillFromGrant` 的返回值要过桥进回执，
   * 而审计视图带着宿主标签与我们写入的值。本文件头注写死的那条纪律
   * （「回执只有 key/ok/原因码，label 在此丢弃」）不能因为多了个面板就破。
   * 回调在内容脚本里同步调用，这份视图从不离开页面所在的这个 realm。
   */
  readonly onAudit?: (audit: KernelFillAudit) => void;
  /**
   * chat 侧「问答 → 存回档案 → 新一轮填上」闭环是否已接通。默认关、fail closed。
   * 见 `userInputTriage.ts` 的 `chatAnswerEnabled` 头注。
   */
  readonly chatAnswerEnabled?: boolean;
  /**
   * 取回**已被批准复用**的记忆答案（PRODUCT-AUTHORITY §3 Reuse）。
   *
   * 只对 grant 点名的那些题调用；返回的答案与档案字段同一份计划、同一张票据写入，
   * 不需要用户再点一次。不注入、或对某题没有答案返回 = 那一条零写入（fail closed）——
   * 签发到填写之间用户可能已经忘掉这条记忆或关掉了自动带出。
   *
   * Data-L1：题干与选项只在本内容脚本与后台的第一方 API 之间流动，不进回执、不进日志。
   */
  readonly resolveRememberedAnswers?: (
    questions: readonly KernelRememberedQuestion[],
  ) => Promise<readonly Readonly<{ questionId: string; value: string }>[]>;
  /**
   * 手势填写路（P1-6）：没有 grant 点名的题，但用户在面板上打开了「自动带出我记住的
   * 答案」。为真时本页每一道可审阅的题都交给 `resolveRememberedAnswers`；答案仍只来自
   * 用户自己记住的那些，写入仍走同一份计划、同一张票据、同一本撤销日志。
   */
  readonly reuseRememberedAnswers?: boolean;
  /**
   * 手势路（2026-09-23，AI 代答用）：第一遍计划定下来、开写之前，同步交给调用方看一眼。AI 代答在这里挑出
   * 规则答不了、页面上还空着的题并发出请求——不 await，第一遍照常立刻开写。**不许抛**。
   */
  readonly onPlanned?: (plan: ApplyPlan, descriptor: ApplyFormDescriptor) => void;
  /**
   * 这一轮之后的那几次写入（AI 代答、「用 AI 写」）还算不算数：调用方说这一轮作废了（开了新的一轮、翻了页、
   * 撤销了、关了开关）就一个字不写。写之前与写的途中都会问。
   */
  readonly laterWritesCurrent?: () => boolean;
}

/** AI 代答写一次的结果：写成了几栏、写完之后的整张单子；或者一个稳定原因。 */
export type KernelAiWrite =
  | Readonly<{ ok: true; view: AuditView; written: number }>
  | Readonly<{ ok: false; code: ApplyErrorCode }>;

/** 审计视图里 AI 写成的那一行（浮层据此分组、画标记）。 */
export interface AiAnsweredAuditRow extends AuditRow {
  readonly aiAnswered: true;
}

/** 审计视图里用户自己答上的那一行（在浮层里点了一个选项、或填了一句，2026-09-28）：浮层写明是他答的。 */
export interface UserAnsweredAuditRow extends AuditRow {
  readonly userAnswered: true;
}

/**
 * 写入期没对上选项的选择题（2026-09-28）：页面上的真实选项就在那儿，用户在浮层里点一个就能答上。计划期跳过的题
 * 本来就能答（`REVIEWABLE_SKIP_REASONS`），这几类是写的时候才失手的，另起题号。
 */
export const DOCK_RETRY_REASONS: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>(['NO_OPTION_MATCH', 'AMBIGUOUS_OPTION', 'OPTIONS_INCOMPLETE']);

/** `writeAiAnswers` 的选项。 */
export interface KernelAiWriteOptions {
  /** 只填空栏（自动代答）。只有用户亲手按「生成」改写一栏已有的内容时才是 false：替换前的内容进撤销日志。 */
  readonly fillEmptyOnly: boolean;
  /** 给了就要求那一栏此刻的内容逐字等于它（按「生成」那一刻的样子）；等的时候用户自己动过就不写。 */
  readonly unchangedFrom?: string;
}

/** grant 点名、且本页上仍按同一身份找得到的一道题。 */
export interface KernelRememberedQuestion {
  readonly questionId: string;
  /** `question:q…`——题目身份摘要派生，与凭证里的 claim key 同一个。 */
  readonly claimKey: string;
  readonly question: QuestionDescription;
}

export { questionClaimKeyFor };

/** 一轮正在跑时、还没结算的那几栏的位置（只在本地，与审计视图同边界）。 */
export interface KernelFillLive {
  readonly current: Element | null;
  readonly written: ReadonlySet<Element>;
}

/**
 * 为这个岗位写的求职信（2026-09-27 起文字框与上传栏都给）：正文写进认得出的求职信文字框，PDF 挂到认得出的求职信
 * 上传栏。收件人已由后端核实为这一页（岗位库里的岗位，或任务自己的申请页）；内核只写空的那一栏，别的栏一概不碰。
 */
export interface KernelCoverLetterMaterial {
  readonly text?: string;
  /** 文件名先到（计划要它）；字节写到那一栏时才取，取不到就是 NO_VALUE。 */
  readonly file?: Readonly<{ fileName: string; resolve: () => Promise<File | null> }>;
}

/** 不进单子的那几种跳过（与审计视图的 HIDDEN_REASONS 同一张）：页面侧清点据此不把它们当「浮层已经在管」。 */
const UNSHOWN_SKIP_REASONS: ReadonlySet<string> = new Set(['HONEYPOT', 'SENSITIVE_OPT_OUT', 'DUPLICATE_FIELD']);

export interface KernelFillAudit {
  readonly view: AuditView;
  /**
   * 再问一次「我们填的还在不在」，返回一份修订过的视图（内核的
   * `ApplyRunSummary.recheck`，见那里的头注）。
   *
   * 轮内的延时复检只等 250 毫秒，挡不住**简历解析**那种服务端往返的宿主回写——
   * 2026-09-22 在 Lever 上实测是结算后约十二秒才把填好的地点清空。窗口一关，那
   * 一行就永远停在「已填」上。这里是面板把那句谎话收回去的唯一途径。
   *
   * 只读：不写 DOM、不碰还原票据。可反复调用，每次都从本轮的原始结论重新判。
   */
  readonly recheck: () => AuditView;
  /** 现在还有没有可还原的写入。面板用它决定摆不摆按钮。 */
  readonly canUndo: () => boolean;
  /**
   * 还原本轮写入。要用户在**我方浮层**里的真实点击——信任根与浮层内生的
   * 其他动作同源（grant.ts mintAuthority：isTrusted + eventComesFromShadow）。
   * 这里不自己造事件，只把面板交上来的那一下原样送进授权链。
   */
  readonly undoAll: (event: Event, shadowRoot: ShadowRoot) => Promise<void>;
  /** 档案计划跳过、可由用户审阅作答的题（题干与选项只在内容脚本与面板之间流动）。 */
  readonly questions: readonly QuestionDescription[];
  /**
   * 计划期已经替用户选好、只等他点头的答案（PREFILLED_NEEDS_CONFIRMATION，2026-09-21 起只剩按岗位地点推断的工作授权）：题目 id → 建议选项原文。
   * 自我认同 / 工作授权走这里——**不直接写**，面板预选，用户确认后经 `answer` 落笔。
   */
  readonly prefills: ReadonlyMap<string, string>;
  /**
   * 预填答案的来源说明，面板要写明，用户点头前看得见：按岗位地点推断的国家（P1-7）、
   * 来自用户保存的推荐人及其公司（P1-9）。
   */
  readonly prefillBasis: ReadonlyMap<string, Readonly<{ inferredRegionCode?: string; referralCompany?: string }>>;
  /**
   * 加行的账（P1-8b）：加了几行、替用户按保存存下了几段（2026-09-24，每一段要单独保存的区）、为什么停
   * （第一个让某个区或整轮停下的原因码）、档案里还有几段这一家落不下。没走加行 = null。
   */
  readonly rowAdds: Readonly<{ added: number; saved: number; stop: ApplyErrorCode | null; unreachable: RowPlan['unreachable'] }> | null;
  /**
   * 附上简历之后等宿主安静下来的那一段（2026-09-24）：怎么结束的、等了多久。这一次没附上简历、或不是
   * 手势路，就没有这一段（null）。只在本地：给测试台与诊断量额外的延迟。
   */
  readonly settle?: HostQuietResult | null;
  /**
   * 计划期跳过、不进单子的那几栏（2026-10-04）：判成蜜罐的、同节同键里落选的、他关掉的敏感类（审计视图的 HIDDEN_REASONS）。
   * 浮层不为它们摆「我们要填」的行；可页面侧清点（`readPageGaps`）不该把它们当「浮层已经在管」：Jobvite 自己画的单选，原生
   * radio 被样式藏起来，整组被判成蜜罐；Greenhouse 同一道题问了两遍，第二道当成重复落选——题目都明明白白摆在页面上、还空着。
   * 真的蜜罐题目也看不见，清点那一侧照旧不列。
   */
  readonly unshown?: readonly Element[];
  /**
   * 这一轮最后一次扫描认出的那几栏（2026-10-04）：加行（Workday 的教育、经历）之后会重扫，新加的那几行只在新的扫描里。
   * 页面侧清点按它判「浮层已经在管」，不按开填之前那一次。
   */
  readonly scanFields?: () => readonly ApplyFieldDescriptor[];
  /**
   * 把用户在面板里确认过的答案写进对应控件。信任根与撤销同源：用户在我方浮层里的
   * 真实点击铸一张新的写权限（新计划、新 fingerprint），写入进同一本撤销日志。
   * 写入仍在本轮的执行边界之内：外部 abort、runner 的 stop、lease 到期、扫描不再
   * 当前，任一成立即零写入；单凭一次点击不能重开已停止的一轮。
   *
   * 手势取证在**点击派发期间**同步完成（派发结束后 `composedPath()` 为空），随后才
   * 等待 `confirm`（调用方向服务端再确认）；确认为否、或确认期间边界变化，零写入。
   */
  readonly answer: (
    event: Event,
    shadowRoot: ShadowRoot,
    answers: readonly Readonly<{ questionId: string; value: string }>[],
    confirm?: () => Promise<boolean>,
  ) => Promise<readonly ApplyWriteResult[]>;
  /**
   * 「需要你」在浮层里当场答（2026-09-28）：这一栏（单子上那一行的元素）能不能由用户在浮层里答、是什么样的题（选项原文
   * 只在本地）。能答的是两类：计划期跳过、答案该由用户给的题（只能本人处理的 MANUAL_ONLY 除外），与写入期没对上选项的
   * 单选题（`DOCK_RETRY_REASONS`）。按规定留给本人的、已经填好的、说不出题面的，都是 null。答走 `answer`：同一条授权路，
   * 答上的那一格在复核视图里标 `userAnswered`。
   */
  readonly questionAt?: (element: Element) => QuestionDescription | null;
  /**
   * 手势路（2026-09-23，AI 代答用）：用一张点击凭证写一批答案——与记住的答案同一条路（`buildAnswerPlan`、
   * `question:<claim key>`），核对、审计行与撤销都一样；写成的那几栏在单子上标 `aiAnswered`，同一栏以最近
   * 一次写成的为准。元素是第一遍那一份扫描里的节点（第二遍重扫换掉的会认回来）。写入仍在这一轮的边界之内：
   * 外部 abort、lease 到期、扫描不再当前、`laterWritesCurrent` 说作废了，任一成立即零写入；凭证过了 30 秒
   * （`GESTURE_PROOF_TTL_MS`）就是 `GESTURE_EXPIRED`，一个字不写。
   */
  readonly writeAiAnswers?: (
    answers: readonly QuestionAnswer[],
    proof: GestureRoot,
    options: KernelAiWriteOptions,
  ) => Promise<KernelAiWrite>;
  /**
   * 手势路（2026-09-24）：整轮之后宿主把我们填好的栏**清空**了（Lever 附上简历约三秒后清掉 Current location），用同一张
   * 点击凭证按资料重填一次。只填被清空、用户没动过、没聚焦的那几栏；只一次；边界与 `writeAiAnswers` 相同，凭证过期就不写。
   * 没有这样的栏时答 `NOT_EMPTY`。
   */
  readonly repairReverted?: (proof: GestureRoot) => Promise<KernelAiWrite>;
  /**
   * 手势路（2026-09-27）：求职信晚到了——这一轮开填时还在写。用一张点击凭证（这一轮那一下还在 30 秒之内，或者用户
   * 按了「附上求职信」）只写求职信那几栏：文字框写正文、上传栏挂 PDF，空的才写，别的栏一概不碰。边界与
   * `repairReverted` 相同，凭证过期就是 `GESTURE_EXPIRED`；没有可写的求职信栏时答 `NOT_EMPTY`。
   */
  readonly attachCoverLetter?: (proof: GestureRoot, material: KernelCoverLetterMaterial) => Promise<KernelAiWrite>;
}

/**
 * 跳过原因里「答案该由用户给」的那几类；其余（蜜罐、推荐人、重复…）不问。
 *
 * ⚠️ `PREFILLED_NEEDS_CONFIRMATION` 必须在这里。它是 MANUAL_ONLY 的一个**更窄的
 * 分支**——同样要问用户，只是面板可以先把档案值预选上。漏登记的后果不是少一个
 * 提示：那道题会从面板上整个消失，用户连"这里还要答"都看不到，比不做这个分支
 * 还糟。
 */
export const REVIEWABLE_SKIP_REASONS: ReadonlySet<ApplyErrorCode> = new Set([
  'JOB_DEPENDENT', 'NO_VALUE', 'LOW_CONFIDENCE', 'MANUAL_ONLY', 'CHOICE_NO_DATA',
  'PREFILLED_NEEDS_CONFIRMATION',
  // 「这题只有你能答」：作文 / 开放题在面板里才有 AI 起草按钮（P3-13），漏登记等于把那道题藏起来。
  'USER_ONLY',
]);

/**
 * 蜜罐第三道防线的测量手段（内容脚本侧）。
 *
 * kernel 不碰浏览器 API（RULE-KERNEL-DETERMINISTIC-BOUNDARY），所以"当前环境
 * 会布局"这件事由这里声明并提供读法；kernel 只跑纯判据，且在整表全退化时
 * 自动关闭这道防线。姿势与 write/setFile.ts 的可见性判定同源。
 *
 * 拦的是文案层与身份层都干净、纯靠 CSS 藏起来的陷阱：1×1、
 * clip: rect(1px,1px,1px,1px)、clip-path: inset(50%)、零字号。
 * 命中一个 = 整份申请被静默判为 bot 丢弃，而界面还显示「已填」。
 */
function readHostGeometry(element: Element): HoneypotGeometry {
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const fontSize = Number.parseFloat(style?.fontSize ?? '');
  return {
    width: rect.width,
    height: rect.height,
    // 横向两边：蜜罐的另一种主流藏法是把父节点推到 `left:-9999px`，
    // 而元素自己尺寸/clip/字号全正常（BambooHR 实测）。判据见
    // dict/guards.ts 的 `OFFSCREEN_LEFT_PX`；纵向刻意不采（滚动会让 top 为负）。
    left: rect.left,
    right: rect.right,
    ...(style?.clip ? { clip: style.clip } : {}),
    ...(style?.clipPath ? { clipPath: style.clipPath } : {}),
    ...(Number.isFinite(fontSize) ? { fontSize } : {}),
  };
}

/**
 * 读宿主自己对这个字段的判决（CAP-AF-068）。
 *
 * 回读判决只证明"我们写的值还在"；这里回答"宿主收不收"。三种信号：
 * 约束校验 API、`aria-invalid`、以及 aria-errormessage / aria-describedby
 * 指向的可见红字。
 *
 * Data-L1：只取判决信号，**不取字段值**。错误文案是宿主渲染的固定提示
 * （"This field is required"），不含用户输入；判据在 kernel 里是纯函数。
 */
function readHostValidationSignals(element: Element): HostValidationSignals {
  const control = element as Partial<HTMLInputElement>;
  const describedBy = [
    element.getAttribute('aria-errormessage'),
    element.getAttribute('aria-describedby'),
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
  const errorText = describedBy
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();

  return {
    ariaInvalid: element.getAttribute('aria-invalid'),
    ...(typeof control.willValidate === 'boolean' ? { willValidate: control.willValidate } : {}),
    ...constraintVerdict(control),
    ...(errorText ? { errorText } : {}),
  };
}

/**
 * 约束校验 API 的判决。**读它本身会抛异常**：宿主的 `pattern` 在 Chrome 的 v 标志正则下不合法时，
 * 读 `validity.valid` 抛 SyntaxError（2026-09-22 测试台 runtimeErrors 里连着三条）。那是宿主的
 * 属性写坏了，不是这个字段被拒——读不出就当宿主没在这一项上表态，aria-invalid 与红字两路照常判。
 * 从前没接住，异常一路抛出去，整轮填写断在这一栏，后面的字段一个都不处理。
 */
function constraintVerdict(control: Partial<HTMLInputElement>): { valid?: boolean } {
  try {
    const valid = control.validity?.valid;
    return typeof valid === 'boolean' ? { valid } : {};
  } catch {
    return {};
  }
}

/**
 * 全轮写完后的延时复检窗口（CAP-AF-055）。
 *
 * 受控框架的重渲染、以及"传完简历宿主自己解析回填"，都发生在我们那一串写入
 * 之后的一两百毫秒内。不复检就会报「已填 12/12」而表单其实是空的或是别人的值
 * ——不是没填上，是我们说了谎。整轮只等这一次，不是每字段各等。
 */
const LATE_RECHECK_MS = 250;

/** run/stop 与 lease 到期翻成 AbortSignal 的轮询粒度；对表单填写足够细。 */
/** 点完「加一行」等宿主把新行渲染出来的时间：Greenhouse 实测是同步插入，留一点余量给 React 批处理。 */
const ROW_ADD_SETTLE_MS = 150;
/**
 * 点完「加一行」之后，等新行出现最多等多久（2026-09-24）：Workable 点完几百毫秒才画出编辑框。行数一涨就不再等，
 * 所以同步插入的宿主一点不多等；到点还没涨，才判「点了没反应」。
 */
const ROW_ADD_APPEAR_CAP_MS = 2_000;
const ROW_ADD_POLL_MS = 50;
/**
 * 整轮之后盯着用户亲手改了哪几栏多久（2026-09-24，给 `repairReverted` 用）：与点击凭证的有效期同长——过了它反正也
 * 铸不出写入票。
 */
const LATE_REPAIR_WINDOW_MS = 30_000;

/** 轮询到 `done()` 成立、到点或被叫停为止。 */
async function waitUntil(done: () => boolean, capMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  const deadline = Date.now() + capMs;
  for (;;) {
    if (done()) return true;
    if (signal?.aborted || Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => { setTimeout(resolve, ROW_ADD_POLL_MS); });
  }
}

/**
 * 按了一段的保存钮之后，等那个编辑框收起来最多等多久（2026-09-24）：Workable 实测 100 毫秒以内收成卡片。
 * 到点编辑框还开着，就当网站没收下（它自己的校验没过），照实报 HOST_REJECTED。
 */
const ROW_SAVE_COMMIT_CAP_MS = 2_000;
/**
 * 开始加下一段之前，点击凭证至少还要剩多久（2026-09-24）：一段要加、等画出来、填、按保存、等收起，三张票都从
 * 同一张凭证铸。剩得不够就不开这一段——免得编辑框开了、票过期了，留一个空着的编辑框在页面上。
 */
const ENTRY_GESTURE_MARGIN_MS = 5_000;
/** 加行／存行之后重扫封不住时，再扫几次、隔多久（与主轮扫描的重试同一个口径：4 次、400 毫秒）。 */
const ROW_RESCAN_RETRIES = 4;
const ROW_RESCAN_RETRY_MS = 400;

/** 单子上一段经历／教育的那一行（2026-09-24，全加全存；见 audit.ts 的 `unsavedEntry` / `savedEntry` / `unaddedEntries`）。 */
function entryRowView(row: AuditRow): AuditView {
  return mergeAuditViews([{ rows: [row], filled: 0, requiredTotal: 0, requiredHandled: 0, needsAttention: 0, blockedByUs: 0, awaitingUser: 0 }]);
}

/** 宿主控件上的字（保存钮的「Update」、加一行的「+ Add」），空白折叠。 */
function controlText(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 一段编辑框还差的格（2026-09-24，全加全存）：写了却没确认填入的、编辑框里必填却空着的（没进计划的必填格也算，
 * 按了保存宿主照样会拦）。按页面顺序给宿主的标签，带第一格的原因码；一格不差就是 null——这时才按保存。
 */
function entryGaps(
  rowElement: Element,
  fields: readonly ApplyFieldDescriptor[],
  runnable: ApplyPlan,
  results: readonly ApplyWriteResult[],
): Readonly<{ labels: readonly string[]; reason: ApplyErrorCode }> | null {
  const gaps = new Map<Element, ApplyErrorCode>();
  runnable.entries.forEach((entry, index) => {
    const result = results[index];
    if (result === undefined) gaps.set(entry.element, 'ABORTED');
    else if (!result.ok) gaps.set(entry.element, result.reason);
    else if (result.unverified === true) gaps.set(entry.element, 'VERIFY_TIMEOUT');
  });
  const skipReason = new Map(runnable.skipped.map((skip) => [skip.element, skip.reason] as const));
  for (const field of fields) {
    if (!field.required || !rowElement.contains(field.element) || gaps.has(field.element)) continue;
    if (hostFieldHasValue(field.element)) continue;
    gaps.set(field.element, skipReason.get(field.element) ?? 'MANUAL_ONLY');
  }
  // 一格都没写：不替他按保存（那会存下一段空的）。还差的就是规则认得、却没填的那几格。
  if (runnable.entries.length === 0) {
    for (const skip of runnable.skipped) if (!gaps.has(skip.element)) gaps.set(skip.element, skip.reason);
    if (gaps.size === 0) return Object.freeze({ labels: Object.freeze([]), reason: 'NO_VALUE' });
  }
  if (gaps.size === 0) return null;
  const ordered = fields.filter((field) => gaps.has(field.element));
  const first = ordered[0];
  return Object.freeze({
    labels: Object.freeze(ordered.map((field) => field.label)),
    reason: first === undefined ? [...gaps.values()][0]! : gaps.get(first.element)!,
  });
}
const STOP_POLL_MS = 250;

/**
 * 第二遍（2026-09-23）只补这两种没写成的栏：写之前发现身份变了（页面重渲染、序号挪了）、
 * 节点被宿主换掉了。别的失败（值被改写、宿主拒收、超时、没有对得上的选项……）不是重渲染
 * 造成的，再写一遍只会跟宿主拉锯。
 */
const RETRY_AFTER_RERENDER: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>(['IDENTITY_CHANGED', 'DETACHED']);

/** 这一轮里页面在我们脚下重渲染过吗：有栏因为身份变了、或节点被换掉而没写成。 */
function reRendered(run: ApplyRunSummary): boolean {
  return run.identityDrift > 0 ||
    run.results.some((result) => !result.ok && RETRY_AFTER_RERENDER.has(result.reason));
}

/**
 * 会让页面冒出条件题的写入：单选／复选组、原生下拉、组合框（listbox / typeahead）。
 * 「是否拉美裔」→ 种族题、国家 → 州、「有没有残障」→ 追问，都是选了一项才冒出来的。
 *
 * 只写了文本、长文本、文件的一轮不为了「也许冒出了新题」再扫一遍：重扫是整页的活，而负责人要的是
 * 和竞品一样快（2026-09-23）。那种页面只在重渲染过（有栏身份变了、节点被换）时才重扫。
 */
const OPTION_KINDS: ReadonlySet<ApplyPlanEntry['kind']> = new Set<ApplyPlanEntry['kind']>(['choice', 'select', 'combobox']);

/**
 * 这一轮以用户名义代填获准的类别（2026-09-28）：策略放行 `sign-on-behalf` 时，同意了当前版本的代填授权就是它覆盖的
 * 每一类（`SIGNING_CONSENT_KINDS`），再加上资料里答过的「能不能联系雇主」那一向。策略关着就一类都没有。
 */
export function signOnBehalfKindsFor(
  policyAllows: boolean,
  consented: boolean,
  employerContact: EmployerContactAnswer | undefined,
): ReadonlySet<SignOnBehalfKind> {
  if (!policyAllows) return new Set();
  return new Set<SignOnBehalfKind>([...(consented ? SIGNING_CONSENT_KINDS : []), ...employerContactKinds(employerContact)]);
}

/** 这一遍有没有**写成**过一道选择题（没写成、已有值而没写的都不算）。 */
function answeredAnOption(plan: ApplyPlan, run: ApplyRunSummary): boolean {
  return plan.entries.some((entry, index) => OPTION_KINDS.has(entry.kind) && run.results[index]?.ok === true);
}

interface PlanField {
  readonly element: Element;
  readonly key: string | null;
  readonly label: string;
}

/**
 * 第二遍计划里的每一栏，在第一遍的计划里是哪一栏（第二遍的元素 → 第一遍的元素）。
 *
 * 先认同一个节点：只是序号挪了的栏（Greenhouse 插进种族题之后的 Veteran）节点没换。
 * 节点换了（宿主把那一题重挂了一遍）再按「键 + 题面」认，而且要同时成立：第一遍那个节点
 * 已经不在文档里；这个「键 + 题面」在两边还没认上的栏里都恰好只有一个。拿不准就当新题——
 * 新题最多在面板上多出一行，认错却会把一栏的结局贴到另一栏上。
 */
function correspondingFields(first: readonly PlanField[], second: readonly PlanField[]): Map<Element, Element> {
  const matched = new Map<Element, Element>();
  const firstElements = new Set(first.map((field) => field.element));
  for (const field of second) {
    if (firstElements.has(field.element)) matched.set(field.element, field.element);
  }
  const claimed = new Set(matched.values());
  const signature = (field: PlanField): string => `${field.key ?? ''}\u0000${field.label}`;
  const tally = (fields: readonly PlanField[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const field of fields) counts.set(signature(field), (counts.get(signature(field)) ?? 0) + 1);
    return counts;
  };
  const orphans = first.filter((field) => !claimed.has(field.element) && !field.element.isConnected);
  const newcomers = second.filter((field) => !matched.has(field.element));
  const orphanCounts = tally(orphans);
  const newcomerCounts = tally(newcomers);
  for (const field of newcomers) {
    const key = signature(field);
    if (orphanCounts.get(key) !== 1 || newcomerCounts.get(key) !== 1) continue;
    const orphan = orphans.find((candidate) => signature(candidate) === key);
    if (orphan !== undefined) matched.set(field.element, orphan.element);
  }
  return matched;
}

/**
 * 第二遍的结论顶不顶替第一遍同一栏的结论（逐项结果那一侧；审计视图那一侧见内核的
 * `overlayAuditView`，两边同一套规矩）：写成了的顶替没写成的；写了没写成的只换掉同样没写成的
 * 那条诊断；写之前看到「已经有值」（NOT_EMPTY）的一律不顶替——第一遍刚填进去的值在第二遍眼里
 * 就是这个样子。
 */
function supersedesResult(later: ApplyWriteResult, earlier: ApplyWriteResult): boolean {
  if (later.ok) return !(earlier.ok && earlier.unverified !== true);
  if (later.reason === 'NOT_EMPTY') return false;
  return !earlier.ok && earlier.reason !== 'HOST_REJECTED' && earlier.reason !== 'NOT_EMPTY';
}

/**
 * 附上简历之后等宿主安静下来（2026-09-24，负责人定的量级）：连续这么久表单里没有变动、各栏的值也没变，
 * 才算宿主的简历解析（若有）已经落定。不解析的宿主（Greenhouse）就只多等这一段。
 */
const HOST_SETTLE_QUIET_MS = 600;
/**
 * 最多等这么久：解析再慢也不让用户对着浮层干等。更晚的回写（Lever 实测过结算后十来秒）第二遍补不到，
 * 由整轮之后的复核照实改判成「网站改掉了这一项」。
 */
const HOST_SETTLE_CAP_MS = 4_000;

/** 看不出宿主改过的跳过行：蜜罐、用户关掉的一类、仲裁落选的那一格，面板上本来就没有它们。 */
const SITE_FILL_IGNORED: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>(['NOT_EMPTY', 'HONEYPOT', 'SENSITIVE_OPT_OUT', 'DUPLICATE_FIELD']);

/** 与内核 `readValue` 同一个口径：文本、长文本、原生下拉读 value，其余读文字。 */
function controlValue(element: Element): string {
  const view = element.ownerDocument.defaultView;
  if (
    view !== null &&
    (element instanceof view.HTMLInputElement || element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLSelectElement)
  ) {
    return element.value;
  }
  return element.textContent ?? '';
}

/** 一份表单此刻各栏值的指纹（只在内存里比较「变没变」，不落任何地方）。 */
function valuesFingerprint(elements: readonly Element[]): string {
  const view = elements[0]?.ownerDocument.defaultView ?? null;
  return elements.map((element) => {
    if (view !== null && element instanceof view.HTMLInputElement) {
      return `${element.value}\u0002${element.checked ? 1 : 0}\u0002${element.files?.length ?? 0}`;
    }
    return controlValue(element);
  }).join('\u0001');
}

/** 计划里的条目按表单顺序排，文件栏排最后（与引擎的 `filesLast` 同一条规矩）。 */
function inPlanOrder(entries: readonly ApplyPlanEntry[]): ApplyPlanEntry[] {
  return [
    ...entries.filter((entry) => entry.kind !== 'file').sort((left, right) => left.order - right.order),
    ...entries.filter((entry) => entry.kind === 'file'),
  ];
}

/** 简历字节一次点击只取一次：第二遍再走到简历栏时用第一遍取到的那一份，不让后端再释出一次。 */
/** 求职信交给内核的计划选项：收件人已核实（worker 只在后端答了这一页之后才交来材料）。 */
function coverLetterPlanOptions(material: KernelCoverLetterMaterial): Readonly<{
  coverLetterTargetVerified: true;
  coverLetterText?: string;
  coverLetterFileName?: string;
}> {
  return {
    coverLetterTargetVerified: true,
    ...(material.text === undefined || material.text.trim() === '' ? {} : { coverLetterText: material.text }),
    ...(material.file === undefined ? {} : { coverLetterFileName: material.file.fileName }),
  };
}

function onceResume(resolve: () => Promise<File | null>): () => Promise<File | null> {
  let pending: Promise<File | null> | null = null;
  return () => (pending ??= resolve());
}

/** 第二遍的全部账：重扫出来的那一代、它与第一遍的对应、跑了什么、结果如何。 */
interface SecondPass {
  readonly scan: KernelPageScan;
  /** 第二遍计划里的元素 → 第一遍计划里同一栏的元素（`correspondingFields`）。 */
  readonly correspondence: ReadonlyMap<Element, Element>;
  /** 真正交给 runner 的那几栏：第一遍因重渲染没写成的，加上新出现的题。 */
  readonly runnable: ApplyPlan;
  /** 面板上叠到第一遍那张单子上的：上面那几栏，加上新出现、但这次点击没批准写的题与跳过的题。 */
  readonly viewPlan: ApplyPlan;
  /** 新出现、没批准写的那几栏（LEASE_INVALID），接在 `runnable` 的结果后面对回 `viewPlan`。 */
  readonly blocked: readonly ApplyWriteResult[];
  /** 与 `runnable.entries` 按下标对齐；票没铸出来时每一栏都是那个原因。 */
  readonly results: readonly ApplyWriteResult[];
  /** 真跑过才有；没东西可写、或票没铸出来时为 null。 */
  readonly summary: ApplyRunSummary | null;
}

/**
 * 把第二遍的那一份叠到第一遍的单子上（规矩见内核 `overlayAuditView`）。新出现的题放在它在
 * 页面上前面最近那一栏的后面——往前找第二遍扫描里、第一遍也有一行的那一栏。
 */
function overlaySecondPass(
  base: AuditView,
  pass: SecondPass,
  results: readonly (ApplyWriteResult | undefined)[],
): AuditView {
  const rowElements = new Set(base.rows.map((row) => row.element));
  const fields = pass.scan.descriptor.fields;
  const place = (row: AuditRow): AuditOverlayPlacement => {
    const same = pass.correspondence.get(row.element);
    if (same !== undefined) return { sameAs: same };
    for (let order = row.order - 1; order >= 0; order -= 1) {
      const field = fields[order];
      const earlier = field === undefined ? undefined : pass.correspondence.get(field.element);
      if (earlier !== undefined && rowElements.has(earlier)) return { after: earlier };
    }
    return { after: null };
  };
  return overlayAuditView(base, buildAuditView(pass.viewPlan, [...results, ...pass.blocked]), place);
}

/**
 * 永不向用户提示"请你自己处理"的跳过原因（安全项）。
 *
 * HONEYPOT：反爬陷阱，填了作废整份申请——提示等于诱导用户自己踩。
 * OTHER_PERSON：推荐人/紧急联系人。真的推荐人栏该由用户填，但这条守卫
 *   拦下的也包含"本人字段被推荐人正则误命中"的那一档；误命中时提示会把
 *   用户引去把**本人**资料填进推荐人栏（recruiter 收到一份推荐人等于本人
 *   的申请，而用户复核最容易略过绿色条目）。拿不准时选不提示——那一栏
 *   在页面上本来就看得见。
 */
export async function fillFromGrant(
  input: KernelFillInput,
): Promise<readonly ReceiptFieldOutcome[]> {
  const { grant, scan, profile, progress } = input;
  const now = input.now ?? (() => Date.now());
  const policy = input.policy ?? createBundledApplyPolicy();

  // §5.5.4 动作面：本模块只做 FILL。grant 里没有 FILL（异常票据/未来档位
  // 收窄）就一个字段都不写——授权链的动作约束在执行层有数据载体地兑现。
  if (!grant.allowedActions.includes('FILL')) {
    const outcomes = [...grant.fieldKeys, ...(grant.questionKeys ?? [])].map<ReceiptFieldOutcome>((key) => ({
      key,
      ok: false,
      reason: 'CAPABILITY_DISABLED',
    }));
    for (const outcome of outcomes) progress.onOutcome(outcome);
    return outcomes;
  }

  // 代填条款、声明与签名：生效策略放行 ∧ 用户在资料页单独同意过当前版本（它覆盖的每一类）或资料里答过能不能联系雇主。
  // 这一轮获准的类别交给计划期（不在里面的认得出也不代填），写之前 runner 按类别再核一次。
  const signingKinds = signOnBehalfKindsFor(policy.capabilities['sign-on-behalf'] === true, input.signOnBehalf === true, input.employerContact);
  const signOnBehalf = signingKinds.size > 0;
  const planOptions = {
    readGeometry: readHostGeometry,
    // 计划期的能力位（「这一类问题获准由我们作答吗」）跟着生效中的策略走。从前这里一直没传，
    // 内核按 fail closed 把自我认同 / 工作授权 / 他人信息一律跳过——后端放行了也到不了这里
    //（2026-09-21 查到）。逐写入的能力检查仍在 runner 里另做一遍。
    capabilities: { ...policy.capabilities, 'sign-on-behalf': signOnBehalf },
    signOnBehalfKinds: signingKinds,
    ...(signOnBehalf && input.employerContact !== undefined ? { employerContact: input.employerContact } : {}),
    ...(signingKinds.has('SIGNATURE_DATE') && input.signingDate !== undefined ? { signingDate: input.signingDate } : {}),
    ...(input.workAuthorizations === undefined ? {} : { workAuthorizations: input.workAuthorizations }),
    ...(input.jobRegionCode === undefined ? {} : { jobRegionCode: input.jobRegionCode }),
    ...(input.jobLocation === undefined ? {} : { jobLocation: input.jobLocation }),
    ...(input.referrals === undefined ? {} : { referrals: input.referrals }),
    ...(input.jobCompany === undefined ? {} : { jobCompany: input.jobCompany }),
    ...(input.hispanicLatino === undefined ? {} : { hispanicLatino: input.hispanicLatino }),
    ...(input.transgenderStatus === undefined ? {} : { transgenderStatus: input.transgenderStatus }),
    ...(input.sexualOrientation === undefined ? {} : { sexualOrientation: input.sexualOrientation }),
    ...(input.collections === undefined ? {} : { collections: input.collections }),
    ...(input.today === undefined ? {} : { today: input.today }),
    ...(input.travelPercentMax === undefined ? {} : { travelPercentMax: input.travelPercentMax }),
    ...(input.resume === undefined
      ? {}
      : {
          resumeFileName: input.resume.fileName,
          // Kernel retains the historical option/error name. The Extension
          // supplies only the stronger canonical-target verification fact.
          resumeHostConfirmed: input.resume.targetVerified,
        }),
    ...(input.coverLetter === undefined ? {} : coverLetterPlanOptions(input.coverLetter)),
  };
  const profilePlan = buildApplyPlan(scan.descriptor, profile, planOptions);

  // 档案计划跳过、可由用户审阅作答的题。记忆复用要先知道它们是谁，面板最后也要用同一份。
  // 题号按那一次扫描的顺序编（`q3`）；第二遍重扫出来的新题另起前缀（`q2-3`），两份并在一起不撞号。
  const describeReviewable = (
    source: ApplyPlan,
    descriptor: KernelPageScan['descriptor'] = scan.descriptor,
    idPrefix = 'q',
    include: (skip: ApplyPlan['skipped'][number]) => boolean = () => true,
  ) => {
    const reviewable = new Map<string, Element>();
    const prefills = new Map<string, string>();
    const prefillBasis = new Map<string, Readonly<{ inferredRegionCode?: string; referralCompany?: string }>>();
    /** 每一题为什么被跳过（浮层当场答只收答案该由用户给的那几类，见 `questionAt`）。 */
    const reasons = new Map<string, ApplyErrorCode>();
    const questions = source.skipped.flatMap((skip) => {
      const field = descriptor.fields[skip.order];
      if (!REVIEWABLE_SKIP_REASONS.has(skip.reason) || !field || field.element !== skip.element || !include(skip)) return [];
      const question = describeQuestion(field, `${idPrefix}${skip.order}`);
      if (question) {
        reviewable.set(question.questionId, skip.element);
        reasons.set(question.questionId, skip.reason);
        if (skip.prefill !== undefined) prefills.set(question.questionId, skip.prefill);
        const basis = {
          ...(skip.inferredRegionCode === undefined ? {} : { inferredRegionCode: skip.inferredRegionCode }),
          ...(skip.referralCompany === undefined ? {} : { referralCompany: skip.referralCompany }),
        };
        if (Object.keys(basis).length > 0) prefillBasis.set(question.questionId, Object.freeze(basis));
      }
      return question ? [question] : [];
    });
    return { questions, reviewable, prefills, prefillBasis, reasons };
  };

  // 记忆复用（PRODUCT-AUTHORITY §3 Reuse）：只处理 grant 点名的那些键，而且只有
  // 本页上仍按**同一身份**找得到那道题时才算数。身份变了 key 就变，于是对不上，
  // 于是零写入——这就是这里唯一需要的那道页面侧核对。
  const grantedQuestionKeys = new Set<string>(grant.questionKeys ?? []);
  const rememberedOnPage = new Set<string>();
  // 两条路进这里：mission 路按 grant 点名的题；手势路（reuseRememberedAnswers）按本页
  // 全部可审阅的题——它没有 grant 可点名，答案的授权来自用户亲手记住并打开了自动带出。
  const reuseAll = input.reuseRememberedAnswers === true && grantedQuestionKeys.size === 0;
  const memoryOn = grantedQuestionKeys.size > 0 || reuseAll;
  // 一份计划的可审阅题里，哪些有记住的答案。第一遍对整页问一次；第二遍（重扫之后）只问新冒出来的题，
  // 同一个口子、同一条过滤（grant 点名，或手势路打开了自动带出）。
  const rememberAnswersFor = async (
    source: ApplyPlan,
    descriptor: KernelPageScan['descriptor'],
    idPrefix: string,
    include: (skip: ApplyPlan['skipped'][number]) => boolean,
  ): Promise<QuestionAnswer[]> => {
    const { questions, reviewable } = describeReviewable(source, descriptor, idPrefix, include);
    const targets: Array<{ target: KernelRememberedQuestion; element: Element }> = [];
    for (const question of questions) {
      const element = reviewable.get(question.questionId);
      if (!element) continue;
      let claimKey: string;
      try {
        claimKey = await questionClaimKeyFor(questionIdentity(question));
      } catch {
        continue;
      }
      if (!reuseAll && !grantedQuestionKeys.has(claimKey)) continue;
      rememberedOnPage.add(claimKey);
      targets.push({ target: { questionId: question.questionId, claimKey, question }, element });
    }
    const answers: QuestionAnswer[] = [];
    if (targets.length > 0 && input.resolveRememberedAnswers) {
      let supplied: readonly Readonly<{ questionId: string; value: string }>[] = [];
      try {
        supplied = await input.resolveRememberedAnswers(targets.map((entry) => entry.target));
      } catch {
        // 取不到答案不是写的理由：这一条退回审阅路径，整轮照旧。
        supplied = [];
      }
      const byQuestion = new Map(supplied.map((answer) => [answer.questionId, answer.value]));
      for (const entry of targets) {
        const value = byQuestion.get(entry.target.questionId);
        if (typeof value !== 'string' || value.trim() === '') continue;
        // 计划里的 key 就是 claim key 本身：回执、审计面板与凭证说的是同一个名字。
        answers.push({
          questionId: entry.target.claimKey.slice('question:'.length),
          element: entry.element,
          value,
        });
      }
    }
    return answers;
  };
  // 不复用记忆时一个 await 都不加：从点击到第一笔写入之间多让出一次，用户的「停止」就可能抢在
  // 第一笔之前落地（kernel-filler.test「取消之后」锁着这个时序）。
  const rememberedAnswers: QuestionAnswer[] = memoryOn
    ? await rememberAnswersFor(profilePlan, scan.descriptor, 'q', () => true)
    : [];

  // 一份计划、一张票据：记忆答案没有第二次点击可以铸第二张票，它必须坐进这一张里。
  const plan =
    rememberedAnswers.length === 0
      ? profilePlan
      : buildFillPlan(scan.descriptor, profile, rememberedAnswers, planOptions);

  // skipped 的三分转发：原型一律保守归 IN_PAGE_ACTION（用户自己在页面上
  // 处理），不带 fieldKey/label——分类拿不准时选零泄漏的那类。CHAT_ANSWER /
  // SENSITIVE_CONFIRM 需要问答与档案联动，属后续刀。只报 required：
  // 非必填的跳过不阻塞投递。
  //
  // ⚠️ NEVER_PROMPT 是安全项不是措辞项（2026-08-15 修，红绿证在
  // tests/kernel-filler.test.ts「蜜罐字段绝不提示用户处理」）：蜜罐填了就
  // 作废整份申请，所以"请你自己处理这个字段"对它是**主动把用户推去踩陷阱**
  // ——而蜜罐是可以标 required 的。engine 的 summarizePlan 早已把这两类排除
  // 在分母外（"它们永远不该被填，所以永远进不了分子"），此处跟上同一裁定。
  //
  // 三分语义（T10 验收 ⑤）：判据是**这个问题该在哪儿被回答**，见 userInputTriage.ts。
  //
  // ⚠️ 顺序是安全属性：`CHAT_ANSWER` / `SENSITIVE_CONFIRM` 按契约**必收口**
  // ——发出去本轮 run 立刻停在 USER_ACTION_REQUIRED、不再进 DONE、不出回执。
  // 在这里（填写**之前**）发它们，会让整轮在还没写任何字段时就停掉，
  // 用户点一次 Fill 什么都没发生。所以：页面动作照旧当场发，能在 chat 问的
  // **攒起来，等这一轮填完再发**。
  const deferredQuestions: Array<{ kind: NeedsUserInputKind; fieldKey?: string }> = [];
  // 第二遍重扫出来、我们填不了的新题也走这一道（与第一遍跳过的题一视同仁）。
  const triageSkipped = (skippedItems: ApplyPlan['skipped']): void => {
    for (const skipped of skippedItems) {
      if (!skipped.required) continue;
      const verdict = triageNeedsUserInput({
        reason: skipped.reason,
        key: skipped.key,
        // 默认关：闭环归 T2／T3，未接通前发收口帧比不发更糟（见 userInputTriage.ts）。
        ...(input.chatAnswerEnabled === true ? { chatAnswerEnabled: true } : {}),
      });
      if (verdict.kind === null) continue;
      if (verdict.kind === 'IN_PAGE_ACTION') {
        progress.onNeedsUserInput?.('IN_PAGE_ACTION');
        continue;
      }
      deferredQuestions.push(
        verdict.fieldKey === undefined
          ? { kind: verdict.kind }
          : { kind: verdict.kind, fieldKey: verdict.fieldKey },
      );
    }
  };
  triageSkipped(plan.skipped);

  // 防御性收窄：只写服务端批准过的 key。claim 语义是集合相等，这里对不上
  // 只可能是 claim 之后页面又变了——多出的字段按"lease 未覆盖"拒写。
  // 手势路（reuseAll）没有 grant 可点名：写入面就是「用户记住且本页真命中」的那几道题。
  // 行内角色（P1-8a）：交来了集合就放行整个角色闭集；值仍只来自那份集合，页面上没有的行不会
  // 凭空多出条目，档案里没有的段在计划期就是 NO_VALUE。
  // 工作授权／担保与推荐人姓名（2026-09-21 起直接写）：不是档案键，grant 点不到它们；写入面
  // 由生效策略的能力位放行，数据面由调用方交来的记录集合放行——两样都在才算批准。
  const approved = new Set<string>([
    ...grant.fieldKeys,
    ...grantedQuestionKeys,
    ...(input.collections === undefined ? [] : COLLECTION_FIELD_ROLES),
    ...(reuseAll ? rememberedAnswers.map((answer) => `question:${answer.questionId}`) : []),
    ...(input.workAuthorizations !== undefined && policy.capabilities['set-work-authorization'] === true
      ? ['workAuthorization', 'workSponsorship']
      : []),
    ...(input.referrals !== undefined && policy.capabilities['set-referral'] === true ? ['referralName'] : []),
    // 「你现在人在 X 吗」按档案里的国家答：国家键放行了，这个派生答案就放行。
    ...(grant.fieldKeys.includes('addressCountry') ? ['residence'] : []),
    // 「现在人在 X，或者愿意搬去 X 吗」按居住城市 + 搬迁意愿答：那两个键放行了才放行它。
    ...(grant.fieldKeys.includes('openToRelocation') || grant.fieldKeys.includes('city')
      ? ['relocation']
      : []),
    // 「你在这家公司工作过吗／现在在这里吗」（2026-09-24）按工作经历答：数据面是调用方交来的经历集合
    // （与行内角色同一份担保）加申请卡片的公司名，两样都交来了才放行。推出来的「年满 18」仍是 over18
    // 这个档案键，照旧只由 grant 点名放行。写入原语的能力位在铸票时照常收窄。
    ...(input.collections !== undefined && input.jobCompany !== undefined ? ['previouslyEmployedHere'] : []),
    // 「Are you a transitioning service member?」（2026-09-24）按工作经历答 No：数据面同样是调用方交来的经历集合。
    ...(input.collections !== undefined ? ['transitioningServiceMember'] : []),
    // 按资料推出来的几类（2026-10-04）：语言、工作年限、现在在读吗、服过兵役吗的数据面是调用方交来的集合（语言、经历、
    // 教育，都是他确认过的）；到办公室上班那一类的依据是扁平键 preferredWorkModes（地点那一半是 city、addressRegion、
    // openToRelocation*，与它同在扁平档案里），那个键放行了才放行它。写入原语的能力位在铸票时照常收窄。
    ...(input.collections !== undefined ? ['languageAnswer', 'experienceYears', 'currentStudent', 'militaryService'] : []),
    ...(grant.fieldKeys.includes('preferredWorkModes') ? ['workArrangement'] : []),
    // 出差题（2026-10-04，argoland #738）：依据是资料里确认过的出差上限，调用方交来了它才放行。
    ...(input.travelPercentMax !== undefined ? ['travelAnswer'] : []),
    // 代填条款、声明与签名（2026-09-23）、同意类（2026-09-24 起）与能不能联系雇主（2026-09-28）：写入面由生效策略的
    // 能力位放行，授权面按类别——用户同意着的那一版文案点名了的，或资料里答过的那一向。
    ...[...signingKinds].map((kind) => SIGN_ON_BEHALF_ENTRY_KEY[kind]),
    // 跨性别、性取向、「是否 LGBTQ+」（2026-09-23）：不是档案键，grant 点不到它们；写入面由自我认同
    // 的能力位放行，数据面由调用方交来的那两句回答放行——各自只在它的依据交来了时才批准。
    ...(policy.capabilities['set-self-identification'] === true
      ? [
          ...(input.transgenderStatus === undefined ? [] : ['eeoTransgender']),
          ...(input.sexualOrientation === undefined ? [] : ['eeoSexualOrientation']),
          ...(input.transgenderStatus === undefined && input.sexualOrientation === undefined ? [] : ['eeoLgbtqCommunity']),
        ]
      : []),
  ]);
  const outOfGrant = plan.entries
    .filter((entry) => !approved.has(entry.key))
    .map<ReceiptFieldOutcome>((entry) => ({ key: entry.key, ok: false, reason: 'LEASE_INVALID' }));
  // 审计视图建在**完整** plan 上，不是 runnablePlan：被 lease 挡掉的条目也得
  // 出现在面板里。面板上"少一行"比"多一行写着没填成"危险——用户会以为那一栏
  // 不存在，而它就在页面上空着。中段屏与终局屏共用这一份，行集合才对得上。
  const leaseBlocked = plan.entries
    .filter((entry) => !approved.has(entry.key))
    .map<ApplyWriteResult>((entry) => ({
      key: entry.key,
      label: entry.label,
      ok: false,
      reason: 'LEASE_INVALID',
    }));
  const runnablePlan: ApplyPlan = {
    ...plan,
    entries: plan.entries.filter((entry) => approved.has(entry.key)),
  };
  // 审计视图的结果按下标对回条目：可跑的结果在前、被租约挡掉的在后，条目就得按同一个顺序排
  // （行最后照表单顺序重排，面板上看不出区别）。从前直接用 `plan`，挡掉的那一栏夹在中间时
  // 下标整体错位——已经填上的一栏在面板上成了「没跑到」。
  const auditPlan: ApplyPlan = {
    ...plan,
    entries: [...runnablePlan.entries, ...plan.entries.filter((entry) => !approved.has(entry.key))],
  };
  // 两遍共用一份字节：第二遍再走到简历栏，用第一遍取到的那一份。
  const resolveResume = input.resume === undefined ? undefined : onceResume(input.resume.resolve);
  const resolveCoverLetter = input.coverLetter?.file === undefined ? undefined : onceResume(input.coverLetter.file.resolve);

  // 两条信任根，同一份计划、同一个指纹、同一套能力面收窄。
  const grantedCapabilities = new Set(
    [...capabilitiesForPlan(runnablePlan)].filter(
      (capability) => policy.capabilities[capability],
    ),
  );
  const minted = input.gesture !== undefined
    ? mintAuthorityFromGesture({
      proof: input.gesture,
      purpose: 'fill',
      fingerprint: runnablePlan.fingerprint,
      capabilities: grantedCapabilities,
      now: now(),
    })
    : mintIntentAuthority({
      lease: { executionLease: grant.executionLease, expiresAtMs: grant.leaseExpiresAt * 1000 },
      purpose: 'fill',
      fingerprint: runnablePlan.fingerprint,
      capabilities: grantedCapabilities,
      now: now(),
    });
  if (!minted.ok) {
    const outcomes: ReceiptFieldOutcome[] = [
      ...runnablePlan.entries.map<ReceiptFieldOutcome>((entry) => ({
        key: entry.key,
        ok: false,
        reason: minted.code,
      })),
      ...outOfGrant,
    ];
    for (const outcome of outcomes) progress.onOutcome(outcome);
    return outcomes;
  }

  // 手势路：计划定下来了，开写之前同步交给调用方看一眼（AI 代答在这里挑题、发请求，不等它）。
  // 一个 await 都不加：从点击到第一笔写入之间多让出一次，用户的「停止」就可能抢在第一笔之前落地。
  if (input.gesture !== undefined) input.onPlanned?.(plan, scan.descriptor);

  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort();
  input.signal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  if (input.signal?.aborted) controller.abort();
  const poll = setInterval(() => {
    if (progress.shouldStop()) controller.abort();
  }, STOP_POLL_MS);
  if (progress.shouldStop()) controller.abort();

  // journal 必须活过这一轮：撤销按钮的全部前提就是它还在。此前它是就地
  // new 出来又就地丢掉的（注释直写「Undo 面板 = T10 扩项」），于是"写入可撤销"
  // 这条铁律承诺在真实执行链上一次都没兑现过。
  const journal = createUndoJournal();

  // 中段屏的数据源（CAP-AF-063）。行集合、顺序、必填分母与档位判定只有一个
  // 权威——`buildAuditView`，与跑完之后那张单子同源；中段屏与终局屏因此是**同一张
  // 单子**，跑完那一刻不会有任何一行凭空出现或消失。位置对齐由 runner 给的 `index`
  // 保证，不按 key 对回。
  const settled: Array<ApplyWriteResult | undefined> = runnablePlan.entries.map(() => undefined);
  const onProgress = input.onProgress;
  // 还没结算的那几栏走到哪了：正在写哪一栏、哪些已写进网页等确认。结算了就从这里退出去。
  let liveCurrent: Element | null = null;
  const liveWritten = new Set<Element>();
  const firstView = (results: readonly (ApplyWriteResult | undefined)[]): AuditView =>
    buildAuditView(auditPlan, [...results, ...leaseBlocked]);
  // 中段屏此刻该画哪一张：第一遍在跑时是第一遍那张；第二遍开跑后换成两遍叠在一起的那张。
  let progressView = (): AuditView => firstView(settled);
  const emitProgress = onProgress === undefined
    ? undefined
    : () => onProgress(progressView(), {
        current: liveCurrent,
        written: new Set(liveWritten),
      });
  // 逐栏的三声（轮到、写进网页、结算）按下标对回**这一遍**的条目与结算槽。
  const liveHooks = (
    entries: readonly ApplyPlanEntry[],
    slots: Array<ApplyWriteResult | undefined>,
  ): Pick<RunApplyPlanInput, 'onFieldSettled' | 'onFieldStart' | 'onFieldWritten'> =>
    emitProgress === undefined
      ? {}
      : {
          onFieldSettled: (index: number, result: ApplyWriteResult) => {
            slots[index] = result;
            const element = entries[index]?.element;
            if (element !== undefined) {
              liveWritten.delete(element);
              if (liveCurrent === element) liveCurrent = null;
            }
            emitProgress();
          },
          onFieldStart: (index: number) => {
            liveCurrent = entries[index]?.element ?? null;
            emitProgress();
          },
          onFieldWritten: (index: number) => {
            const element = entries[index]?.element;
            if (element === undefined) return;
            liveWritten.add(element);
            if (liveCurrent === element) liveCurrent = null;
            emitProgress();
          },
        };
  // 先把整张单子交出去：分母一开始就齐，一栏未亮。先报「必填 0/1」再涨到「0/3」
  // 比不报更糟——用户会以为只剩一栏要管。
  emitProgress?.();

  let summary: ApplyRunSummary;
  let second: SecondPass | null = null;
  // 第二遍在新冒出来的题上：找到的记住的答案（逐项结果标来源要用）；仍要用户自己答的那几题（面板「补答」）。
  let revealedRemembered: readonly QuestionAnswer[] = [];
  let revealedReview: ReturnType<typeof describeReviewable> | null = null;
  // 第二遍新冒出来、不进单子的那几栏（判成蜜罐、同节同键里落选的、他关掉的敏感类；2026-10-04）：与第一遍的一起交给浮层，
  // 页面侧清点不把它们当「浮层已经在管」。
  const revealedUnshown: Element[] = [];
  let currentScan = scan;
  // 手里这份扫描是不是已知过期：最近跑的那一遍里页面重渲染过，而之后又没能重扫。加行要从它出发。
  let scanKnownStale = false;
  // 附上简历之后（2026-09-24）：等宿主安静的那一段；安静下来之后如实改判过的第一遍结论；第一遍写成、随后被
  // 宿主改掉、要在第二遍重写一次的栏（元素 → 第一遍的键）；我们没写、宿主从简历里读出来填上的栏。
  let settle: HostQuietResult | null = null;
  let firstResults: readonly ApplyWriteResult[] | null = null;
  const repairTargets = new Map<Element, string>();
  const siteFilled = new Set<Element>();
  // 网站从简历里读出来填上的那几栏：面板上照实标出来源——只要那一栏此刻仍有值；值没了就回到原来那一行。
  const markSiteFilledView = (view: AuditView): AuditView => {
    if (siteFilled.size === 0) return view;
    const rows = view.rows.map((row): AuditRow =>
      siteFilled.has(row.element) && hostFieldHasValue(row.element)
        ? { ...row, status: 'PREFILLED', reason: 'NOT_EMPTY', siteFilled: 'FROM_RESUME' }
        : row);
    return mergeAuditViews([{ ...view, rows }]);
  };
  // 手势路上、这一次要附简历的时候，从第一笔写入之前就记下用户亲手动过哪些栏（可信的编辑事件），事后才分得清
  // 「宿主改的」与「用户改的」：用户动过的栏一概不重写，也不把它算成网站填的。
  const hostDocument = runnablePlan.entries[0]?.element.ownerDocument ?? null;
  const userEdits = input.gesture !== undefined &&
    input.rowAdds?.rescan !== undefined &&
    resolveResume !== undefined &&
    hostDocument !== null &&
    runnablePlan.entries.some((entry) => entry.kind === 'file')
    ? watchTrustedEdits(hostDocument)
    : null;
  // 第一遍跳过的栏里开写之前就已经有值的：它们后来有值，不是网站从简历里读的。
  const filledBeforeRun = new Set<Element>(
    userEdits === null ? [] : plan.skipped.filter((skip) => hostFieldHasValue(skip.element)).map((skip) => skip.element),
  );
  try {
    summary = await runApplyPlan({
      plan: runnablePlan,
      ...liveHooks(runnablePlan.entries, settled),
      auth: minted.value,
      journal,
      readHostValidation: readHostValidationSignals,
      lateRecheckMs: LATE_RECHECK_MS,
      root: scan.descriptor.root,
      policy,
      // 代填条目在写之前按类别再核一次：这一轮开始时读到的那一版同意点名了它，或资料里答过的是这一向。
      ...(signOnBehalf ? { signOnBehalfCurrent: (kind: SignOnBehalfKind) => signingKinds.has(kind) } : {}),
      ...(resolveResume === undefined ? {} : { resolveResumeFile: resolveResume }),
      ...(resolveCoverLetter === undefined ? {} : { resolveCoverLetterFile: resolveCoverLetter }),
      signal: controller.signal,
      ...(input.scanStillCurrent === undefined
        ? {}
        : { scanStillCurrent: input.scanStillCurrent }),
      now,
    });
    const firstSummary = summary;
    scanKnownStale = reRendered(firstSummary);

    // 附上简历之后先等宿主安静下来（2026-09-24）。有的宿主收到简历之后自己解析，隔一两秒改写别的栏
    // （Rippling 改姓名邮箱电话，Lever 清空地点）；文件排在计划最后（Greenhouse 那条快路要它），这些回写全落在
    // 我们写完之后。等到表单连续一段时间不再变（最多几秒、按停止就停），再如实改判第一遍的结论，并记下：
    //  · 我们写成、随后被宿主改掉、用户没碰过的栏——第二遍以资料里的值重写一次；
    //  · 我们没写（资料里没有）、宿主从简历里读出来填上、用户没碰过的栏——留着网站的值，面板照实说来源。
    const attachedResume = runnablePlan.entries.some((entry, index) =>
      entry.kind === 'file' && firstSummary.results[index]?.ok === true);
    if (
      userEdits !== null &&
      hostDocument !== null &&
      attachedResume &&
      firstSummary.abortedBy === null &&
      !controller.signal.aborted &&
      !progress.shouldStop()
    ) {
      // 单选／复选组的每一个选项都进指纹：宿主改了选中的是哪一项，也只动 checked 属性。
      const watched = scan.descriptor.fields.flatMap((field): Element[] =>
        field.kind === 'choice' ? field.choice.options.map((option) => option.element) : [field.element]);
      settle = await waitForHostQuiet({
        targets: captureScanRootObservationTargets(scan.descriptor.root) ?? [hostDocument.documentElement],
        fingerprint: () => valuesFingerprint(watched),
        quietMs: input.hostSettle?.quietMs ?? HOST_SETTLE_QUIET_MS,
        capMs: input.hostSettle?.capMs ?? HOST_SETTLE_CAP_MS,
        signal: controller.signal,
      });
      const rechecked = firstSummary.recheck();
      firstResults = rechecked;
      runnablePlan.entries.forEach((entry, index) => {
        // LATE_REVERTED 只落在「写成了、之后值变了」的栏上：变在第一遍收尾那 250 毫秒里（第一遍自己就判了），
        // 还是变在等宿主安静的这一段里（上面这次复核才判），都是我们写过、随后被改掉的。
        const after = rechecked[index];
        if (after === undefined || after.ok || after.reason !== 'LATE_REVERTED') return;
        // 文件、单选／复选组、富文本不在这条路上重写：前两者不覆盖已有的选择，富文本只写真正空着的目标。
        if (entry.kind === 'file' || entry.kind === 'choice' || entry.kind === 'richtext') return;
        if (!entry.element.isConnected || userEdits.touched(entry.element)) return;
        repairTargets.set(entry.element, entry.key);
      });
      for (const skip of plan.skipped) {
        if (SITE_FILL_IGNORED.has(skip.reason) || filledBeforeRun.has(skip.element)) continue;
        if (!skip.element.isConnected || userEdits.touched(skip.element) || !hostFieldHasValue(skip.element)) continue;
        siteFilled.add(skip.element);
      }
    }

    // 第二遍（2026-09-23）：页面在第一遍里重渲染过（内核不再连坐，只放弃身份变了的那几栏、记在
    // identityDrift 里），或者第一遍写成过选择题、答案可能让页面冒出了新题（Greenhouse 答完「是否拉美裔」
    // 才出种族题），或者这一次附上了简历（宿主可能已经从简历里改写了别的栏，见上）。只写了文本类的一轮
    // 不为找新题多扫一遍（见 OPTION_KINDS）。
    // 同一次点击里重扫一次、补填一次，**只一次**，不循环：
    //  · 信任根不变：同一张点击凭证、与加行同一个铸票口子（mintAuthorityFromGesture），凭证 30 秒过期就不补；
    //  · 写入面不放宽：只写这一次点击已经批准过的键（`approved`），同一份资料、同一套计划选项；
    //  · 只补三种栏：第一遍因重渲染没写成的（IDENTITY_CHANGED / DETACHED）、第一遍计划里根本没有的新题、
    //    第一遍写成之后被宿主改掉的（上面记下的；以资料里的值重写一次，写完再被改掉就照实报 LATE_REVERTED）。
    //    第一遍已经结算过的其余栏（写成了且还在、别的原因没写成、跳过）一栏都不碰；已经挂上的简历不挂第二份。
    //  · 宿主开始提交、整轮被迫停下（abortedBy）、用户按了停止，都不补。
    const gesture = input.gesture;
    const rescan = input.rowAdds?.rescan;
    if (
      gesture !== undefined &&
      rescan !== undefined &&
      firstSummary.abortedBy === null &&
      (scanKnownStale || answeredAnOption(runnablePlan, firstSummary) || attachedResume) &&
      !controller.signal.aborted &&
      !progress.shouldStop()
    ) {
      let next: KernelPageScan | null;
      try {
        next = await rescan();
      } catch {
        next = null;
      }
      if (next !== null) {
        currentScan = next;
        scanKnownStale = false;
      }
      if (next !== null && !controller.signal.aborted && !progress.shouldStop()) {
        const secondScan = next;
        // 新冒出来的题也问一次记住的答案：与第一遍同一个口子、同一条过滤（grant 点名，或手势路打开了
        // 自动带出），只问第一遍计划里没见过的节点上的题。
        const baseRebuilt = buildApplyPlan(secondScan.descriptor, profile, planOptions);
        const seenFirst = new Set<Element>([...plan.entries, ...plan.skipped].map((item) => item.element));
        revealedRemembered = memoryOn
          ? await rememberAnswersFor(baseRebuilt, secondScan.descriptor, 'q2-', (skip) => !seenFirst.has(skip.element))
          : [];
        const secondRemembered = [...rememberedAnswers, ...revealedRemembered];
        const rebuilt = secondRemembered.length === 0
          ? baseRebuilt
          : buildFillPlan(secondScan.descriptor, profile, secondRemembered, planOptions);
        // 批准面与第一遍同一条规则：手势路上「用户记住、本页真命中」的题就是这一次点击批准的题，第二遍的
        // 「本页」多了新冒出来的那几道。mission 路的题键只来自 grant，本来就都在 approved 里。
        const secondApproved = reuseAll && revealedRemembered.length > 0
          ? new Set<string>([...approved, ...revealedRemembered.map((answer) => `question:${answer.questionId}`)])
          : approved;
        const correspondence = correspondingFields(
          [...plan.entries, ...plan.skipped],
          [...rebuilt.entries, ...rebuilt.skipped],
        );
        const firstResultOf = new Map<Element, ApplyWriteResult>();
        runnablePlan.entries.forEach((entry, index) => {
          const result = firstSummary.results[index];
          if (result !== undefined) firstResultOf.set(entry.element, result);
        });
        const attachedFiles = new Set<string>(runnablePlan.entries.flatMap((entry, index) =>
          entry.kind === 'file' && firstSummary.results[index]?.ok === true ? [entry.key] : []));
        const retry = rebuilt.entries.filter((entry) => {
          if (!secondApproved.has(entry.key)) return false;
          if (entry.kind === 'file' && attachedFiles.has(entry.key)) return false;
          const earlier = correspondence.get(entry.element);
          if (earlier === undefined) return true;
          const result = firstResultOf.get(earlier);
          return result !== undefined && !result.ok && RETRY_AFTER_RERENDER.has(result.reason);
        });
        const newBlocked = rebuilt.entries.filter((entry) =>
          !secondApproved.has(entry.key) && !correspondence.has(entry.element));
        const newSkipped = rebuilt.skipped.filter((skip) => !correspondence.has(skip.element));
        for (const skip of newSkipped) if (UNSHOWN_SKIP_REASONS.has(skip.reason)) revealedUnshown.push(skip.element);
        // 新冒出来、我们填不了的题与第一遍跳过的题一视同仁：面板上有它的行（必填的进「需要你」、进计数），
        // 「补答」里有它，必填的照样报给 triage。
        revealedReview = describeReviewable(rebuilt, secondScan.descriptor, 'q2-', (skip) => !correspondence.has(skip.element));
        triageSkipped(newSkipped);
        // 第一遍写成、宿主随后改掉的栏（简历解析回写）：资料里的值为准，这一遍里重写一次。条目取自一份
        // 「非空也排进来」的计划（题面与签名都是这次重扫的），键得与第一遍相同；写前那一刻的值必须逐字仍是
        // 此刻看到的宿主值（reclaim），用户在这之间动过就照旧不碰。
        const repairs: ApplyPlanEntry[] = [];
        const reclaim = new Map<Element, string>();
        if (repairTargets.size > 0) {
          const overwriteOptions = { ...planOptions, fillEmptyOnly: false };
          const source = secondRemembered.length === 0
            ? buildApplyPlan(secondScan.descriptor, profile, overwriteOptions)
            : buildFillPlan(secondScan.descriptor, profile, secondRemembered, overwriteOptions);
          for (const entry of source.entries) {
            if (repairTargets.get(entry.element) !== entry.key || !secondApproved.has(entry.key)) continue;
            if (userEdits?.touched(entry.element) === true) continue;
            repairs.push(entry);
            reclaim.set(entry.element, controlValue(entry.element));
          }
        }
        const toRun = inPlanOrder([...retry, ...repairs]);
        if (toRun.length > 0 || newBlocked.length > 0 || newSkipped.length > 0) {
          const runnable: ApplyPlan = { ...rebuilt, entries: toRun };
          const viewPlan: ApplyPlan = { ...rebuilt, entries: [...toRun, ...newBlocked], skipped: newSkipped };
          const blocked = newBlocked.map<ApplyWriteResult>((entry) => ({
            key: entry.key,
            label: entry.label,
            ok: false,
            reason: 'LEASE_INVALID',
          }));
          const slots: Array<ApplyWriteResult | undefined> = toRun.map(() => undefined);
          const pending: SecondPass = {
            scan: secondScan,
            correspondence,
            runnable,
            viewPlan,
            blocked,
            results: [],
            summary: null,
          };
          const firstBase = firstResults ?? firstSummary.results;
          progressView = () => markSiteFilledView(overlaySecondPass(firstView(firstBase), pending, slots));
          emitProgress?.();
          let results: readonly ApplyWriteResult[] = [];
          let secondSummary: ApplyRunSummary | null = null;
          if (toRun.length > 0) {
            const secondMint = mintAuthorityFromGesture({
              proof: gesture,
              purpose: 'fill',
              fingerprint: runnable.fingerprint,
              capabilities: new Set(
                [...capabilitiesForPlan(runnable)].filter((capability) => policy.capabilities[capability]),
              ),
              now: now(),
            });
            if (secondMint.ok) {
              secondSummary = await runApplyPlan({
                plan: runnable,
                ...liveHooks(runnable.entries, slots),
                auth: secondMint.value,
                journal,
                readHostValidation: readHostValidationSignals,
                lateRecheckMs: LATE_RECHECK_MS,
                root: secondScan.descriptor.root,
                policy,
                ...(signOnBehalf ? { signOnBehalfCurrent: (kind: SignOnBehalfKind) => signingKinds.has(kind) } : {}),
                ...(resolveResume === undefined ? {} : { resolveResumeFile: resolveResume }),
                ...(resolveCoverLetter === undefined ? {} : { resolveCoverLetterFile: resolveCoverLetter }),
                ...(reclaim.size === 0 ? {} : { reclaim }),
                signal: controller.signal,
                now,
              });
              results = secondSummary.results;
              scanKnownStale = reRendered(secondSummary);
            } else {
              // 凭证过期（第一遍跑得久）等：这几栏如实记那个原因，新出现的题照样摆上面板让用户看见。
              const code = secondMint.code;
              results = toRun.map<ApplyWriteResult>((entry) => ({ key: entry.key, label: entry.label, ok: false, reason: code }));
            }
          }
          second = { ...pending, results, summary: secondSummary };
        }
      }
    }
  } finally {
    clearInterval(poll);
    input.signal?.removeEventListener('abort', abortFromExternalSignal);
    userEdits?.stop();
  }

  // 加行（P1-8b）：主轮跑完再逐段推进。每一步：说下一步 → 专用票 → 点「加一行」→ 等宿主 → 重扫 →
  // 行数真的涨了才为新行建计划、另铸 fill 票、只跑新行的行内条目。任何一步不成就停，已填的都完整。
  //
  // 每一段要单独保存的区（Workable 的「Update」；负责人 2026-09-24：「workable，那就和jobright一样全加全存」）
  // 每一段多三步：新编辑框按「哪一行里有保存钮」找（Workable 把它插在最前面）、那一行按资料里的第几段投影、
  // 填完回读过就用保存票按它自己的保存钮，等它收成卡片再加下一段。一段没存上（缺必填、没回读成、网站没收、
  // 没点成），那个编辑框留着、这个区这一轮不再加，单子上照实说还差什么；另一个区照常。规则声明新行插在最前面的区
  // （`insertsAt: 'top'`，Workable）从资料的最后一段加起，页面上最后从上到下才是资料的顺序（`entryIndex`）。
  //
  // 从哪一份扫描出发（2026-09-23 复核 `abortedBy === null` 这道闸）：从前身份漂移会置 abortedBy，
  // 这道闸因此也挡住了「从一份已经过期的扫描出发去加行」。漂移改记在 identityDrift 之后它挡不住了，
  // 所以另加一条：最近那一遍重渲染过、又没能重扫（`scanKnownStale`），就不加行。abortedBy 那一条
  // 照留——宿主开始提交、或受控下拉停在说不清的状态上，都不该再点「加一行」。
  const rowViews: AuditView[] = [];
  // 加行那几份视图按「集合（教育在前）、资料里的第几段」排：插在最前面的区从最后一段加起（2026-09-24），单子上仍按
  // 第 1、2、3 段列。同一段的几份（没存上时：格 + 那一段）挨在一起。
  const rowGroups: Array<Readonly<{ collection: RowCollection; entry: number; views: readonly AuditView[] }>> = [];
  const pushRows = (collection: RowCollection, entry: number, ...views: AuditView[]): void => {
    rowGroups.push({ collection, entry, views });
    const ordered = [...rowGroups].sort((left, right) =>
      (left.collection === right.collection ? 0 : left.collection === 'education' ? -1 : 1) || left.entry - right.entry);
    rowViews.splice(0, rowViews.length, ...ordered.flatMap((group) => group.views));
  };
  const rowResults: ApplyWriteResult[] = [];
  let rowAdds: KernelFillAudit['rowAdds'] = null;
  if (
    input.rowAdds !== undefined &&
    input.gesture !== undefined &&
    input.collections !== undefined &&
    policy.capabilities['manage-rows'] === true &&
    summary.abortedBy === null &&
    (second?.summary?.abortedBy ?? null) === null &&
    !scanKnownStale
  ) {
    const gesture = input.gesture;
    const collections = input.collections;
    const rescanRows = input.rowAdds.rescan;
    const settleMs = input.rowAdds.settleMs ?? ROW_ADD_SETTLE_MS;
    const appearCapMs = input.rowAdds.appearCapMs ?? ROW_ADD_APPEAR_CAP_MS;
    let added = 0;
    let saved = 0;
    // `stop`：第一个让某个区或整轮停下的原因（审计里的账）；`loopStop`：整轮是为什么提前停的（没加上的那几段按它说）。
    let stop: ApplyErrorCode | null = null;
    let loopStop: ApplyErrorCode | null = null;
    const halt = (code: ApplyErrorCode): void => {
      loopStop = code;
      if (stop === null) stop = code;
    };
    let unreachable: RowPlan['unreachable'] = describeRowAdds(currentScan.descriptor, collections).plan.unreachable;
    // 有一段没能存下来的区（值是原因码）：那个编辑框还开着，这个区这一轮不再加。
    const blocked = new Map<RowCollection, ApplyErrorCode>();
    const stopped = (): boolean => input.signal?.aborted === true || progress.shouldStop();
    // 重扫一时封不住（宿主还在重排：Workable 存完一段、收成卡片之后紧接着那一次，2026-09-24 测试台）不是终局：
    // 与主轮同一个口径，隔一会儿再扫几次，扫到了就接着走；几次都扫不到才停（IDENTITY_CHANGED）。
    const rescanSafely = async (): Promise<KernelPageScan | null> => {
      for (let attempt = 0; ; attempt += 1) {
        let scanned: KernelPageScan | null = null;
        try {
          scanned = await rescanRows();
        } catch {
          scanned = null;
        }
        if (scanned !== null || attempt >= ROW_RESCAN_RETRIES || stopped()) return scanned;
        await new Promise<void>((resolve) => { setTimeout(resolve, ROW_RESCAN_RETRY_MS); });
      }
    };
    const fillAuthority = (runnable: ApplyPlan) => mintAuthorityFromGesture({
      proof: gesture,
      purpose: 'fill',
      fingerprint: runnable.fingerprint,
      capabilities: new Set([...capabilitiesForPlan(runnable)].filter((capability) => policy.capabilities[capability])),
      now: now(),
    });
    const runRow = (runnable: ApplyPlan, root: KernelPageScan['descriptor']['root'], auth: Parameters<typeof runApplyPlan>[0]['auth']) =>
      runApplyPlan({
        plan: runnable,
        auth,
        journal,
        readHostValidation: readHostValidationSignals,
        lateRecheckMs: LATE_RECHECK_MS,
        root,
        policy,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        now,
      });
    // 中段屏：每结算一段交一次，单子上一段一段亮起来（主轮那一张不变，段接在后面）。
    const mainProgress = progressView;
    const emitRows = (): void => {
      progressView = () => mergeAuditViews([mainProgress(), ...rowViews]);
      emitProgress?.();
    };
    while (added < MAX_ROW_ADDS) {
      if (stopped()) { halt('ABORTED'); break; }
      const described = describeRowAdds(currentScan.descriptor, collections, new Set(blocked.keys()));
      unreachable = described.plan.unreachable;
      if (described.next === null) break;
      const { collection, rowIndex, entryIndex } = described.next;
      const perEntrySave = rowNeedsSave(currentScan.descriptor, collection);
      // 一段要三张票（加、填、存），都从同一张点击凭证铸：剩得不够就不开这一段，免得留下一个空着的编辑框。
      // 剩多久由内核按凭证的种类算（点击 30 秒；连填里「这一页」的凭证按那一轮的时限）。
      if (perEntrySave && gestureRootRemainingMs(gesture, now()) < ENTRY_GESTURE_MARGIN_MS) {
        halt('GESTURE_EXPIRED');
        break;
      }
      const rowsBefore = presentRowCounts(currentScan.descriptor)[collection] ?? 0;
      const addAuth = mintRowActionAuthorityFromGesture({ proof: gesture, action: 'add', now: now() });
      if (!addAuth.ok) { halt(addAuth.code); break; }
      const clicked = clickAddRow({
        descriptor: currentScan.descriptor,
        collection,
        authority: addAuth.value,
        journal,
        policy,
        now: now(),
      });
      if (!clicked.ok) { halt(clicked.code); break; }
      await new Promise<void>((resolve) => { setTimeout(resolve, settleMs); });
      // 宿主把新行画出来要多久不一定（Greenhouse 同步插入；Workable 2026-09-24 实测点完几百毫秒才出编辑框）：
      // 行数真的涨了再重扫，最多等 appearCapMs。从前固定等 150 毫秒就重扫，Workable 上行还没画出来，于是判
      // 「点了没反应」停下——编辑框随后才出现，里面的必填 Title 空着，浮层却说必填都填好了。
      const scanBeforeAdd = currentScan;
      await waitUntil(
        () => (presentRowCounts(scanBeforeAdd.descriptor)[collection] ?? 0) > rowsBefore,
        appearCapMs,
        input.signal,
      );
      const next = await rescanSafely();
      if (next === null) { halt('IDENTITY_CHANGED'); break; }
      // 点了、等了、扫了，行数还是没涨：宿主没按我们想的那样反应，不再点第二次。
      if ((presentRowCounts(next.descriptor)[collection] ?? 0) <= rowsBefore) {
        halt('CLICK_DENIED');
        currentScan = next;
        break;
      }
      currentScan = next;
      added += 1;

      if (!perEntrySave) {
        // 加完直接能填的区（Greenhouse）：新行在行尾，页面第 N 行拿资料第 N 段。
        // 只切这个区的第 N 行：另一个区同一行序的格不归这一段（行序在每个区里各数各的）。
        const runnable = rowPlanSlice(buildApplyPlan(next.descriptor, profile, planOptions), next.descriptor, rowIndex, collection);
        if (runnable.entries.length === 0) {
          // 新行里一格都填不了（资料里没有、控件填不进）：这一行的格照样上单子，必填的进「需要你」。
          pushRows(collection, entryIndex, buildAuditView(runnable, []));
          continue;
        }
        const rowMint = fillAuthority(runnable);
        if (!rowMint.ok) { halt(rowMint.code); break; }
        const rowSummary = await runRow(runnable, next.descriptor.root, rowMint.value);
        pushRows(collection, entryIndex, buildAuditView(runnable, rowSummary.results));
        rowResults.push(...rowSummary.results);
        emitRows();
        if (rowSummary.abortedBy !== null) { halt('ABORTED'); break; }
        continue;
      }

      // —— 每一段要单独保存的区 ——
      // 新编辑框在哪一行：恰好一个开着的编辑框才算。说不清该填哪一行、该按哪一颗，这个区就停下。
      const editors = entryEditorState(next.descriptor, collection).open;
      const editorRow = editors.length === 1 ? editors[0]! : null;
      const rowElement = editorRow === null ? null : rowElementAt(next.descriptor, collection, editorRow);
      if (editorRow === null || rowElement === null) {
        blocked.set(collection, 'CLICK_DENIED');
        if (stop === null) stop = 'CLICK_DENIED';
        continue;
      }
      const saveControl = rowSaveControl(next.descriptor, collection, editorRow);
      const saveLabel = controlText(saveControl);
      // 这一行按资料里的第 entryIndex 段投影：编辑框插在最前面，照「第 N 行拿第 N 段」会把每一段都填成第 1 段。
      const runnable = entryPlanSlice(
        buildApplyPlan(next.descriptor, profile, { ...planOptions, collections: collectionsForRow(collections, collection, editorRow, entryIndex) }),
        next.descriptor,
        collection,
        editorRow,
      );
      let results: ApplyWriteResult[] = [];
      let runAborted = false;
      if (runnable.entries.length > 0) {
        const rowMint = fillAuthority(runnable);
        if (rowMint.ok) {
          const rowSummary = await runRow(runnable, next.descriptor.root, rowMint.value);
          results = [...rowSummary.results];
          rowResults.push(...rowSummary.results);
          runAborted = rowSummary.abortedBy !== null;
        } else {
          // 票没铸出来（凭证过期等）：这几格一格都没写，照实记那个原因。
          const code = rowMint.code;
          results = runnable.entries.map<ApplyWriteResult>((entry) => ({ key: entry.key, label: entry.label, ok: false, reason: code }));
        }
      }
      // 这一段没存上：格照样上单子；再加一行说是第几段、还差什么，指着那一颗保存钮（它消失就是用户按了保存）。
      const unsaved = (reason: ApplyErrorCode, missing?: readonly string[]): void => {
        pushRows(collection, entryIndex, buildAuditView(runnable, results), entryRowView({
          key: null,
          label: saveLabel,
          required: true,
          status: 'NEEDS_MANUAL',
          reason,
          attemptedValue: null,
          resolvedOptionText: null,
          element: saveControl ?? rowElement,
          confidence: null,
          order: Number.MAX_SAFE_INTEGER,
          unsavedEntry: Object.freeze({
            collection,
            rowIndex: entryIndex,
            ...(missing === undefined ? {} : { missing: Object.freeze([...missing]) }),
          }),
        }));
        blocked.set(collection, reason);
        if (stop === null) stop = reason;
        emitRows();
      };
      if (runAborted || stopped()) {
        unsaved('ABORTED');
        halt('ABORTED');
        break;
      }
      // 回读过的才按保存：写了的每一格都确认填入，编辑框里的必填格都有值（没进计划的也算——宿主照样会拦）。
      const gaps = entryGaps(rowElement, next.descriptor.fields, runnable, results);
      if (gaps !== null) {
        unsaved(gaps.reason, gaps.labels);
        continue;
      }
      const saveAuth = mintRowActionAuthorityFromGesture({ proof: gesture, action: 'save', now: now() });
      const pressed = saveAuth.ok
        ? clickSaveRow({ descriptor: next.descriptor, collection, rowIndex: editorRow, authority: saveAuth.value, journal, policy, now: now() })
        : saveAuth;
      if (!pressed.ok) {
        unsaved(pressed.code);
        continue;
      }
      // 这一段留下了没有：编辑框收起、行数没少。到点还开着 = 网站自己的校验没过。
      const rowsWithEditor = entryEditorState(next.descriptor, collection).rows;
      const committed = await waitUntil(() => {
        const state = entryEditorState(next.descriptor, collection);
        return state.open.length === 0 && state.rows >= rowsWithEditor;
      }, ROW_SAVE_COMMIT_CAP_MS, input.signal);
      if (!committed) {
        if (stopped()) {
          unsaved('ABORTED');
          halt('ABORTED');
          break;
        }
        unsaved('HOST_REJECTED');
        continue;
      }
      saved += 1;
      // 存上了：一格一格的行换成一行「第几段 · 已替你保存」（那些格已经收进卡片、不在页面上了）。
      const written = runnable.entries.flatMap((entry, index) =>
        results[index]?.ok === true ? [entry.resolvedOptionText ?? entry.value] : []).join(' · ');
      pushRows(collection, entryIndex, entryRowView({
        key: null,
        label: saveLabel,
        required: runnable.entries.some((entry) => entry.required) || runnable.skipped.some((skip) => skip.required),
        status: 'FILLED',
        reason: null,
        attemptedValue: written === '' ? null : written,
        resolvedOptionText: null,
        element: rowElementAt(next.descriptor, collection, editorRow) ?? rowElement,
        confidence: null,
        order: Number.MAX_SAFE_INTEGER,
        savedEntry: Object.freeze({ collection, rowIndex: entryIndex }),
      }));
      emitRows();
      // 收成卡片之后宿主还要重排一会儿（放开「+ Add」、存草稿）：先等一下再重扫。
      await new Promise<void>((resolve) => { setTimeout(resolve, settleMs); });
      const after = await rescanSafely();
      if (after === null) { halt('IDENTITY_CHANGED'); break; }
      currentScan = after;
    }
    // 没加上的那几段（只看每一段要单独保存的区）：这个区停在了没存上的那一段，或整轮提前停了。单列一行，
    // 说是第几段到第几段、为什么、接下来怎么办；他再点一次自动填写，会从页面上已有的段数接着加。
    for (const collection of ['education', 'experience'] as const) {
      if (!rowNeedsSave(currentScan.descriptor, collection)) continue;
      const reason = blocked.get(collection) ?? loopStop;
      const anchor = rowAddAnchor(currentScan.descriptor, collection);
      const remaining = remainingEntries(currentScan.descriptor, collections, collection);
      if (reason === null || anchor === null || remaining === null) continue;
      pushRows(collection, remaining.from, entryRowView({
        key: null,
        label: controlText(anchor),
        required: true,
        status: 'NEEDS_MANUAL',
        reason,
        attemptedValue: null,
        resolvedOptionText: null,
        element: anchor,
        confidence: null,
        order: Number.MAX_SAFE_INTEGER,
        unaddedEntries: Object.freeze({ collection, from: remaining.from, to: remaining.to, afterUnsaved: blocked.has(collection) }),
      }));
    }
    rowAdds = Object.freeze({ added, saved, stop, unreachable });
  }

  const written = new Set(
    [...rememberedAnswers, ...revealedRemembered].map((answer) => `question:${answer.questionId}`),
  );
  const remembered = (key: string) =>
    written.has(key) ? ({ source: 'REMEMBERED_ANSWER' } as const) : {};
  const outcomeOf = (result: ApplyWriteResult): ReceiptFieldOutcome =>
    result.ok
      ? { key: result.key, ok: true, ...remembered(result.key) }
      : { key: result.key, ok: false, reason: result.reason, ...remembered(result.key) };
  // 第二遍的结论按「同一栏」并回第一遍那一条（规矩与面板上叠视图的那一套相同，见 supersedesResult）；
  // 新出现的题接在后面。逐项结果与面板因此说的是同一件事，不会一栏两条。附上过简历的，第一遍用宿主安静
  // 下来之后如实改判过的那一份（被宿主改掉的不再算成功，除非第二遍把它写了回来）。
  const firstBaseResults = firstResults ?? summary.results;
  const firstOutcomes = firstBaseResults.map(outcomeOf);
  const secondOutcomes: ReceiptFieldOutcome[] = [];
  if (second !== null) {
    const pass = second;
    const firstIndexOf = new Map<Element, number>(runnablePlan.entries.map((entry, index) => [entry.element, index]));
    pass.runnable.entries.forEach((entry, index) => {
      const result = pass.results[index];
      if (result === undefined) return;
      const earlier = pass.correspondence.get(entry.element);
      const at = earlier === undefined ? undefined : firstIndexOf.get(earlier);
      const previous = at === undefined ? undefined : firstBaseResults[at];
      if (at === undefined || previous === undefined) {
        secondOutcomes.push(outcomeOf(result));
        return;
      }
      if (supersedesResult(result, previous)) firstOutcomes[at] = outcomeOf(result);
    });
    secondOutcomes.push(...pass.blocked.map<ReceiptFieldOutcome>((result) => ({
      key: result.key,
      ok: false,
      reason: 'LEASE_INVALID',
    })));
  }
  const outcomes: ReceiptFieldOutcome[] = [
    ...firstOutcomes,
    ...secondOutcomes,
    ...rowResults.map<ReceiptFieldOutcome>((result) =>
      result.ok ? { key: result.key, ok: true } : { key: result.key, ok: false, reason: result.reason },
    ),
    ...outOfGrant,
  ];
  // grant 点名、却没能写成的记忆键逐条如实报告：题还在但答案没拿到 =
  // POLICY_DISABLED（签发到填写之间记忆被删或自动带出被关掉），题干脆不在本页上
  // 或身份变了 = LEASE_INVALID。猜一个"大概是这条"比不写危险得多。
  const reported = new Set(outcomes.map((outcome) => outcome.key));
  const refusedByPlan = new Map(plan.skipped.map((skip) => [skip.key, skip.reason]));
  for (const key of grantedQuestionKeys) {
    if (reported.has(key)) continue;
    outcomes.push({
      key,
      ok: false,
      reason:
        refusedByPlan.get(key as never) ??
        (rememberedOnPage.has(key) ? 'POLICY_DISABLED' : 'LEASE_INVALID'),
    });
  }

  // 攒下的问题在这里才发：这一轮该填的已经填完、回执数据已经齐了，
  // 收口发生在"我们能做的都做了"之后，而不是之前。
  for (const question of deferredQuestions) {
    progress.onNeedsUserInput?.(question.kind, question.fieldKey);
  }

  // 面板只提出这一轮**没被答上**的题：已由记忆填好的那些已经离开 skipped。第二遍重扫出来、仍然
  // 填不了的新题接在后面（题号另起前缀，不撞号；`answer` 从这张表把题号认回元素）。
  const firstReview = describeReviewable(plan);
  const { questions, reviewable, prefills, prefillBasis, reasons: reviewReasons } = revealedReview === null
    ? firstReview
    : {
        questions: [...firstReview.questions, ...revealedReview.questions],
        reviewable: new Map([...firstReview.reviewable, ...revealedReview.reviewable]),
        prefills: new Map([...firstReview.prefills, ...revealedReview.prefills]),
        prefillBasis: new Map([...firstReview.prefillBasis, ...revealedReview.prefillBasis]),
        reasons: new Map([...firstReview.reasons, ...revealedReview.reasons]),
      };

  // 终局视图与复核视图走同一条组装：复核只换两遍各自那一段结论，租约拦下的
  // 和加行的那些行一字不动——它们与「我们填的值还在不在」无关。第二遍按同一栏叠到第一遍上
  // （不是拼接：拼接会让一栏出现两行，一行红一行绿）。
  // AI 代答写过的几遍（自动代答一遍、用户每按一次「生成」一遍），按先后。
  const aiPasses: Array<{ readonly plan: ApplyPlan; readonly summary: ApplyRunSummary }> = [];
  // 第二遍重扫换掉的节点：面板上那一行仍挂在第一遍的元素上（与 `overlaySecondPass` 同一个对应）。
  const firstPassElement = (element: Element): Element => second?.correspondence.get(element) ?? element;
  /**
   * AI 写成的那几栏叠到单子上：每一栏取最近一次写成的那一行（改写顶替先前的代答），标上 `aiAnswered`。
   * 写了没写成的不叠——那一栏在页面上还是原来的样子，面板上就还是原来那一行（「需要你」）。
   */
  const overlayAi = (base: AuditView, results: readonly (readonly ApplyWriteResult[] | undefined)[]): AuditView => {
    const latest = new Map<Element, AiAnsweredAuditRow>();
    aiPasses.forEach((pass, index) => {
      for (const row of buildAuditView(pass.plan, results[index] ?? pass.summary.results).rows) {
        if (row.key !== null && (row.status === 'FILLED' || row.status === 'FILLED_UNVERIFIED')) {
          latest.set(row.element, Object.freeze({ ...row, aiAnswered: true as const }));
        }
      }
    });
    if (latest.size === 0) return base;
    return overlayAuditView(base, { ...base, rows: [...latest.values()] }, (row) => ({ sameAs: firstPassElement(row.element) }));
  };
  /**
   * 整轮之后宿主把我们填好的栏清空、我们在同一次点击之内重填的那几遍（2026-09-24，见 `repairReverted`）。
   * 写成的那几栏按同一栏叠到单子上，顶替「网站改掉了这一项」。
   */
  const repairPasses: Array<{ readonly plan: ApplyPlan; readonly summary: ApplyRunSummary }> = [];
  const overlayRepairs = (base: AuditView, results: readonly (readonly ApplyWriteResult[] | undefined)[]): AuditView => {
    const latest = new Map<Element, AuditRow>();
    repairPasses.forEach((pass, index) => {
      for (const row of buildAuditView(pass.plan, results[index] ?? pass.summary.results).rows) {
        if (row.key !== null && (row.status === 'FILLED' || row.status === 'FILLED_UNVERIFIED')) latest.set(row.element, row);
      }
    });
    if (latest.size === 0) return base;
    return overlayAuditView(base, { ...base, rows: [...latest.values()] }, (row) => ({ sameAs: firstPassElement(row.element) }));
  };
  /**
   * 用户自己答上的那几遍（浮层里点一个选项、填一句，或补答面板，2026-09-28，见 `answer`）：写成的那几栏按同一栏叠到
   * 单子上，标上 `userAnswered`——「需要你」里那一行随之离开，浮层写明是他答的；网站之后改掉了，复核照实改判。
   */
  const answerPasses: Array<{ readonly plan: ApplyPlan; readonly summary: ApplyRunSummary }> = [];
  const overlayAnswers = (base: AuditView, results: readonly (readonly ApplyWriteResult[] | undefined)[]): AuditView => {
    const latest = new Map<Element, UserAnsweredAuditRow>();
    answerPasses.forEach((pass, index) => {
      for (const row of buildAuditView(pass.plan, results[index] ?? pass.summary.results).rows) {
        if (row.key !== null && (row.status === 'FILLED' || row.status === 'FILLED_UNVERIFIED')) {
          latest.set(row.element, Object.freeze({ ...row, userAnswered: true as const }));
        }
      }
    });
    if (latest.size === 0) return base;
    return overlayAuditView(base, { ...base, rows: [...latest.values()] }, (row) => ({ sameAs: firstPassElement(row.element) }));
  };
  const composeView = (
    results: readonly ApplyWriteResult[],
    secondResults?: readonly ApplyWriteResult[],
    aiResults: readonly (readonly ApplyWriteResult[] | undefined)[] = [],
    repairResults: readonly (readonly ApplyWriteResult[] | undefined)[] = [],
    answerResults: readonly (readonly ApplyWriteResult[] | undefined)[] = [],
  ): AuditView => {
    const first = firstView(results);
    const merged = second === null ? first : overlaySecondPass(first, second, secondResults ?? second.results);
    const all = mergeAuditViews([markSiteFilledView(merged), ...rowViews]);
    const withAi = aiPasses.length === 0 ? all : overlayAi(all, aiResults);
    const withRepairs = repairPasses.length === 0 ? withAi : overlayRepairs(withAi, repairResults);
    return answerPasses.length === 0 ? withRepairs : overlayAnswers(withRepairs, answerResults);
  };
  const recheckView = (): AuditView =>
    composeView(
      summary.recheck(),
      second?.summary?.recheck(),
      aiPasses.map((pass) => pass.summary.recheck()),
      repairPasses.map((pass) => pass.summary.recheck()),
      answerPasses.map((pass) => pass.summary.recheck()),
    );

  // —— 这一轮之后的写入（AI 代答、「用 AI 写」）——
  // 写入仍在这一轮的边界之内：外部 abort、runner 的 stop、lease 到期、扫描不再当前、调用方说这一轮作废
  // （开了新的一轮、翻了页、撤销了、关了开关），任一成立即零写入。一次点击不能重开已停止的一轮。
  const laterStale = (): ApplyErrorCode | null =>
    input.signal?.aborted || progress.shouldStop() ? 'ABORTED'
      : now() >= grant.leaseExpiresAt * 1000 ? 'LEASE_INVALID'
        : input.scanStillCurrent?.() === false ? 'IDENTITY_CHANGED'
          : input.laterWritesCurrent?.() === false ? 'ABORTED'
            : null;
  /** 第一遍的那个节点此刻在手里这份扫描里是哪一个（第二遍重扫可能把它换掉了）。 */
  const liveElementFor = (element: Element): Element | null => {
    const fields = currentScan.descriptor.fields;
    if (fields.some((field) => field.element === element)) return element;
    for (const [later, earlier] of second?.correspondence ?? []) {
      if (earlier === element && fields.some((field) => field.element === later)) return later;
    }
    return null;
  };
  const writeAiAnswers = async (
    answers: readonly QuestionAnswer[],
    proof: GestureRoot,
    options: KernelAiWriteOptions,
  ): Promise<KernelAiWrite> => {
    const blocked = laterStale();
    if (blocked !== null) return { ok: false, code: blocked };
    const targeted: QuestionAnswer[] = [];
    for (const answer of answers) {
      const element = liveElementFor(answer.element);
      if (element === null) continue;
      // 按「生成」之后、写之前，用户自己动了这一栏：不覆盖。
      if (options.unchangedFrom !== undefined && (element as HTMLInputElement | HTMLTextAreaElement).value !== options.unchangedFrom) {
        return { ok: false, code: 'NOT_EMPTY' };
      }
      targeted.push({ ...answer, element });
    }
    const built = buildAnswerPlan(currentScan.descriptor, targeted, { readGeometry: readHostGeometry, capabilities: planOptions.capabilities });
    const aiPlan: ApplyPlan = options.fillEmptyOnly ? built : { ...built, fillEmptyOnly: false };
    if (aiPlan.entries.length === 0) {
      return { ok: false, code: targeted.length === 0 ? 'DETACHED' : aiPlan.skipped[0]?.reason ?? 'UNSUPPORTED_CONTROL' };
    }
    const aiMint = mintAuthorityFromGesture({
      proof,
      purpose: 'fill',
      fingerprint: aiPlan.fingerprint,
      capabilities: new Set([...capabilitiesForPlan(aiPlan)].filter((capability) => policy.capabilities[capability])),
      now: now(),
    });
    if (!aiMint.ok) return { ok: false, code: aiMint.code };
    const envelope = new AbortController();
    const abortLater = () => envelope.abort();
    input.signal?.addEventListener('abort', abortLater, { once: true });
    const watch = setInterval(() => { if (laterStale() !== null) envelope.abort(); }, STOP_POLL_MS);
    try {
      const aiSummary = await runApplyPlan({
        plan: aiPlan,
        auth: aiMint.value,
        journal,
        readHostValidation: readHostValidationSignals,
        lateRecheckMs: LATE_RECHECK_MS,
        root: currentScan.descriptor.root,
        policy,
        signal: envelope.signal,
        ...(input.scanStillCurrent === undefined ? {} : { scanStillCurrent: input.scanStillCurrent }),
        now,
      });
      aiPasses.push({ plan: aiPlan, summary: aiSummary });
      return { ok: true, view: recheckView(), written: aiSummary.results.filter((result) => result.ok).length };
    } finally {
      clearInterval(watch);
      input.signal?.removeEventListener('abort', abortLater);
    }
  };

  // —— 整轮之后宿主清空了我们填好的栏：同一次点击之内重填一次（2026-09-24）——
  // Lever 附上简历之后约三秒（简历解析是一次服务端往返）把「Current location」的文字清掉，晚于附完简历之后等宿主安静的
  // 那一段，于是整轮收尾时它还在、过几秒就没了，浮层改判「网站改掉了这一项」而页面上那一栏是空的必填（Spotify、
  // Shield AI 实测）。复核看到这样的栏，就按资料重填一次：
  //  · 只填**被清空**的栏（宿主改成了别的值的不碰——那可能是它从简历里读出来的、也可能是用户改的）；
  //  · 用户在这一轮之后亲手动过、或正聚焦在那一栏的，不碰；
  //  · 只一次；仍在这一轮的边界之内（与 AI 代答的后写同一套 `laterStale`），凭证过期就不写；
  //  · 文件、单选／复选、富文本不在这条路上。
  const lateEdits = input.gesture !== undefined && hostDocument !== null ? watchTrustedEdits(hostDocument) : null;
  if (lateEdits !== null) setTimeout(() => { lateEdits.stop(); }, LATE_REPAIR_WINDOW_MS);
  let lateRepairUsed = false;
  const repairReverted = async (proof: GestureRoot): Promise<KernelAiWrite> => {
    const blocked = laterStale();
    if (blocked !== null) return { ok: false, code: blocked };
    if (lateRepairUsed) return { ok: false, code: 'GRANT_CONSUMED' };
    const emptied = new Set<Element>();
    for (const row of recheckView().rows) {
      if (row.key === null || row.status !== 'FAILED' || row.reason !== 'LATE_REVERTED') continue;
      const element = liveElementFor(row.element);
      if (element === null || !element.isConnected || element.ownerDocument.activeElement === element) continue;
      if (lateEdits?.touched(element) === true || userEdits?.touched(element) === true) continue;
      if (hostFieldHasValue(element)) continue;
      emptied.add(element);
    }
    const built = buildApplyPlan(currentScan.descriptor, profile, planOptions);
    const entries = built.entries.filter((entry) =>
      emptied.has(entry.element) && approved.has(entry.key) &&
      entry.kind !== 'file' && entry.kind !== 'choice' && entry.kind !== 'richtext');
    if (entries.length === 0) return { ok: false, code: 'NOT_EMPTY' };
    lateRepairUsed = true;
    const repairPlan: ApplyPlan = { ...built, entries, skipped: [] };
    const repairMint = mintAuthorityFromGesture({
      proof,
      purpose: 'fill',
      fingerprint: repairPlan.fingerprint,
      capabilities: new Set([...capabilitiesForPlan(repairPlan)].filter((capability) => policy.capabilities[capability])),
      now: now(),
    });
    if (!repairMint.ok) return { ok: false, code: repairMint.code };
    const envelope = new AbortController();
    const abortLater = () => envelope.abort();
    input.signal?.addEventListener('abort', abortLater, { once: true });
    const watch = setInterval(() => { if (laterStale() !== null) envelope.abort(); }, STOP_POLL_MS);
    try {
      const repairSummary = await runApplyPlan({
        plan: repairPlan,
        auth: repairMint.value,
        journal,
        readHostValidation: readHostValidationSignals,
        lateRecheckMs: LATE_RECHECK_MS,
        root: currentScan.descriptor.root,
        policy,
        signal: envelope.signal,
        ...(input.scanStillCurrent === undefined ? {} : { scanStillCurrent: input.scanStillCurrent }),
        now,
      });
      repairPasses.push({ plan: repairPlan, summary: repairSummary });
      return { ok: true, view: recheckView(), written: repairSummary.results.filter((result) => result.ok).length };
    } finally {
      clearInterval(watch);
      input.signal?.removeEventListener('abort', abortLater);
    }
  };

  const attachCoverLetter = async (proof: GestureRoot, material: KernelCoverLetterMaterial): Promise<KernelAiWrite> => {
    const blocked = laterStale();
    if (blocked !== null) return { ok: false, code: blocked };
    const built = buildApplyPlan(currentScan.descriptor, profile, { ...planOptions, ...coverLetterPlanOptions(material) });
    const entries = built.entries.filter((entry) => entry.key === 'coverLetter');
    if (entries.length === 0) return { ok: false, code: 'NOT_EMPTY' };
    const letterPlan: ApplyPlan = { ...built, entries, skipped: [] };
    const letterMint = mintAuthorityFromGesture({
      proof,
      purpose: 'fill',
      fingerprint: letterPlan.fingerprint,
      capabilities: new Set([...capabilitiesForPlan(letterPlan)].filter((capability) => policy.capabilities[capability])),
      now: now(),
    });
    if (!letterMint.ok) return { ok: false, code: letterMint.code };
    const envelope = new AbortController();
    const abortLater = () => envelope.abort();
    input.signal?.addEventListener('abort', abortLater, { once: true });
    const watch = setInterval(() => { if (laterStale() !== null) envelope.abort(); }, STOP_POLL_MS);
    try {
      const letterSummary = await runApplyPlan({
        plan: letterPlan,
        auth: letterMint.value,
        journal,
        readHostValidation: readHostValidationSignals,
        lateRecheckMs: LATE_RECHECK_MS,
        root: currentScan.descriptor.root,
        policy,
        signal: envelope.signal,
        ...(material.file === undefined ? {} : { resolveCoverLetterFile: onceResume(material.file.resolve) }),
        ...(input.scanStillCurrent === undefined ? {} : { scanStillCurrent: input.scanStillCurrent }),
        now,
      });
      // 与补填同一本账：终局单子按它重画，求职信那一栏从「正在写」变成写上了（或照实的失败原因）。
      repairPasses.push({ plan: letterPlan, summary: letterSummary });
      return { ok: true, view: recheckView(), written: letterSummary.results.filter((result) => result.ok).length };
    } finally {
      clearInterval(watch);
      input.signal?.removeEventListener('abort', abortLater);
    }
  };

  const auditView = composeView(firstBaseResults);
  // 浮层里当场答（2026-09-28）：单子上那一行的元素 → 那道题。计划期跳过、答案该由用户给的题照元素认（只能本人处理的
  // MANUAL_ONLY 不给）；写入期没对上选项的单选题另起题号（`c<序号>`），写的时候按此刻这份扫描里的那个节点写。
  const dockQuestions = new Map<Element, QuestionDescription>();
  for (const question of questions) {
    const element = reviewable.get(question.questionId);
    const reason = reviewReasons.get(question.questionId);
    if (element !== undefined && reason !== undefined && reason !== 'MANUAL_ONLY') dockQuestions.set(element, question);
  }
  const retryable = new Map<string, Element>();
  for (const row of auditView.rows) {
    // 计划期就判出来的是 NEEDS_MANUAL，写的时候才失手的是 FAILED：两种都是这一类。
    if ((row.status !== 'FAILED' && row.status !== 'NEEDS_MANUAL') || row.reason === null || !DOCK_RETRY_REASONS.has(row.reason) || dockQuestions.has(row.element)) continue;
    const live = liveElementFor(row.element);
    const order = live === null ? -1 : currentScan.descriptor.fields.findIndex((field) => field.element === live);
    const field = order < 0 ? undefined : currentScan.descriptor.fields[order];
    const question = field === undefined || live === null ? null : describeQuestion(field, `c${order}`);
    if (question === null || question.controlType !== 'SINGLE_CHOICE') continue;
    dockQuestions.set(row.element, question);
    retryable.set(question.questionId, live!);
  }

  input.onAudit?.({
    view: auditView,
    recheck: recheckView,
    ...(input.gesture === undefined ? {} : { writeAiAnswers, repairReverted, attachCoverLetter }),
    questions,
    prefills,
    prefillBasis,
    rowAdds,
    settle,
    unshown: [...plan.skipped.filter((skip) => UNSHOWN_SKIP_REASONS.has(skip.reason)).map((skip) => skip.element), ...revealedUnshown],
    scanFields: () => currentScan.descriptor.fields,
    questionAt: (element) => dockQuestions.get(element) ?? null,
    answer: async (event, shadowRoot, answers, confirm) => {
      const targeted = answers.flatMap((answer) => {
        const element = reviewable.get(answer.questionId) ?? retryable.get(answer.questionId);
        return element ? [{ questionId: answer.questionId, element, value: answer.value }] : [];
      });
      const answerPlan = buildAnswerPlan(currentScan.descriptor, targeted, { readGeometry: readHostGeometry });
      const refused = answerPlan.skipped.flatMap<ApplyWriteResult>((skip) =>
        (skip.key === null ? [] : [{ key: skip.key, label: skip.label, ok: false, reason: skip.reason }]));
      const refuseAll = (reason: ApplyErrorCode): readonly ApplyWriteResult[] =>
        [...refused, ...answerPlan.entries.map<ApplyWriteResult>((entry) => ({ key: entry.key, label: entry.label, ok: false, reason }))];
      // A late answer lives inside the same envelope as the fill it belongs to: the caller's
      // abort signal, the runner's stop request, the lease deadline and the scan's currentness
      // are re-checked before the click is honoured and polled through every write. A click
      // alone never re-opens a run that has been stopped.
      const stale = (): ApplyErrorCode | null =>
        input.signal?.aborted || progress.shouldStop() ? 'ABORTED'
          : now() >= grant.leaseExpiresAt * 1000 ? 'LEASE_INVALID'
            : input.scanStillCurrent?.() === false ? 'IDENTITY_CHANGED'
              : null;
      const blocked = stale();
      if (blocked !== null) return refuseAll(blocked);
      // The proof of the user's click is taken now, synchronously: once the browser has finished
      // dispatching the event its composedPath() is empty, so anything awaited before this point
      // would turn a genuine click into GESTURE_FOREIGN. The minted authority keeps its own TTL.
      const minted = mintAuthority({
        event,
        shadowRoot,
        purpose: 'fill',
        fingerprint: answerPlan.fingerprint,
        capabilities: new Set([...capabilitiesForPlan(answerPlan)].filter((capability) => policy.capabilities[capability])),
      });
      if (!minted.ok) return refuseAll('CAPABILITY_DISABLED');
      // The caller's confirmation (a fresh server answer) runs after the proof exists; the
      // envelope is re-checked once it returns, so a stop or expiry during the wait still wins.
      if (confirm && !(await confirm())) return refuseAll('POLICY_DISABLED');
      const late = stale();
      if (late !== null) return refuseAll(late);
      const envelope = new AbortController();
      const abortAnswer = () => envelope.abort();
      input.signal?.addEventListener('abort', abortAnswer, { once: true });
      const watch = setInterval(() => { if (stale() !== null) envelope.abort(); }, STOP_POLL_MS);
      try {
        const written = await runApplyPlan({
          plan: answerPlan,
          auth: minted.value,
          journal,
          readHostValidation: readHostValidationSignals,
          lateRecheckMs: LATE_RECHECK_MS,
          root: currentScan.descriptor.root,
          policy,
          signal: envelope.signal,
          ...(input.scanStillCurrent === undefined ? {} : { scanStillCurrent: input.scanStillCurrent }),
          now,
        });
        // 答上的那几栏叠进单子（复核照样盯着）：浮层据此把那一行移出「需要你」、写明是他答的。
        answerPasses.push({ plan: answerPlan, summary: written });
        return [...refused, ...written.results];
      } finally {
        clearInterval(watch);
        input.signal?.removeEventListener('abort', abortAnswer);
      }
    },
    canUndo: () => journal.canUndo(),
    undoAll: async (event, shadowRoot) => {
      const undoAuth = mintAuthority({
        event,
        shadowRoot,
        purpose: 'undo',
        fingerprint: null,
        capabilities: journal.requiredUndoCapabilities(),
      });
      if (!undoAuth.ok) return;
      if (journal.requiredUndoCapabilities().has('set-richtext')) {
        await journal.undoAllSettled(undoAuth.value);
      } else {
        journal.undoAll(undoAuth.value);
      }
    },
  });

  for (const outcome of outcomes) progress.onOutcome(outcome);
  return outcomes;
}
