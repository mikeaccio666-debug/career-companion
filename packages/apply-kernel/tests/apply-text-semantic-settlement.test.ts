import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTextSemanticTargetAuthority,
  createTextSemanticWriteAuthority,
  invalidateTextSemanticWriteAuthority,
  settleTextSemanticWrite,
  type TextSemanticSettlementInput,
  type TextSemanticTargetAuthority,
  type TextSemanticTransaction,
  type TextSemanticUndoTransfer,
  type TextSemanticUndoOwnership,
  type TextSemanticWriteAuthority,
  type TextTargetState,
} from '../src/write/textSemanticSettlement';

const PREVIOUS = 'Before';
const EXPECTED = 'After';
let nextSlot = 0;

interface TextHarness {
  readonly control: HTMLInputElement | HTMLTextAreaElement;
  readonly targetAuthority: TextSemanticTargetAuthority;
  readonly writeAuthority: TextSemanticWriteAuthority;
  readonly transaction: TextSemanticTransaction;
  readonly setHostValue: (value: string) => void;
  readonly setUserEdited: (edited: boolean) => void;
  readonly setOwnershipProof: (mode: 'true' | 'false' | 'throw') => void;
  readonly ownershipCallbackCalls: () => number;
  readonly commitCalls: () => number;
  readonly transferGetterCalls: () => number;
  readonly restoreCalls: () => number;
  readonly cancelCalls: () => number;
  readonly undoDisposeCalls: () => number;
  readonly alternateCancelCalls: () => number;
  readonly alternateUndoDisposeCalls: () => number;
  readonly publishMalformedTransfer: () => void;
  readonly publishGetterBackedTransfer: () => void;
  readonly commitRetainedTransfer: () => boolean;
  readonly retainedUndoIsAtWrittenState: () => boolean;
  readonly transactionOwnsWrittenState: () => boolean;
  readonly undoOwnsWrittenState: () => boolean;
  readonly transactionDisposed: () => boolean;
  readonly undoDisposed: () => boolean;
}

function mountTextHarness(
  kind: 'input' | 'textarea' = 'input',
  options: Readonly<{
    captureWrittenState?: boolean;
    captureThrows?: boolean;
    captureThrowsAfterPrepare?: boolean;
    invalidCaptureTransfer?: boolean;
    invalidCapturedOwnership?: boolean;
    transferCommitThrows?: boolean;
    transferCommitReturnsFalse?: boolean;
    cancelThrows?: boolean;
    duplicateCapturePublication?: boolean;
    transferAccessorGetters?: boolean;
    transferCommitGetterThrows?: boolean;
    undoMemberGetterThrows?: boolean;
    publishAfterCaptureReturns?: boolean;
    republishCommittedTransferLater?: boolean;
    publishAlternateTransferLater?: boolean;
    publishAliasTransferLater?: boolean;
    publishMalformedTransferLater?: boolean;
    republishTransferFromGetter?: boolean;
    lateTransferGetterMutation?: 'DETACH' | 'REPLACE';
    lateTransferCancelMutation?: 'DETACH' | 'REPLACE';
    lieAboutTargetState?: boolean;
    restoreSucceeds?: boolean;
    unsafeUndoRestore?: boolean;
    inputType?: string;
    autocomplete?: string;
    role?: string;
    plannedExpected?: string;
    onTransferCommit?: () => void;
    onCapturePrepared?: () => void;
    onUndoProof?: () => void;
    onUserEditGeneration?: () => void;
    mountParent?: Node & ParentNode;
  }> = {},
): TextHarness {
  const slot = `semantic-text-${nextSlot++}`;
  const control = document.createElement(kind);
  control.dataset.semanticTextSlot = slot;
  if (control instanceof HTMLInputElement && options.inputType !== undefined) {
    control.type = options.inputType;
  }
  if (options.autocomplete !== undefined) control.setAttribute('autocomplete', options.autocomplete);
  if (options.role !== undefined) control.setAttribute('role', options.role);
  control.value = PREVIOUS;
  (options.mountParent ?? document.body).append(control);

  const targetAuthority = createTextSemanticTargetAuthority(control);
  if (targetAuthority === null) throw new Error('expected a valid text target authority');

  let userEdited = false;
  let userEditGeneration = 0;
  let ownershipProof: 'true' | 'false' | 'throw' = 'true';
  let ownershipCallbackCalls = 0;
  let commitCalls = 0;
  let transferGetterCalls = 0;
  let restoreCalls = 0;
  let cancelCalls = 0;
  let undoDisposeCalls = 0;
  let alternateCancelCalls = 0;
  let alternateUndoDisposeCalls = 0;
  let transactionOwnsWrittenState = true;
  let preparedCandidate = false;
  let undoOwnsWrittenState = false;
  let transactionDisposed = false;
  let undoDisposed = false;
  let retainedPublisher: ((candidate: TextSemanticUndoTransfer) => void) | null = null;
  let retainedGetterBackedPublisher: (() => void) | null = null;
  let retainedCommit: (() => boolean) | null = null;
  let retainedUndoProof: (() => boolean) | null = null;

  const mountParent = options.mountParent ?? document.body;
  const targetState = (): TextTargetState => {
    ownershipCallbackCalls += 1;
    if (options.lieAboutTargetState === true) return 'CURRENT';
    const current = mountParent.querySelector(`[data-semantic-text-slot="${slot}"]`);
    if (control.isConnected && current === control) return 'CURRENT';
    if (!control.isConnected && current === null) return 'DETACHED';
    return 'REPLACED';
  };
  const mutateForLateTransfer = (mutation: 'DETACH' | 'REPLACE' | undefined) => {
    if (mutation === 'DETACH') {
      control.remove();
      return;
    }
    if (mutation === 'REPLACE') {
      const replacement = document.createElement(kind);
      replacement.dataset.semanticTextSlot = slot;
      replacement.value = 'Late publisher replacement';
      control.replaceWith(replacement);
    }
  };

  const transaction: TextSemanticTransaction = {
    targetAuthority,
    writeUserEditGeneration: 0,
    userEditGeneration: () => {
      ownershipCallbackCalls += 1;
      options.onUserEditGeneration?.();
      return userEditGeneration;
    },
    targetState,
    wasUserEdited: () => {
      ownershipCallbackCalls += 1;
      return userEdited;
    },
    isAtPreWriteState: () => {
      ownershipCallbackCalls += 1;
      return targetState() === 'CURRENT' && control.value === PREVIOUS;
    },
    isAtWrittenState: (writtenValue) => {
      ownershipCallbackCalls += 1;
      return (
        !transactionDisposed &&
        transactionOwnsWrittenState &&
        !userEdited &&
        targetState() === 'CURRENT' &&
        control.value === writtenValue
      );
    },
    captureWrittenState: (writtenValue, publishPrepared) => {
      ownershipCallbackCalls += 1;
      retainedPublisher = publishPrepared;
      if (options.captureThrows === true) throw new Error('synthetic capture failure');
      if (options.captureWrittenState === false) return;
      if (targetState() !== 'CURRENT' || control.value !== writtenValue) return;
      preparedCandidate = true;

      const undo: TextSemanticUndoOwnership = {
        targetAuthority,
        writeUserEditGeneration: 0,
        userEditGeneration: () => {
          ownershipCallbackCalls += 1;
          options.onUserEditGeneration?.();
          return userEditGeneration;
        },
        targetState,
        wasUserEdited: () => {
          ownershipCallbackCalls += 1;
          return userEdited;
        },
        isAtWrittenState: () => {
          ownershipCallbackCalls += 1;
          options.onUndoProof?.();
          if (ownershipProof === 'throw') throw new Error('synthetic ownership proof failure');
          return (
            ownershipProof === 'true' &&
            !undoDisposed &&
            (preparedCandidate || undoOwnsWrittenState) &&
            options.invalidCapturedOwnership !== true &&
            !userEdited &&
            targetState() === 'CURRENT' &&
            control.value === writtenValue
          );
        },
        restorePreWrite: () => {
          ownershipCallbackCalls += 1;
          restoreCalls += 1;
          if (options.unsafeUndoRestore === true) {
            control.value = PREVIOUS;
            return true;
          }
          if (
            undoDisposed ||
            !undoOwnsWrittenState ||
            userEdited ||
            targetState() !== 'CURRENT' ||
            control.value !== writtenValue ||
            options.restoreSucceeds === false
          ) {
            return false;
          }
          control.value = PREVIOUS;
          undoOwnsWrittenState = false;
          return true;
        },
        isAtPreWriteState: () => {
          ownershipCallbackCalls += 1;
          return !undoDisposed && targetState() === 'CURRENT' && control.value === PREVIOUS;
        },
        dispose: () => {
          ownershipCallbackCalls += 1;
          undoDisposeCalls += 1;
          undoDisposed = true;
          preparedCandidate = false;
          undoOwnsWrittenState = false;
        },
      };

      if (options.invalidCaptureTransfer === true) {
        publishPrepared({ undo } as TextSemanticUndoTransfer);
        if (options.captureThrowsAfterPrepare === true) {
          throw new Error('synthetic post-prepare capture failure');
        }
        return;
      }

      const publishedUndo = options.undoMemberGetterThrows === true
        ? Object.defineProperties({}, {
            dispose: { enumerable: true, value: undo.dispose },
            targetAuthority: { enumerable: true, value: undo.targetAuthority },
            writeUserEditGeneration: {
              enumerable: true,
              value: undo.writeUserEditGeneration,
            },
            userEditGeneration: {
              enumerable: true,
              get: () => {
                throw new Error('synthetic Undo member getter failure');
              },
            },
          }) as TextSemanticUndoOwnership
        : undo;
      const transfer: TextSemanticUndoTransfer = {
        undo: publishedUndo,
        commit: () => {
          ownershipCallbackCalls += 1;
          commitCalls += 1;
          if (
            transactionDisposed ||
            !transactionOwnsWrittenState ||
            !preparedCandidate
          ) return false;
          options.onTransferCommit?.();
          if (options.transferCommitThrows === true) {
            throw new Error('synthetic transfer commit failure');
          }
          if (options.transferCommitReturnsFalse === true) return false;
          transactionOwnsWrittenState = false;
          preparedCandidate = false;
          undoOwnsWrittenState = true;
          return true;
        },
        cancel: () => {
          ownershipCallbackCalls += 1;
          cancelCalls += 1;
          preparedCandidate = false;
          if (options.cancelThrows === true) throw new Error('synthetic cancel failure');
        },
      };
      retainedCommit = transfer.commit;
      retainedUndoProof = undo.isAtWrittenState;
      let publishedTransfer: TextSemanticUndoTransfer;
      publishedTransfer =
        options.transferAccessorGetters === true || options.transferCommitGetterThrows === true
        ? Object.defineProperties({}, {
            undo: {
              enumerable: true,
              get: () => {
                transferGetterCalls += 1;
                return transfer.undo;
              },
            },
            commit: {
              enumerable: true,
              get: () => {
                transferGetterCalls += 1;
                if (options.transferCommitGetterThrows === true) {
                  throw new Error('synthetic transfer commit getter failure');
                }
                return transfer.commit;
              },
            },
            cancel: {
              enumerable: true,
              get: () => {
                transferGetterCalls += 1;
                if (options.republishTransferFromGetter === true) {
                  publishPrepared(publishedTransfer);
                }
                return transfer.cancel;
              },
            },
          }) as TextSemanticUndoTransfer
        : transfer;
      retainedGetterBackedPublisher = () => {
        const alternateUndo: TextSemanticUndoOwnership = {
          ...undo,
          dispose: () => {
            alternateUndoDisposeCalls += 1;
          },
        };
        const alternateTransfer = Object.defineProperties({}, {
          undo: {
            enumerable: true,
            get: () => {
              transferGetterCalls += 1;
              return alternateUndo;
            },
          },
          commit: {
            enumerable: true,
            get: () => {
              transferGetterCalls += 1;
              return () => false;
            },
          },
          cancel: {
            enumerable: true,
            get: () => {
              transferGetterCalls += 1;
              mutateForLateTransfer(options.lateTransferGetterMutation);
              return () => {
                alternateCancelCalls += 1;
                mutateForLateTransfer(options.lateTransferCancelMutation);
              };
            },
          },
        }) as TextSemanticUndoTransfer;
        publishPrepared(alternateTransfer);
      };
      const publish = () => {
        publishPrepared(publishedTransfer);
        if (options.duplicateCapturePublication === true) publishPrepared(publishedTransfer);
      };
      if (options.publishAfterCaptureReturns === true) queueMicrotask(publish);
      else {
        publish();
        if (options.republishCommittedTransferLater === true) {
          queueMicrotask(() => publishPrepared(publishedTransfer));
        }
        if (options.publishAlternateTransferLater === true) {
          const alternateUndo: TextSemanticUndoOwnership = {
            ...undo,
            dispose: () => {
              alternateUndoDisposeCalls += 1;
            },
          };
          const alternateTransfer: TextSemanticUndoTransfer = {
            undo: alternateUndo,
            commit: () => false,
            cancel: () => {
              alternateCancelCalls += 1;
            },
          };
          queueMicrotask(() => publishPrepared(alternateTransfer));
        }
        if (options.publishAliasTransferLater === true) {
          const aliasTransfer: TextSemanticUndoTransfer = {
            undo: publishedUndo,
            commit: () => false,
            cancel: () => {
              alternateCancelCalls += 1;
            },
          };
          queueMicrotask(() => publishPrepared(aliasTransfer));
        }
        if (options.publishMalformedTransferLater === true) {
          queueMicrotask(() => publishPrepared({} as TextSemanticUndoTransfer));
        }
      }
      options.onCapturePrepared?.();
      if (options.captureThrowsAfterPrepare === true) {
        throw new Error('synthetic post-prepare capture failure');
      }
    },
    restorePreWriteFromWrittenState: (writtenValue) => {
      ownershipCallbackCalls += 1;
      restoreCalls += 1;
      if (
        userEdited ||
        !transactionOwnsWrittenState ||
        targetState() !== 'CURRENT' ||
        control.value !== writtenValue ||
        options.restoreSucceeds === false
      ) {
        return false;
      }
      control.value = PREVIOUS;
      transactionOwnsWrittenState = false;
      return true;
    },
    dispose: () => {
      ownershipCallbackCalls += 1;
      transactionDisposed = true;
      transactionOwnsWrittenState = false;
      preparedCandidate = false;
    },
  };

  const writeAuthority = createTextSemanticWriteAuthority(targetAuthority, transaction, {
    previous: PREVIOUS,
    expected: options.plannedExpected ?? EXPECTED,
  });
  if (writeAuthority === null) throw new Error('expected a valid text write authority');
  ownershipCallbackCalls = 0;

  return {
    control,
    targetAuthority,
    writeAuthority,
    transaction,
    setHostValue: (value) => {
      control.value = value;
      invalidateTextSemanticWriteAuthority(writeAuthority, { kind: 'VALUE_TRANSITION' });
    },
    setUserEdited: (edited) => {
      if (edited && !userEdited) {
        userEditGeneration += 1;
        invalidateTextSemanticWriteAuthority(writeAuthority, { kind: 'USER_EDIT' });
      }
      userEdited = edited;
    },
    setOwnershipProof: (mode) => {
      ownershipProof = mode;
      if (mode !== 'true' && undoOwnsWrittenState) {
        invalidateTextSemanticWriteAuthority(writeAuthority, { kind: 'OWNERSHIP_REVOKED' });
      }
    },
    ownershipCallbackCalls: () => ownershipCallbackCalls,
    commitCalls: () => commitCalls,
    transferGetterCalls: () => transferGetterCalls,
    restoreCalls: () => restoreCalls,
    cancelCalls: () => cancelCalls,
    undoDisposeCalls: () => undoDisposeCalls,
    alternateCancelCalls: () => alternateCancelCalls,
    alternateUndoDisposeCalls: () => alternateUndoDisposeCalls,
    publishMalformedTransfer: () => {
      retainedPublisher?.({} as TextSemanticUndoTransfer);
    },
    publishGetterBackedTransfer: () => {
      retainedGetterBackedPublisher?.();
    },
    commitRetainedTransfer: () => retainedCommit?.() ?? false,
    retainedUndoIsAtWrittenState: () => retainedUndoProof?.() ?? false,
    transactionOwnsWrittenState: () => transactionOwnsWrittenState,
    undoOwnsWrittenState: () => undoOwnsWrittenState,
    transactionDisposed: () => transactionDisposed,
    undoDisposed: () => undoDisposed,
  };
}

function settlementInput(
  harness: TextHarness,
  overrides: Partial<TextSemanticSettlementInput> = {},
): TextSemanticSettlementInput {
  return {
    writeAuthority: harness.writeAuthority,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    executionFence: () => null,
    lateRecheckMs: 1,
    settle: async () => undefined,
    lateRecheckDelay: async () => undefined,
    operationTimeoutMs: 50,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('text/textarea final semantic settlement · dormant CAP-AF-055 leaf', () => {
  it.each(['text', 'email', 'search', 'tel', 'url'] as const)(
    'mints a pre-write branded authority for the allowed input[%s] family',
    (inputType) => {
      const control = document.createElement('input');
      control.type = inputType;
      control.value = PREVIOUS;
      document.body.append(control);

      expect(createTextSemanticTargetAuthority(control)).not.toBeNull();
    },
  );

  it.each(['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button'] as const)(
    'refuses input[%s] before an authorized write can obtain text-target authority',
    (inputType) => {
      const control = document.createElement('input');
      control.type = inputType;
      document.body.append(control);

      expect(createTextSemanticTargetAuthority(control)).toBeNull();
    },
  );

  it.each([
    ['autocomplete=current-password', { autocomplete: 'current-password' }],
    ['autocomplete=new-password', { autocomplete: 'new-password' }],
    ['autocomplete=one-time-code', { autocomplete: 'one-time-code' }],
    ['role=combobox', { role: 'combobox' }],
    ['role=button', { role: 'button' }],
  ] as const)('refuses a credential/non-text semantic target with %s', (_label, attributes) => {
    const control = document.createElement('input');
    control.type = 'text';
    if ('autocomplete' in attributes) control.setAttribute('autocomplete', attributes.autocomplete);
    if ('role' in attributes) control.setAttribute('role', attributes.role);
    document.body.append(control);

    expect(createTextSemanticTargetAuthority(control)).toBeNull();
  });

  it.each([
    ['button', () => document.createElement('button')],
    ['select', () => document.createElement('select')],
    ['hidden text input', () => {
      const control = document.createElement('input');
      control.hidden = true;
      return control;
    }],
    ['popup textbox', () => {
      const control = document.createElement('input');
      control.setAttribute('aria-haspopup', 'listbox');
      return control;
    }],
  ] as const)('refuses a non-text DOM authority target: %s', (_label, createControl) => {
    const control = createControl();
    document.body.append(control);

    expect(createTextSemanticTargetAuthority(control)).toBeNull();
  });

  it('rejects an unbranded write authority before any ownership or host callback', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const executionFence = vi.fn(() => null);
    const settle = vi.fn(async () => undefined);
    const lateRecheckDelay = vi.fn(async () => undefined);
    const readHostValidation = vi.fn(() => ({ ariaInvalid: 'false' }));

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        writeAuthority: {} as TextSemanticWriteAuthority,
        executionFence,
        settle,
        lateRecheckDelay,
        readHostValidation,
      }),
    );

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.ownershipCallbackCalls()).toBe(0);
    expect(executionFence).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(lateRecheckDelay).not.toHaveBeenCalled();
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('does not enumerate an unrelated throwing settlement-input accessor after claim', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const input = settlementInput(harness) as TextSemanticSettlementInput & {
      readonly unrelated?: never;
    };
    Object.defineProperty(input, 'unrelated', {
      enumerable: true,
      get: () => {
        throw new Error('synthetic unrelated accessor failure');
      },
    });

    const result = await settleTextSemanticWrite(input);

    expect(result.ok).toBe(true);
  });

  it('resolves a known settlement-input accessor failure and compensates the claimed write', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const input = settlementInput(harness);
    Object.defineProperty(input, 'readHostValidation', {
      enumerable: true,
      get: () => {
        throw new Error('synthetic known accessor failure');
      },
    });

    const result = await settleTextSemanticWrite(input);

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('normalizes a malformed execution-stop invalidation to a stable failure code', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    invalidateTextSemanticWriteAuthority(harness.writeAuthority, {
      kind: 'EXECUTION_STOP',
      code: 'NOT_AN_APPLY_ERROR_CODE',
    } as unknown as Parameters<typeof invalidateTextSemanticWriteAuthority>[1]);

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('reads a genuine AbortSignal through its intrinsic getter, not a throwing own accessor', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const controller = new AbortController();
    const shadowedGetter = vi.fn(() => {
      throw new Error('synthetic shadowed aborted getter');
    });
    Object.defineProperty(controller.signal, 'aborted', {
      configurable: true,
      get: shadowedGetter,
    });

    const result = await settleTextSemanticWrite(
      settlementInput(harness, { signal: controller.signal }),
    );

    expect(result.ok).toBe(true);
    expect(shadowedGetter).not.toHaveBeenCalled();
    if (result.ok) result.value.undo.dispose();
  });

  it('uses EventTarget intrinsics when a genuine AbortSignal shadows listener methods', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const controller = new AbortController();
    const shadowedAdd = vi.fn(() => {
      throw new Error('synthetic shadowed addEventListener');
    });
    const shadowedRemove = vi.fn(() => {
      throw new Error('synthetic shadowed removeEventListener');
    });
    Object.defineProperties(controller.signal, {
      addEventListener: { configurable: true, value: shadowedAdd },
      removeEventListener: { configurable: true, value: shadowedRemove },
    });

    const result = await settleTextSemanticWrite(
      settlementInput(harness, { signal: controller.signal }),
    );

    expect(result.ok).toBe(true);
    expect(shadowedAdd).not.toHaveBeenCalled();
    expect(shadowedRemove).not.toHaveBeenCalled();
    if (result.ok) result.value.undo.dispose();
  });

  it('uses native AbortSignal intrinsics when an intermediate prototype masks an aborted signal', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const controller = new AbortController();
    controller.abort();
    const originalPrototype = Object.getPrototypeOf(controller.signal) as object;
    const shadowedAborted = vi.fn(() => false);
    const shadowedAdd = vi.fn();
    const shadowedRemove = vi.fn();
    const shadowPrototype = Object.create(originalPrototype, {
      aborted: { configurable: true, get: shadowedAborted },
      addEventListener: { configurable: true, value: shadowedAdd },
      removeEventListener: { configurable: true, value: shadowedRemove },
    });
    Object.setPrototypeOf(controller.signal, shadowPrototype);

    const result = await settleTextSemanticWrite(
      settlementInput(harness, { signal: controller.signal }),
    );

    expect(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(shadowedAborted).not.toHaveBeenCalled();
    expect(shadowedAdd).not.toHaveBeenCalled();
    expect(shadowedRemove).not.toHaveBeenCalled();
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('rejects a structurally spoofed AbortSignal without invoking its prototype methods', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const spoofedAborted = vi.fn(() => false);
    const spoofedAdd = vi.fn();
    const spoofedRemove = vi.fn();
    const spoofedSignal = Object.create(null, {
      aborted: { get: spoofedAborted },
      addEventListener: { value: spoofedAdd },
      removeEventListener: { value: spoofedRemove },
    }) as AbortSignal;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, { signal: spoofedSignal }),
    );

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(spoofedAborted).not.toHaveBeenCalled();
    expect(spoofedAdd).not.toHaveBeenCalled();
    expect(spoofedRemove).not.toHaveBeenCalled();
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('rejects a cross-target transaction before a forward write can be authorized', () => {
    const control = document.createElement('input');
    control.value = PREVIOUS;
    document.body.append(control);
    const targetAuthority = createTextSemanticTargetAuthority(control);
    if (targetAuthority === null) throw new Error('expected target authority');
    const foreign = mountTextHarness();

    expect(createTextSemanticWriteAuthority(targetAuthority, foreign.transaction, {
      previous: PREVIOUS,
      expected: EXPECTED,
    })).toBeNull();
    expect(foreign.ownershipCallbackCalls()).toBe(0);
    expect(control.value).toBe(PREVIOUS);
    expect(foreign.control.value).toBe(PREVIOUS);
  });

  it('cannot mint write authority after the forward value has already changed', () => {
    const control = document.createElement('input');
    control.value = PREVIOUS;
    document.body.append(control);
    const targetAuthority = createTextSemanticTargetAuthority(control);
    if (targetAuthority === null) throw new Error('expected target authority');
    const operation = vi.fn(() => true);
    const transaction: TextSemanticTransaction = {
      targetAuthority,
      writeUserEditGeneration: 0,
      userEditGeneration: vi.fn(() => 0),
      targetState: vi.fn<() => TextTargetState>(() => 'CURRENT'),
      wasUserEdited: vi.fn(() => false),
      isAtPreWriteState: operation,
      isAtWrittenState: operation,
      captureWrittenState: vi.fn(),
      restorePreWriteFromWrittenState: operation,
      dispose: vi.fn(),
    };

    control.value = EXPECTED;

    expect(createTextSemanticWriteAuthority(targetAuthority, transaction, {
      previous: PREVIOUS,
      expected: EXPECTED,
    })).toBeNull();
    expect(operation).not.toHaveBeenCalled();
    expect(transaction.userEditGeneration).not.toHaveBeenCalled();
    expect(transaction.targetState).not.toHaveBeenCalled();
    expect(transaction.captureWrittenState).not.toHaveBeenCalled();
    expect(control.value).toBe(EXPECTED);
  });

  it('cannot mint write authority from a stale pre-write generation', () => {
    const control = document.createElement('textarea');
    control.value = PREVIOUS;
    document.body.append(control);
    const targetAuthority = createTextSemanticTargetAuthority(control);
    if (targetAuthority === null) throw new Error('expected target authority');
    const targetState = vi.fn<() => TextTargetState>(() => 'CURRENT');
    const transaction: TextSemanticTransaction = {
      targetAuthority,
      writeUserEditGeneration: 0,
      userEditGeneration: vi.fn(() => 1),
      targetState,
      wasUserEdited: vi.fn(() => false),
      isAtPreWriteState: vi.fn(() => true),
      isAtWrittenState: vi.fn(() => false),
      captureWrittenState: vi.fn(),
      restorePreWriteFromWrittenState: vi.fn(() => false),
      dispose: vi.fn(),
    };

    expect(createTextSemanticWriteAuthority(targetAuthority, transaction, {
      previous: PREVIOUS,
      expected: EXPECTED,
    })).toBeNull();
    expect(transaction.userEditGeneration).toHaveBeenCalledTimes(1);
    expect(targetState).not.toHaveBeenCalled();
    expect(control.value).toBe(PREVIOUS);
  });

  it.each([
    ['type', (control: HTMLInputElement) => { control.type = 'password'; }],
    ['autocomplete', (control: HTMLInputElement) => { control.autocomplete = 'current-password'; }],
    ['role', (control: HTMLInputElement) => { control.setAttribute('role', 'combobox'); }],
  ] as const)('rejects branded %s drift before any ownership or host callback', async (_label, drift) => {
    const harness = mountTextHarness('input', {
      inputType: 'text',
      autocomplete: 'name',
      role: 'textbox',
    });
    harness.control.value = EXPECTED;
    drift(harness.control as HTMLInputElement);
    const executionFence = vi.fn(() => null);
    const settle = vi.fn(async () => undefined);
    const lateRecheckDelay = vi.fn(async () => undefined);
    const readHostValidation = vi.fn(() => ({ ariaInvalid: 'false' }));

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence,
        settle,
        lateRecheckDelay,
        readHostValidation,
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.ownershipCallbackCalls()).toBe(0);
    expect(executionFence).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(lateRecheckDelay).not.toHaveBeenCalled();
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('latches protected target attribute ABA before settlement and calls no provider callback', async () => {
    const harness = mountTextHarness('input', {
      inputType: 'text',
      autocomplete: 'name',
      role: 'textbox',
    });
    harness.control.value = EXPECTED;
    const control = harness.control as HTMLInputElement;
    control.type = 'password';
    control.type = 'text';
    control.autocomplete = 'current-password';
    control.autocomplete = 'name';
    control.setAttribute('role', 'combobox');
    control.setAttribute('role', 'textbox');
    const executionFence = vi.fn(() => null);
    const settle = vi.fn(async () => undefined);
    const lateRecheckDelay = vi.fn(async () => undefined);
    const readHostValidation = vi.fn(() => ({ ariaInvalid: 'false' }));

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence,
        settle,
        lateRecheckDelay,
        readHostValidation,
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.ownershipCallbackCalls()).toBe(0);
    expect(executionFence).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(lateRecheckDelay).not.toHaveBeenCalled();
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('treats safe-to-safe target metadata drift as identity loss', async () => {
    const harness = mountTextHarness('input', {
      inputType: 'text',
      autocomplete: 'given-name',
      role: 'textbox',
    });
    harness.control.value = EXPECTED;
    const control = harness.control as HTMLInputElement;
    control.type = 'email';
    control.autocomplete = 'family-name';

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.ownershipCallbackCalls()).toBe(0);
  });

  it('stops after a host callback drifts protected target semantics and never restores through it', async () => {
    const harness = mountTextHarness('input', { inputType: 'text' });
    harness.control.value = EXPECTED;
    const readHostValidation = vi.fn(() => ({ ariaInvalid: 'false' }));
    const lateRecheckDelay = vi.fn(async () => undefined);

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: async () => {
          (harness.control as HTMLInputElement).type = 'password';
        },
        readHostValidation,
        lateRecheckDelay,
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(readHostValidation).not.toHaveBeenCalled();
    expect(lateRecheckDelay).not.toHaveBeenCalled();
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it.each(['input', 'textarea'] as const)(
    'commits a stable controlled %s only after late readback, host acceptance, and exact Undo sealing',
    async (kind) => {
      const harness = mountTextHarness(kind);
      harness.control.value = EXPECTED;
      const sequence: string[] = [];
      const click = vi.spyOn(HTMLElement.prototype, 'click');
      const submit = vi.fn();
      document.addEventListener('submit', submit);

      const result = await settleTextSemanticWrite(
        settlementInput(harness, {
          settle: async () => {
            sequence.push('settle');
          },
          lateRecheckDelay: async () => {
            sequence.push('late');
          },
          readHostValidation: () => {
            sequence.push('host');
            return { willValidate: true, valid: true };
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(result.value.writtenValue).toBe(EXPECTED);
      expect(result.value.undo.isAtWrittenState()).toBe(true);
      expect(harness.transactionOwnsWrittenState()).toBe(false);
      expect(harness.undoOwnsWrittenState()).toBe(true);
      expect(sequence).toEqual([
        'settle',
        'host',
        'late',
        'settle',
        'host',
        'settle',
        'host',
      ]);
      expect(click).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();

      expect(result.value.undo.restorePreWrite()).toBe(true);
      expect(harness.undoOwnsWrittenState()).toBe(false);
      expect(result.value.undo.isAtPreWriteState()).toBe(true);
      expect(harness.control.value).toBe(PREVIOUS);
    },
  );

  it('caches each prepared-transfer getter exactly once before commit', async () => {
    const harness = mountTextHarness('input', { transferAccessorGetters: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(harness.transferGetterCalls()).toBe(3);
    expect(harness.commitCalls()).toBe(1);
    expect(result.value.undo.restorePreWrite()).toBe(true);
  });

  it('caches a raw transfer before its getter synchronously republishes the same object', async () => {
    const harness = mountTextHarness('input', {
      transferAccessorGetters: true,
      republishTransferFromGetter: true,
    });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(harness.transferGetterCalls()).toBe(3);
    expect(harness.commitCalls()).toBe(1);
    expect(harness.cancelCalls()).toBe(0);
    expect(result.value.undo.restorePreWrite()).toBe(true);
  });

  it('disposes the exact prepared Undo when a later transfer getter throws', async () => {
    const harness = mountTextHarness('input', { transferCommitGetterThrows: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.transferGetterCalls()).toBe(3);
    expect(harness.commitCalls()).toBe(0);
    expect(harness.cancelCalls()).toBe(1);
    expect(harness.undoDisposeCalls()).toBe(1);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('cancels and disposes a prepared candidate when an Undo member getter throws', async () => {
    const harness = mountTextHarness('input', { undoMemberGetterThrows: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.commitCalls()).toBe(0);
    expect(harness.cancelCalls()).toBe(1);
    expect(harness.undoDisposeCalls()).toBe(1);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('does not cancel the committed owner when the exact transfer is published late again', async () => {
    const harness = mountTextHarness('input', { republishCommittedTransferLater: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    await Promise.resolve();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(harness.commitCalls()).toBe(1);
    expect(harness.cancelCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(result.value.undo.restorePreWrite()).toBe(true);
  });

  it('cleans a distinct transfer published after another owner commits', async () => {
    const harness = mountTextHarness('input', { publishAlternateTransferLater: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    await Promise.resolve();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(harness.commitCalls()).toBe(1);
    expect(harness.alternateCancelCalls()).toBe(1);
    expect(harness.alternateUndoDisposeCalls()).toBe(1);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(result.value.undo.restorePreWrite()).toBe(true);
  });

  it('revokes settlement when a distinct late transfer aliases the selected raw Undo', async () => {
    const harness = mountTextHarness('input', { publishAliasTransferLater: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    await Promise.resolve();

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.commitCalls()).toBe(1);
    expect(harness.alternateCancelCalls()).toBe(1);
    expect(harness.undoDisposeCalls()).toBe(1);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('revokes settlement when a late transfer exposes no provable cleanup path', async () => {
    const harness = mountTextHarness('input', { publishMalformedTransferLater: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    await Promise.resolve();

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.commitCalls()).toBe(1);
    expect(harness.undoDisposeCalls()).toBe(1);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('disposes a committed exact Undo when a retained publisher later exposes no cleanup path', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(harness.undoDisposeCalls()).toBe(0);

    harness.publishMalformedTransfer();

    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.undoDisposeCalls()).toBe(1);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('stops reading a late transfer immediately when its first getter detaches the target', async () => {
    const harness = mountTextHarness('input', { lateTransferGetterMutation: 'DETACH' });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          harness.publishGetterBackedTransfer();
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'DETACHED' });
    expect(harness.transferGetterCalls()).toBe(1);
    expect(harness.alternateCancelCalls()).toBe(0);
    expect(harness.alternateUndoDisposeCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.isConnected).toBe(false);
  });

  it('runs no dispose or restore hook after a late transfer cancel replaces the target', async () => {
    const harness = mountTextHarness('input', { lateTransferCancelMutation: 'REPLACE' });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          harness.publishGetterBackedTransfer();
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.transferGetterCalls()).toBe(3);
    expect(harness.alternateCancelCalls()).toBe(1);
    expect(harness.alternateUndoDisposeCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(harness.restoreCalls()).toBe(0);
    const replacement = document.querySelector(
      `[data-semantic-text-slot="${harness.control.dataset.semanticTextSlot}"]`,
    ) as HTMLInputElement;
    expect(replacement.value).toBe('Late publisher replacement');
  });

  it('ignores a prepared transfer published after terminal transaction cleanup', async () => {
    const harness = mountTextHarness('input', { publishAfterCaptureReturns: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    await Promise.resolve();

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.commitCalls()).toBe(0);
    expect(harness.cancelCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.transactionDisposed()).toBe(true);
    expect(harness.retainedUndoIsAtWrittenState()).toBe(false);
    expect(harness.commitRetainedTransfer()).toBe(false);
    expect(harness.undoOwnsWrittenState()).toBe(false);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('demotes immediate success when the controlled host reverts during the late window', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let controlledRenderQueued = false;
    harness.control.addEventListener('input', () => {
      controlledRenderQueued = true;
    });
    harness.control.dispatchEvent(new Event('input', { bubbles: true }));

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          if (controlledRenderQueued) harness.control.value = PREVIOUS;
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.undoDisposed()).toBe(true);
  });

  it('rejects an immediate controlled-render revert during the first settle', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let firstSettle = true;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: async () => {
          if (firstSettle) {
            firstSettle = false;
            harness.control.value = PREVIOUS;
          }
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'WRITE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('uses exact generic text semantics and never folds meaningful punctuation away', async () => {
    const harness = mountTextHarness('textarea', { plannedExpected: 'C++' });
    harness.control.value = 'C';

    const result = await settleTextSemanticWrite(
      settlementInput(harness),
    );

    expect(result).toEqual({ ok: false, code: 'VALUE_COERCED' });
    expect(harness.control.value).toBe('C');
    expect(harness.restoreCalls()).toBe(0);
  });

  it('classifies an exact previous value as reverted even when normalization overlaps expected', async () => {
    const harness = mountTextHarness('input', { plannedExpected: 'Be-fore' });
    harness.control.value = PREVIOUS;

    const result = await settleTextSemanticWrite(
      settlementInput(harness),
    );

    expect(result).toEqual({ ok: false, code: 'WRITE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('rejects a blur-event state drift before it can seal success', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let firstSettle = true;
    harness.control.addEventListener(
      'blur',
      () => {
        harness.control.value = PREVIOUS;
      },
      { once: true },
    );

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: async () => {
          if (firstSettle) {
            firstSettle = false;
            harness.control.dispatchEvent(new Event('blur'));
          }
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'WRITE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('compensates the exact written state when late host validation rejects it', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let validations = 0;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        readHostValidation: () => {
          validations += 1;
          return validations === 1 ? { ariaInvalid: 'false' } : { ariaInvalid: 'true' };
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'HOST_REJECTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('fails closed on unknown host validation and removes this transaction-owned write', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        readHostValidation: () => ({}),
      }),
    );

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('does not service retained publishers after a replacement occupies the reviewed slot', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let replacement: HTMLInputElement | null = null;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          replacement = document.createElement('input');
          replacement.dataset.semanticTextSlot = harness.control.dataset.semanticTextSlot;
          replacement.value = 'Host replacement';
          harness.control.replaceWith(replacement);
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    const liveReplacement = document.querySelector(
      `[data-semantic-text-slot="${harness.control.dataset.semanticTextSlot}"]`,
    ) as HTMLInputElement;
    expect(liveReplacement.value).toBe('Host replacement');
    expect(harness.restoreCalls()).toBe(0);
    const providerCalls = harness.ownershipCallbackCalls();

    harness.publishMalformedTransfer();
    harness.publishGetterBackedTransfer();

    expect(harness.ownershipCallbackCalls()).toBe(providerCalls);
    expect(harness.transferGetterCalls()).toBe(0);
    expect(harness.alternateCancelCalls()).toBe(0);
    expect(harness.alternateUndoDisposeCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(harness.restoreCalls()).toBe(0);
    expect(liveReplacement.value).toBe('Host replacement');
  });

  it('reports a detached target and terminally ignores retained publishers', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          harness.control.remove();
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'DETACHED' });
    expect(harness.restoreCalls()).toBe(0);
    // Once identity is no longer live, the leaf invokes no provider callback,
    // including a potentially opaque dispose hook.
    expect(harness.undoDisposed()).toBe(false);
    const providerCalls = harness.ownershipCallbackCalls();

    harness.publishMalformedTransfer();
    harness.publishGetterBackedTransfer();

    expect(harness.ownershipCallbackCalls()).toBe(providerCalls);
    expect(harness.transferGetterCalls()).toBe(0);
    expect(harness.alternateCancelCalls()).toBe(0);
    expect(harness.alternateUndoDisposeCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('independently rejects a detached DOM node even when its adapter lies CURRENT', async () => {
    const harness = mountTextHarness('input', { lieAboutTargetState: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          harness.control.remove();
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'DETACHED' });
    expect(harness.restoreCalls()).toBe(0);
  });

  it('preserves a later trusted user edit and returns ABORTED', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          harness.control.value = 'User correction';
          harness.setUserEdited(true);
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(harness.control.value).toBe('User correction');
    expect(harness.restoreCalls()).toBe(0);
  });

  it('leaves an unowned host third state untouched instead of blindly restoring', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          harness.control.value = 'Host canonical value';
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(harness.control.value).toBe('Host canonical value');
    expect(harness.restoreCalls()).toBe(0);
  });

  it('catches a final host-validation side effect with one last exact read', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let validations = 0;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        readHostValidation: () => {
          validations += 1;
          if (validations === 2) harness.control.value = PREVIOUS;
          return { ariaInvalid: 'false' };
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('settles framework microtask drift before the final read-only host verdict', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let settles = 0;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: async () => {
          settles += 1;
          if (settles === 3) {
            queueMicrotask(() => {
              harness.control.value = PREVIOUS;
            });
          }
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('re-reads host validation after the final settle changes validity without changing value', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let settles = 0;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: async () => {
          settles += 1;
          if (settles === 3) harness.control.setAttribute('aria-invalid', 'true');
        },
        readHostValidation: (target) => ({
          ariaInvalid: target.getAttribute('aria-invalid') ?? 'false',
        }),
      }),
    );

    expect(result).toEqual({ ok: false, code: 'HOST_REJECTED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it.each([
    {
      label: 'raw value',
      mutate: (harness: TextHarness) => {
        harness.setHostValue(PREVIOUS);
      },
      code: 'LATE_REVERTED',
      value: PREVIOUS,
    },
    {
      label: 'user-edit generation',
      mutate: (harness: TextHarness) => {
        harness.setUserEdited(true);
      },
      code: 'ABORTED',
      value: EXPECTED,
    },
    {
      label: 'execution policy',
      mutate: (harness: TextHarness, state: { policyClosed: boolean }) => {
        state.policyClosed = true;
        invalidateTextSemanticWriteAuthority(harness.writeAuthority, {
          kind: 'EXECUTION_STOP',
          code: 'POLICY_DISABLED',
        });
      },
      code: 'POLICY_DISABLED',
      value: PREVIOUS,
    },
    {
      label: 'parent AbortSignal',
      mutate: (_harness: TextHarness, _state: { policyClosed: boolean }, controller: AbortController) => {
        controller.abort();
      },
      code: 'ABORTED',
      value: PREVIOUS,
    },
    {
      label: 'Undo ownership revocation',
      mutate: (harness: TextHarness) => {
        harness.setOwnershipProof('false');
      },
      code: 'IDENTITY_CHANGED',
      value: EXPECTED,
    },
  ] as const)(
    're-proves $label after the final opaque ownership callback',
    async ({ mutate, code, value }) => {
      let armFinalProof = false;
      const state = { policyClosed: false };
      const controller = new AbortController();
      let harness!: TextHarness;
      harness = mountTextHarness('input', {
        onUndoProof: () => {
          if (!armFinalProof) return;
          armFinalProof = false;
          mutate(harness, state, controller);
        },
      });
      harness.control.value = EXPECTED;
      let validations = 0;

      const result = await settleTextSemanticWrite(
        settlementInput(harness, {
          signal: controller.signal,
          executionFence: () => (state.policyClosed ? 'POLICY_DISABLED' : null),
          readHostValidation: () => {
            validations += 1;
            if (validations === 3) armFinalProof = true;
            return { ariaInvalid: 'false' };
          },
        }),
      );

      expect(result).toEqual({ ok: false, code });
      expect(harness.control.value).toBe(value);
    },
  );

  it('fails closed when the final execution fence revokes ownership but returns null', async () => {
    let armFinalFence = false;
    let validations = 0;
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        readHostValidation: () => {
          validations += 1;
          if (validations === 3) armFinalFence = true;
          return { ariaInvalid: 'false' };
        },
        executionFence: () => {
          if (armFinalFence) {
            armFinalFence = false;
            invalidateTextSemanticWriteAuthority(harness.writeAuthority, {
              kind: 'OWNERSHIP_REVOKED',
            });
          }
          return null;
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('enforces the minimum late window even when an injected observer resolves immediately', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const hostTimer = setTimeout(() => {
      harness.control.value = PREVIOUS;
    }, 5);

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckMs: 15,
        lateRecheckDelay: async () => undefined,
      }),
    );
    clearTimeout(hostTimer);

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('uses the production microtask, two-frame, and macrotask settle when no seam is injected', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: undefined,
        lateRecheckDelay: undefined,
        operationTimeoutMs: 1_200,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.value.undo.isAtWrittenState()).toBe(true);
  });

  it('cancels the production frame settle when the parent AbortSignal closes', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const controller = new AbortController();
    const requestFrame = vi.fn(() => 73);
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const readHostValidation = vi.fn(() => ({ ariaInvalid: 'false' }));
    const lateRecheckDelay = vi.fn(async () => undefined);

    const pending = settleTextSemanticWrite(
      settlementInput(harness, {
        signal: controller.signal,
        settle: undefined,
        lateRecheckDelay,
        readHostValidation,
        operationTimeoutMs: 1_200,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, code: 'ABORTED' });
    expect(cancelFrame).toHaveBeenCalledWith(73);
    expect(readHostValidation).not.toHaveBeenCalled();
    expect(lateRecheckDelay).not.toHaveBeenCalled();
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('compensates an already-aborted write without entering any host operation', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const controller = new AbortController();
    controller.abort();
    const settle = vi.fn(async () => undefined);
    const lateRecheckDelay = vi.fn(async () => undefined);
    const readHostValidation = vi.fn(() => ({ ariaInvalid: 'false' }));
    const input = settlementInput(harness, {
      signal: controller.signal,
      settle,
      lateRecheckDelay,
      readHostValidation,
    });

    await expect(settleTextSemanticWrite(input)).resolves.toEqual({ ok: false, code: 'ABORTED' });
    expect(settle).not.toHaveBeenCalled();
    expect(lateRecheckDelay).not.toHaveBeenCalled();
    expect(readHostValidation).not.toHaveBeenCalled();
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
    await expect(settleTextSemanticWrite(input)).resolves.toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });
  });

  it('compensates after a bounded settle failure and reports a stable reason', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: async () => {
          throw new Error('synthetic host scheduler failure');
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'VERIFY_TIMEOUT' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('cannot report success when exact Undo ownership cannot be sealed', async () => {
    const harness = mountTextHarness('input', { captureWrittenState: false });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.transactionDisposed()).toBe(true);
  });

  it.each([
    {
      label: 'raw value',
      mutate: (harness: TextHarness) => {
        harness.control.value = PREVIOUS;
      },
      code: 'WRITE_REVERTED',
      value: PREVIOUS,
      restores: 0,
    },
    {
      label: 'user-edit generation',
      mutate: (harness: TextHarness) => {
        harness.setUserEdited(true);
      },
      code: 'ABORTED',
      value: EXPECTED,
      restores: 0,
    },
    {
      label: 'execution policy',
      mutate: (_harness: TextHarness, state: { policyClosed: boolean }) => {
        state.policyClosed = true;
      },
      code: 'POLICY_DISABLED',
      value: PREVIOUS,
      restores: 1,
    },
    {
      label: 'parent abort',
      mutate: (_harness: TextHarness, _state: { policyClosed: boolean }, controller: AbortController) => {
        controller.abort();
      },
      code: 'ABORTED',
      value: PREVIOUS,
      restores: 1,
    },
  ] as const)(
    're-proves $label immediately after the opaque transfer commit callback',
    async ({ mutate, code, value, restores }) => {
      const state = { policyClosed: false };
      const controller = new AbortController();
      let harness!: TextHarness;
      harness = mountTextHarness('input', {
        onTransferCommit: () => mutate(harness, state, controller),
      });
      harness.control.value = EXPECTED;

      const result = await settleTextSemanticWrite(
        settlementInput(harness, {
          signal: controller.signal,
          executionFence: () => (state.policyClosed ? 'POLICY_DISABLED' : null),
        }),
      );

      expect(result).toEqual({ ok: false, code });
      expect(harness.control.value).toBe(value);
      expect(harness.restoreCalls()).toBe(restores);
    },
  );

  it('retains transaction cleanup when the prepared candidate revokes itself during proof', async () => {
    let harness!: TextHarness;
    harness = mountTextHarness('input', {
      onUndoProof: () => harness.setOwnershipProof('false'),
    });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.undoDisposed()).toBe(true);
    expect(harness.transactionDisposed()).toBe(true);
  });

  it('atomically retains transaction compensation when a prepared Undo candidate is invalid', async () => {
    const harness = mountTextHarness('input', { invalidCapturedOwnership: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.undoDisposed()).toBe(true);
    expect(harness.transactionDisposed()).toBe(true);
  });

  it.each([
    ['capture throw', { captureThrows: true }],
    ['capture throw after prepared publication', { captureThrowsAfterPrepare: true }],
    ['invalid transfer shape', { invalidCaptureTransfer: true }],
    ['transfer commit false', { transferCommitReturnsFalse: true }],
    ['transfer commit throw', { transferCommitThrows: true }],
    ['transfer cancel throw after commit false', {
      transferCommitReturnsFalse: true,
      cancelThrows: true,
    }],
  ] as const)('keeps one exact transaction recovery owner after %s', async (_label, options) => {
    const harness = mountTextHarness('input', options);
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result).toEqual({ ok: false, code: 'JOURNAL_UNAVAILABLE' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.transactionOwnsWrittenState()).toBe(false);
    expect(harness.undoOwnsWrittenState()).toBe(false);
    expect(harness.transactionDisposed()).toBe(true);
  });

  it('deduplicates the same prepared transfer without repeating getters or cleanup', async () => {
    const harness = mountTextHarness('input', { duplicateCapturePublication: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(harness.commitCalls()).toBe(1);
    expect(harness.cancelCalls()).toBe(0);
    expect(harness.undoDisposeCalls()).toBe(0);
    expect(harness.undoOwnsWrittenState()).toBe(true);
    expect(harness.transactionOwnsWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(true);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.control.value).toBe(PREVIOUS);
  });

  it('retains exact read-only transaction recovery when Undo capture and compensation both fail', async () => {
    const harness = mountTextHarness('input', {
      captureWrittenState: false,
      restoreSucceeds: false,
    });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected journal failure');
    expect(result.code).toBe('JOURNAL_UNAVAILABLE');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    expect(result.recovery?.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.transactionDisposed()).toBe(false);
  });

  it('returns only an exact recovery handle when immediate compensation cannot complete', async () => {
    const harness = mountTextHarness('input', { restoreSucceeds: false });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        readHostValidation: () => ({ ariaInvalid: 'true' }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected host rejection');
    expect(result.code).toBe('HOST_REJECTED');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('never restores transaction state after cleanup observes explicit ownership revocation', async () => {
    const harness = mountTextHarness('input', { captureWrittenState: false });
    harness.control.value = EXPECTED;
    let cleanupFence = true;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence: () => {
          if (cleanupFence) {
            cleanupFence = false;
            invalidateTextSemanticWriteAuthority(harness.writeAuthority, {
              kind: 'OWNERSHIP_REVOKED',
            });
          }
          return null;
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('never restores transaction state after final ownership proof reports raw ABA', async () => {
    let armed = false;
    let guardedProofs = 0;
    let harness!: TextHarness;
    harness = mountTextHarness('input', {
      captureWrittenState: false,
      onUserEditGeneration: () => {
        if (!armed || ++guardedProofs !== 3) return;
        harness.setHostValue('Host third state');
        harness.setHostValue(EXPECTED);
      },
    });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence: () => {
          armed = true;
          return null;
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('never restores sealed Undo after host-rejection cleanup proof reports raw ABA', async () => {
    let armed = false;
    let cleanupFences = 0;
    const harness = mountTextHarness('input');
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        readHostValidation: () => {
          armed = true;
          return { ariaInvalid: 'true' };
        },
        executionFence: () => {
          if (armed && ++cleanupFences === 3) {
            harness.setHostValue('Host third state');
            harness.setHostValue(EXPECTED);
          }
          return null;
        },
      }),
    );

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('wraps a successful unsafe provider so later user edits cannot be overwritten by Undo', async () => {
    const harness = mountTextHarness('input', { unsafeUndoRestore: true });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    harness.control.value = 'Later user edit';
    harness.setUserEdited(true);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe('Later user edit');
    expect(harness.restoreCalls()).toBe(0);
  });

  it('spends Undo once so an ABA return to the same raw value cannot re-arm restoration', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    expect(result.value.undo.restorePreWrite()).toBe(true);
    harness.control.value = EXPECTED;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('never invokes Undo restore after its final ownership proof reports raw ABA', async () => {
    let armed = false;
    let guardedProofs = 0;
    let harness!: TextHarness;
    harness = mountTextHarness('input', {
      onUserEditGeneration: () => {
        if (!armed || ++guardedProofs !== 3) return;
        harness.setHostValue('Host third state');
        harness.setHostValue(EXPECTED);
      },
    });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    armed = true;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('never invokes Undo restore when its final ownership proof aborts the parent signal', async () => {
    const controller = new AbortController();
    let armed = false;
    let guardedProofs = 0;
    const harness = mountTextHarness('input', {
      onUserEditGeneration: () => {
        if (!armed || ++guardedProofs !== 3) return;
        controller.abort();
      },
    });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, { signal: controller.signal }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    armed = true;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.restoreCalls()).toBe(0);
    expect(harness.control.value).toBe(EXPECTED);
  });

  it('permanently revokes Undo after observing a user edit even when raw value and generation ABA', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    harness.control.value = 'User correction';
    harness.setUserEdited(true);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    harness.control.value = EXPECTED;
    harness.setUserEdited(false);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo when user-edit generation ABA completes before the first Undo read', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    harness.control.value = 'User correction';
    harness.setUserEdited(true);
    harness.control.value = EXPECTED;
    harness.setUserEdited(false);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo after a third raw state even when the exact value ABA returns', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    harness.control.value = 'Host third state';
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    harness.control.value = EXPECTED;
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo when raw-value ABA finishes before the first Undo read', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    harness.setHostValue('Host third state');
    harness.setHostValue(EXPECTED);

    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo when policy closes even if policy and raw value later recover', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let policyClosed = false;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence: () => (policyClosed ? 'POLICY_DISABLED' : null),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    policyClosed = true;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    policyClosed = false;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('blocks Undo when its pre-restore fence reports submission through the monotonic seam', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let blockRestore = false;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence: () => {
          if (blockRestore) {
            invalidateTextSemanticWriteAuthority(harness.writeAuthority, {
              kind: 'EXECUTION_STOP',
              code: 'HOST_SUBMITTED',
            });
          }
          return null;
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    blockRestore = true;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    blockRestore = false;
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo across detach and same-node reattachment ABA', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    const parent = harness.control.parentNode;
    if (parent === null) throw new Error('expected mounted control');

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    harness.control.remove();
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    parent.append(harness.control);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo when an ancestor detach/reattach ABA completes before the first read', async () => {
    const container = document.createElement('section');
    document.body.append(container);
    const harness = mountTextHarness('input', { mountParent: container });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    container.remove();
    document.body.append(container);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('permanently revokes Undo when a shadow host detach/reattach ABA completes before the first read', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.append(host);
    const harness = mountTextHarness('input', { mountParent: shadow });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    host.remove();
    document.body.append(host);
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.restoreCalls()).toBe(0);
  });

  it.each(['false', 'throw'] as const)(
    'permanently revokes Undo after an ownership proof returns %s',
    async (failureMode) => {
      const harness = mountTextHarness();
      harness.control.value = EXPECTED;

      const result = await settleTextSemanticWrite(settlementInput(harness));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);

      harness.setOwnershipProof(failureMode);
      expect(result.value.undo.isAtWrittenState()).toBe(false);
      harness.setOwnershipProof('true');
      expect(result.value.undo.isAtWrittenState()).toBe(false);
      expect(result.value.undo.restorePreWrite()).toBe(false);
      expect(harness.control.value).toBe(EXPECTED);
      expect(harness.restoreCalls()).toBe(0);
    },
  );

  it('permanently revokes Undo after protected target drift and attribute ABA', async () => {
    const harness = mountTextHarness('input', { inputType: 'text' });
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(settlementInput(harness));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    const control = harness.control as HTMLInputElement;
    control.type = 'password';
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    control.type = 'text';
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    expect(result.value.undo.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('pre-seals early HOST_SUBMITTED ownership but exposes no writable recovery', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence: () => 'HOST_SUBMITTED',
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected host submission');
    expect(result.code).toBe('HOST_SUBMITTED');
    expect(result.recovery?.isAtWrittenState()).toBe(true);
    expect(result.recovery?.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('aborts a timed-out cooperative host operation before cleanup can be undone', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        operationTimeoutMs: 5,
        settle: (signal) =>
          new Promise<void>((resolve) => {
            const lateMutation = setTimeout(() => {
              harness.control.value = 'Late operation write';
              resolve();
            }, 30);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(lateMutation);
                resolve();
              },
              { once: true },
            );
          }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(result).toEqual({ ok: false, code: 'VERIFY_TIMEOUT' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('aborts a rejected cooperative host operation before its queued mutation can escape', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        settle: (signal) =>
          new Promise<void>((_resolve, reject) => {
            const lateMutation = setTimeout(() => {
              harness.control.value = 'Rejected operation write';
            }, 20);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(lateMutation);
              },
              { once: true },
            );
            reject(new Error('synthetic rejected settle'));
          }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(result).toEqual({ ok: false, code: 'VERIFY_TIMEOUT' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('never compensates after host validation observes submission', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let submitted = false;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        executionFence: () => (submitted ? 'HOST_SUBMITTED' : null),
        readHostValidation: () => {
          submitted = true;
          return { ariaInvalid: 'true' };
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected host submission');
    expect(result.code).toBe('HOST_SUBMITTED');
    expect(result.recovery?.restorePreWrite()).toBe(false);
    expect(harness.control.value).toBe(EXPECTED);
    expect(harness.restoreCalls()).toBe(0);
  });

  it('compensates when the execution fence closes during the late window', async () => {
    const harness = mountTextHarness();
    harness.control.value = EXPECTED;
    let stopped = false;

    const result = await settleTextSemanticWrite(
      settlementInput(harness, {
        lateRecheckDelay: async () => {
          stopped = true;
        },
        executionFence: () => (stopped ? 'POLICY_DISABLED' : null),
      }),
    );

    expect(result).toEqual({ ok: false, code: 'POLICY_DISABLED' });
    expect(harness.control.value).toBe(PREVIOUS);
    expect(harness.restoreCalls()).toBe(1);
  });
});
