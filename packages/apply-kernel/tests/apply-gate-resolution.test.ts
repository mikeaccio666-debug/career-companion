// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import { afterEach, describe, expect, it } from 'vitest';

import { resolveApplyGate, resolveAuthorizedApplyGate } from '../src/gate/resolve';
import { testApplyPolicy } from './helpers/applyTestAuthority';

/**
 * 注入门控的合成入口（CAP-AF-006）。
 *
 * 今天生产路径上的第一道判断是 `detectApplyVendor(location.hostname)`——一张
 * **8 个精确主机名**的表。公司把 Greenhouse / Ashby / Workable 嵌进自家 careers
 * 域名是极常见的形态，这类页面我们**全部认不出，浮层根本不出现**；用户从公司
 * 官网点进去的那一类流量，我们完全看不见。
 *
 * 而认出它们的四件东西 —— `vendorFingerprint` / `hostVeto` / `pageVeto` /
 * `frameArbitration` —— **早就写完了，生产代码零 import**，`package.json` 的
 * exports 里连 `./gate` 子路径都没有。这是本仓第五次同一形状（前四次：蜜罐守卫、
 * 推荐人守卫、JOB_DEPENDENT、createApplySession）。
 *
 * ## 这个文件锁的纪律
 *
 * 扩围之后最坏的失败**不是认不出，是认错**（FINDING-AF-002 逐字：「接线之后的
 * 失败形态是『认错厂商、套错规则』，比认不出更坏」）——用错的 attrMap 会把值
 * 写进别人的字段。所以：
 *
 *  · 精确主机名的行为**逐字不变**，扩围只在它返回 null 之后才发生；
 *  · 指纹只认**厂商自己的产物**，不认"看起来像申请表"（租房申请、病历 intake、
 *    研究生院申请在结构上与求职申请无法区分）；
 *  · 指纹只给 hint，**不完成归属**——调用方必须真的解析成功才算数；
 *  · 雇主后台、公共部门、登录页、挑战页的否决，优先级高于任何厂商命中。
 */

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function gateOn(
  html: string,
  href: string,
  options: { isTopFrame?: boolean } = {},
) {
  document.body.innerHTML = html;
  const url = new URL(href);
  return resolveApplyGate({
    doc: document,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    policy: testApplyPolicy(),
    isTopFrame: options.isTopFrame ?? true,
  });
}

const GH_FORM = '<form id="application-form"><input id="first_name" /></form>';

describe('精确主机名的行为逐字不变', () => {
  it('候选人侧精确主机照常认出，并标明来源是主机表', () => {
    const verdict = gateOn(GH_FORM, 'https://job-boards.greenhouse.io/acme/jobs/1');
    expect(verdict.attach).toBe(true);
    if (!verdict.attach) return;
    expect(verdict.vendor).toBe('greenhouse');
    expect(verdict.source, '精确主机命中却记成指纹——扩围的锅会算到主机表头上').toBe(
      'EXACT_HOST',
    );
  });

  it('精确主机与指纹给出不同厂商时，精确主机赢', () => {
    // 真实形态：Lever 页面上嵌了别家的第三方组件、或页面残留了别家的 class。
    // 次序反过来就是 FINDING-AF-002 警告的那一幕——套 ashby 的 attrMap 去解析
    // Lever 表单，值会被写进错误的字段，而 UI 照样显示"已填"。
    const verdict = gateOn(
      `<div data-ashby-app>${GH_FORM}</div>`,
      'https://jobs.lever.co/acme/1',
    );
    expect(verdict.attach).toBe(true);
    if (!verdict.attach) return;
    expect(
      verdict.vendor,
      '指纹压过了精确主机名——拿别家的规则去解析这张表，值会写进错误的字段',
    ).toBe('lever');
    expect(verdict.source).toBe('EXACT_HOST');
  });

  it('四家的精确主机全部照常认出', () => {
    const cases = [
      ['https://jobs.lever.co/acme/1', 'lever'],
      ['https://jobs.ashbyhq.com/acme/1', 'ashby'],
      ['https://apply.workable.com/acme/j/1', 'workable'],
    ] as const;
    for (const [href, vendor] of cases) {
      const verdict = gateOn(GH_FORM, href);
      expect(verdict.attach, `${vendor} 的精确主机不认了`).toBe(true);
      if (verdict.attach) expect(verdict.vendor).toBe(vendor);
    }
  });
});

describe('白标页：这条能力存在的全部理由', () => {
  it('公司自建域名 + Greenhouse 官方 embed 产物 → 认出 greenhouse', () => {
    const verdict = gateOn(
      `<div id="grnhse_app">${GH_FORM}</div>`,
      'https://careers.acme-corp.test/jobs/senior-engineer',
    );
    expect(
      verdict.attach,
      '公司自建域名上的 Greenhouse embed 认不出——这正是今天看不见的那类流量',
    ).toBe(true);
    if (!verdict.attach) return;
    expect(verdict.vendor).toBe('greenhouse');
    expect(verdict.source).toBe('FINGERPRINT');
  });

  it('自建域名上的 Ashby 与 Workable 同样认出', () => {
    const ashby = gateOn(
      `<div data-ashby-app>${GH_FORM}</div>`,
      'https://join.acme-corp.test/apply',
    );
    expect(ashby.attach && ashby.vendor).toBe('ashby');

    const workable = gateOn(
      '<form data-ui="application-form"><input id="a" /></form>',
      'https://work.acme-corp.test/apply',
    );
    expect(workable.attach && workable.vendor).toBe('workable');
  });
});

describe('认错比认不出更坏', () => {
  it('通用申请表形状不许命中——租房申请与求职申请在结构上分不开', () => {
    const verdict = gateOn(
      `<form>
         <label for="n">Full name</label><input id="n" />
         <label for="e">Email</label><input id="e" type="email" />
         <label for="p">Phone</label><input id="p" type="tel" />
         <input type="file" name="document" />
         <button type="submit">Submit application</button>
       </form>`,
      'https://apartments.example.test/rental-application',
    );
    expect(
      verdict.attach,
      '拿"看起来像申请表"当判据——租房申请、病历 intake、研究生院申请全都会中',
    ).toBe(false);
  });

  it('认不出就是认不出，绝不猜', () => {
    const verdict = gateOn('<p>hello</p>', 'https://news.example.test/article');
    expect(verdict.attach).toBe(false);
    if (verdict.attach) return;
    expect(verdict.reason).toBe('NO_VENDOR');
  });
});

describe('否决优先于任何厂商命中', () => {
  it('雇主后台主机被否决——扩围之后这是最危险的一条', () => {
    // 这类页面的表单形状与候选人申请表一模一样，但填的是**别人**的资料：
    // HR 正在录入某个候选人，被我们填上扩展使用者本人的信息。
    const verdict = gateOn(`<div id="grnhse_app">${GH_FORM}</div>`, 'https://app.greenhouse.io/people/1');
    expect(verdict.attach, '雇主后台被认成申请页——会把我方用户资料写进别人的候选人记录').toBe(
      false,
    );
    if (verdict.attach) return;
    expect(verdict.reason).toBe('EMPLOYER_CONSOLE');
  });

  it('公共部门后缀被否决', () => {
    const verdict = gateOn(`<div id="grnhse_app">${GH_FORM}</div>`, 'https://careers.example.gov/apply');
    expect(verdict.attach).toBe(false);
    if (!verdict.attach) expect(verdict.reason).toBe('PUBLIC_SECTOR');
  });

  it('登录页被否决——哪怕指纹命中', () => {
    const verdict = gateOn(
      `<div id="grnhse_app"><form><input id="u" /><input type="password" id="p" /></form></div>`,
      'https://careers.acme-corp.test/login',
    );
    expect(verdict.attach, '在登录页上挂了浮层').toBe(false);
    if (!verdict.attach) {
      expect(verdict.reason).toBe('CREDENTIAL_PAGE');
      expect(verdict.vendor).toBe('greenhouse');
    }
  });

  it('厂商判定前的主机否决不伪造厂商归属', () => {
    const verdict = gateOn(
      `<div id="grnhse_app">${GH_FORM}</div>`,
      'https://app.greenhouse.io/people/1',
    );
    expect(verdict.attach).toBe(false);
    if (!verdict.attach) expect(verdict.vendor).toBeNull();
  });
});

describe('帧仲裁', () => {
  it('顶层帧让位给持有申请表的候选人侧 iframe', () => {
    // 公司页嵌 job-boards.greenhouse.io 的 iframe：真正的表单在那一帧里，
    // 顶层不让位就会两帧都挂，或者顶层挂了却什么都扫不到。
    const verdict = gateOn(
      '<div id="grnhse_app"><iframe id="grnhse_iframe" src="https://job-boards.greenhouse.io/acme/jobs/1"></iframe></div>',
      'https://careers.acme-corp.test/jobs/1',
      { isTopFrame: true },
    );
    expect(verdict.attach, '顶层没让位——表单在 iframe 里，顶层挂了也扫不到').toBe(false);
    if (!verdict.attach) {
      expect(verdict.reason).toBe('YIELDED_TO_FRAME');
      expect(verdict.vendor).toBeNull();
    }
  });

  it('iframe 自己永远不让位', () => {
    const verdict = gateOn(
      '<div id="grnhse_app"><iframe src="https://job-boards.greenhouse.io/acme/jobs/1"></iframe></div>',
      'https://careers.acme-corp.test/jobs/1',
      { isTopFrame: false },
    );
    expect(verdict.attach, 'iframe 把自己让掉了——真正持有表单的那一帧谁都不挂').toBe(true);
  });
});

/**
 * 共域厂商 —— 雇主后台与候选人面**在同一个主机上**。
 *
 * 2026-08-23 实地取证（50-证据库 §F.8-d）逼出来的一类。到这一天为止，
 * 本仓的雇主后台防线（`EMPLOYER_CONSOLE_HOSTS`）是**主机级**的，而它对这两家
 * 根本表达不出来：
 *
 *  · **Dover**：`app.dover.com/apply/<slug>/<uuid>` 是候选人申请表（实测，
 *    `name` 全语义化：firstName / email / linkedinUrl / phoneNumber）；
 *    而 `app.dover.com/login` 是**带密码框的登录页**（实测，同一主机）。
 *  · **BambooHR**：`<租户>.bamboohr.com/careers/<id>` 是候选人 job board
 *    （实测，点开「Apply for This Job」原地展开 42 个控件）；
 *    而同一个 `<租户>.bamboohr.com` 的根路径是 HR／员工控制台。
 *
 * 把主机写进 `EMPLOYER_CONSOLE_HOSTS` 会连申请页一起否决；不写就是对这两家
 * **完全没有**雇主后台防线。两边都不可接受，所以否决必须能看路径。
 *
 * ## 为什么是「候选人路径白名单」而不是「雇主路径黑名单」
 *
 * 雇主后台的路径集是**无界的**（`/settings/**`、`/candidates/**`、
 * `/employees/**`、明天新加的任何一条）。列黑名单等于承诺穷举一个会持续增长的
 * 集合 —— 漏一条的后果是浮层出现在 HR 的候选人编辑页上。
 * 候选人面反过来是**小且已实测**的。所以这里 deny by default：
 * 该主机上白名单之外的一切，一律判 `EMPLOYER_CONSOLE`。
 */
describe('共域厂商：同一主机上，路径是唯一的分界线', () => {
  const DOVER_APPLY = '/apply/kubbly/885f0f71-a784-4957-a1f2-e3b6980d6ed0';

  it('Dover 的申请页不被否决', () => {
    const verdict = gateOn(GH_FORM, `https://app.dover.com${DOVER_APPLY}`);
    // 这里只断言「没被主机否决」——厂商归属是另一回事（那时还没接 dover 适配器，
    // 所以会停在 NO_VENDOR）。要锁的是**否决层放行了它**。
    if (!verdict.attach) expect(verdict.reason).not.toBe('EMPLOYER_CONSOLE');
  });

  it('backend-mapped production lane keeps vendor authority remote and still enforces pathname', () => {
    const base = {
      doc: document,
      hostname: 'app.dover.com',
      policy: testApplyPolicy(),
      isTopFrame: true,
      vendor: 'dover' as const,
    };
    const allowed = resolveAuthorizedApplyGate({ ...base, pathname: DOVER_APPLY });
    expect(allowed).toEqual({ attach: true, vendor: 'dover', source: 'REMOTE_MAPPING' });

    for (const pathname of ['/login', '/apply/kubbly/not-a-uuid']) {
      const blocked = resolveAuthorizedApplyGate({ ...base, pathname });
      expect(blocked.attach, pathname).toBe(false);
      if (!blocked.attach) expect(blocked.reason).toBe('EMPLOYER_CONSOLE');
    }
    const unknown = resolveAuthorizedApplyGate(base);
    expect(unknown.attach).toBe(false);
    if (!unknown.attach) expect(unknown.reason).toBe('EMPLOYER_CONSOLE');
  });

  it('同一主机的登录页被否决 —— 那上面有密码框', () => {
    const verdict = gateOn(GH_FORM, 'https://app.dover.com/login');
    expect(verdict.attach).toBe(false);
    if (!verdict.attach) expect(verdict.reason).toBe('EMPLOYER_CONSOLE');
  });

  it('同一主机上白名单之外的一切都被否决（deny by default）', () => {
    for (const path of [
      '/',
      '/settings/company',
      '/candidates/9f2a',
      '/jobs/edit/1',
      // 明天新加的任何一条后台路由都落在这里 —— 这正是白名单方向的意义。
      '/some-route-nobody-has-seen-yet',
    ]) {
      const verdict = gateOn(GH_FORM, `https://app.dover.com${path}`);
      expect(verdict.attach, path).toBe(false);
      if (!verdict.attach) expect(verdict.reason, path).toBe('EMPLOYER_CONSOLE');
    }
  });

  it('前缀花招骗不过白名单', () => {
    for (const path of [
      '/apply-console/kubbly/885f0f71-a784-4957-a1f2-e3b6980d6ed0', // 不是 /apply/
      '/admin/apply/kubbly/885f0f71-a784-4957-a1f2-e3b6980d6ed0', // /apply/ 不在开头
      '/apply/kubbly', // 缺 job uuid
      '/apply/kubbly/not-a-uuid',
      '/apply/kubbly/885f0f71-a784-4957-a1f2-e3b6980d6ed0/edit', // uuid 之后还有段
    ]) {
      const verdict = gateOn(GH_FORM, `https://app.dover.com${path}`);
      expect(verdict.attach, path).toBe(false);
      if (!verdict.attach) expect(verdict.reason, path).toBe('EMPLOYER_CONSOLE');
    }
  });

  it('BambooHR：逐租户子域上 /careers 放行、其余否决', () => {
    const ok = gateOn(GH_FORM, 'https://touchstonetherapycenter.bamboohr.com/careers/33');
    if (!ok.attach) expect(ok.reason).not.toBe('EMPLOYER_CONSOLE');

    for (const url of [
      'https://app.bamboohr.com/login/', // 厂商总登录入口
      'https://touchstonetherapycenter.bamboohr.com/', // 同一租户的 HR 控制台根
      'https://acme.bamboohr.com/employees/directory',
      'https://acme.bamboohr.com/saml/consume.php',
      'https://acme.bamboohr.com/authorize.php',
      'https://acme.bamboohr.com/careers',
      'https://acme.bamboohr.com/careers/admin',
      'https://acme.bamboohr.com/careers/33/admin',
    ]) {
      const verdict = gateOn(GH_FORM, url);
      expect(verdict.attach, url).toBe(false);
      if (!verdict.attach) expect(verdict.reason, url).toBe('EMPLOYER_CONSOLE');
    }
  });

  it('拿不到路径时 fail closed —— 共域主机上「不知道」等于否决', () => {
    // 调用方漏传 pathname 是会发生的（kernelScanner 的 loc 是分开的几个字段）。
    // 那一刻我们对「这是申请页还是 HR 后台」一无所知，而这一家两者同域。
    const verdict = resolveApplyGate({
      doc: document,
      hostname: 'app.dover.com',
      policy: testApplyPolicy(),
      isTopFrame: true,
    });
    expect(verdict.attach).toBe(false);
    if (!verdict.attach) expect(verdict.reason).toBe('EMPLOYER_CONSOLE');
  });

  it('不共域的厂商行为逐字不变 —— 这次改动只能否决得更多，不能更少', () => {
    document.body.innerHTML = GH_FORM;
    const ok = gateOn(`<div id="grnhse_app">${GH_FORM}</div>`, 'https://job-boards.greenhouse.io/acme/jobs/1');
    expect(ok.attach, 'Greenhouse 候选人面被这次改动误伤').toBe(true);
    // 老的主机级否决一条都不许松。
    const bad = gateOn(`<div id="grnhse_app">${GH_FORM}</div>`, 'https://app.greenhouse.io/apply/acme/885f0f71-a784-4957-a1f2-e3b6980d6ed0');
    expect(bad.attach).toBe(false);
    if (!bad.attach) expect(bad.reason).toBe('EMPLOYER_CONSOLE');
  });
});
