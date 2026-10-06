import { describe, expect, it } from 'vitest';
import type { AuditView } from '@edaix/apply-kernel/audit';

import { dockProgressFromAudit, dockProgressWhileFilling } from '../lib/autofillDockProgress';

/**
 * 浮层说「正在填工作经历 2/3」、把「你在浮层里答的」与「我们填的」分开、把「暂时读不到你保存的答案」挂到自我认同那几行上
 * （2026-09-28 负责人：浮层与页面的一轮体验），靠的是单子上的三样事实。这里钉住它们从审计视图带过来。
 */
const row = (label: string, key: string | null, status = 'FILLED') =>
  ({ key, label, required: true, status, reason: null, attemptedValue: null, resolvedOptionText: null }) as AuditView['rows'][number];
const view = (rows: AuditView['rows']): AuditView =>
  ({ rows, filled: 0, requiredTotal: 0, requiredHandled: 0, needsAttention: 0 }) as AuditView;

describe('单子上的三样事实（2026-09-28）', () => {
  it('经历／教育的每一格带上是第几段、共几段：同一个角色第 n 次出现就是第 n 段', () => {
    const rows = dockProgressFromAudit('r', view([
      row('First name', 'firstName'),
      row('Company', 'experience.company'), row('Title', 'experience.title'),
      row('Company', 'experience.company'), row('Title', 'experience.title'),
      row('Company', 'experience.company'),
      row('School', 'education.school'),
    ])).rows;
    expect(rows.map((one) => one.collection ?? null)).toEqual([
      null,
      { kind: 'experience', number: 1, total: 3 }, { kind: 'experience', number: 1, total: 3 },
      { kind: 'experience', number: 2, total: 3 }, { kind: 'experience', number: 2, total: 3 },
      { kind: 'experience', number: 3, total: 3 },
      { kind: 'education', number: 1, total: 1 },
    ]);
  });

  it('正在填的途中那一份也带着（进度卡据此说「正在填工作经历 2/3」）', () => {
    const rows = dockProgressWhileFilling('r', view([
      row('Company', 'experience.company'),
      { ...row('Company', 'experience.company', 'FAILED'), reason: 'ABORTED' as never },
    ])).rows;
    expect(rows[1]).toMatchObject({ state: 'PENDING', collection: { kind: 'experience', number: 2, total: 2 } });
  });

  it('用户在浮层里当场答的那一格：带上 userAnswered，与我们填的分开', () => {
    const [answered, ours] = dockProgressFromAudit('r', view([
      { ...row('School', 'question:c7'), attemptedValue: 'University of California, Berkeley', userAnswered: true } as never,
      { ...row('Email', 'email'), attemptedValue: 'alex@example.com' },
    ])).rows;
    expect(answered).toMatchObject({ state: 'CONFIRMED', userAnswered: true, value: 'University of California, Berkeley' });
    expect(ours?.userAnswered).toBeUndefined();
  });

  it('自我认同题（性别、族裔、退伍、残障……）带上 selfIdentification；别的题不带', () => {
    const rows = dockProgressFromAudit('r', view([
      { ...row('Are you Hispanic/Latino?', null, 'NEEDS_MANUAL'), reason: 'MANUAL_ONLY' as never },
      { ...row('Veteran Status', null, 'NEEDS_MANUAL'), reason: 'MANUAL_ONLY' as never },
      { ...row('May we contact your current employer?', null, 'NEEDS_MANUAL'), reason: 'MANUAL_ONLY' as never },
    ])).rows;
    expect(rows.map((one) => one.selfIdentification === true)).toEqual([true, true, false]);
  });
});
