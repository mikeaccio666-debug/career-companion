import { describe, expect, it } from 'vitest';

import {
  createDockMissionRunBeginIntent,
  createDockMissionRunFinishIntent,
  parseDockMissionRunFinishIntent,
} from '../lib/dockMissionIntent';

/**
 * 浮层任务的「这一轮填完了」（2026-09-24）：只带键、成败与稳定码。页面上有一条带不了的结果
 * （键或原因码不合形状）时丢那一条，不丢整份——否则这一轮的回执就交不上，门户一直等「已填好」。
 */
const ORIGIN = 'https://job-boards.greenhouse.io';
const PATH = '/acme/jobs/123';
const TICKET = '00000000-0000-4000-8000-00000000000a';

describe('dock/mission-run-finish', () => {
  it('drops an outcome it cannot carry, keeps the rest', () => {
    const intent = createDockMissionRunFinishIntent(ORIGIN, PATH, TICKET, [
      { key: 'firstName', ok: true },
      { key: 'question: why us?', ok: true },
      { key: 'email', ok: false, reason: 'not a stable code' },
      { key: 'lastName', ok: false, reason: 'NO_VALUE' },
    ] as never);

    expect(intent?.outcomes).toEqual([
      { key: 'firstName', ok: true },
      { key: 'email', ok: false },
      { key: 'lastName', ok: false, reason: 'NO_VALUE' },
    ]);
  });

  it('carries keys, results and codes only: anything else on an outcome refuses the message', () => {
    expect(parseDockMissionRunFinishIntent({
      kind: 'dock/mission-run-finish',
      version: createDockMissionRunBeginIntent(ORIGIN, PATH, ['email'], 'greenhouse')!.version,
      origin: ORIGIN,
      pathname: PATH,
      ticket: TICKET,
      outcomes: [{ key: 'email', ok: true, value: 'avery@example.test' }],
    })).toBeNull();
  });
});
