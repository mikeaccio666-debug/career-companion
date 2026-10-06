// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBundledApplyPolicy } from '@edaix/apply-kernel/policy';
import { resolveScanRootMutationPolicy } from '@edaix/apply-kernel/scanRoot';
import type { NeedsUserInputKind, ReceiptFieldOutcome } from '@edaix/contracts/draft';
import type { ExecutionGrant, FillProgress } from '@edaix/agent-channel';
import { scanCurrentPage } from '../lib/kernelScanner';
import { fillFromGrant, type KernelFillAudit } from '../lib/kernelFiller';
import { installScanMutationThrottle } from '../lib/scanMutationThrottle';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * 刀五收尾特征测试：filler 从桩变真——同一份扫描产物进 kernel 执行链
 * （buildApplyPlan → mintIntentAuthority → runApplyPlan），字段值真的写进
 * DOM，回执只出 key/原因码。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const GH_LOC = {
  hostname: 'job-boards.greenhouse.io',
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/acme/jobs/12345',
};

function mountGreenhouseForm(extraField = ''): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="last_name">Last name*</label>
      <input id="last_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      ${extraField}
    </form>`;
}

const PROFILE = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' };

function grantFor(keys: readonly string[], overrides: Partial<ExecutionGrant> = {}): ExecutionGrant {
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
    profileSnapshot: {
      revision: '7',
      deletionEpoch: '0',
      snapshotDigest: `sha256:${'c'.repeat(64)}`,
    },
    ...overrides,
  };
}

function progressRecorder() {
  const outcomes: ReceiptFieldOutcome[] = [];
  const needs: Array<{ kind: NeedsUserInputKind; fieldKey?: string }> = [];
  const progress: FillProgress = {
    onOutcome: (o) => outcomes.push(o),
    onNeedsUserInput: (kind, fieldKey) =>
      needs.push(fieldKey === undefined ? { kind } : { kind, fieldKey }),
    shouldStop: () => false,
  };
  return { progress, outcomes, needs };
}

// bundled policy 自带 30 天硬过期（相对构建时刻）；测试注入新鲜 builtAt
// 保持确定性，不然这套测试会在某个日期后无声全红。
const freshPolicy = () => createBundledApplyPolicy(Date.now());

const inputValue = (id: string) => document.querySelector<HTMLInputElement>(id)!.value;

/**
 * happy-dom 的 Event 没有浏览器填入的 isTrusted，composedPath 也不含 shadow 链。
 * 只在测试替身上补这两样；生产代码仍只接受浏览器给出的真实手势
 * （grant.ts mintAuthority：isTrusted + eventComesFromShadow）。
 */
function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  return { event, shadowRoot };
}

/**
 * 审计面板的接线（CAP-AF-063 第③件）。
 *
 * 这个项目在同一个形状上栽过四次：实现写好了、单测全绿、**从来没有调用方**
 * （蜜罐守卫、推荐人守卫、JOB_DEPENDENT、createApplySession）。所以视图与面板
 * 各自的单测都不算数，这一组锁的是"执行链真的把它交出来了"。
 */
describe('审计视图的出口', () => {
  it('跑完一轮把逐字段审计视图交给调用方', async () => {
    mountGreenhouseForm(
      '<label for="salary">Desired salary</label><input id="salary" type="text" />',
    );
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const seen: KernelFillAudit[] = [];

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => seen.push(audit),
    });

    expect(seen, '执行链跑完了，审计视图一次都没交出来——面板永远是空的').toHaveLength(1);
    const labels = seen[0].view.rows.map((row) => row.label);
    expect(labels).toContain('First name');
    expect(
      labels,
      '只能用户自己答的题没进审计视图——用户在提交前看不到它还空着',
    ).toContain('Desired salary');
    expect(seen[0].view.requiredTotal).toBeGreaterThan(0);
  });

  it('审计视图绝不混进回执——回执只有 key/ok/原因码', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();

    const result = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: () => {},
    });

    // 面板显示宿主标签与我们写入的值——那是**本地 UI 边界之内**。回执要过桥、
    // 进服务端、可能进日志，一个标签或一个值都不许上去（Data-L1）。
    const wire = JSON.stringify([...result, ...outcomes]);
    for (const leaked of ['Ada', 'Lovelace', 'ada@example.test', 'First name', 'Email']) {
      expect(wire, `回执里带上了「${leaked}」——Data-L1 越过了本地 UI 边界`).not.toContain(leaked);
    }
    for (const outcome of [...result, ...outcomes]) {
      expect(Object.keys(outcome).sort()).toEqual(
        outcome.ok ? ['key', 'ok'] : ['key', 'ok', 'reason'],
      );
    }
  });

  it('journal 活过这一轮，撤销按钮才有得摆', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const seen: KernelFillAudit[] = [];

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => seen.push(audit),
    });

    // 此前 journal 是就地 new、就地丢的，"写入可撤销"这条铁律承诺在真实
    // 执行链上一次都没兑现过。
    expect(seen[0].canUndo(), '写完三栏却报"没什么可撤销"——journal 又被丢掉了').toBe(true);
  });

  it('用户在我方浮层里的真实点击能把本轮写入还原回去', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const seen: KernelFillAudit[] = [];

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => seen.push(audit),
    });
    expect(inputValue('#first_name')).toBe('Ada');

    const gesture = trustedShadowClick();
    await seen[0].undoAll(gesture.event, gesture.shadowRoot);

    // 反面那条只证明"合成事件撤不动"，它对"还原整个坏掉了"同样是绿的。
    // 这一条是它的正面配对：授权链通过时必须真的还原。
    expect(inputValue('#first_name'), '真实手势也没能还原——撤销按钮是个摆设').toBe('');
    expect(inputValue('#email')).toBe('');
    expect(seen[0].canUndo(), '还原之后 journal 还说有东西可撤').toBe(false);
  });

  /**
   * 取消之后的收口姿势。
   *
   * 复核里有人把「取消不回滚已写入的值」记成 bug。**它不是**——自动擦掉是破坏性
   * 默认：用户点停可能只是想接手自己填，我们把已写的抹掉会连带卷走他刚补的内容，
   * 而且那一下不可逆。runner 的 abort 分支走的是 `preserveUndoForChangedHostValue`，
   * 语义是「值留着，但**还原这条路留着**」。
   *
   * 所以正确的要求不是"取消要回滚"，是**取消之后撤销入口必须还在**。这一条把它钉住：
   * 停完之后 journal 仍可还原、审计视图照常交出——否则用户停下来，看着半张填好的表，
   * 没有任何回头路。
   */
  it('取消之后：值保留、撤销入口仍在、审计视图照常交出', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const outcomes: ReceiptFieldOutcome[] = [];
    const seen: KernelFillAudit[] = [];
    // 第一条写完就要求停：既保证真的写进去过，又保证中止发生在收口之前。
    let stop = false;
    const progress: FillProgress = {
      onOutcome: (o) => outcomes.push(o),
      onNeedsUserInput: () => {},
      shouldStop: () => stop,
    };

    const run = fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => seen.push(audit),
    });
    stop = true;
    await run;

    expect(seen, '取消之后审计视图没交出来——用户停下来看着半张表，没有任何交代').toHaveLength(1);
    expect(
      seen[0].canUndo(),
      '取消之后 journal 报"没什么可撤销"——用户停下来却回不了头',
    ).toBe(true);
  });

  it('scan generation 已失效时，外部 abort signal 在首个写入检查点前 fail closed', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const controller = new AbortController();
    controller.abort();

    const outcomes = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      signal: controller.signal,
      policy: freshPolicy(),
    });

    expect(outcomes.every((outcome) => !outcome.ok && outcome.reason === 'ABORTED')).toBe(true);
    expect(inputValue('#first_name')).toBe('');
    expect(inputValue('#last_name')).toBe('');
    expect(inputValue('#email')).toBe('');
  });

  it('真实 runner 在每个 host write 后交付 mutation，并在新控件出现时停止后续字段', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const controller = new AbortController();
    const mutationPolicy = resolveScanRootMutationPolicy(scan!.descriptor.root);
    expect(mutationPolicy).not.toBeNull();
    const observer = installScanMutationThrottle({
      policy: mutationPolicy!,
      onInvalidate: () => controller.abort(),
    });
    expect(observer).not.toBeNull();

    document.querySelector('#first_name')!.addEventListener('input', () => {
      const late = document.createElement('input');
      late.id = 'late-required-field';
      late.required = true;
      document.querySelector('#application-form')!.append(late);
    }, { once: true });

    const outcomes = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      signal: controller.signal,
      policy: freshPolicy(),
    });

    observer?.dispose();
    expect(controller.signal.aborted).toBe(true);
    expect(inputValue('#first_name')).toBe('Ada');
    expect(inputValue('#last_name')).toBe('');
    expect(inputValue('#email')).toBe('');
    expect(outcomes.filter((outcome) =>
      outcome.key === 'lastName' || outcome.key === 'email'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'lastName', ok: false, reason: 'ABORTED' }),
        expect.objectContaining({ key: 'email', ok: false, reason: 'ABORTED' }),
      ]));
  });

  it('existing host 后挂 ShadowRoot 没有 MutationRecord，也会在下一字段前 fail closed', async () => {
    mountGreenhouseForm('<x-late-shadow id="late-shadow-host"></x-late-shadow>');
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const mutationPolicy = resolveScanRootMutationPolicy(scan!.descriptor.root);
    expect(mutationPolicy).not.toBeNull();
    const host = document.querySelector('#late-shadow-host')!;

    document.querySelector('#first_name')!.addEventListener('input', () => {
      host.attachShadow({ mode: 'open' });
    }, { once: true });

    const outcomes = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      scanStillCurrent: () => mutationPolicy!.isExecutionCurrent(),
      policy: freshPolicy(),
    });

    expect(inputValue('#first_name')).toBe('Ada');
    expect(inputValue('#last_name')).toBe('');
    expect(inputValue('#email')).toBe('');
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'lastName', ok: false, reason: 'ABORTED' }),
      expect.objectContaining({ key: 'email', ok: false, reason: 'ABORTED' }),
    ]));
  });

  it('缺 rule-owned option/readback/Undo seam 时 production combobox 零点击 disabled', async () => {
    mountGreenhouseForm(`
      <label id="location-label" for="location">Location</label>
      <div class="select-shell">
        <input id="location" type="text" role="combobox"
               aria-expanded="false" aria-haspopup="true" aria-labelledby="location-label" />
        <div id="location-options"></div>
      </div>`);
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const controller = new AbortController();
    const mutationPolicy = resolveScanRootMutationPolicy(scan!.descriptor.root);
    const observer = installScanMutationThrottle({
      policy: mutationPolicy!,
      onInvalidate: () => controller.abort(),
    });
    const trigger = document.querySelector('#location')!;
    const slot = document.querySelector('#location-options')!;
    let triggerClicks = 0;
    trigger.addEventListener('click', () => {
      triggerClicks += 1;
      setTimeout(() => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = 'United States';
        option.addEventListener('click', () => slot.replaceChildren());
        slot.append(option);
      }, 0);
    }, { once: true });

    const outcomes = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { ...PROFILE, location: 'United States' },
      progress,
      signal: controller.signal,
      policy: freshPolicy(),
    });

    observer?.dispose();
    expect(controller.signal.aborted).toBe(false);
    expect(outcomes).toContainEqual({
      key: 'location',
      ok: false,
      reason: 'CAPABILITY_DISABLED',
    });
    expect(triggerClicks).toBe(0);
    expect(slot.childElementCount).toBe(0);
  });

  it('还原要走授权链：伪造的（非用户点击）事件撤不动任何东西', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const seen: KernelFillAudit[] = [];

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => seen.push(audit),
    });
    expect(inputValue('#first_name')).toBe('Ada');

    // 脚本造的事件 isTrusted=false。宿主页面若能凭一个合成事件驱动我们的
    // 还原，它就能拿我们当写入原语用。
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    document.documentElement.append(host);
    await seen[0].undoAll(new Event('click'), shadow);

    expect(inputValue('#first_name'), '合成事件把写入撤掉了——授权链形同虚设').toBe('Ada');
    host.remove();
  });
});

describe('kernel filler（真实执行链）', () => {
  it('整链真填：grant 覆盖全部字段 → DOM 写入 + 回执全 ok + 逐条上报', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();

    const result = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(result).toHaveLength(3);
    expect(result.every((o) => o.ok)).toBe(true);
    expect([...result.map((o) => o.key)].sort()).toEqual(['email', 'firstName', 'lastName']);
    expect(inputValue('#first_name')).toBe('Ada');
    expect(inputValue('#last_name')).toBe('Lovelace');
    expect(inputValue('#email')).toBe('ada@example.test');
    expect(outcomes).toEqual([...result]);
  });

  it('蜜罐字段绝不提示用户处理——哪怕它标了 required', async () => {
    // 反爬蜜罐：填了就作废整份申请。今天 filler 对所有 required 的跳过项
    // 一律发 needs-user-input，于是一个 required 蜜罐会变成"请你自己处理
    // 这个字段"——那是主动把用户推去踩陷阱。engine 的 summarizePlan 早就
    // 把蜜罐排除在分母外（"它们永远不该被填"），filler 这侧没跟上。
    mountGreenhouseForm(
      '<label for="beecatcher">Leave this field blank</label>' +
        '<input id="beecatcher" name="beecatcher" type="text" required />',
    );
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, needs } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(needs, '蜜罐被当成"请用户自己处理"上报了——用户照做即作废申请').toEqual([]);
    expect(document.querySelector<HTMLInputElement>('#beecatcher')!.value, '蜜罐被写了').toBe('');
  });

  it('推荐人字段绝不提示用户处理——哪怕它标了 required', async () => {
    // NEVER_PROMPT_REASONS 声称保护 HONEYPOT 和 OTHER_PERSON 两类，但此前只有
    // 蜜罐一类有 filler 层用例：把 'OTHER_PERSON' 从那个集合里删掉，全部测试
    // 仍会绿（审查意见 PR #11 [高]，2026-08-16）。
    //
    // 这一类的危害与蜜罐不同但同样实在：守卫拦下的既有真推荐人栏，也有
    // "本人字段被推荐人正则误命中"的那一档。误命中时提示会把用户引去把**本人**
    // 资料填进推荐人栏——recruiter 收到一份推荐人等于本人的申请，而用户复核
    // 最容易略过绿色条目。拿不准时选不提示：那一栏在页面上本来就看得见。
    mountGreenhouseForm(
      '<label for="reference_name">Reference Name</label>' +
        '<input id="reference_name" name="reference_name" type="text" required />',
    );
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, needs } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(needs, '推荐人字段被当成"请用户自己处理"上报了——误命中时会诱导用户把本人资料填进推荐人栏').toEqual([]);
    expect(
      document.querySelector<HTMLInputElement>('#reference_name')!.value,
      '推荐人字段被写了',
    ).toBe('');
  });

  it('反向断言：普通 required 缺值仍要提示一次（闭集不许被误扩）', async () => {
    // 上面两条只证明"这两类不提示"。如果有人把 NEVER_PROMPT_REASONS 扩成
    // 「所有 required 跳过项都不提示」，那两条照样绿——用户就再也收不到
    // "这栏得你自己填"的提示，静默漏填。这条守住闭集的另一边。
    mountGreenhouseForm(
      '<label for="salary">What are your salary expectations?</label>' +
        '<input id="salary" name="salary" type="text" required />',
    );
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, needs } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(
      needs,
      '普通 required 跳过项没有上报 IN_PAGE_ACTION——闭集被误扩，用户会静默漏填',
    ).toEqual([{ kind: 'IN_PAGE_ACTION' }]);
  });

  it('claim 后页面多出字段 → 超出 grant 的不写（LEASE_INVALID），其余照填', async () => {
    mountGreenhouseForm('<label for="phone">Phone*</label><input id="phone" type="tel" required />');
    const { scan } = await scanCurrentPage(document, GH_LOC);
    expect(scan!.fieldKeys).toContain('phone');

    const { progress } = progressRecorder();
    const result = await fillFromGrant({
      grant: grantFor(['email', 'firstName', 'lastName']), // 服务端只批了三个
      scan: scan!,
      profile: { ...PROFILE, phone: '+1 555 0100' },
      progress,
      policy: freshPolicy(),
    });

    expect(result.find((o) => o.key === 'phone')).toEqual({
      key: 'phone',
      ok: false,
      reason: 'LEASE_INVALID',
    });
    expect(inputValue('#phone')).toBe('');
    expect(inputValue('#email')).toBe('ada@example.test');
  });

  // 审计视图的结果按下标对回计划条目。租约挡掉的条目夹在中间时，从前把「可跑的结果 + 被挡的结果」
  // 首尾相接喂进去，下标整体错位：已经填上的 Email 在面板上成了「没跑到」，被挡的那一栏也对不上。
  it('租约挡掉的字段夹在中间时，审计视图每一行仍是它自己的结局', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const seen: KernelFillAudit[] = [];

    await fillFromGrant({
      grant: grantFor(['firstName', 'email']), // Last name 在两者之间，没被批准
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => seen.push(audit),
    });

    expect(inputValue('#first_name')).toBe('Ada');
    expect(inputValue('#last_name')).toBe('');
    expect(inputValue('#email')).toBe('ada@example.test');
    expect(seen[0]!.view.rows.map((row) => [row.label, row.status, row.reason])).toEqual([
      ['First name', 'FILLED', null],
      ['Last name', 'FAILED', 'LEASE_INVALID'],
      ['Email', 'FILLED', null],
    ]);
    expect(seen[0]!.view.filled).toBe(2);
  });

  it('lease 已过期 → 拒铸票据，一个字段都不写（fail-closed）', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();

    const result = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys, { leaseExpiresAt: Math.floor(Date.now() / 1000) - 5 }),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(result).toHaveLength(3);
    expect(result.every((o) => !o.ok && o.reason === 'LEASE_EXPIRED')).toBe(true);
    expect(inputValue('#first_name')).toBe('');
    expect(inputValue('#email')).toBe('');
    expect(outcomes).toEqual([...result]);
  });

  it('必填字段缺档案值 → CHAT_ANSWER 并带 canonical key（问一次、存回档案）', async () => {
    // 这一条此前锁的是「只产出 IN_PAGE_ACTION」的现状，而缺 email 恰恰是
    // 最该在 chat 里问一次、答案写回档案、下次不用再问的那一类
    // （PD-2026-08-18-PROFILE-QUESTION-MODEL）。契约明文允许 CHAT_ANSWER 带 key：
    // 「CHAT_ANSWER / SENSITIVE_CONFIRM 时给字段 key；IN_PAGE_ACTION 不携带任何定位信息」。
    // canonical key 是 11 成员闭集里的一个名字，不是值——Data-L1 不受影响。
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, needs } = progressRecorder();

    const result = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { firstName: 'Ada', lastName: 'Lovelace' }, // 没有 email
      progress,
      policy: freshPolicy(),
      // 闭环（T2 问答回路 + T3 写回 Profile）接通后才开；默认关时退回页面动作。
      chatAnswerEnabled: true,
    });

    expect(needs).toEqual([{ kind: 'CHAT_ANSWER', fieldKey: 'email' }]);
    expect(result.map((o) => o.key)).not.toContain('email');
    // ⚠️ CHAT_ANSWER 收口，所以它必须在**填完之后**才发：在填写之前发，
    // 整轮会停在 USER_ACTION_REQUIRED，用户点一次 Fill 什么都没发生。
    expect(result.every((o) => o.ok), '收口发早了——该填的两栏没填上').toBe(true);
    expect(inputValue('#first_name'), '问题发得太早，把这一轮的写入掐掉了').toBe('Ada');
  });

  it('默认关：闭环没接通时仍走 IN_PAGE_ACTION，行为与今天逐字一致', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, needs } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { firstName: 'Ada', lastName: 'Lovelace' },
      progress,
      policy: freshPolicy(),
    });

    expect(needs, '默认就发了收口帧——run 会停下来而没人问用户任何问题').toEqual([
      { kind: 'IN_PAGE_ACTION' },
    ]);
  });

  it('填不了的控件 → IN_PAGE_ACTION，且不带任何定位信息', async () => {
    // Data-L1：IN_PAGE_ACTION 是"你去那张表上自己弄"，我方不提供任何定位线索。
    mountGreenhouseForm(
      '<label for="cover">Cover letter</label><div id="cover" contenteditable="true" aria-required="true"></div>',
    );
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, needs } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(needs).toEqual([{ kind: 'IN_PAGE_ACTION' }]);
    expect(
      needs.every((n) => n.fieldKey === undefined),
      'IN_PAGE_ACTION 带上了定位信息——契约逐字禁止',
    ).toBe(true);
  });

  it('Data-L1：回执序列化后无字段值、无标签文案', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();

    const result = await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    expect(JSON.stringify(result)).not.toMatch(/Ada|Lovelace|ada@example\.test|First name/);
  });
});

/**
 * 蜜罐第三道防线在**真实填写路径**上的接线证明（CAP-AF-057）。
 *
 * kernel 里 `isHoneypotGeometry` 早就实现、`engine.ts` 现在也接了，但 kernel
 * 不碰浏览器 API——测量手段由内容脚本注入。这条锁的就是那根线：如果
 * `kernelFiller.ts` 忘了传 `readGeometry`，纯 CSS 藏起来的陷阱会被真的写进去。
 *
 * 本项目同一形状的问题犯过四次（蜜罐守卫、推荐人守卫、JOB_DEPENDENT、守卫
 * 顺序），都是"写好了、单测全绿、没有调用方"。所以这条测试断言的是**写入
 * 结果**，不是源码里有没有那个字符串。
 */
describe('蜜罐几何层接进了真实填写路径', () => {
  function stubRect(id: string, width: number, height: number): void {
    const element = document.querySelector<HTMLElement>(id)!;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it('1×1 藏起来的 portfolio 陷阱不会被写入——文案与身份都干净', async () => {
    mountGreenhouseForm(
      '<label for="portfolio">Portfolio</label><input id="portfolio" type="url" />',
    );
    // 其余字段是正常盒子；只有陷阱退化。整表全退化的安全网因此不会误关这道防线。
    stubRect('#first_name', 240, 32);
    stubRect('#last_name', 240, 32);
    stubRect('#email', 240, 32);
    stubRect('#portfolio', 1, 1);

    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { ...PROFILE, portfolioUrl: 'https://ada.example.test' },
      progress,
      policy: freshPolicy(),
    });

    expect(
      inputValue('#portfolio'),
      '纯 CSS 藏起来的陷阱被真的填了——整份申请会被静默判为 bot 丢弃',
    ).toBe('');
    expect(inputValue('#email'), '正常字段被误伤').toBe(PROFILE.email);
  });

  it('反向探针：正常尺寸的 portfolio 照常填入（防止这道防线被误扩成全拦）', async () => {
    mountGreenhouseForm(
      '<label for="portfolio">Portfolio</label><input id="portfolio" type="url" />',
    );
    stubRect('#first_name', 240, 32);
    stubRect('#last_name', 240, 32);
    stubRect('#email', 240, 32);
    stubRect('#portfolio', 240, 32);

    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { ...PROFILE, portfolioUrl: 'https://ada.example.test' },
      progress,
      policy: freshPolicy(),
    });

    expect(inputValue('#portfolio'), '几何层把正常字段也拦了').toBe('https://ada.example.test');
  });
});

/**
 * 宿主校验错误在**真实填写路径**上的接线证明（CAP-AF-068）。
 *
 * 回读判决只回答「我们写的值还在不在」。这条证明整链现在也回答
 * 「宿主接不接受」——否则面板报「已填 N/N」而页面上红着错误，
 * 用户点提交才发现，而「回读判决 + 逐字段可审计」正是我们的差异化卖点。
 */
describe('宿主校验判决接进了真实填写路径', () => {
  it('值写进去了但宿主标 aria-invalid → 报 HOST_REJECTED，不报成功', async () => {
    mountGreenhouseForm('');
    // 宿主的业务规则：这个邮箱已经申请过了。浏览器看不见，宿主看得见。
    document.querySelector('#email')!.setAttribute('aria-invalid', 'true');

    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    const email = outcomes.find((outcome) => outcome.key === 'email');
    expect(
      email,
      'email 根本没进回执',
    ).toBeDefined();
    expect(
      email!.ok,
      '值留住了就报成功——面板会说「已填」而页面红着错误',
    ).toBe(false);
    expect(email!.reason).toBe('HOST_REJECTED');
    // 值确实写进去了：这条不是"没写成"，是"写成了但对方不收"。
    expect(inputValue('#email')).toBe(PROFILE.email);
  });

  it('反向探针：宿主没表态时照常报成功（不能把沉默当拒收）', async () => {
    mountGreenhouseForm('');
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    const email = outcomes.find((outcome) => outcome.key === 'email');
    expect(
      email!.ok,
      '宿主没表态被当成了拒收——填好的字段会被重试阶梯反复重写',
    ).toBe(true);
  });

  it('宿主的 pattern 写坏了、一读 validity.valid 就抛异常 → 这一轮照常跑完，不被一个字段打断', async () => {
    // 2026-09-22 测试台上扩展的 runtimeErrors 里连着三条：宿主 email 输入框的 pattern
    // 在 Chrome 的 v 标志正则下不合法，读 `validity.valid` 直接抛
    // 「SyntaxError: Failed to read the 'valid' property from 'ValidityState'」。
    // 写后读宿主校验那一步没有接住它，于是异常一路抛出去，整轮填写断在这一栏：
    // 后面的字段一个都不处理，浮层也拿不到这一轮的审计。
    mountGreenhouseForm('');
    const email = document.querySelector('#email') as HTMLInputElement;
    Object.defineProperty(email, 'validity', {
      configurable: true,
      get: () => ({
        get valid(): boolean {
          throw new SyntaxError("Failed to read the 'valid' property from 'ValidityState': Invalid regular expression");
        },
      }),
    });
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
    });

    // 读不出这一项就当宿主没在这一项上表态；aria-invalid 与红字两路照常判。
    expect(outcomes.find((outcome) => outcome.key === 'email')?.ok).toBe(true);
    expect(inputValue('#email')).toBe(PROFILE.email);
    expect(outcomes.find((outcome) => outcome.key === 'lastName')?.ok, '后面的字段被这一栏拖垮了').toBe(true);
  });
});

/**
 * BambooHR uses a normal-sized input whose parent is pushed far off-screen.
 * This integration test locks the Extension geometry collector to the kernel's
 * fail-closed honeypot guard; it contains no host/path authorization logic.
 */
describe('蜜罐几何：横向坐标必须真的采集到', () => {
  it('推到视口外的陷阱不进填充计划', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="last_name">Last name*</label>
        <input id="last_name" type="text" required />
        <label for="email">Email*</label>
        <input id="email" type="email" required />
        <label for="first_name">First name</label>
        <input id="first_name" type="text" />
      </form>`;

    for (const element of document.querySelectorAll('input')) {
      const isTrap = element.id === 'first_name';
      (element as HTMLElement).getBoundingClientRect = () =>
        (isTrap
          ? {
              width: 178,
              height: 28,
              top: -9751,
              left: -9935,
              right: -9757,
              bottom: -9723,
              x: -9935,
              y: -9751,
            }
          : {
              width: 240,
              height: 32,
              top: 100,
              left: 20,
              right: 260,
              bottom: 132,
              x: 20,
              y: 100,
            }) as DOMRect;
    }

    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const audits: KernelFillAudit[] = [];
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => audits.push(audit),
    });

    expect(audits.length).toBeGreaterThan(0);
    expect(document.querySelector<HTMLInputElement>('#first_name')!.value).toBe('');
  });
});

describe('生产计划申请完整的最小能力集', () => {
  it('set-combobox capability 不得绕过缺失的 rule-owned semantic seams', async () => {
    mountGreenhouseForm(
      '<label for="location">Location</label>' +
        '<input id="location" name="location" type="text" role="combobox" aria-haspopup="listbox" />',
    );
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { ...PROFILE, location: 'United States' },
      progress,
      policy: freshPolicy(),
    });

    const location = outcomes.find((outcome) => outcome.key === 'location');
    expect(location).toEqual({
      key: 'location',
      ok: false,
      reason: 'CAPABILITY_DISABLED',
    });
  });

  it('remote policy 关闭 combobox 后生产 filler 不派发宿主点击', async () => {
    mountGreenhouseForm(
      '<label for="location">Location</label>' +
        '<input id="location" name="location" type="text" role="combobox" aria-haspopup="listbox" />',
    );
    const trigger = document.querySelector<HTMLInputElement>('#location')!;
    let clickCount = 0;
    trigger.addEventListener('click', () => { clickCount += 1; });
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    const baseline = freshPolicy();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys),
      scan: scan!,
      profile: { ...PROFILE, location: 'United States' },
      progress,
      policy: {
        ...baseline,
        capabilities: { ...baseline.capabilities, 'set-combobox': false },
      },
    });

    expect(clickCount).toBe(0);
    expect(outcomes).toContainEqual({
      key: 'location',
      ok: false,
      reason: 'CAPABILITY_DISABLED',
    });
  });
});

describe('简历供给 seam', () => {
  const RESUME_FIELD =
    '<label for="resume">Resume/CV*</label><input id="resume" name="resume" type="file" required />';

  function giveInputsRenderedBoxes(): void {
    for (const element of document.querySelectorAll<HTMLInputElement>('input')) {
      element.getBoundingClientRect = () =>
        ({
          width: 240,
          height: 32,
          top: 100,
          left: 20,
          right: 260,
          bottom: 132,
          x: 20,
          y: 100,
        }) as DOMRect;
    }
  }

  it('verified canonical target + resolver 会真实挂载文件', async () => {
    mountGreenhouseForm(RESUME_FIELD);
    giveInputsRenderedBoxes();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    let resolverCalls = 0;
    await fillFromGrant({
      grant: grantFor([...scan!.fieldKeys, 'resumeFile']),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      resume: {
        fileName: 'ada-resume.pdf',
        targetVerified: true,
        resolve: async () => {
          resolverCalls += 1;
          return new File(['%PDF-1.4'], 'ada-resume.pdf', { type: 'application/pdf' });
        },
      },
    });

    expect(resolverCalls).toBe(1);
    expect(outcomes.find((outcome) => outcome.key === 'resumeFile')?.ok).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#resume')!.files?.[0]?.name).toBe(
      'ada-resume.pdf',
    );
  });

  it('canonical target 不可验证时先拒绝，且不取 L1 字节', async () => {
    mountGreenhouseForm(RESUME_FIELD);
    giveInputsRenderedBoxes();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress } = progressRecorder();
    const audits: KernelFillAudit[] = [];
    let resolverCalls = 0;
    await fillFromGrant({
      grant: grantFor([...scan!.fieldKeys, 'resumeFile']),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      onAudit: (audit) => audits.push(audit),
      resume: {
        fileName: 'ada-resume.pdf',
        targetVerified: false,
        resolve: async () => {
          resolverCalls += 1;
          return new File(['%PDF-1.4'], 'ada-resume.pdf', { type: 'application/pdf' });
        },
      },
    });

    expect(resolverCalls).toBe(0);
    expect(audits[0]?.view.rows.find((row) => row.label.startsWith('Resume'))?.reason).toBe(
      'HOST_UNCONFIRMED',
    );
  });
});

/**
 * Independent review of #310 (2026-09-10): the audit's answer callback re-minted a write
 * authority from a click alone, outside the fill's stop signal, abort signal, lease deadline
 * and scan currentness. Each case below stops the run one way and expects zero writes.
 */
describe('审计面板的补答写入仍在本轮执行边界之内', () => {
  const WHY = '<label for="why">Why do you want to work here?</label><textarea id="why"></textarea>';

  async function auditWithQuestion(overrides: {
    shouldStop?: () => boolean;
    signal?: AbortSignal;
    scanStillCurrent?: () => boolean;
    now?: () => number;
    leaseExpiresAt?: number;
  } = {}) {
    mountGreenhouseForm(WHY);
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const recorder = progressRecorder();
    const audits: KernelFillAudit[] = [];
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys, overrides.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: overrides.leaseExpiresAt }),
      scan: scan!,
      profile: PROFILE,
      progress: { ...recorder.progress, shouldStop: overrides.shouldStop ?? (() => false) },
      ...(overrides.signal ? { signal: overrides.signal } : {}),
      scanStillCurrent: overrides.scanStillCurrent ?? (() => true),
      ...(overrides.now ? { now: overrides.now } : {}),
      policy: freshPolicy(),
      onAudit: (audit) => audits.push(audit),
    });
    const question = audits[0]!.questions.find((item) => item.text.startsWith('Why'))!;
    const answer = async () => {
      const click = trustedShadowClick();
      return audits[0]!.answer(click.event, click.shadowRoot, [{ questionId: question.questionId, value: 'Reviewed answer' }]);
    };
    return { answer };
  }

  const untouched = () => (document.getElementById('why') as HTMLTextAreaElement).value;

  it('一个真实点击能把已确认的答案写进控件（基线）', async () => {
    const { answer } = await auditWithQuestion();
    expect((await answer()).map((result) => result.ok)).toEqual([true]);
    expect(untouched()).toBe('Reviewed answer');
  });

  it('runner 已要求停止 → 零写入', async () => {
    let stopped = false;
    const { answer } = await auditWithQuestion({ shouldStop: () => stopped });
    stopped = true;
    expect(await answer()).toMatchObject([{ ok: false, reason: 'ABORTED' }]);
    expect(untouched()).toBe('');
  });

  it('外部 abort signal 已触发 → 零写入', async () => {
    const controller = new AbortController();
    const { answer } = await auditWithQuestion({ signal: controller.signal });
    controller.abort();
    expect(await answer()).toMatchObject([{ ok: false, reason: 'ABORTED' }]);
    expect(untouched()).toBe('');
  });

  it('lease 已到期 → 零写入', async () => {
    let clock = Date.now();
    const { answer } = await auditWithQuestion({ now: () => clock, leaseExpiresAt: Math.floor(clock / 1000) + 60 });
    clock += 120_000;
    expect(await answer()).toMatchObject([{ ok: false, reason: 'LEASE_INVALID' }]);
    expect(untouched()).toBe('');
  });

  it('扫描已不再是当前页面 → 零写入', async () => {
    let current = true;
    const { answer } = await auditWithQuestion({ scanStillCurrent: () => current });
    current = false;
    expect(await answer()).toMatchObject([{ ok: false, reason: 'IDENTITY_CHANGED' }]);
    expect(untouched()).toBe('');
  });
});

/**
 * Independent review round 2 (2026-09-10): the content script awaited the background recheck
 * before handing the Event to mintAuthority; by then the browser had finished dispatching and
 * composedPath() was empty, so a genuine click was refused as GESTURE_FOREIGN. The fixture
 * below behaves like a real dispatch: the path is available only until dispatch ends.
 */
describe('补答的可信手势在异步确认之前同步取证', () => {
  const WHY = '<label for="why">Why do you want to work here?</label><textarea id="why"></textarea>';

  /** A click whose composedPath() is populated only while it is being dispatched. */
  function dispatchingShadowClick(trusted = true) {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    shadowRoot.appendChild(button);
    const event = new Event('click', { bubbles: true, composed: true });
    let dispatching = true;
    Object.defineProperty(event, 'isTrusted', { value: trusted });
    Object.defineProperty(event, 'composedPath', {
      value: () => (dispatching ? [button, shadowRoot, host, document.body, document, window] : []),
    });
    return { event, shadowRoot, endDispatch: () => { dispatching = false; } };
  }

  async function auditWithQuestion(shouldStop: () => boolean = () => false) {
    mountGreenhouseForm(WHY);
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const recorder = progressRecorder();
    const audits: KernelFillAudit[] = [];
    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys), scan: scan!, profile: PROFILE,
      progress: { ...recorder.progress, shouldStop }, scanStillCurrent: () => true, policy: freshPolicy(),
      onAudit: (audit) => audits.push(audit),
    });
    const question = audits[0]!.questions.find((item) => item.text.startsWith('Why'))!;
    return { audit: audits[0]!, questionId: question.questionId };
  }
  const written = () => (document.getElementById('why') as HTMLTextAreaElement).value;
  const laterConfirmation = (verdict: boolean, onConfirm?: () => void) => async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    onConfirm?.();
    return verdict;
  };

  it('a real click survives a delayed confirmation because the proof is minted before the await', async () => {
    const { audit, questionId } = await auditWithQuestion();
    const click = dispatchingShadowClick();
    const pending = audit.answer(click.event, click.shadowRoot, [{ questionId, value: 'Reviewed answer' }], laterConfirmation(true));
    click.endDispatch();
    expect((await pending).map((result) => result.ok)).toEqual([true]);
    expect(written()).toBe('Reviewed answer');
  });

  it('a confirmation that comes back negative writes nothing', async () => {
    const { audit, questionId } = await auditWithQuestion();
    const click = dispatchingShadowClick();
    const pending = audit.answer(click.event, click.shadowRoot, [{ questionId, value: 'Reviewed answer' }], laterConfirmation(false));
    click.endDispatch();
    expect(await pending).toMatchObject([{ ok: false, reason: 'POLICY_DISABLED' }]);
    expect(written()).toBe('');
  });

  it('a click that is not trusted is refused before the confirmation even runs', async () => {
    const { audit, questionId } = await auditWithQuestion();
    const click = dispatchingShadowClick(false);
    const confirm = vi.fn(laterConfirmation(true));
    const pending = audit.answer(click.event, click.shadowRoot, [{ questionId, value: 'Reviewed answer' }], confirm);
    click.endDispatch();
    expect(await pending).toMatchObject([{ ok: false, reason: 'CAPABILITY_DISABLED' }]);
    expect(confirm).not.toHaveBeenCalled();
    expect(written()).toBe('');
  });

  it('a stop that arrives during the confirmation still writes nothing', async () => {
    let stopped = false;
    const { audit, questionId } = await auditWithQuestion(() => stopped);
    const click = dispatchingShadowClick();
    const pending = audit.answer(click.event, click.shadowRoot, [{ questionId, value: 'Reviewed answer' }], laterConfirmation(true, () => { stopped = true; }));
    click.endDispatch();
    expect(await pending).toMatchObject([{ ok: false, reason: 'ABORTED' }]);
    expect(written()).toBe('');
  });
});
