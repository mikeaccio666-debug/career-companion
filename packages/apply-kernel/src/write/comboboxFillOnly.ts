/**
 * Conservative fill-first transaction for one already-expanded ARIA combobox.
 *
 * The transaction never opens a popup and never infers selection from the
 * trigger's display value. Admission requires a complete, twice-observed exact
 * option set whose every member exposes aria-selected. One reviewed option is
 * clicked through the shared deny-list boundary, then semantic selection,
 * host validation, the positive late window, and batch-final readback are
 * required. There is deliberately no previous value or restoration callback.
 */

import type { ApplyErrorCode, ScanRoot } from '../contracts.ts';
import { clickReviewedFillOnlyOption } from '../click/primitives.ts';
import {
  executeFillOnlySemanticWrite,
  type FillOnlySemanticObservation,
  type FillOnlySemanticResult,
} from './fillOnlySemantic.ts';
import type { HostValidationSignals } from './verify.ts';
import { MAX_COMBOBOX_HARVEST_OPTIONS } from '../click/optionSearch.ts';

export interface ComboboxFillOnlyOption {
  readonly optionId: string;
  readonly element: Element;
}

export interface PrepareComboboxFillOnlyInput {
  readonly trigger: HTMLInputElement;
  readonly optionContainer: Element;
  readonly options: readonly ComboboxFillOnlyOption[];
  readonly root: ScanRoot;
  /** Full UA-1 parity and exact option-reference check; read-only. */
  readonly exactMembershipCurrent: () => boolean;
}

export interface ComboboxFillOnlyExecuteInput {
  readonly optionId: string;
  readonly authorizeWrite: () => Promise<boolean>;
  readonly executionFence: () => ApplyErrorCode | null;
  readonly readHostValidation: (target: HTMLInputElement) => HostValidationSignals;
  readonly lateRecheckMs: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly settle?: (signal?: AbortSignal) => Promise<void> | void;
  readonly lateRecheckDelay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void> | void;
}

export interface ComboboxFillOnlyTransaction {
  readonly isEmpty: () => boolean;
  readonly isSelected: (optionId: string) => boolean;
  /** True only after the complete pointer sequence preserved the local seal. */
  readonly canRetireRegistry: () => boolean;
  /** Post-dispatch exact semantic-context check; never calls the retired registry. */
  readonly exactTargetPresent: () => boolean;
  readonly execute: (input: ComboboxFillOnlyExecuteInput) => Promise<FillOnlySemanticResult>;
}

const SAFE_OPTION_ID = /^[a-f0-9]{64}$/u;
const MAX_MEMBERSHIP_NODES = 20_000;
const TRACKED_USER_EVENTS = Object.freeze([
  'pointerdown', 'mousedown', 'click', 'keydown', 'beforeinput', 'input', 'change',
] as const);
const SEALED_TRIGGER_ATTRIBUTES = Object.freeze([
  'id', 'name', 'type', 'role', 'autocomplete', 'placeholder', 'required',
  'disabled', 'readonly', 'hidden', 'aria-label', 'aria-labelledby',
  'aria-required', 'aria-disabled', 'aria-readonly', 'aria-hidden',
  'aria-haspopup', 'aria-controls', 'aria-owns', 'form',
] as const);
const SEALED_CONTAINER_ATTRIBUTES = Object.freeze([
  'id', 'role', 'aria-label', 'aria-labelledby', 'aria-disabled', 'hidden',
] as const);
const SEALED_FORM_ATTRIBUTES = Object.freeze([
  'id', 'name', 'action', 'method', 'enctype', 'target', 'novalidate',
] as const);
const EVENT_TARGET_ADD = typeof EventTarget === 'undefined'
  ? null
  : EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE = typeof EventTarget === 'undefined'
  ? null
  : EventTarget.prototype.removeEventListener;

function rawAttribute(element: Element, name: string): string | null {
  try {
    const getter = Element.prototype.getAttribute;
    const value: unknown = Reflect.apply(getter, element, [name]);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

type AttributeSeal = readonly (readonly [string, string | null])[];

function sealAttributes(element: Element, names: readonly string[]): AttributeSeal {
  return Object.freeze(names.map((name) => Object.freeze([
    name,
    rawAttribute(element, name),
  ] as const)));
}

function attributesMatch(element: Element, seal: AttributeSeal): boolean {
  return seal.every(([name, value]) => rawAttribute(element, name) === value);
}

function firstRole(element: Element): string {
  return (rawAttribute(element, 'role') ?? '').trim().toLowerCase().split(/\s+/u)[0] ?? '';
}

function selectedState(element: Element): boolean | null {
  const value = (rawAttribute(element, 'aria-selected') ?? '').trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
}

function exactTrue(element: Element, name: string): boolean {
  return (rawAttribute(element, name) ?? '').trim().toLowerCase() === 'true';
}

function absentOrFalse(element: Element, name: string): boolean {
  const value = rawAttribute(element, name);
  return value === null || value.trim().toLowerCase() === 'false';
}

function exactPopupRelation(trigger: HTMLInputElement, container: Element): boolean {
  const relation = rawAttribute(trigger, 'aria-controls') ?? rawAttribute(trigger, 'aria-owns');
  const containerId = rawAttribute(container, 'id');
  if (
    relation === null || containerId === null || containerId.length === 0 ||
    /\s/u.test(containerId)
  ) return false;
  const tokens = relation.trim().split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => token === containerId);
}

/** Reject a detectable partial/virtualized option window. */
function exactAriaSetWindow(options: readonly ComboboxFillOnlyOption[]): boolean {
  let usesSetMetadata = false;
  const positions = new Set<number>();
  for (const option of options) {
    const rawSize = rawAttribute(option.element, 'aria-setsize');
    const rawPosition = rawAttribute(option.element, 'aria-posinset');
    if (rawSize === null && rawPosition === null) continue;
    usesSetMetadata = true;
    if (
      rawSize === null || rawPosition === null || !/^[1-9]\d*$/u.test(rawSize) ||
      !/^[1-9]\d*$/u.test(rawPosition)
    ) return false;
    const size = Number(rawSize);
    const position = Number(rawPosition);
    if (
      !Number.isSafeInteger(size) || !Number.isSafeInteger(position) ||
      size !== options.length || position > size || positions.has(position)
    ) return false;
    positions.add(position);
  }
  return !usesSetMetadata ||
    positions.size === options.length && options.every((_option, index) => positions.has(index + 1));
}

function triggerValueAccess(trigger: HTMLInputElement): (() => string | null) | null {
  try {
    const prototype = trigger.ownerDocument.defaultView?.HTMLInputElement.prototype;
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'value')
      : undefined;
    if (typeof descriptor?.get !== 'function') return null;
    return () => {
      try {
        const value: unknown = descriptor.get!.call(trigger);
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}

function connectedToDocument(element: Element, document: Document): boolean {
  try {
    const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')?.get;
    return connected !== undefined && connected.call(element) === true &&
      element.ownerDocument === document;
  } catch {
    return false;
  }
}

/** Same nested-widget exclusion used by the UA-1 associated-option walk. */
function currentOptionMembers(container: Element): readonly Element[] | null {
  const pending: Element[] = [];
  const members: Element[] = [];
  let visited = 0;
  try {
    for (let index = container.children.length - 1; index >= 0; index -= 1) {
      pending.push(container.children[index]!);
    }
    while (pending.length > 0) {
      const candidate = pending.pop()!;
      visited += 1;
      if (visited > MAX_MEMBERSHIP_NODES) return null;
      const role = firstRole(candidate);
      if (role === 'listbox' || role === 'combobox') continue;
      if (role === 'option') {
        members.push(candidate);
        if (members.length > MAX_COMBOBOX_HARVEST_OPTIONS) return null;
      }
      if (visited + pending.length + candidate.children.length > MAX_MEMBERSHIP_NODES) {
        return null;
      }
      for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
        pending.push(candidate.children[index]!);
      }
    }
    return members;
  } catch {
    return null;
  }
}

function withConsumerRetirement(
  observation: FillOnlySemanticObservation,
  release: () => boolean,
): FillOnlySemanticObservation {
  return Object.freeze({
    check: observation.check,
    finalize: (retireConsumer?: () => boolean) => observation.finalize(() => {
      const local = release();
      let outer = true;
      try { outer = retireConsumer?.() ?? true; } catch { outer = false; }
      return local && outer;
    }),
    dispose: () => {
      observation.dispose();
      release();
    },
  });
}

export function prepareComboboxFillOnly(
  input: PrepareComboboxFillOnlyInput,
): ComboboxFillOnlyTransaction | null {
  let trigger: HTMLInputElement;
  let optionContainer: Element;
  let options: readonly ComboboxFillOnlyOption[];
  let root: ScanRoot;
  let document: Document;
  let triggerRoot: Node;
  let containerRoot: Node;
  let triggerParent: Node;
  let containerParent: Node;
  let triggerForm: HTMLFormElement | null;
  let controlsRelation: string | null;
  let ownsRelation: string | null;
  let questionLabel: string;
  let triggerAttributes: AttributeSeal;
  let containerAttributes: AttributeSeal;
  let formAttributes: AttributeSeal | null;
  try {
    ({ trigger, optionContainer, options, root } = input);
    const Input = trigger.ownerDocument.defaultView?.HTMLInputElement;
    if (
      Input === undefined || !(trigger instanceof Input) || firstRole(trigger) !== 'combobox' ||
      firstRole(optionContainer) !== 'listbox' || !exactTrue(trigger, 'aria-expanded') ||
      !exactPopupRelation(trigger, optionContainer) ||
      !absentOrFalse(optionContainer, 'aria-busy') ||
      !absentOrFalse(optionContainer, 'aria-multiselectable') ||
      options.length < 1 || options.length > MAX_COMBOBOX_HARVEST_OPTIONS ||
      !exactAriaSetWindow(options)
    ) return null;
    const popupKind = (rawAttribute(trigger, 'aria-haspopup') ?? '').trim().toLowerCase();
    if (popupKind !== '' && popupKind !== 'listbox') return null;
    document = trigger.ownerDocument;
    triggerRoot = trigger.getRootNode();
    containerRoot = optionContainer.getRootNode();
    if (trigger.parentNode === null || optionContainer.parentNode === null) return null;
    triggerParent = trigger.parentNode;
    containerParent = optionContainer.parentNode;
    triggerForm = trigger.form;
    controlsRelation = rawAttribute(trigger, 'aria-controls');
    ownsRelation = rawAttribute(trigger, 'aria-owns');
    questionLabel = root.labelTextFor(trigger);
    triggerAttributes = sealAttributes(trigger, SEALED_TRIGGER_ATTRIBUTES);
    containerAttributes = sealAttributes(optionContainer, SEALED_CONTAINER_ATTRIBUTES);
    formAttributes = triggerForm === null
      ? null
      : sealAttributes(triggerForm, SEALED_FORM_ATTRIBUTES);
  } catch {
    return null;
  }
  const readTriggerValue = triggerValueAccess(trigger);
  if (readTriggerValue === null) return null;
  const optionIds = new Set<string>();
  const optionElements = new Set<Element>();
  const optionSemantics: Array<Readonly<{
    role: string | null;
    ariaLabel: string | null;
    text: string | null;
    ariaDisabled: string | null;
    ariaHidden: string | null;
    id: string | null;
    hidden: boolean;
    setSize: string | null;
    positionInSet: string | null;
  }>> = [];
  for (const option of options) {
    try {
      const html = option.element as Partial<HTMLElement> & Element;
      if (
        !SAFE_OPTION_ID.test(option.optionId) || optionIds.has(option.optionId) ||
        optionElements.has(option.element) || firstRole(option.element) !== 'option' ||
        option.element.ownerDocument !== document || selectedState(option.element) === null ||
        html.hidden === true || exactTrue(option.element, 'aria-hidden')
      ) return null;
      optionIds.add(option.optionId);
      optionElements.add(option.element);
      optionSemantics.push(Object.freeze({
        role: rawAttribute(option.element, 'role'),
        ariaLabel: rawAttribute(option.element, 'aria-label'),
        text: option.element.textContent,
        ariaDisabled: rawAttribute(option.element, 'aria-disabled'),
        ariaHidden: rawAttribute(option.element, 'aria-hidden'),
        id: rawAttribute(option.element, 'id'),
        hidden: false,
        setSize: rawAttribute(option.element, 'aria-setsize'),
        positionInSet: rawAttribute(option.element, 'aria-posinset'),
      }));
    } catch {
      return null;
    }
  }
  let consumed = false;
  let selectionCommitted = false;

  const exactTargetPresent = (): boolean => {
    try {
      if (
        !connectedToDocument(trigger, document) ||
        !connectedToDocument(optionContainer, document) ||
        trigger.getRootNode() !== triggerRoot || optionContainer.getRootNode() !== containerRoot ||
        trigger.parentNode !== triggerParent || optionContainer.parentNode !== containerParent ||
        trigger.form !== triggerForm ||
        root.labelTextFor(trigger) !== questionLabel ||
        !attributesMatch(trigger, triggerAttributes) ||
        !attributesMatch(optionContainer, containerAttributes) ||
        (triggerForm !== null && (
          formAttributes === null || !attributesMatch(triggerForm, formAttributes)
        )) ||
        firstRole(trigger) !== 'combobox' || firstRole(optionContainer) !== 'listbox' ||
        rawAttribute(trigger, 'aria-controls') !== controlsRelation ||
        rawAttribute(trigger, 'aria-owns') !== ownsRelation ||
        !exactPopupRelation(trigger, optionContainer) ||
        !absentOrFalse(optionContainer, 'aria-busy') ||
        !absentOrFalse(optionContainer, 'aria-multiselectable') ||
        trigger.disabled || trigger.readOnly ||
        rawAttribute(trigger, 'aria-disabled')?.trim().toLowerCase() === 'true'
      ) return false;
      const current = currentOptionMembers(optionContainer);
      return current !== null && current.length === options.length &&
        current.every((element, index) => element === options[index]?.element) &&
        exactAriaSetWindow(options) && options.every((option, index) => {
          const semantic = optionSemantics[index];
          const html = option.element as Partial<HTMLElement> & Element;
          return semantic !== undefined && connectedToDocument(option.element, document) &&
            option.element.getRootNode() === containerRoot &&
            firstRole(option.element) === 'option' && selectedState(option.element) !== null &&
            rawAttribute(option.element, 'role') === semantic.role &&
            rawAttribute(option.element, 'aria-label') === semantic.ariaLabel &&
            option.element.textContent === semantic.text &&
            rawAttribute(option.element, 'aria-disabled') === semantic.ariaDisabled &&
            rawAttribute(option.element, 'aria-hidden') === semantic.ariaHidden &&
            rawAttribute(option.element, 'id') === semantic.id &&
            (html.hidden === true) === semantic.hidden &&
            rawAttribute(option.element, 'aria-setsize') === semantic.setSize &&
            rawAttribute(option.element, 'aria-posinset') === semantic.positionInSet;
        });
    } catch {
      return false;
    }
  };
  const currentBeforeDispatch = (): boolean => {
    if (!exactTargetPresent()) return false;
    try { return input.exactMembershipCurrent() === true; } catch { return false; }
  };
  const selectedOption = (): string | null | 'INVALID' => {
    let selected: string | null = null;
    for (const option of options) {
      const state = selectedState(option.element);
      if (state === null) return 'INVALID';
      if (state) {
        if (selected !== null) return 'INVALID';
        selected = option.optionId;
      }
    }
    return selected;
  };
  const semanticCurrent = (): boolean => selectionCommitted
    ? exactTargetPresent()
    : currentBeforeDispatch();

  return Object.freeze({
    isEmpty: () => !consumed && currentBeforeDispatch() &&
      exactTrue(trigger, 'aria-expanded') && selectedOption() === null &&
      readTriggerValue() === '',
    isSelected: (optionId: string) => !consumed && optionIds.has(optionId) &&
      currentBeforeDispatch() && exactTrue(trigger, 'aria-expanded') &&
      selectedOption() === optionId,
    canRetireRegistry: () => selectionCommitted,
    exactTargetPresent,
    async execute(executeInput: ComboboxFillOnlyExecuteInput): Promise<FillOnlySemanticResult> {
      if (consumed || !optionIds.has(executeInput.optionId)) {
        return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
      }
      consumed = true;
      const desired = options.find((option) => option.optionId === executeInput.optionId)!;
      let userEdited = false;
      const onUserEvent = (event: Event) => {
        try {
          if (!event.isTrusted) return;
          const target = event.target;
          if (
            target === trigger || target === optionContainer ||
            options.some((option) => target === option.element ||
              target instanceof Node && option.element.contains(target))
          ) userEdited = true;
        } catch {
          userEdited = true;
        }
      };
      let listening = true;
      let releaseCleanly = true;
      const release = (): boolean => {
        if (!listening) return releaseCleanly;
        listening = false;
        for (const type of TRACKED_USER_EVENTS) {
          try {
            if (EVENT_TARGET_REMOVE === null) releaseCleanly = false;
            else Reflect.apply(EVENT_TARGET_REMOVE, document, [type, onUserEvent, true]);
          } catch { releaseCleanly = false; }
        }
        return releaseCleanly;
      };
      try {
        if (EVENT_TARGET_ADD === null) throw new Error('EVENT_LISTENER_UNAVAILABLE');
        for (const type of TRACKED_USER_EVENTS) {
          Reflect.apply(EVENT_TARGET_ADD, document, [type, onUserEvent, true]);
        }
      } catch {
        release();
        return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
      }

      const targetFence = (): ApplyErrorCode | null => {
        if (userEdited) return 'ABORTED';
        return semanticCurrent() ? null : 'IDENTITY_CHANGED';
      };
      const pointerSequenceFence = (): ApplyErrorCode | null => {
        try {
          if (executeInput.signal?.aborted) return 'ABORTED';
          const beforeTarget = executeInput.executionFence();
          if (beforeTarget !== null) return beforeTarget;
          if (executeInput.signal?.aborted) return 'ABORTED';
          const target = targetFence();
          // Exact membership is callback-capable. It may synchronously submit,
          // navigate, edit, or abort while still returning the prior valid
          // option set. Re-read revocation before the next pointer event.
          if (executeInput.signal?.aborted) return 'ABORTED';
          const afterTarget = executeInput.executionFence();
          if (afterTarget !== null) return afterTarget;
          if (executeInput.signal?.aborted) return 'ABORTED';
          return target;
        } catch {
          return 'ABORTED';
        }
      };
      const result = await executeFillOnlySemanticWrite({
        authorizeWrite: executeInput.authorizeWrite,
        executionFence: executeInput.executionFence,
        targetFence,
        isAtPreWriteState: () =>
          exactTrue(trigger, 'aria-expanded') && selectedOption() === null &&
          readTriggerValue() === '',
        isAtWrittenState: () => selectedOption() === executeInput.optionId,
        writeForward: (authority) => {
          const result = clickReviewedFillOnlyOption({
            element: desired.element,
            root,
            authority,
            pointerSequenceFence,
          });
          if (!result.ok || !exactTargetPresent()) return false;
          selectionCommitted = true;
          return true;
        },
        readHostValidation: () => executeInput.readHostValidation(trigger),
        lateRecheckMs: executeInput.lateRecheckMs,
        operationTimeoutMs: executeInput.operationTimeoutMs,
        signal: executeInput.signal,
        settle: executeInput.settle,
        lateRecheckDelay: executeInput.lateRecheckDelay,
      });
      if (!result.ok) {
        release();
        return result;
      }
      return Object.freeze({
        ok: true,
        observation: withConsumerRetirement(result.observation, release),
      });
    },
  });
}
