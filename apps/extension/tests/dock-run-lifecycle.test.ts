// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, parseDockRunReply, parseDockRunStep, type AutofillDockProgress } from '../lib/autofillDock';

/**
 * A run on the dock, from the click to the worker's last word.
 *
 * Until now the dock learned about a run only when a field settled. The user
 * pressed Autofill and, for the seconds before the first field — or forever,
 * when the worker refused the page — watched nothing happen. The run scene now
 * owns that whole span: it opens on the click, names the step the worker is
 * on, shows the rows as they settle, and ends with the outcome, whatever it was.
 */
const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
const rows = (runId: string, done: boolean): AutofillDockProgress => ({
  runId, requiredCompleted: done ? 1 : 0, requiredQuestions: 1,
  rows: [{ label: 'Full name', required: true, done, state: done ? 'CONFIRMED' : 'WRITING' }],
});
const text = (handle: ReturnType<typeof mountAutofillDock>) => handle.sceneRoot()?.textContent ?? '';
/** 用户不点开任何折叠时看得到的字：收起的「技术细节」、display:none、收着的菜单都不算。 */
const visibleText = (handle: ReturnType<typeof mountAutofillDock>): string => {
  const root = handle.sceneRoot();
  if (root == null) return '';
  const copy = root.cloneNode(true) as Element;
  for (const hidden of Array.from(copy.querySelectorAll('[style*="display: none"], [hidden], .tech:not([data-open="true"]) .tech-body, .pop:not([data-open="true"])'))) hidden.remove();
  return copy.textContent ?? '';
};
/** 我们内部的码长这样：大写加下划线。用户看得到的地方一个都不该有（2026-09-23）。 */
const CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

describe('a run on the dock', () => {
  it('opens the run scene on the click and says it is checking, before any field is known', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    expect(handle.isOpen()).toBe(true);
    expect(handle.scene()).toBe('AUTOFILL');
    expect(handle.runState()).toBe('PREPARING');
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    expect(handle.sheetFace()).toBe('WORKING');
    // 2026-09-23 新浮层：主卡变成深色的进度卡；2026-09-28 起状态行说此刻在做什么（「正在读表单」）。
    expect(text(handle)).toContain('正在读表单');
    expect(handle.reviewButtons(), 'nothing to press yet').toEqual({ edit: null, fill: null });
  });
  it('names the step the worker reports, in words and never in numbers', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.setStep('SCANNING');
    expect(text(handle)).toContain('正在读表单');
    handle.setStep('FILLING');
    expect(text(handle)).toContain('正在填写');
    expect(handle.summaryText(), 'no count is invented from a step').toBe('正在准备…');
  });
  it('shows the rows as they settle, then the outcome once the worker has spoken', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.beginRun(rows('fill-1', false));
    expect(handle.runState()).toBe('RUNNING');
    expect(text(handle)).toContain('正在填写');
    handle.update({ ...rows('fill-1', true), phase: 'SETTLED' } as never);
    expect(handle.runState()).toBe('SETTLED');
    expect(text(handle)).toContain('必填项都填好了');
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(handle.runState()).toBe('SETTLED');
    expect(handle.reviewButtons().fill, '「重新填写这一页」在 ··· 菜单里').not.toBeNull();
    // 全部填好：主按钮是「提交」（负责人 2026-09-23：插件替用户点提交）；这里没接提交，照实写「去网站上提交」。
    expect(handle.primaryButton()?.textContent).toBe('去网站上提交');
  });
  it('says why when the worker refuses the page, instead of leaving the button dead', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.finishRun({ started: false, code: 'NO_MISSION_FOR_PAGE' });
    expect(handle.runState()).toBe('STOPPED');
    expect(handle.sheetFace()).toBe('COMPLETE');
    expect(text(handle)).toContain('这一轮没有完成');
    expect(text(handle)).toContain('这个岗位暂时不能自动填写');
    expect(handle.sceneRoot()?.querySelector('[data-action="retry"]'), 'the way to try again is offered').not.toBeNull();
  });
  it('keeps a blocked report even when the receipt that follows says the run finished', () => {
    // A policy-disabled build runs the whole chain and writes nothing; the
    // coordinator still uploads a receipt and the worker still answers FILLED.
    // The dock said why nothing was written, and that must not turn into
    // "1 项已核对" a moment later.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.reportBlocked('POLICY_DISABLED');
    expect(handle.runState()).toBe('STOPPED');
    expect(text(handle)).toContain('这个版本的插件暂时填不了这一页');
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(handle.runState()).toBe('STOPPED');
    expect(text(handle)).toContain('这个版本的插件暂时填不了这一页');
  });
  it('reports a stop, a timeout and a hand-back to the user with their own words', () => {
    const doc = document.implementation.createHTMLDocument();
    for (const [outcome, expected] of [
      [{ started: true, outcome: 'TIMED_OUT' }, '还没确认填写结果'],
      [{ started: true, outcome: 'STOPPED', code: 'INTENT_REJECTED' }, '这次申请已经过期了'],
      [{ started: true, outcome: 'NEEDS_USER_INPUT' }, '剩下的问题需要你在网站上完成'],
      [{ started: false, code: 'WORKER_UNREACHABLE' }, '插件没有响应'],
    ] as const) {
      const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
      handle.beginPreparing();
      handle.finishRun(outcome);
      expect(text(handle), JSON.stringify(outcome)).toContain(expected);
      handle.dismiss();
    }
  });
  it('a second click starts over: the previous run\'s rows leave with it', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.beginRun(rows('fill-1', true));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    handle.beginPreparing();
    expect(handle.runState()).toBe('PREPARING');
    expect(handle.fieldRows('required')).toEqual([]);
    handle.update(rows('fill-2', false));
    expect(handle.fieldRows('required').map((row) => row.label)).toEqual(['Full name']);
    expect(handle.runState()).toBe('RUNNING');
  });
  it('minimises to the launcher and comes back, keeping the run; the launcher carries the run\'s own line', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.beginRun(rows('fill-1', false));
    handle.toggleSheet();
    expect(handle.isOpen()).toBe(false);
    expect(handle.sheetState()).toBe('AUTOFILL_STICKY_COLLAPSED');
    expect(handle.launcherButton()?.textContent, '收起时按钮上写着进度').toContain('正在填写 1/1');
    handle.toggleSheet();
    expect(handle.isOpen()).toBe(true);
    expect(handle.scene()).toBe('AUTOFILL');
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    expect(handle.fieldRows('required')).toHaveLength(1);
  });
  it('never grows a run on a face that is only explaining itself', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'GUIDANCE', guidance: 'NO_FORM_FOUND' }, handlers, doc);
    handle.beginPreparing();
    handle.finishRun({ started: false, code: 'NO_MISSION_FOR_PAGE' });
    expect(handle.sheetState()).toBe('ABSENT');
    expect(handle.scene()).toBe('HOME');
  });
});

describe('the worker\'s replies, parsed at the boundary', () => {
  it.each([
    [{ started: true, outcome: 'FILLED' }, { started: true, outcome: 'FILLED' }],
    [{ started: true, outcome: 'STOPPED', code: 'RUN_ABORTED' }, { started: true, outcome: 'STOPPED', code: 'RUN_ABORTED' }],
    [{ started: false, code: 'NO_MISSION_FOR_PAGE' }, { started: false, code: 'NO_MISSION_FOR_PAGE' }],
    // A refusal without a nameable code is still a refusal.
    [{ started: false, code: 'lower case' }, { started: false, code: 'RUN_UNAVAILABLE' }],
  ])('accepts %o', (reply, expected) => {
    expect(parseDockRunReply(reply)).toEqual(expected);
  });
  it.each([undefined, null, 'FILLED', { started: true }, { started: true, outcome: 'SUBMITTED' }, { outcome: 'FILLED' }])(
    'refuses a shape it cannot name: %o', (reply) => { expect(parseDockRunReply(reply)).toBeNull(); },
  );
  it('takes only the six steps the coordinator names', () => {
    expect(parseDockRunStep({ kind: 'dock/run-progress', step: 'SCANNING' })).toBe('SCANNING');
    expect(parseDockRunStep({ kind: 'dock/run-progress', step: 'SUBMITTING' })).toBeNull();
    expect(parseDockRunStep({ kind: 'bridge/hello', step: 'SCANNING' })).toBeNull();
    expect(parseDockRunStep(null)).toBeNull();
  });
});

class TrustedClickForAction extends MouseEvent { get isTrusted() { return true; } }

describe('白标 C：没有表单的落地页', () => {
  it('扫不出表单但页面上有「申请表在哪」时，停止态多一颗「打开申请表」，真点击才触发', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    let opened = 0;
    handle.reportBlocked('ROOT_NOT_FOUND', { kind: 'OPEN_APPLICATION_FORM', onClick: () => { opened += 1; } });
    expect(handle.runState()).toBe('STOPPED');
    expect(text(handle)).toContain('打开申请表');
    const button = Array.from(handle.sceneRoot()?.querySelectorAll('button') ?? [])
      .find((candidate) => candidate.textContent === '打开申请表');
    expect(button).toBeDefined();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened, '页面派发的点击不算').toBe(0);
    button?.dispatchEvent(new TrustedClickForAction('click', { bubbles: true }));
    expect(opened).toBe(1);
    // 没带动作的停止态没有这颗按钮。
    handle.beginPreparing();
    handle.reportBlocked('ROOT_NOT_FOUND');
    expect(text(handle)).not.toContain('打开申请表');
  });
});

describe('码不给用户看，但我们要定位时拿得到（2026-09-23 改；原先 09-21 是把码直接列在结语下面）', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('早期拒绝：码收进总结里默认折叠的「技术细节」，折叠之外一个码都不露', async () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, {
      ...handlers,
      recentDiagnostics: async () => ['RUNTIME_AUTHORITY_UNAVAILABLE', 'not a code', 'RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY'],
    }, doc);
    handle.beginPreparing();
    handle.reportBlocked('AUTHORITY_UNAVAILABLE');
    expect(text(handle)).toContain('暂时连不上 ArgoLand');
    await tick();
    const tech = handle.sceneRoot()?.querySelector<HTMLElement>('.tech');
    expect(tech, '早期拒绝没有审计区，码只能在这里拿到').not.toBeNull();
    expect(tech?.dataset.open, '默认折叠').toBe('false');
    expect(tech?.querySelector('.tech-toggle')?.textContent).toBe('技术细节');
    expect(tech?.querySelector('.tech-code')?.textContent)
      .toMatch(/^AUTHORITY_UNAVAILABLE · RUNTIME_AUTHORITY_UNAVAILABLE · RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY · /);
    expect(visibleText(handle), '折叠之外一个码都不露').not.toMatch(CODE);
    // 简历那句说的是填写的事，而这一轮一项都没填：码进「技术细节」，话不挂（认得的码怎么说成人话见下面跑完的那一轮）。
    expect(text(handle)).not.toContain('简历没附上');
    expect(text(handle), '不合形状的字符串一个都不进面板').not.toContain('not a code');

    const quiet = mountAutofillDock({ kind: 'READY' }, { ...handlers, recentDiagnostics: async () => [] }, doc);
    quiet.beginPreparing();
    quiet.reportBlocked('AUTHORITY_UNAVAILABLE');
    await tick();
    expect(quiet.sceneRoot()?.querySelector('.tech .tech-code')?.textContent, '没有诊断码时只有这一轮的码（再加时间）').toMatch(/^AUTHORITY_UNAVAILABLE · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('三个早期拒绝各有各的句子，不再共用「填写服务暂不可用」', () => {
    for (const [code, fragment] of [
      ['AUTHORITY_UNAVAILABLE', '暂时连不上 ArgoLand'],
      ['RUNTIME_UNRESOLVED', '这一页暂时填不了'],
      ['RUN_FAILED', '填写中途出了问题'],
    ] as const) {
      const doc = document.implementation.createHTMLDocument();
      const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
      handle.beginPreparing();
      handle.reportBlocked(code);
      expect(text(handle), code).toContain(fragment);
    }
  });

  it('每一个结局码、再加一个表里没有的码：面上都是人话，没有码', () => {
    for (const code of ['NO_MISSION_FOR_PAGE', 'AUTHORITY_UNAVAILABLE', 'RUNTIME_UNRESOLVED', 'RUN_FAILED', 'WORKER_UNREACHABLE',
      'POLICY_DISABLED', 'NO_FORM_FOUND', 'PATH_NOT_APPLY', 'APPLY_FORM_NOT_OPENED', 'NOT_SEALABLE', 'GESTURE_UNTRUSTED',
      'CAPABILITY_DISABLED', 'PLAN_STALE', 'INTENT_REJECTED', 'RUNTIME_BUNDLE_RELEASE_COLLISION', 'RUN_FAILED:SCAN_TIMEOUT']) {
      const doc = document.implementation.createHTMLDocument();
      const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
      handle.beginPreparing();
      handle.reportBlocked(code);
      expect(visibleText(handle), code).not.toMatch(CODE);
      expect(visibleText(handle), code).not.toContain(code.split(':')[0]);
    }
  });

  it('失败行的原因码没有文案时：不露代号，也不在状态后面再重复一遍「需要你来填」', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    // 内核今天的每个码都有文案（dock-unconfirmed-rows 锁着）；这里用一个表里没有的码，
    // 钉的是「将来新码漏了文案」时的样子。
    handle.beginRun({
      runId: 'fill-2', requiredCompleted: 0, requiredQuestions: 1, phase: 'SETTLED',
      rows: [{ label: 'First Name', required: true, done: false, state: 'FAILED', reason: 'SOME_FUTURE_CODE' }],
    } as never);
    expect(text(handle)).not.toContain('SOME_FUTURE_CODE');
    expect(text(handle)).not.toContain('需要你来填');
    expect(handle.sceneRoot()?.querySelector('[data-need-row] .need-why')?.textContent, '没有句子可说就什么都不补').toBe('');
  });
});

describe('跑完之后简历没附上、读不到保存的答案：说明挂在它说的那一行上', () => {
  it('EEO 读不到与简历版本未就绪各有一句人话；码不露在面上', async () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, {
      ...handlers,
      recentDiagnostics: async () => ['EEO_ANSWERS_FETCH_FAILED_HTTP_503', 'RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY'],
    }, doc);
    handle.beginPreparing();
    handle.beginRun({
      runId: 'fill-3', requiredCompleted: 1, requiredQuestions: 3, phase: 'SETTLED',
      rows: [
        { label: 'Full name', required: true, done: true, state: 'CONFIRMED' },
        { label: 'Resume/CV', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'NO_VALUE', attachment: true },
        { label: 'Gender', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'MANUAL_ONLY', selfIdentification: true },
      ],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = text(handle);
    const why = (label: string) => [...(handle.sceneRoot()?.querySelectorAll('[data-need-row]') ?? [])]
      .find((node) => node.querySelector('.need-q')?.textContent === label)?.querySelector('.need-why')?.textContent;
    expect(why('Gender')).toBe('暂时读不到你保存的答案，在这一栏选一下就好');
    expect(why('Resume/CV')).toContain('简历没附上：这一版还没有 PDF');
    expect(handle.sceneRoot()?.querySelector('.sum-notes')?.textContent, '都挂上了，总结下面不再另起一行').toBe('');
    // 跑完的那一轮没有失败卡，也就没有「技术细节」。
    expect(handle.sceneRoot()?.querySelector('.tech')).toBeNull();
    expect(shown).not.toMatch(CODE);
  });
});

describe('结语说明附的是哪一版简历', () => {
  it.each([
    ['RESUME_ATTACHMENT_PREPARED_FOR_JOB', '为这个岗位改过的那一版'],
    ['RESUME_ATTACHMENT_DEFAULT_VERSION', '你的默认简历'],
  ])('%s → %s', async (code, fragment) => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { ...handlers, recentDiagnostics: async () => [code] }, doc);
    handle.beginPreparing();
    // 有一栏是附件、而且还有要你处理的：总结的副标题写附的是哪一版。
    handle.beginRun({
      runId: 'fill-4', requiredCompleted: 1, requiredQuestions: 2, phase: 'SETTLED',
      rows: [
        { label: 'Resume/CV', required: true, done: true, state: 'CONFIRMED', attachment: true },
        { label: 'Why us?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY' },
      ],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(text(handle)).toContain(fragment);
  });
});
