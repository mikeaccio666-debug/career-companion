import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createBundledApplyPolicy } from '../src/policy';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal, type WriteTicket } from '../src/undo';
import { consumeAuthority, releaseAuthority } from '../src/grant';
import {
  sealPlainTextContenteditableTicket,
  setPlainTextContenteditable,
} from '../src/write/setPlainTextContenteditable';
import { ALLOWED_WRITE_PROPS } from '../src/write/allowlist';
import { testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountEditor(body = ''): HTMLElement {
  document.body.innerHTML = `<form id="application-form" class="application--form">
    <label id="cl">Cover letter</label>
    <div id="cover_letter" contenteditable="true" role="textbox" aria-labelledby="cl">${body}</div>
  </form>`;
  return document.querySelector<HTMLElement>('#cover_letter')!;
}

function trustedAdapter() {
  const rules = structuredClone(greenhouseRules) as Record<string, unknown>;
  (rules['keySteps'] as unknown[]).unshift({
    type: 'attrMap',
    attr: 'id',
    confidence: 1,
    map: { cover_letter: 'coverLetterPlainTextContenteditable' },
  });
  const parsed = parseVendorRuleset(rules);
  if (!parsed.ok) throw new Error(parsed.code);
  return compileRuleAdapter(parsed.value);
}

function resolvedForm(adapter = trustedAdapter()) {
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse' as const, root, fields: [...adapter.scan(root)] };
}

function releasedPlan(form = resolvedForm(), body = 'Grounded cover letter') {
  return buildApplyPlan(form, {}, {
    coverLetterText: body,
    coverLetterTargetVerified: true,
  });
}

function enabledPolicy() {
  const policy = createBundledApplyPolicy(Date.now());
  return {
    ...policy,
    capabilities: { ...policy.capabilities, 'set-richtext': true },
  };
}

async function runReleased(
  form = resolvedForm(),
  journal = createUndoJournal(),
) {
  const plan = releasedPlan(form);
  const result = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
    journal,
    root: form.root,
    policy: enabledPolicy(),
  });
  return { plan, result, journal };
}

function normalizeOnce(editor: HTMLElement): void {
  editor.addEventListener('input', () => queueMicrotask(() => {
    const span = document.createElement('span');
    span.textContent = editor.textContent;
    editor.replaceChildren(span);
  }), { once: true });
}

function trustedEdit(editor: HTMLElement, type: string): void {
  // Only the unit fixture can model platform-owned isTrusted this way.
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  editor.dispatchEvent(event);
}

describe('CAP-AF-004 dedicated plain-text contenteditable writer', () => {
  it('writes only textContent, reads back exactly, and supports verified Undo', async () => {
    const editor = mountEditor();
    const events: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) {
      editor.addEventListener(type, () => events.push(type));
    }
    const innerHtml = vi.spyOn(editor, 'innerHTML', 'set');
    const form = resolvedForm();
    const plan = releasedPlan(form, 'Grounded\n\nCover letter');
    const journal = createUndoJournal();

    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
      journal,
      root: form.root,
      policy: enabledPolicy(),
    });

    expect(result.results).toEqual([
      expect.objectContaining({ key: 'coverLetter', ok: true }),
    ]);
    expect(editor.textContent).toBe('Grounded\n\nCover letter');
    expect(events).toEqual(['input', 'change', 'blur', 'focusout']);
    expect(innerHtml).not.toHaveBeenCalled();
    expect([...journal.requiredUndoCapabilities()]).toEqual(['set-richtext']);

    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 1, remaining: 0 }));
    expect(editor.textContent).toBe('');
  });

  it('requires one trusted direct rule target and rejects forged plan authority', async () => {
    const editor = mountEditor();
    const untrusted = resolvedForm(compileRuleAdapter((() => {
      const parsed = parseVendorRuleset(greenhouseRules);
      if (!parsed.ok) throw new Error(parsed.code);
      return parsed.value;
    })()));
    expect(releasedPlan(untrusted).entries).toHaveLength(0);

    const form = resolvedForm();
    const plan = releasedPlan(form);
    (plan.entries[0] as unknown as Record<string, unknown>)[
      'plainTextContenteditableAttestation'
    ] = Object.freeze({
      source: 'trusted-apply-rule',
      purpose: 'cover-letter',
      isCurrent: () => true,
    });
    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
      journal: createUndoJournal(),
      root: form.root,
      policy: enabledPolicy(),
    });

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'IDENTITY_CHANGED',
    }));
    expect(editor.textContent).toBe('');
  });

  it('fails closed for revoked editing, target replacement, or structured children', async () => {
    for (const mutate of [
      (editor: HTMLElement) => editor.setAttribute('contenteditable', 'false'),
      (editor: HTMLElement) => editor.setAttribute('contenteditable', 'inherit'),
      (editor: HTMLElement) => editor.setAttribute('aria-disabled', 'true'),
      (editor: HTMLElement) => editor.setAttribute('hidden', ''),
      (editor: HTMLElement) => editor.parentElement!.setAttribute('inert', ''),
      (editor: HTMLElement) => {
        const replacement = editor.cloneNode(false) as HTMLElement;
        editor.removeAttribute('id');
        editor.after(replacement);
      },
      (editor: HTMLElement) => editor.append(document.createElement('p')),
    ]) {
      const editor = mountEditor();
      const form = resolvedForm();
      const plan = releasedPlan(form);
      mutate(editor);

      const result = await runApplyPlan({
        plan,
        auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
        journal: createUndoJournal(),
        root: form.root,
        policy: enabledPolicy(),
      });

      expect(result.results[0]?.ok).toBe(false);
      expect(editor.textContent).toBe('');
    }
  });

  it('fails closed when the reviewed label drifts into a sensitive field', async () => {
    const editor = mountEditor();
    const form = resolvedForm();
    const plan = releasedPlan(form);
    document.querySelector('#cl')!.textContent = 'Password';
    const journal = createUndoJournal();

    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
      journal,
      root: form.root,
      policy: enabledPolicy(),
    });

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'IDENTITY_CHANGED',
    }));
    expect(editor.textContent).toBe('');
    expect(journal.canUndo()).toBe(false);
  });

  it.each(['Candidate text', ' ', '\n'])(
    'never plans over exact non-empty content %j',
    (existing) => {
      const editor = mountEditor();
      editor.textContent = existing;
      const plan = releasedPlan(resolvedForm());
      expect(plan.entries).toHaveLength(0);
      expect(plan.skipped[0]).toEqual(expect.objectContaining({ reason: 'NOT_EMPTY' }));
      expect(editor.textContent).toBe(existing);
    },
  );

  it('rejects a whitespace-only body instead of writing an empty-looking value', () => {
    const editor = mountEditor();
    const plan = releasedPlan(resolvedForm(), ' \n ');

    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toEqual(expect.objectContaining({
      reason: 'UNSUPPORTED_CONTROL',
    }));
    expect(editor.textContent).toBe('');
  });

  it('requires exact delayed readback instead of formatting-equivalent content', async () => {
    const editor = mountEditor();
    editor.addEventListener('input', () => {
      queueMicrotask(() => {
        editor.textContent = 'Grounded cover letter!';
      });
    }, { once: true });
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'VALUE_COERCED',
    }));
    expect(editor.textContent).toBe('Grounded cover letter!');
    expect(journal.canUndo()).toBe(true);
  });

  it('compensates synchronous inert normalization while fill authority is live', async () => {
    const editor = mountEditor();
    editor.addEventListener('input', () => {
      const span = document.createElement('span');
      span.textContent = editor.textContent;
      editor.replaceChildren(span);
    }, { once: true });
    const { result, journal } = await runReleased();
    expect(result.results[0]).toEqual(expect.objectContaining({ ok: false, reason: 'WRITE_REVERTED' }));
    expect(editor.childNodes).toHaveLength(0);
    expect(journal.canUndo()).toBe(false);
  });

  it('keeps a sealed transaction undoable when our unrelated audit surface mounts outside the ScanRoot', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    const auditHost = document.createElement('div');
    auditHost.attachShadow({ mode: 'closed' });
    document.documentElement.append(auditHost);
    try {
      expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
        .toEqual(expect.objectContaining({ restored: 1, remaining: 0 }));
      expect(editor.childNodes).toHaveLength(0);
    } finally {
      auditHost.remove();
    }
  });

  it.each([
    'beforeinput', 'input', 'change', 'compositionstart', 'compositionupdate',
    'compositionend', 'paste', 'drop', 'cut',
  ])('never erases after trusted %s even if the value and full subtree are unchanged', async (type) => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    const original = [...editor.childNodes];
    trustedEdit(editor, type);
    const setter = vi.spyOn(editor, 'textContent', 'set');
    const outcome = await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']));
    expect(outcome).toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    expect([...editor.childNodes]).toEqual(original);
    expect(setter).not.toHaveBeenCalled();
  });

  it('rejects edit-and-edit-back without relying on final string equality', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    const text = editor.firstChild!.firstChild!;
    const previous = text.textContent;
    trustedEdit(editor, 'beforeinput');
    text.textContent = 'A user edit';
    text.textContent = previous;
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 0, failed: 1 }));
    expect(setter).not.toHaveBeenCalled();
  });

  it('arms the trusted-edit witness before dispatching any host write event', async () => {
    const editor = mountEditor();
    editor.addEventListener('input', () => trustedEdit(editor, 'paste'), { once: true });
    const { result, journal } = await runReleased();
    expect(result.results[0]?.ok).toBe(false);
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect((await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']))).restored).toBe(0);
    expect(setter).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('Grounded cover letter');
  });

  it('releases the private witness if recording throws after the observer was armed', () => {
    const editor = mountEditor();
    const form = resolvedForm();
    const entry = releasedPlan(form).entries[0]!;
    if (entry.kind !== 'richtext') throw new Error('TEST_EXPECTED_RICHTEXT');
    const read = vi.spyOn(editor, 'textContent', 'get');
    read.mockReturnValueOnce('').mockImplementation(() => { throw new Error('HOST_PRIVATE_VALUE'); });
    const removeListener = vi.spyOn(editor, 'removeEventListener');
    const journal = createUndoJournal();
    expect(journal.record(editor, { plainTextContenteditable: {
      root: form.root, attestation: entry.plainTextContenteditableAttestation,
    } })).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(journal.size()).toBe(0);
    expect(removeListener).toHaveBeenCalledTimes(9);
  });

  it.each([
    ['extra empty sibling', (editor: HTMLElement) => editor.append(document.createElement('span'))],
    ['new attribute', (editor: HTMLElement) => editor.firstElementChild!.setAttribute('data-host', 'new')],
    ['attribute changed back', (editor: HTMLElement) => {
      editor.firstElementChild!.setAttribute('data-host', 'new');
      editor.firstElementChild!.removeAttribute('data-host');
    }],
    ['interactive child', (editor: HTMLElement) => editor.firstElementChild!.append(document.createElement('button'))],
    ['changed text', (editor: HTMLElement) => { editor.firstChild!.textContent = 'Changed'; }],
    ['equal-text replacement', (editor: HTMLElement) => {
      const span = document.createElement('span'); span.textContent = editor.textContent;
      editor.replaceChildren(span);
    }],
    ['label replacement', () => {
      const replacement = document.createElement('label'); replacement.id = 'cl';
      replacement.textContent = 'Cover letter';
      document.querySelector('#cl')!.replaceWith(replacement);
    }],
    ['label drift', () => { document.querySelector('#cl')!.textContent = 'Password'; }],
    ['signature drift', (editor: HTMLElement) => { editor.setAttribute('name', 'other'); }],
    ['duplicate identity', (editor: HTMLElement) => {
      const duplicate = document.createElement('div'); duplicate.id = editor.id;
      duplicate.setAttribute('contenteditable', 'true'); editor.after(duplicate);
    }],
    ['target replacement', (editor: HTMLElement) => {
      const replacement = document.createElement('div'); replacement.id = editor.id;
      editor.replaceWith(replacement);
    }],
    ['detach and reattach', (editor: HTMLElement) => {
      const parent = editor.parentNode!; editor.remove(); parent.appendChild(editor);
    }],
    ['root detach and reattach', (editor: HTMLElement) => {
      const root = editor.closest('form')!; root.remove(); document.body.append(root);
    }],
    ['excluded scope', (editor: HTMLElement) => { editor.parentElement!.setAttribute('inert', ''); }],
  ] as const)('refuses structural restoration after %s', async (_name, mutate) => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    mutate(editor);
    const original = [...editor.childNodes];
    const setter = vi.spyOn(editor, 'textContent', 'set');
    const outcome = await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']));
    expect(outcome.restored).toBe(0);
    expect([...editor.childNodes]).toEqual(original);
    expect(setter).not.toHaveBeenCalled();
  });

  it('checks the seal at the last setter boundary even when a DOM read mutates the subtree', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const form = resolvedForm();
    const { journal } = await runReleased(form);
    const getAttribute = editor.getAttribute.bind(editor);
    const read = vi.spyOn(editor, 'getAttribute').mockImplementation((name) => {
      editor.firstElementChild!.setAttribute('data-new', 'host');
      return getAttribute(name);
    });
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect((await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']))).restored).toBe(0);
    expect(setter).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('contains hostile receipt read errors without leaking host values or minting future erasure authority', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    const original = [...editor.childNodes];
    const read = vi.spyOn(editor, 'textContent', 'get').mockImplementation(() => {
      throw new Error('PRIVATE_HOST_COVER_LETTER_VALUE');
    });
    const setter = vi.spyOn(editor, 'textContent', 'set');
    await expect(journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .resolves.toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    expect(setter).not.toHaveBeenCalled();
    read.mockRestore();
    expect([...editor.childNodes]).toEqual(original);
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
  });

  it('rechecks mutations from the final pre-restore snapshot read before touching host content', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    const original = [...editor.childNodes];
    const firstChild = Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild')!.get!;
    let reads = 0;
    const read = vi.spyOn(editor, 'firstChild', 'get').mockImplementation(() => {
      // The first two reads verify the receipt; the third captures the node
      // removed by the setter. Even this last read must precede the seal fence.
      if (++reads === 3) original[0]!.appendChild(document.createElement('button'));
      return firstChild.call(editor) as ChildNode | null;
    });
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    expect(setter).not.toHaveBeenCalled();
    expect([...editor.childNodes]).toEqual(original);
    read.mockRestore();
  });

  it.each(['attributes', 'interactive', 'other text'])('never adopts an unsupported initial normalization: %s', async (kind) => {
    const editor = mountEditor();
    editor.addEventListener('input', () => queueMicrotask(() => {
      const span = document.createElement(kind === 'interactive' ? 'button' : 'span');
      span.textContent = kind === 'other text' ? 'Changed' : editor.textContent;
      if (kind === 'attributes') span.setAttribute('class', 'editor');
      editor.replaceChildren(span);
    }), { once: true });
    const { journal } = await runReleased();
    const before = [...editor.childNodes];
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect((await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']))).restored).toBe(0);
    expect([...editor.childNodes]).toEqual(before);
    expect(setter).not.toHaveBeenCalled();
  });

  it('does not admit even an empty Text node as an empty original snapshot', async () => {
    const editor = mountEditor();
    const form = resolvedForm();
    const plan = releasedPlan(form);
    editor.append(document.createTextNode(''));
    const setter = vi.spyOn(editor, 'textContent', 'set');
    const journal = createUndoJournal();
    const result = await runApplyPlan({
      plan, root: form.root, policy: enabledPolicy(), journal,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
    });
    expect(result.results[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(setter).not.toHaveBeenCalled();
    expect(journal.canUndo()).toBe(false);
  });

  it('requires fresh set-richtext Undo authority and keeps native-only undo synchronous', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    const original = [...editor.childNodes];
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect(journal.undoAll(testAuthority(null, 'undo', ['set-richtext'])).restored).toBe(0);
    expect((await journal.undoAllSettled(testAuthority(null, 'undo', ['set-text']))).restored).toBe(0);
    const consumed = testAuthority(null, 'undo', ['set-richtext']);
    consumeAuthority(consumed); releaseAuthority(consumed);
    expect((await journal.undoAllSettled(consumed)).restored).toBe(0);
    expect([...editor.childNodes]).toEqual(original);
    expect(setter).not.toHaveBeenCalled();
    expect((await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']))).restored).toBe(1);
  });

  it('does not clear the journal before settled Undo or reuse it after a host re-normalization', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const { journal } = await runReleased();
    editor.addEventListener('input', () => queueMicrotask(() => {
      const span = document.createElement('span');
      span.textContent = 'Host replacement after Undo';
      editor.replaceChildren(span);
    }), { once: true });
    const pending = journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']));
    expect(journal.canUndo()).toBe(true);
    expect(await pending).toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect((await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']))).restored).toBe(0);
    expect(setter).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('Host replacement after Undo');
  });

  it('rejects native/cross-target/forged/replayed write tickets', () => {
    const editor = mountEditor();
    const form = resolvedForm();
    const entry = releasedPlan(form).entries[0]!;
    if (entry.kind !== 'richtext') throw new Error('TEST_EXPECTED_RICHTEXT');
    const context = { root: form.root, attestation: entry.plainTextContenteditableAttestation };
    const journal = createUndoJournal();
    const native = document.createElement('input');
    const nativeTicket = journal.record(native);
    if (!nativeTicket.ok) throw new Error('TEST_TICKET_MISSING');
    expect(sealPlainTextContenteditableTicket(nativeTicket.value, editor, context.root, context.attestation)).toBe(false);
    const issued = journal.record(editor, { plainTextContenteditable: context });
    if (!issued.ok) throw new Error('TEST_TICKET_MISSING');
    const authority = testAuthority(null, 'fill', ['set-richtext']);
    consumeAuthority(authority);
    const base = { ...context, element: editor, value: 'Grounded', authority };
    expect(setPlainTextContenteditable({ ...base, ticket: {} as WriteTicket }).ok).toBe(false);
    expect(setPlainTextContenteditable({ ...base, ticket: nativeTicket.value }).ok).toBe(false);
    expect(setPlainTextContenteditable({ ...base, element: document.createElement('div'), ticket: issued.value }).ok).toBe(false);
    expect(setPlainTextContenteditable({ ...base, ticket: issued.value }).ok).toBe(true);
    const setter = vi.spyOn(editor, 'textContent', 'set');
    expect(setPlainTextContenteditable({ ...base, ticket: issued.value }).ok).toBe(false);
    expect(setter).not.toHaveBeenCalled();
    releaseAuthority(authority);
    journal.clear();
  });

  it('returns value-free failures and never invokes Submit, requestSubmit or click during compensation/Undo', async () => {
    const editor = mountEditor();
    normalizeOnce(editor);
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit');
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const logs = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method as 'log'));
    const { result, journal } = await runReleased();
    const outcome = await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext']));
    expect(outcome.restored).toBe(1);
    expect(JSON.stringify({ result, outcome })).not.toContain('Grounded cover letter');
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('rejects delayed structured-editor mutation even when text still matches', async () => {
    const editor = mountEditor();
    const originalChildren = [...editor.childNodes];
    editor.addEventListener('input', () => {
      queueMicrotask(() => {
        const child = document.createElement('span');
        child.textContent = editor.textContent;
        editor.textContent = '';
        editor.append(child);
      });
    }, { once: true });
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'VALUE_COERCED',
    }));
    expect(editor.childElementCount).toBe(1);
    expect(journal.canUndo()).toBe(true);

    // PR #129 P1: advertising an Undo entry is not evidence of restoration.
    // Exercise the actual journal/primitive after the host wraps our text.
    expect.soft(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 1, failed: 0, remaining: 0 }));
    expect.soft(editor.textContent).toBe('');
    expect.soft([...editor.childNodes]).toEqual(originalChildren);
    expect.soft(journal.canUndo()).toBe(false);
  });

  it('rolls back an exact-readback failure immediately when restoration succeeds', async () => {
    const editor = mountEditor();
    const replaceOnce = () => {
      editor.removeEventListener('input', replaceOnce);
      editor.textContent = 'Host replacement';
    };
    editor.addEventListener('input', replaceOnce);
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'WRITE_REVERTED',
    }));
    expect(editor.textContent).toBe('');
    expect(journal.canUndo()).toBe(false);
  });

  it('retains a failed compensation without resealing authority over host replacement text', async () => {
    const editor = mountEditor();
    let inputCount = 0;
    const resist = () => {
      inputCount += 1;
      editor.textContent = inputCount === 1 ? 'Host replacement' : 'Rollback blocked';
    };
    editor.addEventListener('input', resist);
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'WRITE_REVERTED',
    }));
    expect(editor.textContent).toBe('Rollback blocked');
    expect(journal.canUndo()).toBe(true);

    editor.removeEventListener('input', resist);
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    expect(editor.textContent).toBe('Rollback blocked');
  });

  it('does not turn failed Undo into a future erasure capability', async () => {
    const editor = mountEditor();
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);
    expect(result.results[0]).toEqual(expect.objectContaining({ ok: true }));

    const rejectUndo = () => {
      if (editor.textContent === '') editor.textContent = 'Grounded cover letter';
    };
    editor.addEventListener('input', rejectUndo);
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ failed: 1, remaining: 1 }));

    editor.removeEventListener('input', rejectUndo);
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    expect(editor.textContent).toBe('Grounded cover letter');
  });

  it('keeps Undo bound to the original trusted ScanRoot', async () => {
    const editor = mountEditor();
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);
    expect(result.results[0]).toEqual(expect.objectContaining({ ok: true }));

    document.body.append(editor);
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ failed: 1, remaining: 1 }));
    expect(editor.textContent).toBe('Grounded cover letter');
  });

  it('refuses Undo after direct editing attestation has been revoked', async () => {
    const editor = mountEditor();
    const journal = createUndoJournal();
    const { result } = await runReleased(resolvedForm(), journal);
    expect(result.results[0]).toEqual(expect.objectContaining({ ok: true }));

    editor.setAttribute('contenteditable', 'false');
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 0, failed: 1, remaining: 1 }));
    expect(editor.textContent).toBe('Grounded cover letter');
  });

  it('does not issue a write ticket for an arbitrary HTMLElement', () => {
    const element = document.createElement('div');
    document.body.append(element);

    expect(createUndoJournal().record(element)).toEqual({
      ok: false,
      code: 'JOURNAL_UNAVAILABLE',
    });
  });

  it('honors the independent capability kill switch before mutation', async () => {
    const editor = mountEditor();
    const form = resolvedForm();
    const plan = releasedPlan(form);
    const policy = createBundledApplyPolicy(Date.now());
    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
      journal: createUndoJournal(),
      root: form.root,
      policy,
    });
    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'CAPABILITY_DISABLED',
    }));
    expect(editor.textContent).toBe('');
  });

  it('requires the current target release before planning any Cover Letter write', () => {
    const editor = mountEditor();
    const plan = buildApplyPlan(resolvedForm(), {}, {
      coverLetterText: 'Grounded cover letter',
    });

    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toEqual(expect.objectContaining({
      reason: 'HOST_UNCONFIRMED',
    }));
    expect(editor.textContent).toBe('');
  });

  it('does not bypass manual-only classification or host Submit detection', async () => {
    const editor = mountEditor();
    document.querySelector('#cl')!.textContent = 'Password';
    const manual = releasedPlan(resolvedForm());
    expect(manual.entries).toHaveLength(0);
    expect(manual.skipped[0]).toEqual(expect.objectContaining({ reason: 'MANUAL_ONLY' }));

    document.querySelector('#cl')!.textContent = 'Cover letter';
    const form = resolvedForm();
    const hostForm = document.querySelector<HTMLFormElement>('form')!;
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit');
    editor.addEventListener('input', () => {
      hostForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, { once: true });
    const { result } = await runReleased(form);
    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: false, reason: 'HOST_SUBMITTED',
    }));
    expect(result.abortedBy).toBe('HOST_SUBMITTED');
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('uses the existing reversible text writer for an exact Cover Letter textarea', async () => {
    document.body.innerHTML = `<form id="application-form" class="application--form">
      <label for="cover_letter">Cover letter</label>
      <textarea id="cover_letter" name="cover_letter"></textarea>
    </form>`;
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const form = resolvedForm();
    const plan = releasedPlan(form, 'Grounded textarea body');
    const journal = createUndoJournal();

    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text']),
      journal,
      root: form.root,
      policy: enabledPolicy(),
    });

    expect(result.results[0]).toEqual(expect.objectContaining({
      key: 'coverLetter', ok: true,
    }));
    expect(textarea.value).toBe('Grounded textarea body');
    expect([...journal.requiredUndoCapabilities()]).toEqual(['set-text']);
    expect(journal.undoAll(testAuthority(null, 'undo', ['set-text'])))
      .toEqual(expect.objectContaining({ restored: 1, remaining: 0 }));
    expect(textarea.value).toBe('');
  });

  it('never plans over a non-empty Cover Letter textarea when fillEmptyOnly is disabled', () => {
    document.body.innerHTML = `<form id="application-form" class="application--form">
      <label for="cover_letter">Cover letter</label>
      <textarea id="cover_letter" name="cover_letter">Candidate text</textarea>
    </form>`;
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const plan = buildApplyPlan(resolvedForm(), {}, {
      coverLetterText: 'Grounded textarea body',
      coverLetterTargetVerified: true,
      fillEmptyOnly: false,
    });

    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toEqual(expect.objectContaining({ reason: 'NOT_EMPTY' }));
    expect(textarea.value).toBe('Candidate text');
  });

  it('keeps the Cover Letter body out of run results and stable diagnostics', async () => {
    mountEditor();
    const form = resolvedForm();
    const body = 'D2_DATA_L1_SENTINEL_BODY';
    const plan = releasedPlan(form, body);
    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
      journal: createUndoJournal(),
      root: form.root,
      policy: enabledPolicy(),
    });

    expect(JSON.stringify(result)).not.toContain(body);
  });

  it.each([' ', '\n'])(
    'treats textarea content %j added after preview as non-empty without events or Undo',
    async (hostValue) => {
      document.body.innerHTML = `<form id="application-form" class="application--form">
        <label for="cover_letter">Cover letter</label>
        <textarea id="cover_letter" name="cover_letter"></textarea>
      </form>`;
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
      const form = resolvedForm();
      const plan = releasedPlan(form);
      textarea.value = hostValue;
      const events: string[] = [];
      textarea.addEventListener('input', () => events.push('input'));
      const journal = createUndoJournal();

      const result = await runApplyPlan({
        plan,
        auth: testAuthority(plan.fingerprint, 'fill', ['set-text']),
        journal,
        root: form.root,
        policy: enabledPolicy(),
      });

      expect(result.results[0]).toEqual(expect.objectContaining({
        key: 'coverLetter', ok: false, reason: 'NOT_EMPTY',
      }));
      expect(textarea.value).toBe(hostValue);
      expect(events).toEqual([]);
      expect(journal.canUndo()).toBe(false);
    },
  );

  it('keeps textContent outside the generic allowlist and the dedicated primitive markup-free', () => {
    expect(ALLOWED_WRITE_PROPS).not.toContain('textContent' as never);
    const writeDirectory = join(process.cwd(), 'src/write');
    const assignmentOwners = readdirSync(writeDirectory)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /\.textContent\s*=(?!=)/.test(readFileSync(`${writeDirectory}/${name}`, 'utf8')));
    expect(assignmentOwners).toEqual(['setPlainTextContenteditable.ts']);

    const source = readFileSync(join(writeDirectory, 'setPlainTextContenteditable.ts'), 'utf8');
    for (const forbidden of [
      '.innerHTML', '.outerHTML', '.insertAdjacentHTML', '.execCommand',
      '.appendChild', '.replaceChildren', '.setAttribute', '.removeAttribute', '.style',
    ]) {
      expect(source, `${forbidden} must remain absent`).not.toContain(forbidden);
    }
  });

  it.each(['structure', 'attestation', 'label'] as const)('does not call late %s drift a successful plain-text write', async (kind) => {
    const editor = mountEditor();
    const form = resolvedForm();
    const plan = releasedPlan(form);
    const result = await runApplyPlan({
      plan, root: form.root, policy: enabledPolicy(), journal: createUndoJournal(),
      auth: testAuthority(plan.fingerprint, 'fill', ['set-richtext']),
      lateRecheckMs: 1,
      lateRecheckDelay: async () => {
        if (kind === 'structure') {
          const span = document.createElement('span');
          span.textContent = editor.textContent;
          editor.replaceChildren(span);
        } else if (kind === 'attestation') {
          editor.setAttribute('contenteditable', 'false');
        } else {
          document.querySelector('#cl')!.textContent = 'Password';
        }
      },
    });
    expect(result.results[0]).toEqual(expect.objectContaining({
      ok: false, reason: 'LATE_REVERTED',
    }));
    expect(editor.textContent).toBe('Grounded cover letter');
  });

  it('preserves explicit Undo when host submission leaves rich-text residue', async () => {
    const editor = mountEditor();
    const journal = createUndoJournal();
    editor.addEventListener('input', () => {
      queueMicrotask(() => {
        const span = document.createElement('span');
        span.textContent = editor.textContent;
        editor.replaceChildren(span);
        editor.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
      });
    }, { once: true });
    const { result } = await runReleased(resolvedForm(), journal);
    expect(result.abortedBy).toBe('HOST_SUBMITTED');
    expect(editor.childElementCount).toBe(1);
    expect(journal.canUndo()).toBe(true);
    expect(await journal.undoAllSettled(testAuthority(null, 'undo', ['set-richtext'])))
      .toEqual(expect.objectContaining({ restored: 1, failed: 0, remaining: 0 }));
    expect(editor.childNodes).toHaveLength(0);
  });
});
