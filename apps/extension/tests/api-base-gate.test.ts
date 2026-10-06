import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveApiBaseOverride, resolveTrustTelemetryDeliveryEnabled, resolveWebBaseOverride } from '../lib/buildConfig';

/**
 * API/门户 origin 覆盖的闸门（行为断言）。
 *
 * PR #4 评审 高4 后重做：商店闸与 origin 规则**直接执行函数断言行为**
 * （字符串计数式断言可被"把那两句挪到无关位置"绕过）；环境变量读取的
 * 扫描面扩到全部运行时源码，不只 wxt.config.ts。
 *
 * 2026-08-15 债务清偿：kernel 旧 support/api/variables.ts 已删——生产
 * origin 的单一真相源收敛到本外壳（wxt.config 字面量），下方最后一条
 * 用例锁 background 兜底与之一致。
 */

const shellDir = resolve(__dirname, '..');
const wxtConfig = readFileSync(resolve(shellDir, 'wxt.config.ts'), 'utf8');

function literalOf(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
  expect(match, `${name} 字面量找不到`).not.toBeNull();
  return match![1]!;
}

/** 递归收集运行时源码（lib + entrypoints 的全部 ts/tsx/js）。 */
function collectSources(dir: string): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (/\.(ts|tsx|js)$/.test(name)) {
      out.push({ path: full, source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('API origin 覆盖闸门（外壳半，行为断言）', () => {
  it('T15 自动遥测在商店包恒为关闭，开发包也必须显式 true', () => {
    expect(resolveTrustTelemetryDeliveryEnabled({ storeBuild: true, raw: 'true' })).toBe(false);
    expect(resolveTrustTelemetryDeliveryEnabled({ storeBuild: false, raw: undefined })).toBe(false);
    expect(resolveTrustTelemetryDeliveryEnabled({ storeBuild: false, raw: 'false' })).toBe(false);
    expect(resolveTrustTelemetryDeliveryEnabled({ storeBuild: false, raw: 'true' })).toBe(true);
  });
  it('商店包永远拿不到覆盖：两个 resolver 在 storeBuild 时无条件 null', () => {
    // 第三个是**生产 origin 本身**：商店包连"覆盖成生产"都不接受，覆盖这条路
    // 在商店包里整个不存在，而不是"覆盖成对的值就放行"。
    for (const raw of ['https://evil.example', 'http://localhost:3000', 'https://api.argoland.ai']) {
      expect(resolveApiBaseOverride({ storeBuild: true, raw })).toBeNull();
      expect(resolveWebBaseOverride({ storeBuild: true, raw })).toBeNull();
    }
  });

  it('API 覆盖只收 https 与 localhost 明文例外；非法 origin 一律 null', () => {
    expect(resolveApiBaseOverride({ storeBuild: false, raw: 'https://staging.edaix.io/' })).toBe('https://staging.edaix.io');
    expect(resolveApiBaseOverride({ storeBuild: false, raw: 'http://localhost:3000' })).toBe('http://localhost:3000');
    expect(resolveApiBaseOverride({ storeBuild: false, raw: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080');
    for (const raw of [
      'http://staging.edaix.io', 'ftp://x', 'javascript:alert(1)', '', undefined, 'http://localhost.evil.com',
      // 收窄行为显式锁死（审计 2026-08-15）：无 scheme / 纯空白 / 多重尾斜杠
      'api.example.test', ' ', 'https://api-staging.example.test///',
    ]) {
      expect(resolveApiBaseOverride({ storeBuild: false, raw })).toBeNull();
    }
  });

  it('canonical origin 严格制（评审复核）：凭证/路径/查询/片段一律拒收', () => {
    // 这些值会进 host_permissions / externally_connectable 信任边界，
    // 前缀判断放过它们就是真实攻击面。
    for (const raw of [
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com?token=x',
      'https://example.com#fragment',
      'https://user@example.com',
      'http://localhost:3000/path',
    ]) {
      expect(resolveApiBaseOverride({ storeBuild: false, raw }), raw).toBeNull();
      expect(resolveWebBaseOverride({ storeBuild: false, raw }), raw).toBeNull();
    }
  });

  it('门户覆盖比 API 严格：localhost 明文也不收（origin 进 externally_connectable）', () => {
    expect(resolveWebBaseOverride({ storeBuild: false, raw: 'https://staging.edaix.io' })).toBe('https://staging.edaix.io');
    expect(resolveWebBaseOverride({ storeBuild: false, raw: 'https://staging.edaix.io/' })).toBe('https://staging.edaix.io');
    for (const raw of ['http://localhost:3000', 'http://127.0.0.1', 'http://staging.edaix.io']) {
      expect(resolveWebBaseOverride({ storeBuild: false, raw })).toBeNull();
    }
  });

  it('本机测试包（VIBE_DIST=local）是门户明文的唯一例外，且只放行回环', () => {
    // 门户 origin 进 externally_connectable，所以普通构建拒收 http；本机测试包连的
    // 是这台机器上的 `pnpm dev:staging` 门户（http://localhost:3100），只有它拿到
    // 回环例外。商店包在这之前就已经拿到 null；非回环的 http 照旧拒收。
    expect(resolveWebBaseOverride({ storeBuild: false, raw: 'http://localhost:3100', loopbackHttp: true })).toBe('http://localhost:3100');
    expect(resolveWebBaseOverride({ storeBuild: false, raw: 'http://127.0.0.1:3100', loopbackHttp: true })).toBe('http://127.0.0.1:3100');
    expect(resolveWebBaseOverride({ storeBuild: false, raw: 'https://staging.edaix.io', loopbackHttp: true })).toBe('https://staging.edaix.io');
    for (const raw of ['http://staging.edaix.io', 'http://localhost.evil.com', 'http://localhost:3100/path', 'http://user:pass@localhost:3100']) {
      expect(resolveWebBaseOverride({ storeBuild: false, raw, loopbackHttp: true }), raw).toBeNull();
    }
    expect(resolveWebBaseOverride({ storeBuild: true, raw: 'http://localhost:3100', loopbackHttp: true })).toBeNull();
  });

  it('wxt.config 用的是这两个 resolver + __VIBE_ define（不是旁路实现）', () => {
    expect(wxtConfig).toContain("from './lib/buildConfig'");
    expect(wxtConfig).toMatch(
      /resolveApiBaseOverride\(\{\s*storeBuild: STORE_BUILD \|\| FIELD_LAB_BUILD/u,
    );
    expect(wxtConfig).toMatch(
      /resolveWebBaseOverride\(\{\s*storeBuild: STORE_BUILD \|\| FIELD_LAB_BUILD/u,
    );
    expect(wxtConfig).toContain('__VIBE_API_BASE__');
    expect(wxtConfig).toContain('__VIBE_WEB_BASE__');
  });

  it('注入权唯一在 define：全部运行时源码不读环境变量（含 VITE_ 旁路）', () => {
    // Vite 自动注入所有 VITE_ 前缀变量，会绕过商店闸门（旧仓库实测）。
    // 扫描面 = lib + entrypoints 全部源文件，不只 wxt.config。
    const sources = [
      ...collectSources(resolve(shellDir, 'lib')),
      ...collectSources(resolve(shellDir, 'entrypoints')),
    ];
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      expect(
        /process\.env\.|import\.meta\.env\./.test(file.source),
        `${file.path} 读取了环境变量——运行时源码只许消费 __VIBE_ define`,
      ).toBe(false);
    }
  });

  it('shares an inert new-product fallback between manifest and worker', () => {
    const deployment = readFileSync(resolve(shellDir, 'lib', 'deploymentConfig.ts'), 'utf8');
    expect(literalOf(deployment, 'PRODUCTION_API_BASE')).toBe('https://api.career-companion.invalid');
    expect(literalOf(deployment, 'PRODUCTION_WEB_APP_BASE')).toBe('https://career-companion.invalid');
    const background = readFileSync(resolve(shellDir, 'entrypoints', 'background.ts'), 'utf8');
    expect(wxtConfig).toContain("from './lib/deploymentConfig'");
    expect(background).toContain("from '../lib/deploymentConfig'");
    expect(background).toMatch(/const apiBase = __VIBE_API_BASE__ \?\? PRODUCTION_API_BASE;/);
  });
});
