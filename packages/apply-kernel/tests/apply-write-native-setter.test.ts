import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeAuthority, type HostWriteAuthority } from '../src/grant';
import { readValue } from '../src/fieldIdentity';
import { createUndoJournal, type UndoJournal, type WriteTicket } from '../src/undo';
import { writeSelectValue, writeTextValue } from '../src/write/setValue';
import { testAuthority } from './helpers/applyTestAuthority';

/**
 * The riskiest assumption in autofill (docs/AUTOFILL-DESIGN.md Phase 1): can we
 * write into a framework-CONTROLLED input so the host framework accepts it?
 * These tests also make the WriteTicket + HostWriteAuthority preconditions
 * explicit: the primitive tests acquire both through their only legal issuers.
 */

type Writable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

afterEach(() => {
  document.body.innerHTML = '';
});

function activeAuthority(): HostWriteAuthority {
  const authority = testAuthority('writer-test');
  const consumed = consumeAuthority(authority);
  if (!consumed.ok) throw new Error(`test authority unexpectedly rejected: ${consumed.code}`);
  return authority;
}

function ticketFor(element: Writable): { journal: UndoJournal; ticket: WriteTicket } {
  const journal = createUndoJournal();
  const recorded = journal.record(element);
  if (!recorded.ok) throw new Error(`test ticket unexpectedly rejected: ${recorded.code}`);
  return { journal, ticket: recorded.value };
}

/** Reproduces React's own-property value tracker on a controlled input. */
function controlledInput(): { el: HTMLInputElement; renderedValue: () => string } {
  const el = document.createElement('input');
  document.body.appendChild(el);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  let tracked = '';
  let componentState = '';

  Object.defineProperty(el, 'value', {
    configurable: true,
    get() {
      return descriptor.get!.call(this);
    },
    set(next: string) {
      tracked = String(next);
      descriptor.set!.call(this, next);
    },
  });

  el.addEventListener('input', () => {
    const domValue = descriptor.get!.call(el) as string;
    if (domValue !== tracked) {
      componentState = domValue;
      tracked = domValue;
    }
  });

  return {
    el,
    renderedValue: () => {
      descriptor.set!.call(el, componentState);
      return descriptor.get!.call(el) as string;
    },
  };
}

describe('writeTextValue', () => {
  it('writes through the prototype setter, so a controlled input keeps the value', () => {
    const { el, renderedValue } = controlledInput();
    const { ticket } = ticketFor(el);
    expect(writeTextValue(el, 'Ke', activeAuthority(), ticket)).toMatchObject({ ok: true });
    expect(renderedValue()).toBe('Ke');
  });

  it('a naive instance-setter assignment does not survive', () => {
    const { el, renderedValue } = controlledInput();
    el.value = 'Ke';
    expect(renderedValue()).toBe('');
  });

  it('fires input/change plus a non-bubbling blur/focusout validation envelope', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const seen: Array<{ type: string; bubbles: boolean }> = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) {
      el.addEventListener(type, (event) => seen.push({ type: event.type, bubbles: event.bubbles }));
    }
    const { ticket } = ticketFor(el);
    writeTextValue(el, 'x', activeAuthority(), ticket);
    expect(seen).toEqual([
      { type: 'input', bubbles: true },
      { type: 'change', bubbles: true },
      { type: 'blur', bubbles: false },
      { type: 'focusout', bubbles: true },
    ]);
  });

  it('never dispatches click or submit (铁律 2 — zero host clicks)', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const clickSpy = vi.fn();
    el.addEventListener('click', clickSpy);
    const { ticket } = ticketFor(el);
    writeTextValue(el, 'x', activeAuthority(), ticket);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('works on a textarea too', () => {
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    const { ticket } = ticketFor(el);
    expect(writeTextValue(el, 'hello', activeAuthority(), ticket)).toMatchObject({ ok: true });
    expect(el.value).toBe('hello');
  });
});

describe('writeSelectValue', () => {
  function select(options: Array<[value: string, text: string]>): HTMLSelectElement {
    const el = document.createElement('select');
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      el.appendChild(option);
    }
    document.body.appendChild(el);
    return el;
  }

  it('matches a unique option on value, visible text, or a prefix — in that order', () => {
    const byValue = select([['', 'Select…'], ['US', 'United States']]);
    expect(writeSelectValue(byValue, 'US', activeAuthority(), ticketFor(byValue).ticket)).toMatchObject({
      ok: true,
    });
    expect(byValue.value).toBe('US');

    const byText = select([['', 'Select…'], ['us', 'United States']]);
    expect(
      writeSelectValue(byText, 'united states', activeAuthority(), ticketFor(byText).ticket),
    ).toMatchObject({ ok: true });
    expect(byText.value).toBe('us');

    const byPrefix = select([['', 'Select…'], ['us', 'United States of America']]);
    expect(
      writeSelectValue(byPrefix, 'United States', activeAuthority(), ticketFor(byPrefix).ticket),
    ).toMatchObject({ ok: true });
    expect(byPrefix.value).toBe('us');
  });

  it('refuses to guess when nothing matches (caller reports NO_OPTION_MATCH)', () => {
    const el = select([['', 'Select…'], ['ca', 'Canada']]);
    expect(writeSelectValue(el, 'Australia', activeAuthority(), ticketFor(el).ticket)).toEqual({
      ok: false,
      code: 'NO_OPTION_MATCH',
    });
    expect(el.value).toBe('');
  });

  it('refuses an ambiguous prefix instead of selecting DOM-order first', () => {
    const el = select([
      ['', 'Select…'],
      ['minor', 'United States Minor Outlying Islands'],
      ['america', 'United States of America'],
    ]);

    expect(writeSelectValue(el, 'United States', activeAuthority(), ticketFor(el).ticket)).toEqual({
      ok: false,
      code: 'AMBIGUOUS_OPTION',
    });
    expect(el.value).toBe('');
  });

  it('does not send blur/focusout to a native select', () => {
    const el = select([['', 'Select…'], ['us', 'United States']]);
    const seen: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) {
      el.addEventListener(type, () => seen.push(type));
    }

    writeSelectValue(el, 'United States', activeAuthority(), ticketFor(el).ticket);
    expect(seen).toEqual(['input', 'change']);
  });
});

describe('undo journal', () => {
  it('restores every recorded field to its pre-write value', () => {
    const a = document.createElement('input');
    const b = document.createElement('textarea');
    document.body.append(a, b);
    a.value = 'original-a';
    b.value = 'original-b';
    const journal = createUndoJournal();
    const auth = activeAuthority();

    const aTicket = journal.record(a);
    const bTicket = journal.record(b);
    if (!aTicket.ok || !bTicket.ok) throw new Error('test journal failed to issue ticket');
    expect(writeTextValue(a, 'filled-a', auth, aTicket.value)).toMatchObject({ ok: true });
    journal.commit(aTicket.value, 'filled-a');
    expect(writeTextValue(b, 'filled-b', auth, bTicket.value)).toMatchObject({ ok: true });
    journal.commit(bTicket.value, 'filled-b');
    expect(journal.canUndo()).toBe(true);

    expect(journal.undoAll(testAuthority(null, 'undo')).restored).toBe(2);
    expect(a.value).toBe('original-a');
    expect(b.value).toBe('original-b');
    expect(journal.canUndo()).toBe(false);
  });

  it('restores a select that started with nothing chosen', () => {
    const el = document.createElement('select');
    for (const [value, text] of [['', 'Select…'], ['US', 'United States']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      el.appendChild(option);
    }
    document.body.appendChild(el);
    const journal = createUndoJournal();
    const recorded = journal.record(el);
    if (!recorded.ok) throw new Error('test journal failed to issue ticket');

    expect(readValue(el)).toBe('');
    expect(writeSelectValue(el, 'US', activeAuthority(), recorded.value)).toMatchObject({ ok: true });
    journal.commit(recorded.value, 'US');
    expect(el.value).toBe('US');

    journal.undoAll(testAuthority(null, 'undo'));
    expect(el.value).toBe('');
  });

  it('restores an explicitly unselected select even without an empty option', () => {
    const el = document.createElement('select');
    for (const [value, text] of [['US', 'United States'], ['CA', 'Canada']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      el.appendChild(option);
    }
    document.body.appendChild(el);
    el.selectedIndex = -1;
    const journal = createUndoJournal();
    const recorded = journal.record(el);
    if (!recorded.ok) throw new Error('test journal failed to issue ticket');

    expect(writeSelectValue(el, 'United States', activeAuthority(), recorded.value)).toMatchObject({ ok: true });
    journal.commit(recorded.value, 'US');
    expect(el.selectedIndex).toBe(0);

    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 1, remaining: 0 });
    expect(el.selectedIndex).toBe(-1);
  });

  it('abandons fields the host page re-rendered away instead of throwing', () => {
    const gone = document.createElement('input');
    document.body.appendChild(gone);
    gone.value = 'original';
    const journal = createUndoJournal();
    const recorded = journal.record(gone);
    if (!recorded.ok) throw new Error('test journal failed to issue ticket');
    expect(writeTextValue(gone, 'filled', activeAuthority(), recorded.value)).toMatchObject({ ok: true });
    journal.commit(recorded.value, 'filled');
    gone.remove();

    const outcome = journal.undoAll(testAuthority(null, 'undo'));
    expect(outcome).toMatchObject({ abandonedDetached: 1, remaining: 0 });
    expect(journal.canUndo()).toBe(false);
  });

  it('keeps earlier successful runs undoable instead of replacing their journal', () => {
    const first = document.createElement('input');
    const second = document.createElement('input');
    document.body.append(first, second);
    first.value = 'first original';
    second.value = 'second original';
    const journal = createUndoJournal();

    const firstTicket = journal.record(first);
    if (!firstTicket.ok) throw new Error('test journal failed to issue first ticket');
    expect(writeTextValue(first, 'first filled', activeAuthority(), firstTicket.value)).toMatchObject({ ok: true });
    journal.commit(firstTicket.value, 'first filled');

    const secondTicket = journal.record(second);
    if (!secondTicket.ok) throw new Error('test journal failed to issue second ticket');
    expect(writeTextValue(second, 'second filled', activeAuthority(), secondTicket.value)).toMatchObject({ ok: true });
    journal.commit(secondTicket.value, 'second filled');

    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 2, remaining: 0 });
    expect(first.value).toBe('first original');
    expect(second.value).toBe('second original');
  });

  it('does not overwrite a value the user changed after fill', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.value = 'original';
    const journal = createUndoJournal();
    const recorded = journal.record(input);
    if (!recorded.ok) throw new Error('test journal failed to issue ticket');
    expect(writeTextValue(input, 'filled', activeAuthority(), recorded.value)).toMatchObject({ ok: true });
    journal.commit(recorded.value, 'filled');
    input.value = 'user corrected';

    const outcome = journal.undoAll(testAuthority(null, 'undo'));
    expect(outcome).toMatchObject({ restored: 0, skippedUserEdited: 1, remaining: 1 });
    expect(input.value).toBe('user corrected');
  });
});
