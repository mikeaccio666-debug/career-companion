import { hasApplyAdapter, isAccountFormPath, isApplyFormPath } from '@edaix/apply-kernel/registry';
import { detectApplyVendor, type ApplyVendor } from '@edaix/apply-kernel/vendors';
import { autofillPanelAffordance, type AutofillAffordance } from '../product-panel/affordance';

/**
 * Which vendors the dock will surface itself on.
 *
 * This used to be a hand-kept list of one. That made "which ATS do we support"
 * two facts that had to be kept in step -- the adapter registry and this list --
 * and they would drift the first time an adapter landed without someone
 * remembering to widen the list here.
 *
 * It is the registry's answer now. `hasApplyAdapter` is true exactly for a
 * vendor with a real adapter, and deliberately false for the ones whose
 * recognition assets exist but whose production mapping has not shipped
 * (`workday`, `avature` are null in ADAPTERS for that reason). So a vendor
 * becomes supported by landing its adapter, in one place, and nothing here has
 * to be edited to keep up.
 */
export function dockSurfacesOn(vendor: ApplyVendor | null): boolean {
  return vendor !== null && hasApplyAdapter(vendor);
}

/**
 * The face a page may show, decided in the background.
 *
 * Decided here rather than in the content script: whether this browser is connected
 * and whether the page belongs to a Mission only exist in the background. For a
 * host in the vendor table everything used is URL-only. For any other host the
 * URL says nothing, so the content script's read-only evidence decides (vendor
 * fingerprint, one generic application form, JobPosting data — `lib/pageEvidence.ts`);
 * without any of it the page shows nothing at all (2026-09-24: the store package
 * injects everywhere, and a dock on Wikipedia is a bug, not reachability).
 */
export function dockFaceForPage(input: Readonly<{
  canonicalOrigin: string;
  pathname: string;
  connected: boolean;
  missionBound: boolean;
  /**
   * Keep the launcher on job pages no application form was recognised on.
   *
   * Injection is network-wide, because white-label and employer-owned application
   * domains cannot be enumerated. Recognition is what is narrow -- and being
   * unrecognised on a job page is not a reason to be unreachable: the user may be
   * on a posting whose vendor we have not modelled, and the honest answer is a tab
   * they can open, not silence. A job page is a vendor host, a vendor fingerprint,
   * or a page that declares a JobPosting; every other page shows nothing.
   */
  reachableOnJobPages?: boolean;
  /** 这一次有没有拿到规则包；省略时按「拿到了」算。 */
  rulesAvailable?: boolean;
  /**
   * 这一页运行在子帧里（P2-10）。只有这样声明，规则里的嵌入路径（Greenhouse 的
   * `/embed/job_app`）才算申请页；顶层帧上它照旧不是。
   */
  embedded?: boolean;
  /**
   * 白标 B（P2-11）：主机不在厂商表里时内容脚本给的「先试哪家」。只在主机表答不出时才用，
   * 且只对声明了 `whitelabelRoot` 退路的厂商成立（`isApplyFormPath(…, { whitelabel: true })`）。
   */
  vendorHint?: ApplyVendor | null;
  /** 通用路（主机表与指纹都答不出）：内容脚本在这一页上看见了恰好一张通用申请表。只是提示。 */
  genericForm?: boolean;
  /** 那张表里还有求职信号（简历、学历那一节、LinkedIn、工作授权、GitHub、期望薪资……）。只是提示。 */
  genericJobForm?: boolean;
  /** 页面自己用 JobPosting 标准说它是一个岗位。只是提示，只换来一个标签。 */
  jobPosting?: boolean;
  /** 我们自己的门户与后端（`https://` origin）：那里的表不是申请表，一律不挂。 */
  ownOrigins?: readonly string[];
  /**
   * 这一次拿到的运行时包放行了哪几家（`bundleOpenVendors`，2026-10-04）。不在里面的那一家：认得出申请表也不亮「自动填写」、
   * 不自动打开，照实说「这类网站还没开放自动填写」——从前亮着按钮，按下去才说「暂时连不上 ArgoLand」（bench-1003：
   * 生产包还没放行公司自建表单，9/9 页都是这句错话）。不传 = 不知道，照旧（填写那一刻仍会按包再判一次）。
   */
  openVendors?: ReadonlySet<string> | null;
}>): AutofillAffordance {
  let hostname: string;
  try {
    hostname = new URL(input.canonicalOrigin).hostname;
  } catch {
    // An origin we cannot parse is not an origin we may stand on.
    return { kind: 'HIDDEN' };
  }
  // 门户资料页那张表认得的字段再多，也不是申请表。
  if (input.ownOrigins?.includes(input.canonicalOrigin) === true) return { kind: 'HIDDEN' };
  const page = pageVendor(hostname, input.vendorHint ?? null);
  // 通用路上只凭内容脚本看见的那张表（`genericApplyFormEvidence`），而且要有求职信号（2026-09-25：「联系销售」表单
  // 也认得够字段，测试台上 Zendesk、DocuSign、HubSpot 都自动弹出了浮层）：表里有只有求职才问的栏、页面声明了
  // JobPosting，或网址自己说它是招聘页。
  const jobUrl = page.generic && jobLikeUrl(hostname, input.pathname);
  const jobSignal = input.genericJobForm === true || input.jobPosting === true || jobUrl;
  const onApplyFormPath = page.vendor !== null &&
    (!page.generic || (input.genericForm === true && jobSignal)) &&
    recognisedApplyPage(page.vendor, input.pathname, input.embedded === true, page.whitelabel, page.generic);
  // 招聘相关的页面才值得一个标签：厂商主机、白标指纹、页面自己声明的 JobPosting，或招聘页的网址。别的网站（百科、
  // 新闻、搜索、联系销售）什么都不挂——没登录、取不到规则时也一样，不在那里说「先登录」。
  const jobPage = !page.generic || input.jobPosting === true || jobUrl;
  if (!onApplyFormPath && !jobPage) return { kind: 'HIDDEN' };
  // 认出了申请表，但这一家此刻没放行（运行时包里的厂商位关着）：说实话，不亮按钮。没拿到规则时照旧说「暂时没法判断」。
  if (onApplyFormPath && input.rulesAvailable !== false && vendorClosed(page.vendor, input.openVendors)) {
    return { kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' };
  }
  return autofillPanelAffordance({
    site: null,
    onApplyFormPath,
    connected: input.connected,
    missionBound: input.missionBound,
    reachableWhenUnrecognised: input.reachableOnJobPages === true,
    ...(input.rulesAvailable === undefined ? {} : { rulesAvailable: input.rulesAvailable }),
  });
}

/** 这一家在这一次拿到的包里没放行。不知道（没给）就不算没放行。 */
function vendorClosed(vendor: ApplyVendor | null, openVendors: ReadonlySet<string> | null | undefined): boolean {
  return vendor !== null && openVendors !== null && openVendors !== undefined && !openVendors.has(vendor);
}

/**
 * URL-only：认得的厂商 + 它声明的申请路径（子帧再多认规则点名的嵌入路径）。
 * 白标与通用都不看路径——那两条路上本家的路径知识不适用，闸在 DOM 里。
 * 本家主机上规则声明的账号页（iCIMS 的 …/login，2026-09-28）也算：那一页上的「注册／登录并自动填写」接着就填申请表。
 */
function recognisedApplyPage(
  vendor: ApplyVendor | null,
  pathname: string,
  embedded: boolean,
  whitelabel = false,
  generic = false,
): boolean {
  return dockSurfacesOn(vendor) &&
    (isApplyFormPath(vendor as ApplyVendor, pathname, { embedded, whitelabel, generic }) ||
      (!whitelabel && !generic && isAccountFormPath(vendor as ApplyVendor, pathname)));
}

/**
 * 网址自己说它是招聘页（2026-09-25，URL-only）：主机名第一段是 careers／jobs／recruiting／talent／hiring，或路径里有一段是
 * careers、jobs、job、vacancies、recruiting、talent、hiring、join-us、work-with-us（德语 karriere、stellenangebote），
 * 或以 careers-、jobs- 打头。单独的 apply 不算——信用卡、贷款、签证、学校申请都叫 apply；job_application 这样的
 * 一整段（维基百科的词条名）也不算。
 */
const JOB_HOST_LABEL = /^(?:careers?|jobs|recruit(?:ing|ment)?|talent|hiring)$/u;
const JOB_PATH_SEGMENT =
  /^(?:careers?|jobs|job|job-openings|vacanc(?:y|ies)|recruit(?:ing|ment)|talent(?:-acquisition)?|hiring|join-us|work-with-us|karriere|stellenangebote)$|^(?:careers|jobs)-/u;

export function jobLikeUrl(hostname: string, pathname: string): boolean {
  if (JOB_HOST_LABEL.test(hostname.toLowerCase().split('.')[0] ?? '')) return true;
  return pathname.toLowerCase().split('/').some((segment) => JOB_PATH_SEGMENT.test(segment));
}

/**
 * 这一页按哪家的规则来。三层，次序是纪律：
 *
 *  1. **主机表**（P2-11）：`detectApplyVendor` 答得出就照它，一个字不变。
 *  2. **白标**（P2-11）：主机表答不出时才看内容脚本给的指纹提示，并且从此以白标身份走
 *     ——路径不看本家的，容器要过 `whitelabelRoot` 那道闸。
 *  3. **通用**（2026-09-22）：两样都答不出。公司自建域名上既没有本家路径也没有本家
 *     id 钩子，唯一立得住的判据是「这一张表里有几个字段我们认得」——那是
 *     `genericRoot`（`generic.json`）。
 *
 * 一层都不许往前插：认得出是哪一家时，那一家的锚点与 id 钩子比数字段准得多；
 * 通用路是最后的退路，不是并列的候选。
 *
 * 这里只负责「去问一句」，**不是准入闸**。真正的三道闸都在后端那一侧：包里要有
 * GENERIC 的精确映射（否则 `RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE`）、包里的 policy
 * 厂商位要开（否则 `RUNTIME_AUTHORITY_POLICY_DISABLED`）、装上之后 `resolveRoot`
 * 还要在 DOM 里数够 `minKeyedFields` 个字段。缺任何一道，这一层问到的就是「没有」，
 * 行为与接这条路之前逐字相同。
 */
export function pageVendor(
  hostname: string,
  vendorHint: ApplyVendor | null,
): Readonly<{ vendor: ApplyVendor | null; whitelabel: boolean; generic: boolean }> {
  const exact = detectApplyVendor(hostname);
  if (exact !== null) return { vendor: exact, whitelabel: false, generic: false };
  if (vendorHint !== null) return { vendor: vendorHint, whitelabel: true, generic: false };
  return { vendor: 'generic', whitelabel: false, generic: true };
}

/** 这一页（顶层或子帧）是不是认得的厂商的申请页；子帧再多认规则点名的嵌入路径。 */
export function recognisedApplyFormPage(
  page: Readonly<{ canonicalOrigin: string; pathname: string }>,
  embedded = false,
): boolean {
  const host = hostnameOf(page.canonicalOrigin);
  return host !== null && recognisedApplyPage(detectApplyVendor(host), page.pathname, embedded);
}

function hostnameOf(canonicalOrigin: string): string | null {
  try {
    return new URL(canonicalOrigin).hostname;
  } catch {
    return null;
  }
}

/**
 * 子帧问「我能不能挂浮层」（P2-10，白标 A：公司站点上官方嵌入的 ATS iframe）。
 *
 * 三条规则，全部 URL-only、全在后台判：
 *  · **顶层帧自己就是申请页**（认得的厂商 + 申请路径）→ HIDDEN：浮层归顶层，子帧照旧不挂；
 *  · 顶层不认识（或还没报到）、**这一帧是认得的厂商的嵌入申请页** → 与顶层同一套脸
 *    （READY / UNAVAILABLE…），由它自己挂；
 *  · 这一帧不是申请页（含认不出的主机）→ HIDDEN。子帧没有「到处可达」那条——那会让页面上
 *    每一个 iframe 都长出一个 tab。
 *
 * 「只给第一个子帧」不在这里判：那是登记表（frameFormRegistry）的事，先来的算数。
 */
export function frameFormFace(input: Readonly<{
  frame: Readonly<{ canonicalOrigin: string; pathname: string }>;
  topPage: Readonly<{ canonicalOrigin: string; pathname: string }> | null;
  connected: boolean;
  missionBound: boolean;
  rulesAvailable?: boolean;
  /** 同 `dockFaceForPage` 的 `openVendors`：这一帧那一家没放行就照实说，不亮按钮。 */
  openVendors?: ReadonlySet<string> | null;
}>): AutofillAffordance {
  if (!recognisedApplyFormPage(input.frame, true)) return { kind: 'HIDDEN' };
  if (input.topPage !== null && recognisedApplyFormPage(input.topPage)) return { kind: 'HIDDEN' };
  const frameHost = hostnameOf(input.frame.canonicalOrigin);
  if (input.rulesAvailable !== false && vendorClosed(frameHost === null ? null : detectApplyVendor(frameHost), input.openVendors)) {
    return { kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' };
  }
  return autofillPanelAffordance({
    site: null,
    onApplyFormPath: true,
    connected: input.connected,
    missionBound: input.missionBound,
    ...(input.rulesAvailable === undefined ? {} : { rulesAvailable: input.rulesAvailable }),
  });
}

/**
 * 「取不到规则」是这一次的事，不是这一页的事——所以按退避再问。
 *
 * MV3 的 worker 冷启动：内容脚本在 `document_start` 就报到，规则包还在路上。
 * 后台会等它（`dock-face-awaits-rules`），等不到就如实回 `RULES_UNAVAILABLE`。
 * 那句话是对的，错的是说完就不动了——内容脚本只在启动、`focus`、`pageshow`
 * 三个时机报到，用户直接落在申请页上不切走，那张脸就一直挂着，而规则其实几秒
 * 后就装好了。批测里更彻底：每页新开标签、从不失焦，一次都不会重问。
 *
 * 第一档必须长过报到自身那道 2s 节流，否则这一问会被它吞掉。
 */
export const FACE_RETRY_DELAYS_MS = [2_500, 6_000, 15_000] as const;

/**
 * 还要不要再问一次，以及隔多久。不再问时返回 null。
 *
 * 只对两种情况重问：
 *   · `RULES_UNAVAILABLE` —— 按定义就是暂时的
 *   · `null` —— 后台没答上来（通道抖动 / worker 没醒）。一次抖动不该让插件在
 *     这一页上永久消失：`showFace` 见到 null 的意思是一声不吭地不挂浮层。
 *
 * 其余每一张脸都是**关于这一页的结论**，不会自己变：没登录要用户去登，不属于
 * 任何 Mission 要用户去加，认不出就是认不出。对它们轮询只是白耗电。
 * HIDDEN（这一页什么都不挂）也是结论：调用方要用 `parseDockFaceReply` 把它原样交过来，
 * 不能先变成 null——那就成了「没答上来」，每一个普通网页都白白重问三次（2026-10-03）。
 *
 * 重试不放松任何一道闸：每一次都是重新向后台要一张脸，同一条消息、同一段计算、
 * 同样 fail closed。规则真的取不到时，问完就停在那张脸上——那时它是真话。
 */
export function nextFaceRetryDelayMs(
  face: AutofillAffordance | null,
  attempt: number,
): number | null {
  const transient = face === null ||
    (face.kind === 'UNAVAILABLE' && face.reason === 'RULES_UNAVAILABLE');
  if (!transient) return null;
  return attempt >= 0 && attempt < FACE_RETRY_DELAYS_MS.length
    ? FACE_RETRY_DELAYS_MS[attempt]!
    : null;
}
