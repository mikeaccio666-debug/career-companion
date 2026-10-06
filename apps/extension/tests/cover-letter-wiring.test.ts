import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { COVER_LETTER_WAIT_MS } from '../lib/coverLetterSeam';

/**
 * 求职信接上了（2026-09-27）：这个项目不止一次「写好了却没有调用方」（见 packages/apply-kernel 的可达性测试头注），
 * 所以钉住两头真的接着——按下「自动填写」的那一轮会去认求职信栏、要一封、晚到了再附；worker 用与简历附件同一套
 * 发信人核对接住这条消息。
 */
const content = readFileSync(new URL('../entrypoints/apply.content.ts', import.meta.url), 'utf8');
const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

describe('求职信的两头都接上了', () => {
  it('自动填写那一轮：认栏（必填、可选都算）→ 要一封 → 几秒内到的当场交给这一轮 → 晚到的再附', () => {
    expect(content).toMatch(/coverLetterTargets\(outcome\.scan\.descriptor\)/u);
    expect(content).toMatch(/coverLetterFromWorker\(/u);
    expect(content).toMatch(/withinBudget\(letterPending, COVER_LETTER_WAIT_MS\)/u);
    expect(content).toMatch(/coverLetter: letterEarly\.material/u);
    expect(content).toMatch(/audit\?\.attachCoverLetter/u);
    // 从前只在绑着任务、而且求职信栏必填时才要：那条路不再走。
    expect(content).not.toMatch(/missionSession\.coverLetter\(/u);
  });

  it('worker：同一套发信人核对，收件人从核对过的发信页组', () => {
    const at = background.indexOf('parseDockCoverLetterIntent(message)');
    expect(at).toBeGreaterThan(0);
    const handler = background.slice(at, at + 600);
    expect(handler).toMatch(/senderTabForPageOrFrame\(sender, browser\.runtime\.id, intent, frameForms\)/u);
    expect(handler).toMatch(/coverLetterProvider\.handle\(intent, String\(tabId\)\)/u);
  });
});

/**
 * 开填之前等求职信不超过一秒（2026-10-04 测试台）：有求职信栏的页（Greenhouse、Lever、Ashby 那几页），「Matching your profile」
 * 那一段 2.0–2.8 秒，没有的页 0.4–0.8 秒——多出来的正是等信的 2.5 秒；连 AI 代答的请求也跟着晚发 2 秒。Lever 两页信根本
 * 写不出（COVER_LETTER_JOB_UNAVAILABLE）也照等。原来就有的那一封往往一秒内就回来；还在写的本来就走「写好了再附」那条路
 * （同一下点击、30 秒之内当场附上，过了就摆一颗「附上求职信」）。
 */
describe('开填之前等求职信', () => {
  it('不超过一秒：规则填写与 AI 代答都不为一封还在写的信干等', () => {
    expect(COVER_LETTER_WAIT_MS).toBeLessThanOrEqual(1_000);
  });
});
