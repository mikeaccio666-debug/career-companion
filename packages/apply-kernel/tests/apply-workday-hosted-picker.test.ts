import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { workdayAdapter } from '../src/sites/workday/applyForm';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import type { ApplyFormDescriptor } from '../src/contracts';
import type { HoneypotGeometry } from '../src/dict/guards';
import type { ApplyPolicy } from '../src/policy';

/**
 * Workday's picker shape, measured live on 2026-09-15
 * (nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/…/apply,
 * owner signed in, My Information):
 *
 *   <div data-automation-id="formField-phoneType">
 *     <label for="phoneNumber--phoneType">Phone Device Type*</label>
 *     <button aria-haspopup="listbox" id="phoneNumber--phoneType" …>Select One</button>
 *     <input type="text" class="css-77hcv" value="">      ← 0×0, no id, no name
 *
 * The button is 344×40 and is what a human clicks; the sibling input is the
 * widget's value mirror and measures 0×0, i.e. exactly like a CSS-hidden trap.
 * Opening the button adds `aria-expanded="true"` and `aria-controls` → a
 * `ul[role=listbox]` rendered at `<body>` level, so an option's membership is
 * provable from the DOM (`withinOwnedPopup`) with no change to the click policy.
 *
 * The same page carries a real 0×0 control with no picker of its own
 * (`data-automation-id="phone-sms-opt-in"`), which must stay denied.
 */
afterEach(() => {
  document.body.innerHTML = '';
  document.querySelectorAll('ul[role="listbox"]').forEach((list) => list.remove());
});

/** The live nesting, verbatim apart from styling classes and the caret SVG. */
const MY_INFO = `
  <div data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-legalName--firstName" data-fkit-id="name--legalName--firstName">
      <label for="name--legalName--firstName"><span>First Name<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><input id="name--legalName--firstName" type="text" name="firstName" aria-required="true" value="" /></div></div>
    </div>
    <div data-automation-id="formField-phoneType" data-fkit-id="phoneNumber--phoneType">
      <label for="phoneNumber--phoneType"><span>Phone Device Type<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><div><button aria-haspopup="listbox" type="button" value="" aria-label="Phone Device Type Select One Required"
        name="phoneType" id="phoneNumber--phoneType">Select One</button><input type="text" value="" /><span class="menu-icon"></span></div></div><div></div></div>
    </div>
    <div data-automation-id="formField-countryPhoneCode" data-fkit-id="phoneNumber--countryPhoneCode">
      <label for="phoneNumber--countryPhoneCode"><span>Country Phone Code<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><input id="phoneNumber--countryPhoneCode" autocomplete="off" aria-required="true" value="" /></div></div>
    </div>
    <div data-automation-id="formField-phoneNumber" data-fkit-id="phoneNumber--phoneNumber">
      <label for="phoneNumber--phoneNumber"><span>Phone Number<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><input id="phoneNumber--phoneNumber" type="text" name="phoneNumber" aria-required="true" value="" /></div></div>
    </div>
    <div><div><div><input id="yzv77" type="checkbox" data-automation-id="phone-sms-opt-in" /></div></div>
      <a data-automation-id="phone-terms-and-condition-link" href="" target="_blank">Terms and Conditions</a></div>
  </div>`;

/** The live page's geometry: everything laid out, the mirror and the SMS trap at 0×0. */
function liveGeometry(element: Element): HoneypotGeometry {
  const hidden =
    element.getAttribute('data-automation-id') === 'phone-sms-opt-in' ||
    (element.localName === 'input' && !element.id);
  return hidden
    ? { width: 0, height: 0, left: 0, right: 0 }
    : { width: 344, height: 40, left: 288, right: 632 };
}

function mount(html = MY_INFO): ApplyFormDescriptor {
  document.body.innerHTML = html;
  const root = workdayAdapter.resolveRoot(document)!;
  return { vendor: 'workday', root, fields: [...workdayAdapter.scan(root)], finalSubmitControl: null };
}

const fieldLabelled = (descriptor: ApplyFormDescriptor, label: string) =>
  descriptor.fields.find((field) => field.label.replace(/\*$/, '') === label);

describe('Workday hosted picker: button trigger + 0×0 value mirror', () => {
  it('scans the value mirror as a combobox bound to its visible button', () => {
    const descriptor = mount();
    const picker = fieldLabelled(descriptor, 'Phone Device Type');
    expect(picker?.kind).toBe('combobox');
    expect(picker?.kind === 'combobox' && picker.listbox?.activationSelector).toBe(
      'button[aria-haspopup="listbox"]',
    );
  });

  it('gives the mirror the question wording, not the button placeholder', () => {
    // The mirror has no host-declared label of its own, so the wording has to come
    // from the rule's question scope or the inference cascade. Live (wd-base, before
    // the scope existed) the cascade answered with the button's own "Select One",
    // which is what a mock-answer or review layer would then have been asked about.
    const descriptor = mount();
    expect(descriptor.fields.map((field) => field.label)).toContain('Phone Device Type');
    expect(descriptor.fields.map((field) => field.label)).not.toContain('Select One');
  });

  it('judges the honeypot geometry on the visible button, not on the 0×0 mirror', () => {
    const descriptor = mount();
    const plan = buildApplyPlan(descriptor, { firstName: 'Taylor' }, { readGeometry: liveGeometry });
    const picker = fieldLabelled(descriptor, 'Phone Device Type')!;
    const skip = plan.skipped.find((entry) => entry.element === picker.element);
    // Not a honeypot: it is a required control a human can see and click.
    expect(skip?.reason).not.toBe('HONEYPOT');
  });

  it('still denies a 0×0 control that no rule binds to a visible trigger', () => {
    const descriptor = mount();
    const plan = buildApplyPlan(descriptor, { firstName: 'Taylor' }, { readGeometry: liveGeometry });
    const trap = descriptor.fields.find(
      (field) => field.element.getAttribute('data-automation-id') === 'phone-sms-opt-in',
    )!;
    expect(plan.skipped.find((entry) => entry.element === trap.element)?.reason).toBe('HONEYPOT');
  });
});

describe('Workday hosted picker: the write goes through the button', () => {
  /** The lab's policy shape: the bundled baseline with this vendor switched on. */
  function workdayPolicy(): ApplyPolicy {
    const bundled = createBundledApplyPolicy(Date.now());
    return { ...bundled, vendors: { ...bundled.vendors, workday: true } };
  }

  function authority(fingerprint: string): HostWriteAuthority {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadowRoot.appendChild(button);
    const event = new Event('click', { bubbles: true, composed: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    Object.defineProperty(event, 'composedPath', {
      value: () => [button, shadowRoot, host, document.body, document, window],
    });
    const minted = mintAuthority({
      event,
      shadowRoot,
      purpose: 'fill',
      fingerprint,
      capabilities: new Set(['set-text', 'set-combobox'] as const),
    });
    if (!minted.ok) throw new Error(minted.code);
    return minted.value;
  }

  /** Workday's picker: the menu is portaled to <body> and named by the button. */
  function scriptPicker(options: readonly string[]): { trigger: HTMLInputElement; button: HTMLButtonElement } {
    const button = document.getElementById('phoneNumber--phoneType') as HTMLButtonElement;
    const trigger = button.nextElementSibling as HTMLInputElement;
    const close = () => {
      document.getElementById('wd-listbox')?.remove();
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-controls');
    };
    button.addEventListener('mousedown', () => {
      if (button.getAttribute('aria-expanded') === 'true') return;
      const list = document.createElement('ul');
      list.id = 'wd-listbox';
      list.setAttribute('role', 'listbox');
      // The live widget renders a disabled "Select One" placeholder row first.
      const placeholder = document.createElement('li');
      placeholder.setAttribute('role', 'option');
      placeholder.setAttribute('aria-disabled', 'true');
      placeholder.textContent = 'Select One';
      list.append(placeholder);
      for (const text of options) {
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.textContent = text;
        option.addEventListener('click', () => {
          const id = `id-${text.toLowerCase().replace(/\s+/g, '-')}`;
          button.textContent = text;
          button.setAttribute('value', id);
          trigger.value = id;
          close();
        });
        list.append(option);
      }
      document.body.append(list);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-controls', 'wd-listbox');
    });
    return { trigger, button };
  }

  async function answerPicker(value: string, options: readonly string[]) {
    const descriptor = mount();
    const { trigger, button } = scriptPicker(options);
    const plan = buildAnswerPlan(
      descriptor,
      [{ questionId: 'q1', element: trigger, value }],
      { readGeometry: liveGeometry },
    );
    const summary = await runApplyPlan({
      plan,
      auth: authority(plan.fingerprint),
      journal: createUndoJournal(),
      root: descriptor.root,
      policy: workdayPolicy(),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    return { plan, summary, trigger, button };
  }

  it('opens the button, picks from its owned popup and reads the button back', async () => {
    const { plan, summary, trigger, button } = await answerPicker('Home Cellular', ['Home', 'Home Cellular']);
    expect(plan.entries.map((entry) => entry.kind)).toEqual(['combobox']);
    expect(summary.results).toEqual([{ key: 'question:q1', label: 'Phone Device Type', ok: true }]);
    expect(button.textContent).toBe('Home Cellular');
    // The mirror is the witness: a repainted button alone is not a pick.
    expect(trigger.value).toBe('id-home-cellular');
  });

  it('treats the "Select One" placeholder as empty, not as a value to preserve', async () => {
    // Read as a value, the placeholder would make every untouched picker NOT_EMPTY.
    const { summary } = await answerPicker('Home', ['Home', 'Home Cellular']);
    expect(summary.results[0]?.ok).toBe(true);
    expect(summary.filled).toBe(1);
  });

  it('leaves a lookalike button that declares no listbox popup unbound', async () => {
    const descriptor = mount(MY_INFO.replace('aria-haspopup="listbox" type="button"', 'type="button"'));
    const mirror = document.getElementById('phoneNumber--phoneType')!.nextElementSibling!;
    const field = descriptor.fields.find((entry) => entry.element === mirror);
    // Still scanned, but as an ordinary text input: nothing here may be clicked,
    // and its own 0x0 geometry keeps it out of every plan.
    expect(field?.kind).toBe('text');
    const plan = buildApplyPlan(descriptor, { firstName: 'Taylor' }, { readGeometry: liveGeometry });
    expect(plan.skipped.find((entry) => entry.element === mirror)?.reason).toBe('HONEYPOT');
  });
});
