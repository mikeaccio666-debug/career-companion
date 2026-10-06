/**
 * 结构化档案 → 引擎字段值的投影层（CAP-AF-020）。
 *
 * ## 它解决的是哪一个具体问题
 *
 * 扫描侧早就有「行标识 + 行内序号」的字段身份（`FieldIdentityScope.scopeKey`
 * 形如 `row·<规则序>:<容器序>:<行序>`），档案侧却没有对应物：
 * `ApplyProfileDraft` 是扁平 11 键，回答不了「把**第 2 段**经历填进页面**第 2 组**控件」。
 *
 * 没有这一层，只剩两条都违规的路：把厂商知识写进档案层，或把档案知识写进适配器——
 * 两条都破 `RULE-KERNEL-RULE-DATA-SEPARATION`。本模块就是那个中间层。
 *
 * ## 边界：谁知道什么
 *
 *  · **规则数据（apply-rules JSON）** 知道「页面这一栏是第几段经历的公司名」——
 *    它把控件映射到下面的 `CollectionFieldRole`。厂商知识只住在那里。
 *  · **本模块** 知道「第 2 段经历的公司名是什么字符串」。它不认识任何选择器、
 *    不认识任何厂商，只做 `(集合, 角色, 行序) → 候选值`。
 *  · **写入层** 知道怎么把候选值落到具体控件上。
 *
 * ## 月份为什么产出**有序候选**而不是一个字符串
 *
 * 同一个「三月」，Greenhouse 的 `<select>` 里是 `March`，Workday 是 `03`，
 * 还有厂商用 `Mar` 或 `3`。把某一种写死在 kernel 里就是把厂商知识搬进了 kernel。
 *
 * 所以这里产出**按偏好排序的候选序列**，交给 `click/optionSearch.ts` 的阶梯匹配
 * （CAP-AF-004 已建好）去挑宿主真正有的那一个——机制现成，且天然覆盖我们没见过的写法。
 * 纯文本框取第一个候选。
 *
 * 顺序是有理由的：数字形态（`3`）在自由文本框里最安全，英文月名在 `<select>` 里
 * 最常见，两位补零形态（`03`）是 Workday 实测形态。把最不容易出错的放前面，
 * 因为文本框拿的就是第一个。
 */

import { dateCandidatesForShape, type DateInputShape } from './dateFormat.ts';
import type { ApplyProfileCollections, ConfirmedDatePart } from './profileCollections.ts';

/**
 * 投影角色闭集：规则数据用它指认「页面这一栏对应结构化档案的哪一格」。
 *
 * 闭集而不是自由字符串，理由与仓里其它闭集一致：规则包是**下发数据**，
 * 认不得的角色必须整条拒收而不是猜——猜错的后果是把公司名写进学校栏。
 */
export const COLLECTION_FIELD_ROLES = [
  'education.school',
  'education.degreeLevel',
  'education.fieldOfStudy',
  'education.location',
  'education.gpa',
  'education.gpaScale',
  // 整段日期与年/月分栏是**两种真实形状**，不是同一件事的两种写法：
  // Workable 的 start_date 是一个纯文本框（要 `2021-06`），
  // Workday/Taleo 是月和年两个独立 <select>（各要 `June` 与 `2021`）。
  // 一份规则按自己那一家的形状选角色。
  'education.startDate',
  'education.endDate',
  'education.startYear',
  'education.startMonth',
  'education.endYear',
  'education.endMonth',
  'experience.company',
  'experience.title',
  'experience.employmentType',
  'experience.location',
  'experience.startDate',
  'experience.endDate',
  'experience.startYear',
  'experience.startMonth',
  'experience.endYear',
  'experience.endMonth',
  // 在职与否（2026-09-24，Workday 的「I currently work here」勾选框）。它不是一个要写进去的字符串，
  // 是一个事实：engine 按 `isCurrentRow` 决定勾不勾，投影层对它不给候选值。规则只能在 keySteps 里
  // 指到它——旧版插件的解析器对不认识的角色是跳过；放进 rowScopes 的 fieldMap 会整份拒收。
  // （2026-09-28 起的内核在 fieldMap 里也只跳过那一格；在那之前构建的包——含商店 1.0.0——仍整份拒收。）
  'experience.isCurrent',
  'skills.all',
] as const;
export type CollectionFieldRole = (typeof COLLECTION_FIELD_ROLES)[number];

export function isCollectionFieldRole(value: unknown): value is CollectionFieldRole {
  return typeof value === 'string' && (COLLECTION_FIELD_ROLES as readonly string[]).includes(value);
}

/**
 * 起止日期的年／月分段角色（`experience.startMonth`、`education.endYear`……）。分段日期的写法
 * （write/setValue.ts 的 `writeDateSegment`）与「缺月份就整组不写」（engine）都只对这一类生效：
 * 角色只能由规则数据给出，于是这两条放宽都锁在规则量过的控件上。
 */
export function isDatePartRole(value: unknown): value is CollectionFieldRole {
  return isCollectionFieldRole(value) && /\.(?:start|end)(?:Year|Month)$/.test(value);
}

/** 同一个日期的另一段：年 ↔ 月。 */
export function siblingDatePartRole(role: CollectionFieldRole): CollectionFieldRole | null {
  const sibling = role.endsWith('Year') ? role.replace(/Year$/, 'Month') : role.replace(/Month$/, 'Year');
  return isDatePartRole(sibling) ? sibling : null;
}

/**
 * 英文月名。**这不是厂商知识**——它是公历月份的英文写法，与任何 ATS 无关；
 * 厂商差异体现在「用哪一种写法」，而那个选择由宿主的选项集在写入期决定。
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * 一个月份的候选序列，按「文本框最安全 → 下拉最常见」排序。
 *
 * 例：3 → `['3', 'March', '03', 'Mar']`
 *
 * 纯文本框取首项 `3`；`<select>` 由阶梯匹配挑宿主真正有的那个。
 * 补零形态排在英文月名之后，因为它只在 Workday 一类里出现，而 `March` 覆盖面更广。
 */
export function monthCandidates(month: number): readonly string[] {
  const name = MONTH_NAMES[month - 1];
  if (name === undefined) return [];
  return [String(month), name, String(month).padStart(2, '0'), name.slice(0, 3)];
}

/** 年份没有形态差异，单候选。 */
function yearCandidates(part: ConfirmedDatePart | null): readonly string[] {
  return part === null ? [] : [String(part.year)];
}

function monthOf(part: ConfirmedDatePart | null): readonly string[] {
  return part === null || part.month === null ? [] : monthCandidates(part.month);
}

function textOf(value: string | null): readonly string[] {
  return value === null ? [] : [value];
}

/**
 * 学位层级的候选：先给闭集码本身，再给人读的写法。
 *
 * 宿主的下拉里几乎不会出现 `BACHELOR` 这种码，但**我们自己的 UI 可能会**；
 * 把码放首位保证纯文本回填时不丢信息，人读写法交给阶梯匹配去命中宿主选项。
 * 与月份同一套思路：kernel 只列可能的写法，选哪个由宿主的选项集决定。
 */
const DEGREE_LEVEL_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  HIGH_SCHOOL: ['High School', 'High School Diploma', 'Secondary'],
  ASSOCIATE: ["Associate", "Associate's Degree", 'Associates'],
  BACHELOR: ["Bachelor's Degree", 'Bachelor', 'Bachelors', 'BS', 'BA'],
  MASTER: ["Master's Degree", 'Master', 'Masters', 'MS', 'MA'],
  // MBA 就是一个硕士学位：名单里没有单列 MBA 时（Workday adobe.wd5 的学位下拉是 GED / High School /
  // Associates / Bachelors / Masters / Doctorate / JD，2026-09-24 只读实测），落到硕士那一项；有 MBA
  // 那一项时它排在最前、先命中。
  MBA: ['MBA', 'Master of Business Administration', "Master's Degree", 'Masters', 'Master'],
  JD: ['JD', 'Juris Doctor'],
  MD: ['MD', 'Doctor of Medicine'],
  PHD: ['PhD', 'Ph.D.', 'Doctorate', 'Doctoral Degree'],
  OTHER: ['Other'],
};

const EMPLOYMENT_TYPE_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  FULL_TIME: ['Full-time', 'Full time', 'Fulltime'],
  PART_TIME: ['Part-time', 'Part time', 'Parttime'],
  INTERNSHIP: ['Internship', 'Intern'],
  CONTRACT: ['Contract', 'Contractor'],
  FREELANCE: ['Freelance', 'Self-employed'],
  VOLUNTEER: ['Volunteer', 'Voluntary'],
};

function enumCandidates(
  code: string | null,
  spellings: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  if (code === null) return [];
  return [code, ...(spellings[code] ?? [])];
}

/**
 * 投影：`(集合, 角色, 行序) → 有序候选`。
 *
 * `rowIndex` 是**页面上的行序**（0 基），直接对应档案集合的下标——
 * 「页面第 2 组控件」拿「第 2 段经历」。行序超出集合长度时返回空数组
 * （页面比档案多一组是常态：宿主预渲染三组空行、用户只有两段经历）。
 *
 * 返回空数组而不是抛错：整轮填写不该因为一栏没数据而中止，
 * 调用方按既有的 `NO_VALUE` 语义处理。
 */
export function projectCollectionField(
  collections: ApplyProfileCollections,
  role: CollectionFieldRole,
  rowIndex: number,
  /**
   * 目标控件的日期形态，只对 `*.startDate` / `*.endDate` 两类角色有意义。
   *
   * 为什么是参数而不是猜：`<input type="date">` 只接受 `YYYY-MM-DD`、
   * `type="month"` 只接受 `YYYY-MM`，写错的后果是**静默不生效**——赋值被浏览器
   * 丢弃、读回来是空串。这是 HTML 规范，不是某一家 ATS 的偏好，所以形态必须
   * 来自那一个控件本身，由调用方（engine，它手里有 element）读出来传进来。
   *
   * 缺省 `'text'` 与 HTML 规范下浏览器对未知 type 的处理一致。
   */
  shape: DateInputShape = 'text',
): readonly string[] {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) return [];

  if (role === 'skills.all') {
    const skills = collections.skills ?? [];
    // 技能栏在多数表单上是一个自由文本框或标签输入；逗号分隔是最通用的写法。
    // 单项形态由多选标签控件自己迭代（CAP-AF-004 的多选原语），不在本层展开。
    return skills.length === 0 ? [] : [skills.join(', ')];
  }

  if (role.startsWith('education.')) {
    const entry = (collections.educations ?? [])[rowIndex];
    if (entry === undefined) return [];
    // 毕业时间（2026-10-01 argoland 交接）：在读学生的 `endDate` 按保存规则必须为空，毕业时间在预计毕业时间里；
    // 不回退的话申请表上的毕业时间（Workday 的「To (Actual or Expected)」等）会空着。
    const graduation = entry.endDate ?? entry.expectedGraduationDate ?? null;
    switch (role) {
      case 'education.school': return [entry.school];
      case 'education.degreeLevel': return enumCandidates(entry.degreeLevel, DEGREE_LEVEL_SPELLINGS);
      case 'education.fieldOfStudy': return textOf(entry.fieldOfStudy);
      case 'education.location': return textOf(entry.location);
      case 'education.gpa': return textOf(entry.gpa);
      case 'education.gpaScale': return textOf(entry.gpaScale);
      case 'education.startDate': return dateCandidatesForShape(entry.startDate, shape);
      case 'education.endDate': return dateCandidatesForShape(graduation, shape);
      case 'education.startYear': return yearCandidates(entry.startDate);
      case 'education.startMonth': return monthOf(entry.startDate);
      case 'education.endYear': return yearCandidates(graduation);
      case 'education.endMonth': return monthOf(graduation);
      default: return [];
    }
  }

  const entry = (collections.experiences ?? [])[rowIndex];
  if (entry === undefined) return [];
  // 在职的那一段没有结束日期（2026-09-24）。脏数据里「在职」与结束日期常常并存；表单上两者是互斥的
  // （Workday 勾上 I currently work here 之后 To 那一栏就不要了），写一个结束日期等于替他说已经离职。
  if (entry.isCurrent && (role === 'experience.endDate' || role === 'experience.endYear' || role === 'experience.endMonth')) {
    return [];
  }
  switch (role) {
    case 'experience.company': return [entry.company];
    case 'experience.title': return textOf(entry.title);
    case 'experience.employmentType': return enumCandidates(entry.employmentType, EMPLOYMENT_TYPE_SPELLINGS);
    case 'experience.location': return textOf(entry.location);
      case 'experience.startDate': return dateCandidatesForShape(entry.startDate, shape);
      case 'experience.endDate': return dateCandidatesForShape(entry.endDate, shape);
      case 'experience.startYear': return yearCandidates(entry.startDate);
    case 'experience.startMonth': return monthOf(entry.startDate);
    case 'experience.endYear': return yearCandidates(entry.endDate);
    case 'experience.endMonth': return monthOf(entry.endDate);
    default: return [];
  }
}

/**
 * 这一行是不是「至今」。
 *
 * 单独一个函数而不是一个角色，因为它驱动的是**控件之间的联动**（勾上 present
 * 之后宿主会禁用结束日期），不是往某一栏写字符串。联动编排属 CAP-AF-055，
 * 这里只提供事实。
 */
export function isCurrentRow(
  collections: ApplyProfileCollections,
  kind: 'education' | 'experience',
  rowIndex: number,
): boolean {
  const list = kind === 'education' ? collections.educations : collections.experiences;
  return (list ?? [])[rowIndex]?.isCurrent === true;
}

/** 某一类集合在档案里有几段——供调用方决定要不要「加一行」（增删行编排属 CAP-AF-003）。 */
export function collectionRowCount(
  collections: ApplyProfileCollections,
  kind: 'education' | 'experience' | 'skills',
): number {
  if (kind === 'education') return (collections.educations ?? []).length;
  if (kind === 'experience') return (collections.experiences ?? []).length;
  return (collections.skills ?? []).length;
}
