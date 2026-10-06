import {
  EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS,
  parseGetMissionApplicationTargetResponse,
  parseUuid,
} from '@edaix/contracts';
import type { VerifiedApplicationTarget } from '@edaix/agent-channel';

export interface MissionApplicationTargetClient {
  resolve(missionId: string): Promise<VerifiedApplicationTarget | null>;
}

const DEFAULT_TARGET_AUTHORITY_TIMEOUT_MS = 5_000;

export function createMissionApplicationTargetClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Overall auth + fetch + decode deadline. Expiry always resolves to null. */
  timeoutMs?: number;
}>): MissionApplicationTargetClient {
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.now ?? Date.now;
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_TARGET_AUTHORITY_TIMEOUT_MS;

  const request = (missionId: string, token: string) =>
    fetchFn(
      new URL(
        `/api/v1/agent/missions/${encodeURIComponent(missionId)}/application-target`,
        input.apiBase,
      ).toString(),
      {
        method: 'GET',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
      },
    );

  return Object.freeze({
    async resolve(missionId: string): Promise<VerifiedApplicationTarget | null> {
      if (!parseUuid(missionId)) return null;
      return withDeadline(resolveFromAuthority(missionId), timeoutMs);
    },
  });

  async function resolveFromAuthority(
    missionId: string,
  ): Promise<VerifiedApplicationTarget | null> {
    try {
      let token = await input.getAccessToken();
      if (!token) return null;
      let response = await request(missionId, token);
      if (response.status === 401 && input.refreshAccessToken) {
        const error = await safeJson(response);
        if (!isLoginRequired(error)) return null;
        token = await input.refreshAccessToken();
        if (!token) return null;
        response = await request(missionId, token);
      }
      if (response.status !== 200 || !response.ok) return null;
      const decoded = parseGetMissionApplicationTargetResponse(await safeJson(response));
      if (decoded === null) return null;
      const verifiedAt = Date.parse(decoded.target.verifiedAt);
      const freshUntil = Date.parse(decoded.target.freshUntil);
      const current = now();
      if (
        !Number.isFinite(current) ||
        verifiedAt > current ||
        freshUntil <= current ||
        !EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS.includes(
          decoded.target.atsProvider as never,
        )
      ) return null;
      return Object.freeze({
        missionRevision: decoded.target.missionRevision,
        canonicalOrigin: decoded.target.canonicalOrigin,
        pathname: decoded.target.pathname,
        atsProvider: decoded.target.atsProvider as VerifiedApplicationTarget['atsProvider'],
        pathRuleId: decoded.target.pathRuleId,
        verifierVersion: decoded.target.verifierVersion,
        verifiedAt: decoded.target.verifiedAt,
        freshUntil: decoded.target.freshUntil,
        policyVersion: decoded.target.policyVersion,
        revision: decoded.target.revision,
      });
    } catch {
      return null;
    }
  }
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    void operation.then(finish, () => finish(null));
  });
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isLoginRequired(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    !Array.isArray(value) &&
    (value as { code?: unknown }).code === 'LOGIN_REQUIRED';
}
