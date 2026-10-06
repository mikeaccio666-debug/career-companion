import { describe, expect, it } from 'vitest';

import {
  INITIAL_OPTION_SET_WATCH,
  OPTION_SET_QUIET_MS,
  OPTION_SET_STABLE_OBSERVATIONS,
  observeOptionSet,
  optionSetSignature,
  resolveOptionCandidate,
} from '../src/click/optionSearch';

/**
 * CAP-AF-004 的两条新语义：**选项集稳定性闸门**与**有序候选值**。
 *
 * 第一条是这个文件存在的主要理由。它挡的不是"匹配不到"，而是**错误的匹配成功**：
 * 下拉选项是分批异步填进来的，在列表只加载了一半时，一个前缀候选可以是"唯一命中"，
 * 而列表完整后本该是 `AMBIGUOUS_OPTION`。下拉是收起的，用户看不见我们选错了。
 *
 * 这个失效模式不是假想的——`click/combobox.ts` 阶梯第 4 级的注释本身就用
 * "United States" / "United States Virgin Islands" 举例说明"多条命中→AMBIGUOUS
 * 正是我们要的"，而那句话只有在列表已完整时才成立。下面第一组测试就是它。
 */

/** 真实 Greenhouse 国家下拉的分批形态：先来一批，后来的那批里才有真前缀。 */
const PARTIAL_COUNTRY_OPTIONS = ['Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States'];
const COMPLETE_COUNTRY_OPTIONS = [
  ...PARTIAL_COUNTRY_OPTIONS,
  'United States Minor Outlying Islands',
  'United States Virgin Islands',
];

describe('选项集稳定性闸门', () => {
  it('半加载的列表不得 settle —— 这是"错误的成功"的唯一防线', () => {
    // 只观测到一次，无论内容如何都不作数。
    const first = observeOptionSet(INITIAL_OPTION_SET_WATCH, PARTIAL_COUNTRY_OPTIONS, 0);
    expect(first.settled).toBe(false);

    // 第二次观测到的是**不同**的列表（又加载进来两项）——计数必须重置，
    // 不能因为"已经看过两次了"就放行。
    const second = observeOptionSet(first.watch, COMPLETE_COUNTRY_OPTIONS, 0);
    expect(second.settled).toBe(false);
    expect(second.watch.consecutive).toBe(1);
  });

  it('只数次数不够：宏任务间隔近乎 0ms，两次观测可以在 1ms 内达成', () => {
    // 这条是 2026-08-21 接线测试实测出来的失效：纯函数层"连续两次"全绿，
    // 真实路径仍然在半加载列表上下了判决。次数不是时间。
    const first = observeOptionSet(INITIAL_OPTION_SET_WATCH, COMPLETE_COUNTRY_OPTIONS, 0);
    const second = observeOptionSet(first.watch, COMPLETE_COUNTRY_OPTIONS, 1);
    expect(second.watch.consecutive).toBe(OPTION_SET_STABLE_OBSERVATIONS);
    expect(second.settled, '次数已达标但静默期未满，必须仍不 settle').toBe(false);
  });

  it('次数达标 且 静默期满，才 settle', () => {
    const first = observeOptionSet(INITIAL_OPTION_SET_WATCH, COMPLETE_COUNTRY_OPTIONS, 0);
    const justShort = observeOptionSet(first.watch, COMPLETE_COUNTRY_OPTIONS, OPTION_SET_QUIET_MS - 1);
    expect(justShort.settled).toBe(false);

    const settled = observeOptionSet(justShort.watch, COMPLETE_COUNTRY_OPTIONS, OPTION_SET_QUIET_MS);
    expect(settled.settled).toBe(true);
  });

  it('静默期从"该签名第一次出现"起算，不因中途多观测几次而重置', () => {
    let watch = observeOptionSet(INITIAL_OPTION_SET_WATCH, COMPLETE_COUNTRY_OPTIONS, 0).watch;
    for (const t of [1, 2, 3, 4]) {
      watch = observeOptionSet(watch, COMPLETE_COUNTRY_OPTIONS, t).watch;
    }
    expect(watch.sinceMs).toBe(0);
    expect(observeOptionSet(watch, COMPLETE_COUNTRY_OPTIONS, OPTION_SET_QUIET_MS).settled).toBe(true);
  });

  it('列表一变，静默期重新起算', () => {
    const first = observeOptionSet(INITIAL_OPTION_SET_WATCH, PARTIAL_COUNTRY_OPTIONS, 0);
    const aged = observeOptionSet(first.watch, PARTIAL_COUNTRY_OPTIONS, OPTION_SET_QUIET_MS);
    expect(aged.settled).toBe(true);

    // 又来一批 —— 之前攒的静默期作废。
    const changed = observeOptionSet(aged.watch, COMPLETE_COUNTRY_OPTIONS, OPTION_SET_QUIET_MS + 1);
    expect(changed.settled).toBe(false);
    expect(changed.watch.sinceMs).toBe(OPTION_SET_QUIET_MS + 1);
  });

  it('闸门挡住的是"低阶命中抢跑"：半加载选错项，完整后本该选另一项', () => {
    // 阶梯是有优先级的：第 1 级原文精确 > 第 4 级词边界前缀。
    // 半加载时列表里没有精确项，于是前缀级唯一命中了一个**更长的**选项。
    const partial = ['LinkedIn Recruiter'];
    const onPartial = resolveOptionCandidate(['LinkedIn'], partial);
    expect(onPartial).toEqual({ kind: 'MATCH', candidateIndex: 0, optionIndex: 0 });

    // 完整列表里精确项加载出来了，正确判定是选它——**另一个 option**。
    const complete = ['LinkedIn Recruiter', 'LinkedIn'];
    const onComplete = resolveOptionCandidate(['LinkedIn'], complete);
    expect(onComplete).toEqual({ kind: 'MATCH', candidateIndex: 0, optionIndex: 1 });

    // 两次都"成功"，但选中的不是同一项 ⇒ 未 settle 就判定 = 静默选错。
    // 下拉是收起的，用户看不见我们把 "LinkedIn" 填成了 "LinkedIn Recruiter"。
    expect(onPartial).not.toEqual(onComplete);
  });

  it('闸门也挡住"半加载唯一、完整后歧义"（需候选本身不精确命中）', () => {
    // 候选 "United" 在任何一批里都不精确等于某项，只能走到第 4 级前缀。
    expect(resolveOptionCandidate(['United'], ['United Kingdom'])).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 0,
    });
    expect(resolveOptionCandidate(['United'], ['United Kingdom', 'United States'])).toEqual({
      kind: 'AMBIGUOUS_OPTION',
      candidateIndex: 0,
    });
  });

  it('精确相等先于前缀 —— 记录这条既有语义，防止未来被改坏', () => {
    // "United States" 精确等于其中一项，不因更长的真前缀项存在而变歧义。
    // 这条是 combobox.ts 原有阶梯的性质，本次未改动，用测试钉住。
    expect(resolveOptionCandidate(['United States'], COMPLETE_COUNTRY_OPTIONS)).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 3,
    });
  });

  it('空列表永不 settle —— 分不清"还没加载"与"被搜索词过滤空"', () => {
    const first = observeOptionSet(INITIAL_OPTION_SET_WATCH, [], 0);
    expect(first.settled).toBe(false);
    const second = observeOptionSet(first.watch, [], 0);
    expect(second.settled).toBe(false);
  });

  it('空列表必须清空已累积的计数，不得把它带过闸门', () => {
    // 真实序列：搜索框输入后宿主先清空列表再重填。若空观测只是"跳过"，
    // 清空前后的两次同签名观测会被拼成"连续 2 次"，闸门形同虚设。
    const primed = observeOptionSet(INITIAL_OPTION_SET_WATCH, COMPLETE_COUNTRY_OPTIONS, 0);
    expect(primed.watch.consecutive).toBe(1);

    const cleared = observeOptionSet(primed.watch, [], 0);
    expect(cleared.watch).toEqual(INITIAL_OPTION_SET_WATCH);

    // 清空之后再看到同一批，必须重新从 1 数起，而不是接着数到 2 就放行。
    const refilled = observeOptionSet(cleared.watch, COMPLETE_COUNTRY_OPTIONS, OPTION_SET_QUIET_MS * 2);
    expect(refilled.watch.consecutive).toBe(1);
    expect(refilled.settled).toBe(false);
  });

  it('顺序变化必须视为不稳定（虚拟滚动／过滤会改顺序）', () => {
    const a = ['Alpha', 'Beta'];
    const b = ['Beta', 'Alpha'];
    expect(optionSetSignature(a)).not.toBe(optionSetSignature(b));
    const first = observeOptionSet(INITIAL_OPTION_SET_WATCH, a, 0);
    const second = observeOptionSet(first.watch, b, OPTION_SET_QUIET_MS + 1);
    expect(second.settled).toBe(false);
  });

  it('签名不因文案拼接产生碰撞', () => {
    // 两边 item 数量相同，长度前缀无能为力；只有保留 item 边界才不会碰撞。
    expect(optionSetSignature(['Alpha Beta', 'Gamma'])).not.toBe(
      optionSetSignature(['Alpha', 'Beta Gamma']),
    );
  });
});

describe('有序候选值', () => {
  // 2026-08-21 实测（§F.5-f）：竞品对 "How Did You Hear About Us?" 携带 12 个
  // 有序候选，先试自家品牌名（宿主选项里没有）→ 退到 LinkedIn → 命中。
  const SOURCE_OPTIONS = [
    'Community Agency',
    'Job Fair',
    'Job Posting Website',
    'LinkedIn',
    'Newspaper / Media',
    'Referral',
  ];

  it('第一个候选不在宿主选项里时，退到下一个', () => {
    expect(resolveOptionCandidate(['Jobright', 'LinkedIn'], SOURCE_OPTIONS)).toEqual({
      kind: 'MATCH',
      candidateIndex: 1,
      optionIndex: 3,
    });
  });

  it('候选顺序即偏好顺序：先命中的先用，不看后面更"像"的', () => {
    expect(resolveOptionCandidate(['Referral', 'LinkedIn'], SOURCE_OPTIONS)).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 5,
    });
  });

  it('全部候选都不中才是 NO_OPTION_MATCH', () => {
    expect(resolveOptionCandidate(['Jobright', 'Carrier Pigeon'], SOURCE_OPTIONS)).toEqual({
      kind: 'NO_OPTION_MATCH',
    });
  });

  it('歧义立刻停手，不再试下一个候选', () => {
    // 换一个候选去碰运气 = 用一个更不确定的值覆盖一个已知有歧义的位置。
    // 候选 0 "United" 在完整列表里前缀命中多条 → 停手，绝不退到候选 1。
    const resolution = resolveOptionCandidate(['United', 'United Kingdom'], COMPLETE_COUNTRY_OPTIONS);
    expect(resolution).toEqual({ kind: 'AMBIGUOUS_OPTION', candidateIndex: 0 });
  });

  it('空候选列表不写入', () => {
    expect(resolveOptionCandidate([], SOURCE_OPTIONS)).toEqual({ kind: 'NO_OPTION_MATCH' });
  });

  it('空白候选值不写入（防止用空串命中空选项）', () => {
    expect(resolveOptionCandidate(['   '], ['', 'LinkedIn'])).toEqual({ kind: 'NO_OPTION_MATCH' });
  });
});

describe('阶梯匹配语义与 combobox.ts 保持一致', () => {
  it('区号后缀：选项 "United States +1" 命中候选 "United States"', () => {
    expect(resolveOptionCandidate(['United States'], ['Canada +1', 'United States +1'])).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 1,
    });
  });

  it('大小写与首尾空白不影响精确相等', () => {
    expect(resolveOptionCandidate(['linkedin'], ['  LinkedIn  '])).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 0,
    });
  });

  it('词边界前缀不命中同一单词的更长形式', () => {
    // "Mast" 不应命中 "Masters"——它们是同一个单词的不同形式，不是前缀关系。
    expect(resolveOptionCandidate(['Mast'], ['Masters', 'Bachelors'])).toEqual({
      kind: 'NO_OPTION_MATCH',
    });
  });

  it('同页选项顺序不一致时仍按文案匹配，绝不按位置', () => {
    // §F.5-f 实测：同一页里 Medicare 系列是 ["No","Yes"]，其它题是 ["Yes","No"]。
    // 任何"取第一项"的默认策略都会在这里灾难性错答。
    expect(resolveOptionCandidate(['No'], ['No', 'Yes'])).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 0,
    });
    expect(resolveOptionCandidate(['No'], ['Yes', 'No'])).toEqual({
      kind: 'MATCH',
      candidateIndex: 0,
      optionIndex: 1,
    });
  });
});
