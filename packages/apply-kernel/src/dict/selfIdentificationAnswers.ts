/**
 * 用户在 argoland 门户里选的 EEO 答案（**原文**）→ 内核的自我认同码。
 *
 * ## 两边说的不是同一种话
 *
 * 门户把用户的选择按选项原文存（`eeo-self-identification` 的 `answers`：
 * `{ genderIdentity: ['Woman'], veteranStatus: ['I am not a protected veteran'], … }`），
 * 而内核的预填（`selfIdentificationOption`）认的是闭集码：`FEMALE`、`NOT_PROTECTED_VETERAN`、
 * `DECLINE`……码再拿去撞宿主页面上真有的选项。这里就是那一步翻译。
 *
 * ## 只翻译认得的，认不得的不猜
 *
 * 「自行描述」没有对应的码——那是用户自己写的一段话，宿主表单上没有一个选项能代表它，
 * 所以不预填。「不想回答」这一族一律译成 `DECLINE`，让内核去找宿主的「decline」选项。
 * 门户词表变了（多一个选项）只会让那一项不预填，不会译错。
 *
 * ## 种族是多选
 *
 * 门户允许多选；美国 EEO 表单通常单选、另有「两个及以上种族」。恰好一个可译的选择
 * → 那一个码；两个及以上**都可译**且不同 → `TWO_OR_MORE_RACES`；有任何一个译不出
 * （例如「Middle Eastern / North African」在内核里没有码）→ 整项不预填——把一半事实
 * 翻成「两个以上」是替用户下结论。`hispanicLatino` 答 Yes 优先于种族选择：内核对
 * 「Are you Hispanic or Latino?」这类题只认 `HISPANIC_OR_LATINO`。
 *
 * ## 「是否拉美裔」另外单独带一份（2026-09-23）
 *
 * 门户把它当成单独一问存（Yes / No / Decline to self-identify）。从前这里只把 Yes 折进种族码，
 * No 与「不想回答」就此丢掉——而内核对「Are you Hispanic/Latino?」只在种族码是拉美裔时才答，
 * 于是用户在门户里明明答过「否」，这道必填题每次都落成「只能由你本人填写」（负责人 2026-09-23
 * 实测）。现在这一问的原话另外译成 `hispanicLatino`（YES / NO / DECLINE）：这是他自己说的，
 * 不是我们从单值的种族推出来的。它不是扁平档案键（那一组与后端契约逐项相等），走规划选项。
 *
 * ## 「是否跨性别」与性取向（2026-09-23）
 *
 * 负责人：用户填了什么就回答什么。门户这两问从前在这里一个字都不译，于是「Do you identify as
 * transgender?」「What is your sexual orientation?」「I consider myself a member of the LGBTQ+
 * community.」一律落成「只能由你本人填写」。现在与「是否拉美裔」同样另外带：
 *
 *  · `transgenderStatus`：Yes / No / 不想回答 → YES / NO / DECLINE；
 *  · `sexualOrientation`：门户那六项各一个码，不想回答 → DECLINE。
 *
 * 两问都只认门户的原话：「自行描述」与认不得的话没有码。一问里存了不止一句时，每一句都得译得出、
 * 而且译成同一个码——自行描述的原文也可能跟着存进来，里面恰好有个「gay」不等于他选了 Gay。
 */

export type HispanicLatinoAnswer = 'YES' | 'NO' | 'DECLINE';
export type TransgenderAnswer = 'YES' | 'NO' | 'DECLINE';
export const SEXUAL_ORIENTATION_ANSWERS = [
  'ASEXUAL', 'BISEXUAL_PANSEXUAL', 'GAY', 'HETEROSEXUAL', 'LESBIAN', 'QUEER', 'DECLINE',
] as const;
export type SexualOrientationAnswer = (typeof SEXUAL_ORIENTATION_ANSWERS)[number];

export interface SelfIdentificationCodes {
  readonly eeoGender?: string;
  readonly eeoRace?: string;
  readonly eeoVeteran?: string;
  readonly eeoDisability?: string;
  readonly hispanicLatino?: HispanicLatinoAnswer;
  readonly transgenderStatus?: TransgenderAnswer;
  readonly sexualOrientation?: SexualOrientationAnswer;
}

const DECLINE = /^(?:decline\b|prefer not\b|i (?:don.?t|do not) (?:wish|want)\b|不想回答|不愿)/iu;
const SELF_DESCRIBE = /^(?:自行描述|self.?describe|prefer to self.?describe)/iu;

const GENDER: readonly Readonly<{ code: string; pattern: RegExp }>[] = [
  { code: 'NON_BINARY', pattern: /^non[-\s]?binary\b/iu },
  { code: 'FEMALE', pattern: /^(?:woman|female)\b/iu },
  { code: 'MALE', pattern: /^(?:man|male)\b/iu },
];

const RACE: readonly Readonly<{ code: string; pattern: RegExp }>[] = [
  { code: 'HISPANIC_OR_LATINO', pattern: /\bhispanic\b|\blatin[ox]\b/iu },
  { code: 'BLACK_OR_AFRICAN_AMERICAN', pattern: /^black\b|\bafrican (?:descent|american)\b/iu },
  { code: 'ASIAN', pattern: /\basian\b/iu },
  { code: 'AMERICAN_INDIAN_OR_ALASKA_NATIVE', pattern: /\bindigenous\b|\bamerican indian\b|\balaska native\b/iu },
  { code: 'NATIVE_HAWAIIAN_OR_OTHER_PACIFIC_ISLANDER', pattern: /\bnative hawaiian\b|\bpacific islander\b/iu },
  { code: 'WHITE', pattern: /^white\b/iu },
];

const VETERAN: readonly Readonly<{ code: string; pattern: RegExp }>[] = [
  { code: 'NOT_PROTECTED_VETERAN', pattern: /\bnot a protected veteran\b|^i am not\b/iu },
  { code: 'PROTECTED_VETERAN', pattern: /\bprotected veteran\b|^i am a\b/iu },
];

/** 性取向：整句对门户的原话（分隔符写法放宽），不做包含匹配。 */
const ORIENTATION: readonly Readonly<{ code: SexualOrientationAnswer; pattern: RegExp }>[] = [
  { code: 'ASEXUAL', pattern: /^asexual$/iu },
  { code: 'BISEXUAL_PANSEXUAL', pattern: /^bisexual ?(?:\/|and\/or|or) ?pansexual$/iu },
  { code: 'GAY', pattern: /^gay$/iu },
  { code: 'HETEROSEXUAL', pattern: /^(?:heterosexual ?(?:\/|or) ?straight|heterosexual|straight)$/iu },
  { code: 'LESBIAN', pattern: /^lesbian$/iu },
  { code: 'QUEER', pattern: /^queer$/iu },
];

function normal(value: string): string {
  return value.normalize('NFKC').trim();
}

function codeOf(value: string, table: readonly Readonly<{ code: string; pattern: RegExp }>[]): string | null {
  const text = normal(value);
  if (text.length === 0 || SELF_DESCRIBE.test(text)) return null;
  if (DECLINE.test(text)) return 'DECLINE';
  for (const entry of table) {
    if (entry.pattern.test(text)) return entry.code;
  }
  return null;
}

function first(values: readonly string[] | undefined): string | null {
  const value = values?.find((item) => typeof item === 'string' && normal(item).length > 0);
  return value === undefined ? null : value;
}

function raceCode(answers: Readonly<Partial<Record<string, readonly string[]>>>): string | null {
  const hispanic = first(answers['hispanicLatino']);
  if (hispanic !== null && /^yes\b/iu.test(normal(hispanic))) return 'HISPANIC_OR_LATINO';
  const chosen = (answers['raceEthnicity'] ?? []).filter((item) => typeof item === 'string' && normal(item).length > 0);
  if (chosen.length === 0) return null;
  const codes = chosen.map((item) => codeOf(item, RACE));
  if (codes.some((code) => code === null)) return null;
  const distinct = new Set(codes as string[]);
  if (distinct.size === 1) return [...distinct][0]!;
  if (distinct.has('DECLINE')) return null;
  return 'TWO_OR_MORE_RACES';
}

/** 是／否／不想回答三档的题（残障、是否拉美裔、是否跨性别）。 */
function yesNoDecline(value: string | null): 'YES' | 'NO' | 'DECLINE' | null {
  if (value === null) return null;
  const text = normal(value);
  if (SELF_DESCRIBE.test(text)) return null;
  if (DECLINE.test(text)) return 'DECLINE';
  if (/^yes\b/iu.test(text)) return 'YES';
  if (/^no\b/iu.test(text)) return 'NO';
  return null;
}

function orientationCode(value: string): SexualOrientationAnswer | null {
  const text = normal(value).replace(/\s+/gu, ' ');
  if (SELF_DESCRIBE.test(text)) return null;
  if (DECLINE.test(text)) return 'DECLINE';
  return ORIENTATION.find((entry) => entry.pattern.test(text))?.code ?? null;
}

/** 每一句都译得出、且译成同一个码才算；有一句译不出（自行描述、认不得）就整项不译。 */
function onlyCode<T extends string>(values: readonly string[] | undefined, translate: (value: string) => T | null): T | null {
  const chosen = (values ?? []).filter((item) => typeof item === 'string' && normal(item).length > 0);
  const codes = new Set(chosen.map(translate));
  return codes.size === 1 && !codes.has(null) ? [...codes][0]! : null;
}

/** 认不得的答案就没有那一个键：调用方按「档案里没有这一项」处理，一个字不猜。 */
export function selfIdentificationCodesFromAnswers(
  answers: Readonly<Partial<Record<string, readonly string[]>>>,
): SelfIdentificationCodes {
  const gender = (() => {
    const identity = first(answers['genderIdentity']);
    const fromIdentity = identity === null ? null : codeOf(identity, GENDER);
    if (fromIdentity !== null) return fromIdentity;
    const sex = first(answers['eeoSex']);
    return sex === null ? null : codeOf(sex, GENDER);
  })();
  const race = raceCode(answers);
  const veteranAnswer = first(answers['veteranStatus']);
  const veteran = veteranAnswer === null ? null : codeOf(veteranAnswer, VETERAN);
  const disability = yesNoDecline(first(answers['disabilityStatus']));
  const hispanicLatino = yesNoDecline(first(answers['hispanicLatino']));
  const transgenderStatus = onlyCode(answers['transgenderStatus'], yesNoDecline);
  const sexualOrientation = onlyCode(answers['sexualOrientation'], orientationCode);
  return Object.freeze({
    ...(gender === null ? {} : { eeoGender: gender }),
    ...(race === null ? {} : { eeoRace: race }),
    ...(veteran === null ? {} : { eeoVeteran: veteran }),
    ...(disability === null ? {} : { eeoDisability: disability }),
    ...(hispanicLatino === null ? {} : { hispanicLatino }),
    ...(transgenderStatus === null ? {} : { transgenderStatus }),
    ...(sexualOrientation === null ? {} : { sexualOrientation }),
  });
}
