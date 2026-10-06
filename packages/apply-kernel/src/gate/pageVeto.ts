/**
 * 页面级注入否决。碰 DOM，但**只读**、只做同步查询、不注册任何监听。
 *
 * 排在 `hostVeto` 之后：主机名判断是纯字符串，DOM 查询要贵得多，所以先便宜后贵。
 * 每一条都要么零误报、要么误杀成本为零。
 */

import type { HostVisibilityStyle } from '../contracts';

export const PAGE_VETO_REASONS = [
  /** 机器人挑战页（Cloudflare 等）。 */
  'CHALLENGE_PAGE',
  /** 匿名举报 / 伦理热线 —— 注入的后果是把匿名性拿掉。 */
  'ANONYMOUS_REPORT',
  /** 存在密码字段：登录、注册、改密、SSO。 */
  'CREDENTIAL_PAGE',
] as const;
export type PageVetoReason = (typeof PAGE_VETO_REASONS)[number];

export type PageVetoVerdict =
  | { readonly vetoed: false }
  | { readonly vetoed: true; readonly reason: PageVetoReason };

/**
 * 匿名举报类页面。
 *
 * 这一条的严重性与别的不同：在 NAVEX EthicsPoint 这类页面上把姓名填进去，
 * 不是"填错了"，是**把匿名性拿掉**——而这类页面上姓名/邮箱/电话恰恰都是可选字段，
 * 正向门会全部通过。
 *
 * 误杀成本为零：真的求职申请表不会说 "you may submit this anonymously"。
 */
const ANONYMOUS_REPORT =
  /\banonymous(?:ly)?\b|whistle.?blow|report a concern|ethics ?(?:hotline|point)|speak ?up\b|匿名(?:举报|投诉|反馈)?|举报(?:热线|平台)/i;

/**
 * 挑战页的**容器**信号。
 *
 * ⚠️ 判据必须是**合取**，见 `evaluatePageVeto` 的说明。
 * `window._cf_chl_opt` 在 content script 的 isolated world 里恒为 undefined，
 * 所以它不能用——只能看 DOM。
 */
export const CHALLENGE_CONTAINER_SELECTOR = [
  '#challenge-running',
  '#challenge-form',
  '#cf-challenge-running',
  '#cf-please-wait',
  '.cf-browser-verification',
  '[id^="cf-chl"]',
  '#px-captcha',
  '#distilCaptchaContainer',
].join(',');

const CHALLENGE_SCRIPT_SELECTOR = 'script[src*="/cdn-cgi/challenge-platform/"]';

/** 挑战页的正文极短且几乎没有可交互控件——这是把它与正常页面分开的那一半。 */
const CHALLENGE_MAX_TEXT_LENGTH = 2_500;
const CHALLENGE_MAX_CONTROLS = 4;

/** 登录、注册、改密那一类页面的硬信号：密码框。连填（wizardAdvance.ts 的 detectHumanCheckpoint）也用它。 */
export const CREDENTIAL_SELECTOR =
  'input[type="password"], input[autocomplete^="current-password"], input[autocomplete^="new-password"]';

/** 真正的密码框：不论藏没藏，一律算（「密码字段是全表唯一零误报的硬门」）。 */
const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';

/**
 * 只靠 autocomplete 声明「这是密码」的普通输入框。
 *
 * 2026-09-28 实测（gravityforms.com 的招聘表，WordPress + Gravity Forms）：表上有一个反机器人的蜜罐栏
 * （标签「Instagram」，`type="text"`），Gravity Forms 给它写了 `autocomplete="new-password"`——只是为了
 * 不让浏览器往陷阱里自动填东西；它住在一个样式表 `display:none` 的容器里，人看不见、也摸不到（Tab 键
 * 走不进去）。旧判据看到那个 autocomplete 就把整页当成注册页否决，于是一张正常的申请表「认不出」。
 *
 * 所以这一类只在**人摸得到**的时候才算：藏起来（自己或祖先 `display:none`、`visibility:hidden`、
 * `hidden` 属性、行内 `display:none`）的不算。真正看得见的那一个照旧否决整页；`type="password"`
 * 不在这一类里，藏不藏都照旧否决。
 */
const PASSWORD_AUTOCOMPLETE_SELECTOR =
  'input[autocomplete^="current-password"], input[autocomplete^="new-password"]';

/** 页面否决的环境能力注入。kernel 不碰 `getComputedStyle`（RULE-KERNEL-DETERMINISTIC-BOUNDARY）。 */
export interface PageVetoOptions {
  /**
   * 读一个元素的计算可见性，与 `ScanRootOptions.readVisibility` 同一个读法。只用于一件事：一个只靠
   * autocomplete 自称密码的输入框是不是藏起来了（见 `PASSWORD_AUTOCOMPLETE_SELECTOR`）。
   * 不给就只看属性层（`hidden`、行内 `display:none`）——读不到样式表里的藏法，那个栏照旧算，保守一侧。
   */
  readonly readVisibility?: (element: Element) => HostVisibilityStyle;
}

/** 这个元素人看不见、也摸不到：自己或某个祖先不渲染。`visibility` 会继承，只看它自己的计算值。 */
function isHiddenAndUnfocusable(
  element: Element,
  readVisibility: PageVetoOptions['readVisibility'],
): boolean {
  if (element.localName === 'input' && (element as HTMLInputElement).type === 'hidden') return true;
  if (readVisibility !== undefined) {
    const own = readVisibility(element);
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return true;
  }
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return true;
    if ((node as Partial<HTMLElement>).style?.display === 'none') return true;
    if (readVisibility !== undefined && readVisibility(node).display === 'none') return true;
  }
  return false;
}

/** 一个人看得见、摸得到的密码类输入框（真正的密码框不论藏没藏都算）。 */
function hasCredentialField(doc: Document, readVisibility: PageVetoOptions['readVisibility']): boolean {
  if (doc.querySelector(PASSWORD_INPUT_SELECTOR) !== null) return true;
  for (const input of Array.from(doc.querySelectorAll(PASSWORD_AUTOCOMPLETE_SELECTOR))) {
    if (!isHiddenAndUnfocusable(input, readVisibility)) return true;
  }
  return false;
}

/**
 * 页面上**人能读到**的文字。
 *
 * 为什么不能直接用 `body.textContent`（2026-08-03，真实页面实测）：它**包含
 * `<script>` 标签里的源码**。`jobs.lever.co` 的内联脚本里有一行
 * `var SEGMENT_COOKIES = ['ajs_user_id', 'ajs_anonymous_id', 'ajs_group_id'];`
 * ——`ajs_anonymous_id` 命中了匿名举报页的 `anonymous`，于是**每一个装了 Segment
 * 的 Lever 申请页都被否决，浮层根本不出现，且零报错**。这一页 textContent 7911 字，
 * 真正可读的只有 2294 字，其余全是 21 个 script 标签的源码。
 *
 * 仍然不用 `innerText`：那会强制布局（reflow），在注入决策这个位置太贵。
 * TreeWalker 只遍历文本节点，不触发布局。
 */
function readableText(doc: Document): string {
  const body = doc.body;
  if (!body) return '';
  // 元素与文字一起走：碰到 script／style／noscript／template 就整棵子树跳过（FILTER_REJECT），别的元素
  // 只是路过（FILTER_SKIP）。与「每个文字节点往上找一遍祖先」读到的是同一段文字，但每个节点只看一次——
  // 从前那一版是「文字节点数 × 树深」（2026-09-28 lab 录 CPU：Jane Street 一次探测里它占 8ms）。
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      const tag = (node as Element).localName;
      return tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template'
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_SKIP;
    },
  });
  let text = '';
  while (walker.nextNode()) text += `${walker.currentNode.nodeValue ?? ''} `;
  return text;
}

export function evaluatePageVeto(doc: Document, options: PageVetoOptions = {}): PageVetoVerdict {
  // 一次遍历，两个判据共用。挑战页的"短"也该按人能读到的字数算，
  // 而不是把 21 个 script 标签的源码算成正文。
  const readable = readableText(doc);

  /**
   * 挑战页判据 = （容器 OR 脚本）**AND**（正文极短 AND 控件极少）。
   *
   * 单看脚本会造成一类**静默杀伤**：`/cdn-cgi/challenge-platform/` 这个路径前缀在
   * **普通** Cloudflare 站点上也存在——开了 Bot Fight Mode / JS Detections 的站点会把
   * `.../scripts/jsd/main.js` 注入到每一个正常页面。拿它单独当否决信号，会静默杀掉
   * 真实的 Lever / Ashby 申请页（Lever 自己就用 hCaptcha）。
   *
   * 单看容器则会漏掉只有脚本先到、容器后渲染的那一瞬。合取两边，再要求"页面确实
   * 空得像张挑战页"，才既不漏也不误杀。
   */
  const hasChallengeMarker =
    doc.querySelector(CHALLENGE_CONTAINER_SELECTOR) !== null ||
    doc.querySelector(CHALLENGE_SCRIPT_SELECTOR) !== null;
  if (hasChallengeMarker) {
    const controlCount = doc.querySelectorAll('input, select, textarea, button').length;
    if (readable.length < CHALLENGE_MAX_TEXT_LENGTH && controlCount <= CHALLENGE_MAX_CONTROLS) {
      return { vetoed: true, reason: 'CHALLENGE_PAGE' };
    }
  }

  // 密码字段是全表唯一零误报的硬门。**整帧一次查询**，不受 `<form>` 边界限制——
  // 评审指出按 form 扫会漏掉 formless 的 React 账户页，而那正是最需要挡住的一类。
  // 只靠 autocomplete 自称密码、而且藏起来的那种不算（Gravity Forms 的蜜罐，见 PASSWORD_AUTOCOMPLETE_SELECTOR）。
  if (hasCredentialField(doc, options.readVisibility)) {
    return { vetoed: true, reason: 'CREDENTIAL_PAGE' };
  }

  if (ANONYMOUS_REPORT.test(readable)) {
    return { vetoed: true, reason: 'ANONYMOUS_REPORT' };
  }

  return { vetoed: false };
}
