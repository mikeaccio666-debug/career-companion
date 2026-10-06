// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWizardReadOnlyDeclaration } from '@edaix/apply-kernel/wizardIdentity';
import { createPilotLocalWizardSession } from '../lib/pilotLocalWizardSession';
import { createPilotUa1ContentRuntime, type PilotUa1LiveObservation } from '../lib/pilotUa1DiscoveryRuntime';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { terminalLedger } from './helpers/pilotMultipageFixture';

const EXTENSION = 'local-wizard-test';
const BACKGROUND = `chrome-extension://${EXTENSION}/background.js`;
const now = 10_000;
let requestIndex = 0;

async function sha(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function declaration(key = 'test-wizard') {
  const parsed = parseWizardReadOnlyDeclaration({
    schemaVersion: 1, wizardKey: key, applicationRootSelector: '#application',
    indicatorContainerSelector: '#steps',
    steps: [0, 1, 2].map((i) => ({ stepKey: `step-${i}`, indicatorSelector: `#step-${i}` })),
  });
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.value;
}

function fixture() {
  document.body.innerHTML = '<main id="application"><nav id="steps">' + [0, 1, 2].map((i) =>
    `<span id="step-${i}" aria-controls="panel-${i}"${i === 0 ? ' aria-current="step"' : ''}>Step</span>`,
  ).join('') + '</nav>' + [0, 1, 2].map((i) =>
    `<section id="panel-${i}"${i === 0 ? '' : ' hidden'}>${i === 0 ? '<label for="name">Name</label><input id="name" value="User value">' : ''}</section>`,
  ).join('') + '</main>';
}

function moveTo(index: number) {
  for (let i = 0; i < 3; i++) {
    document.getElementById(`step-${i}`)!.setAttribute('aria-current', i === index ? 'step' : 'false');
    (document.getElementById(`panel-${i}`) as HTMLElement).hidden = i !== index;
  }
  // Preserve the user's node/value, as a host SPA may move an existing field.
  const name = document.getElementById('name');
  const label = document.querySelector('label');
  if (name && label) document.getElementById(`panel-${index}`)!.append(label, name);
}

function observer(rule = declaration()) {
  let live: PilotUa1LiveObservation | null = null;
  const handle = createPilotUa1ContentRuntime({
    enabled: true, extensionId: EXTENSION, expectedBackgroundUrl: BACKGROUND,
    document, view: window, location, now: () => now, lifecycleNonce: '11'.repeat(16),
    openShadowRoot: (element) => element.shadowRoot,
    wizardDeclaration: rule, observeLive: (next) => { live = next; },
  });
  return async () => {
    const request = createPilotUa1DiscoveryRequest({
      pageUrl: location.href, targetUrlDigest: await sha(location.href),
      requestId: (++requestIndex).toString(16).padStart(32, '0'), issuedAtMs: now,
    });
    const response = await handle(request, { id: EXTENSION, url: BACKGROUND });
    if (!response.ok) throw new Error(response.code);
    if (live === null) throw new Error('fixture observation missing');
    return live as PilotUa1LiveObservation;
  };
}

function ledgerFor(live: PilotUa1LiveObservation, state: 'PREFILLED' | 'DISCOVERY_INCOMPLETE' = 'PREFILLED') {
  const incomplete = state === 'DISCOVERY_INCOMPLETE';
  return {
    ...terminalLedger(0, [{
      questionId: 'question.shared', required: true,
      disposition: incomplete ? { state, reachability: 'DOM_GENERATION_CHANGED' } : { state, semanticReadback: 'CURRENT' },
    }], !incomplete, live.observation.packet.binding.domGeneration,
    incomplete ? [{ regionId: 'f'.repeat(64), reason: 'FRAME_NOT_OBSERVED' }] : []),
    binding: live.observation.packet.binding,
  };
}

function session() {
  const scope = Object.freeze({});
  let currentScope: object | null = scope;
  const value = createPilotLocalWizardSession({
    enabled: true, view: window, scopeToken: scope, readCurrentScopeToken: () => currentScope,
  });
  return { value, revoke: () => { currentScope = Object.freeze({}); } };
}

beforeEach(() => {
  history.replaceState(null, '', '/wizard');
  fixture();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, right: 180, bottom: 40, left: 0, width: 180, height: 40,
    toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('LOCAL_SESSION wizard checkpoints from canonical terminal facts', () => {
  it('captures before registry cleanup and commits only if the same local scope and observation still own the history slot', async () => {
    const { value, revoke } = session(), scan = observer();
    const live = await scan(); value.observe(live);
    const prepared = value.captureTerminal(live, ledgerFor(live));
    expect(prepared.ok).toBe(true);
    expect(value.snapshot()).toMatchObject({ ok: true, value: { checkpoints: [] } });
    live.registry.dispose();
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.value.commit()).toMatchObject({ ok: true, value: { stepIndex: 0 } });
    expect(value.snapshot()).toMatchObject({ ok: true, value: { currentStepIndex: null, checkpoints: [{ stepIndex: 0 }] } });
    revoke();
    expect(prepared.value.commit().ok).toBe(false);
    value.dispose();
  });
  it('does not commit a captured terminal after navigation or another observation takes its slot', async () => {
    const { value } = session(), scan = observer();
    const live = await scan(); value.observe(live);
    const prepared = value.captureTerminal(live, ledgerFor(live));
    if (!prepared.ok) throw new Error(prepared.code);
    window.dispatchEvent(new Event('pagehide'));
    expect(prepared.value.commit().ok).toBe(false);
    expect(value.snapshot()).toMatchObject({ ok: true, value: { checkpoints: [] } });
    value.dispose(); live.registry.dispose();
  });
  it('preserves earlier required dispositions and unobserved regions across adjacent declared steps', async () => {
    const { value } = session(), scan = observer();
    const first = await scan();
    expect(value.observe(first).ok).toBe(true);
    expect(value.recordTerminal(first, ledgerFor(first, 'DISCOVERY_INCOMPLETE')).ok).toBe(true);
    moveTo(1);
    const second = await scan();
    expect(value.observe(second).ok).toBe(true);
    expect(value.recordTerminal(second, ledgerFor(second)).ok).toBe(true);
    const snapshot = value.snapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.scope).toBe('LOCAL_SESSION');
    expect(snapshot.value.checkpoints).toHaveLength(2);
    expect(snapshot.value.checkpoints.map((point) => point.stepIndex)).toEqual([0, 1]);
    expect(snapshot.value.checkpoints[0]!.requiredDispositions[0]!.disposition.state).toBe('DISCOVERY_INCOMPLETE');
    expect(snapshot.value.checkpoints[0]!.unobservedRegions).toHaveLength(1);
    expect(snapshot.value.checkpoints[1]!.requiredDispositions[0]!.disposition.state).toBe('PREFILLED');
    expect(snapshot.value.currentStepCheckpointed).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/missionStepDigest|User value|selector|totalPages|100/);
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('User value');
    value.dispose(); second.registry.dispose();
  });

  it('replaces the checkpoint for a new stable rendering of the same step without appending a page', async () => {
    const { value } = session(), scan = observer();
    const first = await scan();
    value.observe(first); value.recordTerminal(first, ledgerFor(first));
    const panel = document.getElementById('panel-0')!;
    panel.replaceWith(panel.cloneNode(true));
    const replacement = await scan();
    expect(value.observe(replacement).ok).toBe(true);
    const beforeLedger = value.snapshot();
    expect(beforeLedger.ok && beforeLedger.value.currentStepCheckpointed).toBe(false);
    expect(value.recordTerminal(first, ledgerFor(first)).ok).toBe(false);
    expect(value.recordTerminal(replacement, ledgerFor(replacement)).ok).toBe(true);
    const afterLedger = value.snapshot();
    expect(afterLedger.ok && afterLedger.value.checkpoints.length).toBe(1);
    value.dispose(); replacement.registry.dispose();
  });

  it('rejects copied live observations, caller summaries and ledgers from a different binding', async () => {
    const { value } = session(), scan = observer();
    const live = await scan();
    expect(value.observe({ ...live }).ok).toBe(false);
    // A rejected forged source cannot establish a chain; use a new session.
    value.dispose();
    const next = session().value;
    expect(next.observe(live).ok).toBe(true);
    expect(next.recordTerminal(live, { completed: 1 }).ok).toBe(false);
    expect(next.recordTerminal(live, {
      ...ledgerFor(live), binding: { ...live.observation.packet.binding, domGeneration: 'f'.repeat(64) },
    }).ok).toBe(false);
    expect(next.recordTerminal(live, ledgerFor(live)).ok).toBe(true);
    next.dispose(); live.registry.dispose();
  });

  it.each(['skip', 'back', 'root', 'rule'] as const)('refuses %s drift and retains prior facts only as history', async (kind) => {
    const { value } = session(), scan = observer();
    const first = await scan();
    value.observe(first); value.recordTerminal(first, ledgerFor(first));
    if (kind === 'back') {
      moveTo(1);
      const second = await scan();
      value.observe(second); value.recordTerminal(second, ledgerFor(second));
      moveTo(0);
    } else if (kind === 'skip') moveTo(2);
    else if (kind === 'root') {
      const root = document.getElementById('application')!;
      root.replaceWith(root.cloneNode(true));
    }
    const invalid = await (kind === 'rule' ? observer(declaration('different-rule'))() : scan());
    expect(value.observe(invalid)).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    const snapshot = value.snapshot();
    expect(snapshot.ok && snapshot.value.currentStepIndex).toBeNull();
    expect(snapshot.ok && snapshot.value.checkpoints.length).toBe(kind === 'back' ? 2 : 1);
    expect(value.recordTerminal(invalid, ledgerFor(invalid)).ok).toBe(false);
    value.dispose(); invalid.registry.dispose();
  });

  it('does not invent a checkpoint when the user moves on without a terminal ledger', async () => {
    const { value } = session(), scan = observer();
    const first = await scan(); value.observe(first);
    moveTo(1);
    const second = await scan();
    expect(value.observe(second).ok).toBe(false);
    const snapshot = value.snapshot();
    expect(snapshot.ok && snapshot.value.checkpoints.length).toBe(0);
    value.dispose(); second.registry.dispose();
  });

  it('clears the owner-bound history when the current scope is revoked', async () => {
    const { value, revoke } = session(), scan = observer();
    const live = await scan(); value.observe(live); value.recordTerminal(live, ledgerFor(live));
    revoke();
    expect(value.snapshot()).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    expect(value.recordTerminal(live, ledgerFor(live)).ok).toBe(false);
    value.dispose(); live.registry.dispose();
  });

  it.each(['pagehide', 'popstate', 'hashchange'])('retires the chain after %s even when URL and nodes are restored', async (event) => {
    const { value } = session(), scan = observer();
    const first = await scan(); value.observe(first); value.recordTerminal(first, ledgerFor(first));
    window.dispatchEvent(new Event(event));
    const fresh = await scan();
    expect(value.observe(fresh).ok).toBe(false);
    const snapshot = value.snapshot();
    expect(snapshot.ok && snapshot.value.currentStepIndex).toBeNull();
    value.dispose(); fresh.registry.dispose();
  });
});
