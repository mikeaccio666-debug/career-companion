import { describe, expect, it } from 'vitest';
import {
  applicationFormUrl,
  createDockOpenApplicationFormIntent,
  parseDockOpenApplicationFormIntent,
} from '../lib/openApplicationFormIntent';

/**
 * 白标 C（P2-12）：「打开申请表」这条消息只交两个闭集 token，URL 由 worker 按固定模板拼。
 */
const TARGET = { vendor: 'greenhouse' as const, boardToken: 'duolingo', jobId: '8653419002' };

describe('dock/open-application-form', () => {
  it('形状对就收，URL 落在厂商自己的域名上', () => {
    const intent = createDockOpenApplicationFormIntent(TARGET);
    expect(intent).toEqual({ kind: 'dock/open-application-form', ...TARGET });
    expect(applicationFormUrl(intent!)).toBe('https://job-boards.greenhouse.io/duolingo/jobs/8653419002');
  });

  it.each([
    ['多一个键', { extra: 1 }],
    ['别家厂商', { vendor: 'lever' }],
    ['token 带斜杠', { boardToken: 'duo/lingo' }],
    ['token 带点', { boardToken: 'duo.lingo' }],
    ['岗位 id 不是数字', { jobId: '12abc' }],
    ['岗位 id 是数字类型', { jobId: 12 }],
  ])('%s → 拒', (_why, over) => {
    const intent = createDockOpenApplicationFormIntent(TARGET);
    expect(parseDockOpenApplicationFormIntent({ ...intent, ...over })).toBeNull();
  });
});
