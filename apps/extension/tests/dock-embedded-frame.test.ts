// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { shouldYieldToEmbeddedFrame } from '@edaix/apply-kernel/gate';

import { mountAutofillDock } from '../lib/autofillDock';
import { launcherTopPx } from '../product-panel/launcherPosition';

/**
 * 公司官网嵌 Greenhouse（2026-10-04，bench-1003 第七节第 4 条）：一页上两个浮层，只留能填的那一个，而且摆在看得见的地方。
 *
 * 那一天的样子（Brex、Datadog、Databricks、MongoDB）：顶层（公司域名）那一个亮着「自动填写」，按下去门控让位给 iframe
 * （`YIELDED_TO_FRAME`，「这一轮没有完成」），4/4 页整页失败；iframe 里那一个能填（Brex 实测必填 7/11），可它钉在 iframe
 * 的顶端——那一帧的视口就是整个 iframe（Brex 的 3868 像素高）——外层页面一滚，它就跟着申请表顶端出了屏幕。
 *
 * 信任模型一点没动：按「自动填写」的仍是那一帧自己 shadow 里的真实点击，授权仍按那一帧的页面签。
 */

/**
 * 像真的一样的 IntersectionObserver：只有「看得见的比例」跨过一个阈值（或看得见／看不见翻转）的那几个元素才回调。
 * 真的就是这样——2026-10-04 测试台上 Databricks 的 iframe 比视口高，外层页面在中段滚动时比例一直是 0.318，回调一次都不来。
 */
class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  readonly observed: Element[] = [];
  private readonly state = new Map<Element, string>();
  disconnected = false;
  constructor(readonly callback: (entries: IntersectionObserverEntry[]) => void, readonly options?: IntersectionObserverInit) {
    FakeIntersectionObserver.last = this;
  }
  observe(target: Element): void { this.observed.push(target); this.disconnected = false; }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true; this.observed.length = 0; this.state.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  /** 外层页面滚到这一帧的 [top, top + height) 看得见（这一帧自己的坐标）。 */
  show(top: number, height: number): void {
    const thresholds = ([] as number[]).concat(this.options?.threshold ?? [0]);
    const entries: IntersectionObserverEntry[] = [];
    for (const target of this.observed) {
      const own = (target as HTMLElement).style;
      const from = Number.parseFloat(own.top) || 0;
      const size = Number.parseFloat(own.height) || 0;
      const visibleTop = Math.max(from, top);
      const visible = Math.max(0, Math.min(from + size, top + height) - visibleTop);
      const ratio = size > 0 ? visible / size : 0;
      const key = `${visible > 0}|${thresholds.filter((threshold) => ratio >= threshold).length}`;
      if (this.state.get(target) === key) continue;
      this.state.set(target, key);
      entries.push({
        target,
        isIntersecting: visible > 0,
        intersectionRatio: ratio,
        intersectionRect: { top: visible > 0 ? visibleTop : 0, height: visible },
      } as unknown as IntersectionObserverEntry);
    }
    if (entries.length > 0) this.callback(entries);
  }
}

const originalIO = (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;

afterEach(() => {
  document.body.innerHTML = '';
  (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
  FakeIntersectionObserver.last = null;
  delete (document.documentElement as unknown as { scrollHeight?: number }).scrollHeight;
});

/** 这一帧的文档高（Brex 3868、Databricks 3142）：happy-dom 不布局，量出来是 0。 */
function frameHeight(px: number): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => px });
}

function mountInFrame() {
  frameHeight(3200);
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
  return mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    embeddedFrame: true,
  }, document);
}

const shadowOf = (handle: ReturnType<typeof mountInFrame>): ShadowRoot => handle.sceneRoot()!.getRootNode() as ShadowRoot;
const px = (value: string): number => Number.parseFloat(value);

describe('嵌入帧里的浮层：摆在这一帧此刻看得见的那一段里', () => {
  it('外层页面滚到申请表中段（这一帧的 1500–2300 看得见）→ 收起按钮与面板都挪到那一段里，不留在 iframe 顶端', () => {
    const handle = mountInFrame();
    const io = FakeIntersectionObserver.last;
    expect(io, '嵌入帧要量看得见的那一段').not.toBeNull();
    const launcher = shadowOf(handle).querySelector<HTMLElement>('.launcher')!;
    io!.show(1500, 800);
    // 收起按钮：那一段里同一个比例的位置（嵌入帧默认 12%）。
    expect(px(launcher.style.top)).toBe(1500 + launcherTopPx(0.12, 44, 800));
    handle.openPanel();
    const panel = shadowOf(handle).querySelector<HTMLElement>('.panel')!;
    expect(px(panel.style.top)).toBeGreaterThanOrEqual(1500);
    expect(px(panel.style.top) + px(panel.style.height)).toBeLessThanOrEqual(1500 + 800);
    // 再往下滚：跟着走。
    io!.show(2600, 800);
    expect(px(panel.style.top)).toBeGreaterThanOrEqual(2600);
  });

  it('外层页面在中段滚动（iframe 比视口高，看得见的比例一直不变）：照样跟着走', () => {
    // Databricks（2026-10-04 测试台）：3142 像素高的 iframe，外层页面滚到它中段以后比例一直是 0.318——只用一整条占位
    // 元素时回调一次都不来，浮层留在旧位置、出了屏幕。
    const handle = mountInFrame();
    const io = FakeIntersectionObserver.last!;
    handle.openPanel();
    const panel = shadowOf(handle).querySelector<HTMLElement>('.panel')!;
    io.show(1000, 800);
    expect(px(panel.style.top)).toBeGreaterThanOrEqual(1000);
    for (const top of [1010, 1300, 1990, 2400]) {
      io.show(top, 800);
      expect(px(panel.style.top), `滚到 ${top}`).toBeGreaterThanOrEqual(top);
      expect(px(panel.style.top), `滚到 ${top}`).toBeLessThanOrEqual(top + 20);
    }
  });

  it('量的只是我们 shadow 里的占位元素（不碰宿主的节点），每一块至多 100 像素、铺满这一帧；浮层拆掉时一并停下、拿掉', () => {
    const handle = mountInFrame();
    const io = FakeIntersectionObserver.last!;
    const slices = [...io.observed];
    expect(slices.length).toBe(32);
    for (const slice of slices) {
      expect(slice.getRootNode()).toBe(shadowOf(handle));
      expect(Number.parseFloat((slice as HTMLElement).style.height)).toBeLessThanOrEqual(100);
    }
    expect(slices[0]!.parentElement?.getAttribute('aria-hidden')).toBe('true');
    handle.dismiss();
    expect(io.disconnected).toBe(true);
    expect(slices.some((slice) => slice.isConnected)).toBe(false);
  });

  it('这一帧此刻一点都看不见：留在上一次的位置，不跳回 iframe 顶端', () => {
    const handle = mountInFrame();
    const io = FakeIntersectionObserver.last!;
    io.show(1200, 600);
    const launcher = shadowOf(handle).querySelector<HTMLElement>('.launcher')!;
    const before = launcher.style.top;
    io.show(0, 0);
    expect(launcher.style.top).toBe(before);
  });

  it('不是嵌入帧：不量，照旧按整个视口摆', () => {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
    expect(FakeIntersectionObserver.last).toBeNull();
    const launcher = (handle.sceneRoot()!.getRootNode() as ShadowRoot).querySelector<HTMLElement>('.launcher')!;
    expect(px(launcher.style.top)).toBe(launcherTopPx(0.42, 44, window.innerHeight));
  });
});

describe('顶层：页面上嵌着认得的 ATS iframe，就不挂自己那一个（它按下去只会让位）', () => {
  const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');

  it('与门控同一个判据：只读 iframe 的 src（Brex 的 boards.greenhouse.io/embed/job_app）', () => {
    // 判据只读 src：不必真的去加载那两个 iframe。
    (globalThis as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM!.settings.disableIframePageLoading = true;
    const doc = document;
    doc.body.innerHTML = '<main><h1>Account Executive</h1><iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_app?for=brex&token=8686667002"></iframe></main>';
    expect(shouldYieldToEmbeddedFrame({ doc, isTopFrame: true })).toBe(true);
    doc.body.innerHTML = '<main><iframe src="https://www.youtube.com/embed/x"></iframe></main>';
    expect(shouldYieldToEmbeddedFrame({ doc, isTopFrame: true })).toBe(false);
  });

  it('showFace：认出脸之后、挂之前先问让不让位；让位就撤下已经挂着的、不挂新的', () => {
    const from = content.indexOf('const showFace = (reply: unknown): void => {');
    const body = content.slice(from, from + 900);
    const parse = body.indexOf('const dock = parseAutofillDockInstruction(reply);');
    const yieldAt = body.indexOf('if (yieldToEmbeddedFrame()) return;');
    expect(parse).toBeGreaterThan(0);
    expect(yieldAt).toBeGreaterThan(parse);
    expect(content).toContain('return shouldYieldToEmbeddedFrame({ doc: document, isTopFrame });');
  });

  it('嵌入帧晚到（Datadog、Databricks、MongoDB：iframe 是页面脚本过几秒才插进来的）：那一帧挂上自己的浮层时，worker 叫顶层再看一眼', () => {
    // 2026-10-04 实测：顶层的脸在 iframe 出现之前就挂好了，之后没有人再问它让不让位——页面上两个浮层，顶层那一个按下去
    // 只会让位。那一帧报到、拿到一张要挂的脸的那一刻，worker 给顶层（frameId 0）发一声不带值的「再看一眼」。
    const worker = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    const record = worker.indexOf('await writeFrameForms((current) => recordFrameForm(current, entry).registry);');
    expect(record).toBeGreaterThan(0);
    expect(worker.slice(record, record + 400)).toContain("browser.tabs.sendMessage(tabId, { kind: 'dock/top-yield' }, { frameId: 0 })");
    // 顶层：只认 worker 发来的那一条；判不判让位仍是门控那个判据（只读 iframe 的 src），消息本身不算数。
    const listener = content.indexOf('!parseDockTopYield(raw)');
    expect(listener).toBeGreaterThan(0);
    const body = content.slice(content.lastIndexOf('browser.runtime.onMessage.addListener', listener), listener + 300);
    expect(body).toContain('!isTopFrame');
    expect(body).toContain('sender.id !== browser.runtime.id');
    expect(body).toContain('sender.tab');
    expect(content.slice(listener, listener + 300)).toContain('yieldToEmbeddedFrame();');
    const helper = content.indexOf('const yieldToEmbeddedFrame = (): boolean => {');
    expect(helper).toBeGreaterThan(0);
    expect(content.slice(helper, helper + 400)).toContain('if (!yieldsToEmbeddedFrame()) return false;');
    expect(content.slice(helper, helper + 400)).toContain('dockHandle?.dismiss();');
  });

  it('按下去那一刻才让位（嵌入帧晚到）：照实说去那里填，不说「这一轮没有完成」', () => {
    expect(content).toContain("if (code === 'YIELDED_TO_FRAME') {\n          dockHandle?.reportBlocked('IN_EMBEDDED_FRAME');");
  });

  it('浮层上那一句', () => {
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
    handle.openPanel();
    handle.reportBlocked('IN_EMBEDDED_FRAME');
    expect((handle.sceneRoot()?.textContent ?? '').replace(/\s+/g, ' ')).toContain('申请表嵌在这一页下方的那一块里');
  });
});
