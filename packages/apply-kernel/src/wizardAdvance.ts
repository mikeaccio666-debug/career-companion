/**
 * 多页申请的「下一步」：找出宿主页上**唯一一颗**可以替用户按下去的翻页按钮。
 *
 * 2026-09-22 负责人决定：「如果 ats 页面是要有第二页第三页很多页的，就要在插件里可以给
 * 用户点击 continue 到下一页」。所以浮层里多一颗「继续到下一页」——用户按我们的，我们按
 * 宿主的那一颗。Workday 的申请是五六步的向导（My Information → My Experience →
 * Application Questions → Voluntary Disclosures → Self Identify → Review），每一步底部都是
 * 同一颗 `Save and Continue`，浮层展开时正好压在它上面。
 *
 * 判据来自 ATS 实验台的 `labNavigator.ts`（2026-09-15，用它在真实 Workday 上一步步量过），
 * 搬进内核时收紧了三处——实验台是量东西的，这里是替真人按按钮：
 *
 *  · **名字整句对上一张闭集**（Next / Continue / Save and Continue / 下一步 …），不是
 *    「以 next 开头」。`Continue with LinkedIn` 是登录，`Accept and Continue` 是同意，
 *    `Continue to Submit` 是提交，三个都以 continue 开头。
 *  · **每一个名字来源都得在闭集里**：aria-label、按钮上的字、value。一个说 Next、
 *    一个说 Submit 的按钮，不按。
 *  · **全页恰好一颗**。实验台取第一颗；这里零颗、两颗都不按——猜错的代价是替用户按了一颗
 *    他没看见的按钮。
 *
 * 结构上必须**提交不了任何表单**：`type=button`；或者没写 type 但不属于任何 `<form>`
 * （Workday 的 `pageFooterNextButton` 正是这样，2026-09-22 nvidia.wd5 实测：没有 type、
 * 页面上没有 `<form>`）；或者作者声明了 `role=button` 的非链接元素。`type=submit`、属于某张
 * 表的隐式提交按钮、`<a href>`、`role=link` 一律不要。最终提交因此从两头都进不来：名字闭集
 * 里没有 submit / apply / send / finish，结构上提交得了表单的也不是候选（RULE-EXT-NEVER-SUBMIT）。
 *
 * 本模块只读 DOM，不点任何东西，也不碰布局（RULE-KERNEL-DETERMINISTIC-BOUNDARY）：可见性由
 * 调用方量好交进来；点是内容脚本的事，而且只在用户按下我们浮层里那颗按钮的当下、按之前
 * 再找一次。这里没有任何一家厂商的选择器（RULE-GLOBAL-DOM-RULE-BOUNDARY）——闭集是通用的
 * 按钮措辞，与 `click/policy.ts` 的 SUBMIT_NAME 同一类知识。
 */

import type { ScanRoot } from './contracts.ts';
import { CHALLENGE_CONTAINER_SELECTOR, CREDENTIAL_SELECTOR } from './gate/pageVeto.ts';

/**
 * 翻页按钮上允许出现的全部说法（归一化之后逐字比较）。
 *
 * 只收「去下一步」这一个意思。`Review` / `Continue to review` 不收：有的宿主在那一步之后
 * 就是提交页，有的直接就是提交——判不准的一律不按，交给用户自己点。
 */
const NEXT_NAMES: ReadonlySet<string> = new Set([
  'next',
  'next step',
  'next page',
  'continue',
  'continue to next step',
  'continue to next page',
  'continue to the next step',
  'continue to the next page',
  'save and continue',
  'save & continue',
  'save and next',
  'save & next',
  'proceed',
  'proceed to next step',
  'proceed to the next step',
  '下一步',
  '下一页',
  '继续',
  '保存并继续',
]);

/** 按钮尾部常见的装饰箭头。只剥尾部：开头带箭头的是「上一步」的样子。 */
const TRAILING_ARROWS = /[\s›»→>▶►❯⟩]+$/u;

/** 自己有激活行为、或者会把激活转给别的控件的元素：它们即使声明了 role=button 也不算。 */
const NOT_A_PLAIN_BUTTON = new Set([
  'a', 'area', 'label', 'summary', 'details', 'select', 'option', 'optgroup', 'textarea',
  'form', 'fieldset', 'iframe', 'object', 'embed',
]);

const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

export type WizardNextRefusal =
  /** 页面上没有一颗能安全替用户按的翻页按钮（最后一步是 Submit 时就是这样）。 */
  | 'NEXT_STEP_NONE'
  /** 不止一颗，不知道该按哪颗。 */
  | 'NEXT_STEP_AMBIGUOUS'
  /** 读页面时抛了异常：按「没有」处理，不猜。 */
  | 'NEXT_STEP_UNREADABLE';

export interface WizardNextControl {
  readonly element: Element;
  /** 宿主按钮上的字（去掉多余空白与尾部箭头），给用户看我们要按的是哪一颗。 */
  readonly label: string;
}

export type WizardNextResult =
  | Readonly<{ ok: true; value: WizardNextControl }>
  | Readonly<{ ok: false; code: WizardNextRefusal }>;

export interface FindWizardNextInput {
  readonly document: Document;
  /**
   * 这一页扫描认出的字段元素。按钮在对话框里时，那个对话框必须装着其中至少一个——
   * 否则它是 cookie 横幅、登录弹窗之类，与这张申请表无关。
   */
  readonly formElements: readonly Element[];
  /** 调用方量的可见性（算样式与尺寸）。kernel 不碰布局，缺了这份证明就当看不见。 */
  readonly isVisible: (element: Element) => boolean;
  /** 永远不是候选的元素，例如规则声明的最终提交控件。它自己、它的祖先与后代都不要。 */
  readonly refuse?: readonly Element[];
}

/** 归一化一段按钮文字：NFKC、合并空白、剥尾部箭头、小写。 */
export function normalizeControlName(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().replace(TRAILING_ARROWS, '').trim().toLowerCase();
}

function displayName(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().replace(TRAILING_ARROWS, '').trim();
}

/** 一颗按钮的全部名字来源。title 不算：那是说明，不是按钮上写的字。 */
function nameSources(element: Element): string[] {
  const sources: string[] = [];
  const aria = element.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') sources.push(aria);
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null && labelledBy.trim() !== '') {
    const text = labelledBy.trim().split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    // 指向了却读不出字，等于名字来源不明：放一个闭集外的值，让它落选。
    sources.push(text.trim() === '' ? '\u0000' : text);
  }
  const text = element.textContent ?? '';
  if (text.trim() !== '') sources.push(text);
  if (element.tagName.toLowerCase() === 'input') {
    const value = (element as HTMLInputElement).value;
    if (typeof value === 'string' && value.trim() !== '') sources.push(value);
  }
  return sources;
}

/** 名字全部落在闭集里时，返回给用户看的那一种写法；否则 null。 */
function nextLabelOf(element: Element): string | null {
  const sources = nameSources(element);
  if (sources.length === 0) return null;
  for (const source of sources) {
    if (!NEXT_NAMES.has(normalizeControlName(source))) return null;
  }
  // 优先用按钮上看得见的字：用户在宿主页上认的是它。
  const text = element.textContent ?? '';
  return displayName(text.trim() !== '' ? text : sources[0]!);
}

/** 属于某张 `<form>`：祖先里有，或者用 form 属性指向了一张（指向哪张都算，按「有」处理）。 */
function hasFormOwner(element: Element): boolean {
  if (element.closest('form') !== null) return true;
  const formAttribute = element.getAttribute('form');
  if (formAttribute !== null && formAttribute.trim() !== '') return true;
  const native = (element as { form?: unknown }).form;
  return native !== undefined && native !== null;
}

/** 按下去在浏览器层面提交不了任何表单、也不会导航。 */
function structurallyInert(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'a' || element.hasAttribute('href')) return false;
  const role = (element.getAttribute('role') ?? '').trim().toLowerCase();
  if (role === 'link') return false;
  if (tag === 'button') {
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
    if (type === 'button') return true;
    if (type === 'submit' || type === 'reset') return false;
    // 没写 type、或写了个浏览器不认的值，就是 submit 状态：只要属于某张表，按下去就提交它。
    return !hasFormOwner(element);
  }
  if (tag === 'input') return (element.getAttribute('type') ?? '').trim().toLowerCase() === 'button';
  if (role !== 'button' || NOT_A_PLAIN_BUTTON.has(tag)) return false;
  // 自己没有激活行为的 role=button，里面也不能包着有激活行为的东西。
  return element.querySelector('button, input, a[href], select, textarea') === null;
}

function enabled(element: Element): boolean {
  if ((element as { disabled?: unknown }).disabled === true || element.hasAttribute('disabled')) return false;
  if ((element.getAttribute('aria-disabled') ?? '').trim().toLowerCase() === 'true') return false;
  return element.closest('fieldset[disabled]') === null;
}

function markedHidden(element: Element): boolean {
  return element.closest('[hidden], [inert], [aria-hidden="true"]') !== null;
}

function inForeignDialog(element: Element, formElements: readonly Element[]): boolean {
  const dialog = element.closest(DIALOG);
  return dialog !== null && !formElements.some((field) => dialog.contains(field));
}

function refused(element: Element, refuse: readonly Element[] | undefined): boolean {
  return (refuse ?? []).some((other) => other === element || other.contains(element) || element.contains(other));
}

/**
 * 找这一页上唯一一颗可以替用户按下去的翻页按钮。
 *
 * 每次都从头找，不缓存：宿主随时会重渲染底栏，上一次找到的节点可能已经不是这一颗。
 */
export function findWizardNextControl(input: FindWizardNextInput): WizardNextResult {
  try {
    let found: WizardNextControl | null = null;
    const seen = new Set<Element>();
    for (const element of Array.from(input.document.querySelectorAll('button, input, [role="button"]'))) {
      if (seen.has(element)) continue;
      seen.add(element);
      // 输入框只看 type=button 的那种。文本框的 value 是用户填的资料（Data-L1），连读都不读。
      if (element.tagName.toLowerCase() === 'input' &&
          (element.getAttribute('type') ?? '').trim().toLowerCase() !== 'button') continue;
      // 先比名字：页面上绝大多数按钮在这一步就落选，后面的结构与可见性不必再算。
      const label = nextLabelOf(element);
      if (label === null) continue;
      if (!structurallyInert(element) || !enabled(element) || markedHidden(element)) continue;
      if (inForeignDialog(element, input.formElements) || refused(element, input.refuse)) continue;
      if (input.isVisible(element) !== true) continue;
      if (found !== null) return { ok: false, code: 'NEXT_STEP_AMBIGUOUS' };
      found = Object.freeze({ element, label });
    }
    return found === null ? { ok: false, code: 'NEXT_STEP_NONE' } : { ok: true, value: found };
  } catch {
    return { ok: false, code: 'NEXT_STEP_UNREADABLE' };
  }
}

/** 判断「这一步还在不在」时看的控件：与扫描器认的是同一类东西。 */
const STEP_CONTROLS = 'input, select, textarea, button, [role="combobox"], [role="textbox"], [contenteditable="true"]';

const sameLabel = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

export interface ScannedStep {
  /** 上一次扫描认出的字段：元素与它的标签。 */
  readonly fields: readonly Readonly<{ element: Element; label: string }>[];
  /** 同一次扫描的根，用来找「同名标签的新控件」。 */
  readonly root: ScanRoot;
}

/**
 * 上一次扫描认出的那一步，是不是已经整个不在页面上了。
 *
 * 判据刻意偏保守，宁可晚说「换页了」，也不在同一页上误判：
 *
 *  · 任何一个原字段元素还连在页面上 → 还是这一步。
 *  · 原元素全断开了，但页面上还有**同名标签**的控件 → 宿主只是把控件重挂载了一遍，
 *    还是这一步。Workday 在失焦时会把输入框整个换掉（#63 实测），填完一整页之后，
 *    原来的文本框可能一个都不剩——只看元素会把「刚填完」误判成「翻页了」。
 *  · 一个字段都没有 → 没有依据，永远不说换页。
 */
export function scannedStepGone(step: ScannedStep): boolean {
  try {
    if (step.fields.length === 0) return false;
    if (step.fields.some((field) => field.element.isConnected)) return false;
    const present = new Set<string>();
    for (const control of step.root.querySelectorAll(STEP_CONTROLS)) {
      if (!control.isConnected) continue;
      const label = sameLabel(step.root.labelTextFor(control));
      if (label !== '') present.add(label);
    }
    return !step.fields.some((field) => {
      const label = sameLabel(field.label);
      return label !== '' && present.has(label);
    });
  } catch {
    // 读不出来就不下结论：「换页了」会把用户的审计面板收掉，说错比不说更糟。
    return false;
  }
}

// ── 连填要从页面上读的两件事（2026-09-28）─────────────────────────────────────
//
// 一次「自动填写」连着往下填（负责人 2026-09-28 的决定）：浮层要说「第 2 页，共 5 页：正在填「My Experience」」，
// 也要在网站弹出只能本人处理的关卡时停下。两件都是通用的读法：只认公开的说法（ARIA、读屏文字、密码框、一次性验证码框、
// 几家验证码服务自己的挑战页地址），不认任何一家招聘网站的 DOM（RULE-GLOBAL-DOM-RULE-BOUNDARY）。只读、不碰布局——
// 可见性照旧由调用方量好交进来。读出来的字只进本机的浮层，不进日志、遥测与任何意图。

export interface WizardProgress {
  /** 网站说的这一步是第几步（从 1 数）；说不出就是 null。 */
  readonly index: number | null;
  /** 一共几步；说不出就是 null。 */
  readonly total: number | null;
  /** 这一步叫什么（网站上的原文，合并了空白）；说不出、或长得不像一个步骤名，就是 null。 */
  readonly name: string | null;
}

/** 「Step 3 of 6: Questions」「current step 2 of 5 My Experience」：第几步、共几步，后面跟着的是名字。 */
const STEP_PHRASE = /^(?:current\s+)?step\s+(\d{1,2})\s+(?:of|\/)\s+(\d{1,2})(?:\s*[:：,，.。\u2013\u2014-]\s*|\s+|$)(.*)$/iu;
/** 读屏文字里「当前这一步」的说法。只认 current：completed step / step 3 of 5 说的是别的几步。 */
const CURRENT_STEP_PHRASE = /^current\s+step\s+(\d{1,2})\s+of\s+(\d{1,2})(?:\s+(.*))?$/iu;
const MAX_STEP_NAME = 80;
const MAX_STEPS = 20;
/** 读屏文字那一路最多看多少个文字节点：一页申请表远到不了这个数，到了就不再看（说不出就不说）。 */
const TEXT_NODE_BUDGET = 20_000;

const tidy = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

function stepName(text: string): string | null {
  const name = tidy(text);
  return name === '' || name.length > MAX_STEP_NAME ? null : name;
}

function progressOf(index: number | null, total: number | null, name: string | null): WizardProgress | null {
  if (index !== null && total !== null && (total < 2 || total > MAX_STEPS || index < 1 || index > total)) return null;
  if (index === null && total === null && name === null) return null;
  return Object.freeze({ index, total, name });
}

const shownIn = (isVisible: (element: Element) => boolean) => (element: Element): boolean =>
  element.closest('[hidden], [inert]') === null && isVisible(element) === true;

/** ARIA：唯一一个看得见的 `aria-current="step"`。 */
function progressFromAria(document: Document, shown: (element: Element) => boolean): WizardProgress | null | 'NONE' {
  const current = Array.from(document.querySelectorAll('[aria-current="step"]')).filter(shown);
  if (current.length === 0) return 'NONE';
  if (current.length > 1) return null;
  const element = current[0]!;
  const text = tidy(element.textContent ?? '');
  const phrase = STEP_PHRASE.exec(text);
  if (phrase !== null) return progressOf(Number(phrase[1]), Number(phrase[2]), stepName(phrase[3] ?? ''));
  const item = element.closest('li');
  const list = item?.parentElement ?? null;
  if (item !== null && list !== null && (list.tagName === 'OL' || list.tagName === 'UL')) {
    const items = Array.from(list.children).filter((child) => child.tagName === 'LI');
    return progressOf(items.indexOf(item) + 1, items.length, stepName(text));
  }
  return progressOf(null, null, stepName(text));
}

/** 读屏文字：页面上唯一一处看得见的「current step N of M」。 */
function progressFromText(document: Document, shown: (element: Element) => boolean): WizardProgress | null {
  const body = document.body;
  if (body === null) return null;
  const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  const found: { element: Element; own: string; index: number; total: number; rest: string }[] = [];
  for (let seen = 0; seen < TEXT_NODE_BUDGET && walker.nextNode() !== null; seen += 1) {
    const node = walker.currentNode;
    const element = node.parentElement;
    if (element === null || element.closest('script, style, noscript, template') !== null) continue;
    const own = tidy(node.nodeValue ?? '');
    const match = CURRENT_STEP_PHRASE.exec(own);
    if (match === null || !shown(element)) continue;
    found.push({ element, own, index: Number(match[1]), total: Number(match[2]), rest: match[3] ?? '' });
    if (found.length > 1) return null;
  }
  const only = found[0];
  if (only === undefined) return null;
  if (only.rest !== '') return progressOf(only.index, only.total, stepName(only.rest));
  // 读屏文字与步骤名分在两个节点里（<label>current step 2 of 5</label><div>My Experience</div>）：取同一格里的其余文字。
  const whole = tidy(only.element.parentElement?.textContent ?? '');
  const name = whole.startsWith(only.own) ? whole.slice(only.own.length) : whole.replace(only.own, '');
  return progressOf(only.index, only.total, stepName(name));
}

/**
 * 网站自己说的「第几步、共几步、这一步叫什么」。先看 ARIA，再看读屏文字；两处都说不清（没有、不止一处、数不对）就是 null，
 * 浮层照旧只写「第 N 页」。只用来给人看，不参与任何判断。
 */
export function readWizardProgress(input: Readonly<{
  document: Document;
  isVisible: (element: Element) => boolean;
}>): WizardProgress | null {
  try {
    const shown = shownIn(input.isVisible);
    const aria = progressFromAria(input.document, shown);
    return aria === 'NONE' ? progressFromText(input.document, shown) : aria;
  } catch {
    // 只是给人看的一行字：读不出就不说，不影响填写与翻页的任何判断。
    return null;
  }
}

/** 只能本人处理的关卡：登录（密码框）、验证码、人机验证。 */
export type HumanCheckpoint = 'LOGIN' | 'VERIFICATION' | 'CAPTCHA';

const ONE_TIME_CODE_SELECTOR = 'input[autocomplete="one-time-code"]';

/**
 * 人机验证的**挑战框**（验证码服务自己的地址，通用知识）：reCAPTCHA 的 bframe、hCaptcha 的 challenge 帧、Arkose。
 * 勾选框与隐形验证码的角标（anchor、frame=checkbox）不算——它们常年挂在正常的申请表上；网站真要他过验证时才弹挑战框。
 */
const CHALLENGE_FRAMES: readonly RegExp[] = [
  /^https:\/\/(?:www\.)?(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/bframe/iu,
  /^https:\/\/(?:[a-z0-9-]+\.)*hcaptcha\.com\/captcha\/[^#]*#(?:[^#]*&)?frame=challenge(?:&|$)/iu,
  /^https:\/\/(?:[a-z0-9-]+\.)*arkoselabs\.com\//iu,
];

/**
 * 此刻页面上有没有只能本人处理的关卡。连填（2026-09-28）翻页之前、翻完之后都问一次：有就停下，照实说要他做什么
 * （RULE-GLOBAL-HUMAN-AUTHORIZATION：验证码、人机验证、账号与密码始终由本人完成）。只看**看得见**的：收着的登录弹层、
 * 还没触发的挑战框常年挂在页面上。读页面时抛了异常就照抛——调用方把「说不清」当作停下。
 */
export function detectHumanCheckpoint(input: Readonly<{
  document: Document;
  isVisible: (element: Element) => boolean;
  /**
   * 账号墙那一路（2026-09-28，替他注册、登录）：密码框就是那一页本身，不算关卡——只看验证码与人机验证。不给就照旧：
   * 看得见的密码框算「要他登录」，而且排在最前。
   */
  ignoreLogin?: boolean;
}>): HumanCheckpoint | null {
  const shown = shownIn(input.isVisible);
  const any = (selector: string): boolean => Array.from(input.document.querySelectorAll(selector)).some(shown);
  if (input.ignoreLogin !== true && any(CREDENTIAL_SELECTOR)) return 'LOGIN';
  if (any(ONE_TIME_CODE_SELECTOR)) return 'VERIFICATION';
  if (any(CHALLENGE_CONTAINER_SELECTOR)) return 'CAPTCHA';
  for (const frame of Array.from(input.document.querySelectorAll('iframe[src]'))) {
    const src = frame.getAttribute('src') ?? '';
    if (CHALLENGE_FRAMES.some((pattern) => pattern.test(src)) && shown(frame)) return 'CAPTCHA';
  }
  return null;
}

/**
 * 申请、提交这两类按钮上的说法（归一化之后逐字比较）。只给「浮层别盖住它」用，从来不是按的依据——按什么由
 * `findWizardNextControl` 与规则声明的最终提交控件决定。
 */
const PRIMARY_ACTION_NAMES: ReadonlySet<string> = new Set([
  'apply',
  'apply now',
  'apply for this job',
  'apply for this position',
  'apply for this role',
  'apply to this job',
  'submit',
  'submit application',
  'submit your application',
  'submit my application',
  'send application',
  'review',
  'review application',
  'finish',
  '申请',
  '立即申请',
  '提交',
  '提交申请',
]);

/** 浮层自动打开前最多看这么多颗（页面再大也只看前面这些）。 */
const PRIMARY_ACTION_BUDGET = 400;

/**
 * 网站自己的主要操作按钮：写明了的提交控件（`button[type=submit]`、`input[type=submit|image]`），以及名字整句是申请、提交、
 * 下一步的按钮或链接（2026-10-04）。给浮层自动打开时避让用：面板要占的那一条里有它们，
 * 面板就让开或先不开（bench-1003：BambooHR 的「Apply for This Job」、Greenhouse 的「Submit application」、Workday 的
 * 「Save and Continue」被自动打开的浮层盖住）。只读、通用措辞，不点、不认任何一家的 DOM；可见性由调用方量。
 */
export function sitePrimaryActions(input: Readonly<{
  document: Document;
  isVisible: (element: Element) => boolean;
}>): Element[] {
  const found: Element[] = [];
  let candidates: Element[];
  try {
    candidates = Array.from(input.document.querySelectorAll('button, input[type="submit"], input[type="image"], input[type="button"], [role="button"], a[href]'))
      .slice(0, PRIMARY_ACTION_BUDGET);
  } catch {
    return found;
  }
  for (const element of candidates) {
    try {
      if (!enabled(element) || markedHidden(element)) continue;
      if (!submitsForm(element) && !namedPrimaryAction(element)) continue;
      if (!input.isVisible(element)) continue;
      found.push(element);
    } catch {
      // 读不动这一颗：当没有。
    }
  }
  return found;
}

/**
 * 写明了是提交控件：`input[type=submit|image]`、`button[type=submit]`。表里没写 type 的 `<button>` 虽然也会提交，但网站常拿它
 * 当普通按钮用（Ashby 的「Upload file」、各家的「Add another」）——它们只按名字算（`namedPrimaryAction`），不按结构算，免得把
 * 上传、加一行这类按钮当成要让开的主要按钮（2026-10-04 测试台：Ashby linear 的「Upload file」正在面板那一条里）。
 */
function submitsForm(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
  if (tag === 'input') return type === 'submit' || type === 'image';
  return tag === 'button' && type === 'submit';
}

/** 名字整句是申请、提交或下一步（看得见的字；没有字时看 aria-label 与 value）。 */
function namedPrimaryAction(element: Element): boolean {
  const text = (element.textContent ?? '').trim() !== ''
    ? element.textContent ?? ''
    : element.getAttribute('aria-label') ?? (element as { value?: unknown }).value?.toString() ?? '';
  const name = normalizeControlName(text);
  return name !== '' && (PRIMARY_ACTION_NAMES.has(name) || NEXT_NAMES.has(name));
}
