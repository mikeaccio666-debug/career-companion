// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFullAiRequest, type FullAiField } from '@edaix/contracts';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import type { ExecutionGrant } from '@edaix/agent-channel';
import {
  createAiAnswersSession,
  type AiAnswersBatch,
  type AiAnswersSink,
  type KernelAiAnswersOutcome,
  type KernelAiAnswersPort,
  type KernelAiProgress,
} from '../lib/aiAnswers';
import type { AiAnswersRefusal, AiFill, AiTimingMark } from '../lib/aiAnswersIntent';
import { fillFromGesture } from '../lib/gestureFill';
import { closeGestureRun, type GestureRunDock } from '../lib/gestureRunClose';
import { fillFromGrant, type KernelFillAudit } from '../lib/kernelFiller';

installBundledApplyAdapters();

/**
 * AI 代答（2026-09-23 负责人决定）在内核填写这一层的样子。
 *
 *  · 挑题：规则答不了（没认出、开放题、选择题没数据、随岗位而定）而且空着的题才送；只能本人答的（工作授权、
 *    EEO、同意、密码）、他人信息、已经有值的一概不送。送的是不透明题号、题面、选项，按契约校验得过。
 *  · 请求在第一遍开写之前就发出去（一次点击一条流），规则那一遍从不等它：挂着不回、抛了、拒绝了，规则填的照样填、单子照样交。
 *  · 流上一批一批到（2026-09-24）：点击后 30 秒之内到的用同一张凭证写，先到的先写——选择题不等开放题；只写送出去的题，
 *    写进同一本撤销日志，单子上标 aiAnswered。
 *  · 晚到的：一个字不写，流结束后交回一个要用户再点一下的按钮（新凭证，只能用一次）；早到、已经写上的留着。
 *  · 流结束时交回没拿到答案的题（unanswered）；计时只有毫秒与个数。
 *  · 这一轮作废（新的一轮、撤销、关开关）之后回来的答案不写；用户等的时候自己填了的那一栏不覆盖。
 *  · 「用 AI 写 / AI 改写」：只写送出去过的长文本题；改写只在内容没变过时替换，替换前的内容可以撤销。
 *
 * 夹具全是合成文字，没有任何真实用户资料。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

/** 用户在我们浮层里的一次真实点击：凭证（在派发当中取），以及那一下事件与 shadow（撤销要用）。 */
function trustedClick(at: number = Date.now()) {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  let event: Event | null = null;
  button.addEventListener('click', (clicked) => {
    event = clicked;
    proof = captureTrustedShadowGesture(clicked, shadowRoot, at);
  });
  button.dispatchEvent(new TrustedClick('click'));
  expect(proof, '前置条件：凭证要取得到').not.toBeNull();
  return { proof: proof!, event: event!, shadowRoot, button };
}

function livePolicy(capabilities: Partial<ApplyPolicy['capabilities']> = {}): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return { ...base, notAfter: Date.now() + 10 * 60_000, capabilities: { ...base.capabilities, ...capabilities } };
}

const radios = (name: string, legend: string, options: readonly string[]) => `
  <fieldset id="${name}-question"><legend>${legend}</legend>
    ${options.map((text, index) => `<label><input name="${name}" type="radio" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`;

/** Greenhouse 的形状（合成）：两栏档案能填，其余是规则答不了、或只能本人答的题。 */
function mountForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" required />
      <label for="email">Email</label><input id="email" type="email" required />
      <label for="why">Why do you want to work here?</label><textarea id="why" required maxlength="400"></textarea>
      <label for="kotlin_years">How many years of Kotlin experience do you have?</label><input id="kotlin_years" type="text" />
      ${radios('kotlin', 'Do you have experience with Kotlin?', ['Yes', 'No'])}
      ${radios('auth', 'Are you legally authorized to work in the United States?', ['Yes', 'No'])}
      <label for="notes">Anything else you want us to know?</label><textarea id="notes">Already typed by me</textarea>
      <label for="pw">Password</label><input id="pw" type="password" />
      <label><input type="checkbox" id="agree" name="agree" /> I agree to the privacy policy</label>
      <label for="ref_name">Referrer name</label><input id="ref_name" type="text" />
      <label for="transcript">Transcript</label><input id="transcript" type="file" />
    </form>`;
}

const PROFILE = { firstName: 'Sample', email: 'sample.person@example.test' } as never;
const WHY = 'I want to build payment tools, which is what I did at my last job.';
const scanNow = () => ({ descriptor: readApplyForm('greenhouse', document)! }) as never;
const value = (id: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!.value;
const checked = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.parentElement?.textContent?.trim() ?? null;

/**
 * 口子：记下送了什么、流关了没有。给了 `respond` 就在下一个微任务里一次交完（响应头、一批、结束，或拒绝）；
 * 没给就由测试一批一批地交（`batch` / `end` / `refuse`）。
 */
type Respond = (fields: readonly FullAiField[]) => Readonly<{ fills: AiFill[]; noEvidence: string[] }> | Readonly<{ refused: AiAnswersRefusal }>;
function aiPort(respond?: Respond, stillCurrent?: () => boolean) {
  const sent: FullAiField[][] = [];
  const firstNameAtRequest: string[] = [];
  let sink: AiAnswersSink | null = null;
  let closed = false;
  const port: KernelAiAnswersPort = {
    request: vi.fn((fields: readonly FullAiField[], received: AiAnswersSink) => {
      sent.push([...fields]);
      firstNameAtRequest.push(value('first_name'));
      sink = received;
      if (respond !== undefined) {
        queueMicrotask(() => {
          const reply = respond(fields);
          if ('refused' in reply) {
            received.end({ ok: false, code: reply.refused });
            return;
          }
          received.opened();
          received.answers({ lane: 'fast', fills: reply.fills, noEvidence: reply.noEvidence });
          received.end({ ok: true, unanswered: [] });
        });
      }
      return () => { closed = true; };
    }),
    ...(stillCurrent === undefined ? {} : { stillCurrent }),
  };
  const live = () => sink!;
  return {
    port,
    sent,
    firstNameAtRequest,
    closed: () => closed,
    opened: () => live().opened(),
    batch: (lane: AiAnswersBatch['lane'], fills: AiFill[], noEvidence: string[] = []) => live().answers({ lane, fills, noEvidence }),
    end: (unanswered: string[] = []) => live().end({ ok: true, unanswered }),
    refuse: (code: AiAnswersRefusal) => live().end({ ok: false, code }),
  };
}

/** 让已经到了的那一批写完（内核写一批要跑几轮微任务与定时器）。最多等 5 秒：机器忙的时候一批也要写一秒多。 */
async function settle(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 5); });
  expect(check()).toBe(true);
}

/** 按题面找送出去的题号。 */
const idOf = (fields: readonly FullAiField[], label: string) => fields.find((field) => field.label === label)!.id;

function fills(fields: readonly FullAiField[]): AiFill[] {
  return [
    { id: idOf(fields, 'Why do you want to work here?'), value: WHY, optionIds: [] },
    { id: idOf(fields, 'How many years of Kotlin experience do you have?'), value: '5', optionIds: [] },
    { id: idOf(fields, 'Do you have experience with Kotlin?'), value: null, optionIds: ['o0'] },
  ];
}

/** 内容脚本那样接上：同一次点击的凭证给 AI 代答，挑题的口子与「这一轮还算不算数」交给内核。 */
async function run(
  port: KernelAiAnswersPort,
  extra: Record<string, unknown> = {},
  at: number = Date.now(),
  onTiming?: (marks: readonly AiTimingMark[]) => void,
  now?: () => number,
) {
  const audits: KernelFillAudit[] = [];
  const proof = trustedClick(at).proof;
  const session = createAiAnswersSession({ port, gesture: proof, ...(onTiming ? { onTiming } : {}), ...(now ? { now } : {}) });
  const planned: unknown[][] = [];
  const result = await fillFromGesture({
    proof,
    scan: scanNow(),
    policy: livePolicy(),
    profile: PROFILE,
    progress: { onOutcome: () => {}, shouldStop: () => false } as never,
    onAudit: (audit: KernelFillAudit) => audits.push(audit),
    onPlanned: (...args: Parameters<typeof session.onPlanned>) => { planned.push(args); session.onPlanned(...args); },
    ...(port.stillCurrent === undefined ? {} : { laterWritesCurrent: port.stillCurrent }),
    ...extra,
  } as never);
  const audit = audits[0]!;
  const progress: KernelAiProgress[] = [];
  return { result, audit, session, planned, progress, ai: session.attach(audit, (step) => progress.push(step)) };
}

const aiRows = (view: { rows: readonly unknown[] }) =>
  view.rows.filter((row) => (row as { aiAnswered?: unknown }).aiAnswered === true)
    .map((row) => [(row as { label: string }).label, (row as { status: string }).status]);

describe('挑题与请求', () => {
  it('只送规则答不了、而且空着的题；只能本人答的、他人信息、已经有值的一概不送；按契约校验得过、没有选择器与现值', async () => {
    mountForm();
    const ai = aiPort(() => ({ fills: [], noEvidence: [] }));
    await run(ai.port);

    expect(ai.sent).toHaveLength(1);
    const sent = ai.sent[0]!;
    expect(sent.map((field) => [field.label, field.kind])).toEqual([
      ['Why do you want to work here?', 'textarea'],
      ['How many years of Kotlin experience do you have?', 'text'],
      ['Do you have experience with Kotlin?', 'radio'],
    ]);
    expect(sent.find((field) => field.kind === 'radio')?.options).toEqual([{ id: 'o0', label: 'Yes' }, { id: 'o1', label: 'No' }]);
    expect(sent.find((field) => field.kind === 'textarea')?.maxLength).toBe(400);
    expect(sent.every((field) => /^f\d+$/.test(field.id) && field.hasValue === false)).toBe(true);
    // 现值与选择器一个字都不上行；文件、密码、同意、推荐人、工作授权的题面也不上行。
    expect(JSON.stringify(sent)).not.toMatch(/Already typed|Sample|example\.test|#why|kotlin_years|application-form/);
    expect(JSON.stringify(sent)).not.toMatch(/Transcript|Password|privacy|Referrer|authorized/);
    expect(parseFullAiRequest({
      schemaVersion: 1,
      requestId: '11111111-1111-4111-8111-111111111111',
      snapshotId: '22222222-2222-4222-8222-222222222222',
      page: { origin: 'https://job-boards.greenhouse.io', pathname: '/acme/jobs/1', title: 'Analyst' },
      fields: sent,
    })).not.toBeNull();
  });

  it('交给浮层的「AI 在起草」的那几栏，就是送出去的那几题在单子上的那几行（同一批节点）', async () => {
    mountForm();
    const ai = aiPort(() => ({ ok: true, fills: [], noEvidence: [] }));
    const { audit, ai: handle } = await run(ai.port);
    const rowOf = (element: Element) => audit.view.rows.find((row) => row.element === element)?.label;
    expect(handle!.targets.map(rowOf)).toEqual(ai.sent[0]!.map((field) => field.label));
  });

  it('请求在第一遍开写之前就发出去（与写入同时进行）', async () => {
    mountForm();
    const ai = aiPort(() => ({ fills: [], noEvidence: [] }));
    await run(ai.port);
    expect(ai.firstNameAtRequest).toEqual(['']);
    expect(value('first_name')).toBe('Sample');
  });

  it('mission 那条路（没有点击凭证）一题都不问，也没有 AI 的写入口', async () => {
    mountForm();
    const onPlanned = vi.fn();
    const audits: KernelFillAudit[] = [];
    const scan = scanNow() as { descriptor: { fields: readonly { key: string | null }[] } };
    const grant: ExecutionGrant = {
      missionId: 'm_1', missionStepId: 'ms_1', fieldKeys: ['firstName', 'email'], questionKeys: [], allowedActions: ['FILL'],
      executionLease: 'lease_1', leaseExpiresAt: Math.floor(Date.now() / 1000) + 120, intentVersion: 1,
      planDigest: `sha256:${'b'.repeat(64)}`, jobIdentityHash: `sha256:${'a'.repeat(64)}`, fieldSchemaVersion: 1,
      profileSnapshot: { revision: '7', deletionEpoch: '0', snapshotDigest: `sha256:${'c'.repeat(64)}` },
    };
    await fillFromGrant({
      grant, scan: scan as never, profile: PROFILE, policy: livePolicy(),
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: (audit) => audits.push(audit), onPlanned,
    });
    expect(onPlanned).not.toHaveBeenCalled();
    expect(audits[0]!.writeAiAnswers).toBeUndefined();
  });
});

describe('点击后 30 秒之内回来：用同一张凭证写', () => {
  it('写上送出去的题，单子上标 AI 代答；复核说的是同一件事；撤销把文字还原', async () => {
    mountForm();
    const ai = aiPort((fields) => ({ fills: fills(fields), noEvidence: [] }));
    const { result, audit, ai: handle } = await run(ai.port);

    // 规则那一遍照常：逐项结果里只有规则写的（AI 的不进回执）。
    expect(result.ok && result.outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.key)).toEqual(['firstName', 'email']);
    const outcome = await handle!.outcome;
    expect(outcome.kind).toBe('APPLIED');
    if (outcome.kind !== 'APPLIED') return;
    expect(outcome.written).toBe(3);
    expect(value('why')).toBe(WHY);
    expect(value('kotlin_years')).toBe('5');
    expect(checked('kotlin')).toBe('Yes');
    // 只能本人答的、已经有值的一个都没动。
    expect(checked('auth')).toBeNull();
    expect(value('notes')).toBe('Already typed by me');
    expect(value('pw')).toBe('');

    expect(aiRows(outcome.view)).toEqual([
      ['Why do you want to work here?', 'FILLED'],
      ['How many years of Kotlin experience do you have?', 'FILLED'],
      ['Do you have experience with Kotlin?', 'FILLED'],
    ]);
    // 一栏一行：AI 写成的那一行顶替了原来「需要你」的那一行。
    expect(new Set(outcome.view.rows.map((row) => row.element)).size).toBe(outcome.view.rows.length);
    expect(aiRows(audit.recheck())).toEqual(aiRows(outcome.view));

    const click = trustedClick();
    await audit.undoAll(click.event, click.shadowRoot);
    expect(value('why')).toBe('');
    expect(value('kotlin_years')).toBe('');
  });

  it('只认送出去的题号：没送过的题号、送过但对不上那一栏的答案都不写', async () => {
    mountForm();
    const ai = aiPort((fields) => ({
      noEvidence: [],
      fills: [
        { id: 'f99', value: 'Something', optionIds: [] },
        { id: idOf(fields, 'Do you have experience with Kotlin?'), value: 'Yes', optionIds: [] },
        { id: idOf(fields, 'Why do you want to work here?'), value: 'x'.repeat(401), optionIds: [] },
        { id: idOf(fields, 'How many years of Kotlin experience do you have?'), value: '5', optionIds: [] },
      ],
    }));
    const { audit, ai: handle } = await run(ai.port);
    const outcome = await handle!.outcome;
    expect(outcome.kind === 'APPLIED' ? outcome.written : 0).toBe(1);
    expect(value('kotlin_years')).toBe('5');
    expect(value('why')).toBe('');
    expect(checked('kotlin')).toBeNull();
  });

  it('等答案的时候用户自己填了那一栏：不覆盖', async () => {
    mountForm();
    const ai = aiPort();
    const { audit, ai: handle } = await run(ai.port);
    document.querySelector<HTMLTextAreaElement>('#why')!.value = 'My own words';
    ai.batch('fast', fills(ai.sent[0]!));
    ai.end();
    await handle!.outcome;
    expect(value('why')).toBe('My own words');
    expect(value('kotlin_years')).toBe('5');
  });

  it('这一轮作废之后（新的一轮、撤销、关了开关）回来的答案一个字不写', async () => {
    mountForm();
    let current = true;
    const ai = aiPort(undefined, () => current);
    const { audit, ai: handle } = await run(ai.port);
    current = false;
    ai.batch('fast', fills(ai.sent[0]!));
    ai.end();
    expect(await handle!.outcome).toEqual({ kind: 'NONE', noEvidence: [], unanswered: [] });
    expect(value('why')).toBe('');
    expect(checked('kotlin')).toBeNull();
  });
});

describe('AI 在资料里没找到依据的题', () => {
  it('结局里带上那几栏（第一遍扫描里的节点），写成的与没送过的不在其中；题号对不上的不算', async () => {
    mountForm();
    const ai = aiPort((fields) => ({
      fills: [{ id: idOf(fields, 'How many years of Kotlin experience do you have?'), value: '5', optionIds: [] }],
      noEvidence: [idOf(fields, 'Why do you want to work here?'), idOf(fields, 'Do you have experience with Kotlin?'), 'f99'],
    }));
    const { ai: handle } = await run(ai.port);
    const outcome = await handle!.outcome;
    expect(outcome.kind).toBe('APPLIED');
    if (outcome.kind !== 'APPLIED') return;
    expect(outcome.noEvidence).toEqual([document.querySelector('#why'), document.querySelector('input[name="kotlin"]')]);
    expect(value('why')).toBe('');
  });

  it('一题都没写成时也带上（结局是 NONE）', async () => {
    mountForm();
    const ai = aiPort((fields) => ({ fills: [], noEvidence: [idOf(fields, 'Why do you want to work here?')] }));
    const { ai: handle } = await run(ai.port);
    expect(await handle!.outcome).toEqual({ kind: 'NONE', noEvidence: [document.querySelector('#why')], unanswered: [] });
  });
});

describe('回来晚了：不写，改成按钮', () => {
  it('过了 30 秒一个字不写；用户再点一下（新凭证）才写，而且只能用一次', async () => {
    mountForm();
    let clock = Date.now();
    const ai = aiPort();
    const { ai: handle } = await run(ai.port, { now: () => clock }, clock);
    clock += 31_000;
    ai.batch('fast', fills(ai.sent[0]!));
    ai.end();
    const outcome = await handle!.outcome;
    expect(outcome.kind).toBe('READY');
    if (outcome.kind !== 'READY') return;
    expect(outcome.count).toBe(3);
    expect(outcome.written).toBe(0);
    expect(value('why')).toBe('');
    expect(checked('kotlin')).toBeNull();

    const written = await outcome.apply(trustedClick(clock).proof);
    expect(written.ok && written.written).toBe(3);
    expect(value('why')).toBe(WHY);
    expect(written.ok && aiRows(written.view).length).toBe(3);
    expect(await outcome.apply(trustedClick(clock).proof)).toEqual({ ok: false, code: 'GRANT_CONSUMED' });
  });
});

describe('规则那一遍从不等 AI', () => {
  it('答案挂着不回：规则填的照样填、单子照样交，AI 的那几栏空着', async () => {
    mountForm();
    const ai = aiPort();
    const { result, audit, ai: handle } = await run(ai.port);
    expect(result.ok).toBe(true);
    expect(value('first_name')).toBe('Sample');
    expect(audit.view.rows.find((row) => row.label === 'Why do you want to work here?')?.status).toBe('NEEDS_MANUAL');
    const state = await Promise.race([handle!.outcome.then(() => 'settled'), new Promise((resolve) => { setTimeout(() => resolve('pending'), 30); })]);
    expect(state).toBe('pending');
    expect(value('why')).toBe('');
  });

  it('口子抛了、拒绝了：规则照常；拒绝的码原样交给浮层（次数用完要说一句）', async () => {
    mountForm();
    const thrower: KernelAiAnswersPort = { request: () => { throw new Error('worker asleep'); } };
    const thrown = await run(thrower);
    expect(value('email')).toBe('sample.person@example.test');
    expect(await thrown.ai!.outcome).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });

    mountForm();
    const paywall = aiPort(() => ({ refused: 'QUOTA_EXCEEDED' }));
    const refused = await run(paywall.port);
    expect(value('first_name')).toBe('Sample');
    expect(await refused.ai!.outcome).toEqual({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' });
    expect(value('why')).toBe('');
  });
});

describe('用 AI 写 / AI 改写这一栏（2026-09-24）', () => {
  it('只给送出去过的长文本题；空栏写上，改写只在内容没变过时替换；撤销还原到填写前', async () => {
    mountForm();
    const ai = aiPort(() => ({ fills: [], noEvidence: [] }));
    const { audit, ai: handle } = await run(ai.port);
    const why = document.querySelector('#why')!;
    // 多行框与单行框里的开放题都摆（2026-09-24 测试台：Ashby 的长答案是单行框）；选择题不摆。
    expect(handle!.revisable.map((item) => [item.field.label, item.field.kind])).toEqual([
      ['Why do you want to work here?', 'textarea'],
      ['How many years of Kotlin experience do you have?', 'text'],
    ]);

    const first = await handle!.write(why, WHY, trustedClick().proof, '');
    expect(first.ok).toBe(true);
    expect(value('why')).toBe(WHY);
    expect(first.ok && aiRows(first.view)).toEqual([['Why do you want to work here?', 'FILLED']]);

    // 用户按「生成」之后、写回来之前自己改了：不覆盖。
    expect(await handle!.write(why, 'Rewritten', trustedClick().proof, 'something else')).toEqual({ ok: false, code: 'NOT_EMPTY' });
    // 内容没变过：改写替换它，单子上是新的那一版。
    const rewritten = await handle!.write(why, 'Rewritten answer.', trustedClick().proof, WHY);
    expect(rewritten.ok).toBe(true);
    expect(value('why')).toBe('Rewritten answer.');
    expect(rewritten.ok && rewritten.view.rows.find((row) => row.label === 'Why do you want to work here?')?.attemptedValue).toBe('Rewritten answer.');

    // 没送过的栏、选择题：不写。
    expect(await handle!.write(document.querySelector('#notes')!, 'x', trustedClick().proof, 'Already typed by me')).toEqual({ ok: false, code: 'LEASE_INVALID' });
    expect(await handle!.write(document.querySelector('input[name="kotlin"]')!, 'Yes', trustedClick().proof, '')).toEqual({ ok: false, code: 'LEASE_INVALID' });
    // 单行框里的开放题：写成一行。
    const kotlinYears = await handle!.write(document.querySelector('#kotlin_years')!, 'Five years,\nmostly Android.', trustedClick().proof, '');
    expect(kotlinYears.ok).toBe(true);
    expect(value('kotlin_years')).toBe('Five years, mostly Android.');

    const click = trustedClick();
    await audit.undoAll(click.event, click.shadowRoot);
    expect(value('why')).toBe('');
    expect(value('kotlin_years')).toBe('');
  });

  it('凭证过期（生成花了 30 秒以上）：不写，交回原因让浮层要一次新的点击', async () => {
    mountForm();
    let clock = Date.now();
    const ai = aiPort(() => ({ fills: [], noEvidence: [] }));
    const { ai: handle } = await run(ai.port, { now: () => clock }, clock);
    const generateClick = trustedClick(clock).proof;
    clock += 31_000;
    expect(await handle!.write(document.querySelector('#why')!, WHY, generateClick, '')).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
    expect(value('why')).toBe('');
  });
});

describe('流：一批一批到（2026-09-24）', () => {
  const kotlinFills = (fields: readonly FullAiField[]): AiFill[] => [
    { id: idOf(fields, 'Do you have experience with Kotlin?'), value: null, optionIds: ['o0'] },
    { id: idOf(fields, 'How many years of Kotlin experience do you have?'), value: '5', optionIds: [] },
  ];
  const whyFill = (fields: readonly FullAiField[]): AiFill[] => [
    { id: idOf(fields, 'Why do you want to work here?'), value: WHY, optionIds: [] },
  ];

  it('选择题那一批先写上，开放题还没到；开放题到了再写，结局是两批的总数', async () => {
    mountForm();
    const ai = aiPort();
    const { ai: handle, progress } = await run(ai.port);
    const fields = ai.sent[0]!;
    ai.opened();
    ai.batch('fast', kotlinFills(fields));
    await settle(() => progress.length === 1);
    // 开放题那一批还没到：它那一栏空着，结局还没出来。
    expect(checked('kotlin')).toBe('Yes');
    expect(value('kotlin_years')).toBe('5');
    expect(value('why')).toBe('');
    expect(progress.at(-1)).toMatchObject({ written: 2, pending: 1 });
    expect(aiRows(progress.at(-1)!.view!)).toEqual([
      ['How many years of Kotlin experience do you have?', 'FILLED'],
      ['Do you have experience with Kotlin?', 'FILLED'],
    ]);
    const early = await Promise.race([handle!.outcome.then(() => 'settled'), new Promise((resolve) => { setTimeout(() => resolve('pending'), 20); })]);
    expect(early).toBe('pending');

    ai.batch('long', whyFill(fields));
    ai.end();
    const outcome = await handle!.outcome;
    expect(outcome).toMatchObject({ kind: 'APPLIED', written: 3, unanswered: [] });
    expect(value('why')).toBe(WHY);
    expect(progress.map((step) => [step.written, step.pending])).toEqual([[2, 1], [3, 0]]);
  });

  it('早到的写上；晚到的（点击 30 秒之后）不写，流结束后交回按钮，早到的留在页面上', async () => {
    mountForm();
    let clock = Date.now();
    const ai = aiPort();
    const { ai: handle } = await run(ai.port, { now: () => clock }, clock);
    const fields = ai.sent[0]!;
    ai.batch('fast', kotlinFills(fields));
    await settle(() => value('kotlin_years') === '5');
    clock += 31_000;
    ai.batch('long', whyFill(fields));
    ai.end();
    const outcome = await handle!.outcome;
    expect(outcome).toMatchObject({ kind: 'READY', count: 1, written: 2 });
    if (outcome.kind !== 'READY') return;
    expect(value('why')).toBe('');
    expect(checked('kotlin')).toBe('Yes');
    const applied = await outcome.apply(trustedClick(clock).proof);
    expect(applied.ok && applied.written).toBe(1);
    expect(value('why')).toBe(WHY);
    expect(await outcome.apply(trustedClick(clock).proof)).toEqual({ ok: false, code: 'GRANT_CONSUMED' });
  });

  /** 真的一轮填写，AI 的写入口换成测试的（前几次按 `codes` 拒，之后照真的写）。 */
  async function attachWith(codes: readonly string[]) {
    const ai = aiPort();
    const audits: KernelFillAudit[] = [];
    const proof = trustedClick(Date.now()).proof;
    const session = createAiAnswersSession({ port: ai.port, gesture: proof });
    await fillFromGesture({
      proof,
      scan: scanNow(),
      policy: livePolicy(),
      profile: PROFILE,
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: (audit: KernelFillAudit) => audits.push(audit),
      onPlanned: session.onPlanned,
    } as never);
    const real = audits[0]!.writeAiAnswers!;
    let calls = 0;
    const handle = session.attach({
      ...audits[0]!,
      writeAiAnswers: async (...args: Parameters<typeof real>) => {
        calls += 1;
        const code = codes[calls - 1];
        return code === undefined ? real(...args) : { ok: false, code: code as never };
      },
    });
    return { ai, handle: handle!, calls: () => calls };
  }

  it('一批写不成（这一批的题此刻写不进去：选项认不出、那一栏不见了）：只是这一批不写，之后到的照写', async () => {
    mountForm();
    const { ai, handle } = await attachWith(['NO_VALUE']);
    const fields = ai.sent[0]!;
    ai.batch('fast', kotlinFills(fields));
    ai.batch('long', whyFill(fields));
    ai.end();
    expect(await handle.outcome).toMatchObject({ kind: 'APPLIED', written: 1 });
    expect(value('why')).toBe(WHY);
    expect(checked('kotlin')).toBeNull();
  });

  it('这一轮被停下了（中止、租约到期、页面换了）：之后到的一批都不再写，也不改成按钮', async () => {
    for (const code of ['ABORTED', 'LEASE_INVALID', 'IDENTITY_CHANGED', 'GESTURE_UNTRUSTED']) {
      mountForm();
      const { ai, handle, calls } = await attachWith([code]);
      const fields = ai.sent[0]!;
      ai.batch('fast', kotlinFills(fields));
      ai.batch('long', whyFill(fields));
      ai.end();
      expect(await handle.outcome, code).toMatchObject({ kind: 'NONE' });
      expect(calls(), code).toBe(1);
      expect(value('why'), code).toBe('');
    }
  });

  it('每到一批，还交出还在起草的那几栏（第一遍扫描里的节点）：写上的、AI 看过没找到依据的都不在其中', async () => {
    mountForm();
    const ai = aiPort();
    const { ai: handle, progress } = await run(ai.port);
    const fields = ai.sent[0]!;
    expect(handle!.targets).toEqual([document.querySelector('#why'), document.querySelector('#kotlin_years'), document.querySelector('input[name="kotlin"]')]);
    ai.batch('fast', [kotlinFills(fields)[0]!], [idOf(fields, 'How many years of Kotlin experience do you have?')]);
    await settle(() => progress.length === 1);
    expect(progress[0]).toMatchObject({ written: 1, pending: 1 });
    expect(progress[0]!.drafting).toEqual([document.querySelector('#why')]);
    expect(progress[0]!.noEvidence).toEqual([document.querySelector('#kotlin_years')]);
    ai.batch('long', whyFill(fields));
    ai.end();
    await handle!.outcome;
    expect(progress.at(-1)).toMatchObject({ written: 2, pending: 0, drafting: [] });
  });

  it('没拿到答案的题交回来（第一遍扫描里的节点），拿到了的与没送过的不在其中', async () => {
    mountForm();
    const ai = aiPort();
    const { ai: handle } = await run(ai.port);
    const fields = ai.sent[0]!;
    ai.batch('fast', kotlinFills(fields));
    ai.end([idOf(fields, 'Why do you want to work here?'), 'f99']);
    expect(await handle!.outcome).toMatchObject({ kind: 'APPLIED', written: 2, unanswered: [document.querySelector('#why')] });
  });

  it('一次点击只开一条流：同一轮里再有计划也不再问', async () => {
    mountForm();
    const ai = aiPort(() => ({ fills: [], noEvidence: [] }));
    const { session, planned } = await run(ai.port);
    expect(planned).toHaveLength(1);
    session.onPlanned(...(planned[0] as Parameters<typeof session.onPlanned>));
    session.onPlanned(...(planned[0] as Parameters<typeof session.onPlanned>));
    expect(ai.port.request).toHaveBeenCalledTimes(1);
  });

  it('这一轮作废（cancel）：关掉那条流，之后到的一个字不写', async () => {
    mountForm();
    const ai = aiPort();
    const { session, ai: handle } = await run(ai.port);
    const fields = ai.sent[0]!;
    session.cancel();
    expect(ai.closed()).toBe(true);
    ai.batch('fast', kotlinFills(fields));
    ai.end();
    expect(await handle!.outcome).toEqual({ kind: 'NONE', noEvidence: [], unanswered: [] });
    expect(checked('kotlin')).toBeNull();
    expect(value('kotlin_years')).toBe('');
  });

  it('单子写不了 AI 答案（没有写入口）：那条流当场关掉，不留着让服务端白跑', async () => {
    mountForm();
    const ai = aiPort();
    const audits: KernelFillAudit[] = [];
    const proof = trustedClick(Date.now()).proof;
    const session = createAiAnswersSession({ port: ai.port, gesture: proof });
    await fillFromGesture({
      proof,
      scan: scanNow(),
      policy: livePolicy(),
      profile: PROFILE,
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: (audit: KernelFillAudit) => audits.push(audit),
      onPlanned: session.onPlanned,
    } as never);
    expect(ai.sent).toHaveLength(1);
    expect(ai.closed()).toBe(false);
    expect(session.attach({ ...audits[0]!, writeAiAnswers: undefined })).toBeUndefined();
    expect(ai.closed()).toBe(true);
  });

  it('计时从点击起算：发出、响应头、第一批选择题、每次写入、第一批开放题、结束；只有毫秒与个数', async () => {
    mountForm();
    const ai = aiPort();
    let clock = Date.now();
    const marks: (readonly AiTimingMark[])[] = [];
    const { ai: handle, progress } = await run(ai.port, { now: () => clock }, clock, (got) => marks.push(got), () => clock);
    const fields = ai.sent[0]!;
    clock += 400;
    ai.opened();
    clock += 1_600;
    ai.batch('fast', kotlinFills(fields));
    await settle(() => progress.length === 1);
    clock += 1_000;
    ai.batch('long', whyFill(fields));
    clock += 200;
    ai.end();
    await handle!.outcome;
    expect(marks).toHaveLength(1);
    const got = marks[0]!;
    expect(got.map((mark) => mark.at)).toEqual(['SENT', 'OPEN', 'FAST', 'WRITE', 'LONG', 'DONE', 'WRITE']);
    expect(got.filter((mark) => mark.at === 'WRITE').map((mark) => mark.ms)).toEqual([2_000, 3_200]);
    expect(got.find((mark) => mark.at === 'OPEN')?.ms).toBe(400);
    expect(got.find((mark) => mark.at === 'FAST')?.ms).toBe(2_000);
    expect(got.find((mark) => mark.at === 'LONG')?.ms).toBe(3_000);
    expect(got.filter((mark) => mark.at === 'WRITE').map((mark) => ('count' in mark ? mark.count : null))).toEqual([2, 1]);
    // 只有码与数字：题面、答案、元素一个都不在里面。
    expect(JSON.stringify(got)).not.toMatch(/Kotlin|work here|payment/);
  });
});

/**
 * #107（进度卡等 AI 有了结局才收尾、「停止」停得了 AI 那一段）与一条流合在一起（2026-09-24）：真的会话、真的内核写入，
 * 收尾走 closeGestureRun，与内容脚本同一个次序——「停止」的信号既交给内核（写入那一侧挡住），也关掉那条流。
 */
describe('一条流与这一轮的收尾（#107）', () => {
  const kotlinFills = (fields: readonly FullAiField[]): AiFill[] => [
    { id: idOf(fields, 'Do you have experience with Kotlin?'), value: null, optionIds: ['o0'] },
    { id: idOf(fields, 'How many years of Kotlin experience do you have?'), value: '5', optionIds: [] },
  ];
  const whyFill = (fields: readonly FullAiField[]): AiFill[] => [
    { id: idOf(fields, 'Why do you want to work here?'), value: WHY, optionIds: [] },
  ];
  const spyDock = (): GestureRunDock & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      setAiAnswers: (state) => { calls.push(`ai:${state.kind}`); },
      finishRun: (outcome) => { calls.push(`finish:${outcome.started ? outcome.outcome : outcome.code}`); },
      reportBlocked: (code) => { calls.push(`blocked:${code}`); },
    };
  };
  /** 内容脚本的接法：「停止」先关流（这一轮仍算数），再由 closeGestureRun 收尾。 */
  async function begin(extra: Record<string, unknown> = {}, at?: number) {
    const ai = aiPort();
    const stop = new AbortController();
    const started = await run(ai.port, { signal: stop.signal, ...extra }, at);
    stop.signal.addEventListener('abort', () => { started.session.cancel(); }, { once: true });
    const dock = spyDock();
    const drawn: KernelAiAnswersOutcome[] = [];
    const filled = started.result.ok ? started.result.outcomes.filter((outcome) => outcome.ok).length : 0;
    const closing = closeGestureRun({
      dock: () => dock,
      filled,
      ai: started.ai,
      stop: stop.signal,
      current: () => true,
      onAiOutcome: (outcome) => { drawn.push(outcome); },
    });
    return { ...started, ai, handle: started.ai, stop, dock, drawn, closing };
  }

  it('流还开着就不收尾：选择题那一批写上了也不收；开放题到了、流结束，才以两批写上的总数收尾', async () => {
    mountForm();
    const { ai, dock, drawn, closing, progress } = await begin();
    const fields = ai.sent[0]!;
    ai.opened();
    ai.batch('fast', kotlinFills(fields));
    await settle(() => progress.length === 1);
    expect(checked('kotlin')).toBe('Yes');
    expect(dock.calls, '选择题写上了，开放题还在路上：这一轮还没完').toEqual([]);
    ai.batch('long', whyFill(fields));
    ai.end();
    await closing;
    expect(value('why')).toBe(WHY);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ kind: 'APPLIED', written: 3 });
    expect(dock.calls).toEqual(['finish:FILLED']);
  });

  it('AI 在起草时按「停止」：流关掉、之后到的一个字不写；当场照「已停止」收尾，停之前写上的那一批照实画上去', async () => {
    mountForm();
    const { ai, stop, dock, drawn, closing, progress } = await begin();
    const fields = ai.sent[0]!;
    ai.batch('fast', kotlinFills(fields));
    await settle(() => progress.length === 1);
    stop.abort();
    await closing;
    expect(ai.closed(), '服务端那一轮随之中止').toBe(true);
    expect(dock.calls).toEqual(['ai:IDLE', 'finish:STOPPED']);
    // 流已经关了：就算那一头还有一行到，也一个字不写。
    ai.batch('long', whyFill(fields));
    ai.end();
    await settle(() => drawn.length === 1);
    expect(drawn[0]).toMatchObject({ kind: 'APPLIED', written: 2 });
    expect(value('why')).toBe('');
    expect(checked('kotlin')).toBe('Yes');
    expect(dock.calls, '仍是「已停止」').toEqual(['ai:IDLE', 'finish:STOPPED']);
  });

  it('过了 30 秒还在流：早到的写上、晚到的等流结束才摆按钮；规则一项都没写成也算「填好了」', async () => {
    mountForm();
    let clock = Date.now();
    const { ai, dock, drawn, closing, progress } = await begin({ now: () => clock, profile: {} }, clock);
    const fields = ai.sent[0]!;
    ai.batch('fast', kotlinFills(fields));
    await settle(() => progress.length === 1);
    clock += 31_000;
    ai.batch('long', whyFill(fields));
    await settle(() => progress.length === 2);
    expect(value('why'), '晚到的不写').toBe('');
    expect(dock.calls, '流还开着：不收尾').toEqual([]);
    ai.end();
    await closing;
    expect(drawn[0]).toMatchObject({ kind: 'READY', count: 1, written: 2 });
    expect(dock.calls).toEqual(['finish:FILLED']);
  });
});
