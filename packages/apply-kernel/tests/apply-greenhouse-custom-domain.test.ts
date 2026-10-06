// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
import { afterEach, describe, expect, it } from 'vitest';

import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import { fingerprintVendorHint } from '../src/gate/vendorFingerprint';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * 自建域名上的 Greenhouse 板：**拒绝型 fixture**。
 *
 * 2026-09-15 只读实测（调查全文见 src/gate/vendorFingerprint.ts 的说明）：
 * 用 Greenhouse 自己的 boards-api 问过本仓已知的 56 个 board，24 个把 posting
 * 放在客户自己的域名上。打开之后只有三类——官方 embed（已认得）、落地页上没有
 * 表单、以及**客户自建前端**。第三类身上没有任何 Greenhouse 自己的产物。
 *
 * 这份 fixture 锁的就是"**不认**"这件事本身。它在的意义是：下一个人想用那两条
 * 看着很像的信号（`<link rel=preload>` 指向 boards-api、岗位正文里的
 * greenhouse.io 链接）扩指纹时，这里会变红，并且注释告诉他为什么不能——
 * careers.duolingo.com 的同一个 `<head>` 里还预载着 `duolingo.breezy.hr/json`，
 * 认下去等于把每个 Breezy 岗位判成 Greenhouse。
 *
 * 同时锁住**真正认得的那一条**：Greenhouse 自己发的入口 URL 带 `?gh_jid=`，
 * 指纹今天就认它。实测这家不带参数时整页一个 form 都没有；带上参数门控
 * `attach:true vendor:greenhouse`，随后停在 `NO_ROOT`——那一停是对的。
 */

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

/**
 * careers.duolingo.com/jobs/<id> 的真实形状（2026-09-15 只读实测，结构逐字照抄，
 * 正文与选项文案截短、值全部为空）。
 */
function mountCustomDomainBoard(): void {
  document.head.innerHTML = `
    <link as="fetch" crossorigin="" href="https://boards-api.greenhouse.io/v1/boards/duolingo/departments" rel="preload">
    <link as="fetch" crossorigin="" href="https://duolingo.breezy.hr/json" rel="preload">`;
  document.body.innerHTML = `
    <main>
      <h1>Ad Sales Lead, Central</h1>
      <p>Read <a href="https://blog.duolingo.com/?utm_source=greenhouse.com&amp;utm_medium=referral">our blog</a> to learn more.</p>
      <p><strong>Job Alerts:</strong> Sign up for job alerts
        <a href="http://my.greenhouse.io/users/sign_in?job_board=duolingo">here</a>.</p>
      <p>We use Greenhouse Software's Talent Matching feature to assist with reviewing applications.
        <a href="http://app2.greenhouse.io/ai_opt_out_request/job_post/8653419002/ai_opt_out">Opt-out here</a></p>
      <h2 id="apply">Apply</h2>
      <form class="k30Iw" novalidate>
        <label id="first_name--label" for="first_name">First Name</label><input id="first_name" type="text" />
        <label id="last_name--label" for="last_name">Last Name</label><input id="last_name" type="text" />
        <label id="email--label" for="email">Email</label><input id="email" type="email" />
        <input id="resume" type="file" />
        <label id="question_37488760002--label" for="question_37488760002">Are you legally authorized to work in the US?</label>
        <input id="question_37488760002" type="text" />
      </form>
    </main>`;
}

const hintFor = (href: string) => fingerprintVendorHint({ doc: document, url: new URL(href) });

describe('自建域名上的 Greenhouse 板', () => {
  it('客户自建前端：一条 Greenhouse 自己的产物都没有 → 认不出就不猜', () => {
    mountCustomDomainBoard();
    expect(hintFor('https://careers.duolingo.com/jobs/8653419002')).toBeNull();
  });

  it('那张表确实**没有**任何官方产物——所以上一条不是因为选择器写错了', () => {
    mountCustomDomainBoard();
    for (const selector of [
      '#grnhse_app',
      'iframe#grnhse_iframe',
      'form#application-form',
      '[name^="job_application"]',
      'form input[type="hidden"][name="action"]',
    ]) {
      expect(document.querySelectorAll(selector).length, selector).toBe(0);
    }
    // 反过来：页面上确实有 "greenhouse" 字样，而且不止一处——认不出不是因为没看见。
    expect(document.querySelectorAll('a[href*="greenhouse.io"]').length).toBeGreaterThan(1);
    expect(document.querySelectorAll('link[href*="greenhouse.io"]').length).toBe(1);
  });

  it('预载 boards-api 不算判据：同一个 <head> 里还预载着另一家 ATS', () => {
    mountCustomDomainBoard();
    // 这条断言是那个"为什么不能"的证据：同一套外壳同时供着 Greenhouse 与 Breezy，
    // 拿预载归属会把每个 Breezy 岗位判成 Greenhouse。
    expect(document.querySelector('link[href*="breezy.hr"]')).not.toBeNull();
    expect(hintFor('https://careers.duolingo.com/jobs/8653419002')).toBeNull();
  });

  it('岗位正文里的 greenhouse.io 链接不算判据：正文是雇主自己敲的字', () => {
    document.body.innerHTML = `
      <main><p>Apply through <a href="https://my.greenhouse.io/users/sign_in">our board</a>.</p>
      <form><input name="name" /><input name="email" /></form></main>`;
    expect(hintFor('https://careers.example.com/jobs/1')).toBeNull();
  });

  it('真正认得的那一条还在：Greenhouse 自己发的入口 URL 带 gh_jid', () => {
    mountCustomDomainBoard();
    // boards-api 给这 24 个客户域板发的 absolute_url、以及站点自己的 Apply 链接，
    // 都带这个参数。实测门控由此 attach:true / vendor:greenhouse / source:FINGERPRINT。
    expect(hintFor('https://careers.duolingo.com/jobs/8653419002?gh_jid=8653419002')).toBe('greenhouse');
  });

  it('自建域名上的官方 embed 照旧认得（brex / datadog / mongodb 的形状）', () => {
    document.body.innerHTML = '<div id="grnhse_app"><iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_app?token=1"></iframe></div>';
    expect(hintFor('https://www.brex.com/careers/8686667002')).toBe('greenhouse');
  });
});

/**
 * 白标 B（P2-11，2026-09-21）：上面那份「不认」的 fixture 现在有了第二半——**认出厂商之后**（`?gh_jid=`
 * 是 Greenhouse 自己发的入口 URL），规则的 `whitelabelRoot` 允许在没有 form#application-form 时退而找
 * 「包含 ≥ 3 个本家 id 钩子的唯一 form」。指纹那条红线一个字没动：认厂商仍只靠厂商自己的产物；
 * 这里放宽的只是**已经认出厂商之后**的容器锚点，而且只对自称白标的调用方开。
 */
describe('自建域名上的 Greenhouse 板 · 白标 B：认出厂商之后按本家 id 钩子找表', () => {
  const adapter = compileBundledAdapter(greenhouseRules);

  it('≥ 3 个本家钩子的唯一 form → 认出并扫出本家字段；不声明白标照旧 NO_ROOT', () => {
    mountCustomDomainBoard();
    expect(adapter.resolveRoot(document)).toBeNull();
    const root = adapter.resolveRoot(document, { whitelabel: true });
    expect(root).not.toBeNull();
    const keys = adapter.scan(root!, { whitelabel: true }).map((field) => field.key).filter((key) => key !== null);
    expect(keys).toEqual(expect.arrayContaining(['firstName', 'lastName', 'email']));
    expect(keys.length).toBeGreaterThanOrEqual(3);
  });

  it('只有 1 个钩子 → 仍 NO_ROOT：那是「看起来像申请表」，不是本家的数据契约', () => {
    mountCustomDomainBoard();
    document.getElementById('last_name')!.removeAttribute('id');
    document.getElementById('email')!.removeAttribute('id');
    expect(adapter.resolveRoot(document, { whitelabel: true })).toBeNull();
  });

  it('两个 form 都像 → 不猜', () => {
    mountCustomDomainBoard();
    const twin = document.querySelector('form')!.cloneNode(true) as HTMLElement;
    document.body.append(twin);
    expect(adapter.resolveRoot(document, { whitelabel: true })).toBeNull();
  });

  it('白标下路径知识不适用：本家的 applyPath 对别人的域名不成立，靠 DOM 那道闸', () => {
    expect(adapter.isApplyPath('/jobs/8653419002')).toBe(false);
    expect(adapter.isApplyPath('/jobs/8653419002', { whitelabel: true })).toBe(true);
  });
});
