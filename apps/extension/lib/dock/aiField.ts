import type { DockCopy } from './copy';
import { EASE, EASE_OUT } from './css';
import { animate, el, trusted } from './dom';
import { hostFieldHasValue, hostFieldState, ringTargetFor } from './hostField';
import { logo } from './logo';
import type { DockAiGenerateOutcome, DockAiQuota, DockAiTools } from './types';

/**
 * 网页上那几栏旁边的 AI 标记与「用 AI 写 / AI 改写」卡片（2026-09-23／24 负责人）。
 *
 * 全部画在浮层自己那一个关着的 shadow 里：`position:absolute` 的节点跟着宿主控件的位置走（与定位环同一个
 * 办法），宿主页上的节点、值、样式一样都不碰（RULE-GLOBAL-DOM-RULE-BOUNDARY）。只认原生控件与 ARIA 的形状，
 * 不认任何一家的 DOM。
 *
 *  · 边（标记 D）：AI 写进去的那一栏，样式见 `AI_EDGE_STYLE`（2026-09-24 负责人看过真页面上的四种，定了 `none`：不要边，
 *    只留小片；AI 写了哪几栏由浮层单列的「AI 代答」那一组交代）。留着的 `hug` 看上去就是
 *    这一栏自己的左边框变成了蓝色：与看得见的那一格同一个矩形、同样的圆角，不内缩、上下不留缝（Workable 的边框画在
 *    外面第二层 div 上，就量那一层）。用户自己改了那一栏、或撤销了，就撤下。
 *  · 小片：AI 写过的、交来「用 AI 写 / AI 改写」的每一栏各一枚，样子只看这一栏里此刻有没有字（2026-09-24 负责人）：
 *    空着是胶囊（帆船 + ArgoLand.AI），有字（AI 写的，或用户自己打的）是 22px 的圆片，只有帆船。字出现、消失时胶囊
 *    缩成圆片、圆片长回胶囊，右边不动。位置见 `AI_BADGE_POSITION`（2026-09-24 负责人定了 `inside`：与空着时同在框里右下角，悬停往左展开）：多行框空着在框里右下角（Jobright
 *    的在左下角，不叠在一起），让开滚动条或拖动把手；有字时落在底边的中线上，不压字。单行框在框里右边、上下居中；
 *    选择题、下拉、组合框在框外右边、上下居中，绝不压在选项上。
 *  · 悬停、键盘聚焦：只往左长、不缩——圆片长成「AI 改写」＋帆船，胶囊长成「用 AI 写」＋帆船 ArgoLand.AI。宽度 240ms
 *    `--argo-ease`，文字透明度 160ms；多行框在框里与底边之间换位置时用同一条曲线滑过去。系统要求减少动态时直接换。
 *  · 点一下：卡片从小片里长出来（FLIP：从小片的矩形变换到卡片的矩形，transform-origin 就在小片那里，340ms，
 *    `EASE`；透明度 0→1 用 120ms；卡片里的内容晚 130ms 再淡入上移 4px，200ms，`EASE_OUT`）；关的时候反着缩回
 *    小片里（内容 90ms 淡出，卡片 240ms 加速缩回，最后 110ms 淡出）。系统要求减少动态时只淡入淡出（150ms／120ms）。
 *    卡片默认在小片上方，上面放不下就放下方，始终在视口里，跟着滚动与缩放走。
 */

export interface AiFieldSpec {
  readonly element: Element;
  /** AI 写进去的内容（这一栏此刻该挂标记 D）；没有就是 null。 */
  readonly aiValue: string | null;
  /** 旁边摆不摆「用 AI 写 / AI 改写」。 */
  readonly tool: boolean;
}

export interface AiFieldLayerDeps {
  readonly doc: Document;
  /** 我们在宿主页上的那一个宿主节点（在文档上听点击时，用它认「点在我们里面」）。 */
  readonly host: Element;
  /** shadow 里的根：卡片外、浮层里别处的点击在这里听。 */
  readonly root: HTMLElement;
  readonly shadow: ShadowRoot;
  readonly reduced: () => boolean;
  readonly tools: () => DockAiTools | null;
  readonly openPricing: () => void;
  readonly toast: (text: string) => void;
  /** 浮层这一套语言的文案（小片、卡片与提示都用它）。 */
  readonly copy: DockCopy;
  /** 边与小片位置的覆盖（只给测试与浮层预览工具用；产品里不传，用下面两个常量）。 */
  readonly edgeStyle?: AiEdgeStyle;
  readonly badgePosition?: AiBadgePosition;
}

export interface AiFieldLayer {
  /** 边与小片（放在面板下面一层）。 */
  readonly marks: HTMLElement;
  /** 卡片（放在最上面一层）。 */
  readonly cards: HTMLElement;
  sync(specs: readonly AiFieldSpec[]): void;
  reposition(): void;
  /** 看用户是不是动过那几栏：动过 AI 写的内容就撤下标记 D；空栏小片上的字跟着换。 */
  recheck(): void;
  /** 有卡片开着就关上，返回 true（Esc 用）。 */
  closeCard(): boolean;
  clear(): void;
}

export const AI_FIELD_CSS = `
.aif{position:absolute;inset:0;pointer-events:none}
${'' /* 标记 D 的边：换样式只改这一块与 AI_EDGE_STYLE（几何在 placeEdge 里）。 */}
.aim-edge{position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none}
.aim-edge[data-edge='hug']{border:2px solid transparent;border-left-color:#2F6FEB}
.aim-edge[data-edge='ring']{border:1.5px solid #2F6FEB;box-shadow:0 0 0 3px rgba(47,111,235,.13)}
.aim-edge[data-busy='true']{animation:aLinePulse 1.1s ease-in-out infinite}
${'' /* 生成中：不要边时也看得出这一栏在写——小片上的帆船一跳一跳。 */}
.aic[data-busy='true'] img{animation:aLinePulse 1.1s ease-in-out infinite}
@keyframes aLinePulse{0%,100%{opacity:.3}50%{opacity:1}}
${'' /* 小片：空着是胶囊（帆船 + ArgoLand.AI），有字是 22px 圆片（只有帆船）。锚在右边、上下中线（框外右侧的锚在左边）。 */}
.aic{position:absolute;left:0;top:0;z-index:1;transform:translate(-100%,-50%);display:inline-flex;align-items:center;justify-content:center;
  height:22px;padding:0 4px;border:0;border-radius:11px;background:#fff;color:#0A1128;
  box-shadow:0 0 0 .5px rgba(10,17,40,.2),0 1px 3px rgba(10,17,40,.14);
  font-size:var(--fs-caption);font-weight:600;line-height:var(--lh-caption);letter-spacing:.02em;white-space:nowrap;pointer-events:auto;
  transition:padding .24s var(--argo-ease)}
span.aic{pointer-events:none}
.aic[data-place='outside']{transform:translate(0,-50%)}
.aic[data-fill='empty']{padding:0 9px 0 5px}
.aic img{flex:0 0 auto}
.aic-t{display:inline-block;overflow:hidden;max-width:0;opacity:0;
  transition:max-width .24s var(--argo-ease),margin .24s var(--argo-ease),opacity .16s ease}
.aic[data-fill='empty'] .aic-word{max-width:var(--w,72px);opacity:1;margin-left:4px}
${'' /* 悬停、键盘聚焦、卡片开着：只往左长，露出「AI 改写 / 用 AI 写」；帆船与 ArgoLand.AI 一个都不收。 */}
button.aic:hover,button.aic:focus-visible,button.aic[aria-expanded='true']{padding-left:9px}
button.aic:hover .aic-verb,button.aic:focus-visible .aic-verb,button.aic[aria-expanded='true'] .aic-verb{max-width:var(--w,64px);opacity:1;margin-right:4px}
button.aic:disabled{cursor:default}
.aip{position:absolute;left:0;top:0;width:312px;border-radius:14px;background:#fff;color:#0A1128;pointer-events:auto;
  box-shadow:0 0 0 .5px rgba(10,17,40,.12),0 18px 40px -14px rgba(10,17,40,.38),0 2px 6px rgba(10,17,40,.06)}
.aip-in{position:relative;z-index:1;display:grid;gap:8px;padding:12px 12px 10px}
.aip-head{display:flex;align-items:center;gap:6px;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128}
.aip-ta{display:block;width:100%;min-height:66px;max-height:160px;resize:none;border:0;border-radius:10px;background:#F3F6FA;
  padding:9px 10px;font-size:var(--fs-body);line-height:var(--lh-body);color:#0A1128;outline:none;transition:box-shadow .2s ease,background-color .2s ease}
.aip-ta:focus{background:#fff;box-shadow:inset 0 0 0 1.5px #A8C0DC}
.aip-ta::placeholder{color:#8A94A8}
.aip-ta:disabled{opacity:.6}
.aip-msg{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#B4483A}
.aip-msg[data-tone='ok']{color:#3B4762}
.aip-msg:empty{display:none}
.aip-used{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}
.aip-link{border:0;background:transparent;padding:0;color:#2F6FEB;font-size:var(--fs-meta);line-height:var(--lh-meta);font-weight:600;text-decoration:underline;text-underline-offset:2px}
.aip-foot{display:flex;align-items:center;gap:6px}
.aip-quota{flex:1;min-width:0;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#8A94A8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aip-btn{height:32px;border-radius:9px;border:0;padding:0 12px;font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.aip-cancel{background:transparent;color:#4F5B73;font-weight:500}
.aip-cancel:hover{background:rgba(10,17,40,.05)}
.aip-go{min-width:64px;background:linear-gradient(180deg,#1B2542,#0A1128);color:#fff}
.aip-btn:disabled{opacity:.55;cursor:default}
.aip-spin{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.28);border-top-color:#fff;animation:aSpin .8s linear infinite}
.aip-caret{position:absolute;left:0;width:12px;height:12px;background:#fff;transform:rotate(45deg)}
.aip[data-side='above'] .aip-caret{bottom:-6px;box-shadow:.5px .5px 0 rgba(10,17,40,.12)}
.aip[data-side='below'] .aip-caret{top:-6px;box-shadow:-.5px -.5px 0 rgba(10,17,40,.12)}
.glyph[data-kind='ai']{background:#EAF1FE;color:#2F6FEB}
.nai{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px;font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}
.ai-offer{margin-top:10px;display:grid;gap:4px;padding:12px;border-radius:14px;background:#EAF1FE}
.ai-offer-title{font-size:var(--fs-body);line-height:var(--lh-body);font-weight:600;color:#0A1128}
.ai-offer-text{font-size:var(--fs-meta);line-height:var(--lh-meta);color:#3B4762}
.ai-offer-btn{height:38px;margin-top:6px;display:flex;align-items:center;justify-content:center;gap:7px}
.ai-offer-spin{width:14px;height:14px}
.pop-toggle{margin-left:auto;width:34px;height:20px;padding:2px}
.pop-toggle .pf-knob{width:16px;height:16px}
.pop-toggle[data-on='true'] .pf-knob{transform:translateX(14px)}
`;

interface Entry {
  readonly element: Element;
  aiValue: string | null;
  tool: boolean;
  /** 挂上标记 D 那一刻这一栏的样子（hostFieldState）；之后变了样就是用户动过。 */
  snapshot: string | null;
  dismissed: boolean;
  busy: boolean;
  edge: HTMLElement | null;
  chip: HTMLElement | null;
  chipKind: string;
  verb: HTMLElement | null;
  word: HTMLElement | null;
  /** 小片上一次落在哪（'' 是还没摆过）与那时的锚点：多行框在框里与底边之间换位置时，从那里滑过去。 */
  place: string;
  x: number;
  y: number;
}

interface Card {
  readonly entry: Entry;
  readonly node: HTMLElement;
  readonly inner: HTMLElement;
  readonly caret: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  readonly message: HTMLElement;
  readonly used: HTMLElement;
  readonly quotaLine: HTMLElement;
  readonly usedText: HTMLElement;
  readonly upgrade: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly go: HTMLButtonElement;
  readonly revise: boolean;
  above: boolean;
  rect: { left: number; top: number; width: number; height: number };
  quota: DockAiQuota | null;
  usedUp: boolean;
  confirm: ((event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAiGenerateOutcome>) | null;
  closed: boolean;
}

type Rect = { left: number; top: number; right: number; bottom: number };

/** 生成没成的那几种原因各说哪一句（`CANCELLED` 什么都不说）。浮层「需要你」里的「AI 帮我写」也用它（2026-09-28）。 */
export function aiFailedText(copy: DockCopy, reason: Extract<DockAiGenerateOutcome, { kind: 'FAILED' }>['reason']): string {
  const card = copy.ai.card;
  const text: Readonly<Record<typeof reason, string>> = {
    UNAVAILABLE: card.unavailable,
    LOGIN: card.login,
    CHANGED: card.changed,
    PAGE_CHANGED: card.pageChanged,
    UNTRUSTED: card.untrusted,
    TOO_LONG: card.tooLong,
    SWITCHED_OFF: card.switchedOff,
    CANCELLED: '',
  };
  return text[reason] ?? card.unavailable;
}

/**
 * 标记 D 的边（2026-09-24 负责人定了 `none`）：`hug` 是这一栏自己的左边框变蓝（同一个矩形、同样的圆角）；`ring`
 * 沿这一格一圈 1.5px 的蓝边，外加 3px 的淡光晕；`none` 不要边，只留小片。换哪一种只改这一个常量——几何在
 * `placeEdge`，样式在 CSS 的 `.aim-edge` 那一块。
 */
export type AiEdgeStyle = 'hug' | 'ring' | 'none';
export const AI_EDGE_STYLE: AiEdgeStyle = 'none';

/**
 * 有字的多行框，小片放在哪（2026-09-24 负责人定了 `inside`）：`inside` 与空着时一样在框里右下角；`border` 是 22px
 * 圆片的圆心落在底边上、右边离框 16px，不压字。只管有字的多行框——空着的多行框、单行框、选择题都不看这一项。
 */
export type AiBadgePosition = 'inside' | 'border';
export const AI_BADGE_POSITION: AiBadgePosition = 'inside';

/** 小片的高，也是圆片的直径。 */
const BADGE = 22;

/** 这一栏是哪一种：多行框、单行框（小片在框里），还是选择题、下拉、组合框（小片在框外右侧，不压在选项上）。 */
export type AiBadgeKind = 'multi' | 'single' | 'outside';

export function badgeKindOf(element: Element): AiBadgeKind {
  const view = element.ownerDocument.defaultView;
  if (view !== null && element instanceof view.HTMLTextAreaElement) return 'multi';
  if (view !== null && element instanceof view.HTMLInputElement) {
    if (element.type === 'radio' || element.type === 'checkbox') return 'outside';
    const role = (element.getAttribute('role') ?? '').toLowerCase();
    const listbox = role === 'combobox' || element.hasAttribute('aria-autocomplete') ||
      (element.getAttribute('aria-haspopup') ?? '').toLowerCase() === 'listbox';
    return listbox ? 'outside' : 'single';
  }
  return 'outside';
}

export interface AiBadgeAnchor {
  /** 小片右边的横坐标（框外右侧时是左边）。 */
  readonly x: number;
  /** 小片上下的中线。 */
  readonly y: number;
  readonly place: 'inside' | 'border' | 'outside';
}

/**
 * 小片落在哪。`box` 是这一栏看得见的那一格，`rail` 是多行框右边要让开的滚动条或拖动把手（`railOf`）：
 *  · 多行框：框里右下角，右边让 7px + rail，下边让 7px；有字且 `border` 时圆心落在底边上、右边离框 16px。
 *  · 单行框：框里右边 8px，上下居中。
 *  · 选择题、下拉、组合框：框外右边 8px，上下居中。
 */
export function badgeAnchorOf(kind: AiBadgeKind, box: Rect, filled: boolean, rail: number, position: AiBadgePosition = AI_BADGE_POSITION): AiBadgeAnchor {
  const middle = (box.top + box.bottom) / 2;
  if (kind === 'outside') return { x: box.right + 8, y: middle, place: 'outside' };
  if (kind === 'single') return { x: box.right - 8, y: middle, place: 'inside' };
  if (filled && position === 'border') return { x: box.right - 16, y: box.bottom, place: 'border' };
  return { x: box.right - 7 - rail, y: box.bottom - 7 - BADGE / 2, place: 'inside' };
}

/** 多行框右边要让开的：竖向滚动条的宽；没有滚动条、右下角有拖动把手时让 16px。 */
export function railOf(element: Element): number {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const px = (value: string | undefined): number => {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const box = element as HTMLElement;
  const scrollbar = Math.max(0, (box.offsetWidth || 0) - (box.clientWidth || 0) - px(style?.borderLeftWidth) - px(style?.borderRightWidth));
  if (scrollbar > 0) return scrollbar;
  const resize = style?.resize ?? '';
  return element.tagName === 'TEXTAREA' && resize !== '' && resize !== 'none' ? 16 : 0;
}

/**
 * 一道选择题的全部选项（只认原生控件与 ARIA，不认任何一家的 DOM）：原生单选／复选按同一个 name 成组；ARIA 代理
 * 按它的分组容器（radiogroup / group / fieldset），是非按钮没有分组容器时就是同一个父元素下的那几颗。认不出就只有它自己。
 */
function choiceMembers(element: Element): Element[] {
  const view = element.ownerDocument.defaultView;
  if (view !== null && element instanceof view.HTMLInputElement && (element.type === 'radio' || element.type === 'checkbox')) {
    if (element.name === '') return [element];
    const scope: ParentNode = element.form ?? element.ownerDocument;
    const group = Array.from(scope.querySelectorAll('input')).filter((other) => other.type === element.type && other.name === element.name);
    return group.length > 0 ? group : [element];
  }
  const pressed = element.hasAttribute('aria-pressed');
  const role = (element.getAttribute('role') ?? '').toLowerCase();
  if (!pressed && !(element.hasAttribute('aria-checked') && /^(?:radio|checkbox)$/.test(role))) return [element];
  const container = element.parentElement?.closest('[role="radiogroup"], [role="group"], fieldset') ?? (pressed ? element.parentElement : null);
  if (container === null || container === undefined) return [element];
  const members = Array.from(container.querySelectorAll(pressed ? 'button[aria-pressed]' : `[role="${role}"][aria-checked]`));
  return members.length > 0 ? members : [element];
}

const rectOf = (node: Element): Rect => {
  const r = node.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

const TRANSPARENT = /^(?:transparent|rgba?\([^)]*[,/]\s*0(?:\.0*)?%?\s*\))$/i;

/** 这一层自己有没有看得见的边：左边框有宽度、有样式、不透明；外面几层还认阴影画的边。只读计算样式，不改宿主。 */
function outlined(node: Element, outer: boolean): boolean {
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  if (style === undefined) return false;
  const width = Number.parseFloat(style.borderLeftWidth);
  if (width > 0 && !/^(?:none|hidden)$/.test(style.borderLeftStyle) && !TRANSPARENT.test(style.borderLeftColor.trim())) return true;
  return outer && style.boxShadow !== '' && style.boxShadow !== 'none';
}

/**
 * 从 `start` 往外最多三层，第一层带看得见的边、包住 `inner`、又只比它略大一圈的（宽多不过 120px、高多不过 24px——
 * 不圈到连题面一起的整张卡片）；没有就是 null。
 */
function outlinedAround(start: Element, inner: Rect): Element | null {
  let node: Element | null = start;
  for (let depth = 0; node !== null && depth < 4; depth += 1, node = node.parentElement) {
    const r = rectOf(node);
    if (depth > 0 && (r.right - r.left > inner.right - inner.left + 120 || r.bottom - r.top > inner.bottom - inner.top + 24)) return null;
    const wraps = r.left <= inner.left + 1 && r.top <= inner.top + 1 && r.right >= inner.right - 1 && r.bottom >= inner.bottom - 1;
    if (wraps && outlined(node, depth > 0)) return node;
  }
  return null;
}

/** 边与小片量的那一格，与它自己的圆角。 */
export interface AiBox {
  readonly rect: Rect;
  readonly radius: string;
}

/**
 * 这一栏看得见的那一格：这一栏自己，或外面最多三层里第一层带看得见的边、正好包住它的（Workable 的输入框自己的边
 * 是透明的，边框画在外面第二层 div 上）。太小的控件先按定位环往外找看得见的盒子。选择题是全部选项的外接框，外面有
 * 一层带边的框正好包住它们就用那一层（Workable 的 YES/NO）；没有就用外接框，圆角左边照第一项、右边照最后一项
 * （Ashby 的是非按钮）。太高就退回这一项自己的那一格。
 */
export function aiBoxOf(element: Element, kind: AiBadgeKind = badgeKindOf(element)): AiBox {
  const view = element.ownerDocument.defaultView;
  const radiusOf = (node: Element): string => view?.getComputedStyle(node).borderRadius ?? '';
  if (kind === 'outside') {
    const members = choiceMembers(element);
    const boxes = members.length > 1
      ? members.map((member) => rectOf(ringTargetFor(member))).filter((box) => box.right - box.left > 0 && box.bottom - box.top > 0)
      : [];
    if (boxes.length > 0) {
      const union: Rect = {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
      };
      if (union.bottom - union.top <= 320) {
        const around = outlinedAround(members[0]!, union);
        if (around !== null) return { rect: rectOf(around), radius: radiusOf(around) };
        const first = view?.getComputedStyle(members[0]!);
        const last = view?.getComputedStyle(members[members.length - 1]!);
        const corners = [first?.borderTopLeftRadius, last?.borderTopRightRadius, last?.borderBottomRightRadius, first?.borderBottomLeftRadius];
        return { rect: union, radius: corners.every((corner) => corner !== undefined && corner !== '') ? corners.join(' ') : '' };
      }
    }
  }
  const own = rectOf(element);
  const base = kind !== 'outside' && own.right - own.left >= 40 && own.bottom - own.top >= 16 ? element : ringTargetFor(element);
  const node = outlinedAround(element, rectOf(base)) ?? base;
  return { rect: rectOf(node), radius: radiusOf(node) };
}

/** 恢复的那一天（用户本地的日期）；给不出就是 null。 */
function localDate(iso: string | null): { month: number; day: number } | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? { month: date.getMonth() + 1, day: date.getDate() } : null;
}

let cardSerial = 0;

export function createAiFieldLayer(deps: AiFieldLayerDeps): AiFieldLayer {
  const { doc, copy: COPY } = deps;
  const edgeStyle = deps.edgeStyle ?? AI_EDGE_STYLE;
  const badgePosition = deps.badgePosition ?? AI_BADGE_POSITION;
  const win = doc.defaultView;
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => el(doc, tag, cls, text);
  const marks = h('div', 'aif');
  const cards = h('div', 'aif');
  const entries = new Map<Element, Entry>();
  let card: Card | null = null;
  const vp = (): { w: number; h: number } => ({ w: win?.innerWidth || 1200, h: win?.innerHeight || 760 });

  // ── 量位置 ──────────────────────────────────────────────────────
  /** 这一块此刻看得见的范围：视口，与路上每一个会裁剪的祖先的交集。 */
  const clipFor = (from: Element): Rect => {
    const { w, h: height } = vp();
    const clip: Rect = { left: 0, top: 0, right: w, bottom: height };
    const view = from.ownerDocument.defaultView;
    let node = from.parentElement;
    for (let depth = 0; node !== null && depth < 16; depth += 1, node = node.parentElement) {
      if (node === from.ownerDocument.body || node === from.ownerDocument.documentElement) break;
      const style = view?.getComputedStyle(node);
      if (style === undefined || !/(auto|scroll|hidden|clip|overlay)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
      const rect = node.getBoundingClientRect();
      clip.left = Math.max(clip.left, rect.left);
      clip.top = Math.max(clip.top, rect.top);
      clip.right = Math.min(clip.right, rect.right);
      clip.bottom = Math.min(clip.bottom, rect.bottom);
    }
    return clip;
  };

  /**
   * 标记 D 的边：与看得见的那一格同一个矩形、同样的圆角（`hug` 只把左边框涂蓝，`ring` 一整圈加光晕）。用 left/top 摆，
   * 与宿主的边框走同一套像素取整；被会裁剪的祖先挡住的部分裁掉，ring 的光晕在没被挡住的几边照样露出来。
   */
  const placeEdge = (edge: HTMLElement, box: AiBox, clip: Rect): void => {
    const r = box.rect;
    edge.dataset.edge = edgeStyle;
    const shown = r.right > clip.left && r.left < clip.right && r.bottom > clip.top && r.top < clip.bottom;
    edge.style.display = shown ? 'block' : 'none';
    if (!shown) return;
    edge.style.left = `${r.left}px`;
    edge.style.top = `${r.top}px`;
    edge.style.width = `${r.right - r.left}px`;
    edge.style.height = `${r.bottom - r.top}px`;
    edge.style.borderRadius = box.radius;
    const cut = [clip.top - r.top, r.right - clip.right, r.bottom - clip.bottom, clip.left - r.left];
    edge.style.clipPath = cut.some((side) => side > 0) ? `inset(${cut.map((side) => `${Math.max(-4, side)}px`).join(' ')})` : '';
  };

  /** 量一下「AI 改写 / 用 AI 写」与 ArgoLand.AI 各有多宽，展开时正好长到那么宽（量不到就先用 CSS 里的缺省宽）。 */
  const fit = (span: HTMLElement | null): void => {
    if (span === null || span.dataset.fit === span.textContent) return;
    const width = span.scrollWidth;
    if (!(width > 0)) return;
    span.style.setProperty('--w', `${Math.ceil(width)}px`);
    span.dataset.fit = span.textContent ?? '';
  };

  const placeEntry = (entry: Entry): void => {
    const element = entry.element;
    const hide = (): void => {
      if (entry.edge !== null) entry.edge.style.display = 'none';
      if (entry.chip !== null) entry.chip.style.display = 'none';
    };
    if (!element.isConnected) { hide(); return; }
    const kind = badgeKindOf(element);
    const box = aiBoxOf(element, kind);
    const r = box.rect;
    if (r.right - r.left < 2 || r.bottom - r.top < 2) { hide(); return; }
    const clip = clipFor(element);
    if (entry.edge !== null) placeEdge(entry.edge, box, clip);
    const chip = entry.chip;
    if (chip === null) return;
    const anchor = badgeAnchorOf(kind, r, chip.dataset.fill === 'filled', kind === 'multi' ? railOf(element) : 0, badgePosition);
    // 整枚都在看得见的范围里才摆（框外右侧放不下 22px 的圆片就不放）。
    const left = anchor.place === 'outside' ? anchor.x : anchor.x - BADGE;
    const right = anchor.place === 'outside' ? anchor.x + BADGE : anchor.x;
    const shown = left >= clip.left && right <= clip.right && anchor.y - BADGE / 2 >= clip.top && anchor.y + BADGE / 2 <= clip.bottom;
    const wasShown = entry.place !== '' && chip.style.display !== 'none';
    chip.dataset.place = anchor.place;
    chip.style.display = shown ? 'inline-flex' : 'none';
    chip.style.left = `${anchor.x}px`;
    chip.style.top = `${anchor.y}px`;
    // 多行框空着 ↔ 有字：在框里右下角与底边之间换位置，从原来的锚点滑过去（右边对齐着；宽度另由 CSS 过渡）。
    if (shown && wasShown && entry.place !== anchor.place && !deps.reduced()) {
      animate(chip, [{ translate: `${entry.x - anchor.x}px ${entry.y - anchor.y}px` }, { translate: '0px 0px' }], { duration: 240, easing: EASE });
    }
    entry.place = anchor.place;
    entry.x = anchor.x;
    entry.y = anchor.y;
    if (shown) { fit(entry.verb); fit(entry.word); }
  };

  // ── 小片与边 ───────────────────────────────────────────────────
  /** 小片此刻该是什么样：这一栏空着是胶囊、有字是圆片；悬停时露出的字与读屏念的跟着换。 */
  const paintChip = (entry: Entry): void => {
    const chip = entry.chip;
    if (chip === null) return;
    const filled = hostFieldHasValue(entry.element);
    const fill = filled ? 'filled' : 'empty';
    if (chip.dataset.fill !== fill) chip.dataset.fill = fill;
    if (entry.verb === null) return;
    const text = filled ? COPY.ai.chip.revise : COPY.ai.chip.write;
    if (entry.verb.textContent !== text) {
      entry.verb.textContent = text;
      fit(entry.verb);
    }
    chip.setAttribute('aria-label', filled ? COPY.ai.chip.reviseAria : COPY.ai.chip.writeAria);
  };
  const buildChip = (entry: Entry, interactive: boolean): HTMLElement => {
    const chip = interactive ? trusted(doc, 'aic', () => toggleCard(entry)) : h('span', 'aic');
    if (interactive) {
      chip.setAttribute('aria-haspopup', 'dialog');
      chip.setAttribute('aria-expanded', 'false');
    } else chip.setAttribute('aria-hidden', 'true');
    entry.verb = interactive ? h('span', 'aic-t aic-verb') : null;
    entry.word = h('span', 'aic-t aic-word', COPY.product);
    if (entry.verb !== null) chip.append(entry.verb);
    chip.append(logo(doc, 14), entry.word);
    return chip;
  };
  const removeEntry = (entry: Entry): void => {
    if (card?.entry === entry) closeCard(false);
    entry.edge?.remove();
    entry.chip?.remove();
    entries.delete(entry.element);
  };
  const render = (entry: Entry): void => {
    const mark = entry.aiValue !== null && !entry.dismissed;
    if (!mark && !entry.tool && !entry.busy) { removeEntry(entry); return; }
    const wantEdge = (mark || entry.busy) && edgeStyle !== 'none';
    if (wantEdge && entry.edge === null) {
      entry.edge = h('span', 'aim-edge');
      entry.edge.setAttribute('aria-hidden', 'true');
      marks.append(entry.edge);
    } else if (!wantEdge && entry.edge !== null) {
      entry.edge.remove();
      entry.edge = null;
    }
    if (entry.edge !== null) entry.edge.dataset.busy = String(entry.busy);
    // 能不能点（交没交来「用 AI 写 / AI 改写」）变了才换一枚；有没有字只换样子——同一枚缩成圆片、长回胶囊。
    const kind = entry.tool ? 'button' : 'span';
    if (entry.chipKind !== kind) {
      const open = card?.entry === entry;
      if (open) closeCard(false);
      entry.chip?.remove();
      entry.chip = buildChip(entry, entry.tool);
      entry.chipKind = kind;
      entry.place = '';
      // 先定好样子再放进去：第一次出现不从圆片长成胶囊。
      paintChip(entry);
      marks.append(entry.chip);
    } else paintChip(entry);
    if (entry.chip !== null) entry.chip.dataset.busy = String(entry.busy);
    if (entry.chip !== null && entry.chip.tagName === 'BUTTON') (entry.chip as HTMLButtonElement).disabled = entry.busy;
    placeEntry(entry);
  };

  // ── 卡片 ────────────────────────────────────────────────────────
  const placeCard = (state: Card): void => {
    const chip = state.entry.chip;
    if (chip === null) return;
    const c = chip.getBoundingClientRect();
    const { w, h: height } = vp();
    const width = Math.min(312, w - 16);
    state.node.style.width = `${width}px`;
    // 排版高度，不算变换：开合动画当中（从小片长出来的那几百毫秒）回来的次数也会重摆一次，那时量外框只有小片那么高。
    const cardHeight = state.node.offsetHeight || 150;
    let above = c.top - 10 - cardHeight >= 8;
    if (!above && c.bottom + 10 + cardHeight > height - 8 && c.top > height - c.bottom) above = true;
    const top = above ? Math.max(8, c.top - 10 - cardHeight) : Math.max(8, Math.min(height - 8 - cardHeight, c.bottom + 10));
    const left = Math.min(Math.max(8, c.right - width), w - 8 - width);
    state.node.style.left = `${left}px`;
    state.node.style.top = `${top}px`;
    state.node.dataset.side = above ? 'above' : 'below';
    state.caret.style.left = `${Math.min(Math.max(c.left + c.width / 2 - left - 6, 14), width - 26)}px`;
    state.above = above;
    state.rect = { left, top, width, height: cardHeight };
  };
  /**
   * 卡片与小片之间的 FLIP：把卡片的矩形变换成小片的矩形所需的那一个 transform（transform-origin 放在小片正对着
   * 的那条边上，缩放就是从小片那里长出来的）。起止两帧都精确落在各自的矩形上。
   */
  const flipFrom = (state: Card): { transform: string; origin: string } => {
    const c = state.entry.chip?.getBoundingClientRect();
    const { left, top, width, height } = state.rect;
    if (c === undefined || width <= 0 || height <= 0) return { transform: 'scale(.9)', origin: '100% 100%' };
    const ox = Math.min(Math.max(c.left + c.width / 2 - left, 0), width);
    const oy = state.above ? height : 0;
    const sx = Math.max(c.width / width, 0.04);
    const sy = Math.max(c.height / height, 0.04);
    const tx = c.left - left - ox + sx * ox;
    const ty = c.top - top - oy + sy * oy;
    return { transform: `translate(${tx}px,${ty}px) scale(${sx},${sy})`, origin: `${ox}px ${oy}px` };
  };

  const paintCard = (state: Card): void => {
    const busy = state.entry.busy;
    const quota = state.quota;
    const usedUp = state.usedUp || (quota !== null && !quota.unlimited && quota.remaining === 0);
    state.used.style.display = usedUp ? 'flex' : 'none';
    state.textarea.disabled = busy || usedUp;
    state.go.style.display = usedUp ? 'none' : 'inline-flex';
    state.go.disabled = busy;
    state.go.replaceChildren();
    if (busy) state.go.append(h('span', 'aip-spin'), doc.createTextNode(COPY.ai.card.generating));
    else state.go.append(doc.createTextNode(state.confirm !== null ? COPY.ai.card.fill : COPY.ai.card.generate));
    state.go.setAttribute('aria-busy', String(busy));
    state.quotaLine.textContent = !usedUp && quota !== null && !quota.unlimited && quota.remaining !== null
      ? COPY.ai.card.remaining(quota.remaining) : '';
    // 用完了：说这个月用完了、哪天恢复；会员不限次数，不给会员摆「升级会员」。
    const resets = localDate(quota?.resetsAt ?? null);
    state.usedText.textContent = resets === null ? COPY.ai.card.usedUp : COPY.ai.card.usedUpUntil(resets.month, resets.day);
    state.upgrade.style.display = quota?.unlimited === true ? 'none' : '';
  };

  /** 这个月的次数再问一次（打开卡片时，与生成时服务端说「用完了」之后——要知道哪天恢复）。 */
  const refreshQuota = (state: Card): void => {
    void deps.tools()?.quota().then((quota) => {
      if (card !== state || quota === null) return;
      state.quota = quota;
      paintCard(state);
      placeCard(state);
    }).catch(() => {});
  };

  const say = (state: Card, text: string, tone: 'ok' | 'error' = 'error'): void => {
    state.message.textContent = text;
    state.message.dataset.tone = tone;
  };

  const settle = (state: Card, outcome: DockAiGenerateOutcome): void => {
    state.entry.busy = false;
    render(state.entry);
    const open = card === state && !state.closed;
    switch (outcome.kind) {
      case 'WRITTEN':
        if (open) closeCard();
        deps.toast(COPY.ai.card.written);
        return;
      case 'NOTHING_TO_WRITE':
        if (open) say(state, COPY.ai.noEvidence); else deps.toast(COPY.ai.noEvidence);
        break;
      case 'USED_UP':
        state.usedUp = true;
        if (open) refreshQuota(state); else deps.toast(COPY.ai.card.usedUp);
        break;
      case 'EXPIRED':
        state.confirm = outcome.confirm;
        if (open) say(state, COPY.ai.card.expired, 'ok');
        break;
      case 'FAILED': {
        const text = aiFailedText(COPY, outcome.reason);
        if (text === '') break;
        if (open) say(state, text); else deps.toast(text);
        break;
      }
    }
    if (open) paintCard(state);
  };

  const generate = (state: Card, event: MouseEvent): void => {
    if (state.closed || state.entry.busy || state.usedUp) return;
    const tools = deps.tools();
    const wanted = (): boolean => !state.closed && card === state;
    let pending: Promise<DockAiGenerateOutcome>;
    // 这一下是这一次写入的凭证：调用方在派发当中同步取证，之后才去问、才写。
    try {
      const confirm = state.confirm;
      pending = confirm !== null
        ? confirm(event, deps.shadow)
        : tools === null
          ? Promise.resolve<DockAiGenerateOutcome>({ kind: 'FAILED', reason: 'UNAVAILABLE' })
          : tools.generate(state.entry.element, state.textarea.value.trim(), event, deps.shadow, wanted);
    } catch {
      pending = Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' });
    }
    state.confirm = null;
    state.entry.busy = true;
    say(state, '');
    render(state.entry);
    paintCard(state);
    void pending
      .catch((): DockAiGenerateOutcome => ({ kind: 'FAILED', reason: 'UNAVAILABLE' }))
      .then((outcome) => settle(state, outcome));
  };

  const openCard = (entry: Entry): void => {
    if (entry.chip === null) return;
    closeCard(false, false);
    cardSerial += 1;
    const titleId = `aip-title-${cardSerial}`;
    const revise = hostFieldHasValue(entry.element);
    const node = h('div', 'aip');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'false');
    node.setAttribute('aria-labelledby', titleId);
    const inner = h('div', 'aip-in');
    const head = h('div', 'aip-head');
    const title = h('b', '', revise ? COPY.ai.card.reviseTitle : COPY.ai.card.writeTitle);
    title.id = titleId;
    head.append(logo(doc, 14), title);
    const textarea = h('textarea', 'aip-ta');
    textarea.placeholder = COPY.ai.card.placeholder;
    textarea.setAttribute('aria-label', COPY.ai.card.placeholder);
    textarea.maxLength = 1_000;
    textarea.rows = 3;
    const message = h('div', 'aip-msg');
    message.setAttribute('role', 'status');
    const used = h('div', 'aip-used');
    const upgrade = trusted(doc, 'aip-link', () => deps.openPricing(), COPY.ai.card.upgrade);
    upgrade.dataset.action = 'ai-upgrade';
    const usedText = h('span', '', COPY.ai.card.usedUp);
    used.append(usedText, upgrade);
    const foot = h('div', 'aip-foot');
    const quotaLine = h('span', 'aip-quota');
    const cancel = trusted(doc, 'aip-btn aip-cancel', () => closeCard(), COPY.ai.card.cancel);
    cancel.dataset.action = 'ai-cancel';
    const go = trusted(doc, 'aip-btn aip-go', (event) => generate(state, event));
    go.dataset.action = 'ai-generate';
    foot.append(quotaLine, cancel, go);
    inner.append(head, textarea, message, used, foot);
    const caret = h('span', 'aip-caret');
    caret.setAttribute('aria-hidden', 'true');
    node.append(caret, inner);
    cards.append(node);
    const state: Card = {
      entry, node, inner, caret, textarea, message, used, quotaLine, usedText, upgrade, cancel, go, revise,
      above: true, rect: { left: 0, top: 0, width: 312, height: 150 }, quota: null, usedUp: false, confirm: null, closed: false,
    };
    card = state;
    entry.chip.setAttribute('aria-expanded', 'true');
    paintCard(state);
    placeCard(state);
    if (deps.reduced()) {
      animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
    } else {
      const { transform, origin } = flipFrom(state);
      node.style.transformOrigin = origin;
      animate(node, [{ transform }, { transform: 'none' }], { duration: 340, easing: EASE });
      animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
      animate(inner, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
        duration: 200, delay: 130, easing: EASE_OUT, fill: 'backwards',
      });
    }
    textarea.focus?.({ preventScroll: true });
    doc.addEventListener('pointerdown', onDocDown, true);
    deps.root.addEventListener('pointerdown', onRootDown, true);
    refreshQuota(state);
  };

  function closeCard(animated = true, focusChip = true): boolean {
    const state = card;
    if (state === null) return false;
    card = null;
    state.closed = true;
    doc.removeEventListener('pointerdown', onDocDown, true);
    deps.root.removeEventListener('pointerdown', onRootDown, true);
    state.entry.chip?.setAttribute('aria-expanded', 'false');
    const node = state.node;
    // 收回去的那几百毫秒里它只是一个影子：不再是对话框、读屏看不见、点不到、Tab 不进去。
    node.removeAttribute('role');
    node.setAttribute('aria-hidden', 'true');
    node.toggleAttribute('inert', true);
    node.dataset.closing = 'true';
    node.style.pointerEvents = 'none';
    const remove = (): void => { node.remove(); };
    if (!animated) remove();
    else if (deps.reduced()) {
      const fade = animate(node, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
      if (fade === null) remove(); else void fade.finished.then(remove, remove);
    } else {
      placeCard(state);
      const { transform, origin } = flipFrom(state);
      node.style.transformOrigin = origin;
      animate(state.inner, [{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'linear', fill: 'forwards' });
      const shrink = animate(node, [{ transform: 'none' }, { transform }], { duration: 240, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      animate(node, [{ opacity: 1 }, { opacity: 0 }], { duration: 110, delay: 130, easing: 'linear', fill: 'forwards' });
      if (shrink === null) remove(); else void shrink.finished.then(remove, remove);
    }
    if (focusChip) state.entry.chip?.focus?.({ preventScroll: true });
    return true;
  }

  const toggleCard = (entry: Entry): void => {
    if (card?.entry === entry) closeCard();
    else openCard(entry);
  };

  /** 点在网页上（不在我们的宿主节点里）：关卡片。 */
  function onDocDown(event: Event): void {
    if (card !== null && !event.composedPath().includes(deps.host)) closeCard(true, false);
  }
  /** 点在浮层里别处（不在卡片、也不在它的小片上）：关卡片。 */
  function onRootDown(event: Event): void {
    const state = card;
    if (state === null) return;
    const path = event.composedPath();
    if (!path.includes(state.node) && (state.entry.chip === null || !path.includes(state.entry.chip))) closeCard(true, false);
  }

  return {
    marks,
    cards,
    sync(specs) {
      const want = new Set(specs.map((spec) => spec.element));
      for (const entry of [...entries.values()]) {
        if (!want.has(entry.element) && !entry.busy) removeEntry(entry);
      }
      for (const spec of specs) {
        let entry = entries.get(spec.element);
        if (entry === undefined) {
          entry = {
            element: spec.element, aiValue: null, tool: false, snapshot: null, dismissed: false, busy: false,
            edge: null, chip: null, chipKind: '', verb: null, word: null, place: '', x: 0, y: 0,
          };
          entries.set(spec.element, entry);
        }
        if (spec.aiValue !== entry.aiValue) {
          entry.aiValue = spec.aiValue;
          entry.dismissed = false;
          entry.snapshot = spec.aiValue === null ? null : hostFieldState(spec.element);
        }
        entry.tool = spec.tool;
        render(entry);
      }
      if (card !== null) placeCard(card);
    },
    reposition() {
      for (const entry of entries.values()) placeEntry(entry);
      if (card !== null) placeCard(card);
    },
    recheck() {
      for (const entry of [...entries.values()]) {
        if (entry.aiValue !== null && !entry.dismissed && !entry.busy && hostFieldState(entry.element) !== entry.snapshot) {
          entry.dismissed = true;
          render(entry);
        } else paintChip(entry);
      }
    },
    closeCard: () => closeCard(),
    clear() {
      closeCard(false, false);
      for (const entry of [...entries.values()]) {
        entry.busy = false;
        removeEntry(entry);
      }
    },
  };
}
