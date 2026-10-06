import { describe, expect, it } from 'vitest';

import { evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';

/**
 * A combobox trigger's accessible name is a whole question, not a control's own
 * wording, so a bare English token in the consent list can match the middle of
 * an ordinary sentence.
 *
 * Measured live 2026-09-15 (nvidia.wd5, Workday step 4 Voluntary Disclosures):
 * "Do you identify as one of the **following** protected veterans (Disabled
 * Veteran, Recently Separated Veteran, Active Duty Wartime or Campaign Badge
 * Veteran, Armed Forces Service Medal Veteran)?" matched `follow` and was denied
 * CONSENT, while "What is your ethnicity?" and "What is your gender?" — same
 * widget, same page, same decline answer — filled. The host then rejected the
 * page for a required field nobody had consented to anything about.
 *
 * This is the same shape as the bare `legal` token that already got a
 * trigger-specific reading (Greenhouse, "Are you legally authorized to work in
 * the United States for our Company?"), and the narrowing is just as tight: only
 * `following`, only for triggers.
 */
function target(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
    kind: 'combobox-trigger',
    planned: true,
    openedByTransaction: false,
    tagName: 'button',
    buttonType: 'button',
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

const VETERAN = 'Do you identify as one of the following protected veterans (Disabled Veteran, '
  + 'Recently Separated Veteran, Active Duty Wartime or Campaign Badge Veteran, Armed Forces '
  + 'Service Medal Veteran)?';

describe('click policy · consent read against a combobox trigger', () => {
  it('opens the protected-veteran EEO picker instead of calling "following" a consent', () => {
    expect(evaluateClickTarget(target({ accessibleName: VETERAN }))).toEqual({ allowed: true });
  });

  it('keeps its EEO neighbours working, as they already did', () => {
    expect(evaluateClickTarget(target({ accessibleName: 'What is your ethnicity?' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(target({ accessibleName: 'What is your gender?' }))).toEqual({ allowed: true });
  });

  it.each([
    ['a bare follow', 'Follow'],
    ['follow us', 'Follow us for job alerts'],
    ['follow this company', 'Follow this company'],
    ['agree', 'I agree to the terms'],
    ['accept', 'Accept and continue'],
    ['consent', 'I consent to processing'],
    ['subscribe', 'Subscribe to updates'],
    ['terms', 'Terms and Conditions'],
    ['privacy notice', 'I have read the privacy notice'],
    ['email me', 'Email me about new roles'],
    ['top choice', 'Is this your top choice?'],
    ['中文同意', '我同意以上条款'],
    ['a substantive grant (CONSENT_GRANT)', 'I authorize a background check'],
    ['arbitration', 'I agree to binding arbitration'],
  ])('still denies %s on a trigger', (_name, accessibleName) => {
    expect(evaluateClickTarget(target({ accessibleName }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('leaves every other target kind on the whole-text consent read', () => {
    // A choice label that happens to say "following" keeps the old, wider deny:
    // only the trigger's accessible name is a question.
    expect(evaluateClickTarget(target({
      kind: 'choice-label',
      tagName: 'label',
      choiceControl: 'checkbox',
      accessibleName: 'I accept the following terms',
    }))).toEqual({ allowed: false, reason: 'CONSENT' });
    expect(evaluateClickTarget(target({
      kind: 'choice-label',
      tagName: 'label',
      choiceControl: 'checkbox',
      accessibleName: 'Follow the following steps',
    }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });
});
