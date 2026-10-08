import { afterEach, describe, expect, it } from 'vitest';

import { fieldSignature, readValue } from '../src/fieldIdentity';
import { createScanRoot, withScanPass } from '../src/scanRoot';

afterEach(() => {
  document.body.innerHTML = '';
});

function fixture(): { root: ReturnType<typeof createScanRoot>; email: HTMLInputElement; label: HTMLLabelElement } {
  document.body.innerHTML = `
    <form id="application-form">
      <label id="email-label" for="email">Email</label>
      <input id="email" type="email" name="job_application[email]" />
    </form>
  `;
  const container = document.querySelector('form')!;
  return {
    root: createScanRoot(container, []),
    email: document.querySelector<HTMLInputElement>('#email')!,
    label: document.querySelector<HTMLLabelElement>('#email-label')!,
  };
}

describe('C5 · structural field identity', () => {
  it('rereads control membership and first label during one synchronous scan pass', () => {
    const { root, email, label } = fixture();
    const form = document.querySelector('form')!;
    withScanPass(root, () => {
      const first = fieldSignature(email, root);
      const earlierLabel = document.createElement('label');
      earlierLabel.htmlFor = email.id;
      earlierLabel.textContent = 'Earlier current label';
      form.prepend(earlierLabel);
      expect(fieldSignature(email, root).labelHint).toBe('earlier current label');
      earlierLabel.htmlFor = 'another-control';
      label.textContent = 'Changed owner label';
      expect(fieldSignature(email, root).labelHint).toBe('changed owner label');

      const leading = document.createElement('input');
      form.prepend(leading);
      expect(fieldSignature(email, root).core).not.toBe(first.core);
      leading.setAttribute('aria-hidden', 'true');
      leading.setAttribute('tabindex', '-1');
      expect(fieldSignature(email, root).core).toBe(first.core);
      leading.removeAttribute('tabindex');
      expect(fieldSignature(email, root).core).not.toBe(first.core);
    });
  });
  it('excludes a framework-generated id but keeps label wording as a separate hint', () => {
    const { root, email, label } = fixture();
    const initial = fieldSignature(email, root);

    email.id = 'react-generated-94531';
    label.htmlFor = email.id;
    const changedId = fieldSignature(email, root);
    label.textContent = 'Email This field is required';
    const changedLabel = fieldSignature(email, root);

    expect(changedId.core).toBe(initial.core);
    expect(changedLabel.core).toBe(initial.core);
    expect(changedLabel.labelHint).not.toBe(initial.labelHint);
  });

  it('changes core when the control shape or structural position changes', () => {
    const { root, email } = fixture();
    const initial = fieldSignature(email, root);

    email.setAttribute('name', 'job_application[answers_attributes][different_question]');
    expect(fieldSignature(email, root).core).not.toBe(initial.core);

    email.setAttribute('name', 'job_application[email]');
    email.setAttribute('type', 'tel');
    expect(fieldSignature(email, root).core).not.toBe(initial.core);

    email.setAttribute('type', 'email');
    const leading = document.createElement('input');
    document.querySelector('form')!.prepend(leading);
    expect(fieldSignature(email, root).core).not.toBe(initial.core);
  });

  it('treats select-one and select-multiple as different control types', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="city">City</label>
        <select id="city" name="job_application[city]">
          <option value="">Choose</option>
          <option value="us">United States</option>
        </select>
      </form>
    `;
    const form = document.querySelector('form')!;
    const root = createScanRoot(form, []);
    const city = document.querySelector<HTMLSelectElement>('#city')!;
    const initial = fieldSignature(city, root);

    city.multiple = true;
    expect(fieldSignature(city, root).core).not.toBe(initial.core);
  });

  it('keeps host values behind one L2 read-only probe', () => {
    const { email } = fixture();
    email.value = 'alex@example.test';

    expect(readValue(email)).toBe('alex@example.test');
  });
});
