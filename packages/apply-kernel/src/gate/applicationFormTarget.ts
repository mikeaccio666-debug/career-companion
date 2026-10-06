import type { ApplyVendor } from '../contracts';

/**
 * 白标 C（P2-12）：指纹认出厂商、页面上却没有申请表的落地页（coinbase / pinterest 那一类岗位描述页），
 * 从页面上**厂商自己的产物**里读出「申请表在哪」，让浮层出一颗「打开申请表」——只导航，不写。
 *
 * 只读两样东西，都是 Greenhouse 自己的：
 *  · board token：`<link rel="preload" href="https://boards-api.greenhouse.io/v1/boards/<token>/…">`，
 *    或官方 embed 的 `iframe#grnhse_iframe[src*="for=<token>"]`；
 *  · 岗位 id：URL 的 `?gh_jid=<id>`，或那个 iframe src 的 `token=<id>`。
 * 两样都恰好一个才拼得出唯一 URL；拼不出就 null，浮层不出那颗按钮。token 与 id 都按闭集正则校验，
 * 页面文本一个字不进 URL——URL 由 worker 按固定模板拼，这里只交出两个 token。
 */
export interface ApplicationFormTarget {
  readonly vendor: Extract<ApplyVendor, 'greenhouse'>;
  readonly boardToken: string;
  readonly jobId: string;
}

export const GREENHOUSE_BOARD_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const GREENHOUSE_JOB_ID_PATTERN = /^[0-9]{1,20}$/;

export interface ApplicationFormTargetInput {
  readonly doc: Document;
  readonly url: URL;
}

function hrefs(doc: Document, selector: string, attr: string): string[] {
  try {
    return Array.from(doc.querySelectorAll(selector))
      .map((element) => element.getAttribute(attr) ?? '')
      .filter((value) => value !== '');
  } catch {
    return [];
  }
}

function parseUrl(value: string, base: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function unique(values: readonly string[]): string | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0]! : null;
}

export function applicationFormTarget(input: ApplicationFormTargetInput): ApplicationFormTarget | null {
  const { doc, url } = input;
  const base = url.href;
  const tokens: string[] = [];
  const jobIds: string[] = [];

  for (const href of hrefs(doc, 'link[rel="preload"][href]', 'href')) {
    const parsed = parseUrl(href, base);
    if (parsed === null || parsed.hostname !== 'boards-api.greenhouse.io') continue;
    const match = /^\/v1\/boards\/([^/]+)(?:\/|$)/.exec(parsed.pathname);
    if (match !== null) tokens.push(decodeURIComponent(match[1]!).toLowerCase());
  }
  for (const src of hrefs(doc, 'iframe#grnhse_iframe[src]', 'src')) {
    const parsed = parseUrl(src, base);
    if (parsed === null || !/(^|\.)greenhouse\.io$/.test(parsed.hostname)) continue;
    const forToken = parsed.searchParams.get('for');
    const token = parsed.searchParams.get('token');
    if (forToken !== null) tokens.push(forToken.toLowerCase());
    if (token !== null) jobIds.push(token);
  }
  const ghJid = url.searchParams.get('gh_jid');
  if (ghJid !== null) jobIds.push(ghJid);

  const boardToken = unique(tokens);
  const jobId = unique(jobIds);
  if (boardToken === null || jobId === null) return null;
  if (!GREENHOUSE_BOARD_TOKEN_PATTERN.test(boardToken) || !GREENHOUSE_JOB_ID_PATTERN.test(jobId)) return null;
  return Object.freeze({ vendor: 'greenhouse', boardToken, jobId });
}
