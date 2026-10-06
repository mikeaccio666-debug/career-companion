import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostValidationSignals } from '../src/write/verify';
import { fieldSignature } from '../src/fieldIdentity';
import { createScanRoot } from '../src/scanRoot';
import {
  writeDateSemanticTransaction,
  type DateSemanticTarget,
  type WriteDateSemanticTransactionInput,
} from '../src/write/dateSemanticTransaction';
import { testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FINGERPRINT = 'date-semantic-transaction-test';

function inputPart<Role extends 'date' | 'month' | 'year'>(
  element: HTMLInputElement,
  root: ReturnType<typeof createScanRoot>,
  role: Role,
  expected: string,
) {
  return {
    role,
    control: 'input' as const,
    element,
    signature: fieldSignature(element, root),
    expected,
  };
}

function selectPart<Role extends 'month' | 'year'>(
  element: HTMLSelectElement,
  root: ReturnType<typeof createScanRoot>,
  role: Role,
  candidates: readonly [string, ...string[]],
) {
  return {
    role,
    control: 'select' as const,
    element,
    signature: fieldSignature(element, root),
    candidates,
  };
}

function defaultInput(
  target: DateSemanticTarget,
  root: ReturnType<typeof createScanRoot>,
  overrides: Partial<WriteDateSemanticTransactionInput> = {},
): WriteDateSemanticTransactionInput {
  return {
    root,
    target,
    fingerprint: FINGERPRINT,
    authority: testAuthority(FINGERPRINT, 'fill', ['set-text', 'set-select']),
    executionFence: () => null,
    readHostValidation: () => ({ willValidate: true, valid: true }),
    lateRecheckMs: 1,
    operationTimeoutMs: 100,
    ...overrides,
  };
}

function trustedInput(target: HTMLInputElement | HTMLSelectElement): void {
  const event = new Event('input', { bubbles: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  target.dispatchEvent(event);
}

describe('dormant generic date semantic transaction', () => {
  it('writes one exact native date, settles it, and restores only that control without click or Submit', async () => {
    document.body.innerHTML = '<form><input name="available" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const submitEvent = vi.fn();
    form.addEventListener('submit', submitEvent);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.value.validation).toBe('accepted');
    expect(result.value.undo.isAtWrittenState()).toBe(true);
    expect(result.value.undo.requiredCapabilities()).toEqual(new Set(['set-text']));
    expect(date.value).toBe('2026-09-11');
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(submitEvent).not.toHaveBeenCalled();

    const restored = result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    );
    expect(restored.ok).toBe(true);
    expect(date.value).toBe('');
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(submitEvent).not.toHaveBeenCalled();
  });

  it('supports the native month shape without inventing a day', async () => {
    document.body.innerHTML = '<form><input name="start" type="month"></form>';
    const form = document.querySelector('form')!;
    const month = document.querySelector('input')!;
    const root = createScanRoot(form, []);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-month', part: inputPart(month, root, 'month', '2026-09') },
        root,
      ),
    );

    expect(result.ok).toBe(true);
    expect(month.value).toBe('2026-09');
  });

  it('treats split month/year input+select parts as one coupled transaction and Undo bundle', async () => {
    document.body.innerHTML = `<form>
      <select name="start-month">
        <option value="">Month</option>
        <option value="06">June</option>
      </select>
      <input name="start-year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['6', 'June']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(month.value).toBe('06');
    expect(year.value).toBe('2026');
    expect(result.value.undo.requiredCapabilities()).toEqual(
      new Set(['set-select', 'set-text']),
    );

    const restored = result.value.undo.restore(
      testAuthority(null, 'undo', ['set-select', 'set-text']),
    );
    expect(restored.ok).toBe(true);
    expect(month.value).toBe('');
    expect(year.value).toBe('');
  });

  it('preflights every coupled capability before the first host mutation', async () => {
    document.body.innerHTML = `<form>
      <select name="month"><option value=""></option><option value="6">June</option></select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const events = vi.fn();
    form.addEventListener('input', events);
    form.addEventListener('change', events);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['6']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(
      defaultInput(target, root, {
        authority: testAuthority(FINGERPRINT, 'fill', ['set-text']),
      }),
    );

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(month.value).toBe('');
    expect(year.value).toBe('');
    expect(events).not.toHaveBeenCalled();
  });

  it('returns GESTURE_UNTRUSTED for malformed or forged fill authority', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'native-date',
      part: inputPart(date, root, 'date', '2026-09-11'),
    };

    const malformed = await writeDateSemanticTransaction(
      defaultInput(target, root, { authority: null as never }),
    );
    const forged = await writeDateSemanticTransaction(
      defaultInput(target, root, {
        authority: {
          purpose: 'fill',
          fingerprint: FINGERPRINT,
          expiresAt: Number.MAX_SAFE_INTEGER,
        } as never,
      }),
    );

    expect(malformed).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    expect(forged).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    expect(date.value).toBe('');
  });

  it('rejects a malformed AbortSignal before any host mutation', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const events = vi.fn();
    form.addEventListener('input', events);
    form.addEventListener('change', events);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        { signal: { aborted: false } as never },
      ),
    );

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(date.value).toBe('');
    expect(events).not.toHaveBeenCalled();
  });

  it('returns exact recovery when a stateful AbortSignal fails after preflight', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    let addCalls = 0;
    const signal = {
      aborted: false,
      addEventListener() {
        addCalls += 1;
        if (addCalls > 1) throw new Error('host signal changed after preflight');
      },
      removeEventListener() {},
    } as never;

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        { signal },
      ),
    );

    expect(result).toMatchObject({ ok: false, code: 'ABORTED' });
    if (result.ok) throw new Error('expected abort');
    expect(date.value).toBe('2026-09-11');
    expect(result.recovery?.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toMatchObject({ ok: true });
    expect(date.value).toBe('');
  });

  it('returns a stable failure for a malformed target part', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const validTarget: DateSemanticTarget = {
      kind: 'native-date',
      part: inputPart(date, root, 'date', '2026-09-11'),
    };

    const result = await writeDateSemanticTransaction(
      defaultInput(validTarget, root, {
        target: { kind: 'native-date', part: null } as never,
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(date.value).toBe('');
  });

  it('rejects an ambiguous select candidate before changing any coupled part', async () => {
    document.body.innerHTML = `<form>
      <select name="month">
        <option value=""></option>
        <option value="june-a">June</option>
        <option value="june-b">June</option>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };
    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'AMBIGUOUS_OPTION' });
    expect(month.value).toBe('');
    expect(year.value).toBe('');
  });

  it('treats a control inherited-disabled by fieldset as not writable', async () => {
    document.body.innerHTML = `<form><fieldset disabled>
      <input name="date" type="date">
    </fieldset></form>`;
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const hostEvents = vi.fn();
    form.addEventListener('input', hostEvents);
    form.addEventListener('change', hostEvents);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    expect(date.value).toBe('');
    expect(hostEvents).not.toHaveBeenCalled();
  });

  it('fails closed for an aria-disabled exact target', async () => {
    document.body.innerHTML = `<form>
      <input name="date" type="date" aria-disabled="true">
    </form>`;
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    expect(date.value).toBe('');
  });

  it('inherits aria-disabled from an ancestor container', async () => {
    document.body.innerHTML = `<form><div aria-disabled="true">
      <input name="date" type="date">
    </div></form>`;
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const hostEvents = vi.fn();
    form.addEventListener('input', hostEvents);
    form.addEventListener('change', hostEvents);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    expect(date.value).toBe('');
    expect(hostEvents).not.toHaveBeenCalled();
  });

  it('fails closed for an aria-readonly native select', async () => {
    document.body.innerHTML = `<form>
      <select name="month" aria-readonly="true">
        <option value="">Month</option><option value="06">June</option>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const hostEvents = vi.fn();
    form.addEventListener('input', hostEvents);
    form.addEventListener('change', hostEvents);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    expect(month.value).toBe('');
    expect(year.value).toBe('');
    expect(hostEvents).not.toHaveBeenCalled();
  });

  it('rejects a select option inherited-disabled by its optgroup before any write', async () => {
    document.body.innerHTML = `<form>
      <select name="month">
        <option value="">Month</option>
        <optgroup label="Unavailable" disabled>
          <option value="06">June</option>
        </optgroup>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const hostEvents = vi.fn();
    form.addEventListener('input', hostEvents);
    form.addEventListener('change', hostEvents);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'NO_OPTION_MATCH' });
    expect(month.value).toBe('');
    expect(year.value).toBe('');
    expect(hostEvents).not.toHaveBeenCalled();
  });

  it('rejects a visible date option whose submitted raw value is empty', async () => {
    document.body.innerHTML = `<form>
      <select name="month"><option value="">June</option></select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const hostEvents = vi.fn();
    form.addEventListener('input', hostEvents);
    form.addEventListener('change', hostEvents);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'NO_OPTION_MATCH' });
    expect(month.value).toBe('');
    expect(year.value).toBe('');
    expect(hostEvents).not.toHaveBeenCalled();
  });

  it('matches the effective visible option label rather than hidden text', async () => {
    document.body.innerHTML = `<form>
      <select name="month">
        <option value="">Month</option>
        <option value="06" label="May">June</option>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'NO_OPTION_MATCH' });
    expect(month.value).toBe('');
    expect(year.value).toBe('');
  });

  it('detects an option visible-label change during the write', async () => {
    document.body.innerHTML = `<form>
      <select name="month">
        <option value="">Month</option>
        <option value="06">June</option>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };
    month.addEventListener(
      'change',
      () => { month.options[1]!.setAttribute('label', 'May'); },
      { once: true },
    );

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected visible-label identity drift');
    expect(result.code).toBe('IDENTITY_CHANGED');
    expect(month.value).toBe('06');
    expect(year.value).toBe('');
  });

  it('rejects a multiple date select without changing its selected set', async () => {
    document.body.innerHTML = `<form>
      <select name="month" multiple>
        <option value="" selected>Month</option>
        <option value="05" selected>May</option>
        <option value="06">June</option>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect([...month.options].map((option) => option.selected)).toEqual([true, true, false]);
    expect(year.value).toBe('');
  });

  it('refuses to couple month and year controls from different repeated rows', async () => {
    document.body.innerHTML = `<form><div class="rows">
      <div class="row">
        <select name="month"><option value="">Month</option><option value="06">June</option></select>
        <input name="year" type="number">
      </div>
      <div class="row">
        <select name="month"><option value="">Month</option><option value="06">June</option></select>
        <input name="year" type="number">
      </div>
    </div></form>`;
    const form = document.querySelector('form')!;
    const months = [...document.querySelectorAll('select')];
    const years = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, [], [
      {
        kind: 'contains',
        container: '.rows',
        row: '.row',
        collection: 'experience',
      },
    ]);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(months[0]!, root, 'month', ['June']),
      year: inputPart(years[1]!, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(months.map((month) => month.value)).toEqual(['', '']);
    expect(years.map((year) => year.value)).toEqual(['', '']);
  });

  it('never treats the wrong same-valued select option as semantic success', async () => {
    document.body.innerHTML = `<form>
      <select name="month">
        <option value="">Month</option>
        <option value="06">May</option>
        <option value="06">June</option>
      </select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: selectPart(month, root, 'month', ['June']),
      year: inputPart(year, root, 'year', '2026'),
    };
    month.addEventListener('change', () => { month.selectedIndex = 1; }, { once: true });

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected semantic select coercion');
    expect(result.code).toBe('VALUE_COERCED');
    expect(month.selectedIndex).toBe(1);
    expect(month.value).toBe('06');
    expect(year.value).toBe('');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    expect(result.recovery?.restore(
      testAuthority(null, 'undo', ['set-select']),
    )).toMatchObject({ ok: true });
    expect(month.selectedIndex).toBe(0);
    expect(month.value).toBe('');
  });

  it('fails a stale exact field signature before writing', async () => {
    document.body.innerHTML = '<form><input name="start" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'native-date',
      part: inputPart(date, root, 'date', '2026-09-11'),
    };
    date.name = 'replacement-role';

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(date.value).toBe('');
  });

  it('rejects a connected target outside the trusted ScanRoot even with its own -1 signature', async () => {
    document.body.innerHTML = `<form id="trusted"></form>
      <input name="outside" type="date">`;
    const form = document.querySelector('form')!;
    const outside = document.querySelector('input')!;
    const root = createScanRoot(form, []);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(outside, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(outside.value).toBe('');
  });

  it('enforces no-overwrite across the entire bundle', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text" value="5">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect(month!.value).toBe('5');
    expect(year!.value).toBe('');
  });

  it('never writes a replacement second target and retains only the exact first-part recovery', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };
    let replacement: HTMLInputElement | null = null;
    month!.addEventListener(
      'input',
      () => {
        replacement = year!.cloneNode() as HTMLInputElement;
        year!.replaceWith(replacement);
      },
      { once: true },
    );

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected identity failure');
    expect(result.code).toBe('DETACHED');
    expect(month!.value).toBe('6');
    expect(replacement!.value).toBe('');
    expect(result.recovery?.isAtWrittenState()).toBe(true);

    const restored = result.recovery!.restore(testAuthority(null, 'undo', ['set-text']));
    expect(restored.ok).toBe(true);
    expect(month!.value).toBe('');
    expect(replacement!.value).toBe('');
  });

  it('rechecks no-overwrite before every coupled part after a silent host/user value appears', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };
    month!.addEventListener('input', () => { year!.value = '2027'; }, { once: true });

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected no-overwrite recheck');
    expect(result.code).toBe('NOT_EMPTY');
    expect(month!.value).toBe('6');
    expect(year!.value).toBe('2027');
    expect(result.recovery?.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toMatchObject({ ok: true });
    expect(month!.value).toBe('');
    expect(year!.value).toBe('2027');
  });

  it('captures a last-write policy failure before a queued reopen can launder it', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    let executionFailure: 'POLICY_DISABLED' | null = null;
    date.addEventListener(
      'change',
      () => {
        executionFailure = 'POLICY_DISABLED';
        queueMicrotask(() => { executionFailure = null; });
      },
      { once: true },
    );

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        { executionFence: () => executionFailure },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected policy fence failure');
    expect(result.code).toBe('POLICY_DISABLED');
    expect(date.value).toBe('2026-09-11');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
  });

  it('checks the whole bundle after the last write before a queued ABA restore', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };
    year!.addEventListener(
      'change',
      () => {
        month!.value = '';
        queueMicrotask(() => { month!.value = '6'; });
      },
      { once: true },
    );

    const result = await writeDateSemanticTransaction(defaultInput(target, root));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected coupled forward-progress failure');
    expect(result.code).toBe('VALUE_COERCED');
    expect(month!.value).toBe('6');
    expect(year!.value).toBe('2026');
  });

  it('returns a stable failure and exact recovery when host event dispatch throws after mutation', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    Object.defineProperty(date, 'dispatchEvent', {
      configurable: true,
      value: () => { throw new Error('host dispatch failed'); },
    });

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected stable host primitive failure');
    expect(result.code).toBe('WRITE_REVERTED');
    expect(date.value).toBe('2026-09-11');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    Reflect.deleteProperty(date, 'dispatchEvent');
    expect(result.recovery?.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toMatchObject({ ok: true });
    expect(date.value).toBe('');
  });

  it('classifies an initial complete revert separately from a mixed coupled coercion', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    let form = document.querySelector('form')!;
    let date = document.querySelector('input')!;
    let root = createScanRoot(form, []);
    date.addEventListener('input', () => queueMicrotask(() => { date.value = ''; }), { once: true });

    const reverted = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );
    expect(reverted).toEqual({ ok: false, code: 'WRITE_REVERTED' });

    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    root = createScanRoot(form, []);
    month!.addEventListener('input', () => queueMicrotask(() => { month!.value = ''; }), { once: true });
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };

    const mixed = await writeDateSemanticTransaction(defaultInput(target, root));
    expect(mixed.ok).toBe(false);
    if (mixed.ok) throw new Error('expected mixed coercion');
    expect(mixed.code).toBe('VALUE_COERCED');
    expect(month!.value).toBe('');
    expect(year!.value).toBe('2026');
    expect(mixed.recovery?.isAtWrittenState()).toBe(true);
    expect(mixed.recovery?.restore(testAuthority(null, 'undo', ['set-text']))).toMatchObject({
      ok: true,
    });
    expect(year!.value).toBe('');
  });

  it('demotes a settled write when the late readback drifts', async () => {
    document.body.innerHTML = '<form><input name="start" type="month"></form>';
    const form = document.querySelector('form')!;
    const month = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    let validationReads = 0;

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-month', part: inputPart(month, root, 'month', '2026-09') },
        root,
        {
          readHostValidation: () => {
            validationReads += 1;
            if (validationReads === 1) queueMicrotask(() => { month.value = ''; });
            return { willValidate: true, valid: true };
          },
        },
      ),
    );

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
  });

  it('keeps exact targeted recovery usable after the forward operation signal aborts', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const controller = new AbortController();
    date.addEventListener(
      'change',
      () => queueMicrotask(() => controller.abort()),
      { once: true },
    );

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        { signal: controller.signal },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected forward abort');
    expect(result.code).toBe('ABORTED');
    expect(date.value).toBe('2026-09-11');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    expect(result.recovery?.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toMatchObject({ ok: true });
    expect(date.value).toBe('');
  });

  it('returns HOST_REJECTED with local exact recovery when the host rejects one part', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };
    const validate = (element: HTMLInputElement | HTMLSelectElement): HostValidationSignals =>
      element === year ? { ariaInvalid: 'true' } : { ariaInvalid: 'false' };

    const result = await writeDateSemanticTransaction(
      defaultInput(target, root, { readHostValidation: validate }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected host rejection');
    expect(result.code).toBe('HOST_REJECTED');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    expect(result.recovery?.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toMatchObject({ ok: true });
    expect(month!.value).toBe('');
    expect(year!.value).toBe('');
  });

  it('keeps unknown host validation explicit instead of inventing acceptance', async () => {
    document.body.innerHTML = '<form><input name="start" type="month"></form>';
    const form = document.querySelector('form')!;
    const month = document.querySelector('input')!;
    const root = createScanRoot(form, []);

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-month', part: inputPart(month, root, 'month', '2026-09') },
        root,
        { readHostValidation: () => ({}) },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.value.validation).toBe('unknown');
  });

  it('does not return success when final host validation queues a value revert', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    let validationReads = 0;

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        {
          readHostValidation: () => {
            validationReads += 1;
            if (validationReads === 2) queueMicrotask(() => { date.value = ''; });
            return { willValidate: true, valid: true };
          },
        },
      ),
    );

    expect(validationReads).toBe(2);
    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(date.value).toBe('');
  });

  it('re-reads host rejection after the final quiet turn', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    let validationReads = 0;

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        {
          readHostValidation: (element) => {
            validationReads += 1;
            if (validationReads === 2) {
              queueMicrotask(() => { element.setAttribute('aria-invalid', 'true'); });
            }
            return { ariaInvalid: element.getAttribute('aria-invalid') };
          },
        },
      ),
    );

    expect(validationReads).toBe(3);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected final host rejection');
    expect(result.code).toBe('HOST_REJECTED');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
  });

  it('permanently disarms group Undo after a later user edit even if raw values return to the seal', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };
    const result = await writeDateSemanticTransaction(defaultInput(target, root));
    if (!result.ok) throw new Error(result.code);

    year!.value = '2027';
    trustedInput(year!);
    year!.value = '2026';

    expect(result.value.undo.wasUserEdited()).toBe(true);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(
      result.value.undo.restore(testAuthority(null, 'undo', ['set-text'])),
    ).toEqual({ ok: false, code: 'ABORTED' });
    expect(month!.value).toBe('6');
    expect(year!.value).toBe('2026');
  });

  it('rechecks the execution fence between coupled Undo writes', async () => {
    document.body.innerHTML = `<form>
      <input name="month" type="text">
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const [month, year] = [...document.querySelectorAll('input')];
    const root = createScanRoot(form, []);
    const target: DateSemanticTarget = {
      kind: 'split-month-year',
      month: inputPart(month!, root, 'month', '6'),
      year: inputPart(year!, root, 'year', '2026'),
    };
    let executionFailure: 'POLICY_DISABLED' | null = null;
    const result = await writeDateSemanticTransaction(
      defaultInput(target, root, { executionFence: () => executionFailure }),
    );
    if (!result.ok) throw new Error(result.code);
    year!.addEventListener('input', () => { executionFailure = 'POLICY_DISABLED'; }, { once: true });

    const restored = result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    );

    expect(restored).toEqual({ ok: false, code: 'POLICY_DISABLED' });
    expect(year!.value).toBe('');
    expect(month!.value).toBe('6');
  });

  it('keeps Undo on the stable error contract when host dispatch throws after restore', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );
    if (!result.ok) throw new Error(result.code);
    Object.defineProperty(date, 'dispatchEvent', {
      configurable: true,
      value: () => { throw new Error('host dispatch failed'); },
    });

    const restored = result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    );

    expect(restored).toEqual({ ok: false, code: 'WRITE_REVERTED' });
    expect(date.value).toBe('');
    expect(result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
  });

  it('returns GESTURE_UNTRUSTED for malformed or forged Undo authority', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );
    if (!result.ok) throw new Error(result.code);

    expect(result.value.undo.restore(null as never)).toEqual({
      ok: false,
      code: 'GESTURE_UNTRUSTED',
    });
    expect(result.value.undo.restore({ purpose: 'undo', fingerprint: null } as never)).toEqual({
      ok: false,
      code: 'GESTURE_UNTRUSTED',
    });
    expect(result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toMatchObject({ ok: true });
    expect(date.value).toBe('');
  });

  it('returns HOST_SUBMITTED when submission begins during targeted Undo', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );
    if (!result.ok) throw new Error(result.code);
    date.addEventListener(
      'input',
      () => form.dispatchEvent(new Event('submit', { bubbles: true })),
      { once: true },
    );

    const restored = result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    );

    expect(restored).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
  });

  it('prioritizes submission over a coerced select failure during targeted Undo', async () => {
    document.body.innerHTML = `<form>
      <select name="month"><option value=""></option><option value="06">June</option></select>
      <input name="year" type="number">
    </form>`;
    const form = document.querySelector('form')!;
    const month = document.querySelector('select')!;
    const year = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    const result = await writeDateSemanticTransaction(
      defaultInput(
        {
          kind: 'split-month-year',
          month: selectPart(month, root, 'month', ['June']),
          year: inputPart(year, root, 'year', '2026'),
        },
        root,
      ),
    );
    if (!result.ok) throw new Error(result.code);
    month.addEventListener(
      'change',
      () => {
        month.selectedIndex = 1;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      },
      { once: true },
    );

    const restored = result.value.undo.restore(
      testAuthority(null, 'undo', ['set-select', 'set-text']),
    );

    expect(restored).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(month.value).toBe('06');
    expect(year.value).toBe('');
  });

  it('returns HOST_SUBMITTED without recovery when host submission begins during the write', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    date.addEventListener(
      'input',
      () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      { once: true },
    );

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(date.value).toBe('2026-09-11');
  });

  it('detects host submission from a sibling form in the same document', async () => {
    document.body.innerHTML = `<form id="application">
      <input name="date" type="date">
    </form><form id="sibling"></form>`;
    const application = document.querySelector<HTMLFormElement>('#application')!;
    const sibling = document.querySelector<HTMLFormElement>('#sibling')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(application, []);
    date.addEventListener(
      'input',
      () => sibling.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      { once: true },
    );

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(date.value).toBe('2026-09-11');
  });

  it('detects non-composed submission from a sibling form in the target shadow root', async () => {
    const host = document.createElement('date-application');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<form id="application">
      <input name="date" type="date">
    </form><form id="sibling"></form>`;
    const application = shadow.querySelector<HTMLFormElement>('#application')!;
    const sibling = shadow.querySelector<HTMLFormElement>('#sibling')!;
    const date = shadow.querySelector('input')!;
    const root = createScanRoot(host, []);
    date.addEventListener(
      'input',
      () => sibling.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      { once: true },
    );

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(date.value).toBe('2026-09-11');
  });

  it('treats formdata generation as a submission fence without invoking Submit', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    date.addEventListener(
      'input',
      () => form.dispatchEvent(new Event('formdata')),
      { once: true },
    );

    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
      ),
    );

    expect(result).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(date.value).toBe('2026-09-11');
  });

  it('permanently retires targeted Undo once the execution fence reports submission', async () => {
    document.body.innerHTML = '<form><input name="date" type="date"></form>';
    const form = document.querySelector('form')!;
    const date = document.querySelector('input')!;
    const root = createScanRoot(form, []);
    let submitted = false;
    const result = await writeDateSemanticTransaction(
      defaultInput(
        { kind: 'native-date', part: inputPart(date, root, 'date', '2026-09-11') },
        root,
        { executionFence: () => (submitted ? 'HOST_SUBMITTED' : null) },
      ),
    );
    if (!result.ok) throw new Error(result.code);
    submitted = true;

    expect(result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    submitted = false;
    expect(result.value.undo.restore(
      testAuthority(null, 'undo', ['set-text']),
    )).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(date.value).toBe('2026-09-11');
  });
});
