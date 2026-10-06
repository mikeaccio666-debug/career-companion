/**
 * Semantic transaction for one native radio/checkbox question.
 *
 * The runner reaches it only through `fillChoiceGroup` (a reviewed answer for a scanned
 * `choice` field, fill-first); the pilot writer drives `write()` directly. Either way the
 * CAP-AF-001 invariants hold: one logical question owns a complete same-name option set,
 * the whole set is snapshotted before mutation, every changed property reaches
 * its final vector before the first host event, and Undo may restore only the
 * exact vector written by this transaction.
 *
 * `write()` takes opaque question/option IDs and never reads a label or DOM value.
 * `fillChoiceGroup` is the one place a reviewed answer's option text meets the group:
 * `chosenOptions` maps each line to exactly one member and refuses any ambiguity.
 * Sensitive/manual classification remains an upstream responsibility; this leaf
 * accepts only the explicit ordinary, reversible boundary and fails every unknown
 * boundary closed.
 */

import type { ApplyErrorCode, ChoiceGroupShape, NativeChoiceGroupShape, Result, ScanRoot } from '../contracts.ts';
import { activateReviewedChoiceGroup } from '../click/primitives.ts';
import { fillProxyChoiceGroup } from './proxyChoiceGroup.ts';
import { isWholeQuestionKind, type SignOnBehalfChoiceKind } from '../dict/signOnBehalf.ts';
import { dispatchHostEvent } from './allowlist.ts';
import {
  executeFillOnlySemanticWrite,
  type FillOnlyHostWriteAuthority,
  type FillOnlySemanticResult,
} from './fillOnlySemantic.ts';
import { settleAfterHostWrite, type HostValidationSignals } from './verify.ts';

export type ChoiceGroupKind = 'radio' | 'checkbox';

export type ChoiceWriteBoundary =
  | 'ORDINARY_REVERSIBLE'
  | 'SENSITIVE_OR_ATTESTATION'
  | 'LEGAL_OR_SUBSTANTIVE_AUTHORIZATION'
  | 'MARKETING_SUBSCRIPTION'
  | 'CONTACT_CURRENT_EMPLOYER'
  | 'PASSWORD'
  | 'OTP_OR_2FA'
  | 'CAPTCHA_OR_HUMAN_CHALLENGE'
  | 'UNKNOWN_OR_MIXED_AUTHORIZATION'
  | 'FINAL_SUBMIT';

export type ChoiceAnswer =
  | { readonly kind: 'SINGLE_CHOICE'; readonly optionId: string }
  | { readonly kind: 'MULTI_CHOICE'; readonly optionIds: readonly string[] };

export interface ChoiceGroupOptionInput {
  readonly element: HTMLInputElement;
  /** Opaque caller-owned identity; never inferred from label or DOM value. */
  readonly optionId: string;
}

/**
 * Who defines the group's membership.
 *
 *  - `native` (default): the same-`name` controls of one form owner; the caller must list
 *    every one of them (Greenhouse / Lever / BambooHR question groups).
 *  - `declared`: the listed controls *are* the group, exactly as the reviewed scan grouped
 *    them. Ashby (2026-09-15 live) has no `<form>`, names each checkbox of a "select all
 *    that apply" question after its own option text and names radios
 *    `<questionUuid>_<optionUuid>`, so a same-name-in-a-form rule refuses every one of its
 *    questions as MIXED_GROUP_IDENTITY. Identity is then rechecked against those exact
 *    members (connected, same root, same type, each member's own name and form owner
 *    unchanged). One native rule survives for radios: every same-name radio sibling of a
 *    member must be inside the set, because checking one radio unchecks its siblings and an
 *    outside sibling would be a write beyond the reviewed question. Checkbox names carry no
 *    native semantics, so they are compared per member only.
 */
export type ChoiceGroupMembership = 'native' | 'declared';

export interface PrepareChoiceGroupInput {
  /** Opaque logical-question identity supplied by a future trusted planner. */
  readonly questionId: string;
  /** Complete DOM-order membership for this exact group. */
  readonly options: readonly ChoiceGroupOptionInput[];
  /** Defaults to `native`; see `ChoiceGroupMembership`. */
  readonly membership?: ChoiceGroupMembership;
}

export type PrepareChoiceGroupError =
  | 'INVALID_QUESTION_ID'
  | 'EMPTY_OPTION_MEMBERSHIP'
  | 'INVALID_OPTION_ID'
  | 'DUPLICATE_OPTION_ID'
  | 'NOT_A_CHOICE_CONTROL'
  | 'DETACHED_OPTION'
  | 'MIXED_GROUP_IDENTITY'
  | 'INCOMPLETE_OPTION_MEMBERSHIP'
  | 'GROUP_STATE_UNAVAILABLE';

export type ChoiceGroupWriteError =
  | 'MANUAL_ONLY'
  | 'ANSWER_KIND_MISMATCH'
  | 'INVALID_ANSWER'
  | 'UNKNOWN_OPTION'
  | 'GROUP_IDENTITY_CHANGED'
  | 'TARGET_NOT_WRITABLE'
  | 'WRITE_REVERTED'
  | 'WRITE_AUTHORITY_LOST'
  | 'VERIFY_FAILED';

export type ChoiceGroupUndoError =
  | 'UNDO_RETIRED'
  | 'UNDO_NOT_OWNED'
  | 'UNDO_RESTORE_FAILED';

export interface ChoiceGroupSnapshot {
  readonly selectedOptionIds: readonly string[];
  readonly indeterminateOptionIds: readonly string[];
}

export interface ChoiceGroupUndoRestoreInput {
  readonly settle?: () => Promise<void> | void;
}

export interface ChoiceGroupUndo {
  /** True after any later group event or any silent semantic drift. */
  readonly wasExternallyEdited: () => boolean;
  readonly isAtWrittenState: () => boolean;
  readonly restorePreWrite: (input?: ChoiceGroupUndoRestoreInput) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: ChoiceGroupUndoError }
  >;
  readonly isAtPreWriteState: () => boolean;
  readonly dispose: () => void;
}

export interface ChoiceGroupWriteInput {
  readonly boundary: ChoiceWriteBoundary;
  readonly answer: ChoiceAnswer;
  /** Focused-test seam; production defaults to the bounded shared settle. */
  readonly settle?: () => Promise<void> | void;
}

/** What the click boundary needs to natively activate this group's members. */
export interface ChoiceGroupActivation {
  readonly root: ScanRoot;
  /** Re-read inside the click boundary before the authority and before every click. */
  readonly capabilityCurrent: () => boolean;
  /** 代填的那一格（2026-09-23）：带进每一下的点击事实，点击策略在当下重判文字。 */
  readonly signOnBehalf?: SignOnBehalfChoiceKind;
}

/** Fill-first boundary: no prior vector or restoration callback crosses it. */
export interface ChoiceGroupFillOnlyInput {
  readonly answer: ChoiceAnswer;
  /**
   * Write the reviewed members by **native activation** instead of the property
   * setter. Absent = the historical setter + `input`/`change` path.
   *
   * 这是本叶子唯一会对宿主发出 click 的入口（见 click/primitives.ts 的
   * `activateReviewedChoiceGroup`）。`fillChoiceGroup` 默认给它，`write()`
   * 那条带撤销的路径从不给。
   */
  readonly activation?: ChoiceGroupActivation;
  readonly authorizeWrite: () => Promise<boolean>;
  readonly readHostValidation: (
    elements: readonly HTMLInputElement[],
  ) => HostValidationSignals;
  readonly executionFence: () => ApplyErrorCode | null;
  readonly lateRecheckMs: number;
  readonly signal?: AbortSignal;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly operationTimeoutMs?: number;
}

export interface ChoiceGroupWriteOk {
  readonly before: ChoiceGroupSnapshot;
  readonly readback: ChoiceGroupSnapshot;
  /** Null only when the requested semantic state already matched the host. */
  readonly undo: ChoiceGroupUndo | null;
}

export interface ChoiceGroup {
  readonly questionId: string;
  readonly kind: ChoiceGroupKind;
  readonly optionIds: readonly string[];
  /** A group is one question regardless of raw option count. */
  readonly measurement: {
    readonly logicalQuestions: 1;
    readonly requiredQuestions: 0 | 1;
  };
  readonly isEmpty: () => boolean;
  /**
   * Every member publishes its own `aria-checked`. Such a host owns the state:
   * a property write cannot reach it (Workday, 2026-09-15), so the caller must
   * not fall back to one when native activation was unavailable.
   */
  readonly publishesHostState: () => boolean;
  readonly isAtAnswer: (answer: ChoiceAnswer) => boolean;
  readonly fillOnly: (
    input: ChoiceGroupFillOnlyInput,
  ) => Promise<FillOnlySemanticResult>;
  readonly write: (
    input: ChoiceGroupWriteInput,
  ) => Promise<
    | { readonly ok: true; readonly value: ChoiceGroupWriteOk }
    | {
        readonly ok: false;
        readonly error: ChoiceGroupWriteError;
        /** Retained only when the exact system-written vector is still proven. */
        readonly undo?: ChoiceGroupUndo;
      }
  >;
}

export type PrepareChoiceGroupResult =
  | { readonly ok: true; readonly value: ChoiceGroup }
  | { readonly ok: false; readonly error: PrepareChoiceGroupError };

interface ChoiceMemberState {
  readonly checked: boolean;
  readonly indeterminate: boolean;
}

interface NativeChoiceAccess {
  readonly getChecked: () => boolean;
  readonly setChecked: (value: boolean) => void;
  readonly getIndeterminate: () => boolean;
  readonly setIndeterminate: (value: boolean) => void;
  readonly getEffectiveDisabled: () => boolean;
  /**
   * The host's **own** published state for this member: `aria-checked` read as
   * a boolean, or `null` when the host publishes none (an ordinary radio that
   * lets the user agent speak for it).
   *
   * This is the only thing in the group that a property write cannot fake.
   * Workday's My Information radios (nvidia.wd5, 2026-09-15): setting `checked`
   * and dispatching `input`/`change` leaves `aria-checked="false"` forever and
   * the host goes on reporting the question unanswered, while a readback that
   * reads only the property we just set says FILLED. A control that reports
   * FILLED while the host still calls it unanswered is the worst answer this
   * writer can give, so where the host publishes a state, that state decides.
   */
  readonly getPublishedChecked: () => boolean | null;
}

interface NativeEventAccess {
  readonly isCurrent: () => boolean;
  readonly addCapture: (
    type: string,
    intrinsicListener: EventListener,
    supplementalListener: EventListener,
  ) => void;
  readonly removeCapture: (
    type: string,
    intrinsicListener: EventListener,
    supplementalListener: EventListener,
  ) => void;
}

interface PreparedIdentity {
  readonly elements: readonly HTMLInputElement[];
  readonly optionIds: readonly string[];
  readonly kind: ChoiceGroupKind;
  readonly membership: ChoiceGroupMembership;
  /** Each member's own `name` / form owner as prepared; `native` groups share one of each. */
  readonly names: readonly string[];
  readonly forms: readonly (HTMLFormElement | null)[];
  readonly root: Node;
  readonly requiredState: readonly boolean[];
  readonly effectiveDisabledState: readonly boolean[];
  /**
   * Which members published an `aria-checked` state at preparation. A member
   * that published one has to keep agreeing with every state this writer
   * claims; one that never published any imposes nothing (the overwhelming
   * majority of radios and checkboxes on the web).
   */
  readonly publishesHostState: readonly boolean[];
  readonly access: readonly NativeChoiceAccess[];
  readonly eventAccess: NativeEventAccess;
}

const SAFE_LOCAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// `submit` joined the observed set with native activation (2026-09-15): the one
// host click that does **not** pre-cancel its default action must still be
// unable to submit the form, and a capture-phase veto is the only place that
// can stop a host listener calling `form.submit()` from inside our click.
const OBSERVED_EVENTS = ['beforeinput', 'input', 'change', 'click', 'reset', 'submit'] as const;
/**
 * The events the user agent emits for one native choice activation, each at
 * most once on the exact activated member. A second copy of any of them, or one
 * on any other member, is an external edit exactly as it is for `dispatchExpected`.
 */
const ACTIVATION_EVENTS: ReadonlySet<string> = new Set(['click', 'beforeinput', 'input', 'change']);

function isChoiceKind(value: string): value is ChoiceGroupKind {
  return value === 'radio' || value === 'checkbox';
}

function choiceAccess(
  element: HTMLInputElement,
  kind: ChoiceGroupKind,
): NativeChoiceAccess | null {
  try {
    const Input = element.ownerDocument.defaultView?.HTMLInputElement;
    const ElementConstructor = element.ownerDocument.defaultView?.Element;
    const checkedDescriptor = Input
      ? Object.getOwnPropertyDescriptor(Input.prototype, 'checked')
      : undefined;
    const indeterminateDescriptor = Input
      ? Object.getOwnPropertyDescriptor(Input.prototype, 'indeterminate')
      : undefined;
    const matches = ElementConstructor?.prototype.matches;
    const getAttribute = ElementConstructor?.prototype.getAttribute;
    if (
      typeof checkedDescriptor?.get !== 'function' ||
      typeof checkedDescriptor.set !== 'function' ||
      typeof matches !== 'function' ||
      typeof getAttribute !== 'function' ||
      (kind === 'checkbox' && (
        typeof indeterminateDescriptor?.get !== 'function' ||
        typeof indeterminateDescriptor.set !== 'function'
      ))
    ) return null;
    return Object.freeze({
      getChecked: () => checkedDescriptor.get!.call(element) as boolean,
      setChecked: (value: boolean) => { checkedDescriptor.set!.call(element, value); },
      // Radio indeterminate has no choice semantics even if a host assigns the
      // generic DOM property. Normalize it without reading or writing it.
      getIndeterminate: () => kind === 'checkbox'
        ? indeterminateDescriptor!.get!.call(element) as boolean
        : false,
      setIndeterminate: (value: boolean) => {
        if (kind === 'checkbox') indeterminateDescriptor!.set!.call(element, value);
      },
      getEffectiveDisabled: () => matches.call(element, ':disabled'),
      // Read through the realm's own `getAttribute`, exactly like `matches`
      // above: a host-owned accessor on the element must not be able to answer
      // "what did the host publish".
      getPublishedChecked: () => {
        const published = getAttribute.call(element, 'aria-checked');
        return published === 'true' ? true : published === 'false' ? false : null;
      },
    });
  } catch {
    return null;
  }
}

function nativeEventAccess(document: Document, root: Node): NativeEventAccess | null {
  try {
    // Light-DOM events use owner-realm Document authority plus Window capture,
    // so neither a target-own Window wrapper nor an earlier Document listener
    // alone can hide nested clones or reset. Non-composed ShadowRoot events stay
    // on that root; a future runtime integrator must prove same-layer observer
    // precedence before this dormant leaf can be wired into production.
    const intrinsicTarget: EventTarget = root;
    const supplementalTarget: EventTarget | null = root === document
      ? document.defaultView
      : null;
    const EventTargetConstructor = document.defaultView?.EventTarget;
    if (!EventTargetConstructor) return null;
    const add = EventTargetConstructor.prototype.addEventListener;
    const remove = EventTargetConstructor.prototype.removeEventListener;
    const supplementalAdd = supplementalTarget?.addEventListener;
    const supplementalRemove = supplementalTarget?.removeEventListener;
    if (typeof add !== 'function' || typeof remove !== 'function') return null;
    if (
      supplementalTarget !== null &&
      (typeof supplementalAdd !== 'function' || typeof supplementalRemove !== 'function')
    ) return null;
    return Object.freeze({
      isCurrent: () =>
        EventTargetConstructor.prototype.addEventListener === add &&
        EventTargetConstructor.prototype.removeEventListener === remove &&
        (supplementalTarget === null || (
          supplementalTarget.addEventListener === supplementalAdd &&
          supplementalTarget.removeEventListener === supplementalRemove
        )),
      addCapture: (
        type: string,
        intrinsicListener: EventListener,
        supplementalListener: EventListener,
      ) => {
        // Document/ShadowRoot registration always uses owner-realm authority.
        // Window is supplemental so an earlier Document listener cannot hide
        // an event; a target-own wrapper is never the sole source of proof.
        add.call(intrinsicTarget, type, intrinsicListener, true);
        supplementalAdd?.call(supplementalTarget, type, supplementalListener, true);
      },
      removeCapture: (
        type: string,
        intrinsicListener: EventListener,
        supplementalListener: EventListener,
      ) => {
        try {
          supplementalRemove?.call(supplementalTarget, type, supplementalListener, true);
        } finally {
          remove.call(intrinsicTarget, type, intrinsicListener, true);
        }
      },
    });
  } catch {
    return null;
  }
}

function normalizeChoiceAnswer(answer: ChoiceAnswer):
  | { readonly ok: true; readonly value: ChoiceAnswer }
  | { readonly ok: false; readonly error: 'INVALID_ANSWER' } {
  try {
    if (answer === null || typeof answer !== 'object') {
      return { ok: false, error: 'INVALID_ANSWER' };
    }
    const kind = answer.kind;
    if (kind === 'SINGLE_CHOICE') {
      const optionId = answer.optionId;
      if (typeof optionId !== 'string') return { ok: false, error: 'INVALID_ANSWER' };
      return {
        ok: true,
        value: Object.freeze({ kind, optionId }),
      };
    }
    if (kind === 'MULTI_CHOICE') {
      const rawOptionIds = answer.optionIds;
      if (!Array.isArray(rawOptionIds)) return { ok: false, error: 'INVALID_ANSWER' };
      const optionCount = rawOptionIds.length;
      const optionIds: string[] = [];
      for (let index = 0; index < optionCount; index += 1) {
        const optionId = rawOptionIds[index];
        if (typeof optionId !== 'string') return { ok: false, error: 'INVALID_ANSWER' };
        optionIds.push(optionId);
      }
      return {
        ok: true,
        value: Object.freeze({ kind, optionIds: Object.freeze(optionIds) }),
      };
    }
    return { ok: false, error: 'INVALID_ANSWER' };
  } catch {
    return { ok: false, error: 'INVALID_ANSWER' };
  }
}

function inputsIn(root: Node): readonly HTMLInputElement[] | null {
  try {
    if (!('querySelectorAll' in root)) return null;
    return [...(root as ParentNode).querySelectorAll<HTMLInputElement>('input')];
  } catch {
    return null;
  }
}

function sameElements(
  left: readonly HTMLInputElement[],
  right: readonly HTMLInputElement[],
): boolean {
  return left.length === right.length && left.every((element, index) => element === right[index]);
}

/**
 * Is the prepared member list still the complete group? `native`: the same-name
 * choice controls of the form owner must be exactly these elements. `declared`:
 * the list is the group by definition; only a radio member's same-name siblings
 * (the browser's exclusivity set) must all be inside it.
 */
function membershipIsComplete(identity: PreparedIdentity): boolean {
  const { elements, kind, membership, names, forms, root } = identity;
  const inputs = inputsIn(root);
  if (inputs === null) return false;
  try {
    if (membership === 'native') {
      const native = inputs.filter((element) =>
        element.isConnected &&
        element.getRootNode() === root &&
        element.form === forms[0] &&
        element.name === names[0] &&
        isChoiceKind(element.type),
      );
      return sameElements(native, elements);
    }
    if (kind !== 'radio') return true;
    const declared = new Set(elements);
    for (const [index, element] of elements.entries()) {
      const name = names[index]!;
      if (name === '') continue;
      const form = forms[index] ?? null;
      const outside = inputs.some((candidate) =>
        candidate !== element &&
        !declared.has(candidate) &&
        candidate.type === 'radio' &&
        candidate.name === name &&
        candidate.form === form,
      );
      if (outside) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function identityIsCurrent(identity: PreparedIdentity): boolean {
  const { elements, kind, names, forms, root, requiredState } = identity;
  try {
    for (const [index, element] of elements.entries()) {
      if (
        !element.isConnected ||
        element.getRootNode() !== root ||
        element.form !== forms[index] ||
        element.name !== names[index] ||
        element.type !== kind ||
        element.required !== requiredState[index] ||
        identity.access[index]!.getEffectiveDisabled() !==
          identity.effectiveDisabledState[index]
      ) return false;
    }
  } catch {
    return false;
  }
  return membershipIsComplete(identity);
}

/**
 * Does the host's own published state agree that the group is at `wanted`?
 *
 * Only members that published a state at preparation are asked, and a member
 * that published one and has stopped publishing is a disagreement: we can no
 * longer show that the host received the answer, and "cannot show" is "no".
 * A group where no member publishes anything always agrees, so nothing changes
 * for an ordinary radio/checkbox whose user agent owns the whole story.
 */
function hostPublishesVector(
  identity: PreparedIdentity,
  wanted: readonly ChoiceMemberState[],
): boolean {
  try {
    return identity.access.every((access, index) => {
      if (identity.publishesHostState[index] !== true) return true;
      const published = access.getPublishedChecked();
      return published !== null && published === wanted[index]?.checked;
    });
  } catch {
    return false;
  }
}

/** The group is at `wanted` **and** the host says so wherever the host speaks. */
function vectorSettledAt(
  identity: PreparedIdentity,
  wanted: readonly ChoiceMemberState[],
): boolean {
  const current = readVector(identity);
  return current !== null && sameVector(current, wanted) && hostPublishesVector(identity, wanted);
}

function readVector(identity: PreparedIdentity): readonly ChoiceMemberState[] | null {
  if (!identityIsCurrent(identity)) return null;
  try {
    return Object.freeze(identity.access.map((access) => Object.freeze({
      checked: access.getChecked(),
      indeterminate: access.getIndeterminate(),
    })));
  } catch {
    return null;
  }
}

function sameVector(
  left: readonly ChoiceMemberState[],
  right: readonly ChoiceMemberState[],
): boolean {
  return left.length === right.length && left.every((value, index) =>
    value.checked === right[index]?.checked &&
    value.indeterminate === right[index]?.indeterminate,
  );
}

function vectorKey(vector: readonly ChoiceMemberState[]): string {
  return vector.map((value) =>
    `${value.checked ? '1' : '0'}${value.indeterminate ? '1' : '0'}`,
  ).join('|');
}

function snapshot(
  identity: PreparedIdentity,
  vector: readonly ChoiceMemberState[],
): ChoiceGroupSnapshot {
  return Object.freeze({
    selectedOptionIds: Object.freeze(
      identity.optionIds.filter((_optionId, index) => vector[index]?.checked === true),
    ),
    indeterminateOptionIds: Object.freeze(
      identity.optionIds.filter((_optionId, index) => vector[index]?.indeterminate === true),
    ),
  });
}

function desiredVector(
  identity: PreparedIdentity,
  answer: ChoiceAnswer,
):
  | { readonly ok: true; readonly value: readonly ChoiceMemberState[] }
  | { readonly ok: false; readonly error: Extract<
      ChoiceGroupWriteError,
      'ANSWER_KIND_MISMATCH' | 'INVALID_ANSWER' | 'UNKNOWN_OPTION'
    > } {
  if (identity.kind === 'radio') {
    if (answer.kind !== 'SINGLE_CHOICE') {
      return { ok: false, error: 'ANSWER_KIND_MISMATCH' };
    }
    if (!SAFE_LOCAL_ID.test(answer.optionId)) return { ok: false, error: 'INVALID_ANSWER' };
    const index = identity.optionIds.indexOf(answer.optionId);
    if (index < 0) return { ok: false, error: 'UNKNOWN_OPTION' };
    return {
      ok: true,
      value: Object.freeze(identity.optionIds.map((_optionId, optionIndex) => Object.freeze({
        checked: optionIndex === index,
        indeterminate: false,
      }))),
    };
  }

  if (answer.kind !== 'MULTI_CHOICE') {
    return { ok: false, error: 'ANSWER_KIND_MISMATCH' };
  }
  if (answer.optionIds.length === 0 || answer.optionIds.some((id) => !SAFE_LOCAL_ID.test(id))) {
    return { ok: false, error: 'INVALID_ANSWER' };
  }
  const requested = new Set(answer.optionIds);
  if (requested.size !== answer.optionIds.length) return { ok: false, error: 'INVALID_ANSWER' };
  if ([...requested].some((id) => !identity.optionIds.includes(id))) {
    return { ok: false, error: 'UNKNOWN_OPTION' };
  }
  return {
    ok: true,
    value: Object.freeze(identity.optionIds.map((optionId) => Object.freeze({
      checked: requested.has(optionId),
      indeterminate: false,
    }))),
  };
}

/**
 * Apply a semantic vector without host events. Before the first event there is
 * no framework-visible transaction, so an owned intermediate may be restored
 * synchronously if a native setter cannot produce the expected next state.
 */
function applyVectorProperties(
  identity: PreparedIdentity,
  from: readonly ChoiceMemberState[],
  desired: readonly ChoiceMemberState[],
  mayContinue: () => boolean = () => true,
): {
  readonly ok: boolean;
  readonly changedIndexes: readonly number[];
  readonly ownedStates: ReadonlySet<string>;
} {
  const changedIndexes = from.flatMap((value, index) =>
    value.checked === desired[index]?.checked &&
      value.indeterminate === desired[index]?.indeterminate
      ? []
      : [index],
  );
  const ownedStates = new Set<string>([vectorKey(from)]);
  let expected = from.map((state) => ({ ...state }));

  const recordAndVerify = (): boolean => {
    ownedStates.add(vectorKey(expected));
    const after = readVector(identity);
    return mayContinue() && after !== null && sameVector(after, expected);
  };
  const verifyExpected = (): boolean => {
    if (!mayContinue()) return false;
    const live = readVector(identity);
    return live !== null && sameVector(live, expected);
  };
  const setIndeterminate = (index: number, value: boolean): boolean => {
    if (!verifyExpected()) return false;
    const nextExpected = expected.map((state, optionIndex) => optionIndex === index
      ? { ...state, indeterminate: value }
      : { ...state });
    try {
      identity.access[index]!.setIndeterminate(value);
    } catch {
      const afterThrow = readVector(identity);
      if (afterThrow !== null && sameVector(afterThrow, nextExpected)) {
        expected = nextExpected;
        ownedStates.add(vectorKey(expected));
      }
      return false;
    }
    expected = nextExpected;
    return recordAndVerify();
  };
  const setChecked = (index: number, value: boolean): boolean => {
    if (!verifyExpected()) return false;
    const nextExpected = identity.kind === 'radio' && value
      ? expected.map((state, optionIndex) => ({
          ...state,
          checked: optionIndex === index,
        }))
      : expected.map((state, optionIndex) => optionIndex === index
          ? { ...state, checked: value }
          : { ...state });
    try {
      identity.access[index]!.setChecked(value);
    } catch {
      const afterThrow = readVector(identity);
      if (afterThrow !== null && sameVector(afterThrow, nextExpected)) {
        expected = nextExpected;
        ownedStates.add(vectorKey(expected));
      }
      return false;
    }
    expected = nextExpected;
    return recordAndVerify();
  };

  // For a radio, clear non-target members before setting the one target true.
  // Checkbox order is simply DOM order. No host event is emitted until every
  // property has reached the complete final vector.
  const order = [
    ...changedIndexes.filter((index) => desired[index]?.checked === false),
    ...changedIndexes.filter((index) => desired[index]?.checked === true),
  ];
  for (const index of order) {
    const target = desired[index]!;
    const current = expected[index]!;
    // Clear the presentational mixed state before changing selection; when an
    // owned Undo restores indeterminate=true, restore that bit last.
    if (
      identity.kind === 'checkbox' &&
      current.indeterminate &&
      !target.indeterminate &&
      !setIndeterminate(index, false)
    ) {
      return { ok: false, changedIndexes, ownedStates };
    }
    if (expected[index]!.checked !== target.checked && !setChecked(index, target.checked)) {
      return { ok: false, changedIndexes, ownedStates };
    }
    if (
      identity.kind === 'checkbox' &&
      !expected[index]!.indeterminate &&
      target.indeterminate &&
      !setIndeterminate(index, true)
    ) {
      return { ok: false, changedIndexes, ownedStates };
    }
  }
  return { ok: true, changedIndexes, ownedStates };
}

/** Restore properties only while the live vector is a transaction-produced intermediate. */
function restoreUnpublishedOwnedState(
  identity: PreparedIdentity,
  before: readonly ChoiceMemberState[],
  ownedStates: ReadonlySet<string>,
  mayContinue: () => boolean = () => true,
): boolean {
  const recoveryStates = new Set(ownedStates);
  let live = readVector(identity);
  const maxAttempts = identity.elements.length * 2 + 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!mayContinue()) return false;
    if (live === null || !recoveryStates.has(vectorKey(live))) return false;
    if (sameVector(live, before)) return true;
    const recovery = applyVectorProperties(identity, live, before, mayContinue);
    for (const key of recovery.ownedStates) recoveryStates.add(key);
    live = readVector(identity);
  }
  return live !== null && sameVector(live, before);
}

/**
 * A dispatcher can be hostile enough that the capture observer cannot prove
 * whether notifications ran. While the exact leaf-written vector is still
 * live, close that synchronous failure by restoring and notifying the host,
 * then require an exact semantic readback. No long-lived Undo authority is
 * issued from an untrusted observer.
 */
type PublicationUnknownRecovery =
  | { readonly terminal: 'BEFORE' }
  | { readonly terminal: 'OWNERSHIP_LOST' };

async function restorePublicationUnknownState(
  identity: PreparedIdentity,
  before: readonly ChoiceMemberState[],
  written: readonly ChoiceMemberState[],
  changedIndexes: readonly number[],
  eventFence: InFlightEventFence,
  settleOverride?: () => Promise<void> | void,
): Promise<PublicationUnknownRecovery> {
  const live = readVector(identity);
  if (live === null || !sameVector(live, written)) {
    return { terminal: 'OWNERSHIP_LOST' };
  }
  const recoveryMayContinue = () => !eventFence.wasExternallyEdited();
  const applied = applyVectorProperties(identity, live, before, recoveryMayContinue);
  let recoveryProven = applied.ok;
  if (!applied.ok) {
    recoveryProven = restoreUnpublishedOwnedState(
      identity,
      before,
      applied.ownedStates,
      recoveryMayContinue,
    );
  }
  let restored = readVector(identity);
  recoveryProven = recoveryProven && restored !== null && sameVector(restored, before);
  if (recoveryProven) {
    for (const index of changedIndexes) {
      if (!eventFence.dispatchExpected(identity.elements[index]!, 'input')) {
        recoveryProven = false;
        break;
      }
      if (eventFence.wasExternallyEdited()) {
        recoveryProven = false;
        break;
      }
      const afterInput = readVector(identity);
      if (afterInput === null || !sameVector(afterInput, before)) {
        recoveryProven = false;
        break;
      }
      if (!eventFence.dispatchExpected(identity.elements[index]!, 'change')) {
        recoveryProven = false;
        break;
      }
      if (eventFence.wasExternallyEdited()) {
        recoveryProven = false;
        break;
      }
      const afterChange = readVector(identity);
      if (afterChange === null || !sameVector(afterChange, before)) {
        recoveryProven = false;
        break;
      }
    }
  }
  const settled = await settle(settleOverride);
  restored = readVector(identity);
  if (
    recoveryProven &&
    settled &&
    !eventFence.wasExternallyEdited() &&
    restored !== null &&
    sameVector(restored, before)
  ) return { terminal: 'BEFORE' };
  return { terminal: 'OWNERSHIP_LOST' };
}

async function settle(settleOverride?: () => Promise<void> | void): Promise<boolean> {
  try {
    if (settleOverride) await Promise.resolve().then(settleOverride);
    else await settleAfterHostWrite();
    return true;
  } catch {
    return false;
  }
}

function createUndo(
  identity: PreparedIdentity,
  before: readonly ChoiceMemberState[],
  written: readonly ChoiceMemberState[],
  eventFence: InFlightEventFence,
): ChoiceGroupUndo {
  let retired = false;
  let lostOwnership = false;

  const retire = () => {
    if (retired) return;
    retired = true;
    eventFence.dispose();
  };
  const at = (expected: readonly ChoiceMemberState[]) => {
    if (retired) return false;
    const live = readVector(identity);
    return live !== null && sameVector(live, expected);
  };
  const failAfterRestorePublication = () => {
    const externalBeforeCleanup = eventFence.wasExternallyEdited();
    retire();
    const live = readVector(identity);
    const terminalIsOwned = live !== null && (
      sameVector(live, before) || sameVector(live, written)
    );
    if (externalBeforeCleanup || !terminalIsOwned) lostOwnership = true;
    return lostOwnership
      ? { ok: false as const, error: 'UNDO_NOT_OWNED' as const }
      : { ok: false as const, error: 'UNDO_RESTORE_FAILED' as const };
  };
  const externallyEdited = () => {
    if (lostOwnership || eventFence.wasExternallyEdited()) {
      lostOwnership = true;
      return true;
    }
    if (!retired && !at(written)) lostOwnership = true;
    return lostOwnership;
  };

  return Object.freeze({
    wasExternallyEdited: externallyEdited,
    isAtWrittenState: () => !externallyEdited() && at(written),
    restorePreWrite: async (input?: ChoiceGroupUndoRestoreInput) => {
      if (retired) return { ok: false as const, error: 'UNDO_RETIRED' as const };
      if (externallyEdited() || !at(written)) {
        lostOwnership = true;
        retire();
        return { ok: false as const, error: 'UNDO_NOT_OWNED' as const };
      }
      let settleOverride: (() => Promise<void> | void) | undefined;
      let settleAccessFailed = false;
      try {
        settleOverride = input?.settle;
      } catch {
        settleAccessFailed = true;
      }
      const settleTypeInvalid = settleOverride !== undefined &&
        typeof settleOverride !== 'function';
      // The accessor itself is hostile code. Revalidate the exact WRITTEN
      // precondition after it runs, including re-entrant disposal or a silent
      // move to BEFORE/third state, before choosing a failure contract.
      if (
        retired ||
        eventFence.wasExternallyEdited() ||
        !at(written)
      ) {
        lostOwnership = true;
        retire();
        return { ok: false as const, error: 'UNDO_NOT_OWNED' as const };
      }
      if (settleAccessFailed || settleTypeInvalid) {
        const externalBeforeCleanup = eventFence.wasExternallyEdited();
        retire();
        const terminal = readVector(identity);
        if (
          externalBeforeCleanup ||
          terminal === null ||
          !sameVector(terminal, written)
        ) {
          lostOwnership = true;
          return { ok: false as const, error: 'UNDO_NOT_OWNED' as const };
        }
        return { ok: false as const, error: 'UNDO_RESTORE_FAILED' as const };
      }

      const undoMayContinue = () => !eventFence.wasExternallyEdited() && !retired;
      const applied = applyVectorProperties(identity, written, before, undoMayContinue);
      if (!applied.ok) {
        // Restore notifications have not started. Compensate only an exact
        // transaction-produced intermediate back to WRITTEN; never overwrite
        // an out-of-seal host state.
        if (eventFence.wasExternallyEdited()) {
          lostOwnership = true;
          retire();
          return { ok: false as const, error: 'UNDO_NOT_OWNED' as const };
        }
        const compensationOwnedStates = new Set(applied.ownedStates);
        let terminal = readVector(identity);
        const maxCompensationAttempts = identity.elements.length * 2 + 2;
        for (let attempt = 0; attempt < maxCompensationAttempts; attempt += 1) {
          if (
            terminal === null ||
            sameVector(terminal, written) ||
            sameVector(terminal, before) ||
            !compensationOwnedStates.has(vectorKey(terminal)) ||
            eventFence.wasExternallyEdited()
          ) break;
          const compensation = applyVectorProperties(
            identity,
            terminal,
            written,
            undoMayContinue,
          );
          for (const key of compensation.ownedStates) compensationOwnedStates.add(key);
          terminal = readVector(identity);
        }
        const terminalIsOwned = terminal !== null && (
          sameVector(terminal, written) || sameVector(terminal, before)
        );
        const externalBeforeCleanup = eventFence.wasExternallyEdited();
        if (!terminalIsOwned || externalBeforeCleanup) lostOwnership = true;
        retire();
        terminal = readVector(identity);
        const postCleanupTerminalIsOwned = terminal !== null && (
          sameVector(terminal, written) || sameVector(terminal, before)
        );
        if (!postCleanupTerminalIsOwned) lostOwnership = true;
        return lostOwnership
          ? { ok: false as const, error: 'UNDO_NOT_OWNED' as const }
          : { ok: false as const, error: 'UNDO_RESTORE_FAILED' as const };
      }
      for (const index of applied.changedIndexes) {
        if (!eventFence.dispatchExpected(identity.elements[index]!, 'input')) {
          return failAfterRestorePublication();
        }
        const afterInput = readVector(identity);
        if (afterInput === null || !sameVector(afterInput, before)) {
          return failAfterRestorePublication();
        }
        if (!eventFence.dispatchExpected(identity.elements[index]!, 'change')) {
          return failAfterRestorePublication();
        }
        const afterChange = readVector(identity);
        if (afterChange === null || !sameVector(afterChange, before)) {
          return failAfterRestorePublication();
        }
      }
      const settled = await settle(settleOverride);
      const externallyChangedDuringRestore = retired || eventFence.wasExternallyEdited();
      const finalReadback = readVector(identity);
      const restoredBeforeCleanup = settled &&
        !externallyChangedDuringRestore &&
        finalReadback !== null &&
        sameVector(finalReadback, before);
      const terminalIsWritten = finalReadback !== null && sameVector(finalReadback, written);
      if (
        externallyChangedDuringRestore ||
        (finalReadback !== null && !sameVector(finalReadback, before) && !terminalIsWritten) ||
        finalReadback === null
      ) lostOwnership = true;
      retire();
      const postCleanupReadback = readVector(identity);
      const postCleanupIsBefore = postCleanupReadback !== null &&
        sameVector(postCleanupReadback, before);
      const postCleanupIsWritten = postCleanupReadback !== null &&
        sameVector(postCleanupReadback, written);
      if (!postCleanupIsBefore && !postCleanupIsWritten) lostOwnership = true;
      if (restoredBeforeCleanup && postCleanupIsBefore && !lostOwnership) {
        return { ok: true as const };
      }
      return lostOwnership
        ? { ok: false as const, error: 'UNDO_NOT_OWNED' as const }
        : { ok: false as const, error: 'UNDO_RESTORE_FAILED' as const };
    },
    isAtPreWriteState: () => at(before),
    dispose: retire,
  });
}

interface InFlightEventFence {
  readonly dispatchExpected: (
    element: HTMLInputElement,
    type: 'input' | 'change',
  ) => boolean;
  /**
   * Own the events of one native activation of `element`: the synthetic `click`
   * the caller dispatches plus the `input`/`change` the user agent emits as the
   * activation behaviour. While the window is open no form owned by this group
   * may submit — the veto is the reason this one click may skip the
   * `preventDefault` the rest of the click boundary applies.
   */
  readonly activateExpected: (
    element: HTMLInputElement,
    activate: () => void,
  ) => boolean;
  readonly wasExternallyEdited: () => boolean;
  readonly canRetainOwnership: () => boolean;
  readonly dispose: () => void;
}

type ObservationLayer = 'intrinsic' | 'supplemental';

interface ObservationCallbackCell {
  current: ((layer: ObservationLayer, event: Event) => void) | null;
}

// Keep registered listener closures outside the transaction's lexical scope.
// Once the cell is cleared, a hostile remove wrapper can retain only this
// inert cell and layer token—not the group identity or ownership state.
function layerObserver(
  cell: ObservationCallbackCell,
  layer: ObservationLayer,
): EventListener {
  return (event) => cell.current?.(layer, event);
}

/**
 * Observe the gap from first notification through Undo retirement. One exact
 * Event object, delivered at most once per observation layer, is consumed for
 * each leaf dispatch; any clone, replay, nested delivery, or additional group
 * event is external even if target/type and final vector coincidentally match.
 */
function createInFlightEventFence(identity: PreparedIdentity): InFlightEventFence | null {
  let disposed = false;
  let external = false;
  let observerProven = false;
  let observerTrusted = true;
  let expected: {
    readonly element: HTMLInputElement;
    readonly type: 'input' | 'change';
    event: Event | null;
    consumed: boolean;
    readonly observedLayers: Set<ObservationLayer>;
  } | null = null;
  let activation: {
    readonly element: HTMLInputElement;
    readonly seen: Map<string, { readonly event: Event; readonly layers: Set<ObservationLayer> }>;
    blockedSubmit: boolean;
  } | null = null;

  const observe = (layer: ObservationLayer, event: Event) => {
    if (disposed) return;
    try {
      const isGroupEvent = event.type === 'reset' || event.type === 'submit'
        ? identity.forms.some((form) => form !== null && event.target === form)
        : identity.elements.some((element) => event.target === element);
      if (!isGroupEvent) return;
      // 激活窗口期间按住提交。窗口之外只记外部编辑——用户自己按下的提交
      // 不是我们该拦的东西。
      if (event.type === 'submit') {
        if (activation !== null) {
          activation.blockedSubmit = true;
          event.preventDefault();
        }
        external = true;
        return;
      }
      if (activation !== null && event.target === activation.element) {
        if (!ACTIVATION_EVENTS.has(event.type)) {
          external = true;
          return;
        }
        // Same exact-object, once-per-layer rule `dispatchExpected` uses: the
        // one propagation path reaches Window and owner-realm Document, so each
        // object may be observed once per layer and never twice at one layer.
        const record = activation.seen.get(event.type);
        if (record === undefined) {
          activation.seen.set(event.type, { event, layers: new Set([layer]) });
          observerProven = true;
          return;
        }
        if (record.event !== event || record.layers.has(layer)) {
          external = true;
          return;
        }
        record.layers.add(layer);
        return;
      }
      if (
        expected !== null &&
        event === expected.event &&
        event.target === expected.element &&
        event.type === expected.type
      ) {
        // Light DOM observes at both Window and owner-realm Document. The same
        // exact object may therefore arrive once per layer along one propagation
        // path. Re-observation at either layer proves a full same-object replay.
        if (expected.observedLayers.has(layer)) {
          external = true;
          return;
        }
        expected.observedLayers.add(layer);
        if (expected.consumed === false) {
          expected.consumed = true;
          observerProven = true;
        }
        return;
      }
      external = true;
    } catch {
      // Event fields are a host boundary too. Any unreadable property makes
      // exact-object ownership unprovable and must never escape the listener.
      external = true;
    }
  };
  // Bind the observation layer in our own closures. Host code may redefine an
  // Event instance's currentTarget getter, so it cannot be an authority token
  // for exact-object replay detection. Clear the detached callback cell on
  // every retirement path to sever retained wrappers from this transaction.
  const observerCell: ObservationCallbackCell = { current: observe };
  const intrinsicObserver = layerObserver(observerCell, 'intrinsic');
  const supplementalObserver = layerObserver(observerCell, 'supplemental');
  const attached: (typeof OBSERVED_EVENTS)[number][] = [];
  try {
    if (!identity.eventAccess.isCurrent()) return null;
    // DOM registration is necessarily per event type. This dormant leaf does
    // not claim production observer authority by itself: a runtime integrator
    // must supply pristine registration/removal authority and prove that an
    // earlier same-layer listener or a cross-type event during this finite
    // setup cannot hide a delivery before enabling the leaf.
    for (const event of OBSERVED_EVENTS) {
      // Track the attempted registration first: a hostile realm method can
      // register successfully and then throw, and that listener still needs
      // removal before this failed fence is discarded.
      attached.push(event);
      identity.eventAccess.addCapture(event, intrinsicObserver, supplementalObserver);
    }
  } catch {
    disposed = true;
    observerCell.current = null;
    for (const event of attached) {
      try {
        identity.eventAccess.removeCapture(event, intrinsicObserver, supplementalObserver);
      } catch {
        // No authority is returned from a failed observer setup.
      }
    }
    return null;
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observerCell.current = null;
    for (const event of attached) {
      try {
        identity.eventAccess.removeCapture(event, intrinsicObserver, supplementalObserver);
      } catch {
        // The fence is locally retired even if a hostile host patched removal.
      }
    }
  };

  return Object.freeze({
    dispatchExpected: (
      element: HTMLInputElement,
      type: 'input' | 'change',
    ) => {
      if (disposed || external || expected !== null) return false;
      expected = {
        element,
        type,
        event: null,
        consumed: false,
        observedLayers: new Set<ObservationLayer>(),
      };
      try {
        dispatchHostEvent(element, type, undefined, (event) => {
          if (expected === null || expected.event !== null) {
            external = true;
            return;
          }
          expected.event = event;
        });
      } catch {
        // Dispatch may throw after synchronous listeners already received the
        // exact event. Preserve that proof so the caller can retain an owned
        // recovery; an unobserved throw remains publication-unknown.
        if (expected.consumed === false) observerTrusted = false;
        expected = null;
        return false;
      }
      const observed = expected.consumed;
      expected = null;
      if (!observed) observerTrusted = false;
      return observed && !external;
    },
    activateExpected: (element: HTMLInputElement, activate: () => void) => {
      if (disposed || external || expected !== null || activation !== null) return false;
      if (!identity.elements.some((member) => member === element)) return false;
      // 不叫 `window`：这是 DOM 代码，遮蔽全局 `window` 只会让下一个读者停顿。
      const opened = {
        element,
        seen: new Map<string, { readonly event: Event; readonly layers: Set<ObservationLayer> }>(),
        blockedSubmit: false,
      };
      activation = opened;
      try {
        activate();
      } catch {
        // A synchronous listener may already have received the exact click.
        // Ownership is then unprovable, exactly as for a throwing dispatch.
        observerTrusted = false;
        activation = null;
        return false;
      } finally {
        activation = null;
      }
      // 这一下期间宿主试过提交：拦下了，但这次写入的所有权就此作废。
      if (opened.blockedSubmit) {
        observerTrusted = false;
        return false;
      }
      // 连我们自己派的 click 都没观测到 ⇒ 观察器没在工作，不能据此发放所有权。
      if (!opened.seen.has('click')) {
        observerTrusted = false;
        return false;
      }
      return !external;
    },
    wasExternallyEdited: () => external,
    canRetainOwnership: () =>
      !disposed && !external && observerProven && observerTrusted,
    dispose,
  });
}

function writeGroup(
  identity: PreparedIdentity,
  input: ChoiceGroupWriteInput,
): Promise<
  | { readonly ok: true; readonly value: ChoiceGroupWriteOk }
  | {
      readonly ok: false;
      readonly error: ChoiceGroupWriteError;
      readonly undo?: ChoiceGroupUndo;
    }
> {
  return (async () => {
    let boundary: ChoiceWriteBoundary;
    let answer: ChoiceAnswer;
    let settleOverride: (() => Promise<void> | void) | undefined;
    try {
      boundary = input.boundary;
      answer = input.answer;
      settleOverride = input.settle;
    } catch {
      return { ok: false as const, error: 'VERIFY_FAILED' as const };
    }
    if (settleOverride !== undefined && typeof settleOverride !== 'function') {
      return { ok: false as const, error: 'VERIFY_FAILED' as const };
    }
    if (boundary !== 'ORDINARY_REVERSIBLE') {
      return { ok: false as const, error: 'MANUAL_ONLY' as const };
    }
    const normalizedAnswer = normalizeChoiceAnswer(answer);
    if (!normalizedAnswer.ok) return normalizedAnswer;
    const desired = desiredVector(identity, normalizedAnswer.value);
    if (!desired.ok) return desired;

    // Establish the event fence before every write-time DOM identity or state
    // read. Host getters are executable boundaries too: a checked/name/etc.
    // accessor can synchronously publish a group event without changing the
    // vector, and that still invalidates ownership for this attempted write.
    const eventFence = createInFlightEventFence(identity);
    if (eventFence === null) {
      return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    }
    if (!identityIsCurrent(identity)) {
      const externallyEdited = eventFence.wasExternallyEdited();
      eventFence.dispose();
      if (externallyEdited) {
        return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
      }
      return { ok: false as const, error: 'GROUP_IDENTITY_CHANGED' as const };
    }
    if (eventFence.wasExternallyEdited()) {
      eventFence.dispose();
      return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    }
    if (identity.effectiveDisabledState.some((disabled) => disabled)) {
      eventFence.dispose();
      return { ok: false as const, error: 'TARGET_NOT_WRITABLE' as const };
    }

    // This is the all-member write-time snapshot. No DOM mutation or host
    // event occurs before both identity and the full semantic vector exist.
    const before = readVector(identity);
    if (eventFence.wasExternallyEdited()) {
      eventFence.dispose();
      return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    }
    if (before === null) {
      eventFence.dispose();
      return { ok: false as const, error: 'GROUP_IDENTITY_CHANGED' as const };
    }
    const beforeSnapshot = snapshot(identity, before);
    if (sameVector(before, desired.value)) {
      eventFence.dispose();
      const terminal = readVector(identity);
      if (terminal === null || !sameVector(terminal, desired.value)) {
        return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
      }
      return {
        ok: true as const,
        value: Object.freeze({
          before: beforeSnapshot,
          readback: snapshot(identity, desired.value),
          undo: null,
        }),
      };
    }

    const disposeAndVerifyBefore = (wasBeforeBeforeCleanup: boolean) => {
      eventFence.dispose();
      const terminal = readVector(identity);
      return wasBeforeBeforeCleanup && terminal !== null && sameVector(terminal, before)
        ? { ok: false as const, error: 'WRITE_REVERTED' as const }
        : { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    };
    const mutationMayContinue = () => !eventFence.wasExternallyEdited();
    const failUnpublishedWrite = (ownedStates: ReadonlySet<string>) => {
      if (eventFence.wasExternallyEdited()) {
        eventFence.dispose();
        return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
      }
      const restored = restoreUnpublishedOwnedState(
        identity,
        before,
        ownedStates,
        mutationMayContinue,
      );
      // No event has been published, and an unproven observer must never be
      // promoted into long-lived Undo authority. The bounded intrinsic retry
      // above is the only compensation permitted on this path. Cleanup is a
      // hostile boundary too, so re-read AFTER listener retirement.
      return disposeAndVerifyBefore(restored && !eventFence.wasExternallyEdited());
    };

    const applied = applyVectorProperties(
      identity,
      before,
      desired.value,
      mutationMayContinue,
    );
    if (!applied.ok) {
      return failUnpublishedWrite(applied.ownedStates);
    }
    const preEvent = readVector(identity);
    if (preEvent === null || !sameVector(preEvent, desired.value)) {
      return failUnpublishedWrite(applied.ownedStates);
    }

    // All changed properties are final before the first event. After events
    // begin, a host-produced third state is never overwritten as compensation.
    const failPublishedWrite = async () => {
      const live = readVector(identity);
      if (
        !eventFence.wasExternallyEdited() &&
        live !== null
      ) {
        if (sameVector(live, before)) {
          return disposeAndVerifyBefore(true);
        }
        if (sameVector(live, desired.value)) {
          if (eventFence.canRetainOwnership()) {
            const undo = createUndo(identity, before, live, eventFence);
            if (undo.isAtWrittenState()) {
              return { ok: false as const, error: 'WRITE_REVERTED' as const, undo };
            }
            undo.dispose();
          } else {
            const recovery = await restorePublicationUnknownState(
              identity,
              before,
              live,
              applied.changedIndexes,
              eventFence,
              settleOverride,
            );
            if (recovery.terminal === 'BEFORE') return disposeAndVerifyBefore(true);
            eventFence.dispose();
            return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
          }
        }
      }
      eventFence.dispose();
      return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    };
    for (const index of applied.changedIndexes) {
      if (!eventFence.dispatchExpected(identity.elements[index]!, 'input')) {
        return failPublishedWrite();
      }
      const afterInput = readVector(identity);
      if (afterInput === null || !sameVector(afterInput, desired.value)) {
        return failPublishedWrite();
      }
      if (!eventFence.dispatchExpected(identity.elements[index]!, 'change')) {
        return failPublishedWrite();
      }
      const afterChange = readVector(identity);
      if (afterChange === null || !sameVector(afterChange, desired.value)) {
        return failPublishedWrite();
      }
    }

    const settled = await settle(settleOverride);
    if (eventFence.wasExternallyEdited()) {
      eventFence.dispose();
      return { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    }
    const written = readVector(identity);
    if (written === null || !sameVector(written, desired.value)) {
      return disposeAndVerifyBefore(written !== null && sameVector(written, before));
    }
    const undo = createUndo(identity, before, written, eventFence);
    // The same capture fence remains attached from the first host event
    // through Undo retirement, so there is no readback/listener ownership gap.
    if (!undo.isAtWrittenState()) {
      undo.dispose();
      const terminal = readVector(identity);
      return terminal !== null && sameVector(terminal, before)
        ? { ok: false as const, error: 'WRITE_REVERTED' as const }
        : { ok: false as const, error: 'WRITE_AUTHORITY_LOST' as const };
    }
    if (!settled) {
      return { ok: false as const, error: 'VERIFY_FAILED' as const, undo };
    }
    return {
      ok: true as const,
      value: Object.freeze({
        before: beforeSnapshot,
        readback: snapshot(identity, written),
        undo,
      }),
    };
  })();
}

async function fillOnlyGroup(
  identity: PreparedIdentity,
  input: ChoiceGroupFillOnlyInput,
): Promise<FillOnlySemanticResult> {
  let normalized: ReturnType<typeof normalizeChoiceAnswer>;
  try {
    normalized = normalizeChoiceAnswer(input.answer);
  } catch {
    return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
  }
  if (!normalized.ok) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
  const desired = desiredVector(identity, normalized.value);
  if (!desired.ok) {
    return Object.freeze({
      ok: false,
      code: desired.error === 'UNKNOWN_OPTION' ? 'NO_OPTION_MATCH' : 'CAPABILITY_DISABLED',
    });
  }

  const eventFence = createInFlightEventFence(identity);
  if (eventFence === null) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
  let eventFenceRetired = false;
  const empty = Object.freeze(identity.elements.map(() => Object.freeze({
    checked: false,
    indeterminate: false,
  })));
  const changedIndexes = empty.flatMap((state, index) =>
    sameVector([state], [desired.value[index]!]) ? [] : [index]);
  const targetFence = (): ApplyErrorCode | null => {
    if (!identityIsCurrent(identity)) return 'IDENTITY_CHANGED';
    if (identity.effectiveDisabledState.some(Boolean)) return 'TARGET_NOT_WRITABLE';
    return !eventFenceRetired && eventFence.wasExternallyEdited() ? 'ABORTED' : null;
  };
  const forwardFenceCurrent = (): boolean => {
    try {
      if (input.signal?.aborted || input.executionFence() !== null) return false;
      if (targetFence() !== null || input.signal?.aborted) return false;
      return input.executionFence() === null && !input.signal?.aborted;
    } catch {
      return false;
    }
  };

  /**
   * The exact vector after the first `done` activations. Each activation flips
   * exactly one member: a checkbox toggles itself, and the single radio click
   * both selects its member and clears the siblings — which is why the radio
   * case has one entry in `changedIndexes` and this walks straight to `desired`.
   */
  const intermediate = (done: number): readonly ChoiceMemberState[] =>
    Object.freeze(identity.elements.map((_element, index) => {
      const position = changedIndexes.indexOf(index);
      const applied = position >= 0 && position < done;
      return Object.freeze(applied ? desired.value[index]! : empty[index]!);
    }));
  // 每一步的前后验都要宿主自己认账：`aria-checked` 没翻，这一下就没打进去。
  const vectorIs = (wanted: readonly ChoiceMemberState[]): boolean =>
    vectorSettledAt(identity, wanted);
  /** Native activation: the only path in this leaf that emits a host click. */
  let activationCode: ApplyErrorCode | null = null;
  const activationWriteForward = (
    activation: ChoiceGroupActivation,
    authority: FillOnlyHostWriteAuthority,
  ): boolean => {
    const outcome = activateReviewedChoiceGroup({
      activations: changedIndexes.map((index) => ({
        element: identity.elements[index]!,
        control: identity.kind,
        ...(activation.signOnBehalf === undefined ? {} : { signOnBehalf: activation.signOnBehalf }),
      })),
      root: activation.root,
      authority,
      capabilityCurrent: activation.capabilityCurrent,
      beforeEach: (step) => forwardFenceCurrent() && vectorIs(intermediate(step)),
      afterEach: (step) => forwardFenceCurrent() && vectorIs(intermediate(step + 1)),
      withOwnership: (element, activate) => eventFence.activateExpected(element, activate),
    });
    // `executeFillOnlySemanticWrite` only sees true/false and folds a false into
    // HOST_REJECTED. The caller needs the difference between "the host refused
    // this answer" and "clicking was not available", so keep the exact code.
    activationCode = outcome.ok ? null : outcome.code;
    return outcome.ok;
  };

  const result = await executeFillOnlySemanticWrite({
    authorizeWrite: input.authorizeWrite,
    executionFence: input.executionFence,
    targetFence,
    // 写前与写后都按同一条标准判：属性向量对上，且**宿主公布的状态**也对上。
    // 只读我们刚写进去的属性，等于让一次写入给自己打分——Workday 的 radio
    // 上那正是一个稳定的假阳性（属性 true、`aria-checked` 永远 false、
    // 宿主一直说这道题没答）。
    isAtPreWriteState: () => vectorSettledAt(identity, empty),
    isAtWrittenState: () => vectorSettledAt(identity, desired.value),
    writeForward: (authority) => {
      const activation = input.activation;
      if (activation !== undefined) return activationWriteForward(activation, authority);
      const applied = applyVectorProperties(
        identity,
        empty,
        desired.value,
        forwardFenceCurrent,
      );
      if (!applied.ok) return false;
      for (const index of changedIndexes) {
        const element = identity.elements[index]!;
        if (!eventFence.dispatchExpected(element, 'input')) return false;
        if (!forwardFenceCurrent()) return false;
        const afterInput = readVector(identity);
        if (afterInput === null || !sameVector(afterInput, desired.value)) return false;
        if (!forwardFenceCurrent()) return false;
        if (!eventFence.dispatchExpected(element, 'change')) return false;
        if (!forwardFenceCurrent()) return false;
        const afterChange = readVector(identity);
        if (afterChange === null || !sameVector(afterChange, desired.value)) return false;
      }
      return true;
    },
    readHostValidation: () => input.readHostValidation(identity.elements),
    lateRecheckMs: input.lateRecheckMs,
    operationTimeoutMs: input.operationTimeoutMs,
    signal: input.signal,
    settle: input.settle,
    lateRecheckDelay: input.lateRecheckDelay,
  });
  if (!result.ok) {
    eventFenceRetired = true;
    eventFence.dispose();
    // fill-only 结算把 `writeForward` 的 false 一律折成 HOST_REJECTED。上层要
    // 区分「宿主拒绝了这个答案」与「这一下根本没打起来」（policy 关掉了点击、
    // 某个成员被 deny、目标脱离文档），所以把确切的码还回去。
    if (activationCode !== null && result.code === 'HOST_REJECTED') {
      return Object.freeze({ ...result, code: activationCode });
    }
    return result;
  }
  return Object.freeze({
    ok: true,
    observation: Object.freeze({
      check: result.observation.check,
      finalize: (retireConsumer?: () => boolean) => result.observation.finalize(() => {
        let clean = true;
        try {
          if (retireConsumer !== undefined && retireConsumer() !== true) clean = false;
        } catch {
          clean = false;
        }
        if (eventFence.wasExternallyEdited()) clean = false;
        eventFenceRetired = true;
        eventFence.dispose();
        return clean;
      }),
      dispose: () => {
        result.observation.dispose();
        eventFenceRetired = true;
        eventFence.dispose();
      },
    }),
  });
}

function prepareChoiceGroupUnchecked(input: PrepareChoiceGroupInput): PrepareChoiceGroupResult {
  // Snapshot every caller-owned input exactly once before inspecting DOM
  // identity. A hostile accessor must not escape the explicit Result contract
  // or change the prepared question after validation.
  const questionId = input.questionId;
  const rawOptions = input.options;
  if (typeof questionId !== 'string' || !SAFE_LOCAL_ID.test(questionId)) {
    return { ok: false, error: 'INVALID_QUESTION_ID' };
  }
  if (!Array.isArray(rawOptions)) {
    return { ok: false, error: 'GROUP_STATE_UNAVAILABLE' };
  }
  const optionCount = rawOptions.length;
  if (optionCount === 0) {
    return { ok: false, error: 'EMPTY_OPTION_MEMBERSHIP' };
  }

  const optionIds: string[] = [];
  const elements: HTMLInputElement[] = [];
  for (let index = 0; index < optionCount; index += 1) {
    const option = rawOptions[index]!;
    const optionId = option.optionId;
    const element = option.element;
    if (typeof optionId !== 'string' || !SAFE_LOCAL_ID.test(optionId)) {
      return { ok: false, error: 'INVALID_OPTION_ID' };
    }
    optionIds.push(optionId);
    elements.push(element);
  }
  if (new Set(optionIds).size !== optionIds.length) {
    return { ok: false, error: 'DUPLICATE_OPTION_ID' };
  }

  const membership: ChoiceGroupMembership = input.membership === 'declared' ? 'declared' : 'native';
  const first = elements[0]!;
  const firstType = first.type;
  if (!isChoiceKind(firstType)) return { ok: false, error: 'NOT_A_CHOICE_CONTROL' };
  const kind = firstType;
  const name = first.name;
  const form = first.form;
  const root = first.getRootNode();
  const document = first.ownerDocument;
  const firstConnected = first.isConnected;
  const firstRequired = first.required;
  if (!firstConnected) return { ok: false, error: 'DETACHED_OPTION' };
  if (membership === 'native' && (name === '' || form === null)) {
    return { ok: false, error: 'MIXED_GROUP_IDENTITY' };
  }

  const requiredState: boolean[] = [];
  const names: string[] = [];
  const forms: (HTMLFormElement | null)[] = [];
  for (const [index, element] of elements.entries()) {
    const type = index === 0 ? kind : element.type;
    const connected = index === 0 ? firstConnected : element.isConnected;
    const elementName = index === 0 ? name : element.name;
    const elementForm: HTMLFormElement | null = index === 0 ? form : element.form;
    const elementRoot = index === 0 ? root : element.getRootNode();
    const required = index === 0 ? firstRequired : element.required;
    if (!isChoiceKind(type)) return { ok: false, error: 'NOT_A_CHOICE_CONTROL' };
    if (!connected) return { ok: false, error: 'DETACHED_OPTION' };
    if (type !== kind || elementRoot !== root) return { ok: false, error: 'MIXED_GROUP_IDENTITY' };
    if (membership === 'native' && (elementName !== name || elementForm !== form)) {
      return { ok: false, error: 'MIXED_GROUP_IDENTITY' };
    }
    requiredState.push(required);
    names.push(elementName);
    forms.push(elementForm);
  }

  const access = elements.map((element) => choiceAccess(element, kind));
  const eventAccess = nativeEventAccess(document, root);
  if (access.some((candidate) => candidate === null) || eventAccess === null) {
    return { ok: false, error: 'GROUP_STATE_UNAVAILABLE' };
  }
  let effectiveDisabledState: readonly boolean[];
  let publishesHostState: readonly boolean[];
  try {
    effectiveDisabledState = Object.freeze(
      (access as NativeChoiceAccess[]).map((candidate) => candidate.getEffectiveDisabled()),
    );
    publishesHostState = Object.freeze(
      (access as NativeChoiceAccess[]).map((candidate) => candidate.getPublishedChecked() !== null),
    );
  } catch {
    return { ok: false, error: 'GROUP_STATE_UNAVAILABLE' };
  }
  const identity: PreparedIdentity = Object.freeze({
    elements: Object.freeze(elements),
    optionIds: Object.freeze(optionIds),
    kind,
    membership,
    names: Object.freeze(names),
    forms: Object.freeze(forms),
    root,
    requiredState: Object.freeze(requiredState),
    effectiveDisabledState,
    publishesHostState,
    access: Object.freeze(access as NativeChoiceAccess[]),
    eventAccess,
  });
  if (!membershipIsComplete(identity)) {
    return { ok: false, error: 'INCOMPLETE_OPTION_MEMBERSHIP' };
  }
  if (readVector(identity) === null) return { ok: false, error: 'GROUP_STATE_UNAVAILABLE' };

  let fillOnlyConsumed = false;
  const group: ChoiceGroup = Object.freeze({
    questionId,
    kind,
    optionIds: identity.optionIds,
    measurement: Object.freeze({
      logicalQuestions: 1 as const,
      requiredQuestions: requiredState.some(Boolean) ? 1 as const : 0 as const,
    }),
    isEmpty: () => {
      const current = readVector(identity);
      return current !== null && current.every(
        (state) => state.checked === false && state.indeterminate === false,
      );
    },
    /** Whether this group's host publishes its own state for every member. */
    publishesHostState: () => identity.publishesHostState.every(Boolean),
    isAtAnswer: (answer: ChoiceAnswer) => {
      const normalized = normalizeChoiceAnswer(answer);
      if (!normalized.ok) return false;
      const desired = desiredVector(identity, normalized.value);
      if (!desired.ok) return false;
      return vectorSettledAt(identity, desired.value);
    },
    fillOnly: (fillInput: ChoiceGroupFillOnlyInput) => {
      if (fillOnlyConsumed) {
        return Promise.resolve(Object.freeze({ ok: false as const, code: 'CAPABILITY_DISABLED' as const }));
      }
      fillOnlyConsumed = true;
      return fillOnlyGroup(identity, fillInput);
    },
    write: (writeInput: ChoiceGroupWriteInput) => writeGroup(identity, writeInput),
  });
  return { ok: true, value: group };
}

export function prepareChoiceGroup(input: PrepareChoiceGroupInput): PrepareChoiceGroupResult {
  try {
    return prepareChoiceGroupUnchecked(input);
  } catch {
    return { ok: false, error: 'GROUP_STATE_UNAVAILABLE' };
  }
}

/** 选项文字的等价判据（NFKC、折叠空白、不分大小写）：计划期按档案值挑选项与写入期核对选项用的是同一把尺。 */
export const sameText = (a: string, b: string): boolean =>
  a.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === b.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 一次只能选一项的题：原生单选组，以及 ARIA 代理里的切换按钮与 role=radio（2026-09-23）。
 * 原生复选组与 role=checkbox 代理各自独立。
 */
export function isSingleChoiceGroup(choice: ChoiceGroupShape): boolean {
  return choice.control === 'radio' || (choice.control === 'proxy' && !choice.multiple);
}

/**
 * The option labels a reviewed answer names, in option order; null when a line names no
 * option, names more than one member (two members with the same visible label), or a radio
 * group gets more than one. Never a partial selection, never wider than the user confirmed.
 */
export function chosenOptions(choice: ChoiceGroupShape, lines: readonly string[]): readonly string[] | null {
  const labels: readonly string[] = choice.options.map((option) => option.label);
  const members = (line: string) => labels.filter((label) => sameText(label, line));
  if (lines.length === 0 || lines.some((line) => members(line).length !== 1)) return null;
  const chosen = labels.filter((label) => lines.some((line) => sameText(label, line)));
  if (isSingleChoiceGroup(choice) && chosen.length !== 1) return null;
  return chosen;
}

/**
 * 激活这一下**根本没打起来**的说法，与「宿主拒绝了这个答案」相对。
 *
 * 只有这一组码才该回落到属性写入：点击能力被 policy 关掉、某个成员被静态 deny
 * 表拒绝、目标脱离了文档。`HOST_REJECTED` / `LATE_REVERTED` / `WRITE_REVERTED`
 * **不在**表里——那是宿主看见了用户那一下并且不认，再用属性偷偷写一遍，只会把
 * 一个诚实的失败变成一次静默的假成功。
 */
const ACTIVATION_UNAVAILABLE_CODES: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>([
  'CLICK_DENIED',
  'CAPABILITY_DISABLED',
  'DETACHED',
  'POLICY_DISABLED',
]);

/**
 * Runner entry: write one reviewed answer (option labels, one per line) to a scanned
 * group on the fill-first path.
 *
 * ## 为什么默认走原生激活（2026-09-15 改）
 *
 * 属性写入（native `checked` setter + `input`/`change`）对受控宿主**不是慢，是错**。
 * 同日在 jobs.ashbyhq.com/notion/7793e862-…/application 实测两道题：
 *   · 代词单选组：写完在 250ms 的延时复检里就被 React 刷回去 → `LATE_REVERTED`，
 *     这是诚实的失败；
 *   · 「How did you hear about this opportunity?」复选组：同一种写法在复检窗口里
 *     **没有**被刷回去，这一栏报成功；而整页填完之后回读，那个 LinkedIn 复选框
 *     仍然是未勾选的——**一次静默的假成功**，比前者糟得多。
 * 两者的差别只是「下一次重渲染落在 250ms 窗口内还是窗口外」，不是任何可靠的性质：
 * 受控组的下一次重渲染可能由**后面某个字段**的写入触发，那时本组的观察早已结束。
 * 用户做的那一下是 click，宿主只认 click，我们就只能做那一下。
 *
 * 对原生（非受控）组同样安全：radio/checkbox 的 click 默认动作就是改自己的选中态，
 * 用户代理随后自己派发 `input`/`change`；从全空的写前状态出发，每个要勾的成员恰好
 * 点一次，结果是确定的（单选点一次即选中并清掉同名兄弟）。
 *
 * 属性写入仍然保留为**回落**，且条件严格：只有那一下根本没打起来时才回落，
 * 见 `ACTIVATION_UNAVAILABLE_CODES`。
 */
export async function fillChoiceGroup(input: Readonly<{
  questionId: string;
  choice: ChoiceGroupShape;
  lines: readonly string[];
  /** The click boundary re-proves this root itself; it is not trusted from here. */
  root: ScanRoot;
  /** Re-read inside the click boundary; false = this deployment may not click. */
  clickCapabilityCurrent: () => boolean;
  /**
   * 代填的条款同意／属实声明（2026-09-23）与六类同意（2026-09-24）。有它时只走原生点击：点击被拒
   * （能力位在半路关掉、文字变了）就如实失败，**不**回落到属性写入——那条路不经过点击策略，等于绕开了开关。
   */
  signOnBehalf?: SignOnBehalfChoiceKind;
  authorizeWrite: () => Promise<boolean>;
  readHostValidation?: (element: Element) => HostValidationSignals;
  executionFence: () => ApplyErrorCode | null;
  lateRecheckMs: number;
  signal?: AbortSignal;
}>): Promise<Result<void>> {
  const chosen = chosenOptions(input.choice, input.lines);
  if (chosen === null) return { ok: false, code: 'NO_VALUE' };
  const shape = input.choice;
  // ARIA 代理题（2026-09-23）另有一条写入路：点代理（或它承载的原生控件）、按代理公布的状态验，
  // 没有属性回落。条款同意／属实声明不走它（放行范围不含代理题，engine 也不排），带着那两类标记来
  // 就不写；第三刀（2026-09-24）的六类同意走它，但得有题干元素——点击边界每一下之前从它重读题干。
  if (shape.control === 'proxy') {
    const signOnBehalf = input.signOnBehalf;
    const question = shape.question ?? null;
    if (signOnBehalf !== undefined && (!isWholeQuestionKind(signOnBehalf) || question === null)) {
      return { ok: false, code: 'CAPABILITY_DISABLED' };
    }
    return fillProxyChoiceGroup({
      ...(signOnBehalf === undefined || question === null ? {} : { signing: { kind: signOnBehalf, question } }),
      choice: shape,
      chosen,
      root: input.root,
      clickCapabilityCurrent: input.clickCapabilityCurrent,
      authorizeWrite: input.authorizeWrite,
      ...(input.readHostValidation ? { readHostValidation: input.readHostValidation } : {}),
      executionFence: input.executionFence,
      lateRecheckMs: input.lateRecheckMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  const native: NativeChoiceGroupShape = shape;
  const optionId = (index: number) => `o${index}`;
  const optionIds = native.options.flatMap((option, index) => (chosen.includes(option.label) ? [optionId(index)] : []));
  const answer: ChoiceAnswer = native.control === 'radio'
    ? { kind: 'SINGLE_CHOICE', optionId: optionIds[0]! }
    : { kind: 'MULTI_CHOICE', optionIds };

  // 每次尝试都重新 prepare：一次 fillOnly 是一次性的，而且回落那次必须在当下的
  // DOM 身份上重新证明成员关系，不能沿用上一次拿到的那份。
  const attempt = async (
    activation?: ChoiceGroupActivation,
  ): Promise<{ readonly group: ChoiceGroup | null; readonly result: Result<void> }> => {
    const prepared = prepareChoiceGroup({
      questionId: input.questionId,
      options: native.options.map((option, index) => ({ element: option.element, optionId: optionId(index) })),
      // The reviewed scan's option list is the group (rule-grouped question scopes included).
      membership: 'declared',
    });
    if (!prepared.ok) {
      // 一个成员已经不在文档里，说的就是 `DETACHED`：把它折成 IDENTITY_CHANGED
      // 会让「页面把控件换掉了」和「这一组的身份对不上了」两种完全不同的遭遇
      // 读起来一模一样，诊断就白给了。
      const code: ApplyErrorCode = prepared.error === 'GROUP_STATE_UNAVAILABLE'
        ? 'TARGET_NOT_WRITABLE'
        : prepared.error === 'DETACHED_OPTION'
          ? 'DETACHED'
          : 'IDENTITY_CHANGED';
      return { group: null, result: { ok: false, code } };
    }
    // 这一组已经**正是**要写的那个答案（宿主自己也这么说）：那是成功，不是
    // 「身份变了」。重填循环会在同一页上把同一栏再走一遍，而 fill-only 的写前
    // 证明要求全空——不先答这一句，我们自己刚点上去的那一下，下一遍就会被报成
    // IDENTITY_CHANGED，读起来像页面在我们脚下换了控件。
    if (prepared.value.isAtAnswer(answer)) {
      return { group: prepared.value, result: { ok: true, value: undefined } };
    }
    // 已经有别的答案在里面：fill-first 不覆盖用户已经作过的选择。说 NOT_EMPTY，
    // 不说 IDENTITY_CHANGED——后者会把一次正常的「这题已经答过」写成一次故障。
    if (!prepared.value.isEmpty()) {
      return { group: prepared.value, result: { ok: false, code: 'NOT_EMPTY' } };
    }
    const result = await prepared.value.fillOnly({
      answer,
      ...(activation ? { activation } : {}),
      authorizeWrite: input.authorizeWrite,
      // A required checkbox reports valueMissing while unchecked, so the host verdict is read
      // from a member the answer checked; a radio group validates as a whole.
      readHostValidation: (elements) => input.readHostValidation?.(elements.find((element) => element.checked) ?? elements[0]!) ?? {},
      executionFence: input.executionFence,
      lateRecheckMs: input.lateRecheckMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!result.ok) return { group: prepared.value, result: { ok: false, code: result.code } };
    const code = result.observation.finalize();
    result.observation.dispose();
    return { group: prepared.value, result: code ? { ok: false, code } : { ok: true, value: undefined } };
  };

  const activated = await attempt({
    root: input.root,
    capabilityCurrent: input.clickCapabilityCurrent,
    ...(input.signOnBehalf === undefined ? {} : { signOnBehalf: input.signOnBehalf }),
  });
  if (activated.result.ok) return activated.result;
  // 代填的框没有属性回落：它的每一次写入都必须经过点击策略与当下的能力位。
  if (input.signOnBehalf !== undefined) return activated.result;
  if (!ACTIVATION_UNAVAILABLE_CODES.has(activated.result.code)) return activated.result;
  // 回落只在宿主还停在全空的写前状态时允许。留了半截状态就到此为止：fill-first
  // 路径没有撤销，第二次写只会在用户的表单上叠一层我们无法还原的改动。
  if (activated.group === null || !activated.group.isEmpty()) return activated.result;
  // 宿主自己公布 `aria-checked` 时，属性回落**一次都不该发**：实测它写不进
  // 宿主的状态（Workday 2026-09-15：`checked` 变 true、`aria-checked` 永远
  // false、宿主一直说这道题没答），而它留下的那半截属性会让下一遍重扫看到
  // 一个非空的组，于是连原生激活的第二次机会都没有了。少做这一下，重填循环
  // 就能在页面安静下来之后把它真正点上。
  if (activated.group.publishesHostState()) return activated.result;

  const fallback = await attempt();
  // 回落也没成时如实报**第一次**那个诊断：它说的才是这一栏的真实遭遇。
  return fallback.result.ok ? fallback.result : activated.result;
}
