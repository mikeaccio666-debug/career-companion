import { PRODUCTION_API_BASE, PRODUCTION_WEB_APP_BASE } from './lib/deploymentConfig';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { DEVELOPMENT_EXTENSION_PUBLIC_KEY, LOCAL_EXTENSION_PUBLIC_KEY } from './lib/developmentIdentity';
import { resolveApiBaseOverride, resolveBuildFlavor, resolveExtensionPublicKey, resolveInjectionMatches, resolveTrustTelemetryDeliveryEnabled, resolveWebBaseOverride } from './lib/buildConfig';
import { CONNECTED_DEVELOPMENT_REALM, CONNECTED_STAGING_REALM } from './lib/connectedRuntimeRealm';
import {
  isPilotUa5ControlledLocalTuple,
  PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY,
  PILOT_UA5_CONTROLLED_LOCAL_ORIGIN,
  PILOT_UA5_CONTROLLED_LOCAL_PATHNAME,
  PILOT_UA5_CONTROLLED_LOCAL_URL,
} from './lib/pilotUa5ControlledLocalAdmission';

/** 本包 node_modules 里 wxt 的具体文件（wxt 的 exports map 不放行 require.resolve）。 */
function wxtModulePath(relative: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/wxt', relative);
}

/**
 * 执行器外壳（T10 第四刀 b 段）——最小可用骨架。
 *
 * 配置纪律全部继承自旧仓库 wxt.config.ts 的实战结论（gate 测试锁字面一致）：
 *
 *  1. **商店包永远拿不到 API/门户覆盖**：`VIBE_DIST=store` 时覆盖函数直接
 *     返回 null——一个手滑的环境变量绝不能让上架包指向 staging。
 *  2. **注入权唯一在 define**：用 `__VIBE_API_BASE__` 全局常量而不是
 *     `VITE_*`（Vite 会自动把 VITE_ 前缀塞进 import.meta.env，绕过闸门——
 *     旧仓库实测踩过）。
 *  3. **客户端指哪儿，manifest 放行哪儿**：覆盖生效时同一 origin 必须进
 *     host_permissions / externally_connectable，否则表现为"登录不上"。
 *  4. **宽窄注入分离**：隔离世界内容脚本可用 AUTOFILL_WIDE_MATCHES；
 *     将来任何 MAIN world 入口只许用 applyHostMatchPatterns 的窄表
 *     （tests/injection-scope-gate 锁死）。
 */

const STORE_BUILD = process.env.VIBE_DIST === 'store';
// The new product has no production realm, store listing or release policy yet.
// This guard applies to direct WXT calls as well as package scripts.
if (STORE_BUILD) throw new Error('NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED');
const FIELD_LAB_BUILD = process.env.VIBE_DIST === 'field-lab';
// ATS lab: a local, unpacked-only artifact that drives the kernel directly on
// real ATS pages with mock data. It has its own entrypoints directory, its own
// output directory and no extension id key, so it can never be confused with
// or collide with a shippable artifact.
const ATS_LAB_BUILD = process.env.VIBE_DIST === 'ats-lab';
const CONNECTED_STAGING_BUILD = process.env.VIBE_DIST === 'connected-staging';
const CONNECTED_DEV_BUILD = process.env.VIBE_DIST === 'connected-dev' || CONNECTED_STAGING_BUILD;
// Local test package (2026-09-16): the ordinary artifact with its own identity,
// pointed at the developer's own `pnpm dev:staging` backend on this machine.
// It exists so the dock can be exercised end to end -- real writes included --
// without touching the artifact that points at argoland.ai, which stays in
// `.output` under its own id. Everything about it is loopback-only, and the
// realm check below refuses to build it against anything else.
const LOCAL_BUILD = process.env.VIBE_DIST === 'local';
const STORE_VERSION_RAW = process.env.VIBE_EXTENSION_VERSION;
if (STORE_BUILD && STORE_VERSION_RAW !== undefined && !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(STORE_VERSION_RAW)) {
  throw new Error(`VIBE_EXTENSION_VERSION 不是 x.y.z（${STORE_VERSION_RAW}）——商店包版本号只认三段数字`);
}
const STORE_VERSION = STORE_BUILD && STORE_VERSION_RAW !== undefined ? STORE_VERSION_RAW : null;
const CONNECTED_STAGING_RAW = process.env.VIBE_EXTENSION_CONNECTED_STAGING_ENABLED;
const EXTENSION_FIELD_LAB_RAW = process.env.VIBE_EXTENSION_FIELD_LAB_ENABLED;
const EXTENSION_CONNECTED_DEV_RAW = process.env.VIBE_EXTENSION_CONNECTED_DEV_ENABLED;
const CONNECTED_DEV_WRITE_RAW = process.env.VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED;
const CONNECTED_DEV_TARGET_RAW = process.env.VIBE_EXTENSION_CONNECTED_DEV_TARGET_URL;
const CONNECTED_DEV_WRITE_AUTHORITY_RAW =
  process.env.VIBE_EXTENSION_CONNECTED_DEV_WRITE_AUTHORITY;
const CONNECTED_DEV_NOT_BEFORE_RAW = process.env.VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE;
const CONNECTED_DEV_NOT_AFTER_RAW = process.env.VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER;
function parseExplicitWindowTime(raw: string | undefined): number {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw)) return 0;
  const parsed = Date.parse(raw);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === raw ? parsed : 0;
}
const CONNECTED_DEV_LOCAL_NOT_BEFORE_MS = parseExplicitWindowTime(CONNECTED_DEV_NOT_BEFORE_RAW);
const CONNECTED_DEV_LOCAL_NOT_AFTER_MS = parseExplicitWindowTime(CONNECTED_DEV_NOT_AFTER_RAW);
const CONNECTED_DEV_LOCAL_REQUESTED =
  CONNECTED_DEV_WRITE_AUTHORITY_RAW === PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY;
const CONNECTED_REALM = CONNECTED_STAGING_BUILD ? CONNECTED_STAGING_REALM : CONNECTED_DEVELOPMENT_REALM;
const CONNECTED_DEV_API_BASE = CONNECTED_REALM.apiBase;
const CONNECTED_DEV_WEB_APP_BASE = CONNECTED_REALM.portalOrigin;
const CONNECTED_DEV_ATS_ORIGIN = 'https://job-boards.greenhouse.io';
const CONNECTED_DEV_WRITE_AUTHORITY =
  'POST_PR189_MAIN_2001029F+GREENHOUSE_CONNECTED_DEV_ACTIVATION_IMPLEMENTATION_2026-09-04';
const CONNECTED_STAGING_WRITE_AUTHORITY = 'STAGING_CURRENT_PAGE_FILL_IMPLEMENTATION_APPROVED_2026-09-09';
const CONNECTED_DEV_WRITE_NOT_AFTER_MS = Date.parse('2026-09-12T07:00:00.000Z');
const CONNECTED_DEV_ATS_MATCHES = Object.freeze([
  `${CONNECTED_DEV_ATS_ORIGIN}/*`,
]);

function parseConnectedDevTarget(raw: string | undefined): Readonly<{
  origin: string;
  pathname: string;
}> | null {
  if (raw === undefined || raw.length === 0 || raw !== raw.trim()) return null;
  try {
    const target = new URL(raw);
    if (
      target.href !== raw ||
      target.origin !== CONNECTED_DEV_ATS_ORIGIN ||
      target.username !== '' ||
      target.password !== '' ||
      target.port !== '' ||
      target.search !== '' ||
      target.hash !== '' ||
      !/^\/[A-Za-z0-9._~-]+\/jobs\/[1-9][0-9]{0,19}$/u.test(target.pathname)
    ) return null;
    return Object.freeze({ origin: target.origin, pathname: target.pathname });
  } catch {
    return null;
  }
}

const CONNECTED_DEV_TARGET = CONNECTED_DEV_LOCAL_REQUESTED &&
  CONNECTED_DEV_TARGET_RAW === PILOT_UA5_CONTROLLED_LOCAL_URL
  ? Object.freeze({ origin: PILOT_UA5_CONTROLLED_LOCAL_ORIGIN, pathname: PILOT_UA5_CONTROLLED_LOCAL_PATHNAME })
  : parseConnectedDevTarget(CONNECTED_DEV_TARGET_RAW);
const CONNECTED_DEV_LOCAL_VALID = !STORE_BUILD && isPilotUa5ControlledLocalTuple({
  connectedDev: CONNECTED_DEV_BUILD && EXTENSION_CONNECTED_DEV_RAW === '1',
  stagingEnabled: CONNECTED_STAGING_BUILD && CONNECTED_STAGING_RAW === '1',
  writeEnabled: CONNECTED_DEV_WRITE_RAW === '1',
  apiBase: process.env.VIBE_API_BASE ?? null,
  portalOrigin: process.env.VIBE_WEB_BASE ?? null,
  targetUrl: CONNECTED_DEV_TARGET_RAW ?? null,
  authority: CONNECTED_DEV_WRITE_AUTHORITY_RAW ?? null,
  notBeforeMs: CONNECTED_DEV_LOCAL_NOT_BEFORE_MS,
  notAfterMs: CONNECTED_DEV_LOCAL_NOT_AFTER_MS,
});
const CONNECTED_STAGING_WRITE_VALID = CONNECTED_STAGING_BUILD && CONNECTED_STAGING_RAW === '1' &&
  EXTENSION_CONNECTED_DEV_RAW === '1' && CONNECTED_DEV_WRITE_RAW === '1' && !CONNECTED_DEV_LOCAL_REQUESTED &&
  CONNECTED_DEV_WRITE_AUTHORITY_RAW === CONNECTED_STAGING_WRITE_AUTHORITY && CONNECTED_DEV_TARGET !== null &&
  CONNECTED_DEV_LOCAL_NOT_BEFORE_MS > 0 && CONNECTED_DEV_LOCAL_NOT_AFTER_MS > CONNECTED_DEV_LOCAL_NOT_BEFORE_MS &&
  CONNECTED_DEV_LOCAL_NOT_AFTER_MS - CONNECTED_DEV_LOCAL_NOT_BEFORE_MS <= 15 * 60_000;

if (!STORE_BUILD) {
  if ((CONNECTED_STAGING_BUILD && CONNECTED_STAGING_RAW !== '1') ||
    (!CONNECTED_STAGING_BUILD && CONNECTED_STAGING_RAW !== undefined && CONNECTED_STAGING_RAW !== '0')) {
    throw new Error('CONNECTED_STAGING_BUILD_IDENTITY_INVALID');
  }
  if (
    (CONNECTED_DEV_LOCAL_REQUESTED && !CONNECTED_DEV_LOCAL_VALID) ||
    (!CONNECTED_DEV_LOCAL_REQUESTED && !CONNECTED_STAGING_WRITE_VALID &&
      (CONNECTED_DEV_NOT_BEFORE_RAW !== undefined || CONNECTED_DEV_NOT_AFTER_RAW !== undefined))
  ) {
    throw new Error('CONNECTED_DEV_LOCAL_ADMISSION_INVALID: exact local tuple and explicit bounded window required');
  }
  if (
    EXTENSION_FIELD_LAB_RAW !== undefined &&
    EXTENSION_FIELD_LAB_RAW !== '0' &&
    EXTENSION_FIELD_LAB_RAW !== '1'
  ) {
    throw new Error(
      'FIELD_LAB_FLAG_INVALID: VIBE_EXTENSION_FIELD_LAB_ENABLED 只接受 0 或 1',
    );
  }
  if (FIELD_LAB_BUILD && EXTENSION_FIELD_LAB_RAW !== '1') {
    throw new Error(
      'FIELD_LAB_BUILD_IDENTITY_INVALID: VIBE_DIST=field-lab 必须同时设置 VIBE_EXTENSION_FIELD_LAB_ENABLED=1',
    );
  }
  if (!FIELD_LAB_BUILD && EXTENSION_FIELD_LAB_RAW === '1') {
    throw new Error(
      'FIELD_LAB_BUILD_IDENTITY_INVALID: VIBE_EXTENSION_FIELD_LAB_ENABLED=1 只允许 VIBE_DIST=field-lab',
    );
  }
  if (
    EXTENSION_CONNECTED_DEV_RAW !== undefined &&
    EXTENSION_CONNECTED_DEV_RAW !== '0' &&
    EXTENSION_CONNECTED_DEV_RAW !== '1'
  ) {
    throw new Error(
      'CONNECTED_DEV_FLAG_INVALID: VIBE_EXTENSION_CONNECTED_DEV_ENABLED 只接受 0 或 1',
    );
  }
  if (CONNECTED_DEV_BUILD && EXTENSION_CONNECTED_DEV_RAW !== '1') {
    throw new Error(
      'CONNECTED_DEV_BUILD_IDENTITY_INVALID: VIBE_DIST=connected-dev 必须同时设置 VIBE_EXTENSION_CONNECTED_DEV_ENABLED=1',
    );
  }
  if (!CONNECTED_DEV_BUILD && EXTENSION_CONNECTED_DEV_RAW === '1' && !FIELD_LAB_BUILD) {
    throw new Error(
      'CONNECTED_DEV_BUILD_IDENTITY_INVALID: VIBE_EXTENSION_CONNECTED_DEV_ENABLED=1 只允许 VIBE_DIST=connected-dev',
    );
  }
  if (
    CONNECTED_DEV_WRITE_RAW !== undefined &&
    CONNECTED_DEV_WRITE_RAW !== '0' &&
    CONNECTED_DEV_WRITE_RAW !== '1'
  ) {
    throw new Error(
      'CONNECTED_DEV_WRITE_FLAG_INVALID: VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED 只接受 0 或 1',
    );
  }
  if (CONNECTED_DEV_WRITE_RAW === '1') {
    if (
      !CONNECTED_DEV_BUILD ||
      EXTENSION_CONNECTED_DEV_RAW !== '1' ||
      (!(!CONNECTED_STAGING_BUILD && CONNECTED_DEV_WRITE_AUTHORITY_RAW === CONNECTED_DEV_WRITE_AUTHORITY) &&
        !CONNECTED_DEV_LOCAL_VALID && !CONNECTED_STAGING_WRITE_VALID)
    ) {
      throw new Error(
        'CONNECTED_DEV_WRITE_AUTHORITY_INVALID: exact-page activation authority tuple 不完整',
      );
    }
    if (CONNECTED_DEV_TARGET === null) {
      throw new Error(
        'CONNECTED_DEV_TARGET_INVALID: 必须提供无 credential/query/hash 的 exact Greenhouse job URL',
      );
    }
  } else if (
    CONNECTED_DEV_TARGET_RAW !== undefined ||
    CONNECTED_DEV_WRITE_AUTHORITY_RAW !== undefined
  ) {
    throw new Error(
      'CONNECTED_DEV_WRITE_AUTHORITY_INVALID: target/authority 只允许与 write flag=1 同时出现',
    );
  }
}

// New product has no deployed realm; its inert fallback is shared with the worker.
// Explicit local commands provide loopback overrides; no ArgoLand backend is inherited.
/**
 * Pins this build's extension id.
 *
 * Chrome derives the id from this public key, so without it an unpacked build's
 * id follows its directory path — a different id on every machine, and the
 * portal's configured `NEXT_PUBLIC_EXTENSION_APP_ID` matches none of them. The
 * store build never takes one: a published item's id belongs to its listing and
 * a stray environment variable must not be able to claim another identity.
 */
const EXTENSION_PUBLIC_KEY = resolveExtensionPublicKey({
  storeBuild: STORE_BUILD,
  // Only the ordinary artifact falls back to the built-in identity. The other
  // flavours are separate extensions and must not share an id -- two artifacts
  // claiming one id collide the moment both are loaded -- so they keep having to
  // pass their own, and get none when they do not. Store builds are refused
  // either way.
  raw: process.env.VIBE_EXTENSION_PUBLIC_KEY
    ?? (STORE_BUILD || FIELD_LAB_BUILD || CONNECTED_DEV_BUILD || ATS_LAB_BUILD
      ? undefined
      : LOCAL_BUILD
        ? LOCAL_EXTENSION_PUBLIC_KEY
        : DEVELOPMENT_EXTENSION_PUBLIC_KEY),
});

const API_BASE_OVERRIDE = resolveApiBaseOverride({
  storeBuild: STORE_BUILD || FIELD_LAB_BUILD,
  raw: process.env.VIBE_API_BASE,
});
const WEB_BASE_OVERRIDE = resolveWebBaseOverride({
  storeBuild: STORE_BUILD || FIELD_LAB_BUILD,
  raw: process.env.VIBE_WEB_BASE,
  // The one flavour whose portal may be plaintext loopback; see buildConfig.ts.
  loopbackHttp: LOCAL_BUILD || CONNECTED_DEV_BUILD || process.env.VIBE_CONTROLLED_MOCK_WRITES === '1',
});
// The local package is loopback or nothing. Both origins must be given and both
// must be this machine: a local build that silently fell back to production, or
// that borrowed the staging realm, would be the ordinary package under another
// id -- two extensions on one account and the confusion that follows.
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u;
if (LOCAL_BUILD) {
  if (STORE_BUILD || FIELD_LAB_BUILD || CONNECTED_DEV_BUILD || ATS_LAB_BUILD) {
    throw new Error('LOCAL_BUILD_IDENTITY_INVALID: VIBE_DIST=local 不与其它构建形态叠加');
  }
  if (
    API_BASE_OVERRIDE === null || !LOOPBACK_ORIGIN.test(API_BASE_OVERRIDE) ||
    WEB_BASE_OVERRIDE === null || !LOOPBACK_ORIGIN.test(WEB_BASE_OVERRIDE)
  ) {
    throw new Error('LOCAL_BUILD_REALM_INVALID: VIBE_DIST=local 必须同时给出 loopback 的 VIBE_API_BASE 与 VIBE_WEB_BASE');
  }
}
const TRUST_TELEMETRY_DELIVERY_RAW = process.env.VIBE_TRUST_TELEMETRY_ENABLED;
const TRUST_TELEMETRY_DELIVERY_ENABLED = resolveTrustTelemetryDeliveryEnabled({
  storeBuild: STORE_BUILD || FIELD_LAB_BUILD,
  raw: TRUST_TELEMETRY_DELIVERY_RAW,
});
const CONTROLLED_MOCK_WRITES_RAW = process.env.VIBE_CONTROLLED_MOCK_WRITES;
const LIVE_HOST_WRITES_RAW = process.env.VIBE_LIVE_HOST_WRITES;
const EXECUTION_RUNTIME_BUNDLE_RAW = process.env.VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED;
const PILOT_UA1_DISCOVERY_RAW = process.env.VIBE_PILOT_UA1_DISCOVERY_ENABLED;
if (
  !STORE_BUILD &&
  !FIELD_LAB_BUILD &&
  CONTROLLED_MOCK_WRITES_RAW !== undefined &&
  CONTROLLED_MOCK_WRITES_RAW !== '0' &&
  CONTROLLED_MOCK_WRITES_RAW !== '1'
) {
  throw new Error('VIBE_CONTROLLED_MOCK_WRITES 只接受 0 或 1');
}
const CONTROLLED_MOCK_WRITES =
  !STORE_BUILD &&
  !FIELD_LAB_BUILD &&
  !CONNECTED_DEV_BUILD &&
  CONTROLLED_MOCK_WRITES_RAW === '1' &&
  API_BASE_OVERRIDE === 'http://localhost:3000' &&
  WEB_BASE_OVERRIDE === 'http://localhost:3100';
if (
  !STORE_BUILD &&
  !FIELD_LAB_BUILD &&
  !CONNECTED_DEV_BUILD &&
  CONTROLLED_MOCK_WRITES_RAW === '1' &&
  !CONTROLLED_MOCK_WRITES
) {
  throw new Error(
    'VIBE_CONTROLLED_MOCK_WRITES 只允许固定 localhost:3000 / localhost:3100 彩排环境',
  );
}

// 真实站点写入。它只放开"写入"，不引入任何提交动作；最终 Submit 仍是用户自己点。
//
// 商店包恒开，且**不看环境变量**（2026-09-23 负责人决定：「打开这个开关」）。道理与下面规则包取数
// 开关相同——没有它，商店包在每一个真实招聘页上都把策略判成关闭，装上去认得出表单、一格也写不进。
// 远程能关它的是运行时包里的策略（`policy.enabled`，取不到、解不开即关，RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED），
// 不是构建机上一个环境变量。它接受的风险见 lib/hostWriteContainment.ts 的头注（T10，2026-09-11）：
// 宿主在我们派发的 input/change 事件里无事件地提交表单，隔离世界拦不住。
//
// 内部测试构建仍按 VIBE_LIVE_HOST_WRITES=0/1 显式打开；field lab、connected dev 一律关，误设当场炸
// 而不是静默退成生产。
if (
  !STORE_BUILD &&
  !FIELD_LAB_BUILD &&
  LIVE_HOST_WRITES_RAW !== undefined &&
  LIVE_HOST_WRITES_RAW !== '0' &&
  LIVE_HOST_WRITES_RAW !== '1'
) {
  throw new Error('VIBE_LIVE_HOST_WRITES 只接受 0 或 1');
}
const LIVE_HOST_WRITES = STORE_BUILD
  ? true
  : !FIELD_LAB_BUILD &&
    !CONNECTED_DEV_BUILD &&
    LIVE_HOST_WRITES_RAW === '1';

// 覆盖被拒不许静默退生产（审计 2026-08-15）：显式设了覆盖却是非法 origin，
// 开发构建当场炸——否则"以为在打 staging 实际在打生产"。商店包分支在
// resolver 内先行返回 null，不受影响；origin 非 Data-L1，可入错误消息。
//
// 「显式设了」以 `!== undefined` 判定，不是真值判定（审查意见 PR #8，
// 2026-08-16）：`VIBE_API_BASE=''` 在环境里是**存在且非法**的覆盖，真值判定
// 会把它当没设过而静默退回生产，与上面这句话不符。fail-closed 取严的那边。
if (!STORE_BUILD && !FIELD_LAB_BUILD) {
  if (process.env.VIBE_API_BASE !== undefined && API_BASE_OVERRIDE === null) {
    throw new Error(`VIBE_API_BASE 覆盖值被拒收（非法 origin: ${process.env.VIBE_API_BASE}）——拒绝静默退回生产`);
  }
  if (process.env.VIBE_WEB_BASE !== undefined && WEB_BASE_OVERRIDE === null) {
    throw new Error(`VIBE_WEB_BASE 覆盖值被拒收（非法 origin: ${process.env.VIBE_WEB_BASE}）——拒绝静默退回生产`);
  }
  if (
    EXECUTION_RUNTIME_BUNDLE_RAW !== undefined &&
    EXECUTION_RUNTIME_BUNDLE_RAW !== '0' &&
    EXECUTION_RUNTIME_BUNDLE_RAW !== '1'
  ) {
    throw new Error('VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED 只接受 0 或 1');
  }
  if (EXECUTION_RUNTIME_BUNDLE_RAW === '1' && API_BASE_OVERRIDE === null) {
    throw new Error('VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED=1 必须同时提供合法 VIBE_API_BASE');
  }
  if (
    PILOT_UA1_DISCOVERY_RAW !== undefined &&
    PILOT_UA1_DISCOVERY_RAW !== '0' &&
    PILOT_UA1_DISCOVERY_RAW !== '1'
  ) {
    throw new Error('VIBE_PILOT_UA1_DISCOVERY_ENABLED 只接受 0 或 1');
  }
}
if (
  FIELD_LAB_BUILD &&
  (
    process.env.VIBE_API_BASE !== undefined ||
    process.env.VIBE_WEB_BASE !== undefined ||
    (TRUST_TELEMETRY_DELIVERY_RAW !== undefined &&
      TRUST_TELEMETRY_DELIVERY_RAW !== '0' &&
      TRUST_TELEMETRY_DELIVERY_RAW !== 'false') ||
    (CONTROLLED_MOCK_WRITES_RAW !== undefined && CONTROLLED_MOCK_WRITES_RAW !== '0') ||
    (EXECUTION_RUNTIME_BUNDLE_RAW !== undefined && EXECUTION_RUNTIME_BUNDLE_RAW !== '0') ||
    (PILOT_UA1_DISCOVERY_RAW !== undefined && PILOT_UA1_DISCOVERY_RAW !== '0') ||
    (EXTENSION_CONNECTED_DEV_RAW !== undefined && EXTENSION_CONNECTED_DEV_RAW !== '0') ||
    (CONNECTED_DEV_WRITE_RAW !== undefined && CONNECTED_DEV_WRITE_RAW !== '0') ||
    CONNECTED_DEV_TARGET_RAW !== undefined ||
    CONNECTED_DEV_WRITE_AUTHORITY_RAW !== undefined
  )
) {
  throw new Error(
    'FIELD_LAB_RUNTIME_FLAG_CONFLICT: Field Lab build 禁止继承 API、Portal、telemetry、mock-write、execution 或 UA runtime 配置',
  );
}
if (
  CONNECTED_DEV_BUILD &&
  (
    API_BASE_OVERRIDE !== CONNECTED_DEV_API_BASE ||
    WEB_BASE_OVERRIDE !== CONNECTED_DEV_WEB_APP_BASE
  )
) {
  throw new Error(
    'CONNECTED_DEV_RUNTIME_REALM_INVALID: connected-dev 只允许固定 localhost:3000 / localhost:3100 彩排环境',
  );
}
if (
  CONNECTED_DEV_BUILD &&
  (
    (TRUST_TELEMETRY_DELIVERY_RAW !== undefined &&
      TRUST_TELEMETRY_DELIVERY_RAW !== '0' &&
      TRUST_TELEMETRY_DELIVERY_RAW !== 'false') ||
    (CONTROLLED_MOCK_WRITES_RAW !== undefined && CONTROLLED_MOCK_WRITES_RAW !== '0') ||
    (EXECUTION_RUNTIME_BUNDLE_RAW !== undefined && EXECUTION_RUNTIME_BUNDLE_RAW !== '0') ||
    (PILOT_UA1_DISCOVERY_RAW !== undefined && PILOT_UA1_DISCOVERY_RAW !== '0') ||
    (EXTENSION_FIELD_LAB_RAW !== undefined && EXTENSION_FIELD_LAB_RAW !== '0')
  )
) {
  throw new Error(
    'CONNECTED_DEV_RUNTIME_FLAG_CONFLICT: connected-dev 禁止继承 telemetry、mock-write、legacy execution、browser-action 或 Field Lab 配置',
  );
}
/**
 * 规则包取数开关。
 *
 * 商店构建恒开，且**不看环境变量**。这条链的两端本来就该这么接：
 * `bundledAdapters.ts` 的头注写着「生产填表用的从来不是随包那一份，
 * runtimeRegistry 用后端下发的 ruleset 现编适配器」，而 registry 的默认空表是
 * 「没装上之前一切识别 fail closed」。两句合起来就是：商店包必须从后端取规则，
 * 否则适配器表永远空 —— `hasApplyAdapter()` 对所有厂商为假、`dockSurfacesOn()`
 * 为假、dock 在任何 ATS 页面都不出现，装上去是一个什么都不做的插件。
 *
 * 2026-09-16 实测后端这一侧早已就绪：
 *   GET https://api.argoland.ai/api/v1/ext/execution-runtime-bundle → 200，无需鉴权
 *   policy.enabled=true、七家厂商开着、9 条 mapping / 8 份 ruleset。
 * 商店包取它所需的三样也齐了：host_permissions 有 api.argoland.ai、端点不要鉴权、
 * 运行时 apiBase 落在钉死的生产 origin。
 *
 * **环境变量对商店包仍然无效**——这是 build-override-failclosed 那条闸的原意，
 * 保持不变；变的只是结论：从「恒关」改成「恒开」。商店包的 origin 是编译期常量，
 * 取数目标不可能被构建机上一个游离的环境变量污染。
 *
 * 取数失败、超时或配置无效时适配器表保持空 —— 那正是
 * RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 要的行为，不是退化。
 */
const EXECUTION_RUNTIME_BUNDLE_ENABLED = STORE_BUILD
  ? true
  : !FIELD_LAB_BUILD &&
    !CONNECTED_DEV_BUILD &&
    EXECUTION_RUNTIME_BUNDLE_RAW === '1' &&
    API_BASE_OVERRIDE !== null;
// UA-1 is a development-only, exact-page user-triggered lane. Store artifacts
// omit both the flag and the browser action even when the build host has a
// stale environment variable.
const PILOT_UA1_DISCOVERY_ENABLED =
  !STORE_BUILD && !FIELD_LAB_BUILD && !CONNECTED_DEV_BUILD && PILOT_UA1_DISCOVERY_RAW === '1';
const ASSISTANT_READ_RAW = process.env.VIBE_ASSISTANT_READ_ENABLED;
if (ASSISTANT_READ_RAW !== undefined && !['0', '1'].includes(ASSISTANT_READ_RAW)) throw new Error('ASSISTANT_READ_FLAG_INVALID');
const ASSISTANT_READ_ENABLED = !STORE_BUILD && ASSISTANT_READ_RAW === '1';
if (ASSISTANT_READ_ENABLED && (FIELD_LAB_BUILD || CONNECTED_DEV_BUILD || !API_BASE_OVERRIDE || !WEB_BASE_OVERRIDE ||
  !EXTENSION_PUBLIC_KEY || !process.env.VIBE_EXTENSION_PUBLIC_KEY || API_BASE_OVERRIDE === PRODUCTION_API_BASE ||
  WEB_BASE_OVERRIDE === PRODUCTION_WEB_APP_BASE || PILOT_UA1_DISCOVERY_ENABLED || LIVE_HOST_WRITES || CONTROLLED_MOCK_WRITES)) {
  throw new Error('ASSISTANT_READ_BUILD_REALM_INVALID');
}
const ASSISTANT_PROFILE_EDIT_RAW = process.env.VIBE_ASSISTANT_PROFILE_EDIT_ENABLED;
if (ASSISTANT_PROFILE_EDIT_RAW !== undefined && !['0', '1'].includes(ASSISTANT_PROFILE_EDIT_RAW)) throw new Error('ASSISTANT_PROFILE_FLAG_INVALID');
const ASSISTANT_PROFILE_EDIT_ENABLED = ASSISTANT_READ_ENABLED && ASSISTANT_PROFILE_EDIT_RAW !== '0';
if (!STORE_BUILD && ASSISTANT_PROFILE_EDIT_RAW === '1' && !ASSISTANT_READ_ENABLED) throw new Error('ASSISTANT_PROFILE_BUILD_REALM_INVALID');
const ASSISTANT_ROLE_MANAGEMENT_RAW = process.env.VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED;
if (ASSISTANT_ROLE_MANAGEMENT_RAW !== undefined && !['0', '1'].includes(ASSISTANT_ROLE_MANAGEMENT_RAW)) throw new Error('ASSISTANT_ROLE_FLAG_INVALID');
const ASSISTANT_ROLE_MANAGEMENT_ENABLED = ASSISTANT_PROFILE_EDIT_ENABLED && ASSISTANT_ROLE_MANAGEMENT_RAW !== '0';
if (!STORE_BUILD && ASSISTANT_ROLE_MANAGEMENT_RAW === '1' && !ASSISTANT_PROFILE_EDIT_ENABLED) throw new Error('ASSISTANT_ROLE_BUILD_REALM_INVALID');
const EXTENSION_FIELD_LAB_ENABLED =
  !STORE_BUILD && FIELD_LAB_BUILD && EXTENSION_FIELD_LAB_RAW === '1';
const EXTENSION_CONNECTED_DEV_ENABLED =
  !STORE_BUILD && CONNECTED_DEV_BUILD && EXTENSION_CONNECTED_DEV_RAW === '1';
const EXTENSION_CONNECTED_DEV_WRITE_ENABLED =
  EXTENSION_CONNECTED_DEV_ENABLED &&
  CONNECTED_DEV_WRITE_RAW === '1' &&
  CONNECTED_DEV_TARGET !== null &&
  ((!CONNECTED_STAGING_BUILD && CONNECTED_DEV_WRITE_AUTHORITY_RAW === CONNECTED_DEV_WRITE_AUTHORITY) ||
    CONNECTED_DEV_LOCAL_VALID || CONNECTED_STAGING_WRITE_VALID);
const EXTENSION_ENTRYPOINTS = ATS_LAB_BUILD ? ['background', 'lab'] : ASSISTANT_READ_ENABLED ? ['background', 'assistant', 'assistant-host', 'intake-recorder', 'apply'] : EXTENSION_FIELD_LAB_ENABLED
  ? ['sidepanel']
  : EXTENSION_CONNECTED_DEV_ENABLED
    ? ['sidepanel', 'background', 'apply']
    : ['background', 'apply', 'vault'];

// 包内策略的构建时刻：每次构建注入当下时间，30 天硬过期从**构建日**起算。
// 2026-08-18 修的事故：此前 apply-kernel 只读一个全仓没人设过的 VITE_ 变量，
// 永远落到写死的兜底 2026-07-29，notAfter 恒为 2026-08-28——重新构建也不延期，
// 新包出生即过期。铁律 6「72 小时静默自杀」原样重演。
const APPLY_POLICY_BUILT_AT = new Date().toISOString();
if (!Number.isFinite(Date.parse(APPLY_POLICY_BUILT_AT))) {
  throw new Error('APPLY_POLICY_BUILT_AT 不是合法时间戳——拒绝产出会静默过期的包');
}

// The local package names its loopback origins alone: production is not an
// allowed host for it, so nothing it does can reach argoland.ai by mistake.
// An override that names production itself (the way the argoland.ai dock package
// is built, because the runtime-bundle switch requires an explicit API origin)
// must not list the origin twice.
const apiOrigins = EXTENSION_CONNECTED_DEV_ENABLED
  ? [CONNECTED_DEV_API_BASE]
  : LOCAL_BUILD
    ? [API_BASE_OVERRIDE!]
    : [...new Set([PRODUCTION_API_BASE, ...(API_BASE_OVERRIDE ? [API_BASE_OVERRIDE] : [])])];
const portalOrigins = EXTENSION_CONNECTED_DEV_ENABLED
  ? [CONNECTED_DEV_WEB_APP_BASE]
  : LOCAL_BUILD
    ? [WEB_BASE_OVERRIDE!]
    : [...new Set([PRODUCTION_WEB_APP_BASE, ...(WEB_BASE_OVERRIDE ? [WEB_BASE_OVERRIDE] : [])])];

export default defineConfig({
  srcDir: '.',
  // 图标在 public/icon/（2026-09-23 帆船 logo）。Field Lab 是只读的内部工具，产物闸要求它恰好只有侧边栏
  // 与两个编译文件，所以它不带 public/（指向一个不存在的目录）。
  ...(FIELD_LAB_BUILD ? { publicDir: 'public-none' } : {}),
  entrypointsDir: ATS_LAB_BUILD
    ? 'entrypoints-lab'
    : EXTENSION_CONNECTED_DEV_ENABLED
      ? 'entrypoints-connected'
      : 'entrypoints',
  filterEntrypoints: EXTENSION_ENTRYPOINTS,
  vite: (environment) => {
    if (
      (EXTENSION_FIELD_LAB_ENABLED || EXTENSION_CONNECTED_DEV_ENABLED) &&
      environment?.command !== 'build'
    ) {
      throw new Error(
        EXTENSION_FIELD_LAB_ENABLED
          ? 'FIELD_LAB_BUILD_IDENTITY_INVALID: Field Lab 只允许 WXT build，禁止 serve/HMR'
          : 'CONNECTED_DEV_BUILD_IDENTITY_INVALID: connected-dev 只允许 WXT build，禁止 serve/HMR',
      );
    }
    return {
      ...(EXTENSION_FIELD_LAB_ENABLED
        ? { build: { modulePreload: { polyfill: false } } }
        : {}),
      define: {
        __VIBE_ATS_LAB__: JSON.stringify(ATS_LAB_BUILD),
        // 构建形态随版本号一起上报（`1.1.0+store`，lib/buildConfig.ts）：线上分得清商店包与指向生产的本机包。
        __VIBE_BUILD_FLAVOR__: JSON.stringify(resolveBuildFlavor({ dist: process.env.VIBE_DIST, assistant: ASSISTANT_READ_ENABLED })),
        __VIBE_ASSISTANT_READ_ENABLED__: JSON.stringify(ASSISTANT_READ_ENABLED),
        __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__: JSON.stringify(ASSISTANT_ROLE_MANAGEMENT_ENABLED),
        __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__: JSON.stringify(ASSISTANT_PROFILE_EDIT_ENABLED),
        __VIBE_API_BASE__: JSON.stringify(FIELD_LAB_BUILD ? null : API_BASE_OVERRIDE),
        __VIBE_WEB_BASE__: JSON.stringify(FIELD_LAB_BUILD ? null : WEB_BASE_OVERRIDE),
        __VIBE_TRUST_TELEMETRY_ENABLED__: JSON.stringify(
          FIELD_LAB_BUILD ? false : TRUST_TELEMETRY_DELIVERY_ENABLED,
        ),
        __VIBE_CONTROLLED_MOCK_WRITES__: JSON.stringify(
          FIELD_LAB_BUILD ? false : CONTROLLED_MOCK_WRITES,
        ),
        __VIBE_LIVE_HOST_WRITES__: JSON.stringify(
          FIELD_LAB_BUILD ? false : LIVE_HOST_WRITES,
        ),
        __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__: JSON.stringify(
          EXECUTION_RUNTIME_BUNDLE_ENABLED,
        ),
        __VIBE_PILOT_UA1_DISCOVERY_ENABLED__: JSON.stringify(
          PILOT_UA1_DISCOVERY_ENABLED,
        ),
        __VIBE_EXTENSION_FIELD_LAB_ENABLED__: JSON.stringify(
          EXTENSION_FIELD_LAB_ENABLED,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__: JSON.stringify(
          EXTENSION_CONNECTED_DEV_ENABLED,
        ),
        __VIBE_EXTENSION_CONNECTED_STAGING_ENABLED__: JSON.stringify(
          EXTENSION_CONNECTED_DEV_ENABLED && CONNECTED_STAGING_BUILD,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__: JSON.stringify(
          EXTENSION_CONNECTED_DEV_WRITE_ENABLED,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__: JSON.stringify(
          CONNECTED_DEV_LOCAL_VALID ? PILOT_UA5_CONTROLLED_LOCAL_AUTHORITY : null,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__: JSON.stringify(
          CONNECTED_DEV_LOCAL_VALID || CONNECTED_STAGING_WRITE_VALID ? CONNECTED_DEV_LOCAL_NOT_BEFORE_MS : 0,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__: JSON.stringify(
          EXTENSION_CONNECTED_DEV_WRITE_ENABLED ? CONNECTED_DEV_TARGET?.origin ?? null : null,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__: JSON.stringify(
          EXTENSION_CONNECTED_DEV_WRITE_ENABLED ? CONNECTED_DEV_TARGET?.pathname ?? null : null,
        ),
        __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__: JSON.stringify(
          EXTENSION_CONNECTED_DEV_WRITE_ENABLED
            ? CONNECTED_DEV_LOCAL_VALID || CONNECTED_STAGING_WRITE_VALID ? CONNECTED_DEV_LOCAL_NOT_AFTER_MS : CONNECTED_DEV_WRITE_NOT_AFTER_MS
            : 0,
        ),
        // 注入值带一个固定前缀，让产物门禁能认出「这个时间戳确实是策略构建时刻」。
        // Vivian 二次 Blocking（2026-08-18）实测：门禁若只扫任意 ISO 串，
        // 在别处塞一个 2099-01-01 就能顶替，退出码 0 而真正的注入其实缺失。
        // 前缀三处同源：这里注入、`apply-kernel/src/policy.ts` 解析、
        // `scripts/check-policy-timestamp-baked.mjs` 判据。
        __VIBE_APPLY_POLICY_BUILT_AT__: JSON.stringify(
          `vibe-policy-built-at:${APPLY_POLICY_BUILT_AT}`,
        ),
      },
      resolve: {
        alias: {
          // WXT auto-import 会向**被打包的 kernel 源文件**注入
          // browser/storage 的 import（kernel 用的是裸全局），而 pnpm 严格
          // node_modules 下从 kernel 目录解析不到 wxt——把两个说明符钉到
          // 本包 node_modules 里的真模块，注入按 WXT 设计正常工作。
          'wxt/utils/storage': wxtModulePath('dist/utils/storage.mjs'),
          'wxt/browser': wxtModulePath('dist/browser.mjs'),
        },
      },
    };
  },
  manifest: ATS_LAB_BUILD
    ? {
        name: 'EdAIX ATS Lab (Unpacked)',
        description: 'Local autofill lab: scans and fills ATS application forms with mock data; never submits',
        action: { default_title: 'EdAIX ATS Lab: fill this page with mock data' },
        permissions: ['storage', 'activeTab'],
        host_permissions: [],
      }
    : EXTENSION_FIELD_LAB_ENABLED
    ? {
        name: 'EdAIX Field Lab (Unpacked Dev)',
        description: 'Value-free production-port boundary inspector; no host writes',
      }
    : EXTENSION_CONNECTED_DEV_ENABLED
      ? {
          name: CONNECTED_STAGING_BUILD ? 'EdAIX — Staging Current Page' : CONNECTED_DEV_LOCAL_VALID
            ? 'EdAIX Connected Lab — Local TEXT (Unpacked Dev)'
            : EXTENSION_CONNECTED_DEV_WRITE_ENABLED
            ? 'EdAIX Connected Lab — Exact Page (Unpacked Dev)'
            : 'EdAIX Connected Lab (Unpacked Dev)',
          description: 'Local-only current-page Autofill rehearsal; never submits',
          action: { default_title: 'Open EdAIX Connected Lab' },
          // Without this the unpacked id follows the directory path, so the
          // portal's configured extension id matches nothing and the handoff
          // is never delivered. Absent key → no field, and the mismatch is
          // visible rather than silently wrong.
          ...(EXTENSION_PUBLIC_KEY === null ? {} : { key: EXTENSION_PUBLIC_KEY }),
          permissions: ['storage'],
          host_permissions: [
            ...apiOrigins.map((origin) => `${origin}/*`),
            ...(CONNECTED_DEV_LOCAL_VALID
              ? [`${PILOT_UA5_CONTROLLED_LOCAL_ORIGIN}/*`]
              : CONNECTED_DEV_ATS_MATCHES),
          ],
          externally_connectable: {
            matches: portalOrigins.map((origin) => `${origin}/*`),
          },
        }
    : {
        // 对用户无独立品牌（20 §2）：名称保持产品名，不出现"插件"人格。
        name: ASSISTANT_READ_ENABLED ? 'ArgoLand.AI Staging Preview' : LOCAL_BUILD ? 'ArgoLand.AI (Local)' : 'ArgoLand.AI',
        description: ASSISTANT_PROFILE_EDIT_ENABLED ? 'Staging-only owner profile editor' : ASSISTANT_READ_ENABLED ? 'Staging-only career profile and resume reader' : LOCAL_BUILD ? 'Local-only execution runner against a developer backend' : 'ArgoLand.AI fills job applications from your ArgoLand profile.',
        // Same reason as the connected build below, and it applies here too: an
        // unpacked build with no key takes its id from the directory path, so it
        // is a different extension on every machine and on every move. Nothing
        // that pins an id -- a portal's configured app id, an API's allowed
        // extension origins -- can match a build whose identity is its folder.
        //
        // `resolveExtensionPublicKey` already refuses a store build, whose id
        // belongs to its listing; absent key → no field, so the mismatch stays
        // visible rather than becoming silently wrong.
        ...(EXTENSION_PUBLIC_KEY === null ? {} : { key: EXTENSION_PUBLIC_KEY }),
        // storage：tab 报到表放 storage.session（跨 SW 重启存活；无审核警告）。
        // alarms：到期前 120s 叫醒 worker 提前轮换 refresh token（2026-09-20，会话 15 分钟
        // 必死的修法之一）。alarms 不弹任何用户提示，也不进商店的敏感权限清单。
        permissions: ASSISTANT_READ_ENABLED ? ['storage', 'alarms', 'activeTab', 'scripting', 'webNavigation'] : ['storage', 'alarms'],
        ...(!ASSISTANT_READ_ENABLED ? { options_ui: { page: 'vault.html', open_in_tab: true } } : {}),
        // 商店包的版本号由 CI 打（P4-16）：`VIBE_EXTENSION_VERSION=0.1.<run>`；本机构建没给就沿用 package.json 的 0.0.0。
        // 只认 `x.y.z`：商店对版本号的比较是逐段数字，别的形状会让上传被拒或静默排错序。
        ...(STORE_VERSION === null ? {} : { version: STORE_VERSION }),
        ...(ASSISTANT_READ_ENABLED ? {
          version: '0.0.5',
          minimum_chrome_version: '130',
          action: { default_title: 'Open ArgoLand.AI' },
          web_accessible_resources: [{ resources: ['assistant.html'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true }],
        } : {}),
        ...(PILOT_UA1_DISCOVERY_ENABLED
          ? { action: { default_title: 'Discover controls on this page' } }
          : {}),
        host_permissions: (ASSISTANT_READ_ENABLED ? [API_BASE_OVERRIDE!] : apiOrigins).map((origin) => `${origin}/*`),
        externally_connectable: {
          // 只有点名的门户 origin 能把话递进扩展（信任边界，非地址簿）。
          matches: (ASSISTANT_READ_ENABLED ? [WEB_BASE_OVERRIDE!] : portalOrigins).map((origin) => `${origin}/*`),
        },
      },
  // 注入范围（buildConfig.resolveInjectionMatches）：2026-09-24 起商店包也保留入口自己的 matches。
  // 用 manifest 钩子而不是在入口里写条件 matches：入口的 matches 要被 WXT
  // 静态分析，条件表达式会让"产物里到底是什么"取决于分析能力；钩子改的是
  // 最终 manifest，闸门测试断言的也是同一个函数，两边不会漂。
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT adds runtime content-script match patterns as host permissions. The
      // assistant uses a toolbar activeTab grant; it must not retain all-site access.
      if (ASSISTANT_READ_ENABLED) manifest.host_permissions = [`${API_BASE_OVERRIDE!}/*`];
      for (const script of manifest.content_scripts ?? []) {
        script.matches = EXTENSION_CONNECTED_DEV_ENABLED
          ? EXTENSION_CONNECTED_DEV_WRITE_ENABLED && CONNECTED_DEV_TARGET !== null
            ? [`${CONNECTED_DEV_TARGET.origin}${CONNECTED_DEV_TARGET.pathname}`]
            : [...CONNECTED_DEV_ATS_MATCHES]
          // 2026-09-24 起商店包与其他构建一致：每个入口保留自己的 matches（见 resolveInjectionMatches 头注）。
          : [...resolveInjectionMatches({ declared: script.matches ?? [] })];
      }
    },
  },
  outDir: ATS_LAB_BUILD ? '.output-ats-lab' : ASSISTANT_READ_ENABLED ? '.output-assistant' : LOCAL_BUILD ? '.output-local' : STORE_BUILD
    ? '.output-store'
    : CONNECTED_STAGING_BUILD
      ? CONNECTED_DEV_LOCAL_VALID ? '.output-connected-staging-local'
        : CONNECTED_DEV_WRITE_RAW === '1' ? '.output-connected-staging-activation' : '.output-connected-staging'
    : EXTENSION_FIELD_LAB_ENABLED
      ? '.output-field-lab'
      : EXTENSION_CONNECTED_DEV_ENABLED
        ? CONNECTED_DEV_LOCAL_VALID
          ? '.output-connected-dev-local'
          : EXTENSION_CONNECTED_DEV_WRITE_ENABLED
          ? '.output-connected-dev-activation'
          : '.output-connected-dev'
        : '.output',
});
