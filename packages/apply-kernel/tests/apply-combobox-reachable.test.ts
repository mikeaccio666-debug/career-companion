import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { fieldSignature } from '../src/fieldIdentity';
import { optionSetSignature } from '../src/click/optionSearch';
import type {
  ComboboxOptionSource,
  ComboboxSemanticTransaction,
  ComboboxSemanticTransactionSource,
} from '../src/click/combobox';
import {
  runApplyPlan as runApplyPlanCore,
  type RunApplyPlanInput,
} from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createApplySession } from '../src/session.svelte';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyPlan } from '../src/contracts';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import { PENDING, restoreVisibility, setVisibility, suspendFrames, throttleTimers, within } from './helpers/hiddenPage';
import { sealRuleOwnedComboboxSemanticAuthority } from '../src/rules/comboboxSemanticAuthority';

/**
 * 下拉这条路**从扫描一路通到真实点击**的可达性测试。
 *
 * 单写一个文件是因为已经踩到过两次"接了等于没接"：
 *   · 蜜罐守卫写好了，engine 里没调用，评审才发现；
 *   · combobox 刚接进 runner 时，`session.svelte.ts` 仍然只申请 set-text /
 *     set-select，于是每一次下拉填充在真实环境里都会拿到 CAPABILITY_DISABLED
 *     ——**698 条测试当时全绿**。
 *
 * 所以这里断言的不是某个函数的返回值，而是三件"接上了"的事实：
 *   1. 扫描器把 react-select 的 <input type="text"> 判成 combobox，而不是 text；
 *   2. 这份计划要求的能力集里真的有 set-combobox；
 *   3. runApplyPlan 真的走到了开下拉那一步（宿主收到了 mousedown）。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  restoreVisibility();
  vi.unstubAllGlobals();
});

/** 实测形状：react-select 的可见输入框就是一个 type=text 的 input。 */
function mountGreenhouseWithCombobox(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label>
      <input id="first_name" type="text" name="first_name" />
      <label id="location-label" for="location">Location</label>
      <div class="select-shell">
        <input id="location" type="text" role="combobox"
               aria-expanded="false" aria-haspopup="true" aria-labelledby="location-label" />
        <div class="select__menu-slot"></div>
      </div>
    </form>`;
  return document.querySelector('form') as HTMLFormElement;
}

function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  return { event, shadowRoot };
}

const testOptionSource: ComboboxOptionSource = {
  read: (_trigger, root) => root.querySelectorAll('[role="option"]').map((element) => ({
    element,
    text: element.textContent ?? '',
  })),
  isOpen: (trigger) => trigger.getAttribute('aria-expanded') === 'true',
};

function semanticTransactions(
  resolveLive: (original: HTMLInputElement) => HTMLInputElement | null = (original) => original,
): ComboboxSemanticTransactionSource {
  return {
    snapshot: (trigger, root): ComboboxSemanticTransaction => {
      const previousRawValue = trigger.value;
      const hadBacking = Object.prototype.hasOwnProperty.call(
        trigger.dataset,
        'selectedBacking',
      );
      const previousBacking = trigger.dataset.selectedBacking;
      const live = () => resolveLive(trigger);
      const ownsEventTarget = (target: EventTarget | null) =>
        target === live() ||
        (target instanceof Element && root.querySelectorAll('[role="option"]').includes(target));
      const restorePreWrite = () => {
        const current = live();
        if (!current) return false;
        current.value = previousRawValue;
        if (hadBacking) current.dataset.selectedBacking = previousBacking as string;
        else delete current.dataset.selectedBacking;
        return true;
      };
      const isAtPreWriteState = () => {
        const current = live();
        if (!current || current.value !== previousRawValue) return false;
        return hadBacking
          ? current.dataset.selectedBacking === previousBacking
          : !Object.prototype.hasOwnProperty.call(current.dataset, 'selectedBacking');
      };
      return {
        canRestorePreWrite: isAtPreWriteState,
        restorePreWrite,
        isAtPreWriteState,
        ownsEventTarget,
        captureWrittenState: (expected) => ({
          isAtWrittenState: () => live()?.dataset.selectedBacking === expected,
          restorePreWrite,
          isAtPreWriteState,
          ownsEventTarget,
          wasUserEdited: () => false,
          dispose: () => undefined,
        }),
      };
    },
  };
}

const testSemanticTransactions = semanticTransactions();

/**
 * Existing hostile lifecycle probes construct plans by hand. Adapt their
 * opaque semantic seams into the new field-owned authority without restoring
 * the production runner's removed caller-assertion path.
 */
function runApplyPlan(input: RunApplyPlanInput) {
  if (
    input.comboboxOptionSource &&
    input.comboboxSemanticTransactionSource &&
    input.readComboboxSelection
  ) {
    for (const entry of input.plan.entries) {
      if (entry.kind !== 'combobox' || entry.semanticAuthority) continue;
      entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
        optionSource: input.comboboxOptionSource,
        semanticTransactionSource: input.comboboxSemanticTransactionSource,
        readSelection: input.readComboboxSelection,
      });
    }
  }
  return runApplyPlanCore({
    ...input,
    readHostValidation: input.readHostValidation ?? (() => ({ ariaInvalid: 'false' })),
    lateRecheckMs: input.lateRecheckMs ?? 1,
    lateRecheckDelay: input.lateRecheckDelay ?? (async () => undefined),
  });
}

function singleComboboxPlan(
  trigger: HTMLInputElement,
  root: ReturnType<typeof createScanRoot>,
  fingerprint: string,
): ApplyPlan {
  return {
    vendor: 'greenhouse',
    fingerprint,
    fillEmptyOnly: true,
    entries: [{
      kind: 'combobox',
      required: false,
      key: 'location',
      label: 'Location',
      value: 'Seattle',
      comboboxCandidates: ['Seattle'],
      element: trigger,
      confidence: 1,
      order: 0,
      signature: fieldSignature(trigger, root),
    }],
    skipped: [],
  };
}

describe('下拉路径可达性', () => {
  it('react-select 的输入框被判成 combobox，不是 text', () => {
    const form = mountGreenhouseWithCombobox();
    const root = greenhouseAdapter.resolveRoot(document);
    expect(root, 'Greenhouse 适配器没认出这个表单').not.toBeNull();

    const fields = greenhouseAdapter.scan(root!);
    const location = fields.find((field) => field.key === 'location');
    expect(location, '"Location" 没有解析到 location 键').toBeDefined();
    expect(
      location?.kind,
      '判成 text 会让 setValue 写进搜索框：实测 blur 后 value 归空，什么都没填上',
    ).toBe('combobox');
    // 同一个表单里的普通输入框不能被误伤。
    expect(fields.find((field) => field.key === 'firstName')?.kind).toBe('text');
    expect(form.isConnected).toBe(true);
  });

  it('含下拉的计划会申请 set-combobox，不含时则不申请（最小权限）', () => {
    const form = mountGreenhouseWithCombobox();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { firstName: 'Ada', location: 'United States' },
    );
    const kinds = plan.entries.map((entry) => entry.kind);
    expect(kinds, '计划里没有下拉条目，后面的断言就是空转').toContain('combobox');
    expect([...capabilitiesForKinds(kinds)]).toContain('set-combobox');
    // 反向：纯文本计划绝不申请点击能力。
    expect([...capabilitiesForKinds(['text', 'textarea'])]).toEqual(['set-text']);
    expect(form.isConnected).toBe(true);
  });

  it('runner without a rule-owned option/readback/Undo seam performs zero host clicks', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const root = createScanRoot(form, []);
    const seen: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      trigger.addEventListener(type, () => seen.push(type));
    }

    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'reachability',
      fillEmptyOnly: true,
      entries: [
        {
          kind: 'combobox',
          required: false,
          key: 'location',
          label: 'Location',
          value: 'United States',
          comboboxCandidates: ['United States'],
          element: trigger,
          confidence: 1,
          order: 0,
          signature: fieldSignature(trigger, root),
        },
      ],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(seen).toEqual([]);
    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.ok === false ? summary.results[0].reason : null).toBe(
      'CAPABILITY_DISABLED',
    );
  });

  it('session cannot silently restore the removed unverified compatibility path', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const descriptor = {
      vendor: 'greenhouse' as const,
      root,
      fields: [...greenhouseAdapter.scan(root)],
    };
    let triggerClicks = 0;
    trigger.addEventListener('click', () => { triggerClicks += 1; });

    const session = createApplySession({
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { location: 'United States' }, readOnly: false },
      }),
      loadPolicy: async () => testApplyPolicy(),
      rescanForm: () => descriptor,
    });
    session.setForm(descriptor);
    session.setOpen(true);
    await session.ready();
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['location']);

    const click = trustedShadowClick();
    await session.fill(click.event, click.shadowRoot);
    expect(triggerClicks).toBe(0);
    expect(session.snapshot()).toMatchObject({
      phase: 'done',
      run: { filled: 0, failed: 1 },
      undoCount: 0,
    });
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['location']);
    session.dispose();
  });

  it('legacy caller seams cannot replace field-owned semantic authority', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const root = createScanRoot(form, []);
    let triggerClicks = 0;
    trigger.addEventListener('click', () => { triggerClicks += 1; });

    const journal = createUndoJournal();
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'combobox-success',
      fillEmptyOnly: true,
      entries: [
        {
          kind: 'combobox',
          required: false,
          key: 'location',
          label: 'Location',
          value: 'United States',
          comboboxCandidates: ['United States'],
          element: trigger,
          confidence: 1,
          order: 0,
          signature: fieldSignature(trigger, root),
        },
      ],
      skipped: [],
    };

    const summary = await runApplyPlanCore({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: () => 'EMPTY',
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'CAPABILITY_DISABLED' },
    ]);
    expect(triggerClicks).toBe(0);
    expect(journal.size()).toBe(0);
  });

  it.each([
    ['null snapshot', { snapshot: (): null => null }],
    ['throwing snapshot', { snapshot: (): never => { throw new Error('hostile snapshot'); } }],
    ['missing restore', {
      snapshot: (): {
        readonly isAtPreWriteState: () => boolean;
        readonly ownsEventTarget: () => boolean;
      } => ({
        isAtPreWriteState: () => true,
        ownsEventTarget: () => true,
      }),
    }],
    ['missing restore readback', {
      snapshot: (): {
        readonly restorePreWrite: () => boolean;
        readonly ownsEventTarget: () => boolean;
      } => ({
        restorePreWrite: () => true,
        ownsEventTarget: () => true,
      }),
    }],
  ] as const)(
    'incomplete semantic transaction (%s) is CAPABILITY_DISABLED with zero clicks',
    async (_name, invalidSource) => {
      const form = mountGreenhouseWithCombobox();
      const trigger = document.getElementById('location') as HTMLInputElement;
      const root = createScanRoot(form, []);
      const plan = singleComboboxPlan(trigger, root, 'incomplete-semantic-transaction');
      let triggerClicks = 0;
      trigger.addEventListener('click', () => { triggerClicks += 1; });
      const journal = createUndoJournal();

      const summary = await runApplyPlan({
        plan,
        auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
        journal,
        root,
        policy: testApplyPolicy(),
        comboboxOptionSource: testOptionSource,
        readComboboxSelection: () => 'EMPTY',
        rawComboboxUndoIsSemantic: () => true,
        comboboxSemanticTransactionSource:
          invalidSource as unknown as ComboboxSemanticTransactionSource,
      });

      expect(summary.results).toEqual([
        { key: 'location', label: 'Location', ok: false, reason: 'CAPABILITY_DISABLED' },
      ]);
      expect(triggerClicks).toBe(0);
      expect(journal.size()).toBe(0);
    },
  );

  it('ordered candidates survive plan→runner and choose the first available fallback', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    let chosen = '';
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'LinkedIn';
        option.addEventListener('click', () => {
          chosen = 'LinkedIn';
          trigger.value = 'LinkedIn';
          trigger.dataset.selectedBacking = 'LinkedIn';
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'ordered-plan-runner',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Source',
        value: 'Jobright',
        comboboxCandidates: ['Jobright', 'LinkedIn'],
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger, expected) => {
        const backing = liveTrigger.dataset.selectedBacking;
        if (!backing) return 'EMPTY';
        return backing === expected ? 'MATCH' : 'MISMATCH';
      },
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results[0]?.ok).toBe(true);
    expect(chosen).toBe('LinkedIn');
  });

  it('rule-owned readback produces verified filled and an exact semantic Undo', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          trigger.value = 'Seattle';
          trigger.dataset.selectedBacking = 'Seattle';
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'verified-combobox',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Location',
        value: 'Seattle',
        comboboxCandidates: ['Seattle'],
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger, expected) => {
        const backing = liveTrigger.dataset.selectedBacking;
        if (!backing) return 'EMPTY';
        return backing === expected ? 'MATCH' : 'MISMATCH';
      },
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([{ key: 'location', label: 'Location', ok: true }]);
    expect(summary.filled).toBe(1);
    expect(journal.size()).toBe(1);
    const undo = journal.undoAll(
      testAuthority(null, 'undo', [...journal.requiredUndoCapabilities()]),
    );
    expect(undo).toMatchObject({ restored: 1, remaining: 0 });
    expect(trigger.value).toBe('');
    expect(trigger.dataset.selectedBacking).toBeUndefined();
  });

  it('hidden tab (2026-09-23): the open → poll → settle loop runs on host tasks, not on throttled one-second timers', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    // A React-style host renders the menu in the click itself; nothing it does needs a timer.
    trigger.addEventListener('click', () => {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = 'Seattle';
      option.addEventListener('click', () => {
        trigger.value = 'Seattle';
        trigger.dataset.selectedBacking = 'Seattle';
        slot.replaceChildren();
      });
      slot.replaceChildren(option);
    });
    setVisibility('hidden');
    suspendFrames();
    throttleTimers();
    const plan = singleComboboxPlan(trigger, root, 'hidden-combobox');

    const summary = await within(runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger, expected) => {
        const backing = liveTrigger.dataset.selectedBacking;
        if (!backing) return 'EMPTY';
        return backing === expected ? 'MATCH' : 'MISMATCH';
      },
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    }), 600);

    expect(summary, 'each poll must not wait for a throttled timer').not.toBe(PENDING);
    if (summary === PENDING) return;
    expect(summary.results).toEqual([{ key: 'location', label: 'Location', ok: true }]);
  });

  it('same calling-code display with an unsealed wrong backing never gains rollback authority', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'United States +1';
        option.addEventListener('click', () => {
          trigger.value = '+1';
          trigger.dataset.selectedBacking = 'Canada';
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    trigger.addEventListener('input', () => {
      if (trigger.value === '') delete trigger.dataset.selectedBacking;
    });
    const journal = createUndoJournal();
    const optionTexts = ['United States +1'];
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'wrong-backing',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Country',
        value: 'United States',
        comboboxCandidates: ['United States'],
        comboboxHarvest: {
          candidates: ['United States'],
          optionTexts,
          optionSetSignature: optionSetSignature(optionTexts),
          resolvedOptionText: 'United States +1',
        },
        resolvedOptionText: 'United States +1',
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) => {
        const backing = liveTrigger.dataset.selectedBacking;
        if (!backing) return 'EMPTY';
        return backing === 'United States' ? 'MATCH' : 'MISMATCH';
      },
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Country', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(summary.filled).toBe(0);
    expect(journal.size()).toBe(0);
    expect(trigger.value).toBe('+1');
    expect(trigger.dataset.selectedBacking).toBe('Canada');
  });

  it('semantic MATCH without a raw transition succeeds only with exact semantic Undo', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          trigger.dataset.selectedBacking = 'Seattle';
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'hidden-backing-no-raw-transition',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Location',
        value: 'Seattle',
        comboboxCandidates: ['Seattle'],
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([{ key: 'location', label: 'Location', ok: true }]);
    expect(summary.abortedBy).toBeNull();
    expect(trigger.value).toBe('');
    expect(trigger.dataset.selectedBacking).toBe('Seattle');
    expect(journal.size()).toBe(1);
    expect(journal.undoAll(
      testAuthority(null, 'undo', [...journal.requiredUndoCapabilities()]),
    )).toMatchObject({ restored: 1, remaining: 0 });
    expect(trigger.dataset.selectedBacking).toBeUndefined();
  });

  it('settling-period trigger replacement aborts before option dispatch and preserves live semantics', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    let optionClicks = 0;
    let submitClicks = 0;
    let submitEvents = 0;
    let directSubmitCalls = 0;
    let requestSubmitCalls = 0;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.addEventListener('click', () => { submitClicks += 1; });
    form.appendChild(submit);
    form.addEventListener('submit', (event) => {
      submitEvents += 1;
      event.preventDefault();
    });
    Object.defineProperty(form, 'submit', {
      configurable: true,
      value: () => { directSubmitCalls += 1; },
    });
    Object.defineProperty(form, 'requestSubmit', {
      configurable: true,
      value: () => { requestSubmitCalls += 1; },
    });
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const replacement = trigger.cloneNode(true) as HTMLInputElement;
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          optionClicks += 1;
          replacement.value = 'Seattle';
          replacement.dataset.selectedBacking = 'Seattle';
        });
        slot.replaceChildren(option);
        trigger.replaceWith(replacement);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(
      trigger,
      root,
      'combobox-settling-trigger-replacement-fence',
    );

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: semanticTransactions(
        () => document.getElementById('location') as HTMLInputElement | null,
      ),
    });

    const replacement = document.getElementById('location') as HTMLInputElement;
    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(replacement).not.toBe(trigger);
    expect(optionClicks).toBe(0);
    expect(replacement.value).toBe('');
    expect(replacement.dataset.selectedBacking).toBeUndefined();
    expect(journal.size()).toBe(0);
    expect(submitClicks).toBe(0);
    expect(submitEvents).toBe(0);
    expect(directSubmitCalls).toBe(0);
    expect(requestSubmitCalls).toBe(0);
  });

  it.each([
    {
      name: 'hidden after semantic pre-state callback',
      phase: 'semantic' as const,
      expectedReason: 'CLICK_DENIED' as const,
      mutate: (option: HTMLElement, _slot: HTMLElement): void => { option.hidden = true; },
    },
    {
      name: 'Submit-looking after execution fence callback',
      phase: 'execution' as const,
      expectedReason: 'CLICK_DENIED' as const,
      mutate: (option: HTMLElement, _slot: HTMLElement): void => {
        // Keep the target option-like so this proves the absolute Submit-name
        // deny, not an incidental unsupported-role rejection.
        option.setAttribute('aria-label', 'Submit Application');
      },
    },
    {
      name: 'same-text replacement after semantic pre-state callback',
      phase: 'semantic' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, slot: HTMLElement): void => {
        const replacement = option.cloneNode(true) as HTMLElement;
        slot.replaceChildren(replacement);
        // Keep the stale candidate connected so the old implementation cannot
        // accidentally pass this test through clickHostTarget's DETACHED guard.
        document.body.appendChild(option);
      },
    },
    {
      name: 'same-text replacement after final execution fence callback',
      phase: 'final-execution' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, _slot: HTMLElement): void => {
        const replacement = option.cloneNode(true) as HTMLElement;
        const popupRoot = option.parentNode;
        option.removeAttribute('data-popup-member');
        popupRoot?.replaceChild(replacement, option);
        // Keep the stale original connected, visible and inside the same open
        // ShadowRoot, but outside rule-owned popup membership. Observing only
        // ownerDocument does not see this mutation; the final fence must also
        // observe each returned option's exact root.
        popupRoot?.appendChild(option);
      },
    },
    {
      name: 'duplicate added to a previously empty ShadowRoot after final execution fence',
      phase: 'final-execution-empty-shadow' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, slot: HTMLElement): void => {
        const emptyHost = slot.querySelector('[data-empty-popup-host]');
        const emptyRoot = emptyHost?.shadowRoot;
        if (!emptyRoot) throw new Error('missing hostile empty ShadowRoot');
        emptyRoot.appendChild(option.cloneNode(true));
      },
    },
    {
      name: 'duplicate added to an observed empty ShadowRoot by dispatch-adjacent execution fence',
      phase: 'post-facts-execution-empty-shadow' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, slot: HTMLElement): void => {
        const emptyHost = slot.querySelector('[data-empty-popup-host]');
        const emptyRoot = emptyHost?.shadowRoot;
        if (!emptyRoot) throw new Error('missing hostile empty ShadowRoot');
        emptyRoot.appendChild(option.cloneNode(true));
      },
    },
    {
      name: 'final rule read returns a stale view after adding to an empty ShadowRoot',
      phase: 'final-source-empty-shadow' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, slot: HTMLElement): void => {
        const emptyHost = slot.querySelector('[data-empty-popup-host]');
        const emptyRoot = emptyHost?.shadowRoot;
        if (!emptyRoot) throw new Error('missing hostile empty ShadowRoot');
        emptyRoot.appendChild(option.cloneNode(true));
      },
    },
    {
      name: 'final rule read returns a stale ShadowRoot membership view',
      phase: 'source-shadow' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, _slot: HTMLElement): void => {
        const replacement = option.cloneNode(true) as HTMLElement;
        const popupRoot = option.parentNode;
        option.removeAttribute('data-popup-member');
        popupRoot?.replaceChild(replacement, option);
        popupRoot?.appendChild(option);
      },
    },
    {
      name: 'text drift after execution fence callback',
      phase: 'execution' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (option: HTMLElement, _slot: HTMLElement): void => { option.textContent = 'Portland'; },
    },
    {
      name: 'facts drift during the first final facts capture',
      phase: 'during-facts' as const,
      expectedReason: 'CLICK_DENIED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
    {
      name: 'membership removed during second final facts getter',
      phase: 'during-facts-membership' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
    {
      name: 'same connected option moves between observed ShadowRoots during second final facts getter',
      phase: 'during-facts-root' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
    {
      name: 'final rule read expires policy before the execution fence',
      phase: 'source-policy' as const,
      expectedReason: 'POLICY_DISABLED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
    {
      name: 'semantic backing drifts during the final execution fence',
      phase: 'final-execution-backing' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
    {
      name: 'final semantic callback changes raw state after reporting success',
      phase: 'final-semantic-raw' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
    {
      name: 'post-facts execution callback changes opaque semantic pre-state',
      phase: 'post-facts-execution-opaque-prestate' as const,
      expectedReason: 'IDENTITY_CHANGED' as const,
      mutate: (_option: HTMLElement, _slot: HTMLElement): void => undefined,
    },
  ])('$name dispatches no option pointer event', async ({
    phase,
    expectedReason,
    mutate,
  }) => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const firstName = document.getElementById('first_name') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    const optionPointerEvents: string[] = [];
    let submitClicks = 0;
    let submitEvents = 0;
    let directSubmitCalls = 0;
    let requestSubmitCalls = 0;
    let restoreCalls = 0;
    let restoreReadbacks = 0;
    let preStateReads = 0;
    let postOpenPreStateReads = 0;
    let callbacksComplete = false;
    let mutationApplied = false;
    let factTrapInstalled = false;
    let now = 100;
    let postCallbackExecutionFenceReads = 0;
    let postCallbackOptionSourceReads = 0;
    let openedOption: HTMLElement | null = null;
    let adapterOpaquePreWrite = true;
    let opaqueDriftFenceRead = 0;
    let opaqueFactsReads = 0;
    let opaqueFactsReadsAtDrift = 0;
    let opaqueRawValueAtDrift = '';
    let opaqueHadBackingAtDrift = false;

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.addEventListener('click', () => { submitClicks += 1; });
    form.appendChild(submit);
    form.addEventListener('submit', (event) => {
      submitEvents += 1;
      event.preventDefault();
    });
    Object.defineProperty(form, 'submit', {
      configurable: true,
      value: () => { directSubmitCalls += 1; },
    });
    Object.defineProperty(form, 'requestSubmit', {
      configurable: true,
      value: () => { requestSubmitCalls += 1; },
    });

    const pointerTypes = ['mousedown', 'mouseup', 'click'] as const;
    const onOptionPointer = (event: Event) => {
      const target = event.composedPath()[0] ?? event.target;
      if (
        target instanceof Element &&
        target.hasAttribute('data-hostile-option')
      ) optionPointerEvents.push(event.type);
    };
    for (const type of pointerTypes) {
      document.addEventListener(type, onOptionPointer, true);
    }
    const onHostileClick = (event: Event) => {
      const target = event.composedPath()[0] ?? event.target;
      if (
        !(target instanceof Element) ||
        !target.hasAttribute('data-hostile-option')
      ) return;
      trigger.value = 'Seattle';
      trigger.dataset.selectedBacking = 'Seattle';
      form.requestSubmit();
    };
    document.addEventListener('click', onHostileClick);

    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.setAttribute('data-hostile-option', '');
        option.setAttribute('data-popup-member', '');
        option.textContent = 'Seattle';
        openedOption = option;
        if (
          phase === 'final-execution' ||
          phase === 'final-execution-empty-shadow' ||
          phase === 'post-facts-execution-empty-shadow' ||
          phase === 'final-source-empty-shadow' ||
          phase === 'source-shadow' ||
          phase === 'during-facts-root'
        ) {
          const popupHost = document.createElement('div');
          popupHost.attachShadow({ mode: 'open' }).appendChild(option);
          if (
            phase === 'final-execution-empty-shadow' ||
            phase === 'post-facts-execution-empty-shadow' ||
            phase === 'final-source-empty-shadow' ||
            phase === 'during-facts-root'
          ) {
            const emptyPopupHost = document.createElement('div');
            emptyPopupHost.setAttribute('data-empty-popup-host', '');
            emptyPopupHost.attachShadow({ mode: 'open' });
            slot.replaceChildren(popupHost, emptyPopupHost);
          } else {
            slot.replaceChildren(popupHost);
          }
        } else {
          slot.replaceChildren(option);
        }
      }, 0);
    });

    const baseSemanticSource = semanticTransactions();
    const hostileSemanticSource: ComboboxSemanticTransactionSource = {
      snapshot: (liveTrigger, liveRoot) => {
        const base = baseSemanticSource.snapshot(liveTrigger, liveRoot);
        if (!base) return null;
        const previousOpaquePreWrite = adapterOpaquePreWrite;
        return {
          canRestorePreWrite: () =>
            base.canRestorePreWrite() &&
            adapterOpaquePreWrite === previousOpaquePreWrite,
          restorePreWrite: () => {
            restoreCalls += 1;
            const baseRestored = base.restorePreWrite();
            adapterOpaquePreWrite = previousOpaquePreWrite;
            return baseRestored && adapterOpaquePreWrite === previousOpaquePreWrite;
          },
          isAtPreWriteState: () => {
            const atPreWriteState =
              base.isAtPreWriteState() &&
              adapterOpaquePreWrite === previousOpaquePreWrite;
            preStateReads += 1;
            if (restoreCalls > 0) restoreReadbacks += 1;
            if (openedOption) postOpenPreStateReads += 1;
            if (postOpenPreStateReads === 1) {
              callbacksComplete = true;
              if (phase === 'semantic') {
                const option = openedOption as HTMLElement;
                mutate(option, slot);
                mutationApplied = true;
              }
            }
            if (postOpenPreStateReads === 2 && phase === 'final-semantic-raw') {
              // IDL properties do not emit MutationObserver records. The
              // direct raw-state seal must still catch a verifier that changes
              // value after computing a true pre-state result.
              trigger.value = 'host drift';
              mutationApplied = true;
            }
            return atPreWriteState;
          },
          ownsEventTarget: base.ownsEventTarget,
          captureWrittenState: base.captureWrittenState,
        };
      },
    };

    const hostileOptionSource: ComboboxOptionSource = {
      read: (_liveTrigger, liveRoot) => {
        const belongsToSlot = (element: Element): boolean => {
          let node: Node | null = element;
          while (node) {
            if (node === slot) return true;
            if (node.parentNode) {
              node = node.parentNode;
              continue;
            }
            node = (node as Partial<ShadowRoot>).host ?? null;
          }
          return false;
        };
        const views = liveRoot.querySelectorAll('[data-popup-member]')
          .filter(belongsToSlot)
          .map((element) => ({
            element,
            text: element.textContent ?? '',
          }));
        if (callbacksComplete) postCallbackOptionSourceReads += 1;
        if (phase === 'source-policy' && callbacksComplete && !mutationApplied) {
          // The rule boundary returns an otherwise valid view but revokes the
          // execution window as a side effect. The final execution fence must
          // run after this callback and before all fresh click facts.
          now = 200;
          mutationApplied = true;
        }
        if (phase === 'source-shadow' && callbacksComplete && !mutationApplied) {
          // Return the already captured view after changing membership inside
          // the option's ShadowRoot. The initial observer must already cover
          // that root; observing only after read() returns is too late.
          mutate(openedOption as HTMLElement, slot);
          mutationApplied = true;
        }
        if (
          phase === 'final-source-empty-shadow' &&
          postCallbackOptionSourceReads === 2 &&
          !mutationApplied
        ) {
          // The final rule-owned read has already captured a unique old view.
          // Mutating a previously empty sibling ShadowRoot before returning it
          // proves the synchronous fence covers the complete search domain,
          // not only roots that already contained settled options.
          mutate(openedOption as HTMLElement, slot);
          mutationApplied = true;
        }
        return views;
      },
      isOpen: () => true,
    };

    const optionTexts = ['Seattle'];
    const abortRemainingPlan =
      phase === 'during-facts-membership' ||
      phase === 'during-facts-root' ||
      phase === 'post-facts-execution-opaque-prestate';
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: `combobox-option-toctou-${phase}`,
      fillEmptyOnly: true,
      entries: [
        {
          kind: 'combobox',
          required: false,
          key: 'location',
          label: 'Location',
          value: 'Seattle',
          comboboxCandidates: ['Seattle'],
          comboboxHarvest: {
            candidates: ['Seattle'],
            optionTexts,
            optionSetSignature: optionSetSignature(optionTexts),
            resolvedOptionText: 'Seattle',
          },
          resolvedOptionText: 'Seattle',
          element: trigger,
          confidence: 1,
          order: 0,
          signature: fieldSignature(trigger, root),
        },
        ...(abortRemainingPlan ? [{
          kind: 'text' as const,
          required: true,
          key: 'firstName' as const,
          label: 'First Name',
          value: 'Ada',
          element: firstName,
          confidence: 1,
          order: 1,
          signature: fieldSignature(firstName, root),
        }] : []),
      ],
      skipped: [],
    };
    const journal = createUndoJournal();
    const policy = { ...testApplyPolicy(), notAfter: 150 };
    let summary!: Awaited<ReturnType<typeof runApplyPlan>>;
    try {
      summary = await runApplyPlan({
        plan,
        auth: testAuthority(
          plan.fingerprint,
          'fill',
          [...capabilitiesForKinds(abortRemainingPlan ? ['combobox', 'text'] : ['combobox'])],
        ),
        journal,
        root,
        policy,
        now: () => now,
        comboboxOptionSource: hostileOptionSource,
        readComboboxSelection: (liveTrigger) =>
          liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
        rawComboboxUndoIsSemantic: () => true,
        comboboxSemanticTransactionSource: hostileSemanticSource,
        scanStillCurrent: () => {
          if (callbacksComplete) postCallbackExecutionFenceReads += 1;
          if (phase === 'execution' && callbacksComplete && !mutationApplied) {
            const option = openedOption as HTMLElement;
            mutate(option, slot);
            mutationApplied = true;
          }
          if (
            (phase === 'final-execution' || phase === 'final-execution-empty-shadow') &&
            postCallbackExecutionFenceReads === 2 &&
            !mutationApplied
          ) {
            const option = openedOption as HTMLElement;
            mutate(option, slot);
            mutationApplied = true;
          }
          if (
            phase === 'post-facts-execution-empty-shadow' &&
            postCallbackExecutionFenceReads === 3 &&
            !mutationApplied
          ) {
            const option = openedOption as HTMLElement;
            mutate(option, slot);
            mutationApplied = true;
          }
          if (
            phase === 'post-facts-execution-opaque-prestate' &&
            postCallbackExecutionFenceReads === 3 &&
            !mutationApplied
          ) {
            adapterOpaquePreWrite = false;
            opaqueDriftFenceRead = postCallbackExecutionFenceReads;
            opaqueFactsReadsAtDrift = opaqueFactsReads;
            opaqueRawValueAtDrift = trigger.value;
            opaqueHadBackingAtDrift = Object.prototype.hasOwnProperty.call(
              trigger.dataset,
              'selectedBacking',
            );
            mutationApplied = true;
          }
          if (
            phase === 'post-facts-execution-opaque-prestate' &&
            callbacksComplete &&
            !factTrapInstalled
          ) {
            const option = openedOption as HTMLElement;
            Object.defineProperty(option, 'hidden', {
              configurable: true,
              get: () => {
                opaqueFactsReads += 1;
                return false;
              },
            });
            factTrapInstalled = true;
          }
          if (
            phase === 'final-execution-backing' &&
            postCallbackExecutionFenceReads === 2 &&
            !mutationApplied
          ) {
            trigger.value = 'host drift';
            trigger.dataset.selectedBacking = 'host drift';
            mutationApplied = true;
          }
          if (
            (
              phase === 'during-facts' ||
              phase === 'during-facts-membership' ||
              phase === 'during-facts-root'
            ) &&
            callbacksComplete &&
            !factTrapInstalled
          ) {
            const option = openedOption as HTMLElement;
            let hiddenReads = 0;
            Object.defineProperty(option, 'hidden', {
              configurable: true,
              get: () => {
                hiddenReads += 1;
                // Mutate only in the final facts pass, after accessibleName
                // and labelText have already been captured. A mere two-read
                // comparison is insufficient; the synchronous DOM mutation
                // fence must independently make this zero-click.
                if (hiddenReads === 2) {
                  if (phase === 'during-facts-membership') {
                    option.removeAttribute('data-popup-member');
                  } else if (phase === 'during-facts-root') {
                    const emptyHost = slot.querySelector('[data-empty-popup-host]');
                    const emptyRoot = emptyHost?.shadowRoot;
                    if (!emptyRoot) throw new Error('missing observed empty ShadowRoot');
                    emptyRoot.appendChild(option);
                  } else {
                    option.setAttribute('aria-label', 'Submit Application');
                  }
                  mutationApplied = true;
                }
                return false;
              },
            });
            factTrapInstalled = true;
          }
          return true;
        },
      });
    } finally {
      for (const type of pointerTypes) {
        document.removeEventListener(type, onOptionPointer, true);
      }
      document.removeEventListener('click', onHostileClick);
    }

    expect(mutationApplied).toBe(true);
    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: expectedReason },
      ...(abortRemainingPlan ? [{
        key: 'firstName',
        label: 'First Name',
        ok: false,
        reason: 'ABORTED',
      } as const] : []),
    ]);
    if (expectedReason === 'IDENTITY_CHANGED') {
      expect(summary.abortedBy).toBe('IDENTITY_CHANGED');
    }
    expect(optionPointerEvents).toEqual([]);
    if (phase === 'final-execution-backing') {
      expect(trigger.value).toBe('host drift');
      expect(trigger.dataset.selectedBacking).toBe('host drift');
    } else if (phase === 'final-semantic-raw') {
      expect(trigger.value).toBe('host drift');
      expect(trigger.dataset.selectedBacking).toBeUndefined();
    } else {
      expect(trigger.value).toBe('');
      expect(trigger.dataset.selectedBacking).toBeUndefined();
    }
    if (abortRemainingPlan) expect(firstName.value).toBe('');
    if (phase === 'post-facts-execution-opaque-prestate') {
      expect(opaqueDriftFenceRead).toBe(3);
      expect(opaqueFactsReadsAtDrift).toBe(2);
      expect(opaqueRawValueAtDrift).toBe('');
      expect(opaqueHadBackingAtDrift).toBe(false);
      expect(adapterOpaquePreWrite).toBe(false);
    }
    // None of these pre-dispatch callback drifts has an exact written-state
    // seal. A transaction may fail closed, but it cannot erase a host-owned
    // third state merely because that state differs from the snapshot.
    expect(restoreCalls).toBe(0);
    expect(restoreReadbacks).toBe(0);
    expect(journal.size()).toBe(0);
    expect(submitClicks).toBe(0);
    expect(submitEvents).toBe(0);
    expect(directSubmitCalls).toBe(0);
    expect(requestSubmitCalls).toBe(0);
  });

  it('post-click DOM replacement restores the live semantic target before ABORTED', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          const replacement = trigger.cloneNode(true) as HTMLInputElement;
          replacement.value = 'Seattle';
          replacement.dataset.selectedBacking = 'Seattle';
          trigger.replaceWith(replacement);
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(trigger, root, 'combobox-dom-replacement-rollback');

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: semanticTransactions(
        () => document.getElementById('location') as HTMLInputElement | null,
      ),
    });

    const replacement = document.getElementById('location') as HTMLInputElement;
    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(replacement).not.toBe(trigger);
    expect(replacement.value).toBe('');
    expect(replacement.dataset.selectedBacking).toBeUndefined();
    expect(journal.size()).toBe(0);
  });

  it('readback-time DOM replacement cannot commit a detached trigger or false Undo', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          trigger.value = 'Seattle';
          trigger.dataset.selectedBacking = 'Seattle';
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(trigger, root, 'combobox-readback-replacement-rollback');
    let postWriteReads = 0;

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) => {
        if (liveTrigger.dataset.selectedBacking !== 'Seattle') return 'EMPTY';
        postWriteReads += 1;
        if (postWriteReads === 1) return 'UNVERIFIABLE';
        const replacement = liveTrigger.cloneNode(true) as HTMLInputElement;
        liveTrigger.replaceWith(replacement);
        return 'MATCH';
      },
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: semanticTransactions(
        () => document.getElementById('location') as HTMLInputElement | null,
      ),
    });

    const replacement = document.getElementById('location') as HTMLInputElement;
    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(replacement).not.toBe(trigger);
    expect(replacement.value).toBe('');
    expect(replacement.dataset.selectedBacking).toBeUndefined();
    expect(journal.size()).toBe(0);
  });

  it('post-click AbortSignal cannot cancel exact semantic rollback', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    const abort = new AbortController();
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          trigger.value = 'Seattle';
          trigger.dataset.selectedBacking = 'Seattle';
          slot.replaceChildren();
          abort.abort();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(trigger, root, 'combobox-abort-rollback');

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
      signal: abort.signal,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(trigger.value).toBe('');
    expect(trigger.dataset.selectedBacking).toBeUndefined();
    expect(journal.size()).toBe(0);
  });

  it('post-click policy expiry still restores and verifies pre-write semantics', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    let now = 100;
    const policy = { ...testApplyPolicy(), notAfter: 150 };
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          trigger.value = 'Seattle';
          trigger.dataset.selectedBacking = 'Seattle';
          slot.replaceChildren();
          const unrelated = document.getElementById('first_name') as HTMLInputElement;
          const event = new Event('click', { bubbles: true });
          Object.defineProperty(event, 'isTrusted', { value: true });
          unrelated.dispatchEvent(event);
          now = 200;
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(trigger, root, 'combobox-policy-expiry-rollback');

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy,
      now: () => now,
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'POLICY_DISABLED' },
    ]);
    expect(trigger.value).toBe('');
    expect(trigger.dataset.selectedBacking).toBeUndefined();
    expect(journal.size()).toBe(0);
  });

  it('trusted option click on a replacement widget is never overwritten by semantic rollback', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          const replacement = trigger.cloneNode(true) as HTMLInputElement;
          replacement.value = 'Seattle';
          replacement.dataset.selectedBacking = 'Seattle';
          trigger.replaceWith(replacement);
          slot.replaceChildren();
          setTimeout(() => {
            const userOption = document.createElement('div');
            userOption.setAttribute('role', 'option');
            userOption.addEventListener('click', () => {
              replacement.value = 'Portland';
              replacement.dataset.selectedBacking = 'Portland';
            });
            slot.appendChild(userOption);
            const event = new Event('click', { bubbles: true });
            Object.defineProperty(event, 'isTrusted', { value: true });
            userOption.dispatchEvent(event);
          }, 0);
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(trigger, root, 'combobox-replacement-user-edit');
    const semanticSource = semanticTransactions(
      () => document.getElementById('location') as HTMLInputElement | null,
    );

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: semanticSource,
    });

    const replacement = document.getElementById('location') as HTMLInputElement;
    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(replacement.value).toBe('Portland');
    expect(replacement.dataset.selectedBacking).toBe('Portland');
    expect(journal.size()).toBe(0);
  });

  it('readback exceptions cannot mint rollback authority from raw value alone', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => {
          trigger.value = 'Seattle';
          slot.replaceChildren();
        });
        slot.replaceChildren(option);
      }, 0);
    });
    const journal = createUndoJournal();
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'throwing-combobox-readback',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Location',
        value: 'Seattle',
        comboboxCandidates: ['Seattle'],
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    let reads = 0;
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: () => {
        reads += 1;
        if (reads === 1) return 'EMPTY';
        throw new Error('hostile readback');
      },
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(reads).toBe(3);
    expect(journal.size()).toBe(0);
    expect(trigger.value).toBe('Seattle');
  });

  it('trusted user input during option settling aborts before option click and is never journaled', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    let optionClicks = 0;
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => { optionClicks += 1; });
        slot.replaceChildren(option);
      }, 0);
      setTimeout(() => {
        trigger.value = 'candidate typing';
        const event = new Event('input', { bubbles: true });
        Object.defineProperty(event, 'isTrusted', { value: true });
        trigger.dispatchEvent(event);
      }, 10);
    });
    const journal = createUndoJournal();
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'combobox-user-edit-fence',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Location',
        value: 'Seattle',
        comboboxCandidates: ['Seattle'],
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: () => 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(optionClicks).toBe(0);
    expect(trigger.value).toBe('candidate typing');
    expect(journal.size()).toBe(0);
  });

  it('native Submit during option settling fences the option click and every remaining field', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const firstName = document.getElementById('first_name') as HTMLInputElement;
    const slot = form.querySelector('.select__menu-slot') as HTMLElement;
    const root = createScanRoot(form, []);
    let optionClicks = 0;
    trigger.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'Seattle';
        option.addEventListener('click', () => { optionClicks += 1; });
        slot.replaceChildren(option);
      }, 0);
      setTimeout(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }, 10);
    });
    const journal = createUndoJournal();
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'combobox-submit-fence',
      fillEmptyOnly: true,
      entries: [
        {
          kind: 'combobox',
          required: false,
          key: 'location',
          label: 'Location',
          value: 'Seattle',
          comboboxCandidates: ['Seattle'],
          element: trigger,
          confidence: 1,
          order: 0,
          signature: fieldSignature(trigger, root),
        },
        {
          kind: 'text',
          required: true,
          key: 'firstName',
          label: 'First Name',
          value: 'Ada',
          element: firstName,
          confidence: 1,
          order: 1,
          signature: fieldSignature(firstName, root),
        },
      ],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(
        plan.fingerprint,
        'fill',
        [...capabilitiesForKinds(['combobox', 'text'])],
      ),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: () => 'EMPTY',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'HOST_SUBMITTED' },
      { key: 'firstName', label: 'First Name', ok: false, reason: 'HOST_SUBMITTED' },
    ]);
    expect(summary.abortedBy).toBe('HOST_SUBMITTED');
    expect(optionClicks).toBe(0);
    expect(firstName.value).toBe('');
    expect(journal.size()).toBe(0);
  });

  it('a semantically matching backing value is already-filled with zero clicks', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const root = createScanRoot(form, []);
    trigger.dataset.selectedBacking = 'Seattle';
    let triggerClicks = 0;
    trigger.addEventListener('click', () => { triggerClicks += 1; });
    const journal = createUndoJournal();
    const record = vi.spyOn(journal, 'record');
    let validationReads = 0;
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'already-filled-combobox',
      fillEmptyOnly: true,
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'Location',
        value: 'Seattle',
        comboboxCandidates: ['Seattle'],
        element: trigger,
        confidence: 1,
        order: 0,
        signature: fieldSignature(trigger, root),
      }],
      skipped: [],
    };

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'MISMATCH',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
      readHostValidation: () => {
        validationReads += 1;
        return { ariaInvalid: 'false' };
      },
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'NOT_EMPTY' },
    ]);
    expect(summary).toMatchObject({ filled: 0, failed: 0 });
    expect(validationReads).toBe(2);
    expect(triggerClicks).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(journal.size()).toBe(0);
    expect(journal.canUndo()).toBe(false);
  });

  it('does not exempt non-combobox NOT_EMPTY from failed accounting', async () => {
    const form = mountGreenhouseWithCombobox();
    const firstName = document.getElementById('first_name') as HTMLInputElement;
    const root = createScanRoot(form, []);
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'text-already-filled-is-not-combobox-prefilled',
      fillEmptyOnly: true,
      entries: [{
        kind: 'text',
        required: false,
        key: 'firstName',
        label: 'First Name',
        value: 'Ada',
        element: firstName,
        confidence: 1,
        order: 0,
        signature: fieldSignature(firstName, root),
      }],
      skipped: [],
    };
    firstName.value = 'Candidate';

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['text'])]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([
      { key: 'firstName', label: 'First Name', ok: false, reason: 'NOT_EMPTY' },
    ]);
    expect(summary).toMatchObject({ filled: 0, failed: 1 });
  });

  it('demotes already-filled zero-click when late host validation changes semantic selection', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    const root = createScanRoot(form, []);
    trigger.dataset.selectedBacking = 'Seattle';
    let triggerPointers = 0;
    for (const eventName of ['mousedown', 'mouseup', 'click'] as const) {
      trigger.addEventListener(eventName, () => { triggerPointers += 1; });
    }
    let validationReads = 0;
    const journal = createUndoJournal();
    const plan = singleComboboxPlan(trigger, root, 'already-filled-late-semantic-drift');

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      comboboxOptionSource: testOptionSource,
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'MISMATCH',
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
      readHostValidation: () => {
        validationReads += 1;
        if (validationReads === 2) trigger.dataset.selectedBacking = 'Portland';
        return { ariaInvalid: 'false' };
      },
    });

    expect(validationReads).toBe(2);
    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'LATE_REVERTED' },
    ]);
    expect(summary.filled).toBe(0);
    expect(trigger.dataset.selectedBacking).toBe('Portland');
    expect(triggerPointers).toBe(0);
    expect(journal.size()).toBe(0);
  });

  it('normal bundled adapter stays default-off even for a visible semantic-looking match', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    trigger.value = 'Seattle';
    trigger.dataset.selectedBacking = 'Seattle';
    const root = greenhouseAdapter.resolveRoot(document)!;
    let triggerClicks = 0;
    trigger.addEventListener('click', () => { triggerClicks += 1; });
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { location: 'Seattle' },
    );

    expect(plan.entries.find((entry) => entry.key === 'location')?.kind).toBe('combobox');
    const journal = createUndoJournal();
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      readComboboxSelection: (liveTrigger) =>
        liveTrigger.dataset.selectedBacking === 'Seattle' ? 'MATCH' : 'MISMATCH',
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'CAPABILITY_DISABLED' },
    ]);
    expect(summary.filled).toBe(0);
    expect(triggerClicks).toBe(0);
    expect(journal.size()).toBe(0);
  });

  it('visible raw text with no semantic backing is zero-click CAPABILITY_DISABLED', async () => {
    const form = mountGreenhouseWithCombobox();
    const trigger = document.getElementById('location') as HTMLInputElement;
    trigger.value = 'candidate typing';
    const root = greenhouseAdapter.resolveRoot(document)!;
    let triggerClicks = 0;
    trigger.addEventListener('click', () => { triggerClicks += 1; });
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { location: 'Seattle' },
    );
    const journal = createUndoJournal();
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(['combobox'])]),
      journal,
      root,
      policy: testApplyPolicy(),
      readComboboxSelection: () => 'EMPTY',
      comboboxOptionSource: testOptionSource,
      rawComboboxUndoIsSemantic: () => true,
      comboboxSemanticTransactionSource: testSemanticTransactions,
    });

    expect(summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'CAPABILITY_DISABLED' },
    ]);
    expect(trigger.value).toBe('candidate typing');
    expect(triggerClicks).toBe(0);
    expect(journal.size()).toBe(0);
  });
});
