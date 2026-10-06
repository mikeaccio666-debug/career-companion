import { APPLY_VENDORS, type ApplyVendor } from '@edaix/apply-kernel/vendors';

/** Value-free, session-only registry for exact application tabs. */

export interface RegisteredApplicationTab {
  readonly tabId: number;
  readonly canonicalOrigin: string;
  readonly pathname: string;
  readonly at: number;
}

export type ApplicationTabRegistry = Readonly<Record<string, RegisteredApplicationTab>>;

export interface BridgeHello {
  readonly canonicalOrigin: string;
  readonly pathname: string;
  /** 白标 B（P2-11）：主机不在厂商表里时，内容脚本按厂商自己的产物算出的「先试哪家」。只是提示。 */
  readonly vendorHint?: ApplyVendor;
  /** 主机不在厂商表里、也没有指纹时：页面上恰好有一张通用申请表（2026-09-24，`lib/pageEvidence.ts`）。只是提示。 */
  readonly genericForm?: true;
  /** 那张通用表里还有只有求职才问的栏（2026-09-25）。只是提示。 */
  readonly genericJobForm?: true;
  /** 页面自己用 JobPosting 标准说它是一个岗位（2026-09-24）。只是提示。 */
  readonly jobPosting?: true;
}

const HELLO_REQUIRED_KEYS: readonly string[] = ['kind', 'origin', 'pathname'];
const HELLO_OPTIONAL_KEYS: ReadonlySet<string> = new Set(['vendorHint', 'genericForm', 'genericJobForm', 'jobPosting']);

export function parseBridgeHello(value: unknown): BridgeHello | null {
  if (!isRecord(value) || value.kind !== 'bridge/hello') return null;
  const keys = Object.keys(value);
  if (!HELLO_REQUIRED_KEYS.every((key) => keys.includes(key))) return null;
  if (!keys.every((key) => HELLO_REQUIRED_KEYS.includes(key) || HELLO_OPTIONAL_KEYS.has(key))) return null;
  const hinted = Object.hasOwn(value, 'vendorHint');
  if (hinted && !(APPLY_VENDORS as readonly string[]).includes(value.vendorHint as string)) return null;
  // 两个证据位只认字面量 true：不带就是没有，别的形状整条报到作废。
  if (Object.hasOwn(value, 'genericForm') && value.genericForm !== true) return null;
  if (Object.hasOwn(value, 'genericJobForm') && value.genericJobForm !== true) return null;
  if (Object.hasOwn(value, 'jobPosting') && value.jobPosting !== true) return null;
  const canonicalOrigin = parseExactHttpsOrigin(value.origin);
  const pathname = parseCanonicalPathname(value.pathname, canonicalOrigin);
  if (canonicalOrigin === null || pathname === null) return null;
  return Object.freeze({
    canonicalOrigin,
    pathname,
    ...(hinted ? { vendorHint: value.vendorHint as ApplyVendor } : {}),
    ...(value.genericForm === true ? { genericForm: true as const } : {}),
    ...(value.genericJobForm === true ? { genericJobForm: true as const } : {}),
    ...(value.jobPosting === true ? { jobPosting: true as const } : {}),
  });
}

/** Legacy origin-only entries are intentionally ignored, never upgraded by guesswork. */
export function parseTabRegistry(value: unknown): ApplicationTabRegistry {
  if (!isRecord(value)) return Object.freeze({});
  const parsed: Record<string, RegisteredApplicationTab> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isExactRecord(candidate, ['tabId', 'canonicalOrigin', 'pathname', 'at'])) continue;
    if (
      !Number.isSafeInteger(candidate.tabId) ||
      Number(candidate.tabId) < 0 ||
      key !== String(candidate.tabId) ||
      !Number.isSafeInteger(candidate.at) ||
      Number(candidate.at) < 0
    ) continue;
    const canonicalOrigin = parseExactHttpsOrigin(candidate.canonicalOrigin);
    const pathname = parseCanonicalPathname(candidate.pathname, canonicalOrigin);
    if (canonicalOrigin === null || pathname === null) continue;
    parsed[key] = Object.freeze({
      tabId: Number(candidate.tabId),
      canonicalOrigin,
      pathname,
      at: Number(candidate.at),
    });
  }
  return Object.freeze(parsed);
}

export function registerApplicationTab(
  registry: ApplicationTabRegistry,
  entry: RegisteredApplicationTab,
): ApplicationTabRegistry {
  const canonicalOrigin = parseExactHttpsOrigin(entry.canonicalOrigin);
  const pathname = parseCanonicalPathname(entry.pathname, canonicalOrigin);
  if (
    canonicalOrigin === null ||
    pathname === null ||
    !Number.isSafeInteger(entry.tabId) ||
    entry.tabId < 0 ||
    !Number.isSafeInteger(entry.at) ||
    entry.at < 0
  ) return registry;
  return Object.freeze({
    ...registry,
    [String(entry.tabId)]: Object.freeze({
      tabId: entry.tabId,
      canonicalOrigin,
      pathname,
      at: entry.at,
    }),
  });
}

export function removeApplicationTab(
  registry: ApplicationTabRegistry,
  tabId: number,
): ApplicationTabRegistry {
  const next = { ...registry };
  delete next[String(tabId)];
  return Object.freeze(next);
}

/** Ambiguity is not authority: two exact candidates produce no selection. */
export function selectExactApplicationTab(
  entries: readonly RegisteredApplicationTab[],
  canonicalOrigin: string,
  pathname: string,
): RegisteredApplicationTab | null {
  const exactOrigin = parseExactHttpsOrigin(canonicalOrigin);
  const exactPathname = parseCanonicalPathname(pathname, exactOrigin);
  if (exactOrigin === null || exactPathname === null) return null;
  const matches = entries.filter(
    (entry) => entry.canonicalOrigin === exactOrigin && entry.pathname === exactPathname,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function parseExactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      parsed.origin === value &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseCanonicalPathname(value: unknown, canonicalOrigin: string | null): string | null {
  if (
    canonicalOrigin === null ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    /%(?![0-9A-F]{2})/i.test(value) ||
    /%(?:2E|2F|5C|25|00)/i.test(value)
  ) return null;
  try {
    const parsed = new URL(value, canonicalOrigin);
    return parsed.origin === canonicalOrigin &&
      parsed.pathname === value &&
      parsed.search === '' &&
      parsed.hash === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * The entry a sender may act as, or null.
 *
 * A tab registers exactly one page at hello. A later request from that tab is
 * honoured only while the sender is still on that page — same origin, same
 * path. A tab that navigated since, or one that never reported, gets null
 * rather than a refusal it could probe: the answer is the same for "unknown"
 * and "moved", on purpose.
 */
export function registeredExactPage(
  registry: ApplicationTabRegistry,
  tabId: number,
  senderUrl: string,
): RegisteredApplicationTab | null {
  if (!Number.isSafeInteger(tabId) || tabId < 0) return null;
  const entry = registry[String(tabId)];
  if (entry === undefined) return null;
  let url: URL;
  try { url = new URL(senderUrl); } catch { return null; }
  return entry.canonicalOrigin === url.origin && entry.pathname === url.pathname ? entry : null;
}
