import { animate, el } from './dom';
import { ringTargetFor } from './hostField';

/**
 * 「去第一项／下一处／去这一栏」带他到那一栏之后，在那一栏上亮一下（2026-09-28）。
 *
 * 负责人 2026-09-28：保证不了在每一个真实网站上都画对的东西就不画——内层滚动、iframe、吸顶的页头、缩放与变换、
 * 会整块重画的框架，都会让常驻在网页上的标记错位。所以只剩这一下：滚动停下之后量一次，亮一圈柔和的环，1.2 秒内
 * 淡掉；这期间页面一滚动、窗口一变、他一打字（或点了别处），立刻拿掉。不跟着版面走，不碰网页上的任何东西——
 * 环画在我们关着的 shadow 里，只用手里现成的元素引用量一次位置。减少动态时不放大、不淡入淡出，只亮一下就拿掉。
 */
export interface FieldFlash {
  /** 画在我们 shadow 里的那一层（`position: fixed`，不接点击）。 */
  readonly element: HTMLElement;
  /** 等滚动停下，在这一栏上亮一下；之前那一下立刻拿掉。 */
  show(target: Element): void;
  /** 立刻拿掉（新的一轮、面板收掉了）。 */
  clear(): void;
  destroy(): void;
}

/** 从亮起到淡完（负责人：约 1.2 秒）。 */
export const FLASH_MS = 1_200;
/** 等滚动停下最多等这么久（平滑滚动一般三四百毫秒）；到了就照当下的位置量。 */
const SETTLE_CAP_MS = 900;
/** 环离那一栏的边多远。 */
const GAP = 4;
/** 这几样一来就拿掉：页面滚动、窗口变了、他打字或点了别处。 */
const DOCUMENT_EVENTS = ['keydown', 'input', 'pointerdown'] as const;

export const FIELD_FLASH_CSS = `
.flash{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;display:none}
.flash[data-on='true']{display:block}
.flash-ring{position:absolute;inset:0;border-radius:11px;box-shadow:0 0 0 2px rgba(10,17,40,.62),0 0 0 7px rgba(91,141,239,.16)}
`;

export function createFieldFlash(deps: Readonly<{ doc: Document; reduced: () => boolean }>): FieldFlash {
  const { doc } = deps;
  const win = doc.defaultView;
  const element = el(doc, 'div', 'flash');
  element.setAttribute('aria-hidden', 'true');
  element.dataset.on = 'false';
  const ring = el(doc, 'div', 'flash-ring');
  element.append(ring);

  /** 每一次亮（与每一次拿掉）换一个号：还在等滚动停下的那一轮，号变了就不再亮。 */
  let serial = 0;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Animation | null = null;
  let listening = false;

  const nextFrame = (step: () => void): void => {
    if (win !== null && typeof win.requestAnimationFrame === 'function') frame = win.requestAnimationFrame(step);
    else timer = setTimeout(step, 16);
  };

  const onInterrupt = (): void => { clear(); };
  const listen = (on: boolean): void => {
    if (on === listening) return;
    listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    win?.[method]('scroll', onInterrupt, { capture: true } as AddEventListenerOptions);
    win?.[method]('resize', onInterrupt);
    for (const type of DOCUMENT_EVENTS) doc[method](type, onInterrupt, { capture: true } as AddEventListenerOptions);
  };

  function clear(): void {
    serial += 1;
    if (frame !== 0) { win?.cancelAnimationFrame?.(frame); frame = 0; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const animation = running;
    running = null;
    if (animation !== null) {
      // 取消会让 `finished` 以 AbortError 落空：那是取消本身，不是出错（浏览器把它记作已处理，测试环境不一定）。
      animation.finished?.catch(() => undefined);
      animation.cancel();
    }
    listen(false);
    element.dataset.on = 'false';
  }

  /** 量一次、亮一下；看不见（没有大小、整个在视口外）就不亮。 */
  const light = (target: Element, token: number): void => {
    if (token !== serial || !target.isConnected) return;
    const rect = ringTargetFor(target).getBoundingClientRect();
    const height = win?.innerHeight ?? 0;
    const width = win?.innerWidth ?? 0;
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || (height > 0 && rect.top >= height) || (width > 0 && rect.left >= width)) return;
    element.style.transform = `translate(${rect.left - GAP}px,${rect.top - GAP}px)`;
    element.style.width = `${rect.width + GAP * 2}px`;
    element.style.height = `${rect.height + GAP * 2}px`;
    element.dataset.on = 'true';
    listen(true);
    if (!deps.reduced()) {
      running = animate(ring, [
        { opacity: 0, transform: 'scale(1.06)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.2 },
        { opacity: 1, transform: 'scale(1)', offset: 0.55 },
        { opacity: 0, transform: 'scale(1)' },
      ], { duration: FLASH_MS, easing: 'ease-out', fill: 'both' });
    }
    // 动画放完（或没有动画）就拿掉：到点一律拿掉，不靠动画的结束事件。
    timer = setTimeout(() => { if (token === serial) clear(); }, FLASH_MS);
  };

  const show = (target: Element): void => {
    clear();
    const token = serial;
    const started = Date.now();
    let last: { top: number; left: number } | null = null;
    let still = 0;
    // 滚动停下：同一个位置连着两帧没动（平滑滚动的最后几帧也算在动），或者等够了上限。
    const step = (): void => {
      frame = 0;
      timer = null;
      if (token !== serial || !target.isConnected) return;
      const rect = ringTargetFor(target).getBoundingClientRect();
      still = last !== null && Math.abs(rect.top - last.top) < 0.5 && Math.abs(rect.left - last.left) < 0.5 ? still + 1 : 0;
      last = { top: rect.top, left: rect.left };
      if (still >= 2 || Date.now() - started >= SETTLE_CAP_MS) light(target, token);
      else nextFrame(step);
    };
    nextFrame(step);
  };

  const destroy = (): void => {
    clear();
    element.remove();
  };

  return { element, show, clear, destroy };
}
