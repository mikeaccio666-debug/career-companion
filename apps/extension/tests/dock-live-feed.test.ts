// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';
import { dockCopy } from '../lib/dock/copy';

/**
 * 填写途中进度卡下面那一条列表（2026-09-28 负责人）：一栏一行，题目加一个短的值（「First Name · Alex」），按填上的先后
 * 接在最后、停在最新那一行；一帧最多改一次页面，不挡填写；减少动态时不播入场动画。收尾时那几行收进「其余已填好 N 项」
 * （可以展开），「需要你」那几组接过焦点。值只在我们的浮层里，不进日志。
 *
 * 夹具全是合成文字。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const frame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

const reducedMotion = () => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

const PLAN: readonly AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: false, state: 'PENDING' },
  { label: 'Email', required: true, done: false, state: 'PENDING' },
  { label: 'I agree to the terms', required: true, done: false, state: 'PENDING' },
  { label: 'Subscribe to updates', required: false, done: false, state: 'PENDING' },
  { label: 'Why do you want to work here?', required: true, done: false, state: 'PENDING' },
  { label: 'School', required: true, done: false, state: 'PENDING' },
];
/** 途中那一份：前 n 栏填好了，其余还没轮到。 */
function midway(n: number): AutofillDockFieldRow[] {
  const done: AutofillDockFieldRow[] = [
    { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' },
    { label: 'Email', required: true, done: true, state: 'CONFIRMED', value: 'alex@example.test' },
    { label: 'I agree to the terms', required: true, done: true, state: 'CONFIRMED', value: 'I agree to the terms', signedOnBehalf: 'TERMS_CONSENT', checkbox: true },
    { label: 'Subscribe to updates', required: false, done: true, state: 'CONFIRMED', value: 'Subscribe to updates', checkbox: true },
    { label: 'Why do you want to work here?', required: true, done: true, state: 'CONFIRMED', value: 'Because the mission matters to me.', aiAnswered: true },
  ];
  return PLAN.map((row, index) => (index < n ? done[index]! : row));
}
const SETTLED: readonly AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' },
  { label: 'Email', required: true, done: true, state: 'CONFIRMED', value: 'alex@example.test' },
  { label: 'I agree to the terms', required: true, done: true, state: 'CONFIRMED', value: 'I agree to the terms', signedOnBehalf: 'TERMS_CONSENT', checkbox: true },
  { label: 'Subscribe to updates', required: false, done: true, state: 'CONFIRMED', value: 'Subscribe to updates', checkbox: true },
  { label: 'Why do you want to work here?', required: true, done: true, state: 'CONFIRMED', value: 'Because the mission matters to me.', aiAnswered: true },
  { label: 'School', required: true, done: false, state: 'FAILED', reason: 'NO_OPTION_MATCH', hint: 'Example University' },
];

const progress = (rows: readonly AutofillDockFieldRow[], settled = false, runId = 'gesture-1') => ({
  runId,
  requiredQuestions: rows.filter((row) => row.required).length,
  requiredCompleted: rows.filter((row) => row.required && row.done).length,
  rows,
  ...(settled ? { phase: 'SETTLED' } : {}),
}) as never;

function mount() {
  const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
  handle.openPanel();
  handle.beginPreparing();
  const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  const lines = () => [...shadow.querySelectorAll<HTMLElement>('.frow')].map((row) =>
    [row.querySelector('.fq')?.textContent, row.dataset.empty === 'true' ? '' : row.querySelector('.fv')?.textContent]);
  const group = () => shadow.querySelector<HTMLElement>('.fold-rest')!.closest<HTMLElement>('.grp')!;
  return { handle, shadow, lines, group };
}

describe('填写途中：进度卡下面一条条列出填好的栏', () => {
  it('一栏一行（题目 · 短的值），按填上的先后接在最后；勾选框写「已勾选」、代填写类别；「需要你」那几组不摆', async () => {
    const { handle, shadow, lines, group } = mount();
    handle.beginRun(progress(midway(1)));
    await frame();
    expect(lines()).toEqual([['First Name', 'Alex']]);
    handle.update(progress(midway(3)));
    await frame();
    expect(lines()).toEqual([['First Name', 'Alex'], ['Email', 'alex@example.test'], ['I agree to the terms', '已替你同意条款']]);
    handle.update(progress(midway(5)));
    await frame();
    expect(lines().map(([q]) => q)).toEqual(['First Name', 'Email', 'I agree to the terms', 'Subscribe to updates', 'Why do you want to work here?']);
    expect(lines()[3]![1]).toBe('已勾选');
    expect(shadow.querySelector('.frow[data-kind="ai"] .fq')?.textContent, 'AI 写的那一行标着 AI').toBe('Why do you want to work here?');
    // 它就在进度卡下面：这时「需要你」、代填、AI 那几组都不摆，「其余已填好」那一行字也不在。
    expect(group().dataset.feed).toBe('live');
    expect(shadow.querySelector<HTMLElement>('.rest-toggle')!.style.display).toBe('none');
    expect(shadow.querySelectorAll('[data-need-row]')).toHaveLength(0);
    expect(shadow.querySelector<HTMLElement>('[data-ai="group"]')!.style.display).toBe('none');
  });

  it('一帧最多改一次：一口气来了好几份，页面只在下一帧按最新那一份改', async () => {
    const { handle, lines } = mount();
    await frame();
    const raf = vi.spyOn(document.defaultView!, 'requestAnimationFrame');
    handle.beginRun(progress(midway(1)));
    for (let n = 2; n <= 5; n += 1) handle.update(progress(midway(n)));
    expect(lines(), '还没到下一帧：页面没动').toEqual([]);
    expect(raf.mock.calls.length, '只约了一帧').toBe(1);
    await frame();
    expect(lines()).toHaveLength(5);
  });

  it('停在最新那一行；他往上翻了就不拽他回来', async () => {
    const { handle, shadow } = mount();
    const card = shadow.querySelector<HTMLElement>('.fold-rest .card')!;
    // 一行 60px；卡里看得见 100px。
    vi.spyOn(card, 'scrollHeight', 'get').mockImplementation(() => card.children.length * 60);
    vi.spyOn(card, 'clientHeight', 'get').mockReturnValue(100);
    handle.beginRun(progress(midway(3)));
    await frame();
    expect(card.scrollTop, '停在最新那一行').toBe(180);
    expect(card.dataset.overflow, '放不下：顶上淡出').toBe('true');
    // 他往上翻到顶：新来的行照样接在最后，但不拽他回来。
    card.scrollTop = 0;
    handle.update(progress(midway(5)));
    await frame();
    expect(card.children).toHaveLength(5);
    expect(card.scrollTop).toBe(0);
  });

  it('减少动态：新来的行不播入场动画', async () => {
    reducedMotion();
    const { handle, shadow } = mount();
    const animate = vi.spyOn(Element.prototype, 'animate');
    handle.beginRun(progress(midway(3)));
    await frame();
    expect(shadow.querySelectorAll('.frow')).toHaveLength(3);
    expect(animate.mock.contexts.filter((node) => (node as Element).classList?.contains('frow'))).toHaveLength(0);
  });
});

describe('收尾：填好的那几行收进「其余已填好 N 项」', () => {
  it('那几行收起来，「其余已填好」写着几项、可以展开；「需要你」那几组接过焦点', async () => {
    const { handle, shadow, lines, group } = mount();
    handle.beginRun(progress(midway(5)));
    await frame();
    expect(lines()).toHaveLength(5);
    handle.update(progress(SETTLED, true));
    // 收的那半秒里：行还在（跟着一起收），「其余已填好」那一行字出来了，「需要你」出来了。
    const toggle = shadow.querySelector<HTMLElement>('.rest-toggle')!;
    expect(toggle.style.display).toBe('');
    expect(toggle.querySelector('.grp-count')?.textContent, '其余已填好：我们填好的两栏加上勾好的那一栏（代填、AI 各有自己的一组）').toBe('3');
    expect(shadow.querySelector<HTMLElement>('.fold-rest')!.dataset.open).toBe('false');
    expect(lines()).toHaveLength(5);
    expect([...shadow.querySelectorAll('[data-need-row] .need-q')].map((node) => node.textContent)).toEqual(['School']);
    await wait(600);
    // 收好了：换成平常的「其余已填好」（点开是一行行的题目与值）。
    expect(group().dataset.feed).toBeUndefined();
    expect(lines()).toEqual([]);
    click(toggle);
    expect(shadow.querySelector<HTMLElement>('.fold-rest')!.dataset.open).toBe('true');
    expect([...shadow.querySelectorAll('.rrow .rq')].map((node) => node.textContent)).toEqual(['First Name', 'Email', 'Subscribe to updates']);
  });

  it('收的途中他点开了「其余已填好」：不等，直接换成平常的样子并展开', async () => {
    const { handle, shadow, lines } = mount();
    handle.beginRun(progress(midway(5)));
    await frame();
    handle.update(progress(SETTLED, true));
    click(shadow.querySelector('.rest-toggle'));
    expect(lines()).toEqual([]);
    expect(shadow.querySelectorAll('.rrow')).toHaveLength(3);
    expect(shadow.querySelector<HTMLElement>('.fold-rest')!.dataset.open).toBe('true');
  });

  it('减少动态：直接换，不等', async () => {
    reducedMotion();
    const { handle, shadow, lines } = mount();
    handle.beginRun(progress(midway(5)));
    await frame();
    handle.update(progress(SETTLED, true));
    expect(lines()).toEqual([]);
    expect(shadow.querySelectorAll('.rrow')).toHaveLength(3);
  });

  it('新的一轮：那一条列表从头来', async () => {
    const { handle, lines } = mount();
    handle.beginRun(progress(midway(3)));
    await frame();
    handle.beginPreparing();
    handle.beginRun(progress(midway(1), false, 'gesture-2'));
    await frame();
    expect(lines()).toEqual([['First Name', 'Alex']]);
  });
});

describe('账号墙那一轮（#133 替他注册、登录）与那一条列表、「需要你」', () => {
  const SITE = 'Acme 的 Workday';
  const EMAIL = 'candidate@example.test';
  const accountAccess = () => ({
    onSitePassword: vi.fn(), onResume: vi.fn(),
    load: vi.fn(async () => ({ email: null, defaultEmail: EMAIL, hasPassword: true, sites: 0 })),
    reveal: vi.fn(async () => 'x'), setEmail: vi.fn(async () => null), setPassword: vi.fn(async () => null),
  });

  it('替他注册、登录的那几步只在进度卡上说，下面不列行；停在账号墙的卡上也不列；过去了接着填，列表从头来，收尾照常收起、「需要你」接过焦点', async () => {
    const port = accountAccess();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, onStop: () => {}, accountAccess: port }, document);
    handle.openPanel();
    const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
    const lines = () => [...shadow.querySelectorAll('.frow .fq')].map((node) => node.textContent);
    const needs = () => [...shadow.querySelectorAll('[data-need-row] .need-q')].map((node) => node.textContent);
    const group = () => shadow.querySelector<HTMLElement>('.fold-rest')!.closest<HTMLElement>('.grp')!;
    handle.setAccountWall({ action: 'REGISTER', site: SITE });
    click(handle.autofillButton());
    handle.accountStatus({ kind: 'REGISTERING', site: SITE });
    await frame();
    expect(lines(), '还没开始填表：没有行').toEqual([]);
    expect(group().style.display).toBe('none');
    // 停在账号墙上：去邮箱点验证链接。卡上只说那一件事，下面既没有列表也没有「需要你」。
    handle.accountPrompt({ kind: 'VERIFY_EMAIL', site: SITE, email: EMAIL });
    await frame();
    expect(shadow.querySelector('[data-account="VERIFY_EMAIL"]')).not.toBeNull();
    expect(lines()).toEqual([]);
    expect(needs()).toEqual([]);
    expect(group().style.display).toBe('none');
    // 「我已验证，继续」：接着登录，登录了，过了账号墙接着填这一页。
    click(shadow.querySelector('[data-action="account-resume"]'));
    expect(port.onResume).toHaveBeenCalledTimes(1);
    handle.accountStatus({ kind: 'SIGNING_IN', site: SITE });
    handle.accountStatus({ kind: 'SIGNED_IN', site: SITE, email: EMAIL });
    handle.accountContinuing();
    handle.beginRun(progress(midway(3)));
    await frame();
    expect(lines(), '列表从头来，只列这一页填上的').toEqual(['First Name', 'Email', 'I agree to the terms']);
    expect(needs(), '还在填：「需要你」不摆').toEqual([]);
    handle.update(progress(SETTLED, true));
    expect(needs(), '收尾：「需要你」接过焦点').toEqual(['School']);
    expect(shadow.querySelector<HTMLElement>('.fold-rest')!.dataset.open).toBe('false');
    await wait(600);
    expect(lines()).toEqual([]);
    expect(group().dataset.feed).toBeUndefined();
    // 替他做过的那一件照旧记在总结里。
    expect([...shadow.querySelectorAll('[data-account="done"]')].map((node) => node.textContent))
      .toContain(dockCopy('zh').siteAccount.done.SIGNED_IN(SITE, EMAIL));
  });

  it('等他在网站上过人机验证（这一轮还在走）：卡上等着，下面不列行', async () => {
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, onStop: () => {}, accountAccess: accountAccess() }, document);
    handle.openPanel();
    const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
    handle.setAccountWall({ action: 'SIGN_IN', site: SITE });
    click(handle.autofillButton());
    handle.accountPrompt({ kind: 'CAPTCHA', site: SITE });
    await frame();
    expect(handle.runState(), '这一轮还在等他').toBe('PREPARING');
    expect(shadow.querySelector('[data-account="CAPTCHA"]')).not.toBeNull();
    expect(shadow.querySelectorAll('.frow')).toHaveLength(0);
    expect(shadow.querySelectorAll('[data-need-row]')).toHaveLength(0);
  });
});
