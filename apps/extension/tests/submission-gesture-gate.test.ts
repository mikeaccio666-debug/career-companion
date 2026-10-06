// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApplyFormDescriptor,
  FinalSubmitControlDescriptor,
} from '@edaix/apply-kernel/contracts';
import {
  addExactReviewInvalidationListener,
  addNativeSubmissionActivationListener,
  addSubmissionEventListener,
  captureExactFormValueSeal,
  createSubmissionGestureGate,
  deferUntilNextTask,
  installEarlySubmissionCaptureBroker,
  resolveFinalSubmissionTarget,
  resolveSubmissionFormTarget,
  type ReviewValueSeal,
  type SubmissionGestureEvent,
} from '../lib/submissionGestureGate';
import type { SubmissionArmDescriptor, SubmissionAuthority } from '../lib/submissionBoundaryProtocol';

const AUTHORITY: SubmissionAuthority = {
  missionId: '10000000-0000-4000-8000-000000000001',
  expectedMissionRevision: '9',
  missionStepId: '10000000-0000-4000-8000-000000000002',
  stepAttempt: 1,
  applicationId: '10000000-0000-4000-8000-000000000003',
  expectedApplicationRevision: '7',
  applicationBundleVersion: '3',
};
const ARMED = {
  mode: 'ACTIVE',
  bindingId: '10000000-0000-4000-8000-000000000010',
  authority: AUTHORITY,
  expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
  state: 'ARMED',
} satisfies SubmissionArmDescriptor;
const WAITING = {
  ...ARMED,
  state: 'WAIT_FOR_USER_RETRY',
  triggerClientRequestId: '10000000-0000-4000-8000-000000000011',
} satisfies SubmissionArmDescriptor;
const WAITING_FOR_FINAL_RETRY = {
  ...WAITING,
  state: 'WAIT_FOR_FINAL_RETRY' as const,
} as unknown as SubmissionArmDescriptor;

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountTarget(): {
  form: HTMLFormElement;
  field: HTMLInputElement;
  control: HTMLButtonElement;
  other: HTMLButtonElement;
  target: FinalSubmitControlDescriptor;
} {
  document.body.innerHTML = `
    <form id="application">
      <input id="name" name="name" value="Ada" />
      <button id="save" type="submit">Save draft</button>
      <button id="final" type="submit">Submit application</button>
    </form>`;
  const form = document.querySelector<HTMLFormElement>('#application')!;
  const field = document.querySelector<HTMLInputElement>('#name')!;
  const control = document.querySelector<HTMLButtonElement>('#final')!;
  const other = document.querySelector<HTMLButtonElement>('#save')!;
  const target: FinalSubmitControlDescriptor = {
    activation: 'native-submit',
    element: control,
    form,
    isCurrent: () =>
      control.isConnected && control.form === form && control.type === 'submit' && !control.disabled,
  };
  return { form, field, control, other, target };
}

function gesture(
  kind: 'activation' | 'submit',
  input: Partial<Omit<SubmissionGestureEvent, 'kind' | 'preventDefault' | 'stopImmediatePropagation'>> = {},
) {
  const preventDefault = vi.fn();
  const stopImmediatePropagation = vi.fn();
  const markAuthorityBlocked = vi.fn();
  const value: SubmissionGestureEvent = {
    kind,
    trusted: input.trusted ?? true,
    activeUserGesture: input.activeUserGesture ?? true,
    targetMatches: input.targetMatches ?? true,
    exactControlMatches: input.exactControlMatches ?? true,
    submitterMatches: input.submitterMatches ?? (kind === 'submit'),
    markAuthorityBlocked,
    preventDefault,
    stopImmediatePropagation,
  };
  return { value, markAuthorityBlocked, preventDefault, stopImmediatePropagation };
}

function trustedReview(input: { trusted?: boolean; foreign?: boolean } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  root.append(button);
  const event = new MouseEvent('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: input.trusted ?? true });
  Object.defineProperty(event, 'composedPath', {
    value: () => input.foreign ? [document.body, document, window] : [button, root, host],
  });
  return { event, root };
}

function currentSeal(): ReviewValueSeal {
  return { isCurrent: () => true };
}

function gateInput(
  descriptor: SubmissionArmDescriptor,
  overrides: Partial<Parameters<typeof createSubmissionGestureGate>[0]> = {},
) {
  const mounted = mountTarget();
  const sendMessage = vi.fn(async (message: { kind: string }) => {
    if (message.kind === 'submission-boundary/enter') return WAITING;
    if (message.kind === 'submission-boundary/trigger-observed') return WAITING_FOR_FINAL_RETRY;
    if (message.kind === 'submission-boundary/trigger-cancelled') return WAITING;
    if (message.kind === 'submission-boundary/trigger-confirmed') {
      return { ...ARMED, state: 'TRIGGERED_LOCKED' as const };
    }
    return { ...ARMED, state: 'OUTCOME_UNKNOWN' as const };
  });
  return {
    mounted,
    sendMessage,
    gate: createSubmissionGestureGate({
      descriptor,
      target: mounted.target,
      sendMessage,
      isStillAuthorized: () => true,
      captureReviewValueSeal: currentSeal,
      ...overrides,
    }),
  };
}

async function confirm(gate: ReturnType<typeof createSubmissionGestureGate>): Promise<void> {
  const review = trustedReview();
  await expect(gate.confirmFinalReview(review.event, review.root)).resolves.toBe(true);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function authorizeNativeRetry(
  gate: ReturnType<typeof createSubmissionGestureGate>,
): Promise<ReturnType<typeof gesture>> {
  const preparation = gesture('activation');
  gate.handle(preparation.value);
  expect(preparation.preventDefault).toHaveBeenCalledOnce();
  await flush();
  const retry = gesture('activation');
  gate.handle(retry.value);
  return retry;
}

describe('AF-041 exact final target authority', () => {
  it('resolves only the kernel-branded current control and exact field form', () => {
    const { form, field, target } = mountTarget();
    const descriptor = {
      vendor: 'greenhouse',
      root: {},
      fields: [{ element: field }],
      finalSubmitControl: target,
    } as unknown as ApplyFormDescriptor;
    expect(resolveFinalSubmissionTarget(descriptor)).toBe(target);
    expect(resolveSubmissionFormTarget(descriptor)).toBe(form);

    const missing = { ...descriptor, finalSubmitControl: null };
    expect(resolveFinalSubmissionTarget(missing)).toBeNull();
    target.element.disabled = true;
    expect(resolveFinalSubmissionTarget(descriptor)).toBeNull();
  });

  it('requires a trusted closed-shadow review and captures no boundary at review time', async () => {
    const { gate, sendMessage } = gateInput(ARMED);
    const synthetic = trustedReview({ trusted: false });
    await expect(gate.confirmFinalReview(synthetic.event, synthetic.root)).resolves.toBe(false);
    const foreign = trustedReview({ foreign: true });
    await expect(gate.confirmFinalReview(foreign.event, foreign.root)).resolves.toBe(false);

    await confirm(gate);
    expect(gate.finalReviewState).toBe('REVIEW_CONFIRMED');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('swallows the first exact click synchronously before host handlers, then enters boundary', async () => {
    const { gate, sendMessage } = gateInput(ARMED);
    await confirm(gate);
    const first = gesture('activation');

    gate.handle(first.value);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(first.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'submission-boundary/enter',
    }));
    await flush();
    expect(sendMessage.mock.calls.map(([message]) => message.kind)).toEqual([
      'submission-boundary/enter',
      'submission-boundary/trigger-observed',
    ]);
    expect(gate.state).toBe('WAIT_FOR_FINAL_RETRY');
  });

  it('requires a durable observed ack before a separate exact native retry', async () => {
    const { gate, sendMessage } = gateInput(WAITING);
    await confirm(gate);
    const preparation = gesture('activation');

    gate.handle(preparation.value);

    expect(preparation.preventDefault).toHaveBeenCalledOnce();
    expect(preparation.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.map(([message]) => message.kind)).toEqual([
      'submission-boundary/trigger-observed',
    ]);
    await flush();
    expect(gate.state).toBe('WAIT_FOR_FINAL_RETRY');
    expect(gate.finalReviewState).toBe('REVIEW_CONFIRMED');

    const retry = gesture('activation');
    gate.handle(retry.value);
    expect(retry.preventDefault).not.toHaveBeenCalled();
    expect(retry.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map(([message]) => message.kind)).toEqual([
      'submission-boundary/trigger-observed',
      'submission-boundary/trigger-confirmed',
    ]);
    expect(gate.state).toBe('OUTCOME_UNKNOWN');
    expect(gate.finalReviewState).toBe('REVIEW_REQUIRED');
  });

  it('cancels a prepared retry and never confirms when the final synchronous authority recheck fails', async () => {
    let authorized = true;
    const { gate, sendMessage } = gateInput(WAITING, {
      isStillAuthorized: () => authorized,
    });
    await confirm(gate);
    gate.handle(gesture('activation').value);
    await flush();
    expect(gate.state).toBe('WAIT_FOR_FINAL_RETRY');

    authorized = false;
    const retry = gesture('activation');
    gate.handle(retry.value);
    await flush();

    expect(retry.preventDefault).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.map(([message]) => message.kind)).toEqual([
      'submission-boundary/trigger-observed',
      'submission-boundary/trigger-cancelled',
    ]);
    expect(gate.state).toBe('BLOCKED');
  });

  it('binds the one submit event to the exact clicked submitter and denies other/null/reuse', async () => {
    const { gate } = gateInput(WAITING);
    await confirm(gate);
    await authorizeNativeRetry(gate);

    const other = gesture('submit', { exactControlMatches: false, submitterMatches: false });
    gate.handle(other.value);
    expect(other.preventDefault).toHaveBeenCalledOnce();
    expect(other.stopImmediatePropagation).toHaveBeenCalledOnce();

    // Recreate the one-shot token with a fresh reviewed generation.
    const fresh = gateInput(WAITING).gate;
    await confirm(fresh);
    await authorizeNativeRetry(fresh);
    const exact = gesture('submit');
    fresh.handle(exact.value);
    expect(exact.preventDefault).not.toHaveBeenCalled();

    const reused = gesture('submit');
    fresh.handle(reused.value);
    expect(reused.preventDefault).toHaveBeenCalledOnce();
  });

  it('blocks synthetic/programmatic activation and an alternate submit control on the same form', async () => {
    const { gate, sendMessage } = gateInput(WAITING);
    await confirm(gate);
    for (const attempt of [
      gesture('activation', { trusted: false }),
      gesture('activation', { activeUserGesture: false }),
      gesture('activation', { exactControlMatches: false }),
    ]) {
      gate.handle(attempt.value);
      expect(attempt.preventDefault).toHaveBeenCalledOnce();
      expect(attempt.stopImmediatePropagation).toHaveBeenCalledOnce();
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the grant lease reaches its exact expiry boundary', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    vi.setSystemTime(now);
    const { gate, sendMessage } = gateInput({ ...ARMED, expiresAtMs: now + 1_000 });
    await confirm(gate);
    vi.setSystemTime(now + 1_000);
    const attempt = gesture('activation');
    gate.handle(attempt.value);
    expect(attempt.preventDefault).toHaveBeenCalledOnce();
    expect(gate.state).toBe('BLOCKED');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not interfere with an unrelated form while active', async () => {
    const { gate, sendMessage } = gateInput(WAITING);
    await confirm(gate);
    const unrelated = gesture('activation', {
      targetMatches: false,
      exactControlMatches: false,
    });
    gate.handle(unrelated.value);
    expect(unrelated.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('tombstones on silent value drift without taking over an unrelated shared-host form', async () => {
    let valuesCurrent = true;
    const { gate } = gateInput(WAITING, {
      captureReviewValueSeal: () => ({ isCurrent: () => valuesCurrent }),
    });
    await confirm(gate);
    valuesCurrent = false;
    const activation = gesture('activation');
    gate.handle(activation.value);
    expect(activation.preventDefault).toHaveBeenCalledOnce();
    expect(gate.state).toBe('BLOCKED');

    const replacedFormSubmit = gesture('submit', { targetMatches: false });
    gate.handle(replacedFormSubmit.value);
    expect(replacedFormSubmit.preventDefault).not.toHaveBeenCalled();
    expect(replacedFormSubmit.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('rejects a boundary response bound to a different authority', async () => {
    const otherAuthority = {
      ...AUTHORITY,
      applicationId: '10000000-0000-4000-8000-000000000099',
    } satisfies SubmissionAuthority;
    const { gate } = gateInput(ARMED, {
      sendMessage: vi.fn(async () => ({ ...WAITING, authority: otherAuthority })),
    });
    await confirm(gate);
    gate.handle(gesture('activation').value);
    await flush();
    expect(gate.state).toBe('BLOCKED');
  });

  it('rejects a prepared response with a different trigger request identity', async () => {
    const { gate } = gateInput(WAITING, {
      sendMessage: vi.fn(async () => ({
        ...WAITING_FOR_FINAL_RETRY,
        triggerClientRequestId: '10000000-0000-4000-8000-000000000099',
      })),
    });
    await confirm(gate);
    gate.handle(gesture('activation').value);
    await flush();
    expect(gate.state).toBe('BLOCKED');
  });

  it('rejects a trigger-confirmed response bound to a different authority', async () => {
    const otherAuthority = {
      ...AUTHORITY,
      missionStepId: '10000000-0000-4000-8000-000000000099',
    } satisfies SubmissionAuthority;
    const { gate } = gateInput(WAITING, {
      sendMessage: vi.fn(async (message: { kind: string }) =>
        message.kind === 'submission-boundary/trigger-observed'
          ? WAITING_FOR_FINAL_RETRY
          : { ...ARMED, authority: otherAuthority, state: 'TRIGGERED_LOCKED' as const }),
    });
    await confirm(gate);
    await authorizeNativeRetry(gate);
    await flush();
    expect(gate.state).toBe('OUTCOME_UNKNOWN');
  });

  it('rechecks the reviewed value seal between the accepted click and submit capture', async () => {
    let valuesCurrent = true;
    const { gate } = gateInput(WAITING, {
      captureReviewValueSeal: () => ({ isCurrent: () => valuesCurrent }),
    });
    await confirm(gate);
    await authorizeNativeRetry(gate);

    // A host click handler can mutate state synchronously before the browser
    // dispatches submit. The one-shot token must retain and recheck the seal.
    valuesCurrent = false;
    const submit = gesture('submit');
    gate.handle(submit.value);

    expect(submit.preventDefault).toHaveBeenCalledOnce();
    expect(submit.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(gate.state).toBe('BLOCKED');
  });

  it('rechecks runtime and exact-target authority between activation and submit', async () => {
    let authorized = true;
    let targetCurrent = true;
    const mounted = mountTarget();
    const sendMessage = vi.fn(async (message: { kind: string }) =>
      message.kind === 'submission-boundary/trigger-confirmed'
        ? { ...ARMED, state: 'TRIGGERED_LOCKED' as const }
        : { ...ARMED, state: 'OUTCOME_UNKNOWN' as const });
    const gate = createSubmissionGestureGate({
      descriptor: WAITING,
      target: { ...mounted.target, isCurrent: () => targetCurrent },
      sendMessage,
      isStillAuthorized: () => authorized,
      captureReviewValueSeal: currentSeal,
    });
    await confirm(gate);
    await authorizeNativeRetry(gate);

    authorized = false;
    targetCurrent = false;
    const submit = gesture('submit');
    gate.handle(submit.value);

    expect(submit.preventDefault).toHaveBeenCalledOnce();
    expect(submit.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(gate.state).toBe('BLOCKED');
  });

  it('keeps the current native click blocked when durable trigger preparation is ambiguous', async () => {
    const { gate } = gateInput(WAITING, {
      sendMessage: vi.fn(() => Promise.reject(new Error('worker unavailable'))),
    });
    await confirm(gate);
    const attempt = gesture('activation');
    gate.handle(attempt.value);
    expect(attempt.preventDefault).toHaveBeenCalledOnce();
    expect(attempt.stopImmediatePropagation).toHaveBeenCalledOnce();
    await flush();
    expect(gate.state).toBe('BLOCKED');
  });

  it('keeps a response-lost boundary blocked and permits only a later explicit replay', async () => {
    const enterResponses: SubmissionArmDescriptor[] = [
      { ...ARMED, state: 'BOUNDARY_PENDING' },
      WAITING,
    ];
    const mounted = mountTarget();
    const sendMessage = vi.fn(async (message: { kind: string }) =>
      message.kind === 'submission-boundary/enter'
        ? enterResponses.shift() ?? WAITING
        : WAITING_FOR_FINAL_RETRY);
    const gate = createSubmissionGestureGate({
      descriptor: ARMED,
      target: mounted.target,
      sendMessage,
      isStillAuthorized: () => true,
      captureReviewValueSeal: currentSeal,
    });
    await confirm(gate);
    const first = gesture('activation');
    gate.handle(first.value);
    await flush();
    expect(gate.state).toBe('BOUNDARY_PENDING');
    const replay = gesture('activation');
    gate.handle(replay.value);
    await flush();
    expect(replay.preventDefault).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(gate.state).toBe('WAIT_FOR_FINAL_RETRY');
  });
});

describe('production capture helpers and value seal', () => {
  function trustedClick(target: Element): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    target.dispatchEvent(event);
    return event;
  }

  it('captures native activation at window before later document host handlers', () => {
    const { control, target } = mountTarget();
    const order: string[] = [];
    const remove = addNativeSubmissionActivationListener(target, ({ event }) => {
      order.push('gate');
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    document.addEventListener('click', () => order.push('host'), true);
    trustedClick(control);
    expect(order).toEqual(['gate']);
    remove();
  });

  it('preinstalls an inert broker before host capture and activates it without reordering', () => {
    const { control, target } = mountTarget();
    const order: string[] = [];
    const broker = installEarlySubmissionCaptureBroker(window, document);
    const host = () => order.push('host');
    window.addEventListener('click', host, true);
    const remove = broker.addActivationListener(target, ({ event }) => {
      order.push('gate');
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    trustedClick(control);
    expect(order).toEqual(['gate']);
    remove();
    broker.dispose();
    window.removeEventListener('click', host, true);
  });

  // touchstart 不在这张表里：它等第一次绑上目标才装（见下一条）。绑之前就挂在 window 捕获阶段的宿主 touchstart
  // 监听会先看到那一下 touchstart——这是有意的取舍（不让每一个网页都退出「触摸滚动不等主线程」）；轻触生成的
  // click 由 touchend 的 preventDefault 压住，touchend 照旧在 document_start 装、照旧排在宿主前面。
  it.each(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchend', 'keydown', 'keyup'])(
    'captures %s on the exact final control before a host predecessor listener can submit',
    (type) => {
      const { control, target } = mountTarget();
      const broker = installEarlySubmissionCaptureBroker(window, document);
      const order: string[] = [];
      const host = () => order.push('host');
      window.addEventListener(type, host, true);
      const remove = broker.addActivationListener(target, ({ event }) => {
        order.push('gate');
        event.preventDefault();
        event.stopImmediatePropagation();
      });
      const event = type.startsWith('key')
        ? new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true })
        : new Event(type, { bubbles: true, cancelable: true, composed: true });
      control.dispatchEvent(event);
      expect(order).toEqual(['gate']);
      expect(event.defaultPrevented).toBe(true);
      remove();
      broker.dispose();
      window.removeEventListener(type, host, true);
    },
  );

  // 2026-10-03 全网注入实测：broker 在每一个页面的 document_start 就装，window 上一个非 passive 的 touchstart
  // 监听让整页退出 Chrome 的「触摸滚动不等主线程」（scroll-blocking 事件只有 touchstart、touchmove、wheel、mousewheel）。
  // 没绑目标时它什么都不做，所以等第一次绑上目标才装；绑上之后与别的预激活事件一样被闸门挡住。
  it('adds no scroll-blocking touchstart listener until a target is bound, then blocks it on the exact control', () => {
    const { control, target } = mountTarget();
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const host = vi.fn();
    // 只数 broker 自己的那一个（宿主自己的 touchstart 监听不算）。
    const touchStarts = (spy: typeof added | typeof removed) =>
      spy.mock.calls.filter(([type, listener]) => type === 'touchstart' && listener !== host);
    const broker = installEarlySubmissionCaptureBroker(window, document);
    try {
      expect(touchStarts(added), 'unbound: no touchstart listener on the page at all').toEqual([]);
      expect(added.mock.calls.map(([type]) => type), 'every other capture listener is still installed up front')
        .toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchend', 'keydown', 'keypress', 'keyup', 'click', 'submit']);

      const block = ({ event }: { event: Event }) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const removeFirst = broker.addActivationListener(target, block);
      expect(touchStarts(added)).toEqual([['touchstart', expect.any(Function), { capture: true, passive: false }]]);
      window.addEventListener('touchstart', host, true);
      const event = new Event('touchstart', { bubbles: true, cancelable: true, composed: true });
      control.dispatchEvent(event);
      expect(event.defaultPrevented, 'bound: a touchstart on the exact control is blocked').toBe(true);
      expect(host).not.toHaveBeenCalled();

      // 原子替换（新闸门先绑、旧闸门后解）不再装第二个。
      const removeSecond = broker.addActivationListener(target, block);
      removeFirst();
      expect(touchStarts(added)).toHaveLength(1);
      removeSecond();
      broker.dispose();
      expect(touchStarts(removed)).toEqual([['touchstart', expect.any(Function), { capture: true, passive: false }]]);
    } finally {
      broker.dispose();
      window.removeEventListener('touchstart', host, true);
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it('blocks every dispatch when a page reuses the same click Event object', () => {
    const { control, target } = mountTarget();
    const broker = installEarlySubmissionCaptureBroker(window, document);
    const host = vi.fn();
    const gate = vi.fn(({ event }: { event: Event }) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    window.addEventListener('click', host, true);
    const remove = broker.addActivationListener(target, gate);
    const reused = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });

    control.dispatchEvent(reused);
    control.dispatchEvent(reused);

    expect(gate).toHaveBeenCalledTimes(2);
    expect(host).not.toHaveBeenCalled();
    remove();
    broker.dispose();
    window.removeEventListener('click', host, true);
  });

  it('keeps an atomic replacement bound when the retired gate cleans itself up', () => {
    const { control, target } = mountTarget();
    const broker = installEarlySubmissionCaptureBroker(window, document);
    const first = vi.fn();
    const second = vi.fn(({ event }: { event: Event }) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    const removeFirst = broker.addActivationListener(target, first);
    const removeSecond = broker.addActivationListener(target, second);
    removeFirst();
    trustedClick(control);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    removeSecond();
    broker.dispose();
  });

  it('preinstalls inert submit capture and blocks host submit only after exact binding', () => {
    const { form, target } = mountTarget();
    const order: string[] = [];
    const broker = installEarlySubmissionCaptureBroker(window, document);
    const host = () => order.push('host');
    window.addEventListener('submit', host, true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(order).toEqual(['host']);

    const remove = broker.addSubmitListener(target, (event) => {
      order.push('gate');
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(order).toEqual(['host', 'gate']);
    remove();
    broker.dispose();
    window.removeEventListener('submit', host, true);
  });

  it('blocks every dispatch when a page reuses the same submit Event object', () => {
    const { form, target } = mountTarget();
    const broker = installEarlySubmissionCaptureBroker(window, document);
    const host = vi.fn();
    const gate = vi.fn((event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    window.addEventListener('submit', host, true);
    const remove = broker.addSubmitListener(target, gate);
    const reused = new Event('submit', { bubbles: true, cancelable: true });

    form.dispatchEvent(reused);
    form.dispatchEvent(reused);

    expect(gate).toHaveBeenCalledTimes(2);
    expect(host).not.toHaveBeenCalled();
    remove();
    broker.dispose();
    window.removeEventListener('submit', host, true);
  });

  it('sees non-composed exact-form submit and document-level replaced-form submit', () => {
    const { form, target } = mountTarget();
    const listener = vi.fn((event: Event) => event.preventDefault());
    const remove = addSubmissionEventListener(target, listener);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: false }));
    const replacement = document.createElement('form');
    document.body.append(replacement);
    replacement.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(listener).toHaveBeenCalledTimes(2);
    remove();
  });

  it('revokes on input/change/reset, including native form reset', () => {
    const { form, field } = mountTarget();
    const listener = vi.fn();
    const remove = addExactReviewInvalidationListener(form, listener);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    form.dispatchEvent(new Event('reset', { bubbles: true }));
    expect(listener).toHaveBeenCalledTimes(3);
    remove();
  });

  it('revokes for an external native control associated with the exact form only', () => {
    const { form } = mountTarget();
    const external = document.createElement('input');
    external.setAttribute('form', form.id);
    const unrelated = document.createElement('input');
    document.body.append(external, unrelated);
    const listener = vi.fn();
    const remove = addExactReviewInvalidationListener(form, listener);
    unrelated.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    external.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(listener).toHaveBeenCalledOnce();
    remove();
  });

  it('detects silent value/checked/selectedIndex/structure drift without logging values', () => {
    const { form, field } = mountTarget();
    form.insertAdjacentHTML('beforeend', `
      <input id="choice" type="checkbox" checked />
      <select id="country"><option>US</option><option>CA</option></select>`);
    const seal = captureExactFormValueSeal(form)!;
    expect(seal.isCurrent()).toBe(true);
    field.value = 'Changed silently';
    expect(seal.isCurrent()).toBe(false);

    field.value = 'Ada';
    const second = captureExactFormValueSeal(form)!;
    (form.querySelector('#choice') as HTMLInputElement).checked = false;
    expect(second.isCurrent()).toBe(false);

    const third = captureExactFormValueSeal(form)!;
    (form.querySelector('#country') as HTMLSelectElement).selectedIndex = 1;
    expect(third.isCurrent()).toBe(false);

    (form.querySelector('#country') as HTMLSelectElement).selectedIndex = 0;
    const other = document.createElement('form');
    other.id = 'other-form';
    document.body.append(other);
    const fourth = captureExactFormValueSeal(form)!;
    field.setAttribute('form', other.id);
    expect(fourth.isCurrent()).toBe(false);
  });

  it('seals external form-associated controls and all editable attribute spellings', () => {
    const { form } = mountTarget();
    const external = document.createElement('input');
    external.name = 'external-answer';
    external.value = 'reviewed';
    external.setAttribute('form', form.id);
    const rich = document.createElement('div');
    rich.setAttribute('contenteditable', 'plaintext-only');
    rich.textContent = 'reviewed note';
    form.append(rich);
    document.body.append(external);

    const seal = captureExactFormValueSeal(form)!;
    expect(seal.isCurrent()).toBe(true);
    external.value = 'changed silently';
    expect(seal.isCurrent()).toBe(false);

    external.value = 'reviewed';
    const second = captureExactFormValueSeal(form)!;
    rich.textContent = 'changed silently';
    expect(second.isCurrent()).toBe(false);
  });

  it('crosses a task boundary only to expire a submitter token', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    deferUntilNextTask(callback);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(callback).toHaveBeenCalledOnce();
  });
});
