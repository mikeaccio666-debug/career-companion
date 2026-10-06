import type {
  DirectoryResponseText,
  ProfileDirectoryOperation,
  ProfileDirectoryTransport,
  ProfileDirectoryTransportResult,
} from './profileDirectoryTransport';

/**
 * 「我的资料」上一次读到的那一份（2026-10-04；2026-10-03 前端体检 3.1「先显示旧的、后台换新」）。
 *
 * 资料编辑器每次打开都要等后端 1–2 秒。worker 经手的每一次资料目录答复（读到的、存成的）都记一份，下一次打开先摆出来、
 * 后台再现读一次。只记在 `chrome.storage.session`：只在这次浏览器会话、只在内存里，不落盘；内容脚本读不到它（没有放开
 * setAccessLevel），只能经 worker 问、而且只有报到过的那一页问得动（与 profile-directory/run 同一道闸）。
 *
 * 只给读到它的那个账号：每一份记着是谁的（请求前后各读一次当前账号，中途换了人就不记），读的时候对不上就当没有、顺手删掉；
 * 退出登录、换账号、会话被清（authClient 的 onSessionInvalidated）时整份清掉。不进日志、遥测、诊断——诊断只有稳定码。
 *
 * 它只用来先摆出来给人看；填写、代不代签从来不读它（那几处现读）。
 */

export const PROFILE_DIRECTORY_CACHE_SLOTS = ['PROFILE_V2', 'EEO', 'SIGNING_CONSENT', 'RESUME_LIBRARY'] as const;
export type ProfileDirectoryCacheSlot = (typeof PROFILE_DIRECTORY_CACHE_SLOTS)[number];

/** 哪几种答复记进哪一格（存成的答复就是服务器存下的样子，同一格）。别的操作不记。 */
const SLOT_OF: Readonly<Partial<Record<ProfileDirectoryOperation, ProfileDirectoryCacheSlot>>> = Object.freeze({
  PROFILE_V2_READ: 'PROFILE_V2',
  PROFILE_V2_SAVE: 'PROFILE_V2',
  EEO_READ: 'EEO',
  EEO_SAVE: 'EEO',
  SIGNING_CONSENT_READ: 'SIGNING_CONSENT',
  SIGNING_CONSENT_GRANT: 'SIGNING_CONSENT',
  SIGNING_CONSENT_REVOKE: 'SIGNING_CONSENT',
  RESUME_LIBRARY_READ: 'RESUME_LIBRARY',
  RESUME_DEFAULT_SET: 'RESUME_LIBRARY',
});

const KEY_PREFIX = 'profileDirectoryCacheV1:';
const KEYS: readonly string[] = PROFILE_DIRECTORY_CACHE_SLOTS.map((slot) => `${KEY_PREFIX}${slot}`);
/** storage.session 一共 10 MB；一格超过这么大就不记（档案平时 150 KB 上下，契约上限 3 MB 多）。 */
const MAX_TEXT_CHARS = 2_000_000;

export interface CachedSlot {
  /** 那一次请求发出的时刻（毫秒）。 */
  readonly at: number;
  readonly text: DirectoryResponseText;
}
export type CachedSlots = Partial<Record<ProfileDirectoryCacheSlot, CachedSlot>>;

/** `chrome.storage.session` 用到的那三样；测试注入内存表。 */
export interface SessionArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface ProfileDirectoryCache {
  /** 包一层：经它的每一次成功的答复（读或存）都替当时的账号记下来。答复本身原样交回。 */
  readonly wrap: (transport: ProfileDirectoryTransport) => ProfileDirectoryTransport;
  /** 当前账号记着的那几格；没登录、换了账号就是空的。 */
  readonly read: () => Promise<CachedSlots>;
  /** 整份清掉（退出登录、换账号）。 */
  readonly clear: () => Promise<void>;
}

export interface ProfileDirectoryCacheDeps {
  readonly area: () => SessionArea;
  /** 当前登录的账号；没登录是 null。 */
  readonly userId: () => Promise<string | null>;
  readonly now?: () => number;
  readonly onDiagnostic?: (code: 'PROFILE_CACHE_WRITE_FAILED' | 'PROFILE_CACHE_READ_FAILED') => void;
}

interface Stored {
  readonly owner: string;
  readonly at: number;
  readonly text: string;
}

function stored(value: unknown): Stored | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { owner, at, text } = value as Record<string, unknown>;
  return typeof owner === 'string' && owner !== '' && typeof at === 'number' && Number.isFinite(at) && typeof text === 'string'
    ? { owner, at, text }
    : null;
}

export function createProfileDirectoryCache(deps: ProfileDirectoryCacheDeps): ProfileDirectoryCache {
  const now = deps.now ?? Date.now;
  const userId = async (): Promise<string | null> => {
    try {
      return await deps.userId();
    } catch {
      return null;
    }
  };
  /** 每一格的写排成一队：先读再比时刻再写，两次写不会交错。 */
  const tails = new Map<ProfileDirectoryCacheSlot, Promise<void>>();
  /** clear 之后才发出的请求才记：clear 之前在路上的答复晚到，不把上一个人的那一份写回来。 */
  let epoch = 0;

  const remember = (owner: string, slot: ProfileDirectoryCacheSlot, at: number, text: string, startedIn: number): Promise<void> => {
    const key = `${KEY_PREFIX}${slot}`;
    const next = (tails.get(slot) ?? Promise.resolve()).then(async () => {
      if (startedIn !== epoch) return;
      const area = deps.area();
      const existing = stored((await area.get([key]))[key]);
      // 先发出的答复晚到：不盖掉后发出的那一份。
      if (existing !== null && existing.owner === owner && existing.at > at) return;
      await area.set({ [key]: { owner, at, text } });
    }).catch(() => { deps.onDiagnostic?.('PROFILE_CACHE_WRITE_FAILED'); });
    tails.set(slot, next);
    return next;
  };

  return Object.freeze({
    wrap: (transport: ProfileDirectoryTransport): ProfileDirectoryTransport => Object.freeze({
      run: async (operation: ProfileDirectoryOperation, body?: unknown): Promise<ProfileDirectoryTransportResult> => {
        const slot = SLOT_OF[operation];
        if (slot === undefined) return transport.run(operation, body);
        const startedIn = epoch;
        const owner = await userId();
        const at = now();
        const result = await transport.run(operation, body);
        if (result.ok && owner !== null && result.text.length <= MAX_TEXT_CHARS) {
          // 请求途中换了人：不知道这一份是谁的，不记。记不下也不影响这一次答复。
          void userId().then((after) => (after === owner ? remember(owner, slot, at, result.text, startedIn) : undefined));
        }
        return result;
      },
    }),
    read: async () => {
      const owner = await userId();
      if (owner === null) return {};
      let raw: Record<string, unknown>;
      try {
        raw = await deps.area().get([...KEYS]);
      } catch {
        deps.onDiagnostic?.('PROFILE_CACHE_READ_FAILED');
        return {};
      }
      const slots: CachedSlots = {};
      const others: string[] = [];
      for (const slot of PROFILE_DIRECTORY_CACHE_SLOTS) {
        const key = `${KEY_PREFIX}${slot}`;
        if (!(key in raw)) continue;
        const entry = stored(raw[key]);
        if (entry !== null && entry.owner === owner) slots[slot] = { at: entry.at, text: entry.text as DirectoryResponseText };
        else others.push(key);
      }
      // 别的账号的（或坏掉的）那几格：顺手删掉。
      if (others.length > 0) void deps.area().remove(others).catch(() => { deps.onDiagnostic?.('PROFILE_CACHE_WRITE_FAILED'); });
      return slots;
    },
    clear: async () => {
      epoch += 1;
      try {
        await deps.area().remove([...KEYS]);
      } catch {
        deps.onDiagnostic?.('PROFILE_CACHE_WRITE_FAILED');
      }
    },
  });
}
