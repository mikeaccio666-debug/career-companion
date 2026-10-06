import { afterEach, describe, expect, it } from 'vitest';

import { evaluateHostVeto, HOST_VETO_REASONS } from '../../src/gate/hostVeto';
import { evaluatePageVeto } from '../../src/gate/pageVeto';
import { createBundledApplyPolicy } from '../../src/policy';

/**
 * S0 · **绝不注入**的否决表。
 *
 * 这道闸门存在的理由，是全网注入把失败模式从"填不上"换成了"浮层出现在不该出现的
 * 地方"——后者严重一个数量级，而且不可撤销：在 NAVEX 伦理举报页上把姓名填进去，
 * 不是填错，是**把匿名性拿掉**。
 *
 * 竞品对照（2026-08-01 解包实测）：Jobright 是 `<all_urls>` + all_frames + 10 条
 * exclude_matches；Simplify 是 `＊://＊/＊` + all_frames 且**一条 exclude 都没有**。
 * 两家**都没有**雇主后台否决——HR 在 `app.greenhouse.io` 建候选人时表单形状与申请表
 * 完全一致。这是我们要比他们做得好的地方之一。
 *
 * 本文件只断言**否决**，不断言"什么情况下会注入"——正向门的宽松是可以逐步收紧的，
 * 否决表漏一条就是一次事故。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const policy = createBundledApplyPolicy();

/**
 * 判别联合不能直接读 `.reason`。测试里统一用这个取法，顺带让"没否决"与
 * "否决了但原因不对"在断言失败信息里长得不一样。
 */
function reasonOf(
  verdict: { readonly vetoed: false } | { readonly vetoed: true; readonly reason: string },
): string | null {
  return verdict.vetoed ? verdict.reason : null;
}

describe('S0 · 主机级否决', () => {
  /**
   * 雇主后台：招聘方自己的候选人管理界面。表单形状与申请表**一模一样**
   * （姓名/邮箱/电话 + 简历上传），今天靠精确主机名表侥幸避开，一扩围就会命中。
   * 后果是 HR 在录入别人的资料时，被我们填上**扩展使用者本人**的资料。
   */
  it.each([
    'app.greenhouse.io',
    'my.greenhouse.io',
    'hire.lever.co',
    'app.ashbyhq.com',
    'admin.ashbyhq.com',
  ])('否决雇主后台 %s', (host) => {
    const verdict = evaluateHostVeto({ hostname: host, policy });
    expect(verdict.vetoed, `${host} 是雇主后台，不能注入`).toBe(true);
    expect(reasonOf(verdict)).toBe('EMPLOYER_CONSOLE');
  });

  it('候选人侧的同厂商主机不受影响（否则整个功能被自己否掉）', () => {
    for (const host of [
      'job-boards.greenhouse.io',
      'boards.greenhouse.io',
      'jobs.lever.co',
      'jobs.ashbyhq.com',
      'apply.workable.com',
    ]) {
      expect(evaluateHostVeto({ hostname: host, policy }).vetoed, `${host} 被误否决`).toBe(false);
    }
  });

  /**
   * 公共部门。按 TLD 写会漏掉大部分非英语国家——`gob.mx`/`gob.es` 是 gob 不是 gov，
   * `go.jp`/`go.kr` 是 go 不是 gov。这张表永远不全，所以它不是唯一防线，
   * 但漏掉整个语种是不可接受的。
   */
  it.each([
    'www.usajobs.gov',
    'service.berlin.de'.replace('service.berlin.de', 'foo.bund.de'),
    'tramites.gob.mx',
    'www.nta.go.jp',
    'www.admin.ch',
    'careers.nhs.uk',
  ])('否决公共部门主机 %s', (host) => {
    expect(evaluateHostVeto({ hostname: host, policy }).vetoed, `${host} 未被否决`).toBe(true);
  });

  it('远程下发的否决后缀生效（这是唯一的线上止血通道）', () => {
    const withDenied = { ...policy, deniedHostSuffixes: ['ethicspoint.com'] };
    const verdict = evaluateHostVeto({ hostname: 'secure.ethicspoint.com', policy: withDenied });
    expect(verdict.vetoed).toBe(true);
    expect(reasonOf(verdict)).toBe('REMOTE_DENYLIST');
  });

  /** 反向探针：普通招聘主机不能被否决，否则以上断言全是"因为什么都否决"而绿。 */
  it('普通主机不被否决', () => {
    for (const host of ['careers.acme.com', 'example.com', 'jobs.lever.co']) {
      expect(evaluateHostVeto({ hostname: host, policy }).vetoed, `${host} 被误否决`).toBe(false);
    }
  });

  it('否决原因是全量记录（新增一条必须同时登记）', () => {
    expect(new Set(HOST_VETO_REASONS).size).toBe(HOST_VETO_REASONS.length);
    expect(HOST_VETO_REASONS).toContain('EMPLOYER_CONSOLE');
    expect(HOST_VETO_REASONS).toContain('PUBLIC_SECTOR');
    expect(HOST_VETO_REASONS).toContain('REMOTE_DENYLIST');
  });
});

describe('S0 · 页面级否决', () => {
  /**
   * ⚠️ 挑战页判据必须是**合取**。
   *
   * `/cdn-cgi/challenge-platform/` 这个路径前缀在**普通** Cloudflare 站点上也存在——
   * 开了 Bot Fight Mode / JS Detections 的站点会把 `.../scripts/jsd/main.js` 注入到
   * 每一个正常页面。拿它单独当否决信号，会静默杀掉真实的 Lever / Ashby 申请页
   * （Lever 自己就用 hCaptcha）。
   */
  it('真正的挑战页被否决', () => {
    document.body.innerHTML = `
      <div id="cf-wrapper"><div id="challenge-running">Verifying you are human…</div></div>
      <script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>`;
    const verdict = evaluatePageVeto(document);
    expect(verdict.vetoed, '挑战页未被否决').toBe(true);
    expect(reasonOf(verdict)).toBe('CHALLENGE_PAGE');
  });

  it('带 Cloudflare JS-Detections 的**正常申请页**不被否决', () => {
    // fixture 必须**真实**。第一版我只放了 3 个控件、1500 字，结果它在统计上与
    // 挑战页无法区分、被正确地否决了 —— 那是 fixture 的问题不是规则的问题。
    // 真实的 Lever / Ashby 申请页有十几个控件和整段职位描述，两条阈值都远远超出。
    const questions = Array.from(
      { length: 12 },
      (_, i) => `<label for="q${i}">Question ${i}</label><input id="q${i}" />`,
    ).join('');
    document.body.innerHTML = `
      <script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>
      <main><p>${'这是职位描述正文，讲清楚岗位职责与要求。'.repeat(200)}</p></main>
      <form id="application-form">
        <label for="name">Full name</label><input id="name" />
        <label for="email">Email</label><input id="email" type="email" />
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
        ${questions}
        <button type="submit">Submit application</button>
      </form>`;
    expect(
      evaluatePageVeto(document).vetoed,
      '把普通 Cloudflare 站点上的真实申请页当成挑战页杀掉了',
    ).toBe(false);
  });

  /**
   * 匿名举报 / 伦理热线。注入的后果不是填错，是**把匿名性拿掉**——
   * 这类页面上姓名邮箱电话都是可选字段，页面正文明说可以匿名提交。
   * 误杀成本为零：真的求职申请表不会说 "you may submit this anonymously"。
   */
  it.each([
    'You may submit this report anonymously.',
    'Report a concern to our ethics hotline',
    'Speak Up — whistleblower portal',
    '本平台支持匿名举报',
  ])('否决匿名举报类页面：%s', (text) => {
    document.body.innerHTML = `<form id="f"><p>${text}</p>
      <label for="n">Name (optional)</label><input id="n" /></form>`;
    const verdict = evaluatePageVeto(document);
    expect(verdict.vetoed).toBe(true);
    expect(reasonOf(verdict)).toBe('ANONYMOUS_REPORT');
  });

  /** 密码字段是全表唯一零误报的硬门：整帧一次查询，不受 form 边界限制。 */
  it('存在密码字段时否决，且不受 form 边界限制', () => {
    document.body.innerHTML = `
      <input id="stray" type="password" />
      <form id="application-form"><input id="email" type="email" /></form>`;
    const verdict = evaluatePageVeto(document);
    expect(verdict.vetoed, 'form 外的裸 password 漏判了').toBe(true);
    expect(reasonOf(verdict)).toBe('CREDENTIAL_PAGE');
  });

  it('新建密码（注册页）同样否决', () => {
    document.body.innerHTML = `<form><input autocomplete="new-password" /></form>`;
    expect(evaluatePageVeto(document).vetoed).toBe(true);
  });

  /** 反向探针：干净的申请页不能被任何一条否决命中。 */
  it('干净的申请页不被否决（否则以上断言全是空转）', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="name">Full name</label><input id="name" />
        <label for="email">Email</label><input id="email" type="email" />
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
      </form>`;
    const verdict = evaluatePageVeto(document);
    expect(verdict.vetoed, `干净申请页被否决：${reasonOf(verdict) ?? ''}`).toBe(false);
  });
});

/**
 * 真实页面回归：**否决器不得把 `<script>` 里的源码当成页面正文**。
 *
 * 2026-08-03 负责人报告 `jobs.lever.co/.../apply` 上浮层完全不出现。真机实测的成因：
 * `evaluatePageVeto` 用 `body.textContent` 取正文，而它**包含 script 标签的内容**；
 * Lever 的内联脚本里有一行
 *   `var SEGMENT_COOKIES = ['ajs_user_id', 'ajs_anonymous_id', 'ajs_group_id'];`
 * `ajs_anonymous_id` 命中匿名举报页的 `anonymous`，于是**每一个装了 Segment 的 Lever
 * 申请页都被静默否决**——浮层不出现、控制台零报错、全部 880 条单测全绿。
 *
 * 这一页的数字：`textContent` 7911 字，人真正能读到的 2294 字，其余全是 21 个 script
 * 标签的源码。也就是说否决器有 71% 的输入根本不是页面内容。
 *
 * 两道独立的防线各自都能挡住它，这里分别锁死：只读可见文本、`anonymous` 加词边界。
 */
describe('S0 · 否决器只看人能读到的文字（真实 Lever 回归）', () => {
  /** 逐字取自 jobs.lever.co 的内联脚本（2026-08-03）。 */
  const LEVER_SEGMENT_SCRIPT =
    "var GA_COOKIES = ['_gid', '_ga', '_gat_customer'];" +
    "var SEGMENT_COOKIES = ['ajs_user_id', 'ajs_anonymous_id', 'ajs_group_id'];";

  function pageWithScript(script: string, visible = '<h1>Apply for this job</h1>'): Document {
    document.body.innerHTML = `${visible}<form id="application-form">
      <input name="name" /><input name="email" /></form>
      <script>${script}<\/script>`;
    return document;
  }

  it('内联脚本里的 ajs_anonymous_id 不再否决整页', () => {
    const verdict = evaluatePageVeto(pageWithScript(LEVER_SEGMENT_SCRIPT));
    expect(
      verdict.vetoed,
      '脚本源码里的一个 cookie 名把整个申请页挡掉了 —— 用户看到的是浮层根本不出现，' +
        '而且没有任何报错可查',
    ).toBe(false);
  });

  it('<style> 与 <noscript> 里的内容同样不算正文', () => {
    document.body.innerHTML = `<h1>Apply</h1>
      <style>.x::after{content:"submit anonymously"}<\/style>
      <noscript>You may report a concern here<\/noscript>
      <form id="application-form"><input name="name" /></form>`;
    expect(evaluatePageVeto(document).vetoed).toBe(false);
  });

  /** 真的匿名举报页必须照旧被挡住 —— 否则这个修复就是把防线拆了。 */
  it('可见正文里真的写着可匿名提交时，照旧否决', () => {
    document.body.innerHTML = `<h1>Ethics Hotline</h1>
      <p>You may submit this report anonymously. Your name is optional.</p>
      <form id="application-form"><input name="name" /></form>`;
    const verdict = evaluatePageVeto(document);
    expect(verdict.vetoed, '匿名举报页被放行 —— 填进姓名等于把匿名性拿掉').toBe(true);
    expect(verdict.vetoed ? verdict.reason : null).toBe('ANONYMOUS_REPORT');
  });

  /**
   * 第二道防线单独锁死：即使有人以后又把 script 内容混进输入，
   * 词边界也要让 `ajs_anonymous_id` 这类标识符不命中。
   */
  it('词边界让 ajs_anonymous_id 这类标识符本身就不命中', () => {
    document.body.innerHTML = `<h1>Apply</h1>
      <p>${LEVER_SEGMENT_SCRIPT}</p>
      <form id="application-form"><input name="name" /></form>`;
    expect(
      evaluatePageVeto(document).vetoed,
      '把 cookie 名当成可见文字时仍然否决 —— 说明只剩一道防线在起作用',
    ).toBe(false);
  });
});
