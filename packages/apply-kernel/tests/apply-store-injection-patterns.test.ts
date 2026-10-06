import { describe, expect, it } from 'vitest';

import { ADAPTERS } from '../src/bundledAdapters';
import { applyHostMatchPatterns, candidateHostMatchPatterns, storeInjectionMatchPatterns } from '../src/vendors';

/**
 * 上架包的注入窄表（P4-16）：内置适配器 ∪ 远程发布的厂商；按租户分子域的厂商用 `https://*.<注册域>/*`。
 * 仍然只有目录里点名的主机，没有全域通配。
 */
describe('storeInjectionMatchPatterns', () => {
  it('内置适配器为 null 但远程已放行的 Workday 进窄表；BambooHR 按注册域通配', () => {
    const patterns = storeInjectionMatchPatterns(ADAPTERS, ['workday', 'bamboohr']);
    expect(patterns).toContain('https://*.myworkdayjobs.com/*');
    expect(patterns).toContain('https://*.bamboohr.com/*');
    expect(patterns).toContain('https://job-boards.greenhouse.io/*');
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const pattern of patterns) {
      expect(pattern, '全域通配不得进窄表').not.toMatch(/^https:\/\/\*\/|<all_urls>|^\*:\/\//u);
    }
  });

  it('没有远程放行时与内置适配器那份逐项相同；远程清单里的未知厂商不会凭空造出主机', () => {
    expect(storeInjectionMatchPatterns(ADAPTERS, [])).toEqual(applyHostMatchPatterns(ADAPTERS));
    // avature 目录里没有主机：放行了也没有可注入的地方，窄表不变。
    expect(storeInjectionMatchPatterns(ADAPTERS, ['avature'])).toEqual(applyHostMatchPatterns(ADAPTERS));
  });

  it('注册域自身不匹配，只匹配它的子域', () => {
    expect(candidateHostMatchPatterns({ candidateHosts: [], candidateHostSuffixes: ['myworkdayjobs.com'] }))
      .toEqual(['https://*.myworkdayjobs.com/*']);
  });
});
