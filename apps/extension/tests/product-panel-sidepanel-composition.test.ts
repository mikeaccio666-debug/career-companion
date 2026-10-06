// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { respondingPort } from './connectedPorts';

const runtimeConnect = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect: runtimeConnect, onMessage: { addListener: () => {} } } } }));

const originalUserActivation = Object.getOwnPropertyDescriptor(navigator, 'userActivation');

function dispatchTrustedClick(button: HTMLButtonElement): void {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: Object.freeze({ isActive: true, hasBeenActive: true }),
  });
  const event = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  button.dispatchEvent(event);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  runtimeConnect.mockReset();
  vi.resetModules();
  if (originalUserActivation === undefined) {
    Reflect.deleteProperty(navigator, 'userActivation');
  } else {
    Object.defineProperty(navigator, 'userActivation', originalUserActivation);
  }
});

describe('Product Panel sidepanel composition', () => {
  it('runs the real default-off probe before presenting all states and advances once', async () => {
    const root = document.createElement('main');
    root.id = 'app';
    document.body.append(root);
    vi.stubGlobal('__VIBE_EXTENSION_FIELD_LAB_ENABLED__', true);

    await import('../entrypoints/sidepanel/main');

    expect(document.title).toBe('EdAIX Field Lab');
    expect(root.dataset.prototypeMarker).toBe('product-panel/interaction-prototype');
    expect(root.textContent).toContain('Connected destinations are placeholders');
    root.querySelector<HTMLButtonElement>('[data-action="open-resume"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('Résumé destination preview'));

    const start = root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!;
    start.focus();
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('Required completion: 2/5 observed verified'));
    expect(document.activeElement?.id).toBe('product-panel-progress-title');
    expect([...root.querySelectorAll('[data-status]')].map((item) => item.getAttribute('data-status')))
      .toEqual([
        'PREFILLED',
        'FILLED',
        'AI_SUGGESTED',
        'USER_CONFIRMATION_REQUIRED',
        'MANUAL_REQUIRED',
        'POLICY_BLOCKED',
        'DISCOVERY_INCOMPLETE',
      ]);

    const next = root.querySelector<HTMLButtonElement>('[data-action="continue-next-page"]')!;
    next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('Required completion: 2/5 observed verified'));
    expect(root.querySelector('[data-action="continue-next-page"]')).toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[type="submit"]')).toBeNull();
  });

  it('mounts the connected UA-5 adapter and projects only value-free progress', async () => {
    const root = document.createElement('main');
    root.id = 'app';
    document.body.append(root);
    vi.stubGlobal('__VIBE_EXTENSION_FIELD_LAB_ENABLED__', false);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__', true);

    const sent: unknown[] = [];
    runtimeConnect.mockImplementation(() => respondingPort((message, emit) => {
    sent.push(message);
    const request = message as { kind?: string; requestId: string };
    const requestId = request.requestId;
    queueMicrotask(() => {
      if (request.kind === 'pilot-ua5/probe-readiness') {
        emit({
          kind: 'pilot-ua5/readiness',
          version: 2,
          requestId,
          status: 'READY',
        });
        return;
      }
      if (request.kind === 'pilot-ua5/undo-field') {
        const undo = request as {
          requestId: string;
          runRequestId: string;
          questionId: string;
        };
        emit({
          kind: 'pilot-ua5/undo-result',
          version: 2,
          requestId: undo.requestId,
          runRequestId: undo.runRequestId,
          questionId: undo.questionId,
          status: 'RESTORED',
        });
        return;
      }
      if (request.kind === 'pilot-ua5/get-current-result') {
        emit({
          kind: 'pilot-ua5/result', version: 2, requestId,
          result: { ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' },
        });
        return;
      }
      for (const event of [
        { phase: 'OBSERVED', observedControls: 1 },
        { phase: 'COMPOSED', observableQuestions: 1, authorizedQuestions: 1 },
        { phase: 'SETTLED', requiredCompleted: 1, requiredQuestions: 1 },
      ]) {
        emit({
          kind: 'pilot-ua5/progress', version: 2, requestId, event,
        });
      }
      emit({
        kind: 'pilot-ua5/result',
        version: 2,
        requestId,
        result: {
          ok: true,
          projection: {
            schemaVersion: 2,
            binding: {
              origin: 'https://job-boards.greenhouse.io',
              pathname: '/company/jobs/42',
              domGeneration: 'a'.repeat(64),
            },
            discoveryComplete: true,
            rows: [
              { questionId: 'email', required: true, state: 'FILLED', reason: null },
            ],
            unobservedRegions: [],
            summary: {
              observableQuestions: 1,
              requiredQuestions: 1,
              requiredCompleted: 1,
              terminalQuestions: 1,
              unobservedRegions: 0,
            },
          },
        },
      });
    });
    }));

    await import('../entrypoints/sidepanel/main');
    expect(root.dataset.connectedDev).toBe('pilot-ua5/current-page');
    expect(document.title).toBe('EdAIX Connected Lab');
    expect(root.textContent).toContain(
      'Click the EdAIX extension icon on this page, then click Begin assisted fill.',
    );
    expect(runtimeConnect).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ kind: 'pilot-ua5/get-current-result', version: 2,
      requestId: expect.stringMatching(/^[0-9a-f]{32}$/u) });
    expect(root.textContent).not.toContain('Interaction prototype');
    expect(root.textContent).not.toContain('Connected destinations are placeholders');
    await Promise.resolve();
    dispatchTrustedClick(root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!);
    await vi.waitFor(() => expect(root.textContent).toContain('Required completion: 1/1 verified'));

    expect(sent).toContainEqual({
      kind: 'pilot-ua5/start-current-page',
      version: 2,
      requestId: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
    expect(JSON.stringify(sent)).not.toMatch(/value|answer|email|url/iu);
    expect([...root.querySelectorAll('[data-status]')].map((item) => item.getAttribute('data-status')))
      .toEqual(['SUCCESS']);
    expect(root.querySelector('[data-action="continue-next-page"]')).toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[type="submit"]')).toBeNull();

    expect(root.querySelector('[data-action="undo-field"]')).toBeNull();
    expect(sent.some((message) => (message as { kind?: string }).kind === 'pilot-ua5/undo-field')).toBe(false);
    expect(root.textContent).toContain('Edit fields there');
  });

  it('shows an ordinary Greenhouse page as unauthorized and never starts a run', async () => {
    const root = document.createElement('main');
    root.id = 'app';
    document.body.append(root);
    vi.stubGlobal('__VIBE_EXTENSION_FIELD_LAB_ENABLED__', false);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__', true);

    const sentKinds: string[] = [];
    runtimeConnect.mockImplementation(() => respondingPort((message, emit) => {
      const request = message as { kind: string; requestId: string };
      sentKinds.push(request.kind);
      queueMicrotask(() => emit(request.kind === 'pilot-ua5/get-current-result'
        ? { kind: 'pilot-ua5/result', version: 2, requestId: request.requestId,
            result: { ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' } }
        : { kind: 'pilot-ua5/readiness', version: 2, requestId: request.requestId,
            status: 'LIVE_WRITE_NOT_AUTHORIZED' }));
    }));

    await import('../entrypoints/sidepanel/main');
    expect(root.textContent).toContain(
      'Click the EdAIX extension icon on this page, then click Begin assisted fill.',
    );
    expect(sentKinds).toEqual(['pilot-ua5/get-current-result']);
    const start = root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!;
    expect(start.disabled).toBe(false);
    dispatchTrustedClick(start);
    await vi.waitFor(() => expect(root.textContent).toContain(
      'This is not an authorized EdAIX test page. No fields will be changed.',
    ));
    expect(sentKinds).toEqual(['pilot-ua5/get-current-result', 'pilot-ua5/probe-readiness']);
    expect(root.textContent).not.toContain('Interaction prototype');
  });
});
