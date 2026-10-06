import { afterEach, describe, expect, it } from 'vitest';
import workdayRules from '@edaix/apply-rules/workday.json';
import { buildAnswerPlan } from '../src/engine';
import { collectClickFacts } from '../src/click/facts';
import { evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import type { ApplyFormDescriptor } from '../src/contracts';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Workday's "How Did You Hear About Us?" prompt, measured live on
 * nvidia.wd5.myworkdayjobs.com on 2026-09-15.
 *
 * The widget defeats every existing combobox path at once: the menu is portaled
 * to `<body>` with **no `id`** and the trigger never gains
 * `aria-controls`/`aria-owns` (so `withinOwnedPopup` proves nothing and the
 * option click died on `OUTSIDE_FORM` before any event was dispatched); the row
 * that answers a pointer is a role-less `div[data-automation-id="promptOption"]`
 * *inside* the `[role="option"]` wrapper (events on the wrapper do nothing);
 * typing filters nothing; and the answers are one level below six categories,
 * with "Linkedin Jobs" under "Job Board".
 *
 * This file locks three things:
 *  1. the `withinRuleDeclaredPopup` carve-out lifts **only** `OUTSIDE_FORM`, only
 *     for a `transaction-option`, and an arbitrary `<body>`-level element is
 *     still denied — that last one is the whole point of the narrowness;
 *  2. the fact is derived from the live DOM every time, and a popup-root
 *     selector that names two nodes proves nothing;
 *  3. the writer walks one level of categories to reach the leaf, and fails
 *     closed (clicking nothing) when no leaf matches.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

// ───────────────────────────────────────────────────────────── policy surface

function target(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: false,
    kind: 'combobox-trigger',
    planned: true,
    openedByTransaction: false,
    tagName: 'div',
    buttonType: null,
    accessibleName: '',
    labelText: '',
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hasHref: false,
    hrefNavigates: true,
    ...overrides,
  };
}

/** A Workday prompt row: portaled, role-less, proven by rule data alone. */
const promptRow = (overrides: Partial<ClickTargetFacts> = {}) => target({
  kind: 'transaction-option',
  openedByTransaction: true,
  withinFormRoot: false,
  withinRuleDeclaredPopup: true,
  ruleDeclaredOption: true,
  ...overrides,
});

describe('the OUTSIDE_FORM lift for a rule-declared popup is exactly one deny wide', () => {
  it('needs both derived facts, and lifts nothing without the popup proof', () => {
    expect(evaluateClickTarget(promptRow())).toEqual({ allowed: true });
    expect(evaluateClickTarget(promptRow({ withinRuleDeclaredPopup: false })))
      .toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
    expect(evaluateClickTarget(promptRow({ withinRuleDeclaredPopup: undefined })))
      .toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
    // Inside the declared popup but not the declared row shape: still not an option.
    expect(evaluateClickTarget(promptRow({ ruleDeclaredOption: false })))
      .toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
  });

  it('lifts nothing for any other target kind', () => {
    for (const kind of ['combobox-trigger', 'reviewed-option', 'datepicker-cell', 'row-add', 'other'] as const) {
      expect(evaluateClickTarget(promptRow({ kind, ...(kind === 'row-add' ? { declaredRowAction: 'add' as const } : {}) })))
        .toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
    }
    expect(evaluateClickTarget(promptRow({ kind: 'choice-member', tagName: 'input', inputType: 'radio', choiceControl: 'radio' })))
      .toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });

  it('keeps every other deny for a row inside the declared popup', () => {
    expect(evaluateClickTarget(promptRow({ isHidden: true }))).toEqual({ allowed: false, reason: 'HIDDEN_CONTROL' });
    expect(evaluateClickTarget(promptRow({ isDisabled: true }))).toEqual({ allowed: false, reason: 'HIDDEN_CONTROL' });
    expect(evaluateClickTarget(promptRow({ isLikelyOffscreen: true }))).toEqual({ allowed: false, reason: 'HIDDEN_CONTROL' });
    expect(evaluateClickTarget(promptRow({ labelText: 'Submit application' }))).toEqual({ allowed: false, reason: 'SUBMIT_NAME' });
    expect(evaluateClickTarget(promptRow({ tagName: 'a', hasHref: true }))).toEqual({ allowed: false, reason: 'LINK' });
    expect(evaluateClickTarget(promptRow({ inCaptcha: true }))).toEqual({ allowed: false, reason: 'CAPTCHA' });
    expect(evaluateClickTarget(promptRow({ inPasswordContainer: true }))).toEqual({ allowed: false, reason: 'PASSWORD' });
    expect(evaluateClickTarget(promptRow({ labelText: 'I agree to the terms' }))).toEqual({ allowed: false, reason: 'CONSENT' });
    expect(evaluateClickTarget(promptRow({ openedByTransaction: false }))).toEqual({ allowed: false, reason: 'FOREIGN_TRANSACTION' });
    expect(evaluateClickTarget(promptRow({ planned: false }))).toEqual({ allowed: false, reason: 'NOT_PLANNED' });
    expect(evaluateClickTarget(promptRow({ isLikelyHoneyPot: true }))).toEqual({ allowed: false, reason: 'HONEYPOT' });
  });
});

// ─────────────────────────────────────────────────── facts derived from the DOM

describe('collectClickFacts derives the popup facts, never takes them on trust', () => {
  function mount(extraPopup = false): { trigger: HTMLInputElement; root: ReturnType<typeof createScanRoot> } {
    document.body.innerHTML = `
      <div data-automation-id="applyFlowMyInfoPage">
        <div data-automation-id="formField-source">
          <label for="source--source">How Did You Hear About Us?</label>
          <div data-automation-id="multiSelectContainer">
            <input id="source--source" data-uxi-widget-type="selectinput" type="text" value="">
          </div>
        </div>
      </div>
      <input id="stray-trigger" type="text">
      <div data-automation-id="responsiveMonikerPrompt">
        <div data-automation-id="activeListContainer" role="listbox">
          <div role="option" data-automation-id="menuItem">
            <div data-automation-id="promptOption" id="row-job-board">Job Board</div>
          </div>
          <span id="chrome-inside-popup">not a row</span>
        </div>
      </div>
      ${extraPopup ? '<div data-automation-id="activeListContainer" role="listbox"><div data-automation-id="promptOption" id="decoy">Decoy</div></div>' : ''}
      <div id="body-level-intruder" data-automation-id="promptOption">I am nowhere near the popup</div>`;
    return {
      trigger: document.getElementById('source--source') as HTMLInputElement,
      root: createScanRoot(document.querySelector('[data-automation-id="applyFlowMyInfoPage"]')!, [], []),
    };
  }
  const shape = {
    rootSelector: 'div[data-automation-id="activeListContainer"][role="listbox"]',
    optionSelector: '[data-automation-id="promptOption"]',
  };
  const facts = (element: Element, root: ReturnType<typeof createScanRoot>, trigger?: Element) =>
    collectClickFacts({
      element,
      root,
      kind: 'transaction-option',
      planned: true,
      openedByTransaction: true,
      ...(trigger ? { declaredPopup: { trigger, ...shape } } : {}),
    });

  it('is absent without a declared popup and true for a row inside the one the rule names', () => {
    const { trigger, root } = mount();
    const row = document.getElementById('row-job-board')!;
    expect('withinRuleDeclaredPopup' in facts(row, root)).toBe(false);
    expect(facts(row, root, trigger)).toMatchObject({
      withinFormRoot: false,
      withinRuleDeclaredPopup: true,
      ruleDeclaredOption: true,
    });
    expect(evaluateClickTarget(facts(row, root, trigger))).toEqual({ allowed: true });
  });

  /** The narrowness proof the carve-out exists to earn. */
  it('still denies an arbitrary body-level element, even one wearing the rule’s option selector', () => {
    const { trigger, root } = mount();
    const intruder = document.getElementById('body-level-intruder')!;
    expect(facts(intruder, root, trigger)).toMatchObject({
      withinFormRoot: false,
      withinRuleDeclaredPopup: false,
      ruleDeclaredOption: false,
    });
    expect(evaluateClickTarget(facts(intruder, root, trigger))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });

  it('denies popup chrome that is not the declared row shape, and the popup root itself', () => {
    const { trigger, root } = mount();
    const chrome = document.getElementById('chrome-inside-popup')!;
    expect(facts(chrome, root, trigger)).toMatchObject({ withinRuleDeclaredPopup: true, ruleDeclaredOption: false });
    expect(evaluateClickTarget(facts(chrome, root, trigger))).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    const popup = document.querySelector(shape.rootSelector)!;
    expect(facts(popup, root, trigger)).toMatchObject({ withinRuleDeclaredPopup: false });
  });

  it('proves nothing when the popup selector names two nodes, or the trigger is outside the form root', () => {
    const two = mount(true);
    const row = document.getElementById('row-job-board')!;
    expect(facts(row, two.root, two.trigger)).toMatchObject({ withinRuleDeclaredPopup: false, ruleDeclaredOption: false });
    expect(evaluateClickTarget(facts(row, two.root, two.trigger))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });

    const one = mount();
    const stray = document.getElementById('stray-trigger')!;
    expect(facts(document.getElementById('row-job-board')!, one.root, stray))
      .toMatchObject({ withinRuleDeclaredPopup: false, ruleDeclaredOption: false });
  });

  it('refuses to answer when a caller hands over both rule-declared option shapes', () => {
    const { trigger, root } = mount();
    const row = document.getElementById('row-job-board')!;
    const both = collectClickFacts({
      element: row,
      root,
      kind: 'transaction-option',
      planned: true,
      openedByTransaction: true,
      declaredPopup: { trigger, ...shape },
      declaredSuggestion: { container: document.querySelector(shape.rootSelector)!, selector: shape.optionSelector },
    });
    expect(both).toMatchObject({ withinRuleDeclaredPopup: false, ruleDeclaredOption: false });
    expect(evaluateClickTarget(both)).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });
});

// ──────────────────────────────────────────────────────── the writer, end to end

const TREE: Readonly<Record<string, readonly string[]>> = {
  Associations: ['Atidim', 'Impact', 'Moshal'],
  'Event/Conference': ['CVPR 2026', 'GDC 2026'],
  'Job Board': ['Glassdoor', 'Indeed', 'Linkedin Jobs', 'Monster'],
  'Social Media': ['Facebook', 'Twitter', 'YouTube'],
  University: ['Technion', 'Stanford'],
  Website: ['NVIDIA Careers'],
};
const CATEGORIES = Object.keys(TREE);

interface PromptWidget {
  readonly trigger: HTMLInputElement;
  /** Every row text the widget was asked to commit, in order. */
  readonly picked: string[];
  readonly opens: number[];
}

/**
 * A stand-in for the live widget, wired to the same three measurements: the menu
 * is portaled outside the form root with no `id` and no `aria-controls`, only the
 * inner role-less row answers a pointer, and clicking the trigger again returns
 * an open menu to the top level.
 */
function mountWorkdayPrompt(): PromptWidget {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowMyInfoPage">
      <div data-automation-id="formField-source">
        <label for="source--source">How Did You Hear About Us?</label>
        <div data-automation-id="multiSelectContainer">
          <div data-automation-id="multiselectInputContainer">
            <input id="source--source" data-uxi-widget-type="selectinput" type="text" placeholder="Search" value="">
          </div>
          <ul role="listbox" data-automation-id="selectedItemList"></ul>
        </div>
      </div>
    </div>`;
  const trigger = document.getElementById('source--source') as HTMLInputElement;
  const container = document.querySelector('[data-automation-id="multiSelectContainer"]')!;
  const picked: string[] = [];
  const opens: number[] = [];

  const closeMenu = () => document.querySelector('[data-automation-id="responsiveMonikerPrompt"]')?.remove();
  const render = (rows: readonly string[]) => {
    closeMenu();
    const portal = document.createElement('div');
    portal.setAttribute('data-automation-id', 'responsiveMonikerPrompt');
    portal.innerHTML = `<div data-automation-id="activeListContainer" role="listbox">${rows
      .map((text) => `<div role="option" data-automation-id="menuItem" aria-label="${text} not checked"><div data-automation-id="promptOption">${text}</div></div>`)
      .join('')}</div>`;
    document.body.append(portal);
  };

  trigger.addEventListener('click', () => { opens.push(opens.length); render(CATEGORIES); });
  // Only the inner row reacts; the `[role=option]` wrapper is inert, exactly as measured.
  document.addEventListener('click', (event) => {
    const row = event.target as Element;
    if (row.getAttribute('data-automation-id') !== 'promptOption') return;
    const text = row.textContent ?? '';
    if (text in TREE) { render(TREE[text]!); return; }
    picked.push(text);
    closeMenu();
    container.querySelector('[data-automation-id="selectedItem"]')?.remove();
    const chip = document.createElement('div');
    chip.setAttribute('data-automation-id', 'selectedItem');
    chip.textContent = text;
    container.append(chip);
  });
  return { trigger, picked, opens };
}

/** The bundled policy with the vendor under test switched on, like every other workday test. */
function workdayPolicy() {
  const bundled = testApplyPolicy();
  return { ...bundled, vendors: { ...bundled.vendors, workday: true } };
}

function workdayAdapter() {
  return compileBundledAdapter(structuredClone(workdayRules) as Record<string, unknown>);
}

async function answer(value: string) {
  const adapter = workdayAdapter();
  const root = adapter.resolveRoot(document)!;
  const fields = [...adapter.scan(root)];
  const source = fields.find((field) => field.label.startsWith('How Did You Hear'))!;
  const descriptor: ApplyFormDescriptor = { vendor: 'workday', root, fields };
  const plan = buildAnswerPlan(descriptor, [{ questionId: 'source', element: source.element, value }]);
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root,
    policy: workdayPolicy(),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 5,
  });
  return { fields, source, result: summary.results[0] };
}

describe('the hierarchical prompt writer', () => {
  it('scans the plain text input as a combobox carrying the prompt binding', () => {
    mountWorkdayPrompt();
    const adapter = workdayAdapter();
    const root = adapter.resolveRoot(document)!;
    expect(adapter.scan(root).find((field) => field.element.id === 'source--source')).toMatchObject({
      kind: 'combobox',
      listbox: {
        valueContainerSelector: '[data-automation-id="multiSelectContainer"]',
        selectedValueSelector: '[data-automation-id="selectedItem"]',
        hierarchicalPrompt: {
          popupRootSelector: 'div[data-automation-id="activeListContainer"][role="listbox"]',
          optionSelector: '[data-automation-id="promptOption"]',
          maxCategories: 8,
        },
      },
    });
  });

  it('walks one level of categories to reach the leaf, and reads the widget’s own display back', async () => {
    const widget = mountWorkdayPrompt();
    const { result } = await answer('Linkedin Jobs');
    expect(result).toMatchObject({ ok: true });
    expect(widget.picked).toEqual(['Linkedin Jobs']);
    expect(document.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('Linkedin Jobs');
    // The menu is gone: a row clicked in a menu that stays open is not a selection.
    expect(document.querySelector('[data-automation-id="activeListContainer"]')).toBeNull();
  });

  it('matches a leaf through the shared candidate ladder, not only verbatim', async () => {
    const widget = mountWorkdayPrompt();
    // "LinkedIn" is the reviewed answer; "Linkedin Jobs" is the host's wording.
    expect((await answer('LinkedIn')).result).toMatchObject({ ok: true });
    expect(widget.picked).toEqual(['Linkedin Jobs']);
  });

  it('fails closed with nothing clicked when no leaf matches', async () => {
    const widget = mountWorkdayPrompt();
    expect((await answer('Carrier Pigeon')).result).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(widget.picked).toEqual([]);
    expect(document.querySelector('[data-automation-id="selectedItem"]')).toBeNull();
  });

  it('never walks past the rule’s category budget', async () => {
    const widget = mountWorkdayPrompt();
    await answer('NVIDIA Careers');
    // Six categories, "Website" last: one open plus one reset per earlier category.
    expect(widget.picked).toEqual(['NVIDIA Careers']);
    expect(widget.opens.length).toBeLessThanOrEqual(1 + CATEGORIES.length);
  });

  it('leaves an existing selection alone', async () => {
    mountWorkdayPrompt();
    const chip = document.createElement('div');
    chip.setAttribute('data-automation-id', 'selectedItem');
    chip.textContent = 'Indeed';
    document.querySelector('[data-automation-id="multiSelectContainer"]')!.append(chip);
    expect((await answer('Linkedin Jobs')).result).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(document.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('Indeed');
  });

  it('without the rule binding the same input stays an ordinary text field', () => {
    mountWorkdayPrompt();
    const unbound = structuredClone(workdayRules) as Record<string, unknown>;
    delete unbound['promptComboboxes'];
    const adapter = compileBundledAdapter(unbound);
    const root = adapter.resolveRoot(document)!;
    expect(adapter.scan(root).find((field) => field.element.id === 'source--source'))
      .toMatchObject({ kind: 'text' });
  });
});
