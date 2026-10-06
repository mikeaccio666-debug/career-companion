/**
 * 构建期 origin 解析的**纯函数**（wxt.config.ts 唯一消费方）。
 *
 * 抽出来的原因（PR #4 评审 高4）：闸门测试要直接执行这些函数断言行为，
 * 而不是数源码字符串。
 *
 * canonical origin 约束（评审复核追加，对齐正式契约 §1.2）：只接受
 * `scheme://host[:port]`——凭证（user:pass@）、路径、查询、片段一律拒收。
 * 这些值会进入 host_permissions / externally_connectable 信任边界，
 * `startsWith('https://')` 这种前缀判断放过 `https://user:pass@evil` 是
 * 真实的攻击面。用 URL 解析后逐项验证，不做前缀猜测。
 *
 * 环境读入（process.env）留在 wxt.config.ts：这里只接参数。
 */

export interface ResolveOverrideInput {
  /** VIBE_DIST === 'store'——商店包永远拿不到覆盖。 */
  readonly storeBuild: boolean;
  /** 对应环境变量原文（VIBE_API_BASE / VIBE_WEB_BASE）。 */
  readonly raw: string | undefined;
}

/** T15 自动遥测构建门：商店包在 release evidence 合入前永远关闭。 */
export function resolveTrustTelemetryDeliveryEnabled(input: ResolveOverrideInput): boolean {
  return !input.storeBuild && input.raw === 'true';
}

/**
 * 严格 canonical origin：解析成功且无凭证/路径/查询/片段才放行，
 * 返回 `scheme://host[:port]` 规范形。任何一项不满足 → null。
 */
function canonicalOrigin(raw: string, allowedProtocols: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!allowedProtocols.includes(url.protocol)) return null;
  if (url.username !== '' || url.password !== '') return null;
  // 尾部单斜杠（https://h/ → pathname '/'）是常见笔误、无攻击面——接受并
  // 规范化为 origin；任何真实路径/查询/片段一律拒。
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1']);

/** API 覆盖：仅收 https（本地 http://localhost 例外），镜像 variables.ts 规则。 */
export function resolveApiBaseOverride(input: ResolveOverrideInput): string | null {
  if (input.storeBuild) return null;
  if (typeof input.raw !== 'string' || input.raw === '') return null;
  const origin = canonicalOrigin(input.raw, ['https:', 'http:']);
  if (origin === null) return null;
  if (origin.startsWith('https://')) return origin;
  // http 只放行本地回环。
  const host = new URL(origin).hostname;
  return LOCALHOST_HOSTS.has(host) ? origin : null;
}

export interface ResolveWebBaseOverrideInput extends ResolveOverrideInput {
  /**
   * `VIBE_DIST=local` only: accept a plaintext loopback portal.
   *
   * The portal origin goes into `externally_connectable`, which is why the
   * ordinary rule refuses http outright. A local test package talks to the
   * developer's own `pnpm dev:staging` portal at `http://localhost:3100`, and
   * that origin is reachable from this machine alone -- so the loopback
   * exception the API override already makes is extended to the portal for
   * that one flavour, and for nothing else. A store build still gets null
   * before this is even consulted.
   */
  readonly loopbackHttp?: boolean;
}

/** 门户覆盖更严格：连 localhost 明文都不收（origin 进 externally_connectable 信任边界）。 */
export function resolveWebBaseOverride(input: ResolveWebBaseOverrideInput): string | null {
  if (input.storeBuild) return null;
  if (typeof input.raw !== 'string' || input.raw === '') return null;
  if (input.loopbackHttp !== true) return canonicalOrigin(input.raw, ['https:']);
  const origin = canonicalOrigin(input.raw, ['https:', 'http:']);
  if (origin === null || origin.startsWith('https://')) return origin;
  return LOCALHOST_HOSTS.has(new URL(origin).hostname) ? origin : null;
}

/**
 * 内容脚本的注入范围：每个入口保留自己声明的 matches，商店包与其他构建一致。
 *
 * 2026-08-15 起商店包曾收窄到 registry 的窄主机表（当时白标识别没接进生产路径，全网注入换不来覆盖）。
 * 2026-09-24 负责人决定第一版上架就开全网（与开发构建、竞品一致），当初写下的两条解除条件都已不成立：
 *  1. 白标与通用路 2026-09-22 起已接进内容脚本（`pageLane`）；没认出申请表的页面不挂浮层、不写入（`dockFaceForPage`）；
 *  2. 「已装用户重新授权引导」针对的是上架后扩权——还没上架，第一版就开全网，以后不会再有扩权。
 * 反过来，窄表上架后每加一个网站都会让 Chrome 停用已装用户的插件、等他重新接受权限；雇主自建域名里嵌的
 * 申请表也进不去。
 *
 * 注入 ≠ 动手：进来先跑主机／页面否决（`gate/hostVeto.ts`、`gate/pageVeto.ts`），只在认出申请表的页面挂浮层。
 * 隔离世界入口用 `AUTOFILL_WIDE_MATCHES`（只有 https）并排除 `AUTOFILL_EXCLUDE_MATCHES`；MAIN world 的桥仍只用窄主机表
 * （入口自己声明，这里原样保留）；host_permissions 仍只有后端。
 */
export function resolveInjectionMatches(input: { readonly declared: readonly string[] }): readonly string[] {
  return [...input.declared];
}

/**
 * The public key that pins this build's extension id.
 *
 * Chrome derives the id from it, so an unpacked build without one takes an id
 * from its directory path — different on every machine, matching no configured
 * portal. Exact base64 only: the value goes into the manifest verbatim, and a
 * PEM wrapper or stray whitespace would silently change the derived id.
 *
 * Store builds always get null. A published item's id belongs to its listing,
 * and no environment variable may make an artifact claim another identity.
 */
export function resolveExtensionPublicKey(input: ResolveOverrideInput): string | null {
  if (input.storeBuild) return null;
  if (typeof input.raw !== 'string' || input.raw === '') return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.raw)) return null;
  // Round-trip: Buffer/atob are lenient, and a key that does not survive
  // re-encoding is not the key the browser will hash.
  const decoded = Buffer.from(input.raw, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === input.raw ? input.raw : null;
}


/** 这一份产物是怎么打的：随版本号一起上报（`1.1.0+store`），线上分得清商店包与指向生产的本机包（2026-10-04，体检 11-3）。 */
export type BuildFlavor =
  | 'store'
  | 'unpacked'
  | 'local'
  | 'assistant'
  | 'connected-dev'
  | 'connected-staging'
  | 'field-lab'
  | 'ats-lab';

/**
 * `VIBE_DIST` 说了算；没给（普通 `wxt build`，`.output`）是 `unpacked`，其中打开了 Assistant 的是 `assistant`。
 * 只有这几个词：argoland 按同一张表把它记成 `client_flavor`，不认得的记成 `other`。
 */
export function resolveBuildFlavor(input: { readonly dist: string | undefined; readonly assistant: boolean }): BuildFlavor {
  switch (input.dist) {
    case 'store':
    case 'local':
    case 'field-lab':
    case 'ats-lab':
    case 'connected-dev':
    case 'connected-staging':
      return input.dist;
    default:
      return input.assistant ? 'assistant' : 'unpacked';
  }
}
