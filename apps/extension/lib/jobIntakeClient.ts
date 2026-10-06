import {
  createApplicationPageContext,
  parseCreateApplicationPageContextResponse,
} from '@edaix/contracts';

/**
 * 把这一页的岗位认出来，作为申请卡片与后续 mission 的起点。
 *
 * URL 在 worker 里由 sender 已登记的那一页拼出来，不取自页面：内容脚本可以报告
 * 「有人按了」，但不能指定要加什么。
 *
 * ## 2026-09-18：从 `jobs/from-url` 改指 `missions/page-context`
 *
 * 前者**在 argoland 里没有控制器**，生产返回 404——实测点「生成申请卡片」
 * 没有任何反应，整个产品卡在这一步（没有 job 就没有 mission，没有 mission 就
 * 没有 Autofill）。
 *
 * 后者收同样的输入（canonicalOrigin + pathname），而且一次给全三样东西：
 *
 *   canonicalJobId  建 mission 要它
 *   job.jobId       就是 catalogSelector，`cover-letter/requirement` 要的正是它
 *   job.title/company  申请卡片要显示的，比从页面 DOM 刮出来的可靠
 */
export type JobIntakeView = Readonly<{
  canonicalJobId: string;
  /** catalogSelector：后续按岗位提问（求职信要不要等）都用它。 */
  jobSelector: string;
  title: string;
  company: string;
  canonicalOrigin: string;
  applicationPathname: string;
}>;

export type JobIntakeOutcome =
  /**
   * 认出来了。
   *
   * 不再区分 ADDED / ALREADY_PRESENT：`page-context` 对「刚建的」与「本来就有的」
   * 返回同一个形状，而这个区别对用户下一步也没有意义——他要的是那张卡片。
   */
  | Readonly<{ kind: 'RESOLVED'; job: JobIntakeView }>
  /** A stable backend code, or a local one. Never a message, never a field value. */
  | Readonly<{ kind: 'REFUSED'; code: string }>;

export interface JobIntakeClient {
  add(canonicalOrigin: string, pathname: string): Promise<JobIntakeOutcome>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createJobIntakeClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  requestId?: () => string;
  timeoutMs?: number;
}>): JobIntakeClient {
  const fetchFn = input.fetchFn ?? fetch;
  const requestId = input.requestId ?? (() => crypto.randomUUID());
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    async add(canonicalOrigin: string, pathname: string): Promise<JobIntakeOutcome> {
      const outcome = await withDeadline(attempt(canonicalOrigin, pathname), timeoutMs);
      return outcome ?? { kind: 'REFUSED', code: 'JOB_INTAKE_UNAVAILABLE' };
    },
  });

  async function attempt(canonicalOrigin: string, pathname: string): Promise<JobIntakeOutcome> {
    let token = await input.getAccessToken();
    if (token === null || token === '') return { kind: 'REFUSED', code: 'JOB_INTAKE_NO_SESSION' };
    let response = await post(canonicalOrigin, pathname, token);
    if (response.status === 401 && input.refreshAccessToken) {
      token = await input.refreshAccessToken();
      if (token === null || token === '') return { kind: 'REFUSED', code: 'JOB_INTAKE_NO_SESSION' };
      response = await post(canonicalOrigin, pathname, token);
    }
    if (response.status !== 200) {
      // The backend's own stable code when it gave one; nothing else is read out
      // of an error body.
      const code = await refusalCode(response);
      return { kind: 'REFUSED', code };
    }
    const decoded = parseCreateApplicationPageContextResponse(await safeJson(response));
    if (decoded === null) return { kind: 'REFUSED', code: 'JOB_INTAKE_UNREADABLE' };
    // 只投影面板与后续调用真正用得上的那几项。答复里还有 conversationId，
    // 那是门户那边的东西，让它跨进宿主页面所在的进程没有理由。
    return {
      kind: 'RESOLVED',
      job: {
        canonicalJobId: decoded.canonicalJobId,
        jobSelector: decoded.job.jobId,
        title: decoded.job.title,
        company: decoded.job.company,
        canonicalOrigin: decoded.page.canonicalOrigin,
        applicationPathname: decoded.page.pathname,
      },
    };
  }

  function post(canonicalOrigin: string, pathname: string, token: string): Promise<Response> {
    return fetchFn(new URL(createApplicationPageContext.path, input.apiBase).toString(), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        clientRequestId: requestId(),
        canonicalOrigin,
        pathname,
        // 面板的文案是中文，但这一项决定的是**后端生成的内容**用哪种语言。
        // 先跟面板一致；等面板支持切换时由调用方传进来。
        generationLocale: 'zh-CN',
      }),
    });
  }
}

async function refusalCode(response: Response): Promise<string> {
  const body = await safeJson(response);
  const code = (body as { code?: unknown; message?: unknown } | null)?.code
    ?? (body as { message?: unknown } | null)?.message;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : 'JOB_INTAKE_UNAVAILABLE';
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}
