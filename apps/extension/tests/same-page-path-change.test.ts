// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { onSamePagePathChange } from '../lib/samePagePathChange';

/**
 * 站内换路径要重新报到（2026-09-24）。
 *
 * 单页应用用 history.pushState 换页：Chrome 不重新注入内容脚本，也没有 load／focus／pageshow，
 * 内容脚本就一直停在加载时那一页的结论上。测试台实测 Rippling：岗位页 /<租户>/jobs/<id> 点
 * 「Apply now」是站内换到 /apply，后台对岗位页的回答是不挂浮层，于是申请表出来了浮层也不出来，
 * 直到用户切走再切回来（focus 才重新报到）。直接打开 /apply 就一切正常——所以缺的只是「路径变了
 * 再问一次」。
 *
 * Navigation API 的 currententrychange 在内容脚本的隔离世界里也收得到页面主世界 pushState 引起的
 * 那一次（测试台实测）。jsdom 没有这个 API，这里用一个假的 EventTarget 扮演它。
 */

afterEach(() => {
  delete (window as unknown as { navigation?: unknown }).navigation;
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
});

describe('有 Navigation API：路径变了回调一次', () => {
  const withNavigation = () => {
    const navigation = new EventTarget();
    (window as unknown as { navigation: EventTarget }).navigation = navigation;
    return navigation;
  };

  it('pushState 换到 /apply → 回调；只改查询串或锚点 → 不回调', () => {
    const navigation = withNavigation();
    window.history.replaceState({}, '', '/moov/jobs/2b2ebdc4');
    const seen: string[] = [];
    const stop = onSamePagePathChange(window, () => { seen.push(window.location.pathname); });

    window.history.pushState({}, '', '/moov/jobs/2b2ebdc4?jobBoardSlug=moov');
    navigation.dispatchEvent(new Event('currententrychange'));
    window.history.replaceState({}, '', '/moov/jobs/2b2ebdc4#apply');
    navigation.dispatchEvent(new Event('currententrychange'));
    expect(seen, '查询串、锚点不是换页').toEqual([]);

    window.history.pushState({}, '', '/moov/jobs/2b2ebdc4/apply');
    navigation.dispatchEvent(new Event('currententrychange'));
    expect(seen).toEqual(['/moov/jobs/2b2ebdc4/apply']);

    // 同一次变化再来一个事件（popstate 与 currententrychange 都会到）：不重复回调。
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(seen).toHaveLength(1);

    stop();
    window.history.pushState({}, '', '/moov/jobs/other');
    navigation.dispatchEvent(new Event('currententrychange'));
    expect(seen, '停了就不再回调').toHaveLength(1);
  });

  it('后退也算（popstate）', () => {
    withNavigation();
    window.history.replaceState({}, '', '/a/apply');
    const seen: string[] = [];
    onSamePagePathChange(window, () => { seen.push(window.location.pathname); });
    window.history.replaceState({}, '', '/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(seen).toEqual(['/a']);
  });
});

describe('没有 Navigation API 的老浏览器：退回按间隔看一眼路径', () => {
  it('路径变了在下一次检查时回调，没变不回调', () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/jobs/1');
    const seen: string[] = [];
    const stop = onSamePagePathChange(window, () => { seen.push(window.location.pathname); }, 1000);
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([]);
    window.history.pushState({}, '', '/jobs/1/apply');
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['/jobs/1/apply']);
    stop();
    window.history.pushState({}, '', '/jobs/2');
    vi.advanceTimersByTime(5000);
    expect(seen).toHaveLength(1);
  });
});

describe('内容脚本接上了：路径变了就重新报到（源码形状闸）', () => {
  it('apply.content.ts 用 onSamePagePathChange 触发 hello，并清掉报到节流', () => {
    const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
    const wired = content.indexOf('onSamePagePathChange(window, () => {');
    expect(wired, '内容脚本里没有接上站内换路径的重新报到').toBeGreaterThan(0);
    const body = content.slice(wired, wired + 200);
    expect(body).toContain('lastHelloAt = 0;');
    expect(body).toContain('hello();');
  });
});
