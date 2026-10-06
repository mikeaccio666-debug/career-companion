import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  documentHidden,
  HIDDEN_DELAY_MAX_MS,
  hostDelay,
  nextHostTask,
  postHostTask,
  scheduleHostStep,
} from '../src/write/hostSchedule';
import {
  controllableMessageChannel,
  PENDING,
  restoreVisibility,
  setVisibility,
  suspendFrames,
  within,
} from './helpers/hiddenPage';

/**
 * 宿主任务这一个原语（write/hostSchedule.ts）自己的测试。
 *
 * 它要守住两句话：页面看得见时，一切照旧——一帧就是 requestAnimationFrame、一个宏任务就是
 * setTimeout(0)、等 20 毫秒就是 setTimeout(20)；页面看不见时，谁都不等帧、也不等被节流的计时器。
 */

afterEach(() => {
  restoreVisibility();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 一个永远不到的计时器：后台里被节流到「这次测试里等不到」的样子。记下每一次请求的延时。 */
function neverFiringTimers(): { delays: Array<number | undefined>; cleared: ReturnType<typeof vi.fn> } {
  const delays: Array<number | undefined> = [];
  const cleared = vi.fn();
  vi.stubGlobal('setTimeout', (_handler: TimerHandler, delay?: number) => {
    delays.push(delay);
    return delays.length;
  });
  vi.stubGlobal('clearTimeout', cleared);
  return { delays, cleared };
}

/** 数一数投了几条宿主任务（MessageChannel 照常投递，只是计数）。 */
function countHostTasks(): { count: () => number } {
  const Native = globalThis.MessageChannel;
  let count = 0;
  vi.stubGlobal('MessageChannel', class extends Native {
    constructor() {
      super();
      count += 1;
    }
  });
  return { count: () => count };
}

describe('宿主任务', () => {
  it('走 MessageChannel，不走计时器；撤掉了就不跑', async () => {
    neverFiringTimers();
    const ran = vi.fn();
    postHostTask(ran);
    const cancelled = vi.fn();
    postHostTask(cancelled)();
    await within(nextHostTask(), 300);
    await within(nextHostTask(), 300);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('没有 MessageChannel 的运行时退回 setTimeout(0)', () => {
    const timers = neverFiringTimers();
    vi.stubGlobal('MessageChannel', undefined);
    postHostTask(() => undefined)();
    expect(timers.delays).toEqual([0]);
    expect(timers.cleared).toHaveBeenCalledTimes(1);
  });

  it('看不看得见只认 visibilityState；没有文档就按看得见算', () => {
    expect(documentHidden()).toBe(false);
    setVisibility('hidden');
    expect(documentHidden()).toBe(true);
    expect(documentHidden(null)).toBe(false);
  });
});

describe('结算排程里的一步', () => {
  it('看得见：一帧就是一帧，一个宏任务就是 setTimeout(0)，不投宿主任务', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const timers = neverFiringTimers();
    const tasks = countHostTasks();
    const ran = vi.fn();

    const frame = scheduleHostStep('frame', ran);
    expect(frame.waitingOn()).toBe('frame');
    frames[0]!(0);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(frame.waitingOn()).toBe('done');

    const macro = scheduleHostStep('macrotask', ran);
    expect(macro.waitingOn()).toBe('macrotask');
    expect(timers.delays).toEqual([0]);
    expect(tasks.count()).toBe(0);
    macro.cancel();
  });

  it('看不见：两种都是一个宿主任务，不请求帧也不排计时器', async () => {
    setVisibility('hidden');
    const frames = suspendFrames();
    const timers = neverFiringTimers();
    const ran = vi.fn();

    const frame = scheduleHostStep('frame', ran);
    const macro = scheduleHostStep('macrotask', ran);
    expect(frame.waitingOn()).toBe('task');
    expect(macro.waitingOn()).toBe('task');
    await within(nextHostTask(), 300);
    await within(nextHostTask(), 300);
    expect(ran).toHaveBeenCalledTimes(2);
    expect(frames.request).not.toHaveBeenCalled();
    expect(timers.delays).toEqual([]);
  });

  it('等帧的途中页面变成看不见：撤掉那一帧，改等宿主任务', async () => {
    const frames = suspendFrames();
    const ran = vi.fn();
    const step = scheduleHostStep('frame', ran);
    expect(frames.request).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    expect(frames.cancel).toHaveBeenCalledWith(1);
    expect(step.waitingOn()).toBe('task');
    await within(nextHostTask(), 300);
    await within(nextHostTask(), 300);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('visibilitychange 没送到：调用方问一句 moveToTaskIfHidden 就补上；看得见时它什么都不做', async () => {
    const frames = suspendFrames();
    const ran = vi.fn();
    const step = scheduleHostStep('frame', ran);
    expect(step.moveToTaskIfHidden()).toBe(false);
    expect(step.waitingOn()).toBe('frame');

    setVisibility('hidden', { dispatch: false });
    expect(step.waitingOn(), '事件没送到，自己不会动').toBe('frame');
    expect(step.moveToTaskIfHidden()).toBe(true);
    expect(frames.cancel).toHaveBeenCalledWith(1);
    expect(step.moveToTaskIfHidden(), '已经在等宿主任务').toBe(false);
    await within(nextHostTask(), 300);
    await within(nextHostTask(), 300);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('撤掉的一步不再跑，也不再听可见性', async () => {
    suspendFrames();
    const tasks = countHostTasks();
    const ran = vi.fn();
    const step = scheduleHostStep('frame', ran);
    step.cancel();
    expect(step.waitingOn()).toBe('done');
    setVisibility('hidden');
    await within(nextHostTask(), 300);
    expect(ran).not.toHaveBeenCalled();
    expect(tasks.count(), '只有测试自己那一条').toBe(1);
  });
});

describe('轮询间隔 hostDelay', () => {
  it('看得见：就是一个 setTimeout(ms)，到点返回 true', async () => {
    vi.useFakeTimers();
    const tasks = countHostTasks();
    const waiting = hostDelay(20);
    await vi.advanceTimersByTimeAsync(19);
    expect(await within(waiting, 20)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe(true);
    expect(tasks.count()).toBe(0);
  });

  it('看不见：不排任何计时器，按墙钟一格一格地过宿主任务，时间到才返回', async () => {
    setVisibility('hidden');
    const timers = neverFiringTimers();
    const tasks = countHostTasks();
    const started = performance.now();

    await expect(within(hostDelay(20), 500)).resolves.toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(19);
    expect(timers.delays).toEqual([]);
    expect(tasks.count()).toBeGreaterThan(1);
  });

  it('看不见、0 毫秒：恰好一个宿主任务', async () => {
    setVisibility('hidden');
    neverFiringTimers();
    const tasks = countHostTasks();
    await expect(within(hostDelay(0), 300)).resolves.toBe(true);
    expect(tasks.count()).toBe(1);
  });

  it('叫停：立刻返回 false', async () => {
    setVisibility('hidden');
    const cancel = new AbortController();
    const waiting = hostDelay(900, cancel.signal);
    cancel.abort();
    await expect(within(waiting, 300)).resolves.toBe(false);
    await expect(hostDelay(10, cancel.signal)).resolves.toBe(false);
  });

  it('长于 HIDDEN_DELAY_MAX_MS 的等待，看不见时也只用计时器（节流只多出不到一秒，不值得连着占主线程）', () => {
    setVisibility('hidden');
    const timers = neverFiringTimers();
    const tasks = countHostTasks();
    const cancel = new AbortController();
    void hostDelay(HIDDEN_DELAY_MAX_MS + 1, cancel.signal);
    expect(timers.delays).toEqual([HIDDEN_DELAY_MAX_MS + 1]);
    expect(tasks.count()).toBe(0);
    cancel.abort();
  });

  it('等计时器的途中页面变成看不见：撤掉计时器，剩下的时间改走宿主任务', async () => {
    const timers = neverFiringTimers();
    const started = performance.now();
    const waiting = hostDelay(30);
    expect(timers.delays).toEqual([30]);

    setVisibility('hidden');
    expect(timers.cleared).toHaveBeenCalledTimes(1);
    await expect(within(waiting, 500)).resolves.toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(29);
  });

  it('一格一格地过的途中又看得见了：剩下的交回 setTimeout', async () => {
    setVisibility('hidden');
    const channel = controllableMessageChannel();
    const timers = neverFiringTimers();
    const cancel = new AbortController();
    const waiting = hostDelay(900, cancel.signal);
    expect(channel.queued()).toBe(1);

    setVisibility('visible');
    expect(channel.deliver()).toBe(true);
    expect(timers.delays).toHaveLength(1);
    expect(timers.delays[0]).toBeGreaterThan(800);
    expect(channel.queued(), '不再投宿主任务').toBe(0);
    expect(await within(waiting, 20)).toBe(PENDING);
    cancel.abort();
    await expect(waiting).resolves.toBe(false);
  });

  it('时钟不走也不会永远转下去：按格数有上限', async () => {
    setVisibility('hidden');
    vi.stubGlobal('performance', { now: () => 0 });
    const tasks = countHostTasks();
    await expect(within(hostDelay(1), 5_000)).resolves.toBe(true);
    expect(tasks.count()).toBe(1_000);
  });
});
