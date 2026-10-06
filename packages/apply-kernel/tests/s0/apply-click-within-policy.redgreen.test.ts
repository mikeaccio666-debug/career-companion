import { collectClickFacts } from '../../src/click/facts';
import { createScanRoot } from '../../src/scanRoot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { evaluateClickTarget } from '../../src/click/policy';
import {
  MAX_HOST_CLICKS_PER_AUTHORITY,
  activateReviewedChoiceGroup,
  clickHostTarget,
} from '../../src/click/primitives';
import {
  executeFillOnlySemanticWrite,
  type FillOnlyHostWriteAuthority,
} from '../../src/write/fillOnlySemantic';
import { consumeAuthority, type WriteCapability } from '../../src/grant';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';
import { createUndoJournal } from '../../src/undo';

/**
 * S0 · 宿主点击必须全部经过 policy。
 *
 * 这条闸门取代了「零宿主点击」在已放开的那部分范围内的作用。哪些控件在范围内，
 * 见 16 号裁决授权卡 A 栏。本文件先于点击实现落地，因为裁决要求
 * "a red/green test change before code"。
 *
 * 它锁的不是"不点"，而是**"只点 policy 说可以点的"**：
 *   - 所有宿主点击只能走 `clickHostTarget` 这一个出口；
 *   - 该出口对每个目标调用 `evaluateClickTarget`，拒绝即不点、返回错误码；
 *   - 提交 / 下一步 / 同意条款 / 密码 / CAPTCHA / 文件对话框 / 隐藏控件
 *     一律 hard deny，不受任何配置影响。
 *
 * `apply-never-submits.redgreen.test.ts` 仍然独立存在且不放开——那条永不解禁。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * An authority that is *active*, i.e. inside a run. `clickHostTarget` uses the
 * same `checkActiveCapability` predicate as the text/select writers, so a
 * merely-minted authority is rejected as untrusted — that is the property
 * stopping a captured authority object from being replayed later, and the
 * reason this helper exists rather than passing `testAuthority` directly.
 */
function activeAuthority(capabilities: readonly WriteCapability[]) {
  const authority = testAuthority(null, 'fill', capabilities);
  const consumed = consumeAuthority(authority);
  expect(consumed.ok, '测试前置：授权没能进入运行态').toBe(true);
  return authority;
}

function target(html: string): HTMLElement {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  return document.querySelector('[data-t]') as HTMLElement;
}

function targetRoot() {
  return createScanRoot(document.querySelector('#application-form')!, [], []);
}

/**
 * Facts an eligible, planned combobox option would carry.
 *
 * 走**真实的采集器**而不是手搓：`REQUIRED_FACTS_BY_KIND` 要求事实齐全
 * （缺席的事实是 `undefined`，等于对应的 deny 这次不跑），而这条 S0 红证
 * 锁的正是「宿主点击只走 policy 批准的路径」——用一份偏食的手搓事实集去锁它，
 * 锁到的是一个比真实执行宽松的策略。顺带端到端证明采集器产出的事实是齐的。
 */
function allowedFacts(element: Element = document.querySelector('[data-t]')!) {
  return collectClickFacts({
    element,
    root: targetRoot(),
    kind: 'transaction-option',
    planned: true,
    openedByTransaction: true,
  });
}

describe('S0 · 宿主点击只走 policy 批准的路径', () => {
  it('policy 允许时才真的点击（正对照，否则以下断言全是空转）', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const clicked: string[] = [];
    element.addEventListener('click', () => clicked.push('click'));

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: { ...allowedFacts(), role: 'option', tagName: 'LI' },
      authority: activeAuthority(['set-combobox']),
      ticket: createUndoJournal().record(document.createElement('input')),
      policy: testApplyPolicy(),
    });

    expect(result.ok, `policy 应放行，却拒绝了：${result.ok ? '' : result.code}`).toBe(true);
    expect(clicked, '声称点了却没有真的派发 click').toEqual(['click']);
  });

  it('fails before click when mousedown mutates a planned control into submit', () => {
    const element = target('<input type="text" role="combobox" data-t />') as HTMLInputElement;
    const hostForm = document.querySelector('form')!;
    const submissions: Event[] = [];
    hostForm.addEventListener('submit', (event) => submissions.push(event));
    element.addEventListener('mousedown', () => {
      element.type = 'image';
    }, { once: true });

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: {
        ...allowedFacts(element),
        kind: 'combobox-trigger',
        openedByTransaction: false,
        tagName: 'INPUT',
        inputType: 'text',
      },
      authority: activeAuthority(['set-combobox']),
      ticket: createUndoJournal().record(element),
      policy: testApplyPolicy(),
    });

    expect(result).toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(submissions).toEqual([]);
  });

  it.each(['requestSubmit', 'submit'] as const)(
    'does not dispatch a pointer sequence that lets a FILL-only host listener call form.%s()',
    (submissionMethod) => {
      const element = target('<input type="text" role="combobox" data-t />') as HTMLInputElement;
      const hostForm = document.querySelector('form')!;
      const submissionAttempt = vi.fn();
      element.addEventListener('mousedown', () => {
        submissionAttempt();
        if (submissionMethod === 'requestSubmit') hostForm.requestSubmit();
        else hostForm.submit();
      });

      const result = clickHostTarget({
        element,
        root: targetRoot(),
        facts: {
          ...allowedFacts(element),
          kind: 'combobox-trigger',
          openedByTransaction: false,
          tagName: 'INPUT',
          inputType: 'text',
        },
        authority: activeAuthority(['set-combobox']),
        ticket: createUndoJournal().record(element),
        policy: {
          ...testApplyPolicy(),
          capabilities: {
            ...testApplyPolicy().capabilities,
            'set-combobox': false,
          },
        },
      });

      expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
      expect(submissionAttempt).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['最终提交', '<button type="submit" data-t>Submit application</button>', 'submit'],
    ['下一步', '<button data-t>Continue</button>', 'next'],
    ['同意条款', '<input type="checkbox" data-t aria-label="I agree to the terms" />', 'consent'],
    ['文件对话框', '<input type="file" data-t />', 'file'],
    ['链接', '<a href="/x" data-t>Apply elsewhere</a>', 'link'],
  ])('%s 永远不点', (_name, html) => {
    const element = target(html);
    const nativeClick = vi.spyOn(HTMLElement.prototype, 'click');
    const seen: string[] = [];
    element.addEventListener('click', () => seen.push('click'), true);

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: {
        ...allowedFacts(),
        kind: 'other',
        planned: false,
        openedByTransaction: false,
        tagName: element.tagName,
        buttonType: element.getAttribute('type'),
        inputType: (element as HTMLInputElement).type,
        hasHref: element.hasAttribute('href'),
        opensFileDialog: (element as HTMLInputElement).type === 'file',
        accessibleName: element.getAttribute('aria-label') ?? element.textContent ?? '',
        labelText: element.getAttribute('aria-label') ?? element.textContent ?? '',
      },
      authority: activeAuthority(['set-combobox']),
      ticket: createUndoJournal().record(document.createElement('input')),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(seen, '被拒绝的目标仍然收到了 click').toEqual([]);
    expect(nativeClick, '被拒绝的目标仍然调用了 HTMLElement.click()').not.toHaveBeenCalled();
  });

  it('缺少 set-combobox 能力时不点（能力位是硬闸门）', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const seen: string[] = [];
    element.addEventListener('click', () => seen.push('click'));

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: { ...allowedFacts(), role: 'option', tagName: 'LI' },
      // 只有写文本的能力，没有下拉能力。
      authority: activeAuthority(['set-text']),
      ticket: createUndoJournal().record(document.createElement('input')),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('CAPABILITY_DISABLED');
    expect(seen).toEqual([]);
  });

  it('远程 policy 关闭 set-combobox 时即使 authority 曾授权也不点', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const seen: string[] = [];
    element.addEventListener('click', () => seen.push('click'));
    const baseline = testApplyPolicy();

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: { ...allowedFacts(), role: 'option', tagName: 'LI' },
      authority: activeAuthority(['set-combobox']),
      ticket: createUndoJournal().record(document.createElement('input')),
      policy: {
        ...baseline,
        capabilities: { ...baseline.capabilities, 'set-combobox': false },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('CAPABILITY_DISABLED');
    expect(seen).toEqual([]);
  });

  /**
   * 撤销日志不可用时绝不点击。铁律 3 的例外条件是"每次写入必须先记录原值"，
   * 点击会让宿主控件产生一个我们无法还原的值——没有 ticket 就等于没有退路。
   */
  it('拿不到 undo ticket 时不点', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const seen: string[] = [];
    element.addEventListener('click', () => seen.push('click'));

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: { ...allowedFacts(), role: 'option', tagName: 'LI' },
      authority: activeAuthority(['set-combobox']),
      ticket: { ok: false, code: 'JOURNAL_UNAVAILABLE' },
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('JOURNAL_UNAVAILABLE');
    expect(seen, '没有退路却仍然点了宿主控件').toEqual([]);
  });

  /** 运行时 kill switch 关掉后，点击必须和写入一样立刻停止。 */
  it('policy 被关闭时不点', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const seen: string[] = [];
    element.addEventListener('click', () => seen.push('click'));

    const result = clickHostTarget({
      element,
      root: targetRoot(),
      facts: { ...allowedFacts(), role: 'option', tagName: 'LI' },
      authority: activeAuthority(['set-combobox']),
      ticket: createUndoJournal().record(document.createElement('input')),
      policy: { ...testApplyPolicy(), enabled: false },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('POLICY_DISABLED');
    expect(seen, 'kill switch 关闭后仍然点了宿主控件').toEqual([]);
  });

  it('policy 的判定与 clickHostTarget 的行为一致（不允许两套规则）', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const facts = { ...allowedFacts(), role: 'option', tagName: 'LI' };
    const decision = evaluateClickTarget(facts);
    expect(decision.allowed, '正对照的 facts 本身就被 policy 拒了，测试无意义').toBe(true);
  });
});

/**
 * 唯一出口上的点击预算（2026-08-23）。
 *
 * 本文件锁的是「宿主点击只走 policy 批准的路径」。这一节补的是另一半：
 * **走对了路径，也不能无限次地走**。
 *
 * `MAX_ROW_ADDS` 是编排层的墙——编排层自己走岔（重复走同一步、状态机出错、
 * 宿主不响应导致重试）时它一次都不拦。`clickHostTarget` 的文件头自陈
 * 「『Narrow』only means anything if there is exactly one place a click can
 * happen」，那个地方就该有计数器。
 */
describe('S0 · 一张授权的点击次数有上限', () => {
  it('用尽预算之后不再派发任何指针事件', () => {
    const element = target('<li role="option" data-t>United States</li>');
    const clicked: string[] = [];
    element.addEventListener('click', () => clicked.push('c'));
    const authority = activeAuthority(['set-combobox']);
    const call = () =>
      clickHostTarget({
        element,
        root: targetRoot(),
        facts: allowedFacts(element),
        authority,
        ticket: createUndoJournal().record(document.createElement('input')),
        policy: testApplyPolicy(),
      });

    for (let i = 0; i < MAX_HOST_CLICKS_PER_AUTHORITY; i += 1) {
      expect(call().ok, `第 ${i + 1} 次点击不该被拦`).toBe(true);
    }
    expect(clicked).toHaveLength(MAX_HOST_CLICKS_PER_AUTHORITY);

    // 报 ABORTED 而不是新造一个码——`Result` 的错误类型绑在稳定码集上，
    // 而 ABORTED 的定义「an earlier safety failure stopped this…」逐字成立。
    expect(call()).toEqual({ ok: false, code: 'ABORTED' });
    // 要害：不是"报了个错但照样点了"。
    expect(clicked).toHaveLength(MAX_HOST_CLICKS_PER_AUTHORITY);
  });

  it('元素已脱离文档的尝试同样计入预算——耗尽就是耗尽', () => {
    // 预算必须排在 isConnected **之前**。否则一个对着已消失的元素反复重试的
    // 循环永远耗不尽预算：每次都报 DETACHED、每次都不计数。
    const element = target('<li role="option" data-t>United States</li>');
    const facts = allowedFacts(element);
    const authority = activeAuthority(['set-combobox']);
    element.remove();
    const call = () =>
      clickHostTarget({
        element,
        root: targetRoot(),
        facts,
        authority,
        ticket: createUndoJournal().record(document.createElement('input')),
        policy: testApplyPolicy(),
      });
    for (let i = 0; i < MAX_HOST_CLICKS_PER_AUTHORITY; i += 1) {
      expect(call()).toEqual({ ok: false, code: 'DETACHED' });
    }
    expect(call()).toEqual({ ok: false, code: 'ABORTED' });
  });

  it('被 policy 拒掉的尝试也计入预算', () => {
    // 否则一个卡在 deny 上的重试循环可以无限次地敲同一个按钮——
    // 每次都被拒、每次都不计数、永远跑不完。
    const element = target('<a href="https://elsewhere.test" data-t>Go</a>');
    const authority = activeAuthority(['set-combobox']);
    const denied = () =>
      clickHostTarget({
        element,
        root: targetRoot(),
        facts: { ...allowedFacts(element), hasHref: true, hrefNavigates: true },
        authority,
        ticket: createUndoJournal().record(document.createElement('input')),
        policy: testApplyPolicy(),
      });
    for (let i = 0; i < MAX_HOST_CLICKS_PER_AUTHORITY; i += 1) {
      expect(denied()).toEqual({ ok: false, code: 'CLICK_DENIED' });
    }
    expect(denied()).toEqual({ ok: false, code: 'ABORTED' });
  });
});

/**
 * S0 · 原生激活（2026-09-15）是这个出口新开的一扇窗，而且是唯一一处**不预先
 * 取消默认动作**的宿主点击（默认动作正是我们要的那件事：改选中态）。
 *
 * 所以它要单独锁三件事：能力位是硬闸门、整组先验后点（任何一个成员被拒就一下
 * 都不发）、以及那张授权是一次性的（`writeForward` 返回之后不能被重放）。
 */
describe('S0 · 选择题的原生激活仍然只走 policy 批准的路径', () => {
  /** 用真实的 fill-only 结算拿一张真授权；`writeForward` 之外没有别的来源。 */
  async function withFillOnlyAuthority(
    run: (authority: FillOnlyHostWriteAuthority) => boolean,
  ): Promise<FillOnlyHostWriteAuthority | null> {
    let escaped: FillOnlyHostWriteAuthority | null = null;
    await executeFillOnlySemanticWrite({
      authorizeWrite: async () => true,
      executionFence: () => null,
      targetFence: () => null,
      isAtPreWriteState: () => true,
      isAtWrittenState: () => true,
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 1,
      settle: async () => undefined,
      lateRecheckDelay: async () => undefined,
      writeForward: (authority) => {
        escaped = authority;
        return run(authority);
      },
    });
    return escaped;
  }

  function mountChoice(): HTMLInputElement[] {
    document.body.innerHTML = `<form id="application-form">
      <input type="checkbox" id="a" name="LinkedIn" />
      <input type="checkbox" id="b" name="Glassdoor" />
    </form>`;
    return [...document.querySelectorAll<HTMLInputElement>('input')];
  }

  it('能力位关着时一下都不发（硬闸门）', async () => {
    const members = mountChoice();
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as Element).id), true);
    let outcome: unknown;
    await withFillOnlyAuthority((authority) => {
      outcome = activateReviewedChoiceGroup({
        activations: members.map((element) => ({ element, control: 'checkbox' as const })),
        root: targetRoot(),
        authority,
        capabilityCurrent: () => false,
        beforeEach: () => true,
        afterEach: () => true,
        withOwnership: (_element, activate) => { activate(); return true; },
      });
      return true;
    });
    expect(outcome).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(clicks).toEqual([]);
    expect(members.map((member) => member.checked)).toEqual([false, false]);
  });

  it('整组先验后点：第二个成员被 deny，第一个也一下不发', async () => {
    const members = mountChoice();
    // 第二个成员被作者自己标成隐藏 —— 「看不见的东西不许点」。
    members[1]!.setAttribute('aria-hidden', 'true');
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as Element).id), true);
    let outcome: unknown;
    await withFillOnlyAuthority((authority) => {
      outcome = activateReviewedChoiceGroup({
        activations: members.map((element) => ({ element, control: 'checkbox' as const })),
        root: targetRoot(),
        authority,
        capabilityCurrent: () => true,
        beforeEach: () => true,
        afterEach: () => true,
        withOwnership: (_element, activate) => { activate(); return true; },
      });
      return true;
    });
    expect(outcome).toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(clicks, '一个成员被拒，另一个却已经点出去了').toEqual([]);
    expect(members.map((member) => member.checked)).toEqual([false, false]);
  });

  it('正对照 + 一次性：允许时真的点，且同一张授权不能再用第二次', async () => {
    const members = mountChoice();
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as Element).id), true);
    const activate = (authority: FillOnlyHostWriteAuthority) => activateReviewedChoiceGroup({
      activations: [{ element: members[0]!, control: 'checkbox' as const }],
      root: targetRoot(),
      authority,
      capabilityCurrent: () => true,
      beforeEach: () => true,
      afterEach: () => true,
      withOwnership: (_element, run) => { run(); return true; },
    });
    const escaped = await withFillOnlyAuthority((authority) => {
      expect(activate(authority)).toEqual({ ok: true, value: undefined });
      // 同步窗口内的第二次：授权已核销。
      expect(activate(authority)).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
      return true;
    });
    expect(clicks).toEqual(['a']);
    expect(members.map((member) => member.checked)).toEqual([true, false]);
    // `writeForward` 返回之后授权失活，拿着它也点不动。
    expect(activate(escaped!)).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(clicks).toEqual(['a']);
  });
});
