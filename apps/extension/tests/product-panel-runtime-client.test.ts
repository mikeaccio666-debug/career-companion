import { describe, expect, it, vi } from 'vitest';

import { respondingPort as port } from './connectedPorts';
import { createPilotUa5PanelRuntimeClient } from '../connected-dev/panelRuntimeClient';

function successfulRun(requestId: string) {
  return {
      kind: 'pilot-ua5/result',
      version: 2,
      requestId,
      result: {
        ok: true,
        projection: {
          schemaVersion: 2,
          binding: {
            origin: 'https://job-boards.greenhouse.io',
            pathname: '/team/jobs/42',
            domGeneration: 'a'.repeat(64),
          },
          discoveryComplete: true,
          rows: [
            { questionId: 'field-filled', required: true, state: 'FILLED', reason: null },
            { questionId: 'field-manual', required: true, state: 'MANUAL_REQUIRED', reason: 'PASSWORD' },
          ],
          unobservedRegions: [],
          summary: {
            observableQuestions: 2,
            requiredQuestions: 2,
            requiredCompleted: 1,
            terminalQuestions: 2,
            unobservedRegions: 0,
          },
        },
      },
  } as const;
}

describe('connected Product Panel runtime client', () => {
  it('accepts the canonical result without a progress transcript or a UI commit handshake', async () => {
    const requestId = '1'.repeat(32);
    const sent: unknown[] = [];
    const client = createPilotUa5PanelRuntimeClient({
      runtime: { connect: () => port((message, emit) => {
        sent.push(message);
        queueMicrotask(() => emit(successfulRun(requestId)));
      }) },
      requestId: () => requestId,
      timeoutMs: 20,
    });
    await expect(client.runCurrentPage(() => {})).resolves.toMatchObject({ ok: true });
    expect(sent).toEqual([{ kind: 'pilot-ua5/start-current-page', version: 2, requestId }]);
  });

  it('uses the exact value-free one-shot protocol for a targeted FILLED Undo', async () => {
    const runRequestId = 'a'.repeat(32);
    const undoRequestId = 'b'.repeat(32);
    const requestIds = [runRequestId, undoRequestId];
    const sent: unknown[] = [];
    const connect = vi.fn(() => port((message, emit) => {
      sent.push(message);
      const request = message as { kind?: string; requestId?: string };
      queueMicrotask(() => {
        if (request.kind === 'pilot-ua5/start-current-page') {
          emit(successfulRun(runRequestId));
          return;
        }
        emit({
          kind: 'pilot-ua5/undo-result',
          version: 2,
          requestId: undoRequestId,
          runRequestId,
          questionId: 'field-filled',
          status: 'RESTORED',
        });
      });
    }));
    const client = createPilotUa5PanelRuntimeClient({
      runtime: { connect },
      requestId: () => requestIds.shift() ?? 'c'.repeat(32),
      timeoutMs: 1_000,
    });

    await expect(client.runCurrentPage(() => {}))
      .resolves.toMatchObject({ ok: true });
    await expect(client.undoCurrentPage('field-filled')).resolves.toBe('UNAVAILABLE');
    await expect(client.undoCurrentPage('field-filled')).resolves.toBe('UNAVAILABLE');

    expect(sent).toEqual([
      {
        kind: 'pilot-ua5/start-current-page',
        version: 2,
        requestId: runRequestId,
      },
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toMatch(/value|answer|label|reason/iu);
  });

  it('never transports Undo for filled or manual targets', async () => {
    const runRequestId = 'd'.repeat(32);
    const undoRequestId = 'e'.repeat(32);
    const requestIds = [runRequestId, undoRequestId];
    const connect = vi.fn(() => port((message, emit) => {
      const request = message as { kind?: string };
      queueMicrotask(() => {
        if (request.kind === 'pilot-ua5/start-current-page') {
          emit(successfulRun(runRequestId));
          return;
        }
        emit({
          kind: 'pilot-ua5/undo-result',
          version: 2,
          requestId: undoRequestId,
          runRequestId,
          questionId: 'field-filled',
          status: 'RESTORED',
          value: 'must-not-cross',
        });
      });
    }));
    const client = createPilotUa5PanelRuntimeClient({
      runtime: { connect },
      requestId: () => requestIds.shift() ?? 'f'.repeat(32),
      timeoutMs: 1_000,
    });
    await client.runCurrentPage(() => {});

    await expect(client.undoCurrentPage('field-manual')).resolves.toBe('UNAVAILABLE');
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(client.undoCurrentPage('field-filled')).resolves.toBe('UNAVAILABLE');
    await expect(client.undoCurrentPage('field-filled')).resolves.toBe('UNAVAILABLE');
    expect(connect).toHaveBeenCalledTimes(1);
  });


});
