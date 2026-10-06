/** Fill-first writer for exact empty native `<input type=date|month>` controls. */

import type { ApplyErrorCode } from '../contracts.ts';
import {
  consumeFillOnlyHostWriteAuthority,
  executeFillOnlySemanticWrite,
  type FillOnlySemanticResult,
} from './fillOnlySemantic.ts';
import type { HostValidationSignals } from './verify.ts';

export type NativeDateFillOnlyKind = 'date' | 'month';

export interface NativeDateFillOnlyInput {
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

export interface NativeDateFillOnlyTransaction {
  readonly kind: NativeDateFillOnlyKind;
  readonly isEmpty: () => boolean;
  readonly isAtAnswer: () => boolean;
  readonly fillOnly: (input: NativeDateFillOnlyInput) => Promise<FillOnlySemanticResult>;
}

interface NativeValueAccess {
  readonly get: () => string | null;
  readonly set: (value: string) => boolean;
}

interface NativeEventAccess {
  readonly add: (target: EventTarget, type: string, listener: EventListener) => void;
  readonly remove: (target: EventTarget, type: string, listener: EventListener) => void;
  readonly dispatch: (target: EventTarget, event: Event) => boolean;
  readonly create: (type: 'input' | 'change') => Event;
}

const OBSERVED_TARGET_EVENTS = Object.freeze([
  'pointerdown', 'mousedown', 'click', 'keydown', 'beforeinput', 'input', 'change',
] as const);

function nativeValueAccess(target: HTMLInputElement): NativeValueAccess | null {
  try {
    const prototype = target.ownerDocument.defaultView?.HTMLInputElement.prototype;
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'value')
      : undefined;
    if (descriptor?.get === undefined || descriptor.set === undefined) return null;
    return Object.freeze({
      get: () => {
        try {
          const value: unknown = descriptor.get!.call(target);
          return typeof value === 'string' ? value : null;
        } catch { return null; }
      },
      set: (value: string) => {
        try {
          descriptor.set!.call(target, value);
          return descriptor.get!.call(target) === value;
        } catch { return false; }
      },
    });
  } catch {
    return null;
  }
}

function nativeEventAccess(target: HTMLInputElement): NativeEventAccess | null {
  try {
    const view = target.ownerDocument.defaultView;
    const prototype = view?.EventTarget.prototype;
    const EventConstructor = view?.Event;
    const add = prototype?.addEventListener;
    const remove = prototype?.removeEventListener;
    const dispatch = prototype?.dispatchEvent;
    if (
      typeof add !== 'function' || typeof remove !== 'function' ||
      typeof dispatch !== 'function' || EventConstructor === undefined
    ) return null;
    return Object.freeze({
      add: (eventTarget: EventTarget, type: string, listener: EventListener) => {
        Reflect.apply(add, eventTarget, [type, listener, true]);
      },
      remove: (eventTarget: EventTarget, type: string, listener: EventListener) => {
        Reflect.apply(remove, eventTarget, [type, listener, true]);
      },
      dispatch: (eventTarget: EventTarget, event: Event) =>
        Reflect.apply(dispatch, eventTarget, [event]) as boolean,
      create: (type: 'input' | 'change') =>
        new EventConstructor(type, { bubbles: true, composed: true }),
    });
  } catch {
    return null;
  }
}

function validExpected(kind: NativeDateFillOnlyKind, expected: string): boolean {
  if (kind === 'month') {
    const match = /^(\d{4})-(\d{2})$/u.exec(expected);
    if (match === null) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year > 0 && month >= 1 && month <= 12;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(expected);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

function nodeConnected(node: Node, document: Document): boolean {
  try {
    const prototype = document.defaultView?.Node.prototype;
    const getter = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'isConnected')?.get
      : undefined;
    return getter !== undefined && getter.call(node) === true;
  } catch {
    return false;
  }
}

export function prepareNativeDateFillOnly(input: Readonly<{
  target: HTMLInputElement;
  expected: string;
  exactTargetCurrent: () => boolean;
}>): NativeDateFillOnlyTransaction | null {
  let target: HTMLInputElement;
  let expected: string;
  let kind: NativeDateFillOnlyKind;
  let access: NativeValueAccess;
  let eventAccess: NativeEventAccess;
  let document: Document;
  let root: Node;
  let parent: Node | null;
  let form: HTMLFormElement | null;
  let identityAttributes: readonly (readonly [string, string | null])[];
  try {
    ({ target, expected } = input);
    if (typeof expected !== 'string' || typeof input.exactTargetCurrent !== 'function') return null;
    document = target.ownerDocument;
    const Input = document.defaultView?.HTMLInputElement;
    if (Input === undefined || !(target instanceof Input)) return null;
    const inputKind = target.type;
    if ((inputKind !== 'date' && inputKind !== 'month') || !validExpected(inputKind, expected)) {
      return null;
    }
    kind = inputKind;
    const valueAccess = nativeValueAccess(target);
    const events = nativeEventAccess(target);
    if (valueAccess === null || events === null || !nodeConnected(target, document)) return null;
    access = valueAccess;
    eventAccess = events;
    const ariaDisabled = (target.getAttribute('aria-disabled') ?? '').trim().toLowerCase();
    const ariaReadOnly = (target.getAttribute('aria-readonly') ?? '').trim().toLowerCase();
    const ariaHidden = (target.getAttribute('aria-hidden') ?? '').trim().toLowerCase();
    if (
      target.disabled || target.readOnly || target.hidden ||
      ariaDisabled === 'true' || ariaReadOnly === 'true' || ariaHidden === 'true'
    ) return null;
    root = target.getRootNode();
    parent = target.parentNode;
    form = target.form;
    identityAttributes = Object.freeze([
      'type', 'name', 'min', 'max', 'step', 'required', 'disabled', 'readonly', 'hidden',
      'aria-disabled', 'aria-readonly', 'aria-hidden',
    ].map((name) => Object.freeze([name, target.getAttribute(name)] as const)));
  } catch {
    return null;
  }
  let consumed = false;

  const identityCurrent = (): boolean => {
    try {
      return nodeConnected(target, document) && target.ownerDocument === document &&
        target.getRootNode() === root && target.parentNode === parent && target.form === form &&
        target.type === kind && !target.disabled && !target.readOnly && !target.hidden &&
        (target.getAttribute('aria-disabled') ?? '').trim().toLowerCase() !== 'true' &&
        (target.getAttribute('aria-readonly') ?? '').trim().toLowerCase() !== 'true' &&
        (target.getAttribute('aria-hidden') ?? '').trim().toLowerCase() !== 'true' &&
        identityAttributes.every(([name, value]) => target.getAttribute(name) === value) &&
        input.exactTargetCurrent() === true;
    } catch {
      return false;
    }
  };
  const atAnswer = () => identityCurrent() && access.get() === expected;

  return Object.freeze({
    kind,
    isEmpty: () => !consumed && identityCurrent() && access.get() === '',
    isAtAnswer: () => !consumed && atAnswer(),
    async fillOnly(fillInput: NativeDateFillOnlyInput): Promise<FillOnlySemanticResult> {
      if (consumed) return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
      consumed = true;
      let external = false;
      let expectedEvent: Event | null = null;
      let observedExpectedEvent = false;
      const onEvent = (event: Event) => {
        if (event === expectedEvent) observedExpectedEvent = true;
        else external = true;
      };
      let listening = true;
      let releasedCleanly = true;
      const release = (): boolean => {
        if (!listening) return releasedCleanly;
        listening = false;
        for (const type of OBSERVED_TARGET_EVENTS) {
          try {
            eventAccess.remove(target, type, onEvent);
          } catch { releasedCleanly = false; }
        }
        if (form !== null) {
          try { eventAccess.remove(form, 'reset', onEvent); }
          catch { releasedCleanly = false; }
        }
        return releasedCleanly;
      };
      try {
        for (const type of OBSERVED_TARGET_EVENTS) {
          eventAccess.add(target, type, onEvent);
        }
        if (form !== null) eventAccess.add(form, 'reset', onEvent);
      } catch {
        release();
        return Object.freeze({ ok: false, code: 'CAPABILITY_DISABLED' });
      }
      const dispatchExpected = (type: 'input' | 'change'): boolean => {
        let event: Event;
        try { event = eventAccess.create(type); }
        catch { return false; }
        expectedEvent = event;
        observedExpectedEvent = false;
        try { eventAccess.dispatch(target, event); }
        catch { return false; }
        finally { expectedEvent = null; }
        return observedExpectedEvent && !external;
      };
      const targetFence = (): ApplyErrorCode | null => {
        if (external) return 'ABORTED';
        return identityCurrent() ? null : 'IDENTITY_CHANGED';
      };
      const hostEnvelopeCurrent = (): boolean => {
        try {
          if (fillInput.signal?.aborted || fillInput.executionFence() !== null) return false;
          if (targetFence() !== null || fillInput.signal?.aborted) return false;
          return fillInput.executionFence() === null && !fillInput.signal?.aborted;
        } catch {
          return false;
        }
      };
      const result = await executeFillOnlySemanticWrite({
        authorizeWrite: fillInput.authorizeWrite,
        executionFence: fillInput.executionFence,
        targetFence,
        isAtPreWriteState: () => access.get() === '',
        isAtWrittenState: () => access.get() === expected,
        writeForward: (authority) => {
          if (!consumeFillOnlyHostWriteAuthority(authority)) return false;
          if (!access.set(expected) || !dispatchExpected('input')) return false;
          if (access.get() !== expected || !hostEnvelopeCurrent()) return false;
          if (!dispatchExpected('change')) return false;
          return access.get() === expected && hostEnvelopeCurrent();
        },
        readHostValidation: () => fillInput.readHostValidation(target),
        lateRecheckMs: fillInput.lateRecheckMs,
        operationTimeoutMs: fillInput.operationTimeoutMs,
        signal: fillInput.signal,
        settle: fillInput.settle,
        lateRecheckDelay: fillInput.lateRecheckDelay,
      });
      if (!result.ok) {
        release();
        return result;
      }
      return Object.freeze({
        ok: true,
        observation: Object.freeze({
          check: result.observation.check,
          finalize: (retireConsumer?: () => boolean) => result.observation.finalize(() => {
            let clean = release();
            try {
              if (retireConsumer !== undefined && retireConsumer() !== true) clean = false;
            } catch { clean = false; }
            return clean && !external;
          }),
          dispose: () => {
            result.observation.dispose();
            release();
          },
        }),
      });
    },
  });
}
