/**
 * 「此刻登录的是谁」的不透明代号（2026-10-04；2026-10-03 前端体检 3.1「换账号」）。
 *
 * 内容脚本手上有按人缓存的东西（预取的档案、简历问询、头像名字、编辑器里那一份）。换了一个人登录，这些一样都不能留；同一个
 * 人重新登录，也不必丢。worker 在报到、授权、档案这几种答复里带上这个代号：代号变了，内容脚本就把上一个人的东西全丢掉、按
 * 新的人重读；按下「自动填写」那一刻再拿当下的授权答复对一次，预取的那一份不是这个人的就不用。
 *
 * 代号是 SHA-256(本次浏览器会话的随机盐 ‖ 账号 id) 的前 16 字节（base64url）：同一个人在这次会话里一直是同一个，换了人就
 * 不同；拿不到账号 id，也认不出是谁（盐只在 worker 的 storage.session 里，浏览器关了就没）。没登录是 null。
 */

/** 存盐的那一格（storage.session：只在内存里，内容脚本读不到）。 */
const SALT_KEY = 'sessionStampSaltV1';

export interface SessionStampDeps {
  /** 当前登录的账号 id；没登录是 null。 */
  readonly userId: () => Promise<string | null>;
  readonly area: () => {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** 测试注入；缺省 crypto.getRandomValues。 */
  readonly randomBytes?: (length: number) => Uint8Array;
  /** 测试注入；缺省 crypto.subtle。 */
  readonly digest?: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
}

/** 内容脚本认的代号形状（与 worker 产出的一致）。 */
export const SESSION_STAMP_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export function createSessionStamp(deps: SessionStampDeps): () => Promise<string | null> {
  const randomBytes = deps.randomBytes ?? ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  const digest = deps.digest ?? ((data: Uint8Array<ArrayBuffer>) => globalThis.crypto.subtle.digest('SHA-256', data));
  let salt: Promise<string> | null = null;
  /** 盐只取一次（同一个 worker 里排成一个）；storage.session 里没有就造一个存进去。 */
  const saltOnce = (): Promise<string> => {
    salt ??= (async () => {
      const area = deps.area();
      const stored = (await area.get([SALT_KEY]))[SALT_KEY];
      if (typeof stored === 'string' && /^[0-9a-f]{32}$/u.test(stored)) return stored;
      const fresh = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
      await area.set({ [SALT_KEY]: fresh });
      return fresh;
    })();
    // 取不到（storage 出错）：下一次再试，不把一次失败记一辈子。
    salt.catch(() => { salt = null; });
    return salt;
  };
  return async () => {
    const user = await deps.userId();
    if (user === null || user === '') return null;
    const bytes = new TextEncoder().encode(`${await saltOnce()}:${user}`);
    const hash = new Uint8Array(await digest(bytes)).slice(0, 16);
    let binary = '';
    for (const byte of hash) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  };
}
