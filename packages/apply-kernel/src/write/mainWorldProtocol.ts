/**
 * The page-visible portion of the isolated ↔ MAIN bridge.
 *
 * This protocol is intentionally tiny. A request identifies only one live
 * target element (the event target) plus an opaque id and action; it never
 * serializes a profile value, label, selector, or form reference.
 */

export const APPLY_MAIN_WORLD_REQUEST_EVENT = '__vibeApplyMainWorldRequest';
export const APPLY_MAIN_WORLD_RESPONSE_EVENT = '__vibeApplyMainWorldResponse';
export const APPLY_MAIN_WORLD_MARKER = '__vibeApplyMainWorldBridgeInstalled';

export type MainWorldRequestAction = 'react-change' | 'cancel';
export type MainWorldResponseStatus = 'accepted' | 'handled' | 'no-handler' | 'stale';

export interface MainWorldRequest {
  readonly requestId: string;
  readonly action: MainWorldRequestAction;
}

export interface MainWorldResponse {
  readonly requestId: string;
  readonly status: MainWorldResponseStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128;
}

export function isMainWorldRequest(value: unknown): value is MainWorldRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['action', 'requestId'])) return false;
  return (
    isRequestId(value.requestId) &&
    (value.action === 'react-change' || value.action === 'cancel')
  );
}

export function isMainWorldResponse(value: unknown): value is MainWorldResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['requestId', 'status'])) return false;
  return (
    isRequestId(value.requestId) &&
    (value.status === 'accepted' ||
      value.status === 'handled' ||
      value.status === 'no-handler' ||
      value.status === 'stale')
  );
}
