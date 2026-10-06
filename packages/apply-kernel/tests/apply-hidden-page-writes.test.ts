import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '../src/contracts';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { fieldSignature } from '../src/fieldIdentity';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { verifyWrittenValue, WRITE_VERIFICATION_TIMEOUT_MS } from '../src/write/verify';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import {
  controllableMessageChannel,
  PENDING,
  restoreVisibility,
  setVisibility,
  suspendFrames,
  throttleTimers,
  within,
} from './helpers/hiddenPage';

/**
 * 后台标签页里的写入（2026-09-23 在真实 Chrome 里量到）。
 *
 * 用户按下「自动填写」之后切走了（或窗口被挡住、最小化）：动画帧整个停掉，每个计时器被压到
 * 约一秒一次。C6 回读的结算是「一个微任务 → 两帧 → 一个 setTimeout(0)」，再加一只 1 秒的看门狗，
 * 于是每一次写入——值其实已经好好地写进去了——都以 VERIFY_TIMEOUT 收场；浮层把我们自己写成的
 * 那几栏列成失败，又因为栏里有值，算成「你补上了 5 项」。同一个隐藏标签页里，竞品照常填好。
 *
 * 这里钉住的：看不见的页面里结算不再等帧、也不再等被节流的计时器；而原有的保证一样不少——
 * 被宿主改回去的仍是 reverted，留下别的值的仍是 mismatch，叫停仍是 aborted，真卡住的仍在有界的
 * 时间里以带类型的失败收场。页面看得见时，排程逐字不变。
 */

afterEach(() => {
  restoreVisibility();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

/** 像用户那样写：原型上的 setter，再派 input。 */
function typeInto(input: HTMLInputElement, value: string): void {
  nativeValue.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 一个受控输入框：值由它自己的状态决定，每次 input 之后在微任务里把状态重新渲染回 DOM。 */
function controlledInput(render: (typed: string) => string = (typed) => typed): HTMLInputElement {
  const input = document.createElement('input');
  document.body.append(input);
  input.addEventListener('input', () => {
    const state = render(input.value);
    queueMicrotask(() => { nativeValue.call(input, state); });
  });
  return input;
}

function textPlan(element: HTMLInputElement, value: string): ApplyPlan {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    fingerprint: 'hidden-page',
    fillEmptyOnly: false,
    entries: [{ kind: 'text', required: false, key: 'email', label: 'Email', value, element, order: 0, confidence: 1, signature: fieldSignature(element, root) }],
    skipped: [],
  };
}

describe('C6 回读：页面看不见的时候', () => {
  it('一次普通的受控文本写入判 ok——不等永远不来的帧，也不等被拖成一秒的计时器', async () => {
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const input = controlledInput();
    typeInto(input, 'candidate@example.test');

    const started = performance.now();
    const verdict = await verifyWrittenValue({
      expected: 'candidate@example.test',
      previous: '',
      readCurrent: () => input.value,
    });

    expect(verdict).toBe('ok');
    expect(performance.now() - started, '不该等任何一个被节流的计时器').toBeLessThan(WRITE_VERIFICATION_TIMEOUT_MS / 2);
  });

  it('整轮里：隐藏标签页里写成的文本栏算已填，不是 VERIFY_TIMEOUT', async () => {
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const input = controlledInput();
    const plan = textPlan(input, 'candidate@example.test');
    const journal = createUndoJournal();

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([{ key: 'email', label: 'Email', ok: true }]);
    expect(summary.filled).toBe(1);
    expect(input.value).toBe('candidate@example.test');
    expect(journal.canUndo()).toBe(true);
  });

  it('宿主把值改回去，仍判 reverted', async () => {
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const input = controlledInput(() => 'old@example.test');
    nativeValue.call(input, 'old@example.test');
    typeInto(input, 'new@example.test');

    await expect(within(verifyWrittenValue({
      expected: 'new@example.test',
      previous: 'old@example.test',
      readCurrent: () => input.value,
    }), 300)).resolves.toBe('reverted');
  });

  it('宿主留下的是第三个值，仍判 mismatch', async () => {
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const input = controlledInput(() => '+1 555 555 0123');
    typeInto(input, '555 555 0123');

    await expect(within(verifyWrittenValue({
      expected: '555 555 0123',
      previous: '',
      readCurrent: () => input.value,
    }), 300)).resolves.toBe('mismatch');
  });

  it('叫停仍是 aborted，而且不再读', async () => {
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const cancel = new AbortController();
    const readCurrent = vi.fn(() => 'new');
    const verification = verifyWrittenValue({ expected: 'new', previous: '', readCurrent, signal: cancel.signal });
    await Promise.resolve();
    cancel.abort();

    await expect(within(verification, 300)).resolves.toBe('aborted');
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it('等帧的途中页面切到后台：撤掉那一帧，改等宿主任务', async () => {
    const frames = suspendFrames();
    const input = controlledInput();
    typeInto(input, 'candidate@example.test');
    const verification = verifyWrittenValue({
      expected: 'candidate@example.test',
      previous: '',
      readCurrent: () => input.value,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(frames.request, '看得见的时候照旧等一帧').toHaveBeenCalledTimes(1);

    throttleTimers();
    setVisibility('hidden');

    await expect(within(verification, 300)).resolves.toBe('ok');
    expect(frames.cancel).toHaveBeenCalledWith(1);
    expect(frames.request).toHaveBeenCalledTimes(1);
  });

  it('visibilitychange 被页面拦下没送到：看门狗到点时自己看一眼，页面已不可见就改等宿主任务，而不是判超时', async () => {
    vi.useFakeTimers();
    suspendFrames();
    const readCurrent = vi.fn(() => 'new');
    const verification = verifyWrittenValue({ expected: 'new', previous: '', readCurrent });
    await Promise.resolve();
    await Promise.resolve();
    setVisibility('hidden', { dispatch: false });

    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    await expect(within(verification, 300)).resolves.toBe('ok');
    expect(readCurrent).toHaveBeenCalledTimes(1);
  });

  it('宿主任务根本送不到：看门狗照旧在一个窗口后以 VERIFY 超时收场，不读', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    suspendFrames();
    controllableMessageChannel();
    const readCurrent = vi.fn(() => 'new');
    const verification = verifyWrittenValue({ expected: 'new', previous: '', readCurrent });

    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    await expect(within(verification, 300)).resolves.toBe('timeout');
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it('被长任务拖住、但一直在往前走的结算，看门狗给它续时间；走一步就停住的，下一个窗口照旧超时', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    suspendFrames();
    const channel = controllableMessageChannel();

    // 往前走：每个窗口里送到一步。三步走完就判 ok。
    const moving = verifyWrittenValue({ expected: 'new', previous: '', readCurrent: () => 'new' });
    await Promise.resolve();
    for (let step = 0; step < 3; step += 1) {
      await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS - 1);
      expect(channel.deliver()).toBe(true);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(within(moving, 300)).resolves.toBe('ok');

    // 停住：送到一步之后再也不动。续过一次之后，下一个窗口判超时——有界。
    const readCurrent = vi.fn(() => 'new');
    const stuck = verifyWrittenValue({ expected: 'new', previous: '', readCurrent });
    await Promise.resolve();
    expect(channel.deliver()).toBe(true);
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    expect(await within(stuck, 50)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    await expect(within(stuck, 300)).resolves.toBe('timeout');
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it('页面看得见时排程逐字不变：两帧加一个 setTimeout(0)，不发任何宿主任务', async () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<{ callback: () => void; delay: number | undefined }> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('setTimeout', (callback: () => void, delay?: number) => {
      timers.push({ callback, delay });
      return timers.length;
    });
    vi.stubGlobal('clearTimeout', vi.fn());
    const channels = vi.fn();
    vi.stubGlobal('MessageChannel', class { constructor() { channels(); } });

    const readCurrent = vi.fn(() => 'new');
    const verification = verifyWrittenValue({ expected: 'new', previous: '', readCurrent });
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(frames).toHaveLength(2);
    frames[1]!(0);
    expect(timers.map((timer) => timer.delay)).toEqual([WRITE_VERIFICATION_TIMEOUT_MS, 0]);
    expect(readCurrent).not.toHaveBeenCalled();
    timers[1]!.callback();
    await expect(verification).resolves.toBe('ok');
    expect(channels, '看得见的页面不走宿主任务').not.toHaveBeenCalled();
  });
});

const RADIO_NAME = 'hidden-page-radio';
const RADIO_OPTIONS = ['Yes', 'No'] as const;

/** Ashby 的实测形状（见 apply-choice-native-activation）：没有 <form>，单选组成员同名。 */
function mountAshbyRadio(): void {
  document.body.innerHTML = `
    <div class="ashby-application-form-container">
      <div class="ashby-application-form-field-entry">
        <label class="ashby-application-form-question-title" for="first">First Name</label>
        <input id="first" name="first" type="text" />
      </div>
      <div data-field-path="c1f0a7d2-hidden">
        <fieldset class="ashby-application-form-input-radio-group">
          <label class="ashby-application-form-question-title" for="c1f0a7d2-hidden">Do you have a driver's license?</label>
          ${RADIO_OPTIONS.map((text, index) => `
          <div class="ashby-application-form-input-radio-group-option">
            <span><input type="radio" id="${RADIO_NAME}-${index}" name="${RADIO_NAME}" class="ashby-application-form-input-radio-group-option-radio"></span>
            <label for="${RADIO_NAME}-${index}" class="ashby-application-form-input-radio-group-option-label">${text}</label>
          </div>`).join('')}
        </fieldset>
      </div>
    </div>`;
}

/**
 * react-select 的最小仿制件（见 apply-listbox-combobox）：mousedown 打开菜单，选项 role=option，
 * 点中之后菜单关上、选中的字出现在 .select__single-value 里。
 */
function mountReactSelect(options: readonly string[]): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="candidate-location">Location</label>
      <div class="select__container">
        <div class="select__control">
          <div class="select__value-container">
            <input id="candidate-location" type="text" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="react-select-location-listbox" />
          </div>
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('candidate-location') as HTMLInputElement;
  const container = trigger.closest('.select__container')!;
  const valueContainer = trigger.closest('.select__value-container')!;
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    document.getElementById('react-select-location-listbox')?.remove();
    const listbox = document.createElement('div');
    listbox.id = 'react-select-location-listbox';
    listbox.setAttribute('role', 'listbox');
    for (const text of options) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        const chosen = document.createElement('div');
        chosen.className = 'select__single-value';
        chosen.textContent = text;
        valueContainer.prepend(chosen);
        listbox.remove();
        trigger.setAttribute('aria-expanded', 'false');
      });
      listbox.append(option);
    }
    container.append(listbox);
  });
}

describe('控件在看不见的页面里', () => {
  it('单选题照常填上，不是 HOST_REJECTED（从前结算等不到帧，超时被折成了「网站提示格式不对」）', async () => {
    mountAshbyRadio();
    setVisibility('hidden');
    suspendFrames();
    // 延时复检窗口仍走计时器、跟宿主同一只被节流的钟；这里把节流压到 200 毫秒，免得测试干等一秒。
    throttleTimers(200);
    const root = ashbyAdapter.resolveRoot(document)!;
    const fields = [...ashbyAdapter.scan(root)];
    const group = fields.find((field) => field.kind === 'choice')!;
    const plan = buildAnswerPlan({ vendor: 'ashby', root, fields }, [{ questionId: 'license', element: group.element, value: 'Yes' }]);

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });

    expect(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason])).toEqual([['question:license', 'ok']]);
    expect([...document.querySelectorAll<HTMLInputElement>('input[type=radio]')].map((radio) => radio.checked)).toEqual([true, false]);
  });

  it('看得见的页面上帧真的不来：单选题以 VERIFY_TIMEOUT 收场，不再被折成 HOST_REJECTED（「网站提示格式不对」）', async () => {
    mountAshbyRadio();
    vi.useFakeTimers();
    suspendFrames();
    const root = ashbyAdapter.resolveRoot(document)!;
    const fields = [...ashbyAdapter.scan(root)];
    const group = fields.find((field) => field.kind === 'choice')!;
    const plan = buildAnswerPlan({ vendor: 'ashby', root, fields }, [{ questionId: 'license', element: group.element, value: 'Yes' }]);

    const run = runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);

    const summary = await run;
    expect(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason])).toEqual([['question:license', 'VERIFY_TIMEOUT']]);
  });

  it('下拉的轮询不再被拖成一秒一格：隐藏标签页里一个下拉在几百毫秒内选好', async () => {
    mountReactSelect(['Seattle, WA', 'Portland, OR']);
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const plan = buildApplyPlan({ vendor: 'greenhouse', root, fields }, { location: 'Seattle, WA' }, { fillEmptyOnly: true });

    const run = runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-combobox']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 10,
      // 整轮收尾那一次延时复检仍是宿主时钟上的一个窗口；这里只量轮询本身。
      lateRecheckDelay: async () => undefined,
    });

    const summary = await within(run, 600);
    expect(summary, '轮询不该每一格都等一个被节流的计时器').not.toBe(PENDING);
    if (summary === PENDING) return;
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: true });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Seattle, WA');
  });
});
