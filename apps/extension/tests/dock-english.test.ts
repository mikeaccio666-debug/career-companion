// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CandidateProfileSnapshotV2, PatchCandidateProfileV2 } from '@edaix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockHandlers } from '../lib/autofillDock';
import { dockProgressFromAudit } from '../lib/autofillDockProgress';
import { browserDockLocale, COPY, dockCopy, dockLocaleOf, dockRegionName } from '../lib/dock/copy';
import { jobChips, postedAgo, salaryText } from '../lib/dock/jobFacts';
import { draftFromSnapshot, patchFromDraft, validate } from '../lib/dock/profileModel';
import { toDockRow } from '../lib/dock/rows';
import type { AutofillAffordance } from '../product-panel/affordance';
import { dockRunSummary } from '../product-panel/runProgress';

/**
 * 浮层的英文界面（2026-09-25）：浏览器的界面语言是中文就说中文，其余一律说英文；英文的措辞照商店宣传图里的英文浮层。
 *
 * 钉住四件事：怎么挑语言（只看界面语言，测试里注入）；两套文案一样齐（按码查的表也逐键比）；英文界面的几幕——
 * 首页、填写中、填完、我的资料——说的是宣传图上那几句；英文界面上一个中日韩文字都不画出来（文字、读屏名字、提示、
 * 占位符）。中文仍是缺省：不传语言的调用方（测试、浮层预览工具）照旧说中文。
 *
 * 夹具全是合成的英文资料（没有真人的数据）。
 */

/** 中日韩文字与全角标点（「」、。，：（）……）。英文界面上的 · … – — ’ “ ” é 都不在里面。 */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u;
const EN = dockCopy('en');
const ZH = dockCopy('zh');

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); }); };

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Handle = ReturnType<typeof mountAutofillDock>;
const BASE: AutofillDockHandlers = { onAutofill: () => {}, onOpenEntry: () => {} };

function mount(affordance: AutofillAffordance, extra: Partial<AutofillDockHandlers> = {}, doc: Document = document.implementation.createHTMLDocument()): Handle {
  const handle = mountAutofillDock(affordance, { ...BASE, locale: 'en', ...extra }, doc);
  handle.openPanel();
  return handle;
}
const shadowOf = (handle: Handle): ShadowRoot => handle.sceneRoot()!.getRootNode() as ShadowRoot;
const text = (node: Element | null | undefined): string => node?.textContent ?? '';

/**
 * 影子根里画出来的每一个字：文字节点、读屏名字、提示与占位符。样式表不是画出来的字（里面的注释是中文），不算。
 */
function rendered(root: Node, out: string[] = []): string[] {
  if (root.nodeType === 3) {
    if ((root.textContent ?? '').trim() !== '') out.push(root.textContent ?? '');
    return out;
  }
  if (root.nodeType === 1) {
    const element = root as Element;
    if (element.tagName === 'STYLE') return out;
    for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = element.getAttribute(name);
      if (value !== null && value.trim() !== '') out.push(value);
    }
  }
  for (const child of Array.from(root.childNodes)) rendered(child, out);
  return out;
}
const cjkIn = (root: Node): string[] => rendered(root).filter((line) => CJK.test(line));

const row = (label: string, required: boolean, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required, done: state === 'CONFIRMED' || state === 'PRESERVED', state, ...extra,
});
function settle(handle: Handle, rows: readonly AutofillDockFieldRow[]): Handle {
  handle.beginPreparing();
  handle.beginRun({
    runId: 'fill-1',
    requiredQuestions: rows.filter((item) => item.required).length,
    requiredCompleted: rows.filter((item) => item.required && item.done).length,
    rows,
    phase: 'SETTLED',
  } as never);
  return handle;
}

const SETTLED_ROWS: readonly AutofillDockFieldRow[] = [
  row('First Name', true, 'CONFIRMED', { value: 'Alex' }),
  row('Email', true, 'CONFIRMED', { value: 'alex@example.com' }),
  row('School', true, 'FAILED', { reason: 'NO_OPTION_MATCH', hint: 'Example University' }),
  row('Why do you want to work here?', true, 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
  row('Start date', true, 'UNVERIFIED', { value: '2026-10-01', reason: 'HOST_UNCONFIRMED' }),
  row('I agree to the privacy notice', true, 'CONFIRMED', { signedOnBehalf: 'TERMS_CONSENT' }),
  row('Website', false, 'PRESERVED', { reason: 'NOT_EMPTY' }),
];

describe('挑语言：只看浏览器的界面语言', () => {
  it('中文（任何地区、任何写法）就说中文，其余一律说英文', () => {
    for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh_Hant', 'ZH-cn', ' zh-Hans-SG ']) expect(dockLocaleOf(language), language).toBe('zh');
    for (const language of ['en', 'en-US', 'en-GB', 'fr-CA', 'ja', 'ko-KR', 'zu', 'zha', '', null, undefined]) expect(dockLocaleOf(language), String(language)).toBe('en');
  });

  it('先问浏览器的显示语言（chrome.i18n.getUILanguage），问不到才看 navigator.language', () => {
    const ui = (language: unknown) => ({ i18n: { getUILanguage: () => language } });
    expect(browserDockLocale({ chrome: ui('zh-CN'), navigator: { language: 'en-US' } })).toBe('zh');
    expect(browserDockLocale({ chrome: ui('en-GB'), navigator: { language: 'zh-CN' } })).toBe('en');
    expect(browserDockLocale({ navigator: { language: 'zh-TW' } }), '内容脚本之外没有 chrome').toBe('zh');
    expect(browserDockLocale({ chrome: ui(''), navigator: { language: 'zh' } }), '问到空串').toBe('zh');
    const invalidated = { i18n: { getUILanguage: () => { throw new Error('Extension context invalidated.'); } } };
    expect(browserDockLocale({ chrome: invalidated, navigator: { language: 'zh-CN' } }), '插件刚被重载').toBe('zh');
    expect(browserDockLocale({}), '什么都读不到').toBe('en');
  });

  it('不传语言就说中文：旧调用方、测试与浮层预览工具照旧', () => {
    const handle = mountAutofillDock({ kind: 'READY' }, BASE, document.implementation.createHTMLDocument());
    handle.openPanel();
    expect(text(handle.autofillButton())).toBe('自动填写');
    expect(dockCopy()).toBe(COPY);
    expect(dockCopy('zh')).toBe(COPY);
  });
});

describe('两套文案一样齐', () => {
  /** 每一个键的路径与它是哪一种值（字符串 / 函数 / 一组）。 */
  const shape = (value: unknown, path = ''): string[] => {
    if (typeof value === 'function') return [`${path}:function`];
    if (value !== null && typeof value === 'object') return Object.keys(value).sort().flatMap((key) => shape((value as Record<string, unknown>)[key], `${path}.${key}`));
    return [`${path}:${typeof value}`];
  };

  it('形状一样：每一个键两边都有，字符串对字符串、函数对函数（按码查的几张表也逐键比）', () => {
    expect(shape(EN)).toEqual(shape(ZH));
    for (const table of ['reasons', 'outcomes', 'diagnosticsHints', 'resumeVersion', 'signed', 'historyBasis'] as const) {
      expect(Object.keys(EN[table]).sort(), table).toEqual(Object.keys(ZH[table]).sort());
    }
  });

  it('两套都冻着', () => {
    expect(Object.isFrozen(EN) && Object.isFrozen(EN.reasons) && Object.isFrozen(EN.profile.fields)).toBe(true);
    expect(Object.isFrozen(ZH) && Object.isFrozen(ZH.ai.card)).toBe(true);
  });

  it('英文那一套一个中日韩文字都没有：每一句，以及每一个函数在几组参数下的输出', () => {
    const tries: readonly (readonly unknown[])[] = [
      [0, 0, false, false], [1, 1, true, true], [3, 12, true, true],
      ['Greenhouse', 'Save and Continue'], [null, 'Save'], ['', ''],
      ['experience', 2, 3], ['education', 1, 1],
      [['Start Date', 'End Date'], 'Update'], [[], ''],
      [[{ values: ['Rust', 'Go'], why: 'No option matches your profile' }, { values: ['Kotlin'], why: 'Ran out of search time on this page' }]],
      [2, ['Canada', 'Estonia', 'Poland'], true, true], [1, ['Estonia'], true, false],
      ['USD', 'YEAR'], ['EUR', 'HOUR'], [9, 30],
    ];
    const outputs: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') { outputs.push(`${path} = ${value}`); return; }
      if (typeof value === 'function') {
        for (const args of tries) {
          try {
            const result = (value as (...args: readonly unknown[]) => unknown)(...args);
            if (typeof result === 'string') outputs.push(`${path}(${JSON.stringify(args)}) = ${result}`);
          } catch {
            // 这一组参数不是它要的形状：换下一组。
          }
        }
        return;
      }
      if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    };
    walk(EN, 'en');
    expect(outputs.length).toBeGreaterThan(400);
    expect(outputs.filter((line) => CJK.test(line))).toEqual([]);
  });

  it('源码里英文那一块也没有（上面那几组参数走不到的分支也算）', () => {
    const source = readFileSync(resolve(__dirname, '..', 'lib', 'dock', 'copy.ts'), 'utf8');
    const block = source.slice(source.indexOf('const en: typeof zh = {'), source.indexOf('/** 整棵冻结'));
    expect(block.length).toBeGreaterThan(10_000);
    const code = block.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
    expect(code.split('\n').filter((line) => CJK.test(line))).toEqual([]);
  });

  it('措辞与商店宣传图里的英文浮层一致', () => {
    // 2026-09-28：「需要你」按要做的事分组之后，面上不再有一个叫「Needs you」的组名（宣传图要跟着换）；总结、收起按钮上照旧说「need you」。
    expect([EN.autofill, EN.summary.needs(3, false), EN.bar.next, EN.bar.submit, EN.lists.yourData, EN.profileTitle]).toEqual(
      ['Autofill', '3 fields still need you', 'Continue to next page', 'Submit', 'Your profile', 'My profile']);
    expect([EN.entries.AUTOFILL_INFORMATION.title, EN.entries.RESUME.title, EN.entries.COVER_LETTER.title, EN.entries.COVER_LETTER.sub]).toEqual(
      ['My profile', 'My résumé', 'Cover letter', 'Written for this job and attached when you autofill']);
    expect([EN.summary.allDone.title, EN.lists.signed, EN.summary.pageDone.title, EN.summary.pageDone.sub]).toEqual(
      ['All required fields are filled', 'Filled on your behalf', 'This page is filled', 'Continue and it keeps filling the next page.']);
    expect([EN.run.filling, EN.run.stop, EN.lists.rest, EN.signed.TERMS_CONSENT]).toEqual(['Filling', 'Stop', 'Also filled', 'Agreed to the terms for you']);
    expect([EN.reasons.USER_ONLY, EN.reasons.NO_OPTION_MATCH, EN.reasons.MANUAL_ONLY]).toEqual(
      ['Open question, answer in your own words', 'No option matches your profile', 'Only you can answer this one']);
    expect(EN.bar.presses('Save and Continue')).toBe('Presses the site’s “Save and Continue” for you');
    expect([EN.tally.filled(12), EN.tally.ai(2), EN.tally.needs(3), EN.tally.kept(1)]).toEqual(['12 filled', '2 by AI', '3 need you', '1 left to you']);
    expect(EN.resumeDefault('Alex_Chen_Resume.pdf')).toBe('Alex_Chen_Resume.pdf · Default');
  });
});

describe('英文界面的几幕', () => {
  const daysAgo = (days: number): string => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const HOME: Partial<AutofillDockHandlers> = {
    vendorLabel: 'Greenhouse',
    account: () => ({ name: 'Alex Chen', email: 'alex@example.com' }),
    entrySummary: (target) => (target === 'RESUME' ? EN.resumeDefault('Alex_Chen_Resume.pdf') : null),
    jobCard: () => ({
      title: 'Senior Product Designer',
      company: 'Example Co',
      facts: {
        location: 'New York, NY',
        workMode: 'HYBRID',
        employment: 'FULL_TIME',
        salary: { min: 140_000, max: 175_000, currency: 'USD', unit: 'YEAR' },
        postedAt: daysAgo(3),
        description: 'Design the tools our customers use every day.',
        detailUrl: 'https://example.com/jobs/1',
      },
    }),
    onOpenPortal: () => {},
    onSignOut: () => {},
  };

  it('首页：岗位卡、「Autofill」、你的资料那三行、收起按钮与菜单', () => {
    const handle = mount({ kind: 'READY' }, HOME);
    const root = handle.sceneRoot()!;
    expect(text(handle.autofillButton())).toBe('Autofill');
    expect(text(root.querySelector('.job-title-lg'))).toBe('Senior Product Designer');
    expect(text(root.querySelector('.job-meta'))).toBe('Greenhouse · 3 days ago');
    expect(Array.from(root.querySelectorAll('.job-chip')).map(text)).toEqual(['New York, NY', 'Hybrid', 'Full-time']);
    expect(text(root.querySelector('.job-pay'))).toBe('$140k – $175kUSD / year');
    expect(text(root.querySelector('.job-link'))).toBe('View full job details');
    expect(text(root.querySelector('.grp-head[data-home-item]'))).toBe('Your profile');
    expect(handle.entryButtons().map((button) => [text(button.querySelector('.dtitle')), text(button.querySelector('.dsub'))])).toEqual([
      ['My profile', 'Name, contact details and address'],
      ['My résumé', 'Alex_Chen_Resume.pdf · Default'],
      ['Cover letter', 'Written for this job and attached when you autofill'],
    ]);
    expect(handle.launcherButton()?.getAttribute('aria-label')).toBe('Open ArgoLand.AI');
    const shadow = shadowOf(handle);
    expect(Array.from(shadow.querySelectorAll('.pop-item')).map(text)).toEqual(['Open ArgoLand', 'Sign out', 'Fill this page again', 'Edit my profile', 'Back to home']);
    expect(shadow.querySelector('[data-act="menu-more"]')?.getAttribute('aria-label')).toBe('More');
    expect(shadow.querySelector('.collapse')?.getAttribute('aria-label')).toBe('Collapse');
  });

  it('首页的其余几张脸', () => {
    const face = (affordance: AutofillAffordance, extra: Partial<AutofillDockHandlers> = {}) => {
      const root = mount(affordance, extra).sceneRoot();
      return [text(root?.querySelector('.face-title')), text(root?.querySelector('.face-sub'))];
    };
    expect(face({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }, { onOpenPortal: () => {} })).toEqual(
      ['Connect ArgoLand and fill applications in one click', 'We fill in the details you saved in ArgoLand, and you can review everything before you submit.']);
    expect(face({ kind: 'DORMANT' })).toEqual(['This is a job details page', 'Open the application form and we can fill it in.']);
    expect(face({ kind: 'GUIDANCE', guidance: 'NO_FORM_FOUND' })).toEqual(['No application form on this page yet', 'Once the form appears, we can fill it in.']);
    expect(face({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }, { vendorLabel: 'Workday' })[0]).toBe('Sign in to Workday first');
    expect(face({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' })[0], '不知道是哪一家').toBe('Sign in on this site first');
    const rules = mount({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' }, { onRecheck: () => {} }).sceneRoot();
    expect(text(rules?.querySelector('.face-title'))).toBe('Can’t tell yet whether this page can be autofilled');
    expect(text(rules?.querySelector('[data-action="recheck"]'))).toBe('Check again');
    const unlinked = mount({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }, { onOpenPortal: () => {} }).sceneRoot();
    expect(text(unlinked?.querySelector('[data-action="login"]'))).toBe('Sign in to ArgoLand');
    // 读不出岗位名：不说「Application application」。
    const bare = mount({ kind: 'READY' }).sceneRoot();
    expect(text(bare?.querySelector('.job-title'))).toBe('Job application');
    expect(text(mount({ kind: 'READY' }, { vendorLabel: 'Lever' }).sceneRoot()?.querySelector('.job-title'))).toBe('Lever application');
  });

  it('填写中：此刻在做什么、逐栏进度、实时的数与「Stop」；AI 在起草时进度卡照实写', () => {
    // 进度卡上当前那一项每一项至少停 350ms（真实的页一栏只要几十毫秒）：用假时钟走过去。
    vi.useFakeTimers();
    const handle = mount({ kind: 'READY' }, { onStop: () => {}, vendorLabel: 'Greenhouse', jobCard: () => ({ title: 'Designer', company: 'Example Co' }) });
    const root = handle.sceneRoot()!;
    handle.beginPreparing();
    expect(text(root.querySelector('.act-status'))).toBe('Reading the form');
    expect(text(root.querySelector('.ticker-q'))).toBe('Designer');
    expect(text(root.querySelector('.ticker-v'))).toBe('Example Co · Greenhouse');
    expect(handle.summaryText()).toBe('Preparing…');
    handle.setStep('PLANNING');
    expect(text(root.querySelector('.act-status'))).toBe('Matching your profile');
    handle.update({
      runId: 'fill-1', requiredQuestions: 3, requiredCompleted: 1,
      rows: [row('First Name', true, 'CONFIRMED', { value: 'Alex' }), row('Email', true, 'WRITING'), row('Phone', true, 'PENDING')],
    });
    vi.advanceTimersByTime(400);
    expect(text(root.querySelector('.act-status'))).toBe('Filling2 / 3');
    expect(text(root.querySelector('.ticker-q'))).toBe('Email');
    expect(text(root.querySelector('.ticker-v')), '上面那一行已经说了在填').toBe('');
    expect(Array.from(root.querySelectorAll('.tally-item')).map((node) => text(node))).toEqual(['1 filled', '0 by AI', '0 need you', '0 left to you']);
    expect(text(root.querySelector('[data-action="stop"]'))).toBe('Stop');
    expect(handle.summaryText()).toBe('Required 1/3');
    handle.setAiAnswers({ kind: 'DRAFTING', count: 5, targets: [] });
    handle.setStep('AI_DRAFTING');
    expect(text(root.querySelector('.act-status'))).toBe('Waiting for AI');
    expect(text(root.querySelector('.ticker-q'))).toBe('AI is filling 5 questions from your profile…');
    expect(handle.summaryText()).toBe('AI is filling 5 questions from your profile…');
  });

  it('填完：总结、按要做的事分组的「需要你」、代填、「Also filled」、底栏', () => {
    const handle = settle(mount({ kind: 'READY' }), SETTLED_ROWS);
    const root = handle.sceneRoot()!;
    expect(text(root.querySelector('.sum-title'))).toBe('3 fields still need you');
    expect(text(root.querySelector('.sum-sub'))).toBe('4 filled');
    const groups = Array.from(root.querySelectorAll<HTMLElement>('[data-need-group][data-open="true"] .grp-head')).map((node) => text(node));
    expect(groups).toEqual(['Pick one1', 'Write a few lines1', 'Check on the page1']);
    const reasons = Object.fromEntries(Array.from(root.querySelectorAll('[data-need-row]')).map((node) => [text(node.querySelector('.need-q')), text(node.querySelector('.need-why'))]));
    expect(reasons).toEqual({
      School: 'No option says “Example University”. Pick the closest one',
      'Why do you want to work here?': 'An open question. A few lines in your own words',
      'Start date': 'Filled, but the site didn’t confirm it. Take a look',
    });
    expect(root.querySelector('[data-need-row] .need-head')?.getAttribute('aria-label')).toBe('School, find this question on the page');
    expect(text(root.querySelector('[data-need-row] [data-action="need-go"]'))).toBe('Pick on the page');
    const signed = root.querySelector('[data-signed]')?.closest('.grp');
    expect(text(signed?.querySelector('.grp-head'))).toBe('Filled on your behalf1');
    expect(text(signed?.querySelector('.nsign'))).toBe('Agreed to the terms for you');
    expect(text(signed?.querySelector('.foot-note'))).toBe('Based on what you allowed and answered in your profile. Please review before you submit.');
    expect(text(root.querySelector('.rest-toggle'))).toBe('Also filled3');
    const rest = Object.fromEntries(Array.from(root.querySelectorAll('.rrow')).map((node) => [text(node.querySelector('.rq')), text(node.querySelector('.rv'))]));
    expect(rest).toEqual({ 'First Name': 'Alex', Email: 'alex@example.com', Website: 'Already on the page, left as is' });
    expect(text(root.querySelector('.rrow .ropt'))).toBe('Optional');
    expect(text(handle.primaryButton())).toBe('Go to first item');
  });

  it('都填好了、AI 代答了几项：总结两句接成一句；能替你按提交时写「Submit」', () => {
    const handle = settle(mount({ kind: 'READY' }, { submission: { available: () => true, send: async () => 'SUBMITTED' } }), [
      row('First Name', true, 'CONFIRMED', { value: 'Alex' }),
      row('Why us?', true, 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true }),
    ]);
    const root = handle.sceneRoot()!;
    expect(text(root.querySelector('.sum-title'))).toBe('All required fields are filled');
    expect(text(root.querySelector('.sum-sub'))).toBe('2 filled (1 by AI). Look it over, then submit when it all looks right.');
    expect(text(root.querySelector('[data-ai="group"] .grp-head'))).toBe('AI answers1');
    expect(text(handle.primaryButton())).toBe('Submit');
    const offSite = settle(mount({ kind: 'READY' }), [row('First Name', true, 'CONFIRMED', { value: 'Alex' })]);
    expect(text(offSite.primaryButton()), '替不了就照实写').toBe('Submit on the site');
  });

  it('多页：会替你按网站上的哪一颗、「Continue to next page」；这一页填好了', () => {
    const nextStep = { label: () => 'Save and Continue', advance: async () => 'NOT_ADVANCED' as const };
    const needs = settle(mount({ kind: 'READY' }, { nextStep }), SETTLED_ROWS);
    const shadow = shadowOf(needs);
    expect(text(shadow.querySelector('.bar-caption'))).toBe('Presses the site’s “Save and Continue” for you');
    // 与「Go to first item」挤在一行：英文一行放不下全称，这一颗写短的。
    expect(text(needs.nextStepButton())).toBe('Next page');
    expect(text(needs.primaryButton())).toBe('Go to first item');
    expect(text(needs.sceneRoot()?.querySelector('.sum-title'))).toBe('3 fields on this page still need you');
    const done = settle(mount({ kind: 'READY' }, { nextStep }), [row('First Name', true, 'CONFIRMED', { value: 'Alex' })]);
    expect(text(done.sceneRoot()?.querySelector('.sum-title'))).toBe('This page is filled');
    expect(text(done.sceneRoot()?.querySelector('.sum-sub'))).toBe('Continue and it keeps filling the next page.');
    expect(text(done.nextStepButton()), '独占一行时写全称').toBe('Continue to next page');
  });

  it('按了没翻页：横幅照实说', async () => {
    const nextStep = { label: () => 'Next', advance: async () => 'NOT_ADVANCED' as const };
    const handle = settle(mount({ kind: 'READY' }, { nextStep }), SETTLED_ROWS);
    click(handle.nextStepButton());
    await flush();
    const banner = shadowOf(handle).querySelector('.banner');
    expect(text(banner?.querySelector('.banner-title'))).toBe('The site didn’t go to the next page');
    expect(text(banner?.querySelector('.banner-text'))).toBe('3 required fields on this page are still empty. Check the red messages on the site, fix them, then continue.');
  });

  it('没能开始：失败卡说人话，码收在「Technical details」里', () => {
    const network = mount({ kind: 'READY' });
    network.reportBlocked('AUTHORITY_UNAVAILABLE');
    const root = network.sceneRoot()!;
    expect([text(root.querySelector('.face-title')), text(root.querySelector('.face-sub'))]).toEqual(
      ['Can’t reach ArgoLand right now', 'Filling couldn’t start. Try again in a moment.']);
    expect(text(root.querySelector('[data-action="retry"]'))).toBe('Try again');
    expect(text(root.querySelector('[data-action="toggle-tech"]'))).toBe('Technical details');
    expect(text(root.querySelector('.tech-copy'))).toBe('Copy');
    const known = mount({ kind: 'READY' });
    known.reportBlocked('APPLY_FORM_NOT_OPENED', { kind: 'OPEN_APPLICATION_FORM', onClick: () => {} } as never);
    // 2026-10-04：原因是一件他要先做的事——标题照实说那一件事，不说「这一轮没有完成」。
    expect(text(known.sceneRoot()?.querySelector('.face-title'))).toBe('The application form isn’t open yet');
    expect(text(known.sceneRoot()?.querySelector('.face-sub'))).toBe(EN.blockedFaces.APPLY_FORM_NOT_OPENED!.sub);
    expect(text(known.sceneRoot()?.querySelector('[data-action="open-form"]'))).toBe('Open application form');
  });

  it('按岗位地点推断的国名、按默认答的工作授权：国名与句子都是英文', () => {
    const view = {
      requiredHandled: 1, requiredTotal: 1,
      rows: [{ label: 'Are you legally authorized to work in this country?', required: true, status: 'FILLED', key: 'workAuthorization',
        reason: null, attemptedValue: 'Yes', resolvedOptionText: 'Yes', defaultedRegionCode: 'EE' }],
    };
    const progress = dockProgressFromAudit('fill-1', view as never, 'en');
    expect(progress.rows[0]?.defaultedWorkAuth).toEqual({ region: 'Estonia', sponsorship: false });
    expect(dockProgressFromAudit('fill-1', view as never).rows[0]?.defaultedWorkAuth?.region, '不传还是中文').toBe('爱沙尼亚');
    expect(dockRegionName('US', 'en')).toBe('United States');
    const handle = mount({ kind: 'READY' });
    handle.beginPreparing();
    handle.beginRun(progress);
    const root = handle.sceneRoot()!;
    // 2026-09-28：在「Check before you submit」里一行写值、一行写依据。
    expect(text(root.querySelector('[data-review="group"] .grp-head'))).toBe('Check before you submit1');
    expect(text(root.querySelector('[data-review-row] .nsign'))).toBe('Yes');
    expect(text(root.querySelector('[data-review-row] .nr'))).toBe('No work authorization for Estonia in your profile; answered “Yes” by default. Please review before you submit');
  });
});

describe('英文的「我的资料」', () => {
  /** 合成资料：全是英文，带一门语言、办公方式与通知期（语言标签与学位要按英文写）。 */
  function snapshot(): CandidateProfileSnapshotV2 {
    const base = JSON.parse(JSON.stringify(fictionalProfileSnapshot('Example Person'))) as {
      profile: Record<string, unknown> & { experiences: { description: string }[]; availability: Record<string, unknown> };
    };
    base.profile.summary = 'Fictional summary';
    base.profile.experiences[0]!.description = 'Fictional experience';
    base.profile.identity = { firstName: 'Example', middleName: null, lastName: 'Person', fullName: 'Example Person', preferredName: null };
    base.profile.contact = { email: 'person@example.com', phone: { countryCode: '+1', e164: '+14155550100', display: '415 555 0100', type: null } };
    base.profile.languages = [
      { id: '80000000-0000-4000-8000-000000000001', language: 'Japanese', proficiency: 'BASIC', factAuthorityByField: {} },
      { id: '80000000-0000-4000-8000-000000000002', language: 'Spanish', proficiency: 'CONVERSATIONAL', factAuthorityByField: {} },
    ];
    base.profile.preferences = { workModes: ['REMOTE', 'HYBRID'], openToRelocation: false, openToRelocationCities: null, contactCurrentEmployer: null };
    base.profile.availability = { earliestStartDate: null, noticePeriodDays: 14 };
    return base as unknown as CandidateProfileSnapshotV2;
  }

  function open(extra: Partial<AutofillDockHandlers> = {}) {
    const saved: PatchCandidateProfileV2[] = [];
    const value = snapshot();
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value })),
      saveProfileV2: vi.fn(async (patch: PatchCandidateProfileV2) => { saved.push(patch); return { ok: true as const, value }; }),
    };
    const profilePorts = {
      eeo: {
        load: async () => ({ ok: true as const, value: { revision: '1', answers: { genderIdentity: '', hispanicLatino: '', raceEthnicity: [], veteranStatus: '', disabilityStatus: '', reuseEnabled: false } } }),
        save: async () => ({ ok: false as const, code: 'UNAVAILABLE' }),
      },
      signing: { load: async () => ({ ok: true as const, value: false }), set: async (granted: boolean) => ({ ok: true as const, value: granted }) },
      resumes: {
        load: async () => ({ ok: true as const, value: { items: [{ id: 'r1', name: 'Alex_Chen_Resume.pdf', meta: `Main${EN.profile.resumeUpdated(9, 21)}` }], defaultId: 'r1' } }),
        setDefault: async (id: string) => ({ ok: true as const, value: id }),
      },
    };
    const handle = mount({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { directory, profilePorts, ...extra });
    click(handle.entryButtons()[0]);
    return { handle, directory, saved };
  }

  it('分组、卡片、每一栏的标签与选项都是英文；存进草稿的值不变', async () => {
    const { handle } = open();
    await flush();
    const root = handle.profileRoot()!;
    expect(handle.scene()).toBe('PROFILE');
    expect(text(shadowOf(handle).querySelector('.head-title'))).toBe('My profile');
    expect(Array.from(root.querySelectorAll('.pf-group')).map(text)).toEqual(['Personal', 'Job search', 'Background', 'Application settings']);
    expect(Array.from(root.querySelectorAll('.pf-sec-title')).map(text)).toEqual([
      'Basic info', 'Address', 'Links', 'Work authorization', 'Job preferences', 'Common questions',
      'Work experience', 'Education', 'Skills & languages', 'Default résumé', 'Filling on your behalf', 'Self-identification',
    ]);
    expect(text(root.querySelector('.pf-status'))).toBe('All changes saved');
    expect(text(root.querySelector('[data-pf-field="first"] .pf-label'))).toBe('First name');
    expect(Array.from(root.querySelectorAll('[data-pf-field="modes"] .pf-chip')).map(text)).toEqual(['Remote', 'Hybrid', 'On-site']);
    expect(root.querySelector('[data-pf-field="modes"] .pf-chip')?.getAttribute('aria-pressed'), '草稿里的「远程」照旧认得').toBe('true');
    expect(text(root.querySelector('[data-pf-field="notice"] .pf-step-v'))).toBe('14 days');
    expect(Array.from(root.querySelectorAll('[data-pf-field="langs"] .pf-tag')).map(text)).toEqual(['Japanese · Basic', 'Spanish · Conversational']);
    expect(Array.from(root.querySelectorAll('[data-pf-field="gender"] .pf-seg-btn')).map(text)).toEqual(['Woman', 'Man', 'Decline']);
    expect(text(root.querySelector('[data-pf-sec="edu"] .pf-entry-sub'))).toBe('Bachelor’s · Design · 2018.09 — 2022.05');
    expect(text(root.querySelector('[data-pf-sec="exp"] .pf-entry-sub'))).toBe('Example Company · 2022.06 — Present');
    expect(text(root.querySelector('.pf-resume-meta'))).toBe('Main · Updated Sep 21');
    expect(text(root.querySelector('.pf-default'))).toBe('Default');
    const consent = text(root.querySelector('[data-pf-sec="consent"]'));
    // 与门户资料页英文那一格逐字相同。
    // 负责人定稿的一句话（2026-09-28），每一类写在隐私政策里版本号相同的那一节；下面一行点开英文页的那一节。
    expect(consent).toContain(
      'Let ArgoLand handle the terms, declarations and authorizations on application forms in my name, and sign up or sign in to job sites for me. See the Privacy Policy.',
    );
    expect(consent).toContain('See what this covers in the Privacy Policy');
    expect(root.querySelector<HTMLElement>('[data-pf-sec="consent"] .pf-cap-link')?.dataset.portal).toBe('SIGNING_SCOPE');
  });

  it('改了一项：保存栏与离开前的确认框；名字空着就说哪一项', async () => {
    const { handle, directory } = open();
    await flush();
    const root = handle.profileRoot()!;
    const first = root.querySelector<HTMLInputElement>('input[data-pf="first"]')!;
    first.value = ' ';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    expect(text(root.querySelector('.pf-status'))).toBe('1 unsaved change');
    click(root.querySelector('[data-action="profile-save"]'));
    await flush();
    expect(directory.saveProfileV2).not.toHaveBeenCalled();
    expect(text(root.querySelector('[data-pf-field="first"] .pf-err'))).toBe('Enter your first name.');
    expect(text(shadowOf(handle).querySelector('.toast'))).toBe('1 field needs fixing');
    handle.backHome();
    expect(text(root.querySelector('.pf-confirm-title'))).toBe('You have 1 unsaved change');
    expect(text(root.querySelector('.pf-confirm-sub'))).toBe('Save before you leave?');
    expect([text(root.querySelector('.pf-confirm-discard')), text(root.querySelector('.pf-confirm-save'))]).toEqual(['Discard changes', 'Save']);
  });

  it('英文的语言标签原样读回：加一门语言再存，原来那几门的熟练程度不变', async () => {
    const { handle, saved } = open();
    await flush();
    const root = handle.profileRoot()!;
    const input = root.querySelector<HTMLInputElement>('[data-pf-field="langs"] .pf-tag-input')!;
    expect(input.placeholder).toBe('e.g. Japanese · Basic');
    input.value = 'French · Fluent';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    click(root.querySelector('[data-action="profile-save"]'));
    await flush();
    expect(saved[0]?.languages?.map((item) => [item.language, item.proficiency])).toEqual([
      ['Japanese', 'BASIC'], ['Spanish', 'CONVERSATIONAL'], ['French', 'PROFESSIONAL'],
    ]);
  });

  it('读不到资料：照实说，给一个去门户的链接', async () => {
    const directory = {
      profileV2: vi.fn(async () => ({ ok: false as const, code: 'LOGIN_REQUIRED' as const })),
      saveProfileV2: vi.fn(),
    };
    const handle = mount({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { directory: directory as never });
    click(handle.entryButtons()[0]);
    expect(text(handle.profileRoot()?.querySelector('.pf-message')).trim()).toBe('Loading your profile…');
    await flush();
    expect(text(handle.profileRoot()?.querySelector('.pf-message'))).toBe('Your sign-in expired. Sign in again, then reopen this page.Edit in ArgoLand');
  });
});

describe('英文界面上不画出一个中日韩文字', () => {
  /** 一栏在宿主页上（AI 小片要挂在它旁边）。 */
  function hostTextarea(doc: Document): HTMLTextAreaElement {
    const field = doc.createElement('textarea');
    doc.body.append(field);
    const box = { left: 40, top: 300, width: 400, height: 90, right: 440, bottom: 390, x: 40, y: 300, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(box);
    return field;
  }
  const every = (entries: Record<string, string>): AutofillDockFieldRow[] =>
    Object.keys(entries).map((code) => row(`Question for ${code}`, true, 'FAILED', { reason: code }));

  it('每一张脸、每一幕、每一个原因、每一个结局、菜单、资料页、AI 卡片与 Toast', async () => {
    const leaks: string[] = [];
    const sweep = (name: string, node: Node | null | undefined) => {
      if (node == null) throw new Error(`${name}: nothing rendered`);
      for (const line of cjkIn(node)) leaks.push(`${name}: ${line}`);
    };

    // 首页的每一张脸。
    const faces: readonly AutofillAffordance[] = [
      { kind: 'READY' }, { kind: 'DORMANT' },
      { kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }, { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' },
      { kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }, { kind: 'GUIDANCE', guidance: 'NO_FORM_FOUND' },
    ];
    for (const face of faces) {
      const handle = mount(face, { onOpenPortal: () => {}, onSignOut: () => {}, onRecheck: () => {}, aiAnswers: { load: async () => true, save: async (on) => on } });
      sweep(`face ${JSON.stringify(face)}`, shadowOf(handle));
    }

    // 填写中与 AI 在起草。
    const running = mount({ kind: 'READY' }, { onStop: () => {} });
    running.beginPreparing();
    sweep('preparing', shadowOf(running));
    running.update({ runId: 'fill-1', requiredQuestions: 2, requiredCompleted: 0, rows: [row('Email', true, 'WRITING'), row('Phone', true, 'WRITTEN', { value: '415' })] });
    sweep('filling', shadowOf(running));
    running.setAiAnswers({ kind: 'DRAFTING', count: 2, targets: [] });
    running.setStep('AI_DRAFTING');
    sweep('ai drafting', shadowOf(running));

    // 填完：每一个原因码、每一类代填、每一种依据、经历／教育的各种段、没加上的几项、按默认答与没有记录的国家。
    const signedKinds = Object.keys(EN.signed) as NonNullable<AutofillDockFieldRow['signedOnBehalf']>[];
    const bases = Object.keys(EN.historyBasis) as NonNullable<AutofillDockFieldRow['historyBasis']>[];
    const doc = document.implementation.createHTMLDocument();
    const settled = settle(mount({ kind: 'READY' }, {
      nextStep: { label: () => 'Save and Continue', advance: async () => 'NOT_ADVANCED' },
      recentDiagnostics: async () => Object.keys(EN.diagnosticsHints),
    }, doc), [
      ...every(EN.reasons),
      ...signedKinds.map((kind) => row(`Signed ${kind}`, true, 'CONFIRMED', { signedOnBehalf: kind })),
      ...bases.map((basis) => row(`Inferred ${basis}`, true, 'CONFIRMED', { value: 'Yes', historyBasis: basis })),
      row('Authorized?', true, 'CONFIRMED', { value: 'Yes', planned: true, defaultedWorkAuth: { region: 'Estonia', sponsorship: false } }),
      row('Sponsorship?', true, 'CONFIRMED', { value: 'No', planned: true, defaultedWorkAuth: { region: 'Poland', sponsorship: true } }),
      row('Authorized in Canada?', true, 'MANUAL', { needsUser: true, reason: 'JOB_DEPENDENT', regionWithoutRecord: 'Canada' }),
      row('Update', true, 'FAILED', { reason: 'CLICK_DENIED', unsavedEntry: { collection: 'experience', number: 2, saveLabel: 'Update', missing: ['Start Date'] } }),
      row('Save', true, 'FAILED', { reason: 'HOST_REJECTED', unsavedEntry: { collection: 'education', number: 1, saveLabel: '' } }),
      row('Update', true, 'CONFIRMED', { value: 'Example Co', savedEntry: { collection: 'experience', number: 1, saveLabel: 'Update' } }),
      row('Add Another', true, 'FAILED', { reason: 'CLICK_DENIED', unaddedEntries: { collection: 'education', from: 2, to: 3, afterUnsaved: false } }),
      row('Skills', false, 'CONFIRMED', { value: 'Figma\nRust\nGo', notAdded: [{ value: 'Rust', reason: 'NO_OPTION_MATCH' }, { value: 'Go', reason: 'ABORTED' }] }),
      row('Resume', true, 'CONFIRMED', { attachment: true }),
      row('Why us?', true, 'CONFIRMED', { value: 'Because.', aiAnswered: true }),
      row('Current company', true, 'PRESERVED', { reason: 'NOT_EMPTY', fromResume: true }),
      row('Consent', true, 'CONFIRMED', { checkbox: true }),
    ]);
    settled.setAiAnswers({ kind: 'USED_UP' });
    await flush();
    const settledRoot = shadowOf(settled);
    click(settledRoot.querySelector('.rest-toggle'));
    sweep('settled', settledRoot);
    click(settled.nextStepButton());
    await flush();
    sweep('not advanced', settledRoot);
    click(settled.primaryButton());
    sweep('guide', settledRoot);

    // AI 回来晚了：「Fill in AI answers」那一张小卡；网页上的小片与卡片（次数用完、会员链接）。
    const why = hostTextarea(document);
    const ai = mount({ kind: 'READY' }, {}, document);
    settle(ai, [row('Why do you want to work here?', true, 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why })]);
    ai.setAiAnswers({ kind: 'READY', count: 2, apply: async () => 0 } as never);
    const resetsAt = new Date('2026-10-01T12:00:00.000Z');
    ai.setAiTools({ targets: [why], generate: async () => ({ kind: 'USED_UP' }), quota: async () => ({ unlimited: false, remaining: 0, resetsAt: resetsAt.toISOString() }) });
    const aiShadow = shadowOf(ai);
    expect(aiShadow.querySelector('.aic')?.getAttribute('aria-label')).toBe('Write this answer with AI');
    expect(text(aiShadow.querySelector('.aic-verb'))).toBe('Write with AI');
    click(aiShadow.querySelector('button.aic'));
    await flush();
    const card = aiShadow.querySelector('.aip[role="dialog"]');
    expect(text(card?.querySelector('b'))).toBe('Write this answer with AI');
    expect(card?.querySelector('textarea')?.getAttribute('placeholder')).toBe('Tell AI what to add, change, or improve');
    // 恢复的那一天按用户本地的日历写（测试机在哪个时区都对）。
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][resetsAt.getMonth()];
    expect(text(card?.querySelector('.aip-used span'))).toBe(`You’ve used all your AI uses this month. They reset on ${month} ${resetsAt.getDate()}`);
    sweep('ai card', aiShadow);

    // 没能开始：每一个结局码。
    for (const code of Object.keys(EN.outcomes)) {
      const failed = mount({ kind: 'READY' });
      failed.reportBlocked(code, { kind: 'OPEN_APPLICATION_FORM', onClick: () => {} } as never);
      sweep(`failed ${code}`, shadowOf(failed));
    }

    // 资料页：读取中、读好了（每一张卡片）、读不到。
    const profile = mount({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
      directory: { profileV2: async () => ({ ok: true as const, value: fictionalSnapshotInEnglish() }), saveProfileV2: vi.fn() } as never,
      profilePorts: {
        eeo: { load: async () => ({ ok: true as const, value: { revision: '1', answers: { genderIdentity: 'Woman', hispanicLatino: 'No', raceEthnicity: ['Asian'], veteranStatus: '', disabilityStatus: '', reuseEnabled: true } } }), save: vi.fn() },
        signing: { load: async () => ({ ok: true as const, value: true }), set: vi.fn() },
        resumes: { load: async () => ({ ok: true as const, value: { items: [], defaultId: null } }), setDefault: vi.fn() },
      } as never,
    });
    click(profile.entryButtons()[0]);
    sweep('profile loading', profile.profileRoot());
    await flush();
    sweep('profile', profile.profileRoot());
    const unavailable = mount({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    click(unavailable.entryButtons()[0]);
    await flush();
    sweep('profile unavailable', unavailable.profileRoot());

    // Toast：隐藏收起按钮、撤销。
    const toasts = mount({ kind: 'READY' });
    toasts.closePanel();
    click(shadowOf(toasts).querySelector('.l-hide'));
    expect(text(shadowOf(toasts).querySelector('.toast'))).toBe('Hidden. Reload the page to bring it back.');
    sweep('toast', shadowOf(toasts));

    expect(leaks).toEqual([]);
  });

  it('中文界面照旧画中文（这道检查确实看得见中文）', () => {
    const handle = settle(mountAutofillDock({ kind: 'READY' }, BASE, document.implementation.createHTMLDocument()), SETTLED_ROWS);
    expect(cjkIn(shadowOf(handle)).length).toBeGreaterThan(5);
  });
});

describe('浮层以外、写给浮层的那几样也跟着语言走', () => {
  it('岗位卡的胶囊、薪资与发布时间', () => {
    expect(jobChips({ workMode: 'ONSITE', employment: 'CONTRACT' }, EN)).toEqual(['On-site', 'Contract']);
    expect(salaryText({ min: 45, max: 60.5, currency: 'USD', unit: 'HOUR' }, EN)).toEqual({ amount: '$45 – $60.50', unit: 'USD / hour' });
    const now = new Date(2026, 8, 24, 12);
    expect([postedAgo('2026-09-24', now, EN), postedAgo('2026-09-23', now, EN), postedAgo('2026-08-01', now, EN), postedAgo('2024-07-31', now, EN)]).toEqual(
      ['Today', '1 day ago', '1 month ago', '2 years ago']);
  });

  it('经历／教育的那几段、联调包那一行、保存前的检查', () => {
    const unsaved = toDockRow(row('Update', true, 'FAILED', { unsavedEntry: { collection: 'experience', number: 2, saveLabel: 'Update' } }), 0, EN);
    expect(unsaved.q).toBe('Work experience #2');
    expect(toDockRow(row('Add', true, 'FAILED', { unaddedEntries: { collection: 'education', from: 2, to: 3, afterUnsaved: true } }), 0, EN).q).toBe('Education #2–3');
    expect(dockRunSummary({ runId: 'r', rows: [], phase: 'SCANNING', observedControls: 23, requiredCompleted: 0, requiredQuestions: 0 }, EN)).toBe('Reading the form · 23 fields so far');
    expect(dockRunSummary({ runId: 'r', rows: [], phase: 'COMPOSING', observableQuestions: 11, authorizedQuestions: 8, requiredCompleted: 0, requiredQuestions: 0 }, EN)).toBe('We can answer 8 of 11 questions');
    expect(dockRunSummary({ runId: 'r', rows: [], phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 }, EN)).toBe('Required 5/6');
    expect(dockRunSummary({ runId: 'r', rows: [], phase: 'SETTLED', requiredCompleted: 0, requiredQuestions: 0 }, EN)).toBe('This form has no required fields for us to fill');
    const draft = draftFromSnapshot(fictionalSnapshotInEnglish(), EN.profile.proficiency);
    expect(validate({ ...draft, first: '', email: 'nope', linkedin: 'x' }, EN.profile.errors)).toEqual({
      first: 'Enter your first name.', email: 'That email doesn’t look right.', linkedin: 'That link looks incomplete, e.g. linkedin.com/in/your-name.',
    });
  });

  it('语言标签的熟练程度：中英两种写法都读得回来，中文界面的行为不变', () => {
    const snap = fictionalSnapshotInEnglish();
    const zhDraft = draftFromSnapshot(snap);
    const enDraft = draftFromSnapshot(snap, EN.profile.proficiency);
    expect(zhDraft.langs).toEqual(['Japanese · 基础']);
    expect(enDraft.langs).toEqual(['Japanese · Basic']);
    const levels = (draft: typeof enDraft, langs: readonly string[]) =>
      patchFromDraft({ ...draft, langs }, draft, snap)?.languages?.map((item) => item.proficiency);
    expect(levels(enDraft, [...enDraft.langs, 'French · native', 'German · Conversational', 'Korean'])).toEqual(['BASIC', 'NATIVE_OR_BILINGUAL', 'CONVERSATIONAL', 'PROFESSIONAL']);
    expect(levels(zhDraft, [...zhDraft.langs, 'French · 母语', 'Korean'])).toEqual(['BASIC', 'NATIVE_OR_BILINGUAL', 'PROFESSIONAL']);
  });
});

/** 只有英文内容的合成资料（一门「日语 · 基础」）。 */
function fictionalSnapshotInEnglish(): CandidateProfileSnapshotV2 {
  const base = JSON.parse(JSON.stringify(fictionalProfileSnapshot('Example Person'))) as {
    profile: Record<string, unknown> & { experiences: { description: string }[] };
  };
  base.profile.summary = 'Fictional summary';
  base.profile.experiences[0]!.description = 'Fictional experience';
  base.profile.identity = { firstName: 'Example', middleName: null, lastName: 'Person', fullName: 'Example Person', preferredName: null };
  base.profile.contact = { email: 'person@example.com', phone: { countryCode: '+1', e164: '+14155550100', display: '415 555 0100', type: null } };
  base.profile.languages = [{ id: '80000000-0000-4000-8000-000000000001', language: 'Japanese', proficiency: 'BASIC', factAuthorityByField: {} }];
  return base as unknown as CandidateProfileSnapshotV2;
}
