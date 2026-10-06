// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditRow, AuditView } from '@edaix/apply-kernel/audit';
import type { ApplyFieldDescriptor } from '@edaix/apply-kernel/contracts';
import { captureTrustedShadowGesture, type AdvanceRunScope, type TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { readPageGaps } from '@edaix/apply-kernel/pageGaps';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { createScanRoot } from '@edaix/apply-kernel/scanRoot';

import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockProgress } from '../lib/autofillDock';
import { createFillToReview, decideAfterPage, requiredNeedsIn, type ChainAfterPage, type ChainPageFacts } from '../lib/fillToReview';
import { PAGE_GAP_REASON, pageGapRows, withPageGaps } from '../lib/pageGaps';

/**
 * 不在必填还空着、网站还标着错的时候替他按「下一步」，也不说「这一页填好了」（2026-10-04，bench-1003 第七节第 2 条）。
 *
 * 那一天的样子（jobs.jobvite.com 的 uplight、ashcompanies 两页）：浮层认出的那几栏都填上了，四道自己画的是非题与简历
 * 按钮浮层一道都没认出，单子里「需要你」是 0；浮层说「这一页填好了」，连填替他按了「Next」，网站当场标红。
 * 夹具的结构照 2026-10-04 在那一页上只读抓到的样子，文字是公开的题目原文，没有任何人的资料。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const PAGE = `
  <div class="jv-form jv-apply-form">
    <h3 id="jv-resume-header">Add Resume<span>*</span></h3>
    <div id="attachResume"><div><button type="button" aria-haspopup="true" aria-labelledby="jv-resume-header" aria-required="true">Select</button></div>
      <ul class="jv-file-list"></ul></div>
    <form>
      <label for="first">First Name*</label><input id="first" type="text" required value="Sample">
      <fieldset><legend>Are you legally authorized to work in the United States?<span>*</span></legend>
        <label for="q1-0"><i role="radio"></i><input id="q1-0" name="q1" type="radio" value="Yes" required> Yes</label>
        <label for="q1-1"><i role="radio"></i><input id="q1-1" name="q1" type="radio" value="No" required> No</label></fieldset>
      <fieldset><legend>Acknowledgement<span>*</span></legend>
        <label for="q2-0"><i role="radio"></i><input id="q2-0" name="q2" type="radio" value="I Agree" required> I Agree</label>
        <label for="q2-1"><i role="radio"></i><input id="q2-1" name="q2" type="radio" value="I Do Not Agree" required> I Do Not Agree</label></fieldset>
      <button type="button" aria-label="Next">Next →</button>
    </form>
  </div>`;

/** 样式把原生单选藏起来了：看得见的是外面那个标签。 */
const visible = (element: Element): boolean => !(element instanceof HTMLInputElement && element.type === 'radio');

function mountPage() {
  document.body.innerHTML = PAGE;
  const root = createScanRoot(document.querySelector('div.jv-apply-form')!, []);
  const first = document.getElementById('first')!;
  const fields = [{ kind: 'text', element: first, key: 'firstName', label: 'First Name', required: true, confidence: 1, signature: {} } as unknown as ApplyFieldDescriptor];
  // 浮层的单子：认出的那一栏填上了，「需要你」是 0。
  const filledRow: AuditRow = {
    key: 'firstName', label: 'First Name', required: true, status: 'FILLED', reason: null, attemptedValue: 'Sample',
    resolvedOptionText: null, element: first, confidence: 1, order: 0,
  };
  const view: AuditView = { rows: [filledRow], filled: 1, requiredTotal: 1, requiredHandled: 1, needsAttention: 0, blockedByUs: 0, awaitingUser: 0 };
  return { gaps: () => readPageGaps({ form: { root, fields }, isVisible: visible }), view };
}

const SCOPE: AdvanceRunScope = Object.freeze({ origin: 'https://jobs.jobvite.com', pathname: '/acme/job/o1/apply', vendor: 'jobvite' });

function policy(): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, jobvite: true },
    capabilities: { ...base.capabilities, 'advance-step': true, 'advance-steps': true },
    notAfter: Date.now() + 60 * 60_000,
  };
}

function click(): TrustedGestureProof {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let proof: TrustedGestureProof | null = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
  if (proof === null) throw new Error('click not trusted');
  return proof;
}

const facts = (overrides: Partial<ChainPageFacts> = {}): ChainPageFacts => ({
  stopped: false,
  checkpoint: null,
  requiredNeeds: 0,
  finalSubmit: false,
  next: 'ONE',
  chainOn: true,
  run: { ok: true, value: { page: 1, maxPages: 10, remainingMs: 9 * 60_000 } },
  ...overrides,
});

describe('连填：页面上还有没认出的必填、网站还标着错，就不替他按「下一步」', () => {
  it('Jobvite：浮层单子里「需要你」是 0，页面上还空着四道没认出的必填（含简历）→ 停下（NEEDS_USER），一颗按钮都不按', async () => {
    const page = mountPage();
    expect(requiredNeedsIn(page.view)).toBe(0);
    expect(page.gaps().unplanned.map((gap) => gap.label)).toEqual([
      'Add Resume', 'Are you legally authorized to work in the United States?', 'Acknowledgement',
    ]);
    const advance = vi.fn(async () => 'ADVANCED' as const);
    const chain: unknown[] = [];
    const driver = createFillToReview({
      resolvePolicy: async () => policy(),
      advance,
      checkpoint: () => null,
      fillNextPage: () => {},
      dock: () => ({ setChain: (state) => { chain.push(state); }, autoAdvance: () => {} }),
    });
    const begun = driver.begin({ root: click(), scope: SCOPE, vendor: 'jobvite', policy: policy(), next: () => 'ONE', site: () => null });
    if (begun.kind !== 'CHAIN') throw new Error(begun.kind);
    // 与内容脚本同一个口径（apply.content.ts 的 continueChain）：单子里的必填，加上页面上还空着、浮层没认出的。
    const afterPage: ChainAfterPage = {
      written: 1,
      scope: () => SCOPE,
      stopped: () => false,
      current: () => true,
      requiredNeeds: () => requiredNeedsIn(page.view) + page.gaps().unplanned.length,
      siteErrors: () => { const gaps = page.gaps(); return gaps.invalid + gaps.alerts; },
      finalSubmit: () => false,
      next: () => 'ONE',
      label: () => 'Next',
    };
    expect(await driver.afterPage(begun.page, afterPage)).toBe(false);
    expect(advance).not.toHaveBeenCalled();
    expect(chain.at(-1)).toMatchObject({ stop: 'NEEDS_USER' });
  });

  it('他在网站上答完了那几题、附上了简历 → 页面上不再有空着的必填，接着往下翻', async () => {
    const page = mountPage();
    (document.getElementById('q1-0') as HTMLInputElement).checked = true;
    (document.getElementById('q2-0') as HTMLInputElement).checked = true;
    document.querySelector('.jv-file-list')!.innerHTML = '<li>Sample-Resume.pdf <button type="button">remove</button></li>';
    expect(page.gaps().unplanned).toEqual([]);
  });

  it('网站此刻标着错（aria-invalid、表里的报错提示）→ 停下（SITE_ERRORS），排在必填之后、到头了之前', () => {
    expect(decideAfterPage(facts({ siteErrors: 1 }))).toEqual({ kind: 'STOP', reason: 'SITE_ERRORS' });
    expect(decideAfterPage(facts({ siteErrors: 2, requiredNeeds: 1 }))).toEqual({ kind: 'STOP', reason: 'NEEDS_USER' });
    expect(decideAfterPage(facts({ siteErrors: 1, finalSubmit: true }))).toEqual({ kind: 'STOP', reason: 'SITE_ERRORS' });
    // 旧调用方不传：按 0 算，行为不变。
    expect(decideAfterPage(facts())).toEqual({ kind: 'ADVANCE' });
  });
});

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

function mountDock() {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    nextStep: { label: () => 'Next', advance: async () => 'ADVANCED' },
  }, document);
  handle.openPanel();
  return handle;
}

const filled = (label: string): AutofillDockFieldRow => ({ label, required: true, done: true, state: 'CONFIRMED', value: 'Sample' });
const settled = (rows: readonly AutofillDockFieldRow[]): AutofillDockProgress =>
  ({ runId: 'gesture-1', requiredQuestions: rows.length, requiredCompleted: rows.filter((row) => row.done).length, rows, phase: 'SETTLED' }) as never;

describe('浮层：页面上还空着的必填列进「需要你」，不说「这一页填好了」', () => {
  it('withPageGaps：一题一行，必填、轮到他、原因是「没认出这一题」，「去这一栏」指向那个控件；已经在单子里的控件不再加', () => {
    const page = mountPage();
    const gaps = page.gaps();
    const progress = withPageGaps(settled([filled('First Name')]), gaps);
    expect(progress.rows.map((row) => row.label)).toEqual([
      'First Name', 'Add Resume', 'Are you legally authorized to work in the United States?', 'Acknowledgement',
    ]);
    expect(progress.rows.slice(1).every((row) => row.required && row.state === 'MANUAL' && row.reason === PAGE_GAP_REASON)).toBe(true);
    expect(progress.rows[2]!.target).toBe(document.getElementById('q1-0'));
    expect(progress.requiredQuestions).toBe(4);
    const again = withPageGaps(progress, gaps);
    expect(again.rows).toHaveLength(4);
    // 一题都没有就原样交回。
    const none = settled([filled('First Name')]);
    expect(withPageGaps(none, { unplanned: [], invalid: 0, alerts: 0 })).toBe(none);
  });

  it('总结：「这一页还有 3 项需要你」（从前是「这一页填好了」），三行都在「需要你」里、写着没认出', () => {
    const page = mountPage();
    const handle = mountDock();
    handle.beginPreparing();
    const progress = withPageGaps(settled([filled('First Name')]), page.gaps());
    handle.beginRun(progress);
    handle.update(progress);
    const root = handle.sceneRoot();
    expect(text(root?.querySelector('.sum-title'))).toBe('这一页还有 3 项需要你');
    expect(text(root?.querySelector('.sum-title'))).not.toBe('这一页填好了');
    expect(handle.attentionCount()).toBe(3);
    expect(text(root)).toContain('这一题还空着，请在网页上填');
  });

  /**
   * 2026-10-04 测试台（Ashby sierra）：「Preferred First & Last Name」网站标了必填（CSS 画的星号，扫描没读到），单子里当选填列着、
   * 还空着，浮层说「必填项都填好了」。那一行改成必填，照它自己的原因进「需要你」，不另加一行。
   */
  it('单子里当选填列着、网站却标了必填的那一栏：那一行改成必填（不另加一行）', () => {
    document.body.innerHTML = '<input id="pref">';
    const target = document.getElementById('pref')!;
    const optionalRow: AutofillDockFieldRow = { label: 'Preferred First & Last Name', required: false, done: false, state: 'MANUAL', reason: 'LOW_CONFIDENCE', target };
    const progress = withPageGaps(settled([filled('First Name'), optionalRow]), { unplanned: [{ element: target, label: 'Preferred First & Last Name' }], invalid: 0, alerts: 0 });
    expect(progress.rows).toHaveLength(2);
    expect(progress.rows[1]).toMatchObject({ label: 'Preferred First & Last Name', required: true, reason: 'LOW_CONFIDENCE' });
    expect(progress.requiredQuestions).toBe(3);
  });

  it('读不出题目的那一道：标题用通用的说法（「一道必填题（没读出题目）」），「去这一栏」照样指向它', () => {
    document.body.innerHTML = '<div id="sel" role="combobox" aria-required="true">Select</div>';
    const element = document.getElementById('sel')!;
    const progress = withPageGaps(settled([filled('First Name')]), [{ element, label: '' }], '一道必填题（没读出题目）');
    expect(progress.rows[1]).toMatchObject({ label: '一道必填题（没读出题目）', required: true, target: element });
  });

  it('pageGapRows：勾选框那一题标成勾选框（填好了写「已勾选」，不把那句同意原文再念一遍）', () => {
    document.body.innerHTML = '<input id="c" type="checkbox">';
    const [row] = pageGapRows([{ element: document.getElementById('c')!, label: 'I agree to the terms' }]);
    expect(row).toMatchObject({ label: 'I agree to the terms', checkbox: true, required: true });
  });

  it('连填停在「网站在这一页上标出了问题」：总结照实说，不说「这一页填好了」', () => {
    const handle = mountDock();
    handle.beginPreparing();
    handle.setChain({ page: 1, maxPages: 10, site: null, donePages: 0, doneFields: 0, stop: null });
    handle.beginRun(settled([filled('First Name')]));
    handle.update(settled([filled('First Name')]));
    handle.setChain({ page: 1, maxPages: 10, site: null, donePages: 0, doneFields: 0, stop: 'SITE_ERRORS' });
    handle.finishRun({ started: true, outcome: 'FILLED' });
    const root = handle.sceneRoot();
    expect(text(root?.querySelector('.sum-title'))).toBe('网站在这一页上标出了问题');
    expect(text(root?.querySelector('.sum-sub'))).toContain('红色提示');
  });
});

describe('不进单子的那几栏（判成蜜罐、重复落选、关掉的敏感类）交给页面侧清点（Jobvite 自己画的单选被判成了蜜罐）', () => {
  it('kernelFiller 把计划期判成蜜罐的那几栏随审计交出来；其余照旧', async () => {
    const { fillFromGesture } = await import('../lib/gestureFill');
    const { installBundledApplyAdapters } = await import('@edaix/apply-kernel/bundledAdapters');
    const { readApplyForm } = await import('@edaix/apply-kernel/registry');
    installBundledApplyAdapters();
    document.body.innerHTML = `<form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="trap">Website</label><input id="trap" name="honeypot" type="text" />
    </form>`;
    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
    button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
    button.dispatchEvent(new TrustedClick('click'));
    const descriptor = readApplyForm('greenhouse', document);
    expect(descriptor).not.toBeNull();
    const audits: { unshown?: readonly Element[] }[] = [];
    await fillFromGesture({
      proof: proof as never,
      scan: { descriptor } as never,
      profile: { firstName: 'Sample' } as never,
      policy: { ...createBundledApplyPolicy(), notAfter: Date.now() + 60_000 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: (audit: { unshown?: readonly Element[] }) => { audits.push(audit); },
    } as never);
    expect(audits[0]?.unshown).toEqual([document.getElementById('trap')]);
  });
});
