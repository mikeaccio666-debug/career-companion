// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { classifySiteSupport, type SiteSupportInput } from '../lib/siteSupport';

/**
 * 站点支持度三态（CAP-AF-014）。
 *
 * 卡片逐字：「非四家页面上彻底静默——不注入、不解释，连『我认不出这一页』
 * 都不说。」impact：「用户完全不知道该不该等，形成**「这插件时灵时不灵」**的
 * 印象；我们也拿不到覆盖缺口的真实分布。」
 *
 * 三态的判据是**用户此刻该做什么**：
 *   · SUPPORTED       —— 认出厂商且表单解析成功：等着，我们来填。
 *   · LIKELY_SUPPORTED —— 认出厂商但没解析出表单：**这一刻最该解释**。
 *     用户在一个我们"应该支持"的站点上干等，而我们什么都不会发生。
 *   · UNSUPPORTED      —— 没认出厂商：别等了。
 *
 * ## 为什么 UNSUPPORTED 不自动弹面板
 *
 * 宽注入之下 UNSUPPORTED 意味着"任意网页"。在每一个网页上弹东西，正是
 * Simplify 那条「lags my computer to a complete stop」差评的形状——用户不会
 * 归因于页面，会直接卸载。所以分类照做、状态照报，**自动可见的解释只给
 * LIKELY_SUPPORTED**：那是用户真的在等我们的唯一场景。
 */

function input(overrides: Partial<SiteSupportInput> = {}): SiteSupportInput {
  return { vendor: null, gateRefusal: null, formParsed: false, ...overrides };
}

describe('三态判定', () => {
  it('认出厂商 + 解析出表单 → 支持', () => {
    const verdict = classifySiteSupport(input({ vendor: 'greenhouse', formParsed: true }));
    expect(verdict.state).toBe('SUPPORTED');
    expect(verdict.shouldExplain, '正常工作时不该打扰用户').toBe(false);
  });

  it('认出厂商但没解析出表单 → 疑似支持，且必须解释', () => {
    // 最典型：Greenhouse 的岗位描述页（不是申请页），或申请页改版后锚点失效。
    const verdict = classifySiteSupport(input({ vendor: 'greenhouse', formParsed: false }));
    expect(verdict.state).toBe('LIKELY_SUPPORTED');
    expect(
      verdict.shouldExplain,
      '用户在一个我们应该支持的站点上干等，而我们一句话都不说',
    ).toBe(true);
  });

  it('没认出厂商 → 不支持，但不自动弹', () => {
    const verdict = classifySiteSupport(input({ gateRefusal: 'NO_VENDOR' }));
    expect(verdict.state).toBe('UNSUPPORTED');
    expect(
      verdict.shouldExplain,
      '在任意网页上自动弹东西——那正是竞品被差评卸载的形状',
    ).toBe(false);
  });
});

describe('被否决的页面一律闭嘴', () => {
  it.each(['EMPLOYER_CONSOLE', 'PUBLIC_SECTOR', 'CHALLENGE_PAGE', 'REMOTE_DENYLIST', 'ANONYMOUS_REPORT'] as const)(
    '%s：不解释、也不算疑似支持',
    (refusal) => {
      // 雇主后台、公共部门上出现任何我方界面本身就是错的。
      // ⚠️ CHALLENGE_PAGE 尤其严格：那是站点**正在判定这是不是 bot** 的时刻，
      // 任何浮层都可能把整轮判进去。
      const verdict = classifySiteSupport(input({ vendor: 'greenhouse', gateRefusal: refusal }));
      expect(verdict.state).toBe('UNSUPPORTED');
      expect(verdict.shouldExplain, `在 ${refusal} 页面上弹了界面`).toBe(false);
      expect(verdict.guidance).toBeNull();
    },
  );

  it('⚠️ CREDENTIAL_PAGE 是唯一开口的否决：认出厂商就该引导登录', () => {
    // 账号墙 ATS（Workday／Avature 系）第 1 步就是登录／建号。用户是从我们这儿
    // 点进来的，站在一张登录页上等——默不作声才是错的。
    // 「不能填」不等于「不能说」：密码只能他本人输，但"你先登录、登录完我接手"
    // 是我们该说的（竞品同样是引导到站点、用户在那边用插件）。
    const verdict = classifySiteSupport(input({ vendor: 'workday', gateRefusal: 'CREDENTIAL_PAGE' }));
    expect(verdict.shouldExplain).toBe(true);
    expect(verdict.guidance).toBe('SIGN_IN_FIRST');
  });

  it('认不出厂商的登录页仍然闭嘴——那可能是任意网站的登录页', () => {
    const verdict = classifySiteSupport(input({ vendor: null, gateRefusal: 'CREDENTIAL_PAGE' }));
    expect(verdict.shouldExplain, '在用户的网银登录页上弹了我们的东西').toBe(false);
  });

  it('顶层让位给 iframe 时闭嘴——真正干活的是那一帧', () => {
    const verdict = classifySiteSupport(input({ gateRefusal: 'YIELDED_TO_FRAME' }));
    expect(verdict.shouldExplain, '顶层和 iframe 会同时弹两个').toBe(false);
  });
});

describe('诊断只带稳定码', () => {
  it('疑似支持时带上厂商与原因码，不带任何页面内容', () => {
    const verdict = classifySiteSupport(input({ vendor: 'lever', formParsed: false }));
    expect(verdict.vendor).toBe('lever');
    const serialized = JSON.stringify(verdict);
    expect(serialized, '判定结果里混进了页面文本').not.toMatch(/<|http/);
  });

  it('反向探针：三态是闭集，没有第四种', () => {
    const states = new Set(
      [
        classifySiteSupport(input({ vendor: 'greenhouse', formParsed: true })).state,
        classifySiteSupport(input({ vendor: 'greenhouse' })).state,
        classifySiteSupport(input({ gateRefusal: 'NO_VENDOR' })).state,
      ],
    );
    expect([...states].sort()).toEqual(['LIKELY_SUPPORTED', 'SUPPORTED', 'UNSUPPORTED']);
  });
});

describe('可见面：疑似支持时的那一句话', () => {
  it('说明为什么没动，且只在认出厂商时出现', async () => {
    const { showSiteNotice } = await import('../lib/siteNotice');
    const handle = showSiteNotice('greenhouse');
    const text = handle.shadowRoot?.textContent ?? '';
    expect(text, '没说清是哪家').toContain('Greenhouse');
    expect(text, '没说清为什么没动').toContain('没找到申请表');
    handle.dismiss();
  });

  it('认不出厂商时一个字都不说——在任意网页上弹东西就是竞品差评的形状', async () => {
    const { showSiteNotice } = await import('../lib/siteNotice');
    const handle = showSiteNotice(null);
    expect(handle.shadowRoot).toBeNull();
    expect(document.documentElement.querySelector('#edaix-site-notice')).toBeNull();
  });

  it('Data-L1：只有厂商名与固定文案，不带 URL、不带页面文本', async () => {
    const { showSiteNotice } = await import('../lib/siteNotice');
    document.body.innerHTML = '<h1>Senior Engineer at AcmeCorp</h1>';
    const handle = showSiteNotice('lever');
    const text = handle.shadowRoot?.textContent ?? '';
    expect(text).not.toContain('AcmeCorp');
    expect(text).not.toMatch(/https?:/);
    handle.dismiss();
    document.body.innerHTML = '';
  });

  it('单实例 + 不碰宿主 DOM', async () => {
    const { showSiteNotice } = await import('../lib/siteNotice');
    document.body.innerHTML = '<form><input id="a" /></form>';
    const before = document.body.innerHTML;
    showSiteNotice('ashby');
    showSiteNotice('workable');
    expect(document.documentElement.querySelectorAll('#edaix-site-notice')).toHaveLength(1);
    expect(document.body.innerHTML, '往宿主页面里塞了节点（铁律 3）').toBe(before);
    document.documentElement.querySelector('#edaix-site-notice')?.remove();
    document.body.innerHTML = '';
  });
});

describe('引导登录那一句', () => {
  it('说清楚三件事：要账号、密码你自己输、登录完我接手', async () => {
    const { showSiteNotice } = await import('../lib/siteNotice');
    const handle = showSiteNotice('workday', 'SIGN_IN_FIRST');
    const text = handle.shadowRoot?.textContent ?? '';
    expect(text).toContain('Workday');
    expect(text, '没说要先有账号').toMatch(/账号|登录|注册/);
    expect(text, '没说清密码不经我们的手').toMatch(/本人输入|不看也不存/);
    expect(text, '没说登录完会接手').toMatch(/接着|接手/);
    handle.dismiss();
  });

  it('⚠️ 引导条里绝不能有任何输入框——那就是钓鱼的形状', async () => {
    const { showSiteNotice } = await import('../lib/siteNotice');
    const handle = showSiteNotice('workday', 'SIGN_IN_FIRST');
    const shadow = handle.shadowRoot!;
    expect(
      shadow.querySelectorAll('input, textarea, [contenteditable], form'),
      '在登录页上弹了一个带输入框的浮层——用户无从分辨那是不是我们在收密码',
    ).toHaveLength(0);
    handle.dismiss();
  });
});
