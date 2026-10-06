/**
 * 「你现在人在 X 吗」——这一类题的判读。
 *
 * 实测语料里它长这样：
 *
 *   Are you currently located in the US?
 *   Do you currently reside in the United States?
 *   Are you based in Canada?
 *
 * 答案就在档案的 `addressCountry` 里。我们本来就已经把 Country 那一栏照抄进表单，
 * 所以据同一个值回答「我在不在那个国家」不是新的断言，是同一件事换个问法。
 *
 * ## 三条不答的线
 *
 * **一、题里掺了搬迁或意愿的，一律不答。**
 *
 *   Are you currently based in or willing to relocate to New York?
 *   Are you open to working in-person in one of our offices 2–3 days a week?
 *
 * 「愿不愿意搬」是偏好，档案里没有，也推不出来。这种题即便前半句我们答得上来，
 * 整道题的答案仍然只有用户知道——答一半等于替他表了态。
 *
 * **二、只答得出「是」，答不出「否」。**
 *
 * 档案里只有一个国家。题目点名的是它，我们说「是」；点名别的国家时，我们分不清
 * 「他确实不在那儿」和「这个国名我们压根没认出来」——照 workAuthorization 的成例，
 * 认不出就交还给用户。宁可少填一栏，也不替他否认一件我们并不知道的事。
 *
 * **三、题目必须点名国家。**
 *
 *   Are you currently located in the country where this role is based?
 *
 * 不点名就不答，理由与工作授权那条一字不差：答错不是少填一栏，是在正式申请里
 * 向雇主做了一个不实的事实陈述。
 */

import { namedWorkRegion } from './workAuthorization.ts';

/**
 * 掺了这些词就不是一道纯粹的「你在哪」。
 *
 * 搬迁与意愿在前面已说明；工作许可与担保另有专门的判读（`workAuthorization`），
 * 让它们落到这里会把一道法律问题当成一道地址问题答掉。
 */
const NOT_PURE_RESIDENCE = new RegExp(
  '\\brelocat(?:e|ing|ion)\\b|\\bwilling\\b|\\bopen to\\b|\\bprepared to\\b'
  + '|\\bmove to\\b|\\bmoving to\\b'
  + '|\\bauthoriz\\w*\\b|\\bsponsor\\w*\\b|\\bvisa\\b|\\bwork permit\\b'
  + '|\\beligible to work\\b|\\bright to work\\b',
  'i',
);

/** 「现在人在某处」的问法。`currently` 不是必需的：「Are you based in X?」同类。 */
const CURRENTLY_IN = new RegExp(
  '\\b(?:are|do)\\s+you\\s+(?:currently\\s+)?'
  + '(?:located|based|residing|reside|living|live)\\b'
  + '|\\byour\\s+current\\s+(?:location|residence|country)\\b',
  'i',
);

/**
 * 这是不是一道「你现在人在某国」的题；不是就返回 null。
 *
 * 只判问法，不判国家——国家由 `residenceRegion` 在用户自己的记录里反查。
 */
export function isCurrentResidenceQuestion(text: string): boolean {
  if (NOT_PURE_RESIDENCE.test(text)) return false;
  return CURRENTLY_IN.test(text);
}

/**
 * 题目点名的那个国家，且必须是**用户档案里的那一个**。
 *
 * 复用 `namedWorkRegion`：它做的判断正是「在用户自己有记录的几个国家里，题目恰好
 * 点到了哪一个」，并且已经处理了裸码大小写（小写 "us" 在「hear about us」里到处
 * 都是）与 `U.S` 这类带点写法。这里传进去的记录只有一条——档案里的居住国。
 *
 * 州名不算它所在的国家（与工作授权不同）：住在美国不等于住在加州。2026-09-24 之前州名还会落到同码的国家上——
 * 住在加拿大的人被答成「是，我住在加州」。
 */
export function residenceRegion(text: string, addressCountry: string): string | null {
  const code = addressCountry.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code)) return null;
  return namedWorkRegion(text, [code], false);
}
