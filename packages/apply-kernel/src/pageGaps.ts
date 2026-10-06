/**
 * 页面上还空着、还报着错的必填（2026-10-04，bench-1003 第七节第 2 条）。
 *
 * 浮层只看自己认得的那几行。认不出的必填——自己画的单选（Jobvite）、按钮样子的下拉（Rippling 的「Select」）、
 * 签名栏两格（Lever）——从不进单子，于是 Jobvite 上浮层说「这一页填好了」，连填接着替他按了网站的「Next」，
 * 网站当场把四道单选和简历标红（2/8 页）。这里在**页面这一侧**再看一遍：
 *
 *  · `unplanned`：网站自己标了必填（`required`、`aria-required="true"`，或题目头尾的星号、「(required)」）、此刻还空着、
 *    看得见，而这一次扫描**没有**认出来的控件。浮层把它们列进「需要你」，连填看到它们就不翻页。
 *  · `invalid`：网站此刻标着「这一栏不对」的控件（`aria-invalid="true"`）。
 *  · `alerts`：网站在这张表里显示着的报错提示（`role="alert"` 且有字）。
 *
 * 只认公开的说法（原生控件、ARIA、看得见的必填记号），不认任何一家的 DOM（RULE-GLOBAL-DOM-RULE-BOUNDARY）；
 * 只在扫描认出的那张表（`ScanRoot`）里看，规则声明的排除区照旧排除。只读、不碰布局：可见性由调用方量好交进来
 * （RULE-KERNEL-DETERMINISTIC-BOUNDARY）。读出来的题目只进本机的浮层，不进日志、遥测与任何意图（Data-L1）；
 * 也不读任何一栏的值——「空没空」只看有没有。
 *
 * 判据刻意偏保守：说「还空着」要三样都有（网站说必填、看得见、确实空着）；附件栏不看（上传之后宿主常把文件框换成
 * 一个文件名，空不空读不准），密码框与搜索框不看（那是账号与筛选，不是申请表上的题）。读不出题目的照样列（题目是空串，
 * 调用方给一个通用的说法）：网站说它必填、它看得见、它空着，就是还没答的一道题。
 */

import type { ApplyFieldDescriptor, ScanRoot } from './contracts.ts';
import { hasRequiredMarkerAtEdge } from './dict/requiredMarker.ts';
import { labelTextsOf } from './scanRoot.ts';

export interface PageGap {
  /** 「去这一栏」时滚到的那个控件：单选组是第一个选项，按钮式下拉是那颗按钮。 */
  readonly element: Element;
  /** 用户读到的题目（去掉了必填记号）；读不出来就是空串（调用方给一个通用的说法）。 */
  readonly label: string;
}

export interface PageGaps {
  readonly unplanned: readonly PageGap[];
  readonly invalid: number;
  readonly alerts: number;
}

export const NO_PAGE_GAPS: PageGaps = Object.freeze({ unplanned: Object.freeze([]), invalid: 0, alerts: 0 });

export interface ReadPageGapsInput {
  /** 这一页扫描认出的那张表：根与浮层已经在管的那几栏（它们不再算「没认出」）。 */
  readonly form: Readonly<{
    root: ScanRoot;
    fields: readonly ApplyFieldDescriptor[];
    /** 规则声明的题干（`ApplyFormDescriptor.questionText`）：读不出题目时用它。缺省 = 没有。 */
    questionText?: (element: Element) => string;
  }>;
  /** 调用方量的可见性（算样式与尺寸）。kernel 不碰布局。 */
  readonly isVisible: (element: Element) => boolean;
  /** 最多列几项（够他知道还差什么就行）。 */
  readonly limit?: number;
}

/** 一页最多看这么多个控件：申请表远到不了，到了就不再往下看（少说，不错说）。 */
const CONTROL_BUDGET = 600;
const DEFAULT_LIMIT = 20;
const LABEL_MAX = 160;
/** 往上找题目时最多走几层；一层里控件太多就是走到整张表了。 */
const QUESTION_MAX_DEPTH = 6;
const CANDIDATES = [
  'input',
  'select',
  'textarea',
  'button[aria-haspopup="listbox"]',
  '[role="combobox"]:not(input)',
  '[role="radiogroup"]',
  // 网站把「必填」直接标在一颗按钮上（Jobvite 的「Add Resume*」→「Select ▾」）：按钮上还写着占位就是还空着。
  'button[aria-required="true"]',
  '[role="button"][aria-required="true"]',
].join(', ');

/** 题目不是题：密码、搜索、文件、按钮一类的 input 一律不看。 */
const SKIPPED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search', 'range', 'color',
]);

/** 按钮式下拉上「还没选」的那几种说法。 */
const PLACEHOLDER = /^(?:select(?:\s+(?:an?\s+)?(?:option|one|item|value))?|choose(?:\s+(?:an?\s+)?(?:option|one))?|please\s+(?:select|choose)(?:\s+(?:an?\s+)?(?:option|one))?|pick\s+(?:an?\s+)?(?:option|one)|none\s+selected|nothing\s+selected|请选择|选择|--+|—+)[\s.…:：▾▼⌄˅]*$/iu;

const collapse = (text: string): string =>
  text.replace(/[​-‍⁠﻿]/gu, '').replace(/\s+/gu, ' ').trim();

const isInput = (element: Element): element is HTMLInputElement => element.localName === 'input';
const isSelect = (element: Element): element is HTMLSelectElement => element.localName === 'select';
const isTextarea = (element: Element): element is HTMLTextAreaElement => element.localName === 'textarea';

/** 这一次扫描认出的每一栏用到的元素（选项、代理、承载的原生控件、组容器）。 */
function coveredElements(fields: readonly ApplyFieldDescriptor[]): Element[] {
  const out: Element[] = [];
  for (const field of fields) {
    out.push(field.element);
    // 规则声明的按钮式下拉（Workday 的 Degree、国家：扫描认的是按钮旁边那个 0×0 的镜像输入框，人点的是按钮）：整个部件都算
    // 认出来了——值容器与激活控件。
    if (field.kind === 'combobox' && field.listbox !== undefined) {
      try {
        const container = field.element.closest(field.listbox.valueContainerSelector);
        if (container !== null) out.push(container);
        const activation = field.listbox.activationSelector === undefined ? null : container?.querySelector(field.listbox.activationSelector) ?? null;
        if (activation !== null) out.push(activation);
      } catch {
        // 选择器漂了：只算控件自己。
      }
    }
    if (field.kind !== 'choice') continue;
    const shape = field.choice;
    for (const option of shape.options) {
      out.push(option.element);
      if ('carrier' in option && option.carrier !== null) out.push(option.carrier);
    }
    if (shape.control === 'proxy') {
      if (shape.container !== null) out.push(shape.container);
      if (shape.nameSource !== null) out.push(shape.nameSource);
    }
  }
  return out;
}

const INTERACTIVE = 'input:not([type="hidden"]), select, textarea, button, [role="combobox"], [role="radio"], [role="checkbox"], [role="listbox"]';

function interactiveCount(node: Element): number {
  try {
    return node.querySelectorAll(INTERACTIVE).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 认出的那一栏就是它、包着它、被它包着；或者它是认出的那一栏旁边替原生控件说话的那颗按钮（同一个小容器里，
 * 容器里没几个控件）——都算认出来了。
 */
function isCovered(element: Element, covered: readonly Element[]): boolean {
  if (covered.some((other) => other === element || other.contains(element) || element.contains(other))) return true;
  let node: Element | null = element.parentElement;
  for (let depth = 0; depth < 3 && node !== null; depth += 1, node = node.parentElement) {
    if (interactiveCount(node) > 3) return false;
    const container = node;
    if (covered.some((other) => container.contains(other))) return true;
  }
  return false;
}

function hiddenByMarkup(element: Element): boolean {
  return element.closest('[hidden], [inert], [aria-hidden="true"]') !== null;
}

function disabled(element: Element): boolean {
  if ((element as { disabled?: unknown }).disabled === true || element.hasAttribute('disabled')) return true;
  if ((element.getAttribute('aria-disabled') ?? '').trim().toLowerCase() === 'true') return true;
  if (element.hasAttribute('readonly') || (element.getAttribute('aria-readonly') ?? '').toLowerCase() === 'true') return true;
  return element.closest('fieldset[disabled]') !== null;
}

/** 看得见：它自己，或者（藏起来的原生单选、复选）替它画出来的那个标签。 */
function shown(element: Element, isVisible: (element: Element) => boolean): boolean {
  if (isVisible(element)) return true;
  if (!isInput(element) || (element.type !== 'radio' && element.type !== 'checkbox')) return false;
  const labels = [element.closest('label'), ...Array.from(element.labels ?? [])].filter((label): label is HTMLLabelElement => label !== null);
  return labels.some((label) => !hiddenByMarkup(label) && isVisible(label));
}

/** 题目文字：显示用的与保留必填记号的原文。 */
interface Wording {
  readonly text: string;
  readonly raw: string;
}

const EMPTY_WORDING: Wording = Object.freeze({ text: '', raw: '' });

function clip(text: string): string {
  const tidy = collapse(text);
  return tidy.length <= LABEL_MAX ? tidy : `${tidy.slice(0, LABEL_MAX - 1)}…`;
}

/** 「一题」级别的控件：一张表里有几个，就有几道题（按钮、选项图标不算——它们属于某一道题）。 */
const QUESTION_CONTROLS = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select, textarea, ' +
  'button[aria-haspopup="listbox"], [role="combobox"]:not(input), [role="radiogroup"]';

function questionControlCount(node: Element): number {
  try {
    const names = new Set<string>();
    let unnamed = 0;
    for (const choice of Array.from(node.querySelectorAll('input[type="radio"], input[type="checkbox"]'))) {
      const name = (choice as HTMLInputElement).name;
      if (name === '') unnamed += 1;
      else names.add(name);
    }
    return node.querySelectorAll(QUESTION_CONTROLS).length + names.size + unnamed;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 这一个标签是别的控件的（`for` 指向别处、或者包着别的控件）。 */
function labelOfAnother(candidate: Element, members: readonly Element[]): boolean {
  if (candidate.localName !== 'label') return false;
  const target = candidate.getAttribute('for');
  if (target !== null && target !== '') {
    return !members.some((member) => member.id === target);
  }
  try {
    return Array.from(candidate.querySelectorAll('input, select, textarea')).some((control) => !members.includes(control));
  } catch {
    return true;
  }
}

/**
 * 往上找题目：最近的一个装着这一题全部成员的容器里，第一段不装控件、不是选项自己的标签、也不是别的控件的标签的文字。
 * 容器里冒出了别的题，就停：再往上就是整张表了，那里的文字不是这一题的。
 */
function nearbyQuestion(members: readonly Element[], questions = 1): Wording {
  const first = members[0];
  if (first === undefined) return EMPTY_WORDING;
  const memberLabels = new Set<Element>();
  for (const member of members) {
    if (!isInput(member)) continue;
    const wrapping = member.closest('label');
    if (wrapping !== null) memberLabels.add(wrapping);
    for (const label of Array.from(member.labels ?? [])) memberLabels.add(label);
  }
  let node: Element | null = first.parentElement;
  for (let depth = 0; depth < QUESTION_MAX_DEPTH && node !== null; depth += 1, node = node.parentElement) {
    const container = node;
    if (!members.every((member) => container.contains(member))) continue;
    if (questionControlCount(container) > questions) return EMPTY_WORDING;
    let candidates: Element[];
    try {
      candidates = Array.from(container.querySelectorAll('legend, label, h1, h2, h3, h4, h5, h6, p, span, div'));
    } catch {
      return EMPTY_WORDING;
    }
    for (const candidate of candidates) {
      if (memberLabels.has(candidate) || [...memberLabels].some((label) => label.contains(candidate) || candidate.contains(label))) continue;
      if (members.some((member) => candidate.contains(member))) continue;
      if (interactiveCount(candidate) > 0 || labelOfAnother(candidate, members)) continue;
      const texts = labelTextsOf(candidate);
      const text = collapse(texts.text);
      if (text.length >= 2 && text.length <= 400 && !PLACEHOLDER.test(text)) return { text, raw: texts.raw };
    }
  }
  return EMPTY_WORDING;
}

/** 组（单选、复选）的题目：fieldset 的 legend、组容器的可读名，否则就近找。 */
function groupWording(members: readonly HTMLInputElement[], root: ScanRoot): Wording {
  const first = members[0];
  if (first === undefined) return EMPTY_WORDING;
  const group = first.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (group !== null && members.every((member) => group.contains(member))) {
    const legend = group.localName === 'fieldset' ? Array.from(group.children).find((child) => child.localName === 'legend') ?? null : null;
    if (legend !== null) {
      const texts = labelTextsOf(legend);
      if (collapse(texts.text) !== '') return { text: collapse(texts.text), raw: texts.raw };
    }
    let raw = '';
    const declared = root.labelTextFor(group, { declaredOnly: true, onRawText: (text) => { raw = text; } });
    if (collapse(declared) !== '') return { text: collapse(declared), raw: raw || declared };
  }
  // 单个勾选框：它自己的标签就是那句话。
  if (members.length === 1) return controlWording(first, root);
  return nearbyQuestion(members, 1);
}

/** 单个控件的题目：宿主声明的标签（label、aria-labelledby、aria-label），读不到再就近找。 */
function controlWording(element: Element, root: ScanRoot): Wording {
  let raw = '';
  let declared = collapse(root.labelTextFor(element, { declaredOnly: true, onRawText: (text) => { raw = text; } }));
  const own = collapse(element.textContent ?? '');
  // 按钮式下拉的「可读名」常常就是它自己写着的「Select」，或者「题目 + Select」：那一段占位不是题目。
  if (own !== '' && PLACEHOLDER.test(own) && declared.endsWith(own)) declared = declared.slice(0, declared.length - own.length).trim();
  if (declared !== '' && !PLACEHOLDER.test(declared) && declared !== own) return { text: declared, raw: raw || declared };
  return nearbyQuestion([element]);
}

function isPlaceholderOption(select: HTMLSelectElement): boolean {
  const option = select.selectedOptions?.[0] ?? (select.selectedIndex >= 0 ? select.options[select.selectedIndex] : undefined);
  if (option === undefined || option === null) return true;
  if (option.value === '') return true;
  return PLACEHOLDER.test(collapse(option.textContent ?? '')) || /^select\b|^choose\b|^please\b/iu.test(collapse(option.textContent ?? ''));
}

/**
 * 自定义下拉的输入框本身是空的，选中的字显示在旁边：它自己那个小容器里（容器里没有别的输入控件）除了题目与占位之外
 * 还有字，就当已经选了。与浮层「这一栏有没有值」同一把尺（lib/dock/hostField.ts 的 widgetShownText）。
 */
function widgetShowsValue(element: Element): boolean {
  let node: Element | null = element.parentElement;
  const labels = new Set(Array.from((element as HTMLInputElement).labels ?? []));
  for (let depth = 0; depth < 3 && node !== null; depth += 1, node = node.parentElement) {
    let fields: number;
    try {
      fields = node.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
    } catch {
      return false;
    }
    if (fields > 1) return false;
    const parts: string[] = [];
    const walker = element.ownerDocument.createTreeWalker(node, 4 /* SHOW_TEXT */);
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
      const parent = current.parentElement;
      if (parent === null || parent.closest('label') !== null || [...labels].some((label) => label.contains(parent))) continue;
      if (parent.closest('[aria-hidden="true"]') !== null) continue;
      const text = collapse(current.textContent ?? '');
      if (text !== '' && text !== '*' && !PLACEHOLDER.test(text)) parts.push(text);
    }
    if (parts.length > 0) return true;
  }
  return false;
}

function comboboxLike(element: Element): boolean {
  return element.getAttribute('role') === 'combobox' || element.hasAttribute('aria-autocomplete') ||
    element.hasAttribute('aria-haspopup') || element.hasAttribute('aria-activedescendant');
}

function textEmpty(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (element.value.trim() !== '') return false;
  return !(comboboxLike(element) && widgetShowsValue(element));
}

/** 附上了一个文件：旁边写着文件名（`resume.pdf`）。上传部件常把文件列在触发按钮旁边，按钮上的字照旧是「Select」。 */
const FILE_NAME = /\S\.(?:pdf|docx?|rtf|txt|odt|pages|png|jpe?g)\b/iu;

function fileShownNear(element: Element): boolean {
  let node: Element | null = element.parentElement;
  for (let depth = 0; depth < 4 && node !== null; depth += 1, node = node.parentElement) {
    if (interactiveCount(node) > 8) return false;
    if (FILE_NAME.test(node.textContent ?? '')) return true;
  }
  return false;
}

function buttonEmpty(element: Element): boolean {
  const own = collapse(element.textContent ?? '');
  if (own !== '' && !PLACEHOLDER.test(own)) return false;
  return !fileShownNear(element);
}

function ariaGroupEmpty(group: Element): boolean {
  try {
    if (group.querySelector('[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"]') !== null) return false;
    return !Array.from(group.querySelectorAll('input[type="radio"], input[type="checkbox"]')).some((input) => (input as HTMLInputElement).checked);
  } catch {
    return false;
  }
}

function markedRequired(element: Element): boolean {
  if ((isInput(element) || isSelect(element) || isTextarea(element)) && element.required) return true;
  return (element.getAttribute('aria-required') ?? '').trim().toLowerCase() === 'true';
}

function groupMarkedRequired(members: readonly HTMLInputElement[]): boolean {
  if (members.some(markedRequired)) return true;
  const group = members[0]?.closest('fieldset, [role="radiogroup"], [role="group"]') ?? null;
  return group !== null && members.every((member) => group.contains(member)) && markedRequired(group);
}

/**
 * 读一遍这一页还空着、还报着错的必填。读页面时出错就当什么都没读到——调用方据此**不**多说一句；
 * 连填那一侧另有「说不清就停」的判据，不靠这里报错。
 */
export function readPageGaps(input: ReadPageGapsInput): PageGaps {
  try {
    return read(input);
  } catch {
    return NO_PAGE_GAPS;
  }
}

function read(input: ReadPageGapsInput): PageGaps {
  const { root } = input.form;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const covered = coveredElements(input.form.fields);
  const isVisible = (element: Element): boolean => {
    try {
      return input.isVisible(element) === true;
    } catch {
      return false;
    }
  };
  const unplanned: PageGap[] = [];
  const seen = new Set<Element>();
  const doneGroups = new Set<string>();
  // 读不出题目时，规则声明的题干说得出就用它（Rippling 自定义题的「Select」下拉：题干在外层容器里，aria 关系够不着）。
  const scopedQuestion = (element: Element): string => {
    try {
      const text = collapse(input.form.questionText?.(element) ?? '');
      return PLACEHOLDER.test(text) ? '' : text;
    } catch {
      return '';
    }
  };
  const add = (element: Element, wording: Wording): void => {
    const text = clip(wording.text !== '' ? wording.text : scopedQuestion(element));
    if (unplanned.length >= limit) return;
    // 读不出题目的也列（label 是空串）：网站说它必填、它看得见、它空着，就是还没答的一道题（Rippling 自定义题的「Select」下拉，
    // 题干在 aria 关系够不着的地方）。浮层给它一个通用的标题，「去这一栏」照样带他过去。
    unplanned.push(Object.freeze({ element, label: text }));
  };

  const controls = root.querySelectorAll(CANDIDATES).slice(0, CONTROL_BUDGET);
  for (const element of controls) {
    if (unplanned.length >= limit) break;
    if (seen.has(element) || root.isExcluded(element) || hiddenByMarkup(element) || disabled(element)) continue;
    seen.add(element);
    if (isInput(element)) {
      const type = (element.getAttribute('type') ?? 'text').trim().toLowerCase();
      if (SKIPPED_INPUT_TYPES.has(type)) continue;
      if (type === 'radio' || type === 'checkbox') {
        // 同名的一组算一题；没有名字的单选、复选各算一题。
        const name = element.name;
        const key = name === '' ? null : `${type}:${name}`;
        if (key !== null && doneGroups.has(key)) continue;
        if (key !== null) doneGroups.add(key);
        const members = key === null
          ? [element]
          : controls.filter((other): other is HTMLInputElement => isInput(other) && other.type === type && other.name === name);
        members.forEach((member) => seen.add(member));
        if (members.some((member) => isCovered(member, covered))) continue;
        if (!members.some((member) => shown(member, isVisible))) continue;
        if (members.some((member) => member.checked)) continue;
        const wording = groupWording(members, root);
        if (!groupMarkedRequired(members) && !hasRequiredMarkerAtEdge(wording.raw)) continue;
        add(members.find((member) => shown(member, isVisible)) ?? element, wording);
        continue;
      }
      if (isCovered(element, covered) || !isVisible(element) || !textEmpty(element)) continue;
      const wording = controlWording(element, root);
      if (!markedRequired(element) && !hasRequiredMarkerAtEdge(wording.raw)) continue;
      add(element, wording);
      continue;
    }
    if (isTextarea(element)) {
      if (isCovered(element, covered) || !isVisible(element) || !textEmpty(element)) continue;
      const wording = controlWording(element, root);
      if (!markedRequired(element) && !hasRequiredMarkerAtEdge(wording.raw)) continue;
      add(element, wording);
      continue;
    }
    if (isSelect(element)) {
      if (isCovered(element, covered) || !isVisible(element) || !isPlaceholderOption(element)) continue;
      const wording = controlWording(element, root);
      if (!markedRequired(element) && !hasRequiredMarkerAtEdge(wording.raw)) continue;
      add(element, wording);
      continue;
    }
    if (element.getAttribute('role') === 'radiogroup') {
      // 组里的选项也算看过了，免得下面又按单个控件算一遍。
      for (const option of Array.from(element.querySelectorAll('input, [role="radio"]'))) seen.add(option);
      if (isCovered(element, covered) || !isVisible(element) || !ariaGroupEmpty(element)) continue;
      let raw = '';
      const declared = collapse(root.labelTextFor(element, { declaredOnly: true, onRawText: (text) => { raw = text; } }));
      const wording = declared !== '' ? { text: declared, raw: raw || declared } : nearbyQuestion([element]);
      if (!markedRequired(element) && !hasRequiredMarkerAtEdge(wording.raw)) continue;
      add(element, wording);
      continue;
    }
    // 按钮式下拉（`button[aria-haspopup=listbox]`、非 input 的 `role=combobox`）。
    if (isCovered(element, covered) || !isVisible(element) || !buttonEmpty(element)) continue;
    const wording = controlWording(element, root);
    if (!markedRequired(element) && !hasRequiredMarkerAtEdge(wording.raw)) continue;
    add(element, wording);
  }

  let invalid = 0;
  for (const element of root.querySelectorAll('[aria-invalid="true"]').slice(0, CONTROL_BUDGET)) {
    if (root.isExcluded(element) || hiddenByMarkup(element) || !shown(element, isVisible)) continue;
    invalid += 1;
  }
  let alerts = 0;
  for (const element of root.querySelectorAll('[role="alert"]').slice(0, CONTROL_BUDGET)) {
    if (root.isExcluded(element) || hiddenByMarkup(element) || !isVisible(element)) continue;
    if (collapse(labelTextsOf(element).text).length >= 2) alerts += 1;
  }
  return Object.freeze({ unplanned: Object.freeze(unplanned), invalid, alerts });
}
