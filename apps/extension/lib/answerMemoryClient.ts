import {
  APPLICATION_ANSWER_CONTROL_TYPES,
  listApplicationQuestionAnswers,
  parseApplicationAnswerKeyV1,
  parseApplicationAnswerValueV1,
  rememberApplicationQuestionAnswer,
  type ApplicationAnswerControlType,
  type PutApplicationAnswerRequestV1,
  type RememberedAnswerV1,
} from '@edaix/contracts';

/**
 * 答案记忆的两个读写（argoland `answer-memory.controller.ts`）。只在 worker 里跑。
 *
 * wire 是 `applicationQuestionAnswers.ts` 那份：`GET` 回用户全部记住的答案，
 * `POST` 按 answerKey 存一条（同键覆盖）。没有 mission、没有上下文——「同一道题」
 * 由契约算出的键说了算（类别键 `cat:…` 或归一化题干摘要 `txt:…`），所以手势填写路
 * 也能用：它没有 mission，但它认得题干。
 *
 * 答案是 Data-L1：只在 worker 与第一方 API 之间流动，再交给内容脚本比对；
 * 不进日志、不进遥测、不进回执。失败显式分档（RULE-GLOBAL-ERROR-CONTRACT）。
 */
export type AnswerMemoryFailureCode = 'AUTH_REQUIRED' | 'PAYWALL_REQUIRED' | 'REJECTED' | 'UNAVAILABLE';

export type AnswerMemoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: AnswerMemoryFailureCode }>;

export interface AnswerMemoryClient {
  /** 用户记住的全部答案。空清单是一个成功的答案：他确实还没记过。 */
  list(): Promise<AnswerMemoryResult<readonly RememberedAnswerV1[]>>;
  /** 记一条（同键覆盖）。答复只带键与版本，不回显答案。 */
  put(request: PutApplicationAnswerRequestV1): Promise<AnswerMemoryResult<Readonly<{ answerKey: string; revision: string }>>>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export function createAnswerMemoryClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** 稳定原因码（只有码）。目前只报「清单里有这一版不认识的种类、跳过了」。 */
  onDiagnostic?: (code: string) => void;
}>): AnswerMemoryClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS;

  function request(path: string, method: 'GET' | 'POST', body: unknown, token: string): Promise<Response> {
    return fetchFn(new URL(path, input.apiBase).toString(), {
      method,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function exchange(path: string, method: 'GET' | 'POST', body?: unknown): Promise<AnswerMemoryResult<unknown>> {
    let token = await input.getAccessToken();
    if (token === null || token === '') return failure('AUTH_REQUIRED');
    let response = await request(path, method, body, token);
    if (response.status === 401 && input.refreshAccessToken !== undefined) {
      token = await input.refreshAccessToken();
      if (token === null || token === '') return failure('AUTH_REQUIRED');
      response = await request(path, method, body, token);
    }
    if (response.status === 401) return failure('AUTH_REQUIRED');
    if (response.status === 402 || response.status === 403) return failure('PAYWALL_REQUIRED');
    if (response.status !== 200) return failure('UNAVAILABLE');
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) return failure('UNAVAILABLE');
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return failure('UNAVAILABLE');
    }
  }

  return Object.freeze({
    async list(): Promise<AnswerMemoryResult<readonly RememberedAnswerV1[]>> {
      return guard((async (): Promise<AnswerMemoryResult<readonly RememberedAnswerV1[]>> => {
        const read = await exchange(listApplicationQuestionAnswers.path, 'GET');
        if (!read.ok) return read;
        const parsed = parseList(read.value);
        // 解不出就是读不到：半份清单比没有清单危险——会把「没记过」和「读不到」混成一件事。
        if (parsed === null) return failure('UNAVAILABLE');
        if (parsed.skippedUnknownKinds) {
          try {
            input.onDiagnostic?.('ANSWER_MEMORY_UNKNOWN_KIND_SKIPPED');
          } catch {
            // 诊断通道自己坏了不该影响读清单。
          }
        }
        return { ok: true, value: parsed.answers };
      })(), timeoutMs);
    },

    async put(putRequest: PutApplicationAnswerRequestV1): Promise<AnswerMemoryResult<Readonly<{ answerKey: string; revision: string }>>> {
      return guard((async (): Promise<AnswerMemoryResult<Readonly<{ answerKey: string; revision: string }>>> => {
        const read = await exchange(rememberApplicationQuestionAnswer.path, 'POST', putRequest);
        if (!read.ok) return read;
        const body = read.value as Record<string, unknown> | null;
        if (body === null || typeof body !== 'object' || body['schemaVersion'] !== 1) return failure('UNAVAILABLE');
        if (body['ok'] !== true) return failure('REJECTED');
        if (typeof body['answerKey'] !== 'string' || typeof body['revision'] !== 'string') return failure('UNAVAILABLE');
        return { ok: true, value: Object.freeze({ answerKey: body['answerKey'], revision: body['revision'] }) };
      })(), timeoutMs);
    },
  });
}

/**
 * 逐条按契约校验；认得的种类里一条不成形，整份清单不要（键与取值都是要写进别人表单的东西）。
 *
 * 2026-09-28 起分开两种「解不出」：
 *  · **这一版不认识的种类**（新的题目类别、新的键方案、新的控件类型、新的取值种类或取值里多出的
 *    成员）：跳过那一条，别的照常。这一版产不出那样的键、也填不了那样的值，那一条对它等于不存在，
 *    跳过它不会把「没记过」与「读不到」混在一起。在此之前后端加一种类别，旧包的记忆复用全停。
 *  · **认得的种类里坏了**：整份不要，与从前逐字相同。
 * 清单外层与每一条的公共字段（版本、确认时间……）照旧逐项校验。
 */
function parseList(
  value: unknown,
): Readonly<{ answers: readonly RememberedAnswerV1[]; skippedUnknownKinds: boolean }> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body['schemaVersion'] !== 1 || !Array.isArray(body['answers'])) return null;
  const answers: RememberedAnswerV1[] = [];
  let skippedUnknownKinds = false;
  for (const raw of body['answers']) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const answerKey = item['answerKey'];
    const controlType = item['controlType'];
    if (
      typeof answerKey !== 'string' || typeof controlType !== 'string' ||
      !(item['categoryKey'] === null || typeof item['categoryKey'] === 'string') ||
      typeof item['revision'] !== 'string' || typeof item['confirmedAt'] !== 'string'
    ) return null;
    if (parseApplicationAnswerKeyV1(answerKey) === null) {
      if (!isFutureAnswerKey(answerKey)) return null;
      skippedUnknownKinds = true;
      continue;
    }
    if (!(APPLICATION_ANSWER_CONTROL_TYPES as readonly string[]).includes(controlType)) {
      if (!ENUM_TOKEN.test(controlType)) return null;
      skippedUnknownKinds = true;
      continue;
    }
    const parsed = parseApplicationAnswerValueV1(item['value'], controlType as ApplicationAnswerControlType);
    if (parsed === null) {
      if (!isFutureAnswerValue(item['value'], controlType as ApplicationAnswerControlType)) return null;
      skippedUnknownKinds = true;
      continue;
    }
    answers.push(Object.freeze({
      answerKey,
      categoryKey: item['categoryKey'] as string | null,
      controlType: controlType as ApplicationAnswerControlType,
      value: parsed,
      revision: item['revision'],
      confirmedAt: item['confirmedAt'],
    }));
  }
  return Object.freeze({ answers: Object.freeze(answers), skippedUnknownKinds });
}

const ENUM_TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/u;

/**
 * 解不出的键，是「更新的服务端加的一种」还是坏数据：`cat:` 后面跟一个这一版不认识的类别名，
 * 或者一个这一版不认识的方案前缀（`xyz:…`）。`txt:` 的摘要不成形是坏数据——那个方案我们认得。
 */
function isFutureAnswerKey(value: string): boolean {
  if (value.startsWith('cat:')) return /^cat:[a-z][a-z0-9-]{0,63}$/u.test(value);
  if (value.startsWith('txt:')) return false;
  return /^[a-z][a-z0-9]{1,15}:[\x21-\x7e]{1,256}$/u.test(value);
}

/** 取值解不出，是新的取值种类（或认得的种类里多出成员），还是认得的种类坏了。 */
function isFutureAnswerValue(value: unknown, controlType: ApplicationAnswerControlType): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !ENUM_TOKEN.test(kind)) return false;
  const expected = controlType === 'SINGLE_CHOICE' || controlType === 'MULTI_CHOICE'
    ? { kind: 'CHOICES', keys: ['kind', 'optionTexts'] }
    : { kind: 'TEXT', keys: ['kind', 'text'] };
  if (kind !== expected.kind) return true;
  // 认得的种类：多出成员算「这一版读不全」，跳过；成员齐全却解不出，是坏了。
  return Object.keys(record).some((key) => !expected.keys.includes(key));
}

function failure(code: AnswerMemoryFailureCode): Readonly<{ ok: false; code: AnswerMemoryFailureCode }> {
  return Object.freeze({ ok: false as const, code });
}

async function guard<T>(operation: Promise<AnswerMemoryResult<T>>, timeoutMs: number): Promise<AnswerMemoryResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AnswerMemoryResult<T>>((resolve) => {
    timer = setTimeout(() => resolve(failure('UNAVAILABLE')), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return failure('UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
