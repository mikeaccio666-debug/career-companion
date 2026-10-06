import { describe, expect, it } from 'vitest';
import {
  createDockAnswerMemoryIntent,
  parseAnswerMemorySettings,
  parseDockAnswerMemoryIntent,
  parseDockAnswerMemoryReply,
} from '../lib/answerMemoryIntent';

/**
 * 手势填写路向 worker 要答案记忆的那条消息（P1-6）。内容脚本手上不该有 token：
 * 消息只说在哪一页、要哪一步；唯一带值的一步（PUT）带的是用户刚在面板里亲手确认的答案。
 */
const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;
const PUT = { schemaVersion: 1 as const, answerKey: 'cat:relocation', controlType: 'SINGLE_CHOICE' as const, value: { kind: 'CHOICES' as const, optionTexts: ['Yes'] } };

describe('四步各自的形状', () => {
  it('LIST / SETTINGS_GET 只说在哪一页', () => {
    expect(createDockAnswerMemoryIntent(...PAGE, 'LIST')).toMatchObject({ kind: 'dock/answer-memory-intent', origin: PAGE[0], pathname: PAGE[1], step: 'LIST' });
    expect(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_GET')?.step).toBe('SETTINGS_GET');
    // 多一个字段就拒：这条消息会走到一次带凭据的读。
    expect(parseDockAnswerMemoryIntent({ ...createDockAnswerMemoryIntent(...PAGE, 'LIST'), request: PUT })).toBeNull();
  });

  it('PUT 带一条过了契约解析的答案；不成形的答案整条拒', () => {
    const intent = createDockAnswerMemoryIntent(...PAGE, 'PUT', PUT);
    expect(intent).toMatchObject({ step: 'PUT', request: PUT });
    expect(createDockAnswerMemoryIntent(...PAGE, 'PUT', { ...PUT, answerKey: 'cat:nope' })).toBeNull();
    expect(createDockAnswerMemoryIntent(...PAGE, 'PUT', { ...PUT, value: { kind: 'TEXT', text: 'x' } } as never)).toBeNull();
  });

  it('SETTINGS_SET 带两个布尔开关（与说过的那一版说明），别的形状拒', () => {
    expect(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_SET', { enabled: true, autoReuse: false })).toMatchObject({ step: 'SETTINGS_SET', settings: { enabled: true, autoReuse: false } });
    expect(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_SET', { enabled: true, autoReuse: true, disclosureVersion: 'answer-memory-2026-09-28' }))
      .toMatchObject({ settings: { enabled: true, autoReuse: true, disclosureVersion: 'answer-memory-2026-09-28' } });
    expect(parseAnswerMemorySettings({ enabled: true, autoReuse: true, disclosureVersion: null })).toEqual({ enabled: true, autoReuse: true, disclosureVersion: null });
    expect(parseAnswerMemorySettings({ enabled: 'yes', autoReuse: false })).toBeNull();
    expect(parseAnswerMemorySettings({ enabled: true })).toBeNull();
    expect(parseAnswerMemorySettings({ enabled: true, autoReuse: true, disclosureVersion: '' })).toBeNull();
    expect(parseAnswerMemorySettings({ enabled: true, autoReuse: true, disclosureVersion: 3 })).toBeNull();
    expect(parseAnswerMemorySettings({ enabled: true, autoReuse: true, disclosureVersion: 'x'.repeat(65) })).toBeNull();
    expect(parseAnswerMemorySettings({ enabled: true, autoReuse: true, extra: 1 })).toBeNull();
  });

  it('不是这几步、不是这条消息、页面不合格，都拒', () => {
    const intent = createDockAnswerMemoryIntent(...PAGE, 'LIST');
    expect(parseDockAnswerMemoryIntent({ ...intent, step: 'DELETE' })).toBeNull();
    expect(parseDockAnswerMemoryIntent({ ...intent, kind: 'dock/apply-materials-intent' })).toBeNull();
    expect(createDockAnswerMemoryIntent('http://boards.greenhouse.io', PAGE[1], 'LIST')).toBeNull();
  });
});

describe('worker 的答复', () => {
  const answer = { answerKey: 'cat:relocation', categoryKey: 'relocation', controlType: 'SINGLE_CHOICE', value: { kind: 'CHOICES', optionTexts: ['Yes'] }, revision: '1', confirmedAt: '2026-09-21T00:00:00.000Z' };
  it('清单逐条按契约校验，一条不成形整份 null', () => {
    expect(parseDockAnswerMemoryReply({ kind: 'ANSWER_MEMORY_LIST', answers: [answer] })).toEqual({ kind: 'ANSWER_MEMORY_LIST', answers: [answer] });
    expect(parseDockAnswerMemoryReply({ kind: 'ANSWER_MEMORY_LIST', answers: [{ ...answer, value: { kind: 'TEXT', text: 'Yes' } }] })).toBeNull();
    expect(parseDockAnswerMemoryReply({ kind: 'ANSWER_MEMORY_LIST', answers: [{ ...answer, answerKey: 'nope' }] })).toBeNull();
  });
  it('PUT 回键与版本；设置回两个开关；REFUSED 只认稳定码', () => {
    expect(parseDockAnswerMemoryReply({ kind: 'ANSWER_MEMORY_PUT', answerKey: 'cat:relocation', revision: '2' })).toEqual({ kind: 'ANSWER_MEMORY_PUT', answerKey: 'cat:relocation', revision: '2' });
    expect(parseDockAnswerMemoryReply({ kind: 'ANSWER_MEMORY_SETTINGS', settings: { enabled: true, autoReuse: true } })).toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings: { enabled: true, autoReuse: true } });
    expect(parseDockAnswerMemoryReply({ kind: 'REFUSED', code: 'AUTH_REQUIRED' })).toEqual({ kind: 'REFUSED', code: 'AUTH_REQUIRED' });
    expect(parseDockAnswerMemoryReply({ kind: 'REFUSED', code: 'HUH' })).toBeNull();
  });
});
