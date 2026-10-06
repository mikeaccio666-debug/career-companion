/**
 * 招聘网站账号的本机保险箱（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday／iCIMS）。
 *
 * 只在 worker（扩展自己的 origin）里用。放什么：注册邮箱（用户改过才有；没改过就用资料里的邮箱）、所有需要账号的网站
 * 共用的那一条密码、个别网站自己的密码与「这一家已经有账号」的记号，以及这份保险箱属于哪一个 ArgoLand 用户。
 *
 * ## 怎么存
 *
 *  · 整份记录序列化后用 AES-GCM（256 位）加密，每次写都换一个 96 位的随机 IV，附加数据固定为 `argoland-account-vault-v1`；
 *    密文放在 `chrome.storage.local` 的一个键下。
 *  · 密钥由 WebCrypto 生成、**不可导出**（`extractable: false`），存在扩展自己 origin 的 IndexedDB 里——内容脚本的
 *    IndexedDB 是宿主页面的 origin，碰不到它；`chrome.storage.local` 里只有密文。
 *  · 读不出（密钥没了、密文被改过）就当空的，同时删掉那份读不出的密文：没有密钥它永远读不出来。只记稳定码。
 *
 * ## 不出这台电脑
 *
 * 这里的每一样都不进任何发往后端的请求、JWS、channel、回执、日志、遥测与诊断（RULE-GLOBAL-DATA-L1：密码在 Data-L1 之上）。
 * 诊断只有 `ACCOUNT_VAULT_*` 这几个码。
 *
 * ## 什么时候清空
 *
 * 用户在插件里退出 ArgoLand 时整份删掉（密文与密钥一起）；换了一个 ArgoLand 用户登录，旧的那一份也删掉（`owner` 对不上）。
 * 理由写在 background.ts 的退出登录那一段。
 */

export const ACCOUNT_VAULT_STORAGE_KEY = 'accountVaultV1';
const AAD = new TextEncoder().encode('argoland-account-vault-v1');
const IV_BYTES = 12;
/** 至多记多少家（网站自己的密码与「有账号」的记号）：超了就丢最旧的那几家。 */
const MAX_SITES = 400;

export interface AccountSiteRecord {
  /** 这一家自己的密码（与共用的不一样时，他在浮层里输过一次）。 */
  readonly password?: string;
  /** 这一家已经有他的账号（替他注册成了、登录成了，或网站说账号已存在）。 */
  readonly known?: true;
  /** 最后一次更新的时刻（毫秒）。 */
  readonly at: number;
}

export interface AccountVaultRecord {
  readonly v: 1;
  /** 这份保险箱属于哪一个 ArgoLand 用户；还没写过就是 null。 */
  readonly owner: string | null;
  /** 用户改过的注册邮箱；null = 用资料里的邮箱。 */
  readonly email: string | null;
  /** 所有需要账号的网站共用的那一条密码；null = 还没有（第一次替他注册时生成）。 */
  readonly password: string | null;
  /** 按 origin 记的每一家。 */
  readonly sites: Readonly<Record<string, AccountSiteRecord>>;
}

export const EMPTY_ACCOUNT_VAULT: AccountVaultRecord = Object.freeze({ v: 1, owner: null, email: null, password: null, sites: Object.freeze({}) });

/** `chrome.storage.local` 的最小一面（测试注入一个假的）。 */
export interface AccountVaultArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** 放不可导出密钥的地方（生产：扩展自己 origin 的 IndexedDB；测试：内存）。 */
export interface AccountVaultKeyStore {
  load(): Promise<CryptoKey | null>;
  save(key: CryptoKey): Promise<void>;
  remove(): Promise<void>;
}

export type AccountVaultDiagnostic =
  | 'ACCOUNT_VAULT_KEY_MISSING'
  | 'ACCOUNT_VAULT_UNREADABLE'
  | 'ACCOUNT_VAULT_WRITE_FAILED'
  | 'ACCOUNT_VAULT_CLEAR_FAILED';

export interface AccountVault {
  /** 读出整份；没有、读不出都是空的那一份。 */
  read(): Promise<AccountVaultRecord>;
  /** 读—改—写排成一队；写不下就抛（调用方照实说没存上）。 */
  update(change: (record: AccountVaultRecord) => AccountVaultRecord): Promise<AccountVaultRecord>;
  /** 密文与密钥一起删掉。 */
  clear(): Promise<void>;
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解开之后的形状核对：不认得的一律当读不出（不猜）。 */
function parseVaultRecord(value: unknown): AccountVaultRecord | null {
  if (!isRecord(value) || value['v'] !== 1) return null;
  const owner = value['owner'];
  const email = value['email'];
  const password = value['password'];
  const sites = value['sites'];
  if (!(owner === null || typeof owner === 'string')) return null;
  if (!(email === null || typeof email === 'string')) return null;
  if (!(password === null || typeof password === 'string')) return null;
  if (!isRecord(sites)) return null;
  const parsed: Record<string, AccountSiteRecord> = {};
  for (const [origin, site] of Object.entries(sites)) {
    if (!isRecord(site) || typeof site['at'] !== 'number') return null;
    const sitePassword = site['password'];
    if (sitePassword !== undefined && typeof sitePassword !== 'string') return null;
    if (site['known'] !== undefined && site['known'] !== true) return null;
    parsed[origin] = Object.freeze({
      at: site['at'],
      ...(sitePassword === undefined ? {} : { password: sitePassword }),
      ...(site['known'] === true ? { known: true as const } : {}),
    });
  }
  return Object.freeze({ v: 1, owner, email, password, sites: Object.freeze(parsed) });
}

/** 超过上限就丢最旧的那几家。 */
function trimSites(record: AccountVaultRecord): AccountVaultRecord {
  const entries = Object.entries(record.sites);
  if (entries.length <= MAX_SITES) return record;
  const kept = entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SITES);
  return { ...record, sites: Object.fromEntries(kept) };
}

export function createAccountVault(deps: Readonly<{
  area: AccountVaultArea;
  keys: AccountVaultKeyStore;
  subtle?: SubtleCrypto;
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  onDiagnostic?: (code: AccountVaultDiagnostic) => void;
}>): AccountVault {
  const subtle = deps.subtle ?? globalThis.crypto.subtle;
  const random = deps.random ?? ((bytes: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(bytes));
  const diag = (code: AccountVaultDiagnostic): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // 诊断通道自己坏了不影响保险箱。
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const readNow = async (): Promise<AccountVaultRecord> => {
    const stored = await deps.area.get(ACCOUNT_VAULT_STORAGE_KEY);
    if (stored === undefined || stored === null) return EMPTY_ACCOUNT_VAULT;
    const key = await deps.keys.load().catch(() => null);
    if (key === null) {
      // 密钥没了（IndexedDB 被清过）：这份密文再也读不出来，删掉它，免得一直占着、一直报。
      diag('ACCOUNT_VAULT_KEY_MISSING');
      await deps.area.remove(ACCOUNT_VAULT_STORAGE_KEY).catch(() => undefined);
      return EMPTY_ACCOUNT_VAULT;
    }
    try {
      if (!isRecord(stored) || stored['v'] !== 1 || typeof stored['iv'] !== 'string' || typeof stored['data'] !== 'string') {
        throw new Error('shape');
      }
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(stored['iv']), additionalData: AAD },
        key,
        fromBase64(stored['data']),
      );
      const record = parseVaultRecord(JSON.parse(new TextDecoder().decode(plain)));
      if (record === null) throw new Error('record');
      return record;
    } catch {
      diag('ACCOUNT_VAULT_UNREADABLE');
      await deps.area.remove(ACCOUNT_VAULT_STORAGE_KEY).catch(() => undefined);
      return EMPTY_ACCOUNT_VAULT;
    }
  };

  const ensureKey = async (): Promise<CryptoKey> => {
    const existing = await deps.keys.load().catch(() => null);
    if (existing !== null) return existing;
    const created = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
    await deps.keys.save(created);
    return created;
  };

  const writeNow = async (record: AccountVaultRecord): Promise<void> => {
    const key = await ensureKey();
    const iv = random(new Uint8Array(IV_BYTES));
    const data = await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD },
      key,
      new TextEncoder().encode(JSON.stringify(record)),
    );
    await deps.area.set(ACCOUNT_VAULT_STORAGE_KEY, { v: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) });
  };

  const vault: AccountVault = {
    read: () => serial(readNow),
    update: (change) => serial(async () => {
      const next = trimSites(change(await readNow()));
      const checked = parseVaultRecord(next);
      if (checked === null) throw new Error('ACCOUNT_VAULT_RECORD_INVALID');
      try {
        await writeNow(checked);
      } catch (error) {
        diag('ACCOUNT_VAULT_WRITE_FAILED');
        throw error;
      }
      return checked;
    }),
    clear: () => serial(async () => {
      let failed = false;
      await deps.area.remove(ACCOUNT_VAULT_STORAGE_KEY).catch(() => { failed = true; });
      await deps.keys.remove().catch(() => { failed = true; });
      if (failed) diag('ACCOUNT_VAULT_CLEAR_FAILED');
    }),
  };
  return Object.freeze(vault);
}

const DB_NAME = 'argoland-account-vault';
const STORE = 'keys';
const KEY_ID = 'vault-key-v1';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB_REQUEST_FAILED'));
  });
}

/** 生产用：扩展自己 origin 的 IndexedDB。CryptoKey 能按结构化克隆存进去，不可导出的仍不可导出。 */
export function createIndexedDbVaultKeyStore(factory: IDBFactory): AccountVaultKeyStore {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB_OPEN_FAILED'));
  });
  const withStore = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await request(act(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  };
  const store: AccountVaultKeyStore = {
    load: async () => {
      const value = await withStore('readonly', (store) => store.get(KEY_ID) as IDBRequest<unknown>);
      return value instanceof CryptoKey ? value : null;
    },
    save: async (key) => { await withStore('readwrite', (store) => store.put(key, KEY_ID)); },
    remove: async () => { await withStore('readwrite', (store) => store.delete(KEY_ID)); },
  };
  return Object.freeze(store);
}
