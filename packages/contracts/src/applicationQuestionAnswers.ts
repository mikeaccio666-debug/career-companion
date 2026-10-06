/**
 * 答案记忆：用户确认过一次的申请题答案，跨申请复用。
 *
 * 这份契约只定义「同一道题怎么被认出来」和「答案长什么样」，不含存储与授权。
 * 它是 `ApplicationQuestionEvidencePort` 眼里的 `CONFIRMED_ANSWER` 来源——那个 port
 * 的头注禁止它自建答案记忆表，所以记忆必须先作为一等公民存在，再被它读。
 *
 * ## 为什么是「先类别、再归一化文本」两条路
 *
 * 插件线 2026-09-16 在真实申请页上量过 652 条未处理的必填项，结构是这样的：
 *
 *  · 跨厂商复现的语义类**措辞高度发散**。光工作授权一类就有 67 条、18 种措辞，
 *    公司名嵌在题干里（"...to work at Uplight..."），还有厂商自己的错字
 *    （"in the country were the job is located"）。**这一类靠文本匹配基本不可能命中，
 *    只能靠类别。**
 *  · 反过来，长尾非常长：218 种不同题干里 117 种只出现过一次，Top 25 也只盖 36%。
 *    **类别目录盖不住大头**，所以文本那条不是兜底而是主力。一次性的公司特有题
 *    （"why do you want to work at X"）没有复用价值，它们的价值在补答面板——
 *    问用户一次、填完这一份申请，而不是攒起来复用。
 *
 * 结论：类别目录**做小而准**，只收跨厂商复现、且措辞发散到文本匹配必然失手的语义类；
 * 其余一律走归一化文本。
 *
 * ## 为什么归一化必须保守
 *
 * 两道语义不同的题被并成同一个键，复用时就会把 A 题的答案写进 B 题——recruiter 收到
 * 一份答非所问的申请，而面板还显示「已填」。所以归一化只吸收大小写、空白、必填/选填
 * 标记这三类纯排版差异，不做词干化、不删停用词。宁可不命中，不可错命中。
 *
 * 这段规范化与插件侧 applicationQuestionIdentityPreimage 的 clean() 逐字节一致——
 * 不一致的话两边算出不同的键，而且任何一侧都不会报错，只表现为「记了但从不复用」。
 */

export const APPLICATION_ANSWER_SCHEMA_VERSION = 1 as const;

/**
 * 问题类别目录。每条旁注明它在 2026-09-16 那轮实测里的覆盖面（条数 / 跨几家厂商）。
 * 数据出自插件仓的 ATS lab 批量跑，逐字段结果在其 `.gitignore` 内，本仓无法独立复核。
 *
 * 准入条件：跨厂商复现，**且**措辞发散到归一化文本匹配会失手。只在一家出现、或措辞
 * 稳定到文本就能命中的，不进目录——那是给文本那条路的活。
 *
 * ## 为什么没有 `country`
 *
 * 它是实测里最高频的单条（35 条 / 2 家），看着最该收，但它**整类都不属于答案记忆**：
 * 逐条定性过，35 条全是档案字段，没有一条是工作授权语境——21 条与 Address/State/City/Zip
 * 同现（jobvite 的地址块），另 14 条夹在 Email 与 Phone 之间（greenhouse 把国家放进了
 * 联系块）。「用户住在哪个国家」属于档案，「有权在哪个国家工作」已被 `work-authorization`
 * 覆盖，两种语义都不通向一个叫 `country` 的类别。收了它只会把居住国的答案复用到工作
 * 授权题上。
 *
 * 判据可复用：**裸的一个词 "Country" 从不是工作授权题**——那一类的 18 种措辞没有一条
 * 短于一句话。`currentCompany` / 街道行 / `state` / `country` 这四项合计 72 条，归扩展
 * `APPLICATION_PROFILE_FIELD_KEYS`，不归这里。
 */
export const APPLICATION_ANSWER_CATEGORIES = [
  // 67 条 / 18 种措辞：公司名嵌在题干里、还有厂商错字，文本匹配必然失手。
  'work-authorization',
  // 与上一条同族但语义相反（"do you now or in the future require sponsorship"），
  // 答案常常相反，必须分成两个键，否则复用时会答反。
  'visa-sponsorship',
  // 11 条 / 2 家（"how did you hear about us"）。
  'referral-source',
  // 6 条：是否愿意搬迁。
  'relocation',
  // 6 条：期望薪资。
  'salary-expectation',
] as const;
export type ApplicationAnswerCategory = (typeof APPLICATION_ANSWER_CATEGORIES)[number];

export const APPLICATION_ANSWER_CONTROL_TYPES = [
  'TEXT',
  'TEXTAREA',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
] as const;
export type ApplicationAnswerControlType = (typeof APPLICATION_ANSWER_CONTROL_TYPES)[number];

/**
 * 答案取值。选项题记的是**选项文案**而不是选项 id：实测里 id 逐 posting 变、文案才稳定，
 * 记 id 的话换一个 posting 就对不上了。
 */
export type ApplicationAnswerValueV1 =
  | Readonly<{ kind: 'TEXT'; text: string }>
  | Readonly<{ kind: 'CHOICES'; optionTexts: readonly string[] }>;

export type ApplicationAnswerKeyV1 =
  | Readonly<{ kind: 'CATEGORY'; category: ApplicationAnswerCategory }>
  | Readonly<{ kind: 'TEXT'; digest: string }>;

const CATEGORY_PREFIX = 'cat:';
const TEXT_PREFIX = 'txt:';
const MAX_ANSWER_TEXT_BYTES = 8_000;
const MAX_OPTION_TEXT_BYTES = 2_000;
const MAX_OPTION_COUNT = 40;
const MAX_QUESTION_TEXT_BYTES = 8_000;

/** 必填/选填标记的各种写法，与插件侧同一条正则。 */
const REQUIRED_MARKER =
  /[*\uff0a]|\((?:required|optional)\)|[\uff08(]?(?:\u5fc5\u586b|\u9009\u586b)[)\uff09]?/gu;

/** 双向格式化字符与 C0/C1 控制字符：既是注入面，也会让存下来的答案不可读。 */
// eslint-disable-next-line no-control-regex -- 这道栅栏就是要精确拒绝这些控制字符
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export function applicationAnswerCategoryKeyV1(category: ApplicationAnswerCategory): string {
  return `${CATEGORY_PREFIX}${category}`;
}

/**
 * 由归一化题干算出文本键。摘要**必须在契约里算**——四份拷贝（server、portal、两个
 * 插件仓）各自算的话，同一道题会得到不同的键，记忆就跨端失效了。
 *
 * 入参是 `normalizeApplicationQuestionTextV1` 的输出；直接喂原始题干会得到不稳定的键。
 */
export async function applicationAnswerTextKeyV1(normalizedText: string): Promise<string | null> {
  if (typeof normalizedText !== 'string' || normalizedText.length === 0) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = new TextEncoder().encode(`${APPLICATION_ANSWER_SCHEMA_VERSION}:${normalizedText}`);
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return `${TEXT_PREFIX}${[...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 只吸收排版差异：NFKC、转小写、去掉必填/选填标记、折叠空白。
 * 刻意不做词干化与停用词删除——见文件头注。
 *
 * ⚠️ **这段必须与插件侧 `applicationQuestionIdentityPreimage` 的 `clean()` 逐字节一致。**
 * 两边算出不同的键，答案记忆表建得再对也永远命中不了，而且**任何一侧都不会报错**——
 * 它只表现为「记了但从不复用」，是最难发现的那种跨仓失效。改这里必须同时改那边，
 * 并且两边都要有对同一组样例的用例。
 *
 * 必填/选填标记要整串去掉而不是只去尾部的星号：实测里 `*` 出现在题干前后都有，
 * 而 `(required)` / `(optional)` / `（必填）` / `(选填)` 是同一件事的另外几种写法。
 */
export function normalizeApplicationQuestionTextV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (new TextEncoder().encode(value).length > MAX_QUESTION_TEXT_BYTES) return null;
  if (FORBIDDEN_TEXT.test(value)) return null;
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(REQUIRED_MARKER, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length === 0 ? null : normalized;
}

export function parseApplicationAnswerKeyV1(value: unknown): ApplicationAnswerKeyV1 | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith(CATEGORY_PREFIX)) {
    const category = value.slice(CATEGORY_PREFIX.length);
    return (APPLICATION_ANSWER_CATEGORIES as readonly string[]).includes(category)
      ? { kind: 'CATEGORY', category: category as ApplicationAnswerCategory }
      : null;
  }
  if (value.startsWith(TEXT_PREFIX)) {
    const digest = value.slice(TEXT_PREFIX.length);
    return /^[0-9a-f]{64}$/u.test(digest) ? { kind: 'TEXT', digest } : null;
  }
  return null;
}

export function parseApplicationAnswerValueV1(
  value: unknown,
  controlType: ApplicationAnswerControlType,
): ApplicationAnswerValueV1 | null {
  if (!isPlainObject(value)) return null;
  const wantsChoices = controlType === 'SINGLE_CHOICE' || controlType === 'MULTI_CHOICE';
  if (wantsChoices) {
    if (!hasExactKeys(value, ['kind', 'optionTexts']) || value.kind !== 'CHOICES') return null;
    const { optionTexts } = value;
    if (!Array.isArray(optionTexts) || optionTexts.length < 1) return null;
    if (optionTexts.length > MAX_OPTION_COUNT) return null;
    if (controlType === 'SINGLE_CHOICE' && optionTexts.length !== 1) return null;
    const seen = new Set<string>();
    for (const option of optionTexts) {
      if (!isSafeText(option, MAX_OPTION_TEXT_BYTES) || seen.has(option)) return null;
      seen.add(option);
    }
    return { kind: 'CHOICES', optionTexts: [...(optionTexts as readonly string[])] };
  }
  if (!hasExactKeys(value, ['kind', 'text']) || value.kind !== 'TEXT') return null;
  return isSafeText(value.text, MAX_ANSWER_TEXT_BYTES) ? { kind: 'TEXT', text: value.text } : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeText(value: unknown, limitBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= limitBytes &&
    !FORBIDDEN_TEXT.test(value)
  );
}

/**
 * 补答面板的读写线。面板把用户当场答的那一份交上来，之后同一道题就不必再问。
 *
 * 写入只带 owner 之外的东西：owner 一律从会话取，绝不从请求体取——否则「记住谁的答案」
 * 就成了调用方说了算。
 */
export type PutApplicationAnswerRequestV1 = Readonly<{
  schemaVersion: 1;
  answerKey: string;
  controlType: ApplicationAnswerControlType;
  value: ApplicationAnswerValueV1;
}>;

export type RememberedAnswerV1 = Readonly<{
  answerKey: string;
  categoryKey: string | null;
  controlType: ApplicationAnswerControlType;
  value: ApplicationAnswerValueV1;
  revision: string;
  confirmedAt: string;
}>;

export type ListApplicationAnswersResponseV1 = Readonly<{
  schemaVersion: 1;
  answers: readonly RememberedAnswerV1[];
}>;

export const APPLICATION_ANSWER_FAILURE_CODES = [
  'ANSWER_MEMORY_REQUEST_INVALID',
  'ANSWER_MEMORY_KEY_INVALID',
  'ANSWER_MEMORY_VALUE_INVALID',
] as const;
export type ApplicationAnswerFailureCode = (typeof APPLICATION_ANSWER_FAILURE_CODES)[number];

export type PutApplicationAnswerResponseV1 =
  | Readonly<{ schemaVersion: 1; ok: true; answerKey: string; revision: string }>
  | Readonly<{ schemaVersion: 1; ok: false; code: ApplicationAnswerFailureCode }>;

/**
 * 敌意边界解析：键必须解析得出，取值必须与它自己声明的控件类型相符。
 * 两者任一不符就整份拒——不修补、不猜测控件类型。
 */
export function parsePutApplicationAnswerRequestV1(
  value: unknown,
): PutApplicationAnswerRequestV1 | null {
  if (!isPlainObject(value)) return null;
  if (!hasExactKeys(value, ['schemaVersion', 'answerKey', 'controlType', 'value'])) return null;
  if (value.schemaVersion !== APPLICATION_ANSWER_SCHEMA_VERSION) return null;
  if (!parseApplicationAnswerKeyV1(value.answerKey)) return null;
  if (
    typeof value.controlType !== 'string' ||
    !(APPLICATION_ANSWER_CONTROL_TYPES as readonly string[]).includes(value.controlType)
  ) {
    return null;
  }
  const controlType = value.controlType as ApplicationAnswerControlType;
  const parsed = parseApplicationAnswerValueV1(value.value, controlType);
  if (!parsed) return null;
  return Object.freeze({
    schemaVersion: APPLICATION_ANSWER_SCHEMA_VERSION,
    answerKey: value.answerKey as string,
    controlType,
    value: parsed,
  });
}
