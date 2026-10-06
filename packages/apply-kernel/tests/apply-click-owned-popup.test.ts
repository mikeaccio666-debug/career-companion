import { afterEach, describe, expect, it } from 'vitest';
import { collectClickFacts } from '../src/click/facts';
import { evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';
import { clickHostTarget } from '../src/click/primitives';
import { consumeAuthority } from '../src/grant';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/** An authority inside its synchronous run, the only state in which a host click may happen. */
function activeAuthority() {
  const authority = testAuthority(null, 'fill', ['set-combobox']);
  expect(consumeAuthority(authority).ok).toBe(true);
  return authority;
}

/**
 * Two click-policy findings from live pages on 2026-09-15:
 *
 *  · Ashby portals its autocomplete `[role=listbox]` to `<body>`, outside the scan root,
 *    so an option in the widget's own list was `OUTSIDE_FORM`. The lift is narrow: only a
 *    `transaction-option` inside the `[role=listbox]` that an in-form trigger names through
 *    `aria-controls`/`aria-owns`, and the fact is derived from the DOM, never asserted.
 *  · Greenhouse's "Are you legally authorized to work in the United States for our
 *    Company?" react-select was `CLICK_DENIED` at the trigger: its accessible name is the
 *    question, and the bare `legal` token read it as a legal declaration.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function target(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
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

const option = (overrides: Partial<ClickTargetFacts> = {}) =>
  target({ kind: 'transaction-option', openedByTransaction: true, role: 'option', tagName: 'div', ...overrides });

describe('OUTSIDE_FORM lift for an option inside the popup its in-form trigger owns', () => {
  it('allows a portaled option only when the owned-popup fact is proven', () => {
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: true }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(option({ withinFormRoot: false }))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: false }))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });

  it('lifts nothing for other target kinds', () => {
    expect(evaluateClickTarget(target({ withinFormRoot: false, withinOwnedPopup: true }))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
    expect(evaluateClickTarget(target({ kind: 'choice-label', tagName: 'label', choiceControl: 'radio', withinFormRoot: false, withinOwnedPopup: true }))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });

  it('keeps every other deny for a portaled option', () => {
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: true, isHidden: true }))).toEqual({ allowed: false, reason: 'HIDDEN_CONTROL' });
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: true, labelText: 'Submit application' }))).toEqual({ allowed: false, reason: 'SUBMIT_NAME' });
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: true, inCaptcha: true }))).toEqual({ allowed: false, reason: 'CAPTCHA' });
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: true, openedByTransaction: false }))).toEqual({ allowed: false, reason: 'FOREIGN_TRANSACTION' });
    expect(evaluateClickTarget(option({ withinFormRoot: false, withinOwnedPopup: true, planned: false }))).toEqual({ allowed: false, reason: 'NOT_PLANNED' });
  });
});

describe('collectClickFacts derives withinOwnedPopup from the DOM', () => {
  function mount(): { trigger: HTMLInputElement; root: ReturnType<typeof createScanRoot> } {
    document.body.innerHTML = `
      <div class="container">
        <label for="loc">Location</label>
        <input id="loc" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-haspopup="listbox" aria-controls="portal-list">
      </div>
      <div id="portal-root">
        <div id="portal-list" role="listbox"><div role="option" id="inside">San Francisco, California, United States</div></div>
        <div id="other-list" role="listbox"><div role="option" id="elsewhere">Oakland</div></div>
        <div id="plain-popup"><div role="option" id="in-plain">Berkeley</div></div>
      </div>
      <input id="stray" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="other-list">`;
    const container = document.querySelector('.container')!;
    return { trigger: document.getElementById('loc') as HTMLInputElement, root: createScanRoot(container, [], []) };
  }
  const facts = (element: Element, root: ReturnType<typeof createScanRoot>, popupOwner?: Element) =>
    collectClickFacts({ element, root, kind: 'transaction-option', planned: true, openedByTransaction: true, ...(popupOwner ? { popupOwner } : {}) });

  it('is absent without an owner, true inside the owner’s listbox, false anywhere else', () => {
    const { trigger, root } = mount();
    expect('withinOwnedPopup' in facts(document.getElementById('inside')!, root)).toBe(false);
    expect(facts(document.getElementById('inside')!, root, trigger)).toMatchObject({ withinFormRoot: false, withinOwnedPopup: true });
    expect(facts(document.getElementById('elsewhere')!, root, trigger)).toMatchObject({ withinFormRoot: false, withinOwnedPopup: false });
  });

  it('needs the owner inside the form root and a real [role=listbox] popup', () => {
    const { trigger, root } = mount();
    const stray = document.getElementById('stray')!;
    expect(facts(document.getElementById('elsewhere')!, root, stray)).toMatchObject({ withinOwnedPopup: false });
    trigger.setAttribute('aria-controls', 'plain-popup');
    expect(facts(document.getElementById('in-plain')!, root, trigger)).toMatchObject({ withinOwnedPopup: false });
    trigger.removeAttribute('aria-controls');
    expect(facts(document.getElementById('inside')!, root, trigger)).toMatchObject({ withinOwnedPopup: false });
  });

  it('the derived fact makes a portaled option clickable by policy while a stray one stays outside the form', () => {
    const { trigger, root } = mount();
    expect(evaluateClickTarget(facts(document.getElementById('inside')!, root, trigger))).toEqual({ allowed: true });
    expect(evaluateClickTarget(facts(document.getElementById('elsewhere')!, root, trigger))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });
});

describe('rule-declared typeahead suggestion rows count as option-shaped', () => {
  it('allows a role-less transaction-option only with the derived fact, lifting no other deny', () => {
    expect(evaluateClickTarget(option({ role: undefined }))).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget(option({ role: undefined, ruleDeclaredOption: true }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(option({ role: undefined, ruleDeclaredOption: false }))).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget(option({ role: undefined, ruleDeclaredOption: true, withinFormRoot: false }))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
    expect(evaluateClickTarget(option({ role: undefined, ruleDeclaredOption: true, openedByTransaction: false }))).toEqual({ allowed: false, reason: 'FOREIGN_TRANSACTION' });
    expect(evaluateClickTarget(option({ role: undefined, ruleDeclaredOption: true, isHidden: true }))).toEqual({ allowed: false, reason: 'HIDDEN_CONTROL' });
    expect(evaluateClickTarget(target({ ruleDeclaredOption: true, tagName: 'button', buttonType: '' }))).toEqual({ allowed: false, reason: 'IMPLICIT_SUBMIT_BUTTON' });
  });

  it('is derived from containment and the rule selector, never asserted', () => {
    document.body.innerHTML = `
      <form id="application-form"><li class="application-question"><label>Current location
        <input id="location-input" class="location-input" name="location">
        <div class="dropdown-container"><div class="dropdown-results"><div class="dropdown-location" id="location-0">San Francisco, California, United States</div></div></div>
      </label></li>
      <div class="dropdown-location" id="stray">Oakland</div></form>`;
    const container = document.querySelector('li.application-question')!;
    const root = createScanRoot(document.getElementById('application-form')!, [], []);
    const declaredSuggestion = { container, selector: '.dropdown-results > .dropdown-location' };
    const facts = (element: Element) => collectClickFacts({ element, root, kind: 'transaction-option', planned: true, openedByTransaction: true, declaredSuggestion });
    expect(facts(document.getElementById('location-0')!)).toMatchObject({ withinFormRoot: true, ruleDeclaredOption: true });
    expect(evaluateClickTarget(facts(document.getElementById('location-0')!))).toEqual({ allowed: true });
    expect(facts(document.getElementById('stray')!)).toMatchObject({ ruleDeclaredOption: false });
    expect(evaluateClickTarget(facts(document.getElementById('stray')!))).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(facts(container)).toMatchObject({ ruleDeclaredOption: false });
    expect('ruleDeclaredOption' in collectClickFacts({ element: document.getElementById('location-0')!, root, kind: 'transaction-option', planned: true, openedByTransaction: true })).toBe(false);
  });
});

describe('a target the widget detaches inside its own mousedown handler', () => {
  function mountRow(removeOn: 'mousedown' | 'click' | null) {
    document.body.innerHTML = `
      <form id="application-form"><li class="application-question"><label>Current location
        <input id="location-input" class="location-input" name="location">
        <div class="dropdown-results"><div class="dropdown-location" id="location-0">San Francisco, California, United States</div></div>
      </label></li></form>`;
    const row = document.getElementById('location-0')!;
    const seen: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click'] as const) {
      row.addEventListener(type, () => {
        seen.push(type);
        if (type === removeOn) row.remove();
      });
    }
    const root = createScanRoot(document.getElementById('application-form')!, [], []);
    const declaredSuggestion = { container: document.querySelector('li.application-question')!, selector: '.dropdown-results > .dropdown-location' };
    const facts = collectClickFacts({ element: row, root, kind: 'transaction-option', planned: true, openedByTransaction: true, declaredSuggestion });
    const journal = createUndoJournal();
    return { row, root, facts, seen, declaredSuggestion, ticket: journal.record(document.getElementById('location-input') as HTMLInputElement) };
  }

  it('counts as delivered on the generic lane and sends nothing further to the detached node', () => {
    const { row, root, facts, seen, declaredSuggestion, ticket } = mountRow('mousedown');
    const result = clickHostTarget({ element: row, facts, root, authority: activeAuthority(), ticket, policy: testApplyPolicy(), declaredSuggestion });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual(['mousedown']);
  });

  it('still completes the full sequence when the widget only reacts on click', () => {
    const { row, root, facts, seen, declaredSuggestion, ticket } = mountRow('click');
    expect(clickHostTarget({ element: row, facts, root, authority: activeAuthority(), ticket, policy: testApplyPolicy(), declaredSuggestion })).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it('keeps the rule-owned verdict on the semantic lane: a fence that sees the detachment still stops the sequence', () => {
    const { row, root, facts, seen, declaredSuggestion, ticket } = mountRow('mousedown');
    const result = clickHostTarget({
      element: row,
      facts,
      root,
      authority: activeAuthority(),
      ticket,
      policy: testApplyPolicy(),
      declaredSuggestion,
      pointerSequenceFence: (phase) => (phase === 'after-mousedown' && !row.isConnected ? 'IDENTITY_CHANGED' : null),
    });
    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(seen).toEqual(['mousedown']);
  });
});

describe('legal-declaration deny reads a combobox trigger as a question', () => {
  it.each([
    'Are you legally authorized to work in the United States for our Company?',
    'Do you have the legal right to work in the UK?',
    '您是否具备在美国合法工作的法律资格？',
  ])('allows the trigger %s', (accessibleName) => {
    expect(evaluateClickTarget(target({ accessibleName }))).toEqual({ allowed: true });
  });

  it.each([
    'I certify that this information is true',
    'Acknowledgment of the employee handbook',
    'Declaration of accuracy',
    'Waiver of liability',
    '法律声明',
  ])('still denies a declaration-shaped trigger %s', (accessibleName) => {
    expect(evaluateClickTarget(target({ accessibleName }))).toEqual({ allowed: false, reason: 'LEGAL_DECLARATION' });
  });

  it('keeps the whole-text deny (bare "legal") for options, labels and proxies', () => {
    expect(evaluateClickTarget(option({ labelText: 'Legal name' }))).toEqual({ allowed: false, reason: 'LEGAL_DECLARATION' });
    expect(evaluateClickTarget(target({ kind: 'choice-label', tagName: 'label', choiceControl: 'checkbox', accessibleName: 'I have read the legal notice' }))).toEqual({ allowed: false, reason: 'LEGAL_DECLARATION' });
  });

  it('a consent-worded trigger is still consent, never opened', () => {
    expect(evaluateClickTarget(target({ accessibleName: 'Do you consent to a background check?' }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });
});
