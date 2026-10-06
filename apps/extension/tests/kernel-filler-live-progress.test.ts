// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { createBundledApplyPolicy } from '@edaix/apply-kernel/policy';
import type { AuditView } from '@edaix/apply-kernel/audit';
import type { ExecutionGrant, FillProgress } from '@edaix/agent-channel';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import { scanCurrentPage } from '../lib/kernelScanner';
import { fillFromGrant, type KernelFillAudit } from '../lib/kernelFiller';
import { dockProgressFromAudit } from '../lib/autofillDockProgress';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * 中段屏：一轮**正在跑**的时候，逐栏亮起来（CAP-AF-063）。
 *
 * 在此之前，dock 的那张单子只有跑完之后才存在——它的唯一数据源是终局的
 * `AuditView`。于是用户点下 Autofill 之后的那几秒里，屏幕上没有任何东西说明
 * 我们正在改他的表单、改到哪一栏了。
 *
 * ## 为什么交出去的是 `AuditView` 而不是 `key → { label, required }`
 *
 * 按 key 把结果对回行，是 `audit.ts` 明文禁止的那件事（2026-08-22 修）：行内
 * 角色接进来之后，两段经历就是两个 `experience.company`，按 key 对回会把第 1 行
 * 的结果贴到每一行上——第 2 行明明写失败了，面板显示绿色"已填"。中段屏若自己
 * 按 key 拼一次，等于把那个 bug 原样请回来，而且请回到用户提交前唯一会看的那张单子上。
 *
 * 所以行集合、顺序、必填分母与档位判定全部只有一个权威：`buildAuditView`。
 * 中段屏与终局屏是**同一张单子**，只是结算进度不同——跑完那一刻不会有任何一行
 * 凭空出现或消失。
 *
 * ## 边界
 *
 * 这份视图带着宿主标签，走的是与审计面板同一条本地通道：不过桥、不进回执、
 * 不进遥测。回执那一侧仍然只有 key/ok/原因码（`ReceiptFieldOutcome` 的
 * `label?: never` 把这条边界钉成了类型）。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const GH_LOC = {
  hostname: 'job-boards.greenhouse.io',
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/acme/jobs/12345',
};

function mountGreenhouseForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="last_name">Last name*</label>
      <input id="last_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      <label for="salary">Desired salary</label>
      <input id="salary" type="text" />
    </form>`;
}

const PROFILE = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' };

function grantFor(keys: readonly string[]): ExecutionGrant {
  return {
    missionId: 'm_1',
    missionStepId: 'ms_1',
    fieldKeys: keys,
    allowedActions: ['FILL'],
    executionLease: 'lease_test_1',
    leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
    intentVersion: 1,
    planDigest: `sha256:${'b'.repeat(64)}`,
    jobIdentityHash: `sha256:${'a'.repeat(64)}`,
    fieldSchemaVersion: 1,
    profileSnapshot: { revision: '7', deletionEpoch: '0', snapshotDigest: `sha256:${'c'.repeat(64)}` },
  };
}

const freshPolicy = () => createBundledApplyPolicy(Date.now());

interface Recorded {
  readonly live: AuditView[];
  readonly audits: KernelFillAudit[];
  readonly order: string[];
  readonly outcomes: ReceiptFieldOutcome[];
}

async function fill(): Promise<Recorded> {
  mountGreenhouseForm();
  const { scan } = await scanCurrentPage(document, GH_LOC);
  const recorded: Recorded = { live: [], audits: [], order: [], outcomes: [] };
  const progress: FillProgress = {
    onOutcome: (outcome) => recorded.outcomes.push(outcome),
    shouldStop: () => false,
  };
  await fillFromGrant({
    grant: grantFor(scan!.fieldKeys),
    scan: scan!,
    profile: PROFILE,
    progress,
    policy: freshPolicy(),
    onProgress: (view) => { recorded.live.push(view); recorded.order.push('live'); },
    onAudit: (audit) => { recorded.audits.push(audit); recorded.order.push('audit'); },
  });
  return recorded;
}

const labels = (view: AuditView) => view.rows.map((row) => row.label);
const doneCount = (view: AuditView) =>
  dockProgressFromAudit('r', view).rows.filter((row) => row.done).length;

describe('中段屏的逐栏进度', () => {
  it('一轮开始时就交出整张单子，不等跑完', async () => {
    const { live, order } = await fill();

    expect(live.length, '整轮跑完之前一份进度都没交出来——中段屏还是空的').toBeGreaterThan(0);
    expect(order[0], '第一份进度排在终局审计之后——那不叫进度，那叫结果').toBe('live');
    // 分母必须一开始就齐：先报「必填 0/1」再涨到「0/3」，比不报更糟。
    expect(live[0].requiredTotal).toBe(3);
    expect(doneCount(live[0]), '还没写就已经有栏目亮着绿勾').toBe(0);
  });

  it('逐栏亮起来：进度里已完成的栏目单调增长到终局', async () => {
    const { live, audits } = await fill();

    const counts = live.map(doneCount);
    expect(counts.some((count) => count > 0), '从头到尾没有任何一栏亮起来').toBe(true);
    for (const [index, count] of counts.entries()) {
      if (index > 0) expect(count, '中段屏把已经亮起的栏目又熄了').toBeGreaterThanOrEqual(counts[index - 1]!);
    }
    expect(counts.at(-1)).toBe(doneCount(audits[0].view));
  });

  it('中段屏与终局屏是同一张单子——跑完不会有行凭空出现或消失', async () => {
    const { live, audits } = await fill();
    const settled = audits[0].view;

    for (const view of live) {
      expect(labels(view), '一轮结束时单子的行变了，用户以为某一栏不存在').toEqual(labels(settled));
      expect(view.requiredTotal, '必填分母中途变了').toBe(settled.requiredTotal);
    }
  });

  it('进度带着宿主标签走本地通道，回执一个字都不多', async () => {
    const { live, outcomes } = await fill();

    // 本地这一侧：标签在，否则中段屏没有东西可显示。
    expect(labels(live[0])).toContain('First name');
    // 过桥那一侧：Data-L1 一个标签、一个值都不许上去。
    const wire = JSON.stringify(outcomes);
    for (const leaked of ['Ada', 'Lovelace', 'ada@example.test', 'First name', 'Desired salary']) {
      expect(wire, `回执里带上了「${leaked}」——Data-L1 越过了本地 UI 边界`).not.toContain(leaked);
    }
    for (const outcome of outcomes) {
      expect(Object.keys(outcome).sort()).toEqual(outcome.ok ? ['key', 'ok'] : ['key', 'ok', 'reason']);
    }
  });

  /**
   * 中段屏与终局屏共用 `dockProgressFromAudit` 这一个映射，所以
   * FILLED / FILLED_UNVERIFIED 的分开显示是**结构性**保证的，不是两处各写一遍
   * 的约定。这条锁住"共用"本身：进度交出去的是带档位的视图，不是已经拍平的
   * done 布尔——一旦有人在中段屏那一侧自己拍平，这条就红。
   */
  it('进度交出的是带档位的视图，FILLED_UNVERIFIED 的分档由同一个映射决定', async () => {
    const { live } = await fill();
    for (const row of live[0].rows) expect(typeof row.status).toBe('string');
    expect(live[0].rows.every((row) => row.status !== 'FILLED_UNVERIFIED')).toBe(true);
  });
});
