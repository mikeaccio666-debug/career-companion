import {
  parseResolveMissionPageBindingResponseV1,
  type MissionPageBindingV1,
} from '@edaix/contracts';
import { isApplyFormPath } from '@edaix/apply-kernel/registry';
import { detectApplyVendor } from '@edaix/apply-kernel/vendors';
import { dockSurfacesOn } from './autofillDockDecision';

/** The page a browser is standing on, as the content script reported it. */
export type MissionPageBindingPage = Readonly<{ canonicalOrigin: string; pathname: string }>;

export interface MissionPageBindingClient {
  /**
   * The owner's Mission for exactly this page, or null (2026-09-24, argoland §4.15).
   * The backend matches the page against its verified application targets; nothing the
   * page says can nominate a Mission.
   */
  resolve(page: MissionPageBindingPage): Promise<MissionPageBindingV1 | null>;
  /** True only when the backend proved a Mission for exactly this page. */
  isBound(page: MissionPageBindingPage): Promise<boolean>;
}

const DEFAULT_PAGE_BINDING_TIMEOUT_MS = 5_000;

/**
 * Asks the owner-scoped backend read which Mission the page this browser is standing on
 * belongs to (`POST /api/v1/agent/missions/page-binding`).
 *
 * Everything that is not a proven binding is none. An error, a timeout, a body the strict
 * decoder refuses, a binding for another page -- each resolves to null, because an
 * optimistic answer would tie the user's fill to an application we cannot prove. And a
 * page outside the recognised apply pages is never asked about at all: the dock could not
 * act on the answer, so the API is not told the user is there.
 *
 * Before 2026-09-24 this asked `GET …/page-binding` for a bare boolean. The backend never
 * implemented that read (it answers 400), so every page stayed unbound; released builds
 * still ask it and keep today's gesture fill.
 */
export function createMissionPageBindingClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  /** Overall auth + fetch + decode deadline. Expiry always resolves to null. */
  timeoutMs?: number;
}>): MissionPageBindingClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_PAGE_BINDING_TIMEOUT_MS;

  const request = (page: MissionPageBindingPage, token: string) =>
    fetchFn(new URL('/api/v1/agent/missions/page-binding', input.apiBase).toString(), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        canonicalOrigin: page.canonicalOrigin,
        pathname: page.pathname,
      }),
    });

  const resolve = async (page: MissionPageBindingPage): Promise<MissionPageBindingV1 | null> => {
    if (!inFirstBatch(page)) return null;
    return (await withDeadline(askAuthority(page), timeoutMs)) ?? null;
  };

  return Object.freeze({
    resolve,
    async isBound(page: MissionPageBindingPage): Promise<boolean> {
      return (await resolve(page)) !== null;
    },
  });

  async function askAuthority(page: MissionPageBindingPage): Promise<MissionPageBindingV1 | null> {
    try {
      let token = await input.getAccessToken();
      if (!token) return null;
      let response = await request(page, token);
      if (response.status === 401 && input.refreshAccessToken) {
        const error = await safeJson(response);
        if (!isLoginRequired(error)) return null;
        token = await input.refreshAccessToken();
        if (!token) return null;
        response = await request(page, token);
      }
      if (response.status !== 200 || !response.ok) return null;
      const binding = parseResolveMissionPageBindingResponseV1(await safeJson(response))?.binding ?? null;
      // The answer must be about the page we asked about, not merely a page.
      if (
        binding === null ||
        binding.target.canonicalOrigin !== page.canonicalOrigin ||
        binding.target.pathname !== page.pathname
      ) return null;
      return binding;
    } catch {
      return null;
    }
  }
}

/** URL-only, and the same vendor list the dock decides its face from. */
function inFirstBatch(page: MissionPageBindingPage): boolean {
  let hostname: string;
  try {
    hostname = new URL(page.canonicalOrigin).hostname;
  } catch {
    return false;
  }
  const vendor = detectApplyVendor(hostname);
  return dockSurfacesOn(vendor) && isApplyFormPath(vendor!, page.pathname);
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    void operation.then(finish, () => finish(null));
  });
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isLoginRequired(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    !Array.isArray(value) &&
    (value as { code?: unknown }).code === 'LOGIN_REQUIRED';
}
