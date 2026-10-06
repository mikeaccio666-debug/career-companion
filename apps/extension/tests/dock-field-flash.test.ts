// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';

/**
 * 网页上不常驻任何标记（2026-09-28 负责人：保证不了在每一个真实网站上都画对，就不画——内层滚动、iframe、吸顶的页头、
 * 缩放与变换、会整块重画的框架都会让它错位）。只留「去第一项／下一处／去这一栏」带他到那一栏之后的那一下：滚动停下之后
 * 量一次、亮一圈、1.2 秒内拿掉；这期间页面一滚动、窗口一变、他一打字，立刻拿掉。不跟着版面走。
 *
 * 夹具全是合成文字。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** 宿主页上的一栏（合成）：给它一个盒子；外面一层很大，不往外扩。 */
function hostField(tag: 'input' | 'textarea' | 'select', box: DOMRect) {
  const wrap = document.createElement('div');
  const field = document.createElement(tag);
  wrap.append(field);
  document.body.append(wrap);
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(box);
  vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1000, 3000));
  return field;
}

function setup() {
  const first = hostField('input', rect(40, 100, 300, 36));
  const why = hostField('textarea', rect(40, 280, 300, 90));
  const school = hostField('select', rect(40, 420, 300, 36));
  const rows: AutofillDockFieldRow[] = [
    { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Sample', target: first, planned: true },
    { label: 'Why do you want to work here?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY', target: why, planned: true },
    { label: 'School', required: true, done: false, state: 'FAILED', reason: 'NO_OPTION_MATCH', hint: 'Example University', target: school, planned: true },
  ];
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
  handle.openPanel();
  handle.beginPreparing();
  handle.beginRun({ runId: 'gesture-1', requiredQuestions: 3, requiredCompleted: 1, rows, phase: 'SETTLED' } as never);
  const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  const flash = shadow.querySelector<HTMLElement>('.flash')!;
  return { handle, shadow, flash, first, why, school };
}

describe('网页上的标记：不常驻', () => {
  it('填完之后网页上没有描边、编号或对勾；浮层「需要你」的行上也没有编号', () => {
    const { shadow, flash } = setup();
    expect(shadow.querySelectorAll('.pm-ring, .pm-no, .pm-check')).toHaveLength(0);
    expect(flash.dataset.on).toBe('false');
    expect(shadow.querySelectorAll('[data-need-row]')).toHaveLength(2);
    expect(shadow.querySelectorAll('[data-need-row] .need-no'), '编号只是为了对上网页上的标记：标记拿掉了，编号也拿掉').toHaveLength(0);
  });
});

describe('去那一栏：只亮一下', () => {
  it('「去第一项」：光标放进那一栏，滚动停下之后在它上面亮一圈（量一次），1.2 秒内拿掉', async () => {
    const { handle, flash, school } = setup();
    const focus = vi.spyOn(school, 'focus');
    click(handle.primaryButton());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(flash.dataset.on, '还在等滚动停下').toBe('false');
    await wait(150);
    expect(flash.dataset.on).toBe('true');
    expect(flash.style.transform).toBe('translate(36px,416px)');
    expect([flash.style.width, flash.style.height]).toEqual(['308px', '44px']);
    await wait(1_250);
    expect(flash.dataset.on).toBe('false');
  }, 5_000);

  it('亮着的时候：页面一滚动、窗口一变、他一打字或点了别处，立刻拿掉', async () => {
    const { handle, flash } = setup();
    const interruptions: Array<() => void> = [
      () => window.dispatchEvent(new Event('scroll')),
      () => window.dispatchEvent(new Event('resize')),
      () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })),
      () => document.body.dispatchEvent(new Event('input', { bubbles: true })),
      () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    ];
    for (const interrupt of interruptions) {
      click(handle.primaryButton());
      await wait(150);
      expect(flash.dataset.on).toBe('true');
      interrupt();
      expect(flash.dataset.on).toBe('false');
    }
  }, 5_000);

  it('不跟着版面走：亮起来之后那一栏挪了位置，环不跟着挪（下一次「去那一栏」再量）', async () => {
    const { handle, flash, school } = setup();
    click(handle.primaryButton());
    await wait(150);
    const at = flash.style.transform;
    vi.spyOn(school, 'getBoundingClientRect').mockReturnValue(rect(40, 600, 300, 36));
    await wait(60);
    expect(flash.style.transform).toBe(at);
  }, 5_000);

  it('那一栏看不见（没有大小，或整个在视口外）：不亮', async () => {
    const { handle, flash, school, why } = setup();
    vi.spyOn(school, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 0));
    click(handle.primaryButton());
    await wait(150);
    expect(flash.dataset.on, '没有大小').toBe('false');
    // 「下一处」去的是下一题（Why）：它整个在视口下面。
    vi.spyOn(why, 'getBoundingClientRect').mockReturnValue(rect(40, window.innerHeight + 400, 300, 90));
    click(handle.primaryButton());
    await wait(150);
    expect(flash.dataset.on, '整个在视口外').toBe('false');
  }, 5_000);

  it('减少动态：不放大、不淡入淡出——只亮一下，到点拿掉', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const { handle, flash } = setup();
    const ring = flash.querySelector<HTMLElement>('.flash-ring')!;
    const animate = vi.spyOn(ring, 'animate');
    click(handle.primaryButton());
    await wait(150);
    expect(flash.dataset.on).toBe('true');
    expect(animate).not.toHaveBeenCalled();
    await wait(1_250);
    expect(flash.dataset.on).toBe('false');
  }, 5_000);
});
