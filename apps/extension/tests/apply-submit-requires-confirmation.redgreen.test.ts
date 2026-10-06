// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createSubmissionGestureGate, type SubmissionGestureEvent } from '../lib/submissionGestureGate';
import type { SubmissionArmDescriptor, SubmissionAuthority } from '../lib/submissionBoundaryProtocol';

const AUTHORITY: SubmissionAuthority = {
  missionId: '20000000-0000-4000-8000-000000000001',
  expectedMissionRevision: '4',
  missionStepId: '20000000-0000-4000-8000-000000000002',
  stepAttempt: 1,
  applicationId: '20000000-0000-4000-8000-000000000003',
  expectedApplicationRevision: '6',
  applicationBundleVersion: '2',
};

const ARMED = {
  mode: 'ACTIVE',
  bindingId: '20000000-0000-4000-8000-000000000004',
  authority: AUTHORITY,
  expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
  state: 'ARMED',
} satisfies SubmissionArmDescriptor;

const WAITING = {
  ...ARMED,
  state: 'WAIT_FOR_USER_RETRY',
  triggerClientRequestId: '20000000-0000-4000-8000-000000000005',
} satisfies SubmissionArmDescriptor;
const WAITING_FOR_FINAL_RETRY = {
  ...WAITING,
  state: 'WAIT_FOR_FINAL_RETRY' as const,
} satisfies SubmissionArmDescriptor;

function nativeSubmit() {
  let defaultPrevented = false;
  let propagationStopped = false;
  const value: SubmissionGestureEvent = {
    kind: 'activation',
    trusted: true,
    activeUserGesture: true,
    targetMatches: true,
    exactControlMatches: true,
    submitterMatches: false,
    markAuthorityBlocked: () => {},
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopImmediatePropagation: () => {
      propagationStopped = true;
    },
  };
  return {
    value,
    prevented: () => defaultPrevented,
    propagationStopped: () => propagationStopped,
  };
}

function mountTarget() {
  document.body.innerHTML = `
    <form><input name="name" value="Ada" /><button type="submit">Submit application</button></form>`;
  const form = document.querySelector('form')!;
  const element = document.querySelector('button')!;
  return {
    activation: 'native-submit' as const,
    form,
    element,
    isCurrent: () => element.isConnected && element.form === form && element.type === 'submit',
  };
}

function trustedReview(): { event: Event; root: ShadowRoot } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  root.append(button);
  const event = new MouseEvent('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, root, host] });
  return { event, root };
}

describe('CAP-AF-041 final review red/green boundary', () => {
  it('blocks before review and only passes a separate native retry after durable preparation', async () => {
    const sendMessage = vi.fn(async (message: { kind: string }) => {
      if (message.kind === 'submission-boundary/enter') return WAITING;
      if (message.kind === 'submission-boundary/trigger-observed') {
        return WAITING_FOR_FINAL_RETRY;
      }
      if (message.kind === 'submission-boundary/trigger-confirmed') {
        return { ...ARMED, state: 'TRIGGERED_LOCKED' as const };
      }
      return { ...ARMED, state: 'OUTCOME_UNKNOWN' as const };
    });
    const gate = createSubmissionGestureGate({
      descriptor: ARMED,
      target: mountTarget(),
      sendMessage,
      isStillAuthorized: () => true,
      captureReviewValueSeal: () => ({ isCurrent: () => true }),
    });

    const blocked = nativeSubmit();
    gate.handle(blocked.value);
    expect(blocked.prevented()).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    const review = trustedReview();
    await expect(gate.confirmFinalReview(review.event, review.root)).resolves.toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    const firstUserSubmit = nativeSubmit();
    gate.handle(firstUserSubmit.value);
    expect(firstUserSubmit.prevented()).toBe(true);
    expect(firstUserSubmit.propagationStopped()).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'submission-boundary/enter',
    }));
    await Promise.resolve();
    await Promise.resolve();

    const authorizedNativeRetry = nativeSubmit();
    gate.handle(authorizedNativeRetry.value);
    expect(authorizedNativeRetry.prevented()).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'submission-boundary/trigger-confirmed',
    }));
  });

  it('keeps the existing never-submit invariant in every production caller', () => {
    const production = [
      '../entrypoints/apply.content.ts',
      '../lib/auditPanel.ts',
      '../lib/hostWriteContainment.ts',
      '../lib/submissionGestureGate.ts',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

    expect(production).not.toMatch(/\.(?:submit|requestSubmit|click)\s*\(/u);
  });
});
