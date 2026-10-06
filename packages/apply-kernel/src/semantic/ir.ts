/**
 * Autofill Semantic Compiler — typed Semantic IR (S1, kernel lane).
 *
 * Pure types and closed sets; no DOM, network, vendor or library knowledge.
 * Not registered as a package export: nothing outside packages/apply-kernel can
 * import it, and it grants no writer, Submit, activation or release authority.
 *
 * SCOPE (deliberately minimal — only what a UA-4 generic writer must have):
 *
 *   L0 ObservationEpoch  = the certified UA-1 packet, unchanged, plus an
 *                          independent default-off StructureSidecarV1.
 *   L1 LogicalControl    = proxy/native dedup, radio/checkbox grouping, split
 *                          month/year merge, control shape.
 *   L2 QuestionGraph     = one node per logical question/action/decoy, with row
 *                          incarnations that survive ordinal shifts.
 *   L3 QuestionClassification
 *                        = UA-2's per-control output re-keyed to the question,
 *                          always INFERENCE, never a fact.
 *
 * OUT OF SCOPE ON PURPOSE — these belong to owners that already exist, and a
 * second copy here would be a second authority:
 *   - answer authority / AI suggestion / user confirmation → T3 answer-source
 *     projectors (packages/contracts/src/profileAnswerSources.ts and the
 *     apps/api projectors).
 *   - eligibility, terminal disposition, coverage math, Undo availability →
 *     the existing audit/receipt lane (packages/apply-kernel/src/audit.ts).
 *   - how to write a control (write mode, primitive selection) → the UA-4
 *     writer and the kernel's existing WriteCapability closed set
 *     (packages/apply-kernel/src/grant.ts). This IR says only WHAT a control
 *     is; it never says how to write it.
 *   - dependency edges, step contexts, multi-step coverage → designed in
 *     docs/rfc/autofill-semantic-compiler/README.md, implemented only when the
 *     rung that needs them is unblocked.
 *
 * Conservation invariants (checked by ./invariants.ts):
 *   I1 OBSERVATION_TOTALITY  every (epoch, address) observation is placed in
 *                            exactly one LogicalControl that has a node;
 *                            otherwise the compile fails closed.
 *   I2 NODE_TOTALITY         every LogicalControl belongs to exactly one node.
 *   I3 INCARNATION_STABILITY row identity survives ordinal shifts and never
 *                            merges with a reused DOM slot.
 *   I4 INFERENCE_NOT_FACT    a classification attaches to at most one QUESTION
 *                            node and is always an inference.
 */

import type {
  PilotUa1PageBinding,
  PilotUa1VisibleControl,
  PilotUa2CanonicalField,
  PilotUa2Classification,
  PilotUa2Confidence,
} from '@edaix/contracts/draft';

export const SEMANTIC_IR_SCHEMA_VERSION = 1 as const;

/**
 * Ruling 2026-09-02 (Mike): this compiler produces structural FACTS only. It
 * neither owns nor builds a terminal ledger; the UA-4 audit/receipt lane is the
 * single terminal owner. Nothing here may be read as "the chain is complete".
 *
 * What the terminal owner is expected to do with `optionsIncomplete`, recorded
 * here so the contract is not lost between rungs:
 *   - add a precise reason code OPTIONS_INCOMPLETE as an ADDITIVE-L1 change,
 *     surfaced as the existing AuditStatus 'FAILED' (which is already in
 *     OUR_PROBLEM_STATUSES, so it counts toward blockedByUs).
 *   - do NOT reuse UNSUPPORTED_CONTROL, NO_OPTION_MATCH, AMBIGUOUS_OPTION or
 *     USER_CONFIRMATION_REQUIRED: each of those asserts something untrue here.
 *     The control is supported, the option set was never fully seen.
 *   - block only the affected logical control from matching or writing against
 *     the truncated prefix. Never block the page.
 *   - if a fresh, complete and stable option set is obtained before the write,
 *     the write may proceed.
 *   - a placeholder option never participates in matching or writing, in any
 *     circumstance.
 */
export const SEMANTIC_COMPILER_TERMINAL_CONSUMER = 'PENDING_UA4_TERMINAL_CONSUMER' as const;

/** 64-hex SHA-256; the same shape UA-1/UA-2 already use for identities. */
export type Digest64 = string;

// ---------------------------------------------------------------------------
// L0 · Observation epoch (wraps the certified UA-1 packet; no wire change)
// ---------------------------------------------------------------------------

export const OBSERVATION_EPOCH_CAUSES = [
  /** The user clicked the exact-page trigger (UA-1 semantics, epoch 0). */
  'USER_TRIGGER',
  /** Re-observation after one of our own writes settled. */
  'POST_WRITE_RESCAN',
  /** Re-observation after a host mutation that is NOT attributable to us. */
  'HOST_MUTATION_RESCAN',
] as const;
export type ObservationEpochCause = (typeof OBSERVATION_EPOCH_CAUSES)[number];

/**
 * Ruling 2026-09-01 (Mike): the sidecar is an independent, default-off
 * StructureSidecarV1 — UA-1 schemaVersion stays 1. It binds the exact packet
 * digest, the observation epoch and the compiler version, and carries
 * conservation counts, so a truncated or mismatched sidecar can never silently
 * re-group a different packet. Digests, ordinals, booleans and closed sets
 * only: no raw name, placeholder text, HTML, value or token.
 *
 * Every field below is read by the compiler. A field nothing reads is not
 * evidence, it is wire weight, and belongs in the additive change that needs it.
 */
export const STRUCTURE_SIDECAR_SCHEMA_VERSION = 1 as const;

export interface RowEvidence {
  /** H(nonce:rowgroup:<repeating container structural path>). */
  readonly rowGroupDigest: Digest64;
  /** Ordinal of the row within its group at THIS epoch (0-based). */
  readonly ordinal: number;
  /** Digest of the row's member shape (kinds + labels). */
  readonly shapeDigest: Digest64;
  /**
   * H(nonce:rowelement:<first-sight counter>) for the row container Element in
   * the scanning realm. The only value-free evidence that survives ordinal
   * shifts: removing a middle row keeps the other Elements, so their tokens
   * persist; a re-render mints new Elements, so the rows are new incarnations
   * (fail-closed).
   */
  readonly rowElementToken: Digest64;
}

export interface StructureSidecarEntry {
  readonly identityDigest: Digest64;
  /**
   * H(nonce:element:<first-sight counter>) for the control Element itself.
   * UA-1's identityDigest is a per-epoch ADDRESS (nonce + DOM path) that shifts
   * on sibling insert/remove; the element token is the per-lifecycle IDENTITY.
   */
  readonly elementToken: Digest64;
  /** H(nonce:group:<form path>:<name attribute>) for radio/checkbox; never the raw name. */
  readonly groupKeyDigest: Digest64 | null;
  readonly row: RowEvidence | null;
  /** Ordinal of this control among all observed controls in document order. */
  readonly documentOrder: number;
  /**
   * For a standalone role=radio/checkbox member whose parent role=radiogroup was
   * ALSO emitted as a control: the parent's identityDigest. UA-1 emits both
   * today; this is the only exact evidence that counts the question once.
   */
  readonly memberOfGroupControl: Digest64 | null;
  /** Closed placeholder shape; the placeholder text itself never leaves the page. */
  readonly placeholderShape: 'MONTH_YEAR_MASK' | 'DATE_MASK' | null;
  /**
   * Ruling 2026-09-01 (Mike): an option set beyond the packet bound is a LOCAL
   * fact, never a page failure, and the bounded prefix never poses as the full
   * set. Surfaces as LogicalControl.optionsIncomplete.
   */
  readonly optionsOverflow: boolean;
  /** Indexes into the packet's option list of placeholder options. */
  readonly placeholderOptionIndexes: readonly number[];
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly multiple: boolean;
}

export interface StructureSidecar {
  readonly schemaVersion: typeof STRUCTURE_SIDECAR_SCHEMA_VERSION;
  /** Digest of the exact UA-1 packet controls this sidecar describes. */
  readonly packetDigest: Digest64;
  /** Must equal ObservationEpoch.index. */
  readonly epochIndex: number;
  /** Producer version token; a mismatch fails closed, never guesses. */
  readonly compilerVersion: string;
  readonly counts: Readonly<{
    controls: number;
    entries: number;
    suppressed: number;
    hiddenNotObserved: number;
  }>;
  readonly entries: readonly StructureSidecarEntry[];
}

export interface ObservationEpoch {
  readonly schemaVersion: typeof SEMANTIC_IR_SCHEMA_VERSION;
  /** 0-based; monotonic within one application session. */
  readonly index: number;
  readonly cause: ObservationEpochCause;
  readonly binding: PilotUa1PageBinding;
  /** Previous epoch's domGeneration, or null for epoch 0. */
  readonly parentDomGeneration: Digest64 | null;
  /** The certified UA-1 controls, byte-for-byte. */
  readonly controls: readonly PilotUa1VisibleControl[];
  /** Value-free count of hidden natives the scan saw but did not emit. */
  readonly hiddenNotObservedCount: number;
  /** Digests of controls UA-1 observed and suppressed; they are observations too. */
  readonly suppressedControls: readonly Digest64[];
  readonly structure: StructureSidecar | null;
}

// ---------------------------------------------------------------------------
// L1 · Logical controls
// ---------------------------------------------------------------------------

export const LOGICAL_CONTROL_KINDS = [
  'TEXT_SINGLE',
  'TEXT_MULTILINE',
  /** contenteditable / role=textbox without a native value property. */
  'TEXT_RICH',
  'PASSWORD',
  'NUMBER',
  'RANGE',
  'SELECT_ONE',
  'SELECT_MANY',
  /** role=combobox input; value is host-owned, selection is semantic. */
  'COMBOBOX',
  /** N radio members sharing one group key or one radiogroup. */
  'RADIO_GROUP',
  /** N checkbox members sharing one group key (multi-answer). */
  'CHECKBOX_GROUP',
  'CHECKBOX_SINGLE',
  'SWITCH',
  /** date/month/week/time/datetime-local natives, or masked/split dates. */
  'DATE',
  'FILE',
  'BUTTON',
  'UNKNOWN',
] as const;
export type LogicalControlKind = (typeof LOGICAL_CONTROL_KINDS)[number];

export const DATE_SHAPES = [
  'NATIVE_DATE',
  'NATIVE_MONTH',
  'NATIVE_WEEK',
  'NATIVE_TIME',
  'NATIVE_DATETIME_LOCAL',
  /** Free text with no mask evidence. */
  'TEXT_FREE',
  /** Masked text (e.g. a MM/YYYY placeholder shape). */
  'TEXT_MASKED',
  /** Two controls (month select + year select) form one date question. */
  'SPLIT_MONTH_YEAR',
] as const;
export type DateShape = (typeof DATE_SHAPES)[number];

export const MEMBER_ROLES = ['NATIVE_TARGET', 'GROUP_MEMBER', 'SPLIT_PART'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface LogicalControlMember {
  readonly identityDigest: Digest64;
  readonly role: MemberRole;
}

/** Why members were grouped. Only exact evidence should permit a write. */
export const GROUPING_EVIDENCE = [
  /** Same groupKeyDigest (form + name). Exact. */
  'SHARED_NAME',
  /** Same radiogroup container observed as the option parent. Exact. */
  'RADIOGROUP_OPTIONS',
  /** Same legend and contiguous document order. Structural only. */
  'SHARED_FIELDSET_LEGEND',
  'NONE',
] as const;
export type GroupingEvidence = (typeof GROUPING_EVIDENCE)[number];

export interface LogicalOption {
  readonly identityDigest: Digest64;
  readonly accessibleName: string;
  /**
   * Placeholder options are observed but never participate in matching or
   * writing, in any circumstance (ruling 2026-09-01 ③, reaffirmed 2026-09-02).
   */
  readonly placeholder: boolean;
}

export interface LogicalControl {
  /** H(logical:<sorted member identity tokens>) — element tokens when available. */
  readonly id: Digest64;
  readonly kind: LogicalControlKind;
  readonly members: readonly LogicalControlMember[];
  readonly grouping: GroupingEvidence;
  readonly dateShape: DateShape | null;
  readonly options: readonly LogicalOption[];
  /**
   * True when the observed option list is a bounded prefix, not the full set.
   * A structural fact, not a terminal: it forbids matching or writing THIS
   * control against the prefix, and forbids nothing else. See
   * SEMANTIC_COMPILER_TERMINAL_CONSUMER for what the terminal owner does with it.
   */
  readonly optionsIncomplete: boolean;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly accessibleName: string | null;
  readonly label: string | null;
  readonly legend: string | null;
  readonly autocomplete: readonly string[];
}

// ---------------------------------------------------------------------------
// L2 · Question graph (nodes and row incarnations)
// ---------------------------------------------------------------------------

export interface RowIncarnation {
  readonly rowGroupDigest: Digest64;
  /** The DOM slot this incarnation occupies. Two incarnations may reuse one slot over time. */
  readonly rowElementToken: Digest64;
  /** H(incarnation:<group>:<birth epoch>:<birth ordinal>:<row element token>:<shape>). */
  readonly token: Digest64;
  readonly birthEpoch: number;
  readonly currentOrdinal: number;
  /** Set when the row was observed to disappear; the token is then retired. */
  readonly retiredAtEpoch: number | null;
  readonly origin: 'HOST_PRESENT' | 'ADDED_BY_US';
}

export const NODE_KINDS = ['QUESTION', 'ACTION', 'DECOY'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

interface NodeBase {
  /** H(node:<kind>:<logical control id>:<incarnation token | ''>). */
  readonly id: Digest64;
  readonly kind: NodeKind;
  readonly control: LogicalControl;
  readonly firstObservedEpoch: number;
  readonly lastObservedEpoch: number;
  /**
   * Reference into QuestionGraph.rows, never a copy. A copy taken when the node
   * was created goes stale the moment the row retires or shifts, and a consumer
   * reading retirement off the node would offer Undo into a row that is gone.
   */
  readonly rowToken: Digest64 | null;
}

export interface QuestionNode extends NodeBase {
  readonly kind: 'QUESTION';
  /** The question block body (legend ?? label ?? accessibleName); never an option label. */
  readonly stemDigest: Digest64;
  readonly required: boolean;
}

export interface ActionNode extends NodeBase {
  readonly kind: 'ACTION';
  /** Derived from the input type alone; anything richer would need page text. */
  readonly actionClass: 'SUBMIT' | 'RESET' | 'OTHER';
}

/** A control UA-1 observed and suppressed. It stays in the graph so it is never a silent drop. */
export interface DecoyNode extends NodeBase {
  readonly kind: 'DECOY';
}

export type Node = QuestionNode | ActionNode | DecoyNode;

export const COMPILE_INCOMPLETE_REASONS = [
  'UNPLACED_OBSERVATION',
  'MEMBER_IN_TWO_CONTROLS',
  'CONTROL_IN_TWO_NODES',
  'EPOCH_CHAIN_BROKEN',
  'SIDECAR_MISMATCH',
  /** The compiler's own output failed the conservation checker; never shipped. */
  'INVARIANT_VIOLATION',
] as const;
export type CompileIncompleteReason = (typeof COMPILE_INCOMPLETE_REASONS)[number];

export type QuestionGraphCompile =
  | { readonly ok: true; readonly graph: QuestionGraph }
  | {
      readonly ok: false;
      readonly code: 'COMPILE_INCOMPLETE';
      /** Every observed control that could not be placed — never dropped. */
      readonly unplaced: readonly Digest64[];
      readonly reason: CompileIncompleteReason;
    };

export interface QuestionGraph {
  readonly schemaVersion: typeof SEMANTIC_IR_SCHEMA_VERSION;
  readonly binding: PilotUa1PageBinding;
  readonly epochs: readonly ObservationEpoch[];
  readonly nodes: readonly Node[];
  readonly rows: readonly RowIncarnation[];
  /**
   * I1 proof: one key per OBSERVATION, not per address. The key is
   * `<epoch>:c<packet position>:<identityDigest>` for an emitted control and
   * `<epoch>:s<position>:<identityDigest>` for a suppressed one. Keying by
   * address alone would let two observations that share a UA-1 address collapse
   * into one entry, and the totality proof would not notice.
   */
  readonly observationIndex: Readonly<Record<string, Digest64>>;
  /** I2 proof: logical control id → node id, total. */
  readonly controlIndex: Readonly<Record<Digest64, Digest64>>;
}

// ---------------------------------------------------------------------------
// L3 · Classification re-keyed to questions (inference only, I4)
// ---------------------------------------------------------------------------

export const CLASSIFICATION_MERGE_OUTCOMES = [
  'SINGLE',
  'MEMBERS_AGREE',
  'CLASSIFICATION_CONFLICT',
  'MEMBER_UNCLASSIFIED',
] as const;
export type ClassificationMergeOutcome = (typeof CLASSIFICATION_MERGE_OUTCOMES)[number];

/** Negative tiers from the kernel's existing vendor-free dictionaries (dict/guards.ts). */
export const STEM_GUARDS = ['NONE', 'OTHER_PERSON', 'JOB_DEPENDENT', 'PHONE_META'] as const;
export type StemGuard = (typeof STEM_GUARDS)[number];

export interface QuestionClassification {
  readonly nodeId: Digest64;
  readonly stemGuard: StemGuard;
  /** Always INFERENCE. A classification is never a fact (I4). */
  readonly assertion: 'INFERENCE';
  readonly merge: ClassificationMergeOutcome;
  readonly members: readonly PilotUa2Classification[];
  readonly kind: PilotUa2Classification['kind'];
  /** Null unless every classified member agrees. The 14 UA-2 canonical fields are
   *  passed through unchanged; mapping them to a profile concept is T3's job. */
  readonly canonicalField: PilotUa2CanonicalField | null;
  /**
   * Minimum over the CLASSIFIED members; a group is as confident as its weakest
   * classified member. When `merge` is MEMBER_UNCLASSIFIED some member had no
   * classification at all, and that caveat lives in `merge`, not here.
   */
  readonly confidence: PilotUa2Confidence;
  /**
   * Two root-scope questions share this stem and no row evidence separates
   * them. A structural fact, not a concept claim: nothing value-free can say
   * which one takes which answer.
   */
  readonly duplicateRootStem: boolean;
}
