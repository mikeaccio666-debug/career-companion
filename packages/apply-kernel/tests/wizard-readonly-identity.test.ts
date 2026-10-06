// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseWizardReadOnlyDeclaration,
  readDeclaredWizardStep,
  sameDeclaredWizardStep,
} from '../src/rules/wizardIdentity';

const declaration = () => ({
  schemaVersion: 1,
  wizardKey: 'application',
  applicationRootSelector: '#application',
  indicatorContainerSelector: '#steps',
  steps: [
    { stepKey: 'contact', indicatorSelector: '#contact-step' },
    { stepKey: 'experience', indicatorSelector: '#experience-step' },
  ],
});

function read() {
  const parsed = parseWizardReadOnlyDeclaration(declaration());
  if (!parsed.ok) throw new Error('TEST_DECLARATION_INVALID');
  return readDeclaredWizardStep({ declaration: parsed.value, document, isVisible: () => true });
}

beforeEach(() => {
  document.body.innerHTML = `<main id="application">
    <ol id="steps">
      <li id="contact-step" aria-current="step" aria-controls="contact-panel">Contact</li>
      <li id="experience-step" aria-controls="experience-panel">Experience</li>
    </ol>
    <section id="contact-panel"><input value="person-kept-value"></section>
    <section id="experience-panel" hidden><input></section>
  </main>`;
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('unpublished read-only wizard declaration', () => {
  it('takes an immutable exact snapshot and rejects untrusted copies at observation time', () => {
    const source = declaration();
    const parsed = parseWizardReadOnlyDeclaration(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    source.steps[0]!.stepKey = 'changed';
    expect(parsed.value.steps[0]!.stepKey).toBe('contact');
    expect(Object.isFrozen(parsed.value.steps[0])).toBe(true);
    expect(readDeclaredWizardStep({ declaration: { ...parsed.value }, document, isVisible: () => true }))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  });

  it.each([
    { ...declaration(), schemaVersion: 2 },
    { ...declaration(), extra: true },
    { ...declaration(), wizardKey: 'answer text' },
    { ...declaration(), applicationRootSelector: '' },
    { ...declaration(), steps: [] },
    { ...declaration(), steps: Array.from({ length: 65 }, (_, i) => ({ stepKey: `s${i}`, indicatorSelector: `#s${i}` })) },
    { ...declaration(), steps: [{ stepKey: 'same', indicatorSelector: '#a' }, { stepKey: 'same', indicatorSelector: '#b' }] },
    { ...declaration(), steps: [{ stepKey: 'a', indicatorSelector: '#same' }, { stepKey: 'b', indicatorSelector: '#same' }] },
  ])('rejects malformed or ambiguous declaration data', (value) => {
    expect(parseWizardReadOnlyDeclaration(value)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('does not execute an accessor while parsing untrusted data', () => {
    const getter = vi.fn(() => 'application');
    const value = declaration();
    Object.defineProperty(value, 'wizardKey', { get: getter, enumerable: true });
    expect(parseWizardReadOnlyDeclaration(value)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('exact declared step observation', () => {
  it('reads the unique current indicator and visible controlled panel without changing the page', () => {
    const before = document.body.innerHTML;
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const result = read();
    expect(result).toMatchObject({ ok: true, value: { wizardKey: 'application', stepKey: 'contact', stepIndex: 0, stepCount: 2 } });
    expect(document.body.innerHTML).toBe(before);
    expect(click).not.toHaveBeenCalled();
    const again = read();
    expect(result.ok && again.ok && sameDeclaredWizardStep(result.value, again.value)).toBe(true);
  });

  it('recognizes an explicit next step but does not equate same-key panel replacement with stability', () => {
    const first = read();
    document.querySelector('#contact-step')!.removeAttribute('aria-current');
    document.querySelector('#experience-step')!.setAttribute('aria-current', 'step');
    document.querySelector('#contact-panel')!.setAttribute('hidden', '');
    document.querySelector('#experience-panel')!.removeAttribute('hidden');
    const next = read();
    expect(next).toMatchObject({ ok: true, value: { stepKey: 'experience', stepIndex: 1 } });
    expect(first.ok && next.ok && sameDeclaredWizardStep(first.value, next.value)).toBe(false);
    const panel = document.querySelector('#experience-panel')!;
    panel.replaceWith(panel.cloneNode(true));
    const replaced = read();
    expect(next.ok && replaced.ok && sameDeclaredWizardStep(next.value, replaced.value)).toBe(false);
  });

  it.each(['missing-current', 'two-current', 'conflicting-current', 'duplicate-root', 'duplicate-id', 'broken-controls', 'multiple-controls', 'hidden', 'inert', 'foreign-panel'])(
    'refuses unproved identity: %s', (scenario) => {
      const indicator = document.querySelector('#contact-step')!;
      const panel = document.querySelector('#contact-panel')!;
      if (scenario === 'missing-current') indicator.removeAttribute('aria-current');
      if (scenario === 'two-current') document.querySelector('#experience-step')!.setAttribute('aria-current', 'step');
      if (scenario === 'conflicting-current') document.querySelector('#experience-step')!.setAttribute('aria-current', 'page');
      if (scenario === 'duplicate-root') document.body.append(document.querySelector('#application')!.cloneNode(true));
      if (scenario === 'duplicate-id') document.body.append(panel.cloneNode(true));
      if (scenario === 'broken-controls') indicator.setAttribute('aria-controls', 'missing');
      if (scenario === 'multiple-controls') indicator.setAttribute('aria-controls', 'contact-panel experience-panel');
      if (scenario === 'hidden') panel.setAttribute('hidden', '');
      if (scenario === 'inert') panel.setAttribute('inert', '');
      if (scenario === 'foreign-panel') document.body.append(panel);
      expect(read()).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    },
  );

  it('requires fresh visibility and rejects a forged observation', () => {
    const parsed = parseWizardReadOnlyDeclaration(declaration());
    if (!parsed.ok) throw new Error('TEST_DECLARATION_INVALID');
    expect(readDeclaredWizardStep({ declaration: parsed.value, document, isVisible: () => false }))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    const result = read();
    expect(result.ok && sameDeclaredWizardStep(result.value, { ...result.value })).toBe(false);
  });
});
