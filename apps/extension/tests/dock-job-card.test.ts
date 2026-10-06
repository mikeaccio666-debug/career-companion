// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type DockJobCard, type DockJobFacts } from '../lib/autofillDock';
import { jobChips, postedAgo, salaryText } from '../lib/dock/jobFacts';
import type { AutofillAffordance } from '../product-panel/affordance';

/**
 * 首页的岗位摘要卡（2026-09-24 负责人照设计要的，去掉中间那块「多维 ATS 评估」）。
 *
 * 钉住：首页读到 JobPosting 就展开（公司、「厂商 · N 天前」、20px 的岗位名、胶囊、薪资、简介、
 * 「查看完整岗位详情」），缺哪样就不摆哪样；匹配要点只画调用方给的，没给就什么都不画；读不到 JobPosting
 * 照旧是一行；一开始填、或这一页填不了，就是一行。
 */
const FACTS: DockJobFacts = {
  location: 'New York City, NY, USA',
  workMode: 'REMOTE',
  employment: 'FULL_TIME',
  salary: { min: 189000, max: 330000, currency: 'USD', unit: 'YEAR' },
  description: 'Ramp builds the finance tools that save teams time.',
  postedAt: '2026-09-21',
  detailUrl: 'https://jobs.ashbyhq.com/ramp/f564dcf9',
};

afterEach(() => { vi.useRealTimers(); });

const mount = (card: DockJobCard | null, face: AutofillAffordance = { kind: 'UNAVAILABLE', reason: 'NO_MISSION' }) => {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock(face, { onAutofill: () => {}, onOpenEntry: () => {}, vendorLabel: 'Ashby', jobCard: () => card }, doc);
  handle.openPanel();
  const job = handle.sceneRoot()!.querySelector<HTMLElement>('.job')!;
  return { handle, job };
};
const shown = (node: Element | null | undefined): boolean => node != null && (node as HTMLElement).style.display !== 'none';
const text = (job: HTMLElement, selector: string): string | null => {
  const node = job.querySelector(selector);
  return shown(node) ? node?.textContent ?? null : null;
};

describe('岗位卡上几样东西怎么写', () => {
  it('薪资：年薪写成 k，按月也写 k，按小时写原数；旁边小字写币种与周期；读不出就没有', () => {
    expect(salaryText({ min: 140000, max: 175000, currency: 'USD', unit: 'YEAR' })).toEqual({ amount: '$140k – $175k', unit: 'USD / 年' });
    expect(salaryText({ min: 8500, max: 8500, currency: 'EUR', unit: 'MONTH' })).toEqual({ amount: '€8.5k', unit: 'EUR / 月' });
    expect(salaryText({ min: 45, max: 60.5, currency: 'USD', unit: 'HOUR' })).toEqual({ amount: '$45 – $60.50', unit: 'USD / 小时' });
    expect(salaryText({ min: 1_200_000, max: 1_500_000, currency: 'JPY', unit: null })).toEqual({ amount: '¥1.2M – ¥1.5M', unit: 'JPY' });
    expect(salaryText({ min: 0, max: 10, currency: 'USD', unit: 'YEAR' })).toBeNull();
    expect(salaryText({ min: 1, max: 10, currency: 'usd', unit: 'YEAR' })).toBeNull();
    expect(salaryText(null)).toBeNull();
  });

  it('办公方式与雇佣类型照设计写英文；缺哪样就少哪颗胶囊', () => {
    expect(jobChips(FACTS)).toEqual(['New York City, NY, USA', 'Remote', 'Full-time']);
    expect(jobChips({ workMode: 'HYBRID', employment: 'INTERNSHIP' })).toEqual(['Hybrid', 'Internship']);
    expect(jobChips({ location: 'Austin, TX', workMode: 'ONSITE', employment: 'CONTRACT' })).toEqual(['Austin, TX', 'On-site', 'Contract']);
    expect(jobChips({ employment: 'PART_TIME' })).toEqual(['Part-time']);
    expect(jobChips({})).toEqual([]);
  });

  it('发布了多久：按本地日历日；一个月以上写月、一年以上写年；日期不对或在将来就不写', () => {
    const now = new Date(2026, 8, 24, 9, 30);
    expect(postedAgo('2026-09-24', now)).toBe('今天');
    expect(postedAgo('2026-09-23', now)).toBe('1 天前');
    expect(postedAgo('2026-09-21', now)).toBe('3 天前');
    expect(postedAgo('2026-08-01', now)).toBe('1 个月前');
    expect(postedAgo('2025-07-31', now)).toBe('1 年前');
    expect(postedAgo('2026-09-30', now)).toBeNull();
    expect(postedAgo('yesterday', now)).toBeNull();
    expect(postedAgo(null, now)).toBeNull();
  });
});

describe('首页：读到 JobPosting 就展开成摘要卡', () => {
  it('公司与「厂商 · 3 天前」、岗位名、三颗胶囊、薪资、简介、新标签页打开的「查看完整岗位详情」', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 24, 10, 0), toFake: ['Date'] });
    const { job } = mount({ title: 'Mobile Engineer, Android', company: 'Ramp', facts: FACTS });
    expect(job.dataset.size).toBe('full');
    expect(text(job, '.job-mark')).toBe('R');
    expect(text(job, '.job-co')).toBe('Ramp');
    expect(text(job, '.job-meta')).toBe('Ashby · 3 天前');
    expect(text(job, '.job-title-lg')).toBe('Mobile Engineer, Android');
    expect(Array.from(job.querySelectorAll('.job-chip')).map((chip) => chip.textContent)).toEqual(['New York City, NY, USA', 'Remote', 'Full-time']);
    expect(text(job, '.job-pay-amount')).toBe('$189k – $330k');
    expect(text(job, '.job-pay-unit')).toBe('USD / 年');
    expect(text(job, '.job-desc')).toBe('Ramp builds the finance tools that save teams time.');
    const link = job.querySelector<HTMLAnchorElement>('.job-link');
    expect(text(job, '.job-link')).toBe('查看完整岗位详情');
    expect(link?.getAttribute('href')).toBe('https://jobs.ashbyhq.com/ramp/f564dcf9');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
  });

  it('缺哪样就不摆哪样：没有薪资、没有日期、没有简介、算不出详情页、没有公司名', () => {
    const { job } = mount({ title: 'Engineer', company: '', facts: { employment: 'FULL_TIME' } });
    expect(job.dataset.size).toBe('full');
    expect(text(job, '.job-co'), '没有公司名：第一行写厂商').toBe('Ashby');
    expect(shown(job.querySelector('.job-meta')), '厂商已经在第一行，也没有日期：小字那一行不摆').toBe(false);
    expect(Array.from(job.querySelectorAll('.job-chip')).map((chip) => chip.textContent)).toEqual(['Full-time']);
    expect(shown(job.querySelector('.job-pay'))).toBe(false);
    expect(shown(job.querySelector('.job-desc'))).toBe(false);
    expect(shown(job.querySelector('.job-link'))).toBe(false);
    expect(job.querySelector('.job-link')?.hasAttribute('href')).toBe(false);
  });

  it('匹配要点：没给就什么都不画；给了才画（✓ 长处、· 差距），绝不自己编', () => {
    const none = mount({ title: 'Engineer', company: 'Ramp', facts: FACTS }).job;
    expect(none.querySelectorAll('.job-hl-item')).toHaveLength(0);
    expect(shown(none.querySelector('.job-hl'))).toBe(false);
    const given = mount({ title: 'Engineer', company: 'Ramp', facts: { ...FACTS, highlights: [
      { tone: 'strength', text: '设计系统与复杂流程经验直接对应' },
      { tone: 'gap', text: '岗位强调 B2B 场景' },
    ] } }).job;
    expect(Array.from(given.querySelectorAll<HTMLElement>('.job-hl-item')).map((item) => [item.dataset.tone, item.textContent])).toEqual([
      ['strength', '设计系统与复杂流程经验直接对应'],
      ['gap', '岗位强调 B2B 场景'],
    ]);
  });

  it('「查看完整岗位详情」只开 http(s)', () => {
    const { job } = mount({ title: 'Engineer', company: 'Ramp', facts: { ...FACTS, detailUrl: 'javascript:alert(1)' } });
    expect(shown(job.querySelector('.job-link'))).toBe(false);
    expect(job.querySelector('.job-link')?.hasAttribute('href')).toBe(false);
  });
});

describe('什么时候是一行', () => {
  it('读不到 JobPosting：照旧一行岗位名与「公司 · 厂商」', () => {
    const { job } = mount({ title: 'Software Engineer in Test', company: '' });
    expect(job.dataset.size).toBe('compact');
    expect(text(job, '.job-title')).toBe('Software Engineer in Test');
    expect(text(job, '.job-sub')).toBe('Ashby');
  });

  it('一开始填就收成一行（填完那一幕也是一行）：岗位名 15px，「公司 · 厂商」', () => {
    const { handle, job } = mount({ title: 'Mobile Engineer, Android', company: 'Ramp', facts: FACTS });
    handle.beginPreparing();
    expect(job.dataset.size).toBe('compact');
    handle.beginRun({ runId: 'r1', requiredQuestions: 1, requiredCompleted: 1, phase: 'SETTLED',
      rows: [{ label: 'Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' }] } as never);
    expect(job.dataset.size).toBe('compact');
    expect(text(job, '.job-title')).toBe('Mobile Engineer, Android');
    expect(text(job, '.job-sub')).toBe('Ramp · Ashby');
  });

  it('这一页填不了的几张脸（没连接、不是申请表、取不到规则）：一行，那张脸自己的那一句才是这一幕的标题', () => {
    for (const face of [
      { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' },
      { kind: 'DORMANT' },
      { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' },
    ] as const) {
      expect(mount({ title: 'Engineer', company: 'Ramp', facts: FACTS }, face).job.dataset.size, JSON.stringify(face)).toBe('compact');
    }
  });

  it('按下「自动填写」：展开的卡 320ms 收成一行（FLIP，浮层的 EASE），胶囊、薪资、简介等头 120ms 淡出，动完拿掉克隆', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls: Array<{ node: Element; frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      calls.push({ node: this, frames: frames as Keyframe[], options: options as KeyframeAnimationOptions });
      return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
    } as typeof HTMLElement.prototype.animate;
    try {
      class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
      let started = 0;
      const doc = document.implementation.createHTMLDocument();
      const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
        onAutofill: () => { started += 1; }, onOpenEntry: () => {}, vendorLabel: 'Ashby',
        jobCard: () => ({ title: 'Mobile Engineer, Android', company: 'Ramp', facts: FACTS }),
      }, doc);
      handle.openPanel();
      const job = handle.sceneRoot()!.querySelector<HTMLElement>('.job')!;
      expect(job.dataset.size).toBe('full');
      calls.length = 0;
      handle.autofillButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
      expect(started).toBe(1);
      expect(job.dataset.size, '终点是一行').toBe('compact');
      const ghost = job.querySelector('.job-ghost');
      expect(ghost?.getAttribute('aria-hidden')).toBe('true');
      const card = calls.find((call) => call.node === job);
      expect(card?.options.duration).toBe(320);
      expect(card?.options.easing).toBe('cubic-bezier(.32,.72,0,1)');
      expect(Object.keys(card?.frames[0] ?? {})).toContain('height');
      const extras = calls.find((call) => call.node.classList.contains('job-more'));
      expect(extras?.node.parentElement, '淡出的是原处的克隆').toBe(ghost);
      expect(extras?.options.duration).toBe(120);
      expect(extras?.frames.map((frame) => frame.opacity)).toEqual([1, 0]);
      expect(calls.some((call) => call.node.classList.contains('job-title-lg') && call.options.duration === 320), '大标题缩成一行里的岗位名').toBe(true);
      vi.advanceTimersByTime(400);
      expect(job.querySelector('.job-ghost'), '动完拿掉克隆').toBeNull();
    } finally {
      HTMLElement.prototype.animate = original;
    }
  });

  it('系统要求减少动态：直接换成一行，不留克隆、不动卡片', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null })) as unknown as typeof window.matchMedia;
    const animated: Element[] = [];
    const animateBefore = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (this: Element) { animated.push(this); return { cancel() {}, finished: Promise.resolve() } as unknown as Animation; } as typeof HTMLElement.prototype.animate;
    try {
      const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
        onAutofill: () => {}, onOpenEntry: () => {}, vendorLabel: 'Ashby',
        jobCard: () => ({ title: 'Mobile Engineer, Android', company: 'Ramp', facts: FACTS }),
      }, document);
      handle.openPanel();
      const job = handle.sceneRoot()!.querySelector<HTMLElement>('.job')!;
      handle.beginPreparing();
      expect(job.dataset.size).toBe('compact');
      expect(job.querySelector('.job-ghost')).toBeNull();
      expect(animated.filter((node) => node === job || job.contains(node))).toEqual([]);
      handle.dismiss();
    } finally {
      window.matchMedia = original;
      HTMLElement.prototype.animate = animateBefore;
    }
  });

  it('打开面板时先让调用方读岗位卡、再画：第一帧就是展开的卡，不先画「Ashby 申请表」再跳', () => {
    let card: DockJobCard | null = null;
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
      onAutofill: () => {}, onOpenEntry: () => {}, vendorLabel: 'Ashby', autoOpen: true,
      // 调用方在 onPanelOpen 里才从页面读岗位卡（apply.content.ts 的 refreshJobCard）。
      onPanelOpen: () => { card = { title: 'Mobile Engineer, Android', company: 'Ramp', facts: FACTS }; },
      jobCard: () => card,
    }, doc);
    const job = handle.sceneRoot()!.querySelector<HTMLElement>('.job')!;
    expect(job.dataset.size).toBe('full');
    expect(job.querySelector('.job-title-lg')?.textContent).toBe('Mobile Engineer, Android');
  });

  it('调用方后来读到了详情页：refreshJob 之后展开', () => {
    let card: DockJobCard = { title: 'Engineer', company: '' };
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {}, vendorLabel: 'Workable', jobCard: () => card }, doc);
    handle.openPanel();
    const job = handle.sceneRoot()!.querySelector<HTMLElement>('.job')!;
    expect(job.dataset.size).toBe('compact');
    card = { title: 'Engineer', company: 'LearnWorlds', facts: { workMode: 'REMOTE' } };
    handle.refreshJob();
    expect(job.dataset.size).toBe('full');
    expect(text(job, '.job-co')).toBe('LearnWorlds');
  });
});
