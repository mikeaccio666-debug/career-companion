import { CONSENT_GRANT, isHoneyPotField, isPasswordField } from '../dict/guards.ts';
import {
  isWholeQuestionKind,
  signOnBehalfAnswers,
  signOnBehalfAsks,
  signOnBehalfStates,
  type SignOnBehalfChoiceKind,
} from '../dict/signOnBehalf.ts';

/**
 * Static click allowlist. It only evaluates facts collected by a future
 * transaction/widget layer; this module neither queries the DOM nor dispatches
 * an event. That makes the security boundary table-driven and auditable before
 * any host-click capability is introduced.
 */

export type ClickTargetKind =
  | 'combobox-trigger'
  | 'transaction-option'
  /** Exact option from a twice-observed, complete UA-1 review packet. */
  | 'reviewed-option'
  | 'choice-label'
  | 'choice-proxy'
  /**
   * The planned radio/checkbox **itself**, activated natively so a controlled
   * host (Ashby's React groups, 2026-09-15) sees the same change a user makes.
   *
   * 它比 `choice-proxy` 窄，不是它的别名：代理是「某个绑到选项上的可视元素」，
   * 什么标签都可能；本种类要求目标就是那个 `<input>`，且它的 `type` 与已审阅
   * 的控件种类**逐字相同**。这条额外要求是本文件里唯一一处放弃
   * `preventDefault` 的代价换来的保证——见 click/primitives.ts 的
   * `activateReviewedChoiceGroup`：一个 `type` 必为 radio/checkbox 的
   * `<input>`，其 click 默认动作只有「改自己的选中态」，不导航、不提交、
   * 不开文件对话框。
   */
  | 'choice-member'
  /**
   * 一道 ARIA 代理题（2026-09-23）的一个选项：用户点的是 `button[aria-pressed]`（Ashby 的是非题）或
   * `[role=radio|checkbox][aria-checked]`（Workable），宿主把选中态公布在它的 ARIA 状态上。
   *
   * 事实永远在**代理**身上采（用户看得见、读得到的是它）；有承载的原生 radio/checkbox 时，那一下
   * 原生激活落在承载上（`proxyCarrier`，由采集器从 DOM 推出、不信调用方），与用户点代理的 label 时
   * 浏览器做的事是同一件。没有承载时点代理本身，走预先取消默认动作的指针序列。
   * 比 `choice-proxy` 窄得多：标签、角色、状态属性、承载类型四者必须逐一对得上，
   * 有表单归属、点了会提交或重置的按钮一律拒（`formSubmitCapable`）。
   */
  | 'proxy-option'
  | 'datepicker-cell'
  /**
   * 增删行的三个动作。它们**不搭 combobox 的便车**：决策 16 开的口子是
   * 「打开菜单 / 选中一个值」，点完宿主那边什么都没被提交；而 Workable 的
   * `data-ui=save-section` 会把一整段经历提交进宿主的数据结构，撤销只能靠删行。
   * 性质不同就该有自己的种类、自己的能力位、自己的红证
   * （tests/s0/apply-row-action-click.redgreen.test.ts）。
   */
  | 'row-add'
  | 'row-save'
  | 'row-remove'
  /**
   * 账号墙上规则声明的那几颗（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday／iCIMS）：「用邮箱登录」、
   * 切到登录／注册、注册条款的勾选框、以及注册或登录那一下提交。它们正是别的种类一律拒的东西——「Sign in」「Create
   * Account」、`type=submit`、「I agree」——所以有自己的种类、自己的判定路径（`evaluateAccountControl`），绝不搭别的
   * 种类的便车；按的方式也不同：原生激活（点击原语 `activateAccountControl`），走网站自己的登录、注册处理。
   * 放行的前提全在事实里：规则声明了这一颗是哪一个角色（`declaredAccountControl`）、它在规则声明的账号墙里
   * （`withinFormRoot` 按账号墙的根采）。能力位与用户的同意在点击原语与 worker 那一侧另判。
   */
  | 'account-control'
  | 'other';

export interface ClickTargetFacts {
  /** The candidate is inside the adapter-detected application form root. */
  readonly withinFormRoot: boolean;
  /**
   * 代填（2026-09-23）：计划里这一格是以用户名义答的条款同意或属实声明（dict/signOnBehalf.ts）；
   * 2026-09-24 起还有六类同意。复选框／单选成员、下拉的触发器与选项、ARIA 代理选项（只有六类同意）
   * 用得上；点击当下重新读到的文字**必须**认得回来，认不回来一律拒（见 `signingTexts`）。缺席 = 不是代填。
   */
  readonly signOnBehalf?: SignOnBehalfChoiceKind;
  /**
   * 代填的代理选项（2026-09-24）：题干元素**此刻**的文字，由采集器从调用方给的题干元素读（不在表单根里
   * 就是空串）。代理的可读名常常读不到题干（Ashby 的是非按钮只有「YesNo」），所以单独给。
   */
  readonly signingQuestion?: string;
  /**
   * The candidate sits inside the ARIA popup (`aria-controls` / `aria-owns`
   * → `[role=listbox]`) of a combobox trigger that is itself inside the form
   * root, and that popup was opened by this transaction. Widget libraries
   * portal their menus to `<body>` (Ashby's location autocomplete, 2026-09-15),
   * so an option there is outside the root by DOM containment while being the
   * widget's own list. Only a `transaction-option` may use it, and only this
   * one deny (`OUTSIDE_FORM`) is lifted; every other deny still applies.
   * Missing means "not proven" and keeps the plain containment rule.
   */
  readonly withinOwnedPopup?: boolean;
  /**
   * The candidate sits inside the popup a vendor rule declares for a widget
   * whose trigger is inside the form root, and that popup was opened by this
   * transaction. Workday's "How Did You Hear About Us?" prompt (nvidia.wd5,
   * 2026-09-15) portals its menu to `<body>` with **no `id`** and never puts
   * `aria-controls`/`aria-owns` on the trigger, so `withinOwnedPopup` can prove
   * nothing there and the option click dies on `OUTSIDE_FORM`.
   *
   * Derived from the DOM by `collectClickFacts` and re-derived before every
   * pointer event: the rule's popup-root selector must resolve to **exactly
   * one** element in the trigger's document and that element must strictly
   * contain the candidate. It is exactly as narrow as `withinOwnedPopup`: only
   * a `transaction-option` may use it, and only `OUTSIDE_FORM` is lifted —
   * hidden, submit-shaped, captcha, consent, unplanned and foreign-transaction
   * candidates are denied exactly as before, and an arbitrary `<body>`-level
   * element is not inside the declared root, so it stays outside the form.
   * Missing means "not proven" and keeps the plain containment rule.
   */
  readonly withinRuleDeclaredPopup?: boolean;
  /**
   * The candidate matches the vendor rule's typeahead suggestion selector inside
   * the widget container the same rule names (Lever renders suggestions as plain
   * `div.dropdown-location` rows with no ARIA role, 2026-09-15; Workday's prompt
   * rows are role-less `div[data-automation-id="promptOption"]`). Derived from the
   * DOM by `collectClickFacts` from rule data, like `declaredRowAction`; it only
   * satisfies the option-shape requirement of a `transaction-option` and lifts no
   * other deny — the row must still be inside the form root, visible, planned and
   * opened by this transaction.
   */
  readonly ruleDeclaredOption?: boolean;
  /** Needed to reject a button whose omitted type would default to submit. */
  readonly insideHtmlForm: boolean;
  /** Only these categories can ever become eligible. */
  readonly kind: ClickTargetKind;
  /**
   * 该候选属于**用户已审阅的计划**。字段级是「它所属的字段在填充计划里」；
   * 行动作是「这一次增/删/存行在行计划里」——同一条门，两种证明对象。
   */
  readonly planned: boolean;
  /** A transaction observer saw the related popup appear after it started. */
  readonly openedByTransaction: boolean;
  readonly tagName?: string;
  readonly role?: string;
  readonly inputType?: string;
  readonly buttonType?: string | null;
  /** A future DOM scanner flags off-screen, unlabeled tabindex=-1 traps here. */
  readonly isLikelyHoneyPot?: boolean;
  /** Includes a control inside a password widget, not only the password input. */
  readonly inPasswordContainer?: boolean;
  /** Hidden, disabled, or off-screen controls are never valid click targets. */
  readonly isHidden?: boolean;
  readonly isDisabled?: boolean;
  readonly isLikelyOffscreen?: boolean;
  /** Choice clicks are legal only when tied to one planned radio or checkbox. */
  readonly choiceControl?: 'radio' | 'checkbox';
  readonly hasHref?: boolean;
  /**
   * 这个 `<a>` 的 href **点下去会不会离开当前页面**。
   *
   * LINK 这条 deny 防的从来是**导航**：点走一个链接会离开表单、丢掉用户已填的内容。
   * 而 `<a role="button" href="javascript:void(0)">` 是真实存在的按钮写法——
   * iCIMS 的加行按钮就长这样（2026-08-22 实测，见 50-证据库 §F.6-k），
   * 按老规则它一次都点不了，且失败静默（原因码 `LINK` 看着像挡对了）。
   *
   * **缺省 `undefined` 仍按会导航处理**：调用方不表态就维持旧行为，
   * 只有明确证明「这个 href 不导航」才过。`role === 'link'` 一律照旧拒绝——
   * 作者自己声明它是链接，就按链接对待。
   */
  readonly hrefNavigates?: boolean;
  readonly opensFileDialog?: boolean;
  readonly inCaptcha?: boolean;
  readonly accessibleName?: string;
  readonly labelText?: string;
  /**
   * 目标匹配了 apply-rules 声明的行动作选择器，且落在对应行作用域内——
   * 由调用方在 DOM 侧证明后交进来。
   *
   * 为什么必须是「声明过」而不是按文本或长相认：一个按钮能不能点，
   * 靠猜就会在某一家宿主上猜错，而这里猜错的代价是**替用户提交了一段数据**。
   * 厂商知识只能来自受验证的规则数据（铁律 3），本层不看 DOM、不看文本。
   */
  readonly declaredRowAction?: 'add' | 'save' | 'remove';
  /**
   * ARIA 代理选项（2026-09-23）此刻公布选中态用的那个属性：`button` 的 `aria-pressed`、
   * `role=radio|checkbox` 的 `aria-checked`；值不是字面 `"true"`/`"false"` 就是 `null`。
   * 由采集器从 DOM 读，`proxy-option` 必备。
   */
  readonly proxyState?: 'aria-pressed' | 'aria-checked' | null;
  /**
   * 这是一个有表单归属、点了会提交或重置那张表的 `<button>`（按 IDL `form` 读，`form="id"` 的远端
   * 关联也算；`closest('form')` 看不见它，所以 `IMPLICIT_SUBMIT_BUTTON` 挡不住）。给了就判，
   * `proxy-option` 必备。
   */
  readonly formSubmitCapable?: boolean;
  /**
   * 代理里承载答案的原生控件，由采集器从 DOM 推出：`'none'` = 纯 ARIA 部件、点代理本身；
   * `'radio'` / `'checkbox'` = 恰好一个同类型的原生控件、离它最近的代理就是这一个；
   * `'invalid'` = 调用方说的承载对不上 DOM。`proxy-option` 必备。
   */
  readonly proxyCarrier?: 'none' | 'radio' | 'checkbox' | 'invalid';
  /**
   * 账号墙（2026-09-28）：规则声明的这一颗是哪一个角色——提交、用邮箱登录、切到登录、切到注册、注册条款勾选框。
   * 由采集器从规则解释器交出的账号墙这一步带进来（元素就是那一步里这个角色的那一个）；`account-control` 必备。
   */
  readonly declaredAccountControl?: 'submit' | 'useEmail' | 'toSignIn' | 'toCreateAccount' | 'terms';
}

export type ClickPolicyReason =
  | 'OUTSIDE_FORM'
  | 'NOT_PLANNED'
  | 'FOREIGN_TRANSACTION'
  | 'UNSUPPORTED_TARGET'
  | 'SUBMIT_NAME'
  | 'SUBMIT_CONTROL'
  | 'IMPLICIT_SUBMIT_BUTTON'
  | 'FILE_CONTROL'
  | 'LINK'
  | 'CAPTCHA'
  | 'CONSENT'
  | 'LEGAL_DECLARATION'
  | 'HONEYPOT'
  | 'PASSWORD'
  | 'OTP_OR_VERIFICATION'
  | 'LOGIN_OR_PAYMENT'
  | 'HIDDEN_CONTROL'
  | 'RESET_CONTROL'
  /**
   * 这一类目标要求的事实没给全。
   *
   * `ClickTargetFacts` 的 deny 相关字段全是 optional，而 `undefined` 是 falsy——
   * **一个没被填上的事实等于那条 deny 这次不跑**，且完全静默：策略表读起来
   * 像是全副武装，执行时可能只有一半。实测 `click/combobox.ts` 的
   * `triggerFacts` 就漏了十项（隐藏、离屏、蜜罐、密码容器、验证码、文件对话框、
   * href 两项、buttonType、labelText），也就是说一个**隐藏的**下拉触发器是点得动的。
   *
   * 所以「齐全」是放行前置，不是靠每个事实构造器的作者记住。
   */
  | 'INCOMPLETE_FACTS';

/**
 * 每一种目标必须给全的事实。缺一项 ⇒ `INCOMPLETE_FACTS`，连 `pointerdown` 都不发。
 *
 * 这张表本身受测（`tests/s0/apply-click-required-facts.redgreen.test.ts`
 * 逐项删除逐项断言，不是抽查），新增一种 `ClickTargetKind` 必须在这里显式表态，
 * 否则那条测试会指出它没登记。
 *
 * `isHidden` 与 `inCaptcha` 对每一种可点击目标都是必备：「看不见的东西不许点」
 * 与「验证码里的东西不许点」没有任何一种目标可以豁免。
 */
const DENY_FACTS = [
  'tagName',
  'buttonType',
  'accessibleName',
  'labelText',
  'isHidden',
  'isDisabled',
  'isLikelyOffscreen',
  'isLikelyHoneyPot',
  'inPasswordContainer',
  'inCaptcha',
  'opensFileDialog',
  'hasHref',
  'hrefNavigates',
] as const satisfies readonly (keyof ClickTargetFacts)[];

const ROW_FACTS = [...DENY_FACTS, 'declaredRowAction'] as const;

const PROXY_OPTION_FACTS = [...DENY_FACTS, 'proxyState', 'formSubmitCapable', 'proxyCarrier'] as const;

const ACCOUNT_CONTROL_FACTS = [...DENY_FACTS, 'declaredAccountControl'] as const;

export const REQUIRED_FACTS_BY_KIND: Readonly<
  Record<ClickTargetKind, readonly (keyof ClickTargetFacts)[]>
> = Object.freeze({
  'combobox-trigger': DENY_FACTS,
  // 我们自己开出来的弹层里的选项：仍要证明它看得见、不在验证码里。
  'transaction-option': DENY_FACTS,
  // Unlike a transaction option, this was already visible in the reviewed
  // packet. Its caller must carry the separate one-shot fill-only authority.
  'reviewed-option': DENY_FACTS,
  'choice-label': DENY_FACTS,
  'choice-proxy': DENY_FACTS,
  // 原生激活的默认动作不被取消，事实更不能缺：这一种类的必备集与其他种类
  // 完全相同，另加 switch 里对 tagName/inputType 的逐字比对。
  'choice-member': DENY_FACTS,
  // 代理选项的形状（状态属性、表单归属、承载）是放行的全部依据，缺一项就说不清这一下点的是什么。
  'proxy-option': PROXY_OPTION_FACTS,
  'datepicker-cell': DENY_FACTS,
  'row-add': ROW_FACTS,
  'row-save': ROW_FACTS,
  'row-remove': ROW_FACTS,
  // 账号墙上的那几颗：角色说不清，这一下点的是什么就说不清。
  'account-control': ACCOUNT_CONTROL_FACTS,
  // `other` 永远落 UNSUPPORTED_TARGET，没有必备事实可言。
  other: [],
});

function missingFact(facts: ClickTargetFacts): boolean {
  return (REQUIRED_FACTS_BY_KIND[facts.kind] ?? []).some((fact) => facts[fact] === undefined);
}

export type ClickPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: ClickPolicyReason };

const SUBMIT_NAME = /submit|apply|send|next|continue|finish|上一步|下一步|提交|申请|保存并继续/i;
// 词界只对拉丁词有意义：中文动作词后面没有 \b，所以按「开头就是这个词」判，不看后文。
const SUBMIT_ACTION_NAME = /^\s*(?:(?:submit|apply|send|next|continue|finish)(?![\p{L}\p{N}_])|上一步|下一步|提交|申请|保存并继续)/iu;
/**
 * 同意类勾选。
 *
 * 本层自己的宽口径（agree/accept/subscribe/follow/top choice…）**加上**
 * `dict/guards.ts` 的 `CONSENT_GRANT`——后者是「实质授权」的唯一真相源，
 * 两层共用同一份，靠构造消除漂移，不靠测试事后对账。
 *
 * 为什么必须合并（2026-08-18 体检实测）：本层原口径没有 `i authorize` /
 * `waive` / 背景调查 / 仲裁 / 信用报告 / 药检。实测下来
 * `I authorize a background check` 与 `I waive my right to a jury trial`
 * 只拿到 `UNSUPPORTED_TARGET`——它们今天挡住**纯属偶然**：因为 choice-label
 * 还不在放行闭集里。而 `PD-2026-08-18`「法律声明勾选」要做的正是把
 * choice-label 接进代点击。接的那一刻，这两条会当场变成可自动勾选。
 */
const CONSENT_NAME =
  /agree|accept|consent|subscribe|terms|privacy notice|email me|follow|top choice|同意|订阅|接收/i;

/**
 * The same consent read against a combobox trigger, whose accessible name is a
 * whole question rather than a control's own wording — the same distinction
 * `LEGAL_DECLARATION_TRIGGER_NAME` below already draws, for the same reason.
 *
 * `follow` is in the list for marketing opt-ins ("Follow us", "follow this
 * company"). Inside a sentence it also matches the ordinary English word
 * *following*, and an EEO question is exactly where that happens: live on
 * nvidia.wd5 (2026-09-15, Workday step 4 Voluntary Disclosures) the trigger for
 * "Do you identify as one of the following protected veterans (Disabled
 * Veteran, Recently Separated Veteran, …)?" was denied CONSENT and left empty,
 * while "What is your ethnicity?" and "What is your gender?" — the same widget,
 * the same page, the same decline answer — filled. The host then refused the
 * page for a missing required field that nothing had consented to anything.
 *
 * Only that one token is bounded, and only for triggers: `following` stops
 * matching, a bare or leading `follow` still denies, every other token
 * (agree / accept / consent / subscribe / terms / privacy notice / email me /
 * top choice / 同意 / 订阅 / 接收) is untouched, and `CONSENT_GRANT` — the single
 * source of truth for a substantive grant — is still consulted in full. Options,
 * labels and buttons keep the whole-text deny exactly as before.
 */
const CONSENT_TRIGGER_NAME =
  /agree|accept|consent|subscribe|terms|privacy notice|email me|follow(?!ing\b)|top choice|同意|订阅|接收/i;

function isConsentName(text: string, kind?: ClickTargetKind): boolean {
  const named = kind === 'combobox-trigger' ? CONSENT_TRIGGER_NAME : CONSENT_NAME;
  return named.test(text) || CONSENT_GRANT.test(text);
}
const LEGAL_DECLARATION_NAME =
  /legal|declaration|certif(?:y|ication)|acknowledg(?:e|ment)|attest(?:ation)?|waiver|disclosure|法律|声明|承诺|知悉/i;
/**
 * The same deny read against a combobox trigger, whose accessible name is the
 * question wording (see the SUBMIT_NAME note below). Real Greenhouse posting
 * (Discord 8694476002, 2026-09-15): "Are you legally authorized to work in the
 * United States for our Company?" is an ordinary react-select question, yet the
 * bare `legal` token denied opening it while its Yes/No neighbours filled. A
 * declaration-shaped trigger ("I certify …", "… acknowledgment", "法律声明") is
 * still denied; only the bare adjective and the bare 法律 are dropped here, and
 * options, labels and buttons keep the whole-text deny above.
 */
const LEGAL_DECLARATION_TRIGGER_NAME =
  /declaration|certif(?:y|ication)|acknowledg(?:e|ment)|attest(?:ation)?|waiver|disclosure|法律声明|声明|承诺|知悉/i;
const OTP_OR_VERIFICATION_NAME =
  /otp|one[-\s]?time|passcode|verification|verify|security code|验证码|校验码|动态码|一次性密码/i;
const LOGIN_OR_PAYMENT_NAME =
  /sign\s*in|log\s*in|login|authenticat|payment|\bpay\b|credit card|debit card|billing|card number|cvv|cvc|登录|登陆|付款|支付|信用卡|银行卡|账单/i;
/**
 * 代填时「认得回来的那一句」读的是一整句话，不是控件名（第二刀，2026-09-23）：提交类动作词只在
 * 开头才算（像按钮名，前面的星号、括号不算字），`sign in`／`log in` 按整词算——「By submitting this
 * application, I certify…」「By signing below…」「the information submitted is true」都不再被一刀切。
 * 与 dict/signOnBehalf.ts 的 CLICK_ABSOLUTE_DENY 同口径：那边认不得的，这里一定拦；这里拦的，那边一定认不得。
 */
const SIGNED_SENTENCE_SUBMIT =
  /^[^\p{L}\p{N}]*(?:(?:submit|apply|send|next|continue|finish)(?![\p{L}\p{N}_])|上一步|下一步|提交|申请|保存并继续)/iu;
const SIGNED_SENTENCE_LOGIN_OR_PAYMENT =
  /\bsign(?:ing)?\s*in\b|\blog(?:ging)?\s*in\b|\blogins?\b|authenticat|payment|\bpay\b|credit card|debit card|billing|card number|cvv|cvc|登录|登陆|付款|支付|信用卡|银行卡|账单/iu;
/**
 * 代填第五刀（2026-09-28）：核实所填信息（学历、工作经历、身份、E-Verify）放行了，认得回来的那一句按整句读验证码
 * 一类——verification code／link、verify your email／phone／account、one-time、passcode、OTP、security code 照旧
 * 绝对拒绝；光秃秃的 verify／verification（「I authorize Acme to verify my education」）不再一刀切。与
 * dict/signOnBehalf.ts 的 WIDENED_ABSOLUTE_DENY 同口径。认不回来的文字照旧按 `OTP_OR_VERIFICATION_NAME` 整段判。
 */
const SIGNED_SENTENCE_OTP =
  /\botp\b|one[-\s]?time|passcode|\bverification (?:codes?|links?|e-?mails?|texts?|sms|messages?)\b|\bverify (?:your|my|the|this) (?:e-?mail|phone|mobile|number|account|code)|security code|验证码|校验码|动态码|一次性密码/iu;

function normal(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function candidateText(facts: ClickTargetFacts): string {
  return [facts.accessibleName, facts.labelText, facts.signingQuestion]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

type SigningTexts = Readonly<{ verified: readonly string[]; rest: string }>;

/**
 * 代填判据（dict/signOnBehalf.ts）里点击当下要问的那几句。
 *
 * 由入口交给判定体，判定体自己不直接引用判据：扫描那一半（规则解释器里组合框的还原点击）只用
 * `evaluateUnsignedClickTarget`，那条路上带着代填标记的一律拒，于是把规则编译成适配器的 worker 用不着
 * 这一大段正则（2026-09-24：第三刀的同意类判据有八九 KB，worker 的包就差这点余量）。
 */
interface SigningGrammar {
  /** 这一段文字认得回来是这一类（整句）。 */
  readonly states: (text: string, kind: SignOnBehalfChoiceKind) => boolean;
  /** 题面认得回来：整句是这一类；同意类另认同一类的标题。 */
  readonly asks: (text: string, kind: SignOnBehalfChoiceKind) => boolean;
  /**
   * 这一类的回答：Yes／I agree（同意类另认 Opt in／I authorize／I understand）；能不能联系雇主（2026-09-28）按类别里
   * 写的方向——`*_YES` 只认肯定回答，`*_NO` 只认否定回答。
   */
  readonly answers: (kind: SignOnBehalfChoiceKind, text: string) => boolean;
  /** 按整道题判的类别（同意类与联系雇主）：代理题上也代填。 */
  readonly consent: (kind: SignOnBehalfChoiceKind) => boolean;
}

/**
 * 判据都在 dict/signOnBehalf.ts：条款同意／属实声明按前两刀，六类同意按第三刀，新类别按第五刀，只有标题的隐私声明
 * 认那个名字，联系雇主按对象与方向（2026-09-28）。
 */
const SIGNING_GRAMMAR: SigningGrammar = /* @__PURE__ */ Object.freeze({
  states: signOnBehalfStates,
  asks: signOnBehalfAsks,
  answers: signOnBehalfAnswers,
  consent: isWholeQuestionKind,
});

const squash = (value: string): string => value.replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * 代填的 ARIA 代理选项（2026-09-24，只有六类同意；条款同意／属实声明在代理题上一律不认）。
 *
 * 代理的可读名常常读不到题干——Ashby 的是非按钮读出来是「YesNo」——所以题干另从扫描时记下的题干元素
 * 读（`signingQuestion`，此刻的文字）。三段各认各的：
 *  · 题干：这一类的整句同意；或者同一类的标题，而选项自己是这一类的整句同意；
 *  · 选项自己的文字（textContent）：这一类的肯定回答（Yes／I agree／Opt in…）或整句同意；
 *    单个 role=checkbox 的选项自己没有字（Workable 只包着一个隐藏 input），那时题干必须是整句同意；
 *  · 可读名：等于题干、等于选项、等于「题干 + 选项」（Workable 的 aria-labelledby 连题带选项）、
 *    或者本身就是这一类的整句同意，才算认得回来；否则留给下面按题干口径的拒绝去判（「YesNo」过得去）。
 */
function proxySigningTexts(
  facts: ClickTargetFacts,
  kind: SignOnBehalfChoiceKind,
  grammar: SigningGrammar,
): SigningTexts | 'MISMATCH' {
  if (!grammar.consent(kind)) return 'MISMATCH';
  const question = facts.signingQuestion?.trim() ?? '';
  const own = facts.labelText?.trim() ?? '';
  if (question === '') return 'MISMATCH';
  const questionStates = grammar.states(question, kind);
  const ownStates = own !== '' && grammar.states(own, kind);
  const accepted = own === ''
    ? normal(facts.role) === 'checkbox' && questionStates
    : (questionStates && (ownStates || grammar.answers(kind, own))) || (grammar.asks(question, kind) && ownStates);
  if (!accepted) return 'MISMATCH';
  const name = facts.accessibleName?.trim() ?? '';
  const nameVerified = name === '' ||
    [own, question, `${question} ${own}`].some((text) => squash(text) === squash(name)) ||
    grammar.states(name, kind);
  const verified = [question, ...(own === '' ? [] : [own]), ...(nameVerified && name !== '' ? [name] : [])];
  return { verified, rest: nameVerified ? '' : name };
}

/**
 * 代填的目标（2026-09-23；第二刀扩到单选与下拉）：可读文字按段去重，哪几段**认得回来**。
 *
 *  · 复选框／单选成员、下拉选项：这一段判成计划里记的那一类，或者是一句肯定回答（Yes／I agree／
 *    Acknowledge…——题面已在计划期判过，选项自己只需是闭集里的那几个字）；
 *  · 下拉触发器：这一段（题面）判成那一类；肯定回答在这里不算数；
 *  · 别的种类带着标记、或者一段都认不回来：`'MISMATCH'`，一律拒。普通判据只拦「像同意的」，而一个
 *    被换成「Yes, and add me to your talent community」的选项并不像同意——代填标记在身，就只认
 *    认得回来的。
 *
 * 按段判而不是判拼起来的整句：无障碍名与标签常常是同一句，拼起来的「两句一样的声明」在属实声明的
 * 语法里不成立。认不回来的那几段（下拉触发器上显示的当前值、选项旁的附注）照旧按原来的判据跑。
 *
 * 第三刀（2026-09-24）：六类同意同一套读法，判据换成同意类的整句判据；下拉触发器上的题面另认同一类的
 * 标题（仲裁的「Agreement to Arbitrate」——选项本身是那一句同意，由写入器按整题重判时保证）；肯定回答
 * 多认 Opt in／I authorize／I understand 几种。ARIA 代理选项见 `proxySigningTexts`。
 */
function signingTexts(facts: ClickTargetFacts, grammar: SigningGrammar | null): SigningTexts | 'MISMATCH' | null {
  const kind = facts.signOnBehalf;
  if (kind === undefined) return null;
  // 这条入口不带判据（`evaluateUnsignedClickTarget`）：带着代填标记的目标一律认不回来。
  if (grammar === null) return 'MISMATCH';
  if (facts.kind === 'proxy-option') return proxySigningTexts(facts, kind, grammar);
  const answer =
    facts.kind === 'transaction-option' ||
    (facts.kind === 'choice-member' && (facts.choiceControl === 'checkbox' || facts.choiceControl === 'radio'));
  if (!answer && facts.kind !== 'combobox-trigger') return 'MISMATCH';
  const texts = [...new Set([facts.accessibleName, facts.labelText].map((value) => value?.trim() ?? '').filter(Boolean))];
  const verified = texts.filter((text) =>
    answer ? grammar.states(text, kind) || grammar.answers(kind, text) : grammar.asks(text, kind));
  if (verified.length === 0) return 'MISMATCH';
  return { verified, rest: texts.filter((text) => !verified.includes(text)).join(' ') };
}

function isSubmitControl(facts: ClickTargetFacts): boolean {
  const tagName = normal(facts.tagName);
  const type = normal(tagName === 'button' ? facts.buttonType : facts.inputType);
  return (tagName === 'button' || tagName === 'input') &&
    (type === 'submit' || (tagName === 'input' && type === 'image'));
}

function isImplicitSubmitButton(facts: ClickTargetFacts): boolean {
  return normal(facts.tagName) === 'button' && facts.insideHtmlForm && normal(facts.buttonType) === '';
}

function isResetControl(facts: ClickTargetFacts): boolean {
  const tagName = normal(facts.tagName);
  const type = normal(tagName === 'button' ? facts.buttonType : facts.inputType);
  return (tagName === 'button' || tagName === 'input') && type === 'reset';
}

function isOptionLike(facts: ClickTargetFacts): boolean {
  const tagName = normal(facts.tagName);
  const role = normal(facts.role);
  return tagName === 'option' || role === 'option' || (tagName === 'li' && role === 'option');
}

/** 付款那一半（账号墙上「登录」「注册」本身就是要按的，但付款、信用卡永远不按）。 */
const PAYMENT_NAME = /payment|\bpay\b|credit card|debit card|billing|card number|cvv|cvc|付款|支付|信用卡|银行卡|账单/i;
/**
 * 像是在交申请，不是在登录、注册：「Submit application」「Apply now」「提交申请」。账号墙上声明的提交从来不长这样；
 * 长这样就是规则声明错了，或网站把账号墙和申请的提交放在了一起——都不按（最终提交只在用户按下浮层里的「提交」之后）。
 */
const APPLICATION_SUBMIT_NAME =
  /submit\s+(?:my\s+|your\s+|this\s+|the\s+)?application|\bapply\b|send\s+(?:my\s+|your\s+)?application|提交申请|申请/i;
/**
 * 注册条款勾选框的字里掺了注册之外的授权：营销订阅、短信、人才库、工作提醒，或 `CONSENT_GRANT` 那一类实质授权
 * （背景调查、仲裁、弃权……）。用户同意的是「接受注册所需的网站条款」，掺了别的就不是这一类，交还本人。
 */
const BEYOND_REGISTRATION_TERMS =
  /subscrib|newsletter|marketing|promotion|text message|\bsms\b|whats\s*app|job alert|talent (?:community|network|pool)|订阅|营销|推广|短信|人才库/i;

/**
 * 账号墙上的那几颗（2026-09-28）。与通用那张表分开写，是因为放行的东西正好相反：通用判定一律拒「Sign in」「Create
 * Account」、`type=submit`、「I agree」，而这里要按的就是它们。所以这一张表的每一条拒绝都在这里重新写一遍，一条都不省：
 *
 *  · 隐藏、禁用、离屏、`type=hidden`；验证码、一次性验证码（名字里说 verification／OTP 的也算）；蜜罐；密码框本身与
 *    密码部件里的东西；文件框；会导航的链接；重置按钮；付款；像是交申请的名字——**任何角色都拒**；
 *  · 角色与形状要对上：条款必须是勾选框，而且字里不能掺注册之外的授权；提交可以是 `type=submit`；「用邮箱登录」与
 *    两个切换不许是表单里的提交按钮（`type=submit`，或表单里省略 type 的 `<button>`）——点它们只该换一个视图；
 *  · 除了条款，别的角色的名字不许像同意或法律声明（同意只在条款那一格、按规则声明的那一个）；
 *  · 必须在计划里（调用方证明：这一下是这一轮账号墙要按的那一颗）。
 *
 * 「登录」「注册」这类名字不拒——那正是这一颗的用途。能力位与用户的同意不在事实里：点击原语按前重读策略里的
 * `account-access` 位，worker 在交出密码之前读用户同意过的那一版文案。
 */
function evaluateAccountControl(facts: ClickTargetFacts): ClickPolicyDecision {
  const role = facts.declaredAccountControl;
  const text = candidateText(facts);
  const tagName = normal(facts.tagName);
  const inputType = normal(facts.inputType);
  const roleName = normal(facts.role);
  if (facts.isHidden || facts.isDisabled || facts.isLikelyOffscreen || inputType === 'hidden') {
    return { allowed: false, reason: 'HIDDEN_CONTROL' };
  }
  if (OTP_OR_VERIFICATION_NAME.test(text)) return { allowed: false, reason: 'OTP_OR_VERIFICATION' };
  if (PAYMENT_NAME.test(text)) return { allowed: false, reason: 'LOGIN_OR_PAYMENT' };
  if (APPLICATION_SUBMIT_NAME.test(text)) return { allowed: false, reason: 'SUBMIT_NAME' };
  if (isResetControl(facts)) return { allowed: false, reason: 'RESET_CONTROL' };
  if ((tagName === 'input' && inputType === 'file') || facts.opensFileDialog) {
    return { allowed: false, reason: 'FILE_CONTROL' };
  }
  if ((tagName === 'a' && facts.hasHref && facts.hrefNavigates !== false) || roleName === 'link') {
    return { allowed: false, reason: 'LINK' };
  }
  if (facts.inCaptcha) return { allowed: false, reason: 'CAPTCHA' };
  if (facts.isLikelyHoneyPot || isHoneyPotField(text)) return { allowed: false, reason: 'HONEYPOT' };
  if (facts.inPasswordContainer || inputType === 'password') return { allowed: false, reason: 'PASSWORD' };
  if (role === 'terms') {
    if (tagName !== 'input' || inputType !== 'checkbox') return { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    if (CONSENT_GRANT.test(text) || BEYOND_REGISTRATION_TERMS.test(text)) return { allowed: false, reason: 'CONSENT' };
  } else {
    if (tagName === 'input' && inputType !== 'submit' && inputType !== 'button') {
      return { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    }
    if (role !== 'submit' && isSubmitControl(facts)) return { allowed: false, reason: 'SUBMIT_CONTROL' };
    if (role !== 'submit' && isImplicitSubmitButton(facts)) return { allowed: false, reason: 'IMPLICIT_SUBMIT_BUTTON' };
    if (isConsentName(text, 'choice-member')) return { allowed: false, reason: 'CONSENT' };
    if (LEGAL_DECLARATION_NAME.test(text)) return { allowed: false, reason: 'LEGAL_DECLARATION' };
  }
  if (!facts.planned) return { allowed: false, reason: 'NOT_PLANNED' };
  return { allowed: true };
}

/**
 * Return a reason whenever a target falls outside the narrow static policy.
 * Deny rules are evaluated before the category allowlist, so a submit-looking
 * element can never be made eligible merely by claiming a recognised kind.
 */
export function evaluateClickTarget(facts: ClickTargetFacts): ClickPolicyDecision {
  return evaluate(facts, SIGNING_GRAMMAR);
}

/**
 * 同一张表，但不认任何代填标记（带着就拒）。给从来不代填的那几条路用——规则解释器里组合框的还原
 * 点击——好让只需要它们的 worker 不必带上代填的整句判据（见 `SigningGrammar`）。其余每一条拒绝逐字相同。
 */
export function evaluateUnsignedClickTarget(facts: ClickTargetFacts): ClickPolicyDecision {
  return evaluate(facts, null);
}

function evaluate(facts: ClickTargetFacts, grammar: SigningGrammar | null): ClickPolicyDecision {
  // A portaled option is outside the root by containment but inside the menu its
  // in-form trigger owns — proven by ARIA (`withinOwnedPopup`) when the widget
  // declares it, and otherwise by the vendor rule's document-unique popup root
  // (`withinRuleDeclaredPopup`). Nothing else leaves the root, and neither fact
  // lifts any deny but this one.
  if (
    !facts.withinFormRoot &&
    !(facts.kind === 'transaction-option' &&
      (facts.withinOwnedPopup === true || facts.withinRuleDeclaredPopup === true))
  ) {
    return { allowed: false, reason: 'OUTSIDE_FORM' };
  }

  // 必须排在所有 deny **之前**：一条读到 `undefined` 的 deny 等于没跑，
  // 先证明它读得到东西，再让它跑。排在 withinFormRoot 之后是因为
  // 「不在我们认的表单里」比「事实没给全」更根本、也更好懂。
  if (missingFact(facts)) return { allowed: false, reason: 'INCOMPLETE_FACTS' };
  // 账号墙上的那几颗走自己的一张表，与下面的通用判定互不借道（见 `evaluateAccountControl`）。
  if (facts.kind === 'account-control') return evaluateAccountControl(facts);

  const text = candidateText(facts);
  const tagName = normal(facts.tagName);
  const role = normal(facts.role);
  const inputType = normal(facts.inputType);
  const signing = signingTexts(facts, grammar);
  // 代填时认得回来的那几句按整句读（SIGNED_SENTENCE_*）；其余文字照旧按控件名读。
  const sentences = signing === null || signing === 'MISMATCH' ? [] : signing.verified;
  const named = signing === null || signing === 'MISMATCH' ? text : signing.rest;
  // ARIA 代理选项（2026-09-23）的可读名常常连着题干：Workable 每个 role=radio 的 aria-labelledby 是
  // 「题干 + 选项」，于是「Are you legally authorized …? YES」整句进了可读名。所以分两段读：选项自己
  // 的文字（textContent）按控件名的严口径；可读名按题干口径——与 combobox 触发器同一条理由（题干
  // 不是控件名）。两段各自的拒绝一条都不少，只是 legal / following / 句中的 apply 不再误伤题干。
  // 代填的代理选项（2026-09-24）：选项自己的文字与题干已在 `proxySigningTexts` 里认回来，按整句读；
  // 认不回来的可读名（Ashby 的「YesNo」）照旧按题干口径跑下面每一条拒绝。
  const proxy = facts.kind === 'proxy-option';
  const signedProxy = proxy && signing !== null && signing !== 'MISMATCH';
  const ownName = proxy ? (signedProxy ? '' : facts.labelText ?? '') : named;
  const questionName = proxy ? (signedProxy ? named : facts.accessibleName ?? '') : '';

  if (facts.isHidden || facts.isDisabled || facts.isLikelyOffscreen || inputType === 'hidden') {
    return { allowed: false, reason: 'HIDDEN_CONTROL' };
  }
  // 验证码一类：认不回来的文字照旧整段判；代填认得回来的那几句按整句判（第五刀放行了核实所填信息）。
  const unverified = signing === null || signing === 'MISMATCH' ? text : [signing.rest, facts.signingQuestion ?? '']
    .filter((part) => part !== '' && !signing.verified.includes(part.trim()))
    .join(' ');
  if (OTP_OR_VERIFICATION_NAME.test(unverified) || sentences.some((sentence) => SIGNED_SENTENCE_OTP.test(sentence))) {
    return { allowed: false, reason: 'OTP_OR_VERIFICATION' };
  }
  if (LOGIN_OR_PAYMENT_NAME.test(named) || sentences.some((sentence) => SIGNED_SENTENCE_LOGIN_OR_PAYMENT.test(sentence))) {
    return { allowed: false, reason: 'LOGIN_OR_PAYMENT' };
  }
  // combobox 触发器的可读名是**题干**，只有以动作词开头的名字才算提交类（"Submit application"、
  // "Apply now"）；一句里带了 apply/next 的问题（Greenhouse 每道多选题都写着 "select all that
  // apply"）不是控件名，点它也只会打开菜单。其他目标照旧看整句；结构性的提交判定在下面。
  if (
    (facts.kind === 'combobox-trigger' ? SUBMIT_ACTION_NAME.test(named) : SUBMIT_NAME.test(ownName)) ||
    (proxy && SUBMIT_ACTION_NAME.test(questionName)) ||
    sentences.some((sentence) => SIGNED_SENTENCE_SUBMIT.test(sentence))
  ) {
    return { allowed: false, reason: 'SUBMIT_NAME' };
  }
  if (isSubmitControl(facts)) return { allowed: false, reason: 'SUBMIT_CONTROL' };
  // 有表单归属的按钮：点下去就是提交或重置那张表（`form="id"` 的远端归属 closest 看不见）。
  if (facts.formSubmitCapable === true) return { allowed: false, reason: 'SUBMIT_CONTROL' };
  if (isImplicitSubmitButton(facts)) return { allowed: false, reason: 'IMPLICIT_SUBMIT_BUTTON' };
  if (isResetControl(facts)) return { allowed: false, reason: 'RESET_CONTROL' };
  if ((tagName === 'input' && inputType === 'file') || facts.opensFileDialog) {
    return { allowed: false, reason: 'FILE_CONTROL' };
  }
  // fail closed：`hrefNavigates !== false` 意味着「没表态」和「表态说会导航」
  // 都拒绝，只有显式的 `false` 才放行。
  if ((tagName === 'a' && facts.hasHref && facts.hrefNavigates !== false) || role === 'link') {
    return { allowed: false, reason: 'LINK' };
  }
  if (facts.inCaptcha) return { allowed: false, reason: 'CAPTCHA' };
  if (facts.isLikelyHoneyPot || isHoneyPotField(text)) return { allowed: false, reason: 'HONEYPOT' };
  if (facts.inPasswordContainer || inputType === 'password' || isPasswordField(text)) {
    return { allowed: false, reason: 'PASSWORD' };
  }

  // ── 以上全是**绝对拒绝**：提交、验证码、蜜罐、密码、登录支付、文件、链接。
  //    任何档位、任何 opt-in 开关都打不开它们。代填认得回来的那一句只换了读法（按整句读提交与
  //    登录两条名字判据），没有跳过任何一条；结构性的提交、文件、链接判定对它一样生效。
  //
  // ── 以下两条是**分档判定**，`LEGAL_DECLARATION` 是全表唯一有朝一日
  //    可能被放开的原因码（`PD-2026-08-18-IRONCLAD-5-SPLIT` 的乙档）。
  //
  // 为什么这两条必须排在绝对拒绝**之后**（2026-08-18 评审指出，核实成立）：
  // 原先 CONSENT 排在最前，今天无害——从 OUTSIDE_FORM 到 NOT_PLANNED 每一条
  // 都是 deny，变的只是原因码。但只要有人放宽 CONSENT（比如"让用户选择自动
  // 接受 cookie 横幅"），`Accept and Continue` 这类**提交按钮**会先命中
  // CONSENT_NAME 的 `accept` 而在 SUBMIT_NAME 之前被放行。
  // 这与本仓上午刚抓到的那个缺口是同一形态：一条保护只是**偶然**生效。
  // 把绝对拒绝全部前置，任何未来的放宽都够不到它们。
  //
  // 这两条之间的先后同样是安全属性：`I certify that I consent to a
  // background check` 同时命中，必须落在 CONSENT 一侧，否则乙档开关一开
  // 就把背景调查同意一起勾了（与 dict/guards.ts 的分档同口径）。
  //
  // 代填（2026-09-23；负责人 2026-09-22 夜的决定）：计划里标了类别的那一格条款同意或属实声明，
  // 点击当下认得回来的那几段跳过这两道分档拒绝；认不回来的段照旧跑，一段都认不回来就拒。绝对
  // 拒绝已经在上面跑完，这里够不到它们。2026-09-24 起六类同意（AI 面试记录、短信、日后联系、营销、
  // 背景调查授权、仲裁协议）同样只跳过认得回来的那几段；联系现任雇主、点名他人、第三方、核实、
  // 混合授权在 signOnBehalf 的判据里就被排除了，认不回来。
  if (signing === 'MISMATCH') return { allowed: false, reason: 'CONSENT' };
  if (isConsentName(ownName, proxy ? 'choice-member' : facts.kind) || (proxy && isConsentName(questionName, 'combobox-trigger'))) {
    return { allowed: false, reason: 'CONSENT' };
  }
  if (
    (facts.kind === 'combobox-trigger' ? LEGAL_DECLARATION_TRIGGER_NAME.test(named) : LEGAL_DECLARATION_NAME.test(ownName)) ||
    (proxy && LEGAL_DECLARATION_TRIGGER_NAME.test(questionName))
  ) {
    return { allowed: false, reason: 'LEGAL_DECLARATION' };
  }

  if (!facts.planned) return { allowed: false, reason: 'NOT_PLANNED' };

  switch (facts.kind) {
    case 'combobox-trigger':
      return { allowed: true };
    case 'choice-label':
      return facts.choiceControl && tagName === 'label'
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    case 'choice-proxy':
      return facts.choiceControl
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    // 目标必须**就是**那个已审阅的选项控件：`<input>` 且 `type` 与控件种类
    // 逐字相同。少一项都退回 UNSUPPORTED_TARGET，绝不靠 choice-proxy 兜底。
    case 'choice-member':
      return (facts.choiceControl === 'radio' || facts.choiceControl === 'checkbox') &&
        tagName === 'input' &&
        inputType === facts.choiceControl
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    // 代理选项：标签、角色、状态属性、承载四者逐一对得上才放行。切换按钮必须是一个没另声明角色的
    // `<button>`、公布 aria-pressed、不可能有承载；role=radio|checkbox 公布 aria-checked，承载要么
    // 没有、要么与角色同类型。原生控件冒充代理、状态读不出、承载对不上 DOM，一律 UNSUPPORTED_TARGET。
    case 'proxy-option': {
      const carrier = facts.proxyCarrier;
      const toggle = facts.proxyState === 'aria-pressed' && tagName === 'button' &&
        (role === '' || role === 'button') && carrier === 'none';
      const checkable = facts.proxyState === 'aria-checked' && (role === 'radio' || role === 'checkbox') &&
        (carrier === 'none' || carrier === role);
      return facts.formSubmitCapable === false &&
        tagName !== 'input' && tagName !== 'select' && tagName !== 'textarea' &&
        (toggle || checkable)
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    }
    case 'transaction-option':
      return facts.openedByTransaction && (isOptionLike(facts) || facts.ruleDeclaredOption === true)
        ? { allowed: true }
        : {
            allowed: false,
            reason: facts.openedByTransaction ? 'UNSUPPORTED_TARGET' : 'FOREIGN_TRANSACTION',
          };
    case 'reviewed-option':
      return isOptionLike(facts)
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    // 行动作：种类必须与厂商声明的动作**逐一对上**。只要求「声明过某个动作」
    // 是不够的——把删行按钮当保存按钮点，用户会丢掉刚填完的一整段。
    case 'row-add':
      return facts.declaredRowAction === 'add'
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    case 'row-save':
      return facts.declaredRowAction === 'save'
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    case 'row-remove':
      return facts.declaredRowAction === 'remove'
        ? { allowed: true }
        : { allowed: false, reason: 'UNSUPPORTED_TARGET' };
    case 'datepicker-cell':
      return facts.openedByTransaction
        ? { allowed: true }
        : { allowed: false, reason: 'FOREIGN_TRANSACTION' };
    case 'other':
      return { allowed: false, reason: 'UNSUPPORTED_TARGET' };
  }
}
