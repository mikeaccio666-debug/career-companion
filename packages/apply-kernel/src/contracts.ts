/**
 * Autofill boundary types. This is the seam that keeps host-site DOM knowledge
 * inside `parsers/<vendor>/` (通用铁律 1): a vendor adapter reads the page and
 * exposes a vendor-neutral scan boundary; everything downstream — the matching
 * engine, the writer, the UI — works only against these types and contains no
 * vendor strings at all.
 *
 * See docs/AUTOFILL-DESIGN.md §2.1.
 */

/**
 * The catalog lives at L0 so vendor registries, policies, and contracts all
 * fail to compile when a new vendor is only registered in one of them.
 */
/**
 * `generic` 不是第十三家 ATS，是「一家都认不出」那条路的名字（argoland #584 的
 * GENERIC）。它的规则里一条站点知识都没有，找表靠 `genericRoot` 数字段。
 */
export const APPLY_VENDORS = ['greenhouse', 'lever', 'ashby', 'workable', 'workday', 'avature', 'smartrecruiters', 'icims', 'rippling', 'dover', 'bamboohr', 'jobvite', 'generic'] as const;
export type ApplyVendor = (typeof APPLY_VENDORS)[number];

/**
 * The canonical fields autofill knows how to supply. Deliberately small: v1
 * fills the boring, unambiguous parts of an application. Anything not in this
 * list is surfaced to the user as "fill manually", never guessed.
 */
export const APPLY_FIELD_KEYS = [
  'firstName',
  'lastName',
  'fullName',
  'preferredName',
  'email',
  'phone',
  'linkedinUrl',
  'githubUrl',
  'portfolioUrl',
  'city',
  'location',
  // 与 §5.8 wire 契约保持闭集相等（见 apply-profile-key-parity）。端点从
  // argoland #469 起就在发这三个，内核接住之前它们只是被丢掉。
  'addressLine1',
  'addressRegion',
  'currentCompany',
  'addressCountry',
  'addressPostalCode',
  'currentJobTitle',
  'eeoGender',
  'eeoRace',
  'eeoVeteran',
  'eeoDisability',
  'heardAboutSource',
  // 2026-09-21 填写键扩展（P1-5，argoland #535）：ats-lab 306 页里「档案标量」763 项、
  // 「薪资/日期」290 项、「搬迁/到岗」169 项差的就是这些。值一律字符串：布尔
  // 'true'/'false'，整数十进制串，日期 YYYY-MM-DD，集合逗号连接（'REMOTE,HYBRID'）。
  'preferredPronouns',
  'earliestStartDate',
  'noticePeriodDays',
  'profileSummary',
  'expectedSalaryAmount',
  'expectedSalaryCurrency',
  'expectedSalaryPeriod',
  'over18',
  'openToRelocation',
  'openToRelocationCities',
  'preferredWorkModes',
  'profileTwitterUrl',
  'otherWebsiteUrl',
] as const;
export type ApplyFieldKey = (typeof APPLY_FIELD_KEYS)[number];

/**
 * 计划条目可以指向的东西：11 个档案字段，**加上简历文件**。
 *
 * 为什么单独开一个联合而不是往 `APPLY_FIELD_KEYS` 里加一项：那 11 个键是**后端契约**
 * （`docs/后端契约-autofill档案-2026-08-01.md` 的 `fields` 逐字对应），简历不属于它——
 * 简历是一份文件、有自己的接口、有自己的能力位、也不该出现在档案编辑表单里。
 *
 * 但它**应该**走计划/runner：那条路已经有撤销日志、策略门、能力位和顺序控制，
 * 为文件另起一套编排等于把这些保证重写一遍。
 */
/**
 * 规则可以指到、却不是扁平档案键的**推断答案**键（2026-09-24）：题面由规则认（labelPatterns），答案由内核从档案里的
 * 记录推出来（dict/historyAnswers.ts），不来自扁平档案，也不上后端的档案契约——所以不进 `APPLY_FIELD_KEYS`
 * （那是与 wire 契约逐字相等的闭集）。旧版内核的规则解析器对它按「不认识的键」跳过那一条，不整份拒收。
 *
 *  · `transitioningServiceMember` ——「Are you a transitioning service member?」：工作经历里没有一段像军队服役就答
 *    No（负责人 2026-09-24：跟 Jobright 一样）。
 */
export const DERIVED_ANSWER_KEYS = ['transitioningServiceMember'] as const;
export type DerivedAnswerKey = (typeof DERIVED_ANSWER_KEYS)[number];

export function isDerivedAnswerKey(value: unknown): value is DerivedAnswerKey {
  return typeof value === 'string' && (DERIVED_ANSWER_KEYS as readonly string[]).includes(value);
}

export const APPLY_ENTRY_KEYS = [
  ...APPLY_FIELD_KEYS,
  'resumeFile',
  'coverLetter',
  // 2026-09-21 起「档案里填过、保存过就是同意了」：工作授权／担保与推荐人姓名不是扁平档案键
  // （答案来自档案里的记录集合，随岗位国家 / 公司而定），但它们与普通字段同一条
  // 计划 → runner → 回执的路——写入面由能力位（`set-work-authorization` / `set-referral`）放行。
  'workAuthorization',
  'workSponsorship',
  'referralName',
  // 「你现在人在 X 吗」的答案（是／否）。它由 addressCountry 推出，但**不能**借用那个键：
  // 同一节里 Country 下拉与这道题会按「每节每键至多一个」互相仲裁，输的那个被当成重复字段丢掉
  // （2026-09-21 Discord 页实测：Country 赢、这道题落成「没把握」）。
  'residence',
  // 「现在人在 X，或者愿意搬去 X 吗」的答案。与 residence 分开的理由一样：它由
  // city / addressRegion / openToRelocation* 一起推出，借用其中任何一个键都会与同节的
  // 那一栏互相仲裁掉。
  'relocation',
  // 代填条款、声明与签名（2026-09-23，dict/signOnBehalf.ts）：用户在资料页单独勾过同意、策略又
  // 放行了 `sign-on-behalf` 才会出现。签名栏的姓名不借用 fullName：规则把同一节里的姓名栏也认成
  // fullName 时，两者会按「每节每键至多一个」互相仲裁掉。
  'termsConsent',
  'truthAttestation',
  'signatureName',
  'signatureDate',
  // 跨性别、性取向、「是否 LGBTQ+」（2026-09-23，dict/selfIdentification.ts）：答案是用户在门户 EEO 那一节
  // 亲口的回答，不是扁平档案键；写入面由 `set-self-identification` 放行，且只在那句回答交来了时批准。
  // 不借用 eeoGender：条目键说的是这一格写的是哪件事，批准面与审计都按它认。
  'eeoTransgender',
  'eeoSexualOrientation',
  'eeoLgbtqCommunity',
  // 第三刀（2026-09-24）：同意类，同一套信任根。每一类一个键，浮层据此逐条写明「已替你同意：…」。
  'aiRecordingConsent',
  'smsConsent',
  'futureContactConsent',
  'marketingConsent',
  'backgroundCheckConsent',
  'arbitrationAgreement',
  // 第五刀（2026-09-28）：新放行的同意类别，只由 2026-09-28 那一版的同意覆盖。每一类一个键，浮层逐条写明。
  'recruitingDataSharingConsent',
  'informationVerificationConsent',
  'screeningConsent',
  'atWillAcknowledgement',
  'arbitrationWaiver',
  'aiInterviewAnalysisConsent',
  'callNotificationConsent',
  'groupFutureContactConsent',
  'privacyNoticeAcknowledgement',
  'combinedConsent',
  // 能不能联系雇主（2026-09-28）：按资料里的回答答，方向与对象各一个键（现在的雇主；以前的雇主与推荐人）。
  'employerContactAllowed',
  'employerContactDeclined',
  'referenceContactAllowed',
  'referenceContactDeclined',
  // 「你在这家公司工作过吗／现在在这里吗」（2026-09-24，负责人：跟 Jobright 一样；dict/historyAnswers.ts）：
  // 答案由工作经历与申请卡片的公司名推出，不是扁平档案键。写入面由调用方交来的经历集合与公司名放行
  // （kernelFiller 的 `approved`），写入原语仍是选项控件那几个能力位。argoland 的副本随后同步。
  'previouslyEmployedHere',
  // 按资料推出来的几类（2026-10-04，「AI 在资料里找不到依据」那一批）：题面由内核按整句认（不经规则），答案由资料推出，
  // 都不是扁平档案键。写入面由 kernelFiller 的 `approved` 按依据放行（办公方式要扁平键 preferredWorkModes，其余要
  // 调用方交来的集合），写入原语仍是各控件的能力位。
  //  · workArrangement ——「能每周到办公室 N 天吗」「愿意并且能全职在现场办公吗」「接受远程吗」（dict/workArrangement.ts）；
  //  · languageAnswer ——语言题：会不会、流利不流利、是不是母语或双语、勾选会说的语言、列出会说的语言（dict/languages.ts）；
  //  · experienceYears ——不带限定的工作年限（dict/experienceYears.ts）；
  //  · currentStudent ——「你现在在读吗」（dict/historyAnswers.ts）；
  //  · militaryService ——「你服过兵役吗」（dict/historyAnswers.ts）。
  'workArrangement',
  'languageAnswer',
  'experienceYears',
  'currentStudent',
  'militaryService',
  //  · travelAnswer ——「能出差吗」「要 25% 的时间出差，可以吗」，按资料里的出差上限答（dict/travel.ts，argoland #738）。
  'travelAnswer',
  // 规则认题、内核推答案的那几类（见 `DERIVED_ANSWER_KEYS`）。
  ...DERIVED_ANSWER_KEYS,
] as const;
/**
 * 用户在审阅面板里答过的宿主问题；后缀是调用方给这道题的稳定 id。
 * 这类条目不经档案键匹配（见 `buildAnswerPlan`），但与其它条目走同一条
 * 计划 → runner → 撤销日志的路。
 */
export type QuestionAnswerKey = `question:${string}`;
export type ApplyEntryKey = (typeof APPLY_ENTRY_KEYS)[number] | CollectionFieldRole | QuestionAnswerKey;

/**
 * 行内字段指向的是**档案里的第几段的哪一栏**，不是那 11 个扁平键。
 *
 * 为什么并进 `ApplyEntryKey` 而不另开一套计划：行内字段和普通字段在写入期
 * 完全一样——同样的撤销日志、策略门、能力位、回读判决。差别只在「值从哪来」，
 * 而那一步在计划期就结束了。另开一套等于把上面每一条保证重写一遍。
 *
 * 类型级引用 `collectionProjection`，运行期没有依赖——本文件仍然是最底层。
 */
import type { CollectionFieldRole } from './collectionProjection';
import type { SignOnBehalfKind } from './dict/signOnBehalf';
export type { CollectionFieldRole };

/**
 * 按学历／工作经历推出来的答案的依据（2026-09-24，dict/historyAnswers.ts）。稳定码：浮层按它写一句人话，
 * 码本身不给用户看。定义在这里而不是 dict 里：本文件是最底层，契约里的类型不反向依赖判据模块。
 */
export type HistoryAnswerBasis =
  /** 按学历／工作经历推断年满 18。 */
  | 'ADULT_FROM_HISTORY'
  /** 工作经历里有这家公司。 */
  | 'EMPLOYER_IN_HISTORY'
  /** 工作经历里没有这家公司。 */
  | 'EMPLOYER_NOT_IN_HISTORY'
  /** 问的是「现在」，而这家公司那段经历已经结束。 */
  | 'EMPLOYER_ENDED'
  /** 「你是正在退役转业的军人吗」「你服过兵役吗」：工作经历里没有一段像军队服役（2026-09-24；后一问 2026-10-04）。 */
  | 'NO_MILITARY_SERVICE_IN_HISTORY'
  /** 「你现在在读吗」：按教育经历（在读、结束或预计毕业时间）推断（2026-10-04，dict/historyAnswers.ts）。 */
  | 'STUDENT_FROM_EDUCATION'
  /** 「工作年限」：按带日期的工作经历算（重叠只算一次，2026-10-04，dict/experienceYears.ts）。 */
  | 'EXPERIENCE_YEARS_FROM_HISTORY'
  /** 「能每周到办公室 N 天吗」「接受远程吗」：按资料里可接受的办公方式（与住处、搬迁意愿）答（2026-10-04，dict/workArrangement.ts）。 */
  | 'WORK_MODES_IN_PROFILE'
  /** 语言题：按资料里的语言与水平答（2026-10-04，dict/languages.ts）。 */
  | 'LANGUAGES_IN_PROFILE'
  /** 出差题：按资料里「出差最多能接受多少」答（2026-10-04，argoland #738；dict/travel.ts）。 */
  | 'TRAVEL_IN_PROFILE';

/**
 * A control kind and its only valid DOM element type. The map is deliberately
 * the source of truth: adding a writable kind expands both descriptor unions,
 * so the exhaustive engine/runner switches fail to compile until it is handled.
 */
export interface ApplyElementByKind {
  text: HTMLInputElement;
  textarea: HTMLTextAreaElement;
  select: HTMLSelectElement;
  /**
   * A vendor widget's `<input role="combobox">`. Same element type as `text`
   * on purpose — the difference is not the DOM node but how a value gets in:
   * a combobox is never written to, it is opened, matched and clicked
   * (`click/combobox.ts`). Keeping it a separate kind is what makes the
   * runner's dispatch refuse to fall through to `setValue`.
   */
  combobox: HTMLInputElement;
  /**
   * 简历文件控件。与 `text` 同为 `<input>`，区别在于值的载体是 `files` 而不是
   * `value`——它有自己的写入原语（`write/setFile.ts`）、自己的能力位，
   * 以及一条无条件的规矩：**绝不覆盖用户已经挂上的文件**。
   */
  file: HTMLInputElement;
  /**
   * 一道选择题。`element` 是组内 DOM 顺序的第一个成员；整组成员与用户看到的选项文字在描述符的
   * `choice` 里。绝不走 `setValue`。
   *
   * 两种长法（`choice.control` 区分）：原生单选/复选（`element` 是第一个 `<input>`，由
   * `write/choiceGroup.ts` 按 fill-first 原生激活）；ARIA 代理（2026-09-23，`control: 'proxy'`：
   * `element` 是第一个代理选项——`button[aria-pressed]` 或 `[role=radio|checkbox][aria-checked]`，
   * 由 `write/proxyChoiceGroup.ts` 点击、按代理公布的状态验）。
   */
  choice: HTMLInputElement | HTMLElement;
  /** One reviewed, child-free plain-text contenteditable target. */
  richtext: HTMLElement;
}
export type ApplyControlKind = keyof ApplyElementByKind;
export type ApplyWritableElement = ApplyElementByKind[ApplyControlKind];

/**
 * Structural identity is the safety boundary between a reviewed preview and a
 * later Fill. Label wording remains separately available for diagnostics only.
 */
export interface FieldSignature {
  readonly core: string;
  readonly labelHint: string;
}

/**
 * Rule-declared readback for a WAI-ARIA listbox combobox: the widget shows the
 * chosen option inside `selectedValueSelector` under the trigger's closest
 * `valueContainerSelector`. Menu and options come from ARIA, not from rules.
 * When `selectedValueSelector` resolves to the trigger itself (Rippling, Ashby:
 * the search box doubles as the display), the readback is that input's value.
 *
 * With `typeahead` set the binding describes a plain-text typeahead instead:
 * the widget has no ARIA listbox, so the suggestion list is the rule-declared
 * `suggestionSelector` under the same container, and the typeahead writer
 * (write/typeaheadCombobox.ts) takes over. It still travels in the descriptor's
 * `listbox` slot so the reviewed plan carries one combobox binding shape.
 */
export interface ListboxComboboxBinding {
  readonly valueContainerSelector: string;
  readonly selectedValueSelector: string;
  /** Multi-value widgets: the value-container variant and where each chosen chip shows its label. */
  readonly multiValueContainerSelector?: string;
  readonly multiValueLabelSelector?: string;
  readonly typeahead?: TypeaheadComboboxShape;
  /**
   * With `hierarchicalPrompt` set the binding describes a **portaled, tiered
   * prompt** instead: a menu that renders outside the form root, whose rows
   * carry no ARIA option role, and whose values sit one level down under a
   * category. write/hierarchicalPrompt.ts takes over; it rides in the same
   * `listbox` slot so the reviewed plan still carries one combobox binding.
   */
  readonly hierarchicalPrompt?: HierarchicalPromptShape;
  /**
   * With `searchPrompt` set the binding describes a **search prompt**: typing shows nothing,
   * Enter searches, a single result is picked by the widget itself and several results appear
   * in a portaled list (Workday's Field of Study and Skills, measured 2026-09-24).
   * write/searchPrompt.ts takes over.
   */
  readonly searchPrompt?: SearchPromptShape;
  /**
   * The **visible** control that opens this widget, when the scanned input is
   * only the widget's value mirror.
   *
   * Workday (2026-09-15 live, nvidia.wd5): Country / State / Phone Device Type
   * render as `button[aria-haspopup="listbox"]` plus a sibling
   * `input[type="text"]` of 0×0 that carries the chosen option's opaque id.
   * The input is what the scanner sees, but nothing about it is clickable and
   * its own geometry reads exactly like a CSS-hidden trap; the button is the
   * control a human uses, declares the ARIA popup, and is 344×40.
   *
   * Declaring it moves three things onto the button and leaves everything else
   * alone: the honeypot geometry lane measures it (`buildApplyPlan`), the
   * pointer sequence clicks it, and it is the `popupOwner` whose
   * `aria-controls` must name the listbox an option sits in. Absent = today's
   * behaviour: the trigger is its own activation target.
   */
  readonly activationSelector?: string;
  /**
   * The option rows **inside the widget's own listbox**, when the vendor does
   * not put `role="option"` on them.
   *
   * SmartRecruiters one-click (2026-09-15 live): the trigger is a textbook
   * `input[role=combobox][aria-haspopup=listbox]` and `aria-controls` does name
   * a real `[role=listbox]`, but the eleven rows it fills with are
   * `<spl-select-option>` custom elements and **not one of them carries
   * `role="option"`** — so the generic `[role=option]` sweep sees an empty menu
   * and the field reports `CHOICE_NO_DATA` while the list is plainly on screen.
   *
   * It stays as narrow as the typeahead's suggestion selector, which is the
   * same idea for widgets with no listbox at all: the selector is only ever
   * applied **inside the listbox this trigger's own `aria-controls` named**, so
   * it can neither widen the search nor name a row in some other widget, and
   * the click boundary derives `ruleDeclaredOption` from that containment
   * rather than taking the caller's word. Absent = today's behaviour:
   * `[role=option]` only.
   */
  readonly optionSelector?: string;
}

/**
 * Rule-declared shape of a portaled, tiered prompt.
 *
 * Workday's "How Did You Hear About Us?" (nvidia.wd5, 2026-09-15) is the
 * reference case, and every part of it defeats the ARIA listbox writer:
 *   · the menu is portaled to `<body>` as `div[data-automation-id=
 *     "activeListContainer"][role="listbox"]` with **no `id`**, and the trigger
 *     never gains `aria-controls`/`aria-owns` — so option clicks can only be
 *     attributed by `popupRootSelector`, which must be document-unique;
 *   · the row that answers a pointer is a role-less
 *     `div[data-automation-id="promptOption"]` **inside** the `[role=option]`
 *     wrapper: events on the wrapper do nothing at all, so option shape has to
 *     come from rule data;
 *   · typing filters nothing (measured with a bare `input` event and with
 *     trusted keystrokes), and the values are not in the first menu: it lists 6
 *     categories, and clicking one replaces the list with that category's
 *     leaves ("Linkedin Jobs" lives under "Job Board").
 *
 * Clicking the trigger again returns the open menu to the top level, which is
 * how the writer walks from one category to the next — it never needs a second
 * kind of click target.
 */
export interface HierarchicalPromptShape {
  /**
   * The portaled popup root. Must resolve to **exactly one** element in the
   * document while the menu is open; a selector that matches two proves nothing
   * about which menu we opened, and the click boundary then denies every option
   * inside it (see `withinRuleDeclaredPopup` in click/policy.ts).
   */
  readonly popupRootSelector: string;
  /** The row that answers a pointer, resolved under the popup root. */
  readonly optionSelector: string;
  /** How many top-level categories the writer may walk before giving up. */
  readonly maxCategories: number;
}

/** A search prompt never receives more than this many values (Skills: one per profile skill, in order). */
export const MAX_SEARCH_PROMPT_VALUES = 15;

/** Rule-declared shape of a search prompt; see `ListboxComboboxBinding.searchPrompt`. */
export interface SearchPromptShape {
  /** The portaled result list; must resolve to exactly one element while it is open. */
  readonly popupRootSelector: string;
  /** The row that answers a pointer, resolved under the popup root. */
  readonly optionSelector: string;
  /** How many values the widget should receive: 1 = one answer, more = one per value (at most 15). */
  readonly maxValues: number;
}

/** Rule-declared shape of a non-ARIA typeahead (Lever's location field is the reference case). */
export interface TypeaheadComboboxShape {
  /** Suggestion elements, resolved under the trigger's closest `valueContainerSelector`. */
  readonly suggestionSelector: string;
  /** Queries shorter than this are never typed; the widget would not search on them. */
  readonly minTypedChars: number;
  /**
   * A control under the container that the widget fills only when a suggestion
   * was actually picked (Lever: the hidden `selectedLocation`). When declared,
   * success requires it to be non-empty after the pick; typed text alone is
   * never a selection.
   */
  readonly selectionWitnessSelector?: string;
}

/**
 * In-memory proof minted only by the trusted apply-rule interpreter. The
 * rule attribute and exact ScanRoot remain sealed behind the currentness
 * check, so callers cannot construct write authority from a label guess.
 */
export interface PlainTextContenteditableAttestation {
  readonly source: 'trusted-apply-rule';
  readonly purpose: 'cover-letter';
  readonly isCurrent: (
    root: ScanRoot,
    element: HTMLElement,
    purpose: 'fill' | 'undo',
  ) => boolean;
}

/**
 * Why we could not fill something. Stable codes (通用铁律 5) so the UI and any
 * future diagnostics never parse free text.
 */
export const APPLY_UNSUPPORTED_CONTROL_CODE = 'UNSUPPORTED_CONTROL';

/**
 * The content script's per-realm re-injection guard. Exporting it keeps the
 * shipping-package purity gate tied to the executable source rather than a
 * second, hand-copied marker string.
 */
export const APPLY_CONTENT_SCRIPT_MARKER = '__vibeApplyCsLoaded';

export const APPLY_ERROR_CODES = [
  'CLICK_DENIED', // the static click policy refused this target; nothing was dispatched
  'HONEYPOT', // an anti-bot trap field: filling it silently voids the application
  'OTHER_PERSON', // the field describes a reference/emergency contact, not the applicant
  // 答案是 f(候选人 × 岗位) 而非 f(候选人)：期望薪资、到岗时间、搬迁意愿。
  // ⚠️ 不再是"永远存不下来"——PD-2026-08-18-PROFILE-QUESTION-MODEL 给了
  // AnswerScopeRef（USER/REGION/ROLE/COMPANY/JOB/APPLICATION）+ AnswerSnapshot：
  // 答一次、按作用域复用、并入下一次 Intent 代填。所以这是"第一次要问"，
  // 不是"永远填不了"。另：工作授权／签证那一半已被 IRONCLAD-5-SPLIT 改判为乙档。
  'JOB_DEPENDENT',

  // 当前 stable runtime 只能交还用户在页面上操作的控件。
  //
  // ⚠️ 这个码今天**同时承载铁律 5 的甲档与乙档**，wire 上分不出来
  // （PD-2026-08-18-IRONCLAD-5-SPLIT）：
  //   当前硬拒绝闭集 = 密码、验证码/2FA/人机验证，以及背景调查同意、仲裁协议、
  //          信用/药检授权、营销订阅等**实质授权**。其中密码和前四类授权属于
  //          default-off `PENDING_L2P_PROPOSAL`，其余验证、营销、联系现任雇主与
  //          未列明/混合授权始终人工；现行 wire 尚不能拆分，批准前全部 fail closed；
  //   乙档 = **可代做，但每次要用户放行**（EEO 自我认同、"信息属实"类声明）——
  //          按档案值预填、写入前过阻塞式确认条。今天 fail closed 是因为
  //          production release 链未闭合（CAP-AF-024），不是永久边界。
  // 分界线是"声明的对象是谁的东西"，不是"敏感不敏感"。
  //
  // 与 HONEYPOT 的区别：蜜罐是"填了有害"，这一类是"只能你本人做"——所以它**要**
  // 提示用户去处理（产出 IN_PAGE_ACTION），而蜜罐进 NEVER_PROMPT_REASONS 不提示。
  'MANUAL_ONLY',

  // 乙档：**已按档案值预填，等用户放行**。与 MANUAL_ONLY 的下一步动作相反——
  // 那个是「只能你自己做」，这个是「我填好了，你确认一下」。
  //
  // 产出它不等于已经写入：没有那次确认就保持零写入，与 MANUAL_ONLY 同。
  // 面板靠同一条目上的 `key` 知道该拿哪个档案值去预填。
  'PREFILLED_NEEDS_CONFIRMATION',

  // 这一页是纯靠 DOM 指纹认出来的，域名不在厂商主机表里，而任何页面都能伪造
  // 那些指纹。简历比 11 个文本键值钱得多，所以它单独要一次确认。
  'HOST_UNCONFIRMED',

  // 单选/复选：授权上可写（16 号裁决授权卡 A 栏），卡的是没有数据源。
  // 与 UNSUPPORTED_CONTROL 分开，因为后者对这类控件已经是假话。
  'CHOICE_NO_DATA',

  'NO_VALUE', // the user's profile has nothing for this field

  // 用户主动关掉了这一类自动填（服务端 `suggestions.suppressedKeys` 的镜像）。
  // 与 NO_VALUE 的区别是**下一步动作相反**：NO_VALUE 要引导用户去补资料，
  // 这个码要静默跳过——催用户去填他自己刚关掉的那一项，是最直接的信任损失。
  // 因此它不进必填分母（summarizePlan）也不提示（NEVER_PROMPT_REASONS），
  // 与蜜罐／他人字段走同一套「永远进不了分子，所以不进分母」的裁定。
  'SENSITIVE_OPT_OUT',
  APPLY_UNSUPPORTED_CONTROL_CODE, // combobox / radio / date widget — v1 does not click
  'LOW_CONFIDENCE', // matched, but not confidently enough to write
  // 本该由用户自己答的题——作文 / 开放题、与这家公司的历史（是否在这里工作过、申请过）。
  // 从前它们和真正的低置信混在一起报「没把握，没敢填」，读起来像我们的缺陷、等下个版本；
  // 其实是「这题只有你能答」：下一步是用户去答（或让 AI 起草），不是我们去修（P4-15，2026-09-21）。
  'USER_ONLY',
  'NOT_EMPTY', // already had a value and fillEmptyOnly is on
  'NO_OPTION_MATCH', // a <select> with no option matching the value
  'AMBIGUOUS_OPTION', // a select match has multiple plausible options
  // UA-4 structure fact: the observed logical option membership is incomplete.
  // It is control-local and remains our FAILED/blockedByUs outcome; it must not
  // be disguised as unsupported, no-match, ambiguity, or a successful sentinel.
  'OPTIONS_INCOMPLETE',
  'WRITE_REVERTED', // we wrote, the framework reverted it
  'VALUE_COERCED', // the host kept a different value after settling
  'VERIFY_TIMEOUT', // the host did not settle within the verification window

  // 我们写的值留住了，但**宿主自己判它无效**（aria-invalid / 约束校验 /
  // 关联红字）。与 WRITE_REVERTED、VALUE_COERCED 都不同：那两个说的是"值没留住"
  // 或"留下的不是我们写的"，这个说的是"值留住了、对方不收"。
  // 缺了它，面板会报「已填 12/12」而页面上红着四条错误，用户点提交才发现。
  'HOST_REJECTED',

  // 目标身份没变，但此刻写不进去：控件 disabled，或没有可见的触发器
  // （被藏在按钮后懒渲染、零几何）。与 IDENTITY_CHANGED 的区别是**它不是
  // 页面级信号**——只说明这一栏用不了，不说明页面变成了另一个页面，
  // 所以绝不连带中止其余字段。
  'TARGET_NOT_WRITABLE',

  // 同节同键的重复控件里落选的那个：信息已由更高置信的孪生条目计划写入。
  // 不是用户待办，也不是能力不足——但静默消失不行，面板要能说清它去哪了。
  'DUPLICATE_FIELD',

  // 写入当时回读通过，**稍后**被宿主改回或覆盖（受控框架重渲染、上传简历后
  // 异步解析回填）。与 WRITE_REVERTED 的区别是下一步动作：那个换值形态重试
  // 还有救，这个说明宿主有异步权威，重试同一个值只会再被覆盖一次。
  'LATE_REVERTED',
  'WIDGET_TIMEOUT', // a dropdown never opened within its interaction budget
  'DETACHED', // the element left the DOM between plan and write
  'IDENTITY_CHANGED', // the reviewed field no longer has the same structural identity
  'HOST_SUBMITTED', // the host began submission or navigation during this fill run
  'ABORTED', // an earlier safety failure stopped this not-yet-written field
  'GESTURE_UNTRUSTED', // synthetic / forged event cannot authorize a host write
  'GESTURE_FOREIGN', // event did not originate in our Shadow UI
  'GESTURE_EXPIRED', // a user gesture may not be held for later use
  'GRANT_CONSUMED', // an authority may authorize exactly one run
  'LEASE_INVALID', // an intent-minted authority needs a non-empty claimed lease
  'LEASE_EXPIRED', // the server-issued execution lease has already lapsed
  'PLAN_STALE', // the user approved a different plan than the one being run
  'POLICY_DISABLED', // runtime kill/expiry/vendor gate closed the surface
  'JOURNAL_UNAVAILABLE', // original value could not be recorded
  'CAPABILITY_DISABLED', // authority does not permit this write primitive
  'STORAGE_UNAVAILABLE', // L1 draft storage could not be read or written safely
  'SCHEMA_TOO_NEW', // a newer extension owns the stored draft shape
] as const;
export type ApplyErrorCode = (typeof APPLY_ERROR_CODES)[number];

/**
 * Account-profile transport failures are deliberately separate from host-write
 * failures above. A network/auth issue must never be rendered as if an ATS
 * control rejected a value, and vice versa.
 */
export const APPLY_PROFILE_ACCESS_ERROR_CODES = [
  'INVALID_SENDER',
  'INVALID_REQUEST',
  'LOGIN_REQUIRED',
  'PROFILE_CONFLICT',
  /**
   * v1.1：档案被删除或重新启用过，手上这份状态属于一个已经不存在的世代。
   * 与 `PROFILE_CONFLICT` 分开，因为**下一步动作不同**——那个重新拉取即可重试，
   * 这个必须人工 Reload，且**绝不自动重试**。
   */
  'PROFILE_DELETION_CONFLICT',
  'PROFILE_UNAVAILABLE',
  'INVALID_RESPONSE',
  'RESUME_UNAVAILABLE',
  'STORAGE_UNAVAILABLE',
] as const;
export type ApplyProfileAccessErrorCode = (typeof APPLY_PROFILE_ACCESS_ERROR_CODES)[number];

/** A stable, explicit success/failure boundary for local autofill operations. */
export type Result<T, E extends ApplyErrorCode = ApplyErrorCode> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: E };

declare const WRITE_TICKET_BRAND: unique symbol;

/**
 * Opaque compile-time proof that the exact field was recorded by an
 * `UndoJournal` before any supported host mutation. The brand is deliberately
 * not exported, so callers cannot structurally manufacture a ticket.
 */
export interface WriteTicket {
  readonly [WRITE_TICKET_BRAND]: 'write-ticket';
  readonly purpose: 'fill' | 'restore';
}

/** Host-semantic state of one exact combobox selection. Raw input value is not evidence. */
export type ComboboxSelectionState =
  | 'EMPTY'
  | 'MATCH'
  | 'MISMATCH'
  | 'UNVERIFIABLE';

/** One option returned by a validated apply-rules interpreter. */
export interface ComboboxOptionView {
  readonly element: Element;
  readonly text: string;
}

/** Selector-free runtime view over one exact rule-owned combobox. */
export interface ComboboxOptionSource {
  readonly read: (
    trigger: HTMLInputElement,
    root: ScanRoot,
  ) => readonly ComboboxOptionView[];
  readonly isOpen: (trigger: HTMLInputElement) => boolean;
}

/**
 * Opaque semantic Undo handle sealed only after the host proves the selected
 * identity. It never exposes host selectors, option identities, or values.
 */
export interface ComboboxSemanticUndoTransaction {
  /** Trusted edit observed after this session's option dispatch. */
  readonly wasUserEdited: () => boolean;
  /** Protect a user or host edit made after this session's option selection. */
  readonly isAtWrittenState: () => boolean;
  /** Restore the exact semantic state captured before the option click. */
  readonly restorePreWrite: () => boolean;
  /** Prove the exact pre-write semantic state after restoration. */
  readonly isAtPreWriteState: () => boolean;
  /** Used only to protect trusted user edits while the transaction is live. */
  readonly ownsEventTarget: (target: EventTarget | null) => boolean;
  /** Release local listeners/opaque references when the journal retires it. */
  readonly dispose: () => void;
}

/** Rule-owned checkpoint captured before the first host click. */
export interface ComboboxSemanticTransaction {
  /**
   * Non-mutating proof that the exact pre-write option is still a safe,
   * rule-owned restoration target. Callers separately prove the current
   * semantic state and must re-run this immediately before every forward host
   * dispatch and before sealing success.
   */
  readonly canRestorePreWrite: () => boolean;
  readonly restorePreWrite: () => boolean;
  readonly isAtPreWriteState: () => boolean;
  readonly ownsEventTarget: (target: EventTarget | null) => boolean;
  /**
   * Seal the exact post-write semantic identity after selected-state readback.
   * Returning null means no verifiable semantic Undo exists, so the write
   * never becomes a successful result. Compensation is permitted only while
   * an exact transaction-owned pre/write state can still be proven; an
   * unrelated third state is left untouched and receives no Undo capability.
   */
  readonly captureWrittenState: (
    expectedOptionText: string,
  ) => ComboboxSemanticUndoTransaction | null;
}

export interface ComboboxSemanticTransactionSource {
  readonly snapshot: (
    trigger: HTMLInputElement,
    root: ScanRoot,
  ) => ComboboxSemanticTransaction | null;
}

/**
 * Complete, selector-free authority for a single combobox field. Only a
 * validated ruleset interpreter may construct it; callers cannot bolt on a
 * raw-value assertion as a substitute for semantic state.
 */
export interface ComboboxSemanticAuthority {
  readonly optionSource: ComboboxOptionSource;
  readonly semanticTransactionSource: ComboboxSemanticTransactionSource;
  readonly readSelection: (
    trigger: HTMLInputElement,
    expectedOptionText: string,
  ) => ComboboxSelectionState;
}

/**
 * One field the vendor adapter found. `element` is a live reference — this
 * type never crosses a message boundary; only `ApplyFieldReport` does.
 */
interface ApplyFieldDescriptorBase {
  /**
   * What the adapter believes this field is; null = unknown, ask the engine.
   *
   * 行内字段指向的是**角色**（`education.school`）而不是那 11 个扁平键——
   * 「学校」只有配上「第几段」才是一个值。行序不在这里，它由 `signature`
   * 的行标识给出（同一条路，见 fieldIdentity 的 `fieldRowIndex`）。
   *
   * 推断答案键（`DERIVED_ANSWER_KEYS`，2026-09-24）同样由规则认题：答案由内核从档案里的记录推出来。
   */
  key: ApplyFieldKey | CollectionFieldRole | DerivedAnswerKey | null;
  /**
   * 这个控件收得下什么形态的写入。缺省 `setValue`（原生 setter + 事件信封）。
   * `typed` 表示它**只接受逐字符增量输入**——由规则数据声明（铁律 3），
   * 因为那是个毫无特征的 `<input type="text">`（50-证据库 §F.6-s）。
   */
  writeMode?: 'setValue' | 'typed';
  /** Human-readable label, for the review list. Never logged (may be L1-ish). */
  label: string;
  required: boolean;
  /**
   * 0–1. How sure the adapter/engine is about `key`. Below the apply
   * threshold we report LOW_CONFIDENCE instead of writing.
  */
  confidence: number;
  /** Structural identity captured while this exact field was scanned. */
  signature: FieldSignature;
}

/** A native choice question as scanned: its control type and every member with the label the user sees, in DOM order. */
export interface NativeChoiceGroupShape {
  readonly control: 'radio' | 'checkbox';
  readonly options: readonly { readonly element: HTMLInputElement; readonly label: string }[];
}

/** One option of an ARIA-proxied question: the element the user operates and whose ARIA state the host publishes. */
export interface ProxyChoiceOption {
  /** `button[aria-pressed]` or `[role=radio|checkbox][aria-checked]`; never a native control. */
  readonly element: HTMLElement;
  readonly label: string;
  /**
   * The hidden native radio/checkbox this option wraps (Workable), or null for a pure ARIA
   * widget (Ashby's yes/no buttons). The host takes the answer from a click on the carrier when
   * there is one; its `checked` is never evidence — the proxy's published state is.
   */
  readonly carrier: HTMLInputElement | null;
}

/**
 * A question whose options are ARIA proxies (2026-09-23): the host publishes each option's state
 * as `aria-pressed` (toggle buttons) or `aria-checked` (`role=radio` / `role=checkbox`), while the
 * native controls, if any, are hidden carriers or mirrors. Grouping comes from the ARIA/HTML
 * group container (`role=radiogroup|group`, `fieldset`) or a rule-declared question scope —
 * whichever is nearest; the kernel carries no site selector for it (see `dict/ariaChoice.ts`).
 */
export interface ProxyChoiceGroupShape {
  readonly control: 'proxy';
  readonly proxy: 'toggle' | 'radio' | 'checkbox';
  /** Toggle buttons and `role=radio` pick exactly one; `role=checkbox` options are independent. */
  readonly multiple: boolean;
  readonly options: readonly ProxyChoiceOption[];
  /**
   * The container that owns the whole option set, sealed at scan time; null for a lone
   * `role=checkbox` proxy (the option is its own question). The writer re-proves that the
   * container still holds exactly these options and nothing else that could take the click.
   */
  readonly container: Element | null;
  /**
   * The native control that carries the question's form name (a carrier or a sibling mirror);
   * null when the widget has none. Rule steps that read attributes (`attrMap`, name gates) read
   * this one, exactly as they read the first member of a native group.
   */
  readonly nameSource: HTMLInputElement | null;
  /**
   * 题干所在的那个元素（2026-09-24）：`aria-labelledby` 指向的节点、`legend`、规则声明的 question scope
   * 里的题干，或单个 checkbox 代理自己；题干来自 `aria-label` 这种属性时是 null。代理的可读名常常读不到
   * 题干（Ashby 的是非按钮只读得到「YesNo」），以用户名义代填的那一下要在点击当下把题干重新认一遍，
   * 就从这里读。缺省 = 没有（不代填）。
   */
  readonly question?: Element | null;
}

export type ChoiceGroupShape = NativeChoiceGroupShape | ProxyChoiceGroupShape;

/**
 * A discriminated union makes a non-writable control impossible to hand to a
 * writer without first narrowing it. Unsupported controls remain visible so
 * the review surface can count the work a candidate must still do manually.
 */
/**
 * 规则声明的上传部件怎么说「收下了这一份」（2026-09-28 Workday 的简历栏；规则 `fileUploads`）。选择器只在内核里用：
 * 部件根从文件框往上最近的那一个，其余都在部件根里面找。
 */
export interface FileUploadBinding {
  readonly containerSelector: string;
  readonly itemSelector: string;
  readonly itemNameSelector: string;
  readonly successSelector: string;
}

type ApplyWritableFieldDescriptor = {
  [Kind in Exclude<ApplyControlKind, 'combobox'>]: ApplyFieldDescriptorBase & {
    kind: Kind;
    element: ApplyElementByKind[Kind];
  } & (Kind extends 'richtext'
    ? { plainTextContenteditableAttestation: PlainTextContenteditableAttestation | null }
    : Kind extends 'choice'
      ? { choice: ChoiceGroupShape }
      : Kind extends 'file'
        ? { upload?: FileUploadBinding }
        : Record<never, never>);
}[Exclude<ApplyControlKind, 'combobox'>]
  | (ApplyFieldDescriptorBase & {
      kind: 'combobox';
      element: ApplyElementByKind['combobox'];
      /** Missing means default-off and must produce CAPABILITY_DISABLED before open. */
      semanticAuthority?: ComboboxSemanticAuthority;
      listbox?: ListboxComboboxBinding;
      /** Rule-declared multi-value widget: every candidate is a value to select. */
      multiple?: boolean;
    });

export type ApplyFieldDescriptor =
  | ApplyWritableFieldDescriptor
  | {
      kind: 'unsupported';
      element: Element;
      /**
       * 通常是 `null`——填不了的控件多半也认不出是什么。
       *
       * 但 `WIDGET` 那一档可以**认得出却写不进去**：Workable 的行内字段就是这样
       * （只接受逐字符增量输入，见 50-证据库 §F.6-s）。此时保留已解析出的键，
       * 审计面板才说得出「这是你的职位，但这一栏得你自己填」，而不是含糊的
       * 「有个控件我们处理不了」——那两句话对用户的下一步动作意义完全不同。
       */
      key: ApplyFieldKey | CollectionFieldRole | DerivedAnswerKey | null;
      label: string;
      required: boolean;
      confidence: 0;
      signature: FieldSignature;
      /**
       * `CONTROL_TYPE` — the element itself is a kind v1 cannot write
       * (file, checkbox, radio …).
       * `WIDGET` — nominally a writable text input, but a vendor widget owns
       * its real value. Lever's `location` typeahead is the reference case:
       * text written without picking a suggestion is discarded on blur, so the
       * form would submit with no location while our readback saw the text
       * sitting in the box. Reporting it as manual is honest; filling it is
       * worse than leaving it. Stage 2's combobox sequence retires this.
       * 同档还有 `writeMode: 'typed'` 的行内字段：整串写入会被宿主的表单状态
       * 拒收而 `element.value` 留着，回读判决因此会把失败报成成功。
       */
      unsupportedReason: 'CONTROL_TYPE' | 'WIDGET' | 'CHOICE_NO_DATA';
    };

/**
 * 一个厂商声明的重复行作用域。值是数据、来自 `apply-rules` 的 JSON
 * （铁律 3——kernel 里只有类型与解释器）。
 *
 * **两种行模型，因为真实世界就是两种**（2026-08-22 实测，见 50-证据库 §F.6-f）：
 *
 *  · `contains` —— 行是一个 DOM 元素，字段靠包含关系归属。
 *    Workable：`div[data-ui="experience"]` > `ul` > `li`。
 *  · `idPrefix` —— 行序**编在控件 id 里**，DOM 上没有行元素可依。
 *    iCIMS：`-1_PersonProfileFields.PhoneNumber`、`-1_PersonProfileFields.AddressCity`
 *    同属一行，行标识是 id 前缀那一段。
 *
 * 只实现前者的话，iCIMS 与同类厂商**一行都定位不了**——它们的 DOM 里
 * 根本没有「行」这个元素，所有行的控件平铺在同一个容器下。
 *
 * 两种都产出同一形状的 `FieldIdentityScope.scopeKey`，所以下游（投影层、
 * 身份复核、增删行编排）不需要知道自己面对的是哪一种。
 */
/**
 * 行动作按钮的选择器。**缺一个就是「这家不支持这个动作」，不是「用默认值」**——
 * 猜一个选择器出来点下去，代价是替用户按了一个我们没验过的按钮。
 */
export interface RowActionSelectors {
  /** 容器内的「加一行」按钮：Workable `button[data-ui="add-section"]`、Greenhouse `button.add-another-button`。 */
  readonly add?: string;
  /**
   * 行内的「保存本段」按钮。目前只有 Workable 有（`button[data-ui="save-section"]`）。
   * 这一下点击会把整段提交进宿主的数据结构——它是本仓唯一一个「点完宿主那边
   * 真的多了一条数据」的代点击，红证单独写（见 click/policy.ts 的 `row-save`）。
   */
  readonly save?: string;
  /** 行内的删除按钮。只用于撤销**本轮自己加的行**，绝不删宿主原有的行。 */
  readonly remove?: string;
}

/** 行作用域里与行模型无关的部分。 */
interface RowScopeCommon {
  readonly container: string;
  /**
   * 这一组行喂给档案里的哪个集合。
   *
   * **缺省是有意义的一档**：iCIMS 的电话/地址行需要行身份（否则加一行会把后续
   * 字段的序号全冲掉、整轮填充以 IDENTITY_CHANGED 中止），但档案里没有「电话集合」
   * 这种东西，它们不参与增删行编排。行身份与增删行编排是两件事。
   */
  readonly collection?: 'education' | 'experience';
  readonly actions?: RowActionSelectors;
  /**
   * 行内字段的映射：控件 `name` → 该集合的角色**后缀**。
   *
   * 为什么行内字段需要自己的映射表，而不是并进全局 `keySteps`：
   * Workable 的经历行与教育行**共用同一批 name**——两段里都有 `start_date`
   * 与 `end_date`（2026-08-22 实测，50-证据库 §F.6-e）。一张按 `name` 查的全局表
   * 表达不了「这个 `start_date` 是哪一段的」，只能二选一，另一段必然错。
   *
   * 键写成**裸后缀**（`"start_date": "startDate"`）而不是整个角色名，
   * 集合前缀由本作用域的 `collection` 给出——于是「在经历段里声明了一个教育角色」
   * 这种错误从构造上不可能发生，而不是靠校验事后拦。
   *
   * 只有声明了 `collection` 的行作用域才可能有它（schema 强制）。
   */
  readonly fieldMap?: Readonly<Record<string, string>>;
  /**
   * 从控件 `id` 里取出**行内单元名**的正则，必须恰好一个捕获组。
   * 不给就按 `name` 查 `fieldMap`。
   *
   * 为什么需要它：`fieldMap` 是按 `name` 查的，而 Greenhouse 的教育行内控件
   * **一个 name 都没有**——只有 `school--0` / `degree--0` / `discipline--0` 这种
   * 「单元名 + 行号」的 id（2026-08-23 实测，50-证据库 §F.6-r）。
   * 用 `^(.+)--\d+$` 把行号剥掉，剩下的 `school` 才是跨行稳定的那部分。
   *
   * 与 `idPrefix` 行模型的 `idPattern` 是**两件事**：那个取的是「第几行」，
   * 这个取的是「这一行里的哪一栏」。同一份规则可以只用其中一个。
   */
  readonly cellIdPattern?: RegExp;
  /**
   * 这一组行的控件**怎么才收得下值**。这是关于宿主的事实，不是关于我们的能力。
   *
   *  · `setValue`（缺省）——原生 setter + 事件信封，绝大多数表单都吃这一套。
   *  · `typed` ——**只接受逐字符增量输入**。整串写入会被宿主的表单状态拒收，
   *    而 `element.value` 留着旧的写入结果，于是回读判决会把这次**报成成功**
   *    （2026-08-23 Workable 实测，50-证据库 §F.6-s：同一个 `title` 栏整串写入后
   *    点 Update 报「This is a required field.」，逐字符重敲一遍错误当场消失）。
   *
   * 为什么必须由规则数据声明：那是个毫无特征的 `<input type="text">`，
   * tag、type、role 一律看不出区别，只能靠实测（铁律 3）。
   */
  readonly writeMode?: 'setValue' | 'typed';
  /**
   * 这一组行里**带输入掩码**的格（键与 `fieldMap` 同域）。
   *
   * 掩码框会改写我们打的字：Workable 的 `start_date` 是 `MM/YYYY` 掩码
   * （`placeholder="MM/YYYY"`、`inputmode="tel"`、旁边一个日历图标），
   * 敲 `062021` 得到 `06/2021`。
   *
   * **为什么单独列出来而不是一起放行**：投影层给日期的首选是 `2021-06`，
   * 把它敲进 `MM/YYYY` 掩码会得到一个**错误的日期**；而回读判决的
   * `valuesEquivalent('2021-06', '20/2106')` 恰好返回 `true`
   * （内容字符逐位相同，只是分隔符位置不同）——于是**写错了还判成功**。
   * 见 50-证据库 §F.6-w 第二条。
   *
   * 所以在「预测写入后形态 + 严格相等」那一层落地之前，掩码格一律如实报
   * 填不了；同一组行里的普通文本格照常走逐字符通路。
   */
  readonly maskedCells?: readonly string[];
  /**
   * 新加的一段出现在这一组行的哪一头（2026-09-24）。缺省 `bottom`：接在最后（Greenhouse、Workday）。`top`：插在最前面
   * ——Workable 每加一段，新编辑框出现在所有已保存的卡片**上面**（2026-09-24 在 skroutz、usa-vein-clinics 实测）。
   *
   * 它决定按什么次序加资料里的各段：页面上最后从上到下要是资料的顺序（负责人 2026-09-24：最近的一段在最上面，
   * 招聘方从上往下读），插在最前面的区就从资料的最后一段加起。为什么是规则数据、不是内核自己看：一个空的区加第一段时
   * 看不出宿主往哪一头插——等第二段露出来，第一段已经放下了。
   *
   * 只有每一段要单独保存的区（声明了 `actions.save`）才许 `top`：那种区按「哪一行开着编辑框」找得到新行；不存段的区
   * 新行插在最前面会挪动已有每一行的身份，我们不支持（规则解析拒收）。
   */
  readonly insertsAt?: 'top' | 'bottom';
}

export type RowScopeRule = RowScopeCommon &
  (
    | {
        readonly kind: 'contains';
        /** 相对容器的行元素选择器。 */
        readonly row: string;
      }
    | {
        readonly kind: 'idPrefix';
        /**
         * 从控件 id 里取出行标识的正则，**必须恰好一个捕获组**。
         * iCIMS 用 `^(-?\d+)_`：`-1_PersonProfileFields.PhoneNumber` → 行标识 `-1`。
         *
         * 行标识是**不透明字符串**，不是序号——iCIMS 用 `-1` 表示「尚未保存的新行」。
         * 行的先后由控件在 DOM 里的首次出现顺序决定，与标识本身的字面值无关。
         */
        readonly idPattern: RegExp;
      }
  );

/**
 * 字段身份的计数域（"行标识 + 行内序号"契约的载体）。
 *
 * 行内控件：scopeKey 是行标识，controls 只含本行控件——序号在行内数。
 * 根域控件：scopeKey 为 ''，controls 不含任何行内控件——"加一行"因此
 * 不再冲掉行后字段的序号（旧仓库实测：一次加行插入 7 个控件，插入点
 * 之后所有字段序号全变，整轮填充中止）。
 */
export interface FieldIdentityScope {
  /** '' = 根域；行域形如 `row·<规则序>:<容器序>:<行序>`。尾部加行不改既有行的键。 */
  readonly scopeKey: string;
  readonly controls: readonly Element[];
  /**
   * 同一计数域里的 ARIA 代理选项（`dict/ariaChoice.ts`），DOM 顺序。代理题的签名序号在这里数。
   *
   * **惰性**：只有签名的主人本身是代理选项时才会被调用。它是一次额外的全树查询，而
   * `identityScope` 每字段一次、有注入预算的门禁盯着（apply-injection-budget）——普通字段
   * 不该为它付钱。结构性实现（测试桩）可以不给，此时代理题按「数不出序号」失败关闭。
   */
  readonly proxyOptions?: () => readonly Element[];
}

/** Options for `ScanRoot.labelTextFor`. */
export interface LabelTextOptions {
  /** Only host-declared labels (explicit / wrapping `<label>`, `aria-*`); never a placeholder, title or nearby-prose guess. */
  readonly declaredOnly?: boolean;
  /**
   * Receives the found label's visible text **before** display normalization — required markers
   * (`*`, `✱`, `(required)`) kept — from the same source and the same walk. Called once, only when a
   * label is found; never for the placeholder / title fallbacks (a hint inside the box is not a label).
   * Structural implementers may ignore it; a caller then simply sees no marker.
   */
  readonly onRawText?: (raw: string) => void;
}

/**
 * The sole window an adapter gets onto a host form. It lives in L0 as a pure
 * boundary shape so `ApplyFormDescriptor` can carry it without contracts
 * importing the L2 implementation in `scanRoot.ts`.
 */
export interface ScanRoot {
  querySelectorAll(selector: string): readonly Element[];
  /**
   * The label a user reads for this control. `declaredOnly` stops the cascade after the
   * host-declared steps (explicit / wrapping `<label>`, `aria-labelledby`, `aria-label`) and
   * returns '' instead of guessing from a placeholder, title or nearby prose — the rule
   * interpreter uses that boundary to decide when a vendor-declared question scope may speak.
   */
  labelTextFor(element: Element, options?: LabelTextOptions): string;
  isExcluded(element: Element): boolean;
  /** 字段身份的计数域；行知识由创建 ScanRoot 时传入的 rowScopes 数据决定。 */
  identityScope(element: Element): FieldIdentityScope;
}

/**
 * 宿主计算样式里与「这段文字用户读不读得到」有关的那两条。
 *
 * 只有这两条：`display` 与 `visibility`。不收 opacity / clip / 尺寸——那些是
 * 蜜罐几何的判据（HoneypotGeometry），拿它们裁标签会把"视觉上很淡"的真标签
 * 也裁掉。这里要的是**宿主明说「不渲染」**，不是"看起来不显眼"。
 */
export interface HostVisibilityStyle {
  readonly display?: string;
  readonly visibility?: string;
}

/** 扫描期的环境能力注入。kernel 自身不碰浏览器扩展 API。 */
export interface ScanRootOptions {
  /**
   * 打开一个元素的 shadow root。缺省只看 open root（`element.shadowRoot`）；
   * 内容脚本传 `chrome.dom.openOrClosedShadowRoot` 才能穿**闭合**根——那是
   * 内容脚本无需额外权限就能用的 API，宿主页面观察不到。
   */
  openShadowRoot?: (element: Element) => ShadowRoot | null;
  /**
   * 宿主页面的语言（`document.documentElement.lang` 等）。只用主子标签比较。
   * 不传 = 未知，所有 labelPatterns 都参与——保持 locale 分层之前的行为。
   */
  locale?: string;
  /**
   * 读一个元素的计算可见性。**姿势与 buildPlan 的 `readGeometry` 同源**：
   * kernel 不碰 `getComputedStyle`（RULE-KERNEL-DETERMINISTIC-BOUNDARY），
   * 所以"当前环境会布局"这件事由调用方声明并提供读法，kernel 只跑纯判据。
   *
   * 标签归一化拿它剔除**类名藏起来**的文字：inline style、`hidden`、
   * `aria-hidden` 三条属性层判据读得到，但 `.iti__hide` / `.dropdown-no-results`
   * 这种只在样式表里写 `display:none` 的藏法读不到，而那正是 Workable 的
   * 国家区号表与 Lever 的 typeahead 状态文案混进标签的原因。
   *
   * 不传 = 只用属性层判据。少剔一些噪声，但绝不会因此多剔一个真标签。
   */
  readVisibility?: (element: Element) => HostVisibilityStyle;
  /**
   * 读一个元素的 CSS **生成内容**（`getComputedStyle(element, pseudo).content` 的原值）。
   *
   * 只用于一件事：题干上画出来的必填星号（2026-09-23 Ashby：必填的是非题在 DOM 里没有任何
   * required / aria-required，题干上只有一个构建哈希 class，星号是 `::after { content: "*" }`）。
   * 判据（「这是不是一个必填记号」）在内核里是纯函数（`dict/ariaChoice.ts`）；这里只是读法，
   * 与 `readVisibility` 同一个姿势。不传 = 只认 DOM 里真实存在的必填声明与文字星号。
   */
  readGeneratedContent?: (element: Element, pseudo: '::before' | '::after') => string | null;
  /**
   * 白标 B（P2-11）：允许 `resolveRoot` 在厂商声明的容器锚点都找不到时，退而找
   * 「包含 ≥ minHooks 个本家 attrMap id 钩子的唯一容器」（规则的 `whitelabelRoot`）。
   * 只有指纹判定为该家、且主机不在任何厂商表里的调用方才该传 true。
   */
  whitelabel?: boolean;
  /** 通用路（2026-09-22）：见 `ApplyPathOptions.generic`。 */
  generic?: boolean;
}

/**
 * 路径判定的调用方声明。`embedded: true` = 调用方运行在**子帧**里（`window.top !== window.self`）。
 * 只有这样声明时，规则的 `embeddedApplyPath`（厂商官方嵌入帧承载同一张表的路径）才参与判定；
 * 顶层帧上那条路径仍然 fail closed——岗位身份在 query 里，pathname-only authority 不认它。
 */
export interface ApplyPathOptions {
  readonly embedded?: boolean;
  /**
   * 白标 B（P2-11）：指纹判定为该家、且主机不在任何厂商表里。厂商的路径知识对别人的域名
   * 不适用，所以只要规则声明了 `whitelabelRoot` 就放行路径——真正的闸是 DOM 里那张表。
   */
  readonly whitelabel?: boolean;
  /**
   * 通用路（2026-09-22）：这一页**一个厂商都认不出**。厂商的路径知识在这里完全
   * 不适用（自建域上既没有本家路径也没有本家钩子），所以只要规则声明了
   * `genericRoot` 就放行路径——真正的闸是 DOM 里那张表有多少字段我们认得。
   */
  readonly generic?: boolean;
}

/** A vendor adapter owns URL knowledge, an explicit form anchor, and scanning. */
export interface VendorAdapter {
  isApplyPath(pathname: string, options?: ApplyPathOptions): boolean;
  resolveRoot(page: ParentNode, options?: ScanRootOptions): ScanRoot | null;
  scan(root: ScanRoot, options?: ScanRootOptions): readonly ApplyFieldDescriptor[];
  /**
   * 厂商声明的重复行作用域（apply-rules 数据）。有它，增删行编排（rowActions.ts）才知道
   * 「一行」是什么、「加一行」按哪里；缺省 = 这一家没有可编排的行。选择器只在 kernel 里解释。
   */
  readonly rowScopes?: readonly RowScopeRule[];
  /** Resolve only the ruleset-declared final native control; no fallback. */
  resolveFinalSubmitControl(
    root: ScanRoot,
    fields: readonly ApplyFieldDescriptor[],
  ): FinalSubmitControlDescriptor | null;
  /**
   * 这一页上是不是「申请表还没打开」——厂商声明了那个打开按钮、而它此刻就在页面上。
   *
   * 只回答是与不是，**不交出元素、也不点它**（打开申请表由用户本人点，2026-09-22）。
   * 它的唯一用处是把锚点没命中时那句「规则要更新了」换成一句对的话。
   * 没有声明 `applyGate` 的厂商永远返回 false，所以行为与从前逐字相同。
   */
  hasUnopenedApplyForm(page: ParentNode): boolean;
  /**
   * 申请表还没打开时，规则声明的那一颗「打开申请表」（2026-10-04，负责人 D8：BambooHR 的「Apply for This Job」）。
   * 只在申请表此刻确实还没打开、那一颗唯一、可用、不是任何一张表的提交控件时交出；别的情况都是 null。内核不动手——
   * 按不按由扩展按翻页那一位决定。可缺省只为手写的测试替身编译得过。
   */
  applyGateControl?(page: ParentNode): HTMLElement | null;
  /**
   * 这一页是不是申请表之前那一道「数据同意」页（2026-10-04，规则的 `consentGate`）：锚点没命中、同意页的容器此刻在页面上。
   * 只回答是与不是，不交出元素、不动手。没有声明的厂商永远是 false。可缺省只为手写的测试替身编译得过。
   */
  hasConsentGate?(page: ParentNode): boolean;
  /**
   * 规则声明的题干（question scope）里，这个元素所在的那一题的题目（2026-10-04）。给「页面上还空着的必填」读那些扫描
   * 不认的控件用（Rippling 自定义题的 `div[role=combobox]`，题干在外层容器里）。没声明、找不到都是空串；可缺省只为手写的
   * 测试替身编译得过。
   */
  questionTextFor?(root: ScanRoot, element: Element): string;
  /**
   * 数据同意页此刻的样子（2026-10-04，负责人 D7）：规则声明的表（`consentGate.form`）与居住地下拉（`consentGate.residence`）。
   * 只在 `hasConsentGate` 成立时交出；不动手。可缺省只为手写的测试替身编译得过。
   */
  readConsentGate?(page: ParentNode): ConsentGateReading | null;
  /**
   * 账号墙（2026-09-28，规则的 `accountSteps`）。规则没声明的厂商这几项都是「没有」：
   * `declaresAccountSteps` 为 false、`isAccountPath` 答否、`resolveAccountWall` 与 `readAccountOutcome` 答 null。
   * 可缺省只为手写的测试替身编译得过；规则编译出来的适配器总是带着它们。
   */
  readonly declaresAccountSteps?: boolean;
  /** 只有账号页、没有申请表的路径（iCIMS 的 …/login）。账号墙在申请路径上的厂商（Workday）不声明。 */
  isAccountPath?(pathname: string): boolean;
  /** 此刻页面上规则声明的账号墙是哪一步、那几格与那几颗在哪；没有、或说不清（不唯一、缺一样）就是 null。 */
  resolveAccountWall?(page: ParentNode, options?: ScanRootOptions): AccountWallStep | null;
  /** 网站此刻在账号墙上说了什么（规则声明的横幅里、看得见的字）。可见性由调用方量（内核不碰布局）。 */
  readAccountOutcome?(page: ParentNode, isVisible: (element: Element) => boolean): AccountOutcomeReading;
  /**
   * 邮箱验证（2026-10-04，规则的 `emailVerification`）。规则没声明的厂商：`declaresEmailCodePrompts` 为 false、
   * `emailVerificationMail` 与 `emailVerification` 是 null。可缺省只为手写的测试替身编译得过。
   */
  readonly declaresEmailCodePrompts?: boolean;
  /** 那一封邮件的发件地址与标题开头（只给人看）。 */
  readonly emailVerificationMail?: EmailVerificationMail | null;
  /**
   * 规则里那一份（解析过、只读）。认「网站此刻在要验证码」的函数不挂在适配器上，而是 `rules/emailVerification.ts` 的
   * `resolveEmailCodePrompt(rule, …)`：只有浮层那一路叫它，浮层挂不出来的构建里它随之被删掉。
   */
  readonly emailVerification?: EmailVerificationRule | null;
}

/**
 * 网站把验证码发到申请人邮箱的那一封邮件长什么样（2026-10-04）：只给人看——浮层照登，帮他在收件箱里找到那一封。
 * 插件不读邮件（第 1 步），这里也就没有任何能拿去匹配邮件的东西，只有两行字。
 */
export interface EmailVerificationMailRule {
  /** 发件地址（至少一个）。Workday 这类按租户发的写成「…@myworkday.com」这样的说法。 */
  readonly from: readonly string[];
  /** 标题的开头；说不准就是 null。 */
  readonly subject: string | null;
}

/** 网站说验证码怎么了：不对、过期了、试的次数太多。 */
export interface EmailCodeOutcomeRule {
  readonly kind: 'wrong' | 'expired' | 'tooMany';
  readonly text: Readonly<{ source: string; flags?: 'i' }>;
}

/**
 * 网站要申请人把邮件里的验证码填进这一页（2026-10-04，负责人：验证码第 1 步——他自己在浮层里输或粘贴，插件写进网站那一格）。
 *
 *  · `container`：提示所在的容器，整页恰好一个、看得见才算网站此刻在要验证码。
 *  · `inputs`：容器里验证码那一格或那几格（按文档顺序）：一格收整串，或者每格一个字符（格数等于 `length`）。
 *  · `length` / `charset`：几位、由哪些字符组成（只认 `digits` 与 `alphanumeric`）。
 *  · `recipient`：容器里说明发到哪个邮箱的那一处（可缺省）。读出其中像邮箱的那一段，只在本机浮层上显示。
 *  · `errors`：网站说验证码不对、过期的地方（整页找，可缺省）；`outcomes`：那几个字是哪一种。有 `outcomes` 就必须有它。
 *  · `next`：填好之后的那一步——`resubmit`（再按一次提交，Greenhouse）或 `verify`（按网站上的验证钮）。插件都不替他按：
 *    验证码写进去之后照旧由他按浮层里的「提交」（只按规则声明的最终提交），或在网站上自己点。
 *
 * 规则里没有任何授权：写不写由用户在我方浮层里的那一下真实点击与运行时包的写策略决定（RULE-GLOBAL-HUMAN-AUTHORIZATION）。
 */
export interface EmailCodePromptRule {
  readonly container: string;
  readonly inputs: string;
  readonly length: number;
  readonly charset: 'digits' | 'alphanumeric';
  readonly recipient: string | null;
  readonly errors: string | null;
  readonly outcomes: readonly EmailCodeOutcomeRule[];
  readonly next: 'resubmit' | 'verify';
}

/**
 * 邮箱验证（可缺省的顶层键，2026-10-04）。纯加法：去掉它，这份规则对不认识它的内核照旧正确——不认识它的内核
 * 照旧说「去网站上输入验证码」，不会写错任何一格。2026-09-28 起的内核不认识它只是不解释；更早的包（含商店 1.0.0）
 * 本来就因为 accountSteps / fileUploads 整份拒收这一版 release，这一键不改变它们的处境。
 *
 *  · `mail`：那一封邮件的发件地址与标题开头（只给人看）。
 *  · `codePrompts`：这一家要验证码时页面长什么样（可以是空的：Workday 的邮箱验证是点链接，只用 `mail`）。
 */
export interface EmailVerificationRule {
  readonly mail: EmailVerificationMailRule;
  readonly codePrompts: readonly EmailCodePromptRule[];
}

/** 那一封验证邮件长什么样（规则的 `emailVerification.mail`）：只给人看，插件不读邮件。 */
export interface EmailVerificationMail {
  readonly from: readonly string[];
  readonly subject: string | null;
}

/** 网站说验证码怎么了：认得的那一种；有字但对不上规则里的任何一种是 `unrecognized`。 */
export type EmailCodeError = 'wrong' | 'expired' | 'tooMany' | 'unrecognized';

/**
 * 规则解释器交出的「网站在要邮件里的验证码」（2026-10-04）：selector-free 的活元素与一次同步复核，与账号墙同一个姿势。
 * 写进去的值只能是用户本人在我方浮层里输入或粘贴的那一串（`write/emailCode.ts`），插件不读邮件、不从任何别处取码。
 */
export interface EmailCodePrompt {
  /** 验证码那一格（整串）或那几格（每格一个字符，按文档顺序）。 */
  readonly inputs: readonly HTMLInputElement[];
  readonly length: number;
  readonly charset: 'digits' | 'alphanumeric';
  /** 填好之后他要做的那一步：再按一次提交，或者按网站上的验证钮。插件都不替他按。 */
  readonly next: 'resubmit' | 'verify';
  /** 网站说发到了哪个邮箱（读出来的像邮箱的那一段；Data-L1，只在本机浮层上显示）；读不出是 null。 */
  readonly recipient: string | null;
  /**
   * 网站此刻说验证码怎么了；没说是 null。`text` 是网站那一句原话（截到 160 字，只在本机浮层上显示）；`node` 只用来判
   * 「这是不是新说的一次」：换了节点或换了字就是新的一次。
   */
  readonly error: Readonly<{ kind: EmailCodeError; text: string; node: Element }> | null;
  /** 那几格此刻已经是一串完整、字符对得上的验证码（谁填的都算）。 */
  readonly filled: boolean;
  /** 同步复核：容器仍唯一、看得见，那几格仍是认出来时的那几个节点。 */
  readonly isCurrent: () => boolean;
}

/**
 * 账号墙的几种步骤（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday 与 iCIMS）。
 *
 *  · `choice`：先选怎么登录（Workday：用 Google／LinkedIn／「Sign in with email」）——我们只按「用邮箱」；
 *  · `identify`：先报邮箱（iCIMS 的「Enter Your Information」），网站再决定登录还是注册；
 *  · `signIn`：邮箱 + 密码；
 *  · `createAccount`：邮箱 + 密码 + 再输一次密码，常带一个注册条款的勾选框。
 */
export type AccountStepKind = 'choice' | 'identify' | 'signIn' | 'createAccount';
/** 账号墙上我们会写的那几格。 */
export type AccountFieldRole = 'email' | 'password' | 'verifyPassword';
/** 账号墙上我们会按的那几颗（`terms` 是注册条款的勾选框，也是按一下）。 */
export type AccountControlRole = 'submit' | 'useEmail' | 'toSignIn' | 'toCreateAccount' | 'terms';
/** 按了提交之后网站说的话，规则认得的几种（`accountSteps.outcomes`）。 */
export type AccountOutcomeKind = 'accountExists' | 'wrongPassword' | 'verifyEmail' | 'blocked';
/**
 * 账号墙上此刻看得见的横幅：认得的那一种；有字但一种都认不出是 `unrecognized`（网站说了别的，比如某一格格式不对）；
 * 什么都没说是 null。
 */
export type AccountOutcomeReading = AccountOutcomeKind | 'unrecognized' | null;

/**
 * 规则解释器交出的账号墙这一步：selector-free 的活元素与一次同步复核（与 `FinalSubmitControlDescriptor` 同一个姿势）。
 * 扩展只拿元素、只问 `isCurrent()`，从不接触选择器，也不自己认这一页（RULE-GLOBAL-DOM-RULE-BOUNDARY）。
 */
export interface AccountWallStep {
  readonly kind: AccountStepKind;
  /** 账号墙的容器做成的扫描根：点击事实（是否在墙里、是否隐藏、是否在验证码里）按它采。 */
  readonly root: ScanRoot;
  readonly fields: Readonly<Partial<Record<AccountFieldRole, HTMLInputElement>>>;
  readonly controls: Readonly<Partial<Record<AccountControlRole, Element>>>;
  /** 同步复核：容器仍唯一、这一步的标志仍在、每一格与每一颗仍是规则此刻解析出的同一个节点。 */
  readonly isCurrent: () => boolean;
}

/**
 * Selector-free live authority produced by the rule interpreter. Extension may
 * compare element identity and call `isCurrent`, but never receives selector
 * text or performs vendor inference.
 */
export interface FinalSubmitControlDescriptor {
  readonly activation: 'native-submit';
  readonly element: HTMLButtonElement | HTMLInputElement;
  readonly form: HTMLFormElement;
  /** Synchronous identity/attribute/uniqueness recheck at the user gesture. */
  readonly isCurrent: () => boolean;
}

/** What the registry returns for the current page. Vendor-neutral. */
export interface ApplyFormDescriptor {
  vendor: ApplyVendor;
  root: ScanRoot;
  fields: ApplyFieldDescriptor[];
  /** 与 `VendorAdapter.rowScopes` 同一份数据，随描述符带给增删行编排；缺省 = 没有。 */
  rowScopes?: readonly RowScopeRule[];
  /** `null` means the remote ruleset deliberately keeps AF-041 fail closed. */
  finalSubmitControl?: FinalSubmitControlDescriptor | null;
  /**
   * 对这一次扫描出的根与字段，按规则**再认一次**最终提交（2026-10-04）。判据与 `finalSubmitControl` 逐字相同：
   * 规则声明了、恰好一颗、原生提交、属于这张表、此刻可用（不是 disabled、不是 aria-disabled）。
   *
   * 为什么要它：有的网站在必填没填好之前把提交钮禁用着（Rippling：aria-disabled，填好才放开），扫描那一刻认出的是 null；
   * 填完、网站放开之后，扩展靠这里再认一次。它不放宽任何一道闸，认不出照旧是 null。规则没声明的厂商永远是 null。
   */
  resolveFinalSubmitControl?: () => FinalSubmitControlDescriptor | null;
  /**
   * 规则声明的题干：这张表上任一元素所在的那一题的题目（`VendorAdapter.questionTextFor` 绑上这张表的根）。只在本地用、
   * 不序列化；缺省 = 没有。
   */
  questionText?: (element: Element) => string;
}

/** 数据同意页（D7）此刻的样子：规则声明的表与居住地下拉（活元素，只在本地、不序列化）。 */
export interface ConsentGateReading {
  readonly form: Element;
  /** 规则声明的居住地下拉；没声明、找不到、不是 `<select>`、不在那张表里都是 null。 */
  readonly residence: HTMLSelectElement | null;
  /** 同一张表、同一个下拉此刻仍是规则认的那一个（写之前再问一次）。 */
  readonly isCurrent: () => boolean;
  /**
   * 那张表里提交得了它的控件（`button[type=submit]`、表里没写 type 的 `<button>`、`input[type=submit|image]`）。网站把一份
   * 条款摆出来、要人点「Accept」时，它们才出现（Jobvite：选了非默认的那一份之后）。只交出来给调用方量看不看得见——插件
   * 这一版不按它们。
   */
  readonly submitControls: () => readonly Element[];
}

/** A single intended write, resolved against the user's profile. */
interface ApplyPlanEntryBase {
  /**
   * The host marked this field required. Carried into the plan so the panel
   * can show a *denominator* ("3/7 required fields handled") instead of a bare
   * count. 竞品调研 2026-08-01：Jobright 的 `19/21` 量的正是当前表单的必填数，
   * 而我们此前只有 `3 可填 / 4 待复核` 这种没有分母的平铺计数——用户看不出
   * 还差多少才能提交。
   */
  required: boolean;
  key: ApplyEntryKey;
  /** 从描述符原样带过来：runner 据此选写入通路。 */
  writeMode?: 'setValue' | 'typed';
  label: string;
  value: string;
  confidence: number;
  /**
   * 仅 select 条目携带：计划期判决出的**将选中项的可见文字**（CAP-AF-044）。
   * 预览显示它，用户在写入前就能看到我们打算选什么；写入期仍重匹配。
   */
  resolvedOptionText?: string;
  /**
   * 扫描序号。审计面板要把「计划内」与「被跳过」两个数组重新合成**一份按表单
   * 顺序排列**的镜像列表；两边都带同一把序号，合并就是一次纯数字排序，内核
   * 不必碰 `compareDocumentPosition` 这类 DOM API（RULE-KERNEL-DETERMINISTIC-BOUNDARY）。
   */
  order: number;
  /** Recomputed against the live ScanRoot immediately before the write. */
  signature: FieldSignature;
  /**
   * 以用户的名义代填的那一类（dict/signOnBehalf.ts）。有它的条目在写入前还要过一道：策略里
   * `sign-on-behalf` 仍开着、用户的同意仍成立；勾选框在点击当下还要重判一次文字仍是这一类。
   */
  signOnBehalf?: SignOnBehalfKind;
  /**
   * 以用户名义代填的那一格，题面自己说不出替他同意了什么、是选项那句话说的（2026-10-04：Ashby 把短信同意放在电话栏里，
   * 题面是「Phone」，同意的是选项「Yes - I consent to receiving text messages」）：那句话。审计视图拿它当这一行的标题，
   * 浮层「已按你的授权代填」里写的就是替他同意了的那句话，不是借来的「Phone」。只给显示用，不参与任何判断。
   */
  signedWording?: string;
  /**
   * 工作授权／担保的答案是按岗位地点**推断**出国家的（题目没点名国家，P1-7）：那个国家的 ISO 码。
   * 2026-09-23 起这一档也直接写，浮层据此写明「按岗位地点（X）推断」，提交前看得见依据。
   */
  inferredRegionCode?: string;
  /**
   * 工作授权／担保的答案是**按默认答**的（2026-09-24 负责人决定，与 Jobright 一致）：说得出是哪一国，他有别国的
   * 工作许可记录、唯独没有这一国的——有权工作答「是」、要不要担保答「否」。那一国的 ISO 码；浮层据此写明
   * 「你的资料里没有在 X 工作的许可记录，默认答了…」，请他提交前核对。
   */
  defaultedRegionCode?: string;
  /**
   * 答案是按学历／工作经历**推出来**的（2026-09-24，dict/historyAnswers.ts）：年满 18（档案里没有明确的值）、
   * 「在这家公司工作过吗」（经历里有没有这家）。稳定码，浮层据此写明依据。
   */
  historyBasis?: HistoryAnswerBasis;
}

/**
 * Value-only, immutable verdict from a bounded combobox preview transaction.
 * It carries no selector or host node and is safe to compare again at write
 * time. The option text itself remains local Data-L1 and must never be logged.
 */
export interface ComboboxOptionHarvest {
  readonly candidates: readonly string[];
  readonly optionTexts: readonly string[];
  readonly optionSetSignature: string;
  readonly resolvedOptionText: string;
}

/** `kind` stays with the plan so runner dispatch is exhaustive by control type. */
type NonComboboxPlanEntry = {
  [Kind in Exclude<ApplyControlKind, 'combobox'>]: ApplyPlanEntryBase & {
    kind: Kind;
    element: ApplyElementByKind[Kind];
  } & (Kind extends 'richtext'
    ? { plainTextContenteditableAttestation: PlainTextContenteditableAttestation }
    : Kind extends 'choice'
      ? { choice: ChoiceGroupShape }
      : Kind extends 'select'
        ? {
            /**
             * 通用路（2026-09-28）：这个原生下拉藏起来了，人操作的是紧跟着它的那个 ARIA 触发器（jQuery UI
             * selectmenu、bootstrap-select）。有它，runner 就点那个触发器、在它自己的面板里选，读回原生下拉的
             * 选中项（write/ariaComboboxGeneric.ts）；写前按同一个判据再认一次，认不回来不写。
             */
            selectProxy?: HTMLElement;
          }
        : Kind extends 'file'
          ? {
              /** 规则声明的上传部件（2026-09-28）：宿主列出的那一项带着「传好了」的标记，才算它确认收下了这一份。 */
              upload?: FileUploadBinding;
            }
          : Record<never, never>);
}[Exclude<ApplyControlKind, 'combobox'>];

export type ApplyPlanEntry =
  | NonComboboxPlanEntry
  | (ApplyPlanEntryBase & {
      kind: 'combobox';
      element: ApplyElementByKind['combobox'];
      /** Exact selector-free authority carried from the reviewed scan. */
      semanticAuthority?: ComboboxSemanticAuthority;
      listbox?: ListboxComboboxBinding;
      /**
       * Rule-declared multi-value widget: every candidate is a value to select — unless
       * `singlePick` says the candidates are spellings of one answer.
       */
      multiple?: boolean;
      /**
       * 多选部件上的**一个**答案（2026-09-24）：`comboboxCandidates` 是同一个答案的几种写法（阶梯：按序试，
       * 第一个在菜单上恰好命中一项的胜出），不是要逐个选上的几项。档案键、自我认同、工作授权这类单值答案
       * 落在多选部件上时由引擎标上；审阅面板、记住的答案、AI 按行给出的多选答案才是「每一行一项」，不带它。
       */
      singlePick?: true;
      /** Ordered profile candidates sealed into the reviewed plan. */
      comboboxCandidates: readonly string[];
      /** Optional stable preview verdict; writer revalidates it byte-for-byte. */
      comboboxHarvest?: ComboboxOptionHarvest;
      /**
       * 电话国际区号的搜索式单选（2026-09-28 Workday「Country Phone Code」）：号码自己写明的那个区号。只有带着它的
       * 那一项才是答案；`comboboxCandidates` 是「居住国 (+区号)」的几种写法（write/searchPrompt.ts 的
       * `fillCallingCodePrompt`）。
       */
      callingCode?: string;
    });

/** Everything the user is shown BEFORE any write happens. */
export interface ApplyPlan {
  vendor: ApplyVendor;
  /**
   * Opaque per-preview nonce. It deliberately contains no label, selector, or
   * profile value, but binds a Fill gesture to the exact preview the user saw.
  */
  fingerprint: string;
  /** Preserve the preview's overwrite policy for the write-time value recheck. */
  fillEmptyOnly: boolean;
  entries: ApplyPlanEntry[];
  /**
   * Fields we found but will not fill, with the reason.
   *
   * `element` 与 `order` 是审计面板的两个必需品：前者让「跳过」的行也能
   * [locate] 回宿主字段（否则用户被告知"这一栏要你自己填"却找不到它在哪），
   * 后者让它与 `entries` 合并成一份按表单顺序的镜像列表。
   */
  skipped: Array<{
    label: string;
    reason: ApplyErrorCode;
    required: boolean;
    /**
     * 认出来的 canonical 档案键；认不出的字段是 null。
     *
     * 两个消费方都需要它：NEEDS_USER_INPUT 的三分要靠它判断"这问题能不能在
     * chat 里问一次、答案存回档案"（没有键就存不回去，只能推回页面），
     * 审计面板的 [仍然填] 也要靠它知道该往哪一栏写什么。
     */
    key: ApplyEntryKey | null;
    /**
     * 预填的**建议选项原文**，只在 `reason === 'PREFILLED_NEEDS_CONFIRMATION'`
     * 时出现。
     *
     * 带的是页面上那一项的原文而不是档案里的枚举值：下游 `chosenOptions` 用精确
     * 文本匹配，而 EEO 与工作授权的选项措辞是法定的（CC-305 三项由 OFCCP 规定
     * 字句）。让面板拿着原文去预选，两边就不会各自再翻译一次、也不会翻译出两种
     * 结果。
     *
     * 它**不是**一次写入：条目仍在 skipped 里，写入要等用户在面板上放行。
     * 2026-09-21 起只剩**推断出来的**答案走这一档（题目没点名国家、按岗位地点推的工作授权）：
     * 用户在档案里亲手填并保存的值（EEO、点名国家的工作授权、居住地、恰好一条的推荐人）
     * 视同已经同意，直接进 entries 写入——他填写并保存的那一下就是确认。
     */
    prefill?: string;
    /**
     * `prefill` 是按岗位地点推断出的国家答的（P1-7）：题目没点名国家，调用方从申请卡片解出了
     * 恰好一个国家码。面板据此写明「按岗位地点 X 推断」——推断出来的值照旧要用户点头。
     */
    inferredRegionCode?: string;
    /** `prefill` 是推荐人姓名（P1-9），这是那条记录里的公司——面板写明「来自你保存的推荐人（X）」。 */
    referralCompany?: string;
    /**
     * 工作授权题说得出是哪一国（题目点名、或按岗位地点推断），而用户在那一国没有工作许可记录（2026-09-24）：
     * 那一国的 ISO 码。只在 `JOB_DEPENDENT` 上出现；面板据此照实说「你的资料里没有在 X 工作的许可记录」。
     * 他有别国的记录时按默认答（条目带 `defaultedRegionCode`），所以这一格只剩两种情形：他一条记录都没有，
     * 或默认答案在页面上落不下（不是选项控件、没有对得上的选项）。
     */
    regionWithoutRecord?: string;
    element: Element;
    order: number;
  }>;
}

/**
 * A value a several-value widget did not receive, with its stable reason (2026-09-24, Workday Skills:
 * `ABORTED` = the widget's search budget ran out before it was reached; `AMBIGUOUS_OPTION`,
 * `NO_OPTION_MATCH`, `WIDGET_TIMEOUT`, `NOT_EMPTY` as for any field). Shown to the user in the dock
 * only; receipts and telemetry carry stable codes, never these values.
 */
export interface NotAddedValue {
  readonly value: string;
  readonly reason: ApplyErrorCode;
}

/** Outcome of one write, for the review list and Undo. */
export type ApplyWriteResult =
  | {
      key: ApplyEntryKey;
      label: string;
      ok: true;
      /**
       * 我们做了动作，但**没能读回确认**。
       *
       * 只有一种情形会带上它：文件写入之后宿主把那个 `<input type=file>` 卸掉
       * 或换掉，只在字段上留下一个文件名 chip（Greenhouse / Dover 实测形状）。
       * 文件确实交出去了，但已经没有可读的控件状态可比对。
       *
       * 控件还在的时候**不带它**——文件控件的回读是 `input.files` 的对象同一性
       * （write/setFile.ts `hasExactFile`），读得到就是读回确认过了。2026-09-17
       * 之前这里对两种情形一律盖章，Ashby 上 89 条已经填好的必填简历栏因此被
       * 算成"还没办完"。combobox 不再使用此兼容标记；缺 semantic readback 或
       * semantic Undo proof 时它零点击失败。
       *
       * 面板必须把它与读回确认过的成功**区别显示**，否则"点了但没生效"和
       * "确认填入"在屏幕上长得一模一样。
       */
      unverified?: true;
      /** A several-value widget that took only some of its values: the ones it did not take. */
      notAdded?: readonly NotAddedValue[];
    }
  | { key: ApplyEntryKey; label: string; ok: false; reason: ApplyErrorCode; notAdded?: readonly NotAddedValue[] };

/**
 * Export-safe diagnostic snapshot for a local apply session. It intentionally
 * carries aggregate state and stable codes only: host labels, profile values,
 * URLs, and selectors must remain inside the local session/UI boundary.
 */
export interface ApplyDiagnostic {
  readonly schemaVersion: 1;
  readonly vendor: ApplyVendor;
  readonly policyVersion: string;
  readonly attempted: number;
  readonly filled: number;
  readonly byCode: Readonly<Partial<Record<ApplyErrorCode, number>>>;
  /** Compile-time tripwires: diagnostics must never grow an L1-bearing field. */
  readonly label?: never;
  readonly value?: never;
  readonly url?: never;
  readonly selector?: never;
}

/** Exhaustive switches over a discriminated apply boundary must never default. */
export function assertNever(value: never, context: string): never {
  throw new Error(`apply: unhandled variant in ${context}: ${String(value)}`);
}
