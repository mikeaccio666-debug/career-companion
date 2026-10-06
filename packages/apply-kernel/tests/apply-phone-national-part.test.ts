import { afterEach, describe, expect, it } from 'vitest';
import { buildApplyPlan } from '../src/engine';
import { isPhoneCountryCodeField } from '../src/dict/guards';
import { nationalPhoneNumber } from '../src/write/verify';
import { workdayAdapter } from '../src/sites/workday/applyForm';
import type { ApplyFormDescriptor } from '../src/contracts';

/**
 * A form that owns the country calling code wants the national number.
 *
 * Measured 2026-09-15 on nvidia.wd5.myworkdayjobs.com (My Information): the page
 * renders a required "Country Phone Code" control that already reads
 * `United States of America (+1)`, and rejects `+1 415 555 0142` in "Phone
 * Number" with `Enter a valid format for Phone Number`. Nothing here is Workday
 * knowledge: any form that splits the code out (intl-tel-input, most HRIS) reads
 * the same way, and a form without such a control keeps the full number.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

const WITH_CODE = `
  <div data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-countryPhoneCode">
      <label for="phoneNumber--countryPhoneCode"><span>Country Phone Code<abbr aria-hidden="true">*</abbr></span></label>
      <input id="phoneNumber--countryPhoneCode" autocomplete="off" aria-required="true" value="" />
    </div>
    <div data-automation-id="formField-phoneNumber">
      <label for="phoneNumber--phoneNumber"><span>Phone Number<abbr aria-hidden="true">*</abbr></span></label>
      <input id="phoneNumber--phoneNumber" type="text" name="phoneNumber" aria-required="true" value="" />
    </div>
  </div>`;

/** The same page with the calling code folded into the phone field itself. */
const WITHOUT_CODE = `
  <div data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-phoneNumber">
      <label for="phoneNumber--phoneNumber"><span>Phone Number<abbr aria-hidden="true">*</abbr></span></label>
      <input id="phoneNumber--phoneNumber" type="text" name="phoneNumber" aria-required="true" value="" />
    </div>
  </div>`;

function plannedPhone(html: string, phone: string): string | undefined {
  document.body.innerHTML = html;
  const root = workdayAdapter.resolveRoot(document)!;
  const descriptor: ApplyFormDescriptor = {
    vendor: 'workday',
    root,
    fields: [...workdayAdapter.scan(root)],
    finalSubmitControl: null,
  };
  const plan = buildApplyPlan(descriptor, { phone });
  return plan.entries.find((entry) => entry.key === 'phone')?.value;
}

describe('phone: the national part when the form owns the calling code', () => {
  it('writes only the national number when a calling-code control exists', () => {
    expect(plannedPhone(WITH_CODE, '+1 415 555 0142')).toBe('4155550142');
  });

  it('writes the number as stored when the form has no calling-code control', () => {
    expect(plannedPhone(WITHOUT_CODE, '+1 415 555 0142')).toBe('+1 415 555 0142');
  });

  it('leaves a number that declares no country code untouched', () => {
    expect(plannedPhone(WITH_CODE, '415-555-0142')).toBe('415-555-0142');
  });
});

describe('nationalPhoneNumber', () => {
  it('splits on the number’s own declared code, not on a fixed prefix length', () => {
    expect(nationalPhoneNumber('+1 415 555 0142')).toBe('4155550142');
    expect(nationalPhoneNumber('+44 20 7946 0958')).toBe('2079460958');
    expect(nationalPhoneNumber('+353 1 234 5678')).toBe('12345678');
    expect(nationalPhoneNumber('0086 138 0013 8000')).toBe('13800138000');
  });

  it('refuses to guess: no declared code, or nothing long enough left over', () => {
    expect(nationalPhoneNumber('415 555 0142')).toBeNull();
    expect(nationalPhoneNumber('+1 234')).toBeNull();
    expect(nationalPhoneNumber('')).toBeNull();
  });
});

describe('isPhoneCountryCodeField', () => {
  it('recognises the calling-code control by its wording', () => {
    for (const label of ['Country Phone Code', 'Phone Country Code', 'Country Calling Code', 'Dial Code', 'International Dialing Code', '国际区号']) {
      expect(isPhoneCountryCodeField(label)).toBe(true);
    }
  });

  it('never mistakes an address or a phone-part control for it', () => {
    // Area code is phone metadata too, but it is not the international code:
    // treating it as one would strip the country code off a number that has none.
    for (const label of ['Postal Code', 'Zip Code', 'Country', 'Area Code', 'Phone Number', 'Phone Extension', 'Employee Code']) {
      expect(isPhoneCountryCodeField(label)).toBe(false);
    }
  });
});
