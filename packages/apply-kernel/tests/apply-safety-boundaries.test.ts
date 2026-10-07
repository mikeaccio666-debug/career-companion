import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyFieldDescriptor, ApplyFormDescriptor, ApplyPlan } from '../src/contracts';
import { buildAnswerPlan, buildApplyPlan, buildFillPlan, capabilitiesForPlan } from '../src/engine';
import type { SignOnBehalfKind } from '../src/dict/signOnBehalf';
import { fieldSignature } from '../src/fieldIdentity';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => { document.body.innerHTML = ''; });
const PROFILE = { firstName: 'Taylor', lastName: 'Fixture' };
const US_RECORD = [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'YES' }] as const;
const TERMS = 'I agree to the Terms and Conditions and Applicant Privacy Policy.';
const TRUTH = 'I certify that the information in this application is true and complete.';

type Control = 'text' | 'radio' | 'select' | 'combobox';
function form(label: string, control: Control = 'radio'): ApplyFormDescriptor {
  const markup = control === 'radio'
    ? `<fieldset><legend>${label}</legend><label><input id="q" name="q" type="radio">Yes</label><label><input id="no" name="q" type="radio">No</label></fieldset>`
    : control === 'select'
      ? `<label for="q">${label}</label><select id="q"><option value=""></option><option value="yes">Yes</option><option value="no">No</option></select>`
      : `<label for="q">${label}</label><input id="q"${control === 'combobox' ? ' role="combobox" aria-autocomplete="list"' : ''}>`;
  document.body.innerHTML = `<form><label for="ordinary">First name</label><input id="ordinary">${markup}</form>`;
  const root = createScanRoot(document.querySelector('form')!, [], []);
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>('#q')!;
  const shared = { element, key: null, label, required: true, confidence: 0, signature: fieldSignature(element, root) };
  const question: ApplyFieldDescriptor = control === 'radio'
    ? { ...shared, kind: 'choice', element: element as HTMLInputElement, choice: { control: 'radio', options: [
      { element: element as HTMLInputElement, label: 'Yes' },
      { element: document.querySelector<HTMLInputElement>('#no')!, label: 'No' },
    ] } }
    : control === 'select'
      ? { ...shared, kind: 'select', element: element as HTMLSelectElement }
      : control === 'combobox'
        ? { ...shared, kind: 'combobox', element: element as HTMLInputElement, listbox: { valueContainerSelector: 'form', selectedValueSelector: '[data-selected-value]' } }
        : { ...shared, kind: 'text', element: element as HTMLInputElement };
  const ordinary = document.querySelector<HTMLInputElement>('#ordinary')!;
  return { vendor: 'greenhouse', root, fields: [
    { kind: 'text', element: ordinary, key: 'firstName', label: 'First name', required: true, confidence: 1, signature: fieldSignature(ordinary, root) },
    question,
  ] };
}
async function execute(descriptor: ApplyFormDescriptor, plan: ApplyPlan) {
  const policy = testApplyPolicy();
  return runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForPlan(plan)]),
    journal: createUndoJournal(),
    root: descriptor.root,
    policy: { ...policy, capabilities: { ...policy.capabilities, 'set-work-authorization': true, 'sign-on-behalf': true } },
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 1,
  });
}
function expectQuestionUntouched(control: Control) {
  const question = document.querySelector<HTMLInputElement | HTMLSelectElement>('#q')!;
  if (control === 'radio') {
    expect((question as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>('#no')!.checked).toBe(false);
  } else expect(question.value).toBe('');
}

describe('10A explicit signing categories', () => {
  it.each([undefined, new Set<SignOnBehalfKind>(), new Set<SignOnBehalfKind>(['TERMS_CONSENT'])])('missing/empty/partial categories never implicitly authorize other signing kinds: %j', async kinds => {
    document.body.innerHTML = `<form><label for="name">First name</label><input id="name"><label for="terms">${TERMS}</label><input id="terms" type="checkbox"><label for="truth">${TRUTH}</label><input id="truth" type="checkbox"><label for="signature">Signature</label><input id="signature"></form>`;
    const root = createScanRoot(document.querySelector('form')!, [], []);
    const input = (id: string) => document.getElementById(id) as HTMLInputElement;
    const checkbox = (id: string, label: string): ApplyFieldDescriptor => ({
      kind: 'choice', element: input(id), key: null, label, required: true, confidence: 0,
      signature: fieldSignature(input(id), root), choice: { control: 'checkbox', options: [{ element: input(id), label }] },
    });
    const descriptor: ApplyFormDescriptor = { vendor: 'greenhouse', root, fields: [
      { kind: 'text', element: input('name'), key: 'firstName', label: 'First name', required: true, confidence: 1, signature: fieldSignature(input('name'), root) },
      checkbox('terms', TERMS), checkbox('truth', TRUTH),
      { kind: 'text', element: input('signature'), key: null, label: 'Signature', required: true, confidence: 0, signature: fieldSignature(input('signature'), root) },
    ] };
    const plan = buildApplyPlan(descriptor, PROFILE, { capabilities: { 'sign-on-behalf': true }, ...(kinds === undefined ? {} : { signOnBehalfKinds: kinds }) });
    const signing = plan.entries.filter(entry => entry.signOnBehalf !== undefined);
    expect(signing.map(entry => entry.signOnBehalf)).toEqual(kinds?.size === 1 ? ['TERMS_CONSENT'] : []);
    expect(plan.skipped.filter(item => [TRUTH, 'Signature'].includes(item.label)).map(item => item.reason)).toEqual(['MANUAL_ONLY', 'MANUAL_ONLY']);
    // No runtime consent callback: even an explicitly planned terms entry stays unwritten.
    const summary = await execute(descriptor, plan);
    expect(summary.results.find(result => result.key === 'firstName')).toMatchObject({ ok: true });
    expect(input('name').value).toBe('Taylor');
    expect(input('terms').checked).toBe(false);
    expect(input('truth').checked).toBe(false);
    expect(input('signature').value).toBe('');
  });
});

describe('10A missing-country answer boundary', () => {
  it.each(['Are you authorized to work in Canada?', 'Will you require visa sponsorship to work in Canada?', 'Are you eligible to work in Canada without sponsorship?'])('only a US F-1-style record cannot answer %s', async label => {
    const descriptor = form(label);
    const plan = buildApplyPlan(descriptor, PROFILE, { capabilities: { 'set-work-authorization': true }, workAuthorizations: US_RECORD, jobRegionCode: 'CA' });
    expect(plan.entries.map(entry => entry.key)).toEqual(['firstName']);
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'JOB_DEPENDENT', regionWithoutRecord: 'CA' })]);
    expect(plan.skipped[0]?.prefill).toBeUndefined();
    expect(plan.skipped[0]).not.toHaveProperty('defaultedRegionCode');
    await execute(descriptor, plan);
    expectQuestionUntouched('radio');
    expect(document.querySelector<HTMLInputElement>('#ordinary')!.value).toBe('Taylor');
  });

  it('an actual confirmed US record still fills through the same real runner', async () => {
    const descriptor = form('Are you authorized to work in the United States?');
    const plan = buildApplyPlan(descriptor, PROFILE, { capabilities: { 'set-work-authorization': true }, workAuthorizations: US_RECORD });
    expect(plan.entries.find(entry => entry.key === 'workAuthorization')).toMatchObject({ value: 'Yes' });
    const summary = await execute(descriptor, plan);
    expect(summary.results.every(result => result.ok)).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#q')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#ordinary')!.value).toBe('Taylor');
  });

  it('a separately user-reviewed answer remains distinct from an inferred default', async () => {
    const descriptor = form('Are you authorized to work in Canada?');
    const question = descriptor.fields[1]!;
    const plan = buildFillPlan(descriptor, PROFILE, [{ questionId: 'fictional-reviewed-country-answer', element: question.element, value: 'No' }], { capabilities: { 'set-work-authorization': true }, workAuthorizations: US_RECORD });
    expect(plan.entries.find(entry => entry.key === 'question:fictional-reviewed-country-answer')).toMatchObject({ value: 'No' });
    expect(plan.entries.some(entry => entry.key === 'workAuthorization')).toBe(false);
    const summary = await execute(descriptor, plan);
    expect(summary.results.every(result => result.ok)).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#q')!.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>('#no')!.checked).toBe(true);
  });
});

describe('10A citizenship questions in every supported planning entry', () => {
  const labels = ['Are you a U.S. citizen or green card holder?', 'Are you a lawful permanent resident?', 'What is your citizenship?', '你是美国公民或绿卡持有人吗？'];
  it.each(['text', 'radio', 'select', 'combobox'] as const)('%s stays user-only for profile, reviewed answer and remembered-answer merge', async control => {
    for (const label of labels) {
      for (const entry of ['profile', 'reviewed', 'merged'] as const) {
        const descriptor = form(label, control);
        const question = descriptor.fields[1]!;
        const answer = [{ questionId: 'fictional-citizenship-answer', element: question.element, value: 'Yes' }];
        const options = { capabilities: { 'set-work-authorization': true }, workAuthorizations: US_RECORD } as const;
        const plan = entry === 'profile' ? buildApplyPlan(descriptor, PROFILE, options)
          : entry === 'reviewed' ? buildAnswerPlan(descriptor, answer, options)
            : buildFillPlan(descriptor, PROFILE, answer, options);
        expect(plan.entries.some(item => item.element === question.element)).toBe(false);
        expect(plan.skipped.find(item => item.element === question.element)).toMatchObject({ reason: 'MANUAL_ONLY' });
        const opened = vi.fn();
        question.element.addEventListener('click', opened);
        await execute(descriptor, plan);
        expectQuestionUntouched(control);
        expect(opened).not.toHaveBeenCalled();
        if (entry !== 'reviewed') expect(document.querySelector<HTMLInputElement>('#ordinary')!.value).toBe('Taylor');
      }
    }
  });

  it('ordinary user-reviewed answers are still writable', async () => {
    const descriptor = form('Which shift do you prefer?', 'text');
    const question = descriptor.fields[1]!;
    const plan = buildFillPlan(descriptor, PROFILE, [{ questionId: 'fictional-shift-answer', element: question.element, value: 'Day shift' }]);
    expect(plan.entries.map(item => item.key)).toEqual(['firstName', 'question:fictional-shift-answer']);
    const summary = await execute(descriptor, plan);
    expect(summary.results.every(result => result.ok)).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#q')!.value).toBe('Day shift');
  });
});
