// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { installApplyAdapters } from '@edaix/apply-kernel/registry';
import { applyAdaptersFromRuntimeRegistry, createRuntimeApplyRegistry } from '@edaix/apply-kernel/runtimeRegistry';
import type { ApplyVendor } from '@edaix/apply-kernel/vendors';
import { hasJobPosting } from '../lib/jobCardFromPage';
import { genericApplyFormEvidence, type GenericFormEvidence } from '../lib/kernelScanner';
import { SLOW_PROBE_MS, createPageEvidenceTracker } from '../lib/pageEvidence';

/**
 * 没认出厂商的页面上「浮层为什么该露面」的证据（2026-09-24，商店包开全网；2026-09-25 分出「带求职信号的表」）。
 * 记账规矩见 `lib/pageEvidence.ts`；这里再在真 DOM 上跑一遍两个读法。
 */

type Page = { path: string; hint: ApplyVendor | null; form: GenericFormEvidence; job: boolean; probeMs: number };

const fakePage = (over: Partial<Page> = {}) => {
  const page: Page = { path: '/jobs/1', hint: null, form: 'NONE', job: false, probeMs: 1, ...over };
  let clock = 0;
  const probes = { generic: 0 };
  const tracker = createPageEvidenceTracker({
    pathname: () => page.path,
    vendorHint: () => page.hint,
    genericForm: () => { probes.generic += 1; clock += page.probeMs; return page.form; },
    jobPosting: () => page.job,
    now: () => clock,
  });
  return { page, tracker, probes };
};

describe('证据记账', () => {
  it('空页面：没有证据，报到什么都不带', () => {
    const { tracker } = fakePage();
    expect(tracker.refresh()).toBe(false);
    expect(tracker.hello()).toEqual({});
  });

  it('表单画出来之后：证据多了一次，报到带上 genericForm', () => {
    const { page, tracker } = fakePage();
    tracker.refresh();
    page.form = 'FORM';
    expect(tracker.refresh()).toBe(true);
    expect(tracker.hello()).toEqual({ genericForm: true });
    // 没有新东西：不再报到。
    expect(tracker.refresh()).toBe(false);
  });

  it('带求职信号的表：报到同时带上 genericForm 与 genericJobForm', () => {
    const { tracker } = fakePage({ form: 'JOB_FORM' });
    expect(tracker.refresh()).toBe(true);
    expect(tracker.hello()).toEqual({ genericForm: true, genericJobForm: true });
    expect(tracker.hasJobForm()).toBe(true);
  });

  it('表先出来、简历栏后出来（多步表单翻到下一步）：再报一次，升成 genericJobForm', () => {
    const { page, tracker } = fakePage({ form: 'FORM' });
    tracker.refresh();
    expect(tracker.hasJobForm()).toBe(false);
    page.form = 'JOB_FORM';
    expect(tracker.refresh()).toBe(true);
    expect(tracker.hello()).toEqual({ genericForm: true, genericJobForm: true });
  });

  it('只增不减：交完表变成「谢谢」，证据不撤（否则脸会退回标签、把这一轮换掉）', () => {
    const { page, tracker } = fakePage({ form: 'JOB_FORM', job: true });
    tracker.refresh();
    page.form = 'NONE';
    page.job = false;
    expect(tracker.refresh()).toBe(false);
    expect(tracker.hello()).toEqual({ genericForm: true, genericJobForm: true, jobPosting: true });
  });

  it('换路径就是另一页：从头看', () => {
    const { page, tracker } = fakePage({ form: 'JOB_FORM' });
    tracker.refresh();
    page.path = '/about';
    page.form = 'NONE';
    tracker.refresh();
    expect(tracker.hello()).toEqual({});
  });

  it('有白标指纹时不探通用表（与 pageLane 同一个互斥）', () => {
    const { tracker, probes } = fakePage({ hint: 'greenhouse', form: 'JOB_FORM' });
    expect(tracker.refresh()).toBe(true);
    expect(tracker.hello()).toEqual({ vendorHint: 'greenhouse' });
    expect(probes.generic).toBe(0);
    expect(tracker.hasJobForm()).toBe(true);
  });

  it('慢页面不再探：一次通用探测超过上限，这条路径上就不再探', () => {
    const { page, tracker, probes } = fakePage({ probeMs: SLOW_PROBE_MS + 1 });
    tracker.refresh();
    tracker.refresh();
    expect(probes.generic).toBe(1);
    // 换了路径重新给机会。
    page.path = '/other';
    page.probeMs = 1;
    tracker.refresh();
    tracker.refresh();
    expect(probes.generic).toBe(3);
  });

  it('表里有只有求职才问的栏（APPLICATION_FORM）：报到与 JOB_FORM 一样，另外说得出「可以自动打开」', () => {
    const { tracker } = fakePage({ form: 'APPLICATION_FORM' });
    expect(tracker.refresh()).toBe(true);
    expect(tracker.hello()).toEqual({ genericForm: true, genericJobForm: true });
    expect(tracker.hasJobForm()).toBe(true);
    expect(tracker.hasJobOnlyFields()).toBe(true);
  });

  it('只有较弱的求职信号（JOB_FORM）：不说「可以自动打开」，而且接着探——简历栏可能在下一步才出来', () => {
    const { page, tracker, probes } = fakePage({ form: 'JOB_FORM' });
    tracker.refresh();
    expect(tracker.hasJobOnlyFields()).toBe(false);
    page.form = 'APPLICATION_FORM';
    expect(tracker.refresh()).toBe(false);
    expect(tracker.hasJobOnlyFields()).toBe(true);
    expect(probes.generic).toBe(2);
  });

  it('认出带只有求职才问的栏的表之后不再探（已经到顶了）', () => {
    const { tracker, probes } = fakePage({ form: 'APPLICATION_FORM' });
    tracker.refresh();
    tracker.refresh();
    expect(probes.generic).toBe(1);
  });

  it('JobPosting 单独也是证据，但不算「认出了表」', () => {
    const { tracker } = fakePage({ job: true });
    expect(tracker.refresh()).toBe(true);
    expect(tracker.hello()).toEqual({ jobPosting: true });
    expect(tracker.hasJobForm()).toBe(false);
  });
});

const withGenericInstalled = async (): Promise<void> => {
  const registry = await createRuntimeApplyRegistry(APPLY_RULES_RUNTIME_RELEASE_V1);
  if (!registry.ok) throw new Error(registry.code);
  installApplyAdapters(applyAdaptersFromRuntimeRegistry(registry.value));
};

const field = (id: string, label: string, attrs = 'type="text"') =>
  `<p><label for="${id}">${label}</label><input id="${id}" ${attrs}></p>`;

/** 公司自建域名上的申请表：只有标准 autocomplete 与干净的标签，带 LinkedIn。 */
const APPLICATION_FORM = `
  <form class="apply">
    ${field('a1', 'First name', 'type="text" autocomplete="given-name"')}
    ${field('a2', 'Last name', 'type="text" autocomplete="family-name"')}
    ${field('a3', 'Email', 'type="email" autocomplete="email"')}
    ${field('a4', 'Phone', 'type="tel" autocomplete="tel"')}
    ${field('a5', 'LinkedIn Profile')}
  </form>`;

/** 「联系销售」（2026-09-25 测试台：Zendesk、DocuSign、HubSpot 的这一页都自动弹出了浮层）。 */
const CONTACT_SALES_FORM = `
  <form class="contact-sales">
    ${field('c1', 'First name', 'type="text" autocomplete="given-name"')}
    ${field('c2', 'Last name', 'type="text" autocomplete="family-name"')}
    ${field('c3', 'Business email', 'type="email" autocomplete="email"')}
    ${field('c4', 'Phone number', 'type="tel" autocomplete="tel"')}
    ${field('c5', 'Company')}
    ${field('c6', 'Job title')}
    ${field('c7', 'Country', 'type="text" autocomplete="country-name"')}
    ${field('c10', 'Website URL')}
    <p><label for="c8">How can we help?</label><textarea id="c8"></textarea></p>
  </form>`;

/** 同一张联系表，多了一个简历上传栏：那就是申请。 */
const WITH_RESUME = CONTACT_SALES_FORM.replace('</form>', `${field('c9', 'Resume/CV', 'type="file"')}</form>`);

/** 注册表单：姓名、邮箱、电话都凑得够，但它有密码栏。 */
const SIGN_UP_FORM = `
  <form class="signup">
    ${field('s1', 'First name', 'type="text" autocomplete="given-name"')}
    ${field('s2', 'Last name', 'type="text" autocomplete="family-name"')}
    ${field('s3', 'Email', 'type="email" autocomplete="email"')}
    ${field('s4', 'Phone', 'type="tel" autocomplete="tel"')}
    ${field('s9', 'LinkedIn Profile')}
    ${field('s5', 'Password', 'type="password" autocomplete="new-password"')}
  </form>`;

const SEARCH_FORM = `<form role="search"><input type="search" name="q" aria-label="Search"></form>`;

describe('真 DOM：这一页上有没有一张通用申请表', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    installBundledApplyAdapters();
  });

  it('自建域上的申请表（带 LinkedIn）：有，而且带求职信号', async () => {
    await withGenericInstalled();
    document.body.innerHTML = SEARCH_FORM + APPLICATION_FORM;
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
  });

  it('联系销售：认得够多栏，但公司、职位、国家、公司网站都不是求职信号 → 只是一张表', async () => {
    await withGenericInstalled();
    document.body.innerHTML = CONTACT_SALES_FORM;
    expect(genericApplyFormEvidence(document)).toBe('FORM');
  });

  it('同一张表多了简历上传栏 → 带求职信号（而且是只有求职才问的栏）', async () => {
    await withGenericInstalled();
    document.body.innerHTML = WITH_RESUME;
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
  });

  it('简历上传栏的标签只写着「Choose files.」、稳定钩子叫 resume[]（Valve，2026-09-28）→ 带求职信号', async () => {
    await withGenericInstalled();
    document.body.innerHTML = `
      <form data-form-type="job-apply">
        ${field('v1', 'Name')}
        ${field('v2', 'Email address')}
        ${field('v3', 'How did you discover this opportunity?')}
        <p><input type="file" multiple name="resume[]" id="docs"><label for="docs">Choose files.</label></p>
      </form>`;
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
  });

  it('自建域上的申请表（带 LinkedIn）：只有求职才问的栏 → APPLICATION_FORM（可以自动打开）', async () => {
    await withGenericInstalled();
    document.body.innerHTML = APPLICATION_FORM;
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
  });

  it('联系销售 + 简历上传栏 → APPLICATION_FORM', async () => {
    await withGenericInstalled();
    document.body.innerHTML = WITH_RESUME;
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
  });

  it('问工作授权的题 → APPLICATION_FORM', async () => {
    await withGenericInstalled();
    document.body.innerHTML = CONTACT_SALES_FORM.replace('</form>', `
      <fieldset><legend>Are you legally authorized to work in the United States?</legend>
        <label><input type="radio" name="wa" value="yes">Yes</label><label><input type="radio" name="wa" value="no">No</label>
      </fieldset></form>`);
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
  });

  it('学历那一节里的学校、专业 → APPLICATION_FORM；不在学历那一节里的「Highest level of education」不算', async () => {
    await withGenericInstalled();
    document.body.innerHTML = CONTACT_SALES_FORM.replace('</form>', `
      <section><h3>Education</h3>${field('e1', 'University')}${field('e2', 'Field of Study')}</section></form>`);
    expect(genericApplyFormEvidence(document)).toBe('APPLICATION_FORM');
    // 大学的「索取资料」表：问你的最高学历，但它不在学历那一节里，而且没有别的求职栏。
    document.body.innerHTML = `
      <form><h3>Request information</h3>
        ${field('r1', 'First name')}${field('r2', 'Last name')}${field('r3', 'Email')}${field('r4', 'Phone')}
        <p><label for="r5">Highest level of education</label><select id="r5"><option value="">Select</option><option>High school</option><option>Bachelor's degree</option></select></p>
      </form>`;
    expect(genericApplyFormEvidence(document)).toBe('FORM');
  });

  it('只有较弱的求职信号（GitHub、期望薪资）→ JOB_FORM：能填，但不自动打开', async () => {
    await withGenericInstalled();
    document.body.innerHTML = CONTACT_SALES_FORM.replace('</form>', `${field('g1', 'GitHub')}</form>`);
    expect(genericApplyFormEvidence(document)).toBe('JOB_FORM');
  });

  it('只有姓名、邮箱、电话、城市：只是一张表', async () => {
    await withGenericInstalled();
    document.body.innerHTML = `<form>${field('n1', 'First name')}${field('n2', 'Last name')}${field('n3', 'Email')}${field('n4', 'Phone')}${field('n5', 'City')}</form>`;
    expect(genericApplyFormEvidence(document)).toBe('FORM');
  });

  it('只有搜索框（百科、新闻、搜索页）：没有', async () => {
    await withGenericInstalled();
    document.body.innerHTML = SEARCH_FORM;
    expect(genericApplyFormEvidence(document)).toBe('NONE');
  });

  it('注册表单：有密码栏就不算', async () => {
    await withGenericInstalled();
    document.body.innerHTML = SIGN_UP_FORM;
    expect(genericApplyFormEvidence(document)).toBe('NONE');
  });

  it('两张都像申请表：不猜', async () => {
    await withGenericInstalled();
    document.body.innerHTML = APPLICATION_FORM + APPLICATION_FORM.replaceAll('id="a', 'id="b').replaceAll('for="a', 'for="b');
    expect(genericApplyFormEvidence(document)).toBe('NONE');
  });

  it('通用规则没装上：没有（fail closed）', () => {
    document.body.innerHTML = APPLICATION_FORM;
    expect(genericApplyFormEvidence(document)).toBe('NONE');
  });
});

describe('真 DOM：页面有没有声明 JobPosting', () => {
  afterEach(() => { document.head.innerHTML = ''; });

  const ldJson = (value: unknown) => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(value);
    document.head.append(script);
  };

  it('有 JobPosting（含 @graph 包着的）：是', () => {
    ldJson({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Acme' }, { '@type': 'JobPosting', title: 'Engineer' }] });
    expect(hasJobPosting(document)).toBe(true);
  });

  it('只有文章、组织这类结构化数据：不是', () => {
    ldJson({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Job application' });
    expect(hasJobPosting(document)).toBe(false);
  });

  it('坏掉的 ld+json：不是，也不抛', () => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = '{not json';
    document.head.append(script);
    expect(hasJobPosting(document)).toBe(false);
  });
});
