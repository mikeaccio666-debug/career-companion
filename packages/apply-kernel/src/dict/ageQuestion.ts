/**
 * 年龄题的判读（2026-09-24）。
 *
 * 规则的 over18 正则把「是否年满 18」与反着问的「是否未满 18」「是否未成年」都认成 over18——这两种题的答案都由
 * 档案里的 over18 决定，但答哪一项要看题面问的是哪一边。从前内核一律按「是否年满 18」答：档案里年满 18 的人，
 * 对「Are you under the age of 18?」答了「是」。明确的档案值与按学历／工作经历推出来的值共用这一个判读。
 *
 * 只看问号之前那一句：后面跟的多半是说明（「If not, please explain」「Applicants under 18 need a permit」）。
 *
 * 「到了在 X 合法工作的年龄吗」（2026-09-24，adobe.wd5 第 3 步：「Are you of legal age to work in the country in which this
 * position will be based?」）问的也是年龄，不是工作授权。各地的法定工作年龄都不高于 18 岁：年满 18 就答得了「是」；
 * 未满 18 答不了（很多地方 14–16 岁就能工作），由调用方交还。
 */

import { isJobDependentField, normalizeGuardText } from './guards';
import { workAuthorizationQuestionKind } from './workAuthorization';

/** `AT_LEAST_18`：答 over18 本身；`UNDER_18`：答它的反面；`WORKING_AGE`：到了法定工作年龄吗——只有年满 18 答得了。 */
export type AgeQuestion = 'AT_LEAST_18' | 'UNDER_18' | 'WORKING_AGE';

/** 年满 18 那一边的说法：规则 over18 正则原有的几支，加上 18+ 与「and older」。 */
const AT_LEAST_SOURCE =
  '\\b(?:at least|over|older than|a minimum of|minimum)\\s+18\\b|\\b18\\s*\\+|\\b18\\s+(?:(?:years?|yrs?)\\s+(?:(?:of age|old)\\s+)?)?(?:or|and)\\s+(?:older|over|above)\\b|\\b18\\s+years\\s+(?:of age|old)\\b|\\bage of 18\\b';
const AT_LEAST = new RegExp(AT_LEAST_SOURCE, 'u');
const AT_LEAST_ALL = new RegExp(AT_LEAST_SOURCE, 'gu');

/**
 * 未满 18 那一边的说法（规则 over18 正则里反着问的那几支同一族）。「a minor (under 18 years of age)」两段各自
 * 命中、各自去掉，剩下的只有括号。
 */
const UNDER_SOURCE =
  '\\b(?:under|below|younger than|less than|not yet)\\s+(?:the age of\\s+)?18(?:\\s+(?:years?|yrs?)(?:\\s+(?:of age|old))?)?\\b'
  + '|\\b(?:(?:currently|still)\\s+)?(?:a\\s+)?minor\\b|\\bunder-?aged?\\b';
const UNDER = new RegExp(UNDER_SOURCE, 'u');
const UNDER_ALL = new RegExp(UNDER_SOURCE, 'gu');

const NEGATION = /\bnot\b|n['’]t\b|\bnever\b/u;

/** 反着问的题里，除了那一句本身，只许有这些字：多一个别的词（条件、另一件事）就说不清了。 */
const SCAFFOLD: ReadonlySet<string> = new Set(
  'are you i am is the applicant candidate currently still please confirm that a an or yes no required optional'.split(' '),
);
/** 「年满 18 且有权工作」里问年龄的那半句，除了年龄那几个字只许有这些（「at least 18 hours a week」不是年龄）。 */
const AGE_CLAUSE_WORDS: ReadonlySet<string> = new Set([...SCAFFOLD, 'years', 'year', 'yrs', 'of', 'age', 'old', 'older', 'over', 'above']);

/** 法定工作年龄的说法（规则 over18 正则里同一支）。「legal drinking age」「legal age to sell …」是别的年龄，不认。 */
const WORKING_AGE = /\blegal (?:working age|age (?:to|for|of) (?:work|employment|be employed))\b/u;
/**
 * 问法定工作年龄的那一句，除了那几个字只许有问法与地点：「in the country in which this position will be based」
 * 「in the United States」。多一个别的词就说不清——「in a bar」「full time」说的是另一个年龄或另一件事。
 */
const WORKING_AGE_WORDS: ReadonlySet<string> = new Set([
  ...AGE_CLAUSE_WORDS,
  ...'in for where which this your country state position job role will be based located work working united states us usa'.split(' '),
]);

const wordsOf = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** 问号之前那一句（没有问号就是整句）。「(Required)」一类的标记算作允许出现的字（见 `SCAFFOLD`）。 */
const questionPart = (label: string): string => normalizeGuardText(label).split('?')[0] ?? '';

const mentions18 = (text: string): boolean => AT_LEAST.test(text) || UNDER.test(text);
const mentionsAge = (text: string): boolean => mentions18(text) || WORKING_AGE.test(text);

/**
 * 这道认成 over18 的题问的是哪一边；说不清就 null（不答）。
 *
 * 正着问的与从前一样。反着问的（under 18、younger than 18、not yet 18、a minor）只在那一句干干净净时才算：
 * 带条件（「If you are under 18, …」）、否定（「Are you not under 18?」）、两边都提、或问号前还问了别的，一律 null。
 * 问号前根本没提到 18 岁（年龄写在后面的说明里）也是 null：那道题问的不是年龄。
 * 问法定工作年龄、又没写明 18 岁的是 `WORKING_AGE`，同样只在那一句干干净净时才算（否定、条件也都不在允许的字里）。
 */
export function ageQuestion(label: string): AgeQuestion | null {
  const text = questionPart(label);
  if (!mentions18(text) && WORKING_AGE.test(text)) {
    return wordsOf(text.replace(WORKING_AGE, ' ')).every((word) => WORKING_AGE_WORDS.has(word)) ? 'WORKING_AGE' : null;
  }
  const rest = text.replace(UNDER_ALL, ' ');
  if (NEGATION.test(rest)) return null;
  if (rest === text) return AT_LEAST.test(text) ? 'AT_LEAST_18' : null;
  return wordsOf(rest).every((word) => SCAFFOLD.has(word)) ? 'UNDER_18' : null;
}

/** 问号前那一句是一道年龄题（哪一边都算）：认成 over18 的这一栏按年龄答，不走「随岗位而定」那道交还。 */
export function asksAge(label: string): boolean {
  return mentionsAge(questionPart(label));
}

/**
 * 年龄与随岗位而定的事（工作授权、担保、搬迁、薪资……）问在同一句里：不许只凭其中一半作答。
 * 能答的只有 `asksAgeAndWorkAuthorization` 那一种。
 */
export function mixesAgeWithJobQuestion(label: string): boolean {
  const text = questionPart(label);
  return mentionsAge(text) && (isJobDependentField(text) || workAuthorizationQuestionKind(text) !== null);
}

/**
 * 恰好是「年满 18 且有权在 X 工作」：问号前两句用 and 连着，一句正着问年龄，一句问有权工作（含「不需要担保就有权
 * 工作」）；没有否定、没有反着问、没有第三件事。答案是两半的合取，由调用方按档案与授权记录算。
 */
export function asksAgeAndWorkAuthorization(label: string): boolean {
  const text = questionPart(label).replace(/\b(?:and|or) (?:older|over|above)\b/gu, 'or older');
  if (NEGATION.test(text) || UNDER.test(text)) return false;
  const parts = text.split(/\s*(?:\band\b|[,;])\s*/u).filter((part) => part !== '');
  if (parts.length !== 2) return false;
  const [age, work] = AT_LEAST.test(parts[0]!) ? [parts[0]!, parts[1]!] : [parts[1]!, parts[0]!];
  if (!AT_LEAST.test(age) || AT_LEAST.test(work)) return false;
  if (!wordsOf(age.replace(AT_LEAST_ALL, ' ')).every((word) => AGE_CLAUSE_WORDS.has(word))) return false;
  const kind = workAuthorizationQuestionKind(work);
  return kind === 'AUTHORIZED_TO_WORK' || kind === 'AUTHORIZED_WITHOUT_SPONSORSHIP';
}
