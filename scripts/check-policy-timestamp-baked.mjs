#!/usr/bin/env node
/**
 * 产物级门禁：构建时刻必须真的被烤进包里。
 *
 * ## 为什么单测挡不住这一层
 *
 * `apps/extension/tests/policy-expiry-failclosed.test.ts` 已经能抓到
 * 「consumer 没接上」（Vivian 2026-08-18 审查后补的那一组）。但它抓不到
 * **另一个形态**：把 `__VIBE_APPLY_POLICY_BUILT_AT__` 误写成
 * `globalThis.__VIBE_APPLY_POLICY_BUILT_AT__`。
 *
 * 单测里 `vi.stubGlobal` 真的把值挂在 `globalThis` 上，所以带前缀也读得到，
 * 测试照样全绿（实测）。可是 esbuild/vite 的 `define` 做的是**文本替换**，
 * 它只认裸标识符——带了前缀，构建期不会被替换，真产物里恒为 `undefined`，
 * 于是回落写死兜底，**包出生即在 30 天后过期，且无声**。
 *
 * 这正是本项目要防的那个 P0 的原始形态。差别只在换了一种写法复发。
 *
 * ## 判据
 *
 * dev 与 store 两个包打完之后，各自的内容脚本里都必须存在一个 ISO 时间戳，
 * 且它必须是**新鲜的**（距今 2 天内）。两个 flavor 不得互相掩盖缺失；只查
 * 「有没有 ISO 串」也不够——写死一个 2026-01-01 仍会失败。
 *
 * 只认退出码（铁律 7）：0 = 烤进去了；1 = 没有。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_DIRS = ['apps/extension/.output', 'apps/extension/.output-store'];
const FRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** 未来值一律拒——时钟偏差给 10 分钟余量，多出来的只可能是伪造或写死。 */
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * 只认**带标记的载体**，不认任意 ISO 串。
 *
 * Vivian 二次 Blocking（2026-08-18）实测：初版扫描所有产物 JS 里的任意 ISO、
 * 取最新一个、只拒绝「太旧」。她的变异是——① 把 consumer 改成
 * `globalThis.` 前缀让 define 失效；② 在不相关的 policy version 字串里塞一个
 * `2099-01-01T00:00:00Z`。重新构建后真正的注入其实**缺失**，
 * 门禁却退出码 0 并汇报「构建时刻已烤进产物：2099-01-01」。
 *
 * 结论：任何其他功能打包进一个近期/未来 ISO 值，都会掩盖本门禁要防的 P0。
 * 所以判据必须带一个不可能被偶然产生的前缀，三处同源：
 * `wxt.config.ts` 注入、`apply-kernel/src/policy.ts` 解析、这里。
 */
const MARKER = 'vibe-policy-built-at:';
const MARKED = /vibe-policy-built-at:(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const root = resolve(process.cwd());
const now = Date.now();

function verifyOutputDir(outputDir) {
  const built = walk(resolve(root, outputDir));
  if (built.length === 0) {
    // 两个 flavor 都是发布链的一部分；任何一个缺失都不能由另一个的产物代替。
    fail(
      `找不到 ${outputDir} 的构建产物。` +
        '本门禁必须排在 dev 与 store 两次 build 之后——缺少任一 flavor 都必须失败。',
    );
  }

  let freshest = null;
  let carrier = null;

  for (const file of built) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(MARKED)) {
      const at = Date.parse(match[1]);
      if (!Number.isFinite(at)) continue;
      if (freshest === null || at > freshest) {
        freshest = at;
        carrier = file;
      }
    }
  }

  if (freshest === null) {
    fail(
      `${outputDir} 里找不到带 \`${MARKER}\` 标记的时间戳——` +
        '`__VIBE_APPLY_POLICY_BUILT_AT__` 没被烤进去。\n' +
        '  最常见原因：policy.ts 里写成了 `globalThis.__VIBE_APPLY_POLICY_BUILT_AT__`。\n' +
        '  vite/esbuild 的 define 是文本替换，只认裸标识符；带前缀不会被替换，\n' +
        '  运行时恒为 undefined → 回落写死兜底 → 包出生即在 30 天后过期，且无声。',
    );
  }

  // 未来值：本次构建的时刻不可能晚于现在。出现说明是写死的或伪造的。
  if (freshest > now + FUTURE_TOLERANCE_MS) {
    fail(
      `${outputDir} 里的构建时刻是 ${new Date(freshest).toISOString()}，**晚于现在**。\n` +
        '  本次构建的时刻不可能在未来——这个值是写死的或伪造的，不是 define 注入的。\n' +
        `  出处：${carrier}`,
    );
  }

  const ageMs = now - freshest;
  if (ageMs > FRESH_WINDOW_MS) {
    fail(
      `${outputDir} 里最新的时间戳是 ${new Date(freshest).toISOString()}，距今 ${Math.round(ageMs / 86_400_000)} 天。\n` +
        '  注入的应当是**本次构建**的时刻。过旧说明 define 没生效，读到的是别处写死的常量。\n' +
        `  出处：${carrier}`,
    );
  }

  console.log(
    `✓ ${outputDir} 的带标记构建时刻已烤进产物：${new Date(freshest).toISOString()}` +
      `（${carrier?.replace(`${root}/`, '')}）`,
  );
}

for (const outputDir of OUT_DIRS) verifyOutputDir(outputDir);
