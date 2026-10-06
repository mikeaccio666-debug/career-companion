import {
  createPilotUa4WriterRuntime,
  type PilotUa4HostExecutor,
  type PilotUa4WriterRuntimeInput,
} from '../../lib/pilotUa4WriterRuntime';

const UNREAD_DISABLED_INPUT = Object.freeze({
  authority: null,
  currentBinding: null,
  currentControlIdentityDigests: Object.freeze([]),
  nowMs: 0,
  semanticEpochs: Object.freeze([]),
  ua2Classifications: Object.freeze([]),
  semanticDigest: () => {
    throw new Error('FIELD_LAB_UA4_DIGEST_FORBIDDEN');
  },
  payloadRefs: Object.freeze([]),
  discoveryComplete: false,
  preResolvedDispositions: Object.freeze([]),
}) satisfies PilotUa4WriterRuntimeInput;

export type FieldLabExecutionProbe = Readonly<{
  port: 'UA-4_WRITER_RUNTIME';
  state: 'CALLED_FAIL_CLOSED';
  code: 'PILOT_CAPABILITY_DISABLED';
  liveTargetTouched: false;
}>;

/**
 * Calls the sole production UA-4 composition port after an explicit developer
 * click. Its hard-disabled gate must return before reading input or reaching a
 * host executor; the Field Lab never constructs authority, a plan, or a ledger.
 */
export async function probeExecutionPort(): Promise<FieldLabExecutionProbe> {
  let liveTargetTouched = false;
  const hostExecutor: PilotUa4HostExecutor = Object.freeze({
    async execute() {
      liveTargetTouched = true;
      throw new Error('FIELD_LAB_UA4_HOST_EXECUTION_FORBIDDEN');
    },
  });
  const result = await createPilotUa4WriterRuntime(
    Object.freeze({ enabled: false }),
    hostExecutor,
  ).execute(UNREAD_DISABLED_INPUT);
  if (result.ok || result.code !== 'PILOT_CAPABILITY_DISABLED' || liveTargetTouched) {
    throw new Error('FIELD_LAB_UA4_BOUNDARY_VIOLATION');
  }
  return Object.freeze({
    port: 'UA-4_WRITER_RUNTIME',
    state: 'CALLED_FAIL_CLOSED',
    code: result.code,
    liveTargetTouched: false,
  });
}
