/**
 * PageScanner 的 kernel 真实现（刀五前半）：内容脚本环境里跑
 * apply-kernel 的扫描，产出 claim 所需的 actualFieldKeys + scanDigest。
 *
 * 分工（20 §2 拓扑）：扫描/写入永远发生在**内容脚本**（页面 DOM 所在地）；
 * 背景 SW 的协调器经内部消息桥调它（桥 = 刀六，与 HTTP 客户端同批）。
 *
 * scanDigest 组成（v1，代码定义——契约 §1.2 要求每种 digest 的输入 schema
 * 由代码定义并版本化）：
 *   JCS({ schemaVersion: 1, canonicalOrigin, pathname, vendor, fieldKeys })
 *   → SHA-256 → `sha256:<hex>`（canonicalDigest.ts 的 RFC 8785 实现）。
 * ⚠️ 后端 claim 端点比对时必须采用同一 schema——已列入与后端 Codex 的
 * 对齐清单（服务端是比对权威，组成不一致只会拒发 lease，不破坏安全）。
 *
 * Data-L1：产出只有 key/摘要/路径，零字段值零页面内容。
 */

import {
  evaluatePageVeto,
  resolveApplyGate,
  resolveAuthorizedApplyGate,
  type ApplyGateRefusal,
} from '@edaix/apply-kernel/gate';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { probeApplyFormFields, readApplyForm } from '@edaix/apply-kernel/registry';
import { isNonResumeFileField, isResumeFileField } from '@edaix/apply-kernel/guards';
import { createSectionCaptioner, sectionMentionsCollection } from '@edaix/apply-kernel/fieldContext';
import { workAuthorizationQuestionKind } from '@edaix/apply-kernel/workAuthorization';
import { readRuntimeApplyForm, readRuntimeApplyFormResult, type RuntimeApplyFormStop } from '@edaix/apply-kernel/runtimeRegistry';
import {
  resolveScanRootMutationPolicy,
  type ScanRootMutationPolicy,
} from '@edaix/apply-kernel/scanRoot';
import type { ApplyFormDescriptor, ApplyVendor, HostVisibilityStyle } from '@edaix/apply-kernel/contracts';
import { sha256CanonicalJson } from './canonicalDigest';
import type {
  ResolvedContentDiscoveryRuntimeAuthority,
  ResolvedContentRuntimeAuthority,
  RuntimeExecutionAuthorization,
} from './executionRuntimeAuthority';

/**
 * 穿透闭合 shadow root（CAP-AF-047）。
 *
 * `chrome.dom.openOrClosedShadowRoot` 是**内容脚本专属**且无需额外权限的 API：
 * 宿主页面既观察不到我们在看，也无法用 closed 模式把表单藏起来让我们静默失效。
 * kernel 不碰扩展 API（RULE-KERNEL-DETERMINISTIC-BOUNDARY），所以这个能力从这里
 * 注入；拿不到（非 Chrome / API 不存在）就退回只看 open root，保守失败。
 *
 * Data-L1：只返回 ShadowRoot 引用，不读取也不外传任何页面内容。
 */
function openHostShadowRoot(element: Element): ShadowRoot | null {
  const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } })
    .chrome?.dom?.openOrClosedShadowRoot;
  if (typeof dom === 'function') {
    try {
      return dom(element);
    } catch {
      // Distinguish "no root" from "browser could not verify the boundary".
      // Scan traversal itself remains conservative, while policy sealing calls
      // this opener directly and fails the entire authorized scan closed.
      throw new Error('SHADOW_ROOT_UNAVAILABLE');
    }
  }
  return element.shadowRoot;
}

/**
 * 标签归一化要的计算可见性（CAP-AF-015 的可读文字那一半）。
 *
 * kernel 不碰 `getComputedStyle`（RULE-KERNEL-DETERMINISTIC-BOUNDARY），所以
 * "当前环境会布局"这件事由这里声明并提供读法，kernel 只跑纯判据。姿势与
 * kernelFiller.ts 的 readHostGeometry 同源。
 *
 * 只取 display / visibility：宿主**明说不渲染**的那两条。拦的是靠类名藏起来、
 * 属性层看不见的那类文字——Workable 电话标签里那张 240 行的国家区号表
 * （`.iti__hide`）、Lever typeahead 的状态文案（`.dropdown-no-results`）。
 *
 * Data-L1：只读样式，不读取也不外传任何字段值。
 */
function readHostVisibility(element: Element): HostVisibilityStyle {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return {};
  return { display: style.display, visibility: style.visibility };
}

/**
 * CSS 生成内容：`::before` / `::after` 的 `content` 计算值（kernel 的 `readGeneratedContent`）。
 *
 * 只喂一件事——题干上**画出来**的必填星号。2026-09-23 在 Ashby 的真实申请页上只读实测：必填的
 * 是非题在 DOM 里没有任何 required / aria-required，题干上只有一个构建哈希 class，星号是
 * `::after { content: "*" }`；同一页上它与「必填」逐题一一对应。「这是不是一个必填记号」的判据
 * 在 kernel（dict/requiredMarker.ts）里是纯函数，这里只是读法，与 readHostVisibility 同一个姿势。
 * 读不到 view（detached document）就交回 null，kernel 当没有记号。
 *
 * Data-L1：只读宿主的样式，不读取也不外传任何字段值。
 */
function readHostGeneratedContent(element: Element, pseudo: '::before' | '::after'): string | null {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element, pseudo);
  return style ? style.content : null;
}

/**
 * 只有求职才问的栏（2026-09-25）。「联系销售」一类的表也有名、姓、邮箱、电话、公司、职位、国家、从哪儿听说我们，
 * 那些都不算；简历、学校、LinkedIn、工作授权、到岗时间、期望薪资、求职者身份统计题这类才算。作品集（portfolioUrl）
 * 不算：通用规则把一切写着 website 的栏都认成它，HubSpot「联系销售」的「Website URL」（公司网站）就是这样被算进来的。
 */
const JOB_SIGNAL_KEYS: ReadonlySet<string> = new Set([
  'resumeFile', 'coverLetter', 'linkedinUrl', 'githubUrl',
  'earliestStartDate', 'noticePeriodDays', 'expectedSalaryAmount', 'expectedSalaryCurrency', 'expectedSalaryPeriod',
  'workAuthorization', 'workSponsorship', 'openToRelocation', 'openToRelocationCities', 'relocation',
  'transitioningServiceMember', 'previouslyEmployedHere', 'referralName',
  'eeoGender', 'eeoRace', 'eeoVeteran', 'eeoDisability', 'eeoTransgender', 'eeoSexualOrientation', 'eeoLgbtqCommunity',
]);

/**
 * 没有表／有一张表／有一张带求职信号的表／表里有只有求职才问的栏。
 *
 * `APPLICATION_FORM`（负责人 2026-09-28）：表里有简历／CV 上传栏、LinkedIn、问工作授权的题，或学历那一节里的
 * 学校、专业一类——公司自己做的表有了这一档，就像厂商的申请页一样自动打开浮层（`lib/dockAutoOpen.ts`）。
 * `JOB_FORM` 是较弱的求职信号（GitHub、期望薪资、到岗时间、身份统计题……）：能填，只挂收着的标签。
 */
export type GenericFormEvidence = 'NONE' | 'FORM' | 'JOB_FORM' | 'APPLICATION_FORM';

/**
 * 这一页上有没有一张「通用申请表」（2026-09-24，商店包开全网）：主机不在厂商表里、也没有白标指纹的页面，只凭这个与
 * JobPosting、网址判断要不要挂浮层。
 *
 * 与动手时同一道闸：通用规则的 `genericRoot`（恰好一张表里认得够 `minKeyedFields` 个字段），再过页面否决（密码页、
 * 挑战页不算——注册表单也能凑够姓名、邮箱、电话）。过了是 `FORM`；表里还有求职信号（`JOB_SIGNAL_KEYS`，或一个简历
 * 上传栏）是 `JOB_FORM`（2026-09-25：「联系销售」表单在测试台上被当成申请表自动弹出）；其中有只有求职才问的栏的是
 * `APPLICATION_FORM`（见上）。学历那几栏只在说到学历的那一节里才算，算就是 `APPLICATION_FORM`。
 * 只读、不封存；通用规则没装上就答 `NONE`。
 *
 * Data-L1：只回答这四档之一，不读取也不外传任何字段值。
 */
export function genericApplyFormEvidence(page: Document): GenericFormEvidence {
  const locale = page.documentElement?.lang?.trim() || undefined;
  const fields = probeApplyFormFields('generic', page, {
    generic: true,
    openShadowRoot: openVerifiedHostShadowRoot,
    readVisibility: readHostVisibility,
    ...(locale ? { locale } : {}),
  });
  if (fields === null || evaluatePageVeto(page, { readVisibility: readHostVisibility }).vetoed) return 'NONE';
  // 学历那几栏只在说到学历的那一节里才算（2026-09-28，与计划期同一道判据）：大学「索取资料」表上的
  // 「Highest level of education」不是求职信号。
  let captionOf: ((element: Element) => string) | null = null;
  const inEducationSection = (field: (typeof fields)[number]): boolean => {
    if (field.key === null || !field.key.startsWith('education.')) return false;
    captionOf ??= createSectionCaptioner(page);
    return sectionMentionsCollection(captionOf(field.element), field.key);
  };
  // 简历上传栏按标签**与稳定钩子**认（与认表时数门槛那一道同一个判据，2026-09-28：Valve 的标签只写着
  // 「Choose files.」，简历是 `name="resume[]"` 说的）。
  const resumeUpload = (field: (typeof fields)[number]): boolean => {
    if (field.kind !== 'file') return false;
    const identities = [
      field.element.getAttribute('name'),
      field.element.getAttribute('id'),
      field.element.getAttribute('data-automation-id'),
      field.element.getAttribute('data-ui'),
      field.element.getAttribute('data-qa'),
      field.element.getAttribute('data-testid'),
    ];
    return isResumeFileField(field.label, identities) && !isNonResumeFileField(field.label, identities);
  };
  // 只有求职才问的栏（负责人 2026-09-28）：简历／CV 上传、LinkedIn、工作授权、学历。
  const jobOnly = fields.some((field) =>
    resumeUpload(field) ||
    field.key === 'linkedinUrl' ||
    workAuthorizationQuestionKind(field.label) !== null ||
    inEducationSection(field));
  if (jobOnly) return 'APPLICATION_FORM';
  const jobSignal = fields.some((field) =>
    (field.key !== null && JOB_SIGNAL_KEYS.has(field.key)) ||
    (field.kind === 'file' && isResumeFileField(field.label)));
  return jobSignal ? 'JOB_FORM' : 'FORM';
}

/**
 * DOM 规范里能挂影子根的元素：HTML 命名空间里的自定义元素（名字带连字符），加上这份固定清单。
 * 其余元素 `attachShadow` 直接抛 NotSupportedError，声明式影子根也是同一套规则，所以不用问。
 */
const SHADOW_HOST_NAMES: ReadonlySet<string> = new Set([
  'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'main', 'nav', 'p', 'section', 'span',
]);
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function canHostShadowRoot(element: Element): boolean {
  return element.namespaceURI === HTML_NAMESPACE &&
    (element.localName.includes('-') || SHADOW_HOST_NAMES.has(element.localName));
}

/**
 * Production scanner access. A missing extension-only closed-shadow API is an
 * unverifiable traversal boundary, not permission to silently scan open roots.
 *
 * 扫描器对每个元素都问一次「你有没有影子根」，而且每次按选择器查都从头问一遍。
 * `chrome.dom.openOrClosedShadowRoot` 每次调用都要过一趟扩展 API 绑定：2026-09-23 在 Palantir 的
 * Lever 申请页（学校下拉 3323 个 option，全页 3771 个元素里只有 184 个能挂影子根）上，
 * 这一个调用吃掉了 13.5 秒，扫描本身等了 12 秒。挂不了影子根的元素不用问，答案一定是没有。
 */
export function openVerifiedHostShadowRoot(element: Element): ShadowRoot | null {
  const dom = (globalThis as {
    chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } };
  }).chrome?.dom?.openOrClosedShadowRoot;
  if (typeof dom !== 'function') throw new Error('SHADOW_ROOT_API_UNAVAILABLE');
  if (!canHostShadowRoot(element)) return null;
  try {
    return dom(element);
  } catch {
    throw new Error('SHADOW_ROOT_UNAVAILABLE');
  }
}

export const SCAN_DIGEST_SCHEMA_VERSION = 1;

export interface KernelPageScan {
  readonly jobId: string;
  /** https://host[:port]，无路径/查询——claim 目标复核（§5.5.2）的观测输入。 */
  readonly canonicalOrigin: string;
  readonly fieldKeys: readonly string[];
  readonly scanDigest: string;
  /** 后续给 filler 复用：同一次扫描的表单描述符（含活元素引用，绝不出内容脚本）。 */
  readonly descriptor: ApplyFormDescriptor;
  /** Production-only local binding; never serialized in BridgeScan. */
  readonly runtimeAuthorization?: RuntimeExecutionAuthorization;
  /** Exact bundle deadlines captured with the production scan; never serialized. */
  readonly runtimeFreshUntilMs?: number;
  readonly runtimeNotAfterMs?: number;
}

/** Keeps a gate refusal distinct from a permitted page with no parsable form. */
/**
 * 扫描没成的那几种，各自有名字。
 *
 * 原先四个 `return { scan: null, refusal: null }` 长得一模一样，于是调用方只能
 * 一律报 `NO_FORM_FOUND`——「这一页没有表单」。可其中三种根本不是那个意思：
 * 规则解释不出、策略一个键都没点名、这一页的结构封不住。2026-09-18 查一次真实的
 * 零写入，光是把这四条分开就花了好几轮（RULE-GLOBAL-ERROR-CONTRACT：
 * 失败要有稳定的名字）。
 */
export type KernelScanStop =
  /** 规则解释不出这一页；`RuntimeApplyFormStop` 说的是它具体停在哪一步。 */
  | RuntimeApplyFormStop
  | 'RULES_MATCHED_NOTHING'
  /** 扫出来的键里，策略一个都没点名。 */
  | 'NO_AUTHORIZED_FIELD'
  /** 这一页的结构此刻封不住（拿不到可比对的代次）。 */
  | 'SCAN_NOT_SEALABLE';

export interface KernelScanOutcome {
  readonly scan: KernelPageScan | null;
  readonly refusal: ApplyGateRefusal | null;
  readonly vendor: ApplyVendor | null;
  /** 门控放行之后才停下的那几种，各自的名字；门控自己的拒绝仍在 `refusal`。 */
  readonly stop?: KernelScanStop;
}

/**
 * 扫当前页面。厂商认不出 / 表单锚点证明失败 → outcome.scan 为 null
 *（协调器停 RESCAN_MISMATCH），同时保留门控 refusal 与当前 vendor。
 * fieldKeys 只取 kernel 判定出 canonical key 的字段（与 Intent 的 fieldKeys 同域）。
 */
/**
 * 门控的可注入部分（CAP-AF-006）。
 *
 * `policy` 只为让测试注入远程否决名单；缺省用打包策略。`isTopFrame` 与 `search`
 * 在内容脚本里由 `window.top === window.self` 与 `location.search` 给出——扫描
 * 函数本身不读全局，保持可测。
 */
export interface KernelScanGate {
  readonly policy?: ApplyPolicy;
  readonly isTopFrame?: boolean;
  /** 形如 `?gh_jid=123`。Greenhouse／Lever 的 URL 参数是指纹的一条弱信号。 */
  readonly search?: string;
  /**
   * Installs a dirty latch in the same synchronous turn as descriptor sealing,
   * before the digest await. Production supplies this; read-only callers may
   * omit it and still receive a post-digest exact-parity check.
   */
  readonly armMutationGuard?: (
    policy: ScanRootMutationPolicy,
  ) => KernelScanMutationGuard | null;
}

export interface KernelScanMutationGuard {
  readonly isCurrent: () => boolean;
  readonly dispose: () => void;
}

export interface RuntimeKernelScanGate {
  readonly isTopFrame?: boolean;
  /** 这一帧是子帧（P2-10）：只有这样声明，规则点名的嵌入路径才算申请页；顶层帧上它照旧不是。 */
  readonly embedded?: boolean;
  /** 白标 B（P2-11）：主机不在厂商表里、厂商来自指纹。路径不看本家的，容器要过 whitelabelRoot 那道闸。 */
  readonly whitelabel?: boolean;
  /**
   * 通用路（2026-09-22）：主机表与指纹都答不出。路径与本家钩子都不适用，
   * 容器要过 `genericRoot` 那道闸（数「这张表里有几个字段我们认得」）。
   * 与 `whitelabel` 互斥——同时为真会让 `isApplyPath` 先在白标位上答 false。
   */
  readonly generic?: boolean;
  readonly armMutationGuard: NonNullable<KernelScanGate['armMutationGuard']>;
  /** Verified open-or-closed ShadowRoot access supplied by the extension lane. */
  readonly openShadowRoot: (element: Element) => ShadowRoot | null;
}

export interface RuntimeDiscoveryScanGate {
  readonly isTopFrame?: boolean;
  /** 同 RuntimeKernelScanGate.embedded。 */
  readonly embedded?: boolean;
  /** 同 RuntimeKernelScanGate.whitelabel。 */
  readonly whitelabel?: boolean;
  /** 同 RuntimeKernelScanGate.generic。 */
  readonly generic?: boolean;
  /** Discovery retains no descriptor, so post-digest parity is sufficient. */
  readonly armMutationGuard?: KernelScanGate['armMutationGuard'];
  readonly openShadowRoot: (element: Element) => ShadowRoot | null;
}

async function digestSealedScan(
  input: {
    readonly canonicalOrigin: string;
    readonly fieldKeys: readonly string[];
    readonly pathname: string;
    readonly root: ApplyFormDescriptor['root'];
    readonly vendor: ApplyVendor;
  },
  armMutationGuard?: KernelScanGate['armMutationGuard'],
): Promise<string | null> {
  const policy = resolveScanRootMutationPolicy(input.root);
  if (!policy) return null;
  const guard = armMutationGuard?.(policy) ?? null;
  if (armMutationGuard && guard === null) return null;

  let scanDigest: string;
  try {
    scanDigest = await sha256CanonicalJson({
      schemaVersion: SCAN_DIGEST_SCHEMA_VERSION,
      canonicalOrigin: input.canonicalOrigin,
      pathname: input.pathname,
      vendor: input.vendor,
      fieldKeys: input.fieldKeys,
    });
  } catch (error) {
    guard?.dispose();
    throw error;
  }
  if (!(guard?.isCurrent() ?? policy.isCurrent())) {
    guard?.dispose();
    return null;
  }
  return scanDigest;
}

export async function scanCurrentPage(
  page: Document = document,
  loc: { hostname: string; origin: string; pathname: string } = location,
  gate: KernelScanGate = {},
): Promise<KernelScanOutcome> {
  // 门控合成入口（CAP-AF-006）：精确主机名先行、认不出才用 DOM 指纹，
  // 雇主后台／公共部门／登录页／挑战页的否决优先于任何厂商命中。
  // 指纹只给"先试哪家"的提示——下面 readApplyForm 解析不出表单就照常返回 null，
  // 那道确认才是归属的终点（FINDING-AF-002：认错厂商比认不出更坏）。
  const verdict = resolveApplyGate({
    doc: page,
    hostname: loc.hostname,
    // 共域厂商（Dover / BambooHR：候选人面与 HR 后台同主机）上路径是唯一的
    // 分界线，缺它等于否决。`loc.pathname` 本来就在手上——不传给门控，
    // 那两家就永远挂不上，而且完全静默。
    pathname: loc.pathname,
    ...(gate.search ? { search: gate.search } : {}),
    policy: gate.policy ?? createBundledApplyPolicy(),
    isTopFrame: gate.isTopFrame ?? true,
    // 藏起来的「密码」蜜罐不算密码页（2026-09-28，gate/pageVeto.ts）。
    readVisibility: readHostVisibility,
  });
  if (!verdict.attach) {
    return { scan: null, refusal: verdict.reason, vendor: verdict.vendor };
  }
  const vendor = verdict.vendor;

  // 页面语言喂给 labelPatterns 的 locale 分层（CAP-AF-015）。读不到就不传，
  // 解释器在未知语言下让所有 pattern 参与——不因为读不到 lang 就少认字段。
  const locale = (page as Document).documentElement?.lang?.trim() || undefined;
  const descriptor = readApplyForm(vendor, page, {
    openShadowRoot: openHostShadowRoot,
    readVisibility: readHostVisibility,
    readGeneratedContent: readHostGeneratedContent,
    ...(locale ? { locale } : {}),
  });
  if (descriptor === null) {
    return { scan: null, refusal: null, vendor, stop: 'RULES_MATCHED_NOTHING' };
  }

  const keys = new Set<string>();
  for (const field of descriptor.fields) {
    if (field.key !== null) keys.add(field.key);
  }
  const fieldKeys = [...keys].sort();

  const scanDigest = await digestSealedScan({
    canonicalOrigin: loc.origin,
    pathname: loc.pathname,
    vendor,
    fieldKeys,
    root: descriptor.root,
  }, gate.armMutationGuard);
  if (scanDigest === null) return { scan: null, refusal: null, vendor };

  const scan: KernelPageScan = {
    // 原型的 job 引用 = 路径（真身份 = postingFingerprint/canonical target，
    // 待后端 pathRule/岗位指纹规则可下发后接入）。
    jobId: loc.pathname,
    canonicalOrigin: loc.origin,
    fieldKeys,
    scanDigest,
    descriptor,
  };
  return { scan, refusal: null, vendor };
}

/**
 * Production runtime lane.  Vendor attribution comes only from the exact
 * backend mapping already resolved in `authority`; hostname and DOM
 * fingerprinting are never consulted.  `loc.pathname` is merely the current
 * page observation included in scanDigest for server-side canonical recheck.
 */
export async function scanCurrentPageWithRuntimeAuthority(
  authority: ResolvedContentRuntimeAuthority,
  page: Document = document,
  loc: { hostname: string; origin: string; pathname: string } = location,
  gate: RuntimeKernelScanGate,
): Promise<KernelScanOutcome> {
  return scanCurrentPageWithResolvedRuntime(
    authority,
    authority.policy,
    page,
    loc,
    gate,
  );
}

/**
 * Read-only production lane. The authority carries a physically disabled host
 * policy used only for remote denylist and page-safety vetoes; it cannot be
 * consumed by the write runner, and its authorization purpose is DISCOVERY.
 */
export async function scanCurrentPageWithDiscoveryAuthority(
  authority: ResolvedContentDiscoveryRuntimeAuthority,
  page: Document = document,
  loc: { hostname: string; origin: string; pathname: string } = location,
  gate: RuntimeDiscoveryScanGate,
): Promise<KernelScanOutcome> {
  return scanCurrentPageWithResolvedRuntime(
    authority,
    authority.hostPolicy,
    page,
    loc,
    gate,
  );
}

async function scanCurrentPageWithResolvedRuntime(
  authority: Readonly<{
    authorization: RuntimeExecutionAuthorization;
    mapping: ResolvedContentRuntimeAuthority['mapping'];
    freshUntilMs: number;
    notAfterMs: number;
    allowedFieldKeys: readonly string[];
  }>,
  policy: ApplyPolicy,
  page: Document,
  loc: { hostname: string; origin: string; pathname: string },
  gate: RuntimeDiscoveryScanGate,
): Promise<KernelScanOutcome> {
  const vendor = authority.mapping.vendor;
  const verdict = resolveAuthorizedApplyGate({
    doc: page,
    hostname: loc.hostname,
    pathname: loc.pathname,
    policy,
    vendor,
    isTopFrame: gate.isTopFrame ?? true,
    readVisibility: readHostVisibility,
  });
  if (!verdict.attach) {
    return { scan: null, refusal: verdict.reason, vendor: verdict.vendor };
  }

  const locale = page.documentElement?.lang?.trim() || undefined;
  const read = readRuntimeApplyFormResult(
    authority.mapping,
    loc.pathname,
    page,
    {
      openShadowRoot: gate.openShadowRoot,
      readVisibility: readHostVisibility,
      readGeneratedContent: readHostGeneratedContent,
      ...(locale ? { locale } : {}),
      ...(gate.whitelabel === true ? { whitelabel: true } : {}),
      ...(gate.generic === true ? { generic: true } : {}),
    },
    {
      embedded: gate.embedded === true,
      whitelabel: gate.whitelabel === true,
      generic: gate.generic === true,
    },
  );
  if (!read.ok) return { scan: null, refusal: null, vendor, stop: read.stop };
  const descriptor = read.descriptor;

  const keys = new Set<string>();
  for (const field of descriptor.fields) {
    if (field.key !== null) keys.add(field.key);
  }
  /**
   * 策略没点名的键，只让**那一栏**不算数，不让整张表消失。
   *
   * 这里原先是「扫出来的键里只要有一个不在 `allowedFieldKeys` 里，整个扫描作废」。
   * 粒度错了，而且代价是全量的：下发的规则自己就认得出 `education.school` 这类
   * 集合键，而下发的策略只列了 22 个扁平档案键——两份都出自后端的同一个包，却对不上。
   * 于是**任何带学历那一段的申请页都扫不出表单**，浮层报 NO_FORM_FOUND，
   * 读起来像「这一页不支持」。2026-09-18 在真实 Greenhouse 页上实测：
   * 44 个控件、规则扫出 12 个键，其中 3 个是 `education.*`，
   * 另外 9 个本来能填的也一起没了。
   *
   * 取交集是**更严**，不是更松：没点名的键根本不进 `fieldKeys`，于是它不进摘要、
   * 不进 claim、也不进写入面。写入那一侧本来就各自围栏（mission 路按
   * `grant.fieldKeys`，手势路按 `APPLY_FIELD_KEYS`），这里只是别再把
   * 「有一栏不归我们管」当成「这一页没有表」。
   */
  const allowed = new Set(authority.allowedFieldKeys as readonly string[]);
  const fieldKeys = [...keys].filter((key) => allowed.has(key)).sort();
  // 一个都不归我们管的页面，和没有表是一回事——
  // 只有一个例外：手势填写的厂商路上，整页都是雇主自定义题、一个键都没有的那一步（2026-09-22
  // nvidia.wd5 第 3 步 Application Questions）。那一页交给计划，是为了让按题干作答的逻辑——工作授权
  // 按岗位国家预填、居住地、答案记忆——跑得到；写入面照旧由手势路自己的键围栏与能力位管。
  // 「有键、但策略一个都没点名」不在例外里，mission 路也不在。
  const unkeyedVendorStep = keys.size === 0 && descriptor.fields.length > 0 &&
    authority.authorization.purpose === 'DISCOVERY' && gate.whitelabel !== true && gate.generic !== true;
  if (fieldKeys.length === 0 && !unkeyedVendorStep) {
    return { scan: null, refusal: null, vendor, stop: 'NO_AUTHORIZED_FIELD' };
  }

  const scanDigest = await digestSealedScan({
    canonicalOrigin: loc.origin,
    pathname: loc.pathname,
    vendor,
    fieldKeys,
    root: descriptor.root,
  }, gate.armMutationGuard);
  if (scanDigest === null) {
    return { scan: null, refusal: null, vendor, stop: 'SCAN_NOT_SEALABLE' };
  }
  return {
    scan: {
      jobId: loc.pathname,
      canonicalOrigin: loc.origin,
      fieldKeys,
      scanDigest,
      descriptor,
      runtimeAuthorization: authority.authorization,
      runtimeFreshUntilMs: authority.freshUntilMs,
      runtimeNotAfterMs: authority.notAfterMs,
    },
    refusal: null,
    vendor,
  };
}
