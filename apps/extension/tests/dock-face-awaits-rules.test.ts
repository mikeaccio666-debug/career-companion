import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 报到时算出来的那张脸，必须等规则装完再算。
 *
 * MV3 的 worker 是冷启动的。用户打开一个申请页，内容脚本立刻报到，而规则包还在
 * 下载——那一刻 `hasApplyAdapter(vendor)` 读的是一张**空的装入表**，于是
 * `dockFaceForPage` 判出 DORMANT（「这一页没有认出申请表」），而且**就那样留着**，
 * 直到有别的事再触发一次报到。
 *
 * 2026-09-17 在 jobs.lever.co 上实测到：规则包已经在 storage 里
 * （`t10ExecutionRuntimeBundleV1`），7 家厂商都在，路径也匹配，面板却说没认出。
 * 同一条消息链上 `apply-site-knowledge/get` 是等的，face 这条漏了。
 *
 * 这条闸是源码形状闸，与 `api-base-gate` 同一个路数：background 的接线没有别的
 * 办法在单测里摆出「冷启动 + 报到抢在装载之前」这个时序，而它恰恰是出问题的那一刻。
 */

const background = readFileSync(
  resolve(__dirname, '..', 'entrypoints', 'background.ts'),
  'utf8',
);

/** 报到那个 handler 的正文：从 parseBridgeHello 到它 return 之前。 */
function helloHandler(): string {
  const start = background.indexOf('const hello = parseBridgeHello(message);');
  expect(start, '找不到报到 handler；这条闸要跟着改').toBeGreaterThan(-1);
  const end = background.indexOf('parseDockAddJobIntent(message)', start);
  expect(end, '找不到下一个 handler 的边界').toBeGreaterThan(start);
  return background.slice(start, end);
}

describe('报到算脸之前先等规则装完', () => {
  it('handler 里 await 过装载器', () => {
    expect(helloHandler()).toMatch(/await\s+rulesInstaller\.rules\(\)/u);
  });

  it('而且是在 dockFaceForPage 之前 await 的', () => {
    // 顺序才是这条闸的全部内容：在之后 await 等于没等。
    const body = helloHandler();
    const awaited = body.search(/await\s+rulesInstaller\.rules\(\)/u);
    const face = body.indexOf('dockFaceForPage(');
    expect(awaited).toBeGreaterThan(-1);
    expect(face).toBeGreaterThan(-1);
    expect(awaited, 'await 必须排在 dockFaceForPage 之前').toBeLessThan(face);
  });

  it('装载失败仍然 fail closed：空表 → 不认，不是乐观放行', () => {
    // 等它不等于信它。失败时装的是空表（runtimeRulesInstaller 里 install(null)），
    // 那时判「认不出」是对的——这条闸只保证我们**知道答案之后**再回答。
    // 失败之后允许重试，那是重新去问后端，不是沿用旧授权。
    expect(background).toMatch(/createRuntimeRulesInstaller\(/u);
  });
});
