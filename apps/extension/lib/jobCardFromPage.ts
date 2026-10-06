/**
 * 从这一页读出「这个岗位」那张卡片（docs/DOCK-APPLY-FLOW.md ①）。
 *
 * ## 为什么只认标准，不认任何一家的 DOM
 *
 * RULE-GLOBAL-DOM-RULE-BOUNDARY：宿主站点的选择器与 DOM 知识只能作为
 * `packages/apply-rules/rules/*.json` 的数据维护、由后端下发并走发布治理。
 * 所以这里一条厂商选择器都没有，只读两样**跨站通用的标准**：
 *
 *  1. schema.org 的 `JobPosting`（`<script type="application/ld+json">`）
 *  2. Open Graph 的 `og:title`
 *
 * 2026-09-17 实测：Ashby 的申请页带完整 JobPosting（title / hiringOrganization /
 * jobLocation 的结构化地址）；Greenhouse 没有 ld+json，但有干净的 `og:title`
 * （就是职位名）。读这两样不是「知道某一家长什么样」，是读一份公开格式。
 *
 * ## `og:description` 是个陷阱，刻意不读
 *
 * Greenhouse 上它恰好是地点（"San Francisco Bay Area"），Ashby 上它是**整篇
 * 职位描述**（"WHO WE ARE\n\nNotion is the collaborative AI workspace…"）。
 * 拿它当地点，等于在 Ashby 上把整篇 JD 当成一行地点搬进卡片。要分辨这两种情况就得知道
 * 自己在哪一家，那正是这个模块不许知道的事。
 *
 * 所以卡片上的地点**只**来自 JobPosting 里的结构化地址。Greenhouse 上读不出地点，卡片
 * 就照实显示「未写明」——少一行，好过把一整篇 JD 摆上去。
 *
 * 唯一的例外在卡片之外（2026-09-24）：推岗位所在国家（工作授权题要用）时，`readPostingLocationNearby`
 * 在 JobPosting 一处都读不到时，才看 og:description——而且只在它短得像一个地名、页面正文里又单独写着
 * 同一句时才算（见 `readOpenGraphLocation`）。一段 JD 过不了这两道；读出来的只拿去推国家，不进卡片。
 *
 * ## 首页那张摘要卡（2026-09-24）
 *
 * 负责人要首页的岗位卡照设计展开：地点、办公方式、雇佣类型、薪资、一段简介、发布了多久。这些都只从
 * JobPosting 的结构化字段读（`jobLocationType`、`employmentType`、`baseSalary`、`datePosted`、
 * `description`），简介只取**第一段像样的正文**、去掉标签、截到三行以内——不是整篇 JD。
 * JD 原文是 Data-L1（RULE-GLOBAL-DATA-L1）：这一段只进面板，不进日志、遥测、诊断与回执。
 *
 * ## 送给 AI 代答的那一份（2026-09-24，负责人决定；argoland #620 的 `job`）
 *
 * 「自动填写」的规划请求带上岗位：职位名、公司、地点，与**整篇**描述的纯文本（去标签、还原实体、按段换行），
 * 各自截到契约的上限（`FULL_AI_JOB_LIMITS`），控制字符去掉。只从 JobPosting 读（这一页的，或同站点详情页的——
 * 与岗位卡、推国家共用那一次取数，见 `createNearbyPostingReader`）；读不出的一项就不带，一项都没有就不带 `job`。
 * 它只交给第一方 API 当不可信的上下文，仍不进日志、遥测、诊断与回执；AI 起草开放题那一路照旧只带职位名、公司、地点。
 *
 * ## 公司名为什么常常读不出来
 *
 * Greenhouse 的公司名只出现在 `document.title` 里，形如
 * 「Job Application for {职位} at {公司}」。那条正则是**厂商格式知识**，按上面
 * 那条规矩它属于规则数据，不属于这里。等规则包带上它再说。
 *
 * ## 读出来的东西去哪
 *
 * 只进面板。不进日志、不进遥测、不进回执。
 */

import { FULL_AI_JOB_LIMITS, type FullAiJob } from '@edaix/contracts';

export type PageJobCard = Readonly<{
  title: string;
  company: string;
  location: string;
}>;

export type PostingWorkMode = 'REMOTE' | 'HYBRID' | 'ONSITE';
export type PostingEmployment = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERNSHIP';
export type PostingSalaryUnit = 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type PostingSalary = Readonly<{ min: number; max: number; currency: string; unit: PostingSalaryUnit | null }>;

/** 首页那张岗位摘要卡要的几样。读不出的一项是空串或 null，卡片上就不摆那一项。 */
export type PostingFacts = Readonly<{
  /** 结构化地址拼成的一行；没有地址时退到 `applicantLocationRequirements` 里的国家（远程岗位常见）。 */
  location: string;
  workMode: PostingWorkMode | null;
  employment: PostingEmployment | null;
  salary: PostingSalary | null;
  /** 第一段像样的正文，纯文本，最多 `DESCRIPTION_MAX` 个字符。 */
  description: string;
  /** `YYYY-MM-DD`；读不出是空串。 */
  datePosted: string;
}>;

/** 首页岗位卡：`facts` 只在读到了 JobPosting（这一页或同站点的详情页）时才有。 */
export type PageJobSummary = Readonly<{ title: string; company: string; facts: PostingFacts | null }>;

/** 一个字段最多这么长。异常长的值多半不是我们以为的那个东西。 */
const FIELD_MAX = 160;
/** 简介最多这么多字符：卡片上夹到三行，多取没有用，也少留一点 JD 原文在内存里。 */
const DESCRIPTION_MAX = 280;

/*
 * 下面三道上限，是这个模块获准调用 `JSON.parse` 的代价。
 *
 * `tests/directory-parse-boundary.test.ts` 把「把网络答复变成对象」列为一项
 * 具名特权，它的原话是：把名字加进名单是有意的动作，**没想清楚形状检查在哪儿
 * 就加进去才是错**。
 *
 * 而这里的输入比那道闸设想的更糟：它不是我们自己后端的答复，是**宿主页面里的
 * 一段文本**，完全由对方控制。`JSON.parse` 本身执行不了代码，但对方可以放一段
 * 50MB 的 ld+json，或者一个嵌了十万层的数组——前者卡住主线程，后者让 `flatten`
 * 的递归爆栈。已具名的那几个解析器面对的是我们自己的后端，没有这个问题。
 *
 * 所以：先按字节截，再限递归深度，再限看几份。形状检查在 `findJobPosting`、
 * `text()` 与各个 `read*` 里——`@type` 必须恰好是 JobPosting，每个字段形状不对一律当没有。
 */
/** 超过这个长度的 ld+json 不解析。真实职位页实测在 3KB 量级。 */
const LD_JSON_MAX_CHARS = 128 * 1024;
/** `@graph` / 数组的嵌套上限。正常结构两三层就到底了。 */
const FLATTEN_MAX_DEPTH = 8;
/** 一页最多看几份 ld+json。 */
const LD_JSON_MAX_SCRIPTS = 20;

type PostingNode = Record<string, unknown>;

export function readJobCardFromPage(doc: Document): PageJobCard {
  const posting = findJobPosting(doc);
  return Object.freeze({
    title: clamp(posting === null ? metaContent(doc, 'og:title') : text(posting.title)),
    company: clamp(posting === null ? '' : companyOf(posting)),
    location: clamp(posting === null ? '' : readLocation(posting.jobLocation)),
  });
}

/** 这一页自己用 JobPosting 标准说它是一个岗位（上限与形状检查同岗位卡）。 */
export function hasJobPosting(doc: Document): boolean {
  return findJobPosting(doc) !== null;
}

/** 首页岗位卡（只看这一页）：有 JobPosting 就带上摘要；没有就只有 og:title，`facts` 为 null。 */
export function readJobSummaryFromPage(doc: Document): PageJobSummary {
  const posting = findJobPosting(doc);
  if (posting !== null) return summaryOf(posting);
  return Object.freeze({ title: clamp(metaContent(doc, 'og:title')), company: '', facts: null });
}

/**
 * 申请页的「职位详情页」：地址末尾的 `/apply` 或 `/application`（后面可以再跟**一段只由字母组成的「申请流程里的
 * 一步」**）去掉之后的那一页（同源，不带查询与片段）。不是这种地址就是 null——别的地址不猜。浮层上「查看完整岗位
 * 详情」与下面读详情页用的是同一个算法。
 *
 * 后面那一段（2026-09-24）：Workday 的申请页是 `…/job/<地点>/<职位>_<编号>/apply`，选了怎么申请之后变成
 * `…/apply/applyManually`、`…/apply/autofillWithResume`、`…/apply/useMyLastApplication`；详情页
 * `…/job/<地点>/<职位>_<编号>` 的 HTML 带着完整的 JobPosting（当天实测 NVIDIA）。这里不认 Workday，认形状：
 * 那一段只有字母（一步的名字，不是编号：带数字、带点、不止一段的一概不认），而且只认紧跟在 `/apply` 后面的一段。
 */
export function detailPageUrl(href: string): string | null {
  let current: URL;
  try {
    current = new URL(href);
  } catch {
    return null;
  }
  if (current.protocol !== 'https:' && current.protocol !== 'http:') return null;
  if (!APPLY_SUFFIX.test(current.pathname)) return null;
  const pathname = current.pathname.replace(APPLY_SUFFIX, '');
  // 去掉之后只剩站点首页的，不是一个岗位的详情页。
  if (pathname === '' || pathname === '/' || pathname === current.pathname) return null;
  const detail = new URL(current.origin);
  detail.pathname = pathname;
  return detail.toString();
}

/** `/apply` 或 `/application`，可以再跟一段只由字母组成的一步（最多 40 个字母），末尾的斜杠可有可无。 */
const APPLY_SUFFIX = /\/(?:apply|application)(?:\/[a-z]{1,40})?\/?$/iu;

/**
 * 申请页自己没有 JobPosting 时，去**同一站点**上的职位详情页读地点（2026-09-24）。
 *
 * 2026-09-23 实测：Jobvite（`…/job/<id>/apply`）与 Lever（`…/<uuid>/apply`）的申请页都没有 ld+json，
 * 详情页（去掉末尾的 `/apply`）才有。读不出岗位地点，「在岗位所在国家是否有工作授权」「是否需要担保」
 * 这两题就只能交还用户（JOB_DEPENDENT），而竞品按详情页上的 United States 答上了。
 *
 * 仍然只读公开标准，不认任何一家的 DOM：取的是「申请页地址去掉 `/apply` 或 `/application`」那一页，
 * 读的仍是它的 JobPosting。几道闸：
 *  · 当前页自己带着地点就直接用，不多取一页（Ashby 的 /application 页就带着）；
 *  · 只在地址以 `/apply` 或 `/application`（后面可以再跟一段只由字母组成的一步，见 `detailPageUrl`）结尾时才取，
 *    别的地址不猜；
 *  · 只取同源；跳转到别的站点、不是网页、状态不是 2xx、超时，一律当读不出；
 *  · 正文只读前面一截（`maxChars`），解析交给 DOMParser（不执行脚本），ld+json 仍走上面那几道上限。
 *
 * 取回来的页面只在内存里解析、只留地点那一行；不进日志、不进遥测、不进回执（RULE-GLOBAL-DATA-L1）。
 * 读不出就是空串——调用方把它当「不知道岗位在哪」，与从前一样交还用户。
 *
 * 这一版每次调用各取各的；同一页上岗位卡与填写共用一次取数，用 `createNearbyPostingReader`。
 */
export async function readPostingLocationNearby(
  doc: Document,
  href: string,
  deps: NearbyDeps = {},
): Promise<string> {
  return createNearbyPostingReader(deps).location(doc, href);
}

type NearbyDeps = Readonly<{ fetch?: typeof fetch; timeoutMs?: number; maxChars?: number }>;

export interface NearbyPostingReader {
  /** 首页岗位卡：这一页的 JobPosting；没有就读同站点的详情页。都读不出是 null。 */
  readonly summary: (doc: Document, href: string) => Promise<PageJobSummary | null>;
  /** 与 `readPostingLocationNearby` 同一个口径（这一页有地点就不取），走同一次取数。 */
  readonly location: (doc: Document, href: string) => Promise<string>;
  /**
   * 送给 AI 代答的岗位（`job`）：这一页的 JobPosting；没有就读同站点的详情页（同一次取数）。一项都读不出是 undefined。
   */
  readonly job: (doc: Document, href: string) => Promise<FullAiJob | undefined>;
}

/**
 * 同一页只取一次详情页（2026-09-24）：面板打开时岗位卡要它，按下「自动填写」时工作授权推国家也要它——
 * 两处共用同一次同源取数，时限与读取上限不变，不新增任何权限。超时、断网这种一时的失败不记住，
 * 下一次要的时候再取；取到了（哪怕那一页没有 JobPosting）就记住，这一页不再重取。
 */
export function createNearbyPostingReader(deps: NearbyDeps = {}): NearbyPostingReader {
  const reads = new Map<string, Promise<DetailRead>>();
  const detail = (href: string): Promise<DetailRead> => {
    const url = detailPageUrl(href);
    if (url === null) return Promise.resolve(NO_DETAIL);
    const known = reads.get(url);
    if (known !== undefined) return known;
    const pending = fetchDetailPosting(url, deps);
    reads.set(url, pending);
    void pending.then((read) => {
      if (!read.settled && reads.get(url) === pending) reads.delete(url);
    });
    return pending;
  };
  return Object.freeze({
    summary: async (doc: Document, href: string): Promise<PageJobSummary | null> => {
      const here = findJobPosting(doc);
      if (here !== null) return summaryOf(here);
      const read = await detail(href);
      return read.posting === null ? null : summaryOf(read.posting);
    },
    location: async (doc: Document, href: string): Promise<string> => {
      const here = findJobPosting(doc);
      const hereLocation = here === null ? '' : readLocation(here.jobLocation);
      if (hereLocation !== '') return clamp(hereLocation);
      const read = await detail(href);
      const detailLocation = read.posting === null ? '' : readLocation(read.posting.jobLocation);
      if (detailLocation !== '') return clamp(detailLocation);
      // 连详情页也没有 JobPosting（Greenhouse 的 job-boards 页本身就是职位页，2026-09-24）：页面上单独写着的
      // og:description 才算（见 `readOpenGraphLocation`）。只拿去推国家，不进卡片。
      return clamp(readOpenGraphLocation(doc));
    },
    job: async (doc: Document, href: string): Promise<FullAiJob | undefined> => {
      const here = findJobPosting(doc);
      if (here !== null) return jobOf(here);
      const read = await detail(href);
      return read.posting === null ? undefined : jobOf(read.posting);
    },
  });
}

/** 契约只收可打印字符（制表、换行、回车除外）。 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;

/** 截到上限：尽量断在换行或空格上（最后 200 个字符里找），截不到就硬截。 */
function cut(value: string, max: number): string {
  const plain = value.replace(CONTROL, ' ').replace(/[ \t]{2,}/gu, ' ').trim();
  if (plain.length <= max) return plain;
  const head = plain.slice(0, max);
  const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
  return (at > max - 200 ? head.slice(0, at) : head).trim();
}

function jobOf(posting: PostingNode): FullAiJob | undefined {
  const address = readLocation(posting.jobLocation);
  const description = typeof posting.description === 'string'
    ? paragraphsOf(posting.description.slice(0, LD_JSON_MAX_CHARS)).join('\n')
    : '';
  const job: Record<string, string> = {
    title: cut(text(posting.title), FULL_AI_JOB_LIMITS.title),
    company: cut(companyOf(posting), FULL_AI_JOB_LIMITS.company),
    location: cut(address !== '' ? address : readCountries(posting.applicantLocationRequirements), FULL_AI_JOB_LIMITS.location),
    description: cut(description, FULL_AI_JOB_LIMITS.description),
  };
  const stated = Object.entries(job).filter(([, value]) => value !== '');
  return stated.length === 0 ? undefined : Object.freeze(Object.fromEntries(stated)) as FullAiJob;
}

/** `settled`：得到了确定的答复（页面在、不在、没有 JobPosting 都算）；超时与断网不算，下一次再取。 */
type DetailRead = Readonly<{ posting: PostingNode | null; settled: boolean }>;
const NO_DETAIL: DetailRead = Object.freeze({ posting: null, settled: true });

/** 详情页最多等这么久：它跟档案、简历问询并行，慢了就当读不出，不拖住填写。 */
const DETAIL_TIMEOUT_MS = 1500;
/**
 * 详情页正文最多读这么多字符。从前是 40 万、理由是「ld+json 在 head 里」——2026-09-24 实测 Lever 的详情页
 * 73 万字符，head 里两段各 35 万的内联样式，JobPosting 在 body 末尾（第 716,813 个字符）。读到一份完整的
 * JobPosting 就停，所以多数页面读不到这么多。
 */
const DETAIL_MAX_CHARS = 1_500_000;

async function fetchDetailPosting(url: string, deps: NearbyDeps): Promise<DetailRead> {
  const origin = new URL(url).origin;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DETAIL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      credentials: 'same-origin',
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = response.url === '' ? url : response.url;
    if (!response.ok || new URL(finalUrl).origin !== origin) return NO_DETAIL;
    if (!/\btext\/html\b/iu.test(response.headers.get('content-type') ?? '')) return NO_DETAIL;
    const scripts = await readLdJsonScripts(response, deps.maxChars ?? DETAIL_MAX_CHARS, controller.signal);
    if (scripts === null) return Object.freeze({ posting: null, settled: false });
    return Object.freeze({ posting: findJobPostingInScripts(scripts), settled: true });
  } catch {
    // 超时、断网、被中止：一时的，不记住。
    return Object.freeze({ posting: null, settled: false });
  } finally {
    clearTimeout(timer);
  }
}

/** 一段 HTML 文本里**已经收尾**的 ld+json 脚本正文（`<script type="application/ld+json">…</script>`）。 */
const LD_JSON_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/giu;

function ldJsonScriptsIn(html: string): string[] {
  return [...html.matchAll(LD_JSON_SCRIPT)].map((match) => match[1] ?? '');
}

/**
 * 边读边找 ld+json：只留脚本正文，读到一份认得出的 JobPosting 就停，最多读 `maxChars` 个字符。
 * 不把整页交给 DOMParser——页面其余部分我们用不上，那几十万字符的样式也不该在内容脚本里再建一遍树。
 */
async function readLdJsonScripts(response: Response, maxChars: number, signal: AbortSignal): Promise<string[] | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const whole = await response.text();
    return ldJsonScriptsIn(whole.slice(0, maxChars));
  }
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < maxChars) {
      if (signal.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      // 块边界上可能刚好切在一段脚本中间：只看已经收尾的那几段，没收尾的下一块再看。
      if (out.includes('JobPosting') && findJobPostingInScripts(ldJsonScriptsIn(out)) !== null) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return ldJsonScriptsIn(out.slice(0, maxChars));
}

/**
 * og:description 当岗位地点，只在它**看起来是一个地名、而且页面上单独写着同一句**时（2026-09-24）。
 *
 * Greenhouse 的 job-boards 页没有 JobPosting，地点只写在 og:description（「Remote - Estonia」）与标题下面那
 * 一行。别家的 og:description 是一段 JD（Ashby、Lever、Workable、BambooHR、Rippling 当天实测都是）——要分辨
 * 就得知道自己在哪一家，那正是这个模块不许知道的事。所以不认厂商，认形状：
 *  · 短（`OG_LOCATION_MAX_CHARS` 以内、不超过 `OG_LOCATION_MAX_WORDS` 个词）、一行、不以句号问号叹号收尾；
 *  · 页面正文里有一段文字**恰好就是它**（宿主把它当成一行单独的标签摆出来，不是 JD 里的半句话）。
 * 读出来的只拿去推国家（调用方的 `inferRegionCode` 还要求恰好解出一国）；不进卡片、不进日志。
 */
export function readOpenGraphLocation(doc: Document): string {
  const raw = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '';
  if (/[\r\n]/u.test(raw.trim())) return '';
  const candidate = text(raw);
  if (candidate === '' || candidate.length > OG_LOCATION_MAX_CHARS) return '';
  if (candidate.split(' ').length > OG_LOCATION_MAX_WORDS) return '';
  if (/[.!?。！？]$/u.test(candidate)) return '';
  return pageShowsAlone(doc, candidate) ? candidate : '';
}

const OG_LOCATION_MAX_CHARS = 80;
const OG_LOCATION_MAX_WORDS = 10;
/** 找那一行字最多看这么多个文本节点：地点写在标题下面，页面前面一截就有。 */
const PAGE_TEXT_NODE_BUDGET = 5_000;

/** 页面正文里有没有一个文本节点，去掉首尾空白、折叠空白之后恰好就是 `wanted`。 */
function pageShowsAlone(doc: Document, wanted: string): boolean {
  const body = doc.body;
  if (body === null) return false;
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let seen = 0; seen < PAGE_TEXT_NODE_BUDGET; seen += 1) {
    const node = walker.nextNode();
    if (node === null) return false;
    const value = node.nodeValue ?? '';
    if (value.length > wanted.length * 2 + 16) continue;
    if (text(value) === wanted) return true;
  }
  return false;
}

function findJobPosting(doc: Document): PostingNode | null {
  return findJobPostingInScripts(
    [...doc.querySelectorAll('script[type="application/ld+json"]')].map((script) => script.textContent ?? ''),
  );
}

/** 一串 ld+json 脚本正文里第一份 JobPosting（这一页的，或详情页边读边切出来的）；上限与形状检查见文件头那几道。 */
function findJobPostingInScripts(scripts: readonly string[]): PostingNode | null {
  let examined = 0;
  for (const raw of scripts) {
    if (examined >= LD_JSON_MAX_SCRIPTS) break;
    examined += 1;
    // 先量长度再解析：解析一段 50MB 的文本，卡住的是用户正在读的那个页面。
    if (raw.length === 0 || raw.length > LD_JSON_MAX_CHARS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 一份坏掉的 ld+json 不该让整页读不出卡片；接着看下一份。
      continue;
    }
    // 一个页面可以放多份、也可以放一个数组，还可以用 @graph 包起来。
    for (const node of flatten(parsed)) {
      if (isRecord(node) && hasType(node['@type'], 'JobPosting')) return node;
    }
  }
  return null;
}

function companyOf(posting: PostingNode): string {
  return isRecord(posting.hiringOrganization) ? text(posting.hiringOrganization.name) : '';
}

function summaryOf(posting: PostingNode): PageJobSummary {
  return Object.freeze({ title: clamp(text(posting.title)), company: clamp(companyOf(posting)), facts: factsOf(posting) });
}

function factsOf(posting: PostingNode): PostingFacts {
  const address = readLocation(posting.jobLocation);
  return Object.freeze({
    location: clamp(address !== '' ? address : readCountries(posting.applicantLocationRequirements)),
    workMode: readWorkMode(posting.jobLocationType, address),
    employment: readEmployment(posting.employmentType),
    salary: readSalary(posting.baseSalary),
    description: readDescription(posting.description),
    datePosted: readDate(posting.datePosted),
  });
}

/**
 * 结构化地址拼成一行人话。
 *
 * 只取 locality / region / country 三项，**不取 streetAddress 与 postalCode**：
 * 卡片要回答的是「这岗位在哪个城市」，一个街道门牌对那个问题没有帮助，而且
 * 那是雇主办公地址，摆在用户的面板上没有理由。
 */
function readLocation(value: unknown): string {
  for (const node of flatten(value)) {
    if (!isRecord(node)) continue;
    const address = isRecord(node.address) ? node.address : node;
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map(text)
      .filter((part) => part !== '');
    if (parts.length > 0) return parts.join(', ');
  }
  return '';
}

/** 远程岗位常只写「申请人要在哪些国家」：取名字、去重，最多三个。只给卡片看，不用来推工作授权。 */
function readCountries(value: unknown): string {
  const names: string[] = [];
  for (const node of flatten(value)) {
    const name = isRecord(node) ? text(node.name) : text(node);
    if (name !== '' && !names.some((known) => known.toLowerCase() === name.toLowerCase())) names.push(name);
    if (names.length === 3) break;
  }
  return names.join(', ');
}

/** `TELECOMMUTE` 是远程；否则看 jobLocationType 与地点那一行里有没有写 hybrid / remote / on-site。 */
function readWorkMode(type: unknown, location: string): PostingWorkMode | null {
  const types = flatten(type).map((item) => text(item));
  if (types.some((item) => item.toUpperCase() === 'TELECOMMUTE')) return 'REMOTE';
  const said = [...types, location].join(' ');
  if (/\bhybrid\b/iu.test(said)) return 'HYBRID';
  if (/\bremote\b/iu.test(said)) return 'REMOTE';
  if (/\b(?:on[\s-]?site|in[\s-]?office)\b/iu.test(said)) return 'ONSITE';
  return null;
}

const EMPLOYMENT: Readonly<Record<string, PostingEmployment>> = Object.freeze({
  FULL_TIME: 'FULL_TIME', FULLTIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME', PARTTIME: 'PART_TIME',
  CONTRACT: 'CONTRACT', CONTRACTOR: 'CONTRACT',
  INTERN: 'INTERNSHIP', INTERNSHIP: 'INTERNSHIP',
});

/** schema.org 的写法（FULL_TIME），也认各家的小写连字符写法（full-time）；只认这四种，别的不摆。 */
function readEmployment(value: unknown): PostingEmployment | null {
  for (const item of flatten(value)) {
    for (const part of text(item).split(/[,/]/u)) {
      const hit = EMPLOYMENT[part.trim().toUpperCase().replace(/[\s-]+/gu, '_')];
      if (hit !== undefined) return hit;
    }
  }
  return null;
}

/** `baseSalary`：MonetaryAmount，金额是一个数、或 QuantitativeValue 的 value / minValue–maxValue。 */
function readSalary(value: unknown): PostingSalary | null {
  for (const node of flatten(value)) {
    if (!isRecord(node)) continue;
    const currency = text(node.currency).toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) continue;
    let min: number | null = amountOf(node.value);
    let max: number | null = min;
    let unit: unknown = node.unitText;
    if (min === null && isRecord(node.value)) {
      const quantity = node.value;
      const single = amountOf(quantity.value);
      min = amountOf(quantity.minValue) ?? single;
      max = amountOf(quantity.maxValue) ?? single;
      min ??= max;
      max ??= min;
      unit = quantity.unitText ?? unit;
    }
    if (min === null || max === null) continue;
    return Object.freeze({ min: Math.min(min, max), max: Math.max(min, max), currency, unit: salaryUnit(unit) });
  }
  return null;
}

function amountOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\s*\d[\d,]*(?:\.\d+)?\s*$/u.test(value) ? Number(value.replace(/,/gu, ''))
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1e9 ? parsed : null;
}

function salaryUnit(value: unknown): PostingSalaryUnit | null {
  const raw = text(value).toUpperCase();
  if (/^HOUR/u.test(raw)) return 'HOUR';
  if (/^DAY/u.test(raw)) return 'DAY';
  if (/^WEEK/u.test(raw)) return 'WEEK';
  if (/^MONTH/u.test(raw)) return 'MONTH';
  if (/^(?:YEAR|ANNUAL)/u.test(raw)) return 'YEAR';
  return null;
}

function readDate(value: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text(value));
  if (match === null) return '';
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? match[0] : '';
}

/**
 * 简介：JobPosting 的 description（多半是 HTML，偶尔是转义过一次的 HTML、或纯文本）去掉标签，
 * 按段落切开，取**第一段像样的正文**——跳过「About Ramp」「WHO WE ARE」「What you'll do:」这种小标题。
 * 一段都不够长就取最长的那段。截到 `DESCRIPTION_MAX` 以内，结果只是一段纯文本。
 */
function readDescription(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const paragraphs = paragraphsOf(value.slice(0, LD_JSON_MAX_CHARS));
  const chosen = paragraphs.find(meaningful) ?? paragraphs.reduce((best, one) => (one.length > best.length ? one : best), '');
  return clip(chosen, DESCRIPTION_MAX);
}

const TAG = /<\/?[a-z][^>]*>/iu;

/** 转义过的标签：`&lt;p`，或者转义了不止一次的 `&amp;lt;p`、`&amp;amp;lt;p`。 */
const ESCAPED_TAG = /&(?:amp;)*lt;\/?[a-z]/iu;

function paragraphsOf(raw: string): string[] {
  let source = raw;
  // 转义过一次的 HTML（`&lt;p&gt;…`）、甚至两次的（`&amp;lt;p&amp;gt;…`，2026-10-04 Brex 官网的 JobPosting）：一层一层还原，
  // 直到读得出标签为止（至多三层），再当 HTML 读。从前只还原一层，岗位卡上显示的是「&lt;div class=…」原文。
  for (let layer = 0; layer < 3 && !TAG.test(source) && ESCAPED_TAG.test(source); layer += 1) source = decodeEntities(source);
  const plain = TAG.test(source) ? htmlToText(source) : decodeEntities(source);
  return plain.split(/\n+/u).map((line) => line.replace(/\s+/gu, ' ').trim()).filter((line) => line !== '');
}

/** 块级标签与 <br> 换成换行、其余标签去掉、实体还原。只产出文字，结果只会被当作文字显示。 */
function htmlToText(html: string): string {
  const marked = html
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<br\b[^>]*>/giu, '\n')
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|section|article|header|footer|blockquote|tr|table|dl|dt|dd|hr)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, '');
  return decodeEntities(marked);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·',
});

/** 实体还原：浏览器里交给 DOMParser 的 textarea（RCDATA：只还原实体、不建任何元素）；别处用一张小表。 */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  if (typeof DOMParser === 'function') {
    const parsed = new DOMParser().parseFromString(`<textarea>${value.replace(/<\/textarea/giu, '')}</textarea>`, 'text/html');
    const decoded = parsed.querySelector('textarea')?.textContent;
    if (typeof decoded === 'string') return decoded;
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** 一段话够不够「像样」：中日韩文字按两个宽度算，至少 60 个宽度；以冒号结尾的是小标题。 */
function meaningful(paragraph: string): boolean {
  let width = 0;
  for (const char of paragraph) width += /[぀-ヿ㐀-鿿가-힯]/u.test(char) ? 2 : 1;
  return width >= 60 && !/[:：]$/u.test(paragraph);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const body = space > max - 40 ? cut.slice(0, space) : cut;
  return `${body.replace(/[\s,.;:，。；：、]+$/u, '')}…`;
}

/**
 * 数组、`@graph`、单个对象，摊成一串节点。
 *
 * 带深度上限：这段文本是对方写的，一个嵌了十万层的数组会让这里爆栈，而爆栈
 * 发生在用户的申请页上。到顶就停，当作读不出来——读不出卡片只是少一张卡片。
 */
function flatten(value: unknown, depth = 0): readonly unknown[] {
  if (depth >= FLATTEN_MAX_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, depth + 1));
  if (isRecord(value) && '@graph' in value) return flatten(value['@graph'], depth + 1);
  return value === null || value === undefined ? [] : [value];
}

/** `@type` 可以是字符串，也可以是字符串数组。 */
function hasType(value: unknown, wanted: string): boolean {
  return Array.isArray(value) ? value.some((item) => item === wanted) : value === wanted;
}

function metaContent(doc: Document, property: string): string {
  const meta = doc.querySelector(`meta[property="${property}"]`);
  return text(meta?.getAttribute('content'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 一个 HTML 实体（`&amp;`、`&#38;`、`&#x26;`）。 */
const ENTITY = /&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/iu;

/**
 * JobPosting 里的一项纯文字（岗位名、公司、地点……）。JSON 字符串里本不该有 HTML 实体，可不少站点照样放
 * （2026-10-04，Lever shieldai：「Aerodynamics &amp; Performance Engineer」，岗位卡上显示的就是「&amp;」），
 * 有的还转义了不止一次：一层一层还原成字（至多三层）。本来就是字的「&」「<」照旧是字。
 */
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  let source = value;
  for (let layer = 0; layer < 3 && ENTITY.test(source); layer += 1) source = decodeEntities(source);
  return source.replace(/\s+/gu, ' ').trim();
}

function clamp(value: string | undefined): string {
  return (value ?? '').slice(0, FIELD_MAX);
}
