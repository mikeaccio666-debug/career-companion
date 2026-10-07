import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyFormDescriptor } from '../src/contracts';
import { buildAnswerPlan, buildApplyPlan, buildFillPlan, capabilitiesForPlan } from '../src/engine';
import { fieldSignature } from '../src/fieldIdentity';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { runApplyPlan } from '../src/runner';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => { document.body.innerHTML = ''; });

describe('explicit manual identity questions stay unwritten through every plan path', () => {
  it.each([
    ['Are you a U.S. person under export-control regulations?', ''],
    ['What is your export-control eligibility status?', ''],
    ['Describe your eligibility under export control regulations.', ''],
    ['Do you meet this requirement?', 'Applicants must be a U.S. person under export-control rules.'],
    ['Do you meet this requirement?', 'Applicants must hold a green card.'],
  ])('%s / %s', async (label, context) => {
    document.body.innerHTML = `<form><label for="name">First name</label><input id="name"><label for="identity">${label}</label><input id="identity"></form>`;
    const root = createScanRoot(document.querySelector('form')!, [], []);
    const ordinary = document.querySelector<HTMLInputElement>('#name')!;
    const identity = document.querySelector<HTMLInputElement>('#identity')!;
    const description = document.createElement('p');
    description.id = 'description';
    description.textContent = context;
    document.body.append(description);
    identity.setAttribute('aria-describedby', 'description');
    const descriptor: ApplyFormDescriptor = { vendor: 'greenhouse', root, fields: [
      { kind: 'text', element: ordinary, key: 'firstName', label: 'First name', required: true, confidence: 1, signature: fieldSignature(ordinary, root) },
      // Even an overconfident adapter key cannot override the actual question text.
      { kind: 'text', element: identity, key: 'firstName', label, required: true, confidence: 1, signature: fieldSignature(identity, root) },
    ] };
    const profile = { firstName: 'Synthetic' };
    const answers = [{ questionId: 'identity', element: identity, value: 'Yes' }];
    const plans = [buildApplyPlan(descriptor, profile), buildAnswerPlan(descriptor, answers), buildFillPlan(descriptor, profile, answers)];
    for (const plan of plans) {
      expect(plan.entries.some((entry) => entry.element === identity)).toBe(false);
      expect(plan.skipped.find((skip) => skip.element === identity)).toMatchObject({ reason: 'MANUAL_ONLY' });
      await runApplyPlan({ plan, root, policy: testApplyPolicy(), auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForPlan(plan)]), journal: createUndoJournal(), lateRecheckMs: 1 });
      expect(identity.value).toBe('');
    }
    expect(ordinary.value).toBe('Synthetic');
  });
});
