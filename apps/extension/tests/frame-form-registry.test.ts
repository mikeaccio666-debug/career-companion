import { describe, expect, it } from 'vitest';
import {
  frameFormForSender,
  parseBridgeFrameForm,
  parseDockTopYield,
  parseFrameFormRegistry,
  recordFrameForm,
  removeFrameForm,
} from '../lib/frameFormRegistry';

/**
 * 子帧持表登记（P2-10）。与报到表分开的一张表：先来的帧算数，标签页关闭即清，
 * 发信人核对与报到表同一口径（origin + pathname，查询串与片段不算）。
 */

const ORIGIN = 'https://boards.greenhouse.io';
const PATH = '/embed/job_app';
const entry = (over: Partial<Parameters<typeof recordFrameForm>[1]> = {}) => ({
  tabId: 7, frameId: 3, canonicalOrigin: ORIGIN, pathname: PATH, at: 1_000, ...over,
});

describe('parseBridgeFrameForm', () => {
  it('只认 exact-key 的 bridge/frame-form，origin 必须是 https 且规范', () => {
    expect(parseBridgeFrameForm({ kind: 'bridge/frame-form', origin: ORIGIN, pathname: PATH }))
      .toEqual({ canonicalOrigin: ORIGIN, pathname: PATH });
    expect(parseBridgeFrameForm({ kind: 'bridge/hello', origin: ORIGIN, pathname: PATH })).toBeNull();
    expect(parseBridgeFrameForm({ kind: 'bridge/frame-form', origin: 'http://boards.greenhouse.io', pathname: PATH })).toBeNull();
    expect(parseBridgeFrameForm({ kind: 'bridge/frame-form', origin: ORIGIN, pathname: `${PATH}?for=acme` })).toBeNull();
    expect(parseBridgeFrameForm({ kind: 'bridge/frame-form', origin: ORIGIN, pathname: PATH, frameId: 3 })).toBeNull();
  });
});

describe('recordFrameForm · 一个标签页只记一帧，先来的算数', () => {
  it('第一帧收下；同一帧再报只刷新时间', () => {
    const first = recordFrameForm({}, entry());
    expect(first.accepted).toBe(true);
    const again = recordFrameForm(first.registry, entry({ at: 2_000 }));
    expect(again.accepted).toBe(true);
    expect(again.registry['7']).toMatchObject({ frameId: 3, at: 2_000 });
  });

  it('第二个子帧不收，表不变', () => {
    const first = recordFrameForm({}, entry());
    const second = recordFrameForm(first.registry, entry({ frameId: 5, at: 2_000 }));
    expect(second.accepted).toBe(false);
    expect(second.registry).toBe(first.registry);
  });

  it('顶层帧（frameId 0）与非法 id 不进这张表', () => {
    expect(recordFrameForm({}, entry({ frameId: 0 })).accepted).toBe(false);
    expect(recordFrameForm({}, entry({ frameId: -1 })).accepted).toBe(false);
    expect(recordFrameForm({}, entry({ tabId: 1.5 })).accepted).toBe(false);
  });

  it('标签页关闭即清', () => {
    const { registry } = recordFrameForm({}, entry());
    expect(removeFrameForm(registry, 7)).toEqual({});
    expect(removeFrameForm(registry, 8)).toBe(registry);
  });
});

describe('frameFormForSender · 发信人是不是登记过的那一帧', () => {
  const { registry } = recordFrameForm({}, entry());
  it('tabId、frameId、origin、pathname 全对上才算；查询串不算', () => {
    expect(frameFormForSender(registry, 7, 3, `${ORIGIN}${PATH}?for=acme&token=1`)).toMatchObject({ frameId: 3 });
  });
  it.each([
    ['别的标签页', 8, 3, `${ORIGIN}${PATH}`],
    ['别的帧', 7, 4, `${ORIGIN}${PATH}`],
    ['顶层帧', 7, 0, `${ORIGIN}${PATH}`],
    ['换了页', 7, 3, `${ORIGIN}/embed/job_board`],
    ['换了站', 7, 3, `https://evil.example${PATH}`],
    ['url 不成形', 7, 3, 'nope'],
  ])('%s → null', (_why, tabId, frameId, url) => {
    expect(frameFormForSender(registry, tabId, frameId, url)).toBeNull();
  });
});

describe('parseFrameFormRegistry · 存储读回按不可信输入对待', () => {
  it('只留形状完整、键与 tabId 一致、frameId 为正的记录', () => {
    const good = entry();
    expect(parseFrameFormRegistry({ '7': good })).toEqual({ '7': good });
    expect(parseFrameFormRegistry({ '8': good })).toEqual({});
    expect(parseFrameFormRegistry({ '7': { ...good, frameId: 0 } })).toEqual({});
    expect(parseFrameFormRegistry({ '7': { ...good, extra: 1 } })).toEqual({});
    expect(parseFrameFormRegistry(null)).toEqual({});
  });
});

describe('worker 叫顶层再看一眼（dock/top-yield，2026-10-04）', () => {
  it('只认不带值的那一条', () => {
    expect(parseDockTopYield({ kind: 'dock/top-yield' })).toBe(true);
    expect(parseDockTopYield({ kind: 'dock/top-yield', frameId: 3 })).toBe(false);
    expect(parseDockTopYield({ kind: 'dock/frame-yield' })).toBe(false);
    expect(parseDockTopYield(null)).toBe(false);
    expect(parseDockTopYield('dock/top-yield')).toBe(false);
  });
});
