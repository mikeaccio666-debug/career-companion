// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { AuditRow, AuditStatus, AuditView } from '@edaix/apply-kernel/audit';
import {
  ADVANCE_RUN_MAX_PAGES,
  ADVANCE_RUN_STEP_RESERVE_MS,
  beginAdvanceRunStep,
  captureTrustedShadowGesture,
  isAdvanceRunPage,
  mintAuthorityFromGesture,
  type AdvanceRunPageProof,
  type AdvanceRunScope,
  type AdvanceRunStep,
  type GestureRoot,
  type TrustedGestureProof,
} from '@edaix/apply-kernel/grant';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';

import type { DockAdvanceOutcome, DockChainState } from '../lib/autofillDock';
import {
  createFillToReview,
  decideAfterPage,
  requiredNeedsIn,
  type ChainAfterPage,
  type ChainPage,
  type ChainPageFacts,
  type FillToReviewDeps,
} from '../lib/fillToReview';

/**
 * 按一下「自动填写」，一页一页填到检查页（fillToReview.ts，2026-09-28 负责人决定）。
 *
 * 钉三件事：每一个停下的条件（与它们的先后）；往下翻的那一步只凭那一下点击开出的一轮连填、翻过去才发新一页的凭证、
 * 上一页的随之作废；停止、换一轮、离开这一页之后，一张票都铸不出、一颗按钮都不按。
 */

const SCOPE: AdvanceRunScope = Object.freeze({
  origin: 'https://acme.wd5.myworkdayjobs.com',
  pathname: '/en-US/External/job/Remote/Engineer_R1/apply/applyManually',
  vendor: 'workday',
});

function policy(capabilities: Partial<ApplyPolicy['capabilities']> = { 'advance-step': true, 'advance-steps': true }): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, workday: true },
    capabilities: { ...base.capabilities, ...capabilities },
    notAfter: Date.now() + 60 * 60_000,
  };
}

/** 一次真实点击的凭证（在我方 shadow 里的一颗按钮上派发）。 */
function click(): TrustedGestureProof {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let proof: TrustedGestureProof | null = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
  class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
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
  run: { ok: true, value: { page: 1, maxPages: ADVANCE_RUN_MAX_PAGES, remainingMs: 9 * 60_000 } },
  ...overrides,
});

describe('每一页填完：往下翻，还是停下', () => {
  it('什么都没挡着 → 往下翻', () => {
    expect(decideAfterPage(facts())).toEqual({ kind: 'ADVANCE' });
  });

  it.each([
    ['他按了「停止」', { stopped: true }, 'STOPPED'],
    ['这一轮已经作废（停止、换一轮、离开这一页）', { run: { ok: false, code: 'RUN_ENDED' } }, 'STOPPED'],
    ['页面换了地方（另一张申请、另一家）', { run: { ok: false, code: 'RUN_SCOPE_CHANGED' } }, 'MOVED'],
    ['网站要他登录', { checkpoint: 'LOGIN' }, 'LOGIN'],
    ['网站要他输入验证码', { checkpoint: 'VERIFICATION' }, 'VERIFICATION'],
    ['网站弹出人机验证', { checkpoint: 'CAPTCHA' }, 'CAPTCHA'],
    ['读页面时出错（说不清有没有关卡）', { checkpoint: 'UNREADABLE' }, 'UNAVAILABLE'],
    ['这一页还有必填要他处理', { requiredNeeds: 2 }, 'NEEDS_USER'],
    ['规则声明的最终提交就在这一页上', { finalSubmit: true }, 'REVIEW'],
    ['这一页没有翻页按钮了（最后一步是 Submit）', { next: 'NONE' }, 'REVIEW'],
    ['翻页按钮不止一颗', { next: 'AMBIGUOUS' }, 'UNAVAILABLE'],
    ['控制器没 arm（这一页没交给它）', { next: 'UNARMED' }, 'UNAVAILABLE'],
    ['连填的开关此刻关着（后端没发、或关掉了）', { chainOn: false }, 'OFF'],
    ['填满了上限那么多页', { run: { ok: true, value: { page: ADVANCE_RUN_MAX_PAGES, maxPages: ADVANCE_RUN_MAX_PAGES, remainingMs: 60_000 } } }, 'PAGE_CAP'],
    ['总时限到了', { run: { ok: false, code: 'RUN_EXPIRED' } }, 'TIME_CAP'],
    ['剩下的时间不够下一页用', { run: { ok: true, value: { page: 2, maxPages: 10, remainingMs: ADVANCE_RUN_STEP_RESERVE_MS - 1 } } }, 'TIME_CAP'],
  ] as const)('%s → 停下（%s）', (_name, overrides, reason) => {
    expect(decideAfterPage(facts(overrides as Partial<ChainPageFacts>))).toEqual({ kind: 'STOP', reason });
  });

  /**
   * 网站自己说还有几步（「current step 2 of 5」）却读不到翻页按钮：不是最后一页，只是这一刻那一颗读不出来——
   * 不说「都填好了、去提交」，说「下一步说不清是哪一颗」（2026-09-28：知道不是最后一页就绝不说提交）。
   */
  it('没有翻页按钮、但网站说还有几步 → UNAVAILABLE，不是 REVIEW', () => {
    expect(decideAfterPage(facts({ next: 'NONE', site: { index: 2, total: 5, name: null } }))).toEqual({ kind: 'STOP', reason: 'UNAVAILABLE' });
    expect(decideAfterPage(facts({ next: 'NONE', site: { index: 5, total: 5, name: null } }))).toEqual({ kind: 'STOP', reason: 'REVIEW' });
    expect(decideAfterPage(facts({ next: 'NONE', site: { index: null, total: null, name: 'Review' } }))).toEqual({ kind: 'STOP', reason: 'REVIEW' });
    // 规则声明的最终提交就在这一页上：那才是最后一页，照旧 REVIEW。
    expect(decideAfterPage(facts({ finalSubmit: true, site: { index: 2, total: 5, name: null } }))).toEqual({ kind: 'STOP', reason: 'REVIEW' });
  });

  it('先后：停止 > 关卡 > 必填 > 到头了 > 开关与上限', () => {
    expect(decideAfterPage(facts({ stopped: true, checkpoint: 'LOGIN', requiredNeeds: 1 }))).toEqual({ kind: 'STOP', reason: 'STOPPED' });
    expect(decideAfterPage(facts({ checkpoint: 'CAPTCHA', requiredNeeds: 1 }))).toEqual({ kind: 'STOP', reason: 'CAPTCHA' });
    // 最后一页还有必填：先说要他处理的（浮层照旧「逐项处理」），不说「都填好了」。
    expect(decideAfterPage(facts({ requiredNeeds: 1, next: 'NONE' }))).toEqual({ kind: 'STOP', reason: 'NEEDS_USER' });
    // 到头了就是到头了：开关关着、上限到了，也照实说「都填好了」。
    expect(decideAfterPage(facts({ finalSubmit: true, chainOn: false }))).toEqual({ kind: 'STOP', reason: 'REVIEW' });
  });
});

const row = (status: AuditStatus, required: boolean): AuditRow => ({
  key: null, label: status, required, status, reason: null, attemptedValue: null, resolvedOptionText: null,
  element: document.createElement('input'), confidence: null, order: 0,
});
const viewOf = (rows: AuditRow[]): AuditView => ({
  rows, filled: 0, requiredTotal: rows.filter((r) => r.required).length, requiredHandled: 0, needsAttention: 0, blockedByUs: 0, awaitingUser: 0,
});

describe('这一页还有几项必填要他处理（与浮层「需要你」同一个口径）', () => {
  it('必填里填成的、网页上本来就有的不算；没填成、要他答的、写了网站没确认的都算；选填不算', () => {
    expect(requiredNeedsIn(viewOf([
      row('FILLED', true), row('PREFILLED', true),
      row('NEEDS_MANUAL', true), row('NEEDS_CONFIRMATION', true), row('FAILED', true), row('FILLED_UNVERIFIED', true),
      row('NEEDS_MANUAL', false), row('FAILED', false),
    ]))).toBe(4);
    expect(requiredNeedsIn(null)).toBe(0);
  });
});

/** 一套可以从外面拨动的依赖：翻页的结论、关卡、策略都由测试决定。 */
function harness(overrides: Partial<FillToReviewDeps> = {}) {
  const chain: (DockChainState | null)[] = [];
  const advances: Promise<DockAdvanceOutcome>[] = [];
  const labels: (string | null)[] = [];
  const filled: AdvanceRunPageProof[] = [];
  let outcome: DockAdvanceOutcome = 'ADVANCED';
  const advance = vi.fn(async (_step: AdvanceRunStep) => outcome);
  let wall: ReturnType<FillToReviewDeps['checkpoint']> = null;
  let live: ApplyPolicy | null = policy();
  const deps: FillToReviewDeps = {
    resolvePolicy: async () => live,
    advance,
    checkpoint: () => wall,
    fillNextPage: (page) => { filled.push(page); },
    dock: () => ({
      setChain: (state) => { chain.push(state); },
      autoAdvance: (pending, label) => { advances.push(pending); labels.push(label); },
    }),
    ...overrides,
  };
  const driver = createFillToReview(deps);
  return {
    driver,
    advance,
    chain,
    advances,
    labels,
    filled,
    setOutcome: (value: DockAdvanceOutcome) => { outcome = value; },
    setWall: (value: typeof wall) => { wall = value; },
    setPolicy: (value: ApplyPolicy | null) => { live = value; },
  };
}

const after = (overrides: Partial<ChainAfterPage> = {}): ChainAfterPage => ({
  written: 6,
  scope: () => SCOPE,
  stopped: () => false,
  current: () => true,
  requiredNeeds: () => 0,
  finalSubmit: () => false,
  next: () => 'ONE',
  label: () => 'Save and Continue',
  ...overrides,
});

function beginFirst(h: ReturnType<typeof harness>, root: GestureRoot = click()) {
  const begun = h.driver.begin({ root, scope: SCOPE, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null });
  if (begun.kind !== 'CHAIN') throw new Error(`expected a chain, got ${begun.kind}`);
  return begun;
}

const mints = (root: GestureRoot) => mintAuthorityFromGesture({ proof: root, purpose: 'fill', fingerprint: 'p', now: Date.now() }).ok;

describe('开一轮：只在一次真实点击、开关开着、这一页是向导的一步时', () => {
  it('开关开着、页面上有唯一一颗翻页按钮 → 开一轮，这一页用「这一页」的凭证写（不是点击凭证）', () => {
    const h = harness();
    const proof = click();
    const begun = beginFirst(h, proof);
    expect(begun.proof).not.toBe(proof);
    expect(isAdvanceRunPage(begun.proof)).toBe(true);
    expect(begun.page).toMatchObject({ number: 1, donePages: 0, doneFields: 0, maxPages: ADVANCE_RUN_MAX_PAGES });
    expect(mints(begun.proof)).toBe(true);
  });

  it.each([
    ['连填位没开（后端还没发）', policy({ 'advance-step': true }), 'ONE'],
    ['翻页位没开', policy({ 'advance-steps': true }), 'ONE'],
    ['单页申请表（没有翻页按钮）', policy(), 'NONE'],
    ['翻页按钮说不清', policy(), 'AMBIGUOUS'],
  ] as const)('%s → 不开，照旧用那一下点击的凭证', (_name, value, next) => {
    const h = harness();
    const proof = click();
    expect(h.driver.begin({ root: proof, scope: SCOPE, vendor: 'workday', policy: value, next: () => next, site: () => null }))
      .toEqual({ kind: 'SINGLE', proof });
  });

  it('新的一次点击：上一轮到此为止（上一轮那一页的凭证不再铸得出票）', () => {
    const h = harness();
    const first = beginFirst(h);
    beginFirst(h);
    expect(mints(first.proof)).toBe(false);
  });
});

describe('一页填完、没有挡着的：替他按网站的下一步，翻过去接着填', () => {
  it('交给浮层「正在翻到下一页」，按的是那一轮的这一步；翻过去了 → 发新一页的凭证接着填，上一页的作废', async () => {
    const h = harness();
    const first = beginFirst(h);
    expect(await h.driver.afterPage(first.page, after())).toBe(true);
    expect(h.labels).toEqual(['Save and Continue']);
    expect(h.advance).toHaveBeenCalledTimes(1);
    expect(await h.advances[0]).toBe('ADVANCED_FILLING');
    expect(h.filled).toHaveLength(1);
    const second = h.filled[0]!;
    expect(isAdvanceRunPage(second)).toBe(true);
    expect(mints(second)).toBe(true);
    expect(mints(first.proof), '翻走的那一页不能再写').toBe(false);
    // 浮层：新一页是第 2 页，前面填好了 1 页、6 项。
    expect(h.chain.at(-1)).toMatchObject({ page: 2, donePages: 1, doneFields: 6, stop: null });
    // 新一页扫出表之后接着这一轮。
    const begun = h.driver.begin({ root: second, scope: SCOPE, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => ({ index: 2, total: 5, name: 'My Experience' }) });
    expect(begun).toMatchObject({ kind: 'CHAIN', proof: second, page: { number: 2, site: { name: 'My Experience' } } });
  });

  it('一路翻到上限：第 10 页填完就停（PAGE_CAP），不再按', async () => {
    const h = harness();
    let begun = beginFirst(h);
    for (let page = 1; page < ADVANCE_RUN_MAX_PAGES; page += 1) {
      expect(await h.driver.afterPage(begun.page, after())).toBe(true);
      await h.advances.at(-1);
      const next = h.driver.begin({ root: h.filled.at(-1)!, scope: SCOPE, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null });
      if (next.kind !== 'CHAIN') throw new Error(next.kind);
      begun = next;
    }
    expect(begun.page.number).toBe(ADVANCE_RUN_MAX_PAGES);
    expect(await h.driver.afterPage(begun.page, after())).toBe(false);
    expect(h.chain.at(-1)?.stop).toBe('PAGE_CAP');
    expect(h.advance).toHaveBeenCalledTimes(ADVANCE_RUN_MAX_PAGES - 1);
  });

  it('按之前重读开关：这一页填完时连填已经关了 → 停下（OFF），不按', async () => {
    const h = harness();
    const first = beginFirst(h);
    h.setPolicy(policy({ 'advance-step': true, 'advance-steps': false }));
    expect(await h.driver.afterPage(first.page, after())).toBe(false);
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.chain.at(-1)?.stop).toBe('OFF');
  });

  it('读不到开关（worker 没给授权）→ 当关，不按', async () => {
    const h = harness();
    const first = beginFirst(h);
    h.setPolicy(null);
    expect(await h.driver.afterPage(first.page, after())).toBe(false);
    expect(h.advance).not.toHaveBeenCalled();
  });

  it('到了最后一页（规则声明的最终提交在这一页上）→ 停下（REVIEW），一颗按钮都不按', async () => {
    const h = harness();
    const first = beginFirst(h);
    expect(await h.driver.afterPage(first.page, after({ finalSubmit: () => true }))).toBe(false);
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.chain.at(-1)).toMatchObject({ page: 1, stop: 'REVIEW' });
  });

  it('这一页还有必填要他处理 → 停下（NEEDS_USER），这一轮不再往下翻', async () => {
    const h = harness();
    const first = beginFirst(h);
    expect(await h.driver.afterPage(first.page, after({ requiredNeeds: () => 1 }))).toBe(false);
    expect(h.chain.at(-1)?.stop).toBe('NEEDS_USER');
    expect(beginAdvanceRunStep(first.page.run, SCOPE)).toEqual({ ok: false, code: 'RUN_ENDED' });
    // 停在这一页：这一页的凭证还能用一会儿（网站在整轮之后清空一栏，重填一次还来得及）。
    expect(mints(first.proof)).toBe(true);
  });

  it('网站弹出了人机验证 → 停下（CAPTCHA），不按', async () => {
    const h = harness();
    const first = beginFirst(h);
    h.setWall('CAPTCHA');
    expect(await h.driver.afterPage(first.page, after())).toBe(false);
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.chain.at(-1)?.stop).toBe('CAPTCHA');
  });

  it('这一页已经不归这一轮管（新的一轮、翻页、浮层换了）→ 什么都不做', async () => {
    const h = harness();
    const first = beginFirst(h);
    expect(await h.driver.afterPage(first.page, after({ current: () => false }))).toBe(false);
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.chain).toEqual([]);
  });

  it('页面换了地方（另一个岗位的申请）→ 停下（MOVED），不按', async () => {
    const h = harness();
    const first = beginFirst(h);
    expect(await h.driver.afterPage(first.page, after({ scope: () => ({ ...SCOPE, pathname: '/job/Other/apply/applyManually' }) }))).toBe(false);
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.chain.at(-1)?.stop).toBe('MOVED');
  });
});

describe('按了，网站没翻过去', () => {
  it('校验没过 → NOT_ADVANCED，停在这一页', async () => {
    const h = harness();
    h.setOutcome('NOT_ADVANCED');
    const first = beginFirst(h);
    await h.driver.afterPage(first.page, after());
    expect(await h.advances[0]).toBe('NOT_ADVANCED');
    expect(h.filled).toEqual([]);
    expect(h.chain.at(-1)).toMatchObject({ page: 1, stop: 'NOT_ADVANCED' });
  });

  it('按下去之后弹出了人机验证 → 照实说是验证（CAPTCHA），不是「网站没有翻页」', async () => {
    const h = harness();
    // 按之前页面上没有关卡；按下去，网站弹出挑战框、没翻页。
    h.advance.mockImplementation(async () => { h.setWall('CAPTCHA'); return 'NOT_ADVANCED'; });
    const first = beginFirst(h);
    expect(await h.driver.afterPage(first.page, after())).toBe(true);
    expect(await h.advances[0]).toBe('NOT_ADVANCED');
    expect(h.chain.at(-1)?.stop).toBe('CAPTCHA');
  });

  it('按钮此刻按不了（不在了、开关在按之前关了）→ UNAVAILABLE', async () => {
    const h = harness();
    h.setOutcome('UNAVAILABLE');
    const first = beginFirst(h);
    await h.driver.afterPage(first.page, after());
    expect(await h.advances[0]).toBe('UNAVAILABLE');
    expect(h.chain.at(-1)?.stop).toBe('UNAVAILABLE');
  });
});

describe('停止与离开', () => {
  it('翻页的那几秒里他按了「停止」：宿主翻过去了也不接着填，新一页一张票都没有', async () => {
    let release: (value: DockAdvanceOutcome) => void = () => {};
    const h = harness({ advance: vi.fn(() => new Promise<DockAdvanceOutcome>((resolve) => { release = resolve; })) });
    const first = beginFirst(h);
    await h.driver.afterPage(first.page, after());
    h.driver.end();
    release('ADVANCED');
    expect(await h.advances[0]).toBe('ADVANCED');
    expect(h.filled).toEqual([]);
    expect(mints(first.proof)).toBe(false);
  });

  it('停止之后宿主没翻：说「已停止」，不说「网站没有翻页」', async () => {
    let release: (value: DockAdvanceOutcome) => void = () => {};
    const h = harness({ advance: vi.fn(() => new Promise<DockAdvanceOutcome>((resolve) => { release = resolve; })) });
    const first = beginFirst(h);
    await h.driver.afterPage(first.page, after());
    h.driver.end();
    release('NOT_ADVANCED');
    await h.advances[0];
    expect(h.chain.at(-1)?.stop).toBe('STOPPED');
  });

  it('连填翻到的一页，扫出来却换了厂商或换了地方 → 不填（REFUSED），这一轮收起', async () => {
    const h = harness();
    const first = beginFirst(h);
    await h.driver.afterPage(first.page, after());
    await h.advances[0];
    const second = h.filled[0]!;
    expect(h.driver.begin({ root: second, scope: { ...SCOPE, vendor: 'greenhouse' }, vendor: 'greenhouse', policy: policy(), next: () => 'ONE', site: () => null }))
      .toEqual({ kind: 'REFUSED', stop: 'MOVED' });
    expect(mints(second)).toBe(true);
    expect(h.driver.begin({ root: second, scope: SCOPE, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null }))
      .toEqual({ kind: 'REFUSED', stop: 'STOPPED' });
  });

  it('不认得的「这一页」凭证（别的一轮的、伪造的）→ 不填', () => {
    const h = harness();
    const forged = Object.freeze({ capturedAt: Date.now() }) as unknown as GestureRoot;
    // 伪造的对象不是连填发的，当点击看——但它也不是点击：开不出一轮，照旧交回（铸票那一关会拒它）。
    expect(h.driver.begin({ root: forged, scope: SCOPE, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null }).kind).toBe('SINGLE');
    expect(mints(forged)).toBe(false);
  });
});

describe('翻过去之后新一页扫不出表', () => {
  async function advancedOnce() {
    const h = harness();
    const first = beginFirst(h);
    await h.driver.afterPage(first.page, after());
    await h.advances[0];
    return { h, second: h.filled[0]! as GestureRoot, first };
  }

  it('没有翻页按钮了（只剩 Submit）→ 到了检查页（REVIEW），带着前面填好的页数', async () => {
    const { h, second } = await advancedOnce();
    expect(h.driver.noForm(second, { origin: SCOPE.origin, pathname: SCOPE.pathname, next: 'NONE' }))
      .toMatchObject({ stop: 'REVIEW', page: { number: 2, donePages: 1, doneFields: 6 } });
    expect(mints(second), '检查页上没有我们要写的：这一轮收起').toBe(true);
  });

  it('还有一颗「下一步」→ 这一页我们认不出要填的（UNKNOWN_PAGE），不说到了检查页', async () => {
    const { h, second } = await advancedOnce();
    expect(h.driver.noForm(second, { origin: SCOPE.origin, pathname: SCOPE.pathname, next: 'ONE' })?.stop).toBe('UNKNOWN_PAGE');
  });

  it('翻过去是登录页 → LOGIN', async () => {
    const { h, second } = await advancedOnce();
    h.setWall('LOGIN');
    expect(h.driver.noForm(second, { origin: SCOPE.origin, pathname: SCOPE.pathname, next: 'NONE' })?.stop).toBe('LOGIN');
  });

  it('地址换了（翻出了这张申请）→ MOVED', async () => {
    const { h, second } = await advancedOnce();
    expect(h.driver.noForm(second, { origin: SCOPE.origin, pathname: '/en-US/External/job/Remote/Engineer_R1', next: 'NONE' })?.stop).toBe('MOVED');
  });

  it('点击凭证（不是连填翻到的页）→ null，照旧的处理', () => {
    const h = harness();
    expect(h.driver.noForm(click(), { origin: SCOPE.origin, pathname: SCOPE.pathname, next: 'NONE' })).toBeNull();
  });

  it('pageOf：连填翻到的页认得出，点击凭证与第一页之外的东西都是 null', async () => {
    const { h, second, first } = await advancedOnce();
    expect(h.driver.pageOf(second)?.number).toBe(2);
    expect(h.driver.pageOf(first.proof)?.number).toBe(1);
    expect(h.driver.pageOf(click())).toBeNull();
    expect((h.driver.pageOf(second) as ChainPage).run).toBe(first.page.run);
  });
});

describe('账号墙那一轮（2026-09-28：替他注册、登录之后接着填）', () => {
  const MOVED = '/en-US/External/job/Remote/Engineer_R1/apply';
  const opened = (h: ReturnType<typeof harness>) => {
    const run = h.driver.openAccountRun({ root: click(), scope: SCOPE, vendor: 'workday' });
    if (run === null) throw new Error('expected an account run');
    return run;
  };

  it('那一下点击开一轮，账号墙是这一轮的第一页；凭证是「这一页」的，不是点击', () => {
    const h = harness();
    const run = opened(h);
    expect(isAdvanceRunPage(run.proof)).toBe(true);
    expect(run.page).toMatchObject({ number: 1, donePages: 0, doneFields: 0 });
    expect(h.driver.accountRunState(run.page, SCOPE)).toMatchObject({ ok: true, value: { page: 1 } });
  });

  it('账号墙过去了：发下一页的凭证（浮层上照旧从第 1 页数起），地址没换就照常接着那一轮', () => {
    const h = harness();
    const run = opened(h);
    const step = h.driver.beginAccountStep(run.page, SCOPE);
    expect(step).not.toBeNull();
    const next = h.driver.completeAccountStep(step!, run.page);
    expect(next).not.toBeNull();
    expect(h.driver.pageOf(next!)).toMatchObject({ number: 1, donePages: 0 });
    expect(mints(run.proof), '账号墙那一页的凭证随之作废').toBe(false);
    const begun = h.driver.begin({ root: next!, scope: SCOPE, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null });
    expect(begun.kind).toBe('CHAIN');
  });

  it('Workday 建了草稿、地址换成 …/apply：账号墙之后的那一页跟着换一次；再换就停（MOVED）', () => {
    const h = harness();
    const run = opened(h);
    const next = h.driver.completeAccountStep(h.driver.beginAccountStep(run.page, SCOPE)!, run.page)!;
    const moved = { ...SCOPE, pathname: MOVED };
    const begun = h.driver.begin({ root: next, scope: moved, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null });
    expect(begun.kind).toBe('CHAIN');
    if (begun.kind !== 'CHAIN') return;
    expect(begun.page.scope).toEqual(moved);
    expect(mints(begun.proof)).toBe(true);
    // 同一页再开始一次（重扫）照旧；换到别处就停。
    expect(h.driver.begin({ root: next, scope: { ...SCOPE, pathname: '/elsewhere' }, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null }))
      .toEqual({ kind: 'REFUSED', stop: 'MOVED' });
  });

  it('换厂商不跟着换；普通的连填翻页之后换地址照旧停', async () => {
    const h = harness();
    const run = opened(h);
    const next = h.driver.completeAccountStep(h.driver.beginAccountStep(run.page, SCOPE)!, run.page)!;
    expect(h.driver.begin({ root: next, scope: { ...SCOPE, pathname: MOVED, vendor: 'icims' }, vendor: 'icims', policy: policy(), next: () => 'ONE', site: () => null }))
      .toMatchObject({ kind: 'REFUSED' });

    const h2 = harness();
    const first = beginFirst(h2);
    expect(await h2.driver.afterPage(first.page, after())).toBe(true);
    await h2.advances[0];
    const second = h2.filled[0]!;
    expect(h2.driver.begin({ root: second, scope: { ...SCOPE, pathname: MOVED }, vendor: 'workday', policy: policy(), next: () => 'ONE', site: () => null }))
      .toEqual({ kind: 'REFUSED', stop: 'MOVED' });
  });

  it('那一下提交没过去：放下这一步，这一页的凭证照旧、还能再开一步', () => {
    const h = harness();
    const run = opened(h);
    const step = h.driver.beginAccountStep(run.page, SCOPE)!;
    expect(h.driver.beginAccountStep(run.page, SCOPE), '上一步还没有结论').toBeNull();
    h.driver.abandonAccountStep(step);
    expect(mints(run.proof)).toBe(true);
    expect(h.driver.beginAccountStep(run.page, SCOPE)).not.toBeNull();
  });

  it('他按了停止（end）：这一轮作废，下一步开不了', () => {
    const h = harness();
    const run = opened(h);
    h.driver.end();
    expect(h.driver.beginAccountStep(run.page, SCOPE)).toBeNull();
    expect(h.driver.accountRunState(run.page, SCOPE)).toEqual({ ok: false, code: 'RUN_ENDED' });
  });
});
