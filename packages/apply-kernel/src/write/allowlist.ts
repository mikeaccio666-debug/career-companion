/**
 * The one definition of the host-side effects permitted by the autofill
 * exception in CLAUDE.md.  Keeping the list beside the only writer prevents
 * an innocuous-looking caller from inventing a new event sequence.
 */

import type { ApplyControlKind } from '../contracts';
import type { WriteCapability } from '../grant';

/** v1 may write only these host control properties. */
/** v1 may write only these host control properties.
 *  `checked` 于 2026-08-18 补上——铁律 4 原文一直允许这四项，只是此前没有用到它的功能。
 *  唯一写它的地方是 `write/setChecked.ts`（乙档「信息属实」声明）。 */
export const ALLOWED_WRITE_PROPS = ['value', 'selectedIndex', 'checked', 'files'] as const;
export type AllowedWriteProp = (typeof ALLOWED_WRITE_PROPS)[number];

/**
 * v1 may notify the host only with these framework-facing events.
 *
 * `keydown` / `keyup` 于 2026-09-15 显式扩权，**只为规则声明过的 typeahead
 * 触发器**，见下方 `TYPEAHEAD_SEARCH_EVENTS` 与 `dispatchTypeaheadSearchKey`。
 * 扩的是闭集本身而不是在它旁边另开一条私路：本文件开头那句
 * 「Keeping the list beside the only writer prevents an innocuous-looking
 * caller from inventing a new event sequence」——绕开闭集正是它防的那件事。
 *
 * 为什么非扩不可（jobs.lever.co/palantir/ac978161…/apply，2026-09-15 实测）：
 * Lever 的地点框只在 `input` 的 **keydown** 处理器里（去抖 500ms）发起
 * `/searchLocations`；原生 setter + `input` 事件 3.5s 内零建议、零请求，补一对
 * keydown/keyup 后 0.8s 出 5 条。没有键盘事件，这一栏只能永远报手动。
 */
export const HOST_EVENTS = ['input', 'change', 'blur', 'focusout', 'keydown', 'keyup'] as const;
export type HostEventName = (typeof HOST_EVENTS)[number];

/**
 * 补给 typeahead 触发器的最小键盘信封：一对 `keydown`/`keyup`，冒泡、可取消、
 * 非 trusted，`key` 是刚写进去那串查询的最后一个字符。
 *
 * **不逐字符重放**：值已经由 `typeIntoTrigger` 一次写完，再补 N 对按键只是在
 * 骗一个已经不成立的时序，且会把宿主的去抖搜索多打 N-1 次。一对就够——实测
 * 就是一对让 Lever 发出了那一次 `/searchLocations?text=San%20Franc`。
 *
 * **不进 `EVENT_PROFILES`**：那张表是 `satisfies Record<ApplyControlKind, …>`
 * 的全量记录，多一个键会破坏「新增控件种类却忘了申请能力就编译报错」那条保护
 * （与 `TYPED_TAIL_EVENTS` 同一个理由）。而且这对事件**不属于任何一种控件**，
 * 它属于一个规则量过的部件。
 */
export const TYPEAHEAD_SEARCH_EVENTS = [
  'keydown',
  'keyup',
] as const satisfies readonly HostEventName[];

/**
 * 分段日期（WAI-ARIA：`role=group` 里的 `input[role=spinbutton]`）一段的写入信封：**只有** `input`。
 *
 * 不进 `EVENT_PROFILES`，理由与上面那两组相同（那张表是按控件种类的全量记录）。为什么不能用文本框的
 * input → change → blur → focusout（2026-09-24 在 Workday adobe.wd5 的 MM/YYYY 上实测）：这种组件
 * 只在焦点离开整个日期组时把**上一次渲染的状态**提交进表单模型，而 React 18 的更新要到微任务里才落地。
 * 同步派出的 focusout 于是拿旧状态提交、再用旧状态盖掉刚写的那一段——月份显示「06」一瞬间变回「MM」，
 * 模型里只剩「/2021」、页面报 Invalid Date，而回读读的是输入框，一会儿对一会儿错。
 * 所以一段只发 `input`，等它渲染落地，再由 `DATE_SEGMENT_COMMIT_EVENTS` 单独提交一次。
 */
export const DATE_SEGMENT_SECTION_EVENTS = ['input'] as const satisfies readonly HostEventName[];

/**
 * 分段日期的提交：一个冒泡的 `focusout`，在这一段的值**渲染落地之后**派（runner 在两次宿主任务之间派）。
 * 组件看到焦点离开了日期组（焦点本来就不在组里，见 `writeDateSegment` 的前置条件），就把此刻渲染的整个
 * 日期交给表单、并跑一次离开校验。与文本框信封末尾那个 focusout 是同一个事件，差别只在时机。
 */
export const DATE_SEGMENT_COMMIT_EVENTS = ['focusout'] as const satisfies readonly HostEventName[];

/**
 * Event delivery is control-specific. Native selects never receive the blur
 * envelope: a typeahead-like host control can clear an otherwise valid option
 * when it observes blur before its selection settles.
 */
export const EVENT_PROFILES = {
  text: ['input', 'change', 'blur', 'focusout'],
  textarea: ['input', 'change', 'blur', 'focusout'],
  select: ['input', 'change'],
  // 下拉不经过 setValue，因此没有需要我们补发的通知事件：实测 react-select 在
  // 收到我们点中的选项后自己关闭并渲染选中态。补发 input/change 只会多一次
  // 对宿主的作用，却换不到任何东西。
  combobox: [],
  // 实测两家（Lever / Greenhouse）都靠 change 认这个文件；**不发 blur**——
  // 宿主此刻正在跑它自己的简历解析流程，失焦会打断它。
  file: ['change'],
  choice: ['input', 'change'],
  richtext: ['input', 'change', 'blur', 'focusout'],
} as const satisfies Readonly<Record<ApplyControlKind, readonly HostEventName[]>>;

/**
 * 逐字符写入的 `input` 事件载荷。`inputType` 是**闭集**，不接受任意字符串——
 * 它决定宿主的输入掩码把这一下当成插入还是删除，猜错的后果是掩码状态机错乱。
 */
export interface HostInputIntent {
  readonly inputType: 'insertText' | 'deleteContentBackward';
  /** `insertText` 时是那一个字符；删除时按 UI Events 规范为 `null`。 */
  readonly data: string | null;
}

/**
 * The only host-event dispatcher. Native blur does not bubble; focusout is
 * the bubbling counterpart used by delegated validation handlers.
 *
 * `intent` 只改变 `input` 事件的**类与载荷**（`Event` → `InputEvent`），
 * **不改变 type 闭集**——S0 闸门
 * （`tests/s0/apply-host-mutation-allowlist.redgreen.test.ts`）按 `event.type`
 * 判白名单，而 `new InputEvent('input', …).type === 'input'`，原样落在既有闭集内。
 * `HOST_EVENTS` 一个字不改。
 */
export function dispatchHostEvent(
  target: EventTarget,
  type: Exclude<HostEventName, (typeof TYPEAHEAD_SEARCH_EVENTS)[number]>,
  intent?: HostInputIntent,
  onEventCreated?: (event: Event) => void,
): void {
  const bubbles = type !== 'blur';
  const event =
    type === 'blur' || type === 'focusout'
      ? new FocusEvent(type, { bubbles })
      : intent !== undefined && type === 'input'
        ? new InputEvent(type, { bubbles, inputType: intent.inputType, data: intent.data })
        : new Event(type, { bubbles });
  // UA-4 choice-group ownership binds the exact event object before a hostile
  // synchronous listener can emit a same-target/type clone. Other callers omit
  // this hook, so the existing event envelope is unchanged.
  onEventCreated?.(event);
  target.dispatchEvent(event);
}

/**
 * 规则声明过的 typeahead 触发器**唯一**的键盘信封。
 *
 * 独立于 `dispatchHostEvent` 是刻意的：那个函数是每一条写入路径的公共出口，
 * 只要它能派键盘事件，任何一个普通文本框的调用方都能顺手派一下。这个函数
 * 只有一个调用方（`write/typeaheadCombobox.ts`），而那条路径本身就被规则数据
 * （`typeaheadComboboxes` 的 `triggerSelector`）锁在量过的部件上。
 *
 * 事件非 trusted、`bubbles` 且 `cancelable`：宿主的 keydown 处理器挂在 input
 * 上或更外层的委托节点上，两种都要收得到；`cancelable` 是为了让宿主能像对
 * 真实按键那样 `preventDefault`（我们不读返回值，也不因此改变行为）。
 */
export function dispatchTypeaheadSearchKey(trigger: HTMLInputElement, key: string): void {
  for (const type of TYPEAHEAD_SEARCH_EVENTS) {
    trigger.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key }));
  }
}

/**
 * 关掉**我们自己打开的**下拉菜单：WAI-ARIA combobox 的标准 dismiss 键。
 *
 * 为什么必须有这个出口（2026-09-17 批测 + 对
 * jobs.ashbyhq.com/elevenlabs/158034c9…/application 的只读实测，未提交）：
 * Ashby 的地点列表 portal 到 body，一打开，宿主就按 react-aria 的
 * `ariaHideOutside` 给弹层之外的每个 field entry 挂上 `aria-hidden="true"`
 * （当场 22 个）。菜单留在开着的状态，**整张表**对我们就都是 hidden——
 * 隔壁那个完全可写的简历上传框于是被判成 `TARGET_NOT_WRITABLE`。
 * 121 个 posting 的批测里，14 条 resumeFile 全栽在这上面，且与
 * `CHOICE_NO_DATA` 一一对应，对角线之外零。
 *
 * 为什么是 Escape 而不是别的：同一次实测里，把查询清空**不关列表**
 * （aria-expanded / listbox / aria-hidden 三个数一个没变），而 Escape 当场
 * 关上、aria-hidden 归零、同一个控件立刻恢复可写。这是 ARIA 给 combobox
 * 定义的 dismiss 语义，不是某一家的 DOM 知识——所以它落在内核而不是规则数据里。
 *
 * 与 `dispatchTypeaheadSearchKey` 分开写而不是复用：那个是「问宿主要候选」，
 * 这个是「收摊」。两者的调用时机、目标和授权理由都不同，共用一个名字会让
 * 下一个读代码的人以为发 Escape 也能触发搜索。闭集本身没有变宽——仍然只有
 * `keydown` / `keyup` 两种，仍然只有本文件构造 `KeyboardEvent`（S0 闸门按
 * **文件**收窄，见 `tests/s0/apply-host-mutation-allowlist.redgreen.test.ts`）。
 */
export const COMBOBOX_DISMISS_EVENTS = [
  'keydown',
  'keyup',
] as const satisfies readonly HostEventName[];

/** ARIA 给 combobox 定义的 dismiss 键；不接受调用方自带键名。 */
export const COMBOBOX_DISMISS_KEY = 'Escape';

export function dispatchComboboxDismissKey(target: Element): void {
  for (const type of COMBOBOX_DISMISS_EVENTS) {
    target.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, key: COMBOBOX_DISMISS_KEY }),
    );
  }
}

/**
 * 搜索式多选的「搜」键（2026-09-24）：规则声明过的搜索框里，回车才发起搜索。
 *
 * 实测（Workday adobe.wd5 的 Field of Study / Skills，经批准、用自己的测试词）：往框里打字——原生 setter
 * 加 input 事件、再补一对最后一个字符的 keydown/keyup——一行结果都不出；一对 Enter 的 keydown/keyup 之后
 * 才搜。与另外两个键盘出口一样，闭集没变宽（仍是 `keydown` / `keyup`、仍只有本文件构造 `KeyboardEvent`），
 * 键名写死、不接受调用方自带，唯一的调用方是 write/searchPrompt.ts，而那一条路只对规则声明的触发器开，
 * 并且只在触发器**不属于任何 `<form>`** 时才按（合成的按键不会触发浏览器的隐式提交，但宿主自己的
 * keydown 处理器可能把回车当成提交——不属于表单的搜索框没有那张表可交）。
 */
export const SEARCH_PROMPT_SUBMIT_EVENTS = [
  'keydown',
  'keyup',
] as const satisfies readonly HostEventName[];

export function dispatchSearchPromptSubmitKey(trigger: HTMLInputElement): void {
  for (const type of SEARCH_PROMPT_SUBMIT_EVENTS) {
    trigger.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
  }
}

/**
 * Escape 收不起来的菜单，失焦来收：combobox 失去焦点即收起列表，这同样是通用行为而不是
 * 某一家的 DOM 知识。2026-09-23 在 Greenhouse 的 react-select 上实测：合成的 Escape
 * keydown/keyup（连带 keyCode 27）一次都没关上它，每个没选成的下拉因此白等 1.5 秒；
 * 一对 blur/focusout 55ms 内关上，焦点仍留在原处。事件仍在 `HOST_EVENTS` 闭集里，
 * 与逐字符写入的收尾（`TYPED_TAIL_EVENTS`）是同一对。
 */
export const COMBOBOX_DISMISS_BLUR_EVENTS = [
  'blur',
  'focusout',
] as const satisfies readonly HostEventName[];

export function dispatchComboboxDismissBlur(target: Element): void {
  for (const type of COMBOBOX_DISMISS_BLUR_EVENTS) dispatchHostEvent(target, type);
}

/**
 * 逐字符写入的收尾信封 = `EVENT_PROFILES.text` 去掉开头的 `input`
 * （N 个 `insertText` 已经发过，再补一个裸 `input` 是白送宿主一次副作用）。
 *
 * **单列常量、不塞进 `EVENT_PROFILES`**：那张表是
 * `satisfies Readonly<Record<ApplyControlKind, …>>` 的全量记录，多一个键会破坏
 * 「新增控件种类却忘了申请能力就编译报错」那条保护（见下方注释里那次真实事故）。
 */
export const TYPED_TAIL_EVENTS = [
  'change',
  'blur',
  'focusout',
] as const satisfies readonly HostEventName[];

/**
 * 每种控件需要哪一项能力。写成全量记录，是为了让"新增一种控件却忘了申请能力"
 * 变成编译错误——**这个 bug 刚刚真的发生过**：combobox 接进 runner 后，
 * `session.svelte.ts` 仍然只申请 set-text / set-select，于是每一次下拉填充都会
 * 在真实环境里拿到 CAPABILITY_DISABLED，而全部单测照样绿。
 *
 * 与 Lever 那次漏改 policy 是同一个形状：三处登记只改了两处。
 */
export const CAPABILITY_BY_KIND = {
  text: 'set-text',
  textarea: 'set-text',
  select: 'set-select',
  combobox: 'set-combobox',
  file: 'set-file',
  // 单选/复选的**语义**写入位仍与原生 select 同一位：它决定「能不能替用户答这道
  // 单选/复选题」。2026-09-15 起默认的写入手段是原生激活（click），那一位另计，
  // 见下面的 `EXTRA_CAPABILITY_BY_KIND`——两件事要能分开关。
  choice: 'set-select',
  richtext: 'set-richtext',
} as const satisfies Readonly<Record<ApplyControlKind, WriteCapability>>;

/**
 * 主能力位之外还要申请的位。
 *
 * `choice` 自 2026-09-15 起默认用原生激活写入（`write/choiceGroup.ts` 的
 * `fillChoiceGroup`），那是一次宿主 click，因此与下拉共用 `set-combobox` 这一位。
 * 关掉它不会让单选/复选题变成填不上：叶子会回落到属性写入那条老路（只有在
 * 那一下**根本没打起来**时才回落，见 `ACTIVATION_UNAVAILABLE_CODES`）。
 *
 * 写成独立的表而不是把 `CAPABILITY_BY_KIND` 改成「一种控件对应一组位」，
 * 是为了保住那张全量记录的编译期保护：新增一种控件仍然必须显式表态主位。
 */
export const EXTRA_CAPABILITY_BY_KIND = {
  choice: 'set-combobox',
} as const satisfies Readonly<Partial<Record<ApplyControlKind, WriteCapability>>>;

/** 这份计划实际需要的能力集——最小权限：没有下拉也没有单选题就不申请点击。 */
export function capabilitiesForKinds(
  kinds: Iterable<ApplyControlKind>,
): ReadonlySet<WriteCapability> {
  const needed = new Set<WriteCapability>();
  for (const kind of kinds) {
    needed.add(CAPABILITY_BY_KIND[kind]);
    const extra = (EXTRA_CAPABILITY_BY_KIND as Readonly<Partial<Record<ApplyControlKind, WriteCapability>>>)[kind];
    if (extra !== undefined) needed.add(extra);
  }
  return needed;
}
