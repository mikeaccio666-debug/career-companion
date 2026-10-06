import { describe, expect, it } from 'vitest';

import { needKindOf, optionChips, rememberable, type NeedFacts } from '../lib/dock/needs';
import { toDockRow } from '../lib/dock/rows';
import type { AutofillDockFieldRow, DockQuestion } from '../lib/dock/types';

/**
 * 「需要你」怎么分组、摆哪几个选项（2026-09-28）。只看稳定原因码与控件的形状，选项原文只在本地比一比。
 */
const row = (reason: string, extra: Partial<AutofillDockFieldRow> = {}) =>
  toDockRow({ label: 'Question', required: true, done: false, state: 'MANUAL', needsUser: true, reason, ...extra }, 0);
const facts = (over: Partial<NeedFacts> = {}): NeedFacts => ({ question: null, aiWritable: false, letter: false, control: 'single', ...over });
const choice = (options: readonly string[], suggested: string | null = null): DockQuestion => ({ kind: 'choice', options, suggested });

describe('按要做的事分组', () => {
  it('按规定留给本人的：你来决定（同意没开代填、自我认同、涉及他人……）', () => {
    for (const reason of ['MANUAL_ONLY', 'CONSENT_OFF', 'OTHER_PERSON', 'CAPABILITY_DISABLED', 'CLICK_DENIED']) {
      expect(needKindOf(row(reason), facts({ question: choice(['Yes', 'No']) })), reason).toBe('decide');
    }
  });

  it('选项的事：选一个（对不上、说不准、没读全、按岗位地点推断好了等点头、看岗位的是非题）', () => {
    for (const reason of ['NO_OPTION_MATCH', 'AMBIGUOUS_OPTION', 'OPTIONS_INCOMPLETE', 'WIDGET_TIMEOUT', 'PREFILLED_NEEDS_CONFIRMATION']) {
      expect(needKindOf(row(reason), facts({ control: 'choice' })), reason).toBe('choose');
    }
    expect(needKindOf(row('JOB_DEPENDENT'), facts({ question: choice(['Yes', 'No']) }))).toBe('choose');
  });

  it('资料里没有：选择题问一次选项，一行字的题问一句', () => {
    expect(needKindOf(row('CHOICE_NO_DATA'), facts({ question: choice(['LinkedIn', 'Referral']) }))).toBe('missing');
    expect(needKindOf(row('NO_VALUE'), facts({ question: { kind: 'text', options: [], suggested: null } }))).toBe('missing');
    expect(needKindOf(row('LOW_CONFIDENCE'), facts())).toBe('missing');
  });

  it('写一段：开放题、多行框、旁边有「用 AI 写」的', () => {
    expect(needKindOf(row('USER_ONLY'), facts())).toBe('write');
    expect(needKindOf(row('LOW_CONFIDENCE'), facts({ control: 'multi' }))).toBe('write');
    expect(needKindOf(row('LOW_CONFIDENCE'), facts({ aiWritable: true }))).toBe('write');
    expect(needKindOf(row('NO_VALUE'), facts({ question: { kind: 'long', options: [], suggested: null } }))).toBe('write');
  });

  it('别的没填上的：去网页上看一眼（网站说格式不对、没确认、没存上的一段、求职信）', () => {
    expect(needKindOf(row('HOST_REJECTED'), facts())).toBe('check');
    expect(needKindOf(toDockRow({ label: 'Start', required: true, done: false, state: 'UNVERIFIED' }, 0), facts())).toBe('check');
    expect(needKindOf(row('NO_VALUE', { unsavedEntry: { collection: 'experience', number: 1, saveLabel: 'Update' } }), facts())).toBe('check');
    expect(needKindOf(row('USER_ONLY'), facts({ letter: true }))).toBe('check');
  });

  it('当场答上之后记不记：只有资料里没有的那几类；看岗位的、说得出是哪一国工作许可的不记', () => {
    expect(rememberable(row('NO_VALUE'), 'missing')).toBe(true);
    expect(rememberable(row('CHOICE_NO_DATA'), 'missing')).toBe(true);
    expect(rememberable(row('JOB_DEPENDENT'), 'missing')).toBe(false);
    expect(rememberable(row('NO_VALUE', { regionWithoutRecord: '英国' }), 'missing')).toBe(false);
    expect(rememberable(row('NO_OPTION_MATCH'), 'choose')).toBe(false);
  });
});

describe('摆哪几个选项', () => {
  const SCHOOLS = ['Stanford University', 'University of California, Berkeley', 'UC Berkeley Extension', 'University of California, Los Angeles', 'University of Washington', 'Other'];

  it('按与他资料里那句话的接近程度挑，最多三个；缩写认得出（UC = University of California）', () => {
    expect(optionChips(choice(SCHOOLS), 'UC Berkeley')).toEqual(['University of California, Berkeley', 'UC Berkeley Extension']);
    expect(optionChips(choice(["Associate's Degree", "Bachelor's Degree", 'Master of Science', 'Master of Arts', 'MBA', 'Doctorate']), "Master's"))
      .toEqual(['Master of Science', 'Master of Arts']);
    expect(optionChips(choice(['计算机科学与技术', '软件工程', '电子信息工程', '自动化', '数学']), '计算机科学')).toEqual(['计算机科学与技术']);
  });

  it('国名认得常见写法（USA、UK、United States of America…），也不把 UK 当成 Ukraine', () => {
    const COUNTRIES = ['Canada', 'Mexico', 'Ukraine', 'United Kingdom', 'United States', 'Uruguay', 'Other'];
    expect(optionChips(choice(COUNTRIES), 'USA')).toEqual(['United States']);
    expect(optionChips(choice(COUNTRIES), 'US')).toEqual(['United States']);
    expect(optionChips(choice(COUNTRIES), 'UK')).toEqual(['United Kingdom']);
    expect(optionChips(choice(COUNTRIES), 'Great Britain')).toEqual(['United Kingdom']);
    expect(optionChips(choice(['Canada', 'United States of America', 'United Kingdom of Great Britain and Northern Ireland', 'Other', 'Mexico']), 'United States'))
      .toEqual(['United States of America']);
    expect(optionChips(choice(['Canada', 'Korea, Republic of', "Korea, Democratic People's Republic of", 'Japan', 'Other']), 'South Korea'))
      .toEqual(['Korea, Republic of']);
  });

  it('不猜：都不够像就只摆「Other」一类（有的话），再没有就一个都不摆', () => {
    expect(optionChips(choice(['Portland', 'Austin', 'Denver', 'Boston', 'Other']), 'Seattle')).toEqual(['Other']);
    expect(optionChips(choice(['Portland', 'Austin', 'Denver', 'Boston', 'Chicago']), 'Seattle')).toEqual([]);
    // 说了很多、只有一个词对得上的（学位里的「Science」），不当成对。
    expect(optionChips(choice(["Associate's Degree", "Bachelor's Degree", 'Master of Science', 'Master of Arts', 'MBA']), 'Bachelor of Science in Computer Science'))
      .toEqual([]);
  });

  it('选项不多（不超过四个）就全摆、按页面的先后；计划期挑好的那一项在最前', () => {
    expect(optionChips(choice(['Yes', 'No']), null)).toEqual(['Yes', 'No']);
    expect(optionChips(choice(['LinkedIn', 'Company website', 'Referral', 'Other']), null)).toEqual(['LinkedIn', 'Company website', 'Referral', 'Other']);
    expect(optionChips(choice(['Yes', 'No'], 'No'), null)).toEqual(['No', 'Yes']);
    expect(optionChips(choice(SCHOOLS), null), '选项多、又没有线索：一个都不挑').toEqual([]);
  });
});
