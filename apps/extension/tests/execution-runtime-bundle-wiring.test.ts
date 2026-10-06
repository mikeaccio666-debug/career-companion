import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
const content = readFileSync(new URL('../entrypoints/apply.content.ts', import.meta.url), 'utf8');

describe('execution runtime bundle stacked/default-off convergence wiring', () => {
  it('background owns the one-key store and refresh client', () => {
    expect(background).toContain('createExecutionRuntimeBundleStore');
    expect(background).toContain('createExecutionRuntimeBundleClient');
    expect(background).toContain('browser.storage.local.get(key)');
    expect(background).toContain('browser.storage.local.set({ [key]: value })');
    expect(background).toContain('executionRuntimeBundleClient.refresh()');
  });

  it('is default-off: VM0 Auth/API cannot implicitly configure VM2 refresh', () => {
    // 开关关着 → null；开着 → 覆盖优先，没有覆盖落到生产 origin。
    // `?? PRODUCTION_API_BASE` 补的是商店包上的一条死路（商店包拿不到覆盖，
    // 于是终点恒为 null、规则永远取不到、浮层在任何申请页上都不出现）。
    // 开关仍是唯一的开关：非商店包要让它为真，wxt.config 已要求同时给出合法
    // VIBE_API_BASE，fallback 在那条路上轮不到。
    expect(background).toMatch(
      /const executionRuntimeApiBase = __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__[\s\S]*?\?\s*\(__VIBE_API_BASE__ \?\? PRODUCTION_API_BASE\)[\s\S]*?: null/,
    );
    expect(background).toMatch(
      /createExecutionRuntimeBundleClient\(\{[\s\S]*?apiBase:\s*executionRuntimeApiBase/,
    );
    expect(background).not.toMatch(
      /createExecutionRuntimeBundleClient\(\{[\s\S]*?apiBase:\s*apiBase/,
    );
    expect(background).toMatch(
      /if \(__VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__\)[\s\S]*?executionRuntimeBundleClient\.refresh\(\)/,
    );
  });

  it('wires exact runtime authority into scan/fill while retaining default-off config', () => {
    expect(background).toContain('createBackgroundExecutionRuntimeAuthority');
    expect(background).toMatch(/runtimeAuthority:\s*\{\s*mode:\s*'REQUIRED'/);
    expect(background).toContain('executionRuntimeAuthority.authorize');
    expect(background).toContain('executionRuntimeAuthority.revalidate');
    expect(content).toContain('resolveStoredExecutionRuntimeAuthority');
    expect(content).toContain('scanCurrentPageWithRuntimeAuthority');
  });

  it('mutation fence: production content never falls back to bundled policy or static adapters', () => {
    expect(content).not.toContain('createBundledApplyPolicy');
    expect(content).not.toContain('ADAPTERS');
    expect(content).not.toContain('resolveApplyGate');
    expect(content).toMatch(/if \(!authorization\) return null/);
    expect(content).toMatch(/runtime === null[\s\S]*POLICY_DISABLED/);
  });

  it('pre-authority startup is inert: only registration/listener setup precedes bridge requests', () => {
    const mainStart = content.indexOf('main() {');
    const listenerStart = content.indexOf('browser.runtime.onConnect.addListener');
    const startup = content.slice(mainStart, listenerStart);
    const startupEffects = content.slice(
      content.indexOf('// The locally verified bundle', mainStart),
      listenerStart,
    );
    expect(startup).not.toMatch(/document\.(?:querySelector|querySelectorAll|createElement)/);
    expect(startupEffects).not.toContain('scanCurrentPageWithRuntimeAuthority(');
    expect(startupEffects).not.toContain('fillFromGrant(');
    expect(startupEffects).not.toContain('showAuditPanel(');
  });
});
