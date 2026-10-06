/**
 * 「能每周到办公室 N 天吗」「要求全职在现场办公，你愿意并且能做到吗」「接受远程吗」按资料里可接受的办公方式答
 * （2026-10-04，dict/workArrangement.ts）。
 *
 * 要守住的：
 *  · 「否」只看办公方式：题目要的方式不在他可接受的那几种里；
 *  · 「是」还要地点对得上：住在那儿、或说过愿意搬（不限城市，或列的城市里有那一座）；对不上就不答；
 *  · 掺了搬迁、出差、薪资、残障与便利措施、兼职实习、工作时段、时区、到岗时间、居住地、客户现场的不答；问句否定的不答。
 *
 * 题面与资料全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import type { ApplyFormDescriptor } from '../src/contracts';
import { workArrangementAnswer, type WorkArrangementFacts } from '../src/dict/workArrangement';
import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const AUSTIN_HYBRID: WorkArrangementFacts = { workModes: 'HYBRID,ONSITE', city: 'Austin', region: 'Texas', openToRelocation: 'false' };
const REMOTE_ONLY: WorkArrangementFacts = { workModes: 'REMOTE', city: 'Austin', region: 'Texas', openToRelocation: 'true' };
const answerOf = (text: string, facts: WorkArrangementFacts, jobLocation?: string) => workArrangementAnswer(text, facts, jobLocation)?.answer ?? null;

describe('办公方式对不上 → 否（与地点无关）', () => {
  it.each([
    'Can you work from our Denver office three days a week?',
    'This position requires being in the office 5 days per week. Are you willing and able to meet this requirement?',
    'Are you comfortable working fully on-site at our Chicago headquarters?',
    'Our team is hybrid (two days in office). Does this work for you?',
  ])('只接受远程：「%s」→ NO', (text) => {
    expect(workArrangementAnswer(text, REMOTE_ONLY)).toEqual({ answer: 'NO', basis: 'WORK_MODES_IN_PROFILE' });
  });

  it('只接受混合，被问每周五天在现场 → NO；被问每周三天 → 看地点', () => {
    const hybridOnly = { ...AUSTIN_HYBRID, workModes: 'HYBRID' };
    expect(answerOf('This role is on-site five days per week in Austin. Are you able to commit to that?', hybridOnly)).toBe('NO');
    expect(answerOf('Are you able to work from our Austin office three days per week?', hybridOnly)).toBe('YES');
  });

  it('只接受现场办公，被问接受远程吗 → NO；接受远程 → YES', () => {
    expect(answerOf('This is a fully remote role. Are you comfortable working remotely?', { workModes: 'ONSITE' })).toBe('NO');
    expect(answerOf('This is a fully remote role. Are you comfortable working remotely?', REMOTE_ONLY)).toBe('YES');
  });
});

describe('办公方式对得上 → 还要地点对得上', () => {
  it('住在题目点到的城市 → YES', () => {
    expect(answerOf('Can you work from our Austin office three days a week?', AUSTIN_HYBRID)).toBe('YES');
    expect(answerOf('Are you able to work on-site at our Austin, TX headquarters?', AUSTIN_HYBRID)).toBe('YES');
  });

  it('题目只说「our office」：拿岗位地点当那间办公室', () => {
    expect(answerOf('Are you able to come into the office 3 days per week?', AUSTIN_HYBRID, 'Austin, Texas')).toBe('YES');
    expect(answerOf('Are you able to come into the office 3 days per week?', AUSTIN_HYBRID, 'Boston, MA')).toBeNull();
    expect(answerOf('Are you able to come into the office 3 days per week?', AUSTIN_HYBRID)).toBeNull();
  });

  it('办公室有名字时不拿岗位地点代替（多地点岗位）', () => {
    expect(answerOf('Can you work from our Denver office three days a week?', AUSTIN_HYBRID, 'Austin, Texas')).toBeNull();
  });

  it('住在别处：说过愿意搬、不限城市 → YES；只愿意搬去别的城市 → 不答；不愿意搬 → 不答', () => {
    const anywhere = { ...AUSTIN_HYBRID, openToRelocation: 'true', openToRelocationCities: '' };
    const seattleOnly = { ...AUSTIN_HYBRID, openToRelocation: 'true', openToRelocationCities: 'Seattle' };
    const text = 'Can you work from our Denver office three days a week?';
    expect(answerOf(text, anywhere)).toBe('YES');
    expect(answerOf(text, seattleOnly)).toBeNull();
    expect(answerOf('Can you work from our Seattle office three days a week?', seattleOnly)).toBe('YES');
    expect(answerOf(text, AUSTIN_HYBRID)).toBeNull();
  });

  it('只接受混合、被问「到办公室」却没说每周几天 → 说不清，不答', () => {
    expect(answerOf('Are you able to work from our Austin office?', { ...AUSTIN_HYBRID, workModes: 'HYBRID' })).toBeNull();
    expect(answerOf('Are you able to work from our Austin office?', AUSTIN_HYBRID)).toBe('YES');
  });

  it('问句后面的「If not, please explain」不算否定句', () => {
    expect(answerOf('Can you work from our Austin office three days a week? If not, please explain.', AUSTIN_HYBRID)).toBe('YES');
  });
});

describe('不归这里管的一律不答', () => {
  it.each([
    'Are you willing to relocate to work on-site in Denver?',
    'Are you able to travel to client sites up to 25% of the time?',
    'Are you able to work on-site at client locations in Denver three days a week?',
    'Are you able to work on-site 5 days a week, 9am to 5pm Eastern Time?',
    'Are you based in Austin and able to come into the office?',
    'Are you able to start working on-site in January?',
    'Are you able to work on-site? We will provide reasonable accommodation for disabilities.',
    'Are you available for a part-time, on-site internship?',
    'Are you authorized to work on-site in the United States?',
    'Are you not able to come into the office three days a week?',
    'Our office is in Austin.',
    'What is your preferred work arrangement?',
    'Are you comfortable working remotely from within the United States?',
    'This role is remote or on-site. Are you comfortable with that?',
  ])('「%s」→ 不答', (text) => {
    expect(workArrangementAnswer(text, { ...AUSTIN_HYBRID, workModes: 'REMOTE,HYBRID,ONSITE' })).toBeNull();
  });

  it('资料里没填办公方式 → 不答', () => {
    expect(workArrangementAnswer('Can you work from our Austin office three days a week?', { ...AUSTIN_HYBRID, workModes: '' })).toBeNull();
    expect(workArrangementAnswer('Can you work from our Austin office three days a week?', { city: 'Austin' })).toBeNull();
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

describe('接进计划', () => {
  const PROFILE = { firstName: 'Taylor', city: 'Austin', addressRegion: 'TX', preferredWorkModes: 'HYBRID,ONSITE', openToRelocation: 'false' };
  const HYBRID = 'Can you work from our Austin office three days a week?';
  const FIVE = 'This position requires being in the office 5 days per week in Austin. Are you willing and able to meet this requirement?';

  it('单选：选 Yes，键 workArrangement，依据带上；州码换成全名再比', () => {
    const descriptor = greenhouse(`<fieldset><legend>${HYBRID}</legend>
      <label><input name="h" type="radio" value="y" /> Yes</label><label><input name="h" type="radio" value="n" /> No</label></fieldset>`);
    const result = buildApplyPlan(descriptor, PROFILE as never, {});
    expect(result.entries.find((entry) => entry.label === HYBRID)).toMatchObject({
      kind: 'choice', key: 'workArrangement', value: 'Yes', confidence: 1, historyBasis: 'WORK_MODES_IN_PROFILE',
    });
  });

  it('多行框：写 No（只接受远程）', () => {
    const descriptor = greenhouse(`<label for="onsite">${FIVE}</label><textarea id="onsite"></textarea>`);
    const result = buildApplyPlan(descriptor, { ...PROFILE, preferredWorkModes: 'REMOTE' } as never, {});
    expect(result.entries.find((entry) => entry.label === FIVE)).toMatchObject({ kind: 'textarea', key: 'workArrangement', value: 'No' });
  });

  it('用户关掉了办公方式这一类（suppressedKeys）→ 不答', () => {
    const descriptor = greenhouse(`<fieldset><legend>${HYBRID}</legend>
      <label><input name="h" type="radio" value="y" /> Yes</label><label><input name="h" type="radio" value="n" /> No</label></fieldset>`);
    const result = buildApplyPlan(descriptor, PROFILE as never, { suppressedKeys: new Set(['preferredWorkModes']) as never });
    expect(result.entries.find((entry) => entry.label === HYBRID)).toBeUndefined();
  });
});
