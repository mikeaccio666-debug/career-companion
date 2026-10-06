/**
 * 「已按你的授权代填」那一行的标题要说得出替他同意了什么（2026-10-04，bench-1003 第八节）。
 *
 * Ashby 把短信同意放在电话那一栏里：题目（`<label>`）是「Phone」，同意的那句话是选项自己——
 * 「Yes - I consent to receiving text messages」。内核按选项那句话认出这是短信同意、替他选上（对的），可那一行的标题
 * 借了电话的「Phone」：浮层「已按你的授权代填」里一行「Phone · 已替你同意：短信通知」，他看不懂替他同意了什么。
 * 现在：题面自己说不出是哪一类、靠选项那句话认出来的，那一行的标题就是那句话。题面自己就是那句同意的（单个勾选框、
 * 「Do you consent to …?」）照旧用题面；选项太短（「Yes」「I agree」）说不清的照旧用题面。
 *
 * 夹具的结构照 2026-10-04 在 jobs.ashbyhq.com/ramp/<id>/application 只读抓到的电话栏（公开页面，没有任何人的资料）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFormDescriptor } from '../src/contracts';
import { buildAuditView } from '../src/audit';
import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

afterEach(() => { document.body.innerHTML = ''; });

const RAMP_PHONE = `
  <div class="ashby-application-form-container"><form>
  <div class="ashby-application-form-field-entry" data-field-path="phone-1">
    <label class="ashby-application-form-question-title" for="phone-1">Phone</label>
    <input placeholder="1-415-555-1234..." name="phone-1" required id="phone-1" type="tel" class="ashby-application-form-input-text">
    <div class="ashby-application-form-texting-consent">
      <div><div><div contenteditable="false" class="tiptap ProseMirror"><p>Check <strong>Yes</strong> or <strong>No</strong> to indicate your agreement to receive text message updates from Acme Corporation regarding your job application. Frequency may vary. Message and data rates may apply. Reply STOP to opt out of future messaging.</p></div></div></div>
      <div class="consentRadioGroup">
        <label><input type="radio" name="communicationConsent"><div><div><div contenteditable="false" class="tiptap ProseMirror"><p><strong>Yes</strong> - I consent to receiving text messages</p></div></div></div></label>
        <label><input type="radio" name="communicationConsent"><div><div><div contenteditable="false" class="tiptap ProseMirror"><p><strong>No</strong> - I do not consent to receiving text messages</p></div></div></div></label>
      </div>
    </div>
  </div>
  </form></div>`;

function signedRows(descriptor: ApplyFormDescriptor) {
  const plan = buildApplyPlan(descriptor, { phone: '+1 415 555 0100' } as never, { fillEmptyOnly: true, capabilities: { 'sign-on-behalf': true } } as never);
  const view = buildAuditView(plan, plan.entries.map((entry) => ({ key: entry.key, label: entry.label, ok: true })) as never);
  return { plan, rows: view.rows.filter((row) => row.key === 'smsConsent') };
}

describe('短信同意借了电话那一栏的题目', () => {
  it('Ashby（Ramp）：那一行的标题是同意的那句话，不是「Phone」', () => {
    document.body.innerHTML = RAMP_PHONE;
    const root = ashbyAdapter.resolveRoot(document);
    expect(root).toBeTruthy();
    const fields = [...ashbyAdapter.scan(root!)];
    const consent = fields.find((field) => field.kind === 'choice' && field.choice.options.some((option) => /consent to receiving text/iu.test(option.label)));
    expect(consent, '短信同意那一组扫出来了').toBeDefined();
    const { plan, rows } = signedRows({ vendor: 'ashby', root: root!, fields } as never);
    const entry = plan.entries.find((one) => one.key === 'smsConsent');
    expect(entry?.signOnBehalf).toBe('SMS_CONSENT');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('Yes - I consent to receiving text messages');
    expect(rows[0]!.label).not.toBe('Phone');
  });
});

function radioGroup(question: string, options: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form><fieldset><legend>${question}</legend>${options
    .map((option, index) => `<label><input type="radio" name="q" id="o${index}">${option}</label>`)
    .join('')}</fieldset></form>`;
  const members = options.map((option, index) => ({ element: document.getElementById(`o${index}`) as HTMLInputElement, label: option }));
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'choice', element: members[0]!.element, key: null, label: question, required: true, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: { control: 'radio', options: members },
    }],
  } as never;
}

describe('题面自己说得出的，照旧用题面', () => {
  it('「Do you consent to receive text messages about your application?」+ Yes / No：标题是题面', () => {
    const { rows } = signedRows(radioGroup('Do you consent to receive text messages about your application?', ['Yes', 'No']));
    expect(rows.map((row) => row.label)).toEqual(['Do you consent to receive text messages about your application?']);
  });

  it('题面说不出、选项也太短（只有「Yes」）：不拿「Yes」当标题', () => {
    const { rows } = signedRows(radioGroup('Text message updates', ['Yes', 'No']));
    expect(rows.every((row) => row.label !== 'Yes')).toBe(true);
  });
});
