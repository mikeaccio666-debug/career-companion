/**
 * User-gesture authority for host-form writes.
 *
 * The branded symbol is deliberately module-private: a caller can only obtain
 * this type through `mintAuthority()`, which verifies a browser-trusted event
 * originated inside our own ShadowRoot. `consumeAuthority()` then makes it a
 * one-run capability; write primitives accept only an active capability.
 */

import type { Result } from './contracts';

const AUTHORITY: unique symbol = Symbol('HostWriteAuthority');

/**
 * `set-combobox` covers the host clicks a searchable dropdown needs (open the
 * listbox, pick an option, close it). It is a separate capability from
 * `set-text` on purpose: the runtime policy can revoke clicking without
 * disabling plain text fills, which is the only kill switch that matters if a
 * vendor changes its widget and our sequence starts mis-clicking.
 */
/**
 * `set-attestation` 是保留能力：两条通用 mint 路径都会无条件删掉它，
 * 包内策略也是 `false`。未来放行必须另建绑定 durable sensitive-release
 * authority 的专用铸造路径；翻转 policy 一行或调用方传 Set 都不够。
 */
export type WriteCapability =
  | 'set-text'
  | 'set-select'
  | 'set-combobox'
  | 'set-richtext'
  /**
   * 增删行的宿主点击（CAP-AF-003）。与 `set-combobox` 分开，是因为
   * 「打开一个菜单」与「把一段经历提交给宿主」性质不同：关掉本位之后
   * 下拉照常工作，只是不再替用户增删/保存行。
   */
  | 'manage-rows'
  | 'set-file'
  /**
   * 推荐人 / 紧急联系人 / 配偶等**他人信息**栏。
   *
   * 与 EEO 自我认同不同，这一栏问的不是用户自己：它需要一份"这些人是谁"的数据，
   * 而不只是一个开关。默认关闭的理由也不是法律风险，是**填错的形状特别坏**——
   * 无锚点的标签正则会把申请人本人的资料写进推荐人栏，面板还显示绿色"已填"，
   * recruiter 于是收到一份推荐人等于本人的申请（见 engine.ts 该守卫头注）。
   * 有了可信的他人数据源再打开这一位；打开之后本仓其余守卫一条都不放松。
   */
  | 'set-other-person'
  | 'set-attestation'
  /**
   * 乙档 EEO 自我认同：性别 / 族裔 / 退伍 / 残障。
   *
   * 与 `set-other-person` 正好相反——那一栏问的不是用户自己、需要一份「这些人是谁」
   * 的数据源；这一栏问的**就是用户自己**，数据源是他在档案里亲手填的那个值。
   * 默认关不是因为拿不到数据，是因为这一类要「按档案值预填、写入前过一次阻塞式
   * 确认」，而那条确认链闭合之前不该有任何自动写入。
   */
  | 'set-self-identification'
  /**
   * 乙档工作授权／担保。
   *
   * 与 `set-self-identification` 分开：EEO 是关于本人身份的陈述，这一条是**向雇主
   * 陈述一项法律资格**——「我有权在美国工作」答错不是少填一栏，是在一份正式申请里
   * 说了不实的话。答案随岗位所在国家变，同一个用户在两国可以答得相反。
   */
  | 'set-work-authorization'
  // 推荐人（P1-9）：他人信息里唯一有可信数据源的子类——用户亲手存的「谁把我推荐到哪家」。
  // 它是计划期的门（这一类问题获准由我们作答吗），写入原语仍是 set-text。
  | 'set-referral'
  /**
   * 多页申请的翻页（2026-09-22）：用户在浮层里按「继续到下一页」，我们按宿主那一颗
   * `Save and Continue`（`wizardAdvance.ts` 找出来的全页唯一的那颗）。
   *
   * 与 `manage-rows` 同类：Workday 的 Save and Continue 会把这一步**保存进宿主**。所以它有
   * 自己的位、远程关得掉，出厂 false。它不是一次写入——没有任何写入原语认它，通用铸造也
   * 永远删掉它（下面的保留集）；内容脚本只在用户那一次真实点击的当下按一颗按钮。
   */
  | 'advance-step'
  /**
   * 一次「自动填写」连着往下填（2026-09-28 负责人决定：按一下，一页一页填到检查页，停在那里等他按「提交」）。
   *
   * `advance-step` 管的是「替他按那一颗翻页按钮」；这一位管的是「不等他再按，填完一页就接着翻」。两位都开着才连填；
   * 这一位关着（或后端还没下发，缺席读作 false），就回到每一页一颗「继续到下一页」的老样子。它同样不是写入：没有任何
   * 写入原语认它，通用铸造永远删掉它（下面的保留集）。连填的信任根仍是那一下点击，见 `openAdvanceRun`。
   */
  | 'advance-steps'
  /**
   * 代填条款、声明与签名（2026-09-23）：以用户的名义勾「同意本次申请的条款／隐私政策」、
   * 勾「保证所填属实」一类的声明、在签名栏填姓名与当天日期。
   *
   * 它是计划期与点击当下的门，不是写入原语：勾框仍走原生点击（set-select），签名仍是 set-text。
   * 信任根是用户在门户资料页**单独**勾过的同意（后端存版本与时间），加上运行时包里这一位；
   * 通用铸造永远删掉它（下面的保留集）。营销、短信、背景调查、联系现任雇主与混合授权永远拒绝。
   */
  | 'sign-on-behalf'
  /**
   * 在插件里提交（2026-09-23 负责人决定：「插件替用户点提交」）。用户在我方浮层里按「提交」，
   * 内容脚本在那一次真实点击里取证、重读这一位，然后按**规则声明的**最终提交控件
   * （`finalSubmitControl`，只认 native submit）。它不是写入：没有任何写入原语认它，通用铸造
   * 永远删掉它（下面的保留集）。随包字节里仍然没有 `.submit(` / `.requestSubmit(`。
   */
  | 'submit-application'
  /**
   * 替用户在招聘网站上注册账号、登录（2026-09-28 负责人决定：像 Jobright 那样，Workday／iCIMS 的账号墙由插件过）。
   *
   * 只在规则声明的账号墙上用（`accountSteps`）：往规则声明的邮箱栏、密码栏写用户自己的邮箱与这台电脑上保存的密码，
   * 勾规则声明的注册条款框，按规则声明的「用邮箱登录」「注册」「登录」那几颗。信任根有两把钥匙：运行时包里这一位
   * （远程可关，缺席读作 false），加上用户在资料页同意过点名这一类的那一版文案（worker 读后端记录）。票只从专用路径
   * `mintAccountAccessAuthority` 铸，而且票上只有这一位；通用铸造永远删掉它（下面的保留集）。验证码、两步验证、
   * 邮箱验证仍由用户本人完成；最终提交与它无关。
   */
  | 'account-access';
export type WritePurpose = 'fill' | 'undo';

export interface HostWriteAuthority {
  readonly [AUTHORITY]: 'host-write';
  readonly purpose: WritePurpose;
  /** Fill authorities are bound to the preview the user explicitly reviewed. */
  readonly fingerprint: string | null;
  readonly expiresAt: number;
}

export interface MintAuthorityInput {
  readonly event: Event;
  readonly shadowRoot: ShadowRoot;
  readonly purpose: WritePurpose;
  readonly fingerprint: string | null;
  /** Caller request; generic mint always removes reserved capabilities before storing it. */
  readonly capabilities?: ReadonlySet<WriteCapability>;
  readonly now?: number;
}

/**
 * 一张票只服务**紧接着的那一轮填写**，所以它有上限；上限要覆盖那一轮，不是覆盖「同步的几步」。
 *
 * 原值 5 秒来自最初搬入时的假设——填写是一串同步 setValue。今天不是了：组合框要开菜单、
 * 等列表稳定、点选、回读，还有延时复检（`lateRecheckMs`），一份 Greenhouse 申请页十几个
 * 组合框跑完要十几秒。2026-09-22 用生产包在 29 个真实在招岗位上实测：**26 项**写入失败于
 * `GESTURE_EXPIRED`，全是排在后面的字段（Attach、Discipline、工作授权……）——前 5 秒写得进去，
 * 之后整轮剩下的一个都写不进，而用户只看到「本项未完成」。
 *
 * 放宽的是**这一轮的窗口**，不是「一次点击能留多久再用」：后者由 `GESTURE_PROOF_TTL_MS`（30 秒）
 * 管着，且票据仍绑死 purpose、这一份计划的 fingerprint 与这一轮收窄过的能力集，逐写入仍要重验
 * 策略、lease、目标身份与回读。
 */
export const AUTHORITY_TTL_MS = 120_000;

const DEFAULT_CAPABILITIES: ReadonlySet<WriteCapability> = new Set(['set-text', 'set-select']);
/**
 * 通用铸造路径**永远删掉**的能力位。两条 mint 路径共用这一份。
 *
 *  · `set-attestation` —— 通用 trusted-gesture mint 不能授权法律写入。pending proposal
 *    若获批准，也必须走后端 durable per-item release 与专用 fresh-revalidation mint；
 *    营销、联系现任雇主和未列明／混合授权仍不得进入该专用路径。
 *  · `manage-rows` —— **不可逆**：`row-save` 会把一整段经历提交进宿主的数据
 *    结构，撤销只能靠删行；而实测（50-证据库 §F.6-o）iCIMS 的第一行**根本没有
 *    删行按钮**。这种动作不能跟着一张通用写入票顺带出去，也不能是调用方在 Set 里
 *    写一句就给。它只从专用路径 `mintRowActionAuthorityFromGesture` 铸：一张票一种
 *    动作（加一行，或 2026-09-24 负责人决定放行的规则声明的「保存本段」），删行铸不出来。
 *
 *  · `advance-step` —— 翻页不是写入，没有任何一张写入票该带着它。它只作为远程开关存在：
 *    内容脚本在用户按下「继续到下一页」的当下读策略里的这一位，再按宿主那颗按钮。
 *  · `advance-steps` —— 连填（2026-09-28）同理：它只是远程开关，内容脚本每翻一页之前重读一次。
 *
 *  · `sign-on-behalf` —— 同样不上任何写入票。它的信任根是用户在门户资料页单独勾过的同意
 *    （后端存版本与时间）；计划期要它才把条款同意、属实声明、签名排进计划，点击当下再重读一次
 *    （策略里这一位 ∧ 用户的同意），勾框本身仍走 set-select 的原生点击。
 *  · `account-access` —— 替用户注册、登录（2026-09-28）。它写的是密码、按的是「登录」「注册」，
 *    一张填表的票绝不能顺带出去：只从 `mintAccountAccessAuthority` 铸，票上只有这一位。
 *
 * 未来放行任一项都必须**另建专用铸造路径**，绑定各自的信任根；
 * 翻转这里一行、或让调用方传 Set，都不够。
 */
const GENERIC_MINT_RESERVED_CAPABILITIES: ReadonlySet<WriteCapability> = new Set([
  'set-attestation',
  'manage-rows',
  'advance-step',
  'advance-steps',
  'sign-on-behalf',
  'submit-application',
  'account-access',
]);
const minted = new WeakSet<object>();
/**
 * 行专用票的烙印：这张票只许的那**一种**行动作（见 mintRowActionAuthorityFromGesture）。
 * `clickHostTarget` 对它只放行同一种的点击；删行不在这张表里，也就永远铸不出来。
 */
const rowActionOnly = new WeakMap<object, RowAuthorityAction>();
const consumed = new WeakSet<object>();
const active = new WeakSet<object>();
const capabilitySets = new WeakMap<object, Set<WriteCapability>>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function eventComesFromShadow(event: Event, shadowRoot: ShadowRoot): boolean {
  try {
    return event.composedPath().includes(shadowRoot);
  } catch {
    return false;
  }
}

function capabilitiesForGenericMint(
  requested: ReadonlySet<WriteCapability> | undefined,
): Set<WriteCapability> {
  return new Set(
    [...(requested ?? DEFAULT_CAPABILITIES)].filter(
      (capability) => !GENERIC_MINT_RESERVED_CAPABILITIES.has(capability),
    ),
  );
}

/**
 * 这一次点击成立的**凭证**，在点击当下取，之后才能用。
 *
 * ## 为什么必须在当下取
 *
 * 「事件来自我方 shadow」这一条靠 `event.composedPath()` 判，而 DOM 规定
 * **派发一结束，composedPath() 就返回空数组**。于是任何在 await 之后才做的
 * 校验都必然判否——不是因为这一次点击不成立，是因为那时已经问不出来了。
 *
 * 无 mission 那条填写路正是这个形状：按下 Autofill 之后要先问后台要授权、要档案、
 * 要解出运行时、再扫这一页，全是 await；等走到铸票那一步，事件早就派发完了。
 * 2026-09-18 实测：整条链跑到最后一步，浮层说「这一次点击没能通过校验」，
 * 而那一次点击是完全真实的。
 *
 * ## 凭证不是把闸放松
 *
 * 它在**能判的那一刻**判完，判据逐字不变（`isTrusted` 且来自我方 shadow）。
 * 判完之后留下的这个对象带内核私有烙印（`trustedGestures`），调用方伪造一个
 * 同形状的对象过不了 `mintAuthorityFromGesture`。它还自带年龄上限：
 * 取到之后 `GESTURE_PROOF_TTL_MS` 内不用就作废——一次点击不该在几分钟后
 * 还能兑出写入能力。
 */
export const GESTURE_PROOF_TTL_MS = 30_000;

declare const gestureProofBrand: unique symbol;
export interface TrustedGestureProof {
  readonly [gestureProofBrand]: 'trusted-shadow-gesture';
  readonly capturedAt: number;
}

const trustedGestures = new WeakSet<object>();

export function captureTrustedShadowGesture(
  event: Event,
  shadowRoot: ShadowRoot,
  now: number = Date.now(),
): TrustedGestureProof | null {
  if (!isTrustedShadowGesture(event, shadowRoot)) return null;
  const proof = Object.freeze({ capturedAt: now }) as unknown as TrustedGestureProof;
  trustedGestures.add(proof);
  return proof;
}

// ── 连填：一次点击开出的一轮（2026-09-28）────────────────────────────────

/**
 * 一次「自动填写」连着往下填（2026-09-28 负责人决定：按一下，一页一页填到检查页，停在那里等他按「提交」）。
 *
 * ## 为什么点击凭证不够
 *
 * 点击凭证 30 秒就作废（`GESTURE_PROOF_TTL_MS`）：一次点击不该在几分钟后还能兑出写入能力。PR #69 的「继续到下一页」
 * 就是在这 30 秒里翻过去、接着填下一页。连填要翻好几页，每一页填写、等 AI 起草、再翻页，整轮是几分钟的事，
 * 30 秒撑不到第二页。
 *
 * ## 为什么不再造一张点击凭证
 *
 * 点击凭证说的是「此刻有一次真实点击」。翻到第三页时没有点击：给它发一张新的点击凭证，就是凭空造了一次点击。
 * 所以连填有自己的一种凭证（`AdvanceRunPageProof`，「这一页」），类型与烙印都和点击凭证分开，写明它从哪来：
 *
 *  · 只从一次真实点击开（`openAdvanceRun` 收的是点击凭证：30 秒之内，一次点击只开一轮）；连填自己发的「这一页」
 *    凭证开不出新的一轮——它不能自己续自己；
 *  · 绑定开的那一刻的页面、申请与厂商（origin + pathname + 厂商）：换了就不再往下翻；
 *  · 总时限从那一下点击算起（`ADVANCE_RUN_TTL_MS`），页数有上限（`ADVANCE_RUN_MAX_PAGES`，含第一页）；
 *  · 每翻一页（`beginAdvanceRunStep` → 宿主真的翻过去了 → `completeAdvanceRunStep`）只发一张新一页的凭证，
 *    上一页的随之作废——翻走的那一页不能再写；
 *  · 用户按「停止」、开了新的一轮、离开这一页，调用方就 `endAdvanceRun`：全部作废。连填自己停下（到了检查页、
 *    有要他处理的）时 `closeAdvanceRun`：不再往下翻，这一页的凭证最多再活一次点击那么久（整轮之后网站清空了
 *    一栏，还能照一次点击的口径重填一次）。
 *
 * 「这一页」凭证铸出来的票与点击铸的走同一个口子（`mintAuthorityFromGesture` / `mintRowActionAuthorityFromGesture`）：
 * 同样绑计划指纹、同样按策略收窄、同样删掉保留集——翻页、连填、提交、代填这几位永远不在票上。翻页那一下由内容脚本
 * 按：它要一个还算数的 `AdvanceRunStep`（只有本模块发得出），而且只按内核 `findWizardNextControl` 认出的那一颗——
 * 名字整句是「下一步」、结构上提交不了表单；规则声明的最终提交在那一页上时根本不翻。最终提交只在用户按下浮层里的
 * 「提交」之后（RULE-EXT-NEVER-SUBMIT），这一轮连填从头到尾碰不到它。
 */
export const ADVANCE_RUN_MAX_PAGES = 10;
/** 一轮连填的总时限：从那一下点击算起。 */
export const ADVANCE_RUN_TTL_MS = 10 * 60_000;
/**
 * 往下翻一页之前至少还要剩多久：新一页出来、扫描、问资料、铸第一张写入票，都得在总时限之内。剩得不够就不翻——
 * 翻过去只填一半，比停在这一页让他自己点更糟。第一张票铸出来之后，这一页主干那一遍由票自己的时限（AUTHORITY_TTL_MS）管。
 */
export const ADVANCE_RUN_STEP_RESERVE_MS = 30_000;

/** 一轮连填绑定的范围：开的那一刻的页面、申请与厂商。 */
export interface AdvanceRunScope {
  readonly origin: string;
  readonly pathname: string;
  readonly vendor: string;
}

export type AdvanceRunRefusal =
  /** 开这一轮的不是一次真实点击的凭证（伪造的、连填自己发的、已经开过一轮的）。 */
  | 'GESTURE_UNTRUSTED'
  /** 那一下点击已经过了 30 秒。 */
  | 'GESTURE_EXPIRED'
  /** 这一轮已经收场（停止、换了一轮、离开了这一页，或自己停下了），或者根本不是本模块开的。 */
  | 'RUN_ENDED'
  /** 总时限到了（往下翻时：剩下的不够下一页用）。 */
  | 'RUN_EXPIRED'
  /** 页数到上限了。 */
  | 'RUN_PAGE_CAP'
  /** 页面、申请或厂商换了（开的时候说不清也算）。 */
  | 'RUN_SCOPE_CHANGED'
  /** 上一步还没有结论。 */
  | 'RUN_BUSY'
  /** 这一步已经完成或放弃过了。 */
  | 'RUN_STEP_STALE';

/**
 * 连填那几个函数的结果。码不进 `ApplyErrorCode`：它们只在内容脚本里决定「还往不往下翻」，不落到任何一栏、回执或遥测上。
 */
export type AdvanceRunResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: AdvanceRunRefusal }>;

declare const advanceRunBrand: unique symbol;
export interface AdvanceRun {
  readonly [advanceRunBrand]: 'advance-run';
}
declare const advanceRunStepBrand: unique symbol;
/** 一轮连填里「往下翻一页」的那一步：替他按翻页按钮，只凭它（或用户的真实点击）。 */
export interface AdvanceRunStep {
  readonly [advanceRunStepBrand]: 'advance-run-step';
}
declare const advanceRunPageBrand: unique symbol;
/** 一轮连填里「这一页」的凭证：不是点击，是那一下点击开出的这一轮发给这一页的。 */
export interface AdvanceRunPageProof {
  readonly [advanceRunPageBrand]: 'advance-run-page';
  /** 发出的时刻（这一页开始填的时刻）。 */
  readonly capturedAt: number;
}

/** 写入票的信任根：一次真实点击，或一次真实点击开出的那一轮连填里「这一页」的凭证。 */
export type GestureRoot = TrustedGestureProof | AdvanceRunPageProof;

interface AdvanceRunRecord {
  /** 只在账号墙之后的第一页可能换一次路径（`rebindAfterAccount`），别处从不改。 */
  scope: AdvanceRunScope;
  /** 账号墙过去之后发的那一张「这一页」凭证：只有它能换一次路径；换过了、或没有账号墙，就是 null。 */
  afterAccount: object | null;
  deadline: number;
  readonly maxPages: number;
  pages: number;
  current: object | null;
  pending: object | null;
  /** 不再往下翻（连填自己停下了）；这一页的凭证还在，最多再活一次点击那么久。 */
  closed: boolean;
  /** 全部作废（停止、换一轮、离开这一页）。 */
  ended: boolean;
}

const advanceRuns = new WeakMap<object, AdvanceRunRecord>();
const advanceRunSteps = new WeakMap<object, object>();
const advanceRunPages = new WeakMap<object, object>();
/** 已经开过一轮的点击：一次点击只开一轮。 */
const openedRuns = new WeakSet<object>();

const scopeUsable = (scope: unknown): scope is AdvanceRunScope =>
  isObject(scope) &&
  [(scope as AdvanceRunScope).origin, (scope as AdvanceRunScope).pathname, (scope as AdvanceRunScope).vendor]
    .every((part) => typeof part === 'string' && part !== '');

const sameScope = (record: AdvanceRunRecord, scope: unknown): boolean =>
  scopeUsable(scope) &&
  record.scope.origin === scope.origin && record.scope.pathname === scope.pathname && record.scope.vendor === scope.vendor;

const runRecord = (run: unknown): AdvanceRunRecord | undefined => (isObject(run) ? advanceRuns.get(run) : undefined);

function issueRunPage(run: object, record: AdvanceRunRecord, now: number): AdvanceRunPageProof {
  const page = Object.freeze({ capturedAt: now }) as unknown as AdvanceRunPageProof;
  advanceRunPages.set(page, run);
  record.current = page;
  return page;
}

/** 开一轮连填，并发第一页的凭证。见上面的头注。 */
export function openAdvanceRun(input: Readonly<{
  proof: TrustedGestureProof;
  scope: AdvanceRunScope;
  now?: number;
  /** 只能收紧：大于 `ADVANCE_RUN_MAX_PAGES` 按它算。 */
  maxPages?: number;
  /** 只能收紧：大于 `ADVANCE_RUN_TTL_MS` 按它算。 */
  ttlMs?: number;
}>): AdvanceRunResult<Readonly<{ run: AdvanceRun; page: AdvanceRunPageProof }>> {
  const proof = input.proof;
  if (!isObject(proof) || !trustedGestures.has(proof) || openedRuns.has(proof)) {
    return { ok: false, code: 'GESTURE_UNTRUSTED' };
  }
  const now = input.now ?? Date.now();
  if (typeof proof.capturedAt !== 'number' || now - proof.capturedAt > GESTURE_PROOF_TTL_MS) {
    return { ok: false, code: 'GESTURE_EXPIRED' };
  }
  if (!scopeUsable(input.scope)) return { ok: false, code: 'RUN_SCOPE_CHANGED' };
  const tighten = (value: number | undefined, ceiling: number, floor: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(floor, Math.min(ceiling, Math.floor(value))) : ceiling;
  openedRuns.add(proof);
  const run = Object.freeze({}) as unknown as AdvanceRun;
  const record: AdvanceRunRecord = {
    scope: Object.freeze({ origin: input.scope.origin, pathname: input.scope.pathname, vendor: input.scope.vendor }),
    afterAccount: null,
    deadline: proof.capturedAt + tighten(input.ttlMs, ADVANCE_RUN_TTL_MS, 0),
    maxPages: tighten(input.maxPages, ADVANCE_RUN_MAX_PAGES, 1),
    pages: 1,
    current: null,
    pending: null,
    closed: false,
    ended: false,
  };
  advanceRuns.set(run, record);
  return { ok: true, value: Object.freeze({ run, page: issueRunPage(run, record, now) }) };
}

/** 这一轮此刻在第几页、上限几页、还剩多久；收场了、范围换了、到点了就说为什么。 */
export function advanceRunState(
  run: AdvanceRun,
  scope: AdvanceRunScope,
  now: number = Date.now(),
): AdvanceRunResult<Readonly<{ page: number; maxPages: number; remainingMs: number }>> {
  const record = runRecord(run);
  if (record === undefined || record.ended || record.closed) return { ok: false, code: 'RUN_ENDED' };
  if (!sameScope(record, scope)) return { ok: false, code: 'RUN_SCOPE_CHANGED' };
  if (now >= record.deadline) return { ok: false, code: 'RUN_EXPIRED' };
  return { ok: true, value: Object.freeze({ page: record.pages, maxPages: record.maxPages, remainingMs: record.deadline - now }) };
}

/** 往下翻一页的那一步开始：此后到它完成或放弃之前，这一轮不开第二步。 */
export function beginAdvanceRunStep(
  run: AdvanceRun,
  scope: AdvanceRunScope,
  now: number = Date.now(),
): AdvanceRunResult<AdvanceRunStep> {
  const record = runRecord(run);
  if (record === undefined || record.ended || record.closed) return { ok: false, code: 'RUN_ENDED' };
  if (!sameScope(record, scope)) return { ok: false, code: 'RUN_SCOPE_CHANGED' };
  if (record.pending !== null) return { ok: false, code: 'RUN_BUSY' };
  if (record.pages >= record.maxPages) return { ok: false, code: 'RUN_PAGE_CAP' };
  if (record.deadline - now < ADVANCE_RUN_STEP_RESERVE_MS) return { ok: false, code: 'RUN_EXPIRED' };
  const step = Object.freeze({}) as unknown as AdvanceRunStep;
  advanceRunSteps.set(step, run);
  record.pending = step;
  return { ok: true, value: step };
}

/** 这一步此刻还算不算数（按翻页按钮之前再问一次：用户可能刚按了「停止」）。 */
export function isAdvanceRunStepCurrent(step: AdvanceRunStep, now: number = Date.now()): boolean {
  const run = isObject(step) ? advanceRunSteps.get(step) : undefined;
  const record = runRecord(run);
  return record !== undefined && !record.ended && !record.closed && record.pending === step && now < record.deadline;
}

/** 宿主真的翻过去了：这一步完成，发新一页的凭证；上一页的凭证随之作废。 */
export function completeAdvanceRunStep(
  step: AdvanceRunStep,
  now: number = Date.now(),
): AdvanceRunResult<AdvanceRunPageProof> {
  const run = isObject(step) ? advanceRunSteps.get(step) : undefined;
  const record = runRecord(run);
  if (run === undefined || record === undefined || record.ended || record.closed) return { ok: false, code: 'RUN_ENDED' };
  if (record.pending !== step) return { ok: false, code: 'RUN_STEP_STALE' };
  record.pending = null;
  if (now >= record.deadline) return { ok: false, code: 'RUN_EXPIRED' };
  record.pages += 1;
  return { ok: true, value: issueRunPage(run, record, now) };
}

/**
 * 账号墙那一步完成（2026-09-28）：替他登录、注册之后，账号墙没了——与翻过一页同一个口子，发新一页的凭证，与
 * `completeAdvanceRunStep` 逐字相同。只多记一件事：这一页是账号墙之后的第一页（`rebindAfterAccount` 只认它）。
 */
export function completeAccountRunStep(
  step: AdvanceRunStep,
  now: number = Date.now(),
): AdvanceRunResult<AdvanceRunPageProof> {
  const result = completeAdvanceRunStep(step, now);
  if (result.ok) {
    const record = runRecord(advanceRunPages.get(result.value));
    if (record !== undefined) record.afterAccount = result.value;
  }
  return result;
}

/**
 * 账号墙之后的第一页换了地址（2026-09-28）。Workday 建了草稿就把 …/apply/applyManually 换成 …/apply（2026-09-22
 * nvidia.wd5 实测），而这一轮绑的是开的那一刻的路径，一换就当「页面换了地方」停下——替他登录完却一栏都不填。所以这一页
 * 开始填的时候，允许把这一轮的路径换成此刻的路径：只许账号墙之后发的那一张凭证、它还是这一轮的当前页，只许一次，必须
 * 同源、同厂商。新路径上是不是这一家的申请表由调用方先按规则扫出来（内核不认 URL）；之后照旧一换就停。
 */
export function rebindAfterAccount(
  page: AdvanceRunPageProof,
  scope: AdvanceRunScope,
  now: number = Date.now(),
): AdvanceRunResult<true> {
  const record = runRecord(isObject(page) ? advanceRunPages.get(page) : undefined);
  if (record === undefined || record.ended || record.closed) return { ok: false, code: 'RUN_ENDED' };
  if (record.afterAccount !== page || record.current !== page || !scopeUsable(scope) ||
      scope.origin !== record.scope.origin || scope.vendor !== record.scope.vendor) {
    return { ok: false, code: 'RUN_SCOPE_CHANGED' };
  }
  if (now >= record.deadline) return { ok: false, code: 'RUN_EXPIRED' };
  record.scope = Object.freeze({ origin: record.scope.origin, pathname: scope.pathname, vendor: record.scope.vendor });
  record.afterAccount = null;
  return { ok: true, value: true };
}

/** 这一步没翻成（宿主没翻、按钮不在了、开关关了）：放下它；页数不涨，这一页的凭证照旧。 */
export function abandonAdvanceRunStep(step: AdvanceRunStep): void {
  const run = isObject(step) ? advanceRunSteps.get(step) : undefined;
  const record = runRecord(run);
  if (record !== undefined && record.pending === step) record.pending = null;
}

/** 全部作废：用户按了「停止」、开了新的一轮、离开了这一页、浮层换了。 */
export function endAdvanceRun(run: AdvanceRun): void {
  const record = runRecord(run);
  if (record === undefined) return;
  record.ended = true;
  record.pending = null;
}

/**
 * 连填自己停下了（到了检查页、有要他处理的、到上限了）：不再往下翻。这一页的凭证最多再活一次点击那么久——
 * 整轮之后网站清空了一栏，同一次之内重填一次还来得及，与一次点击同一个口径；不因停下而比总时限活得更久。
 */
export function closeAdvanceRun(run: AdvanceRun, now: number = Date.now()): void {
  const record = runRecord(run);
  if (record === undefined) return;
  record.closed = true;
  record.pending = null;
  record.deadline = Math.min(record.deadline, now + GESTURE_PROOF_TTL_MS);
}

/** 这是不是连填发的「这一页」凭证（不是点击）。 */
export function isAdvanceRunPage(root: unknown): root is AdvanceRunPageProof {
  return isObject(root) && advanceRunPages.has(root);
}

/** 一张凭证此刻还能不能铸票。点击：30 秒之内；「这一页」：这一轮没作废、还是这一页、没到点。 */
function gestureRootCheck(root: unknown, now: number): 'OK' | 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' {
  if (!isObject(root)) return 'GESTURE_UNTRUSTED';
  if (trustedGestures.has(root)) {
    const capturedAt = (root as TrustedGestureProof).capturedAt;
    return typeof capturedAt !== 'number' || now - capturedAt > GESTURE_PROOF_TTL_MS ? 'GESTURE_EXPIRED' : 'OK';
  }
  const record = runRecord(advanceRunPages.get(root));
  if (record === undefined) return 'GESTURE_UNTRUSTED';
  return !record.ended && record.current === root && now < record.deadline ? 'OK' : 'GESTURE_EXPIRED';
}

/** 这张凭证还能铸多久的票（毫秒）；已经不能了就是 0。 */
export function gestureRootRemainingMs(root: GestureRoot, now: number = Date.now()): number {
  if (gestureRootCheck(root, now) !== 'OK') return 0;
  if (trustedGestures.has(root)) return Math.max(0, GESTURE_PROOF_TTL_MS - (now - root.capturedAt));
  const record = runRecord(advanceRunPages.get(root));
  return record === undefined ? 0 : Math.max(0, record.deadline - now);
}

export interface MintAuthorityFromGestureInput {
  /** 一次真实点击的凭证，或一轮连填里「这一页」的凭证（见 `openAdvanceRun`）。 */
  readonly proof: GestureRoot;
  readonly purpose: WritePurpose;
  readonly fingerprint: string | null;
  readonly capabilities?: ReadonlySet<WriteCapability>;
  readonly now?: number;
}

/** 用当下取到的那张凭证铸票。判据与 `mintAuthority` 逐字相同，只是判得更早。 */
export function mintAuthorityFromGesture(
  input: MintAuthorityFromGestureInput,
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED'> {
  const now = input.now ?? Date.now();
  const check = gestureRootCheck(input.proof, now);
  if (check !== 'OK') return { ok: false, code: check };

  const capabilities = capabilitiesForGenericMint(input.capabilities);
  const authority: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: input.purpose,
    fingerprint: input.fingerprint,
    expiresAt: now + AUTHORITY_TTL_MS,
  });
  minted.add(authority);
  capabilitySets.set(authority, capabilities);
  return { ok: true, value: authority };
}

/**
 * 替用户注册、登录的专用票（2026-09-28）。
 *
 * `account-access` 在通用路径里是保留位：一张填表的票写不了密码、按不了「登录」「注册」。这里单独铸一张，票上**只有**
 * 这一位，信任根与别的票相同——一次真实点击（30 秒之内），或那一下点击开出的一轮连填里「这一页」的凭证（账号墙是那一轮
 * 的第一页；邮箱验证、人机验证之后接着登录靠的就是它，总时限照旧从那一下点击算起）。
 *
 * 票本身什么都不放行：写哪几格、按哪几颗只由规则声明的账号墙决定（`rules/accountWall.ts`）；每一下写、每一下按之前，
 * 写入原语与点击原语还要重读策略里的 `account-access` 位；用户同意过点名这一类的那一版文案由 worker 在交出密码之前判。
 * 不绑计划（没有计划：账号墙不是申请表）；时限与通用票相同。
 */
export function mintAccountAccessAuthority(
  input: Readonly<{ proof: GestureRoot; now?: number }>,
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED'> {
  const now = input.now ?? Date.now();
  const check = gestureRootCheck(input.proof, now);
  if (check !== 'OK') return { ok: false, code: check };
  const authority: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: 'fill',
    fingerprint: null,
    expiresAt: now + AUTHORITY_TTL_MS,
  });
  minted.add(authority);
  capabilitySets.set(authority, new Set<WriteCapability>(['account-access']));
  return { ok: true, value: authority };
}

/**
 * 数据同意页（2026-10-04，负责人 D7）的专用票：替他在规则声明的居住地下拉里选一项。票上只有 `sign-on-behalf`；信任根是
 * 一次真实点击（他按了我们的「自动填写」），与账号墙那张票同一个铸法。用户的同意不在这里：扩展只在 worker 读到他同意着
 * 当前版本的代填授权时才走到这一步；运行时包的 `sign-on-behalf` 位由写入那一侧每次重读。
 */
export function mintConsentGateAuthority(
  input: Readonly<{ proof: GestureRoot; now?: number }>,
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED'> {
  const now = input.now ?? Date.now();
  const check = gestureRootCheck(input.proof, now);
  if (check !== 'OK') return { ok: false, code: check };
  const authority: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: 'fill',
    fingerprint: null,
    expiresAt: now + AUTHORITY_TTL_MS,
  });
  minted.add(authority);
  capabilitySets.set(authority, new Set<WriteCapability>(['sign-on-behalf']));
  return { ok: true, value: authority };
}

/**
 * 行专用票能许的动作：加一行，或按规则声明的那一颗「保存本段」。**删行不在其中**——撤销只删本轮自己加的行，
 * 那条路另有它的信任根；从用户的一次点击里铸不出删行。
 */
export type RowAuthorityAction = 'add' | 'save';

const ROW_AUTHORITY_ACTIONS: ReadonlySet<string> = new Set<RowAuthorityAction>(['add', 'save']);

/**
 * 行动作的专用铸造路径（P1-8b 加行；2026-09-24 扩到保存本段）。
 *
 * `manage-rows` 在通用路径里是保留位（GENERIC_MINT_RESERVED_CAPABILITIES）：加行改变的是宿主
 * 表单的结构，保存本段把一整段提交进宿主的表单状态，撤销只能靠删行，而不少厂商根本没有删行按钮。
 * 所以它不跟着 fill 一起铸，而是单独一张票、单独的信任根，而且**一张票只许一种动作**：
 *
 *  · 同一次真实点击（`TrustedGestureProof`）——用户此刻确实按了我们的「自动填写」；
 *  · 远程策略的 `manage-rows` 位——由 click 原语按 policy 逐次检查（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED），
 *    这里不看、也看不到；
 *  · 规则数据声明了这一家的那一颗控件——由 click facts 的 `declaredRowAction` 证明（'add' 或 'save'）；
 *  · **只能点票上写的那一种**：票带着动作烙印，`clickHostTarget` 对别的种类一律拒。删行永远不从这条路
 *    铸出来；保存本段只由负责人 2026-09-24 的决定打开（「workable，那就和jobright一样全加全存」：Workable
 *    每一段填完要点框里的「Update」才会留下，竞品在同一次点击里替用户按）。它仍然不是提交：点击策略的
 *    整张拒绝表照跑，type=submit、表单里省略 type 的按钮、名字像提交的一律点不了。
 *
 * 票据不绑计划（fingerprint 为空）：行动作发生在两份计划之间——加完要重扫、为新行建计划、另铸 fill 票；
 * 填完、回读过才按保存。TTL 与通用票相同，一张票只够紧接着的那一下。
 */
export function mintRowActionAuthorityFromGesture(
  input: Readonly<{ proof: GestureRoot; action: RowAuthorityAction; now?: number }>,
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED'> {
  if (!ROW_AUTHORITY_ACTIONS.has(input.action)) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const now = input.now ?? Date.now();
  // 一次真实点击，或一轮连填里「这一页」的凭证（与 mintAuthorityFromGesture 同一道判据）。
  const check = gestureRootCheck(input.proof, now);
  if (check !== 'OK') return { ok: false, code: check };
  const authority: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: 'fill',
    fingerprint: null,
    expiresAt: now + AUTHORITY_TTL_MS,
  });
  minted.add(authority);
  capabilitySets.set(authority, new Set<WriteCapability>(['manage-rows']));
  rowActionOnly.set(authority, input.action);
  return { ok: true, value: authority };
}

/** 加行专用票：`mintRowActionAuthorityFromGesture` 的 `action: 'add'`。 */
export function mintRowAddAuthorityFromGesture(
  input: Readonly<{ proof: GestureRoot; now?: number }>,
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED'> {
  return mintRowActionAuthorityFromGesture({ ...input, action: 'add' });
}

/** 这张票是不是行专用票、许的是哪一种动作；别的票是 null。 */
export function rowActionOfAuthority(authority: HostWriteAuthority): RowAuthorityAction | null {
  return isObject(authority) ? rowActionOnly.get(authority) ?? null : null;
}

/** 这张票是不是加行专用票（只许 row-add）。 */
export function isRowAddOnlyAuthority(authority: HostWriteAuthority): boolean {
  return rowActionOfAuthority(authority) === 'add';
}

/**
 * "这确实是用户在我们自己的浮层里点的一下"——**不铸造任何写入能力**。
 *
 * 给那些需要真实用户意图、但不写宿主任何东西的决定用（例如确认"这个网站可以收我的
 * 简历"）。为它们去 `mintAuthority` 会凭空造出一张能写宿主的票据，纯粹是浪费的风险。
 */
export function isTrustedShadowGesture(event: Event, shadowRoot: ShadowRoot): boolean {
  return event.isTrusted === true && eventComesFromShadow(event, shadowRoot);
}

/**
 * Mint a capability only from a real event dispatched from our own shadow
 * tree. `isTrusted` cannot be made true by page JavaScript in the browser.
 */
export function mintAuthority(
  input: MintAuthorityInput,
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_FOREIGN'> {
  if (input.event.isTrusted !== true) return { ok: false, code: 'GESTURE_UNTRUSTED' };
  if (!eventComesFromShadow(input.event, input.shadowRoot)) {
    return { ok: false, code: 'GESTURE_FOREIGN' };
  }

  const now = input.now ?? Date.now();
  const capabilities = capabilitiesForGenericMint(input.capabilities);
  const authority: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: input.purpose,
    fingerprint: input.fingerprint,
    expiresAt: now + AUTHORITY_TTL_MS,
  });
  minted.add(authority);
  capabilitySets.set(authority, capabilities);
  return { ok: true, value: authority };
}

/**
 * 新形态的第二条铸造路径（T10，20 §3 授权链）：信任根从"用户在我们浮层里的
 * 真实点击"换成"**服务端已原子核销的 execution lease**"。
 *
 * 为什么这是等价甚至更强的信任根：手势票据证明的是"有人点过一下"；lease
 * 证明的是"用户在 chat 批准了**这个岗位、这些字段、这个档位**，后端复核签发，
 * 扩展验签后带着现场扫描去 claim，服务端比对通过并一次性核销"（三段式）。
 * 凭证与 lease 全程只存在于扩展隔离环境（契约 §4.1）。
 *
 * 与手势路径共享同一套 branding/一次核销/逐写入过期检查——运行时语义
 * 完全一致，写入原语无需知道票据出身；`expiresAt` 直接绑 lease 到期，
 * 写入窗口由服务端控制。手势路径原样保留（浮层内生的动作仍用它）。
 */
export interface ClaimedLeaseRef {
  /** 服务端核销后返回的 lease 标识（仅标识，不含任何值数据）。 */
  readonly executionLease: string;
  /** lease 到期（毫秒时间戳，源自 claim 响应的 leaseExpiresAt）。 */
  readonly expiresAtMs: number;
}

export interface MintIntentAuthorityInput {
  readonly lease: ClaimedLeaseRef;
  readonly purpose: WritePurpose;
  /** 与手势路径同语义：绑定用户批准的那份计划指纹。 */
  readonly fingerprint: string | null;
  /** Caller request; generic mint always removes reserved capabilities before storing it. */
  readonly capabilities?: ReadonlySet<WriteCapability>;
  readonly now?: number;
}

export function mintIntentAuthority(
  input: MintIntentAuthorityInput,
): Result<HostWriteAuthority, 'LEASE_INVALID' | 'LEASE_EXPIRED'> {
  const lease = input.lease;
  if (
    !isObject(lease) ||
    typeof lease.executionLease !== 'string' ||
    lease.executionLease === '' ||
    typeof lease.expiresAtMs !== 'number' ||
    Number.isNaN(lease.expiresAtMs)
  ) {
    return { ok: false, code: 'LEASE_INVALID' };
  }
  const now = input.now ?? Date.now();
  if (lease.expiresAtMs <= now) return { ok: false, code: 'LEASE_EXPIRED' };

  const capabilities = capabilitiesForGenericMint(input.capabilities);
  const authority: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: input.purpose,
    fingerprint: input.fingerprint,
    // 写入窗口 = lease 窗口：逐写入的过期检查（checkActiveCapability）
    // 因此由服务端的 lease 时长统一约束，本地不另设更长的宽限。
    expiresAt: lease.expiresAtMs,
  });
  minted.add(authority);
  capabilitySets.set(authority, capabilities);
  return { ok: true, value: authority };
}

/**
 * Intersect a freshly minted authority with a policy loaded after the click.
 * The Set is module-private, so this operation can only remove capabilities;
 * no async policy response can broaden what the trusted gesture originally
 * allowed. It also lets UI code validate `isTrusted`/`composedPath()` before
 * awaiting storage, when Event.currentTarget is still available.
 */
export function narrowAuthority(
  authority: HostWriteAuthority,
  allowed: ReadonlySet<WriteCapability>,
  now: number = Date.now(),
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'GRANT_CONSUMED'> {
  if (!isObject(authority) || !minted.has(authority)) {
    return { ok: false, code: 'GESTURE_UNTRUSTED' };
  }
  if (consumed.has(authority)) return { ok: false, code: 'GRANT_CONSUMED' };
  if (authority.expiresAt < now) return { ok: false, code: 'GESTURE_EXPIRED' };

  const capabilities = capabilitySets.get(authority);
  if (!capabilities) return { ok: false, code: 'GESTURE_UNTRUSTED' };
  for (const capability of capabilities) {
    if (!allowed.has(capability)) capabilities.delete(capability);
  }
  return { ok: true, value: authority };
}

/**
 * Redeem a capability once for one synchronous host-write run. A malformed
 * object is treated exactly like an untrusted gesture and never reaches a
 * writer; this also gives the runtime a fail-closed complement to branding.
 */
export function consumeAuthority(
  authority: HostWriteAuthority,
  now: number = Date.now(),
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'GRANT_CONSUMED'> {
  if (!isObject(authority) || !minted.has(authority)) {
    return { ok: false, code: 'GESTURE_UNTRUSTED' };
  }
  if (consumed.has(authority)) return { ok: false, code: 'GRANT_CONSUMED' };

  // Expired grants remain consumed: an attacker cannot keep retrying the same
  // captured object until a timing edge happens to work.
  consumed.add(authority);
  if (authority.expiresAt < now) return { ok: false, code: 'GESTURE_EXPIRED' };

  active.add(authority);
  return { ok: true, value: authority };
}

/**
 * Move an already-consumed authority into a runner-private object.
 *
 * The caller still owns the original object and could otherwise reuse it while
 * the runner yields for a bounded combobox or MutationObserver checkpoint.
 * The isolated object never escapes the runner closure; capabilities can only
 * be copied from the active source, never added.
 */
export function isolateConsumedAuthority(
  authority: HostWriteAuthority,
  now: number = Date.now(),
): Result<HostWriteAuthority, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED'> {
  if (!isObject(authority) || !minted.has(authority) || !active.has(authority)) {
    return { ok: false, code: 'GESTURE_UNTRUSTED' };
  }
  const capabilities = capabilitySets.get(authority);
  active.delete(authority);
  if (!capabilities) return { ok: false, code: 'GESTURE_UNTRUSTED' };
  if (authority.expiresAt < now) return { ok: false, code: 'GESTURE_EXPIRED' };

  const isolated: HostWriteAuthority = Object.freeze<HostWriteAuthority>({
    [AUTHORITY]: 'host-write',
    purpose: authority.purpose,
    fingerprint: authority.fingerprint,
    expiresAt: authority.expiresAt,
  });
  minted.add(isolated);
  consumed.add(isolated);
  active.add(isolated);
  capabilitySets.set(isolated, new Set(capabilities));
  return { ok: true, value: isolated };
}

/** End the synchronous run so direct writer calls cannot reuse its authority. */
export function releaseAuthority(authority: HostWriteAuthority): void {
  if (isObject(authority)) active.delete(authority);
}

/** Runtime complement to the parameter type check in the write primitives. */
export function checkActiveCapability(
  authority: HostWriteAuthority,
  capability: WriteCapability,
  now: number = Date.now(),
): Result<void, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED'> {
  if (!isObject(authority) || !minted.has(authority) || !active.has(authority)) {
    return { ok: false, code: 'GESTURE_UNTRUSTED' };
  }
  if (authority.expiresAt < now) return { ok: false, code: 'GESTURE_EXPIRED' };
  const capabilities = capabilitySets.get(authority);
  if (!capabilities || !capabilities.has(capability)) {
    return { ok: false, code: 'CAPABILITY_DISABLED' };
  }
  return { ok: true, value: undefined };
}
