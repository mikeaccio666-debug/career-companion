// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import { afterEach, describe, expect, it } from 'vitest';

import { detectApplyVendor } from '../src/vendors';
import { evaluateHostVeto } from '../src/gate/hostVeto';
import { resolveApplyGate } from '../src/gate/resolve';
import { testApplyPolicy } from './helpers/applyTestAuthority';

/**
 * Workday 的主机识别（CAP-AF-007 第一步；PENDING-B1 已由 Mike／Yiwen／Vivian
 * 于 2026-08-21 放行）。
 *
 * 今天 `VENDOR_CATALOG` 里**一条 Workday 都没有**，候选人侧认不出、雇主侧也没否决。
 * 卡片 impact 逐字：「**单平台投递量最大的一家零覆盖**；北美大厂／新卒实习岗位
 * 大量走 Workday，正是 wedge 人群（国际学生／技术新卒）最核心的申请场景。」
 *
 * ## 为什么 Workday 必须用后缀而不是精确主机名
 *
 * `VENDOR_CATALOG` 刻意是精确主机名——因为 `greenhouse.io` 写成后缀会让
 * `app.greenhouse.io`（**雇主后台**）也匹配：HR 打开候选人编辑页，我们的浮层照样
 * 弹出，Fill 写进去的是我方用户的邮箱、覆盖的是**别人的**候选人记录（架构评审 P4）。
 *
 * Workday 的形态不同：**一雇主一租户一子域**（`<tenant>.wdN.myworkdayjobs.com`），
 * 精确主机名永远列不完。而它的候选人侧与雇主侧在**不同的注册域**上：
 *   候选人：`*.myworkdayjobs.com`
 *   雇主／管理：`*.workday.com`、`*.myworkday.com`
 * 所以对 `myworkdayjobs.com` 用后缀是安全的——它下面没有雇主后台。这不是放宽
 * 原则，是这个域恰好满足原则要求的那个条件；测试逐条把它钉住。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

describe('候选人侧租户子域', () => {
  it.each([
    'acme.wd1.myworkdayjobs.com',
    'globex.wd3.myworkdayjobs.com',
    'initech.wd5.myworkdayjobs.com',
    'umbrella.wd103.myworkdayjobs.com',
    'acme.wd1.myworkdayjobs.com.',
    'ACME.WD1.MYWORKDAYJOBS.COM',
  ])('认出 %s 是 Workday', (host) => {
    expect(detectApplyVendor(host), '单平台投递量最大的一家仍然零覆盖').toBe('workday');
  });

  it('不带 wdN 的裸租户域同样认', () => {
    expect(detectApplyVendor('acme.myworkdayjobs.com')).toBe('workday');
  });
});

describe('雇主侧与仿冒必须挡住', () => {
  it.each([
    ['acme.workday.com', 'workday.com 是雇主／管理面'],
    ['impl.workday.com', '实施顾问面'],
    ['acme.myworkday.com', 'myworkday.com 是员工自助面，不是候选人申请面'],
  ])('%s 被否决（%s）', (host) => {
    const verdict = evaluateHostVeto({ hostname: host, policy: testApplyPolicy() });
    expect(verdict.vetoed, `${host} 没被挡住——HR 或员工页面上会弹出我们的浮层`).toBe(true);
    if (verdict.vetoed) expect(verdict.reason).toBe('EMPLOYER_CONSOLE');
  });

  it.each([
    'myworkdayjobs.com.evil.test',
    'evil-myworkdayjobs.com',
    'myworkdayjobs.com.attacker.example',
  ])('仿冒主机 %s 认不出', (host) => {
    expect(detectApplyVendor(host), '后缀匹配没按标签边界做——仿冒域被当成 Workday').toBeNull();
  });

  it('裸注册域本身不算申请页', () => {
    // `myworkdayjobs.com` 自己不承载任何租户的申请表。
    expect(detectApplyVendor('myworkdayjobs.com')).toBeNull();
  });
});

describe('已有四家的行为逐字不变', () => {
  it.each([
    ['job-boards.greenhouse.io', 'greenhouse'],
    ['jobs.lever.co', 'lever'],
    ['jobs.ashbyhq.com', 'ashby'],
    ['apply.workable.com', 'workable'],
  ] as const)('%s 仍然是 %s', (host, vendor) => {
    expect(detectApplyVendor(host)).toBe(vendor);
  });

  it.each(['app.greenhouse.io', 'hire.lever.co', 'app.ashbyhq.com', 'app.workable.com'])(
    '雇主后台 %s 仍然被否决',
    (host) => {
      expect(evaluateHostVeto({ hostname: host, policy: testApplyPolicy() }).vetoed).toBe(true);
    },
  );

  it('随便一个域名仍然认不出', () => {
    expect(detectApplyVendor('news.example.test')).toBeNull();
  });
});

describe('门控整链', () => {
  it('Workday 租户页挂载，来源记为主机表', () => {
    document.body.innerHTML = '<div data-automation-id="applyFlowPage"></div>';
    const verdict = resolveApplyGate({
      doc: document,
      hostname: 'acme.wd1.myworkdayjobs.com',
      policy: testApplyPolicy(),
      isTopFrame: true,
    });
    expect(verdict.attach).toBe(true);
    if (verdict.attach) {
      expect(verdict.vendor).toBe('workday');
      expect(verdict.source).toBe('EXACT_HOST');
    }
  });

  it('⚠️ Workday 的登录／建号页在当前 stable runtime 仍然整页否决', () => {
    // Pending password proposal 不能复用通用 scanner/writer；final approval 前密码零写入，
    // 验证码始终由用户完成。Workday 第 1 步整个页面继续 fail closed。
    document.body.innerHTML =
      '<form><input id="u" /><input type="password" id="p" /></form>';
    const verdict = resolveApplyGate({
      doc: document,
      hostname: 'acme.wd1.myworkdayjobs.com',
      policy: testApplyPolicy(),
      isTopFrame: true,
    });
    expect(verdict.attach, '在 Workday 的登录页上挂载了').toBe(false);
    if (!verdict.attach) expect(verdict.reason).toBe('CREDENTIAL_PAGE');
  });
});
