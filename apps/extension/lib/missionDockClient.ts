/**
 * The two Mission writes the dock makes on the user's behalf (2026-09-24, argoland §4.15):
 *
 *  - **Start approval.** Start applying in the portal is the user's approval to fill that
 *    job. Right before each dock run the worker asks the backend to record it for exactly
 *    the canonical Profile keys the page shows; the ordinary intent issue, claim and receipt
 *    then run on it. It never authorizes submission.
 *  - **Reported submission.** After the user's own 提交 in the dock (or on the site) and the
 *    site's confirmation, the worker reports `USER_REPORTED_SUBMISSION`, which closes the
 *    Mission in the portal.
 *
 * Background-only; the bearer stays here. Failures are stable codes, never bodies or URLs.
 */

import {
  parseEnsureMissionStartApprovalResponseV1,
  parseUuid,
  type EnsureMissionStartApprovalResponseV1,
  type MissionPageBindingV1,
} from '@edaix/contracts';

export type StartApprovalOutcome =
  | Readonly<{ ok: true; approval: EnsureMissionStartApprovalResponseV1 }>
  | Readonly<{ ok: false; code: string }>;

export type SubmissionReportOutcome = 'REPORTED' | 'ALREADY_SUBMITTED' | 'FAILED';

export interface MissionDockClient {
  startApproval(
    binding: MissionPageBindingV1,
    fieldKeys: readonly string[],
  ): Promise<StartApprovalOutcome>;
  reportSubmission(missionId: string): Promise<SubmissionReportOutcome>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createMissionDockClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  getInstallId: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  newRequestId?: () => string;
  timeoutMs?: number;
}>): MissionDockClient {
  const fetchFn = input.fetchFn ?? fetch;
  const newRequestId = input.newRequestId ?? (() => crypto.randomUUID());
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  async function send(
    path: string,
    init: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>,
  ): Promise<Readonly<{ status: number; body: unknown }> | null> {
    let token = await input.getAccessToken();
    if (!token) return null;
    const request = (bearer: string) => fetchFn(new URL(path, input.apiBase).toString(), {
      method: init.method,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${bearer}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    let response = await request(token);
    let body = await safeJson(response);
    if (response.status === 401 && input.refreshAccessToken && codeOf(body) === 'LOGIN_REQUIRED') {
      token = await input.refreshAccessToken();
      if (!token) return null;
      response = await request(token);
      body = await safeJson(response);
    }
    return { status: response.status, body };
  }

  async function readApplication(missionId: string) {
    const answer = await send(`/api/v1/agent/missions/${encodeURIComponent(missionId)}`, { method: 'GET' });
    if (answer === null || answer.status !== 200) return null;
    return decodeApplication(answer.body, missionId);
  }

  const client: MissionDockClient = {
    async startApproval(binding, fieldKeys) {
      return (await withDeadline((async (): Promise<StartApprovalOutcome> => {
        try {
          const installId = await input.getInstallId();
          if (!installId || !parseUuid(installId)) return { ok: false, code: 'INSTALL_ID_UNAVAILABLE' };
          const answer = await send(
            `/api/v1/agent/missions/${encodeURIComponent(binding.missionId)}/start-approvals`,
            {
              method: 'POST',
              body: {
                schemaVersion: 1,
                clientRequestId: newRequestId(),
                expectedMissionRevision: binding.missionRevision,
                extensionInstallId: installId,
                page: { canonicalOrigin: binding.target.canonicalOrigin, pathname: binding.target.pathname },
                fieldKeys: [...new Set(fieldKeys)].sort(),
              },
            },
          );
          if (answer === null) return { ok: false, code: 'AUTH_UNAVAILABLE' };
          if (answer.status !== 201 && answer.status !== 200) {
            return { ok: false, code: stableCode(answer.body) ?? `HTTP_${answer.status}` };
          }
          const approval = parseEnsureMissionStartApprovalResponseV1(answer.body);
          if (approval === null || approval.mission.id !== binding.missionId) {
            return { ok: false, code: 'RESPONSE_MALFORMED' };
          }
          return { ok: true, approval };
        } catch {
          return { ok: false, code: 'NETWORK_FAILED' };
        }
      })(), timeoutMs)) ?? { ok: false, code: 'TIMEOUT' };
    },

    async reportSubmission(missionId) {
      if (!parseUuid(missionId)) return 'FAILED';
      return (await withDeadline((async (): Promise<SubmissionReportOutcome> => {
        try {
          // The application moves while the user fills (every receipt bumps its revision):
          // read it fresh, and once more if the backend says it moved again.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const application = await readApplication(missionId);
            if (application === null) return 'FAILED';
            if (application.submissionState === 'TRIGGERED_LOCKED') return 'ALREADY_SUBMITTED';
            const answer = await send(
              `/api/v1/agent/missions/${encodeURIComponent(missionId)}/submission-events`,
              {
                method: 'POST',
                body: {
                  clientRequestId: newRequestId(),
                  eventType: 'USER_REPORTED_SUBMISSION',
                  applicationId: application.applicationId,
                  expectedApplicationRevision: application.applicationRevision,
                  applicationBundleVersion: application.applicationBundleVersion,
                },
              },
            );
            if (answer === null) return 'FAILED';
            if (answer.status === 201 || answer.status === 200) return 'REPORTED';
            if (answer.status !== 409) return 'FAILED';
          }
          return 'FAILED';
        } catch {
          return 'FAILED';
        }
      })(), timeoutMs * 2)) ?? 'FAILED';
    },
  };
  return Object.freeze(client);
}

/** Only the application binding of a Mission detail; everything else is not ours to read. */
function decodeApplication(value: unknown, missionId: string) {
  if (!isRecord(value) || value['schemaVersion'] !== 1 || !isRecord(value['mission'])) return null;
  const mission = value['mission'];
  if (mission['id'] !== missionId) return null;
  const application = mission['application'];
  if (!isRecord(application)) return null;
  const applicationId = parseUuid(application['applicationId']);
  const bundle = application['applicationBundleVersion'];
  const revision = application['applicationRevision'];
  const state = application['submissionState'];
  if (
    applicationId === null ||
    !positiveDecimal(bundle) ||
    !positiveDecimal(revision) ||
    typeof state !== 'string'
  ) return null;
  return Object.freeze({
    applicationId,
    applicationBundleVersion: bundle,
    applicationRevision: revision,
    submissionState: state,
  });
}

function stableCode(body: unknown): string | null {
  const code = codeOf(body);
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null;
}

function codeOf(body: unknown): unknown {
  return isRecord(body) ? body['code'] : undefined;
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
