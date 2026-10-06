import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyWriteResult } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 「轮到这一栏」与「已写进网页、等确认」两声（2026-09-23 浮层的进度卡）。
 *
 * 进度卡上只显示当前这一项，进度条分两层走：写入先往前推，确认跟在后面。文本类的回读排在整轮
 * 写完之后，所以「值已经在网页上了」与「网站确认了」之间有一段真实的时间——这两声就是为了让
 * 这段时间看得见。与逐栏结算同一条纪律：只给下标，抛出来就不再广播，整轮结论一个字不变。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = { firstName: 'Ada', email: 'ada@example.test' };

async function run(hooks: {
  onFieldStart?: (index: number) => void;
  onFieldWritten?: (index: number) => void;
  onFieldSettled?: (index: number, result: ApplyWriteResult) => void;
}) {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="email">Email</label><input id="email" type="email" />
    </form>`;
  const root = greenhouseAdapter.resolveRoot(document)!;
  const plan = buildApplyPlan({ vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] }, PROFILE);
  return runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
    journal: createUndoJournal(),
    root,
    policy: testApplyPolicy(),
    lateRecheckMs: 200,
    lateRecheckDelay: async () => {},
    ...hooks,
  });
}

describe('轮到这一栏 / 已写入等确认', () => {
  it('每一栏先报轮到、再报写进网页，都在它结算之前', async () => {
    const events: string[] = [];
    const summary = await run({
      onFieldStart: (index) => events.push(`start:${index}`),
      onFieldWritten: (index) => events.push(`written:${index}`),
      onFieldSettled: (index, result) => events.push(`settled:${index}:${result.ok ? 'ok' : result.reason}`),
    });
    expect(summary.filled).toBe(2);
    for (const index of [0, 1]) {
      const start = events.indexOf(`start:${index}`);
      const written = events.indexOf(`written:${index}`);
      const settled = events.indexOf(`settled:${index}:ok`);
      expect(start, `第 ${index} 栏没报轮到`).toBeGreaterThanOrEqual(0);
      expect(written).toBeGreaterThan(start);
      expect(settled, '文本类的回读排在整轮写完之后：写进网页先于确认').toBeGreaterThan(written);
    }
  });

  it('钩子抛错不改变整轮结论，之后也不再广播', async () => {
    let starts = 0;
    const summary = await run({
      onFieldStart: () => { starts += 1; throw new Error('display broke'); },
      onFieldWritten: () => { throw new Error('display broke'); },
    });
    expect(summary.filled).toBe(2);
    expect(starts, '抛过一次就不再广播').toBe(1);
  });

  it('不接这两声时行为与今天逐字一致', async () => {
    const summary = await run({});
    expect(summary.filled).toBe(2);
  });
});
