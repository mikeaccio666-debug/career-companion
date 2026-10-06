// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditView } from '@edaix/apply-kernel/audit';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import type { ExecutionGrant } from '@edaix/agent-channel';
import { dockProgressFromAudit } from '../lib/autofillDockProgress';
import { isNeed, toDockRow } from '../lib/dock/rows';
import { fillFromGesture } from '../lib/gestureFill';
import { fillFromGrant, type KernelFillAudit } from '../lib/kernelFiller';

installBundledApplyAdapters();

/**
 * 手势路的「第二遍」（2026-09-23）。
 *
 * Greenhouse 的 EEO 是动态的：答完「Are you Hispanic/Latino?」选 No，宿主才在它下面插进
 * 「Please identify your race」。插进来的那一题把后面 Veteran / Disability 的序号都挪了一位，
 * 内核写前复核它们的结构身份对不上——这两栏一个字都不写（这是对的），整轮记下 identityDrift。
 * 从前还把排在计划最后的简历一起连坐成 ABORTED：测试台批测 Greenhouse 简历 0/4。
 *
 * 现在内核只放弃那两栏；内容脚本在**同一次点击**里重扫一次、补填一次：
 *  · 第一遍因重渲染没写成的两栏、与新冒出来的种族题，第二遍在新的一代 DOM 上写上；
 *  · 第一遍已经挂上的简历不挂第二份，简历字节只取一次；
 *  · 面板上一栏只有一行：第二遍写成的顶替第一遍没写成的，新题插在它在页面上的位置；
 *  · 写入面不放宽：这一次点击没批准的键，第二遍也不写；
 *  · 第一遍漂移过又没能重扫，就不从那份过期的扫描出发去加行。
 *
 * 夹具全是合成文字，没有任何真实用户资料。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

/** 用户在我们浮层里的那一次真实点击的凭证（在派发当中取，见 grant.ts）。 */
function trustedGesture() {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click'));
  expect(proof, '前置条件：凭证要取得到').not.toBeNull();
  return proof!;
}

function livePolicy(capabilities: Partial<ApplyPolicy['capabilities']> = {}): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return { ...base, notAfter: Date.now() + 60_000, capabilities: { ...base.capabilities, ...capabilities } };
}

function scanNow() {
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, '前置条件：适配器要认出这张表').not.toBeNull();
  return { descriptor: descriptor! } as never;
}

const rescan = async () => {
  const descriptor = readApplyForm('greenhouse', document);
  return descriptor === null ? null : ({ descriptor } as never);
};

const radios = (name: string, legend: string, options: readonly string[]) => `
  <fieldset id="${name}-question">
    <legend>${legend}</legend>
    ${options.map((text, index) => `<label><input name="${name}" type="radio" value="${index}" required /> ${text}</label>`).join('')}
  </fieldset>`;

const RACE = radios('race', 'Please identify your race', [
  'American Indian or Alaska Native',
  'Asian',
  'Black or African American',
  'White',
  'Decline to self identify',
]);

/** Greenhouse job-boards 的形状（合成）：简历在上面，EEO 在最后；答「No」之后宿主插进种族题。 */
function mountGreenhouseEeo(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" required />
      <label for="email">Email</label><input id="email" type="email" required />
      <div class="field">
        <label for="resume">Resume/CV</label>
        <div>
          <input id="resume" type="file" accept=".pdf,.doc,.docx" required />
          <button type="button" class="attach">Attach</button>
        </div>
      </div>
      ${radios('gender', 'Gender', ['Male', 'Female', 'Decline to self identify'])}
      ${radios('hispanic', 'Are you Hispanic/Latino?', ['Yes', 'No', 'Decline to self identify'])}
      ${radios('veteran', 'Veteran Status', [
        'I identify as one or more of the classifications of a protected veteran',
        'I am not a protected veteran',
        "I don't wish to answer",
      ])}
      ${radios('disability', 'Disability Status', [
        'Yes, I have a disability, or have had one in the past',
        'No, I do not have a disability and have not had one in the past',
        'I do not want to answer',
      ])}
    </form>`;
  // happy-dom 没有布局：给 Attach 按钮一个真实的盒子，写入器才认得出可见的触发器。
  vi.spyOn(document.querySelector<HTMLButtonElement>('button.attach')!, 'getBoundingClientRect').mockReturnValue(
    { width: 96, height: 36, top: 300, left: 40, right: 136, bottom: 336, x: 40, y: 300, toJSON: () => ({}) } as DOMRect,
  );
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="hispanic"]')) {
    radio.addEventListener('change', () => {
      if (radio.value !== '1' || document.getElementById('race-question')) return;
      document.getElementById('hispanic-question')!.insertAdjacentHTML('afterend', RACE);
    });
  }
}

const PROFILE = {
  firstName: 'Sample',
  email: 'sample.person@example.test',
  eeoGender: 'FEMALE',
  eeoRace: 'ASIAN',
  eeoVeteran: 'NOT_PROTECTED_VETERAN',
  eeoDisability: 'NO',
} as never;

const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Sample-Resume.pdf', { type: 'application/pdf' });

const checked = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.parentElement?.textContent?.trim() ?? null;

function collectAudits() {
  const audits: KernelFillAudit[] = [];
  const progress: AuditView[] = [];
  return {
    onAudit: (audit: KernelFillAudit) => { audits.push(audit); },
    onProgress: (view: AuditView) => { progress.push(view); },
    audit: () => audits[0]!,
    progress: () => progress,
  };
}

const rowsOf = (view: AuditView) => view.rows.map((row) => [row.label, row.status, row.reason]);

describe('答一题才冒出来的题：同一次点击里重扫、补填一次', () => {
  it('后面的栏与简历都填上，新冒出来的种族题由第二遍填上；面板一栏一行、计数如实', async () => {
    mountGreenhouseEeo();
    const collected = collectAudits();
    const resolve = vi.fn(async () => pdf());

    const result = await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'set-self-identification': true }),
      profile: PROFILE,
      hispanicLatino: 'NO',
      resume: { fileName: 'Sample-Resume.pdf', targetVerified: true, resolve },
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
      onProgress: collected.onProgress,
    } as never);

    // 页面上真的都有值了。
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Sample');
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('sample.person@example.test');
    expect(checked('gender')).toBe('Female');
    expect(checked('hispanic')).toBe('No');
    expect(checked('race'), '新冒出来的种族题没被第二遍填上').toBe('Asian');
    expect(checked('veteran'), '序号挪了的 Veteran 没被第二遍补上').toBe('I am not a protected veteran');
    expect(checked('disability')).toBe('No, I do not have a disability and have not had one in the past');
    expect((document.getElementById('resume') as HTMLInputElement).files?.[0]?.name).toBe('Sample-Resume.pdf');
    expect(resolve, '简历字节只取一次：第二遍不再让后端释出第二份').toHaveBeenCalledTimes(1);

    // 面板：一栏一行，按页面顺序，新题插在它的位置上，全部已填。
    const view = collected.audit().view;
    expect(rowsOf(view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Email', 'FILLED', null],
      ['Resume/CV', 'FILLED', null],
      ['Gender', 'FILLED', null],
      ['Are you Hispanic/Latino?', 'FILLED', null],
      ['Please identify your race', 'FILLED', null],
      ['Veteran Status', 'FILLED', null],
      ['Disability Status', 'FILLED', null],
    ]);
    expect(new Set(view.rows.map((row) => row.element)).size).toBe(view.rows.length);
    expect(view.filled).toBe(8);
    expect(view.needsAttention).toBe(0);
    expect(view.requiredHandled).toBe(view.requiredTotal);
    // 复核（整轮之后再问一次「值还在不在」）说的也是同一张单子。
    expect(rowsOf(collected.audit().recheck())).toEqual(rowsOf(view));

    // 逐项结果：第二遍写成的顶替第一遍那一条，新题接在后面；一条失败都没有。
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.map((outcome) => [outcome.key, outcome.ok])).toEqual([
      ['firstName', true],
      ['email', true],
      ['eeoGender', true],
      ['eeoRace', true],
      ['eeoVeteran', true],
      ['eeoDisability', true],
      ['resumeFile', true],
      ['eeoRace', true],
    ]);

    // 中段屏每一帧也是一栏一行（第二遍开跑时新题先以「还没轮到」出现，不会与旧行并存）。
    for (const frame of collected.progress()) {
      expect(new Set(frame.rows.map((row) => row.element)).size).toBe(frame.rows.length);
    }
    expect(collected.progress().some((frame) => frame.rows.some((row) => row.label === 'Please identify your race'))).toBe(true);
  });

  it('简历在取字节的时候被挪了位：第一遍如实放弃，第二遍补挂，字节只取一次', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        <div id="late-slot"></div>
        <div class="field">
          <label for="resume">Resume/CV</label>
          <div>
            <input id="resume" type="file" accept=".pdf,.doc,.docx" />
            <button type="button" class="attach">Attach</button>
          </div>
        </div>
      </form>`;
    vi.spyOn(document.querySelector<HTMLButtonElement>('button.attach')!, 'getBoundingClientRect').mockReturnValue(
      { width: 96, height: 36, top: 300, left: 40, right: 136, bottom: 336, x: 40, y: 300, toJSON: () => ({}) } as DOMRect,
    );
    const collected = collectAudits();
    const resolve = vi.fn(async () => {
      // 等字节的这段时间里宿主在简历上面插进一题：简历的序号挪了一位，挂之前的复核对不上。
      document.getElementById('late-slot')!.innerHTML =
        '<label for="pronunciation">Name pronunciation notes</label><input id="pronunciation" type="text" />';
      return pdf();
    });

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy(),
      profile: { firstName: 'Sample' } as never,
      resume: { fileName: 'Sample-Resume.pdf', targetVerified: true, resolve },
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    } as never);

    expect((document.getElementById('resume') as HTMLInputElement).files?.[0]?.name).toBe('Sample-Resume.pdf');
    expect(resolve, '第二遍又让后端释出了一次简历').toHaveBeenCalledTimes(1);
    const rows = collected.audit().view.rows;
    expect(rows.filter((row) => row.label === 'Resume/CV').map((row) => row.status)).toEqual(['FILLED']);
    expect(new Set(rows.map((row) => row.element)).size).toBe(rows.length);
    // 新插进来的那一题照实摆上面板（资料里没有它的答案），不冒充已填。
    expect(rows.find((row) => row.label === 'Name pronunciation notes')?.status).not.toBe('FILLED');
  });

  it('写入面不放宽：这一次点击没批准的键，第二遍也不写，面板上它仍只有一行', async () => {
    mountGreenhouseEeo();
    const collected = collectAudits();
    const grant: ExecutionGrant = {
      missionId: '',
      missionStepId: '',
      // 没批准 Veteran。
      fieldKeys: ['firstName', 'email', 'eeoGender', 'eeoRace', 'eeoDisability', 'resumeFile'],
      allowedActions: ['FILL'],
      executionLease: 'gesture',
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      intentVersion: 0,
      planDigest: '',
      jobIdentityHash: '',
      fieldSchemaVersion: 0,
      profileSnapshot: { revision: '0', deletionEpoch: '0', snapshotDigest: '' },
    } as never;

    const outcomes = await fillFromGrant({
      grant,
      gesture: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'set-self-identification': true }),
      profile: PROFILE,
      hispanicLatino: 'NO',
      resume: { fileName: 'Sample-Resume.pdf', targetVerified: true, resolve: async () => pdf() },
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    });

    expect(checked('race')).toBe('Asian');
    expect(checked('disability')).toBe('No, I do not have a disability and have not had one in the past');
    expect(checked('veteran'), '没批准的键被第二遍写了').toBeNull();
    const rows = collected.audit().view.rows;
    expect(rows.filter((row) => row.label === 'Veteran Status').map((row) => [row.status, row.reason]))
      .toEqual([['FAILED', 'LEASE_INVALID']]);
    expect(rows.filter((row) => row.label === 'Disability Status').map((row) => row.status)).toEqual(['FILLED']);
    expect(new Set(rows.map((row) => row.element)).size).toBe(rows.length);
    expect(outcomes.filter((outcome) => outcome.key === 'eeoVeteran')).toEqual([
      { key: 'eeoVeteran', ok: false, reason: 'LEASE_INVALID' },
    ]);
    expect(outcomes.find((outcome) => outcome.key === 'eeoDisability')).toMatchObject({ ok: true });
  });

  it('写入面不放宽：新冒出来的题键没被这一次点击批准，第二遍不写，面板与逐项结果如实记 LEASE_INVALID', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        ${radios('gender', 'Gender', ['Male', 'Female', 'Decline to self identify'])}
      </form>`;
    // 宿主：答了性别那一题才出现代词那一栏。
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="gender"]')) {
      radio.addEventListener('change', () => {
        if (document.getElementById('pronouns')) return;
        document.getElementById('gender-question')!.insertAdjacentHTML(
          'afterend',
          '<label for="pronouns">Pronouns</label><input id="pronouns" type="text" />',
        );
      });
    }
    const collected = collectAudits();
    const grant: ExecutionGrant = {
      missionId: '',
      missionStepId: '',
      // 没批准代词。
      fieldKeys: ['firstName', 'eeoGender'],
      allowedActions: ['FILL'],
      executionLease: 'gesture',
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      intentVersion: 0,
      planDigest: '',
      jobIdentityHash: '',
      fieldSchemaVersion: 0,
      profileSnapshot: { revision: '0', deletionEpoch: '0', snapshotDigest: '' },
    } as never;

    const outcomes = await fillFromGrant({
      grant,
      gesture: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'set-self-identification': true }),
      profile: { firstName: 'Sample', eeoGender: 'FEMALE', preferredPronouns: 'she/her' } as never,
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    });

    expect(checked('gender')).toBe('Female');
    expect((document.getElementById('pronouns') as HTMLInputElement).value, '没批准的键被第二遍写了').toBe('');
    expect(rowsOf(collected.audit().view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Gender', 'FILLED', null],
      ['Pronouns', 'FAILED', 'LEASE_INVALID'],
    ]);
    expect(outcomes).toEqual([
      { key: 'firstName', ok: true },
      { key: 'eeoGender', ok: true },
      { key: 'preferredPronouns', ok: false, reason: 'LEASE_INVALID' },
    ]);
  });
});

/**
 * 新冒出来、我们填不了的题要**照实**算：与第一遍就跳过的题一视同仁。必填的进浮层「需要你」、进计数，
 * 审阅面板的「补答」里有它（而且真能从那里答上），triage 照样报它。用户有记住的答案的，第二遍用与
 * 第一遍同一个口子取来填上。
 */
describe('新冒出来的题照实算', () => {
  const mountHispanicOnly = () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" required />
        ${radios('hispanic', 'Are you Hispanic/Latino?', ['Yes', 'No', 'Decline to self identify'])}
      </form>`;
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="hispanic"]')) {
      radio.addEventListener('change', () => {
        if (radio.value !== '1' || document.getElementById('race-question')) return;
        document.getElementById('hispanic-question')!.insertAdjacentHTML('afterend', RACE);
      });
    }
  };

  function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    shadowRoot.appendChild(button);
    const event = new Event('click', { bubbles: true, composed: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    Object.defineProperty(event, 'composedPath', { value: () => [button, shadowRoot, host, document.body, document, window] });
    return { event, shadowRoot };
  }

  it('必填、填不了的新题：浮层「需要你」里有它、计数算它、补答里有它且答得上、triage 报它', async () => {
    mountHispanicOnly();
    const collected = collectAudits();
    const needs = vi.fn();

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'set-self-identification': true }),
      // 资料里没有种族：新冒出来的种族题我们答不了。
      profile: { firstName: 'Sample' } as never,
      hispanicLatino: 'NO',
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false, onNeedsUserInput: needs } as never,
      onAudit: collected.onAudit,
    } as never);

    expect(checked('hispanic')).toBe('No');
    expect(checked('race')).toBeNull();
    const audit = collected.audit();
    expect(rowsOf(audit.view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Are you Hispanic/Latino?', 'FILLED', null],
      ['Please identify your race', 'NEEDS_MANUAL', 'MANUAL_ONLY'],
    ]);
    expect(audit.view).toMatchObject({ requiredTotal: 3, requiredHandled: 2, awaitingUser: 1, needsAttention: 1 });

    // 浮层：「需要你」只列必填、没填上的行——新冒出来的这一题就在里面，而且只有它。
    const dockRows = dockProgressFromAudit('run-revealed', audit.view).rows.map((row, index) => toDockRow(row, index));
    expect(dockRows.filter(isNeed).map((row) => row.q)).toEqual(['Please identify your race']);

    // 审阅面板的「补答」里有它（题号另起前缀，不与第一遍撞号），triage 也报了它。
    const revealed = audit.questions.find((question) => question.text === 'Please identify your race');
    expect(revealed?.questionId).toMatch(/^q2-\d+$/);
    expect(new Set(audit.questions.map((question) => question.questionId)).size).toBe(audit.questions.length);
    expect(needs).toHaveBeenCalledWith('IN_PAGE_ACTION');

    // 而且真能从那里答上：用户在面板里选了「Asian」，写进的是新冒出来的那一题。
    const click = trustedShadowClick();
    const written = await audit.answer(click.event, click.shadowRoot, [{ questionId: revealed!.questionId, value: 'Asian' }]);
    expect(written.map((result) => result.ok)).toEqual([true]);
    expect(checked('race')).toBe('Asian');
  });

  it('新冒出来的题有记住的答案：第二遍用与第一遍同一个口子取来填上，只问新题', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        ${radios('previously', 'Have you previously worked with us?', ['Yes', 'No'])}
      </form>`;
    // 宿主：答了「以前在这儿干过吗」才追问一道开放题。
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="previously"]')) {
      radio.addEventListener('change', () => {
        if (document.getElementById('project')) return;
        document.getElementById('previously-question')!.insertAdjacentHTML(
          'afterend',
          '<label for="project">Please describe your most relevant project</label><textarea id="project"></textarea>',
        );
      });
    }
    const remembered = new Map([
      ['Have you previously worked with us?', 'No'],
      ['Please describe your most relevant project', 'A synthetic project summary.'],
    ]);
    const asked: string[][] = [];
    const resolveRememberedAnswers = vi.fn(async (questions: readonly { questionId: string; question: { text: string } }[]) => {
      asked.push(questions.map((entry) => entry.question.text));
      return questions.flatMap((entry) => {
        const value = remembered.get(entry.question.text);
        return value === undefined ? [] : [{ questionId: entry.questionId, value }];
      });
    });
    const collected = collectAudits();

    const result = await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy(),
      profile: { firstName: 'Sample' } as never,
      reuseRememberedAnswers: true,
      resolveRememberedAnswers,
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    } as never);

    expect(checked('previously')).toBe('No');
    expect((document.getElementById('project') as HTMLTextAreaElement).value).toBe('A synthetic project summary.');
    // 第一遍问整页，第二遍只问新冒出来的那一道。
    expect(asked).toEqual([
      ['Have you previously worked with us?'],
      ['Please describe your most relevant project'],
    ]);
    const audit = collected.audit();
    expect(rowsOf(audit.view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Have you previously worked with us?', 'FILLED', null],
      ['Please describe your most relevant project', 'FILLED', null],
    ]);
    expect(audit.questions).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fromMemory = result.outcomes.filter((outcome) => outcome.key.startsWith('question:'));
    expect(fromMemory).toHaveLength(2);
    expect(fromMemory.every((outcome) => outcome.ok && outcome.source === 'REMEMBERED_ANSWER')).toBe(true);
  });
});

/**
 * 什么时候值得重扫（2026-09-23 负责人：要和竞品一样快）。条件题是**选了一项**才冒出来的——
 * 单选／复选组、原生下拉、组合框；只写了文本、长文本、文件的一轮不为了「也许冒出了新题」再扫一遍。
 * 页面重渲染过（有栏身份变了）照旧重扫，那两条见上面。
 */
describe('只在值得的时候重扫', () => {
  it('只写了文本的一轮不重扫', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        <label for="email">Email</label><input id="email" type="email" />
      </form>`;
    const spy = vi.fn(rescan);

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy(),
      profile: { firstName: 'Sample', email: 'sample.person@example.test' } as never,
      rowAdds: { rescan: spy, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
    } as never);

    expect((document.getElementById('email') as HTMLInputElement).value).toBe('sample.person@example.test');
    expect(spy, '只写了文本也重扫了一遍').not.toHaveBeenCalled();
  });

  it('写成了一道选择题就重扫一次——哪怕什么新题都没冒出来，也只扫一次', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        ${radios('gender', 'Gender', ['Male', 'Female', 'Decline to self identify'])}
      </form>`;
    const spy = vi.fn(rescan);
    const collected = collectAudits();

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'set-self-identification': true }),
      profile: { firstName: 'Sample', eeoGender: 'FEMALE' } as never,
      rowAdds: { rescan: spy, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    } as never);

    expect(checked('gender')).toBe('Female');
    expect(spy).toHaveBeenCalledTimes(1);
    // 什么都没冒出来：单子与只跑一遍时一模一样。
    expect(rowsOf(collected.audit().view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Gender', 'FILLED', null],
    ]);
  });

  it('选择题这一次没写成（资料里没有值）不算：只写了文本就不重扫', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        ${radios('gender', 'Gender', ['Male', 'Female', 'Decline to self identify'])}
      </form>`;
    const spy = vi.fn(rescan);

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'set-self-identification': true }),
      profile: { firstName: 'Sample' } as never,
      rowAdds: { rescan: spy, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
    } as never);

    expect(checked('gender')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * 加行从哪一份扫描出发（复核 `abortedBy === null` 那道闸）。从前身份漂移会置 abortedBy，于是
 * 那道闸顺带挡住了「从一份已经过期的扫描出发去点加一行」；漂移改记在 identityDrift 之后得另挡。
 */
describe('第一遍漂移过之后的加行', () => {
  const educationRow = (index: number) => `
    <div class="education--form">
      <label for="school--${index}">School</label><input id="school--${index}" type="text" />
      <label for="discipline--${index}">Discipline</label><input id="discipline--${index}" type="text" />
    </div>`;
  function mountWithEducation(): { clicks: () => number } {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        <label for="last_name">Last Name</label><input id="last_name" type="text" />
        <label for="email">Email</label><input id="email" type="email" />
        <div class="education--container">
          ${educationRow(0)}
          <button type="button" class="add-another-button">Add another</button>
        </div>
      </form>`;
    // 宿主在第一栏的 input 里同步改掉 Last Name 的 name：Last Name 的结构身份变了。
    document.getElementById('first_name')!.addEventListener('input', () => {
      document.getElementById('last_name')!.setAttribute('name', 'job_application[answers_attributes][0][text_value]');
    }, { once: true });
    let clicks = 0;
    const add = document.querySelector<HTMLButtonElement>('.add-another-button')!;
    add.addEventListener('click', () => {
      clicks += 1;
      add.insertAdjacentHTML('beforebegin', educationRow(document.querySelectorAll('.education--form').length));
    });
    return { clicks: () => clicks };
  }
  const education = (school: string, fieldOfStudy: string) => ({
    school, fieldOfStudy, degreeLevel: null, startDate: null, endDate: null, location: null, gpa: null, gpaScale: null, isCurrent: false,
  });
  const TWO = { educations: [education('Example University', 'Design'), education('Second College', 'History')] };
  const CONTACT = { firstName: 'Sample', lastName: 'Person', email: 'sample.person@example.test' } as never;

  it('漂移过、又没能重扫：不从过期的扫描出发去点「加一行」', async () => {
    const host = mountWithEducation();
    const collected = collectAudits();

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'manage-rows': true }),
      profile: CONTACT,
      collections: TWO,
      rowAdds: { rescan: async () => null, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    } as never);

    expect(host.clicks(), '从一份已知过期的扫描出发点了「加一行」').toBe(0);
    expect(collected.audit().rowAdds).toBeNull();
    expect((document.getElementById('last_name') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('school--0') as HTMLInputElement).value).toBe('Example University');
  });

  it('重扫成功：第二遍补上漂移的那一栏，加行从新的一代出发照常进行', async () => {
    const host = mountWithEducation();
    const collected = collectAudits();

    await fillFromGesture({
      proof: trustedGesture(),
      scan: scanNow(),
      policy: livePolicy({ 'manage-rows': true }),
      profile: CONTACT,
      collections: TWO,
      rowAdds: { rescan, settleMs: 0 },
      progress: { onOutcome: () => {}, shouldStop: () => false } as never,
      onAudit: collected.onAudit,
    } as never);

    expect((document.getElementById('last_name') as HTMLInputElement).value).toBe('Person');
    expect(host.clicks()).toBe(1);
    expect((document.getElementById('school--1') as HTMLInputElement).value).toBe('Second College');
    const audit = collected.audit();
    expect(audit.rowAdds).toEqual({ added: 1, saved: 0, stop: null, unreachable: [] });
    expect(audit.view.rows.filter((row) => row.label === 'Last Name').map((row) => row.status)).toEqual(['FILLED']);
  });
});
