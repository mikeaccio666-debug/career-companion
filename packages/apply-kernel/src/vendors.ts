/**
 * Which ATS are we on? URL-only, pure, and the single source of truth for the
 * autofill surface (analogue of `parsers/platform.ts#detectPlatform`).
 *
 * v1 vendor set (owner-approved 2026-07-28) was chosen by one filter: can a
 * user reach a fillable form WITHOUT creating an account? Greenhouse, Lever,
 * Ashby and Workable pass. Workday, iCIMS and Taleo gate the form behind
 * account creation, so they are a different product surface (see
 * docs/AUTOFILL-DESIGN.md §1.2) and deliberately absent here.
 *
 * Keep this module free of DOM access: the content script decides whether to
 * boot at all from this result, before touching the page.
 */

import type { ApplyVendor } from './contracts';

// Kept as re-exports during the C1 migration so existing consumers retain the
// URL-catalog entrypoint while the L0 vendor type has a single definition.
export { APPLY_VENDORS } from './contracts';
export type { ApplyVendor } from './contracts';

/**
 * **候选人侧**的精确主机名，按厂商分组。
 *
 * 刻意是精确主机名而不是域名后缀。原先写的是后缀 `greenhouse.io`，于是
 * `app.greenhouse.io`——**招聘方后台**——也会匹配：HR 打开候选人编辑页，我们的
 * 浮层照样弹出，点一下 Fill 写进去的是**我方用户的**邮箱、覆盖的是**别人的**
 * 候选人记录（架构评审 P4，2026-07-29）。同类的还有 `my.greenhouse.io`、
 * `hire.lever.co`、`app.ashbyhq.com`——全是雇主侧界面，一个都不该进。
 *
 * 精确匹配同时天然挡住 `greenhouse.io.evil.test` 这类仿冒主机。
 *
 * 这份表是**唯一真相源**：manifest 的注入范围（wxt.config.ts）由
 * `applyHostMatchPatterns()` 从这里生成，不再手抄。原先同一份 host 列表
 * 有四份拷贝，漏改任何一份都会让新厂商"content script 正常注入、正常跑、
 * 浮层永不出现，且无任何报错"（架构评审 P2）。
 */
export interface VendorCatalogEntry {
  readonly candidateHosts: readonly string[];
  /**
   * 候选人侧的**注册域后缀**，按标签边界匹配。
   *
   * ⚠️ 只有满足一个硬条件的域才允许出现在这里：该注册域下没有雇主／管理面，
   * 或该后缀被 hostVeto 的 deny-by-default shared-host pathname 闸覆盖。这个二选一
   * 由测试与 `sharedHostGuardedSuffixes()` 机器强制，不能只靠注释。
   * `greenhouse.io` 不满足（`app.greenhouse.io` 是雇主后台），所以它只能用精确
   * 主机名——写成后缀会让 HR 的候选人编辑页也命中，Fill 写进去的是我方用户的
   * 邮箱、覆盖的是**别人的**候选人记录（架构评审 P4，2026-07-29）。
   *
   * Workday 满足：它一雇主一租户一子域（`<tenant>.wdN.myworkdayjobs.com`），
   * 精确主机名永远列不完；而它的雇主／管理面在**另外的注册域**上
   * （`workday.com` / `myworkday.com`），那两个在 `hostVeto` 的雇主后台名单里。
   *
   * 注册域**自身**不匹配（`myworkdayjobs.com` 不承载任何租户的申请表），
   * 且按标签边界比对，所以 `myworkdayjobs.com.evil.test` 与 `evil-myworkdayjobs.com`
   * 都不会命中。
   */
  readonly candidateHostSuffixes?: readonly string[];
  /**
   * Candidate-only manifest path prefixes. This narrows page-observable MAIN
   * world injection and never grants vendor or execution authority.
   */
  readonly candidatePathPrefixes?: readonly string[];
}

export const VENDOR_CATALOG = {
  greenhouse: {
    candidateHosts: [
      'job-boards.greenhouse.io',
      'job-boards.eu.greenhouse.io',
      'boards.greenhouse.io',
      'boards.eu.greenhouse.io',
    ],
  },
  lever: { candidateHosts: ['jobs.lever.co', 'jobs.eu.lever.co'] },
  ashby: { candidateHosts: ['jobs.ashbyhq.com'] },
  workable: { candidateHosts: ['apply.workable.com'] },
  // PENDING-B1 于 2026-08-21 由 Mike／Yiwen／Vivian 放行。先落地**识别**：
  // `ADAPTERS.workday` 仍为 null，所以 `applyHostMatchPatterns` 不会把它加进
  // 上架包的注入范围——解析器落地前，注入面一个字节都不动。
  workday: { candidateHosts: [], candidateHostSuffixes: ['myworkdayjobs.com'] },
  // Avature 跑在**客户自己的域名**上（apply.deloitte.com、
  // us-talentcommunity.kpmg.com），既无共同注册域也无法穷举——主机名这条路
  // 在这家根本不存在，只能靠 DOM 指纹（见 gate/vendorFingerprint.ts）。
  avature: { candidateHosts: [] },
  // 2026-08-22 在真实 posting 上实测：整张表在 shadow root 里（27 个 shadow host，
  // document 层 querySelectorAll('input') 返回 0），锚点是自定义元素 oc-oneclick-form
  // 而不是 <form>——该页没有 form 元素。主机名单一且稳定。
  smartrecruiters: { candidateHosts: ['jobs.smartrecruiters.com'] },
  // iCIMS 跑在**逐客户子域**上（careers-<公司>.icims.com、us-erac.icims.com…），
  // 无法穷举。**不能用后缀**：本仓有一条来自 2026-07-29 真实事故的不变量——
  // 通配子域会把雇主后台一起圈进来（当年写 greenhouse.io 后缀，结果
  // app.greenhouse.io 招聘方后台也匹配上，HR 打开候选人编辑页我们就在场）。
  // 2026-08-22 接 iCIMS 时我一度想让后缀进窄表，被 apply-vendor-detect 的
  // 「不含任何通配子域」用例当场咬住——那条不变量是对的，此处照 Avature 处理：
  // 主机名这条路走不通，靠 DOM 指纹认（gate/vendorFingerprint.ts）。
  icims: { candidateHosts: [] },
  // 2026-09-22：合同映射收口了（argoland #565 把 DOVER / JOBVITE / RIPPLING 放进
  // runtime bundle 的 mappings），上面那句「保持空表」的前提不再成立。空表的代价是
  // 实测出来的：放行当天这三家各跑 6 页真实在招岗位，**18 页全部**报「这一页没有认出
  // 申请表」——`pageVendor` 主机表先行，答不出就退白标，而这三家没有 whitelabelRoot，
  // 于是整条链从第一步就断了。页面本身没问题：Dover 那一页有 form、11 个输入框。
  //
  // `ats.rippling.com` 的根路径 308 跳 www.rippling.com/recruiting，是纯候选人面的
  // 招聘板；雇主自己的招聘后台在 app.rippling.com。所以不需要路径否决。
  rippling: { candidateHosts: ['ats.rippling.com'] },
  // `app.dover.com` 根路径 200、标题就是 Dover——**这台主机上有雇主面**，所以那条
  // 路径否决不能去掉（2026-07-29 事故的同一形状：通配主机把雇主后台一起圈进来）。
  dover: { candidateHosts: ['app.dover.com'], candidatePathPrefixes: ['/apply/'] },
  // Suffix recognition is confined to the non-production detection lane;
  // production receives vendor from the exact backend mapping and still runs
  // the shared-host pathname veto before touching DOM.
  bamboohr: { candidateHosts: [], candidateHostSuffixes: ['bamboohr.com'] },
  // `jobs.jobvite.com` 的根路径 301 跳 www.jobvite.com，是纯候选人面的招聘板；
  // 雇主后台在别的主机上。同上，2026-09-22 起合同映射已收口。
  jobvite: { candidateHosts: ['jobs.jobvite.com'] },
  // 不绑厂商的那条路：**候选主机永远为空**，这不是「还没填」。通用路按内容认
  //（这一张表里有几个字段我们认得），不按主机认——给它登记任何主机，都等于把
  //「这一页归谁」这件事从后端的 exact mapping 偷渡回本地 URL 判断。
  // 空表同时保证 `applyHostMatchPatterns` 一条注入范围都不为它派生
  //（RULE-EXT-OPTIONAL-HOST-ONLY）。
  generic: { candidateHosts: [] },
} as const satisfies Readonly<Record<ApplyVendor, VendorCatalogEntry>>;

/** The vendor for a hostname, or null when this is not an ATS we support. */
export function detectApplyVendor(hostname: string): ApplyVendor | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const [vendor, entry] of Object.entries(VENDOR_CATALOG) as Array<[ApplyVendor, VendorCatalogEntry]>) {
    if (entry.candidateHosts.includes(host)) return vendor;
    // 后缀按**标签边界**比对，且注册域自身不算——见 candidateHostSuffixes 头注。
    if (entry.candidateHostSuffixes?.some((suffix) => host.endsWith(`.${suffix}`))) return vendor;
  }
  return null;
}

/**
 * manifest `content_scripts.matches` 用的匹配模式，从上面那份表生成。
 *
 * 由 `wxt.config.ts` 与 `src/entrypoints/apply.content.ts` 共同消费；
 * `ADAPTERS` 是唯一 activation source。给已有厂商接上 adapter 后，manifest
 * 和入口的 matches 自动跟着变，不存在第二份“已启用厂商”状态可漂移。
 */
export function applyHostMatchPatterns(
  // Deliberately structural: L1 stays free of an L4 runtime import while the
  // registry's total ADAPTERS record remains the only activation source.
  adapters: Readonly<Record<ApplyVendor, object | null>>,
): string[] {
  return (Object.entries(VENDOR_CATALOG) as Array<[ApplyVendor, VendorCatalogEntry]>).flatMap(
    ([vendor, entry]) => {
      const adapter = adapters[vendor];
      if (typeof adapter !== 'object' || adapter === null) return [];
      return candidateHostMatchPatterns(entry);
    },
  );
}

/** Build-time packaging helper; invalid path metadata fails closed loudly. */
/**
 * 厂商主机的窄表（P4-16，2026-09-21）。2026-09-24 起商店包不再用它收窄内容脚本——负责人决定第一版上架就开
 * 全网（见 RULE-EXT-OPTIONAL-HOST-ONLY 与 apps/extension/lib/buildConfig.ts `resolveInjectionMatches`）；
 * 它仍是「我们点名支持哪些主机」的单一来源（测试、诊断用）。以下是当初收窄时的说明：
 *
 * `applyHostMatchPatterns(ADAPTERS)` 只按**随包内置**的适配器算：Workday 的内置适配器仍是 null，
 * 于是商店包在 `*.myworkdayjobs.com` 上根本不注入——而 argoland 09-18 起已放行 workday 的策略位、
 * 规则也随 bundle 下发，dock 在生产里靠的是远程 registry 编译的适配器，不是内置那份。
 * 注入范围要跟着**远程发布的厂商清单**走：内置有适配器的，加上 release 里有映射的，取并集、去重、
 * 保持目录顺序。仍然只有目录里点名的主机，没有通配。
 */
export function storeInjectionMatchPatterns(
  adapters: Readonly<Record<ApplyVendor, object | null>>,
  releasedVendors: readonly ApplyVendor[],
): string[] {
  const released = new Set<ApplyVendor>(releasedVendors);
  const seen = new Set<string>();
  return (Object.entries(VENDOR_CATALOG) as Array<[ApplyVendor, VendorCatalogEntry]>).flatMap(
    ([vendor, entry]) => {
      const adapter = adapters[vendor];
      const bundled = typeof adapter === 'object' && adapter !== null;
      if (!bundled && !released.has(vendor)) return [];
      return candidateHostMatchPatterns(entry).filter((pattern) => {
        if (seen.has(pattern)) return false;
        seen.add(pattern);
        return true;
      });
    },
  );
}

export function candidateHostMatchPatterns(entry: VendorCatalogEntry): string[] {
  const prefixes = entry.candidatePathPrefixes ?? ['/'];
  if (prefixes.length === 0 || prefixes.some((prefix) => !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(prefix))) {
    throw new Error('INVALID_CANDIDATE_PATH_PREFIX');
  }
  // 按租户分子域的厂商（Workday 的 `<tenant>.wdN.myworkdayjobs.com`、BambooHR 的
  // `<tenant>.bamboohr.com`）只能用主机通配写：`https://*.<注册域>/…`。注册域自身不匹配（它不承载
  // 任何租户的申请表），与 `detectApplyVendor` 的 `.endsWith('.' + suffix)` 同一条边界。
  const hosts = [
    ...entry.candidateHosts,
    ...(entry.candidateHostSuffixes ?? []).map((suffix) => `*.${suffix}`),
  ];
  return hosts.flatMap((host) =>
    prefixes.map((prefix) => `https://${host}${prefix}*`),
  );
}

/**
 * **隔离世界**入口的宽注入范围（A2b，负责人 2026-08-01 批准）。
 *
 * 为什么需要它：申请表可以出现在任何域名上——Ashby 支持自定义域、Workday 是每租户
 * 一个子域、公司自建招聘页更是任意主机。靠枚举主机名永远追不上。
 *
 * ⚠️ **只有隔离世界的入口用它。** MAIN world 那个桥必须继续用
 * `applyHostMatchPatterns(ADAPTERS)` 的窄表：它是一条 page-observable 的
 * CustomEvent 通道，跟着扩围等于在用户的网银页面主 realm 里装一个我们的监听器
 * ——正是铁律 2/3 要避免的形状。两个常量必须分开。⚠️ 锁死这一点的测试属于
 * 外壳的注入配置（旧仓库由 e2e 纯净度闸门覆盖，未随内核搬入）——apps/extension
 * 接线前必须重建"MAIN world 桥只用窄表、绝不随宽注入扩围"的闸门测试
 * （40-工程计划 T10 分解），在那之前此不变量仅靠本注释与 review 守护。
 *
 * 注入 ≠ 动手。宽注入之后，`gate/hostVeto.ts` + `gate/pageVeto.ts` 会先跑否决，
 * 只有认出厂商才继续。竞品对照：Jobright 与 Simplify 都是全域注入 + 白名单识别，
 * **两家都没有通用引擎**（Jobright 的 getTargetName 认不出就什么都不创建）。
 */
export const AUTOFILL_WIDE_MATCHES: readonly string[] = ['https://*/*'];

/**
 * manifest 层的第一道闸，零运行时成本。
 *
 * 排的是"注入进去必然是浪费或危险"的域：验证码与挑战服务、追踪像素、广告帧。
 * 名单起点抄自 Jobright 的 exclude_matches（2026-08-01 解包实测），
 * 我们在它基础上补了主流验证码与人机识别服务——Simplify **一条 exclude 都没有**，
 * 于是它注入进每一个追踪像素。
 */
export const AUTOFILL_EXCLUDE_MATCHES: readonly string[] = [
  // 挑战 / 人机识别
  'https://*.cloudflare.com/*',
  'https://challenges.cloudflare.com/*',
  'https://www.google.com/recaptcha/*',
  'https://www.recaptcha.net/*',
  'https://*.hcaptcha.com/*',
  'https://*.arkoselabs.com/*',
  'https://*.perimeterx.net/*',
  'https://*.datadome.co/*',
  // 追踪 / 广告 / 标签管理
  'https://www.googletagmanager.com/*',
  'https://*.doubleclick.net/*',
  'https://*.google-analytics.com/*',
  'https://*.demdex.net/*',
  'https://*.segment.io/*',
  'https://*.hotjar.com/*',
  // 支付 —— 内嵌支付帧绝不能有我们的脚本
  'https://js.stripe.com/*',
  'https://*.paypal.com/*',
  'https://*.adyen.com/*',
];

/** Every known candidate-side ATS origin, for shipping-package purity checks. */
export function allCandidateHostMatchPatterns(): string[] {
  return Object.values(VENDOR_CATALOG).flatMap(candidateHostMatchPatterns);
}
