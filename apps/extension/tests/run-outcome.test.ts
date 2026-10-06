import { describe, expect, it } from 'vitest';

import {
  RUN_REASONS,
  countBucket,
  createDockRunOutcome,
  durationBucket,
  fillRateBucket,
  newRunId,
  parseDockRunOutcome,
  runReason,
  runVendor,
  submitOutcomeOf,
  type RunOutcomeEvent,
} from '../lib/runOutcome';

/**
 * 一轮自动填写怎么收场（2026-10-04，体检 11-1）：内容脚本 → worker 的闭集消息。契约权威在 argoland
 * （src/observability/extension-run-outcome.ts）：服务端对任何一项不在闭集里、跨字段不一致的整批拒收，所以 worker
 * 这一侧先按同一套规则把关，内容脚本那一侧只交闭集里的值。
 */
const event = (overrides: Partial<RunOutcomeEvent> = {}): RunOutcomeEvent => ({
  runId: '0123456789abcdef0123456789abcdef',
  vendor: 'workday',
  lane: 'host',
  outcome: 'NEEDS_YOU',
  planned: '11-20',
  filled: '6-10',
  needsYou: '2',
  aiAnswered: '1',
  signedOnBehalf: '0',
  requiredEmptyOnPage: '2',
  fillRate: '50-74',
  durationBucket: '5_10S',
  chainPages: 0,
  submitOutcome: 'none',
  ...overrides,
});

describe('分桶：只给桶，不给确切的数', () => {
  it.each([
    [0, '0'], [-3, '0'], [Number.NaN, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4-5'], [5, '4-5'],
    [6, '6-10'], [10, '6-10'], [11, '11-20'], [20, '11-20'], [21, '21-40'], [40, '21-40'], [41, '41+'], [400, '41+'],
  ] as const)('%s 栏 → %s', (count, bucket) => {
    expect(countBucket(count)).toBe(bucket);
  });

  it.each([
    [0, 0, 'NONE'], [3, 0, 'NONE'], [0, 7, '0'], [1, 7, '1-24'], [2, 7, '25-49'], [4, 7, '50-74'],
    [6, 7, '75-99'], [7, 7, '100'], [9, 7, '100'],
  ] as const)('写上 %s / 列出 %s → %s（按确切的数算，再分桶）', (filled, planned, bucket) => {
    expect(fillRateBucket(filled, planned)).toBe(bucket);
  });

  it.each([
    [0, 'LT_2S'], [1_999, 'LT_2S'], [2_000, '2_5S'], [9_999, '5_10S'], [19_000, '10_20S'],
    [39_000, '20_40S'], [89_000, '40_90S'], [90_000, 'GE_90S'], [-5, 'LT_2S'], [Number.NaN, 'LT_2S'],
  ] as const)('%s ms → %s', (ms, bucket) => {
    expect(durationBucket(ms)).toBe(bucket);
  });
});

describe('内部码 → 闭集原因', () => {
  it.each([
    ['PROFILE_UNAVAILABLE', 'PROFILE_UNAVAILABLE'],
    ['NOT_SEALABLE:ROOT_MUTATED', 'NOT_SEALABLE'],
    ['CHAIN_CAPTCHA', 'CAPTCHA'],
    ['CHAIN_UNKNOWN_PAGE', 'UNKNOWN_PAGE'],
    ['NO_VALUE', 'NO_VALUE'],
    ['SOMETHING_NEW_IN_THE_KERNEL', 'OTHER'],
    ['https://boards.greenhouse.io/acme/jobs/123', 'OTHER'],
    ['Are you authorized to work in the US?', 'OTHER'],
    [undefined, 'OTHER'],
  ])('%s → %s', (code, reason) => {
    expect(runReason(code)).toBe(reason);
  });

  it('原因表里没有一个像主机、网址或句子的码', () => {
    for (const reason of RUN_REASONS) expect(reason).toMatch(/^[A-Z][A-Z_]{1,40}$/u);
  });

  it('厂商认不出就是 unknown', () => {
    expect(runVendor('lever')).toBe('lever');
    expect(runVendor('generic')).toBe('generic');
    expect(runVendor('acme-careers.example.com')).toBe('unknown');
    expect(runVendor(null)).toBe('unknown');
  });

  it('浮层「提交」的结局', () => {
    expect(submitOutcomeOf('SUBMITTED')).toBe('confirmed');
    expect(submitOutcomeOf('UNCONFIRMED')).toBe('unconfirmed');
    expect(submitOutcomeOf('NOT_SUBMITTED')).toBe('rejected');
    expect(submitOutcomeOf('UNAVAILABLE')).toBe('unavailable');
    expect(submitOutcomeOf('UNTRUSTED')).toBe('unavailable');
  });

  it('runId 是 32 位小写十六进制，每一轮不同', () => {
    const first = newRunId();
    expect(first).toMatch(/^[a-f0-9]{32}$/u);
    expect(newRunId()).not.toBe(first);
  });
});

describe('dock/run-outcome：worker 只认闭集里、一致的那一条', () => {
  it('认得的那一条原样交回（带不带原因都行）', () => {
    expect(parseDockRunOutcome(createDockRunOutcome(event(), true))).toEqual({ event: event(), final: true });
    const failed = event({ outcome: 'FAILED', reason: 'PROFILE_UNAVAILABLE', planned: '0', filled: '0', fillRate: 'NONE' });
    expect(parseDockRunOutcome(createDockRunOutcome(failed, false))).toEqual({ event: failed, final: false });
  });

  it.each([
    ['多一个网址', { ...event(), url: 'https://jobs.lever.co/acme/1/apply' }],
    ['多一个题目', { ...event(), label: 'Are you authorized to work in the US?' }],
    ['少一项', (() => { const { submitOutcome: _drop, ...rest } = event(); return rest; })()],
    ['厂商是主机名', event({ vendor: 'careers.acme.com' as never })],
    ['确切的字段数', event({ planned: '17' as never })],
    ['字段数是数字', event({ filled: 7 as never })],
    ['runId 带了页面', event({ runId: 'run-https://jobs.lever.co' })],
    ['原因不在闭集里', event({ outcome: 'FAILED', reason: 'boards.greenhouse.io' as never })],
    ['FAILED 没有原因', event({ outcome: 'FAILED' })],
    ['FILLED_ALL 带了原因', event({ outcome: 'FILLED_ALL', reason: 'NO_VALUE' })],
    ['连填结局却不在连填里', event({ outcome: 'CHAIN_ADVANCED', chainPages: 0 })],
    ['连填页数超了', event({ outcome: 'CHAIN_ADVANCED', chainPages: 31 })],
    ['列出 0 栏却有填写率', event({ planned: '0', fillRate: '50-74' })],
  ])('%s → 不认', (_label, value) => {
    expect(parseDockRunOutcome({ kind: 'dock/run-outcome', final: true, event: value })).toBeNull();
  });

  it.each([
    ['不是这一种消息', { kind: 'dock/diagnostic', final: true, event: event() }],
    ['final 不是真假', { kind: 'dock/run-outcome', final: 'yes', event: event() }],
    ['多一个键', { kind: 'dock/run-outcome', final: true, event: event(), tab: 3 }],
    ['不是对象', 'dock/run-outcome'],
    ['null', null],
  ])('%s → 不认', (_label, value) => {
    expect(parseDockRunOutcome(value)).toBeNull();
  });
});
