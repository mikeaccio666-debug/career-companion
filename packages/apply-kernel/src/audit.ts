/**
 * 逐字段审计视图（CAP-AF-063）。
 *
 * 一轮跑完之后，内核手里握着 38 条逐字段原因码、每个条目的置信度、元素引用
 * 与一本 undo journal；用户手里只有一行「已填 2/3 · 请核对后自行提交」。
 * 这个模块把前者摊成一份**表单的镜像列表**，是面板唯一的数据来源。
 *
 * ## 为什么是"镜像列表"而不是"错误清单"
 *
 * 铁律 3 不许给宿主节点上样式，绿/黄标记画不到输入框上。所以能给用户的
 * 只剩我方 Shadow 浮层里的一列行，而那列行必须**逐行对得上页面上的一栏**
 * ——否则 [locate] 跳到哪一栏、"还差两项"指的是哪两项，用户都无从对照。
 * 这就是 `order` 存在的全部理由：`entries` 与 `skipped` 是同一次扫描里
 * 分流出去的两个数组，靠它才能重新合回表单顺序。
 *
 * ## 纯函数边界
 *
 * 这里一行 DOM API 都不调用（RULE-KERNEL-DETERMINISTIC-BOUNDARY）。
 * `element` 只是原样透传给渲染层做 `scrollIntoView`，本模块从不读它。
 */

import type { ApplyEntryKey, ApplyErrorCode, ApplyPlan, ApplyWriteResult, HistoryAnswerBasis, NotAddedValue } from './contracts';

/**
 * 一行在面板上的档位。
 *
 * 分档的判据只有一个：**用户看到它之后的下一步动作**。两件事下一步动作相同
 * 就该合档，不同就必须分开——把它们混在一个"失败"里，用户要么白等，要么
 * 跑去改一个根本不该他改的东西。
 */
export type AuditStatus =
  /** 写进去了，并且回读确认过。 */
  | 'FILLED'
  /**
   * 动作做了，但读不回确认（今天只有一种：文件写完之后宿主把 input 卸掉／换成
   * 一个文件名 chip，没有可读的控件状态了）。控件还在的文件写入读得回来，算
   * FILLED。必须与 FILLED 分开显示——否则"点了但没生效"和"确认填入"在屏幕上
   * 长得一模一样，用户就不会去核对那一栏。见 contracts.ts `unverified` 头注。
   */
  | 'FILLED_UNVERIFIED'
  /** 值留住了，但宿主自己判它无效。下一步是"你改这个值"。 */
  | 'REJECTED'
  /** 没写进去。下一步是"可以重试或自己填"。 */
  | 'FAILED'
  /** 只能用户自己答（岗位相关题、铁律 5 四类、他人信息、我们填不了的控件）。 */
  | 'NEEDS_MANUAL'
  /**
   * 乙档：我们认出了题、档案里有值、页面上也挑好了那一项，但**放行仍是用户的
   * 一次动作**（EEO 自我认同、工作授权／担保）。
   *
   * 必须与 NEEDS_MANUAL 分开：那一档用户要自己想答案，这一档答案已经摆好，
   * 他只需要看一眼点确认。合并会让「等你填」盖住我们其实已经备好的事实。
   * 更要与 FAILED 分开——2026-09-17 这个码刚加时没有分支，落到末尾的
   * FAILED，于是每预填一题就给自己记一笔「没做好」。
   */
  | 'NEEDS_CONFIRMATION'
  /** 认出了字段，档案里没有这一项。下一步在**档案**里，不在这张表上。 */
  | 'MISSING_PROFILE'
  /** 我们有值但不够有把握，没敢写。下一步是用户一键 [仍然填]。 */
  | 'LOW_CONFIDENCE'
  /** 页面上本来就有内容，我们按 fillEmptyOnly 没动。不用管。 */
  | 'PREFILLED';

export interface AuditRow {
  /** 被跳过的行可能压根没匹配上档案键。 */
  readonly key: ApplyEntryKey | null;
  readonly label: string;
  readonly required: boolean;
  readonly status: AuditStatus;
  /** 稳定原因码；已填成功的行没有。 */
  readonly reason: ApplyErrorCode | null;
  /** 我们试图写入的值（含被拒/失败的行——用户要看的正是"我们打算写什么"）。 */
  readonly attemptedValue: string | null;
  /** select 条目在计划期判决出的将选中项文字（CAP-AF-044）。 */
  readonly resolvedOptionText: string | null;
  /** 原样透传给渲染层做 scrollIntoView。本模块从不读它。 */
  readonly element: Element;
  readonly confidence: number | null;
  readonly order: number;
  /** 工作授权／担保的答案按岗位地点推断出国家时，那个国家的 ISO 码（渲染层据此写明依据）。 */
  readonly inferredRegionCode?: string;
  /**
   * 工作授权／担保的答案是按默认答的（2026-09-24 负责人决定：他有别国的记录、唯独没有这一国的）：那一国的 ISO 码。
   * 只在计划条目的行上出现；渲染层据此写明「你的资料里没有在 X 工作的许可记录，默认答了…」。
   */
  readonly defaultedRegionCode?: string;
  /** 答案是按学历／工作经历推出来的（2026-09-24）：依据的稳定码，渲染层据此写明是怎么推的。 */
  readonly historyBasis?: HistoryAnswerBasis;
  /**
   * 工作授权题说得出是哪一国、而用户在那一国没有工作许可记录（2026-09-24）：那一国的 ISO 码。只在跳过的
   * 行上出现；渲染层据此照实说「你的资料里没有在 X 工作的许可记录」，而不是「取决于这个岗位」。
   */
  readonly regionWithoutRecord?: string;
  /**
   * 这一栏不是我们写的、也不是用户写的：我们附上简历之后，网站自己从简历里读出来填上的（2026-09-24）。
   * 只出现在 `PREFILLED` 的行上；渲染层据此照实说「网站从你的简历里读的」，不把它记成用户补上的。
   * 由调用方判定（它知道这一次点击附没附简历、用户动没动过这一栏），本模块只透传。
   */
  readonly siteFilled?: 'FROM_RESUME';
  /**
   * 这一行不是一栏，是一段**我们加了、填了、没能保存下来**的经历／教育（2026-09-24）：每一段要单独保存的区
   * （Workable 的「Update」）。`rowIndex` 是资料里的第几段（0 基）。元素是那一段的保存控件（定位用；它从页面上
   * 消失就是用户按了保存）。`missing`：还差的那几格（宿主的标签）——必填空着、或填了没回读成，我们因此没按保存；
   * 没有 `missing` 就是按了没存上（原因码说是网站没收下还是这一下没点成）。
   */
  readonly unsavedEntry?: Readonly<{ collection: 'education' | 'experience'; rowIndex: number; missing?: readonly string[] }>;
  /**
   * 这一行不是一栏，是一段**我们加了、填了、回读过、替用户按了规则声明的保存钮、网站收下了**的经历／教育
   * （2026-09-24 负责人：「和 Jobright 一样全加全存」）。`rowIndex` 是资料里的第几段（0 基）。它替掉那一段里
   * 一格一格的行（编辑框收成卡片之后那些格已经不在页面上了）；值是填进去的内容，标签是保存钮上的字。
   */
  readonly savedEntry?: Readonly<{ collection: 'education' | 'experience'; rowIndex: number }>;
  /**
   * 资料里有、但这一轮**没有加进网站**的那几段（0 基，含两端）：每一段要单独保存的区停在了某一段上
   * （`afterUnsaved`：前一段没存上，这个区加不了下一段），或整轮停了（票过期、加一行没点成）。元素是那个区的
   * 「加一行」控件（定位用）。
   */
  readonly unaddedEntries?: Readonly<{ collection: 'education' | 'experience'; from: number; to: number; afterUnsaved: boolean }>;
  /** A several-value widget (Workday Skills) that took only some values: the others, each with its stable reason. */
  readonly notAdded?: readonly NotAddedValue[];
}

export interface AuditView {
  readonly rows: readonly AuditRow[];
  /** 回读确认过的写入数。`FILLED_UNVERIFIED` **不**计入。 */
  readonly filled: number;
  readonly requiredTotal: number;
  readonly requiredHandled: number;
  /**
   * 还需要有人动手的行数 = `blockedByUs + awaitingUser`。面板的行动号召量这个，
   * 不是失败数——"页面本来就填好"与"已填"都不该催用户。
   */
  readonly needsAttention: number;
  /**
   * 该由**我们**解决的行数。上线口径量的是这个，自动推进的闸门也只该架在它上面。
   */
  readonly blockedByUs: number;
  /**
   * 当前 runtime 必须交还**用户本人**在页面上做的行数。它不是缺陷计数；即使未来
   * pending proposal 的窄类别获批，验证码、营销等永久人工项仍可能使它不归零。
   * 因此不得当作停止条件——但必须逐条显示并给 [定位]，否则用户点提交才发现。
   */
  readonly awaitingUser: number;
}

/**
 * 绝不出现在面板上的跳过原因。
 *
 * 这不是排序或折叠问题，是**不得出现**：
 *  · `HONEYPOT` —— 列表里每一行天然带着"要不要处理一下"的暗示，把蜜罐摆上去
 *    等于把陷阱指给用户看，而填了蜜罐是整份申请作废。
 *  · `SENSITIVE_OPT_OUT` —— 用户主动关掉了这一类；再摆回他眼前，就是把他刚
 *    关掉的东西重新推回来。它连必填分母都不进（见 engine.ts summarizePlan）。
 *  · `DUPLICATE_FIELD` —— 同节同键仲裁掉的那个落选控件；胜出的那一行已经在
 *    列表里了，再列一行只会让用户以为有两栏要管。
 */
const HIDDEN_REASONS: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>([
  'HONEYPOT',
  'SENSITIVE_OPT_OUT',
  'DUPLICATE_FIELD',
]);

/** 下一步在页面上、只能用户自己动手的那些跳过原因。 */
const MANUAL_REASONS: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>([
  'MANUAL_ONLY',
  'USER_ONLY',
  'OTHER_PERSON',
  'JOB_DEPENDENT',
  'HOST_UNCONFIRMED',
  'CHOICE_NO_DATA',
  'UNSUPPORTED_CONTROL',
  'NO_OPTION_MATCH',
  'AMBIGUOUS_OPTION',
]);

/**
 * 「我们没做好」——该由**我们**去解决的档位。
 *
 * 这一类是**应该归零的**：2026-08-21 实测 5 份夹具 14 条跳过里 13 条属这里，
 * 其中 9 条 LOW_CONFIDENCE 的标签都很干净（Current company / Address / Postcode /
 * Cover letter …），认不出纯粹因为档案只有 11 个键（扩键归 T3 的 CAP-AF-018）。
 * 它没归零就是我们还有活没干完。
 */
const OUR_PROBLEM_STATUSES: ReadonlySet<AuditStatus> = new Set<AuditStatus>([
  'REJECTED',
  'FAILED',
  'MISSING_PROFILE',
  'LOW_CONFIDENCE',
  'FILLED_UNVERIFIED',
]);

/**
 * 「轮到你了」——当前 runtime 只能交还用户本人在页面上做的档位。
 *
 * 这一类在当前 runtime **不能假定归零**：工作授权、EEO、「I certify」在真实美国 ATS 表上几乎必现，
 * 且验证码、营销订阅、联系现任雇主和未列明／混合授权继续永久人工。pending proposal 只覆盖其窄子集，
 * 不得用未来可能的放行推断本轮没有用户动作。
 * 所以它绝不能和上面那类混成一个数——混了之后任何「没归零就停」的闸门都等于
 * 每一岗都停，那正是把一件对的事（有问题就停）做成一件蠢事的方式。
 *
 * 注意它仍然**进必填分母、不进分子**（engine.ts summarizePlan 同口径）：
 * 这是刻意的安全属性，`apply-job-dependent.test.ts` 锁着——报「必填 4/4 已就绪」
 * 而用户其实还没答工签，等于告诉他可以提交了。
 */
const AWAITING_USER_STATUSES: ReadonlySet<AuditStatus> = new Set<AuditStatus>(['NEEDS_MANUAL', 'NEEDS_CONFIRMATION']);

function skipStatus(reason: ApplyErrorCode): AuditStatus {
  if (reason === 'NOT_EMPTY') return 'PREFILLED';
  if (reason === 'NO_VALUE') return 'MISSING_PROFILE';
  if (reason === 'LOW_CONFIDENCE') return 'LOW_CONFIDENCE';
  if (reason === 'PREFILLED_NEEDS_CONFIRMATION') return 'NEEDS_CONFIRMATION';
  if (MANUAL_REASONS.has(reason)) return 'NEEDS_MANUAL';
  // 计划期还能落到这里的都是"我们没能处理"，对用户就是一次失败。
  return 'FAILED';
}

function writeStatus(result: ApplyWriteResult, isCombobox: boolean): AuditStatus {
  if (result.ok) return result.unverified === true ? 'FILLED_UNVERIFIED' : 'FILLED';
  if (isCombobox && result.reason === 'NOT_EMPTY') return 'PREFILLED';
  if (result.reason === 'HOST_REJECTED') return 'REJECTED';
  return 'FAILED';
}

/** 一份行列表的计数。三处（建视图、拼视图、叠视图）共用这一个口径，不许各算各的。 */
function viewOf(rows: readonly AuditRow[]): AuditView {
  let filled = 0;
  let requiredTotal = 0;
  let requiredHandled = 0;
  let blockedByUs = 0;
  let awaitingUser = 0;
  for (const row of rows) {
    if (row.status === 'FILLED') filled += 1;
    if (row.required) {
      requiredTotal += 1;
      // "已经不需要用户操心"= 我们确认填了 + 页面上本来就填好了。
      // FILLED_UNVERIFIED 不算：它恰恰是那条"请你自己去看一眼"的。
      if (row.status === 'FILLED' || row.status === 'PREFILLED') requiredHandled += 1;
    }
    if (OUR_PROBLEM_STATUSES.has(row.status)) blockedByUs += 1;
    else if (AWAITING_USER_STATUSES.has(row.status)) awaitingUser += 1;
  }
  return {
    rows,
    filled,
    requiredTotal,
    requiredHandled,
    needsAttention: blockedByUs + awaitingUser,
    blockedByUs,
    awaitingUser,
  };
}

/**
 * 把几份视图并成一份（P1-8b）：主轮一份，之后每加一行、重扫、再填一行各一份。
 *
 * 行只是拼接，不重排——各份的 `order` 来自各自那一次扫描，跨扫描比较没有意义；主轮在前、
 * 新行按加的先后在后，恰好也是页面上的顺序。计数按同一套口径重算。
 */
export function mergeAuditViews(views: readonly AuditView[]): AuditView {
  return viewOf(views.flatMap((view) => view.rows));
}

/**
 * 第二遍的一行落在第一遍的哪里。
 *
 * `sameAs`：这是第一遍已经有一行的同一栏（那一行的宿主元素）。
 * `after`：这是新出现的题，页面上跟在第一遍这一行（的元素）后面；`null` = 排在最前。
 */
export type AuditOverlayPlacement =
  | Readonly<{ sameAs: Element }>
  | Readonly<{ after: Element | null }>;

/** 写过、而且写成了。 */
function isWriteSuccess(row: AuditRow): boolean {
  return row.status === 'FILLED' || row.status === 'FILLED_UNVERIFIED';
}

/**
 * 写过、但没写成。计划条目的行才带 `key`（跳过的行一律 null）；`NOT_EMPTY` 不算——那是写之前
 * 看到「已经有值」而没写，第一遍刚填进去的值在第二遍眼里就是这个样子。
 */
function isWriteFailure(row: AuditRow): boolean {
  return row.key !== null &&
    (row.status === 'FAILED' || row.status === 'REJECTED') &&
    row.reason !== 'NOT_EMPTY';
}

/** 第二遍的这一行该不该顶替第一遍同一栏的那一行。 */
function supersedes(later: AuditRow, earlier: AuditRow): boolean {
  if (isWriteSuccess(later)) return earlier.status !== 'FILLED';
  if (isWriteFailure(later)) return earlier.status === 'FAILED' && earlier.reason !== 'NOT_EMPTY';
  return false;
}

/**
 * 同一次点击里「重扫、补填」的第二遍，叠到第一遍的视图上（2026-09-23）。
 *
 * 与 `mergeAuditViews` 不是一回事：加行那几份说的是页面上**新长出来的行**，拼接就对；第二遍
 * 说的多半是**第一遍已经有一行的同一栏**——第一遍因为页面重渲染没写成（身份变了、节点换了），
 * 第二遍在新的一代 DOM 上写成了。拼接会让同一栏出现两行，一行红一行绿，用户不知道信哪一行。
 *
 * 同一栏（`sameAs`）的规矩：
 *  · 第二遍写成了 → 顶替，除非第一遍那一行本来就是 FILLED；
 *  · 第二遍写了没写成 → 只顶替第一遍同样写了没写成（FAILED，且不是 NOT_EMPTY）的那一行，换成更新的诊断；
 *  · 其余（第二遍没写：已有值、跳过）→ 第一遍那一行不动。第一遍填上的一栏第二遍看到「已经有值」，
 *    那是我们刚填的值，不许把「已填」降成「页面本来就有」。
 * 新出现的题（`after`）插在它在页面上前一栏的那一行后面；找不到那一行就接在最后。
 * 计数按同一套口径重算。本模块照旧不读 DOM：同一栏怎么认由调用方的 `place` 回答。
 */
export function overlayAuditView(
  base: AuditView,
  overlay: AuditView,
  place: (row: AuditRow) => AuditOverlayPlacement,
): AuditView {
  const indexOf = new Map<Element, number>();
  base.rows.forEach((row, index) => {
    if (!indexOf.has(row.element)) indexOf.set(row.element, index);
  });
  const replaced = new Map<number, AuditRow>();
  // 插入点：-1 = 最前，base.rows.length = 最后。
  const inserted = new Map<number, AuditRow[]>();
  const insert = (at: number, row: AuditRow): void => {
    const list = inserted.get(at) ?? [];
    list.push(row);
    inserted.set(at, list);
  };
  for (const row of overlay.rows) {
    const placement = place(row);
    if ('sameAs' in placement) {
      const index = indexOf.get(placement.sameAs);
      if (index === undefined) {
        insert(base.rows.length, row);
        continue;
      }
      const earlier = replaced.get(index) ?? base.rows[index]!;
      if (supersedes(row, earlier)) replaced.set(index, row);
      continue;
    }
    if (placement.after === null) {
      insert(-1, row);
      continue;
    }
    insert(indexOf.get(placement.after) ?? base.rows.length, row);
  }
  const rows: AuditRow[] = [...(inserted.get(-1) ?? [])];
  base.rows.forEach((row, index) => {
    rows.push(replaced.get(index) ?? row);
    rows.push(...(inserted.get(index) ?? []));
  });
  rows.push(...(inserted.get(base.rows.length) ?? []));
  return viewOf(rows);
}

/**
 * 把一份计划与它的写入结果合成面板要渲染的那份列表。
 *
 * 结果与 `plan.entries` **按下标对齐**（runner 里 `results[index] = …`）。
 * `results` 缺某个条目（整轮被中止、或那一条压根没跑到）时该行仍要出现——
 * 面板上"少一行"比"多一行写着未执行"危险得多：用户会以为那一栏不存在。
 *
 * ⚠️ 曾经按 **key** 对回（2026-08-22 修）。那靠的是"一份计划里一个 key 只出现
 * 一次"，在 11 个扁平键的年代成立（重复仲裁会把多余的挑掉）。行内角色接进来
 * 之后不再成立：两段经历就是两个 `experience.company`，而且它们**应该**同时在
 * 计划里。按 key 对回的后果是第 1 行的结果被贴到每一行上——第 2 行明明写失败了，
 * 面板显示绿色"已填"。审计面板撒谎比没有审计面板更糟。
 */
export function buildAuditView(
  plan: ApplyPlan,
  // 允许带空位：一轮**还在跑**的时候，中段屏拿同一份计划与已经结算的那几条
  // 来建视图（CAP-AF-063）。空位走的就是下面那条"没跑到"的分支，行集合、顺序
  // 与必填分母因此与跑完之后那张单子逐字一致。
  results: readonly (ApplyWriteResult | undefined)[],
): AuditView {
  const rows: AuditRow[] = [];

  for (const [index, entry] of plan.entries.entries()) {
    const candidate = results[index];
    // 键不一致说明调用方传进来的结果与这份计划不是同一次运行的产物。
    // 此时宁可整行报"没跑到"，也不能把别人的结果显示成这一行的结局。
    const result = candidate !== undefined && candidate.key === entry.key ? candidate : undefined;
    const status = result ? writeStatus(result, entry.kind === 'combobox') : 'FAILED';
    rows.push({
      key: entry.key,
      // 代填那一格题面说不出替他同意了什么时（2026-10-04，Ashby 电话栏里的短信同意），标题用同意的那句话。
      label: entry.signedWording ?? entry.label,
      required: entry.required,
      status,
      reason: result && !result.ok ? result.reason : result ? null : 'ABORTED',
      attemptedValue: entry.value,
      resolvedOptionText: entry.resolvedOptionText ?? null,
      element: entry.element,
      confidence: entry.confidence,
      order: entry.order,
      ...(entry.inferredRegionCode === undefined ? {} : { inferredRegionCode: entry.inferredRegionCode }),
      ...(entry.defaultedRegionCode === undefined ? {} : { defaultedRegionCode: entry.defaultedRegionCode }),
      ...(entry.historyBasis === undefined ? {} : { historyBasis: entry.historyBasis }),
      ...(result?.notAdded === undefined ? {} : { notAdded: result.notAdded }),
    });
  }

  for (const skip of plan.skipped) {
    if (HIDDEN_REASONS.has(skip.reason)) continue;
    rows.push({
      key: null,
      label: skip.label,
      required: skip.required,
      status: skipStatus(skip.reason),
      reason: skip.reason,
      attemptedValue: null,
      resolvedOptionText: null,
      element: skip.element,
      confidence: null,
      order: skip.order,
      ...(skip.regionWithoutRecord === undefined ? {} : { regionWithoutRecord: skip.regionWithoutRecord }),
    });
  }

  rows.sort((left, right) => left.order - right.order);

  return viewOf(rows);
}
