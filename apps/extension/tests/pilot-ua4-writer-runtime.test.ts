import { describe, expect, it, vi } from 'vitest';

import type { PilotUa4WriteAuthority } from '@edaix/contracts/draft/pilot-ua4-write-authority';
import { compileGraph } from '../../../packages/apply-kernel/src/semantic/graph';
import {
  compiledEpochs, d, sha256, type Vector,
} from '../../../packages/apply-kernel/tests/semantic/harness';
import {
  createPilotUa4LeafHostExecutor,
  createPilotUa4WriterRuntime,
  readPilotUa4TerminalLedger,
} from '../lib/pilotUa4WriterRuntime';

const digest = (ordinal: number): string => ordinal.toString(16).padStart(64, '0');
const vector: Vector = {
  id: 'ua4-extension-runtime', scenarioClass: 'UA4', title: 'writer runtime', todayBehavior: 'off',
  origin: 'https://careers.example.test', pathname: '/jobs/engineer',
  epochs: [{
    cause: 'USER_TRIGGER', domGeneration: digest(900), sidecar: true,
    controls: [
      { ref: 'email', shape: 'TEXT', required: true, accessibleName: 'Email' },
      {
        ref: 'country', shape: 'SELECT', required: true, accessibleName: 'Country',
        options: ['Choose', 'US'], placeholderOptions: [0], optionsOverflow: true,
      },
    ],
    ua2: {
      email: { kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' },
      country: { kind: 'CANONICAL_FIELD', canonicalField: 'COUNTRY' },
    },
  }],
  expected: {},
};
const semanticEpochs = compiledEpochs(vector);
const graph = compileGraph(semanticEpochs, sha256);
if (!graph.ok) throw new Error('fixture compiler failed');
const emailNode = graph.graph.nodes.find((node) => node.control.members.some((m) => m.identityDigest === d('email')));
const countryNode = graph.graph.nodes.find((node) => node.control.members.some((m) => m.identityDigest === d('country')));
if (emailNode?.kind !== 'QUESTION' || countryNode?.kind !== 'QUESTION') throw new Error('fixture node missing');
const emailQuestionId = emailNode.id;
const countryQuestionId = countryNode.id;
const binding = semanticEpochs[0]!.binding;
const authority: PilotUa4WriteAuthority = {
  authorityId: digest(99), binding, pageIdentityDigest: digest(88),
  observedControlIdentityDigests: [d('email'), d('country')], expiresAtMs: 1_800_000_030_000,
  questionAuthorizations: [{
    questionId: emailQuestionId, controlKind: 'TEXT', identityDigests: [d('email')], required: true,
    answerAuthority: 'PROFILE_CONFIRMED', answerDigest: digest(91),
  }],
  blockedQuestions: [{
    questionId: countryQuestionId, controlKind: 'NATIVE_SELECT', identityDigests: [d('country')],
    required: true, code: 'OPTIONS_INCOMPLETE',
  }],
  constraints: {
    exactTargetBinding: 'REQUIRED', semanticReadback: 'REQUIRED', hostValidation: 'REQUIRED',
    lateRecheck: 'REQUIRED', undo: 'REQUIRED', submit: 'FORBIDDEN',
    activationState: 'DEFAULT_OFF', releaseState: 'NOT_RELEASED',
  },
};

function leaf(ordinal: number, controlKind: 'TEXT' | 'CONTENTEDITABLE' | 'NATIVE_SELECT') {
  const compilerControlKind = { TEXT: 'TEXT_SINGLE', CONTENTEDITABLE: 'TEXT_RICH', NATIVE_SELECT: 'SELECT_ONE' } as const;
  return {
    questionId: digest(ordinal), controlKind, compilerControlKind: compilerControlKind[controlKind],
    identityDigests: [digest(ordinal + 1)], required: true, rowToken: null,
    answerDigest: digest(ordinal + 2), payloadRef: 'local.fixture', classification: null,
  };
}

describe('UA-4 Extension composition-only writer runtime', () => {
  it('is default-off and never reaches the host executor', async () => {
    const execute = vi.fn();
    const runtime = createPilotUa4WriterRuntime({ enabled: false }, { execute });
    expect(await runtime.execute(input())).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes only compiler-admitted questions and closes the compiler denominator', async () => {
    const execute = vi.fn().mockResolvedValue({
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    });
    const runtime = createPilotUa4WriterRuntime({ enabled: true }, { execute });
    const result = await runtime.execute(input());
    expect(result.ok && readPilotUa4TerminalLedger(result)).toBe(result.ok ? result.value : false);
    expect(readPilotUa4TerminalLedger({ ...result })).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      questionId: emailQuestionId, compilerControlKind: 'TEXT_SINGLE',
    }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        discoveryComplete: true,
        dispositions: [
          { questionId: countryQuestionId, disposition: { state: 'POLICY_BLOCKED', reason: 'OPTIONS_INCOMPLETE' } },
          { questionId: emailQuestionId, disposition: {
            state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
          } },
        ],
        summary: { requiredFieldFinalDispositionCoverage: 100 },
      },
    });
  });

  it('keeps an unobserved region apart from the questions: no row, no terminal, no write', async () => {
    const execute = vi.fn().mockResolvedValue({
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    });
    const runtime = createPilotUa4WriterRuntime({ enabled: true }, { execute });
    const result = await runtime.execute({
      ...input(),
      discoveryComplete: false,
      unobservedRegions: [{ regionId: digest(700), reason: 'FRAME_NOT_OBSERVED' }],
    });
    if (!result.ok) throw new Error(`ledger not built: ${result.code}`);
    expect(result.value.discoveryComplete).toBe(false);
    expect(result.value.unobservedRegions).toEqual([{ regionId: digest(700), reason: 'FRAME_NOT_OBSERVED' }]);
    expect(result.value.summary.unobservedRegions).toBe(1);
    // The denominator is the compiler's questions, exactly; the region is
    // neither required nor optional and holds no terminal.
    expect(result.value.questions.map((question) => question.questionId).sort())
      .toEqual([countryQuestionId, emailQuestionId].sort());
    expect(result.value.dispositions.some((row) => row.questionId === digest(700))).toBe(false);
    expect(result.value.summary.observableQuestions).toBe(2);
    expect(result.value.summary.requiredFieldFinalDispositionCoverage).toBe(100);
    // The observed questions were still written; the region never was.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('CROSS_ORIGIN');
  });

  it('refuses a region presented alongside a claim that discovery was complete', async () => {
    const execute = vi.fn().mockResolvedValue({
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    });
    const runtime = createPilotUa4WriterRuntime({ enabled: true }, { execute });
    expect(await runtime.execute({
      ...input(),
      discoveryComplete: true,
      unobservedRegions: [{ regionId: digest(700), reason: 'FRAME_NOT_OBSERVED' }],
    })).toEqual({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
    // And a region may not shadow a compiler question.
    expect(await runtime.execute({
      ...input(),
      discoveryComplete: false,
      unobservedRegions: [{ regionId: emailQuestionId, reason: 'FRAME_NOT_OBSERVED' }],
    })).toEqual({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
  });

  it('rechecks tentative FILLED ownership after the final leaf before building the ledger', async () => {
    const execute = vi.fn().mockResolvedValue({
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    });
    const finalizeDisposition = vi.fn().mockReturnValue({
      state: 'POLICY_BLOCKED', reason: 'UNDO_UNAVAILABLE',
    });
    const runtime = createPilotUa4WriterRuntime(
      { enabled: true },
      { execute, finalizeDisposition },
    );

    const result = await runtime.execute(input());

    expect(finalizeDisposition).toHaveBeenCalledTimes(1);
    expect(finalizeDisposition).toHaveBeenCalledWith(
      emailQuestionId,
      expect.objectContaining({ state: 'FILLED', undo: 'OWNED' }),
    );
    expect(result).toMatchObject({ ok: true, value: { dispositions: expect.arrayContaining([{
      questionId: emailQuestionId,
      disposition: { state: 'POLICY_BLOCKED', reason: 'UNDO_UNAVAILABLE' },
    }]) } });
  });

  it('turns a host throw into a precise terminal without leaking its message', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('private@example.test'));
    const result = await createPilotUa4WriterRuntime({ enabled: true }, { execute }).execute(input());
    expect(result).toMatchObject({ ok: true, value: { dispositions: expect.arrayContaining([{
      questionId: emailQuestionId,
      disposition: { state: 'POLICY_BLOCKED', reason: 'WRITER_EXECUTION_FAILED' },
    }]) } });
    expect(JSON.stringify(result)).not.toContain('private@example.test');
  });

  it('fails target drift before compilation or host action', async () => {
    const execute = vi.fn();
    const runtime = createPilotUa4WriterRuntime({ enabled: true }, { execute });
    expect(await runtime.execute({
      ...input(), currentBinding: { ...binding, domGeneration: digest(901) },
    })).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['TEXT', 'CONTENTEDITABLE'] as const)(
    'dispatches only an admitted %s leaf and transfers its exact owned Undo', async (controlKind) => {
      const undo = { dispose: vi.fn() };
      const execute = vi.fn(async () => controlKind === 'TEXT'
        ? { ok: true as const, value: { writtenValue: 'kept local', undo } }
        : { ok: true as const, disposition: 'FILLED' as const,
            semanticReadback: 'HOST_ACCEPTED' as const, lateRecheck: 'STABLE' as const, undo });
      const executor = createPilotUa4LeafHostExecutor({
        resolve: () => controlKind === 'TEXT'
          ? { kind: 'TEXT_TRANSACTION', execute: execute as never }
          : { kind: 'EXISTING_KERNEL', control: 'CONTENTEDITABLE', execute: execute as never },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(await executor.execute(leaf(41, controlKind))).toEqual({
        state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(executor.takeUndo(digest(41))).toBe(undo);
      expect(undo.dispose).not.toHaveBeenCalled();
    },
  );

  it('keeps failed-write recovery in the page-local targeted Undo registry', async () => {
    const recovery = { dispose: vi.fn() };
    const executor = createPilotUa4LeafHostExecutor({
      resolve: () => ({
        kind: 'NATIVE_SELECT',
        transaction: {
          write: vi.fn().mockResolvedValue({ ok: false, code: 'HOST_REJECTED', recovery }),
        } as never,
        input: {} as never,
      }),
    });
    const disposition = await executor.execute(leaf(51, 'NATIVE_SELECT'));
    expect(disposition).toEqual({ state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' });
    expect(executor.takeUndo(digest(51))).toBe(recovery);
    expect(recovery.dispose).not.toHaveBeenCalled();
  });

  it('keeps the targeted Undo registry isolated, one-shot, replace-safe, and disposable', async () => {
    const first = { dispose: vi.fn() };
    const replacement = { dispose: vi.fn() };
    const separate = { dispose: vi.fn() };
    const handles = new Map<string, Array<{ dispose(): void }>>([
      [digest(61), [first, replacement]],
      [digest(62), [separate]],
    ]);
    const executor = createPilotUa4LeafHostExecutor({
      resolve: (question) => {
        const undo = handles.get(question.questionId)?.shift();
        return undo === undefined ? null : {
          kind: 'EXISTING_KERNEL',
          control: 'CONTENTEDITABLE',
          execute: async () => ({
            ok: true,
            disposition: 'FILLED',
            semanticReadback: 'HOST_ACCEPTED',
            lateRecheck: 'STABLE',
            undo,
          }),
        };
      },
    });
    const question = (questionId: string) => ({ ...leaf(71, 'CONTENTEDITABLE'), questionId });

    await executor.execute(question(digest(61)));
    await executor.execute(question(digest(62)));
    expect(executor.takeUndo(digest(99))).toBeNull();

    await executor.execute(question(digest(61)));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(separate.dispose).not.toHaveBeenCalled();
    expect(executor.takeUndo(digest(61))).toBe(replacement);
    expect(executor.takeUndo(digest(61))).toBeNull();
    expect(replacement.dispose).not.toHaveBeenCalled();

    executor.dispose();
    expect(separate.dispose).toHaveBeenCalledTimes(1);
    expect(executor.takeUndo(digest(62))).toBeNull();
  });

  it.each(['dispose', 'revokeUndo'] as const)(
    'disposes a late owned handle after executor %s', async (retire) => {
      const owned = { dispose: vi.fn() };
      let settle!: () => void;
      const pending = new Promise<void>((resolve) => { settle = resolve; });
      const executor = createPilotUa4LeafHostExecutor({
        resolve: () => retire === 'dispose' ? {
          kind: 'EXISTING_KERNEL', control: 'CONTENTEDITABLE',
          execute: async () => {
            await pending;
            return { ok: true, disposition: 'FILLED', semanticReadback: 'HOST_ACCEPTED',
              lateRecheck: 'STABLE', undo: owned };
          },
        } : {
          kind: 'NATIVE_SELECT', input: {} as never,
          transaction: { write: async () => {
            await pending;
            return { ok: false, code: 'HOST_REJECTED', recovery: owned };
          } } as never,
        },
      });
      const question = leaf(81, retire === 'dispose' ? 'CONTENTEDITABLE' : 'NATIVE_SELECT');
      const executing = executor.execute(question);
      executor[retire]();
      settle();
      await executing;
      expect(owned.dispose).toHaveBeenCalledTimes(1);
      expect(executor.takeUndo(question.questionId)).toBeNull();
      if (retire === 'dispose') await expect(executor.execute(question)).resolves.toEqual({
        state: 'POLICY_BLOCKED', reason: 'WRITER_EXECUTION_FAILED',
      });
    },
  );
});

function input() {
  return {
    authority,
    currentBinding: binding,
    currentControlIdentityDigests: [d('email'), d('country')],
    nowMs: 1_800_000_010_000,
    semanticEpochs,
    ua2Classifications: [
      {
        identityDigest: d('email'), kind: 'CANONICAL_FIELD' as const, canonicalField: 'EMAIL' as const,
        confidence: 'HIGH' as const,
        provenance: { source: 'AUTOCOMPLETE' as const, semanticDigest: digest(11) },
        reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH' as const,
      },
      {
        identityDigest: d('country'), kind: 'CANONICAL_FIELD' as const, canonicalField: 'COUNTRY' as const,
        confidence: 'HIGH' as const,
        provenance: { source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: digest(12) },
        reasonCode: 'CANONICAL_SEMANTIC_MATCH' as const,
      },
    ],
    semanticDigest: sha256,
    payloadRefs: [{ questionId: emailQuestionId, payloadRef: 'local.answer.email' }],
    discoveryComplete: true,
    preResolvedDispositions: [],
  };
}

it.each(['throw', 'malformed'] as const)('preserves possible writes when fill-only batch finalization is %s', async (scenario) => {
  const runtime = createPilotUa4WriterRuntime({ enabled: true }, {
    execute: async () => ({ state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'FROZEN' }),
    finalizeDisposition: () => {
      if (scenario === 'throw') throw new Error('SYNTHETIC_FINALIZATION_FAILURE');
      return { state: 'UNKNOWN' } as never;
    },
  });
  const result = await runtime.execute({ ...input(), authority: { ...authority, constraints: { ...authority.constraints, undo: 'FROZEN' } } });
  if (!result.ok) throw new Error('EXPECTED_LEDGER');
  expect(result.value.dispositions.find((entry) => entry.questionId === emailQuestionId)?.disposition)
    .toEqual({ state: 'POLICY_BLOCKED', reason: 'WRITER_EXECUTION_FAILED', writeEffect: 'MAY_HAVE_CHANGED' });
});

it('requires explicit null from a fill-only final observation and rejects an absent verdict', async () => {
  const dispose = vi.fn();
  const executor = createPilotUa4LeafHostExecutor({ resolve: () => ({ kind: 'TEXT_FILL_ONLY',
    execute: async () => ({ ok: true, observation: { check: () => null, finalize: () => undefined as never, dispose } }),
  }) });
  const question = { ...leaf(501, 'TEXT'), undoPolicy: 'FROZEN' as const };
  const tentative = await executor.execute(question);
  expect(tentative.state).toBe('FILLED');
  expect(executor.finalizeDisposition?.(question.questionId, tentative))
    .toMatchObject({ state: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' });
  expect(dispose).toHaveBeenCalledTimes(1);
});
