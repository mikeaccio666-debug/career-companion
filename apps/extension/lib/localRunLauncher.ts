import {
  createChannelClient,
  createMockTransportPair,
  type ChannelTransport,
} from '@edaix/agent-channel';

/**
 * Starts one fill without a Portal on the other end of the channel.
 *
 * The run coordinator already knows how to acquire, scan, claim and fill; the
 * only thing it has ever lacked here is somebody to say "start". The Portal says
 * it over a port. This says the same sentence over the package's own in-memory
 * transport pair, so both halves stay production code and this module is the
 * single seam between them -- nothing about admission, leases or receipts is
 * reimplemented, and a change to the protocol cannot drift away from this path.
 *
 * The caller supplies the coordinator rather than its dependencies: acquirer,
 * claimer, scanner and filler are the background's, built once with its own
 * clients, and this must not get a second opinion about any of them.
 */
export type LocalRunMission = Readonly<{
  missionId: string;
  missionStepId: string;
  missionRevision: string;
}>;

export type LocalRunOutcome =
  /** The coordinator uploaded a receipt: the run reached its end. */
  | Readonly<{ kind: 'FILLED'; runId: string }>
  /** A stable channel code. Never a message, never a field value. */
  | Readonly<{ kind: 'STOPPED'; runId: string | null; code: string }>
  | Readonly<{ kind: 'NEEDS_USER_INPUT'; runId: string }>
  | Readonly<{ kind: 'TIMED_OUT' }>;

export type LocalRunProgress = Readonly<{
  step: string;
  filled: number;
  total: number;
}>;

const DEFAULT_RUN_TIMEOUT_MS = 180_000;

type Frame = Readonly<{ kind?: unknown; runId?: unknown; code?: unknown }>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export function launchLocalRun(input: Readonly<{
  mission: LocalRunMission;
  /** Builds the run coordinator on the extension side of the pair. */
  attachCoordinator: (transport: ChannelTransport) => Readonly<{ dispose(): void }>;
  onProgress?: (progress: LocalRunProgress) => void;
  signal?: AbortSignal;
  clientRequestId?: string;
  timeoutMs?: number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}>): Promise<LocalRunOutcome> {
  if (input.signal?.aborted) return Promise.resolve({kind:'STOPPED',runId:null,code:'RUN_ABORTED'});
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_RUN_TIMEOUT_MS;
  const schedule = input.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancel = input.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return new Promise<LocalRunOutcome>((resolve) => {
    const pair = createMockTransportPair();
    const coordinator = input.attachCoordinator(pair.extensionSide);
    const client = createChannelClient(pair.chatSide);
    let runId: string | null = null;
    let settled = false;
    let timer: unknown = null;

    const finish = (outcome: LocalRunOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) cancel(timer);
      input.signal?.removeEventListener('abort', abort);
      unsubscribe();
      client.dispose();
      coordinator.dispose();
      resolve(outcome);
    };

    const abort = () => finish({kind:'STOPPED',runId,code:'RUN_ABORTED'});

    const unsubscribe = client.onEvent((event) => {
      const frame = event as Frame;
      const id = text(frame.runId);
      if (id !== null) runId = id;
      switch (frame.kind) {
        case 'run/progress': {
          const progress = event as unknown as LocalRunProgress;
          input.onProgress?.({
            step: String(progress.step),
            filled: Number(progress.filled),
            total: Number(progress.total),
          });
          return;
        }
        // A receipt is the coordinator's last word on a run that got that far.
        case 'run/receipt':
          finish({ kind: 'FILLED', runId: runId ?? '' });
          return;
        case 'run/stopped':
          finish({ kind: 'STOPPED', runId, code: text(frame.code) ?? 'RUN_ABORTED' });
          return;
        case 'run/needs-user-input':
          finish({ kind: 'NEEDS_USER_INPUT', runId: runId ?? '' });
          return;
        default:
      }
    });

    // A run that never reports back must still release the coordinator and the
    // caller: a service worker that is torn down mid-run would otherwise leave
    // the dock spinning for as long as the tab lives.
    timer = schedule(() => finish({ kind: 'TIMED_OUT' }), timeoutMs);

    input.signal?.addEventListener('abort', abort, {once:true});
    if (input.signal?.aborted) { abort(); return; }

    client.startRun(
      input.mission.missionId,
      input.mission.missionStepId,
      input.mission.missionRevision,
      input.clientRequestId,
    );
  });
}
