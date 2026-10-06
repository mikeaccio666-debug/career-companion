/**
 * 结构化档案集合：`educations[]` / `experiences[]` / `skills[]`（CAP-AF-019）。
 *
 * ## 为什么单独一个模块，而不是往 `ApplyProfileDraft` 里塞
 *
 * `ApplyProfileDraft` 是 `Partial<Record<ApplyFieldKey, string>>`——扁平 11 键，
 * 且那 11 键是**后端契约的逐字对应**（见 `contracts.ts` 的 `APPLY_FIELD_KEYS` 头注）。
 * 结构化集合是另一个维度：一段经历有 6 个字段、一张表上可能出现 N 段。
 * 把它压进扁平键要么造 `experience0Company` 这种伪键、要么破坏那条契约对应，两者都不行。
 *
 * ## 上限（12/6/40）刻意**不**在这里定义
 *
 * 后端已实现账号级 confirmed 集合并强制上限：超限整条 400、集合为全量替换语义。
 * 本仓没有那份契约文档（v1.1 在后端仓），因此**无法核实哪个上限对应哪个集合**。
 * 抄一个猜出来的常量进这里，等于在 wire 邻接层制造第二个真相源——
 * 正是 `RULE-GLOBAL-AUTH-OWNERSHIP-CONTRACT` 的「不得手抄」要禁的事。
 *
 * 所以边界是：**形状与闭集在这里（它们已被逐字确定），数量上限归后端**。
 * 解析器对超出的条目按下面的「有界读」丢弃而不是抛错，这样即便后端将来调整上限，
 * 扩展侧也不会因为一个过期常量而拒收合法数据。
 *
 * ## 有界读纪律
 *
 * 设计原文：「unknown/oversized → `null`，never throw」。本模块照此实现——
 * 简历解析与后端回程都可能给出脏数据，一条坏记录不该让整轮填写失败。
 * 每个字段独立降级：`gpa` 太长只丢 `gpa`，不丢整段教育经历。
 *
 * ## 日期为什么不是 ISO 串
 *
 * 后端的 `ConfirmedDatePart` 是 `{year, month|null}` 而**不是** `YYYY-MM` 字符串。
 * 这个形状是被 Workday/Taleo 逼出来的：那两家把起止日期渲染成**月和年两个独立
 * `<select>`**，拿到 ISO 串还得再拆一次，而拆分点（"2024-03" vs "March 2024"
 * vs "03/2024"）在自由文本里并不可靠。年月分开存，写入期直接投射到两个控件。
 * `month` 可空是因为教育经历常常只给年份。
 */

/** 学位层级闭集。取自 AUTOFILL-DESIGN §5.2 B1 的 `@IsIn` 列表，逐字。 */
export const DEGREE_LEVELS = [
  'HIGH_SCHOOL',
  'ASSOCIATE',
  'BACHELOR',
  'MASTER',
  'MBA',
  'JD',
  'MD',
  'PHD',
  'OTHER',
] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];

/** 雇佣类型闭集。同上，逐字。 */
export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'INTERNSHIP',
  'CONTRACT',
  'FREELANCE',
  'VOLUNTEER',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * 年 + 可空月。**不是 ISO 串**——理由见文件头。
 *
 * `year` 取 1900–2100：低于 1900 的求职经历不存在，高于 2100 的是脏数据或占位符
 * （实测简历解析会把 "Present" 误判成 9999）。`month` 是 1–12，不是 0–11——
 * 这里存的是人读的月份，不是 `Date` 的内部表示；用 0 基会在写入期被静默错一格。
 */
export interface ConfirmedDatePart {
  readonly year: number;
  readonly month: number | null;
}

/** 一段教育经历。除 `school` 外全部可选——真实简历缺项很常见。 */
export interface ProfileEducation {
  readonly school: string;
  readonly degreeLevel: DegreeLevel | null;
  readonly fieldOfStudy: string | null;
  readonly startDate: ConfirmedDatePart | null;
  readonly endDate: ConfirmedDatePart | null;
  readonly location: string | null;
  /**
   * **字符串，不是数字。** 实测真实取值包含 `3.8/4.0`、`First Class Honours`、
   * `85/100`——把它当数字会在英联邦与百分制体系上整段丢失。
   */
  readonly gpa: string | null;
  readonly gpaScale: string | null;
  /** 在读。为真时 `endDate` 应为 null，但不强制——脏数据里两者并存很常见。 */
  readonly isCurrent: boolean;
  /**
   * 预计毕业时间（2026-10-01 argoland 交接）：档案的保存规则是在读（`isCurrent`）时 `endDate` 必须为空、毕业时间存在
   * 这里——门户手填的在读学生、资料页新加的「在读」勾选、简历上写「Expected May 2027」的导入，都这样存。申请表上的
   * 毕业时间在 `endDate` 为空时用它（`collectionProjection.ts`）。没有就不出现。
   */
  readonly expectedGraduationDate?: ConfirmedDatePart;
}

/**
 * 语言水平闭集：Profile V2 的四档（`PROFILE_V2_LANGUAGE_PROFICIENCIES`），逐字。定义在这里而不是 dict/languages.ts：
 * worker 的投影只要这张闭集，不该把判读语言题的那一整套（语言名表）一起打进 background。
 */
export const LANGUAGE_PROFICIENCIES = ['NATIVE_OR_BILINGUAL', 'PROFESSIONAL', 'CONVERSATIONAL', 'BASIC'] as const;
export type LanguageProficiency = (typeof LANGUAGE_PROFICIENCIES)[number];

/** 一条语言：语言名（他自己写的）与四档水平。只用来答语言题（dict/languages.ts），不按行填。 */
export interface ProfileLanguage {
  readonly language: string;
  readonly proficiency: LanguageProficiency;
}

/** 一段工作经历。除 `company` 外全部可选。 */
export interface ProfileExperience {
  readonly company: string;
  readonly title: string | null;
  readonly employmentType: EmploymentType | null;
  readonly startDate: ConfirmedDatePart | null;
  readonly endDate: ConfirmedDatePart | null;
  readonly location: string | null;
  readonly isCurrent: boolean;
}

/**
 * 三个集合，加上语言（2026-10-04）。字段可缺省，缺省与空数组语义相同（都表示"没有可填的"），
 * 因为后端是全量替换语义：省略与清空在写入面上没有区别。
 *
 * 语言不按行填进页面（没有「第 i 行的语言」这种角色），只用来答语言题（dict/languages.ts）：
 * 他确认过的语言与四档水平。
 */
export interface ApplyProfileCollections {
  readonly educations?: readonly ProfileEducation[];
  readonly experiences?: readonly ProfileExperience[];
  readonly skills?: readonly string[];
  readonly languages?: readonly ProfileLanguage[];
}

// ── 有界读 ──────────────────────────────────────────────────────────

/** 字段级长度上限。这些是**显示与写入**的合理上限，不是后端的集合数量上限。 */
const MAX_TEXT = 160;
const MAX_FIELD_OF_STUDY = 120;
/**
 * GPA 与 GPA 制式的长度上限。
 *
 * ⚠️ **设计原文自相矛盾，此处按真实取值取更大值。** AUTOFILL-DESIGN §5.2 B1 写
 * 「`gpa`（**string** ≤16 — "3.8/4.0", "First Class Honours", "85/100" all occur）」——
 * 但它自己举的 `First Class Honours` 是 **19 字符**，按 ≤16 会被自己的规范丢掉。
 * 本模块的测试用的正是原文那三个例子，写成 16 立刻红。
 *
 * 英联邦学位分类还有更长的：`Upper Second Class Honours`（26）、
 * `Second Class Honours, Upper Division`（36）。取 64 覆盖这一族，
 * 同时仍然挡住把整段成绩单塞进 GPA 栏的脏数据。
 *
 * 后端若按 ≤16 校验，超长值会在提交时被拒——那是后端的上限，
 * 由它自己报错，扩展侧不代为静默丢弃（丢弃反而让用户查不出为什么没填上）。
 */
const MAX_GPA = 64;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
/** 语言名的长度上限（与 Profile V2 一致的量级；更长的多半不是一个语言名）。 */
const MAX_LANGUAGE = 80;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function boundedMember<T extends string>(value: unknown, members: readonly T[]): T | null {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * 解析年月。整数才收——`2024.5` 这种既不是年也不是月，来源一定是脏数据。
 * 月缺失是合法的（教育经历常常只给年份），但**年缺失整条作废**：
 * 没有年份的日期在两个 `<select>` 上无从落笔。
 */
export function parseConfirmedDatePart(value: unknown): ConfirmedDatePart | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { year?: unknown; month?: unknown };
  const year = record.year;
  if (!Number.isInteger(year) || (year as number) < MIN_YEAR || (year as number) > MAX_YEAR) {
    return null;
  }
  const month = record.month;
  const validMonth =
    Number.isInteger(month) && (month as number) >= 1 && (month as number) <= 12
      ? (month as number)
      : null;
  return { year: year as number, month: validMonth };
}

/** 一段教育经历的有界读。`school` 读不出来整条丢弃——没有学校名的教育经历填不进任何表。 */
export function parseProfileEducation(value: unknown): ProfileEducation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const school = boundedText(record.school, MAX_TEXT);
  if (school === null) return null;
  return {
    school,
    degreeLevel: boundedMember(record.degreeLevel, DEGREE_LEVELS),
    fieldOfStudy: boundedText(record.fieldOfStudy, MAX_FIELD_OF_STUDY),
    startDate: parseConfirmedDatePart(record.startDate),
    endDate: parseConfirmedDatePart(record.endDate),
    location: boundedText(record.location, MAX_TEXT),
    gpa: boundedText(record.gpa, MAX_GPA),
    gpaScale: boundedText(record.gpaScale, MAX_GPA),
    isCurrent: record.isCurrent === true,
    ...expectedGraduation(record.expectedGraduationDate),
  };
}

function expectedGraduation(value: unknown): { expectedGraduationDate?: ConfirmedDatePart } {
  const date = parseConfirmedDatePart(value);
  return date === null ? {} : { expectedGraduationDate: date };
}

/** 一段工作经历的有界读。`company` 读不出来整条丢弃。 */
export function parseProfileExperience(value: unknown): ProfileExperience | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const company = boundedText(record.company, MAX_TEXT);
  if (company === null) return null;
  return {
    company,
    title: boundedText(record.title, MAX_TEXT),
    employmentType: boundedMember(record.employmentType, EMPLOYMENT_TYPES),
    startDate: parseConfirmedDatePart(record.startDate),
    endDate: parseConfirmedDatePart(record.endDate),
    location: boundedText(record.location, MAX_TEXT),
    isCurrent: record.isCurrent === true,
  };
}

/** 一条语言的有界读：语言名或水平读不出来整条丢弃。 */
export function parseProfileLanguage(value: unknown): ProfileLanguage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const language = boundedText(record.language, MAX_LANGUAGE);
  const proficiency = boundedMember(record.proficiency, LANGUAGE_PROFICIENCIES);
  return language === null || proficiency === null ? null : { language, proficiency };
}

/**
 * 整组集合的有界读：坏条目单独丢弃，好条目照常保留。
 *
 * 这条纪律是被真实数据逼出来的：结构化简历解析对三段经历里的一段给出脏数据，
 * 不该让另外两段也填不进去。「整组作废」在填表场景里永远是错的取舍——
 * 用户宁可少填一段，也不愿一段都没填还得自己排查为什么。
 */
export function parseApplyProfileCollections(value: unknown): ApplyProfileCollections {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const educations = Array.isArray(record.educations)
    ? record.educations.map(parseProfileEducation).filter((entry): entry is ProfileEducation => entry !== null)
    : [];
  const experiences = Array.isArray(record.experiences)
    ? record.experiences.map(parseProfileExperience).filter((entry): entry is ProfileExperience => entry !== null)
    : [];
  const skills = Array.isArray(record.skills)
    ? record.skills.map((entry) => boundedText(entry, MAX_TEXT)).filter((entry): entry is string => entry !== null)
    : [];
  const languages = Array.isArray(record.languages)
    ? record.languages.map(parseProfileLanguage).filter((entry): entry is ProfileLanguage => entry !== null)
    : [];
  const collections: {
    educations?: readonly ProfileEducation[];
    experiences?: readonly ProfileExperience[];
    skills?: readonly string[];
    languages?: readonly ProfileLanguage[];
  } = {};
  if (educations.length > 0) collections.educations = educations;
  if (experiences.length > 0) collections.experiences = experiences;
  if (skills.length > 0) collections.skills = skills;
  if (languages.length > 0) collections.languages = languages;
  return collections;
}
