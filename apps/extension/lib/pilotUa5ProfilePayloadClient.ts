import {
  parsePilotUa5BoundProfilePayloadRequest, parsePilotUa5BoundProfilePayloadResponse,
  PILOT_UA5_MAX_RESPONSE_BYTES,
  type PilotUa5BoundProfilePayloadRequest, type PilotUa5BoundProfilePayloadResponse,
  type PilotUa5ProfilePayloadRequest, type PilotUa5ProfilePayloadResponse,
} from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import {
  parsePilotUa5ProfileCurrentnessRequest, parsePilotUa5ProfileCurrentnessResponse,
  samePilotUa5ProfileCheck, PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE as unavailable,
  type PilotUa5ProfileCurrentnessRequest, type PilotUa5ProfileCurrentnessResponse,
} from '@edaix/contracts/draft/pilot-ua5-profile-currentness';
import { CONNECTED_DEVELOPMENT_REALM, resolveConnectedRuntimeRealm } from './connectedRuntimeRealm';

export const PILOT_UA5_PROFILE_PAYLOAD_ENDPOINT = '/api/v1/agent/pilot/ua5/profile-payloads';
export const PILOT_UA5_PROFILE_CURRENTNESS_ENDPOINT = '/api/v1/agent/pilot/ua5/profile-currentness';
const REQUEST_TIMEOUT_MS = 5_000;
// The existing Agent host JSON body cap, including the encoded seal and envelope.
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const failure = (code: Extract<PilotUa5BoundProfilePayloadResponse, { ok: false }>['code']): PilotUa5BoundProfilePayloadResponse =>
  Object.freeze({ ok: false, schemaVersion: 2, code });
export type PilotUa5ProfilePayloadClient = Readonly<{
  resolve(request: PilotUa5BoundProfilePayloadRequest, writeNotAfterMs?: number): Promise<PilotUa5BoundProfilePayloadResponse>;
  check(request: PilotUa5ProfileCurrentnessRequest, writeNotAfterMs?: number): Promise<PilotUa5ProfileCurrentnessResponse>;
}>;
export type CreatePilotUa5ProfilePayloadClientInput = Readonly<{
  enabled: boolean; apiBase: string | null; getAccessToken: () => Promise<string | null>;
  stagingEnabled?: boolean; portalOrigin?: string;
  fetchFn?: typeof fetch; now?: () => number;
}>;

/** One private request lifetime, with no logs, storage, retries, or replacement answers. */
export function createPilotUa5ProfilePayloadClient(input: CreatePilotUa5ProfilePayloadClientInput): PilotUa5ProfilePayloadClient {
  const realm = resolveConnectedRuntimeRealm({ ...input,
    portalOrigin: input.portalOrigin ?? (input.stagingEnabled === true ? undefined : CONNECTED_DEVELOPMENT_REALM.portalOrigin) });
  const enabled = input.enabled && realm !== null;
  const now = input.now ?? Date.now, fetchFn = input.fetchFn ?? fetch;
  const post = async (endpoint: string, body: unknown, writeNotAfterMs = Number.MAX_SAFE_INTEGER): Promise<unknown> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = now();
      if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(writeNotAfterMs)) return null;
      const deadline = Math.min(started + REQUEST_TIMEOUT_MS, writeNotAfterMs);
      const current = () => {
        const time = now();
        return !controller.signal.aborted && Number.isSafeInteger(time) && time >= started && time < deadline;
      };
      if (!current()) return null;
      const serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) return null;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, deadline - started);
      });
      const work = (async () => {
        try {
          const token = await input.getAccessToken();
          if (!token || !current()) return null;
          if (!realm) return null;
          const response = await fetchFn(`${realm.apiBase}${endpoint}`, {
            method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: serialized, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
          });
          if (!current() || !response.ok || response.status !== 200 ||
              response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return null;
          const raw = await response.text();
          if (!current() || new TextEncoder().encode(raw).byteLength > PILOT_UA5_MAX_RESPONSE_BYTES) return null;
          return JSON.parse(raw) as unknown;
        } catch { return null; }
      })();
      return await Promise.race([work, timeout]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  };
  return Object.freeze({
    async resolve(candidate, deadline) {
      const request = parsePilotUa5BoundProfilePayloadRequest(candidate);
      if (!request.ok) return failure('PILOT_UA5_INPUT_INVALID');
      if (!enabled) return failure('PILOT_CAPABILITY_DISABLED');
      const response = parsePilotUa5BoundProfilePayloadResponse(await post(PILOT_UA5_PROFILE_PAYLOAD_ENDPOINT, request.value, deadline));
      if (!response.ok || (response.value.ok && !responseMatchesRequest(request.value.request, response.value.payload))) return failure('PILOT_UA5_PROFILE_UNAVAILABLE');
      return response.value;
    },
    async check(candidate, deadline) {
      const request = parsePilotUa5ProfileCurrentnessRequest(candidate);
      if (!enabled || !request.ok) return unavailable;
      const response = parsePilotUa5ProfileCurrentnessResponse(await post(PILOT_UA5_PROFILE_CURRENTNESS_ENDPOINT, request.value, deadline));
      return response.ok && (!response.value.ok || samePilotUa5ProfileCheck(request.value.check, response.value.check)) ? response.value : unavailable;
    },
  });
}

function responseMatchesRequest(
  request: PilotUa5ProfilePayloadRequest,
  response: Extract<PilotUa5ProfilePayloadResponse, { ok: true }>,
): boolean {
  const expectedBinding = request.discovery.binding;
  const composition = response.composition;
  if (
    !sameBinding(expectedBinding, composition.candidateRule.binding) ||
    !sameBinding(expectedBinding, composition.authority.binding) ||
    !sameBinding(expectedBinding, composition.projection.binding)
  ) return false;
  const expectedIdentities = request.discovery.controls.map((item) => item.identityDigest);
  const classifiedIdentities = composition.candidateRule.classifications.map(
    (item) => item.identityDigest,
  );
  return sameStringSet(expectedIdentities, classifiedIdentities) &&
    sameStringSet(
      expectedIdentities,
      composition.authority.observedControlIdentityDigests,
    );
}

function sameBinding(
  left: PilotUa5ProfilePayloadRequest['discovery']['binding'],
  right: PilotUa5ProfilePayloadRequest['discovery']['binding'],
): boolean {
  return left.origin === right.origin &&
    left.pathname === right.pathname &&
    left.domGeneration === right.domGeneration;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value));
}
