import type { DockCopy } from './copy';
import { el, trusted } from './dom';
import { icon } from './icons';
import { NEED_KINDS, type NeedKind } from './needs';
import type { DockRow } from './rows';

/**
 * 「需要你」那一块在浮层上的样子（2026-09-28）：按要做的事分组，每一行一个明摆着的动作。
 *
 * 节点按行常驻（行的次序在整轮里不变），状态变了在原节点上改；输入框里打了一半的字不因重画丢掉。办好了的那一行
 * 收起高度、淡出（CSS 过渡，系统要求减少动态时直接拿掉）；一组空了，整组一起收起。
 *
 * 行上没有编号（2026-09-28）：编号是为了对上网页上那一栏旁边的标记，标记拿掉了，编号就只剩一个要认的数——每组的
 * 组名后面已经写着几项，「去第一项／下一处」照列表从上往下走。
 * 只建节点、只写文字；页面上的真实选项原文只摆在这里，不外传。
 */

/** 这一行摆什么动作。 */
export type NeedAct =
  /**
   * 几个选项（页面上的原文），点一下就写；`more`：旁边一个「更多选项」去那一栏。`labels`：按钮上写的字与选项原文不同时
   * （「可以联系你现在的雇主吗」写「可以」「不可以」），与 `options` 一一对应。
   */
  | Readonly<{ kind: 'chips'; options: readonly string[]; labels?: readonly string[]; more: boolean; busy: string | null; remember: boolean }>
  /** 选项太多又没有线索：浮层里一个下拉，选好按「填入」。 */
  | Readonly<{ kind: 'select'; options: readonly string[]; busy: boolean; remember: boolean }>
  /** 一个小输入框与「填入」（回车也行）。 */
  | Readonly<{ kind: 'input'; long: boolean; busy: boolean; remember: boolean }>
  /** 「AI 帮我写」；`confirm`：写好了但那一下点击过期了，再点一下填入。 */
  | Readonly<{ kind: 'ai'; busy: boolean; confirm: boolean }>
  /** 只有「去这一栏」（`pick`：去那一栏选；`write`：去那一栏写）。 */
  | Readonly<{ kind: 'go'; label: 'go' | 'pick' | 'write' }>;

export interface NeedItem {
  readonly row: DockRow;
  readonly kind: NeedKind;
  readonly why: string;
  readonly act: NeedAct;
  /** 填完之后才能动手（填的途中只列出来）。 */
  readonly enabled: boolean;
}

export interface NeedsViewDeps {
  readonly doc: Document;
  readonly copy: DockCopy;
  readonly reduced: () => boolean;
  /** 「去这一栏」「更多选项」、点行的题目：滚过去、把光标放进那一栏。 */
  readonly onGo: (row: DockRow) => void;
  /** 点了一个选项、或按了「填入」：这一下原样交出去（调用方同步取证）。 */
  readonly onAnswer: (row: DockRow, value: string, event: Event, remember: boolean) => void;
  readonly onAi: (row: DockRow, event: MouseEvent) => void;
}

export interface NeedsView {
  readonly element: HTMLElement;
  paint(items: readonly NeedItem[]): void;
  /** 这一轮换掉了：节点全拿掉，不播动画。 */
  clear(): void;
}

interface RowNodes {
  readonly fold: HTMLElement;
  readonly row: HTMLElement;
  readonly head: HTMLButtonElement;
  readonly why: HTMLElement;
  readonly act: HTMLElement;
  actKey: string;
  item: NeedItem;
  /** 输入框、下拉与「填入」（有的话）：忙的时候只换可不可用，不重建（打了一半的字留着）。 */
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  fill: HTMLButtonElement | null;
}

interface GroupNodes {
  readonly fold: HTMLElement;
  readonly count: HTMLElement;
  readonly card: HTMLElement;
}

/** 行收起的过渡时长（与 css.ts 的 `.need-fold` 一致）。 */
const LEAVE_MS = 420;
/** 行上那一句原因的 id（同一个 shadow 里不重）。 */
let rowSerial = 0;

export function createNeedsView(deps: NeedsViewDeps): NeedsView {
  const { doc, copy: COPY } = deps;
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => el(doc, tag, cls, text);
  const tb = (cls: string, onSelect: (event: MouseEvent) => void, text?: string) => trusted(doc, cls, onSelect, text);
  const element = h('div', 'needs');
  const groups = new Map<NeedKind, GroupNodes>();
  for (const kind of NEED_KINDS) {
    const fold = h('div', 'fold need-grp');
    fold.dataset.needGroup = kind;
    fold.dataset.open = 'false';
    const clip = h('div', 'clip');
    const grp = h('div', 'grp');
    const head = h('div', 'grp-head');
    head.dataset.deckFade = '1';
    const count = h('span', 'grp-count');
    head.append(h('span', '', COPY.needs.groups[kind]), count);
    const card = h('div', 'card');
    card.dataset.deck = '1';
    grp.append(head, card);
    clip.append(grp);
    fold.append(clip);
    element.append(fold);
    groups.set(kind, { fold, count, card });
  }
  const nodes = new Map<string, RowNodes>();

  /** 动作那一块的样子（不含忙不忙）：变了才重建。 */
  const actKeyOf = (item: NeedItem): string => {
    const act = item.act;
    if (!item.enabled) return 'off';
    switch (act.kind) {
      case 'chips': return `chips:${act.more}:${act.options.join('\u0001')}:${(act.labels ?? []).join('\u0001')}`;
      case 'select': return `select:${act.options.join('\u0001')}`;
      case 'input': return `input:${act.long}`;
      case 'ai': return `ai:${act.busy}:${act.confirm}`;
      case 'go': return `go:${act.label}`;
    }
  };

  const spinner = (): HTMLElement => h('span', 'spin-dark need-spin');

  const buildAct = (nodesFor: RowNodes): void => {
    const item = nodesFor.item;
    const act = item.act;
    nodesFor.act.replaceChildren();
    nodesFor.input = null;
    nodesFor.fill = null;
    nodesFor.act.style.display = item.enabled ? '' : 'none';
    if (!item.enabled) return;
    const row = (): DockRow => nodesFor.item.row;
    if (act.kind === 'chips') {
      act.options.forEach((option, index) => {
        const label = act.labels?.[index] ?? option;
        const chip = tb('need-chip', (event) => {
          const now = nodesFor.item.act;
          if (now.kind !== 'chips' || now.busy !== null) return;
          deps.onAnswer(row(), option, event, now.remember);
        });
        chip.dataset.chip = '1';
        chip.dataset.value = option;
        chip.title = label;
        chip.setAttribute('aria-label', COPY.needs.chipAria(label));
        chip.append(h('span', 'need-chip-t', label));
        nodesFor.act.append(chip);
      });
      if (act.more) {
        const more = tb('need-link', () => deps.onGo(row()), COPY.needs.more);
        more.dataset.action = 'need-more';
        nodesFor.act.append(more);
      }
      return;
    }
    if (act.kind === 'select') {
      const select = h('select', 'need-select');
      const option = (text: string, value: string): HTMLOptionElement => {
        const node = h('option', '', text);
        node.value = value;
        return node;
      };
      select.append(option(COPY.needs.choosePlaceholder, ''), ...act.options.map((text) => option(text, text)));
      select.setAttribute('aria-label', COPY.needs.choosePlaceholder);
      const fill = tb('need-fill', (event) => {
        const now = nodesFor.item.act;
        if (now.kind !== 'select' || now.busy || select.value === '') return;
        deps.onAnswer(row(), select.value, event, now.remember);
      }, COPY.needs.fill);
      fill.dataset.action = 'need-fill';
      select.addEventListener('change', () => { fill.disabled = select.value === '' || busyOf(nodesFor.item); });
      fill.disabled = true;
      nodesFor.input = select;
      nodesFor.fill = fill;
      nodesFor.act.append(select, fill);
      return;
    }
    if (act.kind === 'input') {
      const input = act.long ? h('textarea', 'need-input need-area') : h('input', 'need-input');
      if (input instanceof HTMLInputElement) input.type = 'text';
      else input.rows = 2;
      input.placeholder = COPY.needs.placeholder;
      input.setAttribute('aria-label', COPY.needs.inputAria(row().q));
      input.maxLength = 2_000;
      const send = (event: Event): void => {
        const now = nodesFor.item.act;
        const value = input.value.trim();
        if (now.kind !== 'input' || now.busy || value === '') return;
        deps.onAnswer(row(), value, event, now.remember);
      };
      const fill = tb('need-fill', (event) => send(event), COPY.needs.fill);
      fill.dataset.action = 'need-fill';
      input.addEventListener('input', () => { fill.disabled = input.value.trim() === '' || busyOf(nodesFor.item); });
      input.addEventListener('keydown', (event) => {
        // 回车就是「填入」（多行框里 Shift+回车换行）；只认浏览器认定的真按键。
        const key = event as KeyboardEvent;
        if (!key.isTrusted || key.key !== 'Enter' || key.isComposing || (act.long && key.shiftKey)) return;
        key.preventDefault();
        send(key);
      });
      fill.disabled = true;
      nodesFor.input = input;
      nodesFor.fill = fill;
      nodesFor.act.append(input, fill);
      return;
    }
    if (act.kind === 'ai') {
      const button = tb('need-ai', (event) => {
        const now = nodesFor.item.act;
        if (now.kind !== 'ai' || now.busy) return;
        deps.onAi(row(), event);
      });
      button.dataset.action = 'need-ai';
      button.disabled = act.busy;
      if (act.busy) button.append(spinner(), doc.createTextNode(COPY.needs.aiWriting));
      else button.append(icon(doc, 'spark', 15, { stroke: 1.8 }), doc.createTextNode(act.confirm ? COPY.needs.aiFill : COPY.needs.aiWrite));
      nodesFor.act.append(button);
      return;
    }
    const go = tb('need-go', () => deps.onGo(row()));
    go.dataset.action = 'need-go';
    go.append(doc.createTextNode(act.label === 'pick' ? COPY.needs.goPick : act.label === 'write' ? COPY.needs.goWrite : COPY.needs.go),
      icon(doc, 'chevronRight', 13, { stroke: 2.2 }));
    nodesFor.act.append(go);
  };

  const busyOf = (item: NeedItem): boolean => {
    const act = item.act;
    return act.kind === 'chips' ? act.busy !== null : act.kind === 'go' ? false : act.busy;
  };

  /** 忙不忙：选项上转圈、输入框与「填入」不可用。 */
  const paintBusy = (nodesFor: RowNodes): void => {
    const act = nodesFor.item.act;
    nodesFor.row.dataset.busy = String(busyOf(nodesFor.item));
    if (act.kind === 'chips') {
      for (const chip of nodesFor.act.querySelectorAll<HTMLButtonElement>('[data-chip]')) {
        const mine = act.busy !== null && chip.dataset.value === act.busy;
        chip.disabled = act.busy !== null;
        chip.dataset.busy = String(mine);
        const spin = chip.querySelector('.need-spin');
        if (mine && spin === null) chip.prepend(spinner());
        if (!mine) spin?.remove();
      }
      return;
    }
    if (act.kind === 'select' || act.kind === 'input') {
      if (nodesFor.input !== null) nodesFor.input.disabled = act.busy;
      if (nodesFor.fill !== null) {
        const empty = nodesFor.input === null || nodesFor.input.value.trim() === '';
        nodesFor.fill.disabled = act.busy || empty;
        nodesFor.fill.replaceChildren();
        if (act.busy) nodesFor.fill.append(spinner(), doc.createTextNode(COPY.needs.filling));
        else nodesFor.fill.append(doc.createTextNode(COPY.needs.fill));
      }
    }
  };

  const buildRow = (item: NeedItem): RowNodes => {
    const fold = h('div', 'need-fold');
    fold.dataset.open = 'true';
    const clip = h('div', 'clip');
    const row = h('div', 'need');
    row.dataset.needRow = item.row.key;
    row.dataset.in = '1';
    const head = tb('need-head', () => deps.onGo(nodesFor.item.row));
    head.dataset.action = 'need-locate';
    const textBox = h('span', 'need-text');
    const why = h('span', 'need-why');
    // 读屏：按钮的名字是「去网页上找到这一题」，那一句原因作为说明念出来。
    rowSerial += 1;
    why.id = `need-why-${rowSerial}`;
    head.setAttribute('aria-describedby', why.id);
    textBox.append(h('span', 'need-q', item.row.q), why);
    head.append(textBox);
    const act = h('div', 'need-act');
    row.append(head, act);
    clip.append(row);
    fold.append(clip);
    const nodesFor: RowNodes = { fold, row, head, why, act, actKey: '', item, input: null, fill: null };
    return nodesFor;
  };

  /** 办好了的那一行：先认不出来（查不到、读屏跳过），再收起、淡出，最后拿掉。 */
  const leave = (nodesFor: RowNodes): void => {
    const { fold, row } = nodesFor;
    delete row.dataset.needRow;
    row.dataset.needLeft = '1';
    fold.setAttribute('aria-hidden', 'true');
    fold.toggleAttribute('inert', true);
    if (deps.reduced() || !fold.isConnected) { fold.remove(); return; }
    fold.dataset.open = 'false';
    setTimeout(() => fold.remove(), LEAVE_MS);
  };

  const paint = (items: readonly NeedItem[]): void => {
    const keep = new Set(items.map((item) => item.row.key));
    for (const [key, nodesFor] of nodes) {
      if (keep.has(key)) continue;
      nodes.delete(key);
      leave(nodesFor);
    }
    const counts = new Map<NeedKind, number>();
    const previous = new Map<NeedKind, HTMLElement | null>();
    for (const item of items) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
      let nodesFor = nodes.get(item.row.key);
      if (nodesFor === undefined) {
        nodesFor = buildRow(item);
        nodes.set(item.row.key, nodesFor);
      }
      nodesFor.item = item;
      if (nodesFor.why.textContent !== item.why) nodesFor.why.textContent = item.why;
      nodesFor.row.dataset.kind = item.kind;
      nodesFor.head.disabled = !item.enabled;
      nodesFor.head.setAttribute('aria-label', COPY.lists.locateAria(item.row.q));
      const actKey = actKeyOf(item);
      if (actKey !== nodesFor.actKey) {
        nodesFor.actKey = actKey;
        buildAct(nodesFor);
      }
      paintBusy(nodesFor);
      // 放进它那一组、排在上一行后面（换了组的行整行挪过去，节点不重建）。
      const group = groups.get(item.kind)!;
      const before = previous.get(item.kind) ?? null;
      const want: ChildNode | null = before === null ? group.card.firstChild : before.nextSibling;
      if (want !== nodesFor.fold) group.card.insertBefore(nodesFor.fold, want);
      previous.set(item.kind, nodesFor.fold);
    }
    for (const kind of NEED_KINDS) {
      const group = groups.get(kind)!;
      const count = counts.get(kind) ?? 0;
      group.fold.dataset.open = String(count > 0);
      group.fold.toggleAttribute('inert', count === 0);
      group.count.textContent = count > 0 ? String(count) : '';
    }
  };

  const clear = (): void => {
    for (const nodesFor of nodes.values()) nodesFor.fold.remove();
    nodes.clear();
    for (const group of groups.values()) {
      group.card.replaceChildren();
      group.fold.dataset.open = 'false';
      group.count.textContent = '';
    }
  };

  return { element, paint, clear };
}
