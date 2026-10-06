/**
 * 下拉选项的**纯判定层**：候选值阶梯匹配 + 选项集稳定性。
 *
 * 抽出来的理由和 `write/setValue.ts` 的 `resolveSelectOption` 是同一条
 * （CAP-AF-044「计划期与写入期同源」）：预览里说"将会选中哪一项"和写入时真正
 * 选的必须是同一套判决，否则预览就是另一个谎言。这里额外承担 CAP-AF-004 的两件
 * `click/combobox.ts` 原来没有的事：**有序候选值**与**稳定性闸门**。
 *
 * 本文件不碰 DOM、不计时、不发事件（`RULE-KERNEL-DETERMINISTIC-BOUNDARY`）。
 * 轮询宏任务、点击、读回仍然是 `combobox.ts` 与 Extension adapter 的事；
 * 这里只回答"看到这批文案，该怎么判"。
 *
 * ── 为什么需要稳定性闸门（这是本次新增的核心） ──
 *
 * 原实现轮询到"出现了至少一个选项"就立刻匹配。真实下拉的选项是**分批异步**填进
 * 来的（`combobox.ts` 头部实测：同一 tick 0 个，一个宏任务后 244 个），于是存在
 * 一个静默错选窗口：
 *
 *   列表加载到第 50 项时，"United States" 是**唯一**命中 → 判定成功、点中；
 *   第 200 项 "United States Virgin Islands" 随后才加载出来 —— 那本该是
 *   `AMBIGUOUS_OPTION`，该把这个字段交还给用户。
 *
 * 这个例子不是我编的，它就写在 `combobox.ts` 阶梯第 4 级的注释里，作为"多条命中
 * →AMBIGUOUS 正是我们要的"的说明。它成立的前提是**列表已经完整**。
 * 在申请表上选错一个国家，用户看不见（下拉是收起的），比留空糟得多。
 *
 * 所以判定**必须等选项集连续两次观测一致**才作数——包括成功的那一次。
 * 只对失败设闸门是不够的：错误的成功才是这里真正的风险。
 *
 * ── 为什么需要有序候选值 ──
 *
 * 同一个语义在不同租户的选项文案里可能根本不存在。2026-08-21 实测（§F.5-f）：
 * 竞品对 "How Did You Hear About Us?" 携带 12 个有序候选，先试 "Jobright"
 * （宿主选项里没有）→ 退到 "LinkedIn" → 命中。只带单值的实现在这里直接失败。
 * 候选顺序即偏好顺序，第一个唯一命中的即采用。
 */

import { normalizeComparableValue } from '../write/verify';
import type { ComboboxOptionHarvest } from '../contracts';

/** Shared input ceilings used by preview, plan sealing and write revalidation. */
export const MAX_COMBOBOX_HARVEST_OPTIONS = 1_024;
export const MAX_COMBOBOX_CANDIDATES = 64;
export const MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS = 512;
export const MAX_COMBOBOX_OPTION_TEXT_TOTAL_CODE_UNITS = 128 * 1_024;
/** JSON may encode one control-code unit as a six-character `\\u00xx` escape. */
export const MAX_COMBOBOX_OPTION_SIGNATURE_CODE_UNITS =
  MAX_COMBOBOX_OPTION_TEXT_TOTAL_CODE_UNITS * 6 + MAX_COMBOBOX_HARVEST_OPTIONS * 3 + 2;

export function isBoundedComboboxCandidates(input: unknown): input is readonly string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_COMBOBOX_CANDIDATES) {
    return false;
  }
  return input.every(
    (candidate) =>
      typeof candidate === 'string' &&
      candidate.trim() !== '' &&
      candidate.length <= MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS,
  );
}

export function isBoundedComboboxOptionTexts(input: unknown): input is readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_COMBOBOX_HARVEST_OPTIONS
  ) return false;
  let totalCodeUnits = 0;
  for (const text of input) {
    if (typeof text !== 'string' || text.length > MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS) {
      return false;
    }
    totalCodeUnits += text.length;
    if (totalCodeUnits > MAX_COMBOBOX_OPTION_TEXT_TOTAL_CODE_UNITS) return false;
  }
  return true;
}

export function isBoundedComboboxHarvest(input: unknown): input is ComboboxOptionHarvest {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const value = input as Partial<ComboboxOptionHarvest>;
    return (
      isBoundedComboboxCandidates(value.candidates) &&
      isBoundedComboboxOptionTexts(value.optionTexts) &&
      typeof value.optionSetSignature === 'string' &&
      value.optionSetSignature.length <= MAX_COMBOBOX_OPTION_SIGNATURE_CODE_UNITS &&
      typeof value.resolvedOptionText === 'string' &&
      value.resolvedOptionText.length <= MAX_COMBOBOX_OPTION_TEXT_CODE_UNITS
    );
  } catch {
    return false;
  }
}

/** 电话区号后缀。实测："United States +1" 是选项原文，"+1" 才是选中后的显示值。 */
/** 「United States +1」里的尾部区号。带旗标的国家选择器选中后常常只显示这一截。 */
export const CALLING_CODE_SUFFIX = /\s*\+\d{1,4}\s*$/;

/**
 * 选项集必须连续观测到相同签名的次数。
 *
 * 2 次而不是 1 次：1 次等于没有闸门（任何一次观测都"和自己相等"）。
 * **但次数本身远远不够**——见下面的静默期。
 */
export const OPTION_SET_STABLE_OBSERVATIONS = 2;

/**
 * 选项集必须**保持不变**的墙钟时长（毫秒）。这才是闸门的主体。
 *
 * 为什么只数次数不行（2026-08-21 接线测试实测出来的）：轮询走的是宏任务，
 * 相邻两次观测相距近乎 0ms。于是"连续看到两次一样"可以在 1ms 内达成，而下一批
 * 选项 4ms 后才到——闸门形同虚设，仍然在半加载的列表上下了判决。
 * 需要的信号是"列表**不再增长**了"，那本质上是时间量，不是次数量。
 *
 * 64ms ≈ 4 个动画帧，覆盖 React 跨帧分批渲染并留有余量。
 *
 * ⚠️ 诚实标注：`combobox.ts` 头部那条实测（Greenhouse `#country`）是**单批**
 * 到位的——244 个选项在一个宏任务后一次出现。多批分次加载是**尚未实测**的形态，
 * 本闸门为它而设。设它的理由不是"我们见过"，而是阶梯有优先级：低阶命中在半加载
 * 列表上会抢在高阶命中之前成立，且错得静默。代价是每个下拉多 64ms。
 */
export const OPTION_SET_QUIET_MS = 64;

/** 选项集指纹。仅用于判断"这批文案和上次是不是同一批"，不参与匹配。 */
export type OptionSetSignature = string & { readonly __brand: 'OptionSetSignature' };

/**
 * 顺序敏感的指纹。**不排序**：选项顺序变化本身就说明列表还在动
 * （虚拟滚动、异步分批、搜索框过滤都会改变顺序），那正是我们要检测的。
 */
export function optionSetSignature(optionTexts: readonly string[]): OptionSetSignature {
  // A delimiter-based signature is not injective: for example
  // ['Alpha Beta', 'Gamma'] and ['Alpha', 'Beta Gamma'] both collapse to the
  // same joined string. JSON's array framing and per-item escaping preserve
  // both boundaries and order without introducing a second parser.
  return JSON.stringify(optionTexts) as OptionSetSignature;
}

/** 稳定性观测状态。由调用方在轮询循环里持有并原样传回。 */
export interface OptionSetWatch {
  readonly signature: OptionSetSignature | null;
  readonly consecutive: number;
  /** 当前签名**第一次**被观测到的时刻，由调用方提供的时钟。 */
  readonly sinceMs: number | null;
}

export const INITIAL_OPTION_SET_WATCH: OptionSetWatch = {
  signature: null,
  consecutive: 0,
  sinceMs: null,
};

export interface OptionSetObservation {
  readonly watch: OptionSetWatch;
  /** 只有 true 时才允许调用 `resolveOptionCandidate` 并采信其结果。 */
  readonly settled: boolean;
}

/**
 * 记一次观测。签名与上次相同则计数 +1，不同则重置为 1（这一次仍然算一次观测）。
 *
 * 空列表永不 settle：空可能是"还没加载"，也可能是"搜索词过滤掉了全部"，
 * 通用层分不出来。分不出来就不判定——由调用方的预算超时收口成 `WIDGET_TIMEOUT`，
 * 而不是在这里假装得出了 `NO_OPTION_MATCH`。
 */
export function observeOptionSet(
  watch: OptionSetWatch,
  optionTexts: readonly string[],
  /** 调用方提供的单调时钟读数（毫秒）。kernel 自己不取时间。 */
  nowMs: number,
): OptionSetObservation {
  if (optionTexts.length === 0) {
    return { watch: INITIAL_OPTION_SET_WATCH, settled: false };
  }
  const signature = optionSetSignature(optionTexts);
  const same = watch.signature === signature && watch.sinceMs !== null;
  const consecutive = same ? watch.consecutive + 1 : 1;
  const sinceMs = same ? (watch.sinceMs as number) : nowMs;
  return {
    watch: { signature, consecutive, sinceMs },
    settled: consecutive >= OPTION_SET_STABLE_OBSERVATIONS && nowMs - sinceMs >= OPTION_SET_QUIET_MS,
  };
}

export type CandidateResolution =
  | {
      readonly kind: 'MATCH';
      /** 命中的是第几个候选值。用于诊断与审计，不参与写入。 */
      readonly candidateIndex: number;
      readonly optionIndex: number;
    }
  | { readonly kind: 'NO_OPTION_MATCH' }
  | { readonly kind: 'AMBIGUOUS_OPTION'; readonly candidateIndex: number };

/**
 * 单个候选值的阶梯匹配。每一级都要求**唯一**命中才算数；命中多条立刻停手，
 * 不再往下一级退——在申请表上猜错一项，比留给用户手选糟得多。
 *
 * 从 `combobox.ts` 原地抽出，语义逐条保持不变，只是改成对文案数组求下标。
 */
function matchOneCandidate(
  desired: string,
  optionTexts: readonly string[],
): { readonly kind: 'MATCH'; readonly optionIndex: number } | 'NO_OPTION_MATCH' | 'AMBIGUOUS_OPTION' {
  const wanted = desired.trim();
  if (wanted === '') return 'NO_OPTION_MATCH';
  const wantedNormal = normalizeComparableValue(wanted);

  const rungs: ((text: string) => boolean)[] = [
    // 1. 原文相等（忽略大小写与首尾空白）
    (text) => text.trim().toLowerCase() === wanted.toLowerCase(),
    // 2. 仅格式差异（标点、符号、空白）后相等
    (text) => normalizeComparableValue(text) === wantedNormal,
    // 3. 去掉尾部区号后相等——"United States +1" 命中 "United States"
    (text) => normalizeComparableValue(text.replace(CALLING_CODE_SUFFIX, '')) === wantedNormal,
    // 4. 词边界前缀。要求下一个字符不是字母/数字，避免命中某个以它开头的更长的
    //    **单词**；但 "United States Virgin Islands" 这类真前缀会命中，于是走到
    //    "多条命中→AMBIGUOUS"，正是我们要的——前提是列表已经完整，见文件头。
    (text) => {
      const stripped = text.replace(CALLING_CODE_SUFFIX, '').trim();
      if (!stripped.toLowerCase().startsWith(wanted.toLowerCase())) return false;
      const next = stripped.charAt(wanted.length);
      return next === '' || !/[\p{L}\p{N}]/u.test(next);
    },
  ];

  for (const matches of rungs) {
    const hits = optionTexts.flatMap((text, index) => (matches(text) ? [index] : []));
    if (hits.length === 1) return { kind: 'MATCH', optionIndex: hits[0] as number };
    if (hits.length > 1) return 'AMBIGUOUS_OPTION';
  }
  return 'NO_OPTION_MATCH';
}

/**
 * 按候选顺序逐个尝试，第一个**唯一命中**的即采用。
 *
 * 歧义不跳过：某个候选走到 `AMBIGUOUS_OPTION` 时立刻停止整轮，不去试下一个候选。
 * 理由——歧义说明"用户想要的这个语义在宿主选项里有多种解释"，此时换一个候选去碰
 * 运气，等于用一个我们更不确定的值覆盖一个我们已知有歧义的位置。停手交还用户。
 */
export function resolveOptionCandidate(
  candidates: readonly string[],
  optionTexts: readonly string[],
): CandidateResolution {
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const outcome = matchOneCandidate(candidates[candidateIndex] as string, optionTexts);
    if (outcome === 'AMBIGUOUS_OPTION') return { kind: 'AMBIGUOUS_OPTION', candidateIndex };
    if (outcome !== 'NO_OPTION_MATCH') {
      return { kind: 'MATCH', candidateIndex, optionIndex: outcome.optionIndex };
    }
  }
  return { kind: 'NO_OPTION_MATCH' };
}
