import { describe, expect, it, vi } from 'vitest';
import type { ChannelTransport } from '@edaix/agent-channel';
import { launchLocalRun } from '../lib/localRunLauncher';

const MISSION = Object.freeze({
  missionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  missionStepId: '2c963f66-afa6-4562-b3fc-3fa85f645717',
  missionRevision: '7',
});
const V = 1;
/** The shape parseChannelMessage admits; a looser one is dropped fail-closed. */
const RECEIPT = Object.freeze({
  runId: 'run_1',
  jobId: '',
  missionId: MISSION.missionId,
  missionStepId: MISSION.missionStepId,
  filled: 3,
  total: 5,
  outcomes: [],
  submission: 'NOT_SUBMITTED',
  finishedAt: 1_757_000_000,
});

/** Stands in for the run coordinator: answers run/start with the frames named. */
function coordinatorAnswering(frames: readonly Record<string, unknown>[]) {
  const seen: unknown[] = [];
  const attach = (transport: ChannelTransport) => {
    const off = transport.onMessage((raw) => {
      const message = raw as { kind?: unknown };
      if (message.kind !== 'run/start') return;
      seen.push(raw);
      for (const frame of frames) transport.send({ v: V, ...frame } as never);
    });
    return { dispose: () => off() };
  };
  return { attach, seen };
}

describe('launchLocalRun', () => {
  it('disposes the coordinator on caller cancellation and never starts when already cancelled', async () => {
    const abort = new AbortController(), dispose = vi.fn();
    const running = launchLocalRun({mission:MISSION, signal:abort.signal, attachCoordinator:()=>({dispose})});
    abort.abort();
    await expect(running).resolves.toMatchObject({kind:'STOPPED',code:'RUN_ABORTED'});
    expect(dispose).toHaveBeenCalledOnce();
    const attach = vi.fn(()=>({dispose}));
    await expect(launchLocalRun({mission:MISSION,signal:abort.signal,attachCoordinator:attach})).resolves.toMatchObject({kind:'STOPPED'});
    expect(attach).not.toHaveBeenCalled();
  });
  it('starts a run from the page side and reports the receipt as the end of it', async () => {
    const progress: unknown[] = [];
    const { attach, seen } = coordinatorAnswering([
      { kind: 'run/accepted', clientRequestId: 'req_local', runId: 'run_1', missionId: MISSION.missionId, missionStepId: MISSION.missionStepId },
      { kind: 'run/progress', runId: 'run_1', jobId: '', step: 'FILLING', filled: 3, total: 5 },
      { kind: 'run/receipt', runId: 'run_1', receipt: RECEIPT },
    ]);

    const outcome = await launchLocalRun({
      mission: MISSION,
      attachCoordinator: attach,
      clientRequestId: 'req_local',
      onProgress: (value) => progress.push(value),
    });

    expect(outcome).toEqual({ kind: 'FILLED', runId: 'run_1' });
    expect(progress).toEqual([{ step: 'FILLING', filled: 3, total: 5 }]);
    // The mission reference reaches the coordinator exactly as the Portal sends it.
    expect(seen).toEqual([{
      v: V,
      kind: 'run/start',
      clientRequestId: 'req_local',
      missionId: MISSION.missionId,
      missionStepId: MISSION.missionStepId,
      missionRevision: MISSION.missionRevision,
    }]);
  });

  it('carries a refusal out as its stable code and nothing else', async () => {
    const { attach } = coordinatorAnswering([
      { kind: 'run/stopped', runId: 'run_1', code: 'INTENT_REJECTED' },
    ]);

    await expect(launchLocalRun({ mission: MISSION, attachCoordinator: attach }))
      .resolves.toEqual({ kind: 'STOPPED', runId: 'run_1', code: 'INTENT_REJECTED' });
  });

  /** A worker torn down mid-run must not leave the dock spinning for the tab's life. */
  it('gives up on its own deadline and releases the coordinator', async () => {
    const dispose = vi.fn();
    let fire: (() => void) | null = null;

    // The coordinator is attached and never answers, so the deadline is the only
    // way this settles. Firing the scheduled callback is what a timer would do.
    const outcome = launchLocalRun({
      mission: MISSION,
      attachCoordinator: () => ({ dispose }),
      timeoutMs: 60_000,
      schedule: (run) => { fire = run; return 'handle'; },
      cancel: () => {},
    });

    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();

    await expect(outcome).resolves.toEqual({ kind: 'TIMED_OUT' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
