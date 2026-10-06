import {
  generateApplicationQuestionCandidates,
  getApplicationQuestionSettings,
  getMission,
  getMissionApplicationQuestions,
  parseApplicationQuestionBatchV1,
  parseApplicationQuestionContextV1,
  parseApplicationQuestionResultV1,
  parseApplicationQuestionSchemaV1,
  parseUuid,
  rememberApplicationQuestionAnswer,
  type ApplicationQuestionBatchV1,
  type ApplicationQuestionContextV1,
  type ApplicationQuestionMemoryRecordV1,
  type ApplicationQuestionResultV1,
  type ApplicationQuestionSchemaV1,
  type ApplicationQuestionSettingsUpdateV1,
  type ApplicationQuestionSettingsV1,
  type RememberApplicationQuestionAnswerV1,
  updateApplicationQuestionSettings,
} from '@edaix/contracts';

/**
 * Background-only client for the application-question host (AGENT-API-CONTRACT §4.15–4.16).
 *
 * Question text and option text leave the page only through here, only after the user
 * enabled the feature (the backend refuses otherwise), and only to the first-party API
 * origin — never to the host page, telemetry or the chat channel (PRODUCT-AUTHORITY §3).
 */
export type ApplicationQuestionClientCode = 'DISABLED' | 'LOGIN_REQUIRED' | 'UNAVAILABLE' | 'INVALID';
export type ApplicationQuestionClientResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: ApplicationQuestionClientCode }>;

export interface ApplicationQuestionPage {
  readonly missionId: string;
  /** The reviewed scan digest (`sha256:…`): the exact page the questions came from. */
  readonly pageId: string;
  readonly pageGeneration: string;
}

export interface ApplicationQuestionClient {
  readonly settings: () => Promise<ApplicationQuestionClientResult<ApplicationQuestionSettingsV1>>;
  readonly updateSettings: (update: ApplicationQuestionSettingsUpdateV1) => Promise<ApplicationQuestionClientResult<ApplicationQuestionSettingsV1>>;
  /** The exact application context the packet must carry, assembled from what only the background knows. */
  readonly context: (page: ApplicationQuestionPage) => Promise<ApplicationQuestionClientResult<ApplicationQuestionContextV1>>;
  readonly candidates: (batch: ApplicationQuestionBatchV1) => Promise<ApplicationQuestionClientResult<ApplicationQuestionResultV1>>;
  /** The listing's own application form, so a closed question can be asked with its options. */
  readonly schema: (missionId: string) => Promise<ApplicationQuestionClientResult<ApplicationQuestionSchemaV1>>;
  readonly remember: (input: RememberApplicationQuestionAnswerV1) => Promise<ApplicationQuestionClientResult<ApplicationQuestionMemoryRecordV1>>;
  /**
   * Asked right before a late write: the feature must still be on for the owner and the context
   * the candidates were generated under must still be the Mission's current one.
   */
  readonly recheck: (page: ApplicationQuestionPage, context: ApplicationQuestionContextV1) => Promise<ApplicationQuestionClientResult<Readonly<{ current: boolean }>>>;
}

export interface CreateApplicationQuestionClientInput {
  /** Null is the required default-off state. */
  readonly apiBase: string | null;
  readonly getAccessToken: () => Promise<string | null>;
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly getInstallId: () => Promise<string>;
  /** Verified application target for the mission (missionRevision + target revision). */
  readonly resolveTarget: (missionId: string) => Promise<Readonly<{ missionRevision: string; revision: string }> | null>;
  readonly fetchFn?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
/** The candidate service holds a 30 s hard deadline; wait a little past it. */
const CANDIDATES_TIMEOUT_MS = 32_000;

/** Field-by-field equality of two application contexts. */
export function sameApplicationQuestionContext(a: ApplicationQuestionContextV1, b: ApplicationQuestionContextV1): boolean {
  return (Object.keys(a) as (keyof ApplicationQuestionContextV1)[]).every((key) => a[key] === b[key]);
}

export function createApplicationQuestionClient(input: CreateApplicationQuestionClientInput): ApplicationQuestionClient {
  const origin = resolveOrigin(input.apiBase);
  const fetchFn = input.fetchFn ?? fetch;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ApplicationQuestionClientResult<unknown>> => {
    if (origin === null) return failure('DISABLED');
    const send = async (token: string): Promise<Response> => fetchFn(new URL(path, origin).toString(), {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      let token = await input.getAccessToken();
      if (!token) return failure('LOGIN_REQUIRED');
      let response = await send(token);
      if (response.status === 401 && input.refreshAccessToken) {
        token = await input.refreshAccessToken();
        if (!token) return failure('LOGIN_REQUIRED');
        response = await send(token);
      }
      if (response.status === 401) return failure('LOGIN_REQUIRED');
      if (response.status === 204) return { ok: true, value: null };
      if (!response.ok || !isJson(response.headers.get('content-type'))) return failure('UNAVAILABLE');
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) return failure('UNAVAILABLE');
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return failure('UNAVAILABLE');
    }
  };

  const client: ApplicationQuestionClient = {
    async settings() {
      const result = await call('GET', getApplicationQuestionSettings.path);
      return result.ok ? shaped(result.value, isSettings) : result;
    },
    async updateSettings(update: ApplicationQuestionSettingsUpdateV1) {
      const result = await call('PATCH', updateApplicationQuestionSettings.path, update);
      return result.ok ? shaped(result.value, isSettings) : result;
    },
    async context(page: ApplicationQuestionPage) {
      if (!parseUuid(page.missionId)) return failure('INVALID');
      const [mission, target, extensionInstallId] = await Promise.all([
        call('GET', getMission.path.replace(':missionId', encodeURIComponent(page.missionId))),
        input.resolveTarget(page.missionId),
        input.getInstallId(),
      ]);
      if (!mission.ok) return mission;
      const application = missionApplication(mission.value, page.missionId);
      if (!application || !target) return failure('UNAVAILABLE');
      const context = parseApplicationQuestionContextV1({
        extensionInstallId,
        missionId: page.missionId,
        missionRevision: target.missionRevision,
        canonicalJobId: application.canonicalJobId,
        applicationBundleVersion: application.applicationBundleVersion,
        applicationTargetRevision: target.revision,
        pageId: page.pageId,
        pageGeneration: page.pageGeneration,
      });
      return context ? { ok: true, value: context } : failure('INVALID');
    },
    async candidates(batch: ApplicationQuestionBatchV1) {
      if (!parseApplicationQuestionBatchV1(batch)) return failure('INVALID');
      const result = await call('POST', generateApplicationQuestionCandidates.path, batch, CANDIDATES_TIMEOUT_MS);
      if (!result.ok) return result;
      const parsed = parseApplicationQuestionResultV1(result.value, batch);
      return parsed ? { ok: true, value: parsed } : failure('UNAVAILABLE');
    },
    async schema(missionId: string) {
      if (!parseUuid(missionId)) return failure('INVALID');
      const result = await call('GET', getMissionApplicationQuestions.path.replace(':missionId', encodeURIComponent(missionId)));
      if (!result.ok) return result;
      const parsed = parseApplicationQuestionSchemaV1(result.value);
      return parsed ? { ok: true as const, value: parsed } : failure('UNAVAILABLE');
    },
    async remember(record: RememberApplicationQuestionAnswerV1) {
      const result = await call('POST', rememberApplicationQuestionAnswer.path, record);
      return result.ok ? shaped(result.value, isMemoryRecord) : result;
    },
    async recheck(page: ApplicationQuestionPage, context: ApplicationQuestionContextV1) {
      const [settings, current] = await Promise.all([client.settings(), client.context(page)]);
      if (!settings.ok) return settings;
      // A Mission whose target can no longer be resolved is not current; other failures surface.
      if (!current.ok) return current.code === 'UNAVAILABLE' ? { ok: true, value: { current: false } } : current;
      return { ok: true, value: { current: settings.value.enabled && sameApplicationQuestionContext(current.value, context) } };
    },
  };
  return Object.freeze(client);
}

/** The mission's canonical application binding, read from the mission resource the owner already sees. */
function missionApplication(value: unknown, missionId: string): Readonly<{ canonicalJobId: string; applicationBundleVersion: string }> | null {
  const mission = isRecord(value) && isRecord(value['mission']) ? value['mission'] : null;
  const application = mission && isRecord(mission['application']) ? mission['application'] : null;
  if (!mission || !application || mission['id'] !== missionId) return null;
  const canonicalJobId = application['canonicalJobId'];
  const applicationBundleVersion = application['applicationBundleVersion'];
  return parseUuid(canonicalJobId) && typeof applicationBundleVersion === 'string'
    ? { canonicalJobId: canonicalJobId as string, applicationBundleVersion }
    : null;
}

function resolveOrigin(apiBase: string | null): string | null {
  if (apiBase === null) return null;
  try {
    const parsed = new URL(apiBase);
    const bare = parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' && parsed.origin === apiBase;
    return bare ? parsed.origin : null;
  } catch {
    return null;
  }
}

function shaped<T>(value: unknown, guard: (value: unknown) => value is T): ApplicationQuestionClientResult<T> {
  return guard(value) ? { ok: true, value } : failure('UNAVAILABLE');
}

function isSettings(value: unknown): value is ApplicationQuestionSettingsV1 {
  return isRecord(value) && value['schemaVersion'] === 1 && typeof value['enabled'] === 'boolean'
    && typeof value['autoReuse'] === 'boolean' && typeof value['revision'] === 'string';
}

function isMemoryRecord(value: unknown): value is ApplicationQuestionMemoryRecordV1 {
  return isRecord(value) && parseUuid(value['id']) !== null && isRecord(value['question']) && isRecord(value['answer']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function failure(code: ApplicationQuestionClientCode): Readonly<{ ok: false; code: ApplicationQuestionClientCode }> {
  return Object.freeze({ ok: false, code });
}
