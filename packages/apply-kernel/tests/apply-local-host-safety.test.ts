import type { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan, EmailCodePrompt } from '../src/contracts';
import { fieldSignature } from '../src/fieldIdentity';
import { evaluateHostVeto } from '../src/gate/hostVeto';
import { resolveApplyGate, resolveAuthorizedAccountGate, resolveAuthorizedApplyGate } from '../src/gate/resolve';
import { captureTrustedShadowGesture, consumeAuthority, mintAccountAccessAuthority, releaseAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { collectClickFacts } from '../src/click/facts';
import { activateAccountControl, activateReviewedChoiceGroup, clickHostTarget, clickHostRestorationTarget } from '../src/click/primitives';
import { writeAccountField } from '../src/write/accountCredential';
import { executeFillOnlySemanticWrite } from '../src/write/fillOnlySemantic';
import { writeEmailCode } from '../src/write/emailCode';
import { commitDateSegment, writeDateSegment, writeSelectIndex, writeSelectValue, writeTextValue, writeTextValueWithMainWorld } from '../src/write/setValue';
import { testAuthority } from './helpers/applyTestAuthority';

const ORIGINAL_URL = window.location.href;
const ATS_URL = 'https://job-boards.greenhouse.io/acme/jobs/1';
const BLOCKED = [
  ['www.linkedin.com', 'LOCAL_AUTOMATION_DENY'],
  ['www.indeed.com', 'LOCAL_AUTOMATION_DENY'],
  ['apply.indeed.com', 'LOCAL_AUTOMATION_DENY'],
  ['smartapply.indeed.com', 'LOCAL_AUTOMATION_DENY'],
  ['www.usajobs.gov', 'PUBLIC_SECTOR'],
  ['jobs.city.gov', 'PUBLIC_SECTOR'],
  ['www.nhs.uk', 'PUBLIC_SECTOR'],
] as const;

function setURL(url: string) {
  // Changes only the synthetic document URL; the suite disables page loading.
  (window as unknown as Window).happyDOM.setURL(url);
}
function policy() {
  // A remote-only empty table must not remove the local automation restrictions.
  return { ...createBundledApplyPolicy(Date.now()), deniedHostSuffixes: [], source: 'remote' as const };
}
function mountPlan(): { plan: ApplyPlan; root: ReturnType<typeof createScanRoot>; element: HTMLInputElement } {
  document.body.innerHTML = '<form id="application-form"><label for="email">Email</label><input id="email" type="email" /></form>';
  const element = document.querySelector<HTMLInputElement>('#email')!;
  const root = createScanRoot(document.querySelector('form')!, []);
  const plan: ApplyPlan = {
    vendor: 'greenhouse', fingerprint: 'synthetic-host-safety', fillEmptyOnly: true, skipped: [],
    entries: [{ kind: 'text', key: 'email', label: 'Email', value: 'candidate@example.test', element,
      required: false, confidence: 1, order: 0, signature: fieldSignature(element, root) }],
  };
  return { plan, root, element };
}
function accountAuthority() {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [shadowRoot, host, document.body, document, window] });
  const proof = captureTrustedShadowGesture(event, shadowRoot);
  if (proof === null) throw new Error('SYNTHETIC_PROOF_UNAVAILABLE');
  const minted = mintAccountAccessAuthority({ proof });
  if (!minted.ok) throw new Error(minted.code);
  const active = consumeAuthority(minted.value);
  if (!active.ok) throw new Error(active.code);
  return active.value;
}

beforeEach(() => setURL(ATS_URL));
afterEach(() => {
  document.body.innerHTML = '';
  setURL(ORIGINAL_URL);
  vi.restoreAllMocks();
});

describe('local host rule applies before attribution and plan acquisition', () => {
  it.each(BLOCKED)('%s blocks ordinary, authoritative apply and account gates', (hostname, reason) => {
    document.body.innerHTML = '<form id="application-form"><input type="email" /></form>';
    const common = { doc: document, hostname, pathname: '/apply', policy: policy(), isTopFrame: true };
    const query = vi.spyOn(document, 'querySelectorAll');
    expect(evaluateHostVeto(common)).toEqual({ vetoed: true, reason });
    expect(resolveApplyGate({ ...common, search: '' })).toEqual({ attach: false, reason, vendor: null });
    expect(resolveAuthorizedApplyGate({ ...common, vendor: 'greenhouse' })).toEqual({ attach: false, reason, vendor: null });
    expect(resolveAuthorizedAccountGate({ ...common, vendor: 'greenhouse' })).toEqual({ attach: false, reason, vendor: null });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['job-boards.greenhouse.io', 'jobs.lever.co', 'careers.acme.test', 'localhost'])('%s retains the original non-veto behavior', (hostname) => {
    expect(evaluateHostVeto({ hostname, pathname: '/apply', policy: policy() })).toEqual({ vetoed: false });
  });
});

describe('exported runner rechecks the actual document, independently of a scan origin', () => {
  it.each(BLOCKED)('a previously prepared ATS plan cannot write after target document changes to %s', async (hostname) => {
    const { plan, root, element } = mountPlan();
    // Plan and trusted root were made on the allowed ATS; no caller loc is passed to runner.
    setURL(`https://${hostname}/apply`);
    expect(element.ownerDocument.location.hostname).toBe(hostname);
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const events = vi.fn();
    element.addEventListener('input', events);
    const journal = createUndoJournal();
    const result = await runApplyPlan({ plan, root, policy: policy(), auth: testAuthority(plan.fingerprint), journal });
    expect(result.results).toEqual([{ key: 'email', label: 'Email', ok: false, reason: 'POLICY_DISABLED' }]);
    expect(setter).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(journal.size()).toBe(0);
    expect(element.value).toBe('');
  });

  it('rechecks after onFieldStart can change the real target URL', async () => {
    const { plan, root, element } = mountPlan();
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const journal = createUndoJournal();
    const result = await runApplyPlan({ plan, root, policy: policy(), auth: testAuthority(plan.fingerprint), journal,
      onFieldStart: () => setURL('https://smartapply.indeed.com/indeedapply/apply') });
    expect(result.results[0]).toMatchObject({ ok: false, reason: 'POLICY_DISABLED' });
    expect(setter).not.toHaveBeenCalled();
    expect(journal.size()).toBe(0);
    expect(element.value).toBe('');
  });

  it('writes on a genuine allowed ATS document (positive control)', async () => {
    const { plan, root, element } = mountPlan();
    const result = await runApplyPlan({ plan, root, policy: policy(), auth: testAuthority(plan.fingerprint), journal: createUndoJournal() });
    expect(result.results[0]).toMatchObject({ ok: true });
    expect(element.value).toBe('candidate@example.test');
  });

  it('rechecks after an actual await before the next planned field', async () => {
    const { plan, root, element } = mountPlan();
    const second = document.createElement('input');
    second.id = 'second';
    document.querySelector('form')!.append(second);
    const two: ApplyPlan = { ...plan, entries: [
      { ...plan.entries[0]!, signature: fieldSignature(element, root) },
      { kind: 'text', key: 'firstName', label: 'First name', value: 'Alex', element: second,
        required: false, confidence: 1, order: 1, signature: fieldSignature(second, root) },
    ] };
    let checkpoints = 0;
    const result = await runApplyPlan({ plan: two, root, policy: policy(), auth: testAuthority(two.fingerprint), journal: createUndoJournal(),
      mutationDeliveryCheckpoint: async () => { await Promise.resolve(); checkpoints++; setURL('https://www.usajobs.gov/apply'); } });
    expect(checkpoints).toBe(1);
    expect(element.value).toBe('candidate@example.test');
    expect(second.value).toBe('');
    expect(result.results[1]).toMatchObject({ ok: false, reason: 'POLICY_DISABLED' });
  });

  it.each(['native', 'bridged'] as const)('%s runner preserves the first mutation ticket when a same-origin Dover input handler changes to /login', async (transport) => {
    setURL('https://app.dover.com/apply/acme/885f0f71-a784-4957-a1f2-e3b6980d6ed0');
    const { plan, root, element } = mountPlan();
    const second = document.createElement('input');
    second.id = 'second';
    document.querySelector('form')!.append(second);
    const two: ApplyPlan = { ...plan, entries: [
      { ...plan.entries[0]!, signature: fieldSignature(element, root) },
      { kind: 'text', key: 'firstName', label: 'First name', value: 'Alex', element: second,
        required: false, confidence: 1, order: 1, signature: fieldSignature(second, root) },
    ] };
    const dispatched: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) element.addEventListener(type, () => dispatched.push(type));
    element.addEventListener('input', () => window.history.pushState({}, '', '/login'));
    let settle!: (outcome: 'aborted') => void;
    const settled = new Promise<'aborted'>((resolve) => { settle = resolve; });
    const abort = vi.fn(() => settle('aborted'));
    const journal = createUndoJournal();
    const result = await runApplyPlan({ plan: two, root, policy: policy(), auth: testAuthority(two.fingerprint), journal,
      ...(transport === 'bridged' ? { startMainWorldBridge: () => ({ settled, abort }) } : {}),
    });
    expect(document.location.origin).toBe('https://app.dover.com');
    expect(document.location.pathname).toBe('/login');
    expect(element.value).toBe('candidate@example.test');
    expect(second.value).toBe('');
    expect(dispatched).toEqual(['input']);
    expect(result.results[1]).toMatchObject({ ok: false, reason: 'POLICY_DISABLED' });
    expect(journal.size(), 'the already-written field must remain traceable').toBe(1);
    if (transport === 'bridged') {
      // Primitive stops pending work immediately; runner also retires the retained handle.
      expect(abort).toHaveBeenCalledTimes(2);
      expect(result.results[0]).toMatchObject({ ok: false, reason: 'ABORTED' });
      await expect(settled).resolves.toBe('aborted');
    } else {
      expect(result.results[0]).toMatchObject({ ok: true });
      expect(result.filled).toBe(1);
    }
  });
});

describe('direct account and click exports retain the local gate', () => {
  it.each(BLOCKED)('direct account setter and control do not operate on %s', (hostname) => {
    setURL(`https://${hostname}/account`);
    document.body.innerHTML = '<form><input type="email" /><button type="button">Sign in</button></form>';
    const element = document.querySelector('input')!;
    const control = document.querySelector('button')!;
    const root = createScanRoot(document.querySelector('form')!, []);
    const active = accountAuthority();
    const accountPolicy = { enabled: true, capabilities: { ...policy().capabilities, 'account-access': true }, deniedHostSuffixes: [] };
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const click = vi.spyOn(control, 'click');
    try {
      expect(writeAccountField({ element, role: 'email', value: 'candidate@example.test', authority: active, policy: accountPolicy })).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(activateAccountControl({ element: control, role: 'useEmail', root, authority: active, policy: accountPolicy, isLikelyOffscreen: false })).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(setter).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    } finally { releaseAuthority(active); }
  });

  it('direct account writes and rule-declared control work on an allowed candidate host', () => {
    setURL('https://careers.acme.icims.com/account');
    document.body.innerHTML = '<form><input type="email" /><button type="button">Sign in</button></form>';
    const element = document.querySelector('input')!;
    const control = document.querySelector('button')!;
    const active = accountAuthority();
    const accountPolicy = { enabled: true, capabilities: { ...policy().capabilities, 'account-access': true } };
    const click = vi.fn();
    control.addEventListener('click', click);
    try {
      expect(writeAccountField({ element, role: 'email', value: 'candidate@example.test', authority: active, policy: accountPolicy }).ok).toBe(true);
      expect(activateAccountControl({ element: control, role: 'useEmail', root: createScanRoot(document.querySelector('form')!, []), authority: active, policy: accountPolicy, isLikelyOffscreen: false }).ok).toBe(true);
      expect(element.value).toBe('candidate@example.test');
      expect(click).toHaveBeenCalledTimes(1);
    } finally { releaseAuthority(active); }
  });

  it.each(BLOCKED)('direct widget click and restoration dispatch nothing on %s', (hostname) => {
    setURL(`https://${hostname}/apply`);
    document.body.innerHTML = '<form><li role="option">United States</li><input /></form>';
    const element = document.querySelector('li')!;
    const root = createScanRoot(document.querySelector('form')!, []);
    const facts = collectClickFacts({ element, root, kind: 'transaction-option', planned: true, openedByTransaction: true });
    const minted = testAuthority(null, 'fill', ['set-combobox']);
    const active = consumeAuthority(minted);
    if (!active.ok) throw new Error(active.code);
    const dispatch = vi.spyOn(element, 'dispatchEvent');
    try {
      expect(clickHostTarget({ element, root, facts, authority: active.value, ticket: createUndoJournal().record(document.querySelector('input')!), policy: policy() })).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(clickHostRestorationTarget({ element, root })).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { releaseAuthority(active.value); }
  });

  it('pointer sequence stops if mousedown changes the actual target document to a local denied host', () => {
    document.body.innerHTML = '<form><li role="option">United States</li><input /></form>';
    const element = document.querySelector('li')!;
    const root = createScanRoot(document.querySelector('form')!, []);
    const facts = collectClickFacts({ element, root, kind: 'transaction-option', planned: true, openedByTransaction: true });
    const active = consumeAuthority(testAuthority(null, 'fill', ['set-combobox']));
    if (!active.ok) throw new Error(active.code);
    const dispatched: string[] = [];
    for (const event of ['mousedown', 'mouseup', 'click']) element.addEventListener(event, () => dispatched.push(event));
    element.addEventListener('mousedown', () => setURL('https://www.linkedin.com/jobs/apply'));
    try {
      expect(clickHostTarget({ element, root, facts, authority: active.value, ticket: createUndoJournal().record(document.querySelector('input')!), policy: policy() })).toEqual({ ok: false, code: 'CLICK_DENIED' });
      expect(dispatched).toEqual(['mousedown']);
    } finally { releaseAuthority(active.value); }
  });

  it('native choice rechecks inside caller ownership immediately before dispatch', async () => {
    document.body.innerHTML = '<form><input type="checkbox" name="interest" /></form>';
    const element = document.querySelector('input')!;
    const root = createScanRoot(document.querySelector('form')!, []);
    const dispatch = vi.spyOn(element, 'dispatchEvent');
    let outcome: unknown;
    await executeFillOnlySemanticWrite({
      authorizeWrite: async () => true, executionFence: () => null, targetFence: () => null,
      isAtPreWriteState: () => true, isAtWrittenState: () => true, readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 1, settle: async () => undefined, lateRecheckDelay: async () => undefined,
      writeForward: (authority) => {
        outcome = activateReviewedChoiceGroup({ activations: [{ element, control: 'checkbox' }], root, authority,
          capabilityCurrent: () => true, beforeEach: () => true, afterEach: () => true,
          withOwnership: (_element, activate) => { setURL('https://apply.indeed.com/indeedapply/apply'); activate(); return true; } });
        return false;
      },
    });
    expect(outcome).toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(element.checked).toBe(false);
  });
});

describe('direct text, select, date and user-entered code write boundaries', () => {
  function activeTextAndSelect() {
    const active = consumeAuthority(testAuthority(null, 'fill', ['set-text', 'set-select']));
    if (!active.ok) throw new Error(active.code);
    return active.value;
  }
  function controls() {
    document.body.innerHTML = '<form><input id="text" /><textarea></textarea><select><option value="">Choose</option><option value="us">United States</option></select><div role="group"><input id="date" role="spinbutton" /></div></form>';
    return { text: document.querySelector<HTMLInputElement>('#text')!, textarea: document.querySelector('textarea')!, select: document.querySelector('select')!, date: document.querySelector<HTMLInputElement>('#date')! };
  }
  function ticket(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
    const recorded = createUndoJournal().record(element);
    if (!recorded.ok) throw new Error(recorded.code);
    return recorded.value;
  }
  function prompt(inputs: readonly HTMLInputElement[]): EmailCodePrompt {
    return { inputs, length: 2, charset: 'digits', next: 'verify', recipient: null, error: null, filled: false, isCurrent: () => true };
  }

  it.each(BLOCKED)('direct value/date/select primitives perform zero mutations or events on %s', (hostname) => {
    const { text, textarea, select, date } = controls();
    setURL(`https://${hostname}/apply`);
    const active = activeTextAndSelect();
    const setters = [vi.spyOn(HTMLInputElement.prototype, 'value', 'set'), vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set'), vi.spyOn(HTMLSelectElement.prototype, 'value', 'set'), vi.spyOn(HTMLSelectElement.prototype, 'selectedIndex', 'set')];
    const dispatches = [text, textarea, select, date].map((element) => vi.spyOn(element, 'dispatchEvent'));
    const bridge = vi.fn(() => ({ settled: Promise.resolve('handled' as const), abort: () => undefined }));
    try {
      expect(writeTextValue(text, 'Alex', active, ticket(text))).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(writeTextValue(textarea, 'Project summary', active, ticket(textarea))).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(writeTextValueWithMainWorld(text, 'Alex', active, ticket(text), bridge)).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(writeSelectValue(select, 'United States', active, ticket(select))).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(writeSelectIndex(select, 1, active, ticket(select))).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(writeDateSegment(date, '2026', active, ticket(date))).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(commitDateSegment(date, active)).toBe(false);
      for (const spy of [...setters, ...dispatches, bridge]) expect(spy).not.toHaveBeenCalled();
    } finally { releaseAuthority(active); }
  });

  it('normal ATS allows the same direct value/date/select primitives', () => {
    const { text, textarea, select, date } = controls();
    const active = activeTextAndSelect();
    try {
      expect(writeTextValue(text, 'Alex', active, ticket(text)).ok).toBe(true);
      expect(writeTextValue(textarea, 'Project summary', active, ticket(textarea)).ok).toBe(true);
      expect(writeSelectValue(select, 'United States', active, ticket(select)).ok).toBe(true);
      expect(select.value).toBe('us');
      expect(writeSelectIndex(select, 0, active, ticket(select)).ok).toBe(true);
      expect(select.selectedIndex).toBe(0);
      expect(writeDateSegment(date, '2026', active, ticket(date)).ok).toBe(true);
      expect(commitDateSegment(date, active)).toBe(true);
      expect(text.value).toBe('Alex');
      expect(textarea.value).toBe('Project summary');
      expect(date.value).toBe('2026');
    } finally { releaseAuthority(active); }
  });

  it('a native input event changing host stops the rest of its notification envelope', () => {
    const { text } = controls();
    const active = activeTextAndSelect();
    const seen: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) text.addEventListener(type, () => seen.push(type));
    text.addEventListener('input', () => setURL('https://www.linkedin.com/jobs/apply'));
    try {
      expect(writeTextValue(text, 'Alex', active, ticket(text))).toEqual({ ok: true, value: 'Alex' });
      expect(seen).toEqual(['input']);
      expect(text.value).toBe('Alex');
    } finally { releaseAuthority(active); }
  });

  it('MAIN bridge callback cannot dispatch the text envelope after host changed', () => {
    const { text } = controls();
    const active = activeTextAndSelect();
    const dispatch = vi.spyOn(text, 'dispatchEvent');
    const abort = vi.fn();
    try {
      const attempted = writeTextValueWithMainWorld(text, 'Alex', active, ticket(text), () => {
        setURL('https://apply.indeed.com/indeedapply/apply');
        return { settled: Promise.resolve('handled'), abort };
      });
      expect(attempted.ok).toBe(true);
      if (!attempted.ok) throw new Error(attempted.code);
      expect(attempted.value.bridge.abort).toBe(abort);
      expect(dispatch).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledTimes(1);
    } finally { releaseAuthority(active); }
  });

  it('pending MAIN bridge is retired when the first input changes the current host', async () => {
    const { text } = controls();
    const active = activeTextAndSelect();
    let settle!: (outcome: 'aborted') => void;
    const settled = new Promise<'aborted'>((resolve) => { settle = resolve; });
    const abort = vi.fn(() => settle('aborted'));
    text.addEventListener('input', () => setURL('https://www.linkedin.com/jobs/apply'));
    try {
      const attempted = writeTextValueWithMainWorld(text, 'Alex', active, ticket(text), () => ({ settled, abort }));
      expect(attempted.ok).toBe(true);
      if (!attempted.ok) throw new Error(attempted.code);
      expect(attempted.value.bridge.settled).toBe(settled);
      expect(abort).toHaveBeenCalledTimes(1);
      await expect(settled).resolves.toBe('aborted');
    } finally { releaseAuthority(active); }
  });

  it.each(BLOCKED)('even a user-entered email code performs zero writes/events on %s', (hostname) => {
    document.body.innerHTML = '<input type="text" /><input type="text" />';
    const inputs = [...document.querySelectorAll('input')];
    setURL(`https://${hostname}/verify`);
    const active = activeTextAndSelect();
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const dispatches = inputs.map((element) => vi.spyOn(element, 'dispatchEvent'));
    try {
      expect(writeEmailCode({ prompt: prompt(inputs), code: '12', authority: active, policy: policy() })).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(setter).not.toHaveBeenCalled();
      for (const dispatch of dispatches) expect(dispatch).not.toHaveBeenCalled();
    } finally { releaseAuthority(active); }
  });

  it('normal ATS accepts only the user-entered code and does not click', () => {
    document.body.innerHTML = '<input type="text" /><input type="text" />';
    const inputs = [...document.querySelectorAll('input')];
    const active = activeTextAndSelect();
    const clicks = inputs.map((input) => vi.spyOn(input, 'click'));
    try {
      expect(writeEmailCode({ prompt: prompt(inputs), code: '12', authority: active, policy: policy() })).toEqual({ ok: true });
      expect(inputs.map((input) => input.value)).toEqual(['1', '2']);
      for (const click of clicks) expect(click).not.toHaveBeenCalled();
    } finally { releaseAuthority(active); }
  });

  it('code input handler navigation stops later events and remaining digits', () => {
    document.body.innerHTML = '<input type="text" /><input type="text" />';
    const inputs = [...document.querySelectorAll('input')];
    const active = activeTextAndSelect();
    const seen: string[] = [];
    for (const input of inputs) for (const type of ['input', 'change', 'blur', 'focusout']) input.addEventListener(type, () => seen.push(type));
    inputs[0]!.addEventListener('input', () => setURL('https://smartapply.indeed.com/indeedapply/apply'));
    try {
      expect(writeEmailCode({ prompt: prompt(inputs), code: '12', authority: active, policy: policy() })).toEqual({ ok: false, code: 'POLICY_DISABLED' });
      expect(inputs.map((input) => input.value)).toEqual(['1', '']);
      expect(seen).toEqual(['input']);
    } finally { releaseAuthority(active); }
  });
});
