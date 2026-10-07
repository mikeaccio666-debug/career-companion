// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';
import type { AutofillAffordance } from '../product-panel/affordance';

/**
 * 浮层对用户说的话（2026-09-23 按设计交接 `ArgoAI Autofill.dc.html` 重做之后）。
 *
 * 钉住设计里那几条：面上只有人话、没有码；主卡是「这一件事」（自动填写 / 进度 / 总结 / 提示 / 失败）；
 * 填完先一句总结，再列要他动手的必填项，数字与列表、进度条对得上；每行只写原因，不写状态；
 * 一项都没填就停下时是失败卡，码收在默认折叠的「技术细节」里。
 */
const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
type Handle = ReturnType<typeof mountAutofillDock>;

/** 用户不点开任何折叠时看得到的字：收起的折叠、display:none 的节点都不算。 */
const visibleText = (root: Element | null | undefined): string => {
  if (root == null) return '';
  const copy = root.cloneNode(true) as Element;
  for (const hidden of Array.from(copy.querySelectorAll<HTMLElement>('[style*="display: none"], [hidden], .tech:not([data-open="true"]) .tech-body, .fold:not([data-open="true"]), .fold-rest:not([data-open="true"]), .pop:not([data-open="true"]), .guide'))) hidden.remove();
  return copy.textContent ?? '';
};
/** 我们内部的码长这样：大写加下划线。 */
const CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

const home = (affordance: AutofillAffordance, extra: Record<string, unknown> = {}): Handle => {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock(affordance, { ...handlers, ...extra }, doc);
  handle.openPanel();
  return handle;
};

const FACES: readonly AutofillAffordance[] = [
  { kind: 'READY' },
  { kind: 'UNAVAILABLE', reason: 'NO_MISSION' },
  { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' },
  { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' },
  { kind: 'DORMANT' },
];

describe('主界面', () => {
  it('能填的脸上，主卡本身就是「自动填写」；按不了的脸不摆这颗按钮', () => {
    for (const affordance of FACES) {
      const root = home(affordance).sceneRoot();
      const button = root?.querySelector<HTMLButtonElement>('[data-action="autofill"]') ?? null;
      const fillable = affordance.kind === 'READY' || (affordance.kind === 'UNAVAILABLE' && affordance.reason === 'NO_MISSION');
      const name = JSON.stringify(affordance);
      if (fillable) {
        expect(button, name).not.toBeNull();
        expect(button?.textContent, name).toBe('自动填写');
      } else {
        expect(button, `${name}：灰掉的按钮让人以为坏了`).toBeNull();
      }
    }
  });

  it('没连接：一句话说清楚这是什么，主按钮是「登录 Career Companion」', () => {
    const root = home({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }, { onOpenPortal: () => {} }).sceneRoot();
    expect(visibleText(root)).toContain('连接 Career Companion，一键填好申请表');
    expect(root?.querySelector('[data-action="login"]')?.textContent).toBe('登录 Career Companion');
  });

  it('每一张脸：面上没有码，也不再有页头的状态行与场景名', () => {
    for (const affordance of FACES) {
      const text = visibleText(home(affordance).sceneRoot());
      expect(text, JSON.stringify(affordance)).not.toMatch(CODE);
      expect(text, JSON.stringify(affordance)).not.toMatch(/THIS PAGE|已连接 Career Companion|未连接 Career Companion/);
    }
  });

  it('取不到规则：照实说判断不了，给「重新检查」，不说「未连接」', () => {
    let rechecked = 0;
    const handle = home({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' }, { onRecheck: () => { rechecked += 1; } });
    const text = visibleText(handle.sceneRoot());
    expect(text).toContain('暂时没法判断这一页能不能自动填写');
    expect(text).not.toContain('未连接');
    const recheck = handle.sceneRoot()?.querySelector<HTMLButtonElement>('[data-action="recheck"]');
    expect(recheck?.textContent).toBe('重新检查');
    class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
    recheck?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(rechecked).toBe(1);
  });
});

const row = (label: string, required: boolean, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required, done: state === 'CONFIRMED' || state === 'PRESERVED', state, ...extra,
});

const settle = (rows: readonly AutofillDockFieldRow[]): Handle => {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
  handle.openPanel();
  handle.beginPreparing();
  handle.beginRun({
    runId: 'fill-1',
    requiredQuestions: rows.filter((item) => item.required).length,
    requiredCompleted: rows.filter((item) => item.required && item.done).length,
    rows,
    phase: 'SETTLED',
  } as never);
  return handle;
};

describe('填完那一幕：总结在最前', () => {
  const ROWS: readonly AutofillDockFieldRow[] = [
    row('First Name', true, 'CONFIRMED', { value: 'Alex' }),
    row('Email', true, 'CONFIRMED', { value: 'alex@example.com' }),
    row('School', true, 'FAILED', { reason: 'NO_OPTION_MATCH', hint: 'University of California, Berkeley' }),
    row('Why do you want to work here?', true, 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
    row('Start date', true, 'UNVERIFIED', { value: '2026-10-01', reason: 'HOST_UNCONFIRMED' }),
    row('I agree to the privacy notice', true, 'CONFIRMED', { signedOnBehalf: 'TERMS_CONSENT' }),
    row('Website', false, 'PRESERVED', { reason: 'NOT_EMPTY' }),
    row('How did you hear about us?', false, 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE' }),
  ];

  it('岗位卡 → 总结 → 需要你 → 已按你的授权代填 → 其余已填好（收起）', () => {
    const root = settle(ROWS).sceneRoot();
    const main = root?.querySelector('.route-main');
    expect(main?.querySelector('.sum-title')?.textContent).toBe('还有 3 项需要你');
    expect(main?.querySelector('.sum-sub')?.textContent).toBe('已填好 4 项');
    const order = Array.from(main?.children ?? [])
      .filter((node) => (node as HTMLElement).style.display !== 'none' && !(node.classList.contains('fold') && (node as HTMLElement).dataset.open !== 'true'))
      .map((node) => node.classList.contains('job') ? 'job'
        : node.classList.contains('hero') ? 'summary'
        : node.classList.contains('fold') ? 'needs'
        : node.querySelector('.rest-toggle') !== null ? 'rest'
        : node.querySelector('[data-signed]') !== null ? 'signed' : node.className);
    expect(order).toEqual(['job', 'summary', 'needs', 'signed', 'rest']);
  });

  it('「需要你」只列必填项：列表里的行、总结里的数、进度条上橙色与珊瑚色的段，三者对得上', () => {
    const root = settle(ROWS).sceneRoot();
    const needs = Array.from(root?.querySelectorAll('[data-need-row] .need-q') ?? []).map((node) => node.textContent);
    expect(needs).toEqual(['School', 'Why do you want to work here?', 'Start date']);
    const colours = Array.from(root?.querySelectorAll<HTMLElement>('.seg') ?? []).map((node) => node.style.background);
    const loud = colours.filter((colour) => /255, 157, 77|255, 122, 107|FF9D4D|FF7A6B/i.test(colour));
    expect(loud).toHaveLength(3);
    const rest = root?.querySelector('.rest-toggle');
    expect(rest?.getAttribute('aria-expanded'), '其余默认收起').toBe('false');
    expect(Array.from(root?.querySelectorAll('.rrow .rq') ?? []).map((node) => node.textContent)).toEqual(['First Name', 'Email', 'Website']);
  });

  it('每行下面一句照着做的话，不写状态；按要做的事分组（2026-09-28）', () => {
    const root = settle(ROWS).sceneRoot();
    const byLabel = (label: string) => Array.from(root?.querySelectorAll('[data-need-row]') ?? [])
      .find((node) => node.querySelector('.need-q')?.textContent === label) as HTMLElement | undefined;
    const school = byLabel('School');
    expect(school?.querySelector('.need-why')?.textContent).toBe('选项里没有「University of California, Berkeley」，挑最接近的一个');
    expect(school?.dataset.kind).toBe('choose');
    expect(byLabel('Why do you want to work here?')?.dataset.kind).toBe('write');
    expect(byLabel('Start date')?.dataset.kind).toBe('check');
    expect(visibleText(root)).not.toMatch(/没填上|需要你来填/);
  });

  it('面上没有码（原因码、结局码都换成了人话）', () => {
    expect(visibleText(settle(ROWS).sceneRoot())).not.toMatch(CODE);
  });

  it('必填都填好了：没有「需要你」那一组；替不了用户按提交时主按钮照实写「去网站上提交」', () => {
    const handle = settle([row('First Name', true, 'CONFIRMED'), row('Email', true, 'CONFIRMED'), row('Website', false, 'MANUAL', { reason: 'LOW_CONFIDENCE' })]);
    const root = handle.sceneRoot();
    expect(root?.querySelector('.sum-title')?.textContent).toBe('必填项都填好了');
    expect(root?.querySelector<HTMLElement>('.fold')?.dataset.open).toBe('false');
    expect(handle.primaryButton()?.textContent).toBe('去网站上提交');
  });

  it('还有要你处理的：一颗主按钮「去第一项」（2026-09-28）', () => {
    expect(settle(ROWS).primaryButton()?.textContent).toBe('去第一项');
  });

  // 2026-09-24：附上简历之后网站自己从简历里读出来填上的必填栏——不是我们填的，也不是用户补的。
  // 它不进「需要你」，也不记成「你补上了」；在「其余已填好」里照实写来源。
  it('网站从简历里读的那一栏：不进「需要你」、不记成你补的，其余里照实写「网站从你的简历里读的」', () => {
    const root = settle([
      row('First Name', true, 'CONFIRMED', { value: 'Alex' }),
      row('Current Company', true, 'PRESERVED', { reason: 'NOT_EMPTY', fromResume: true }),
      row('Website', false, 'PRESERVED', { reason: 'NOT_EMPTY' }),
      row('Why do you want to work here?', true, 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
    ]).sceneRoot();
    const needs = Array.from(root?.querySelectorAll('[data-need-row] .need-q') ?? []).map((node) => node.textContent);
    expect(needs).toEqual(['Why do you want to work here?']);
    expect(root?.querySelector('.sum-sub')?.textContent).not.toContain('你补上了');
    const rest = new Map(Array.from(root?.querySelectorAll('.rrow') ?? []).map((node) =>
      [node.querySelector('.rq')?.textContent, node.querySelector('.rv')?.textContent]));
    expect(rest.get('Current Company')).toBe('网站从你的简历里读的');
    expect(rest.get('Website')).toBe('网页上已经有了，没有改动');
  });

  // 2026-09-24：按学历／工作经历推出来的答案（年满 18、「在这家公司工作过吗」）在「其余已填好」里照实写依据。
  it('推出来的答案：值后面写明依据（按你的学历／工作经历推断、经历里有没有这家公司）', () => {
    const root = settle([
      row('First Name', true, 'CONFIRMED', { value: 'Alex' }),
      row('Are you at least 18 years of age?', true, 'CONFIRMED', { value: 'Yes', historyBasis: 'ADULT_FROM_HISTORY' }),
      row('Have you ever worked for Acme?', true, 'CONFIRMED', { value: 'No', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' }),
      row('Have you previously been employed by Acme?', true, 'CONFIRMED', { value: 'Yes', historyBasis: 'EMPLOYER_IN_HISTORY' }),
      row('Are you currently employed by Acme?', true, 'CONFIRMED', { value: 'No', historyBasis: 'EMPLOYER_ENDED' }),
      row('Are you a transitioning service member?', true, 'CONFIRMED', { value: 'No', historyBasis: 'NO_MILITARY_SERVICE_IN_HISTORY' }),
    ]).sceneRoot();
    const rest = new Map(Array.from(root?.querySelectorAll('.rrow') ?? []).map((node) =>
      [node.querySelector('.rq')?.textContent, node.querySelector('.rv')?.textContent]));
    expect(rest.get('First Name')).toBe('Alex');
    expect(rest.get('Are you at least 18 years of age?')).toBe('Yes · 按你的学历／工作经历推断');
    expect(rest.get('Have you ever worked for Acme?')).toBe('No · 你的工作经历里没有这家公司');
    expect(rest.get('Have you previously been employed by Acme?')).toBe('Yes · 你的工作经历里有这家公司');
    expect(rest.get('Are you currently employed by Acme?')).toBe('No · 你在这家公司的那段经历已结束');
    expect(rest.get('Are you a transitioning service member?')).toBe('No · 你的工作经历里没有军队服役经历');
    expect([...rest.values()].join(' ')).not.toMatch(CODE);
  });

  // 2026-09-24 负责人决定（Mike：「就答是的」）：他有别国的工作许可记录、唯独没有岗位那一国的，工作授权按默认答（与
  // Jobright 一致）。这一行仍是我们填好的——算进「已填好」，不进「需要你」、不写「你已填好」——值后面照实写依据，
  // 请他提交前核对。
  it('按默认答的工作授权：算我们填好的，值后面写明哪一国没有记录、默认答了什么', () => {
    const AUTH = 'Are you legally authorized to work in the country in which this role is located?';
    const SPONSOR = 'Will you now or in the future require sponsorship for employment visa status?';
    const COMBINED = 'Are you at least 18 years old and legally authorized to work in the country where this role is located?';
    const CHECKBOX = 'Are you legally authorized to work in the country for which you applied?';
    const root = settle([
      row('First Name', true, 'CONFIRMED', { value: 'Alex', planned: true }),
      row(AUTH, true, 'CONFIRMED', { value: 'Yes', planned: true, defaultedWorkAuth: { region: '爱沙尼亚', sponsorship: false } }),
      row(SPONSOR, true, 'CONFIRMED', { value: 'No', planned: true, defaultedWorkAuth: { region: '爱沙尼亚', sponsorship: true } }),
      row(COMBINED, true, 'CONFIRMED', {
        value: 'Yes', planned: true, historyBasis: 'ADULT_FROM_HISTORY', defaultedWorkAuth: { region: '波兰', sponsorship: false },
      }),
      // 选项是勾选框的那一种：依据照样写，不因为只写「已勾选」就吞掉。
      row(CHECKBOX, true, 'CONFIRMED', { value: 'Yes', planned: true, checkbox: true, defaultedWorkAuth: { region: '爱沙尼亚', sponsorship: false } }),
    ]).sceneRoot();
    expect(root?.querySelector('.sum-title')?.textContent).toBe('必填项都填好了');
    expect(root?.querySelector<HTMLElement>('.fold')?.dataset.open, '不进「需要你」').toBe('false');
    // 2026-09-28：从默认收着的「其余已填好」挪到「提交前核对」，不点开也看得见；一行写值，一行写依据。
    const review = new Map(Array.from(root?.querySelectorAll('[data-review-row]') ?? []).map((node) =>
      [node.querySelector('.nq')?.textContent, `${node.querySelector('.nsign')?.textContent} | ${node.querySelector('.nr')?.textContent}`]));
    expect(review.get(AUTH)).toBe('Yes | 你的资料里没有在爱沙尼亚工作的许可记录，默认答了「是」，提交前请核对');
    expect(review.get(SPONSOR)).toBe('No | 你的资料里没有在爱沙尼亚工作的许可记录，默认答了「不需要担保」，提交前请核对');
    expect(review.get(COMBINED)).toBe('Yes · 按你的学历／工作经历推断 | 你的资料里没有在波兰工作的许可记录，默认答了「是」，提交前请核对');
    expect(review.get(CHECKBOX)).toBe('已勾选 | 你的资料里没有在爱沙尼亚工作的许可记录，默认答了「是」，提交前请核对');
    expect(root?.querySelector('[data-review="group"] .grp-count')?.textContent).toBe('4');
    const rest = new Map(Array.from(root?.querySelectorAll('.rrow') ?? []).map((node) =>
      [node.querySelector('.rq')?.textContent, node.querySelector('.rv')?.textContent]));
    expect([...rest.keys()], '其余里只剩没什么要核对的那一行').toEqual(['First Name']);
    expect(visibleText(root)).not.toContain('你已填好');
    expect([...review.values()].join(' ')).not.toMatch(CODE);
  });

  // 2026-09-24：Workday 的技能一栏收好几项，一页的技能搜索最多 8 秒（负责人：一页的答案 15 秒内）。没加上的几项
  // 带着稳定原因码交过来，浮层按原因分组列出来：不点开也看得见，面上没有码。2026-09-28 起挂在那一行上（「提交前核对」，
  // 一项都没加上的必填栏在「需要你」），总结下面不再另起一行。
  describe('搜索式多选没加上的几项：挂在那一行上，按原因分组', () => {
    const SKILLS = 'Type to Add Skills';
    const reviewRow = (root: Element | null | undefined) => root?.querySelector<HTMLElement>('[data-review-row]') ?? null;

    it('加上了一部分：「提交前核对」里写加上的那几项，下面列出没加上的与原因（时间用完的说没来得及）', () => {
      const root = settle([
        row('First Name', true, 'CONFIRMED', { value: 'Alex', planned: true }),
        row(SKILLS, false, 'CONFIRMED', {
          value: 'PyTorch\nTensorFlow\nKubernetes\nPython\nSQL',
          planned: true,
          notAdded: [
            { value: 'Python', reason: 'AMBIGUOUS_OPTION' },
            { value: 'TensorFlow', reason: 'ABORTED' },
            { value: 'Kubernetes', reason: 'ABORTED' },
          ],
        }),
      ]).sceneRoot();
      const skills = reviewRow(root);
      expect(skills?.querySelector('.nq')?.textContent).toBe(SKILLS);
      expect(skills?.querySelector('.nsign')?.textContent, '只写加上的那几项，一项一个顿号').toBe('PyTorch、SQL');
      expect(skills?.querySelector('.nr')?.textContent).toBe('没加上：Python（有几个选项都可能对）；TensorFlow、Kubernetes（这一页的搜索时间用完了，没来得及）');
      expect(visibleText(root)).toContain('没加上：Python');
      expect(root?.querySelector('.sum-notes')?.textContent, '总结下面不再另起一行').toBe('');
      expect(visibleText(root)).not.toMatch(CODE);
    });

    it('一项都没加上的必填栏：「需要你」那一行的原因就是这份清单', () => {
      const root = settle([
        row(SKILLS, true, 'FAILED', { reason: 'AMBIGUOUS_OPTION', planned: true, notAdded: [{ value: 'Python', reason: 'AMBIGUOUS_OPTION' }] }),
      ]).sceneRoot();
      const skills = Array.from(root?.querySelectorAll('[data-need-row]') ?? []).find((node) => node.querySelector('.need-q')?.textContent === SKILLS);
      expect(skills?.querySelector('.need-why')?.textContent).toBe('没加上：Python（有几个选项都可能对）');
      expect(reviewRow(root)).toBeNull();
      expect(visibleText(root)).not.toMatch(CODE);
    });

    it('全都加上了：没有这一行，其余里照顺序列出每一项', () => {
      const root = settle([row(SKILLS, false, 'CONFIRMED', { value: 'PyTorch\nSQL', planned: true })]).sceneRoot();
      expect(reviewRow(root)).toBeNull();
      const rest = new Map(Array.from(root?.querySelectorAll('.rrow') ?? []).map((node) =>
        [node.querySelector('.rq')?.textContent, node.querySelector('.rv')?.textContent]));
      expect(rest.get(SKILLS)).toBe('PyTorch、SQL');
    });
  });

  // 2026-09-24 协调方跟进：「其余已填好」默认收着，逐行的那句依据要展开才看得见。2026-09-28 起这几行挪到「提交前核对」：
  // 不点开也看得见，一行一题，写明答了什么、哪一国没有记录。
  describe('按默认答的工作授权：在「提交前核对」里一行一题，不点开也看得见', () => {
    const AUTH = 'Are you legally authorized to work in the country in which this role is located?';
    const SPONSOR = 'Will you now or in the future require sponsorship for employment visa status?';
    const defaulted = (label: string, region: string, sponsorship: boolean, state: AutofillDockFieldRow['state'] = 'CONFIRMED', extra: Partial<AutofillDockFieldRow> = {}) =>
      row(label, true, state, { value: sponsorship ? 'No' : 'Yes', planned: true, defaultedWorkAuth: { region, sponsorship }, ...extra });
    const review = (root: Element | null | undefined) => new Map(Array.from(root?.querySelectorAll('[data-review-row]') ?? []).map((node) =>
      [node.querySelector('.nq')?.textContent, node.querySelector('.nr')?.textContent]));

    it('一道：答了「是」、哪一国；不用展开「其余已填好」', () => {
      const root = settle([row('First Name', true, 'CONFIRMED', { value: 'Alex', planned: true }), defaulted(AUTH, '爱沙尼亚', false)]).sceneRoot();
      expect(review(root).get(AUTH)).toBe('你的资料里没有在爱沙尼亚工作的许可记录，默认答了「是」，提交前请核对');
      expect(visibleText(root)).toContain('默认答了「是」');
      expect(root?.querySelector('.rest-toggle')?.getAttribute('aria-expanded'), '「其余已填好」仍收着').toBe('false');
    });

    it('只有担保题：答的是「不需要担保」', () => {
      const root = settle([defaulted(SPONSOR, '爱沙尼亚', true)]).sceneRoot();
      expect(review(root).get(SPONSOR)).toBe('你的资料里没有在爱沙尼亚工作的许可记录，默认答了「不需要担保」，提交前请核对');
    });

    it('几道、几国：一题一行，各写各的那一国', () => {
      const root = settle([
        defaulted(AUTH, '爱沙尼亚', false),
        defaulted(SPONSOR, '爱沙尼亚', true),
        defaulted('Are you legally authorized to work in Poland?', '波兰', false),
        defaulted('Will you require sponsorship to work in Japan?', '日本', true),
      ]).sceneRoot();
      expect(review(root).size).toBe(4);
      expect(review(root).get('Will you require sponsorship to work in Japan?')).toBe('你的资料里没有在日本工作的许可记录，默认答了「不需要担保」，提交前请核对');
    });

    it('写进了网页但网站没确认的也算；没写成的、网页上本来就有的不算；一道都没有就没有这一组', () => {
      const root = settle([
        defaulted(AUTH, '爱沙尼亚', false, 'UNVERIFIED', { reason: 'HOST_UNCONFIRMED' }),
        defaulted(SPONSOR, '爱沙尼亚', true, 'FAILED', { reason: 'WRITE_REVERTED' }),
        defaulted('Are you legally authorized to work in Poland?', '波兰', false, 'PRESERVED', { reason: 'NOT_EMPTY' }),
      ]).sceneRoot();
      expect([...review(root).keys()]).toEqual([AUTH]);
      const none = settle([row('First Name', true, 'CONFIRMED', { value: 'Alex', planned: true }), row(AUTH, true, 'CONFIRMED', { value: 'Yes', planned: true })]).sceneRoot();
      expect(review(none).size).toBe(0);
      expect(visibleText(none)).not.toContain('按默认答');
    });
  });

  it('以你的名义同意的六类（2026-09-24）：逐条写「已替你同意：…」，与条款、签名一起数进「已按你的授权代填」', () => {
    const signed = [
      ['Do you consent to AI note-taking during interviews?', 'AI_RECORDING_CONSENT', '已替你同意：AI 面试记录'],
      ['I agree to receive text messages about my application.', 'SMS_CONSENT', '已替你同意：短信通知'],
      ['Join our talent community', 'FUTURE_CONTACT_CONSENT', '已替你同意：日后联系'],
      ['I would like to receive marketing emails.', 'MARKETING_CONSENT', '已替你同意：营销信息'],
      ['Do you consent to a background check?', 'BACKGROUND_CHECK_CONSENT', '已替你同意：背景调查授权'],
      ['Agreement to Arbitrate', 'ARBITRATION_AGREEMENT', '已替你同意：仲裁协议'],
    ] as const;
    const root = settle([
      row('First Name', true, 'CONFIRMED'),
      row('I agree to the privacy notice', true, 'CONFIRMED', { signedOnBehalf: 'TERMS_CONSENT' }),
      ...signed.map(([label, kind]) => row(label, true, 'CONFIRMED', { signedOnBehalf: kind })),
    ]).sceneRoot();
    const lines = Array.from(root?.querySelectorAll('[data-signed]') ?? [])
      .map((node) => [node.querySelector('.nq')?.textContent, node.querySelector('.nsign')?.textContent]);
    expect(lines).toEqual([
      ['I agree to the privacy notice', '已替你同意条款'],
      ...signed.map(([label, , copy]) => [label, copy]),
    ]);
    expect(visibleText(root)).toContain('已按你的授权代填');
    expect(visibleText(root)).not.toMatch(CODE);
  });
});

describe('没能开始', () => {
  it('一项都没填就停下：失败卡与「再试一次」，码收在默认折叠的「技术细节」里', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.openPanel();
    handle.beginPreparing();
    handle.reportBlocked('NO_FORM_FOUND');
    const root = handle.sceneRoot();
    expect(root?.querySelector('.failed .face-title')?.textContent).toBe('这一轮没有完成');
    expect(root?.querySelector('[data-action="retry"]')?.textContent).toBe('再试一次');
    expect(root?.querySelector('.tech-code')?.textContent).toContain('NO_FORM_FOUND');
    expect(visibleText(root)).not.toMatch(CODE);
  });

  it('连不上 Career Companion：说连不上，不说「原因未知」', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.openPanel();
    handle.beginPreparing();
    handle.reportBlocked('AUTHORITY_UNAVAILABLE');
    expect(handle.sceneRoot()?.querySelector('.failed .face-title')?.textContent).toBe('暂时连不上 Career Companion');
  });

  it('填过一些再停下（超时）：总结写「填写已停止」', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.openPanel();
    handle.beginPreparing();
    handle.beginRun({ runId: 'fill-1', requiredQuestions: 1, requiredCompleted: 1, rows: [row('First Name', true, 'CONFIRMED')] });
    handle.finishRun({ started: true, outcome: 'TIMED_OUT' });
    const root = handle.sceneRoot();
    expect(root?.querySelector('.sum-title')?.textContent).toBe('填写已停止');
    expect(root?.querySelector('.sum-sub')?.textContent).toBe('已填好 1 项，其余的请在网站上完成。');
  });
});
