/**
 * 语言题按资料里的语言答（2026-10-04，dict/languages.ts）。
 *
 * 10-03 真实岗位批测里「AI 在资料里找不到依据」的必填行，语言题最多：会不会某种语言、流不流利、是不是母语或接近母语、
 * 是不是双语、勾选会说的语言、写出英语以外还会哪几种。资料里有这一块（Profile V2 `languages`），内核从前拿不到。
 *
 * 判据要守住的几条：
 *  · 资料里有、水平够 → 是；水平明确不够 → 否；
 *  · 列了语言、却没有题里问的那一种 → 否；但问的是英语、或资料里有一条认不出的语言时不答「否」；
 *  · 一条语言都没有 → 不答；
 *  · 问「普通话」而资料只写了「中文」→ 不答。
 *
 * 题面与资料全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import { buildAuditView } from '../src/audit';
import type { ApplyFormDescriptor } from '../src/contracts';
import { languageListText, languageOptionsToCheck, languagesNamed, languageYesNo, type ProfileLanguage } from '../src/dict/languages';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const lang = (language: string, proficiency: ProfileLanguage['proficiency']): ProfileLanguage => ({ language, proficiency });
const BILINGUAL: readonly ProfileLanguage[] = [lang('English', 'PROFESSIONAL'), lang('普通话', 'NATIVE_OR_BILINGUAL'), lang('Spanish', 'CONVERSATIONAL')];

describe('认语言名', () => {
  it.each([
    ['Do you speak German?', ['de']],
    ['Chinese (Mandarin)', ['cmn']],
    ['Mandarin Chinese', ['cmn']],
    ['你会说西班牙语吗？', ['es']],
    ['English (ENG)', ['en']],
    ['Are you fluent in French and Italian?', ['fr', 'it']],
    ['Tell us about yourself', []],
  ])('「%s」→ %j', (text, ids) => {
    expect(languagesNamed(text)).toEqual(ids);
  });
});

describe('是非题', () => {
  it.each([
    ['Are you fluent in spoken and written English?', 'YES'],
    ['Is English your native language?', null], // 工作语言那一档说不清是不是母语
    ['Are you a native or near-native Mandarin speaker?', 'YES'],
    ['Do you speak Chinese?', 'YES'], // 普通话算中文
    ['Can you speak Spanish?', 'YES'], // 会话水平够「会说」
    ['Are you fluent in Spanish?', 'NO'], // 会话水平不够「流利」
    ['Do you speak Portuguese proficiently?', 'NO'], // 列了语言、没有葡语
    ['Are you bilingual in English and Mandarin?', 'YES'],
    ['Are you Mandarin bilingual?', 'YES'], // 普通话之外还有英语在工作语言及以上
    ['Are you Spanish bilingual?', 'NO'], // 西语只到会话
    ['Do you speak French or German?', 'NO'],
    ['Do you speak Spanish or Portuguese?', 'YES'],
    ['Are you fluent in English and Portuguese?', 'NO'],
  ])('「%s」→ %s', (text, answer) => {
    const result = languageYesNo(text, BILINGUAL);
    expect(result === null ? null : result.answer).toBe(answer);
    if (result !== null) expect(result.basis).toBe('LANGUAGES_IN_PROFILE');
  });

  it('资料里没写英语：问英语一律不答「否」（很多人不写英语）', () => {
    const noEnglish = [lang('Mandarin', 'NATIVE_OR_BILINGUAL')];
    expect(languageYesNo('Are you fluent in spoken and written English?', noEnglish)).toBeNull();
    expect(languageYesNo('Do you speak Korean fluently?', noEnglish)).toEqual({ answer: 'NO', basis: 'LANGUAGES_IN_PROFILE' });
  });

  it('资料里有一条认不出的语言：没有题里那一种也不答「否」（说不定就是它）', () => {
    const unknown = [lang('English', 'NATIVE_OR_BILINGUAL'), lang('Elvish', 'PROFESSIONAL')];
    expect(languageYesNo('Do you speak Portuguese proficiently?', unknown)).toBeNull();
    expect(languageYesNo('Are you fluent in spoken and written English?', unknown)).toEqual({ answer: 'YES', basis: 'LANGUAGES_IN_PROFILE' });
  });

  it('问普通话、资料只写了「中文」→ 说不清，不答；问中文则算', () => {
    const chinese = [lang('中文', 'NATIVE_OR_BILINGUAL'), lang('English', 'PROFESSIONAL')];
    expect(languageYesNo('Are you a native Mandarin speaker?', chinese)).toBeNull();
    expect(languageYesNo('Do you speak Chinese fluently?', chinese)).toEqual({ answer: 'YES', basis: 'LANGUAGES_IN_PROFILE' });
  });

  it('资料里一条语言都没有 → 不答', () => {
    expect(languageYesNo('Do you speak Portuguese proficiently?', [])).toBeNull();
    expect(languageYesNo('Do you speak Portuguese proficiently?', undefined)).toBeNull();
  });

  it.each([
    'Can you translate documents from Spanish to English?',
    'Do you hold a certified Spanish interpreter credential?',
    'What is your TOEFL score in English?',
    'How many years have you spoken Spanish professionally?',
    'Do you know anyone here who speaks Spanish?',
    'Are you comfortable working with Spanish-speaking customers?',
    'Are you not fluent in Spanish?',
    'Spanish speakers are encouraged to apply.',
    'Do you have experience with SQL or Python?',
  ])('不归这里：「%s」→ 不答', (text) => {
    expect(languageYesNo(text, BILINGUAL)).toBeNull();
  });
});

describe('列出语言', () => {
  it('勾选题：勾上会说的那几种（中文三条按普通话对），英语以外的问法去掉英语', () => {
    const options = ['English (ENG)', 'Mandarin (CMN)', 'Spanish (SPA)', 'French (FRA)', 'Other'];
    expect(languageOptionsToCheck('Languages spoken (check all that apply)', options, BILINGUAL))
      .toEqual(['English (ENG)', 'Mandarin (CMN)', 'Spanish (SPA)']);
    expect(languageOptionsToCheck('Which languages are you fluent in other than English?', options, BILINGUAL))
      .toEqual(['Mandarin (CMN)']);
  });

  it('一项都勾不上 → 不勾（不替他选「None」）', () => {
    expect(languageOptionsToCheck('Language skills (select all that apply)', ['French', 'German', 'None'], BILINGUAL)).toBeNull();
  });

  it('文本题：写会说的那几种（英文名），资料里认不出的那条照原样', () => {
    expect(languageListText('Which other languages do you speak fluently?', BILINGUAL)).toBe('Mandarin');
    expect(languageListText('What languages do you speak?', [...BILINGUAL, lang('Elvish', 'PROFESSIONAL')])).toBe('English, Mandarin, Spanish, Elvish');
    expect(languageListText('Which other languages do you speak fluently?', [lang('English', 'NATIVE_OR_BILINGUAL')])).toBeNull();
  });

  it('不是列语言的题 → null', () => {
    expect(languageListText('Which programming languages do you use?', BILINGUAL)).toBeNull();
    expect(languageOptionsToCheck('Which tools are you familiar with?', ['Excel', 'Tableau'], BILINGUAL)).toBeNull();
  });
});

function greenhouse(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${controls}
  </form>`;
  const adapter = compileBundledAdapter(greenhouseRules);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] };
}

let groups = 0;
const radios = (label: string, options: readonly string[] = ['Yes', 'No']): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    ${options.map((text, index) => `<label><input name="l${groups}" type="radio" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`;
};
const checkboxes = (label: string, options: readonly string[]): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    ${options.map((text, index) => `<label><input name="c${groups}" type="checkbox" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`;
};
const textarea = (id: string, label: string): string => `<label for="${id}">${label}</label><textarea id="${id}"></textarea>`;

const COLLECTIONS = parseApplyProfileCollections({
  languages: [
    { language: 'English', proficiency: 'PROFESSIONAL' },
    { language: '普通话', proficiency: 'NATIVE_OR_BILINGUAL' },
    { language: 'Spanish', proficiency: 'CONVERSATIONAL' },
    { language: 'not-a-proficiency', proficiency: 'EXPERT' },
  ],
});
const plan = (controls: string, options: BuildPlanOptions = { collections: COLLECTIONS }) =>
  buildApplyPlan(greenhouse(controls), { firstName: 'Taylor' } as never, options);
const entryFor = (result: ReturnType<typeof plan>, label: string) => result.entries.find((entry) => entry.label === label);
const skipFor = (result: ReturnType<typeof plan>, label: string) => result.skipped.find((item) => item.label === label);

describe('接进计划', () => {
  const FLUENT = 'Are you fluent in spoken and written English?';
  const PORTUGUESE = 'Do you speak Portuguese proficiently?';

  it('集合的有界读：水平不在四档里的那一条丢掉，其余照收', () => {
    expect(COLLECTIONS.languages).toEqual([
      { language: 'English', proficiency: 'PROFESSIONAL' },
      { language: '普通话', proficiency: 'NATIVE_OR_BILINGUAL' },
      { language: 'Spanish', proficiency: 'CONVERSATIONAL' },
    ]);
  });

  it('单选是非题：选「Yes」／「No」，键 languageAnswer，依据带给浮层', () => {
    const result = plan(radios(FLUENT) + radios(PORTUGUESE));
    expect(entryFor(result, FLUENT)).toMatchObject({ kind: 'choice', key: 'languageAnswer', value: 'Yes', confidence: 1, historyBasis: 'LANGUAGES_IN_PROFILE' });
    // 同一节两道语言题是两道题，不按重复字段仲裁掉。
    expect(entryFor(result, PORTUGUESE)).toMatchObject({ key: 'languageAnswer', value: 'No' });
    expect(result.skipped.some((item) => item.reason === 'DUPLICATE_FIELD')).toBe(false);
    const row = buildAuditView(result, []).rows.find((item) => item.label === FLUENT);
    expect(row).toMatchObject({ key: 'languageAnswer', historyBasis: 'LANGUAGES_IN_PROFILE' });
  });

  it('复选框组：勾上会说的那几项（多行值）', () => {
    const label = 'Languages spoken (check all that apply)';
    const result = plan(checkboxes(label, ['English (ENG)', 'Mandarin (CMN)', 'French (FRA)']));
    expect(entryFor(result, label)).toMatchObject({ kind: 'choice', key: 'languageAnswer', value: 'English (ENG)\nMandarin (CMN)' });
  });

  it('多行框：写英语以外流利的语言', () => {
    const label = 'Which other languages do you speak fluently?';
    const result = plan(textarea('other_languages', label));
    expect(entryFor(result, label)).toMatchObject({ kind: 'textarea', key: 'languageAnswer', value: 'Mandarin', historyBasis: 'LANGUAGES_IN_PROFILE' });
  });

  it('文本框里的是非题写 Yes／No', () => {
    const label = 'Do you speak Portuguese proficiently?';
    const result = plan(`<label for="pt">${label}</label><input id="pt" type="text" />`);
    expect(entryFor(result, label)).toMatchObject({ kind: 'text', key: 'languageAnswer', value: 'No' });
  });

  it('资料里没有语言 → 一个字不改地走原路（单选照旧 CHOICE_NO_DATA，交给 AI 或本人）', () => {
    const result = plan(radios(FLUENT), { collections: {} });
    expect(entryFor(result, FLUENT)).toBeUndefined();
    expect(skipFor(result, FLUENT)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('页面上已经选了 → 不覆盖（NOT_EMPTY）', () => {
    const descriptor = greenhouse(radios(FLUENT));
    (document.querySelector('input[type="radio"][value="1"]') as HTMLInputElement).checked = true;
    const result = buildApplyPlan(descriptor, {} as never, { collections: COLLECTIONS });
    expect(result.entries.find((entry) => entry.label === FLUENT)).toBeUndefined();
    expect(result.skipped.find((item) => item.label === FLUENT)).toMatchObject({ reason: 'NOT_EMPTY', key: 'languageAnswer' });
  });

  it('选项里没有 Yes／No → 不写，照原路', () => {
    const result = plan(radios(FLUENT, ['Native', 'Fluent', 'Basic']));
    expect(entryFor(result, FLUENT)).toBeUndefined();
  });
});
