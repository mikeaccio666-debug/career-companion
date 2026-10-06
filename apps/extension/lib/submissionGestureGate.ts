import type {
  ApplyFormDescriptor,
  FinalSubmitControlDescriptor,
} from '@edaix/apply-kernel/contracts';
import { isTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { markSubmissionBlockedByAuthority } from '@edaix/apply-kernel/runner';
import {
  parseSubmissionArmDescriptor,
  sameSubmissionAuthority,
  type SubmissionArmDescriptor,
  type SubmissionBoundaryRuntimeMessage,
  type SubmissionBoundaryRuntimeState,
} from './submissionBoundaryProtocol';

export interface SubmissionGestureEvent {
  readonly kind: 'preactivation' | 'activation' | 'submit';
  readonly trusted: boolean;
  readonly activeUserGesture: boolean;
  readonly targetMatches: boolean;
  readonly exactControlMatches: boolean;
  readonly submitterMatches: boolean;
  markAuthorityBlocked(): void;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export interface ReviewValueSeal {
  isCurrent(): boolean;
}

export type FinalReviewState = 'REVIEW_REQUIRED' | 'REVIEW_CONFIRMED';

export interface SubmissionGestureGate {
  readonly state: SubmissionBoundaryRuntimeState;
  readonly finalReviewState: FinalReviewState;
  canConfirmFinalReview(): boolean;
  confirmFinalReview(event: Event, shadowRoot: ShadowRoot): Promise<boolean>;
  onFinalReviewStateChange(listener: (state: FinalReviewState) => void): () => void;
  onStateChange(listener: (state: SubmissionBoundaryRuntimeState) => void): () => void;
  revokeFinalReview(): void;
  /** Keep synchronous blockers installed until a fresh gate atomically replaces this one. */
  retireToBlockedTombstone(): void;
  handle(event: SubmissionGestureEvent): void;
  dispose(): void;
}

interface NativeActivation {
  readonly event: Event;
  readonly control: HTMLButtonElement | HTMLInputElement;
  readonly phase: 'preactivation' | 'activation';
}

export interface EarlySubmissionCaptureBroker {
  addActivationListener(
    target: FinalSubmitControlDescriptor,
    listener: (activation: NativeActivation) => void,
  ): () => void;
  addSubmitListener(
    target: FinalSubmitControlDescriptor,
    listener: (event: Event) => void,
  ): () => void;
  dispose(): void;
}

export function createSubmissionGestureGate(input: Readonly<{
  descriptor: SubmissionArmDescriptor;
  target: FinalSubmitControlDescriptor;
  sendMessage: (message: SubmissionBoundaryRuntimeMessage) => Promise<unknown>;
  addActivationListener?: (listener: (activation: NativeActivation) => void) => () => void;
  addSubmitListener?: (listener: (event: Event) => void) => () => void;
  addReviewInvalidationListener?: (listener: () => void) => () => void;
  hasActiveUserGesture?: () => boolean;
  isStillAuthorized: () => boolean;
  captureReviewValueSeal: () => ReviewValueSeal | null;
}>): SubmissionGestureGate {
  let descriptor = input.descriptor;
  let state: SubmissionBoundaryRuntimeState =
    descriptor.mode === 'BLOCKED' ? 'BLOCKED' : descriptor.state;
  let disposed = false;
  let tombstoned = descriptor.mode === 'BLOCKED';
  let enterInFlight = false;
  let triggerPreparationInFlight = false;
  let triggerPreparationVersion = 0;
  let triggerPhaseVersion = 0;
  let boundaryRequestVersion = 0;
  let reviewAttemptVersion = 0;
  let submitTokenVersion = 0;
  let submitToken: Readonly<{
    element: HTMLButtonElement | HTMLInputElement;
    reviewValueSeal: ReviewValueSeal;
  }> | null = null;
  let preparedTrigger: Extract<
    SubmissionArmDescriptor,
    { mode: 'ACTIVE'; state: 'WAIT_FOR_FINAL_RETRY' }
  > | null = null;
  let reviewValueSeal: ReviewValueSeal | null = null;
  let finalReviewState: FinalReviewState = 'REVIEW_REQUIRED';
  const reviewStateListeners = new Set<(state: FinalReviewState) => void>();
  const stateListeners = new Set<(state: SubmissionBoundaryRuntimeState) => void>();

  const setState = (next: SubmissionBoundaryRuntimeState): void => {
    if (state === next) return;
    state = next;
    for (const listener of stateListeners) listener(state);
  };

  const requireFinalReview = (preserveSubmitToken: boolean): void => {
    reviewAttemptVersion += 1;
    reviewValueSeal = null;
    if (!preserveSubmitToken) {
      triggerPreparationVersion += 1;
      triggerPreparationInFlight = false;
      preparedTrigger = null;
      submitTokenVersion += 1;
      submitToken = null;
    }
    if (finalReviewState === 'REVIEW_REQUIRED') return;
    finalReviewState = 'REVIEW_REQUIRED';
    for (const listener of reviewStateListeners) listener(finalReviewState);
  };

  const queueKnownBlockedCancellation = (
    activeDescriptor: Extract<
      SubmissionArmDescriptor,
      { mode: 'ACTIVE'; state: 'WAIT_FOR_USER_RETRY' | 'WAIT_FOR_FINAL_RETRY' }
    >,
  ): void => {
    try {
      void input.sendMessage({
        kind: 'submission-boundary/trigger-cancelled',
        bindingId: activeDescriptor.bindingId,
        authority: activeDescriptor.authority,
        triggerClientRequestId: activeDescriptor.triggerClientRequestId,
      }).catch(() => {
        // The trusted attempt was synchronously blocked. A lost cancellation
        // remains fail closed: a later arm converts the prepared record to
        // outcome-unknown rather than guessing that no click began.
      });
    } catch {
      // Same fail-closed outcome as an asynchronously rejected cancellation.
    }
  };

  const revokeFinalReview = (): void => {
    const prepared = preparedTrigger;
    preparedTrigger = null;
    if (prepared !== null) queueKnownBlockedCancellation(prepared);
    requireFinalReview(false);
  };

  const retireToBlockedTombstone = (): void => {
    if (disposed) return;
    tombstoned = true;
    setState('BLOCKED');
    boundaryRequestVersion += 1;
    revokeFinalReview();
  };

  const markFinalReviewConfirmed = (seal: ReviewValueSeal): void => {
    reviewValueSeal = seal;
    if (finalReviewState === 'REVIEW_CONFIRMED') return;
    finalReviewState = 'REVIEW_CONFIRMED';
    for (const listener of reviewStateListeners) listener(finalReviewState);
  };

  const checkStillAuthorized = (): boolean => {
    if (disposed || tombstoned) return false;
    let current = false;
    try {
      const nowMs = Date.now();
      current = descriptor.mode === 'ACTIVE' &&
        Number.isFinite(nowMs) &&
        nowMs < descriptor.expiresAtMs &&
        input.isStillAuthorized() === true &&
        input.target.isCurrent();
    } catch {
      current = false;
    }
    if (!current) retireToBlockedTombstone();
    return current;
  };

  const reviewValuesStillCurrent = (seal = reviewValueSeal): boolean => {
    try {
      return seal?.isCurrent() === true;
    } catch {
      return false;
    }
  };

  const canConfirmFinalReview = (): boolean =>
    !disposed &&
    !tombstoned &&
    !enterInFlight &&
    descriptor.mode === 'ACTIVE' &&
    (state === 'ARMED' || state === 'BOUNDARY_PENDING' || state === 'WAIT_FOR_USER_RETRY') &&
    checkStillAuthorized();

  const sendTriggerPhase = (
    kind: 'submission-boundary/trigger-confirmed',
    activeDescriptor: Extract<SubmissionArmDescriptor, { mode: 'ACTIVE'; state: 'WAIT_FOR_FINAL_RETRY' }>,
  ): boolean => {
    const version = ++triggerPhaseVersion;
    let pending: Promise<unknown>;
    try {
      pending = input.sendMessage({
        kind,
        bindingId: activeDescriptor.bindingId,
        authority: activeDescriptor.authority,
        triggerClientRequestId: activeDescriptor.triggerClientRequestId,
      });
    } catch {
      return false;
    }
    void pending.then((raw) => {
      if (version !== triggerPhaseVersion || disposed) return;
      const next = parseSubmissionArmDescriptor(raw);
      if (
        !next ||
        next.mode !== 'ACTIVE' ||
        next.bindingId !== activeDescriptor.bindingId ||
        next.expiresAtMs !== activeDescriptor.expiresAtMs ||
        !sameSubmissionAuthority(next.authority, activeDescriptor.authority) ||
        next.state !== 'TRIGGERED_LOCKED'
      ) {
        // The exact final click may already have reached host code before an
        // asynchronous ACK is decoded. A foreign/malformed ACK can never turn
        // that ambiguity into the false claim that submission was blocked.
        setState('OUTCOME_UNKNOWN');
        tombstoned = true;
        requireFinalReview(false);
        return;
      }
      descriptor = next;
      setState(next.state);
    }).catch(() => {
      if (version !== triggerPhaseVersion || disposed) return;
      // The background runtime may already have durably persisted the trigger.
      // Ambiguity is terminal locally; never offer another attempt.
      setState('OUTCOME_UNKNOWN');
      tombstoned = true;
    });
    return true;
  };

  const requestTriggerPreparation = async (
    activeDescriptor: Extract<
      SubmissionArmDescriptor,
      { mode: 'ACTIVE'; state: 'WAIT_FOR_USER_RETRY' }
    >,
  ): Promise<boolean> => {
    if (triggerPreparationInFlight || tombstoned || disposed) return false;
    const version = ++triggerPreparationVersion;
    triggerPreparationInFlight = true;
    let raw: unknown;
    try {
      raw = await input.sendMessage({
        kind: 'submission-boundary/trigger-observed',
        bindingId: activeDescriptor.bindingId,
        authority: activeDescriptor.authority,
        triggerClientRequestId: activeDescriptor.triggerClientRequestId,
      });
    } catch {
      if (version === triggerPreparationVersion && !disposed) {
        queueKnownBlockedCancellation(activeDescriptor);
        // The current click was synchronously swallowed. If both the observed
        // ACK and the cancellation ACK are lost, a later arm treats the
        // persisted preparation as ambiguous instead of reusing it.
        retireToBlockedTombstone();
      }
      return false;
    } finally {
      if (version === triggerPreparationVersion) triggerPreparationInFlight = false;
    }
    if (version !== triggerPreparationVersion || disposed || tombstoned) return false;
    const next = parseSubmissionArmDescriptor(raw);
    if (
      !next ||
      next.mode !== 'ACTIVE' ||
      next.bindingId !== activeDescriptor.bindingId ||
      next.expiresAtMs !== activeDescriptor.expiresAtMs ||
      !sameSubmissionAuthority(next.authority, activeDescriptor.authority) ||
      next.state !== 'WAIT_FOR_FINAL_RETRY' ||
      next.triggerClientRequestId !== activeDescriptor.triggerClientRequestId ||
      !checkStillAuthorized()
    ) {
      queueKnownBlockedCancellation(activeDescriptor);
      retireToBlockedTombstone();
      return false;
    }
    // The worker has durably recorded that this known-blocked click caused no
    // host action. A later, separate native retry may be allowed once. Losing
    // the page-local token makes a future arm outcome-unknown, never reusable.
    descriptor = next;
    setState(next.state);
    preparedTrigger = next;
    return true;
  };

  const requestBoundary = async (): Promise<boolean> => {
    if (
      descriptor.mode === 'ACTIVE' &&
      state === 'WAIT_FOR_USER_RETRY' &&
      descriptor.state === 'WAIT_FOR_USER_RETRY'
    ) return true;
    if (
      descriptor.mode !== 'ACTIVE' ||
      enterInFlight ||
      tombstoned ||
      (state !== 'ARMED' && state !== 'BOUNDARY_PENDING')
    ) return false;
    const requestedDescriptor = descriptor;
    const bindingId = requestedDescriptor.bindingId;
    const version = ++boundaryRequestVersion;
    enterInFlight = true;
    setState('BOUNDARY_PENDING');
    let raw: unknown;
    try {
      raw = await input.sendMessage({
        kind: 'submission-boundary/enter',
        bindingId,
        authority: requestedDescriptor.authority,
      });
    } catch {
      // The durable outbox may already contain the boundary request. Keep the
      // blocker and permit only a later explicit user retry to replay it.
      return false;
    } finally {
      if (version === boundaryRequestVersion) enterInFlight = false;
    }
    if (disposed || tombstoned || version !== boundaryRequestVersion) return false;
    const next = parseSubmissionArmDescriptor(raw);
    if (
      !next ||
      next.mode !== 'ACTIVE' ||
      next.bindingId !== bindingId ||
      next.expiresAtMs !== requestedDescriptor.expiresAtMs ||
      !sameSubmissionAuthority(next.authority, requestedDescriptor.authority)
    ) {
      retireToBlockedTombstone();
      return false;
    }
    descriptor = next;
    setState(next.state);
    if (next.state === 'WAIT_FOR_USER_RETRY') {
      // The exact native click that entered the durable boundary was already
      // synchronously swallowed with known zero host action. Record that same
      // observed attempt immediately; a second fresh click is then the only
      // click that may reach the host in the normal success path.
      return requestTriggerPreparation(next);
    }
    return false;
  };

  const block = (event: SubmissionGestureEvent): void => {
    event.markAuthorityBlocked();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const handleActivation = (event: SubmissionGestureEvent): void => {
    if (disposed) return;
    if (!event.targetMatches) return;
    if (tombstoned) {
      block(event);
      return;
    }
    // While active, unrelated forms remain untouched. Any native submit control
    // associated with our exact application form but not the ruleset-declared
    // final control is synchronously denied.
    if (
      !event.exactControlMatches ||
      !event.trusted ||
      !event.activeUserGesture ||
      descriptor.mode !== 'ACTIVE' ||
      !checkStillAuthorized()
    ) {
      block(event);
      return;
    }
    if (finalReviewState !== 'REVIEW_CONFIRMED') {
      block(event);
      return;
    }
    if (!reviewValuesStillCurrent()) {
      retireToBlockedTombstone();
      block(event);
      return;
    }
    if (state === 'ARMED' || state === 'BOUNDARY_PENDING') {
      // The first explicit final-control click is swallowed before any host
      // onClick/onSubmit listener. It expresses intent only; no host side effect
      // may occur until the durable boundary responds WAIT_FOR_USER_RETRY.
      block(event);
      void requestBoundary();
      return;
    }
    if (state === 'WAIT_FOR_USER_RETRY' && descriptor.state === 'WAIT_FOR_USER_RETRY') {
      const waiting = descriptor;
      // Swallow this retry as well. The worker must acknowledge that it has
      // durably moved the trigger outbox to FINAL_RETRY_PREPARED before any later
      // native event is permitted to reach host code.
      block(event);
      void requestTriggerPreparation(waiting);
      return;
    }
    if (state === 'WAIT_FOR_FINAL_RETRY' && preparedTrigger !== null) {
      const prepared = preparedTrigger;
      const reviewedSeal = reviewValueSeal;
      // Complete every synchronous target/runtime/value check before queuing a
      // durable trigger fact. If a check fails, the current native click stays
      // blocked and the known-zero-host preparation is cancelled idempotently.
      if (
        reviewedSeal === null ||
        !checkStillAuthorized() ||
        !reviewValuesStillCurrent(reviewedSeal)
      ) {
        retireToBlockedTombstone();
        block(event);
        return;
      }
      if (!sendTriggerPhase('submission-boundary/trigger-confirmed', prepared)) {
        retireToBlockedTombstone();
        block(event);
        return;
      }
      const tokenVersion = ++submitTokenVersion;
      submitToken = Object.freeze({
        element: input.target.element,
        reviewValueSeal: reviewedSeal,
      });
      setState('OUTCOME_UNKNOWN');
      preparedTrigger = null;
      requireFinalReview(true);
      deferUntilNextTask(() => {
        if (tokenVersion !== submitTokenVersion) return;
        submitToken = null;
      });
      return;
    }
    block(event);
  };

  const handleSubmit = (event: SubmissionGestureEvent): void => {
    if (disposed) return;
    const activeToken = submitToken;
    if (!event.targetMatches) {
      // Outside the brief exact final-click task, fail closed means revoking
      // T10 authority, not taking control of another form on a shared host.
      // During that one task, an alternate-form submit may be a side effect of
      // the authorized exact click and is therefore still synchronously denied.
      if (activeToken !== null) {
        retireToBlockedTombstone();
        block(event);
      }
      return;
    }
    if (tombstoned) {
      block(event);
      return;
    }
    if (
      activeToken !== null &&
      (!event.exactControlMatches ||
        !event.submitterMatches ||
        activeToken.element !== input.target.element)
    ) {
      retireToBlockedTombstone();
      block(event);
      return;
    }
    const stillAuthorized = activeToken === null
      ? false
      : checkStillAuthorized() && reviewValuesStillCurrent(activeToken.reviewValueSeal);
    if (activeToken !== null && !stillAuthorized) retireToBlockedTombstone();
    const allow =
      event.trusted &&
      event.exactControlMatches &&
      event.submitterMatches &&
      activeToken?.element === input.target.element &&
      stillAuthorized &&
      (state === 'OUTCOME_UNKNOWN' || state === 'TRIGGERED_LOCKED');
    if (!allow) {
      if (activeToken !== null) retireToBlockedTombstone();
      block(event);
      return;
    }
    submitTokenVersion += 1;
    submitToken = null;
  };

  const handle = (event: SubmissionGestureEvent): void => {
    if (event.kind === 'preactivation') {
      if (!disposed && event.targetMatches) block(event);
    } else if (event.kind === 'activation') handleActivation(event);
    else handleSubmit(event);
  };

  const removeActivationListener = input.addActivationListener?.(({ event, control, phase }) => {
    const targetMatches = control.form === input.target.form;
    handle({
      kind: phase,
      trusted: event.isTrusted,
      activeUserGesture: input.hasActiveUserGesture?.() ?? false,
      targetMatches,
      exactControlMatches: control === input.target.element,
      submitterMatches: false,
      markAuthorityBlocked: () => markSubmissionBlockedByAuthority(event),
      preventDefault: () => event.preventDefault(),
      stopImmediatePropagation: () => {
        event.stopImmediatePropagation();
        event.stopPropagation();
      },
    });
  });

  const removeSubmitListener = input.addSubmitListener?.((event) => {
    const submitter = 'submitter' in event ? (event as SubmitEvent).submitter : null;
    handle({
      kind: 'submit',
      trusted: event.isTrusted,
      activeUserGesture: input.hasActiveUserGesture?.() ?? false,
      targetMatches: event.target === input.target.form,
      exactControlMatches: submitter === input.target.element,
      submitterMatches: submitter === input.target.element,
      markAuthorityBlocked: () => markSubmissionBlockedByAuthority(event),
      preventDefault: () => event.preventDefault(),
      stopImmediatePropagation: () => {
        event.stopImmediatePropagation();
        event.stopPropagation();
      },
    });
  });
  const removeReviewInvalidationListener = input.addReviewInvalidationListener?.(() => {
    retireToBlockedTombstone();
  });

  return {
    get state() {
      return state;
    },
    get finalReviewState() {
      return finalReviewState;
    },
    canConfirmFinalReview,
    async confirmFinalReview(event, shadowRoot) {
      if (!canConfirmFinalReview() || !isTrustedShadowGesture(event, shadowRoot)) return false;
      const attemptVersion = ++reviewAttemptVersion;
      const seal = input.captureReviewValueSeal();
      if (
        seal === null ||
        disposed ||
        tombstoned ||
        attemptVersion !== reviewAttemptVersion ||
        !checkStillAuthorized() ||
        descriptor.mode !== 'ACTIVE' ||
        !['ARMED', 'BOUNDARY_PENDING', 'WAIT_FOR_USER_RETRY'].includes(state)
      ) return false;
      markFinalReviewConfirmed(seal);
      return true;
    },
    onFinalReviewStateChange(listener) {
      reviewStateListeners.add(listener);
      return () => reviewStateListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },
    revokeFinalReview,
    retireToBlockedTombstone,
    handle,
    dispose() {
      if (disposed) return;
      disposed = true;
      boundaryRequestVersion += 1;
      triggerPhaseVersion += 1;
      revokeFinalReview();
      reviewStateListeners.clear();
      stateListeners.clear();
      removeActivationListener?.();
      removeReviewInvalidationListener?.();
      removeSubmitListener?.();
    },
  };
}

/** A later task clears the exact submitter token; no timer decides submission outcome. */
export function deferUntilNextTask(callback: () => void): void {
  globalThis.setTimeout(callback, 0);
}

/** Resolve only the kernel-branded, ruleset-declared current final target. */
export function resolveFinalSubmissionTarget(
  descriptor: ApplyFormDescriptor,
): FinalSubmitControlDescriptor | null {
  const target = descriptor.finalSubmitControl ?? null;
  if (target === null) return null;
  let current = false;
  try {
    current = target.isCurrent();
  } catch {
    current = false;
  }
  if (!current || target.activation !== 'native-submit') return null;
  for (const field of descriptor.fields) {
    if (!field.element.isConnected || field.element.closest('form') !== target.form) return null;
  }
  return target;
}

/** Compatibility helper used by focused tests and callers that only need the form. */
export function resolveSubmissionFormTarget(
  descriptor: ApplyFormDescriptor,
): HTMLFormElement | null {
  return resolveFinalSubmissionTarget(descriptor)?.form ?? null;
}

function eventRoot(target: Element): Document | ShadowRoot {
  const root = target.getRootNode();
  return root instanceof ShadowRoot ? root : target.ownerDocument;
}

function nativeSubmitControlInPath(
  event: Event,
): HTMLButtonElement | HTMLInputElement | null {
  let path: EventTarget[];
  try {
    path = event.composedPath();
  } catch {
    return null;
  }
  for (const candidate of path) {
    if (!(candidate instanceof Element)) continue;
    if (candidate.localName === 'button') {
      const button = candidate as HTMLButtonElement;
      if (button.type === 'submit') return button;
    } else if (candidate.localName === 'input') {
      const input = candidate as HTMLInputElement;
      if (input.type === 'submit' || input.type === 'image') return input;
    }
  }
  return null;
}

/**
 * Install at document_start, before verified authority exists. While unbound it
 * is completely inert: no selector, target, path, or DOM read occurs. Later
 * bindings carry only the kernel's exact selector-free element/form identity.
 * Generation-checked cleanup prevents an old gate from unbinding its atomic
 * replacement.
 */
export function installEarlySubmissionCaptureBroker(
  ownerWindow: Window = window,
  ownerDocument: Document = document,
): EarlySubmissionCaptureBroker {
  void ownerDocument;
  let activationBinding: Readonly<{
    token: object;
    target: FinalSubmitControlDescriptor;
    listener: (activation: NativeActivation) => void;
  }> | null = null;
  let submitBinding: Readonly<{
    token: object;
    target: FinalSubmitControlDescriptor;
    listener: (event: Event) => void;
  }> | null = null;
  let disposed = false;

  const onActivation = (event: Event) => {
    const binding = activationBinding;
    if (disposed || binding === null) return;
    if (
      event instanceof KeyboardEvent &&
      event.key !== 'Enter' &&
      event.key !== ' ' &&
      event.key !== 'Spacebar'
    ) return;
    const control = nativeSubmitControlInPath(event);
    if (control === null) return;
    binding.listener({
      event,
      control,
      phase: event.type === 'click' ? 'activation' : 'preactivation',
    });
  };
  const onSubmit = (event: Event) => {
    const binding = submitBinding;
    if (disposed || binding === null || event.type !== 'submit') return;
    binding.listener(event);
  };

  // The production target is enforced to be light DOM. A single earliest
  // window capture listener therefore covers the full path without needing a
  // permanent Event-identity dedupe set. DOM permits the same Event object to
  // be dispatched again after dispatch completes; every dispatch must pass the
  // blocker independently.
  const activationEventTypes = [
    'pointerdown', 'mousedown', 'pointerup', 'mouseup',
    'touchend', 'keydown', 'keypress', 'keyup', 'click',
  ] as const;
  const captureOptions = Object.freeze({ capture: true, passive: false });
  for (const type of activationEventTypes) {
    ownerWindow.addEventListener(type, onActivation, captureOptions);
  }
  ownerWindow.addEventListener('submit', onSubmit, true);
  /**
   * touchstart 等第一次绑上目标才装（2026-10-03 全网注入实测）。
   *
   * broker 在每一个页面的 document_start 就装；window 上一个非 passive 的 touchstart 监听让整页退出 Chrome 的
   * 「触摸滚动不等主线程」——Chrome 的 scroll-blocking 事件只有 touchstart、touchmove、wheel、mousewheel。
   * （同日用 CDP LayerTree 实测：非 passive 的 touchstart 给页面加上合成器的 TouchEventHandler 区，touchend 不加。）
   * 没绑目标时 onActivation 什么都不做，那个代价白付。闸门要 preventDefault（预激活一律挡），所以不能改成 passive。
   *
   * 绑上之后与别的预激活事件同一个监听、同一套判断，一直留到 dispose（原子替换、再次武装都不重装、不改顺序）。
   * 代价只有一处：绑上之前就挂在 window 捕获阶段的宿主 touchstart 监听会先看到那一下 touchstart。闸门照旧
   * preventDefault、停止传播；轻触生成的 click 由 touchend 的 preventDefault 压住，而 touchend 不挡滚动，照旧在
   * document_start 装、照旧排在所有宿主监听前面。
   */
  let touchStartInstalled = false;

  return Object.freeze({
    addActivationListener(
      target: FinalSubmitControlDescriptor,
      listener: (activation: NativeActivation) => void,
    ) {
      const token = Object.freeze({});
      activationBinding = Object.freeze({ token, target, listener });
      if (!touchStartInstalled && !disposed) {
        touchStartInstalled = true;
        ownerWindow.addEventListener('touchstart', onActivation, captureOptions);
      }
      return () => {
        if (activationBinding?.token === token) activationBinding = null;
      };
    },
    addSubmitListener(
      target: FinalSubmitControlDescriptor,
      listener: (event: Event) => void,
    ) {
      const token = Object.freeze({});
      submitBinding = Object.freeze({ token, target, listener });
      return () => {
        if (submitBinding?.token === token) submitBinding = null;
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activationBinding = null;
      submitBinding = null;
      for (const type of activationEventTypes) {
        ownerWindow.removeEventListener(type, onActivation, captureOptions);
      }
      if (touchStartInstalled) ownerWindow.removeEventListener('touchstart', onActivation, captureOptions);
      ownerWindow.removeEventListener('submit', onSubmit, true);
    },
  });
}

/**
 * Window capture runs before document/form host handlers on ordinary ATS pages.
 * Root/form fallbacks retain non-composed and closed-root coverage. The helper
 * recognizes only platform-native submit controls; vendor final authority
 * remains the selector-free exact element supplied by the kernel.
 */
export function addNativeSubmissionActivationListener(
  target: FinalSubmitControlDescriptor,
  listener: (activation: NativeActivation) => void,
): () => void {
  const exactListener = (event: Event) => {
    if (
      event instanceof KeyboardEvent &&
      event.key !== 'Enter' &&
      event.key !== ' ' &&
      event.key !== 'Spacebar'
    ) return;
    const control = nativeSubmitControlInPath(event);
    if (control === null) return;
    listener({
      event,
      control,
      phase: event.type === 'click' ? 'activation' : 'preactivation',
    });
  };
  const ownerDocument = target.element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const root = eventRoot(target.element);
  const captureTarget: EventTarget = ownerWindow ?? root;
  const activationEventTypes = [
    'pointerdown', 'mousedown', 'pointerup', 'mouseup',
    'touchstart', 'touchend', 'keydown', 'keypress', 'keyup', 'click',
  ] as const;
  const captureOptions = Object.freeze({ capture: true, passive: false });
  for (const type of activationEventTypes) {
    captureTarget.addEventListener(type, exactListener, captureOptions);
  }
  return () => {
    for (const type of activationEventTypes) {
      captureTarget.removeEventListener(type, exactListener, captureOptions);
    }
  };
}

/**
 * A tombstoned gate sees every document submit, including a replaced form. The
 * exact-form/root listeners preserve coverage for non-composed shadow events.
 */
export function addSubmissionEventListener(
  target: FinalSubmitControlDescriptor,
  listener: (event: Event) => void,
): () => void {
  const exactListener = (event: Event) => listener(event);
  const ownerDocument = target.element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const root = eventRoot(target.element);
  const captureTarget: EventTarget = root === ownerDocument
    ? ownerWindow ?? ownerDocument
    : root;
  captureTarget.addEventListener('submit', exactListener, true);
  return () => {
    captureTarget.removeEventListener('submit', exactListener, true);
  };
}

function hasEditableContentAttribute(element: Element): boolean {
  const value = element.getAttribute('contenteditable')?.trim().toLowerCase();
  return value === '' || value === 'true' || value === 'plaintext-only';
}

function eventBelongsToExactForm(event: Event, targetForm: HTMLFormElement): boolean {
  if (event.type === 'reset') return event.target === targetForm;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement
  ) return target.form === targetForm;
  const editable = target.closest('[contenteditable]');
  return editable !== null && targetForm.contains(editable) && hasEditableContentAttribute(editable);
}

/** reset/input/change invalidate the immutable audit before the next click. */
export function addExactReviewInvalidationListener(
  targetForm: HTMLFormElement,
  listener: () => void,
): () => void {
  const exactListener = (event: Event) => {
    if (!eventBelongsToExactForm(event, targetForm)) return;
    listener();
  };
  const ownerDocument = targetForm.ownerDocument;
  const root = eventRoot(targetForm);
  const captureTarget: EventTarget = root === ownerDocument ? ownerDocument : root;
  captureTarget.addEventListener('input', exactListener, true);
  captureTarget.addEventListener('change', exactListener, true);
  captureTarget.addEventListener('reset', exactListener, true);
  return () => {
    captureTarget.removeEventListener('input', exactListener, true);
    captureTarget.removeEventListener('change', exactListener, true);
    captureTarget.removeEventListener('reset', exactListener, true);
  };
}

interface ControlValueSnapshot {
  readonly element: Element;
  readonly state: readonly unknown[];
}

function captureControlState(element: Element): readonly unknown[] | null {
  if (element instanceof HTMLInputElement) {
    return [
      'input', element.form, element.getAttribute('form'), element.type, element.name,
      element.value, element.checked,
      element.indeterminate, element.disabled, element.readOnly, element.required,
      ...(element.files ? [...element.files] : []),
    ];
  }
  if (element instanceof HTMLTextAreaElement) {
    return [
      'textarea', element.form, element.getAttribute('form'), element.name, element.value,
      element.disabled, element.readOnly, element.required,
    ];
  }
  if (element instanceof HTMLSelectElement) {
    return [
      'select', element.form, element.getAttribute('form'), element.name, element.disabled,
      element.required, element.multiple,
      ...[...element.options].flatMap((option) => [option, option.selected, option.value, option.disabled]),
    ];
  }
  if (element instanceof HTMLElement && hasEditableContentAttribute(element)) {
    return [
      'contenteditable', element.getAttribute('contenteditable'), element.textContent,
    ];
  }
  if ('form' in element) {
    const associated = element as Element & { form: HTMLFormElement | null };
    return [
      'associated', element.localName, associated.form, element.getAttribute('form'),
      element.getAttribute('name'), element.getAttribute('disabled'),
    ];
  }
  return ['element', element.localName];
}

function sameUnknownList(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

/**
 * Local-only whole-form seal. Values never leave this closure, logs, receipts,
 * or telemetry; final-control capture rechecks it synchronously before host code.
 */
export function captureExactFormValueSeal(form: HTMLFormElement): ReviewValueSeal | null {
  if (!form.isConnected) return null;
  const collectElements = (): Element[] | null => {
    const elements: Element[] = [];
    const seen = new Set<Element>();
    for (const element of Array.from(form.elements)) {
      if (!(element instanceof Element) || seen.has(element)) return null;
      seen.add(element);
      elements.push(element);
    }
    for (const element of form.querySelectorAll('[contenteditable]')) {
      if (!hasEditableContentAttribute(element) || seen.has(element)) continue;
      seen.add(element);
      elements.push(element);
    }
    return elements;
  };
  const elements = collectElements();
  if (elements === null) return null;
  const snapshots: ControlValueSnapshot[] = [];
  for (const element of elements) {
    const state = captureControlState(element);
    if (state === null) return null;
    snapshots.push({ element, state });
  }
  return Object.freeze({
    isCurrent: () => {
      if (!form.isConnected) return false;
      const live = collectElements();
      if (live === null) return false;
      if (live.length !== snapshots.length) return false;
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index]!;
        if (live[index] !== snapshot.element) return false;
        const state = captureControlState(snapshot.element);
        if (state === null || !sameUnknownList(state, snapshot.state)) return false;
      }
      return true;
    },
  });
}
