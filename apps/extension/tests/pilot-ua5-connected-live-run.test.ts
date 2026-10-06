// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PilotUa5ProfilePayloadResponse } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { derivePilotUa5Questions } from '@edaix/apply-kernel/pilotUa5Composition';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { createPilotUa5ConnectedLiveRun } from '../connected-dev/liveRun';
import type { PilotUa5LiveContentSessionInput } from '../lib/pilotUa5LiveContentSession';
import { pilotUa5SemanticDigest } from '../lib/pilotUa5SemanticDigest';
import { Window as HappyWindow } from 'happy-dom';
import { PILOT_UA5_CONTROLLED_LOCAL_URL } from '../lib/pilotUa5ControlledLocalAdmission';
import { syntheticWizardRuntime } from '../../../e2e/fixtures/t10-wizard-runtime';

const EXTENSION_ID = 'connected-live-test';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const ANSWER_DIGEST = 'a'.repeat(64);
const VALUE = 'ada@example.test';

function positiveRect(): DOMRect {
  return {
    x: 0, y: 0, width: 180, height: 28, top: 0, right: 180, bottom: 28, left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

async function exactUrlDigest(href: string): Promise<string> {
  return createHash('sha256').update(new URL(href).href, 'utf8').digest('hex');
}

function profileResponse(
  request: Parameters<Parameters<ReturnType<typeof createPilotUa5ConnectedLiveRun>>[2]['resolveProfilePayloads']>[0],
  now: number,
): PilotUa5ProfilePayloadResponse {
  const control = request.discovery.controls[0]!;
  const isGivenName = control.autocomplete.includes('given-name');
  const classification = Object.freeze({
    identityDigest: control.identityDigest,
    kind: 'CANONICAL_FIELD' as const,
    canonicalField: isGivenName ? 'NAME_GIVEN' as const : 'EMAIL' as const,
    confidence: 'HIGH' as const,
    provenance: Object.freeze({
      source: 'AUTOCOMPLETE' as const,
      semanticDigest: 'b'.repeat(64),
    }),
    reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH' as const,
  });
  const epochs = [Object.freeze({
    cause: 'USER_TRIGGER' as const,
    binding: request.discovery.binding,
    controls: request.discovery.controls,
    structure: request.structure!,
    suppressedControls: request.discovery.observation.suppressedControls,
    hiddenNotObservedCount: request.discovery.observation.hiddenNotObservedCount,
    attributedAddRowGroup: null,
  })];
  const derived = derivePilotUa5Questions(epochs, [classification], pilotUa5SemanticDigest);
  if (!derived.ok) throw new Error(`fixture compilation failed: ${derived.reason}`);
  const question = derived.questions[0]!;
  const pageIdentityDigest = 'c'.repeat(64);
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    composition: Object.freeze({
      ok: true,
      schemaVersion: 1,
      candidateRule: Object.freeze({
        schemaVersion: 1,
        kind: 'EPHEMERAL_PAGE_CANDIDATE',
        binding: request.discovery.binding,
        pageIdentityDigest,
        issuedAtMs: now,
        expiresAtMs: now + 30_000,
        classifications: Object.freeze([classification]),
        constraints: Object.freeze({
          remoteCode: 'FORBIDDEN',
          automaticPublication: 'FORBIDDEN',
          writerAuthority: 'NOT_GRANTED',
          submit: 'HUMAN_ONLY',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        }),
      }),
      authority: Object.freeze({
        authorityId: 'd'.repeat(64),
        binding: request.discovery.binding,
        pageIdentityDigest,
        observedControlIdentityDigests: Object.freeze([control.identityDigest]),
        expiresAtMs: now + 30_000,
        questionAuthorizations: Object.freeze([Object.freeze({
          questionId: question.questionId,
          controlKind: 'TEXT' as const,
          identityDigests: Object.freeze([control.identityDigest]),
          required: true,
          answerAuthority: 'PROFILE_CONFIRMED' as const,
          answerDigest: ANSWER_DIGEST,
        })]),
        blockedQuestions: Object.freeze([]),
        constraints: Object.freeze({
          exactTargetBinding: 'REQUIRED',
          semanticReadback: 'REQUIRED',
          hostValidation: 'REQUIRED',
          lateRecheck: 'REQUIRED',
          undo: 'FROZEN',
          submit: 'FORBIDDEN',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        }),
      }),
      projection: Object.freeze({
        schemaVersion: 1,
        binding: request.discovery.binding,
        rows: Object.freeze([Object.freeze({
          questionId: question.questionId,
          required: true,
          writerKind: 'TEXT',
          memberCount: 1,
          admission: 'AUTHORIZED' as const,
        })]),
        summary: Object.freeze({
          observableQuestions: 1,
          requiredQuestions: 1,
          authorizedQuestions: 1,
          requiredAuthorizedQuestions: 1,
        }),
      }),
      constraints: Object.freeze({
        submit: 'FORBIDDEN',
        remoteCode: 'FORBIDDEN',
        rawValues: 'NEVER_TRANSMITTED',
        activationState: 'DEFAULT_OFF',
        releaseState: 'NOT_RELEASED',
      }),
    }),
    profileBinding: Object.freeze({
      fieldSchemaVersion: 1,
      fieldKeys: Object.freeze(isGivenName ? ['firstName'] as const : ['email'] as const),
      revision: '1' as never,
      deletionEpoch: '0' as never,
      snapshotDigest: `sha256:${'e'.repeat(64)}` as never,
    }),
    payloads: Object.freeze([Object.freeze({
      questionId: question.questionId,
      payloadRef: 'ua5.profile.email',
      answerDigest: ANSWER_DIGEST,
      value: isGivenName ? 'Ada' : VALUE,
    })]),
    constraints: Object.freeze({
      compositionValueBoundary: 'VALUE_FREE_SUBOBJECT_ONLY',
      payloadWire: 'DEV_ONLY_DATA_L1',
      dataLifetime: 'EPHEMERAL_MEMORY_ONLY',
      panelExposure: 'FORBIDDEN',
      persistence: 'FORBIDDEN',
      logging: 'FORBIDDEN',
    }),
  });
}

beforeEach(() => {
  history.replaceState(null, '', '/acme/jobs/123');
  document.body.innerHTML =
    '<form><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></form>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(positiveRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('uses verified v3 context to retain canonical terminal facts across a read-only next-step scan', async () => {
  const now = Date.now(), source = await syntheticWizardRuntime(now), epoch = {};
  document.body.innerHTML = '<main id="application"><nav id="steps">' + [0, 1, 2].map((i) =>
    `<span id="step-${i}" aria-controls="panel-${i}"${i === 0 ? ' aria-current="step"' : ''}>Step</span>`).join('') +
    '</nav><section id="panel-0"><form><label>Email<input type="email" autocomplete="email" required value="user@example.test"></label></form></section>' +
    '<section id="panel-1" hidden></section><section id="panel-2" hidden></section></main>';
  const request = createPilotUa1DiscoveryRequest({ pageUrl: location.href, requestId: '1'.repeat(32), issuedAtMs: now,
    targetUrlDigest: await exactUrlDigest(location.href) })!;
  const context = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: '2'.repeat(32), requestId: request.requestId,
    expiresAtMs: now + 30_000, authorization: source.authorization } as const;
  const run = createPilotUa5ConnectedLiveRun({ enabled: true, extensionId: EXTENSION_ID, expectedBackgroundUrl: BACKGROUND_URL,
    document, view: window, location, now: () => now, openShadowRoot: (element) => element.shadowRoot,
    wizard: { readStoredRuntimeBundle: async () => source.stored, extensionVersion: () => '0.0.0', readAuthorityEpoch: () => epoch },
    session: { settle: async () => undefined, lateRecheckDelay: async () => undefined } });
  const profile = vi.fn(async (candidate) => profileResponse(candidate, now)), authorize = vi.fn(async () => false as const);
  const controller = new AbortController();
  const result = await run(request, () => {}, { signal: controller.signal, resolveProfilePayloads: profile, authorizeLeafWrite: authorize, wizardContext: context });
  expect(result.ok).toBe(true);
  // The writer has already retired its registry: terminal facts are history.
  expect(run.getWizardProjection(result)).toMatchObject({ scope: 'LOCAL_SESSION', currentStep: null, checkpoints: [{ stepIndex: 0 }] });
  controller.abort(); run.dispose();
  document.getElementById('step-0')!.setAttribute('aria-current', 'false');
  document.getElementById('step-1')!.setAttribute('aria-current', 'step');
  document.getElementById('panel-0')!.setAttribute('hidden', '');
  document.getElementById('panel-1')!.removeAttribute('hidden');
  document.getElementById('panel-1')!.append(document.querySelector('form')!);
  const next = { ...request, requestId: '3'.repeat(32) };
  const scanned = await run.rescanCurrentPage(next, new AbortController().signal, { ...context, requestId: next.requestId });
  expect(scanned).toMatchObject({ ok: true, wizard: { currentStep: { stepIndex: 1 }, checkpoints: [{ stepIndex: 0 }] } });
  expect(profile).toHaveBeenCalledOnce(); expect(authorize).not.toHaveBeenCalled();
  expect(document.querySelector('input')!.value).toBe('user@example.test');
  run.resetWizard(); run.dispose();
});

describe('local admission limits the observed surface before requesting Profile', () => {
  it.each([[true, true], [false, true], [true, false]])('keeps per-leaf P1 and read-only rescan isolated in the local artifact (current=%s, deadline=%s)', async (current, hasDeadline) => {
    const page = window as unknown as HappyWindow;
    const previousHref = page.location.href;
    page.happyDOM.setURL(PILOT_UA5_CONTROLLED_LOCAL_URL);
    page.document.body.innerHTML = '<form><label>First name<input type="text" autocomplete="given-name" required></label></form>';
    vi.spyOn(page.Element.prototype, 'getBoundingClientRect')
      .mockImplementation(() => new page.DOMRect(0, 0, 180, 28));
    const now = Date.now();
    const request = createPilotUa1DiscoveryRequest({
      pageUrl: page.location.href, requestId: '4'.repeat(32), issuedAtMs: now,
      targetUrlDigest: await exactUrlDigest(page.location.href),
    })!;
    const run = createPilotUa5ConnectedLiveRun({
      enabled: true, controlledLocalTextOnly: true,
      // Synthetic writer proof only: the current content entrypoint still omits this input.
      writeNotAfterMs: hasDeadline ? now + 30_000 : undefined,
      extensionId: EXTENSION_ID, expectedBackgroundUrl: BACKGROUND_URL,
      document: page.document as unknown as Document, view: page as unknown as Window,
      location: page.location as unknown as Location, now: () => now,
      openShadowRoot: (element) => element.shadowRoot,
      session: { settle: async () => undefined, lateRecheckDelay: async () => undefined },
    });
    const resolveProfilePayloads = vi.fn(async (candidate) => profileResponse(candidate, now));
    const isProfileCurrent = vi.fn(async () => current);
    const authorizeLeafWrite = vi.fn(async () => ({ allowed: true as const, writeNotAfterMs: now + 30_000 }));
    const target = page.document.querySelector('input')!;
    const submit = vi.spyOn(page.document.querySelector('form')!, 'submit');
    const controller = new AbortController();
    try {
      const result = await run(request, () => {}, {
        signal: controller.signal, resolveProfilePayloads, isProfileCurrent, authorizeLeafWrite,
      });
      const filled = current && hasDeadline;
      expect(result).toMatchObject({ ok: true, projection: { rows: [{ state: filled ? 'FILLED' : 'POLICY_BLOCKED' }] } });
      expect(target.value).toBe(filled ? 'Ada' : '');
      expect(isProfileCurrent).toHaveBeenCalledTimes(hasDeadline ? 1 : 0);
      const authorityCalls = authorizeLeafWrite.mock.calls.length;
      expect(authorityCalls).toBe(hasDeadline ? 1 : 0);
      controller.abort();
      run.dispose(); // The content Continue path performs both before the fresh observation.
      expect(run.getCurrentResult()).toBeNull();
      const second = page.document.createElement('input'); second.type = 'text';
      page.document.querySelector('form')!.append(second);
      const scanned = await run.rescanCurrentPage({ ...request, requestId: '5'.repeat(32) }, new AbortController().signal);
      expect(scanned).toMatchObject({ ok: true, scan: { observedControls: 2, pageIdentity: 'UNVERIFIED' } });
      expect(resolveProfilePayloads).toHaveBeenCalledOnce();
      expect(isProfileCurrent).toHaveBeenCalledTimes(hasDeadline ? 1 : 0);
      expect(authorizeLeafWrite).toHaveBeenCalledTimes(authorityCalls);
      expect(target.value).toBe(filled ? 'Ada' : '');
      expect(second.value).toBe('');
      expect(submit).not.toHaveBeenCalled();
      await expect(run.undoCurrentPage(request.requestId, 'first-name')).resolves.toBe('UNAVAILABLE');
    } finally {
      run.dispose();
      page.happyDOM.setURL(previousHref);
    }
  });

  it.each([
    ['one text', '<label>First name<input type="text" autocomplete="given-name"></label>', true],
    ['two fields', '<input type="text"><input type="text">', false],
    ['textarea', '<label>First name<textarea></textarea></label>', false],
    ['email', '<label>Email<input type="email" autocomplete="email"></label>', false],
    ['hidden', '<label>First name<input type="text" autocomplete="given-name"></label><input type="text" style="display:none">', false],
    ['frame', '<label>First name<input type="text" autocomplete="given-name"></label><iframe></iframe>', false],
    ['submit', '<label>First name<input type="text" autocomplete="given-name"></label><button type="submit">Submit</button>', false],
  ])('admits only the reviewed single native TEXT (%s)', async (_label, fixture, accepted) => {
    const page = new HappyWindow({ url: 'https://127.0.0.1:9443/__edaix_controlled__/p1-native-text' });
    page.document.body.innerHTML = fixture;
    vi.spyOn(page.Element.prototype, 'getBoundingClientRect')
      .mockImplementation(() => new page.DOMRect(0, 0, 180, 28));
    const now = Date.now();
    const request = createPilotUa1DiscoveryRequest({
      pageUrl: page.location.href, requestId: '3'.repeat(32), issuedAtMs: now,
      targetUrlDigest: await exactUrlDigest(page.location.href),
    })!;
    const resolveProfilePayloads = vi.fn(async () => ({
      ok: false as const, schemaVersion: 1 as const, code: 'PILOT_UA5_AUTHORITY_UNAVAILABLE' as const,
    }));
    const run = createPilotUa5ConnectedLiveRun({
      enabled: true, controlledLocalTextOnly: true,
      extensionId: EXTENSION_ID, expectedBackgroundUrl: BACKGROUND_URL,
      document: page.document as unknown as Document, view: page as unknown as Window,
      location: page.location as unknown as Location, now: () => now,
      openShadowRoot: (element) => element.shadowRoot,
    });
    try {
      await run(request, () => {}, {
        signal: new AbortController().signal, resolveProfilePayloads,
        isProfileCurrent: vi.fn(async () => false), authorizeLeafWrite: vi.fn(async () => false as const),
      });
      expect(resolveProfilePayloads).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect([...page.document.querySelectorAll('input,textarea')]
        .every((field) => Reflect.get(field, 'value') === '')).toBe(true);
    } finally {
      run.dispose();
      await page.happyDOM.close();
    }
  });
});

async function controlledRun(abortDuringSettlement = false,
  isProfileCurrent: PilotUa5LiveContentSessionInput['isProfileCurrent'] = async () => true) {
  let time = Date.now();
  const request = createPilotUa1DiscoveryRequest({
    pageUrl: location.href, requestId: '2'.repeat(32), issuedAtMs: time,
    targetUrlDigest: await exactUrlDigest(location.href),
  });
  if (request === null) throw new Error('TEST_DISCOVERY_INVALID');
  const controller = new AbortController();
  const run = createPilotUa5ConnectedLiveRun({
    enabled: true, forwardWriteMode: 'FILL_ONLY', writeNotAfterMs: time + 30_000,
    extensionId: EXTENSION_ID, expectedBackgroundUrl: BACKGROUND_URL,
    document, view: window, location, now: () => time,
    openShadowRoot: (element) => element.shadowRoot,
    session: {
      lateRecheckMs: 1, operationTimeoutMs: 50,
      settle: async () => { if (abortDuringSettlement) controller.abort(); },
      lateRecheckDelay: async () => undefined,
    },
  });
  const form = document.querySelector('form')!;
  return {
    run, request, controller,
    target: document.querySelector<HTMLInputElement>('#email')!,
    submit: vi.spyOn(form, 'submit'), requestSubmit: vi.spyOn(form, 'requestSubmit'),
    advance: (ms: number) => { time += ms; },
    execute: (progress: Parameters<typeof run>[1] = () => {}, nextRequest = request) => run(
      nextRequest, progress, {
        signal: controller.signal,
        resolveProfilePayloads: async (candidate) => profileResponse(candidate, time),
        isProfileCurrent,
        authorizeLeafWrite: async () => ({ allowed: true, writeNotAfterMs: time + 30_000 }),
      },
    ),
  };
}

describe('connected-dev real current-page run', () => {
  it('binds the original Profile and denies a stale proof without restarting the run', async () => {
    const isProfileCurrent = vi.fn(async () => false);
    const harness = await controlledRun(false, isProfileCurrent);
    const result = await harness.execute();
    expect(result).toMatchObject({ ok: true, projection: { rows: [{ state: 'POLICY_BLOCKED' }] } });
    expect(isProfileCurrent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      answerDigest: ANSWER_DIGEST,
      profileBinding: expect.objectContaining({ revision: '1', deletionEpoch: '0' }),
    }));
    expect(harness.target.value).toBe('');
    expect(harness.run.getCurrentResult()).toBeNull();
    await expect(harness.run.undoCurrentPage(harness.request.requestId, 'email')).resolves.toBe('UNAVAILABLE');
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.requestSubmit).not.toHaveBeenCalled();
    harness.run.dispose();
  });

  it('runs UA-1 → UA-5 → UA-4 but performs zero writes without a monotonic value witness', async () => {
    const now = Date.now();
    const request = createPilotUa1DiscoveryRequest({
      pageUrl: location.href,
      requestId: '1'.repeat(32),
      issuedAtMs: now,
      targetUrlDigest: await exactUrlDigest(location.href),
    });
    if (request === null) throw new Error('discovery request unavailable');
    const run = createPilotUa5ConnectedLiveRun({
      enabled: true,
      extensionId: EXTENSION_ID,
      expectedBackgroundUrl: BACKGROUND_URL,
      document,
      view: window,
      location,
      now: () => now,
      openShadowRoot: (element) => element.shadowRoot,
      session: Object.freeze({
        lateRecheckMs: 1,
        operationTimeoutMs: 50,
        settle: async () => undefined,
        lateRecheckDelay: async () => undefined,
      }),
    });
    const progress: unknown[] = [];
    const resolveProfilePayloads = vi.fn(async (candidate) => profileResponse(candidate, now));

    const result = await run(
      request,
      (event) => progress.push(event),
      Object.freeze({ signal: new AbortController().signal, resolveProfilePayloads }),
    );

    expect(resolveProfilePayloads).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>('#email')?.value).toBe('');
    expect(result).toMatchObject({
      ok: true,
      projection: {
        summary: { requiredQuestions: 1, requiredCompleted: 0, terminalQuestions: 1 },
        rows: [{ state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' }],
      },
    });
    expect(progress).toEqual([
      { phase: 'OBSERVED', observedControls: 1 },
      { phase: 'COMPOSED', observableQuestions: 1, authorizedQuestions: 1 },
      { phase: 'SETTLED', requiredCompleted: 0, requiredQuestions: 1 },
    ]);
    expect(JSON.stringify({ result, progress })).not.toContain(VALUE);
  });

  it.each(['undo', 'deadline', 'replacement', 'settled-disconnect'] as const)(
    'retains only the value-free run result through %s', async (scenario) => {
      const h = await controlledRun();
      const result = await h.execute((event) => {
        if (scenario === 'settled-disconnect' && event.phase === 'SETTLED') h.controller.abort();
      });
      expect(result).toMatchObject({ ok: true, projection: { rows: [{ state: 'FILLED' }] } });
      if (!result.ok) throw new Error('TEST_RUN_FAILED');
      const questionId = result.projection.rows[0]!.questionId;
      const canonical = h.run.getCurrentResult();
      expect(canonical).toMatchObject({ requestId: h.request.requestId, result });
      expect(JSON.stringify(canonical)).not.toContain(VALUE);
      expect(h.target.value).toBe(VALUE);
      expect(h.submit).not.toHaveBeenCalled();
      expect(h.requestSubmit).not.toHaveBeenCalled();
      if (scenario === 'deadline') {
        h.advance(59_999);
        expect(h.run.getCurrentResult()).toEqual(canonical);
        h.advance(1);
        expect(h.run.getCurrentResult()).toBeNull();
        await expect(h.run.undoCurrentPage(h.request.requestId, questionId)).resolves.toBe('UNAVAILABLE');
        expect(h.target.value).toBe(VALUE);
      } else if (scenario === 'replacement') {
        h.target.replaceWith(h.target.cloneNode());
        expect(h.run.getCurrentResult()).toBeNull();
        await expect(h.run.undoCurrentPage(h.request.requestId, questionId)).resolves.toBe('UNAVAILABLE');
      } else {
        await expect(h.run.undoCurrentPage(h.request.requestId, questionId)).resolves.toBe('UNAVAILABLE');
        expect(h.target.value).toBe(VALUE);
        expect(h.run.getCurrentResult()).toEqual(canonical);
        await expect(h.run.undoCurrentPage(h.request.requestId, questionId)).resolves.toBe('UNAVAILABLE');
      }
      h.run.dispose();
    },
  );

  it('ignores frozen Undo requests while a replacement owns the current result', async () => {
    const h = await controlledRun();
    const first = await h.execute();
    if (!first.ok) throw new Error('TEST_RUN_FAILED');
    await h.run.undoCurrentPage(h.request.requestId, first.projection.rows[0]!.questionId);
    h.target.value = ''; // The person edits the host page before requesting another run.
    const replacement = { ...h.request, requestId: '3'.repeat(32) };
    const second = await h.execute(() => {}, replacement);
    if (!second.ok) throw new Error('TEST_RUN_FAILED');
    await expect(h.run.undoCurrentPage(h.request.requestId, first.projection.rows[0]!.questionId))
      .resolves.toBe('UNAVAILABLE');
    expect(h.run.getCurrentResult()?.requestId).toBe(replacement.requestId);
    await expect(h.run.undoCurrentPage(replacement.requestId, second.projection.rows[0]!.questionId))
      .resolves.toBe('UNAVAILABLE');
    h.run.dispose();
  });

  it('preserves an unsettled leaf and its failure result on disconnect without calling Submit', async () => {
    const h = await controlledRun(true);
    const result = await h.execute();
    expect(result).toMatchObject({ ok: true, projection: { rows: [{ state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' }] } });
    expect(h.target.value).toBe(VALUE);
    expect(h.run.getCurrentResult()).toMatchObject({ kind: 'pilot-ua5/result', result });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.requestSubmit).not.toHaveBeenCalled();
    h.run.dispose();
  });
});
