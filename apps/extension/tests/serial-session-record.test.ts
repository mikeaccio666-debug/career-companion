import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createSerialSessionRecord, type SessionAreaLike } from '../lib/serialSessionRecord';

/**
 * storage.session 里的一张表，读—改—写排队（2026-09-27）。
 *
 * 报到表从前是「读出来、改一条、整张写回去」，两次写入一交错，后写的那次就把先写的那条冲掉。#115 起内容脚本
 * 全网注入、每个 https 页面都报到，几个标签页同时报到成了常事；被冲掉的那一页再问资料，后台答「这一页没登记」，
 * 资料编辑器画成「暂时读不到你的资料，稍后再试」（负责人 2026-09-27 在商店包上遇到）。
 */
function slowArea(): SessionAreaLike & { readonly data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  // get 与 set 各让出一轮：不排队的读—改—写在这里一定交错。
  const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  return {
    data,
    async get(key) { await tick(); return { [key]: structuredClone(data[key]) }; },
    async set(items) { await tick(); Object.assign(data, structuredClone(items)); },
  };
}
const parse = (value: unknown): Readonly<Record<string, number>> =>
  value !== null && typeof value === 'object' ? { ...(value as Record<string, number>) } : {};

describe('storage.session 里的一张表：读—改—写排队', () => {
  it('二十个标签页同时报到，一条都不丢', async () => {
    const area = slowArea();
    const record = createSerialSessionRecord(() => area, 'registry', parse);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      record.update((current) => ({ ...current, [String(index)]: index }))));
    expect(results.every((ok) => ok)).toBe(true);
    expect(Object.keys(await record.read())).toHaveLength(20);
    expect(Object.keys(parse(area.data.registry))).toHaveLength(20);
  });

  it('刚写就读：读等前面的写完，读得到自己', async () => {
    const area = slowArea();
    const record = createSerialSessionRecord(() => area, 'registry', parse);
    void record.update((current) => ({ ...current, mine: 1 }));
    expect(await record.read()).toEqual({ mine: 1 });
  });

  it('存储坏了：写报失败、读当空表，之后的写照常排上', async () => {
    let broken = true;
    const data: Record<string, unknown> = {};
    const area: SessionAreaLike = {
      async get(key) {
        if (broken) throw new Error('STORAGE_DOWN');
        return { [key]: data[key] };
      },
      async set(items) {
        if (broken) throw new Error('STORAGE_DOWN');
        Object.assign(data, items);
      },
    };
    const record = createSerialSessionRecord(() => area, 'registry', parse);
    expect(await record.update((current) => ({ ...current, lost: 1 }))).toBe(false);
    expect(await record.read()).toEqual({});
    broken = false;
    expect(await record.update((current) => ({ ...current, kept: 2 }))).toBe(true);
    expect(await record.read()).toEqual({ kept: 2 });
  });
});

describe('后台的两张表都走这条队', () => {
  const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

  it('报到表与子帧持表表不再各自读—改—写', () => {
    expect(background).not.toMatch(/storage\.session\.set\(\{\s*\[REGISTRY_KEY\]/u);
    expect(background).not.toMatch(/storage\.session\.set\(\{\s*\[FRAME_FORM_KEY\]/u);
    expect(background).toMatch(/createSerialSessionRecord\([^;]*REGISTRY_KEY/u);
    expect(background).toMatch(/createSerialSessionRecord\([^;]*FRAME_FORM_KEY/u);
  });
});
