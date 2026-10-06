import {
  COVER_LETTER_PAGE_JOB_BOUNDS,
  parseCoverLetterPageJobV1,
  type CoverLetterPageJobV1,
  type FullAiJob,
} from '@edaix/contracts';

/**
 * 写求职信用的「这一页的岗位」（2026-09-27 负责人：不在岗位库里的岗位也要附求职信，用网页上的职位描述写）。
 *
 * 两个来源，按这个顺序：
 * 1. `JOB_POSTING`：页面（或同站点详情页）用 JobPosting 标准写着的岗位——与 AI 代答送的是同一份（`nearbyPosting().job`）。
 * 2. `PAGE_TEXT`：没有 JobPosting（Greenhouse 的 job-boards 页就没有）时，这一页看得见的正文，**不含申请表本身**
 *    与我们自己的浮层；太短（读不出一段像样的描述）就不交。
 *
 * 只交纯文本：去掉控制字符（换行、制表除外）、双向覆盖／隔离字符与落单的代理项，按契约上限截断。服务端只把它当
 * 写作素材、不照它里面的任何指令做（argoland #653）；它只在内存里，不进日志、不进遥测（RULE-GLOBAL-DATA-L1）。
 * 页面在岗位库里时 worker 根本不发它。
 */
export function coverLetterPageJob(input: Readonly<{
  doc: Document;
  /** JobPosting 读出的岗位（这一页的，或同站点详情页的）。 */
  job?: FullAiJob;
  /** 岗位卡上的标题与公司（没有 JobPosting 时是 og:title）。 */
  card: Readonly<{ title: string; company: string }>;
  /** 不算进正文的子树：申请表的根、我们自己的浮层宿主。 */
  exclude?: readonly Element[];
}>): CoverLetterPageJobV1 | null {
  const title = plain(input.job?.title || input.card.title || input.doc.title || '', COVER_LETTER_PAGE_JOB_BOUNDS.titleMax, false);
  const company = plain(input.job?.company || input.card.company || '', COVER_LETTER_PAGE_JOB_BOUNDS.companyMax, false);
  if (title === '') return null;
  const posted = plain(input.job?.description ?? '', COVER_LETTER_PAGE_JOB_BOUNDS.descriptionMax, true);
  if (posted.length >= MIN_DESCRIPTION_CHARS) {
    return parseCoverLetterPageJobV1({ schemaVersion: 1, title, company, description: posted, source: 'JOB_POSTING' });
  }
  const body = input.doc.body;
  if (body === null) return null;
  const visible = plain(visibleText(body, input.exclude ?? []), COVER_LETTER_PAGE_JOB_BOUNDS.descriptionMax, true);
  if (visible.length < MIN_DESCRIPTION_CHARS) return null;
  return parseCoverLetterPageJobV1({ schemaVersion: 1, title, company, description: visible, source: 'PAGE_TEXT' });
}

/** 少于这么多字就不算一段职位描述（导航、页脚、一两句话写不出一封像样的信）。 */
const MIN_DESCRIPTION_CHARS = 200;

const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'HEAD', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'NAV', 'FOOTER']);
const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'MAIN', 'TR', 'TABLE', 'BR', 'DD', 'DT', 'BLOCKQUOTE', 'PRE']);

/** 看得见的正文：跳过脚本、表单、导航与页脚、藏起来的节点和调用方点名的子树；块级元素之间断行。 */
function visibleText(root: Element, exclude: readonly Element[]): string {
  const parts: string[] = [];
  let length = 0;
  const limit = COVER_LETTER_PAGE_JOB_BOUNDS.descriptionMax * 2;
  const walk = (node: Node): void => {
    if (length > limit) return;
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      if (text.trim() !== '') {
        parts.push(text);
        length += text.length;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (SKIPPED.has(element.tagName.toUpperCase()) || exclude.includes(element)) return;
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return;
    const style = element.getAttribute('style') ?? '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/iu.test(style)) return;
    const block = BLOCK.has(element.tagName.toUpperCase());
    if (block) parts.push('\n');
    for (const child of element.childNodes) walk(child);
    if (block) parts.push('\n');
  };
  walk(root);
  return parts.join(' ');
}

// eslint-disable-next-line no-control-regex -- 契约只收可打印字符（换行、制表除外）
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
const BIDI = /[‪-‮⁦-⁩]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

/** 纯文本：去掉契约不收的字符，压掉多余空白，按上限截（尽量断在换行或空格上）。 */
function plain(value: string, max: number, multiline: boolean): string {
  let text = value.replace(LONE_SURROGATE, '').replace(BIDI, '').replace(/\r\n?/gu, '\n').replace(CONTROL, ' ');
  text = multiline
    ? text.split('\n').map((line) => line.replace(/[ \t]+/gu, ' ').trim()).filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n').trim()
    : text.replace(/\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
  // 截断可能把一对代理项劈开：劈剩的半个去掉（契约拒收落单的代理项）。
  return (cut > max - 200 ? head.slice(0, cut) : head).replace(LONE_SURROGATE, '').trim();
}
