import type { OnboardingQuestion } from '@companion/platform-contracts';

export interface OnboardingQuestionDefinition {
  readonly questionId: OnboardingQuestion;
  readonly prompt: string;
  readonly choices: readonly Readonly<{ value: string; label: string }>[];
  readonly clarification?: string;
}
const choices = (entries: readonly (readonly [string, string])[]) => Object.freeze(entries.map(([value, label]) => Object.freeze({ value, label })));
const definition = (questionId: OnboardingQuestion, prompt: string, entries: readonly (readonly [string, string])[], clarification?: string): OnboardingQuestionDefinition =>
  Object.freeze({ questionId, prompt, choices: choices(entries), ...(clarification ? { clarification } : {}) });

/** Questionnaire revision 1, from product 05 §2.1 and 02 §2.3. No generated labels or inferred facts. */
const catalogue: Readonly<Record<OnboardingQuestion, OnboardingQuestionDefinition>> = Object.freeze({
  study: definition('study', '你现在读的是什么？', [['cs', 'CS'], ['ds_statistics', 'DS / 统计'], ['ece_ee', 'ECE / EE'], ['other_stem', '其他 STEM']],
    'degreeField 必须明确属于一个选项。programChoice 可为 12_month（一年制）、16_month（产品固定选项「一年半」）、24_month（两年）、other 或 null；未提学制时为 null。不得把非 STEM 专业推断成 other_stem。'),
  graduation: definition('graduation', '预计（或实际）哪年哪月毕业？', [], '需要明确的 YYYY-MM 月份和 graduated 布尔值；不要推断年份、月份或是否已经毕业。'),
  roles: definition('roles', '想找哪类岗位？可以多选。', [['swe', 'SWE'], ['ds', 'DS'], ['mle', 'MLE'], ['da', '数据分析'], ['de', 'Data Engineer'], ['hw', '本专业（硬件等）'], ['undecided', '还不确定']]),
  search_stage: definition('search_stage', '现在走到哪一步了？', [['not_started', '还没开始'], ['applying', '在投，还没面试'], ['interviewing', '有面试在进行'], ['offer', '已经有 offer'], ['graduated_looking', '已毕业，在找工作']]),
  emotion_language: definition('emotion_language', '难过或着急的时候，你更想用哪种语言聊？', [['zh', '中文'], ['en', 'English'], ['either', '都行']]),
  identity_stage: definition('identity_stage', '你现在的身份阶段是？只用来记下你自己录入的日期，不做任何判断。', [['f1_student', 'F-1 在读'], ['opt', 'OPT'], ['stem_opt', 'STEM OPT'], ['other', '其他'], ['prefer_not_say', '不想说']], '只解析用户明确自报的选项，不做身份判断、日期计算或法律推断。'),
  Q1: definition('Q1', '周日晚上十点，你发现这周计划投的 10 个岗只投了 3 个。你最希望身边的人——', [['A', '先别提，让我缓一缓'], ['B', '帮我把剩下的拆成明天能做完的两件'], ['C', '直接告诉我这周时间花哪去了'], ['D', '陪我吐槽两句，然后再说']]),
  Q2: definition('Q2', '你把简历发给朋友看。你更想收到哪种反馈？', [['A', '先说哪里好，再说一个最该改的'], ['B', '按优先级列出全部问题'], ['C', '一句话：能不能投，不能的话卡在哪']]),
  Q3: definition('Q3', '收到一封拒信后的 24 小时，你通常——', [['A', '反复看那封信，想自己哪里不够'], ['B', '当没发生，继续投'], ['C', '找人说说'], ['D', '很快复盘一下就放下']]),
  Q4: definition('Q4', '下面哪句话最像你现在的状态？', [['A', '想得很多，做得很少'], ['B', '做了很多，但不知道对不对'], ['C', '节奏还行，就是一个人有点闷'], ['D', '还没开始，不知道从哪开始']]),
  Q5: definition('Q5', '和人发消息，你更习惯——', [['A', '短句，一次一两句'], ['B', '说清楚来龙去脉，长点没关系'], ['C', '能用表格就别用段落']]),
  Q6: definition('Q6', '中文聊天里夹英文，你觉得——', [['A', '很自然，我自己也这样'], ['B', '专业词用英文就好'], ['C', '尽量全中文']]),
  Q7: definition('Q7', '正着急的时候，有人开个玩笑，你通常觉得——', [['A', '挺好，能松口气'], ['B', '看时候'], ['C', '正事别开玩笑']]),
  extra: definition('extra', '还有什么希望它知道的？比如「别催我」「说话直一点」。', [], '只做安全分类，resolution 必须为 null；不转换成其他问题的答案。'),
});

export function onboardingQuestionDefinition(questionId: OnboardingQuestion): OnboardingQuestionDefinition {
  if (!Object.hasOwn(catalogue, questionId)) throw new Error('Unknown onboarding question.');
  return catalogue[questionId];
}
