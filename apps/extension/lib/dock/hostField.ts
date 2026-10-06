/**
 * 浮层对宿主页上某一栏只做三件事：看它有没有值（以及从某一刻起变没变样）、把它滚到眼前、量它在哪
 * （「去那一栏」之后亮的那一圈、AI 标记）。
 *
 * 全是只读的：不改宿主的值、不改它的样式、不往它的节点上挂东西（事件在文档上统一听）。
 * 不认任何一家的 DOM——只认原生控件与 ARIA（RULE-GLOBAL-DOM-RULE-BOUNDARY）。
 * 「有没有值」只用来在浮层上打一个勾（设计交接 §7：只判断有没有值，不判断填得对不对）。
 * 「变没变样」只用来分清一栏是不是用户自己动过的：我们这一轮写过的那一栏，收尾那一刻是什么样子
 * 就不算用户补的（2026-09-23）。读到的样子只在浮层的闭包里比一比，不显示、不外传（Data-L1）。
 */

const PLACEHOLDER = /^(select\.*|select an option|select one|choose\.*|choose an option|please select\.*|--+|—+|none selected)$/i;

function textOf(node: Element): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** aria-describedby / aria-labelledby 指向的那几段字（占位提示、题目本身），算值的时候要扣掉。 */
function referencedTexts(el: Element): string[] {
  const doc = el.ownerDocument;
  const ids = `${el.getAttribute('aria-describedby') ?? ''} ${el.getAttribute('aria-labelledby') ?? ''}`.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const id of ids) {
    const node = doc.getElementById(id);
    if (node !== null) out.push(textOf(node));
  }
  return out;
}

/**
 * 自定义下拉（input 本身是空的，选中的字显示在旁边）：在它的小容器里找「除了题目与占位以外的字」。
 * 找到就交回那几段字，什么都不显示就是 null。
 */
function widgetShownText(el: Element): string | null {
  const skip = new Set(referencedTexts(el).filter(Boolean));
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const label of Array.from(labels)) skip.add(textOf(label));
  let node: Element | null = el.parentElement;
  for (let depth = 0; depth < 3 && node !== null; depth += 1, node = node.parentElement) {
    // 容器里不止这一个输入控件，就已经大到不是「这一栏」了。
    if (node.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) return null;
    const parts: string[] = [];
    const walker = el.ownerDocument.createTreeWalker(node, 4 /* SHOW_TEXT */);
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
      const parent = current.parentElement;
      if (parent !== null && (parent.closest('label') !== null || parent.getAttribute('aria-hidden') === 'true')) continue;
      const value = (current.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (value !== '') parts.push(value);
    }
    const shown = parts.filter((part) => !skip.has(part) && !PLACEHOLDER.test(part) && part !== '*');
    if (shown.length > 0) return shown.join('\n');
  }
  return null;
}

/**
 * ARIA 代理选项（2026-09-23）：`button[aria-pressed]`（Ashby 的是非题）或 `[role=radio|checkbox][aria-checked]`
 * （Workable）。状态值只认字面 true / false。原生控件自己带 ARIA 状态的不算（它们走下面的原生分支）。
 */
function ariaProxyOf(el: Element): { readonly attribute: 'aria-pressed' | 'aria-checked'; readonly role: string } | null {
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return null;
  const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
  const token = (name: string) => /^(?:true|false)$/.test(el.getAttribute(name) ?? '');
  if ((role === 'radio' || role === 'checkbox') && token('aria-checked')) return { attribute: 'aria-checked', role };
  if (el.tagName === 'BUTTON' && (role === '' || role === 'button') && token('aria-pressed')) {
    return { attribute: 'aria-pressed', role: '' };
  }
  return null;
}

/**
 * 代理题此刻的样子（与原生控件同一套判据，见 `hostFieldState`）：组里公布了 true 的是哪几个选项；一个都没有就是
 * null（没答）。组 = 离它最近的 ARIA/HTML 分组容器（role=radiogroup|group、fieldset）；切换按钮没有分组容器时就是
 * 同一个父元素下的那几颗（Ashby）。单个 role=checkbox 不在任何组里时只看它自己。**不看**里面藏着的原生 radio 的
 * checked：Workable 上它晚一拍、还会与 aria-checked 不一致（2026-09-23 实测）。
 */
function ariaProxyState(el: Element, proxy: NonNullable<ReturnType<typeof ariaProxyOf>>): string | null {
  const group = el.parentElement?.closest('[role="radiogroup"], [role="group"], fieldset') ??
    (proxy.attribute === 'aria-pressed' ? el.parentElement : null);
  if (group === null || group === undefined) return el.getAttribute(proxy.attribute) === 'true' ? 'proxy:self' : null;
  const selector = proxy.attribute === 'aria-pressed' ? 'button[aria-pressed]' : `[role="${proxy.role}"][aria-checked]`;
  const on = Array.from(group.querySelectorAll(selector)).flatMap((other, index) =>
    other.getAttribute(proxy.attribute) === 'true' ? [index] : []);
  if (on.length > 0) return `proxy:${on.join(',')}`;
  return el.getAttribute(proxy.attribute) === 'true' ? 'proxy:self' : null;
}

const shownState = (el: Element): string | null => {
  const shown = widgetShownText(el);
  return shown === null ? null : `shown:${shown}`;
};

/**
 * 这一栏此刻的样子，折成一个能拿来比的字符串；什么都没有（空、占位、没勾）就是 null。
 * 「有没有值」就是它不是 null——两件事共用这一套判据，不会各说各的。
 */
export function hostFieldState(el: Element | null | undefined): string | null {
  if (el === null || el === undefined || !el.isConnected) return null;
  const proxy = ariaProxyOf(el);
  if (proxy !== null) return ariaProxyState(el, proxy);
  const view = el.ownerDocument.defaultView;
  if (view !== null && el instanceof view.HTMLInputElement) {
    const type = el.type;
    if (type === 'checkbox') return el.checked ? 'checked' : null;
    if (type === 'radio') {
      if (el.name !== '') {
        const scope: ParentNode = el.form ?? el.ownerDocument;
        const group = Array.from(scope.querySelectorAll('input[type="radio"]')).filter(
          (other): other is HTMLInputElement => other instanceof view.HTMLInputElement && other.name === el.name,
        );
        const index = group.findIndex((other) => other.checked);
        if (index >= 0) return `radio:${index}`;
      }
      return el.checked ? 'radio:self' : null;
    }
    if (type === 'file') {
      const files = Array.from(el.files ?? []);
      if (files.length > 0) return `files:${files.map((file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`).join('\u0001')}`;
      return shownState(el);
    }
    if (el.value.trim() !== '') return `value:${el.value}`;
    return el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') ? shownState(el) : null;
  }
  if (view !== null && el instanceof view.HTMLTextAreaElement) return el.value.trim() !== '' ? `value:${el.value}` : null;
  if (view !== null && el instanceof view.HTMLSelectElement) {
    const option = el.selectedOptions[0];
    return option !== undefined && option.value !== '' && !PLACEHOLDER.test(textOf(option))
      ? `select:${el.selectedIndex}:${option.value}`
      : null;
  }
  const choices = Array.from(el.querySelectorAll('input[type="checkbox"], input[type="radio"]')) as HTMLInputElement[];
  if (choices.length > 0) {
    return choices.some((choice) => choice.checked) ? `choices:${choices.map((choice) => (choice.checked ? '1' : '0')).join('')}` : null;
  }
  if (el.getAttribute('aria-checked') === 'true') return 'aria-checked';
  if ((el as HTMLElement).isContentEditable) {
    const text = textOf(el);
    return text !== '' ? `text:${text}` : null;
  }
  return shownState(el);
}

export function hostFieldHasValue(el: Element | null | undefined): boolean {
  return hostFieldState(el) !== null;
}

/**
 * 亮的那一圈（与 AI 标记的边）圈哪一块：控件本身太小（勾选框、藏起来的文件框、自定义下拉里 2px 宽的输入框）就往上找
 * 一层看得见的盒子，但不圈到整张表。
 */
export function ringTargetFor(el: Element): Element {
  const view = el.ownerDocument.defaultView;
  if (view !== null && el instanceof view.HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const label = el.closest('label');
    if (label !== null) return label;
  }
  let node: Element = el;
  // 先往上找到一个看得见的盒子（勾选框、藏起来的文件框、自定义下拉里 2px 宽的输入框都太小）。
  for (let depth = 0; depth < 4; depth += 1) {
    const rect = node.getBoundingClientRect();
    if (rect.width >= 60 && rect.height >= 20) break;
    const parent = node.parentElement;
    if (parent === null) return node;
    if (parent.getBoundingClientRect().height > 220) return node;
    node = parent;
  }
  // 再往外扩到那一栏带边框的整块（下拉的值区 → 整个控件框），但只在外一层「只是略大一圈」时才扩：
  // 高不超过 1.9 倍、宽不超过多 120px、整体不超过 140px 高——不圈到整张表或整段。
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = node.parentElement;
    if (parent === null) break;
    const inner = node.getBoundingClientRect();
    const outer = parent.getBoundingClientRect();
    if (outer.height > 140 || outer.height > inner.height * 1.9 || outer.width > inner.width + 120) break;
    node = parent;
  }
  return node;
}

function scrollParent(el: Element): Element | null {
  const view = el.ownerDocument.defaultView;
  if (view === null) return null;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node === el.ownerDocument.body || node === el.ownerDocument.documentElement) return null;
    const style = view.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
  }
  return null;
}

/** 把这一栏滚到视口约 26% 的高度（设计：停在视口约 26% 的高度）。只动滚动位置，不动布局。 */
export function scrollHostFieldIntoView(el: Element, smooth: boolean, ratio = 0.26): void {
  const view = el.ownerDocument.defaultView;
  if (view === null || !el.isConnected) return;
  const target = ringTargetFor(el);
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  const container = scrollParent(target);
  const rect = target.getBoundingClientRect();
  if (container !== null) {
    const box = container.getBoundingClientRect();
    const top = container.scrollTop + rect.top - box.top - container.clientHeight * ratio;
    container.scrollTo?.({ top: Math.max(0, top), behavior });
    return;
  }
  const top = view.scrollY + rect.top - view.innerHeight * ratio;
  view.scrollTo?.({ top: Math.max(0, top), behavior });
}
