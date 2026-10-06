import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 登记这一页的，只能是**顶层帧**。
 *
 * 注册表是「这个标签页此刻停在哪一页」，按 tabId 存一条，后来的覆盖先来的。
 * 而内容脚本是 `allFrames: true` 注入的——白标 ATS 把申请表放在跨源 iframe 里，
 * 不进子帧就没有一帧持有表单，所以宽注入是对的。
 *
 * 两件对的事合起来是错的：页面上任何一个跨源 iframe 的内容脚本也会报到，
 * 用同一个 tabId **把顶层帧那条覆盖掉**。
 *
 * 2026-09-18 在真实 Greenhouse 申请页上实测到：注册表里只剩一条，
 * 内容是 `https://content.googleapis.com/static/proxy.html`（reCAPTCHA 那个 iframe），
 * 而用户看着的那一页根本不在表里。后果是所有认「这一页登记过没有」的入口一起失效
 * ——`registeredExactPage` 拦下资料面板的取数，面板于是一片空白，
 * 并且劝用户「刷新这一页」——刷新也没用，那个 iframe 每次都在。
 *
 * 这是源码形状闸，与 `dock-face-awaits-rules` 同一路数：background 的接线没有别的
 * 办法在单测里摆出「顶层帧与子帧先后报到」这个时序，而它恰恰是出问题的那一刻。
 */

const background = readFileSync(
  resolve(__dirname, '..', 'entrypoints', 'background.ts'),
  'utf8',
);

/** 报到那个 handler 的正文：从 parseBridgeHello 到下一个 handler 之前。 */
function helloHandler(): string {
  const start = background.indexOf('const hello = parseBridgeHello(message);');
  expect(start, '找不到报到 handler；这条闸要跟着改').toBeGreaterThan(-1);
  const end = background.indexOf('parseDockAddJobIntent(message)', start);
  expect(end, '找不到下一个 handler 的边界').toBeGreaterThan(start);
  return background.slice(start, end);
}

describe('只有顶层帧能登记这一页', () => {
  it('handler 里查过 frameId', () => {
    expect(helloHandler()).toMatch(/sender\.frameId\s*!==\s*0/u);
  });

  it('而且查在写注册表之前', () => {
    const body = helloHandler();
    expect(body.indexOf('sender.frameId')).toBeLessThan(body.indexOf('writeRegistry'));
  });

  it('这条闸不是空转的：handler 确实在写注册表', () => {
    expect(helloHandler()).toContain('registerApplicationTab');
  });
});
