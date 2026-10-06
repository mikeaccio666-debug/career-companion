import type { ApplyFieldKey } from '../contracts';

/**
 * 扁平档案键里那几个**闭集值**在申请表上的人读写法（P1-5，2026-09-21）。
 *
 * 档案里存的是码（'YEAR'、'true'、'REMOTE'），申请表上的下拉写的是 "Annual"、"Yes"、
 * "Remote"。`resolveSelectOption` 只做 value 精确 → 文本精确 → 文本前缀三档匹配，
 * 从不猜——所以要把码展开成一串候选，按序去撞宿主真有的选项，第一个能落下的胜出。
 *
 * 只列**同义**的写法，不列近义：'Annual' 与 'Per year' 是同一件事，'Negotiable' 不是。
 * 一个错的候选落下去，用户在折叠的下拉里看不出来。
 */
const CHOICE_LABELS: Partial<Record<ApplyFieldKey, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  expectedSalaryPeriod: {
    YEAR: ['Annual', 'Annually', 'Per year', 'Yearly', 'Year', 'Per annum', 'Salary'],
    MONTH: ['Monthly', 'Per month', 'Month'],
    HOUR: ['Hourly', 'Per hour', 'Hour'],
  },
  over18: { true: ['Yes'], false: ['No'] },
  openToRelocation: { true: ['Yes'], false: ['No'] },
  preferredWorkModes: {
    REMOTE: ['Remote', 'Fully remote', 'Work from home'],
    HYBRID: ['Hybrid'],
    ONSITE: ['On-site', 'Onsite', 'On site', 'In office', 'In-office', 'In person', 'In-person'],
  },
});

const LIST_KEYS: ReadonlySet<ApplyFieldKey> = new Set<ApplyFieldKey>(['preferredWorkModes']);

/**
 * 代词（2026-09-23 Rippling 实测 AMBIGUOUS_OPTION）：门户存「He/Him」，而 Rippling 的下拉同时有
 * 「He/him/his」与「He/him/his, they/them/theirs」。短码按词边界前缀两条都中，候选阶梯又把歧义当终局，
 * 所以**完整写法必须排在短码前面**，靠原文相等唯一落下；只写「He/Him」的下拉由后面的短写法一次命中。
 * 键按小写、斜杠两侧去空格查，存值的大小写与空格不影响。只作用于有选项的控件。
 */
const PRONOUN_LABELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'he/him': ['He/him/his', 'He/Him'],
  'she/her': ['She/her/hers', 'She/Her'],
  'they/them': ['They/them/theirs', 'They/Them'],
  'prefer not to say': ['Prefer not to say', 'Prefer not to answer', 'I prefer not to say', 'I prefer not to answer', 'Decline to state'],
});

function pronounCandidates(value: string, control: 'options' | 'text'): readonly string[] {
  // 自由文本框照写用户自己的写法：没有选项要撞，扩写成三段式等于替他改措辞。
  if (control === 'text') return [value];
  const labels = PRONOUN_LABELS[value.trim().toLowerCase().replace(/\s*\/\s*/g, '/')];
  if (labels === undefined) return [value];
  return labels.some((label) => label.toLowerCase() === value.trim().toLowerCase()) ? labels : [...labels, value];
}

/**
 * 一个扁平值的全部候选。
 *
 * · 有选项集的控件（select / combobox）：码在前、人读写法在后——码最精确，
 *   而且 Greenhouse 那类把 value 写成码的表用它一次就中。
 * · 自由文本框：人读写法在前——文本框只取候选首项，把 'YEAR' 写进用户的申请表
 *   是错的（与集合字段的 `demoteEnumCodes` 同一条道理）。
 * · 集合值（'REMOTE,HYBRID'）逐项展开，保持档案里的顺序：单选下拉落第一项。
 * · 没有登记的键原样一个候选，行为与从前逐字相同。
 */
export function flatValueCandidates(
  key: ApplyFieldKey,
  value: string,
  control: 'options' | 'text',
): readonly string[] {
  if (key === 'preferredPronouns') return pronounCandidates(value, control);
  const table = CHOICE_LABELS[key];
  if (table === undefined) return [value];
  const codes = LIST_KEYS.has(key) ? value.split(',').map((item) => item.trim()).filter(Boolean) : [value];
  const out: string[] = [];
  for (const code of codes) {
    const labels = table[code] ?? [];
    const ordered = control === 'text' ? [...labels, code] : [code, ...labels];
    for (const candidate of ordered) if (!out.includes(candidate)) out.push(candidate);
  }
  return out.length === 0 ? [value] : out;
}
