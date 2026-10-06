/**
 * apply-rules 规则的边界 schema 与 fail-closed 校验。
 *
 * 这份 JSON 是要走网络的：后端下发热更新（Chrome 商店审核最坏 28 天，
 * 站点改版等不起——docs/20-技术架构.md §3）。所以它按不可信输入对待：
 *
 *  · **拒收即整份拒收**。一条 step 认不得、一个正则编译不过、已知结构里多一个键，
 *    这一份规则关闭执行；绝不退回随包内置规则恢复远程授权，也绝不"跳过看不懂的那一条
 *    继续用"——条目之间不独立（掩码格、新行插在哪一头、部件绑定替掉 widgetNames），
 *    丢一条或忽略一个属性都可能让旧解释器多写、写错地方（铁律 6 的 fail-closed）。
 *    拒收一份规则在运行时只停**这一家**，不拖垮整份 release（`runtimeRegistry.ts`）。
 *  · **唯一的放宽在顶层**（2026-09-28，见 `RulesParseOptions.unknownTopLevelKeys`）：
 *    这一版不认识的顶层键在运行时不解释、不保留，这份规则按没有它照常生效。顶层键
 *    在这份 schema 里是互相独立的一项能力，不认识它 = 不用它 = 旧解释器读旧规则时
 *    本来的样子。发布侧照旧严格。
 *  · 失败只给稳定原因码（铁律 2），不带自由文本，不带规则内容。
 *  · 正则 flags 只放行 `i`：`g`/`y` 让 RegExp 携带 lastIndex 状态，同一条
 *    规则第二次 test 会得到不同答案。
 *
 * 与 `interpreter.ts` 的分工：这里只管"数据合不合法"，那边只管"合法数据
 * 怎么执行"。校验通过的 `VendorRuleset` 仍是纯数据（正则保持 source 字符串），
 * 编译发生在解释器。
 */

import { isCollectionFieldRole } from '../collectionProjection.ts';
import type { CollectionFieldRole } from '../collectionProjection.ts';
import { parseWizardReadOnlyDeclaration, type WizardReadOnlyDeclaration } from './wizardIdentity.ts';
import {
  APPLY_FIELD_KEYS,
  isDerivedAnswerKey,
  type DerivedAnswerKey,
  APPLY_VENDORS,
  MAX_SEARCH_PROMPT_VALUES,
  type ApplyFieldKey,
  type ApplyVendor,
  type RowActionSelectors,
  type RowScopeRule,
  type EmailCodeOutcomeRule,
  type EmailCodePromptRule,
  type EmailVerificationRule,
} from '../contracts.ts';

export const APPLY_RULES_SCHEMA_VERSION = 2;
/** Reader capability only; existing published rules remain v2. */
export const APPLY_RULES_MAX_READER_SCHEMA_VERSION = 3;

/**
 * `attrMap` 能钩的属性 —— **闭集，逐个量过才进**。
 *
 * 每一项都必须有一家厂商实测「它在这一家上稳定且语义化」：
 *
 *  · `id` / `name` —— 绝大多数厂商的常规钩子；
 *  · `autocomplete` —— 厂商主动标了语义的那一档；
 *  · `data-testid` —— Rippling（`ats.rippling.com`）**唯一**可用的钩子；
 *  · `data-automation-id` —— Workday 的字段 wrapper 与控件稳定钩子。
 *    那一家的 `name` 是随机串（`gDSJ_fJtmK`）、`id` 是生成序号（`field-13`，
 *    插一栏就整体漂）、`autocomplete` 一律 `off`；只有 `data-testid` 是
 *    `input-first_name` / `input-email` 这种语义名（50-证据库 §F.8-b 实测）。
 *
 * **不放开成 `data-*` 通配**：白名单的全部意义就是「有人量过、确认它稳」。
 * 放开之后，下一个规则作者无从判断哪个钩子是量过的、哪个是顺手猜的。
 * Workday 的真实 step 1/2/3/5 夹具与守卫测试共同证明：生成 id、空 name 都不
 * 能作为跨租户信号，`data-automation-id` 才能。这里只放行这个精确属性名，
 * 不放开成任意 `data-*`。
 */
export const RULE_ATTR_MAP_ATTRS = [
  'id',
  'name',
  'autocomplete',
  'data-testid',
  'data-automation-id',
  // Ashby（jobs.ashbyhq.com）字段 wrapper 的语义钩子：`.ashby-application-form-field-entry`
  // 带 `data-field-path="_systemfield_location"` 等跨公司稳定的 `_systemfield_*` 值，
  // 而其中的 autocomplete 输入框本身既无 id 也无 name（2026-09-15 Notion posting 实测）。
  // 只放行这个精确属性名，供 `ancestorAttrMap` 使用。
  'data-field-path',
  // SmartRecruiters（jobs.smartrecruiters.com/oneclick-ui）自己的语义钩子。
  // 2026-09-15 实测：one-click 表单里那个地点自动完成框的 `id` 是生成序号
  // （`spl-form-element_10`，随表单结构漂移，规则里明确拒绝当钩子用），既没有
  // `name` 也没有可用的 `autocomplete`（值是 `off`），而它带着跨 posting 稳定的
  // `data-sr-id="location-autocomplete-search-search-input"`。它的显式 label 只写
  // 「City*」，但控件本身是个地理编码自动完成框，选项是完整地名
  // （"San Francisco, CA, US"），所以它要的是 `location` 而不是 `city`——这一条
  // 只有属性钩子说得清，标签说不清。与 `data-field-path` 同一纪律：只放行这个
  // 精确属性名。
  'data-sr-id',
] as const;

/** `attrMap` 可钩的属性名。 */
export type RuleMapAttr = (typeof RULE_ATTR_MAP_ATTRS)[number];

/**
 * A sentinel for one reviewed plain-text contenteditable target. It is not a
 * Profile key and is accepted only in a direct, exact attrMap entry.
 */
export const RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET =
  'coverLetterPlainTextContenteditable' as const;
export type RulePlainTextContenteditableTarget =
  typeof RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET;
export type RuleAttrMapKey = RuleFieldKey | RulePlainTextContenteditableTarget;

const PLAIN_TEXT_CONTENTEDITABLE_TARGET_ATTRS = [
  'id',
  'name',
  'data-testid',
  'data-automation-id',
] as const satisfies readonly RuleMapAttr[];

/** 可下发的正则：source + 受限 flags。绝不接受现成的 RegExp 对象。 */
export interface RuleRegex {
  readonly source: string;
  readonly flags?: 'i';
}

export interface RuleLabelPattern {
  readonly regex: RuleRegex;
  readonly key: RuleFieldKey;
  /**
   * 这条 pattern 适用的页面语言（BCP-47 **主子标签**，小写，如 `['en']`）。
   *
   * 缺省 = 通用，任何页面语言都试——四份既有规则一个字不改、行为不变。
   * 声明了就只在匹配的页面语言下参与匹配。
   *
   * 为什么现在就定：规则由后端热更新下发，schema 一旦发出去改动就是包结构级
   * 重构。v1 仍只发英文，但分层维度现在就存在。目标用户是留学生，欧洲／加拿大
   * 法语区／德语区的申请页匹配不上会表现为「浮层出来了但一个字段都认不出」。
   */
  readonly locales?: readonly string[];
}

/**
 * One default-off, rule-owned semantic transaction for a hosted combobox.
 *
 * Every DOM token is data. The kernel receives only the selector-free
 * `ComboboxSemanticAuthority` compiled by the interpreter. This first phase is
 * deliberately narrow: a transaction is available only when one exact prior
 * selected option can be snapshotted and restored by activating that same
 * rule-owned identity.
 */
export interface ComboboxSemanticControlRule {
  readonly triggerSelector: string;
  readonly openState: Readonly<{
    readonly attribute: string;
    readonly openValue: string;
    readonly closedValue: string;
  }>;
  readonly optionRootSelector: string;
  readonly optionMemberSelector: string;
  readonly optionIdentityAttribute: string;
  readonly selectedState: Readonly<{
    readonly attribute: string;
    readonly selectedValue: string;
    readonly unselectedValue: string;
  }>;
  readonly transaction: Readonly<{
    readonly snapshot: 'exact-selected-option';
    readonly restoreActivation: 'native-click';
  }>;
}

/**
 * resolveKey 的一步。解释器按序执行：
 *  · `attrMap` —— 属性值（小写化后）查表命中即返回 {key, confidence}；
 *  · `stopNamePrefix` —— name 命中任一前缀即终止解析（返回未知）。
 *    Lever 的 `urls[...]`：厂商声明的命名空间高于标签猜测；
 *  · `labelFallbackGate` —— name 非空且不匹配 nameRegex 时终止解析。
 *    Workable 的 `QA_<digits>`：具名核心控件绝不回落到猜标签；
 *  · `labelPatterns` —— 标签文案（小写化后）逐条试 pattern。
 */
export type RuleKeyStep =
  | {
      readonly type: 'attrMap';
      readonly attr: RuleMapAttr;
      readonly confidence: number;
      readonly map: Readonly<Record<string, RuleAttrMapKey>>;
    }
  | {
      /** Nearest ancestor carrying `attr`; Workday keeps the semantic id on a field wrapper. */
      readonly type: 'ancestorAttrMap';
      readonly attr: RuleMapAttr;
      readonly confidence: number;
      readonly map: Readonly<Record<string, RuleFieldKey>>;
    }
  | { readonly type: 'stopNamePrefix'; readonly prefixes: readonly string[] }
  | {
      readonly type: 'labelFallbackGate';
      readonly nameRegex: RuleRegex;
      readonly allowEmptyName: boolean;
    }
  | {
      readonly type: 'labelPatterns';
      readonly confidence: number;
      readonly patterns: readonly RuleLabelPattern[];
    };

/** 一家 ATS 的全部页面知识。除此之外 kernel 不许再有厂商选择器（铁律 3）。 */
/**
 * A WAI-ARIA listbox combobox (react-select and friends): the trigger is an
 * `input[role=combobox]`, the open menu is the element named by its
 * `aria-controls`/`aria-owns`, options are `[role=option]`. Only the readback
 * is vendor knowledge: where the widget displays the chosen option.
 */
export interface ListboxComboboxRule {
  readonly triggerSelector: string;
  readonly valueContainerSelector: string;
  readonly selectedValueSelector: string;
  /** Multi-value variant: both selectors or neither. */
  readonly multiValueContainerSelector?: string;
  readonly multiValueLabelSelector?: string;
  /**
   * The visible control inside `valueContainerSelector` that opens the widget,
   * for the shape where the scanned input is only the widget's value mirror
   * (Workday's `button[aria-haspopup="listbox"]` + 0×0 `input`, measured
   * 2026-09-15). See `ListboxComboboxBinding.activationSelector`.
   */
  readonly activationSelector?: string;
  /**
   * The option rows inside this widget's own listbox, when the vendor puts no
   * `role="option"` on them (SmartRecruiters' `<spl-select-option>`, measured
   * 2026-09-15). See `ListboxComboboxBinding.optionSelector`: it is applied
   * only inside the listbox the trigger's `aria-controls` named.
   */
  readonly optionSelector?: string;
}

/**
 * One vendor-declared question scope: the wrapper each question is rendered in and, inside
 * it, the element that carries the question wording.
 *
 * Why it exists (2026-09-15 live lab, four vendors): Lever renders custom questions as
 * `li.application-question` with the wording in a sibling `.application-label` and the control
 * labelled only by a placeholder ("Type your response"); its radio/checkbox groups have no
 * `<legend>`. Ashby titles every question with `label.ashby-application-form-question-title`
 * whose `for` points nowhere, and gives each checkbox of a "select all that apply" group its own
 * `name`. Rippling puts a long question `<p>` above an unlabelled `<textarea>`. Dover's radio
 * group title is a styled `div`. None of that is reachable by generic label inference, and all
 * of it is vendor DOM knowledge — so it lives here as data.
 *
 * Interpreter semantics (see `interpreter.ts` `resolveQuestionScope`): scopes are tried in
 * declaration order; a scope resolves only when `element.closest(container)` lies inside the
 * verified scan root and that container holds **exactly one** `label` match that wraps no
 * control. A resolved scope never overrides a label the host declared for the control itself
 * (explicit / wrapping `<label>`, `aria-*`); it speaks only when the control would otherwise be
 * labelled by nothing, a placeholder, a title or nearby prose. For radio/checkbox members it
 * also defines the group: every same-type member inside the container is one question even
 * when their `name` attributes differ. No resolved scope = today's behaviour, unchanged.
 */
/**
 * 白标 B（P2-11）：客户自建前端上「同一家 ATS 的数据契约」——控件 id 仍是本家的
 * （duolingo 的 `first_name` / `question_37488760002`），只是没有本家的容器锚点。
 * 声明容器选择器与最少钩子数；钩子本身从 keySteps 里 `attrMap` on `id` 的键派生，不另抄一份。
 * 只在调用方声明 `whitelabel: true` 时启用；≥ minHooks 的容器必须**恰好一个**，否则不猜。
 */
export interface WhitelabelRootRule {
  readonly container: string;
  readonly minHooks: number;
}

/**
 * 通用路的容器（2026-09-22）。与 `WhitelabelRootRule` 同一个形状，差别只在**数什么**：
 * 那一条数的是本家 `attrMap(id)` 的钩子，这一条数的是扫出来**带键**的字段。
 *
 * 自建域上本家的路径与 id 钩子都不存在，所以通用路唯一能立住的判据就是
 * 「这一张表里有足够多我们认得的字段」。门槛与「恰好一个容器达标」两条一起，
 * 决定了它不会把页脚的订阅框当成申请表。
 */
export interface GenericRootRule {
  readonly container: string;
  readonly minKeyedFields: number;
}

export interface QuestionScopeRule {
  /** Selector (list) for the per-question wrapper, matched with `closest()`. */
  readonly container: string;
  /** Selector for the wording element, matched inside the wrapper; must be unique there. */
  readonly label: string;
}

/**
 * A plain-text typeahead without ARIA listbox semantics (Lever's location
 * field): a text input whose suggestions render into a rule-declared element
 * under the widget container, and whose value only counts once a suggestion
 * was picked. Everything here is measured vendor DOM; the writer is generic.
 */
export interface TypeaheadComboboxRule {
  readonly triggerSelector: string;
  /** Widget root, resolved as the trigger's closest ancestor. */
  readonly containerSelector: string;
  /** Suggestion elements under the container; each one's text is the option text. */
  readonly suggestionSelector: string;
  /** Where the chosen suggestion is displayed afterwards; an input reads back through its value. */
  readonly selectedValueSelector: string;
  /** Default 1: the widget searches on any query. */
  readonly minTypedChars: number;
  /** A control the widget fills only on a real pick (hidden inputs); success requires it non-empty. */
  readonly selectionWitnessSelector?: string;
}

/**
 * A portaled prompt: an input whose value only arrives through a menu that is not in the form root
 * (portaled to `<body>`, no ARIA link back to the input) and whose rows carry no option role.
 * Everything here is measured vendor DOM; the writers in write/ are generic. Two kinds share this
 * shape and differ only in their bound (see the two rules below).
 */
export interface PortaledPromptRule {
  readonly triggerSelector: string;
  /** Widget root, resolved as the trigger's closest ancestor; holds the chosen value(s). */
  readonly containerSelector: string;
  /** Where a chosen value is displayed afterwards, under the container (one element per value). */
  readonly selectedValueSelector: string;
  /** The portaled popup root; must be document-unique while the menu is open. */
  readonly popupRootSelector: string;
  /** The row inside that popup which answers a pointer. */
  readonly optionSelector: string;
}

/**
 * A **search** prompt (2026-09-24, Workday My Experience: Field of Study, "Type to Add Skills"):
 * typing shows nothing, Enter searches, a single result is picked by the widget itself, several
 * results appear in the portaled list. write/searchPrompt.ts is the writer.
 */
export interface SearchPromptComboboxRule extends PortaledPromptRule {
  /** How many values the widget should receive (1 = one answer; Skills: up to 15). */
  readonly maxValues: number;
}

/**
 * 一种上传部件怎么说「收下了这一份」（2026-09-28 Workday 的简历栏，adobe.wd5 实测）。宿主在 change 里把文件拿走、
 * 清空文件框，随后在部件里列出这一份文件与它自己的「传好了」标记——我们读不回文件框，只能读它列出来的那一项。
 * 内核只在这一项是我们这一次挂上之后才多出来的、名字就是我们这一份文件、而且带着这个标记时才算宿主确认了
 * （write/setFile.ts 的 `watchDeclaredUpload`）；没有这个标记照旧是「网站没确认」。
 */
export interface FileUploadRule {
  /** 这种部件的文件框（扫描到的那个 `input[type=file]`）。 */
  readonly triggerSelector: string;
  /** 部件根：从文件框往上最近的那一个，里面只能有这一个文件框。 */
  readonly containerSelector: string;
  /** 部件里列出的一份已上传文件。 */
  readonly itemSelector: string;
  /** 那一项里写着文件名的元素（恰好一个）。 */
  readonly itemNameSelector: string;
  /** 那一项里宿主说「传好了」的标记。 */
  readonly successSelector: string;
}

/**
 * A portaled, **tiered** prompt whose values live one level below a category list.
 * write/hierarchicalPrompt.ts is the writer; see `HierarchicalPromptShape` in contracts.ts
 * for the measurement it encodes.
 */
export interface PromptComboboxRule extends PortaledPromptRule {
  /** Default 8: how many top-level categories the writer may walk. */
  readonly maxCategories: number;
}

/**
 * 账号墙的一步（2026-09-28，负责人：像 Jobright 那样替用户在 Workday／iCIMS 上注册与登录）。
 *
 * 每一步由 `marker` 认：它在容器里**恰好一个**时就是这一步。其余每一项都是容器里的选择器，也必须恰好一个：
 *  · `choice`：`useEmail`（「用邮箱登录」那一颗）；
 *  · `identify`：`email`、`submit`，可选 `terms`（先报邮箱的那一步，iCIMS）；
 *  · `signIn`：`email`、`password`、`submit`，可选 `toCreateAccount`；
 *  · `createAccount`：`email`、`password`、`submit`，可选 `verifyPassword`、`terms`、`toSignIn`。
 * 哪一种能出现哪几个键是闭集：多写一个就是作者对这一步想错了，整份拒收。可选项声明了、页面上此刻没有，
 * 按「这一家这一次没有」算；有两个就说不清是哪一个，这一步不认。
 */
export interface AccountStepRule {
  readonly kind: 'choice' | 'identify' | 'signIn' | 'createAccount';
  readonly marker: string;
  readonly email?: string;
  readonly password?: string;
  readonly verifyPassword?: string;
  readonly terms?: string;
  readonly submit?: string;
  readonly useEmail?: string;
  readonly toSignIn?: string;
  readonly toCreateAccount?: string;
}

/** 按了提交之后网站说的一种话：横幅里看得见的字命中 `text` 就是这一种。 */
export interface AccountOutcomeRule {
  readonly kind: 'accountExists' | 'wrongPassword' | 'verifyEmail' | 'blocked';
  readonly text: RuleRegex;
}

/**
 * 账号墙（可缺省的顶层键，2026-09-28）。纯加法：去掉它，这份规则对不认识它的内核照旧正确——账号墙那一页
 * 本来就被页面否决挡在填写之外（`CREDENTIAL_PAGE`），不认识它的内核继续说「先在网站上登录」。
 *
 *  · `container`：账号墙的容器，整页恰好一个才算。每一步、每一格、每一颗都只在它里面找。
 *  · `path`：只有账号页、没有申请表的路径（iCIMS 的 `/jobs/<id>/<slug>/login`）；账号墙就在申请路径上的厂商不写。
 *  · `banners`：网站说话的地方（错误、提示横幅），整页找——作者自己把它限在该限的地方。有 `outcomes` 就必须有它。
 *  · `outcomes`：横幅里的字说的是哪一种结局。每一种至多一条。
 *
 * 规则里只有「这一步长什么样」，没有任何授权：能不能替用户注册、登录，由运行时包的 `account-access` 位与用户在资料页
 * 同意过的那一版文案一起说了算，两样都在规则之外。
 */
export interface AccountStepsRule {
  readonly container: string;
  readonly path: RuleRegex | null;
  readonly steps: readonly AccountStepRule[];
  readonly banners: string | null;
  readonly outcomes: readonly AccountOutcomeRule[];
}

// 邮箱验证的规则形状（2026-10-04）放在 contracts.ts：适配器把解析好的那一份原样带给只在浮层那一路用的解析函数
// （`rules/emailVerification.ts`），浮层挂不出来的构建里那几个函数随之被删掉。
export type {
  EmailCodeOutcomeRule,
  EmailCodePromptRule,
  EmailVerificationMailRule,
  EmailVerificationRule,
} from '../contracts.ts';

interface VendorRulesetFields {
  readonly vendor: ApplyVendor;
  /** 对小写化 pathname 的预筛。 */
  readonly applyPath: RuleRegex;
  /**
   * 厂商**官方嵌入帧**承载同一张表的路径（可缺省，归一化为 null = 没有这条路）。
   *
   * 只在调用方声明 `embedded: true`（内容脚本运行在子帧）时参与 `isApplyPath`；顶层帧上照旧拒绝。
   * Greenhouse 的 `/embed/job_app` 岗位身份在 query 里，所以它不能进 `applyPath`——那条
   * pathname-only authority 是 mission 那条路的合约（intent 绑定 origin + pathname，两个岗位共用
   * 一条 pathname 就分不开）；而手势路的授权根是用户在那一帧里的点击，帧身份
   * （tabId + frameId + origin + pathname）足以钉住「这一张表」。P2-10（2026-09-21）。
   */
  readonly embeddedApplyPath: RuleRegex | null;
  /** 厂商声明的容器锚点；绝不能是稳定输入 id。 */
  readonly anchors: readonly string[];
  /**
   * 白标 B 的退路（可缺省，归一化为 null = 没有）。它是 README「锚点绝不能用稳定输入 id 兜底」
   * 那条纪律的唯一例外，且三道闸同时成立才走：调用方声明 `whitelabel`（指纹判定为该家、主机
   * 不在厂商表里）、容器里本家 id 钩子 ≥ minHooks、这样的容器恰好一个。见 `WhitelabelRootRule`。
   */
  readonly whitelabelRoot: WhitelabelRootRule | null;
  /** 通用路的退路（可缺省，归一化为 null = 没有）。见 `GenericRootRule`。 */
  readonly genericRoot: GenericRootRule | null;
  readonly excludeWithin: readonly string[];
  /** 标签命中即整个控件不进扫描结果（反滥用文案）。 */
  readonly denyLabels: readonly RuleRegex[];
  /** name 含任一子串即跳过（reCAPTCHA 垫片等）。 */
  readonly denyNameSubstrings: readonly string[];
  /** 值被厂商部件托管的文本框：写了也不算数，如实报 WIDGET。 */
  readonly widgetNames: readonly string[];
  /**
   * 简历标题往上找多深。缺省 = null（用内核默认的 4 层）。
   *
   * 有的厂商把标题挂得很高：BambooHR 的 `Resume*` 在祖先链第 5 层之外，
   * Workday 的 `Resume/CV` 是往上约 7 层的 `<h4>`。标题**存在**，只是够不着，
   * 于是内核证明不了身份、如实拒绝——2026-09-16 全量批测里 126 个必填简历框
   * 卡在这里。
   *
   * 抬的是"往上看多远"，不是"这个就是简历"：文案必须仍然说 Resume 才算数。
   * 这一点很要紧——BambooHR 有的版式里有两个 file 框，唯一区分就是各自上方的
   * 文字；一条身份声明会把两个都认成简历，抬深度不会。
   *
   * 内核会把值夹在 [4, 8] 之间：低于默认没有意义，高于 8 会够到整个表单的段落。
   */
  readonly fileContextMaxDepth: number | null;
  readonly keySteps: readonly RuleKeyStep[];
  /**
   * 重复行作用域（可缺省 = []）。声明后字段身份按"行标识 + 行内序号"计数，
   * 尾部加行不再冲掉全表序号——增删行（P3）的硬前置。选择器必须来自真实
   * 页面实测，宁缺毋错：没量过就留空，行为退回保守（插入即失配）。
   */
  readonly rowScopes: readonly RowScopeRule[];
  /**
   * Missing data normalizes to `[]`: no semantic authority, therefore zero
   * combobox click/event/milestone. Live vendor rules remain empty until an
   * exact controlled selector set is separately approved.
   */
  readonly comboboxSemanticControls: readonly ComboboxSemanticControlRule[];
  readonly listboxComboboxes: readonly ListboxComboboxRule[];
  /** Missing data normalizes to `[]`: no typeahead is ever driven without a measured binding. */
  readonly typeaheadComboboxes: readonly TypeaheadComboboxRule[];
  /**
   * Missing data normalizes to `[]`: no portaled prompt is ever walked, and the
   * click boundary's popup carve-out therefore has nothing to act on.
   */
  readonly promptComboboxes: readonly PromptComboboxRule[];
  /** Missing data normalizes to `[]`: nothing is ever searched for or submitted with Enter. */
  readonly searchPromptComboboxes: readonly SearchPromptComboboxRule[];
  /**
   * 上传部件怎么说「收下了」（2026-09-28，可缺省 = []）。缺省时文件写入与从前逐字相同：读不回文件框、只看到文件名的，
   * 照旧记「网站没确认」。见 `FileUploadRule`。
   */
  readonly fileUploads: readonly FileUploadRule[];
  /**
   * Missing data normalizes to `[]`: no question scope resolves, labels and choice groups
   * come out exactly as before. See `QuestionScopeRule`.
   */
  readonly questionScopes: readonly QuestionScopeRule[];
  /**
   * Exact final-action authority. `null` is an explicit fail-closed decision:
   * the vendor may still be scanned/filled, but CAP-AF-041 cannot arm.  The
   * selector is interpreted only inside the already verified application root
   * and is never exposed to Extension code.
   */
  readonly finalSubmitControl: null | Readonly<{
    readonly selector: string;
    readonly activation: 'native-submit';
  }>;
  /**
   * 「申请表还没打开」的那个控件（2026-09-22 加）。
   *
   * 有几家的岗位页上根本没有表单：BambooHR 的 `/careers/<id>` 只有一个
   * `Apply for This Job`，点完 `form#job-application-form` 才出现、URL 不变。
   * 不点的时候锚点当然找不到，而浮层对用户说的是「规则的表单锚点在这一页上
   * 没找到……仍然如此就是这一家的规则要更新了」——那句话是错的：规则没问题，
   * 是表单还没打开。2026-09-22 的真实批测里 BambooHR 八页全卡在这句话上。
   *
   * 这里**只用来判「是不是这种情况」**，内核不点它：提交由用户本人点，打开申请表
   * 同样由他点（2026-09-22 Mike 拍板）。声明它的唯一后果是把那句错话换成
   * 「先点页面上的申请按钮」。
   *
   * 与 `finalSubmitControl` 相反，它在**锚点没命中时**才用，所以只能在整页上找；
   * 也正因如此它必须是一个稳定钩子，而不是文案匹配。
   */
  readonly applyGate: null | Readonly<{ readonly selector: string }>;
  /**
   * 申请表之前那一道「数据同意」页（2026-10-04，可缺省）：Jobvite 的申请页第一步是 `form[name=consentForm]`——先选居住地，
   * 网站再给出隐私条款与「同意」，同意之后才出申请表。从前锚点没命中，浮层说「这一页暂时认不出申请表，请刷新」，而刷新没用。
   *
   * `form`（必填）：那一道同意页的容器。锚点没命中、它却在页面上时，内核答「这是同意页」（`CONSENT_GATE`），浮层照实说要他
   * 先做什么。其余三项可缺省，留给「替他同意」那一步（负责人 2026-10-04 的 D7）：`residence` 选居住地的下拉、`text` 条款正文、
   * `accept` 同意的那一颗。只有 `form` 时内核只认、不动手。
   */
  readonly consentGate: null | Readonly<{
    readonly form: string;
    readonly residence: string | null;
    readonly text: string | null;
    readonly accept: string | null;
  }>;
  /** 账号墙（2026-09-28，可缺省，归一化为 null = 这一家没有声明）。见 `AccountStepsRule`。 */
  readonly accountSteps: AccountStepsRule | null;
  /** 邮箱验证（2026-10-04，可缺省，归一化为 null = 这一家没有声明）。见 `EmailVerificationRule`。 */
  readonly emailVerification: EmailVerificationRule | null;
}

/** 稳定原因码（铁律 2）。UI 与诊断永不解析自由文本。 */
export const APPLY_RULES_ERROR_CODES = [
  'RULES_MALFORMED', // 结构不对：缺字段、类型不符、认不得的键或 step
  'RULES_SCHEMA_TOO_NEW', // 版本号比本解释器新——关闭该 release，等扩展更新
  'RULES_REGEX_INVALID', // 正则编译不过，或带了被禁的 flags
  'RULES_VENDOR_UNKNOWN', // vendor 不在 APPLY_VENDORS 目录里
  'RULES_FIELD_KEY_UNKNOWN', // 映射目标不是 11 键档案契约里的键
] as const;
export type ApplyRulesErrorCode = (typeof APPLY_RULES_ERROR_CODES)[number];

export type RulesParseResult =
  | { readonly ok: true; readonly value: VendorRuleset }
  | { readonly ok: false; readonly code: ApplyRulesErrorCode };

/**
 * 规则里指向了本内核不认识的档案键时怎么办。
 *
 * 规则由后端热更新下发，而键表随插件版本走：后端一次纯加法（新键 + 它的
 * 标签模式）会同时到达**所有**装着旧版内核的插件。2026-09-16 已经吃过一次
 * 同类的亏（argoland #469 给 `allowedFieldKeys` 加三个键，旧插件整包 policy
 * 拒收、自动填写全线 fail closed）。
 *
 * · `'skip'`（运行时默认）——认不得的键**只让那一条模式失效**：陌生键永远
 *   匹配不上我们产得出的键，跳过它既不放权也不越权；等内核哪天认得了，同一份
 *   规则自然就生效。整份的形状校验（多余字段、坏正则、坏 step 类型）一条不放松。
 * · `'reject'`——闭集之外一律 `RULES_FIELD_KEY_UNKNOWN`。这是**发布侧**的口径：
 *   本仓是规则的作者，随包规则里一个拼错的键在这里就该红，而不是到线上静默失效。
 */
export interface RulesParseOptions {
  readonly unknownFieldKeys?: 'skip' | 'reject';
  /** 被跳过的键逐个回报（只有键名，不带任何页面内容），给诊断与发布检查用。 */
  readonly onUnknownFieldKey?: (key: string) => void;
  /**
   * 这一版内核不认识的**顶层键**怎么办（2026-09-28）。
   *
   * 2026-09-24 那一次：后端给 Workday 的规则加了顶层键 `searchPromptComboboxes`，旧内核的
   * 顶层白名单不认识它 → 这一份 `RULES_MALFORMED` → 整份 release 拒收 → 所有厂商约 5 分钟内
   * 一起停（worker 最多 5 分钟复查一次规则包）。商店包的更新是异步的（审核 + 用户升级），
   * 后端与已装的包**永远**有一段版本不一致的窗口。
   *
   * · `'ignore'`（运行时默认）——认不得的顶层键**不解释、不保留**：它不进解析结果，
   *   解释器根本读不到它；这份规则按「没有这个键」照常生效。逐个回报给调用方
   *   （只用来记一个「有这回事」的稳定码）。只放行长得像 schema 键的名字（小驼峰标识符）；
   *   空串、带空格、原型链上的名字是坏数据，不是新版本，照旧 `RULES_MALFORMED`。
   * · `'reject'`——整份 `RULES_MALFORMED`。这是**发布侧**的口径（`buildApplyRulesRelease`、
   *   随包规则的严格测试）：本仓是规则的作者，一个拼错的顶层键在这里就该红。
   *
   * 只放宽顶层这一层。已知结构**里面**的陌生东西（条目里多一个键、认不得的 step 类型或
   * 枚举值）不在此列，照旧整份拒收，理由见文件头。
   *
   * **对规则作者的约束**（`packages/apply-rules/README.md`「前向兼容」）：新顶层键必须是纯加法——去掉它，这份规则对
   * 不认识它的旧内核仍然正确。和别处联动的改法（例如把一个字段移出 `widgetNames`、改由新键
   * 驱动）对旧内核就不是纯加法：旧内核看得见「移出」、看不见「接管」，要么保留旧的那一半，
   * 要么 bump `schemaVersion`，让旧内核只停这一家。
   */
  readonly unknownTopLevelKeys?: 'ignore' | 'reject';
  /** 被忽略的顶层键逐个回报（只有键名）。键名不进诊断：调用方只记稳定码。 */
  readonly onUnknownTopLevelKey?: (key: string) => void;
}

interface ParseContext {
  readonly unknownFieldKeys: 'skip' | 'reject';
  readonly onUnknownFieldKey: ((key: string) => void) | undefined;
  readonly unknownTopLevelKeys: 'ignore' | 'reject';
  readonly onUnknownTopLevelKey: ((key: string) => void) | undefined;
}

/**
 * 能被当成「将来的顶层键」忽略的名字：小驼峰标识符，与现有每一个顶层键同一个写法。
 * `constructor` / `prototype` 形状合格，但它们是原型链上的名字，不会是 schema 键。
 */
const FUTURE_TOP_LEVEL_KEY = /^[a-z][A-Za-z0-9]{0,63}$/;
const NEVER_A_SCHEMA_KEY = new Set(['constructor', 'prototype']);

/** 这一版认得的顶层键。新增字段必须同时登记在这里（发布侧严格口径据此拒收拼错的键）。 */
const RULESET_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'vendor',
  'applyPath',
  'embeddedApplyPath',
  'anchors',
  'whitelabelRoot',
  'genericRoot',
  'excludeWithin',
  'denyLabels',
  'denyNameSubstrings',
  'widgetNames',
  // 2026-09-16 加。
  'fileContextMaxDepth',
  'keySteps',
  'rowScopes',
  'comboboxSemanticControls',
  'listboxComboboxes',
  'questionScopes',
  'typeaheadComboboxes',
  'promptComboboxes',
  // 2026-09-24 加（搜索式多选）。认得它之前的内核会整份拒收（所有厂商一起停）——那正是
  // 2026-09-28 起顶层陌生键改为「运行时不解释」的起因（见 `RulesParseOptions.unknownTopLevelKeys`）。
  'searchPromptComboboxes',
  'finalSubmitControl',
  'applyGate',
  // 2026-10-04 加（申请表之前的数据同意页，Jobvite）。纯加法：2026-09-28 之后的内核（含商店 1.1.0）不认识它只是不解释，
  // 照旧说「认不出申请表」；更早的包整份拒收——与 accountSteps 同一个发布口径。
  'consentGate',
  // 2026-09-28 加（账号墙：替用户注册、登录）。纯加法：2026-09-28 之后的内核不认识它也只是不解释；
  // 更早的包（含商店 1.0.0）整份拒收，所以带它的规则要等新商店版本上线、内部包重打之后才发（见 README「前向兼容」）。
  'accountSteps',
  // 2026-09-28 加（上传部件怎么说「收下了」，Workday 的简历栏）。纯加法，与 accountSteps 同一个发布口径：不认识它的
  // 内核（2026-09-28 起）照旧把读不回的上传记成「网站没确认」；更早的包整份拒收。
  'fileUploads',
  // 2026-10-04 加（邮箱验证：网站把验证码发到他的邮箱，他在浮层里输或粘贴，插件写进那一格）。纯加法，与 accountSteps
  // 同一个发布口径：2026-09-28 起的内核不认识它只是不解释（浮层照旧说「去网站上输入验证码」）。
  'emailVerification',
] as const;

/**
 * 顶层键：认得的照常往下校验；认不得的，运行时不解释、不保留（逐个回报），发布侧拒收。
 * 解析结果只从认得的键逐项构造，所以「不保留」不需要另外剥——陌生键根本没有路能走进去。
 */
function assertTopLevelKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  ctx: ParseContext,
): void {
  for (const key of Object.keys(record)) {
    if (isAnnotation(key) || allowed.includes(key)) continue;
    if (
      ctx.unknownTopLevelKeys === 'reject' ||
      !FUTURE_TOP_LEVEL_KEY.test(key) ||
      NEVER_A_SCHEMA_KEY.has(key)
    ) {
      fail('RULES_MALFORMED');
    }
    ctx.onUnknownTopLevelKey?.(key);
  }
}

export type VendorRuleset = VendorRulesetFields & (
  | Readonly<{ schemaVersion: 2; wizard?: never }>
  | Readonly<{ schemaVersion: 3; wizard: WizardReadOnlyDeclaration | null }>
);

/** 校验用的内部失败信号；对外永远折叠成稳定码。 */
class RuleError extends Error {
  readonly code: ApplyRulesErrorCode;

  constructor(code: ApplyRulesErrorCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: ApplyRulesErrorCode): never {
  throw new RuleError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `$comment` 打头的键是数据里的随行注释（JSON 没有注释语法），校验时忽略。 */
function isAnnotation(key: string): boolean {
  return key.startsWith('$comment');
}

/** 白名单之外出现任何真实键即整份拒收——宽容解析会掩盖手误与新旧不齐。 */
function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!isAnnotation(key) && !allowed.includes(key)) fail('RULES_MALFORMED');
  }
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  for (const item of value) {
    if (typeof item !== 'string') fail('RULES_MALFORMED');
  }
  return value as readonly string[];
}

/** 简历标题的搜索深度。缺省 = null，内核用它自己的默认值。 */
function parseFileContextMaxDepth(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('RULES_MALFORMED');
  // 范围由内核夹取，这里只拒绝明显不是深度的值：负数与 0 是写错了，不是意图。
  if (value <= 0) fail('RULES_MALFORMED');
  return value;
}

function parseFinalSubmitControl(
  value: unknown,
): VendorRuleset['finalSubmitControl'] {
  if (value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['selector', 'activation']);
  if (
    typeof value['selector'] !== 'string' ||
    value['selector'] === '' ||
    value['activation'] !== 'native-submit'
  ) fail('RULES_MALFORMED');
  return {
    selector: value['selector'],
    activation: 'native-submit',
  };
}

/** 可选：缺席与 `null` 同义。`form` 必填，其余三项可缺省（缺席与 `null` 同义）；写了就得是非空字符串。 */
function parseConsentGate(value: unknown): VendorRuleset['consentGate'] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['form', 'residence', 'text', 'accept']);
  if (typeof value['form'] !== 'string' || value['form'] === '') fail('RULES_MALFORMED');
  const optional = (key: 'residence' | 'text' | 'accept'): string | null => {
    const entry = value[key];
    if (entry === undefined || entry === null) return null;
    if (typeof entry !== 'string' || entry === '') fail('RULES_MALFORMED');
    return entry;
  };
  return { form: value['form'], residence: optional('residence'), text: optional('text'), accept: optional('accept') };
}

/** 可选：缺席与 `null` 同义（老规则一个字都不用改）。 */
function parseApplyGate(value: unknown): VendorRuleset['applyGate'] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['selector']);
  if (typeof value['selector'] !== 'string' || value['selector'] === '') fail('RULES_MALFORMED');
  return { selector: value['selector'] };
}

/**
 * 账号墙每一种步骤的键：必填的、可选的。闭集——`choice` 写了 `password`、`signIn` 写了 `verifyPassword`，
 * 都是作者对这一步想错了，整份拒收（与 `listboxComboboxes` 的条目同一个口径：已知结构里的陌生键不跳过）。
 */
const ACCOUNT_STEP_KEYS: Readonly<Record<AccountStepRule['kind'], Readonly<{
  required: readonly (keyof AccountStepRule)[];
  optional: readonly (keyof AccountStepRule)[];
}>>> = {
  choice: { required: ['useEmail'], optional: [] },
  identify: { required: ['email', 'submit'], optional: ['terms'] },
  signIn: { required: ['email', 'password', 'submit'], optional: ['toCreateAccount'] },
  createAccount: { required: ['email', 'password', 'submit'], optional: ['verifyPassword', 'terms', 'toSignIn'] },
};
const ACCOUNT_OUTCOME_KINDS: readonly AccountOutcomeRule['kind'][] = ['accountExists', 'wrongPassword', 'verifyEmail', 'blocked'];
/** 一家的账号墙能有几步：四种各至多一步。 */
const MAX_ACCOUNT_STEPS = 4;

function parseAccountStep(entry: unknown): AccountStepRule {
  if (!isRecord(entry)) fail('RULES_MALFORMED');
  const kind = entry['kind'];
  // argoland 那份副本按 ES2021 编译（没有 Object.hasOwn），与内核别处同一个写法。
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(ACCOUNT_STEP_KEYS, kind)) fail('RULES_MALFORMED');
  const shape = ACCOUNT_STEP_KEYS[kind as AccountStepRule['kind']];
  assertOnlyKeys(entry, ['kind', 'marker', ...shape.required, ...shape.optional]);
  const step: Record<string, string> = { kind, marker: parseNonEmptyString(entry['marker']) };
  for (const key of shape.required) step[key] = parseNonEmptyString(entry[key]);
  for (const key of shape.optional) {
    if (entry[key] !== undefined) step[key] = parseNonEmptyString(entry[key]);
  }
  return step as unknown as AccountStepRule;
}

/** 可选：缺席与 `null` 同义（没有账号墙的厂商一个字都不用写）。 */
function parseAccountSteps(value: unknown): AccountStepsRule | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['container', 'path', 'steps', 'banners', 'outcomes']);
  const steps = value['steps'];
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_ACCOUNT_STEPS) fail('RULES_MALFORMED');
  const parsedSteps = steps.map(parseAccountStep);
  // 同一种步骤写两条：哪一条算数就取决于数组顺序了。按畸形拒收，不猜。
  if (new Set(parsedSteps.map((step) => step.kind)).size !== parsedSteps.length) fail('RULES_MALFORMED');
  const outcomesValue = value['outcomes'];
  if (outcomesValue !== undefined && !Array.isArray(outcomesValue)) fail('RULES_MALFORMED');
  const outcomes = (outcomesValue ?? []).map((entry): AccountOutcomeRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, ['kind', 'text']);
    const kind = entry['kind'];
    if (!(ACCOUNT_OUTCOME_KINDS as readonly unknown[]).includes(kind)) fail('RULES_MALFORMED');
    return { kind: kind as AccountOutcomeRule['kind'], text: parseRegex(entry['text']) };
  });
  if (new Set(outcomes.map((outcome) => outcome.kind)).size !== outcomes.length) fail('RULES_MALFORMED');
  const banners = value['banners'] === undefined || value['banners'] === null ? null : parseNonEmptyString(value['banners']);
  // 认得出几种话，却没说网站在哪儿说话：那几条永远读不到，是死数据。
  if (outcomes.length > 0 && banners === null) fail('RULES_MALFORMED');
  return {
    container: parseNonEmptyString(value['container']),
    path: parseOptionalRegex(value['path']),
    steps: parsedSteps,
    banners,
    outcomes,
  };
}

const EMAIL_CODE_OUTCOME_KINDS: readonly EmailCodeOutcomeRule['kind'][] = ['wrong', 'expired', 'tooMany'];
/** 一家至多几种验证码提示、邮件至多写几个发件地址；验证码几位（含两端）。 */
const MAX_EMAIL_CODE_PROMPTS = 4;
const MAX_MAIL_SENDERS = 4;
const EMAIL_CODE_LENGTH = { min: 4, max: 12 } as const;
/** 给人看的那两行字的长度上限：一个发件地址、一个标题开头，不是一段话。 */
const MAX_MAIL_TEXT = 120;

function parseMailText(value: unknown): string {
  const text = parseNonEmptyString(value);
  if (text.length > MAX_MAIL_TEXT) fail('RULES_MALFORMED');
  return text;
}

function parseEmailCodePrompt(entry: unknown): EmailCodePromptRule {
  if (!isRecord(entry)) fail('RULES_MALFORMED');
  assertOnlyKeys(entry, ['container', 'inputs', 'length', 'charset', 'recipient', 'errors', 'outcomes', 'next']);
  const length = entry['length'];
  if (typeof length !== 'number' || !Number.isInteger(length) || length < EMAIL_CODE_LENGTH.min || length > EMAIL_CODE_LENGTH.max) {
    fail('RULES_MALFORMED');
  }
  const charset = entry['charset'];
  if (charset !== 'digits' && charset !== 'alphanumeric') fail('RULES_MALFORMED');
  const next = entry['next'];
  if (next !== 'resubmit' && next !== 'verify') fail('RULES_MALFORMED');
  const optional = (key: string): string | null =>
    entry[key] === undefined || entry[key] === null ? null : parseNonEmptyString(entry[key]);
  const outcomesValue = entry['outcomes'];
  if (outcomesValue !== undefined && !Array.isArray(outcomesValue)) fail('RULES_MALFORMED');
  const outcomes = (outcomesValue ?? []).map((item): EmailCodeOutcomeRule => {
    if (!isRecord(item)) fail('RULES_MALFORMED');
    assertOnlyKeys(item, ['kind', 'text']);
    const kind = item['kind'];
    if (!(EMAIL_CODE_OUTCOME_KINDS as readonly unknown[]).includes(kind)) fail('RULES_MALFORMED');
    return { kind: kind as EmailCodeOutcomeRule['kind'], text: parseRegex(item['text']) };
  });
  if (new Set(outcomes.map((outcome) => outcome.kind)).size !== outcomes.length) fail('RULES_MALFORMED');
  const errors = optional('errors');
  // 认得出几种话，却没说网站在哪儿说话：那几条永远读不到，是死数据。
  if (outcomes.length > 0 && errors === null) fail('RULES_MALFORMED');
  return {
    container: parseNonEmptyString(entry['container']),
    inputs: parseNonEmptyString(entry['inputs']),
    length,
    charset,
    recipient: optional('recipient'),
    errors,
    outcomes,
    next,
  };
}

/** 可选：缺席与 `null` 同义（没有邮箱验证的厂商一个字都不用写）。 */
function parseEmailVerification(value: unknown): EmailVerificationRule | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['mail', 'codePrompts']);
  const mail = value['mail'];
  if (!isRecord(mail)) fail('RULES_MALFORMED');
  assertOnlyKeys(mail, ['from', 'subject']);
  const from = mail['from'];
  if (!Array.isArray(from) || from.length === 0 || from.length > MAX_MAIL_SENDERS) fail('RULES_MALFORMED');
  const prompts = value['codePrompts'];
  if (!Array.isArray(prompts) || prompts.length > MAX_EMAIL_CODE_PROMPTS) fail('RULES_MALFORMED');
  return {
    mail: {
      from: from.map(parseMailText),
      subject: mail['subject'] === undefined || mail['subject'] === null ? null : parseMailText(mail['subject']),
    },
    codePrompts: prompts.map(parseEmailCodePrompt),
  };
}

/** 可选：缺席与 `null` 同义（现有十一份规则一个字都不用改）。 */
function parseGenericRoot(value: unknown): VendorRuleset['genericRoot'] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['container', 'minKeyedFields']);
  const container = value['container'];
  const min = value['minKeyedFields'];
  if (typeof container !== 'string' || container === '') fail('RULES_MALFORMED');
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) fail('RULES_MALFORMED');
  return { container, minKeyedFields: min };
}

const RULE_ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9:._-]*$/;

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('RULES_MALFORMED');
  return value;
}

function parseAttributeName(value: unknown): string {
  const name = parseNonEmptyString(value);
  if (!RULE_ATTRIBUTE_NAME.test(name)) fail('RULES_MALFORMED');
  return name;
}

function parseListboxComboboxes(value: unknown): readonly ListboxComboboxRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  return value.map((entry): ListboxComboboxRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, ['triggerSelector', 'valueContainerSelector', 'selectedValueSelector', 'multiValueContainerSelector', 'multiValueLabelSelector', 'activationSelector', 'optionSelector']);
    const multi = entry['multiValueContainerSelector'] !== undefined || entry['multiValueLabelSelector'] !== undefined;
    return {
      triggerSelector: parseNonEmptyString(entry['triggerSelector']),
      valueContainerSelector: parseNonEmptyString(entry['valueContainerSelector']),
      selectedValueSelector: parseNonEmptyString(entry['selectedValueSelector']),
      ...(multi
        ? {
            multiValueContainerSelector: parseNonEmptyString(entry['multiValueContainerSelector']),
            multiValueLabelSelector: parseNonEmptyString(entry['multiValueLabelSelector']),
          }
        : {}),
      ...(entry['activationSelector'] === undefined
        ? {}
        : { activationSelector: parseNonEmptyString(entry['activationSelector']) }),
      ...(entry['optionSelector'] === undefined
        ? {}
        : { optionSelector: parseNonEmptyString(entry['optionSelector']) }),
    };
  });
}

/** A walk is bounded so one field can never spend the whole click budget. */
const MAX_PROMPT_CATEGORIES = 24;

/**
 * Both portaled prompts are declared with the same five selectors plus one integer bound
 * (`maxCategories`, default 8, for the tiered walk; `maxValues`, required, for the search prompt).
 * One parser, so what the two accept cannot drift apart. Keys are closed per entry.
 */
function parsePortaledPrompts<K extends 'maxCategories' | 'maxValues'>(
  value: unknown,
  bound: K,
  max: number,
  fallback?: number,
): readonly (PortaledPromptRule & Readonly<Record<K, number>>)[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  return value.map((entry) => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, [
      'triggerSelector',
      'containerSelector',
      'selectedValueSelector',
      'popupRootSelector',
      'optionSelector',
      bound,
    ]);
    const limit = entry[bound] === undefined ? fallback : entry[bound];
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) fail('RULES_MALFORMED');
    const rule: PortaledPromptRule = {
      triggerSelector: parseNonEmptyString(entry['triggerSelector']),
      containerSelector: parseNonEmptyString(entry['containerSelector']),
      selectedValueSelector: parseNonEmptyString(entry['selectedValueSelector']),
      popupRootSelector: parseNonEmptyString(entry['popupRootSelector']),
      optionSelector: parseNonEmptyString(entry['optionSelector']),
    };
    // A computed key widens to an index signature; the bound is exactly `K` by construction.
    return { ...rule, [bound]: limit } as PortaledPromptRule & Readonly<Record<K, number>>;
  });
}

const FILE_UPLOAD_KEYS = ['triggerSelector', 'containerSelector', 'itemSelector', 'itemNameSelector', 'successSelector'] as const;

/** 上传部件（`FileUploadRule`）：缺省或 null 是没有声明；每一项的键封闭、五个选择器都不能空（五个键都是必填的字符串）。 */
function parseFileUploads(value: unknown): readonly FileUploadRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  return value.map((entry): FileUploadRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, FILE_UPLOAD_KEYS);
    return Object.fromEntries(FILE_UPLOAD_KEYS.map((key) => [key, parseNonEmptyString(entry[key])])) as unknown as FileUploadRule;
  });
}

const MAX_TYPEAHEAD_MIN_TYPED_CHARS = 16;

function parseTypeaheadComboboxes(value: unknown): readonly TypeaheadComboboxRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  return value.map((entry): TypeaheadComboboxRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, [
      'triggerSelector',
      'containerSelector',
      'suggestionSelector',
      'selectedValueSelector',
      'minTypedChars',
      'selectionWitnessSelector',
    ]);
    const minTypedChars = entry['minTypedChars'] === undefined ? 1 : entry['minTypedChars'];
    if (
      typeof minTypedChars !== 'number' ||
      !Number.isInteger(minTypedChars) ||
      minTypedChars < 1 ||
      minTypedChars > MAX_TYPEAHEAD_MIN_TYPED_CHARS
    ) fail('RULES_MALFORMED');
    return {
      triggerSelector: parseNonEmptyString(entry['triggerSelector']),
      containerSelector: parseNonEmptyString(entry['containerSelector']),
      suggestionSelector: parseNonEmptyString(entry['suggestionSelector']),
      selectedValueSelector: parseNonEmptyString(entry['selectedValueSelector']),
      minTypedChars,
      ...(entry['selectionWitnessSelector'] === undefined
        ? {}
        : { selectionWitnessSelector: parseNonEmptyString(entry['selectionWitnessSelector']) }),
    };
  });
}

function parseComboboxSemanticControls(
  value: unknown,
): readonly ComboboxSemanticControlRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');

  const controls = value.map((entry): ComboboxSemanticControlRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, [
      'triggerSelector',
      'openState',
      'optionRootSelector',
      'optionMemberSelector',
      'optionIdentityAttribute',
      'selectedState',
      'transaction',
    ]);

    const openState = entry['openState'];
    if (!isRecord(openState)) fail('RULES_MALFORMED');
    assertOnlyKeys(openState, ['attribute', 'openValue', 'closedValue']);
    const openAttribute = parseAttributeName(openState['attribute']);
    const openValue = parseNonEmptyString(openState['openValue']);
    const closedValue = parseNonEmptyString(openState['closedValue']);
    if (openValue === closedValue) fail('RULES_MALFORMED');

    const selectedState = entry['selectedState'];
    if (!isRecord(selectedState)) fail('RULES_MALFORMED');
    assertOnlyKeys(selectedState, ['attribute', 'selectedValue', 'unselectedValue']);
    const selectedAttribute = parseAttributeName(selectedState['attribute']);
    const selectedValue = parseNonEmptyString(selectedState['selectedValue']);
    const unselectedValue = parseNonEmptyString(selectedState['unselectedValue']);
    if (selectedValue === unselectedValue) fail('RULES_MALFORMED');

    const transaction = entry['transaction'];
    if (!isRecord(transaction)) fail('RULES_MALFORMED');
    assertOnlyKeys(transaction, ['snapshot', 'restoreActivation']);
    if (
      transaction['snapshot'] !== 'exact-selected-option' ||
      transaction['restoreActivation'] !== 'native-click'
    ) fail('RULES_MALFORMED');

    const optionIdentityAttribute = parseAttributeName(entry['optionIdentityAttribute']);
    if (optionIdentityAttribute === selectedAttribute) fail('RULES_MALFORMED');

    return {
      triggerSelector: parseNonEmptyString(entry['triggerSelector']),
      openState: {
        attribute: openAttribute,
        openValue,
        closedValue,
      },
      optionRootSelector: parseNonEmptyString(entry['optionRootSelector']),
      optionMemberSelector: parseNonEmptyString(entry['optionMemberSelector']),
      optionIdentityAttribute,
      selectedState: {
        attribute: selectedAttribute,
        selectedValue,
        unselectedValue,
      },
      transaction: {
        snapshot: 'exact-selected-option',
        restoreActivation: 'native-click',
      },
    };
  });

  // Identical trigger selectors would create two authorities for the same
  // exact node. Reject the data instead of relying on array order.
  if (new Set(controls.map((entry) => entry.triggerSelector)).size !== controls.length) {
    fail('RULES_MALFORMED');
  }
  return controls;
}

/**
 * `questionScopes` 的解析。缺省归一化为 `[]`（不发言）。每条只许 `container` 与
 * `label` 两个非空选择器；同一个 `container` 写两条会让「哪条题干算数」取决于数组顺序，
 * 按畸形拒收。选择器本身在这里不试编译——校验器不依赖 DOM；解释器在使用点
 * 捕获非法选择器并按「未命中」处理（fail closed）。
 */
function parseQuestionScopes(value: unknown): readonly QuestionScopeRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  const scopes = value.map((entry): QuestionScopeRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, ['container', 'label']);
    return {
      container: parseNonEmptyString(entry['container']),
      label: parseNonEmptyString(entry['label']),
    };
  });
  if (new Set(scopes.map((scope) => scope.container)).size !== scopes.length) {
    fail('RULES_MALFORMED');
  }
  return scopes;
}

function parseWhitelabelRoot(value: unknown): WhitelabelRootRule | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['container', 'minHooks']);
  const container = parseNonEmptyString(value['container']);
  const minHooks = value['minHooks'];
  // 少于 2 个钩子就是「看起来像申请表」，不是本家的数据契约；上限防止写成永远命不中的数。
  if (typeof minHooks !== 'number' || !Number.isInteger(minHooks) || minHooks < 2 || minHooks > 8) {
    fail('RULES_MALFORMED');
  }
  return { container, minHooks };
}

/** 可缺省的正则键：没写或写 null 都是「没有这条路」；写了就按 parseRegex 全量校验。 */
function parseOptionalRegex(value: unknown): RuleRegex | null {
  if (value === undefined || value === null) return null;
  return parseRegex(value);
}

function parseRegex(value: unknown): RuleRegex {
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['source', 'flags']);
  const { source, flags } = value;
  if (typeof source !== 'string' || source === '') fail('RULES_MALFORMED');
  if (flags !== undefined && flags !== 'i') fail('RULES_REGEX_INVALID');
  try {
    new RegExp(source, flags);
  } catch {
    // RegExp 的报错文本随引擎变化，不进任何契约；这里只折叠成稳定码。
    fail('RULES_REGEX_INVALID');
  }
  return flags === undefined ? { source } : { source, flags };
}

/**
 * 规则可以指向的键：11 个扁平档案键，**加上**行内角色（`education.school` 等）。
 *
 * 行内角色必须能出现在规则里，否则 Workable 的 `title` / `company` 这些
 * 只有行内才有意义的字段永远映不出去——增删行编排排得再对，也没有东西可填。
 *
 * 闭集之外的键：发布侧（`unknownFieldKeys: 'reject'`）一律 `RULES_FIELD_KEY_UNKNOWN`
 * ——一个拼错的键静默失效，表现是「这一栏就是填不上」，而没有任何地方会说为什么；
 * 运行时（默认 `'skip'`）只让那一条失效，见 `RulesParseOptions`。
 */
/**
 * 规则可以指向的键：扁平档案键 ∪ 行内角色 ∪ 推断答案键（`DERIVED_ANSWER_KEYS`，2026-09-24：题面由规则认、
 * 答案由内核从档案记录推出来，例如「Are you a transitioning service member?」）。
 */
export type RuleFieldKey = ApplyFieldKey | CollectionFieldRole | DerivedAnswerKey;

/**
 * 这个模式是拿去比对**小写化后的值**的吗？是的话，里面不许有未转义的大写字母。
 *
 * ⚠️ 起因是一条实测抓到的静默失效：`icims.json` 的
 * `^(?!(Person|Portal)ProfileFields\.).+$` 想表达「带命名空间的字段不许靠猜标签」，
 * 但解释器查表前会把 `name` 小写化，负向前瞻于是**永远不成立**、`.+$` 恒真——
 * **那道闸从来没关上过**。它不报错、不变红，只是无声地不生效。
 *
 * 所以判据挪到「写不出来」的地方：出现未转义的大写 ASCII 字母且没有 `i` 标志
 * ⇒ 整份拒收。`\D` `\W` `\S` `\B` 不算——那里的大写是语法，不是要匹配的字面量。
 */
function assertLowercaseComparable(spec: { source: string; flags?: string }): void {
  if (spec.flags?.includes('i')) return;
  // 逐字符扫，跳过被反斜杠转义的下一个字符。
  for (let index = 0; index < spec.source.length; index += 1) {
    const character = spec.source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character >= 'A' && character <= 'Z') fail('RULES_MALFORMED');
  }
}

/** null = 这条指向了本内核不认识的键，按 `ParseContext` 的口径跳过（只在 'skip' 下出现）。 */
function parseFieldKey(value: unknown, ctx: ParseContext): RuleFieldKey | null {
  if (typeof value !== 'string') fail('RULES_MALFORMED');
  if ((APPLY_FIELD_KEYS as readonly string[]).includes(value)) return value as ApplyFieldKey;
  if (isCollectionFieldRole(value)) return value;
  if (isDerivedAnswerKey(value)) return value;
  // 保留字用在它唯一被允许的位置（exact attrMap）之外，是错用而不是「未来的键」。
  if (value === RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET) fail('RULES_MALFORMED');
  if (ctx.unknownFieldKeys === 'reject') fail('RULES_FIELD_KEY_UNKNOWN');
  // 键名不是页面内容，也不是用户资料；回报它只为了让发布检查与诊断说得出「哪一条没生效」。
  if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(value)) fail('RULES_MALFORMED');
  ctx.onUnknownFieldKey?.(value);
  return null;
}

function parseAttrMapKey(value: unknown, ctx: ParseContext): RuleAttrMapKey | null {
  return value === RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET
    ? RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET
    : parseFieldKey(value, ctx);
}

function parseConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) fail('RULES_MALFORMED');
  if (value <= 0 || value > 1) fail('RULES_MALFORMED');
  return value;
}

function parseAttrMapStep(
  record: Record<string, unknown>,
  type: 'attrMap' | 'ancestorAttrMap',
  ctx: ParseContext,
): RuleKeyStep {
  assertOnlyKeys(record, ['type', 'attr', 'confidence', 'map']);
  const attr = record['attr'];
  if (!(RULE_ATTR_MAP_ATTRS as readonly unknown[]).includes(attr)) fail('RULES_MALFORMED');
  const rawMap = record['map'];
  if (!isRecord(rawMap)) fail('RULES_MALFORMED');
  const map: Record<string, RuleAttrMapKey> = {};
  for (const [attrValue, key] of Object.entries(rawMap)) {
    if (isAnnotation(attrValue)) continue;
    // 解释器查表前会把属性值小写化；大小写混排的键永远查不中，只能是手误。
    if (attrValue !== attrValue.toLowerCase()) fail('RULES_MALFORMED');
    const parsedKey = type === 'attrMap' ? parseAttrMapKey(key, ctx) : parseFieldKey(key, ctx);
    if (parsedKey === null) continue;
    if (parsedKey === RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET && attrValue === '') {
      fail('RULES_MALFORMED');
    }
    map[attrValue] = parsedKey;
  }
  const confidence = parseConfidence(record['confidence']);
  if (Object.values(map).includes(RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET)) {
    if (
      type !== 'attrMap' ||
      confidence !== 1 ||
      !(PLAIN_TEXT_CONTENTEDITABLE_TARGET_ATTRS as readonly unknown[]).includes(attr)
    ) fail('RULES_MALFORMED');
  }
  if (type === 'attrMap') {
    return { type, attr: attr as RuleMapAttr, confidence, map };
  }
  return {
    type,
    attr: attr as RuleMapAttr,
    confidence,
    map: map as Readonly<Record<string, RuleFieldKey>>,
  };
}

/**
 * `locales` 只收非空、小写、去重的 BCP-47 **主子标签**。
 *
 * 全部整份拒收而不是"跳过这一条"：规则可由后端热更新下发，跳过会让新旧版本
 * 对同一份规则产生两种填法。带地区子标签（`en-US`）也拒——解释器只比主子标签，
 * 收下它就是一条永远匹配不中的死规则。
 */
function parseLocales(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) fail('RULES_MALFORMED');
  const locales = value.map((entry) => {
    if (typeof entry !== 'string' || !/^[a-z]{2,3}$/.test(entry)) fail('RULES_MALFORMED');
    return entry;
  });
  if (new Set(locales).size !== locales.length) fail('RULES_MALFORMED');
  return locales;
}

function parseLabelPatternsStep(record: Record<string, unknown>, ctx: ParseContext): RuleKeyStep {
  assertOnlyKeys(record, ['type', 'confidence', 'patterns']);
  if (!Array.isArray(record['patterns'])) fail('RULES_MALFORMED');
  const patterns = record['patterns'].flatMap((entry): RuleLabelPattern[] => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    assertOnlyKeys(entry, ['regex', 'key', 'locales']);
    const locales = parseLocales(entry['locales']);
    const regex = parseRegex(entry['regex']);
    const key = parseFieldKey(entry['key'], ctx);
    if (key === null) return [];
    return [locales === undefined ? { regex, key } : { regex, key, locales }];
  });
  return { type: 'labelPatterns', confidence: parseConfidence(record['confidence']), patterns };
}

/**
 * 两种行模型的解析。`kind` **必填**——不给默认值是刻意的：
 * 一份规则包声明了重复段却没说清行怎么表达，只有两种可能，猜错哪一种都会
 * 把第 2 行的值写进第 1 行。让作者写一次比让引擎猜一次便宜得多。
 */
/**
 * 行动作选择器。三个键各自可缺——缺就是「这家不支持这个动作」。
 * 空串按畸形拒收：一个空选择器会匹配不到任何东西，而调用方看到的是
 * 「声明过 add」，于是会等一个永远不来的新行。
 */
function parseRowActions(value: unknown): RowActionSelectors | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  assertOnlyKeys(value, ['add', 'save', 'remove']);
  const actions: { add?: string; save?: string; remove?: string } = {};
  for (const key of ['add', 'save', 'remove'] as const) {
    const selector = value[key];
    if (selector === undefined) continue;
    if (typeof selector !== 'string' || selector === '') fail('RULES_MALFORMED');
    actions[key] = selector;
  }
  return actions;
}

/**
 * 带输入掩码的格。必须是 `fieldMap` **声明过的**格名的子集——声明一个不在映射里的格是
 * 死数据，而死数据读起来像是一道生效中的防线。
 *
 * 按声明过的格名比，而不是按认得角色的那些：运行时跳过的那一格（角色这一版不认识，见
 * `parseRowFieldMap`）照旧是掩码格，照旧不许往里写——掩码是限制，限制不跟着跳过一起丢。
 */
function parseMaskedCells(
  value: unknown,
  declaredCells: ReadonlySet<string> | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || declaredCells === undefined) fail('RULES_MALFORMED');
  return value.map((cell) => {
    if (typeof cell !== 'string' || cell === '') fail('RULES_MALFORMED');
    const name = cell.toLowerCase();
    if (!declaredCells.has(name)) fail('RULES_MALFORMED');
    return name;
  });
}

/**
 * 行内字段映射：`name` → 角色后缀。拼出来的整名要落在 `CollectionFieldRole` 闭集里。
 *
 * 落不进去时与 keySteps 里的档案键同一个口径（`RulesParseOptions.unknownFieldKeys`）：
 * 发布侧 `RULES_FIELD_KEY_UNKNOWN`——一个拼错的后缀静默失效，表现是「这一栏就是填不上」，
 * 而没有任何地方会说为什么；运行时（2026-09-28 起）只跳过那一格：这一版不认识的角色永远
 * 投影不出值，跳过它既不放权也不越权，那一格退回全局 keySteps，与没写这一格时一样。
 * 在此之前运行时也整份拒收——后端给一段加一个新角色，旧包所有厂商一起停。
 *
 * `name` 一律小写化后存：解释器查表前会把属性值小写化（与 attrMap 同一姿势），
 * 大小写混排的键永远查不中。
 */
function parseRowFieldMap(
  value: unknown,
  collection: 'education' | 'experience' | undefined,
  ctx: ParseContext,
): Readonly<{ map: Readonly<Record<string, string>>; declaredCells: ReadonlySet<string> }> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('RULES_MALFORMED');
  // 没有集合就没有前缀，拼不出角色名。
  if (collection === undefined) fail('RULES_MALFORMED');
  const map: Record<string, string> = {};
  const declaredCells = new Set<string>();
  for (const [name, suffix] of Object.entries(value)) {
    if (name === '' || typeof suffix !== 'string' || suffix === '') fail('RULES_MALFORMED');
    declaredCells.add(name.toLowerCase());
    const role = `${collection}.${suffix}`;
    if (!isCollectionFieldRole(role)) {
      if (ctx.unknownFieldKeys === 'reject') fail('RULES_FIELD_KEY_UNKNOWN');
      // 跳过的只能是长得像角色名的东西；别的是坏数据，不是新版本。
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(suffix)) fail('RULES_MALFORMED');
      ctx.onUnknownFieldKey?.(role);
      continue;
    }
    map[name.toLowerCase()] = suffix;
  }
  return { map, declaredCells };
}

/**
 * 行内单元名的取法。恰好一个捕获组——零个取不出单元名，多个说明作者对
 * 「哪一段是单元名」本身没想清楚（与 `idPattern` 同一判据、同一探针写法）。
 *
 * 没有 `fieldMap` 就没有查表的对象，此时给 `cellIdPattern` 是死数据，拒收。
 */
function parseCellIdPattern(
  value: unknown,
  fieldMap: Readonly<Record<string, string>> | undefined,
): RegExp | undefined {
  if (value === undefined) return undefined;
  if (fieldMap === undefined) fail('RULES_MALFORMED');
  const spec = parseRegex(value);
  const probe = new RegExp(`|${spec.source}`, spec.flags ?? '').exec('');
  if (probe === null || probe.length !== 2) fail('RULES_MALFORMED');
  return new RegExp(spec.source, spec.flags ?? '');
}

/**
 * 集合归属。只有 education / experience 两种——档案里只有这两个带「段」的集合。
 * 缺省合法：iCIMS 的电话/地址行要行身份但不参与增删行编排。
 */
function parseRowCollection(value: unknown): 'education' | 'experience' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'education' && value !== 'experience') fail('RULES_MALFORMED');
  return value;
}

function parseRowScopes(value: unknown, ctx: ParseContext): readonly RowScopeRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('RULES_MALFORMED');
  const scopes = value.map((entry): RowScopeRule => {
    if (!isRecord(entry)) fail('RULES_MALFORMED');
    const kind = entry['kind'];
    const container = entry['container'];
    if (typeof container !== 'string' || container === '') fail('RULES_MALFORMED');

    const collection = parseRowCollection(entry['collection']);
    const actions = parseRowActions(entry['actions']);
    const parsedFieldMap = parseRowFieldMap(entry['fieldMap'], collection, ctx);
    const fieldMap = parsedFieldMap?.map;
    const cellIdPattern = parseCellIdPattern(entry['cellIdPattern'], fieldMap);
    const maskedCells = parseMaskedCells(entry['maskedCells'], parsedFieldMap?.declaredCells);
    const rawWriteMode = entry['writeMode'];
    if (rawWriteMode !== undefined && rawWriteMode !== 'setValue' && rawWriteMode !== 'typed') {
      fail('RULES_MALFORMED');
    }
    const writeMode: 'setValue' | 'typed' | undefined = rawWriteMode;
    // 新加的一段出现在哪一头（2026-09-24，见 contracts.ts 的 `insertsAt`）：只认 top / bottom；top 只许配每一段要单独
    // 保存的区——没有保存钮就找不到插在最前面的那一行。
    const rawInsertsAt = entry['insertsAt'];
    if (rawInsertsAt !== undefined && rawInsertsAt !== 'top' && rawInsertsAt !== 'bottom') fail('RULES_MALFORMED');
    const insertsAt: 'top' | 'bottom' | undefined = rawInsertsAt;
    if (insertsAt === 'top' && actions?.save === undefined) fail('RULES_MALFORMED');
    // 只有声明了 collection 的行才可能参与增删行编排；给一个不参与编排的行
    // 配动作按钮，说明作者对这两件事的分野有误解，拒收比静默忽略好。
    if (actions !== undefined && collection === undefined) fail('RULES_MALFORMED');
    const common = {
      container,
      ...(collection === undefined ? {} : { collection }),
      ...(actions === undefined ? {} : { actions }),
      ...(fieldMap === undefined ? {} : { fieldMap }),
      ...(cellIdPattern === undefined ? {} : { cellIdPattern }),
      ...(writeMode === undefined ? {} : { writeMode }),
      ...(maskedCells === undefined ? {} : { maskedCells }),
      ...(insertsAt === undefined ? {} : { insertsAt }),
    };

    if (kind === 'contains') {
      assertOnlyKeys(entry, ['kind', 'container', 'row', 'collection', 'actions', 'fieldMap', 'cellIdPattern', 'writeMode', 'maskedCells', 'insertsAt']);
      const row = entry['row'];
      if (typeof row !== 'string' || row === '') fail('RULES_MALFORMED');
      return { ...common, kind: 'contains', row };
    }

    if (kind === 'idPrefix') {
      assertOnlyKeys(entry, ['kind', 'container', 'idPattern', 'collection', 'actions', 'fieldMap', 'cellIdPattern', 'writeMode', 'maskedCells', 'insertsAt']);
      const spec = parseRegex(entry['idPattern']);
      const idPattern = new RegExp(spec.source, spec.flags ?? '');
      // 恰好一个捕获组：零个取不出行标识，多个说明作者对「哪一段是行」本身没想清楚。
      // 空替换分支 `|<source>` 让整条必然匹配空串，返回的组数就是源模式的组数——
      // 比解析正则源码去数括号可靠得多（转义、字符类、非捕获组全不用管）。
      const probe = new RegExp(`|${spec.source}`, spec.flags ?? '').exec('');
      if (probe === null || probe.length !== 2) fail('RULES_MALFORMED');
      return { ...common, kind: 'idPrefix', idPattern };
    }

    fail('RULES_MALFORMED');
  });

  // 同一个 `collection` 只许一条。不拦的后果是**静默**的：下游两处各自「取第一条」——
  // `rowPlan.ts` 只按第一条排增删行，而 `scanRoot.ts` 的 `rowIndexOfScopeKey`
  // 只读 scopeKey 的 `parts[2]`（行序）、**把 `parts[0]`（规则序）整个丢掉**。
  // 于是两条规则的第 0 行会被投影成档案的**同一段**：用户的第 1 段经历被写进
  // 两个 DOM 区，或者两个区的内容被当成同一段读回来，而扫描期没有任何原因码
  // 或计数变化能让人看见。
  //
  // 一个集合真的被拆成几个 DOM 区时（罕见），需要的是一条**明确的合并规则**，
  // 而不是「碰巧取了第一条」。让规则作者写清楚，别让引擎猜。
  //
  // 没有 `collection` 的行作用域不受限：它只表达行身份，不参与档案投影，
  // 多条之间不存在「算档案哪一段」的歧义。
  const claimed = new Set<string>();
  for (const scope of scopes) {
    if (scope.collection === undefined) continue;
    if (claimed.has(scope.collection)) fail('RULES_MALFORMED');
    claimed.add(scope.collection);
  }
  return scopes;
}

function parseKeyStep(value: unknown, ctx: ParseContext): RuleKeyStep {
  if (!isRecord(value)) fail('RULES_MALFORMED');
  const type = value['type'];
  switch (type) {
    case 'attrMap':
      return parseAttrMapStep(value, type, ctx);
    case 'ancestorAttrMap':
      return parseAttrMapStep(value, type, ctx);
    case 'stopNamePrefix': {
      assertOnlyKeys(value, ['type', 'prefixes']);
      const prefixes = parseStringArray(value['prefixes']);
      // 比对的是小写化后的 name：带大写的前缀永不命中，且完全无声。
      for (const prefix of prefixes) assertLowercaseComparable({ source: prefix });
      return { type, prefixes };
    }
    case 'labelFallbackGate': {
      assertOnlyKeys(value, ['type', 'nameRegex', 'allowEmptyName']);
      const allowEmptyName = value['allowEmptyName'];
      if (typeof allowEmptyName !== 'boolean') fail('RULES_MALFORMED');
      const nameRegex = parseRegex(value['nameRegex']);
      // 同上：这道闸比对的是小写化后的 name。见 assertLowercaseComparable 头注
      // 记的那次静默失效（iCIMS 的负向前瞻恒真、闸从没关上过）。
      assertLowercaseComparable(nameRegex);
      return { type, nameRegex, allowEmptyName };
    }
    case 'labelPatterns':
      return parseLabelPatternsStep(value, ctx);
    default:
      // 认不得的 step 类型 = 这份数据要求一种本解释器没有的匹配语义。
      // 跳过它会让新旧版本对同一份规则产生两种填法，必须整份拒收。
      fail('RULES_MALFORMED');
  }
}

/**
 * 唯一入口。任何来源（随包内置 / 后端下发）的规则都必须先过这里。
 *
 * 默认是运行时口径（后端下发的规则）：陌生档案键跳过那一条、陌生顶层键不解释。
 * 本仓签进去的规则（发布、随包编译）传 `unknownTopLevelKeys: 'reject'`。
 */
export function parseVendorRuleset(input: unknown, options: RulesParseOptions = {}): RulesParseResult {
  const ctx: ParseContext = {
    unknownFieldKeys: options.unknownFieldKeys ?? 'skip',
    onUnknownFieldKey: options.onUnknownFieldKey,
    unknownTopLevelKeys: options.unknownTopLevelKeys ?? 'ignore',
    onUnknownTopLevelKey: options.onUnknownTopLevelKey,
  };
  try {
    if (!isRecord(input)) fail('RULES_MALFORMED');
    // 先看版本：比内核新的规则，它的键集本来就可能是这一版不认识的，报「太新」比报「畸形」准。
    const schemaVersion = input['schemaVersion'];
    if (typeof schemaVersion !== 'number') fail('RULES_MALFORMED');
    if (schemaVersion > APPLY_RULES_MAX_READER_SCHEMA_VERSION) fail('RULES_SCHEMA_TOO_NEW');
    if (schemaVersion !== APPLY_RULES_SCHEMA_VERSION && schemaVersion !== 3) fail('RULES_MALFORMED');
    // v2 规则里的 `wizard` 是 v3 才认的键：v2 读者本来就不解释它，按陌生顶层键处理。
    assertTopLevelKeys(
      input,
      schemaVersion === 3 ? [...RULESET_TOP_LEVEL_KEYS, 'wizard'] : RULESET_TOP_LEVEL_KEYS,
      ctx,
    );

    let wizard: WizardReadOnlyDeclaration | null = null;
    if (schemaVersion === 3 && input['wizard'] !== null) {
      const parsedWizard = parseWizardReadOnlyDeclaration(input['wizard']);
      if (!parsedWizard.ok) fail('RULES_MALFORMED');
      wizard = parsedWizard.value;
    }

    const vendor = input['vendor'];
    if (typeof vendor !== 'string') fail('RULES_MALFORMED');
    if (!(APPLY_VENDORS as readonly string[]).includes(vendor)) fail('RULES_VENDOR_UNKNOWN');

    const anchors = parseStringArray(input['anchors']);
    const genericRoot = parseGenericRoot(input['genericRoot']);
    // 锚点是「本家申请表长什么样」这件站点知识，没有它就找不到表——除非这份规则
    // 靠**数字段**找表（genericRoot）。通用规则集根本没有厂商，锚点对它是个空概念，
    // 而 `resolveRoot` 先试 anchors：随便填一个能命中的，就会绕过数字段那道闸，
    // 把整条通用路的唯一判据架空。所以空锚点只对声明了 genericRoot 的规则放行。
    if (anchors.length === 0 && genericRoot === null) fail('RULES_MALFORMED');

    if (!Array.isArray(input['denyLabels'])) fail('RULES_MALFORMED');
    if (!Array.isArray(input['keySteps'])) fail('RULES_MALFORMED');

    const keySteps = input['keySteps'].map((step) => parseKeyStep(step, ctx));
    const plainTextTargets = keySteps.reduce(
      (count, step) => count + (
        step.type === 'attrMap'
          ? Object.values(step.map).filter(
              (key) => key === RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET,
            ).length
          : 0
      ),
      0,
    );
    if (plainTextTargets > 1) fail('RULES_MALFORMED');

    const value: VendorRuleset = {
      ...(schemaVersion === 3 ? { schemaVersion: 3 as const, wizard } : { schemaVersion: 2 as const }),
      vendor: vendor as ApplyVendor,
      applyPath: parseRegex(input['applyPath']),
      embeddedApplyPath: parseOptionalRegex(input['embeddedApplyPath']),
      anchors,
      whitelabelRoot: parseWhitelabelRoot(input['whitelabelRoot']),
      genericRoot,
      excludeWithin: parseStringArray(input['excludeWithin']),
      denyLabels: input['denyLabels'].map(parseRegex),
      denyNameSubstrings: parseStringArray(input['denyNameSubstrings']),
      widgetNames: parseStringArray(input['widgetNames']),
      fileContextMaxDepth: parseFileContextMaxDepth(input['fileContextMaxDepth']),
      keySteps,
      rowScopes: parseRowScopes(input['rowScopes'], ctx),
      comboboxSemanticControls: parseComboboxSemanticControls(
        input['comboboxSemanticControls'],
      ),
      listboxComboboxes: parseListboxComboboxes(input['listboxComboboxes']),
      questionScopes: parseQuestionScopes(input['questionScopes']),
      typeaheadComboboxes: parseTypeaheadComboboxes(input['typeaheadComboboxes']),
      promptComboboxes: parsePortaledPrompts(input['promptComboboxes'], 'maxCategories', MAX_PROMPT_CATEGORIES, 8),
      searchPromptComboboxes: parsePortaledPrompts(input['searchPromptComboboxes'], 'maxValues', MAX_SEARCH_PROMPT_VALUES),
      fileUploads: parseFileUploads(input['fileUploads']),
      finalSubmitControl: parseFinalSubmitControl(input['finalSubmitControl']),
      applyGate: parseApplyGate(input['applyGate']),
      consentGate: parseConsentGate(input['consentGate']),
      accountSteps: parseAccountSteps(input['accountSteps']),
      emailVerification: parseEmailVerification(input['emailVerification']),
    };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof RuleError) return { ok: false, code: error.code };
    // 不该到达：校验器自身的 bug 也折叠成稳定码，绝不让异常带着输入内容外逸。
    return { ok: false, code: 'RULES_MALFORMED' };
  }
}
