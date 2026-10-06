/**
 * 宿主标给用户看的「必填」记号：一个星号，或一句「(required)」。
 *
 * 只认用户眼睛读到的那个记号——蜜罐几何、构建哈希 class（Ashby 的 `_required_f7cvd_91`）都不是它。
 * 星号四种写法：`*` `✱` `✳` `＊`；括号句两种：「(required)」「(必填)」（含全角括号）。
 * 「(optional)」「(选填)」是反面的声明，不是记号；句中一个光秃秃的 required 也不是（「Salary required」
 * 是一条真标签）。
 */

const STAR = '[*\\u2731\\u2733\\uFF0A]';
const REQUIRED_PHRASE = '[(（]\\s*(?:required|必填)\\s*[)）]';
const OPTIONAL_PHRASE = /[(（]\s*(?:optional|选填|選填)\s*[)）]/iu;

const WHOLE_MARKER = new RegExp(`^(?:${STAR}+|${REQUIRED_PHRASE})$`, 'iu');
const TRAILING_MARKER = new RegExp(`(?:${STAR}+|${REQUIRED_PHRASE})$`, 'iu');
const LEADING_MARKER = new RegExp(`^${STAR}+`, 'u');

function collapse(text: string): string {
  return text.replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]+/gu, ' ').trim();
}

/** 这一段文字**整个**就是一个必填记号（题干旁边单独一个星号元素、CSS 画出来的星号）。 */
export function isRequiredMarkerText(text: string): boolean {
  return WHOLE_MARKER.test(collapse(text));
}

/**
 * 一段标签文字的**头或尾**挂着必填记号：「Question *」「* Question」「Question (required)」。
 * 句中出现的星号不算（那是句子的一部分）；带着「(optional)」的一律不算——宿主明说了选填。
 */
export function hasRequiredMarkerAtEdge(text: string): boolean {
  const collapsed = collapse(text);
  if (collapsed === '' || OPTIONAL_PHRASE.test(collapsed)) return false;
  return TRAILING_MARKER.test(collapsed) || LEADING_MARKER.test(collapsed);
}

/**
 * CSS 生成内容（`getComputedStyle(el, '::after').content` 的原样返回值）是不是一个必填记号。
 *
 * Ashby 的必填题题干上只有一个构建哈希 class，星号是 `::after { content: "*" }` 画出来的——DOM 文字里
 * 没有它，属性里也没有。计算值的形状是一个带引号的 CSS 字符串（`"*"`），可以跟一段 `/ alt` 替代文字；
 * `none` / `normal` / 计数器 / `attr()` 一律不算。解析不了就不算：宁可少认一个必填，也不把一段装饰
 * 当成必填。
 */
export function generatedContentIsRequiredMarker(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const match = /^\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*(?:\/.*)?$/su.exec(content);
  if (match === null) return false;
  return isRequiredMarkerText(match[2]!.replace(/\\(.)/gsu, '$1'));
}
