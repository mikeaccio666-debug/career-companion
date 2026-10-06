// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForHostQuiet, watchTrustedEdits } from '../lib/hostSettle';

/**
 * 等宿主安静下来（附上简历之后，2026-09-24）与「用户亲手动过哪些栏」。
 *
 * 等待有三种结局：连续 quietMs 表单里没有变动、各栏的值也没变（QUIET）；到上限（CAPPED）；被叫停（ABORTED）。
 * 每一跳都按墙钟判——后台标签页里定时器被节流，也最迟晚一跳结束。
 */

describe('waitForHostQuiet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<form><input id="a" /><span id="status"></span></form>';
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });
  const form = () => document.querySelector('form')!;

  it('什么都没变：一个安静窗口（外加至多一跳）就结束', async () => {
    const pending = waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 4_000 });
    await vi.advanceTimersByTimeAsync(700);
    await expect(pending).resolves.toMatchObject({ outcome: 'QUIET' });
    expect((await pending).waitedMs).toBeGreaterThanOrEqual(600);
    expect((await pending).waitedMs).toBeLessThanOrEqual(700);
  });

  it('DOM 还在变：从最后一次变动重新算安静窗口', async () => {
    const pending = waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 4_000 });
    await vi.advanceTimersByTimeAsync(500);
    document.getElementById('status')!.textContent = 'Parsing';
    await vi.advanceTimersByTimeAsync(500);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, '变动之后不足一个安静窗口就结束了').toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ outcome: 'QUIET' });
    expect((await pending).waitedMs).toBeGreaterThanOrEqual(1_100);
  });

  it('只改了 value（没有 MutationRecord）：值的指纹变了也算还在变', async () => {
    const input = document.getElementById('a') as HTMLInputElement;
    const pending = waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 4_000, fingerprint: () => input.value });
    await vi.advanceTimersByTimeAsync(500);
    input.value = 'changed by host';
    await vi.advanceTimersByTimeAsync(700);
    await expect(pending).resolves.toMatchObject({ outcome: 'QUIET' });
    expect((await pending).waitedMs).toBeGreaterThanOrEqual(1_100);
  });

  it('一直在变：到上限就停', async () => {
    const status = document.getElementById('status')!;
    const busy = setInterval(() => { status.textContent = String(Date.now()); }, 100);
    const pending = waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_200);
    clearInterval(busy);
    await expect(pending).resolves.toMatchObject({ outcome: 'CAPPED' });
    expect((await pending).waitedMs).toBeGreaterThanOrEqual(2_000);
    expect((await pending).waitedMs).toBeLessThanOrEqual(2_100);
  });

  it('被叫停：立刻结束；开始前就停了的，一跳都不等', async () => {
    const controller = new AbortController();
    const pending = waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 4_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ outcome: 'ABORTED', waitedMs: 200 });

    const early = new AbortController();
    early.abort();
    await expect(waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 4_000, signal: early.signal }))
      .resolves.toMatchObject({ outcome: 'ABORTED', waitedMs: 0 });
  });

  it('定时器被节流成一秒一跳（后台标签页）：按墙钟判，最迟晚一跳结束', async () => {
    const pending = waitForHostQuiet({ targets: [form()], quietMs: 600, capMs: 4_000, tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ outcome: 'QUIET', waitedMs: 1_000 });
  });
});

describe('watchTrustedEdits', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  const trusted = (type: string): Event => {
    const event = new Event(type, { bubbles: true, composed: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    return event;
  };

  it('只记浏览器标了 isTrusted 的编辑；我们自己派发的事件不算', () => {
    document.body.innerHTML = '<form><input id="a" /><input id="b" /></form>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const watch = watchTrustedEdits(document);
    b.dispatchEvent(new Event('input', { bubbles: true }));
    a.dispatchEvent(trusted('input'));
    expect(watch.touched(a)).toBe(true);
    expect(watch.touched(b)).toBe(false);
    watch.stop();
  });

  it('单选按同名的一组算：用户点了同组的另一项，也算动过这一题', () => {
    document.body.innerHTML = `<form>
      <input id="r1" type="radio" name="q" /><input id="r2" type="radio" name="q" /><input id="other" type="radio" name="p" />
    </form>`;
    const watch = watchTrustedEdits(document);
    document.getElementById('r2')!.dispatchEvent(trusted('change'));
    expect(watch.touched(document.getElementById('r1')!)).toBe(true);
    expect(watch.touched(document.getElementById('other')!)).toBe(false);
    watch.stop();
  });

  it('停了之后不再记新的，已经记下的照旧答得出来', () => {
    document.body.innerHTML = '<form><input id="a" /><input id="b" /></form>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const watch = watchTrustedEdits(document);
    a.dispatchEvent(trusted('input'));
    watch.stop();
    b.dispatchEvent(trusted('input'));
    expect(watch.touched(a)).toBe(true);
    expect(watch.touched(b)).toBe(false);
  });
});
