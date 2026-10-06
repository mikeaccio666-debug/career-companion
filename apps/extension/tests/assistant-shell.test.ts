import { describe, expect, it } from 'vitest';
import { boatRect, panelDimensions } from '../assistant/shell/geometry';
import { createAssistantStore } from '../assistant/state/store';

describe('assistant shell geometry', () => {
  it('keeps the composer and panel inside a short or narrow viewport', () => {
    expect(panelDimensions('chat', { width: 390, height: 582 })).toEqual({
      width: 366, height: 558, margin: 12, wide: false,
    });
    const short = panelDimensions('home', { width: 1280, height: 572 });
    expect(short.height + short.margin * 2).toBe(572);
    expect(short.width).toBe(416);
    const tiny = panelDimensions('chat', { width: 200, height: 100 });
    expect(tiny.width).toBeGreaterThan(0);
    expect(tiny.height + tiny.margin * 2).toBeLessThanOrEqual(100);
  });

  it('changes to the Fable horizontal layout only when it fits', () => {
    expect(panelDimensions('chat', { width: 895, height: 900 }).wide).toBe(false);
    expect(panelDimensions('chat', { width: 896, height: 900 })).toEqual({
      width: 848, height: 636, margin: 24, wide: true,
    });
    expect(panelDimensions('deck', { width: 1440, height: 930 }).width).toBe(416);
  });

  it('keeps one boat coordinate system from hero to compact avatar', () => {
    const panel = panelDimensions('welcome', { width: 1440, height: 930 });
    const hero = boatRect('welcome', panel);
    expect(hero.x + hero.width / 2).toBe(panel.width / 2);
    expect(hero.width).toBeLessThanOrEqual(300);
    expect(boatRect('home', panel)).toEqual({ x: 20, y: 20, width: 48, height: 48 });
  });
});

describe('assistant state lifetime', () => {
  it('does not apply an old async result to a reset session', () => {
    const store = createAssistantStore({ count: 0 });
    const previous = store.scope();
    store.reset({ count: 5 });
    expect(previous.signal.aborted).toBe(true);
    expect(store.commit(previous, value => ({ count: value.count + 1 }))).toBe(false);
    expect(store.getSnapshot()).toEqual({ count: 5 });
  });

  it('publishes stable snapshots and stops work after disposal', () => {
    const store = createAssistantStore({ count: 0 });
    let calls = 0;
    const unsubscribe = store.subscribe(() => { calls += 1; });
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    const scope = store.scope();
    expect(store.commit(scope, value => ({ count: value.count + 1 }))).toBe(true);
    expect(calls).toBe(1);
    unsubscribe();
    store.dispose();
    expect(scope.signal.aborted).toBe(true);
    expect(store.commit(scope, () => ({ count: 9 }))).toBe(false);
    expect(store.getSnapshot().count).toBe(1);
  });
});
