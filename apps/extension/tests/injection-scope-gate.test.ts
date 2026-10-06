import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveInjectionMatches } from '../lib/buildConfig';

/**
 * 注入范围闸门（重建旧仓库缺失的 apply-injection-scope 保护面，
 * 审计 §二.1 的第二道；PR #4 评审 高5 后加固）。
 *
 * 不变量：`AUTOFILL_WIDE_MATCHES`（全域宽表通配）只许隔离世界入口使用；
 * 任何 MAIN world 入口必须用 `applyHostMatchPatterns` 的窄主机表——
 * MAIN world 是 page-observable 的通道，跟着宽表扩围等于在用户的
 * 网银页面主 realm 里装我们的监听器（铁律 2/3）。
 *
 * 加固点：入口收集改**递归**（子目录、tsx/js 同查）；宽表引用必须
 * **绑定在 matches/excludeMatches 赋值**上（只"提到"不算）；危险
 * 通配闭集扩到双引号/反引号/<all_urls>/http 宽表，扫描 wxt.config 全文。
 */

const shellDir = resolve(__dirname, '..');
const wxtConfig = readFileSync(resolve(shellDir, 'wxt.config.ts'), 'utf8');

function collectEntrypoints(dir: string): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectEntrypoints(full).map((e) => ({ ...e, name: `${name}/${e.name}` })));
    } else if (/\.(ts|tsx|js)$/.test(name)) {
      out.push({ name, source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}
const entrypoints = collectEntrypoints(resolve(shellDir, 'entrypoints'));

// 危险通配闭集：单/双/反引号三种写法一起查（评审复核补全协议通配与 file 两种写法）。
const WIDE_PATTERNS = ['https://*/*', 'http://*/*', '*://*/*', '<all_urls>', 'file:///*', 'file://*'];
function containsWidePattern(source: string): string | null {
  for (const pattern of WIDE_PATTERNS) {
    for (const quote of ["'", '"', '`']) {
      if (source.includes(`${quote}${pattern}`)) return pattern;
    }
  }
  return null;
}

describe('注入范围闸门', () => {
  it('MAIN world 入口绝不使用宽表，必须用窄主机表', () => {
    for (const entry of entrypoints) {
      const isMainWorld = /world:\s*['"]MAIN['"]/.test(entry.source);
      if (!isMainWorld) continue;
      expect(
        /matches:\s*(\[\s*)?\.{0,3}applyHostMatchPatterns/.test(entry.source),
        `${entry.name} 是 MAIN world 入口，matches 必须绑定窄主机表`,
      ).toBe(true);
      expect(
        entry.source.includes('AUTOFILL_WIDE_MATCHES'),
        `${entry.name} 是 MAIN world 入口，绝不许引用宽表`,
      ).toBe(false);
    }
  });

  it('隔离世界宽注入：matches/excludeMatches 必须真的绑定两张表（提到不算）', () => {
    const wide = entrypoints.filter((entry) => entry.source.includes('AUTOFILL_WIDE_MATCHES'));
    expect(wide.length, '宽注入入口应存在（A2b 模式）').toBeGreaterThanOrEqual(1);
    for (const entry of wide) {
      expect(
        /matches:\s*\[\s*\.\.\.AUTOFILL_WIDE_MATCHES\s*\]/.test(entry.source),
        `${entry.name} 的宽表必须绑定在 matches 赋值上`,
      ).toBe(true);
      expect(
        /excludeMatches:\s*\[\s*\.\.\.AUTOFILL_EXCLUDE_MATCHES\s*\]/.test(entry.source),
        `${entry.name} 用了宽表却没把 exclude 清单绑定在 excludeMatches 上`,
      ).toBe(true);
      expect(
        /world:\s*['"]MAIN['"]/.test(entry.source),
        `${entry.name} 宽表只许隔离世界使用`,
      ).toBe(false);
    }
  });

  /**
   * Embedded ATS boards put the application form in a cross-origin iframe
   * (Greenhouse's `embed/job_app` inside the employer's own careers page).
   * Without `allFrames`, the isolated-world entrypoint only runs in the top
   * document, which `gate/frameArbitration` makes yield to that iframe — and
   * no frame is left to fill the form. Scope is still decided by
   * matches/excludeMatches plus the host veto; this only says which frames of
   * an already-matching URL the script runs in.
   */
  it('隔离世界宽注入：必须声明 allFrames（内嵌 ATS iframe 才有帧可跑）', () => {
    const wide = entrypoints.filter((entry) => entry.source.includes('AUTOFILL_WIDE_MATCHES'));
    expect(wide.length, '宽注入入口应存在（A2b 模式）').toBeGreaterThanOrEqual(1);
    for (const entry of wide) {
      expect(
        /allFrames:\s*true/.test(entry.source),
        `${entry.name} 没有声明 allFrames —— 顶层让位给 ATS iframe 后没有任何一帧能填表`,
      ).toBe(true);
    }
  });

  it('宽域通配永不出现在 wxt.config（host_permissions/externally_connectable 只点名 origin）', () => {
    // S2-B permits embedding the assistant document after a toolbar gesture. This is
    // resource accessibility, not host access or an automatic script registration.
    // Remove only this exact declaration; all other wide literals remain forbidden.
    const assistantResource = "web_accessible_resources: [{ resources: ['assistant.html'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true }]";
    expect(wxtConfig.split(assistantResource)).toHaveLength(2);
    expect(wxtConfig).toContain("...(ASSISTANT_READ_ENABLED ? {");
    const hit = containsWidePattern(wxtConfig.replace(assistantResource, ''));
    expect(hit, `wxt.config.ts 出现宽域通配 ${hit ?? ''}`).toBeNull();
    expect(wxtConfig).toContain('externally_connectable');
    expect(wxtConfig).toMatch(/portalOrigins\.map/);
    expect(wxtConfig).toMatch(/apiOrigins\.map/);
  });

  it('入口源码同样不许出现宽域通配字面量（防手写绕过两张表）', () => {
    for (const entry of entrypoints) {
      const hit = containsWidePattern(entry.source);
      expect(hit, `${entry.name} 出现宽域通配 ${hit ?? ''}`).toBeNull();
    }
  });
});

/**
 * 注入范围（2026-08-15 加商店包收窄，2026-09-24 负责人决定第一版上架就开全网，与开发构建一致）。
 *
 * 为什么放开：窄表上架后每加一个网站都会让 Chrome 停用已装用户的插件、等他重新接受权限；雇主自建域名里
 * 嵌的申请表进不去；新厂商本可以由后端规则下发即生效。约束不变：注入 ≠ 动手（先跑主机／页面否决），
 * 隔离世界只用 https 全网并带排除表，MAIN world 的桥仍只用窄主机表，host_permissions 仍只有后端。
 */
describe('注入范围：每个入口保留自己声明的 matches（商店包也一样）', () => {
  it('纯函数：原样返回入口声明的 matches', () => {
    expect(resolveInjectionMatches({ declared: ['https://*/*'] })).toEqual(['https://*/*']);
    expect(resolveInjectionMatches({ declared: ['https://jobs.lever.co/*'] })).toEqual(['https://jobs.lever.co/*']);
  });

  it('wxt.config 把它接在 manifest 生成上，且不再按商店包改写成窄表', () => {
    expect(wxtConfig).toContain('resolveInjectionMatches');
    expect(wxtConfig).toMatch(/build:manifestGenerated/);
    expect(wxtConfig).not.toMatch(/storeInjectionMatchPatterns/);
  });
});

/**
 * 上面三条都不碰真正的产物：前两条测的是纯函数、第三条是正则扫配置文本。
 *
 * Yiwen 审查（2026-08-16 [高]）指出这层缺口：把 hook 里的赋值目标改成别的字段、
 * 或让它压根不改写 `script.matches`，那三条仍会**全绿**。注释却写着
 * "钩子改的是最终 manifest，闸门测试断言的也是同一个函数，两边不会漂"——
 * 声称的保护大于测到的范围。
 *
 * 这里补上：**真 import 配置模块、真取出那个 hook、真跑一遍**，然后断言
 * 被改写后的 `manifest.content_scripts[*].matches`。改赋值目标、改条件、
 * 摘掉 hook，都会红。
 */
describe('build:manifestGenerated 真跑一遍（断言最终 manifest，不是纯函数）', () => {
  const ENV_KEYS = [
    'VIBE_DIST',
    'VIBE_API_BASE',
    'VIBE_WEB_BASE',
    'VIBE_CONTROLLED_MOCK_WRITES',
    'VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED',
  ] as const;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.resetModules();
  });

  /** 造一份"hook 之前"的 manifest：内容脚本带宽注入，与真实构建同形。 */
  function wideManifest() {
    return {
      content_scripts: [
        { matches: ['https://*/*'], js: ['content-scripts/content.js'] },
        { matches: ['https://*/*'], js: ['content-scripts/main-world.js'], world: 'MAIN' },
      ],
    };
  }

  async function runHook(storeBuild: boolean) {
    for (const key of ENV_KEYS) delete process.env[key];
    if (storeBuild) process.env.VIBE_DIST = 'store';
    vi.resetModules();
    const config = (await import('../wxt.config')).default as {
      hooks?: Record<string, (wxt: unknown, manifest: unknown) => void>;
    };
    const hook = config.hooks?.['build:manifestGenerated'];
    expect(hook, 'wxt.config 没有 build:manifestGenerated 钩子——收窄没接在产物生成上').toBeTypeOf(
      'function',
    );
    const manifest = wideManifest();
    hook!(null, manifest);
    return manifest;
  }

  it('refuses a store hook before a new product release is configured', async () => {
    await expect(runHook(true)).rejects.toThrow('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
  });

  it('开发构建：hook 之后不出现 http、*://、<all_urls> 这类通配（只有 https 全网）', async () => {
    const manifest = await runHook(false);
    for (const script of manifest.content_scripts) {
      for (const pattern of script.matches) {
        expect(/^http:\/\//.test(pattern) || pattern === '<all_urls>' || pattern.startsWith('*://') || pattern.startsWith('file:'), `出现不许的通配: ${pattern}`).toBe(false);
      }
    }
  });

  it('开发构建：宽注入原样保留', async () => {
    const manifest = await runHook(false);
    for (const script of manifest.content_scripts) {
      expect(script.matches).toEqual(['https://*/*']);
    }
  });
});
