import type { ExecutionRuntimeWriteCapability } from '@edaix/contracts';
/**
 * Runtime policy for the sideload-only autofill surface.
 *
 * This module is deliberately conservative: a missing, malformed, expired,
 * or incompatible policy never becomes an implicit allow.  The future
 * background/API refresh path only needs to write a validated cache record;
 * it cannot broaden any bundled restriction because `tighten` is monotonic.
 */

import { APPLY_VENDORS, type ApplyVendor } from './contracts';
import type { WriteCapability } from './grant';

export const APPLY_POLICY_CACHE_KEY = 'vibeApplyPolicy';
export const APPLY_POLICY_INSTALLED_AT_KEY = 'vibeApplyPolicyInstalledAt';
export const APPLY_POLICY_KILL_KEY = 'vibeApplyKill';

/** Local automation restriction (product/11 §5.1, §6.2), independent of remote policy. */
export const LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES = Object.freeze([
  'linkedin.com',
  // Includes the documented apply.indeed.com and smartapply.indeed.com frames.
  'indeed.com',
] as const);

export function isLocallyAutomationDenied(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export const APPLY_POLICY_TTL_MS = 24 * 60 * 60 * 1000;
export const APPLY_POLICY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 无远程策略缓存时的安装宽限期。**当前等于包内硬有效期**（2026-08-12 负责人裁决）。
 *
 * 原值 72 小时的前提是"存在会写 `APPLY_POLICY_CACHE_KEY` 的取数通道"，
 * 但那条通道只建了读的一半——全仓没有生产写入方。于是每个内测包装满三天
 * 就走到宽限尽头静默自杀：注入正常、零报错、浮层永远不出现。
 *
 * 放宽到与 `APPLY_POLICY_LIFETIME_MS` 相等后，真正的到期约束回到
 * `notAfter`（构建时间 + 30 天硬过期，resolver 第一行检查）——
 * "无界授权"仍然不存在。取数通道上线后，这里应收回到远高于取数周期的小值
 * （例如 7 天），让"通道断了"重新变得可感知。
 */
export const APPLY_POLICY_GRACE_MS = APPLY_POLICY_LIFETIME_MS;

/**
 * 参与远程策略合并的能力位**全集**。
 *
 * ⚠️ 这里漏一项是**静默**的：`satisfies readonly WriteCapability[]` 只校验
 * 元素属于联合类型，**不校验穷尽**。审查实测（2026-08-19）：
 * 往 `WriteCapability` 加了 `set-attestation` 而这一行没跟着改，
 * `tsc --noEmit` 照样 exit 0，而 `tighten()` 用 `WRITE_CAPABILITIES.map(...)`
 * 重建 capabilities——那一位**被整个丢掉**：
 *
 *   bundled  → set-attestation: false
 *   resolved → 键不存在，值 undefined
 *
 * 两个方向都坏：包内那个 `false` 没参与合并（今天仍 fail-closed 纯属侥幸，
 * `undefined` 是 falsy 而调用方恰好按真值筛；任何一处改成 `!== false` 就开洞），
 * 而且「只把包内改成 true 就是放行动作」也不成立——改了在远程路径上没效果。
 *
 * 下面的 `EXHAUSTIVE` 让漏加变成**编译错误**，不再靠人记得。
 */
const WRITE_CAPABILITIES = [
  'set-text',
  'set-select',
  'set-combobox',
  'set-richtext',
  'manage-rows',
  'set-file',
  'set-other-person',
  'set-attestation',
  // 乙档 EEO 自我认同。旧策略 blob 里没有这个键 → booleanRecord 判 false →
  // 默认关，要开由后端按策略下发。
  'set-self-identification',
  'set-work-authorization',
  'set-referral',
  // 多页申请的翻页（2026-09-22）。出厂 false，要开由远程策略下发。
  'advance-step',
  // 连填：一次「自动填写」一页一页填到检查页（2026-09-28）。出厂 false，要开由远程策略下发。
  'advance-steps',
  // 代填条款、声明与签名（2026-09-23）。出厂 false，要开由远程策略下发；每个用户还得单独同意过。
  'sign-on-behalf',
  // 在插件里提交（2026-09-23）。出厂 false，要开由远程策略下发。
  'submit-application',
  // 替用户注册、登录招聘网站（2026-09-28）。出厂 false，要开由远程策略下发；每个用户还得同意过点名这一类的那一版文案。
  'account-access',
] as const satisfies readonly WriteCapability[];

/**
 * 穷尽性闸门：`WRITE_CAPABILITIES` 少一项，这一行就编译不过。
 *
 * 写成类型级断言而不是运行时检查——运行时检查要有人调用才生效，
 * 而这个错误的形态恰好是「没人想起来」。
 */
type _ExhaustiveWriteCapabilities = readonly [
  ...{ [K in WriteCapability]: K }[WriteCapability][],
] extends readonly (typeof WRITE_CAPABILITIES)[number][]
  ? Exclude<WriteCapability, (typeof WRITE_CAPABILITIES)[number]> extends never
    ? true
    : ['WRITE_CAPABILITIES 漏了这些能力位：', Exclude<WriteCapability, (typeof WRITE_CAPABILITIES)[number]>]
  : never;
const _exhaustive: _ExhaustiveWriteCapabilities = true;
void _exhaustive;

export interface ApplyPolicy {
  readonly version: string;
  readonly minExtensionVersion: string;
  readonly enabled: boolean;
  readonly vendors: Readonly<Record<ApplyVendor, boolean>>;
  readonly capabilities: Readonly<Record<WriteCapability, boolean>>;
  readonly minConfidence: number;
  readonly inferredRequiresConfirm: boolean;
  readonly notAfter: number;
  /**
   * 主机名粒度的止血通道：命中任一后缀的页面一律不注入、不填充。
   *
   * **为什么必须先于全网注入存在**：在它之前，远程策略只能做两件事——整体 kill，
   * 或按四家 vendor 之一 kill。一旦线上出现误注入（"我们在某国社保申请页上弹了
   * 浮层"），唯一的止血手段是关掉整个 autofill。装灭火器要在点火之前。
   *
   * 合并规则是**并集**（见 `tighten`）：远程只能增加否决，永远不能减少。
   * 这保持了 tighten 的单调性——它的名字承诺的就是"只会更严"。
   */
  readonly deniedHostSuffixes: readonly string[];
  readonly source: 'bundled' | 'remote' | 'disabled';
}

interface ParsedRemotePolicy {
  readonly version: string;
  readonly minExtensionVersion: string;
  readonly enabled: boolean;
  readonly vendors: Readonly<Record<ApplyVendor, boolean>>;
  readonly capabilities: Readonly<Record<WriteCapability, boolean>>;
  readonly minConfidence: number;
  readonly inferredRequiresConfirm: boolean;
  readonly notAfter: number;
  readonly deniedHostSuffixes: readonly string[];
}

interface CachedApplyPolicy {
  readonly policy: ParsedRemotePolicy;
  readonly fetchedAt: number;
}

export interface ResolveApplyPolicyInput {
  readonly bundled: ApplyPolicy;
  readonly now: number;
  readonly extensionVersion: string;
  /** The key's presence is sticky: its value is intentionally irrelevant. */
  readonly killPresent: boolean;
  readonly installedAt: unknown;
  readonly cachePresent: boolean;
  readonly cached: unknown;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 把一个开关记录解析成全量布尔表，**对两个方向的 schema 漂移都容错**。
 *
 * ⚠️ 这里原本是 `exactBooleanRecord`：要求键集**完全相等**，否则整包拒绝。
 * 它有一个会造成全量停服的失效模式，而且今天真的发生了——
 * 给 `WRITE_CAPABILITIES` 加 `set-file` 的那一刻，线上所有已缓存的三键 blob
 * 全部解析失败 → `tighten` 返回 disabledPolicy → **autofill 对所有人整体关闭**，
 * 而且完全静默。（`tests/apply-denied-hosts.test.ts` 当场抓到，8 条同时变红。）
 *
 * 容错方向经过选择，不是一律放行：
 *  - **缺键 → false**。fail-closed：远程策略没提到的能力位一律不授予。
 *    新版扩展在旧 blob 下会少一项能力，而不是全盘失效。
 *  - **多余的未知键 → 忽略**。旧版扩展遇到新 blob 时不会被未来的键炸掉。
 *  - **非布尔值 → false**。同样是 fail-closed。
 *
 * 安全属性不变：这个函数**只能减少**授予，永远不会凭空多授予一项能力。
 */
function booleanRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
): Readonly<Record<K, boolean>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.map((key) => [key, record[key] === true]),
  ) as Record<K, boolean>;
}

function parseRemotePolicy(value: unknown): ParsedRemotePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (
    !isNonEmptyString(policy.version) ||
    !isNonEmptyString(policy.minExtensionVersion) ||
    typeof policy.enabled !== 'boolean' ||
    !booleanRecord(policy.vendors, APPLY_VENDORS) ||
    !booleanRecord(policy.capabilities, WRITE_CAPABILITIES) ||
    typeof policy.minConfidence !== 'number' ||
    !Number.isFinite(policy.minConfidence) ||
    policy.minConfidence < 0 ||
    policy.minConfidence > 1 ||
    typeof policy.inferredRequiresConfirm !== 'boolean' ||
    !isFiniteTimestamp(policy.notAfter)
  ) {
    return null;
  }

  // ⚠️ **可选字段 + 缺省空数组**，不能是必填。
  //
  // `exactBooleanRecord` 的教训就在隔壁：它要求键集完全相等，所以往
  // APPLY_VENDORS 加一个键会让**所有已缓存的旧 blob** 解析失败 → fail-closed →
  // 四家一起黑掉。新增的顶层字段必须对旧 blob 向后兼容，否则这次发版就是一次
  // 静默的全量停服。形状不合法时按"没提供"处理，而不是整包拒绝——
  // 一个手滑的运维配置不该关掉所有人的 autofill。
  const deniedHostSuffixes = parseHostSuffixes(policy.deniedHostSuffixes);

  return {
    version: policy.version,
    minExtensionVersion: policy.minExtensionVersion,
    enabled: policy.enabled,
    // 用解析结果而不是原始对象：原始对象可能缺键、可能带未知键。
    vendors: booleanRecord(policy.vendors, APPLY_VENDORS) as Readonly<Record<ApplyVendor, boolean>>,
    capabilities: booleanRecord(policy.capabilities, WRITE_CAPABILITIES) as Readonly<
      Record<WriteCapability, boolean>
    >,
    minConfidence: policy.minConfidence,
    inferredRequiresConfirm: policy.inferredRequiresConfirm,
    notAfter: policy.notAfter,
    deniedHostSuffixes,
  };
}

function parseCachedPolicy(value: unknown): CachedApplyPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cached = value as Record<string, unknown>;
  const policy = parseRemotePolicy(cached.policy);
  if (!policy || !isFiniteTimestamp(cached.fetchedAt)) return null;
  return { policy, fetchedAt: cached.fetchedAt };
}

function parseSemver(version: string): number[] {
  return version.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
}

export function isExtensionVersionCompatible(
  extensionVersion: string,
  minExtensionVersion: string,
): boolean {
  const current = parseSemver(extensionVersion);
  const minimum = parseSemver(minExtensionVersion);
  for (let index = 0; index < Math.max(current.length, minimum.length); index += 1) {
    const actual = current[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
}

function disabledPolicy(bundled: ApplyPolicy): ApplyPolicy {
  return { ...bundled, enabled: false, source: 'disabled' };
}

/**
 * 包内策略的构建时刻。
 *
 * ⚠️ **2026-08-18 修的一个真事故**：此前只读 `import.meta.env.
 * VITE_VIBE_APPLY_POLICY_BUILT_AT`，而**全仓没有任何地方设过它**
 * （只有这一处读 + 一处类型声明）。于是永远走下面那个写死的兜底
 * `2026-07-29`，+30 天 = **notAfter 恒为 2026-08-28**。
 *
 * 实测后果（不注入 policy、走生产默认路径）：
 * `2026-08-27 → 可填`，`2026-08-29 → 三个字段全部 POLICY_DISABLED、零写入、
 * 用户端零报错`。而且**重新构建也不延期**——builtAt 是写死的，新包出生即过期。
 * 这正是铁律 6 要防的「插件时代 72 小时静默自杀」原样重演。
 *
 * 为什么原来那个变量永远设不上：`apps/extension/wxt.config.ts` 头注明写本项目
 * **刻意不用 `VITE_*` 前缀**（Vite 会自动把它塞进 `import.meta.env`，绕过闸门，
 * 旧仓库实测踩过）。所以唯一能设它的机制正是项目明令禁用的那个。
 *
 * 改成读 wxt `define` 注入的 `__VIBE_APPLY_POLICY_BUILT_AT__`（与
 * `__VIBE_API_BASE__` 同一惯例）。`typeof` 守卫是必需的：本包也被扩展之外的
 * 环境消费，裸引用未定义的全局会 ReferenceError。
 *
 * 兜底仍保留写死时间戳而不是 `Date.now()`——原注释的理由成立且必须保留：
 * 用 `Date.now()` 会让每次重载都变成崭新的 30 天，硬过期这个性质就没了。
 * 真正的保护不在兜底值，在 `wxt.config.ts` 的构建期断言：**define 缺失就炸**，
 * 于是兜底永远不会出现在真实产物里。
 */
/**
 * wxt `define` 注入的包内策略构建时刻（ISO 串）。与 `__VIBE_API_BASE__` 同惯例——
 * 本项目刻意不用 `VITE_*` 前缀，见 apps/extension/wxt.config.ts 头注。
 * 非扩展环境（源码 checkout / vitest）里它不存在，下面用 typeof 守卫。
 *
 * **为什么用 `declare global` 写在这里，而不是放 `env.d.ts`**：
 * 本包被下游从**源码**编译（apps/extension 的 tsc 直接吃 kernel 的 .ts），
 * 而另一个包里的 ambient `.d.ts` 不会被自动带进下游的编译范围。
 * 放 env.d.ts 时 kernel 自己 tsc 是绿的、CI 的 extension-shell 却红
 * （TS2304，2026-08-18 实测）。写在模块里，声明就跟着模块走。
 *
 * ⚠️ 必须是裸标识符。vite/esbuild 的 `define` 做的是**文本替换**——
 * 写成 `globalThis.__VIBE_APPLY_POLICY_BUILT_AT__` 不会被替换，
 * 运行时永远是 undefined，硬过期的保护当场失效且无声。
 */
declare global {
  const __VIBE_APPLY_POLICY_BUILT_AT__: string | undefined;
}

/** 与 `wxt.config.ts` 的注入、`scripts/check-policy-timestamp-baked.mjs` 的判据同源。 */
const BUILT_AT_MARKER = 'vibe-policy-built-at:';

function bundledBuildTime(): number {
  const raw =
    typeof __VIBE_APPLY_POLICY_BUILT_AT__ === 'string' ? __VIBE_APPLY_POLICY_BUILT_AT__ : undefined;
  // 注入值形如 `vibe-policy-built-at:2026-08-19T…Z`。前缀存在的意义是让**产物门禁**
  // 能认出这个时间戳属于策略构建时刻，而不是别处偶然打进包里的某个 ISO 串
  // （Vivian 二次 Blocking 实测：无标记时塞一个 2099-01-01 就能骗过门禁）。
  const injected = raw?.startsWith(BUILT_AT_MARKER) ? raw.slice(BUILT_AT_MARKER.length) : raw;
  const value = Date.parse(injected ?? import.meta.env.VITE_VIBE_APPLY_POLICY_BUILT_AT ?? '');
  return Number.isFinite(value) ? value : Date.UTC(2026, 6, 29);
}

export function createBundledApplyPolicy(builtAt = bundledBuildTime()): ApplyPolicy {
  return {
    version: 'bundled-v1',
    minExtensionVersion: '0.0.0',
    enabled: true,
    // 必须与 registry 的 ADAPTERS 保持一致：没有远程 policy 后端之前，这里写
    // false 等于把一个已经接好的适配器永久关掉，而且**症状完全静默**——
    // content script 正常注入、MAIN bridge 正常安装、表单锚点也在，只有浮层
    // 永远不出现，且零报错（实测 2026-08-01，接入 Lever 时漏改这里）。
    // 由 tests/apply-policy-vendor-parity.test.ts 锁死。
    vendors: {
      greenhouse: true,
      lever: true,
      ashby: true,
      workable: true,
      // 识别已落地、解析器未落地（`ADAPTERS.workday === null`）。这里必须是
      // false——上面那条不变量是「有适配器 ⇔ 内置 policy 开启」，写 true 等于
      // 声称一个不存在的适配器可用。解析器落地时与 ADAPTERS 同一提交翻开。
      workday: false,
      // 同上：识别已落地（DOM 指纹，见 gate/vendorFingerprint.ts），解析器未落地。
      avature: false,
      // 第五家：适配器已接好（ADAPTERS.smartrecruiters 非 null），
      // 按「有适配器 ⇔ 内置 policy 开启」这条不变量必须为 true。
      smartrecruiters: true,
      // 第六家，适配器已接好，按「有适配器 ⇔ 内置 policy 开启」必须为 true。
      icims: true,
      // 第七家，适配器资产已接好，同一条 legacy/test parity 不变量。production
      // execution lane 不读取 bundled policy，只认 fresh backend runtime bundle。
      rippling: true,
      // 第八家，同上；VENDOR_CATALOG 主机表为空，不能由本地 URL 触发。
      dover: true,
      // 第九家，同上；provider/path 合同映射缺失时保持不可执行。
      bamboohr: true,
      // 第十家，legacy/test 适配器资产已接好；本地主机表为空，production
      // provider/path 合同映射缺失时保持不可执行。
      jobvite: true,
      // 不绑厂商的那条路：随包**永久关闭**。在远程 policy 后端存在之前，这里写
      // false 不是「等远程打开」而是「永久关闭」，而这正是想要的——通用路只该在
      // 后端已验证的 runtime bundle 里有 GENERIC 的 exact mapping 时才活起来。
      // 与 `ADAPTERS.generic === null` 成对：有适配器 ⇔ policy 开，是双向不变量。
      generic: false,
    },
    capabilities: {
      'set-text': true,
      'set-select': true,
      // 下拉点击的范围依据见 16 号裁决授权卡 A 栏。它是独立能力位，
      // 远程 policy 可以只关掉点击而保留纯文本填充——万一某家厂商改了控件
      // 导致我们的编排误点，这是唯一有意义的止血开关。
      'set-combobox': true,
      // New host-mutation surface: remains repository-candidate/default-off.
      'set-richtext': false,
      // 增删行是独立能力位（CAP-AF-003）。默认**关闭**：它比下拉点击更进一步——
      // Workable 的 save-section 会把一整段经历提交给宿主，撤销只能靠删行。
      // 高风险能力默认关闭并 fail closed（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）；
      // 每家的行动作选择器都在真实页面上验过、且远程 policy 明确放行之后才开。
      'manage-rows': false,
      // 简历文件是独立能力位：万一某家厂商改了控件导致我们挂错文件，
      // 这是唯一能只关掉传简历、保留纯文本填充的开关。
      'set-file': true,
      // 他人信息栏（推荐人 / 紧急联系人）。默认关闭并**不是**因为它敏感到不能做，
      // 而是因为今天没有他人数据源：打开它而没有数据，等于让无锚点的标签正则
      // 把申请人本人的资料写进推荐人栏。有数据源的部署把这一位打开即可。
      'set-other-person': false,
      // 推荐人（P1-9）：数据源是用户亲手存的推荐人清单，只预填姓名、等用户点头。要开由远程策略下发。
      'set-referral': false,
      // 翻页（2026-09-22）：按宿主的 Save and Continue 会把这一步保存进宿主，与增删行同类，
      // 默认关闭并 fail closed（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。要开由远程策略下发。
      'advance-step': false,
      // 连填（2026-09-28）：填完一页不等用户再按、接着替他按翻页。翻页那一下会把这一步保存进宿主，与翻页同类，
      // 默认关闭并 fail closed；缺席也读作关，回到每一页一颗「继续到下一页」。要开由远程策略下发。
      'advance-steps': false,
      // 代填条款、声明与签名（2026-09-23）：默认关闭并 fail closed。要开由远程策略下发，
      // 并且每个用户还得在资料页单独勾过同意（调用方读后端记录，读不到当没同意）。
      'sign-on-behalf': false,
      // 在插件里提交（2026-09-23）：替用户按网站的最终提交是最重的一下，默认关闭并 fail closed。
      // 要开由远程策略下发；按也只按规则声明的那一颗，而且只在用户按下浮层里「提交」的那一刻。
      'submit-application': false,
      // 替用户注册、登录招聘网站（2026-09-28）：写的是密码、按的是「登录」「注册」，默认关闭并 fail closed。要开由远程策略
      // 下发，并且每个用户还得在资料页同意过点名这一类的那一版文案（worker 读后端记录，读不到当没同意）。
      'account-access': false,
      // ⚠️ C3 放行闸：`PD-2026-08-18-IRONCLAD-5-SPLIT` 的乙档代勾，
      // 在源契约、T21、确认 UI 与专用 release authority 落定前物理上开不了。
      // 只把这里改成 true 仍会被通用 mint 拒绝，不能构成放行动作。
      'set-attestation': false,
      // 乙档 EEO：确认链闭合之前不该有任何自动写入。
      'set-self-identification': false,
      // 乙档工作授权：同样等确认链闭合。
      'set-work-authorization': false,
    },
    minConfidence: 0.7,
    // 本地产品限制不能由远程空表解除；远程仍可增加事故止血后缀。
    // 政府与雇主后台的现有纯规则在 gate/hostVeto.ts，所有操作门共用。
    deniedHostSuffixes: LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES,
    inferredRequiresConfirm: true,
    notAfter: builtAt + APPLY_POLICY_LIFETIME_MS,
    source: 'bundled',
  };
}

/**
 * Combine a bundled baseline with a remote policy. Every operation can only
 * reduce what the bundle permits: booleans use AND, confidence uses MAX, and
 * expiry uses MIN. A malformed remote policy disables rather than falls back.
 */
/** 后缀表的上限。远程 blob 不该能塞进一份无界的名单。 */
const MAX_DENIED_HOST_SUFFIXES = 512;

/**
 * 解析主机后缀否决表。**形状不合法一律按"没提供"处理，不整包拒绝**——
 * 一个手滑的运维配置不该关掉所有人的 autofill。
 */
function parseHostSuffixes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    // 至少要有一个点：单标签后缀（如 "com"、"org"）会一次性否掉半个互联网。
    if (host === '' || host.length > 253 || !host.includes('.')) continue;
    if (!/^[a-z0-9.-]+$/.test(host)) continue;
    out.push(host);
    if (out.length >= MAX_DENIED_HOST_SUFFIXES) break;
  }
  return [...new Set(out)];
}

/**
 * 这个主机名是否被否决。
 *
 * 按**标签边界**匹配，不是纯字符串后缀：`nav.no` 命中 `nav.no` 与 `www.nav.no`，
 * 但**不**命中 `notnav.no`。纯 `endsWith` 会让一条否决意外扩散到无关域名上，
 * 而否决表本身就是给运维在事故中用的，误伤范围必须可预测。
 */
export function isHostDenied(policy: Pick<ApplyPolicy, 'deniedHostSuffixes'>, hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return false;
  // Exported callers may pass a remote-only projection. It cannot erase the local rule.
  if (isLocallyAutomationDenied(host)) return true;
  return policy.deniedHostSuffixes.some((raw) => {
    // 后缀也要归一化：`parseHostSuffixes` 出来的已经是小写，但这个谓词是导出的，
    // 调用方可能拿一份手工构造的 policy 进来（测试、以及将来的内置基线）。
    // 只归一化一边的谓词是个半成品——它在大部分调用点碰巧对。
    const suffix = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    return suffix !== '' && (host === suffix || host.endsWith(`.${suffix}`));
  });
}

export function tighten(bundled: ApplyPolicy, remote: unknown): ApplyPolicy {
  const parsed = parseRemotePolicy(remote);
  if (!parsed) return disabledPolicy(bundled);

  const vendors = Object.fromEntries(
    APPLY_VENDORS.map((vendor) => [vendor, bundled.vendors[vendor] && parsed.vendors[vendor]]),
  ) as Record<ApplyVendor, boolean>;
  const capabilities = Object.fromEntries(
    WRITE_CAPABILITIES.map((capability) => [
      capability,
      bundled.capabilities[capability] && parsed.capabilities[capability],
    ]),
  ) as Record<WriteCapability, boolean>;

  return {
    version: parsed.version,
    minExtensionVersion: parsed.minExtensionVersion,
    enabled: bundled.enabled && parsed.enabled,
    vendors,
    capabilities,
    minConfidence: Math.max(bundled.minConfidence, parsed.minConfidence),
    inferredRequiresConfirm: bundled.inferredRequiresConfirm || parsed.inferredRequiresConfirm,
    notAfter: Math.min(bundled.notAfter, parsed.notAfter),
    // 并集：远程只能**增加**否决。这是 tighten 单调性的一部分——
    // 任何"远程可以取消一条否决"的写法都会让止血通道反过来变成开洞通道。
    deniedHostSuffixes: [
      ...new Set([
        ...LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES,
        ...bundled.deniedHostSuffixes,
        ...parsed.deniedHostSuffixes,
      ]),
    ],
    source: 'remote',
  };
}

/**
 * Pure fail-closed resolver. Keeping the decision separate from browser
 * storage makes every bad-cache and sticky-kill case table-testable.
 */
export function resolveApplyPolicy(input: ResolveApplyPolicyInput): ApplyPolicy {
  const { bundled, now, extensionVersion } = input;
  if (!Number.isFinite(now) || now > bundled.notAfter || input.killPresent) {
    return disabledPolicy(bundled);
  }

  if (input.cachePresent) {
    const cached = parseCachedPolicy(input.cached);
    if (
      !cached ||
      cached.fetchedAt > now ||
      now - cached.fetchedAt > APPLY_POLICY_TTL_MS ||
      !isExtensionVersionCompatible(extensionVersion, cached.policy.minExtensionVersion)
    ) {
      return disabledPolicy(bundled);
    }

    const policy = tighten(bundled, cached.policy);
    return now > policy.notAfter ? disabledPolicy(policy) : policy;
  }

  // The grace period is intentionally only for a truly absent cache. A stale
  // or malformed cache is evidence that the policy channel failed, not a
  // reason to reset an entitlement by clearing storage.
  if (
    !isFiniteTimestamp(input.installedAt) ||
    input.installedAt > now ||
    now - input.installedAt > APPLY_POLICY_GRACE_MS
  ) {
    return disabledPolicy(bundled);
  }
  return bundled;
}

function storageHas(storage: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(storage, key);
}

function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Browser-backed half of the policy gate. No network fallback exists yet: if
 * the background/API refresh path is unavailable, a newly installed test
 * package works only during the bounded grace period and then disables itself.
 */
export async function loadApplyPolicy(
  now = Date.now(),
  bundled = createBundledApplyPolicy(),
): Promise<ApplyPolicy> {
  try {
    const stored = (await browser.storage.local.get([
      APPLY_POLICY_CACHE_KEY,
      APPLY_POLICY_INSTALLED_AT_KEY,
      APPLY_POLICY_KILL_KEY,
    ])) as Record<string, unknown>;

    let installedAt = stored[APPLY_POLICY_INSTALLED_AT_KEY];
    if (!storageHas(stored, APPLY_POLICY_INSTALLED_AT_KEY)) {
      await browser.storage.local.set({ [APPLY_POLICY_INSTALLED_AT_KEY]: now });
      installedAt = now;
    }

    return resolveApplyPolicy({
      bundled,
      now,
      extensionVersion: extensionVersion(),
      killPresent: storageHas(stored, APPLY_POLICY_KILL_KEY),
      installedAt,
      cachePresent: storageHas(stored, APPLY_POLICY_CACHE_KEY),
      cached: stored[APPLY_POLICY_CACHE_KEY],
    });
  } catch {
    return disabledPolicy(bundled);
  }
}

export function isApplyPolicyEnabled(policy: ApplyPolicy, vendor: ApplyVendor, now = Date.now()): boolean {
  return policy.enabled && policy.vendors[vendor] && now <= policy.notAfter;
}

/**
 * 编译期 parity 闸：内核的写能力位集合必须与 wire 契约的逐字相等。
 *
 * 这道闸的由来：两边曾经漂移过——内核实现了 set-richtext / manage-rows /
 * set-other-person，契约里却只有五位，于是后端根本说不出这三个词，能力永远
 * 授权不出来，而且没有任何东西会报错。任一侧加减能力位、另一侧没跟上，从今天
 * 起在 tsc 阶段就炸，而不是等到线上发现某个框永远填不了。
 *
 * 契约是权威：漂移时改的是内核这边跟上，或在 argoland 提 additive 契约变更，
 * 而不是把闸删掉。
 */
type AssertTrue<T extends true> = T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const WRITE_CAPABILITY_PARITY: AssertTrue<
  MutuallyAssignable<WriteCapability, ExecutionRuntimeWriteCapability>
> = true;
