import { EASE_OUT } from './css';
import { animate, el } from './dom';
import { icon } from './icons';

/**
 * 填写途中，进度卡下面一条条列出填好的栏（2026-09-28 负责人：要快、要顺——一栏一行，题目加一个短的值，像「First Name ·
 * Alex」）。
 *
 * 只在我们自己的浮层里显示：值不进日志、不进遥测、不出本机。填写那一边一栏一栏地报，这里不跟着一次次改页面——交过来的
 * 最新那一份记下，下一帧一起改（一帧最多改一次）；新来的行接在最后，列表停在最新的那一行（他往上翻了就不拽他回来）；
 * 系统要求减少动态时不播入场动画。只加节点、只写文字，不量宿主页，填写一刻也不等它。
 */
export interface FeedLine {
  readonly key: string;
  readonly q: string;
  /** 短的值（勾选框是「已勾选」、代填是「已替你同意条款」……）；没有值就只写题目。 */
  readonly v: string;
  readonly kind: 'ok' | 'ai' | 'signed';
}

export interface LiveFeed {
  /** 这一刻填好了的那几栏（按填上的先后）；页面在下一帧一起改。 */
  sync(lines: readonly FeedLine[]): void;
  /** 收起之后（或换了一轮）：行全拿掉、高度放开，列表交还给「其余已填好」。 */
  clear(): void;
}

export interface LiveFeedDeps {
  readonly doc: Document;
  /** 行放在哪（「其余已填好」那张卡：填写途中它就是这一条列表）。 */
  readonly list: HTMLElement;
  readonly reduced: () => boolean;
  /** 这一条列表最多多高（放得下就不出第二层滚动）：每次改之前量一次。 */
  readonly maxHeight: () => number;
}

/** 离底部这么近就算停在最新那一行（他没往上翻）。 */
const PINNED_SLACK = 24;

const GLYPH: Readonly<Record<FeedLine['kind'], 'check' | 'spark' | 'signature'>> = { ok: 'check', ai: 'spark', signed: 'signature' };

export function createLiveFeed(deps: LiveFeedDeps): LiveFeed {
  const { doc, list } = deps;
  const win = doc.defaultView;
  const nodes = new Map<string, { row: HTMLElement; q: HTMLElement; v: HTMLElement; kind: FeedLine['kind'] }>();
  let wanted: readonly FeedLine[] | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const build = (line: FeedLine) => {
    const row = el(doc, 'div', 'frow');
    row.dataset.feedRow = line.key;
    row.dataset.kind = line.kind;
    const glyph = el(doc, 'span', 'fglyph');
    glyph.append(icon(doc, GLYPH[line.kind], 11, { stroke: line.kind === 'ok' ? 3.2 : 2 }));
    const q = el(doc, 'span', 'fq');
    const v = el(doc, 'span', 'fv');
    row.append(glyph, q, v);
    return { row, q, v, kind: line.kind };
  };

  const flush = (): void => {
    frame = 0;
    timer = null;
    const lines = wanted;
    wanted = null;
    if (lines === null) return;
    // 改之前看一眼他是不是停在最新那一行（没翻上去）。
    const pinned = list.scrollHeight - list.scrollTop - list.clientHeight <= PINNED_SLACK;
    const keep = new Set(lines.map((line) => line.key));
    for (const [key, node] of nodes) if (!keep.has(key)) { node.row.remove(); nodes.delete(key); }
    const fresh: HTMLElement[] = [];
    let previous: HTMLElement | null = null;
    for (const line of lines) {
      let node = nodes.get(line.key);
      if (node === undefined || node.kind !== line.kind) {
        node?.row.remove();
        node = build(line);
        nodes.set(line.key, node);
        fresh.push(node.row);
      }
      if (node.q.textContent !== line.q) node.q.textContent = line.q;
      if (node.v.textContent !== line.v) node.v.textContent = line.v;
      node.row.dataset.empty = String(line.v === '');
      const want: ChildNode | null = previous === null ? list.firstChild : previous.nextSibling;
      if (want !== node.row) list.insertBefore(node.row, want);
      previous = node.row;
    }
    list.style.maxHeight = `${Math.max(0, Math.round(deps.maxHeight()))}px`;
    if (pinned) list.scrollTop = list.scrollHeight;
    list.dataset.overflow = String(list.scrollHeight > list.clientHeight + 1);
    if (deps.reduced()) return;
    fresh.forEach((row, index) => {
      animate(row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
        duration: 220, easing: EASE_OUT, delay: Math.min(index, 6) * 18, fill: 'backwards',
      });
    });
  };

  const sync = (lines: readonly FeedLine[]): void => {
    wanted = lines;
    if (frame !== 0 || timer !== null) return;
    if (win !== null && typeof win.requestAnimationFrame === 'function') frame = win.requestAnimationFrame(flush);
    else timer = setTimeout(flush, 16);
  };

  const clear = (): void => {
    if (frame !== 0) { win?.cancelAnimationFrame?.(frame); frame = 0; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    wanted = null;
    for (const node of nodes.values()) node.row.remove();
    nodes.clear();
    list.style.maxHeight = '';
    delete list.dataset.overflow;
  };

  return { sync, clear };
}
