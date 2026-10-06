/**
 * 出差题按资料里「出差最多能接受多少」答（2026-10-04，argoland #738 的 `preferences.travelPercentMax`；dict/travel.ts）。
 *
 * 要守住的：
 *  · 题目说了比例：取最大的那一个，不超过上限答「是」，超过答「否」；
 *  · 「偶尔」当作不超过 25%；「经常」上限到 75% 才答「是」、上限 25% 及以下答「否」、正好 50% 不答；
 *  · 只问愿不愿意出差：上限大于 0 答「是」、不出差答「否」；
 *  · 报销、签证护照、出国、搬迁通勤、开车、「出过差吗」、否定问句不归这里；资料里没答不答。
 *
 * 题面与资料全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import type { ApplyFormDescriptor } from '../src/contracts';
import { travelAnswer } from '../src/dict/travel';
import { buildApplyPlan } from '../src/engine';
import { confirmedTravelPercentMax } from '../src/profileV2Travel';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const answerOf = (text: string, limit: 0 | 25 | 50 | 75 | 100 | undefined) => travelAnswer(text, limit)?.answer ?? null;

describe('按上限答', () => {
  it.each([
    ['This role requires up to 25% travel. Are you able to meet this requirement?', 25, 'YES'],
    ['This role requires up to 25% travel. Are you able to meet this requirement?', 0, 'NO'],
    ['Travel is expected 10-20% of the time. Is this something you are comfortable with?', 25, 'YES'],
    ['Are you willing to travel up to 50% of the time?', 25, 'NO'],
    ['Are you willing to travel up to 50% of the time?', 75, 'YES'],
    ['Are you able to travel occasionally to customer sites in Denver and Austin?', 25, 'YES'],
    ['Are you able to travel occasionally to customer sites in Denver and Austin?', 0, 'NO'],
    ['Willing to travel?', 50, 'YES'],
    ['Are you willing to travel for work?', 0, 'NO'],
    ['This position involves frequent travel. Are you comfortable with that?', 75, 'YES'],
    ['This position involves frequent travel. Are you comfortable with that?', 25, 'NO'],
    ['This position involves frequent travel. Are you comfortable with that?', 50, null],
  ] as const)('「%s」上限 %i → %s', (text, limit, expected) => {
    expect(answerOf(text, limit)).toBe(expected);
  });

  it('依据带上', () => {
    expect(travelAnswer('Are you willing to travel for work?', 25)).toEqual({ answer: 'YES', basis: 'TRAVEL_IN_PROFILE' });
  });

  it('资料里没答 → 不答', () => {
    expect(travelAnswer('Are you willing to travel for work?', undefined)).toBeNull();
  });
});

describe('不归这里管的一律不答', () => {
  it.each([
    'Will travel expenses be reimbursed by the candidate?',
    'Are you able to travel internationally on short notice?',
    'Do you hold a valid passport for travel?',
    'Are you willing to relocate or travel to our Denver office?',
    'Are you able to travel by car and do you have a valid driver license?',
    'Have you ever traveled for a previous job?',
    'Are you not able to travel?',
    'Travel up to 3 days per month is required. Are you able to meet this?',
    'Describe your travel experience.',
  ])('「%s」→ 不答', (text) => {
    expect(travelAnswer(text, 100)).toBeNull();
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
  const QUESTION = 'Are you able to travel occasionally to customer sites in Denver and Austin?';
  const radios = `<fieldset><legend>${QUESTION}</legend>
    <label><input name="t" type="radio" value="y" /> Yes</label><label><input name="t" type="radio" value="n" /> No</label></fieldset>`;

  it('单选：选 Yes，键 travelAnswer，依据带上', () => {
    const result = buildApplyPlan(greenhouse(radios), {} as never, { travelPercentMax: 25 });
    expect(result.entries.find((entry) => entry.label === QUESTION)).toMatchObject({
      kind: 'choice', key: 'travelAnswer', value: 'Yes', confidence: 1, historyBasis: 'TRAVEL_IN_PROFILE',
    });
  });

  it('多行框写 No（不出差）', () => {
    const result = buildApplyPlan(greenhouse(`<label for="tr">${QUESTION}</label><textarea id="tr"></textarea>`), {} as never, { travelPercentMax: 0 });
    expect(result.entries.find((entry) => entry.label === QUESTION)).toMatchObject({ kind: 'textarea', key: 'travelAnswer', value: 'No' });
  });

  it('资料里没答 → 照原路（单选 CHOICE_NO_DATA）', () => {
    const result = buildApplyPlan(greenhouse(radios), {} as never, {});
    expect(result.entries.find((entry) => entry.label === QUESTION)).toBeUndefined();
    expect(result.skipped.find((item) => item.label === QUESTION)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });
});

describe('Profile V2 投影', () => {
  const confirmed = { factId: '70000000-0000-4000-8000-000000000001', factRevision: '1', deletionEpoch: '0',
    meta: { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: '2026-10-04T00:00:00.000Z', sourceRef: null } };
  const snapshot = (travelPercentMax: unknown, authority: unknown = confirmed) => ({ // authority 'none'：没有权威行
    deletionEpoch: '0',
    profile: {
      preferences: { workModes: null, openToRelocation: null, openToRelocationCities: null, contactCurrentEmployer: null, travelPercentMax },
      scalarAuthorityByPath: authority === 'none' ? {} : { 'preferences.travelPercentMax': authority },
    },
  }) as never;

  it('确认过的五档照投影；没答、不在五档里、没确认 → null', () => {
    expect(confirmedTravelPercentMax(snapshot(50))).toBe(50);
    expect(confirmedTravelPercentMax(snapshot(0))).toBe(0);
    expect(confirmedTravelPercentMax(snapshot(null))).toBeNull();
    expect(confirmedTravelPercentMax(snapshot(30))).toBeNull();
    expect(confirmedTravelPercentMax(snapshot(50, 'none'))).toBeNull();
    expect(confirmedTravelPercentMax(snapshot(50, { ...confirmed, meta: { ...confirmed.meta, authorityState: 'SUGGESTED' } }))).toBeNull();
  });
});
