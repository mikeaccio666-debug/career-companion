import {
  PILOT_UA4_LEDGER_SCHEMA_VERSION,
  parsePilotUa4TerminalLedger,
  parsePilotUa4WriteAuthorityResponse,
  pilotUa4AuthorityMatchesLivePage,
  type PilotUa4ControlKind,
  type PilotUa4FinalDisposition,
  type PilotUa4TerminalLedger,
  type PilotUa4UnobservedRegion,
  type PilotUa4WriteAuthority,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import type { PilotUa2Classification } from '@edaix/contracts/draft';
import type { ApplyErrorCode } from './contracts';
import { classifyQuestions } from './semantic/classify.ts';
import {
  classificationTerminalDisposition,
  writerKind,
} from './semantic/writerKind.ts';

export { classificationTerminalDisposition, writerKind };
import { compileGraph, type EpochInput } from './semantic/graph.ts';
import type { Digest } from './semantic/grouping.ts';
import type { LogicalControlKind, QuestionClassification, QuestionNode } from './semantic/ir.ts';
import type { ChoiceGroup, ChoiceGroupUndo, ChoiceGroupWriteInput } from './write/choiceGroup.ts';
import type {
  NativeSelectSemanticTransaction,
  NativeSelectSemanticUndo,
  NativeSelectSemanticWriteInput,
} from './write/nativeSelectSemanticTransaction.ts';
import type { DateTargetedUndo, WriteDateSemanticTransactionInput } from './write/dateSemanticTransaction.ts';
import { writeDateSemanticTransaction } from './write/dateSemanticTransaction.ts';
import type { ResumeFileOwnedUndo, ResumeFileSemanticSettleInput } from './write/fileSemanticSettle.ts';
import { settleResumeFileWrite } from './write/fileSemanticSettle.ts';
import type {
  TextFillOnlyResult,
  TextFillOnlyObservation,
  TextSemanticSettlementInput,
  TextSemanticSettlementResult,
  TextSemanticUndoOwnership,
} from './write/textSemanticSettlement.ts';
import { settleTextSemanticWrite } from './write/textSemanticSettlement.ts';

export type PilotUa4WriterFailureCode =
  | 'PILOT_WRITE_AUTHORITY_INPUT_INVALID'
  | 'PILOT_EPHEMERAL_RULE_EXPIRED'
  | 'PILOT_TARGET_DRIFT'
  | 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE'
  | 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE';

/**
 * A writer admission produced only from #164's unique semantic compiler.
 * Answer authority and page-local payload lookup remain overlays; neither can
 * provide or replace structural question/group facts.
 */
export type PilotUa4CompiledQuestion = Readonly<{
  questionId: string;
  /** Absent only in frozen legacy local fixtures. Wire producers always set it. */
  undoPolicy?: 'REQUIRED' | 'FROZEN';
  controlKind: PilotUa4ControlKind;
  compilerControlKind: LogicalControlKind;
  identityDigests: readonly string[];
  required: boolean;
  rowToken: string | null;
  answerDigest: string;
  payloadRef: string;
  classification: QuestionClassification | null;
}>;

export type PilotUa4PreparedBatch = Readonly<{
  questions: readonly PilotUa4CompiledQuestion[];
  denominatorQuestions: readonly Readonly<{ questionId: string; required: boolean }>[];
  dispositions: readonly Readonly<{
    questionId: string;
    disposition: PilotUa4FinalDisposition;
  }>[];
}>;

export type PreparePilotUa4WriterBatchInput = Readonly<{
  authority: unknown;
  currentBinding: unknown;
  currentControlIdentityDigests: unknown;
  nowMs: unknown;
  /** Certified UA-1 epochs plus StructureSidecarV1, consumed by #164. */
  semanticEpochs: readonly EpochInput[];
  /** UA-2 output is re-keyed by #164; it never grants answer/write authority. */
  ua2Classifications: readonly PilotUa2Classification[];
  semanticDigest: Digest;
  /** Opaque page-local answer handles, one for each admitted writer question. */
  payloadRefs: unknown;
}>;

export type PreparePilotUa4WriterBatchResult =
  | Readonly<{ ok: true; value: PilotUa4PreparedBatch }>
  | Readonly<{ ok: false; code: PilotUa4WriterFailureCode }>;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function parseExactArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function exactValues(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(
    (key) => typeof key !== 'string' || !keys.includes(key),
  )) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function parsePayloadRefs(value: unknown): ReadonlyMap<string, string> | null {
  const source = parseExactArray(value, 500);
  if (!source) return null;
  const result = new Map<string, string>();
  for (const item of source) {
    const fields = exactValues(item, ['questionId', 'payloadRef']);
    if (
      !fields ||
      typeof fields.questionId !== 'string' || !SAFE_ID.test(fields.questionId) ||
      typeof fields.payloadRef !== 'string' || !SAFE_ID.test(fields.payloadRef) ||
      result.has(fields.questionId)
    ) return null;
    result.set(fields.questionId, fields.payloadRef);
  }
  return result;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValueSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function parsedAuthority(value: unknown): PilotUa4WriteAuthority | null {
  const parsed = parsePilotUa4WriteAuthorityResponse({ ok: true, schemaVersion: 1, authority: value });
  return parsed.ok && parsed.value.ok ? parsed.value.authority : null;
}


export function preparePilotUa4WriterBatch(
  input: PreparePilotUa4WriterBatchInput,
): PreparePilotUa4WriterBatchResult {
  try {
    const authority = parsedAuthority(input.authority);
    if (!authority) return Object.freeze({ ok: false, code: 'PILOT_WRITE_AUTHORITY_INPUT_INVALID' });
    if (
      typeof input.nowMs !== 'number' || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
      typeof input.semanticDigest !== 'function'
    ) return Object.freeze({ ok: false, code: 'PILOT_WRITE_AUTHORITY_INPUT_INVALID' });
    if (input.nowMs >= authority.expiresAtMs) {
      return Object.freeze({ ok: false, code: 'PILOT_EPHEMERAL_RULE_EXPIRED' });
    }
    if (!pilotUa4AuthorityMatchesLivePage(
      authority,
      input.currentBinding,
      input.currentControlIdentityDigests,
      input.nowMs,
    )) return Object.freeze({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    const compiled = compileGraph(input.semanticEpochs, input.semanticDigest);
    if (!compiled.ok) {
      return Object.freeze({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    }
    const graph = compiled.graph;
    const finalEpochIndex = graph.epochs.length - 1;
    const finalEpoch = graph.epochs[finalEpochIndex];
    if (
      !finalEpoch ||
      graph.binding.origin !== authority.binding.origin ||
      graph.binding.pathname !== authority.binding.pathname ||
      graph.binding.domGeneration !== authority.binding.domGeneration ||
      !sameValueSet(
        finalEpoch.controls.map((control) => control.identityDigest),
        authority.observedControlIdentityDigests,
      )
    ) return Object.freeze({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });

    const ua2ByDigest = new Map<string, PilotUa2Classification>();
    for (const classification of input.ua2Classifications) {
      if (
        typeof classification !== 'object' || classification === null ||
        typeof classification.identityDigest !== 'string' ||
        ua2ByDigest.has(classification.identityDigest)
      ) return Object.freeze({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
      ua2ByDigest.set(classification.identityDigest, classification);
    }
    const classifications = classifyQuestions(graph, ua2ByDigest);
    const classificationById = new Map(classifications.map((entry) => [entry.nodeId, entry]));
    const nodes = graph.nodes.filter(
      (node): node is QuestionNode => node.kind === 'QUESTION' && node.lastObservedEpoch === finalEpochIndex,
    );
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const payloadRefs = parsePayloadRefs(input.payloadRefs);
    if (!payloadRefs || payloadRefs.size !== authority.questionAuthorizations.length) {
      return Object.freeze({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
    }

    const dispositions: Array<Readonly<{
      questionId: string;
      disposition: PilotUa4FinalDisposition;
    }>> = [];
    const classificationDispositionById = new Map<string, PilotUa4FinalDisposition>();
    for (const node of nodes) {
      const disposition = classificationTerminalDisposition(
        classificationById.get(node.id) ?? null,
        writerKind(node.control.kind),
      );
      if (disposition !== null) {
        classificationDispositionById.set(node.id, disposition);
        dispositions.push(Object.freeze({ questionId: node.id, disposition }));
      }
    }

    const questions: PilotUa4CompiledQuestion[] = [];
    for (const authorized of authority.questionAuthorizations) {
      const node = nodeById.get(authorized.questionId);
      const kind = node ? writerKind(node.control.kind) : null;
      const payloadRef = payloadRefs.get(authorized.questionId);
      if (
        !node || kind === null || payloadRef === undefined ||
        classificationDispositionById.has(node.id) ||
        kind !== authorized.controlKind ||
        node.required !== authorized.required ||
        node.control.optionsIncomplete ||
        !sameOrderedValues(
          node.control.members.map((member) => member.identityDigest),
          authorized.identityDigests,
        )
      ) return Object.freeze({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
      questions.push(Object.freeze({
        questionId: node.id,
        undoPolicy: authority.constraints.undo,
        controlKind: kind,
        compilerControlKind: node.control.kind,
        identityDigests: Object.freeze(node.control.members.map((member) => member.identityDigest)),
        required: node.required,
        rowToken: node.rowToken,
        answerDigest: authorized.answerDigest,
        payloadRef,
        classification: classificationById.get(node.id) ?? null,
      }));
    }

    for (const blocked of authority.blockedQuestions) {
      const node = nodeById.get(blocked.questionId);
      const kind = node ? writerKind(node.control.kind) : null;
      // Each block code is checked against the fact it claims. Reading every
      // block as OPTIONS_INCOMPLETE turned "the owner has no answer for this"
      // into a page-structure verdict, and -- because a question with a
      // complete option set then failed this compile -- masked the missing
      // answer behind a whole-batch failure.
      const structural = blocked.code === 'OPTIONS_INCOMPLETE';
      if (
        !node || kind === null || kind !== blocked.controlKind ||
        classificationDispositionById.has(node.id) ||
        node.required !== blocked.required ||
        node.control.optionsIncomplete !== structural ||
        !sameOrderedValues(
          node.control.members.map((member) => member.identityDigest),
          blocked.identityDigests,
        )
      ) return Object.freeze({ ok: false, code: 'PILOT_SEMANTIC_COMPILATION_INCOMPLETE' });
      dispositions.push(Object.freeze({
        questionId: node.id,
        disposition: structural
          ? Object.freeze({ state: 'POLICY_BLOCKED' as const, reason: 'OPTIONS_INCOMPLETE' as const })
          // No confirmed answer authority resolved. That is UA-4's own existing
          // terminal for the case, and a person can still answer it.
          : Object.freeze({
              state: 'USER_CONFIRMATION_REQUIRED' as const,
              reason: 'ANSWER_AUTHORITY_MISSING' as const,
            }),
      }));
    }

    return Object.freeze({
      ok: true,
      value: Object.freeze({
        questions: Object.freeze(questions),
        denominatorQuestions: Object.freeze(nodes.map((node) => Object.freeze({
          questionId: node.id,
          required: node.required,
        }))),
        dispositions: Object.freeze(dispositions),
      }),
    });
  } catch {
    return Object.freeze({ ok: false, code: 'PILOT_WRITE_AUTHORITY_INPUT_INVALID' });
  }
}

export type BuildPilotUa4TerminalLedgerInput = Readonly<{
  binding: unknown;
  discoveryComplete: boolean;
  questions: readonly Readonly<{ questionId: string; required: boolean }>[];
  dispositions: readonly Readonly<{ questionId: string; disposition: PilotUa4FinalDisposition }>[];
  /**
   * Regions the scan reached but could not observe into. Kept apart from the
   * questions: they get no terminal and nothing is written to them. The parser
   * refuses a ledger that lists one and still claims `discoveryComplete`.
   */
  unobservedRegions?: readonly PilotUa4UnobservedRegion[];
}>;

export type BuildPilotUa4TerminalLedgerResult =
  | Readonly<{ ok: true; value: PilotUa4TerminalLedger }>
  | Readonly<{ ok: false; code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' }>;

/** The summary is always recomputed; callers cannot provide a 100% sentinel. */
export function buildPilotUa4TerminalLedger(
  input: BuildPilotUa4TerminalLedgerInput,
): BuildPilotUa4TerminalLedgerResult {
  try {
    const requiredQuestions = input.questions.filter((question) => question.required).length;
    const questionIds = new Set(input.questions.map((question) => question.questionId));
    const dispositionIds = new Set(input.dispositions.map((entry) => entry.questionId));
    const terminalRequiredQuestions = input.questions.filter(
      (question) => question.required && dispositionIds.has(question.questionId),
    ).length;
    const unobservedRegions = input.unobservedRegions ?? [];
    const candidate = {
      schemaVersion: PILOT_UA4_LEDGER_SCHEMA_VERSION,
      binding: input.binding,
      discoveryComplete: input.discoveryComplete,
      questions: input.questions,
      dispositions: input.dispositions,
      unobservedRegions,
      summary: {
        observableQuestions: input.questions.length,
        requiredQuestions,
        terminalQuestions: input.dispositions.length,
        terminalRequiredQuestions,
        requiredFieldFinalDispositionCoverage: 100,
        unobservedRegions: unobservedRegions.length,
      },
    } as const;
    if (questionIds.size !== input.questions.length || dispositionIds.size !== input.dispositions.length) {
      return Object.freeze({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
    }
    const parsed = parsePilotUa4TerminalLedger(candidate);
    if (!parsed.ok) return Object.freeze({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
    return Object.freeze({ ok: true, value: parsed.value });
  } catch {
    return Object.freeze({ ok: false, code: 'PILOT_TERMINAL_DISPOSITION_INCOMPLETE' });
  }
}

/** Temporary projection into the existing FAILED/blockedByUs audit channel. */
export function pilotUa4DispositionToApplyFailure(
  disposition: Extract<PilotUa4FinalDisposition, { state: 'POLICY_BLOCKED' }>,
): Readonly<{ ok: false; reason: ApplyErrorCode }> {
  if (disposition.reason === 'OPTIONS_INCOMPLETE') return Object.freeze({ ok: false, reason: 'OPTIONS_INCOMPLETE' });
  if (disposition.reason === 'HOST_REJECTED') return Object.freeze({ ok: false, reason: 'HOST_REJECTED' });
  if (disposition.reason === 'LATE_REVERTED') return Object.freeze({ ok: false, reason: 'LATE_REVERTED' });
  if (disposition.reason === 'EXACT_TARGET_DRIFT') return Object.freeze({ ok: false, reason: 'IDENTITY_CHANGED' });
  if (disposition.reason === 'UNDO_UNAVAILABLE') return Object.freeze({ ok: false, reason: 'JOURNAL_UNAVAILABLE' });
  return Object.freeze({ ok: false, reason: 'CAPABILITY_DISABLED' });
}

export type PilotUa4OwnedUndo =
  | TextSemanticUndoOwnership
  | NativeSelectSemanticUndo
  | ChoiceGroupUndo
  | DateTargetedUndo
  | ResumeFileOwnedUndo
  | Readonly<{ dispose(): void }>;

type ExistingKernelProof =
  | Readonly<{ ok: true; disposition: 'PREFILLED' }>
  | Readonly<{
      ok: true;
      disposition: 'FILLED';
      semanticReadback: 'HOST_ACCEPTED';
      lateRecheck: 'STABLE';
      undo: Readonly<{ dispose(): void }>;
    }>
  | Readonly<{ ok: false; code: ApplyErrorCode }>;

/**
 * Page-local plans contain DOM objects or opaque existing-runner handles and
 * never cross the authority wire. Dispatch is closed by compiler control kind:
 * a text authority cannot be redirected to a select, choice, file, or row.
 */
export type PilotUa4LeafPlan =
  | Readonly<{
      kind: 'PREFILLED';
      /** Prove the current host value is already the authorized semantic answer. */
      readCurrentSemantic: () => boolean;
    }>
  | Readonly<{ kind: 'TEXT_FILL_ONLY'; execute: () => Promise<TextFillOnlyResult> }>
  | Readonly<{
      kind: 'SEMANTIC_FILL_ONLY';
      control: PilotUa4ControlKind;
      execute: () => Promise<TextFillOnlyResult>;
    }>
  | Readonly<{ kind: 'TEXT_SETTLE'; input: TextSemanticSettlementInput }>
  | Readonly<{
      kind: 'TEXT_TRANSACTION';
      /**
       * Content-owned forward write plus the kernel semantic settlement. The
       * callback is invoked only after UA-4 compiler/authority admission; a
       * resolver itself remains read-only.
       */
      execute: () => Promise<TextSemanticSettlementResult>;
    }>
  | Readonly<{
      kind: 'NATIVE_SELECT';
      transaction: NativeSelectSemanticTransaction;
      input: NativeSelectSemanticWriteInput;
    }>
  | Readonly<{
      kind: 'CHOICE_GROUP';
      group: ChoiceGroup;
      input: ChoiceGroupWriteInput;
      readHostAccepted: () => boolean;
      lateRecheckMs: number;
      lateRecheckDelay?: (milliseconds: number) => Promise<void> | void;
    }>
  | Readonly<{ kind: 'DATE'; input: WriteDateSemanticTransactionInput }>
  | Readonly<{ kind: 'FILE'; input: ResumeFileSemanticSettleInput }>
  | Readonly<{
      kind: 'EXISTING_KERNEL';
      control: 'CONTENTEDITABLE' | 'COMBOBOX';
      execute: () => Promise<ExistingKernelProof>;
    }>;

export type PilotUa4LeafResult = Readonly<{
  disposition: PilotUa4FinalDisposition;
  undo: PilotUa4OwnedUndo | null;
  observation?: TextFillOnlyObservation;
}>;

const prefilledLeaf = (): PilotUa4LeafResult => Object.freeze({
  disposition: Object.freeze({ state: 'PREFILLED' as const, semanticReadback: 'CURRENT' as const }),
  undo: null,
});

const filledLeaf = (undo: PilotUa4OwnedUndo): PilotUa4LeafResult => Object.freeze({
  disposition: Object.freeze({
    state: 'FILLED' as const,
    semanticReadback: 'HOST_ACCEPTED' as const,
    lateRecheck: 'STABLE' as const,
    undo: 'OWNED' as const,
  }),
  undo,
});

function blockedLeaf(
  reason: Extract<PilotUa4FinalDisposition, { state: 'POLICY_BLOCKED' }>['reason'],
  undo: PilotUa4OwnedUndo | null = null,
): PilotUa4LeafResult {
  return Object.freeze({
    disposition: Object.freeze({ state: 'POLICY_BLOCKED' as const, reason }),
    undo,
  });
}

function applyFailure(code: ApplyErrorCode, undo: PilotUa4OwnedUndo | null = null): PilotUa4LeafResult {
  if (code === 'IDENTITY_CHANGED' || code === 'DETACHED') return blockedLeaf('EXACT_TARGET_DRIFT', undo);
  if (code === 'HOST_REJECTED') return blockedLeaf('HOST_REJECTED', undo);
  if (code === 'LATE_REVERTED') return blockedLeaf('LATE_REVERTED', undo);
  if (code === 'JOURNAL_UNAVAILABLE') return blockedLeaf('UNDO_UNAVAILABLE', undo);
  return blockedLeaf('WRITER_EXECUTION_FAILED', undo);
}

function fileFailure(code: string, undo: PilotUa4OwnedUndo | null = null): PilotUa4LeafResult {
  if (code === 'FILE_TARGET_REPLACED' || code === 'FILE_TARGET_CHANGED') return blockedLeaf('EXACT_TARGET_DRIFT', undo);
  if (code === 'FILE_HOST_REJECTED' || code === 'FILE_HOST_UNVERIFIED') return blockedLeaf('HOST_REJECTED', undo);
  if (code === 'FILE_CLEARED_DURING_SETTLE' || code === 'FILE_REPLACED_DURING_SETTLE') {
    return blockedLeaf('LATE_REVERTED', undo);
  }
  return blockedLeaf('WRITER_EXECUTION_FAILED', undo);
}

function choiceFailure(code: string, undo: PilotUa4OwnedUndo | null = null): PilotUa4LeafResult {
  if (code === 'GROUP_IDENTITY_CHANGED') return blockedLeaf('EXACT_TARGET_DRIFT', undo);
  if (code === 'WRITE_REVERTED' || code === 'WRITE_AUTHORITY_LOST') return blockedLeaf('LATE_REVERTED', undo);
  if (code === 'TARGET_NOT_WRITABLE' || code === 'MANUAL_ONLY') return blockedLeaf('TARGET_NOT_ELIGIBLE', undo);
  if (code === 'VERIFY_FAILED') return blockedLeaf('HOST_REJECTED', undo);
  return blockedLeaf('WRITER_EXECUTION_FAILED', undo);
}

function planMatchesQuestion(question: PilotUa4CompiledQuestion, plan: PilotUa4LeafPlan): boolean {
  if (plan.kind === 'PREFILLED') return true;
  if (plan.kind === 'TEXT_FILL_ONLY') return question.undoPolicy === 'FROZEN' &&
    (question.controlKind === 'TEXT' || question.controlKind === 'TEXTAREA');
  if (plan.kind === 'SEMANTIC_FILL_ONLY') {
    return question.undoPolicy === 'FROZEN' && question.controlKind === plan.control;
  }
  if (question.undoPolicy === 'FROZEN') return false;
  if (plan.kind === 'TEXT_SETTLE' || plan.kind === 'TEXT_TRANSACTION') {
    return question.controlKind === 'TEXT' || question.controlKind === 'TEXTAREA';
  }
  if (plan.kind === 'NATIVE_SELECT') return question.controlKind === 'NATIVE_SELECT';
  if (plan.kind === 'CHOICE_GROUP') {
    return question.controlKind === 'RADIO_GROUP' || question.controlKind === 'CHECKBOX_GROUP';
  }
  if (plan.kind === 'DATE') return question.controlKind === 'DATE';
  if (plan.kind === 'FILE') return question.controlKind === 'FILE';
  return question.controlKind === plan.control;
}

/** Executes one compiler-admitted question through a reviewed semantic leaf. */
export async function executePilotUa4Leaf(
  question: PilotUa4CompiledQuestion,
  plan: PilotUa4LeafPlan,
): Promise<PilotUa4LeafResult> {
  try {
    if (!planMatchesQuestion(question, plan)) return blockedLeaf('TARGET_NOT_ELIGIBLE');
    if (plan.kind === 'PREFILLED') {
      return plan.readCurrentSemantic() ? prefilledLeaf() : blockedLeaf('HOST_REJECTED');
    }
    if (plan.kind === 'TEXT_FILL_ONLY') {
      const result = await plan.execute();
      if (result.ok) return Object.freeze({
        disposition: Object.freeze({ state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'FROZEN' }),
        undo: null, observation: result.observation,
      });
      const failed = applyFailure(result.code);
      return result.writeEffect && failed.disposition.state === 'POLICY_BLOCKED'
        ? Object.freeze({ ...failed, disposition: Object.freeze({ ...failed.disposition, writeEffect: result.writeEffect }) })
        : failed;
    }
    if (plan.kind === 'SEMANTIC_FILL_ONLY') {
      const result = await plan.execute();
      if (result.ok) return Object.freeze({
        disposition: Object.freeze({ state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'FROZEN' }),
        undo: null, observation: result.observation,
      });
      const failed = applyFailure(result.code);
      return result.writeEffect && failed.disposition.state === 'POLICY_BLOCKED'
        ? Object.freeze({ ...failed, disposition: Object.freeze({ ...failed.disposition, writeEffect: result.writeEffect }) })
        : failed;
    }
    if (plan.kind === 'TEXT_SETTLE') {
      const result = await settleTextSemanticWrite(plan.input);
      return result.ok ? filledLeaf(result.value.undo) : applyFailure(result.code, result.recovery ?? null);
    }
    if (plan.kind === 'TEXT_TRANSACTION') {
      const result = await plan.execute();
      return result.ok ? filledLeaf(result.value.undo) : applyFailure(result.code, result.recovery ?? null);
    }
    if (plan.kind === 'NATIVE_SELECT') {
      const result = await plan.transaction.write(plan.input);
      if (!result.ok) return applyFailure(result.code, result.recovery ?? null);
      if (result.value.disposition === 'PREFILLED') return prefilledLeaf();
      return result.value.undo === null ? blockedLeaf('UNDO_UNAVAILABLE') : filledLeaf(result.value.undo);
    }
    if (plan.kind === 'CHOICE_GROUP') {
      if (!Number.isFinite(plan.lateRecheckMs) || plan.lateRecheckMs <= 0) {
        return blockedLeaf('WRITER_EXECUTION_FAILED');
      }
      const result = await plan.group.write(plan.input);
      if (!result.ok) return choiceFailure(result.error, result.undo ?? null);
      if (result.value.undo === null) return prefilledLeaf();
      if (!plan.readHostAccepted()) {
        return blockedLeaf('HOST_REJECTED', result.value.undo);
      }
      if (plan.lateRecheckDelay) await plan.lateRecheckDelay(plan.lateRecheckMs);
      else await new Promise<void>((resolve) => setTimeout(resolve, plan.lateRecheckMs));
      if (
        result.value.undo.wasExternallyEdited() ||
        !result.value.undo.isAtWrittenState() ||
        !plan.readHostAccepted()
      ) {
        return blockedLeaf('LATE_REVERTED', result.value.undo);
      }
      return filledLeaf(result.value.undo);
    }
    if (plan.kind === 'DATE') {
      const result = await writeDateSemanticTransaction(plan.input);
      return result.ok ? filledLeaf(result.value.undo) : applyFailure(result.code, result.recovery ?? null);
    }
    if (plan.kind === 'FILE') {
      const result = await settleResumeFileWrite(plan.input);
      return result.ok ? filledLeaf(result.undo) : fileFailure(result.code, result.recovery ?? null);
    }
    const result = await plan.execute();
    if (!result.ok) return applyFailure(result.code);
    if (result.disposition === 'PREFILLED') return prefilledLeaf();
    return filledLeaf(result.undo);
  } catch {
    return blockedLeaf('WRITER_EXECUTION_FAILED');
  }
}
