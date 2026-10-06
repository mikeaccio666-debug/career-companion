import { describe, expect, it, vi } from 'vitest';

const leafMocks = vi.hoisted(() => ({
  text: vi.fn(),
  date: vi.fn(),
  file: vi.fn(),
}));

vi.mock('../src/write/textSemanticSettlement.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/write/textSemanticSettlement.ts')>(),
  settleTextSemanticWrite: leafMocks.text,
}));
vi.mock('../src/write/dateSemanticTransaction.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/write/dateSemanticTransaction.ts')>(),
  writeDateSemanticTransaction: leafMocks.date,
}));
vi.mock('../src/write/fileSemanticSettle.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/write/fileSemanticSettle.ts')>(),
  settleResumeFileWrite: leafMocks.file,
}));

import type {
  PilotUa4FinalDisposition,
  PilotUa4WriteAuthority,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import { APPLY_ERROR_CODES } from '../src/contracts';
import {
  buildPilotUa4TerminalLedger,
  executePilotUa4Leaf,
  pilotUa4DispositionToApplyFailure,
  preparePilotUa4WriterBatch,
} from '../src/pilotUa4Writer';
import { compileGraph } from '../src/semantic/graph';
import { compiledEpochs, d, sha256, type Vector } from './semantic/harness';

const digest = (ordinal: number): string => ordinal.toString(16).padStart(64, '0');
const vector: Vector = {
  id: 'ua4-writer-admission',
  scenarioClass: 'UA4',
  title: 'one writable text and one incomplete select',
  todayBehavior: 'default-off',
  origin: 'https://careers.example.test',
  pathname: '/jobs/engineer',
  epochs: [{
    cause: 'USER_TRIGGER',
    domGeneration: digest(900),
    sidecar: true,
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
const graphResult = compileGraph(semanticEpochs, sha256);
if (!graphResult.ok) throw new Error('fixture compiler failed');
const emailNode = graphResult.graph.nodes.find((node) => node.control.members.some((m) => m.identityDigest === d('email')));
const countryNode = graphResult.graph.nodes.find((node) => node.control.members.some((m) => m.identityDigest === d('country')));
if (emailNode?.kind !== 'QUESTION' || countryNode?.kind !== 'QUESTION') throw new Error('fixture node missing');
const emailQuestionId = emailNode.id;
const countryQuestionId = countryNode.id;
const binding = semanticEpochs[0]!.binding;
const ua2Classifications = vector.epochs[0]!.ua2
  ? [
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
    ]
  : [];
const authority: PilotUa4WriteAuthority = {
  authorityId: digest(99),
  binding,
  pageIdentityDigest: digest(88),
  observedControlIdentityDigests: [d('email'), d('country')],
  expiresAtMs: 1_800_000_030_000,
  questionAuthorizations: [{
    questionId: emailQuestionId,
    controlKind: 'TEXT',
    identityDigests: [d('email')],
    required: true,
    answerAuthority: 'PROFILE_CONFIRMED',
    answerDigest: digest(91),
  }],
  blockedQuestions: [{
    questionId: countryQuestionId,
    controlKind: 'NATIVE_SELECT',
    identityDigests: [d('country')],
    required: true,
    code: 'OPTIONS_INCOMPLETE',
  }],
  constraints: {
    exactTargetBinding: 'REQUIRED', semanticReadback: 'REQUIRED', hostValidation: 'REQUIRED',
    lateRecheck: 'REQUIRED', undo: 'REQUIRED', submit: 'FORBIDDEN',
    activationState: 'DEFAULT_OFF', releaseState: 'NOT_RELEASED',
  },
};

describe('UA-4 semantic compiler admission and terminal ledger', () => {
  /**
   * The two block codes are different facts about different things, and the
   * disposition has to follow the code rather than the position in the list.
   */
  it('reports an unresolved answer authority as a missing answer, not an options fact', () => {
    // The email question is complete and writable; only its answer is missing.
    const result = preparePilotUa4WriterBatch({
      ...preparedInput(),
      payloadRefs: [],
      authority: {
        ...authority,
        questionAuthorizations: [],
        blockedQuestions: [{
          questionId: emailQuestionId,
          controlKind: 'TEXT',
          identityDigests: [d('email')],
          required: true,
          code: 'ANSWER_AUTHORITY_NOT_RESOLVED',
        }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reading this as OPTIONS_INCOMPLETE failed the whole compile, because the
    // question's option set is complete -- the missing answer disappeared behind
    // a writer-unavailable result.
    expect(result.value.dispositions).toContainEqual({
      questionId: emailQuestionId,
      disposition: { state: 'USER_CONFIRMATION_REQUIRED', reason: 'ANSWER_AUTHORITY_MISSING' },
    });
    // And it is never handed to a host to write.
    expect(result.value.questions).toEqual([]);
  });

  it('refuses an OPTIONS_INCOMPLETE block for a question that has no option set', () => {
    // The code has to match the structure it claims, in both directions. Here
    // the wire itself refuses it, because the options code is only defined for
    // the four option-bearing control kinds.
    expect(preparePilotUa4WriterBatch({
      ...preparedInput(),
      payloadRefs: [],
      authority: {
        ...authority,
        questionAuthorizations: [],
        blockedQuestions: [{
          questionId: emailQuestionId,
          controlKind: 'TEXT',
          identityDigests: [d('email')],
          required: true,
          code: 'OPTIONS_INCOMPLETE',
        } as unknown as PilotUa4WriteAuthority['blockedQuestions'][number]],
      },
    })).toEqual({ ok: false, code: 'PILOT_WRITE_AUTHORITY_INPUT_INVALID' });
  });

  it('derives its denominator and writable questions from the unique #164 compiler', () => {
    const result = preparePilotUa4WriterBatch(preparedInput());
    expect(result).toMatchObject({
      ok: true,
      value: {
        questions: [{
          questionId: emailQuestionId,
          controlKind: 'TEXT',
          compilerControlKind: 'TEXT_SINGLE',
          identityDigests: [d('email')],
          required: true,
          answerDigest: digest(91),
          payloadRef: 'local.answer.email',
        }],
        denominatorQuestions: [
          { questionId: emailQuestionId, required: true },
          { questionId: countryQuestionId, required: true },
        ],
        dispositions: [{
          questionId: countryQuestionId,
          disposition: { state: 'POLICY_BLOCKED', reason: 'OPTIONS_INCOMPLETE' },
        }],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/selector|answerValue|javascript/i);
  });

  it('fails closed on target drift, compile failure, forged payload routing, and grouping drift', () => {
    const input = preparedInput();
    expect(preparePilotUa4WriterBatch({
      ...input,
      currentBinding: { ...binding, domGeneration: digest(901) },
    })).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(preparePilotUa4WriterBatch({ ...input, semanticEpochs: [] })).toEqual({
      ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE',
    });
    expect(preparePilotUa4WriterBatch({
      ...input,
      payloadRefs: [{ questionId: countryQuestionId, payloadRef: 'local.answer.email' }],
    })).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    expect(preparePilotUa4WriterBatch({
      ...input,
      authority: {
        ...authority,
        blockedQuestions: [],
        questionAuthorizations: [{ ...authority.questionAuthorizations[0]!, identityDigests: [d('country')] }],
      },
    })).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    for (const controlKind of ['PASSWORD', 'BUTTON', 'SUBMIT']) {
      expect(preparePilotUa4WriterBatch({
        ...input,
        authority: {
          ...authority,
          blockedQuestions: [],
          questionAuthorizations: [{ ...authority.questionAuthorizations[0]!, controlKind }],
        },
      })).toEqual({ ok: false, code: 'PILOT_WRITE_AUTHORITY_INPUT_INVALID' });
    }
  });

  it.each([
    {
      kind: 'HUMAN_ACTION_REQUIRED' as const,
      canonicalField: null,
      confidence: 'HIGH' as const,
      provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(21) },
      reasonCode: 'HUMAN_ACTION_CONTROL' as const,
    },
    {
      kind: 'HUMAN_ACTION_REQUIRED' as const,
      canonicalField: null,
      confidence: 'HIGH' as const,
      provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(23) },
      reasonCode: 'HUMAN_PASSWORD_CONTROL' as const,
    },
    {
      kind: 'HUMAN_ACTION_REQUIRED' as const,
      canonicalField: null,
      confidence: 'HIGH' as const,
      provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(24) },
      reasonCode: 'HUMAN_SUBMIT_CONTROL' as const,
    },
    {
      kind: 'UNRESOLVED' as const,
      canonicalField: null,
      confidence: 'LOW' as const,
      provenance: { source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: digest(22) },
      reasonCode: 'SEMANTIC_CLASSIFICATION_UNRESOLVED' as const,
    },
  ])('rejects a forged writer authority for $kind classifications', (classification) => {
    const input = preparedInput();
    expect(preparePilotUa4WriterBatch({
      ...input,
      ua2Classifications: [
        { identityDigest: d('email'), ...classification },
        input.ua2Classifications[1]!,
      ],
    })).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
  });

  it.each([
    {
      classification: {
        kind: 'HUMAN_ACTION_REQUIRED' as const,
        canonicalField: null,
        confidence: 'HIGH' as const,
        provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(21) },
        reasonCode: 'HUMAN_ACTION_CONTROL' as const,
      },
      disposition: { state: 'MANUAL_REQUIRED', reason: 'HUMAN_ACTION' },
    },
    {
      classification: {
        kind: 'HUMAN_ACTION_REQUIRED' as const,
        canonicalField: null,
        confidence: 'HIGH' as const,
        provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(23) },
        reasonCode: 'HUMAN_PASSWORD_CONTROL' as const,
      },
      disposition: { state: 'MANUAL_REQUIRED', reason: 'PASSWORD' },
    },
    {
      classification: {
        kind: 'HUMAN_ACTION_REQUIRED' as const,
        canonicalField: null,
        confidence: 'HIGH' as const,
        provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(24) },
        reasonCode: 'HUMAN_SUBMIT_CONTROL' as const,
      },
      disposition: { state: 'MANUAL_REQUIRED', reason: 'FINAL_SUBMIT' },
    },
    {
      classification: {
        kind: 'UNRESOLVED' as const,
        canonicalField: null,
        confidence: 'LOW' as const,
        provenance: { source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: digest(22) },
        reasonCode: 'SEMANTIC_CLASSIFICATION_UNRESOLVED' as const,
      },
      disposition: { state: 'USER_CONFIRMATION_REQUIRED', reason: 'ANSWER_AUTHORITY_MISSING' },
    },
  ])('turns non-writable $classification.kind classifications into terminal dispositions', ({
    classification,
    disposition,
  }) => {
    const input = preparedInput();
    const result = preparePilotUa4WriterBatch({
      ...input,
      authority: { ...authority, questionAuthorizations: [] },
      payloadRefs: [],
      ua2Classifications: [
        { identityDigest: d('email'), ...classification },
        input.ua2Classifications[1]!,
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        questions: [],
        dispositions: [
          { questionId: emailQuestionId, disposition },
          {
            questionId: countryQuestionId,
            disposition: { state: 'POLICY_BLOCKED', reason: 'OPTIONS_INCOMPLETE' },
          },
        ],
      },
    });
  });

  it('blocks a trusted answer when the compiler detects an other-person stem', () => {
    const guardedVector: Vector = {
      id: 'ua4-other-person-admission',
      scenarioClass: 'UA4',
      title: 'other-person text is terminal-only',
      todayBehavior: 'default-off',
      origin: vector.origin,
      pathname: vector.pathname,
      epochs: [{
        cause: 'USER_TRIGGER', domGeneration: digest(910), sidecar: true,
        controls: [{
          ref: 'reference_email', shape: 'EMAIL', required: true,
          accessibleName: 'Reference email',
        }],
        ua2: { reference_email: { kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' } },
      }],
      expected: {},
    };
    const epochs = compiledEpochs(guardedVector);
    const compiled = compileGraph(epochs, sha256);
    if (!compiled.ok) throw new Error('guarded fixture compiler failed');
    const node = compiled.graph.nodes.find((entry) => entry.kind === 'QUESTION');
    if (node?.kind !== 'QUESTION') throw new Error('guarded fixture node missing');
    const guardedAuthority: PilotUa4WriteAuthority = {
      ...authority,
      binding: epochs[0]!.binding,
      observedControlIdentityDigests: [d('reference_email')],
      questionAuthorizations: [],
      blockedQuestions: [],
    };
    expect(preparePilotUa4WriterBatch({
      authority: guardedAuthority,
      currentBinding: epochs[0]!.binding,
      currentControlIdentityDigests: [d('reference_email')],
      nowMs: 1_800_000_010_000,
      semanticEpochs: epochs,
      ua2Classifications: [{
        identityDigest: d('reference_email'),
        kind: 'CANONICAL_FIELD',
        canonicalField: 'EMAIL',
        confidence: 'HIGH',
        provenance: { source: 'AUTOCOMPLETE', semanticDigest: digest(25) },
        reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
      }],
      semanticDigest: sha256,
      payloadRefs: [],
    })).toMatchObject({
      ok: true,
      value: {
        questions: [],
        dispositions: [{
          questionId: node.id,
          disposition: { state: 'MANUAL_REQUIRED', reason: 'OTHER_PERSON' },
        }],
      },
    });
  });

  it('keeps a structural password control manual even though it has no writer kind', () => {
    const passwordVector: Vector = {
      id: 'ua4-password-boundary',
      scenarioClass: 'UA4',
      title: 'password is terminal-only',
      todayBehavior: 'default-off',
      origin: vector.origin,
      pathname: vector.pathname,
      epochs: [{
        cause: 'USER_TRIGGER', domGeneration: digest(915), sidecar: true,
        controls: [{ ref: 'password', shape: 'PASSWORD', required: true, accessibleName: 'Password' }],
        ua2: { password: { kind: 'HUMAN_ACTION_REQUIRED', reasonCode: 'HUMAN_PASSWORD_CONTROL' } },
      }],
      expected: {},
    };
    const epochs = compiledEpochs(passwordVector);
    const compiled = compileGraph(epochs, sha256);
    if (!compiled.ok) throw new Error('password fixture compiler failed');
    const node = compiled.graph.nodes.find((entry) => entry.kind === 'QUESTION');
    if (node?.kind !== 'QUESTION') throw new Error('password fixture node missing');
    const passwordAuthority: PilotUa4WriteAuthority = {
      ...authority,
      binding: epochs[0]!.binding,
      observedControlIdentityDigests: [d('password')],
      questionAuthorizations: [],
      blockedQuestions: [],
    };
    expect(preparePilotUa4WriterBatch({
      authority: passwordAuthority,
      currentBinding: epochs[0]!.binding,
      currentControlIdentityDigests: [d('password')],
      nowMs: 1_800_000_010_000,
      semanticEpochs: epochs,
      ua2Classifications: [{
        identityDigest: d('password'),
        kind: 'HUMAN_ACTION_REQUIRED',
        canonicalField: null,
        confidence: 'HIGH',
        provenance: { source: 'CONTROL_SEMANTICS', semanticDigest: digest(26) },
        reasonCode: 'HUMAN_PASSWORD_CONTROL',
      }],
      semanticDigest: sha256,
      payloadRefs: [],
    })).toMatchObject({
      ok: true,
      value: {
        questions: [],
        dispositions: [{
          questionId: node.id,
          disposition: { state: 'MANUAL_REQUIRED', reason: 'PASSWORD' },
        }],
      },
    });
  });

  it('rejects a forged choice-group authority when UA-2 members conflict', () => {
    const conflictVector: Vector = {
      id: 'ua4-choice-conflict',
      scenarioClass: 'UA4',
      title: 'conflicting group members are terminal-only',
      todayBehavior: 'default-off',
      origin: vector.origin,
      pathname: vector.pathname,
      epochs: [{
        cause: 'USER_TRIGGER', domGeneration: digest(920), sidecar: true,
        controls: [
          {
            ref: 'schedule_yes', shape: 'RADIO', required: true, label: 'Yes',
            legend: 'Preferred schedule', groupKey: 'schedule',
          },
          {
            ref: 'schedule_no', shape: 'RADIO', label: 'No',
            legend: 'Preferred schedule', groupKey: 'schedule',
          },
        ],
        ua2: {
          schedule_yes: { kind: 'STRUCTURED_CHOICE' },
          schedule_no: { kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' },
        },
      }],
      expected: {},
    };
    const epochs = compiledEpochs(conflictVector);
    const compiled = compileGraph(epochs, sha256);
    if (!compiled.ok) throw new Error('conflict fixture compiler failed');
    const node = compiled.graph.nodes.find((entry) => entry.kind === 'QUESTION');
    if (node?.kind !== 'QUESTION') throw new Error('conflict fixture node missing');
    const conflictAuthority: PilotUa4WriteAuthority = {
      ...authority,
      binding: epochs[0]!.binding,
      observedControlIdentityDigests: [d('schedule_yes'), d('schedule_no')],
      questionAuthorizations: [{
        questionId: node.id,
        controlKind: 'RADIO_GROUP',
        identityDigests: [d('schedule_yes'), d('schedule_no')],
        required: true,
        answerAuthority: 'USER_CONFIRMED',
        answerDigest: digest(93),
      }],
      blockedQuestions: [],
    };
    expect(preparePilotUa4WriterBatch({
      authority: conflictAuthority,
      currentBinding: epochs[0]!.binding,
      currentControlIdentityDigests: [d('schedule_yes'), d('schedule_no')],
      nowMs: 1_800_000_010_000,
      semanticEpochs: epochs,
      ua2Classifications: [
        {
          identityDigest: d('schedule_yes'), kind: 'STRUCTURED_CHOICE', canonicalField: null,
          confidence: 'HIGH', provenance: { source: 'CONTROL_SEMANTICS', semanticDigest: digest(26) },
          reasonCode: 'STRUCTURED_CHOICE_CONTROL',
        },
        {
          identityDigest: d('schedule_no'), kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL',
          confidence: 'HIGH', provenance: { source: 'AUTOCOMPLETE', semanticDigest: digest(27) },
          reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
        },
      ],
      semanticDigest: sha256,
      payloadRefs: [{ questionId: node.id, payloadRef: 'local.answer.schedule' }],
    })).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
  });

  it('keeps a MEMBER_UNCLASSIFIED group terminal-only before any host executor', async () => {
    const memberVector: Vector = {
      id: 'ua4-member-unclassified', scenarioClass: 'UA4',
      title: 'one choice member has no UA-2 classification', todayBehavior: 'default-off',
      origin: vector.origin, pathname: vector.pathname,
      epochs: [{
        cause: 'USER_TRIGGER', domGeneration: digest(921), sidecar: true,
        controls: [
          { ref: 'schedule_yes', shape: 'RADIO', required: true, label: 'Yes', legend: 'Schedule', groupKey: 'schedule' },
          { ref: 'schedule_no', shape: 'RADIO', label: 'No', legend: 'Schedule', groupKey: 'schedule' },
        ],
        ua2: { schedule_yes: { kind: 'STRUCTURED_CHOICE' } },
      }],
      expected: {},
    };
    const epochs = compiledEpochs(memberVector);
    const compiled = compileGraph(epochs, sha256);
    if (!compiled.ok) throw new Error('member-unclassified fixture compiler failed');
    const node = compiled.graph.nodes.find((entry) => entry.kind === 'QUESTION');
    if (node?.kind !== 'QUESTION') throw new Error('member-unclassified fixture node missing');
    const ids = [d('schedule_yes'), d('schedule_no')];
    const forgedAuthority: PilotUa4WriteAuthority = {
      ...authority, binding: epochs[0]!.binding, observedControlIdentityDigests: ids,
      questionAuthorizations: [{
        questionId: node.id, controlKind: 'RADIO_GROUP', identityDigests: ids, required: true,
        answerAuthority: 'USER_CONFIRMED', answerDigest: digest(94),
      }],
      blockedQuestions: [],
    };
    const common = {
      currentBinding: epochs[0]!.binding,
      currentControlIdentityDigests: ids,
      nowMs: 1_800_000_010_000,
      semanticEpochs: epochs,
      ua2Classifications: [{
        identityDigest: d('schedule_yes'), kind: 'STRUCTURED_CHOICE' as const, canonicalField: null,
        confidence: 'HIGH' as const,
        provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(31) },
        reasonCode: 'STRUCTURED_CHOICE_CONTROL' as const,
      }],
      semanticDigest: sha256,
    };
    const hostExecutor = vi.fn();
    const forged = preparePilotUa4WriterBatch({
      ...common,
      authority: forgedAuthority,
      payloadRefs: [{ questionId: node.id, payloadRef: 'local.answer.schedule' }],
    });
    if (forged.ok) await Promise.all(forged.value.questions.map(hostExecutor));
    expect(forged).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    expect(hostExecutor).not.toHaveBeenCalled();
    expect(preparePilotUa4WriterBatch({
      ...common,
      authority: { ...forgedAuthority, questionAuthorizations: [] },
      payloadRefs: [],
    })).toMatchObject({
      ok: true,
      value: { questions: [], dispositions: [{
        questionId: node.id,
        disposition: { state: 'USER_CONFIRMATION_REQUIRED', reason: 'ANSWER_AUTHORITY_MISSING' },
      }] },
    });
  });

  it('keeps duplicate root stems terminal-only before any host executor', async () => {
    const duplicateVector: Vector = {
      id: 'ua4-duplicate-root-stem', scenarioClass: 'UA4',
      title: 'duplicate root company questions', todayBehavior: 'default-off',
      origin: vector.origin, pathname: vector.pathname,
      epochs: [{
        cause: 'USER_TRIGGER', domGeneration: digest(922), sidecar: true,
        controls: [
          { ref: 'company_a', shape: 'TEXT', required: true, label: 'Company' },
          { ref: 'company_b', shape: 'TEXT', required: true, label: 'Company' },
        ],
        ua2: {
          company_a: { kind: 'CANONICAL_FIELD', canonicalField: 'ORGANIZATION' },
          company_b: { kind: 'CANONICAL_FIELD', canonicalField: 'ORGANIZATION' },
        },
      }],
      expected: {},
    };
    const epochs = compiledEpochs(duplicateVector);
    const compiled = compileGraph(epochs, sha256);
    if (!compiled.ok) throw new Error('duplicate-stem fixture compiler failed');
    const nodes = compiled.graph.nodes.filter((entry) => entry.kind === 'QUESTION');
    if (nodes.length !== 2) throw new Error('duplicate-stem fixture nodes missing');
    const first = nodes[0]!;
    const ids = [d('company_a'), d('company_b')];
    const classifications = ids.map((identityDigest, index) => ({
      identityDigest,
      kind: 'CANONICAL_FIELD' as const,
      canonicalField: 'ORGANIZATION' as const,
      confidence: 'HIGH' as const,
      provenance: { source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: digest(32 + index) },
      reasonCode: 'CANONICAL_SEMANTIC_MATCH' as const,
    }));
    const forgedAuthority: PilotUa4WriteAuthority = {
      ...authority, binding: epochs[0]!.binding, observedControlIdentityDigests: ids,
      questionAuthorizations: [{
        questionId: first.id, controlKind: 'TEXT', identityDigests: [first.control.members[0]!.identityDigest],
        required: true, answerAuthority: 'PROFILE_CONFIRMED', answerDigest: digest(95),
      }],
      blockedQuestions: [],
    };
    const common = {
      currentBinding: epochs[0]!.binding,
      currentControlIdentityDigests: ids,
      nowMs: 1_800_000_010_000,
      semanticEpochs: epochs,
      ua2Classifications: classifications,
      semanticDigest: sha256,
    };
    const hostExecutor = vi.fn();
    const forged = preparePilotUa4WriterBatch({
      ...common,
      authority: forgedAuthority,
      payloadRefs: [{ questionId: first.id, payloadRef: 'local.answer.company' }],
    });
    if (forged.ok) await Promise.all(forged.value.questions.map(hostExecutor));
    expect(forged).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    expect(hostExecutor).not.toHaveBeenCalled();
    const terminal = preparePilotUa4WriterBatch({
      ...common,
      authority: { ...forgedAuthority, questionAuthorizations: [] },
      payloadRefs: [],
    });
    expect(terminal).toMatchObject({ ok: true, value: { questions: [] } });
    if (!terminal.ok) return;
    expect(terminal.value.dispositions).toHaveLength(2);
    expect(terminal.value.dispositions).toEqual(expect.arrayContaining(nodes.map((node) => ({
      questionId: node.id,
      disposition: { state: 'USER_CONFIRMATION_REQUIRED', reason: 'ANSWER_AUTHORITY_MISSING' },
    }))));
  });

  it('keeps a generic sensitive non-NONE stem guard terminal-only before any host executor', async () => {
    const sensitiveVector: Vector = {
      id: 'ua4-sensitive-stem', scenarioClass: 'UA4',
      title: 'job-dependent salary question', todayBehavior: 'default-off',
      origin: vector.origin, pathname: vector.pathname,
      epochs: [{
        cause: 'USER_TRIGGER', domGeneration: digest(923), sidecar: true,
        controls: [{ ref: 'salary', shape: 'TEXT', required: true, label: 'Expected salary' }],
        ua2: { salary: { kind: 'OPEN_QUESTION' } },
      }],
      expected: {},
    };
    const epochs = compiledEpochs(sensitiveVector);
    const compiled = compileGraph(epochs, sha256);
    if (!compiled.ok) throw new Error('sensitive-stem fixture compiler failed');
    const node = compiled.graph.nodes.find((entry) => entry.kind === 'QUESTION');
    if (node?.kind !== 'QUESTION') throw new Error('sensitive-stem fixture node missing');
    const classification = {
      identityDigest: d('salary'), kind: 'OPEN_QUESTION' as const, canonicalField: null,
      confidence: 'HIGH' as const,
      provenance: { source: 'CONTROL_SEMANTICS' as const, semanticDigest: digest(34) },
      reasonCode: 'OPEN_QUESTION_CONTROL' as const,
    };
    const forgedAuthority: PilotUa4WriteAuthority = {
      ...authority, binding: epochs[0]!.binding, observedControlIdentityDigests: [d('salary')],
      questionAuthorizations: [{
        questionId: node.id, controlKind: 'TEXT', identityDigests: [d('salary')], required: true,
        answerAuthority: 'USER_CONFIRMED', answerDigest: digest(96),
      }],
      blockedQuestions: [],
    };
    const common = {
      currentBinding: epochs[0]!.binding,
      currentControlIdentityDigests: [d('salary')],
      nowMs: 1_800_000_010_000,
      semanticEpochs: epochs,
      ua2Classifications: [classification],
      semanticDigest: sha256,
    };
    const hostExecutor = vi.fn();
    const forged = preparePilotUa4WriterBatch({
      ...common,
      authority: forgedAuthority,
      payloadRefs: [{ questionId: node.id, payloadRef: 'local.answer.salary' }],
    });
    if (forged.ok) await Promise.all(forged.value.questions.map(hostExecutor));
    expect(forged).toEqual({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    expect(hostExecutor).not.toHaveBeenCalled();
    expect(preparePilotUa4WriterBatch({
      ...common,
      authority: { ...forgedAuthority, questionAuthorizations: [] },
      payloadRefs: [],
    })).toMatchObject({
      ok: true,
      value: { questions: [], dispositions: [{
        questionId: node.id,
        disposition: { state: 'USER_CONFIRMATION_REQUIRED', reason: 'SENSITIVE_CONFIRMATION' },
      }] },
    });
  });

  it('closes every compiler question and computes coverage instead of trusting a sentinel', () => {
    const filled: PilotUa4FinalDisposition = {
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    };
    const questions = [
      { questionId: emailQuestionId, required: true },
      { questionId: countryQuestionId, required: true },
    ];
    expect(buildPilotUa4TerminalLedger({
      binding,
      discoveryComplete: true,
      questions,
      dispositions: [
        { questionId: emailQuestionId, disposition: filled },
        { questionId: countryQuestionId, disposition: { state: 'POLICY_BLOCKED', reason: 'OPTIONS_INCOMPLETE' } },
      ],
    })).toMatchObject({ ok: true, value: { summary: { requiredFieldFinalDispositionCoverage: 100 } } });
    expect(buildPilotUa4TerminalLedger({
      binding, discoveryComplete: true, questions,
      dispositions: [{ questionId: emailQuestionId, disposition: filled }],
    })).toEqual({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
  });

  it('carries an unobserved region beside the questions and refuses a whole-page claim over it', () => {
    const filled: PilotUa4FinalDisposition = {
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    };
    const questions = [{ questionId: emailQuestionId, required: true }];
    const dispositions = [{ questionId: emailQuestionId, disposition: filled }];
    const region = { regionId: d('frame'), reason: 'FRAME_NOT_OBSERVED' as const };
    const built = buildPilotUa4TerminalLedger({
      binding, discoveryComplete: false, questions, dispositions, unobservedRegions: [region],
    });
    expect(built).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 2,
        discoveryComplete: false,
        questions,
        dispositions,
        unobservedRegions: [region],
        summary: { observableQuestions: 1, requiredFieldFinalDispositionCoverage: 100, unobservedRegions: 1 },
      },
    });
    expect(buildPilotUa4TerminalLedger({
      binding, discoveryComplete: true, questions, dispositions, unobservedRegions: [region],
    })).toEqual({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
    expect(buildPilotUa4TerminalLedger({
      binding, discoveryComplete: false, questions, dispositions,
      unobservedRegions: [{ regionId: emailQuestionId, reason: 'FRAME_NOT_OBSERVED' }],
    })).toEqual({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
    // No region given: the section is present and empty, and the claim stands.
    expect(buildPilotUa4TerminalLedger({ binding, discoveryComplete: true, questions, dispositions }))
      .toMatchObject({ ok: true, value: { unobservedRegions: [], summary: { unobservedRegions: 0 } } });
  });

  it('maps OPTIONS_INCOMPLETE to FAILED/blockedByUs, never manual unsupported', () => {
    expect(APPLY_ERROR_CODES).toContain('OPTIONS_INCOMPLETE');
    expect(pilotUa4DispositionToApplyFailure({
      state: 'POLICY_BLOCKED', reason: 'OPTIONS_INCOMPLETE',
    })).toEqual({ ok: false, reason: 'OPTIONS_INCOMPLETE' });
  });

  it('requires semantic proof before reporting PREFILLED and rejects a mismatched leaf', async () => {
    const question = {
      questionId: emailQuestionId,
      controlKind: 'TEXT' as const,
      compilerControlKind: 'TEXT_SINGLE' as const,
      identityDigests: [d('email')],
      required: true,
      rowToken: null,
      answerDigest: digest(91),
      payloadRef: 'local.answer.email',
      classification: null,
    };
    expect(await executePilotUa4Leaf(question, {
      kind: 'PREFILLED',
      readCurrentSemantic: () => false,
    })).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
      undo: null,
    });
    expect(await executePilotUa4Leaf(question, {
      kind: 'PREFILLED',
      readCurrentSemantic: () => true,
    })).toEqual({
      disposition: { state: 'PREFILLED', semanticReadback: 'CURRENT' },
      undo: null,
    });
    expect(await executePilotUa4Leaf(question, {
      kind: 'FILE',
      input: {} as never,
    })).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' },
      undo: null,
    });
  });

  it('retains the exact owned recovery for TEXT_SETTLE, DATE, and FILE verification failures', async () => {
    const textRecovery = { dispose: vi.fn() };
    leafMocks.text.mockResolvedValueOnce({
      ok: false, code: 'LATE_REVERTED', recovery: textRecovery,
    });
    const textResult = await executePilotUa4Leaf({
      questionId: 'question.text', controlKind: 'TEXT', compilerControlKind: 'TEXT_SINGLE',
      identityDigests: [digest(61)], required: true, rowToken: null,
      answerDigest: digest(62), payloadRef: 'local.answer.text', classification: null,
    }, { kind: 'TEXT_SETTLE', input: {} as never });
    expect(textResult).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'LATE_REVERTED' },
      undo: textRecovery,
    });
    expect(textRecovery.dispose).not.toHaveBeenCalled();

    const dateRecovery = { dispose: vi.fn() };
    leafMocks.date.mockResolvedValueOnce({
      ok: false, code: 'HOST_REJECTED', recovery: dateRecovery,
    });
    const dateResult = await executePilotUa4Leaf({
      questionId: 'question.date', controlKind: 'DATE', compilerControlKind: 'DATE',
      identityDigests: [digest(63)], required: true, rowToken: null,
      answerDigest: digest(64), payloadRef: 'local.answer.date', classification: null,
    }, { kind: 'DATE', input: {} as never });
    expect(dateResult).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
      undo: dateRecovery,
    });
    expect(dateRecovery.dispose).not.toHaveBeenCalled();

    const fileRecovery = { dispose: vi.fn() };
    leafMocks.file.mockResolvedValueOnce({
      ok: false, code: 'FILE_HOST_REJECTED', recovery: fileRecovery,
    });
    const fileResult = await executePilotUa4Leaf({
      questionId: 'question.file', controlKind: 'FILE', compilerControlKind: 'FILE',
      identityDigests: [digest(65)], required: true, rowToken: null,
      answerDigest: digest(66), payloadRef: 'local.answer.file', classification: null,
    }, { kind: 'FILE', input: {} as never });
    expect(fileResult).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
      undo: fileRecovery,
    });
    expect(fileRecovery.dispose).not.toHaveBeenCalled();
  });

  it('retains owned recovery after native-select and choice verification failures', async () => {
    const nativeUndo = { dispose: vi.fn() };
    const nativeQuestion = {
      questionId: 'question.native',
      controlKind: 'NATIVE_SELECT' as const,
      compilerControlKind: 'SELECT_ONE' as const,
      identityDigests: [digest(31)],
      required: true,
      rowToken: null,
      answerDigest: digest(32),
      payloadRef: 'local.answer.native',
      classification: null,
    };
    const nativeResult = await executePilotUa4Leaf(nativeQuestion, {
      kind: 'NATIVE_SELECT',
      transaction: {
        write: vi.fn().mockResolvedValue({ ok: false, code: 'HOST_REJECTED', recovery: nativeUndo }),
      } as never,
      input: {} as never,
    });
    expect(nativeResult).toMatchObject({
      disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
      undo: nativeUndo,
    });

    const choiceUndo = {
      wasExternallyEdited: vi.fn(() => false),
      isAtWrittenState: vi.fn(() => true),
      restorePreWrite: vi.fn(),
      dispose: vi.fn(),
    };
    const choiceQuestion = {
      ...nativeQuestion,
      questionId: 'question.choice',
      controlKind: 'RADIO_GROUP' as const,
      compilerControlKind: 'RADIO_GROUP' as const,
    };
    const choiceResult = await executePilotUa4Leaf(choiceQuestion, {
      kind: 'CHOICE_GROUP',
      group: {
        write: vi.fn().mockResolvedValue({
          ok: true,
          value: { undo: choiceUndo },
        }),
      } as never,
      input: {} as never,
      readHostAccepted: () => false,
      lateRecheckMs: 1,
    });
    expect(choiceResult).toMatchObject({
      disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
      undo: choiceUndo,
    });
    expect(choiceUndo.dispose).not.toHaveBeenCalled();
  });

  it('retains choice recovery for both non-ok and late-reverted outcomes', async () => {
    const question = {
      questionId: 'question.choice.recovery',
      controlKind: 'RADIO_GROUP' as const,
      compilerControlKind: 'RADIO_GROUP' as const,
      identityDigests: [digest(71), digest(72)],
      required: true,
      rowToken: null,
      answerDigest: digest(73),
      payloadRef: 'local.answer.choice',
      classification: null,
    };
    const nonOkUndo = {
      wasExternallyEdited: vi.fn(() => false),
      isAtWrittenState: vi.fn(() => true),
      restorePreWrite: vi.fn(),
      dispose: vi.fn(),
    };
    const nonOk = await executePilotUa4Leaf(question, {
      kind: 'CHOICE_GROUP',
      group: {
        write: vi.fn().mockResolvedValue({ ok: false, error: 'VERIFY_FAILED', undo: nonOkUndo }),
      } as never,
      input: {} as never,
      readHostAccepted: vi.fn(() => true),
      lateRecheckMs: 1,
      lateRecheckDelay: vi.fn(),
    });
    expect(nonOk).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
      undo: nonOkUndo,
    });
    expect(nonOkUndo.dispose).not.toHaveBeenCalled();

    const lateUndo = {
      wasExternallyEdited: vi.fn(() => true),
      isAtWrittenState: vi.fn(() => true),
      restorePreWrite: vi.fn(),
      dispose: vi.fn(),
    };
    const lateDelay = vi.fn();
    const late = await executePilotUa4Leaf(question, {
      kind: 'CHOICE_GROUP',
      group: {
        write: vi.fn().mockResolvedValue({ ok: true, value: { undo: lateUndo } }),
      } as never,
      input: {} as never,
      readHostAccepted: vi.fn(() => true),
      lateRecheckMs: 1,
      lateRecheckDelay: lateDelay,
    });
    expect(lateDelay).toHaveBeenCalledWith(1);
    expect(late).toEqual({
      disposition: { state: 'POLICY_BLOCKED', reason: 'LATE_REVERTED' },
      undo: lateUndo,
    });
    expect(lateUndo.dispose).not.toHaveBeenCalled();
  });
});

function preparedInput() {
  return {
    authority,
    currentBinding: binding,
    currentControlIdentityDigests: [d('email'), d('country')],
    nowMs: 1_800_000_010_000,
    semanticEpochs,
    ua2Classifications,
    semanticDigest: sha256,
    payloadRefs: [{ questionId: emailQuestionId, payloadRef: 'local.answer.email' }],
  };
}
