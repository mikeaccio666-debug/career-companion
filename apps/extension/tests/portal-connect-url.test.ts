import { describe, expect, it } from 'vitest';
import { PORTAL_CONNECT_PATH, portalConnectUrl } from '../lib/portalConnectUrl';

const ID = 'boibiooejloflbbfiofnaaddckegpkhk';
const STATE = 'a'.repeat(64);

/**
 * 2026-09-20 改：连接门从 /career/settings 改指 /extension-auth/complete。
 *
 * 设置页的连接卡 09-16 被有意删除（635ef2f8），app-shell 里的自动绑定 effect 线上
 * 不触发且失败静默，未登录时 (career)/layout 跳 /login 还会把参数丢掉——所以那条路
 * 对新用户是死的。/extension-auth/complete 是门户现成、可用的握手完成页：未登录时它
 * 把三个参数原样带去 /login 再带回来，登录后调 createExtensionHandoff 并把 code 发给
 * 插件。它只多要一个 state——由 worker 在开门前预铸（authHandoff.beginPending）。
 */
describe('门户连接 URL', () => {
  it('打握手完成页，带门户 readExtensionAuthRequest 要的三个参数', () => {
    const url = new URL(portalConnectUrl('https://staging.career-companion.invalid', ID, STATE));
    expect(PORTAL_CONNECT_PATH).toBe('/extension-auth/complete');
    expect(url.pathname).toBe('/extension-auth/complete');
    expect(url.searchParams.get('source')).toBe('extension');
    expect(url.searchParams.get('extensionId')).toBe(ID);
    expect(url.searchParams.get('state')).toBe(STATE);
    expect([...url.searchParams.keys()].sort()).toEqual(['extensionId', 'source', 'state']);
  });

  // 门户校验 STATE_RE = /^[A-Za-z0-9._~-]{16,256}$/；插件铸的是 64 位十六进制。
  it('state 必须过门户的格式；不合格就拒绝拼 URL', () => {
    expect(() => portalConnectUrl('https://argoland.ai', ID, 'short')).toThrow();
    expect(() => portalConnectUrl('https://argoland.ai', ID, 'has space in it 1234')).toThrow();
  });

  it('origin 原样保留，不把门户换成别的主机', () => {
    for (const origin of ['https://staging.career-companion.invalid', 'https://argoland.ai']) {
      expect(new URL(portalConnectUrl(origin, ID, STATE)).origin).toBe(origin);
    }
  });
});
