import {
  parsePilotUa2ClassificationRequest,
  parsePilotUa2ClassificationResponse,
  pilotUa2ResponseMatchesRequest,
  type PilotUa2ClassificationRequest,
  type PilotUa2ClassificationResponse,
  type PilotUa2FailureCode,
} from '@edaix/contracts/draft';

export const PILOT_UA2_CLASSIFICATION_ENDPOINT =
  '/api/v1/agent/pilot/ua2/classify';

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface PilotUa2ClassificationClient {
  classify(input: PilotUa2ClassificationRequest): Promise<PilotUa2ClassificationResponse>;
}

export interface CreatePilotUa2ClassificationClientInput {
  /** Null is the required default-off state. */
  readonly apiBase: string | null;
  readonly getAccessToken: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
}

export function createPilotUa2ClassificationClient(
  input: CreatePilotUa2ClassificationClientInput,
): PilotUa2ClassificationClient {
  const endpoint = resolveEndpoint(input.apiBase);
  const fetchFn = input.fetchFn ?? fetch;

  return Object.freeze({
    async classify(candidate: PilotUa2ClassificationRequest) {
      const parsed = parsePilotUa2ClassificationRequest(candidate);
      if (!parsed.ok) return failure('PILOT_CLASSIFICATION_INPUT_INVALID');
      if (endpoint === null) return failure('PILOT_CAPABILITY_DISABLED');

      let token: string | null;
      try {
        token = await input.getAccessToken();
      } catch {
        token = null;
      }
      if (!token) return failure('PILOT_CLASSIFICATION_UNAVAILABLE');

      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(parsed.value),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return failure('PILOT_CLASSIFICATION_UNAVAILABLE');
      }
      if (!response.ok || response.status !== 200 || !isJson(response.headers.get('content-type'))) {
        return failure('PILOT_CLASSIFICATION_UNAVAILABLE');
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch {
        return failure('PILOT_CLASSIFICATION_UNAVAILABLE');
      }
      if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
        return failure('PILOT_CLASSIFICATION_UNAVAILABLE');
      }

      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        return failure('PILOT_CLASSIFICATION_UNAVAILABLE');
      }
      const classified = parsePilotUa2ClassificationResponse(body);
      if (!classified.ok) return failure('PILOT_CLASSIFICATION_UNAVAILABLE');
      if (!classified.value.ok) return classified.value;
      if (!pilotUa2ResponseMatchesRequest(parsed.value, classified.value)) {
        return failure('PILOT_TARGET_DRIFT');
      }
      return classified.value;
    },
  });
}

function resolveEndpoint(apiBase: string | null): string | null {
  if (apiBase === null) return null;
  try {
    const parsed = new URL(apiBase);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.origin !== apiBase
    ) return null;
    return new URL(PILOT_UA2_CLASSIFICATION_ENDPOINT, parsed).toString();
  } catch {
    return null;
  }
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function failure(code: PilotUa2FailureCode): PilotUa2ClassificationResponse {
  return Object.freeze({ ok: false, schemaVersion: 1, code });
}
