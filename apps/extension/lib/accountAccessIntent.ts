import { PILOT_UA5_CONNECTED_PROTOCOL_VERSION, createPilotUa5ConnectedPageReady } from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';
import { isPlausibleEmail, isPlausibleSitePassword, SHARED_PASSWORD_MAX_LENGTH } from './accountPassword';

/**
 * 浮层 ↔ worker：招聘网站账号（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday／iCIMS）。
 *
 * 保险箱（accountVault.ts）只在 worker 里；内容脚本要邮箱与密码，只在用户按下「注册并自动填写」「登录并自动填写」那一下之后、
 * 按这一页问一次，写进规则声明的那几格就丢掉。这些消息只在扩展自己的 worker 与内容脚本之间走（`runtime.sendMessage`），
 * **从不**出这台电脑：worker 不把其中任何一样放进发往后端的请求、JWS、channel、回执、日志、遥测与诊断。
 *
 * 形状与别的 dock 消息同一个姿势：精确键集、页面只报 origin 与 pathname（单页应用改过地址时多带加载时的路径），worker
 * 拿它与 `sender.url` 逐字比（senderPage.ts）。
 */

export const ACCOUNT_ACCESS_INTENT_KIND = 'dock/account-access-intent' as const;

export type DockAccountAccessPayload =
  /** 这一页此刻能不能替他注册、登录（两把钥匙）、这一家有没有他的账号。不带任何秘密。 */
  | Readonly<{ step: 'STATUS' }>
  /** 按下之后要邮箱与密码（worker 先判两把钥匙）。 */
  | Readonly<{ step: 'CREDENTIAL' }>
  /** 这一家的结局（只记「有账号」的记号，不带值）。 */
  | Readonly<{ step: 'RECORD'; outcome: 'CREATED' | 'SIGNED_IN' | 'EXISTS' }>
  /** 他在浮层里输的这一家自己的密码。 */
  | Readonly<{ step: 'SITE_PASSWORD'; password: string }>
  /** 账户菜单「招聘网站账号」。 */
  | Readonly<{ step: 'SETTINGS_GET' }>
  | Readonly<{ step: 'SETTINGS_SET_EMAIL'; email: string | null }>
  | Readonly<{ step: 'SETTINGS_SET_PASSWORD'; password: string }>
  | Readonly<{ step: 'REVEAL' }>;

export interface DockAccountAccessIntent {
  readonly kind: typeof ACCOUNT_ACCESS_INTENT_KIND;
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  readonly documentPathname?: string;
  readonly payload: DockAccountAccessPayload;
}

const KEYS = ['kind', 'version', 'origin', 'pathname', 'payload'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function parsePayload(value: unknown): DockAccountAccessPayload | null {
  if (!isRecord(value)) return null;
  const step = value['step'];
  switch (step) {
    case 'STATUS':
    case 'CREDENTIAL':
    case 'SETTINGS_GET':
    case 'REVEAL':
      return exactKeys(value, ['step']) ? Object.freeze({ step }) : null;
    case 'RECORD': {
      const outcome = value['outcome'];
      return exactKeys(value, ['step', 'outcome']) && (outcome === 'CREATED' || outcome === 'SIGNED_IN' || outcome === 'EXISTS')
        ? Object.freeze({ step, outcome })
        : null;
    }
    case 'SITE_PASSWORD': {
      const password = value['password'];
      return exactKeys(value, ['step', 'password']) && typeof password === 'string' && isPlausibleSitePassword(password)
        ? Object.freeze({ step, password })
        : null;
    }
    case 'SETTINGS_SET_EMAIL': {
      const email = value['email'];
      return exactKeys(value, ['step', 'email']) && (email === null || (typeof email === 'string' && isPlausibleEmail(email)))
        ? Object.freeze({ step, email })
        : null;
    }
    case 'SETTINGS_SET_PASSWORD': {
      const password = value['password'];
      // 强度在 worker 里判（交回 WEAK_PASSWORD 让浮层照着说）；这里只挡形状。
      return exactKeys(value, ['step', 'password']) && typeof password === 'string' &&
        password.length > 0 && password.length <= SHARED_PASSWORD_MAX_LENGTH
        ? Object.freeze({ step, password })
        : null;
    }
    default:
      return null;
  }
}

export function parseDockAccountAccessIntent(value: unknown): DockAccountAccessIntent | null {
  if (!isRecord(value)) return null;
  const keys = keysBesidesDocumentPath(value);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  if (value['kind'] !== ACCOUNT_ACCESS_INTENT_KIND || value['version'] !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION) return null;
  if (typeof value['origin'] !== 'string' || typeof value['pathname'] !== 'string') return null;
  const payload = parsePayload(value['payload']);
  if (payload === null) return null;
  const ready = createPilotUa5ConnectedPageReady(value['origin'], value['pathname']);
  if (ready === null) return null;
  const loaded = readDocumentPathname(value, ready.origin);
  if (loaded === null) return null;
  return Object.freeze({
    kind: ACCOUNT_ACCESS_INTENT_KIND,
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
    payload,
  });
}

export function createDockAccountAccessIntent(
  origin: string,
  pathname: string,
  payload: DockAccountAccessPayload,
): DockAccountAccessIntent | null {
  return parseDockAccountAccessIntent({ kind: ACCOUNT_ACCESS_INTENT_KIND, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin, pathname, payload });
}

/** worker 的拒绝：只有码。 */
export type DockAccountAccessRefusal =
  /** 他没有同意过点名「替你注册账号和登录」的那一版代填授权。 */
  | 'CONSENT_REQUIRED'
  /** 运行时包里 account-access 关着（或这一家、这一页不在范围里）。 */
  | 'DISABLED'
  /** 没有注册邮箱：资料里没有，账户菜单里也没填。 */
  | 'NO_EMAIL'
  /** 他设的共用密码不合要求。 */
  | 'WEAK_PASSWORD'
  /** 没登录 ArgoLand、读不到、存不下。 */
  | 'UNAVAILABLE';

export type DockAccountAccessReply =
  | Readonly<{ kind: 'ACCOUNT_STATUS'; consent: boolean; enabled: boolean; known: boolean }>
  | Readonly<{
      kind: 'ACCOUNT_CREDENTIAL';
      email: string;
      password: string;
      /** 用的是这一家自己的密码，还是共用的那一条。 */
      source: 'SITE' | 'SHARED';
      /** 共用的那一条是这一次刚生成的。 */
      generated: boolean;
      /** 这一家已经有他的账号（先登录，不先注册）。 */
      known: boolean;
    }>
  | Readonly<{ kind: 'ACCOUNT_SETTINGS'; email: string | null; defaultEmail: string | null; hasPassword: boolean; sites: number }>
  | Readonly<{ kind: 'ACCOUNT_PASSWORD'; password: string | null }>
  | Readonly<{ kind: 'ACCOUNT_SAVED' }>
  | Readonly<{ kind: 'REFUSED'; code: DockAccountAccessRefusal }>;

const REFUSALS: ReadonlySet<string> = new Set(['CONSENT_REQUIRED', 'DISABLED', 'NO_EMAIL', 'WEAK_PASSWORD', 'UNAVAILABLE']);

/** 内容脚本读 worker 的答复：形状对不上一律 null（调用方当「这次没有」）。 */
export function parseDockAccountAccessReply(value: unknown): DockAccountAccessReply | null {
  if (!isRecord(value)) return null;
  switch (value['kind']) {
    case 'ACCOUNT_STATUS':
      return exactKeys(value, ['kind', 'consent', 'enabled', 'known']) &&
        typeof value['consent'] === 'boolean' && typeof value['enabled'] === 'boolean' && typeof value['known'] === 'boolean'
        ? Object.freeze({ kind: 'ACCOUNT_STATUS', consent: value['consent'], enabled: value['enabled'], known: value['known'] })
        : null;
    case 'ACCOUNT_CREDENTIAL': {
      const { email, password, source, generated, known } = value;
      return exactKeys(value, ['kind', 'email', 'password', 'source', 'generated', 'known']) &&
        typeof email === 'string' && isPlausibleEmail(email) &&
        typeof password === 'string' && isPlausibleSitePassword(password) &&
        (source === 'SITE' || source === 'SHARED') && typeof generated === 'boolean' && typeof known === 'boolean'
        ? Object.freeze({ kind: 'ACCOUNT_CREDENTIAL', email, password, source, generated, known })
        : null;
    }
    case 'ACCOUNT_SETTINGS': {
      const { email, defaultEmail, hasPassword, sites } = value;
      return exactKeys(value, ['kind', 'email', 'defaultEmail', 'hasPassword', 'sites']) &&
        (email === null || typeof email === 'string') && (defaultEmail === null || typeof defaultEmail === 'string') &&
        typeof hasPassword === 'boolean' && typeof sites === 'number' && Number.isInteger(sites) && sites >= 0
        ? Object.freeze({ kind: 'ACCOUNT_SETTINGS', email, defaultEmail, hasPassword, sites })
        : null;
    }
    case 'ACCOUNT_PASSWORD': {
      const password = value['password'];
      return exactKeys(value, ['kind', 'password']) && (password === null || (typeof password === 'string' && isPlausibleSitePassword(password)))
        ? Object.freeze({ kind: 'ACCOUNT_PASSWORD', password })
        : null;
    }
    case 'ACCOUNT_SAVED':
      return exactKeys(value, ['kind']) ? Object.freeze({ kind: 'ACCOUNT_SAVED' }) : null;
    case 'REFUSED': {
      const code = value['code'];
      return exactKeys(value, ['kind', 'code']) && typeof code === 'string' && REFUSALS.has(code)
        ? Object.freeze({ kind: 'REFUSED', code: code as DockAccountAccessRefusal })
        : null;
    }
    default:
      return null;
  }
}
