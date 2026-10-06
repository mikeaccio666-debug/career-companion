import { describe, expect, it, vi } from 'vitest';

/**
 * 内容脚本不往页面上广播「装着 ArgoLand」（2026-10-03 全网注入实测）。
 *
 * WXT 的 ContentScriptContext 一建起来就 `window.postMessage({ type: '<扩展 ID>:apply:wxt:content-script-started', … }, '*')`：
 * 页面上任何一个 message 监听都收得到（实测 63 次里 63 次），任何网站（LinkedIn 也在内）都能借它认出用户装了 ArgoLand、
 * 拿到扩展 ID。这条 postMessage 只为兼容老版本 WXT 的「新内容脚本来了，旧的停下」；现在的协议是 document 上的
 * CustomEvent，事件名里带扩展 ID，事先不知道的页面听不到。
 *
 * 关掉它没有代价：我们的 main() 从不用 ctx（失效回调一个都没挂）；而且是 manifest 注入、Chrome 不往已经开着的页面里
 * 重新注入，新旧两份内容脚本从不同在一个文档里——那条兼容广播无事可做。`noScriptStartedPostMessage: true` 只关
 * 这一条 postMessage，CustomEvent 照旧（WXT 0.20.27 `utils/content-script-context.mjs` 的 stopOldScripts）。
 *
 * 这一条钉定义；真产物里 WXT 认不认这个开关，`tests/artifact/store-manifest.test.ts` 读商店包的 apply.js 再钉一次。
 */

vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: <T>(config: T): T => config }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'test-extension-id' } } }));

describe('content-script-started 不广播给页面', () => {
  it('apply 内容脚本的定义关掉了那条 postMessage', async () => {
    const { default: definition } = await import('../entrypoints/apply.content');
    expect((definition as { noScriptStartedPostMessage?: unknown }).noScriptStartedPostMessage).toBe(true);
  });
});
