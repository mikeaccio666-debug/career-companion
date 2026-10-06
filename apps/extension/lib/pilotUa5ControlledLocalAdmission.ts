import type { PilotUa1DiscoveryPacket } from '@edaix/contracts/draft';
import { resolveConnectedRuntimeRealm } from './connectedRuntimeRealm';

/** User-approved local acceptance scope; never supplied by Panel, page or storage. */
export const PILOT_UA5_CONTROLLED_LOCAL_ORIGIN = 'https://127.0.0.1:9443';
export const PILOT_UA5_CONTROLLED_LOCAL_PATHNAME = '/__edaix_controlled__/p1-native-text';
export const PILOT_UA5_CONTROLLED_LOCAL_URL =
  `${PILOT_UA5_CONTROLLED_LOCAL_ORIGIN}${PILOT_UA5_CONTROLLED_LOCAL_PATHNAME}`;
export const PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY =
  'FIRST_LOCAL_TEXT_ADMISSION_APPROVED_828AAC2E_2026-09-05';
export const PILOT_UA5_CONTROLLED_LOCAL_HARD_CUTOFF_MS = Date.parse('2026-09-12T07:00:00.000Z');
const MAX_WINDOW_MS = 15 * 60_000;

export type PilotUa5ControlledLocalTuple = Readonly<{
  connectedDev: boolean;
  stagingEnabled?: boolean;
  writeEnabled: boolean;
  apiBase: string | null;
  portalOrigin: string | null;
  targetUrl: string | null;
  authority: string | null;
  notBeforeMs: number;
  notAfterMs: number;
}>;

/** Static validation is also used by the build; an expired artifact may be inspected safely. */
export function isPilotUa5ControlledLocalTuple(input: PilotUa5ControlledLocalTuple): boolean {
  return input.connectedDev === true && input.writeEnabled === true &&
    resolveConnectedRuntimeRealm(input) !== null &&
    input.targetUrl === PILOT_UA5_CONTROLLED_LOCAL_URL &&
    input.authority === PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY &&
    Number.isSafeInteger(input.notBeforeMs) && input.notBeforeMs > 0 &&
    Number.isSafeInteger(input.notAfterMs) && input.notAfterMs > input.notBeforeMs &&
    input.notAfterMs - input.notBeforeMs <= MAX_WINDOW_MS &&
    input.notAfterMs <= PILOT_UA5_CONTROLLED_LOCAL_HARD_CUTOFF_MS;
}

/** This is one conjunct only: Auth, exact-page gesture/lease and per-leaf P1 remain mandatory. */
export function isPilotUa5ControlledLocalAdmission(
  input: PilotUa5ControlledLocalTuple,
  nowMs: number | null,
): boolean {
  return isPilotUa5ControlledLocalTuple(input) &&
    nowMs !== null && Number.isSafeInteger(nowMs) &&
    nowMs >= input.notBeforeMs && nowMs < input.notAfterMs;
}

/** Consume UA-1 semantics only; node identity, empty prestate and drift remain the session's fences. */
export function isPilotUa5ControlledLocalObservation(packet: PilotUa1DiscoveryPacket): boolean {
  const control = packet.controls[0];
  return packet.binding.origin === PILOT_UA5_CONTROLLED_LOCAL_ORIGIN &&
    packet.binding.pathname === PILOT_UA5_CONTROLLED_LOCAL_PATHNAME &&
    packet.controls.length === 1 && control?.inputType === 'text' &&
    control.role === 'textbox' &&
    control.autocomplete.length === 1 && control.autocomplete[0] === 'given-name' &&
    packet.observation.hiddenNotObservedCount === 0 &&
    packet.observation.suppressedControls.length === 0 &&
    packet.observation.opaqueBoundaries.length === 0;
}
