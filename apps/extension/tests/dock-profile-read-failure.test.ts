// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';
import type { DockLocale } from '../lib/dock/copy';

/**
 * 「我的资料」读不到的时候说出原因代号（2026-09-27）。
 *
 * 负责人在商店包上点「我的资料」只看到「暂时读不到你的资料，稍后再试。」——同一句话盖住了七八种原因
 * （这一页没登记、后台没答、服务器答不上来、档案形状对不上……），只能靠复现才查得出。现在这句话下面带一行
 * 原因代号（只有稳定的码，不含任何值），与填写失败时的「技术信息」同一个意思。登录过期照旧只说重新登录。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { document.body.innerHTML = ''; });

async function openWith(code: string, locale: DockLocale = 'zh') {
  const directory = {
    profileV2: async () => ({ ok: false as const, code }),
    saveProfileV2: async () => ({ ok: false as const, code: 'UNAVAILABLE' as const }),
  };
  const handle = mountAutofillDock(
    { kind: 'UNAVAILABLE', reason: 'NO_MISSION' },
    { onAutofill: () => {}, onOpenEntry: () => {}, directory: directory as never, locale },
    document,
  );
  click(handle.entryButtons()[0]);
  await settle();
  await settle();
  return handle.profileRoot()!.querySelector('.pf-message');
}

describe('我的资料读不到：说出原因代号', () => {
  it('这一页没登记：还是那句话，下面一行「原因代号：PAGE_NOT_REGISTERED」', async () => {
    const message = await openWith('PAGE_NOT_REGISTERED');
    expect(message?.textContent).toContain('暂时读不到你的资料，稍后再试。');
    expect(message?.querySelector('.pf-code')?.textContent).toBe('找我们帮忙时附上这一串：PAGE_NOT_REGISTERED');
  });

  it('档案形状对不上、服务器答不上来：各自的码', async () => {
    expect((await openWith('RESPONSE_MALFORMED'))?.querySelector('.pf-code')?.textContent).toBe('找我们帮忙时附上这一串：RESPONSE_MALFORMED');
    document.body.innerHTML = '';
    expect((await openWith('UNAVAILABLE'))?.querySelector('.pf-code')?.textContent).toBe('找我们帮忙时附上这一串：UNAVAILABLE');
  });

  it('英文界面：Code: …', async () => {
    const message = await openWith('NO_REPLY', 'en');
    expect(message?.querySelector('.pf-code')?.textContent).toBe('If you contact us, include: NO_REPLY');
  });

  it('登录过期：只说重新登录，不挂代号', async () => {
    const message = await openWith('LOGIN_REQUIRED');
    expect(message?.textContent).toContain('登录已过期');
    expect(message?.querySelector('.pf-code')).toBeNull();
  });

  it('读得太慢（TIMEOUT）、资料正在别处保存（BUSY）：各说各的，不说「暂时读不到」（2026-10-04）', async () => {
    const slow = await openWith('TIMEOUT');
    expect(slow?.textContent).toContain('ArgoLand 这次回得太慢，没读到你的资料。稍后再试。');
    expect(slow?.querySelector('.pf-code')?.textContent).toBe('找我们帮忙时附上这一串：TIMEOUT');
    document.body.innerHTML = '';
    const busy = await openWith('BUSY');
    expect(busy?.textContent).toContain('你的资料正在别处保存，等几秒再打开这一页。');
    document.body.innerHTML = '';
    expect((await openWith('TIMEOUT', 'en'))?.textContent).toContain('ArgoLand took too long to send your profile. Please try again in a moment.');
  });

  it('认不出的码不上屏（只认稳定码的形状）', async () => {
    const message = await openWith('something <b>odd</b>');
    expect(message?.textContent).toContain('暂时读不到你的资料');
    expect(message?.querySelector('.pf-code')).toBeNull();
  });
});
