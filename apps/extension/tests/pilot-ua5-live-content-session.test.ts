// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PilotUa4WriteAuthority } from '@edaix/contracts/draft/pilot-ua4-write-authority';
import { parseSha256Digest } from '@edaix/contracts';
import type { PilotUa5ProfileBinding } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import type { TextSemanticUndoOwnership } from '@edaix/apply-kernel/textSemanticSettlement';
import { writerKind } from '@edaix/apply-kernel/pilotUa4Writer';
import { compileGraph } from '../../../packages/apply-kernel/src/semantic/graph';
import { sha256 } from '../../../packages/apply-kernel/tests/semantic/harness';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1LiveObservation,
} from '../lib/pilotUa1DiscoveryRuntime';
import {
  createPilotUa5LiveContentSession,
  type PilotUa5LiveContentSessionInput,
} from '../lib/pilotUa5LiveContentSession';
import { readPilotUa4TerminalLedger } from '../lib/pilotUa4WriterRuntime';

const EXTENSION_ID = 'ua5-live-session';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 20_000;
const ANSWER_DIGEST = '91'.repeat(32);
const PAYLOAD_REF = 'local.answer.email';
const PROFILE_BINDING: PilotUa5ProfileBinding = Object.freeze({
  fieldSchemaVersion: 1, fieldKeys: Object.freeze(['email'] as const),
  revision: '7', deletionEpoch: '3', snapshotDigest: parseSha256Digest(`sha256:${'d'.repeat(64)}`)!,
});

function positiveRect(): DOMRect {
  return {
    x: 0, y: 0, width: 160, height: 24, top: 0, right: 160, bottom: 24, left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function observe(
  markup = '<form><label for="email">Email</label><input id="email" type="email"></form>',
  count = 1,
): Promise<PilotUa1LiveObservation> {
  document.body.innerHTML = markup;
  let live: PilotUa1LiveObservation | null = null;
  const handle = createPilotUa1ContentRuntime({
    enabled: true,
    extensionId: EXTENSION_ID,
    expectedBackgroundUrl: BACKGROUND_URL,
    document,
    view: window,
    location,
    now: () => NOW,
    lifecycleNonce: '11'.repeat(16),
    openShadowRoot: (element) => element.shadowRoot,
    observeLive: (observation) => { live = observation; },
    scanPacket: scanPilotUa1Discovery,
  });
  const request = createPilotUa1DiscoveryRequest({
    pageUrl: location.href,
    requestId: '22'.repeat(16),
    issuedAtMs: NOW,
    targetUrlDigest: await digest(new URL(location.href).href),
  });
  if (request === null) throw new Error('request unavailable');
  expect(await handle(request, BACKGROUND_SENDER)).toEqual({ ok: true, detectedControlCount: count });
  if (live === null) throw new Error('live observation unavailable');
  return live;
}

function fixture(live: PilotUa1LiveObservation, index = 0) {
  const discovery = live.observation.packet;
  const structure = live.observation.structure!;
  const semanticEpochs = [Object.freeze({
    cause: 'USER_TRIGGER' as const,
    binding: discovery.binding,
    controls: discovery.controls,
    structure,
    suppressedControls: discovery.observation.suppressedControls,
    hiddenNotObservedCount: discovery.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null,
  })];
  const graph = compileGraph(semanticEpochs, sha256);
  if (!graph.ok) throw new Error(`compile failed: ${graph.reason}`);
  const question = graph.graph.nodes.filter((node) => node.kind === 'QUESTION')[index];
  if (question?.kind !== 'QUESTION') throw new Error('question unavailable');
  const identityDigests = question.control.members.map((member) => member.identityDigest);
  const controlKind = writerKind(question.control.kind);
  if (controlKind === null) throw new Error('writer kind unavailable');
  const authority: PilotUa4WriteAuthority = {
    authorityId: '99'.repeat(32),
    binding: discovery.binding,
    pageIdentityDigest: '88'.repeat(32),
    observedControlIdentityDigests: identityDigests,
    expiresAtMs: NOW + 5_000,
    questionAuthorizations: [{
      questionId: question.id,
      controlKind,
      identityDigests,
      required: question.required,
      answerAuthority: 'PROFILE_CONFIRMED',
      answerDigest: ANSWER_DIGEST,
    }],
    blockedQuestions: [],
    constraints: {
      exactTargetBinding: 'REQUIRED', semanticReadback: 'REQUIRED', hostValidation: 'REQUIRED',
      lateRecheck: 'REQUIRED', undo: 'REQUIRED', submit: 'FORBIDDEN',
      activationState: 'DEFAULT_OFF', releaseState: 'NOT_RELEASED',
    },
  };
  return {
    questionId: question.id,
    questions: graph.graph.nodes.filter(
      (node): node is Extract<typeof node, { kind: 'QUESTION' }> => node.kind === 'QUESTION',
    ),
    authority,
    writerInput: {
      authority,
      currentBinding: discovery.binding,
      currentControlIdentityDigests: identityDigests,
      nowMs: NOW,
      semanticEpochs,
      ua2Classifications: identityDigests.map((identityDigest) => ({
        identityDigest,
        kind: 'CANONICAL_FIELD' as const,
        canonicalField: 'EMAIL' as const,
        confidence: 'HIGH' as const,
        provenance: { source: 'AUTOCOMPLETE' as const, semanticDigest: '77'.repeat(32) },
        reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH' as const,
      })),
      semanticDigest: sha256,
      payloadRefs: [{ questionId: question.id, payloadRef: PAYLOAD_REF }],
      discoveryComplete: true,
      preResolvedDispositions: [],
    },
  };
}

function session(options: Readonly<{
  forwardWriteMode?: PilotUa5LiveContentSessionInput['forwardWriteMode'];
  authorizeLeafWrite?: PilotUa5LiveContentSessionInput['authorizeLeafWrite'];
  isProfileCurrent?: PilotUa5LiveContentSessionInput['isProfileCurrent'];
  onTerminalLedger?: PilotUa5LiveContentSessionInput['onTerminalLedger'];
  now?: () => number;
  writeNotAfterMs?: number;
  settle?: () => Promise<void>;
  readHostValidation?: PilotUa5LiveContentSessionInput['readHostValidation'];
  lateRecheckDelay?: PilotUa5LiveContentSessionInput['lateRecheckDelay'];
}> = {}) {
  return createPilotUa5LiveContentSession({
    enabled: true,
    document,
    view: window,
    location,
    lateRecheckMs: 1,
    operationTimeoutMs: 50,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    settle: async () => undefined,
    lateRecheckDelay: async () => undefined,
    now: () => NOW,
    writeNotAfterMs: NOW + 10_000,
    isProfileCurrent: async () => true, // Synthetic provider only; the real entrypoint has none.
    ...options,
  });
}

function bind(current: ReturnType<typeof session>, live: PilotUa1LiveObservation) {
  const run = fixture(live);
  expect(current.observe(live)).toBe(true);
  expect(current.bindPayloads([{
    questionId: run.questionId, payloadRef: PAYLOAD_REF,
    answerDigest: ANSWER_DIGEST, value: 'alex@example.test',
  }], PROFILE_BINDING)).toBe(true);
  return run;
}

function bindFillOnly(
  current: ReturnType<typeof session>,
  live: PilotUa1LiveObservation,
  value: string,
) {
  const run = fixture(live);
  run.writerInput.authority = {
    ...run.authority,
    constraints: { ...run.authority.constraints, undo: 'FROZEN' },
  };
  expect(current.observe(live)).toBe(true);
  expect(current.bindPayloads([{
    questionId: run.questionId,
    payloadRef: PAYLOAD_REF,
    answerDigest: ANSWER_DIGEST,
    value,
  }], PROFILE_BINDING)).toBe(true);
  return run;
}

function bindComboboxFillOnly(
  current: ReturnType<typeof session>,
  live: PilotUa1LiveObservation,
  value: string,
) {
  const run = bindFillOnly(current, live, value);
  const allControlIds = live.observation.packet.controls.map(
    (control) => control.identityDigest,
  );
  run.writerInput.authority = {
    ...run.writerInput.authority,
    observedControlIdentityDigests: allControlIds,
  };
  run.writerInput.currentControlIdentityDigests = allControlIds;
  return run;
}

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/ua5?step=1#form');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(positiveRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('UA-5 content-local text/textarea session', () => {
  it.each(['missing', 'revision', 'deletion', 'owner-answer', 'throw', 'truthy', 'expired', 'element-ABA'] as const)(
    'requires independent original-Profile currentness before a setter: %s', async (failure) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const form = document.querySelector('form')!;
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    let now = NOW;
    const isProfileCurrent = vi.fn(async (expected: Parameters<NonNullable<
      PilotUa5LiveContentSessionInput['isProfileCurrent']>>[0]) => {
      expect(expected.profileBinding).toEqual(PROFILE_BINDING);
      expect(expected.answerDigest).toBe(ANSWER_DIGEST);
      expect(Object.isFrozen(expected.profileBinding)).toBe(true);
      if (failure === 'throw') throw new Error('TEST_CURRENTNESS_UNAVAILABLE');
      if (failure === 'truthy') return 1 as unknown as boolean;
      if (failure === 'expired') now = NOW + 100;
      if (failure === 'element-ABA') { target.remove(); form.append(target); }
      // The injected provider denies changed owner/fact provenance or either version.
      return !['revision', 'deletion', 'owner-answer'].includes(failure);
    });
    const authorizeLeafWrite = vi.fn(async () => ({ allowed: true as const, writeNotAfterMs: NOW + 100 }));
    const current = session({ forwardWriteMode: 'EXACT_CANARY_SETTER_ONLY',
      now: () => now, authorizeLeafWrite, isProfileCurrent: failure === 'missing' ? undefined : isProfileCurrent });
    const run = bind(current, live);
    const result = await current.writer.execute(run.writerInput);
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    expect(target.value).toBe('');
    expect(setter).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    expect(authorizeLeafWrite).toHaveBeenCalledTimes(1);
    expect(isProfileCurrent).toHaveBeenCalledTimes(failure === 'missing' ? 0 : 1);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    current.dispose();
  });

  it.each([
    ['input', '<form><label for="email">Email</label><input id="email" type="email"></form>'],
    ['textarea', '<form><label for="email">Email</label><textarea id="email"></textarea></form>'],
  ] as const)('writes and owns one empty safe %s only in exact-canary setter-only mode', async (_kind, markup) => {
    const live = await observe(markup);
    const target = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('#email')!;
    const form = document.querySelector<HTMLFormElement>('form')!;
    const hostEvents: string[] = [];
    for (const type of ['beforeinput', 'input', 'change', 'blur', 'focusout']) {
      target.addEventListener(type, () => hostEvents.push(type));
    }
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const click = vi.spyOn(HTMLButtonElement.prototype, 'click');
    const authorizeLeafWrite = vi.fn(async () => true);
    const current = session({
      forwardWriteMode: 'EXACT_CANARY_SETTER_ONLY',
      authorizeLeafWrite,
    });
    const run = bind(current, live);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      questionId: run.questionId,
      disposition: {
        state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
      },
    }] } });
    expect(authorizeLeafWrite).toHaveBeenCalledTimes(1);
    expect(target.value).toBe('alex@example.test');
    expect(hostEvents).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(live.registry.isCurrent()).toBe(true);

    const undo = current.takeUndo(run.questionId);
    expect(undo).not.toBeNull();
    expect((undo as TextSemanticUndoOwnership).restorePreWrite()).toBe(true);
    expect(target.value).toBe('');
    expect(hostEvents).toEqual([]);
    expect(current.takeUndo(run.questionId)).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    current.dispose();
  });

  it.each(['grant-expiry', 'Profile-revocation'] as const)(
    'keeps sealed ownership but irreversibly blocks later leaves after %s', async (failure) => {
    const live = await observe(
      '<form><label for="email">Email</label><input id="email" type="email">' +
      '<label for="other">Contact address</label><input id="other" type="email">' +
      '<label for="last">Last address</label><input id="last" type="email"></form>', 3,
    );
    const runs = [fixture(live, 0), fixture(live, 1), fixture(live, 2)];
    let clock = NOW;
    let grants = 0;
    let profileChecks = 0;
    const current = session({
      forwardWriteMode: 'EXACT_CANARY_SETTER_ONLY', now: () => clock, writeNotAfterMs: NOW + 100,
      authorizeLeafWrite: async () => { if (++grants === 2 && failure === 'grant-expiry') clock = NOW + 100; return true; },
      isProfileCurrent: async () => ++profileChecks !== 2 || failure !== 'Profile-revocation',
    });
    current.observe(live);
    current.bindPayloads(runs.map((run, index) => ({
      questionId: run.questionId, payloadRef: `${PAYLOAD_REF}.${index}`,
      answerDigest: ANSWER_DIGEST, value: 'alex@example.test',
    })), PROFILE_BINDING);
    const writerInput = {
      ...runs[0]!.writerInput,
      authority: { ...runs[0]!.authority,
        observedControlIdentityDigests: runs.flatMap((run) => run.authority.observedControlIdentityDigests),
        questionAuthorizations: runs.flatMap((run) => run.authority.questionAuthorizations),
      },
      currentControlIdentityDigests: runs.flatMap((run) => run.writerInput.currentControlIdentityDigests),
      ua2Classifications: runs.flatMap((run) => run.writerInput.ua2Classifications),
      payloadRefs: runs.map((run, index) => ({ questionId: run.questionId, payloadRef: `${PAYLOAD_REF}.${index}` })),
    };
    const result = await current.writer.execute(writerInput);
    expect(grants).toBe(2);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { dispositions: [
      { disposition: { state: 'FILLED' } }, { disposition: { state: 'POLICY_BLOCKED' } },
      { disposition: { state: 'POLICY_BLOCKED' } },
    ] } });
    expect([...document.querySelectorAll('input')].map((target) => target.value).filter(Boolean))
      .toEqual(['alex@example.test']);
    current.dispose();
  });

  it('rejects a delayed grant at its tighter lease cutoff before the setter', async () => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const writeNotAfterMs = NOW + 1_000;
    const grantWriteNotAfterMs = NOW + 100;
    let clock = NOW;
    let releaseGrant!: (authorization: Readonly<{
      allowed: true;
      writeNotAfterMs: number;
    }>) => void;
    const authorizeLeafWrite = vi.fn(() => new Promise<Readonly<{
      allowed: true;
      writeNotAfterMs: number;
    }>>((resolve) => {
      releaseGrant = resolve;
    }));
    const current = session({
      forwardWriteMode: 'EXACT_CANARY_SETTER_ONLY',
      authorizeLeafWrite,
      now: () => clock,
      writeNotAfterMs,
    });
    const run = bind(current, live);

    const result = current.writer.execute(run.writerInput);
    await vi.waitFor(() => expect(authorizeLeafWrite).toHaveBeenCalledTimes(1));
    clock = grantWriteNotAfterMs;
    releaseGrant(Object.freeze({
      allowed: true,
      writeNotAfterMs: grantWriteNotAfterMs,
    }));

    await expect(result).resolves.toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    expect(target.value).toBe('');
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it('compensates a setter when the high-water clock expires during settlement', async () => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const writeNotAfterMs = NOW + 100;
    let clock = NOW;
    const current = session({
      forwardWriteMode: 'EXACT_CANARY_SETTER_ONLY',
      authorizeLeafWrite: async () => true,
      now: () => clock,
      writeNotAfterMs,
      settle: async () => { clock = writeNotAfterMs; },
    });
    const run = bind(current, live);

    await expect(current.writer.execute(run.writerInput)).resolves.toMatchObject({
      ok: true, value: { dispositions: [{ disposition: { state: 'POLICY_BLOCKED' } }] },
    });
    expect(target.value).toBe('');
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it('permanently rejects a clock rollback observed after leaf authorization', async () => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    let clock = NOW;
    const current = session({
      forwardWriteMode: 'EXACT_CANARY_SETTER_ONLY',
      authorizeLeafWrite: async () => {
        clock = NOW - 1;
        return true;
      },
      now: () => clock,
      writeNotAfterMs: NOW + 100,
    });
    const run = bind(current, live);

    await expect(current.writer.execute(run.writerInput)).resolves.toMatchObject({
      ok: true, value: { dispositions: [{ disposition: { state: 'POLICY_BLOCKED' } }] },
    });
    expect(target.value).toBe('');
    current.dispose();
  });

  it.each([
    ['input', '<label for="email">Email</label><input id="email" type="email">'],
    ['textarea', '<label for="email">Email</label><textarea id="email"></textarea>'],
  ] as const)('fails an empty %s closed before setter while no monotonic value witness exists', async (_kind, markup) => {
    const live = await observe(markup);
    const target = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('#email')!;
    const events: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout']) {
      target.addEventListener(type, () => events.push(type));
    }
    const current = session();
    const run = bind(current, live);
    expect(current.resolvePayloadRef({
      questionId: run.questionId,
      answerDigest: ANSWER_DIGEST,
    })).toBe(PAYLOAD_REF);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      questionId: run.questionId,
      disposition: { state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' },
    }] } });
    expect(target.value).toBe('');
    expect(events).toEqual([]);
    expect(current.resolvePayloadRef({
      questionId: run.questionId,
      answerDigest: ANSWER_DIGEST,
    })).toBeNull();
    expect(live.registry.isCurrent()).toBe(false);
    const undo = current.takeUndo(run.questionId);
    expect(undo).toBeNull();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it('cannot infer ownership from direct native-setter eventless ABA', async () => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const current = session();
    const run = bind(current, live);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    const writerSetter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    // Neither transition emits an event nor a MutationRecord. Endpoint state
    // returns to empty. Calling the descriptor captured before the spy also
    // models a host that retained the native setter before this transaction;
    // an instance/prototype hook cannot witness either call.
    descriptor.set!.call(target, 'host-intermediate');
    descriptor.set!.call(target, '');
    expect(target.value).toBe('');

    expect(await current.writer.execute(run.writerInput)).toMatchObject({
      ok: true,
      value: { dispositions: [{ disposition: {
        state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE',
      } }] },
    });
    expect(target.value).toBe('');
    expect(writerSetter).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it('reports exact prefilled state without writing or creating Undo', async () => {
    const live = await observe(
      '<label for="email">Email</label><input id="email" type="email" value="alex@example.test">',
    );
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const dispatch = vi.spyOn(target, 'dispatchEvent');
    const current = session();
    const run = bind(current, live);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'PREFILLED', semanticReadback: 'CURRENT' },
    }] } });
    expect(dispatch).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it('revalidates fresh geometry after payload binding before a prefilled leaf decision', async () => {
    const live = await observe(
      '<label for="email">Email</label><input id="email" type="email" value="alex@example.test">',
    );
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const dispatch = vi.spyOn(target, 'dispatchEvent');
    const current = session();
    const run = bind(current, live);
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(() => ({
      ...positiveRect(), width: 1, height: 1, right: 1,
    }) as DOMRect);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' },
    }] } });
    expect(target.value).toBe('alex@example.test');
    expect(dispatch).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it('accepts more than five contract-valid payload bindings without a consumer-side cap', async () => {
    const live = await observe(
      '<label for="email">Email</label><input id="email" type="email">',
    );
    const current = session();
    const run = fixture(live);
    expect(current.observe(live)).toBe(true);
    const payloads = Array.from({ length: 6 }, (_, index) => ({
      questionId: index === 0 ? run.questionId : `question.extra.${index}`,
      payloadRef: `local.answer.${index}`,
      answerDigest: index.toString(16).padStart(64, '0'),
      value: `value-${index}`,
    }));

    expect(current.bindPayloads(payloads, PROFILE_BINDING)).toBe(true);
    expect(current.resolvePayloadRef({
      questionId: 'question.extra.5',
      answerDigest: '5'.padStart(64, '0'),
    })).toBe('local.answer.5');
    current.dispose();
  });

  it('never overwrites a nonempty mismatch or a drifted/replaced exact target', async () => {
    const live = await observe(
      '<label for="email">Email</label><input id="email" type="email" value="person@host.test">',
    );
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const dispatch = vi.spyOn(target, 'dispatchEvent');
    const current = session();
    const run = bind(current, live);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' },
    }] } });
    expect(target.value).toBe('person@host.test');
    expect(dispatch).not.toHaveBeenCalled();

    const replacedLive = await observe(
      '<label for="email">Email</label><input id="email" type="email">',
    );
    const replacementSession = session();
    const replacedRun = fixture(replacedLive);
    replacementSession.observe(replacedLive);
    replacementSession.bindPayloads([{
      questionId: replacedRun.questionId, payloadRef: PAYLOAD_REF,
      answerDigest: ANSWER_DIGEST, value: 'alex@example.test',
    }], PROFILE_BINDING);
    document.querySelector('#email')!.replaceWith(document.createElement('input'));
    expect(await replacementSession.writer.execute(replacedRun.writerInput))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    replacementSession.dispose();
    current.dispose();
  });

  it('keeps the real gate closed without dispatching host events or installing a Submit guard', async () => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const form = document.querySelector<HTMLFormElement>('form')!;
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const click = vi.spyOn(target, 'click');
    const hostSubmit = vi.fn();
    form.addEventListener('submit', hostSubmit);
    target.addEventListener('input', () => form.requestSubmit());
    const current = session();
    const run = bind(current, live);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' },
    }] } });
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(hostSubmit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(target.value).toBe('');
    expect(current.takeUndo(run.questionId)).toBeNull();
    const postRecoverySubmit = new Event('submit', { bubbles: true, cancelable: true });
    expect(form.dispatchEvent(postRecoverySubmit)).toBe(true);
    expect(postRecoverySubmit.defaultPrevented).toBe(false);
    expect(hostSubmit).toHaveBeenCalledTimes(1);
    current.dispose();
  });

  it('rejects unsafe targets and wrong payload authority before a setter or event', async () => {
    const live = await observe(
      '<label for="password">Email</label><input id="password" type="email" disabled>',
    );
    const target = document.querySelector<HTMLInputElement>('#password')!;
    const dispatch = vi.spyOn(target, 'dispatchEvent');
    const current = session();
    const run = fixture(live);
    current.observe(live);
    expect(current.bindPayloads([{
      questionId: run.questionId, payloadRef: PAYLOAD_REF,
      answerDigest: '92'.repeat(32), value: 'never-write-me',
    }], PROFILE_BINDING)).toBe(true);
    expect(current.resolvePayloadRef({
      questionId: run.questionId, answerDigest: ANSWER_DIGEST,
    })).toBeNull();

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    expect(target.value).toBe('');
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('never-write-me');
    current.dispose();
  });

});


describe('fill-first native choice session', () => {
  it('selects one exact option from an already-expanded reviewed combobox', async () => {
    const live = await observe(`<form><label for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      <ul id="locations" role="listbox">
        <li id="remote" role="option" aria-selected="false">Remote</li>
        <li id="onsite" role="option" aria-selected="false">On site</li>
      </ul></form>`, 1);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const pointerEvents: string[] = [];
    for (const option of options) {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        option.addEventListener(type, () => pointerEvents.push(`${option.id}:${type}`));
      }
    }
    options[0]!.addEventListener('click', (event) => {
      expect(event.defaultPrevented).toBe(true);
      options[0]!.setAttribute('aria-selected', 'true');
      options[1]!.setAttribute('aria-selected', 'false');
      document.querySelector<HTMLInputElement>('#location')!
        .setAttribute('aria-expanded', 'false');
    });
    const form = document.querySelector<HTMLFormElement>('form')!;
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const nativeClick = vi.spyOn(HTMLElement.prototype, 'click');
    let sameLiveAtTerminal = false;
    let registryCurrentAtTerminal: boolean | null = null;
    let terminalLedger: ReturnType<typeof readPilotUa4TerminalLedger> = null;
    const onTerminalLedger = vi.fn<NonNullable<PilotUa5LiveContentSessionInput['onTerminalLedger']>>((observed, result) => {
      sameLiveAtTerminal = observed === live;
      registryCurrentAtTerminal = observed.registry.isCurrent();
      terminalLedger = readPilotUa4TerminalLedger(result);
      // The real wizard controller has this same mandatory currentness gate.
      // Host selection/closure invalidates the optional checkpoint, not FILLED.
      return sameLiveAtTerminal && registryCurrentAtTerminal && terminalLedger !== null;
    });
    const current = session({
      forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      onTerminalLedger,
    });
    const run = bindComboboxFillOnly(current, live, 'Remote');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.questions).toEqual([{ questionId: run.questionId, required: false }]);
    expect(result.value.dispositions).toHaveLength(1);
    expect(result.value.summary).toMatchObject({ observableQuestions: 1, terminalQuestions: 1 });
    expect(onTerminalLedger).toHaveBeenCalledOnce();
    expect(sameLiveAtTerminal).toBe(true);
    expect(terminalLedger).toBe(result.value);
    expect(registryCurrentAtTerminal).toBe(false);
    expect(current.didCaptureTerminal()).toBe(false);
    expect(live.registry.isCurrent()).toBe(false);
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId))
      .toEqual({
        questionId: run.questionId,
        disposition: {
          state: 'FILLED', semanticReadback: 'HOST_ACCEPTED',
          lateRecheck: 'STABLE', undo: 'FROZEN',
        },
      });
    expect(pointerEvents).toEqual(['remote:mousedown', 'remote:mouseup', 'remote:click']);
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(nativeClick).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('stops the pointer sequence when mousedown changes the reviewed question label', async () => {
    const live = await observe(`<form><label id="question-label" for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      <ul id="locations" role="listbox">
        <li id="remote" role="option" aria-selected="false">Remote</li>
        <li id="onsite" role="option" aria-selected="false">On site</li>
      </ul></form>`, 1);
    const label = document.querySelector<HTMLElement>('#question-label')!;
    const remote = document.querySelector<HTMLElement>('#remote')!;
    const pointerEvents: string[] = [];
    remote.addEventListener('mousedown', () => {
      pointerEvents.push('mousedown');
      label.textContent = 'Citizenship';
    });
    remote.addEventListener('mouseup', () => pointerEvents.push('mouseup'));
    remote.addEventListener('click', () => {
      pointerEvents.push('click');
      remote.setAttribute('aria-selected', 'true');
    });
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true });
    const run = bindComboboxFillOnly(current, live, 'Remote');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
      .toMatchObject({ state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' });
    expect(pointerEvents).toEqual(['mousedown']);
    expect(label.textContent).toBe('Citizenship');
    expect(remote.getAttribute('aria-selected')).toBe('false');
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it.each([
    { membershipCallback: 1, armAfter: 'mousedown' },
    { membershipCallback: 2, armAfter: 'mousedown' },
    { membershipCallback: 1, armAfter: 'mouseup' },
    { membershipCallback: 2, armAfter: 'mouseup' },
  ] as const)(
    'stops after $armAfter when membership callback $membershipCallback observes Submit',
    async ({ membershipCallback, armAfter }) => {
      const original = await observe(`<form><label for="location">Work location</label>
        <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
        <ul id="locations" role="listbox">
          <li id="remote" role="option" aria-selected="false">Remote</li>
          <li id="onsite" role="option" aria-selected="false">On site</li>
        </ul></form>`, 1);
      const form = document.querySelector<HTMLFormElement>('form')!;
      const remote = document.querySelector<HTMLElement>('#remote')!;
      let armed = false;
      let membershipReads = 0;
      let submitted = false;
      const live = {
        ...original,
        registry: {
          ...original.registry,
          resolveOptionsForWrite: (
            identity: Parameters<typeof original.registry.resolveOptionsForWrite>[0],
          ) => {
            const result = original.registry.resolveOptionsForWrite(identity);
            if (armed && ++membershipReads === membershipCallback) {
              submitted = true;
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
            return result;
          },
        },
      } satisfies PilotUa1LiveObservation;
      const pointerEvents: string[] = [];
      remote.addEventListener('mousedown', () => {
        pointerEvents.push('mousedown');
        if (armAfter === 'mousedown') armed = true;
      });
      remote.addEventListener('mouseup', () => {
        pointerEvents.push('mouseup');
        if (armAfter === 'mouseup') armed = true;
      });
      remote.addEventListener('click', () => {
        pointerEvents.push('click');
        remote.setAttribute('aria-selected', 'true');
      });
      const current = session({
        forwardWriteMode: 'FILL_ONLY',
        authorizeLeafWrite: async () => true,
      });
      const run = bindComboboxFillOnly(current, live, 'Remote');

      try {
        const result = await current.writer.execute(run.writerInput);

        expect(submitted).toBe(true);
        expect(pointerEvents).toEqual(
          armAfter === 'mousedown' ? ['mousedown'] : ['mousedown', 'mouseup'],
        );
        expect(remote.getAttribute('aria-selected')).toBe('false');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('EXPECTED_LEDGER');
        expect(result.value.dispositions.find(
          (entry) => entry.questionId === run.questionId,
        )?.disposition).toMatchObject({
          state: 'POLICY_BLOCKED',
          writeEffect: 'MAY_HAVE_CHANGED',
        });
      } finally {
        current.dispose();
      }
    },
  );

  it.each([
    { scenario: 'selected mismatch', first: 'false', second: 'true', hidden: false },
    { scenario: 'missing semantic state', first: null, second: 'false', hidden: false },
    { scenario: 'hidden membership', first: 'false', second: 'false', hidden: true },
  ] as const)('does not click an expanded combobox with $scenario', async ({ first, second, hidden }) => {
    const selected = (value: 'true' | 'false' | null) =>
      value === null ? '' : ` aria-selected="${value}"`;
    const live = await observe(`<form><label for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      <ul id="locations" role="listbox">
        <li id="remote" role="option"${selected(first)}>Remote</li>
        <li id="onsite" role="option"${selected(second)}${hidden ? ' hidden' : ''}>On site</li>
      </ul></form>`, hidden ? 3 : 1);
    const events: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, () => events.push(type));
    }
    const authorizeLeafWrite = vi.fn(async () => true);
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite });
    const run = bindComboboxFillOnly(current, live, 'Remote');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
      .toMatchObject({ state: 'POLICY_BLOCKED' });
    expect(events).toEqual([]);
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    expect(document.querySelector('#remote')!.getAttribute('aria-selected')).toBe(first);
    expect(document.querySelector('#onsite')!.getAttribute('aria-selected')).toBe(second);
    current.dispose();
  });

  it('preserves typed combobox text and does not request leaf authority', async () => {
    const live = await observe(`<form><label for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      <ul id="locations" role="listbox">
        <li id="remote" role="option" aria-selected="false">Remote</li>
        <li id="onsite" role="option" aria-selected="false">On site</li>
      </ul></form>`, 1);
    const trigger = document.querySelector<HTMLInputElement>('#location')!;
    trigger.value = 'User-entered location';
    const events: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, () => events.push(type));
    }
    const authorizeLeafWrite = vi.fn(async () => true);
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite });
    const run = bindComboboxFillOnly(current, live, 'Remote');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
      .toMatchObject({ state: 'POLICY_BLOCKED' });
    expect(trigger.value).toBe('User-entered location');
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    current.dispose();
  });

  it('treats an exact already-selected combobox option as read-only PREFILLED', async () => {
    const live = await observe(`<form><label for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      <ul id="locations" role="listbox"><li role="option" aria-selected="true">Remote</li>
        <li role="option" aria-selected="false">On site</li></ul></form>`, 1);
    const dispatch = vi.spyOn(EventTarget.prototype, 'dispatchEvent');
    const authorizeLeafWrite = vi.fn(async () => true);
    let sameLiveAtTerminal = false;
    let registryCurrentAtTerminal: boolean | null = null;
    let terminalLedger: ReturnType<typeof readPilotUa4TerminalLedger> = null;
    const onTerminalLedger = vi.fn<NonNullable<PilotUa5LiveContentSessionInput['onTerminalLedger']>>((observed, result) => {
      sameLiveAtTerminal = observed === live;
      registryCurrentAtTerminal = observed.registry.isCurrent();
      terminalLedger = readPilotUa4TerminalLedger(result);
      // Positive hook control only; a full S7 checkpoint also needs its source/controller.
      return sameLiveAtTerminal && registryCurrentAtTerminal && terminalLedger !== null;
    });
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite, onTerminalLedger });
    const run = bindComboboxFillOnly(current, live, 'Remote');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
      .toEqual({ state: 'PREFILLED', semanticReadback: 'CURRENT' });
    const terminal = readPilotUa4TerminalLedger(result);
    expect(terminal).toBe(result.value);
    expect(terminal?.questions).toEqual([{ questionId: run.questionId, required: false }]);
    expect(terminal?.dispositions).toHaveLength(1);
    expect(terminal?.summary).toMatchObject({ observableQuestions: 1, terminalQuestions: 1 });
    expect(onTerminalLedger).toHaveBeenCalledOnce();
    expect(sameLiveAtTerminal).toBe(true);
    expect(terminalLedger).toBe(result.value);
    expect(registryCurrentAtTerminal).toBe(true);
    expect(current.didCaptureTerminal()).toBe(true);
    expect(live.registry.isCurrent()).toBe(false);
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    current.dispose();
  });

  it.each(['late-drift', 'submit'] as const)(
    'preserves the host state and reports MAY_HAVE_CHANGED after combobox %s', async (scenario) => {
      const live = await observe(`<form><label for="location">Work location</label>
        <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
        <ul id="locations" role="listbox"><li id="remote" role="option" aria-selected="false">Remote</li>
          <li id="onsite" role="option" aria-selected="false">On site</li></ul></form>`, 1);
      const remote = document.querySelector<HTMLElement>('#remote')!;
      const onsite = document.querySelector<HTMLElement>('#onsite')!;
      const form = document.querySelector<HTMLFormElement>('form')!;
      let submitEvents = 0;
      form.addEventListener('submit', (event) => { submitEvents += 1; event.preventDefault(); });
      remote.addEventListener('click', () => {
        remote.setAttribute('aria-selected', 'true');
        if (scenario === 'submit') {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      });
      const current = session({
        forwardWriteMode: 'FILL_ONLY',
        authorizeLeafWrite: async () => true,
        lateRecheckDelay: async () => {
          if (scenario === 'late-drift') {
            remote.setAttribute('aria-selected', 'false');
            onsite.setAttribute('aria-selected', 'true');
          }
        },
      });
      const run = bindComboboxFillOnly(current, live, 'Remote');

      const result = await current.writer.execute(run.writerInput);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('EXPECTED_LEDGER');
      expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
        .toMatchObject({ state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' });
      expect(submitEvents).toBe(scenario === 'submit' ? 1 : 0);
      expect([remote, onsite].map((option) => option.getAttribute('aria-selected')))
        .toEqual(scenario === 'late-drift' ? ['false', 'true'] : ['true', 'false']);
      expect(current.takeUndo(run.questionId)).toBeNull();
      current.dispose();
    },
  );

  it('runs the static deny list before a reviewed option pointer sequence', async () => {
    const live = await observe(`<form><label for="location">Work location</label>
      <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
      <ul id="locations" role="listbox"><li id="danger" role="option"
        aria-selected="false">Submit application</li></ul></form>`, 1);
    const danger = document.querySelector<HTMLElement>('#danger')!;
    const events: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      danger.addEventListener(type, () => events.push(type));
    }
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true });
    const run = bindComboboxFillOnly(current, live, 'Submit application');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
      .toMatchObject({ state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' });
    expect(events).toEqual([]);
    expect(danger.getAttribute('aria-selected')).toBe('false');
    current.dispose();
  });

  it.each([
    {
      kind: 'select',
      markup: '<form><label for="country">Country</label><select id="country">' +
        '<option value="" selected>Choose</option><option value="US">United States</option>' +
        '<option value="CA">Canada</option></select></form>',
      controls: 1,
      value: 'US',
      selected: () => (document.querySelector<HTMLSelectElement>('#country')?.value ?? null) === 'US',
    },
    {
      kind: 'radio',
      markup: '<form><fieldset><legend>Country</legend>' +
        '<label><input type="radio" name="country">United States</label>' +
        '<label><input type="radio" name="country">Canada</label>' +
        '</fieldset></form>',
      controls: 2,
      value: 'United States',
      selected: () => [...document.querySelectorAll<HTMLInputElement>('input')]
        .map((input) => input.checked).join(',') === 'true,false',
    },
    {
      kind: 'checkbox',
      markup: '<form><label><input id="portfolio" type="checkbox" name="portfolio">Include portfolio</label></form>',
      controls: 1,
      value: 'true',
      selected: () => document.querySelector<HTMLInputElement>('#portfolio')?.checked === true,
    },
  ] as const)('writes one empty native $kind through the real session resolver', async ({ kind, markup, controls, value, selected }) => {
    const live = await observe(markup, controls);
    // happy-dom's HTML parser can leave selectedIndex=-1 while the selected
    // option getter says true. Real browsers expose one coherent native state.
    if (kind === 'select') document.querySelector<HTMLSelectElement>('select')!.selectedIndex = 0;
    const form = document.querySelector<HTMLFormElement>('form')!;
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true });
    const run = bindFillOnly(current, live, value);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      questionId: run.questionId,
      disposition: {
        state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'FROZEN',
      },
    }] } });
    expect(selected()).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    expect(selected()).toBe(true);
  });

  it.each([
    {
      kind: 'select',
      markup: '<form><label for="country">Country</label><select id="country">' +
        '<option value="">Choose</option><option value="US">United States</option>' +
        '<option value="CA">Canada</option></select></form>',
      controls: 1,
      value: 'US',
      makeNonempty: () => { document.querySelector<HTMLSelectElement>('#country')!.selectedIndex = 2; },
      unchanged: () => document.querySelector<HTMLSelectElement>('#country')!.value === 'CA',
    },
    {
      kind: 'radio',
      markup: '<form><fieldset><legend>Country</legend>' +
        '<label><input type="radio" name="country">United States</label>' +
        '<label><input type="radio" name="country">Canada</label>' +
        '</fieldset></form>',
      controls: 2,
      value: 'United States',
      makeNonempty: () => { document.querySelectorAll<HTMLInputElement>('input')[1]!.checked = true; },
      unchanged: () => [...document.querySelectorAll<HTMLInputElement>('input')]
        .map((target) => target.checked).join(',') === 'false,true',
    },
    {
      kind: 'checkbox',
      markup: '<form><label><input id="portfolio" type="checkbox" name="portfolio">Include portfolio</label></form>',
      controls: 1,
      value: 'false',
      makeNonempty: () => { document.querySelector<HTMLInputElement>('#portfolio')!.checked = true; },
      unchanged: () => document.querySelector<HTMLInputElement>('#portfolio')!.checked,
    },
  ] as const)('preserves a nonempty native $kind instead of replacing it', async ({ markup, controls, value, makeNonempty, unchanged }) => {
    const live = await observe(markup, controls);
    makeNonempty();
    const form = document.querySelector<HTMLFormElement>('form')!;
    const events: string[] = [];
    form.addEventListener('input', () => events.push('input'));
    form.addEventListener('change', () => events.push('change'));
    const authorizeLeafWrite = vi.fn(async () => true);
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite });
    const run = bindFillOnly(current, live, value);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    expect(unchanged()).toBe(true);
    expect(events).toEqual([]);
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
    current.dispose();
    expect(unchanged()).toBe(true);
  });

  it.each([
    {
      kind: 'select',
      markup: '<form><label for="country">Country</label><select id="country">' +
        '<option value="">Choose</option><option value="US">United States</option>' +
        '<option value="CA">Canada</option></select></form>',
      controls: 1,
      value: 'US',
      prepare: () => { document.querySelector<HTMLSelectElement>('#country')!.selectedIndex = 0; },
      written: () => document.querySelector<HTMLSelectElement>('#country')!.value === 'US',
    },
    {
      kind: 'radio',
      markup: '<form><fieldset><legend>Country</legend>' +
        '<label><input type="radio" name="country">United States</label>' +
        '<label><input type="radio" name="country">Canada</label>' +
        '</fieldset></form>',
      controls: 2,
      value: 'United States',
      prepare: () => undefined,
      written: () => [...document.querySelectorAll<HTMLInputElement>('input')]
        .map((target) => target.checked).join(',') === 'true,false',
    },
    {
      kind: 'checkbox',
      markup: '<form><label><input id="portfolio" type="checkbox" name="portfolio">Include portfolio</label></form>',
      controls: 1,
      value: 'true',
      prepare: () => undefined,
      written: () => document.querySelector<HTMLInputElement>('#portfolio')!.checked,
    },
  ] as const)('keeps the written native $kind on host rejection and reports MAY_HAVE_CHANGED', async ({ markup, controls, value, prepare, written }) => {
    const live = await observe(markup, controls);
    prepare();
    const form = document.querySelector<HTMLFormElement>('form')!;
    const events: string[] = [];
    form.addEventListener('input', () => events.push('input'));
    form.addEventListener('change', () => events.push('change'));
    const current = session({
      forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      readHostValidation: () => ({ ariaInvalid: 'true' }),
    });
    const run = bindFillOnly(current, live, value);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: {
        state: 'POLICY_BLOCKED',
        reason: 'HOST_REJECTED',
        writeEffect: 'MAY_HAVE_CHANGED',
      },
    }] } });
    expect(written()).toBe(true);
    expect(events).toEqual(['input', 'change']);
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    expect(written()).toBe(true);
  });

  it('validates the selected radio member and preserves its rejected host state', async () => {
    const live = await observe('<form><fieldset><legend>Country</legend>' +
      '<label><input type="radio" name="country">United States</label>' +
      '<label><input type="radio" name="country">Canada</label>' +
      '</fieldset></form>', 2);
    const radios = [...document.querySelectorAll<HTMLInputElement>('input')];
    radios[1]!.addEventListener('change', () => {
      radios[1]!.setCustomValidity('Synthetic host rejection');
    });
    const current = session({
      forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      readHostValidation: undefined,
    });
    const run = bindFillOnly(current, live, 'Canada');

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId)?.disposition)
      .toMatchObject({
        state: 'POLICY_BLOCKED',
        reason: 'HOST_REJECTED',
        writeEffect: 'MAY_HAVE_CHANGED',
      });
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    expect(radios.map((radio) => radio.validity.valid)).toEqual([true, false]);
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
  });

  it('retains post-write evidence when native select listener cleanup throws', async () => {
    const live = await observe('<form><label for="country">Country</label><select id="country">' +
      '<option value="">Choose</option><option value="US">United States</option></select></form>');
    const target = document.querySelector<HTMLSelectElement>('#country')!;
    target.selectedIndex = 0;
    const current = session({
      forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      readHostValidation: () => ({ ariaInvalid: 'true' }),
    });
    const run = bindFillOnly(current, live, 'US');
    const remove = vi.spyOn(target, 'removeEventListener').mockImplementation(() => {
      throw new Error('SYNTHETIC_REMOVE_FAILURE');
    });

    const result = await current.writer.execute(run.writerInput);

    expect(target.value).toBe('US');
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      questionId: run.questionId,
      disposition: {
        state: 'POLICY_BLOCKED',
        reason: 'HOST_REJECTED',
        writeEffect: 'MAY_HAVE_CHANGED',
      },
    }] } });
    expect(current.takeUndo(run.questionId)).toBeNull();
    remove.mockRestore();
    current.dispose();
    expect(target.value).toBe('US');
  });

  it.each([
    {
      kind: 'select',
      markup: '<form><label for="country">Country</label><select id="country">' +
        '<option value="">Choose</option><option value="US">United States</option>' +
        '<option value="CA">Canada</option></select></form>',
      controls: 1,
      value: 'US',
      prepare: () => { document.querySelector<HTMLSelectElement>('#country')!.selectedIndex = 0; },
      drift: () => { document.querySelector<HTMLSelectElement>('#country')!.selectedIndex = 2; },
      drifted: () => document.querySelector<HTMLSelectElement>('#country')!.value === 'CA',
    },
    {
      kind: 'radio',
      markup: '<form><fieldset><legend>Country</legend>' +
        '<label><input type="radio" name="country">United States</label>' +
        '<label><input type="radio" name="country">Canada</label>' +
        '</fieldset></form>',
      controls: 2,
      value: 'United States',
      prepare: () => undefined,
      drift: () => { document.querySelectorAll<HTMLInputElement>('input')[1]!.checked = true; },
      drifted: () => [...document.querySelectorAll<HTMLInputElement>('input')]
        .map((target) => target.checked).join(',') === 'false,true',
    },
    {
      kind: 'checkbox',
      markup: '<form><label><input id="portfolio" type="checkbox" name="portfolio">Include portfolio</label></form>',
      controls: 1,
      value: 'true',
      prepare: () => undefined,
      drift: () => { document.querySelector<HTMLInputElement>('#portfolio')!.checked = false; },
      drifted: () => document.querySelector<HTMLInputElement>('#portfolio')!.checked === false,
    },
  ] as const)('preserves late native $kind drift without background restoration', async ({ markup, controls, value, prepare, drift, drifted }) => {
    const live = await observe(markup, controls);
    prepare();
    const current = session({
      forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      lateRecheckDelay: async () => { drift(); },
    });
    const run = bindFillOnly(current, live, value);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: {
        state: 'POLICY_BLOCKED',
        reason: 'LATE_REVERTED',
        writeEffect: 'MAY_HAVE_CHANGED',
      },
    }] } });
    expect(drifted()).toBe(true);
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    expect(drifted()).toBe(true);
  });

  it.each([
    {
      kind: 'select',
      markup: '<form><label for="country">Country</label><select id="country">' +
        '<option value="">Choose</option><option value="US">United States</option></select></form>',
      controls: 1,
      value: 'US',
      prepare: () => { document.querySelector<HTMLSelectElement>('select')!.selectedIndex = 0; },
      written: () => document.querySelector<HTMLSelectElement>('select')!.value === 'US',
    },
    {
      kind: 'radio',
      markup: '<form><fieldset><legend>Country</legend>' +
        '<label><input type="radio" name="country">United States</label>' +
        '<label><input type="radio" name="country">Canada</label>' +
        '</fieldset></form>',
      controls: 2,
      value: 'United States',
      prepare: () => undefined,
      written: () => [...document.querySelectorAll<HTMLInputElement>('input')]
        .map((target) => target.checked).join(',') === 'true,false',
    },
  ] as const)('stops native $kind events after input synchronously submits', async ({
    markup, controls, value, prepare, written,
  }) => {
    const live = await observe(markup, controls);
    prepare();
    const form = document.querySelector<HTMLFormElement>('form')!;
    const events: string[] = [];
    let submitEvents = 0;
    form.addEventListener('submit', (event) => { submitEvents += 1; event.preventDefault(); });
    form.addEventListener('input', () => {
      events.push('input');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    form.addEventListener('change', () => events.push('change'));
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true });
    const run = bindFillOnly(current, live, value);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' },
    }] } });
    expect(submitEvents).toBe(1);
    expect(events).toEqual(['input']);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(written()).toBe(true);
    current.dispose();
  });
});


describe('fill-first native date session', () => {
  it.each([
    ['date', '2028-02-29'],
    ['month', '2028-02'],
  ] as const)('writes one empty native %s through UA-1, compiler, authority, and session', async (kind, expected) => {
    const live = await observe(`<form><label for="start">Start date</label>
      <input id="start" type="${kind}"></form>`);
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const form = target.form!;
    const events: string[] = [];
    for (const type of ['beforeinput', 'input', 'change', 'click', 'submit']) {
      form.addEventListener(type, () => events.push(type));
    }
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    let capturedBeforeCleanup = false;
    const onTerminalLedger = vi.fn<NonNullable<PilotUa5LiveContentSessionInput['onTerminalLedger']>>((observed, result) => {
      capturedBeforeCleanup = observed === live && observed.registry.isCurrent() &&
        readPilotUa4TerminalLedger(result) !== null;
      return true;
    });
    const current = session({
      forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true, onTerminalLedger,
    });
    const run = bindFillOnly(current, live, expected);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      questionId: run.questionId,
      disposition: {
        state: 'FILLED', semanticReadback: 'HOST_ACCEPTED',
        lateRecheck: 'STABLE', undo: 'FROZEN',
      },
    }] } });
    expect(target.value).toBe(expected);
    expect(events).toEqual(['input', 'change']);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(onTerminalLedger).toHaveBeenCalledOnce();
    expect(capturedBeforeCleanup).toBe(true);
    expect(current.didCaptureTerminal()).toBe(true);
    expect(live.registry.isCurrent()).toBe(false);
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    expect(target.value).toBe(expected);
  });

  it('treats an exact native date as read-only PREFILLED', async () => {
    const expected = '2028-02-29';
    const live = await observe(`<form><label for="start">Start date</label>
      <input id="start" type="date" value="${expected}"></form>`);
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const authorizeLeafWrite = vi.fn(async () => true);
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite });
    const run = bindFillOnly(current, live, expected);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'PREFILLED', semanticReadback: 'CURRENT' },
    }] } });
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe(expected);
    current.dispose();
  });

  it('makes zero date writes when the final registry proof synchronously submits', async () => {
    const original = await observe('<form><label for="start">Start date</label>' +
      '<input id="start" type="date"></form>');
    const target = document.querySelector<HTMLInputElement>('#start')!;
    let authorized = false;
    let resolutionsAfterAuthorization = 0;
    let submitted = false;
    const live: PilotUa1LiveObservation = Object.freeze({
      ...original,
      registry: Object.freeze({
        ...original.registry,
        resolveForWrite: (identity: Parameters<typeof original.registry.resolveForWrite>[0]) => {
          const resolved = original.registry.resolveForWrite(identity);
          if (authorized && ++resolutionsAfterAuthorization === 2) {
            submitted = true;
            target.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
          return resolved;
        },
      }),
    });
    const current = session({
      forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      isProfileCurrent: async () => { authorized = true; return true; },
    });
    const run = bindFillOnly(current, live, '2028-02-29');
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

    const result = await current.writer.execute(run.writerInput);

    expect(submitted).toBe(true);
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      questionId: run.questionId,
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it.each([
    { scenario: 'different nonempty value', currentValue: '2028-03-01', expected: '2028-02-29' },
    { scenario: 'invalid calendar payload', currentValue: '', expected: '2027-02-29' },
    { scenario: 'unsupported native kind', currentValue: '', expected: '2028-W05', kind: 'week' },
  ] as const)('preserves the host and performs no write for $scenario', async ({ currentValue, expected, kind = 'date' }) => {
    const live = await observe(`<form><label for="start">Start date</label>
      <input id="start" type="${kind}" value="${currentValue}"></form>`);
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const authorizeLeafWrite = vi.fn(async () => true);
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite });
    const run = bindFillOnly(current, live, expected);

    const result = await current.writer.execute(run.writerInput);

    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe(currentValue);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
    current.dispose();
  });

  it.each(['late-drift', 'host-rejected', 'submit'] as const)(
    'preserves native date state and reports MAY_HAVE_CHANGED after %s', async (scenario) => {
      const live = await observe('<form><label for="start">Start date</label>' +
        '<input id="start" type="date"></form>');
      const target = document.querySelector<HTMLInputElement>('#start')!;
      const form = target.form!;
      const events: string[] = [];
      form.addEventListener('input', () => {
        events.push('input');
        if (scenario === 'submit') {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      });
      form.addEventListener('change', () => events.push('change'));
      form.addEventListener('submit', (event) => { events.push('submit'); event.preventDefault(); });
      const current = session({
        forwardWriteMode: 'FILL_ONLY',
        authorizeLeafWrite: async () => true,
        readHostValidation: () => ({
          ariaInvalid: scenario === 'host-rejected' ? 'true' : 'false',
        }),
        lateRecheckDelay: async () => {
          if (scenario === 'late-drift') target.value = '2029-01-01';
        },
      });
      const run = bindFillOnly(current, live, '2028-02-29');

      const result = await current.writer.execute(run.writerInput);

      expect(result).toMatchObject({ ok: true, value: { dispositions: [{
        disposition: { state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' },
      }] } });
      expect(target.value).toBe(scenario === 'late-drift' ? '2029-01-01' : '2028-02-29');
      expect(events).toEqual(scenario === 'submit' ? ['input', 'submit'] : ['input', 'change']);
      expect(current.takeUndo(run.questionId)).toBeNull();
      current.dispose();
    },
  );
});


describe('source-gated file and repeated-row boundaries', () => {
  it('cannot turn a scalar payload into a file, file chooser, or resume attachment', async () => {
    const live = await observe('<form><label for="resume">Upload resume</label>' +
      '<input id="resume" type="file" accept=".pdf,.doc,.docx"></form>');
    const target = document.querySelector<HTMLInputElement>('#resume')!;
    const authorizeLeafWrite = vi.fn(async () => true);
    const setFiles = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const events: string[] = [];
    for (const type of ['input', 'change', 'click']) {
      target.addEventListener(type, () => events.push(type));
    }
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite });
    const run = bindFillOnly(current, live, 'resume.pdf');
    Object.assign(run.writerInput, {
      ua2Classifications: live.observation.packet.controls.map((control) => ({
        identityDigest: control.identityDigest,
        kind: 'STRUCTURED_FILE' as const,
        canonicalField: null,
        confidence: 'HIGH' as const,
        provenance: {
          source: 'CONTROL_SEMANTICS' as const,
          semanticDigest: '77'.repeat(32),
        },
        reasonCode: 'STRUCTURED_FILE_CONTROL' as const,
      })),
    });

    const result = await current.writer.execute(run.writerInput);

    expect(result, `file boundary: ${JSON.stringify(result)}`).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    expect(authorizeLeafWrite).not.toHaveBeenCalled();
    expect(setFiles).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(target.files).toHaveLength(0);
    expect(target.value).toBe('');
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
    current.dispose();
  });

  it('fills only one exact existing repeated-row leaf and never activates Add row', async () => {
    const live = await observe(`<form><section id="experience-list">
      <div class="row"><label for="company-0">Company</label><input id="company-0"></div>
      <div class="row"><label for="company-1">Company</label><input id="company-1"></div>
      <button id="add-row" type="button">Add another employer</button>
    </section></form>`, 3);
    const rows = live.observation.structure!.entries.filter((entry) => entry.row !== null);
    expect(rows).toHaveLength(2);
    const first = document.querySelector<HTMLInputElement>('#company-0')!;
    const second = document.querySelector<HTMLInputElement>('#company-1')!;
    const add = document.querySelector<HTMLButtonElement>('#add-row')!;
    const addEvents: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      add.addEventListener(type, () => addEvents.push(type));
    }
    const nativeClick = vi.spyOn(HTMLElement.prototype, 'click');
    const current = session({
      forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true,
    });
    const run = bindFillOnly(current, live, 'Acme');
    const allControlIds = live.observation.packet.controls.map(
      (control) => control.identityDigest,
    );
    run.writerInput.authority = {
      ...run.writerInput.authority,
      observedControlIdentityDigests: allControlIds,
      blockedQuestions: run.questions
        .filter((question) => question.id !== run.questionId)
        .map((question) => ({
          questionId: question.id,
          controlKind: writerKind(question.control.kind)!,
          identityDigests: question.control.members.map((member) => member.identityDigest),
          required: question.required,
          code: 'ANSWER_AUTHORITY_NOT_RESOLVED' as const,
        })),
    };
    run.writerInput.currentControlIdentityDigests = allControlIds;
    Object.assign(run.writerInput, {
      ua2Classifications: live.observation.packet.controls.map((control) =>
        control.inputType === 'button'
          ? {
              identityDigest: control.identityDigest,
              kind: 'HUMAN_ACTION_REQUIRED' as const,
              canonicalField: null,
              confidence: 'HIGH' as const,
              provenance: {
                source: 'CONTROL_SEMANTICS' as const,
                semanticDigest: '77'.repeat(32),
              },
              reasonCode: 'HUMAN_ACTION_CONTROL' as const,
            }
          : {
              identityDigest: control.identityDigest,
              kind: 'CANONICAL_FIELD' as const,
              canonicalField: 'ORGANIZATION' as const,
              confidence: 'HIGH' as const,
              provenance: {
                source: 'BACKEND_TEXT_CLASSIFIER' as const,
                semanticDigest: '77'.repeat(32),
              },
              reasonCode: 'CANONICAL_SEMANTIC_MATCH' as const,
            }),
    });

    const result = await current.writer.execute(run.writerInput);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions.find((entry) => entry.questionId === run.questionId))
      .toEqual({
        questionId: run.questionId,
        disposition: {
          state: 'FILLED', semanticReadback: 'HOST_ACCEPTED',
          lateRecheck: 'STABLE', undo: 'FROZEN',
        },
      });
    expect(first.value).toBe('Acme');
    expect(second.value).toBe('');
    expect(addEvents).toEqual([]);
    expect(nativeClick).not.toHaveBeenCalled();
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });
});


describe('fill-first session with frozen Undo', () => {
  it.each(['abort', 'submit', 'navigation', 'edit', 'value-only', 'detach'] as const)(
    'downgrades success after final listener cleanup: %s', async (scenario) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true });
    const run = bind(current, live);
    run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    let triggered = false;
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const remove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'removeEventListener').mockImplementation((...args: Parameters<Document['removeEventListener']>) => {
      if (args[0] === 'beforeinput' && !triggered) {
        triggered = true;
        if (scenario === 'abort') current.abort();
        else if (scenario === 'submit') target.form!.dispatchEvent(new Event('submit', { bubbles: true }));
        else if (scenario === 'navigation') window.dispatchEvent(new Event('pagehide'));
        else if (scenario === 'detach') target.remove();
        else {
          nativeSet.call(target, 'person correction');
          if (scenario === 'edit') target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return remove(...args);
    });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const result = await current.writer.execute(run.writerInput);
    expect(triggered).toBe(true);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(target.value).toBe(['edit', 'value-only'].includes(scenario) ? 'person correction' : 'alex@example.test');
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' },
    }] } });
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it.each(['submit', 'navigation', 'edit'] as const)(
    'retains event coverage after the last external listener removal: %s', async (scenario) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true });
    const run = bind(current, live);
    run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    let triggered = false;
    const remove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'removeEventListener').mockImplementation((...args: Parameters<Document['removeEventListener']>) => {
      const removed = remove(...args);
      if (args[0] === 'submit' && !triggered) {
        triggered = true;
        if (scenario === 'submit') target.form!.dispatchEvent(new Event('submit', { bubbles: true }));
        else if (scenario === 'navigation') window.dispatchEvent(new Event('pagehide'));
        else {
          if (scenario === 'edit') target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return removed;
    });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const result = await current.writer.execute(run.writerInput);
    expect(triggered).toBe(true);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(target.value).toBe('alex@example.test');
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' },
    }] } });
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it.each([
    { timing: 'before', canWrite: true },
    { timing: 'after', canWrite: true },
    { timing: 'before', canWrite: false },
  ] as const)('retires old edit handlers when cleanup throws $timing removal (write=$canWrite)', async ({ timing, canWrite }) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const current = session({ forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => canWrite });
    const run = bind(current, live);
    run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    const nativeAdd = document.addEventListener.bind(document);
    const nativeRemove = document.removeEventListener.bind(document);
    const added: EventListenerOrEventListenerObject[] = [];
    vi.spyOn(document, 'addEventListener').mockImplementation((...args: Parameters<Document['addEventListener']>) => {
      if (args[0] === 'input') added.push(args[1]);
      nativeAdd(...args);
    });
    const remove = vi.spyOn(document, 'removeEventListener').mockImplementation((...args: Parameters<Document['removeEventListener']>) => {
      if (args[0] === 'input' && timing === 'before') throw new Error('SYNTHETIC_CLEANUP_FAILURE');
      nativeRemove(...args);
      if (args[0] === 'input') throw new Error('SYNTHETIC_CLEANUP_FAILURE');
    });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    try {
      const result = await current.writer.execute(run.writerInput);
      current.dispose();
      current.dispose();
      expect(result).toMatchObject({ ok: true, value: { dispositions: [{ disposition: { state: 'POLICY_BLOCKED' } }] } });
      if (!result.ok) throw new Error('EXPECTED_LEDGER');
      if (canWrite) expect(result.value.dispositions[0]!.disposition)
        .toMatchObject({ reason: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' });
      else expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
      expect(setter).toHaveBeenCalledTimes(canWrite ? 1 : 0);
      expect(target.value).toBe(canWrite ? 'alex@example.test' : '');
      expect(remove.mock.calls.filter(([type]) => type === 'input')).toHaveLength(1);
      let targetReads = 0;
      const event = new Event('input', { bubbles: true });
      Object.defineProperty(event, 'target', { get: () => { targetReads++; return target; } });
      document.dispatchEvent(event);
      expect(targetReads).toBe(0);
    } finally {
      // Keep the intentionally red baseline from leaking a handler into later tests.
      for (const listener of added) nativeRemove('input', listener, true);
    }
  });

  it.each(['success', 'pre-write-abort', 'cleanup-throw'] as const)(
    'attempts each of the seven listener removals once after %s', async (scenario) => {
    const live = await observe();
    let authorized = false;
    let current: ReturnType<typeof session>;
    current = session({
      forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true,
      isProfileCurrent: async () => { authorized = true; return true; },
      now: () => { if (authorized && scenario === 'pre-write-abort') current.abort(); return NOW; },
    });
    const run = bind(current, live);
    run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    const addDocument = vi.spyOn(document, 'addEventListener');
    const addWindow = vi.spyOn(window, 'addEventListener');
    const nativeRemove = document.removeEventListener.bind(document);
    const removeDocument = vi.spyOn(document, 'removeEventListener').mockImplementation((...args: Parameters<Document['removeEventListener']>) => {
      nativeRemove(...args);
      if (scenario === 'cleanup-throw' && args[0] === 'beforeinput') throw new Error('SYNTHETIC_CLEANUP_FAILURE');
    });
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const result = await current.writer.execute(run.writerInput);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    if (scenario === 'success') expect(result.value.dispositions[0]!.disposition.state).toBe('FILLED');
    else if (scenario === 'cleanup-throw') expect(result.value.dispositions[0]!.disposition)
      .toMatchObject({ state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' });
    else expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
    current.dispose();
    current.dispose();
    const addedDocument = addDocument.mock.calls.filter(([type]) => ['beforeinput', 'input', 'change', 'submit'].includes(type));
    const addedWindow = addWindow.mock.calls.filter(([type]) => ['pagehide', 'popstate', 'hashchange'].includes(type));
    expect(addedDocument).toHaveLength(4);
    expect(addedWindow).toHaveLength(3);
    expect(removeDocument.mock.calls.filter(([type]) => ['beforeinput', 'input', 'change', 'submit'].includes(type)))
      .toEqual(addedDocument);
    expect(removeWindow.mock.calls.filter((call) => addedWindow.some((added) => added[1] === call[1])))
      .toEqual(addedWindow);
  });

  it.each(['abort', 'submit', 'navigation', 'edit'] as const)(
    'retains revocation listeners through the last retired clock callback: %s', async (scenario) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    let retired = false;
    let clockCalls = 0;
    let triggered = false;
    const current = session({
      forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true,
      now: () => {
        if (retired && ++clockCalls === 2) {
          triggered = true;
          if (scenario === 'abort') current.abort();
          else if (scenario === 'submit') target.form!.dispatchEvent(new Event('submit', { bubbles: true }));
          else if (scenario === 'navigation') window.dispatchEvent(new Event('pagehide'));
          else target.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return NOW;
      },
    });
    const run = bind(current, live);
    run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    const disconnect = MutationObserver.prototype.disconnect;
    vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementation(function (this: MutationObserver) {
      disconnect.call(this);
      retired = true;
    });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const result = await current.writer.execute(run.writerInput);
    expect(triggered).toBe(true);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' },
    }] } });
    expect(target.value).toBe('alex@example.test');
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it.each(['abort', 'submit', 'navigation', 'edit'] as const)(
    'does not write when the final clock callback synchronously triggers %s', async (scenario) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    let authorized = false;
    let current: ReturnType<typeof session>;
    current = session({
      forwardWriteMode: 'FILL_ONLY', authorizeLeafWrite: async () => true,
      isProfileCurrent: async () => { authorized = true; return true; },
      now: () => {
        if (authorized) {
          if (scenario === 'abort') current.abort();
          else if (scenario === 'submit') target.form!.dispatchEvent(new Event('submit', { bubbles: true }));
          else if (scenario === 'navigation') window.dispatchEvent(new Event('pagehide'));
          else target.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return NOW;
      },
    });
    const run = bind(current, live);
    run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const result = await current.writer.execute(run.writerInput);
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
    expect(result).toMatchObject({ ok: true, value: { dispositions: [{
      disposition: { state: 'POLICY_BLOCKED' },
    }] } });
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    expect(result.value.dispositions[0]!.disposition).not.toHaveProperty('writeEffect');
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
  });

  it.each(['success', 'host-rejected', 'missing-profile', 'profile-false', 'late-edit', 'required-policy'] as const)(
    'keeps the narrow gates and truthful result: %s', async (scenario) => {
    const live = await observe();
    const target = document.querySelector<HTMLInputElement>('#email')!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const current = createPilotUa5LiveContentSession({
      enabled: true, document, view: window, location, now: () => NOW,
      writeNotAfterMs: NOW + 10_000, forwardWriteMode: 'FILL_ONLY',
      authorizeLeafWrite: async () => true,
      isProfileCurrent: scenario === 'missing-profile' ? undefined : async () => scenario !== 'profile-false',
      lateRecheckMs: 1, settle: async () => {},
      lateRecheckDelay: async () => { if (scenario === 'late-edit') target.value = 'person edit'; },
      readHostValidation: () => ({ ariaInvalid: scenario === 'host-rejected' ? 'true' : 'false' }),
    });
    const run = bind(current, live);
    if (scenario !== 'required-policy') run.writerInput.authority = { ...run.authority, constraints: { ...run.authority.constraints, undo: 'FROZEN' } };
    const result = await current.writer.execute(run.writerInput);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_LEDGER');
    const disposition = result.value.dispositions[0]!.disposition;
    if (scenario === 'success') {
      expect(disposition).toEqual({ state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'FROZEN' });
      expect(target.value).toBe('alex@example.test');
      expect(setter).toHaveBeenCalledTimes(1);
    } else if (scenario === 'host-rejected' || scenario === 'late-edit') {
      expect(disposition).toMatchObject({ state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' });
      expect(target.value).toBe(scenario === 'late-edit' ? 'person edit' : 'alex@example.test');
    } else {
      expect(disposition.state).toBe('POLICY_BLOCKED');
      expect(setter).not.toHaveBeenCalled();
    }
    expect(current.takeUndo(run.questionId)).toBeNull();
    current.dispose();
    if (scenario === 'success' || scenario === 'host-rejected') expect(target.value).toBe('alex@example.test');
  });
});
