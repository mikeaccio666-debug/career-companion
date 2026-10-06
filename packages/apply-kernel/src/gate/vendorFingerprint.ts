import type { ApplyVendor } from '../contracts';

/**
 * 在**任意主机名**上认出这一页属于哪家 ATS。
 *
 * 为什么需要：申请表可以出现在任何域名上——Ashby 支持自定义域、Workday 每租户
 * 一个子域、公司自建招聘页更是任意主机。`detectApplyVendor` 那张主机名表永远追不上。
 *
 * ⚠️ **它只给一个"先试哪家"的提示，不完成归属。** 调用方必须用
 * `readApplyForm(vendor)` 真的解析成功才算数。评审的原话：URL 参数是投放方与攻击者
 * 可控的，单靠它归属等于把判定权交出去。所以这里的返回值叫 hint 而不是 vendor。
 *
 * 每条信号都要求**厂商自己的产物**，不是"看起来像申请表"的通用特征——后者是误注入
 * 的来源（租房申请、病历 intake、研究生院申请在结构上与求职申请无法区分）。
 * 竞品对照：Jobright 的 `getTargetName()` 是一条 70+ 分支的 allowlist，
 * 认不出就**什么都不创建**；两家竞品**都没有**通用兜底引擎。我们采用同一姿态。
 */

const GREENHOUSE_ACTION_HOSTS = [
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.eu.greenhouse.io',
];

/**
 * 「自建域名上的 Greenhouse 板」这件事的实测边界（2026-09-15，只读）。
 *
 * 先说结论：**这里没有可加的判据，刻意不加。** 写下来是为了让下一个人不用重跑
 * 这轮调查，也不要伸手去拿那几条看着很像、其实会认错厂商的信号。
 *
 * 用 Greenhouse 自己的 boards-api 把本仓已知的 56 个 board 逐个问了一遍它自己
 * 声明的 posting 主机：**24 个在客户自己的域名上**（careers.duolingo.com、
 * www.brex.com、careers.datadoghq.com、jobs.dropbox.com、stripe.com、
 * app.careerpuck.com……）。挨个打开这些页面之后，它们分成三类：
 *
 *  1. **官方 embed**（brex / datadog / mongodb / nuro / samsara / lyft）：
 *     `#grnhse_app` 与 `iframe#grnhse_iframe` 原样都在——**下面那张表已经认得**，
 *     实测能填（brex 6/6）。
 *  2. **落地页上根本没有申请表**（coinbase / pinterest / instacart / klaviyo /
 *     elastic / dropbox / stripe）：那是岗位描述页，申请入口在别处。没有表单，
 *     挂上去也无事可做。
 *  3. **客户自建前端**（careers.duolingo.com；upstart 同形）：表单是客户自己的
 *     React 产物——`<form class="k30Iw">`，没有 id、没有一个 `name` 属性，
 *     控件 id 是 `first_name` / `question_37488760002`。**Greenhouse 的产物一个都没有。**
 *
 * 第 3 类是唯一有表单又认不出的，而它身上带 "greenhouse" 字样的地方只有两处，
 * 两处都**不能**当判据：
 *   · `<link rel="preload" as="fetch" href="https://boards-api.greenhouse.io/…">`
 *     ——同一个 `<head>` 里**还有** `https://duolingo.breezy.hr/json`。同一套页面
 *     外壳同时供着两家 ATS 的岗位，拿这条归属等于把每一个 Breezy 岗位判成
 *     Greenhouse，正是本文件头注说的"认错厂商比认不出更坏"。
 *   · 岗位描述正文里的 `my.greenhouse.io/…` / `app2.greenhouse.io/…` 链接
 *     ——正文是雇主自己敲进去的文字，任何 ATS 上的任何雇主都能粘一条进去。
 *
 * 而**真正的入口 URL 早就认得**：Greenhouse 自己的 boards-api 给这 24 个客户域
 * 板发的 `absolute_url` 无一例外带 `?gh_jid=<id>`，站点自己的 Apply 链接
 * （`/jobs/8653419002?gh_jid=8653419002#apply`）也带。实测 careers.duolingo.com：
 * 不带该参数时整页**一个 form 都没有**、判 `NO_VENDOR`；带上它时门控 `attach:true
 * vendor:greenhouse source:FINGERPRINT`——指纹压根不是拦路的那一环，随后停在
 * `NO_ROOT`，因为那张表不是 Greenhouse 渲染的。那一停是对的：把 Greenhouse 的
 * 选择器套到别人渲染的表单上，就是拿错规则往错字段里写。
 *
 * 拒绝型 fixture 见 tests/apply-greenhouse-custom-domain.test.ts。
 */

/** 官方 embed 的固有产物，公司自建页上原样保留。 */
const GREENHOUSE_DOM_SIGNALS = [
  'iframe#grnhse_iframe',
  '#grnhse_app',
  'form input[type="hidden"][name="action"][value="greenhouse/applications/submit"]',
  'form input[type="hidden"][name="action"][value="gh_application_submission"]',
];

const ASHBY_DOM_SIGNALS = ['.ashby-application-form-container', '[data-ashby-app]'];

const WORKABLE_DOM_SIGNALS = ['form[data-ui="application-form"]'];

/**
 * Avature 的向导状态字段。2026-08-21 在两个真实租户上只读实测
 * （`apply.deloitte.com` 与 `us-talentcommunity.kpmg.com`），两家**逐字相同**。
 *
 * 为什么用这五个而不是字段名：两家的逐字段命名完全不同（Deloitte 是
 * `550/551/552/944`，KPMG 是 `1739/1740/1792/21614`）——数字是逐租户的内部 ID，
 * 跨租户毫无意义。而这五个是 Avature 自己的产物、跨租户不变。
 *
 * 它们也不是"看起来像申请表"的通用特征：租房申请、病历 intake 不会带
 * `visitedStepIds`。这正是本文件头注要求的判据——**厂商自己的产物**。
 */
const AVATURE_STATE_FIELDS = [
  'currentStepIndex',
  'entityData',
  'visitedStepIds',
  'committedStepIds',
  'stepIndexesStack',
] as const;

/**
 * 要求**至少三个**同时出现，不是命中一个就算。
 * `currentStepIndex` 这种名字别的多步表单也可能用；一个就断定 = 误注入。
 */
const AVATURE_MIN_SIGNALS = 3;

/**
 * iCIMS 的 DOM 指纹（2026-08-22 在真实 posting 上实测）。
 *
 * 三条都是 iCIMS 自己的产物，**不是**任何雇主能配出来的：
 *  · `form#profileForm` —— 候选人档案表单的固定 id；
 *  · `[id^="PersonProfileFields."]` —— 它自己的字段命名空间；
 *  · `.iCIMS_ProfileFormTable` —— 带厂商前缀的容器类名。
 *
 * 为什么必须靠指纹而不是主机名：iCIMS 跑在逐客户子域上（careers-<公司>.icims.com），
 * 无法穷举；而后缀通配被本仓的「不含任何通配子域」不变量禁止——那条来自
 * 2026-07-29 的真实事故（greenhouse.io 后缀把 app.greenhouse.io 雇主后台圈了进来）。
 */
const ICIMS_DOM_SIGNALS = [
  'form#profileForm',
  '[id^="PersonProfileFields."]',
  '.iCIMS_ProfileFormTable',
] as const;

function avatureStateFieldCount(doc: Document): number {
  return AVATURE_STATE_FIELDS.filter((name) => {
    try {
      return doc.querySelector(`input[name="${name}"]`) !== null;
    } catch {
      return false;
    }
  }).length;
}

function formActionHost(doc: Document, host: string): boolean {
  for (const form of Array.from(doc.querySelectorAll('form[action]'))) {
    const action = form.getAttribute('action') ?? '';
    // 只认绝对 URL 的 host 部分。相对路径不携带厂商信息，拿它匹配等于猜。
    try {
      if (new URL(action, doc.location?.href ?? 'https://x.invalid').hostname === host) return true;
    } catch {
      /* 畸形 action 忽略 */
    }
  }
  return false;
}

function anySelector(doc: Document, selectors: readonly string[]): boolean {
  return selectors.some((selector) => {
    try {
      return doc.querySelector(selector) !== null;
    } catch {
      return false;
    }
  });
}

export interface VendorFingerprintInput {
  readonly doc: Document;
  readonly url: URL;
}

/**
 * 返回"先试哪家"的提示。**认不出就返回 null，绝不猜**。
 */
export function fingerprintVendorHint(input: VendorFingerprintInput): ApplyVendor | null {
  const { doc, url } = input;

  // Greenhouse：官方 embed 的 DOM 产物 > form action 主机 > URL 参数。
  // `gh_jid` 单独出现时也算——Jobright 的兜底分支用的就是它，且它是 Greenhouse
  // 特有的参数名，不会与别家撞车。但它仍然只是提示，要 resolveRoot 确认。
  if (
    anySelector(doc, GREENHOUSE_DOM_SIGNALS) ||
    GREENHOUSE_ACTION_HOSTS.some((host) => formActionHost(doc, host)) ||
    url.searchParams.has('gh_jid')
  ) {
    return 'greenhouse';
  }

  if (formActionHost(doc, 'jobs.lever.co') || url.searchParams.has('LeverAppId')) {
    return 'lever';
  }

  if (anySelector(doc, ASHBY_DOM_SIGNALS)) return 'ashby';
  if (anySelector(doc, WORKABLE_DOM_SIGNALS)) return 'workable';
  // iCIMS 与上面几家同档：判据是厂商自己的 DOM 产物（固定 form id、
  // 自有字段命名空间、带前缀的容器类名），不是"多个弱信号凑数"。
  if (anySelector(doc, ICIMS_DOM_SIGNALS)) return 'icims';

  // Avature 排在最后：它的判据是"多个向导状态字段同时出现"，比上面几家的
  // 专有 DOM 产物弱一档。前面任何一家命中就不轮到它——否则一个内嵌了
  // Greenhouse 的 Avature 页会被判成 Avature，套错规则把值写进错误字段。
  if (avatureStateFieldCount(doc) >= AVATURE_MIN_SIGNALS) return 'avature';

  return null;
}
