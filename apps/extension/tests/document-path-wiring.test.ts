import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 内容脚本发给 worker 的页面消息，每一次都要经过 `withDocumentPath`（源码形状闸）。
 * 2026-09-24：dock/fill 那一种随旧的任务填写路删了；浮层任务的四种消息在 dockMissionContent.ts 里创建，
 * 经会话的 `wrap`（= withDocumentPath）发出，下面第二条钉它。
 *
 * 漏掉一处的症状只在单页应用改过地址的页面上出现，而且是静默的：worker 的发信人核对丢掉那条消息，
 * 不答复、不记诊断码。2026-09-22 草稿建立后的 Workday 申请页上就是这样——浮层只说「没能取得填写授权」。
 */
const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
// 2026-09-23：AI 代答（dock/ai-answers-intent）也过发信人核对，同一道闸。
const CREATORS = /createDock(?:ApplyMaterials|ResumeAttachment|AnswerMemory|Fill|AddJob|QuestionDraft|AiAnswers)Intent\(/g;

describe('页面消息都带上文档加载时的路径', () => {
  it('六种消息的每一次创建都包在 withDocumentPath 里', () => {
    const all = [...content.matchAll(CREATORS)];
    // 2026-09-23：新浮层没有「生成申请卡片」与「选简历」那两幕，少了两处创建。
    // 2026-09-24：dock/fill 的创建随旧的任务填写路删了，又少一处。
    expect(all.length, '一处都没找到——这条闸就没在守什么').toBeGreaterThanOrEqual(7);
    for (const match of all) {
      const before = content.slice(Math.max(0, match.index! - 'withDocumentPath('.length), match.index);
      expect(before, `第 ${content.slice(0, match.index).split('\n').length} 行的 ${match[0]} 没有经过 withDocumentPath`).toBe('withDocumentPath(');
    }
  });

  it('浮层任务的四种消息：会话以 withDocumentPath 为 wrap，会话里每一次创建都经 ask()', () => {
    expect(content).toContain('wrap: withDocumentPath,');
    const session = readFileSync(resolve(__dirname, '..', 'lib', 'dockMissionContent.ts'), 'utf8');
    const created = [...session.matchAll(/createDock(?:MissionRunBegin|MissionRunFinish|MissionCoverLetter|SubmitConfirmed)Intent\(/g)];
    expect(created, '四种消息各一处创建').toHaveLength(4);
    for (const match of created) {
      expect(session.slice(Math.max(0, match.index! - 'ask('.length), match.index), match[0]).toBe('ask(');
    }
    expect(session).toContain('const wrapped = deps.wrap(intent);');
  });
});
