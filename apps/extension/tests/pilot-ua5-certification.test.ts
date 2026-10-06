/**
 * UA-5 current-page orchestration: the vertical chain, exercised through the
 * real ports it composes. Nothing here fakes a rung's rule — the writer runtime,
 * the terminal ledger and the projection are the production ones.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { PilotUa1DiscoveryPacket } from '@edaix/contracts/draft';
import type { PilotUa5CompositionResponse } from '@edaix/contracts/draft/pilot-ua5-certification';
import { parsePilotUa5RunProjection } from '@edaix/contracts/draft/pilot-ua5-certification';
import {
  createPilotUa4WriterRuntime,
  type PilotUa4HostExecutor,
} from '../lib/pilotUa4WriterRuntime';
import {
  projectRun,
  readPilotUa5TerminalLedger,
  runPilotUa5CurrentPage,
  type PilotUa5ProgressEvent,
} from '../lib/pilotUa5Orchestrator';

const sha256 = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join(' '), 'utf8').digest('hex');
const d = (ref: string): string => sha256('ref', ref);

const packet: PilotUa1DiscoveryPacket = Object.freeze({
  schemaVersion: 2,
  binding: Object.freeze({
    origin: 'https://example.invalid',
    pathname: '/apply',
    domGeneration: sha256('gen', 'g0'),
  }),
  controls: Object.freeze([
    Object.freeze({
      identityDigest: d('email'), role: 'textbox' as const, inputType: 'email' as const,
      autocomplete: Object.freeze(['email']), required: true, accessibleName: 'Email',
      label: 'Email', legend: null, options: Object.freeze([]), fileAccept: null,
    }),
    Object.freeze({
      identityDigest: d('pw'), role: 'textbox' as const, inputType: 'password' as const,
      autocomplete: Object.freeze([]), required: true, accessibleName: 'Password',
      label: 'Password', legend: null, options: Object.freeze([]), fileAccept: null,
    }),
  ]),
  // The scan's own drop accounting, on the certified wire. This page dropped
  // nothing; a page that did would say so here and the run would stop.
  observation: Object.freeze({
    suppressedControls: Object.freeze([]),
    hiddenNotObservedCount: 0, opaqueBoundaries: [],
  }),
});

/** One sidecar row per control: digests, ordinals and booleans only. */
const entry = (ref: string, documentOrder: number) => Object.freeze({
  identityDigest: d(ref), elementToken: sha256('element', ref), groupKeyDigest: null,
  row: null, documentOrder, memberOfGroupControl: null, placeholderShape: null,
  optionsOverflow: false, placeholderOptionIndexes: Object.freeze([]),
  disabled: false, readOnly: false, multiple: false,
});

/**
 * The producer emits a sidecar only when the scan proved it counted the whole
 * document, and it must state this packet's own accounting. The compiler
 * re-checks both, so neither can be restated here.
 */
const structure = Object.freeze({
  schemaVersion: 1 as const,
  packetDigest: sha256('packet', JSON.stringify(packet.controls)),
  epochIndex: 0,
  compilerVersion: 'semantic-compiler-1',
  counts: Object.freeze({ controls: 2, entries: 2, suppressed: 0, hiddenNotObserved: 0 }),
  entries: Object.freeze([entry('email', 0), entry('pw', 1)]),
});

const observation = Object.freeze({ packet, structure }) as never;

const hostAccepts: PilotUa4HostExecutor = Object.freeze({
  async execute() {
    return Object.freeze({
      state: 'FILLED' as const,
      semanticReadback: 'HOST_ACCEPTED' as const,
      lateRecheck: 'STABLE' as const,
      undo: 'OWNED' as const,
    });
  },
});

const disabledPorts = (over: Partial<Parameters<typeof runPilotUa5CurrentPage>[1]> = {}) => Object.freeze({
  observe: async () => observation,
  compose: async () => Object.freeze({ ok: false, schemaVersion: 1, code: 'PILOT_CAPABILITY_DISABLED' }) as PilotUa5CompositionResponse,
  writer: createPilotUa4WriterRuntime(Object.freeze({ enabled: false }), hostAccepts),
  semanticDigest: sha256,
  now: () => 1_000_000,
  ...over,
});

describe('UA-5 orchestrator · gates before anything is observed', () => {
  it('is default-off: a disabled policy stops before the page is touched', async () => {
    let observed = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: false }),
      disabledPorts({ observe: async () => { observed = true; return observation; } }),
      true,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    expect(observed).toBe(false);
  });

  it('refuses a run that cannot prove the user asked for it', async () => {
    let observed = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({ observe: async () => { observed = true; return observation; } }),
      false,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    expect(observed).toBe(false);
  });

  it('stops when the page cannot be observed, and never calls the backend', async () => {
    let composed = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        observe: async () => null,
        compose: async () => { composed = true; throw new Error('unreachable'); },
      }),
      true,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    expect(composed).toBe(false);
  });

  it('stops when the composition is unavailable, and never reaches the writer', async () => {
    let executed = false;
    const writer = createPilotUa4WriterRuntime(Object.freeze({ enabled: true }), Object.freeze({
      async execute() { executed = true; throw new Error('unreachable'); },
    }));
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({ writer }),
      true,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_COMPOSITION_UNAVAILABLE' });
    expect(executed).toBe(false);
  });
});

describe('UA-5 orchestrator · the panel projection', () => {
  const ledger = Object.freeze({
    schemaVersion: 2 as const,
    binding: packet.binding,
    discoveryComplete: true,
    questions: Object.freeze([
      Object.freeze({ questionId: d('q-email'), required: true }),
      Object.freeze({ questionId: d('q-pw'), required: true }),
      Object.freeze({ questionId: d('q-note'), required: false }),
    ]),
    dispositions: Object.freeze([
      Object.freeze({
        questionId: d('q-email'),
        disposition: Object.freeze({
          state: 'FILLED' as const, semanticReadback: 'HOST_ACCEPTED' as const,
          lateRecheck: 'STABLE' as const, undo: 'OWNED' as const,
        }),
      }),
      Object.freeze({
        questionId: d('q-pw'),
        disposition: Object.freeze({ state: 'MANUAL_REQUIRED' as const, reason: 'PASSWORD' as const }),
      }),
      Object.freeze({
        questionId: d('q-note'),
        disposition: Object.freeze({
          state: 'USER_CONFIRMATION_REQUIRED' as const, reason: 'ANSWER_AUTHORITY_MISSING' as const,
        }),
      }),
    ]),
    unobservedRegions: Object.freeze([]),
    summary: Object.freeze({
      observableQuestions: 3, requiredQuestions: 2, terminalQuestions: 3,
      terminalRequiredQuestions: 2, requiredFieldFinalDispositionCoverage: 100 as const,
      unobservedRegions: 0,
    }),
  });

  it('gives every logical question exactly one state and counts required completion', () => {
    const projection = projectRun(ledger);
    expect(projection.rows).toHaveLength(3);
    expect(new Set(projection.rows.map((row) => row.questionId)).size).toBe(3);
    expect(projection.summary).toEqual({
      observableQuestions: 3, requiredQuestions: 2, requiredCompleted: 1, terminalQuestions: 3,
      unobservedRegions: 0,
    });
    // A required password is required-but-not-completed: it must not inflate the count.
    expect(projection.rows.find((row) => row.questionId === d('q-pw')))
      .toEqual({ questionId: d('q-pw'), required: true, state: 'MANUAL_REQUIRED', reason: 'PASSWORD' });
  });

  it('re-parses under the contract, so the counts cannot be asserted by a caller', () => {
    const parsed = parsePilotUa5RunProjection(projectRun(ledger));
    expect(parsed.ok).toBe(true);
    // An inflated completion count is refused, not trusted.
    const inflated = { ...projectRun(ledger) };
    const tampered = {
      ...inflated,
      summary: { ...inflated.summary, requiredCompleted: 2 },
    };
    expect(parsePilotUa5RunProjection(tampered).ok).toBe(false);
  });

  it('carries no raw value, label, selector or HTML', () => {
    const serialized = JSON.stringify(projectRun(ledger));
    for (const forbidden of ['Email', 'Password', 'input', 'div', '<', 'value']) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });
});

describe('UA-5 orchestrator · it asserts nothing the observation cannot prove', () => {
  /** Captures what the writer was actually handed, then stops the run. */
  const recorder = () => {
    const seen: { discoveryComplete?: unknown; suppressed?: unknown; hidden?: unknown; structure?: unknown } = {};
    return Object.freeze({
      seen,
      port: Object.freeze({
        async execute(input: {
          discoveryComplete: unknown;
          semanticEpochs: readonly {
            suppressedControls: unknown; hiddenNotObservedCount: unknown; structure: unknown;
          }[];
        }) {
          seen.discoveryComplete = input.discoveryComplete;
          seen.suppressed = input.semanticEpochs[0]?.suppressedControls;
          seen.hidden = input.semanticEpochs[0]?.hiddenNotObservedCount;
          seen.structure = input.semanticEpochs[0]?.structure;
          return Object.freeze({ ok: false as const, code: 'PILOT_CAPABILITY_DISABLED' as const });
        },
      }),
    });
  };

  const composedEmpty = async () => Object.freeze({
    ok: true, schemaVersion: 1,
    candidateRule: { classifications: [] },
    authority: { questionAuthorizations: [] },
    projection: { rows: [], summary: { observableQuestions: 0, authorizedQuestions: 0 } },
    constraints: {},
  }) as never;

  it('stops without a sidecar rather than compiling on a DOM address', async () => {
    let composed = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        observe: async () => Object.freeze({ packet, structure: null }) as never,
        compose: async () => { composed = true; throw new Error('unreachable'); },
      }),
      true,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_STRUCTURE_UNAVAILABLE' });
    expect(composed).toBe(false);
  });

  it('stops when the scan proved questions exist that it could never name', async () => {
    // Two hidden natives were seen and never given an identity. No ledger row
    // can exist for them, so the denominator cannot be shown to be complete --
    // and a run that cannot say "and some more" must not say "that is all".
    const withHidden = Object.freeze({
      ...packet,
      observation: Object.freeze({ suppressedControls: Object.freeze([]), hiddenNotObservedCount: 2, opaqueBoundaries: [] }),
    });
    let composed = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        observe: async () => Object.freeze({ packet: withHidden, structure }) as never,
        compose: async () => { composed = true; throw new Error('unreachable'); },
      }),
      true,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_HIDDEN_QUESTIONS_UNOBSERVED' });
    expect(composed).toBe(false);
  });

  it('continues when the only hidden natives were shims the scan accounted for by identity', async () => {
    // A react-select validation shim or the native carrier behind a visible
    // ARIA radio is observed and suppressed by identity by UA-1; it is not a
    // hidden question, so the denominator is not short and the run proceeds.
    const withShims = Object.freeze({
      ...packet,
      observation: Object.freeze({
        suppressedControls: Object.freeze([d('shim-country'), d('shim-auth-yes')]),
        hiddenNotObservedCount: 0, opaqueBoundaries: [],
      }),
    });
    let composed = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        observe: async () => Object.freeze({ packet: withShims, structure: { ...structure, counts: { ...structure.counts, suppressed: 2 } } }) as never,
        compose: async () => { composed = true; return Object.freeze({ ok: false, schemaVersion: 1, code: 'PILOT_CAPABILITY_DISABLED' }) as PilotUa5CompositionResponse; },
      }),
      true,
    );
    expect(composed).toBe(true);
    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_COMPOSITION_UNAVAILABLE' });
  });

  it('hands the writer the packet\'s own accounting and the producer\'s sidecar', async () => {
    // Suppressed honeypots are accounted for, not lost, so this run continues --
    // and the numbers the writer sees are the packet's, not this module's.
    const withSuppressed = Object.freeze({
      ...packet,
      observation: Object.freeze({
        suppressedControls: Object.freeze(['b'.repeat(64)]),
        hiddenNotObservedCount: 0, opaqueBoundaries: [],
      }),
    });
    const recording = recorder();
    await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        writer: recording.port as never,
        observe: async () => Object.freeze({ packet: withSuppressed, structure }) as never,
        compose: composedEmpty,
      }),
      true,
    );
    expect(recording.seen.suppressed).toEqual(['b'.repeat(64)]);
    expect(recording.seen.hidden).toBe(0);
    expect(recording.seen.structure).toBe(structure);
    // Derived from the producer's proof: a run without a sidecar never gets here.
    expect(recording.seen.discoveryComplete).toBe(true);
  });

  it('sends the sidecar to the backend, so both rungs compile the same evidence', async () => {
    let sent: unknown = null;
    await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        compose: async (request) => { sent = request; return composedEmpty(); },
        writer: recorder().port as never,
      }),
      true,
    );
    expect(sent).toEqual({
      schemaVersion: 1,
      trigger: 'USER_CURRENT_PAGE_REQUEST',
      discovery: packet,
      structure,
    });
    // There is no field on this wire through which an answer authority could be
    // asserted; Answer Resolution is the only producer of that fact.
    expect(Object.keys(sent as object)).not.toContain('answers');
  });
});

describe('UA-5 orchestrator · every question ends the run with a terminal', () => {
  const authority = Object.freeze({
    authorityId: d('authority'),
    binding: packet.binding,
    pageIdentityDigest: d('page'),
    observedControlIdentityDigests: Object.freeze([d('email'), d('pw')]),
    expiresAtMs: 2_000_000,
    questionAuthorizations: Object.freeze([]),
    blockedQuestions: Object.freeze([]),
    constraints: Object.freeze({
      exactTargetBinding: 'REQUIRED' as const, semanticReadback: 'REQUIRED' as const,
      hostValidation: 'REQUIRED' as const, lateRecheck: 'REQUIRED' as const,
      undo: 'REQUIRED' as const, submit: 'FORBIDDEN' as const,
      activationState: 'DEFAULT_OFF' as const, releaseState: 'NOT_RELEASED' as const,
    }),
  });

  const classifications = Object.freeze([
    Object.freeze({
      identityDigest: d('email'), kind: 'CANONICAL_FIELD' as const, canonicalField: 'EMAIL' as const,
      confidence: 'HIGH' as const, reasonCode: 'CANONICAL_SEMANTIC_MATCH' as const,
      provenance: Object.freeze({ source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: d('sem-email') }),
    }),
    Object.freeze({
      identityDigest: d('pw'), kind: 'HUMAN_ACTION_REQUIRED' as const, canonicalField: null,
      confidence: 'HIGH' as const, reasonCode: 'HUMAN_PASSWORD_CONTROL' as const,
      provenance: Object.freeze({ source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: d('sem-pw') }),
    }),
  ]);

  /**
   * The email question is writable and cleanly classified, so UA-4's prepare
   * step mints nothing for it from the classification alone -- its terminal has
   * to come from UA-4's own verdict on the authority, or the ledger is a row
   * short and the whole batch fails.
   */
  const compose = (
    rows: readonly unknown[],
    blockedQuestions: readonly unknown[] = [],
  ) => async () => Object.freeze({
    ok: true, schemaVersion: 1,
    candidateRule: Object.freeze({ classifications }),
    authority: Object.freeze({ ...authority, blockedQuestions: Object.freeze(blockedQuestions) }),
    projection: Object.freeze({
      rows: Object.freeze(rows),
      summary: Object.freeze({ observableQuestions: rows.length, authorizedQuestions: 0 }),
    }),
    constraints: Object.freeze({}),
  }) as never;

  const questionIds = async (): Promise<readonly string[]> => {
    const { derivePilotUa5Questions } = await import('@edaix/apply-kernel/pilotUa5Composition');
    const derived = derivePilotUa5Questions(
      [Object.freeze({
        cause: 'USER_TRIGGER' as const, binding: packet.binding, controls: packet.controls,
        structure, suppressedControls: Object.freeze([]), hiddenNotObservedCount: 0,
        attributedAddRowGroup: null,
      })] as never,
      classifications as never,
      sha256,
    );
    if (!derived.ok) throw new Error('the fixture must compile');
    return derived.questions.map((question) => question.questionId);
  };

  it('gives a question with no resolved authority its terminal, and calls no host', async () => {
    const [emailId, passwordId] = await questionIds();
    let hostCalls = 0;
    const countingHost: PilotUa4HostExecutor = Object.freeze({
      async execute() { hostCalls += 1; return hostAccepts.execute({} as never); },
    });
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        writer: createPilotUa4WriterRuntime(Object.freeze({ enabled: true }), countingHost),
        compose: compose(
          [
            Object.freeze({
              questionId: emailId, required: true, writerKind: 'TEXT', memberCount: 1,
              admission: 'ANSWER_AUTHORITY_MISSING',
            }),
            Object.freeze({
              questionId: passwordId, required: true, writerKind: null, memberCount: 1,
              admission: 'TERMINAL_FROM_CLASSIFICATION',
            }),
          ],
          [Object.freeze({
            questionId: emailId, controlKind: 'TEXT', identityDigests: [d('email')],
            required: true, code: 'ANSWER_AUTHORITY_NOT_RESOLVED',
          })],
        ),
      }),
      true,
    );
    if (!result.ok) throw new Error(`run failed: ${result.code}`);
    // Both questions are in the ledger, each with exactly one terminal, and the
    // missing answer is reported as a missing answer.
    expect(result.projection.rows).toHaveLength(2);
    expect(result.projection.rows.find((row) => row.questionId === emailId))
      .toEqual({
        questionId: emailId, required: true,
        state: 'USER_CONFIRMATION_REQUIRED', reason: 'ANSWER_AUTHORITY_MISSING',
      });
    expect(result.projection.rows.find((row) => row.questionId === passwordId)?.state)
      .toBe('MANUAL_REQUIRED');
    // Nothing was authorized, so no host was ever asked to write anything.
    expect(hostCalls).toBe(0);
    const terminal = readPilotUa5TerminalLedger(result);
    expect(terminal?.dispositions).toHaveLength(2);
    expect(terminal?.binding).toEqual(packet.binding);
    expect(readPilotUa5TerminalLedger({ ...result })).toBeNull();
    expect(readPilotUa5TerminalLedger({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' })).toBeNull();
    expect(Object.keys(result)).toEqual(['ok', 'projection']);
    expect(result.projection.summary.requiredCompleted).toBe(0);
    expect(result.projection.discoveryComplete).toBe(true);
  });

  it('fails closed rather than reporting a denominator that is a row short', async () => {
    // The same run with UA-4's verdict on the email question withheld. The
    // ledger refuses it outright; it never reports a smaller, tidier page.
    const [emailId, passwordId] = await questionIds();
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        writer: createPilotUa4WriterRuntime(Object.freeze({ enabled: true }), hostAccepts),
        compose: compose([
          Object.freeze({
            questionId: emailId, required: true, writerKind: 'TEXT', memberCount: 1,
            admission: 'ANSWER_AUTHORITY_MISSING',
          }),
          Object.freeze({
            questionId: passwordId, required: true, writerKind: null, memberCount: 1,
            admission: 'TERMINAL_FROM_CLASSIFICATION',
          }),
        ]),
      }),
      true,
    );
    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' });
  });
});

describe('UA-5 orchestrator · progress events are value-free', () => {
  it('emits counts and closed phases only', async () => {
    const events: PilotUa5ProgressEvent[] = [];
    await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({ onProgress: (event) => events.push(event) }),
      true,
    );
    expect(events).toEqual([{ phase: 'OBSERVED', observedControls: 2 }]);
    const serialized = JSON.stringify(events);
    for (const forbidden of ['Email', 'Password', 'example.invalid', '<']) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });
});

describe('UA-5 orchestrator · page-local payload references', () => {
  const questionId = d('q-email');
  const answerDigest = d('answer-email');
  const composition = Object.freeze({
    ok: true,
    schemaVersion: 1,
    candidateRule: Object.freeze({ classifications: Object.freeze([]) }),
    authority: Object.freeze({
      questionAuthorizations: Object.freeze([
        Object.freeze({ questionId, answerDigest }),
      ]),
    }),
    projection: Object.freeze({
      rows: Object.freeze([]),
      summary: Object.freeze({ observableQuestions: 0, authorizedQuestions: 0 }),
    }),
    constraints: Object.freeze({}),
  }) as never;

  it('hands UA-4 the opaque ref bound by the live content session', async () => {
    let payloadRefs: unknown = null;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        compose: async () => composition,
        resolvePayloadRef: (authorization) => {
          expect(authorization).toEqual({ questionId, answerDigest });
          return 'ua5.profile.question.email';
        },
        writer: Object.freeze({
          async execute(input) {
            payloadRefs = input.payloadRefs;
            return Object.freeze({ ok: false as const, code: 'PILOT_CAPABILITY_DISABLED' as const });
          },
        }),
      }),
      true,
    );

    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' });
    expect(payloadRefs).toEqual([{
      questionId,
      payloadRef: 'ua5.profile.question.email',
    }]);
  });

  it('fails closed before UA-4 when a live payload ref is unavailable', async () => {
    let writerCalled = false;
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        compose: async () => composition,
        resolvePayloadRef: () => null,
        writer: Object.freeze({
          async execute() {
            writerCalled = true;
            return Object.freeze({ ok: false as const, code: 'PILOT_CAPABILITY_DISABLED' as const });
          },
        }),
      }),
      true,
    );

    expect(result).toEqual({ ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' });
    expect(writerCalled).toBe(false);
  });
});

describe('UA-5 orchestrator · an opaque frame boundary is an unobserved region: not a question, not a run failure', () => {
  const frame = d('frame');
  const withBoundary = Object.freeze({
    ...packet,
    observation: Object.freeze({
      suppressedControls: Object.freeze([]),
      hiddenNotObservedCount: 0,
      opaqueBoundaries: Object.freeze([frame]),
    }),
  });
  const authority = Object.freeze({
    authorityId: d('authority'),
    binding: packet.binding,
    pageIdentityDigest: d('page'),
    observedControlIdentityDigests: Object.freeze([d('email'), d('pw')]),
    expiresAtMs: 2_000_000,
    questionAuthorizations: Object.freeze([]),
    blockedQuestions: Object.freeze([]),
    constraints: Object.freeze({
      exactTargetBinding: 'REQUIRED' as const, semanticReadback: 'REQUIRED' as const,
      hostValidation: 'REQUIRED' as const, lateRecheck: 'REQUIRED' as const,
      undo: 'REQUIRED' as const, submit: 'FORBIDDEN' as const,
      activationState: 'DEFAULT_OFF' as const, releaseState: 'NOT_RELEASED' as const,
    }),
  });
  const classifications = Object.freeze([
    Object.freeze({
      identityDigest: d('email'), kind: 'CANONICAL_FIELD' as const, canonicalField: 'EMAIL' as const,
      confidence: 'HIGH' as const, reasonCode: 'CANONICAL_SEMANTIC_MATCH' as const,
      provenance: Object.freeze({ source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: d('sem-email') }),
    }),
    Object.freeze({
      identityDigest: d('pw'), kind: 'HUMAN_ACTION_REQUIRED' as const, canonicalField: null,
      confidence: 'HIGH' as const, reasonCode: 'HUMAN_PASSWORD_CONTROL' as const,
      provenance: Object.freeze({ source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: d('sem-pw') }),
    }),
  ]);
  const questionIds = async (): Promise<readonly string[]> => {
    const { derivePilotUa5Questions } = await import('@edaix/apply-kernel/pilotUa5Composition');
    const derived = derivePilotUa5Questions(
      [Object.freeze({
        cause: 'USER_TRIGGER' as const, binding: packet.binding, controls: packet.controls,
        structure, suppressedControls: Object.freeze([]), hiddenNotObservedCount: 0,
        attributedAddRowGroup: null,
      })] as never,
      classifications as never,
      sha256,
    );
    if (!derived.ok) throw new Error('the fixture must compile');
    return derived.questions.map((question) => question.questionId);
  };
  const compose = (emailId: string, passwordId: string) => async () => Object.freeze({
    ok: true, schemaVersion: 1,
    candidateRule: Object.freeze({ classifications }),
    authority: Object.freeze({
      ...authority,
      blockedQuestions: Object.freeze([Object.freeze({
        questionId: emailId, controlKind: 'TEXT', identityDigests: [d('email')],
        required: true, code: 'ANSWER_AUTHORITY_NOT_RESOLVED',
      })]),
    }),
    projection: Object.freeze({
      rows: Object.freeze([
        Object.freeze({ questionId: emailId, required: true, writerKind: 'TEXT', memberCount: 1, admission: 'ANSWER_AUTHORITY_MISSING' }),
        Object.freeze({ questionId: passwordId, required: true, writerKind: null, memberCount: 1, admission: 'TERMINAL_FROM_CLASSIFICATION' }),
      ]),
      summary: Object.freeze({ observableQuestions: 2, authorizedQuestions: 0 }),
    }),
    constraints: Object.freeze({}),
  }) as never;

  it('hands the writer the region with a neutral reason and withdraws the completeness claim', async () => {
    const seen: { discoveryComplete?: unknown; regions?: unknown } = {};
    await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        observe: async () => Object.freeze({ packet: withBoundary, structure }) as never,
        compose: async () => Object.freeze({
          ok: true, schemaVersion: 1,
          candidateRule: { classifications: [] },
          authority: { questionAuthorizations: [] },
          projection: { rows: [], summary: { observableQuestions: 0, authorizedQuestions: 0 } },
          constraints: {},
        }) as never,
        writer: Object.freeze({
          async execute(input: { discoveryComplete: unknown; unobservedRegions: unknown }) {
            seen.discoveryComplete = input.discoveryComplete;
            seen.regions = input.unobservedRegions;
            return Object.freeze({ ok: false as const, code: 'PILOT_CAPABILITY_DISABLED' as const });
          },
        }) as never,
      }),
      true,
    );
    expect(seen.discoveryComplete).toBe(false);
    // The scan checked nothing about the frame's origin, so it claims nothing about it.
    expect(seen.regions).toEqual([{ regionId: frame, reason: 'FRAME_NOT_OBSERVED' }]);
  });

  it('runs over the observed questions and carries the frame as an unobserved region, never as a row', async () => {
    const [emailId, passwordId] = await questionIds();
    let hostCalls = 0;
    const countingHost: PilotUa4HostExecutor = Object.freeze({
      async execute() { hostCalls += 1; return hostAccepts.execute({} as never); },
    });
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        observe: async () => Object.freeze({ packet: withBoundary, structure }) as never,
        writer: createPilotUa4WriterRuntime(Object.freeze({ enabled: true }), countingHost),
        compose: compose(emailId!, passwordId!),
      }),
      true,
    );
    if (!result.ok) throw new Error(`run failed: ${result.code}`);
    expect(parsePilotUa5RunProjection(result.projection).ok).toBe(true);
    expect(result.projection.discoveryComplete).toBe(false);
    // Two observed questions, exactly; the frame is not a third one -- it is
    // neither required nor optional and has no terminal state.
    expect(result.projection.rows).toHaveLength(2);
    expect(result.projection.rows.find((row) => row.questionId === frame)).toBeUndefined();
    expect(result.projection.unobservedRegions).toEqual([{ regionId: frame, reason: 'FRAME_NOT_OBSERVED' }]);
    expect(result.projection.summary).toMatchObject({ observableQuestions: 2, unobservedRegions: 1 });
    // The observed questions still got their own terminals; the frame was never
    // written to, and it does not inflate the required denominator.
    expect(result.projection.rows.find((row) => row.questionId === emailId)?.state)
      .toBe('USER_CONFIRMATION_REQUIRED');
    expect(result.projection.rows.find((row) => row.questionId === passwordId)?.state)
      .toBe('MANUAL_REQUIRED');
    expect(result.projection.summary.requiredQuestions).toBe(2);
    expect(hostCalls).toBe(0);
    // Value-free: the wire carries the frame's digest and nothing about the frame,
    // and no origin claim the scan never checked.
    expect(JSON.stringify(result)).not.toMatch(/iframe|src=|title=|widget|CROSS_ORIGIN/u);
  });

  it('without a boundary the claim is unchanged', async () => {
    const [emailId, passwordId] = await questionIds();
    const result = await runPilotUa5CurrentPage(
      Object.freeze({ enabled: true }),
      disabledPorts({
        writer: createPilotUa4WriterRuntime(Object.freeze({ enabled: true }), hostAccepts),
        compose: compose(emailId!, passwordId!),
      }),
      true,
    );
    if (!result.ok) throw new Error(`run failed: ${result.code}`);
    expect(result.projection.discoveryComplete).toBe(true);
    expect(result.projection.rows).toHaveLength(2);
  });
});
