// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fillFromGesture } from '../lib/gestureFill';
import { fillFromGrant, type KernelFillAudit } from '../lib/kernelFiller';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import { mountWorkableEntrySections } from '../../../packages/apply-kernel/tests/fixtures/workable/entrySections';

installBundledApplyAdapters();

/**
 * 无 mission 的填写：用户站在任何一家我们认得的申请页上按一下 Autofill，
 * 就用他自己的档案把表填上（2026-09-17 产品决定：standalone ATS detection +
 * autofill without mission dependency）。
 *
 * 信任根是 `mintAuthority` 认的那一个——**用户在我们自己浮层里的真实点击**。
 * `isTrusted` 页面 JS 造不出来，closed shadow root 页面 JS 够不到；两个条件
 * 合起来等价于「这个人此刻确实按了我们的按钮」。对「填我自己的资料」这件事，
 * 这就是完整的授权。
 *
 * 这些用例钉的是**它不放松什么**。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

function page(extraFields = '') {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    <label for="email">Email</label><input id="email" type="email" />
    ${extraFields}
  </form>`;
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, '前置条件：适配器要认出这张表').not.toBeNull();
  return { shadowRoot, button, descriptor: descriptor! };
}

const PROFILE = { firstName: 'Taylor', email: 'taylor@example.test' } as never;

/**
 * 生产里这份策略来自后端下发的 bundle（`ResolvedContentDiscoveryRuntimeAuthority.fillPolicy`）。
 * 用例里用包内策略的形状代它，但**必须把 `notAfter` 挪到现在之后**：
 * `createBundledApplyPolicy()` 的有效期是「构建时刻 + 30 天」，而测试环境里
 * 构建时刻退化成硬编码的 2026-07-29，于是原样拿来用的话每个用例都在 runner
 * 里判 `POLICY_DISABLED`——零写入，且读起来像是"填写逻辑不工作"。
 */
function livePolicy(over: Partial<ApplyPolicy> = {}): ApplyPolicy {
  return { ...createBundledApplyPolicy(), notAfter: Date.now() + 60_000, ...over };
}

function input(over: Record<string, unknown> = {}, extraFields = '') {
  const { shadowRoot, button, descriptor } = page(extraFields);
  const event = new TrustedClick('click');
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  // 凭证必须在**派发当中**取：`composedPath()` 一派发完就空了，
  // 这正是这条路上真实的形状（见 grant.ts 的 captureTrustedShadowGesture）。
  button.addEventListener('click', (e) => { proof = captureTrustedShadowGesture(e, shadowRoot); });
  button.dispatchEvent(event);
  return {
    event, shadowRoot, proof: proof as never,
    scan: { descriptor } as never,
    profile: PROFILE,
    policy: livePolicy(),
    progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
    ...over,
  };
}

describe('信任根：只认我们自己浮层里的真实点击', () => {
  it('页面自己派发的点击取不到凭证', () => {
    const { shadowRoot, button } = page();
    let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
    button.addEventListener('click', (e) => { proof = captureTrustedShadowGesture(e, shadowRoot); });
    button.dispatchEvent(new MouseEvent('click')); // isTrusted 为 false

    expect(proof).toBeNull();
  });

  it('来自别处 shadow 的可信点击也取不到——不是我们的按钮', () => {
    const { button } = page();
    const other = document.createElement('div');
    document.body.append(other);
    const foreign = other.attachShadow({ mode: 'open' });
    let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
    button.addEventListener('click', (e) => { proof = captureTrustedShadowGesture(e, foreign); });
    button.dispatchEvent(new TrustedClick('click'));

    expect(proof).toBeNull();
  });

  /**
   * 这一条钉的是**为什么凭证必须在点击当下取**。
   *
   * 浏览器里 `composedPath()` 在事件派发结束的那一刻就返回空数组。这条路上铸票
   * 之前全是 await（问后台要授权、要档案、解运行时、扫这一页），所以晚一步问必然
   * 判否——不是因为点击不成立，是因为那时问不出来。2026-09-18 实测：整条链跑到
   * 最后一步，浮层说「这一次点击没能通过校验」，而那一次点击完全真实。
   *
   * happy-dom 不复刻这个清空行为（它派发完还留着路径），所以这里直接摆出**浏览器
   * 里那一刻的样子**：一个 `isTrusted` 为真、但 `composedPath()` 已经空了的事件。
   * 凭证必须拒它——否则「来自我方 shadow」这一条就形同虚设。
   */
  it('路径已经空掉的事件取不到凭证（浏览器里派发之后就是这个样子）', () => {
    const { shadowRoot } = page();
    const settled = Object.defineProperties(new MouseEvent('click'), {
      isTrusted: { get: () => true },
      composedPath: { value: () => [] },
    });

    expect(captureTrustedShadowGesture(settled, shadowRoot)).toBeNull();
  });
});

describe('闸一条都没放松', () => {
  it('厂商被策略关掉时写不进去', async () => {
    const base = livePolicy();
    const off = { ...base, vendors: { ...base.vendors, greenhouse: false } };
    const result = await fillFromGesture({ ...input(), policy: off });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 票据铸得出来（手势是真的），但一个条目都不该成功落地。
      expect(result.outcomes.every((o) => !o.ok)).toBe(true);
    }
  });

  it('敏感能力位出厂是关的——这条路填的只是他自己的普通字段', async () => {
    const policy = createBundledApplyPolicy();
    for (const capability of [
      'set-other-person', 'set-self-identification', 'set-work-authorization',
      'set-attestation', 'set-richtext', 'manage-rows', 'set-referral', 'advance-step', 'sign-on-behalf',
    ] as const) {
      expect(policy.capabilities[capability], capability).toBe(false);
    }
  });
});

/**
 * 整轮之后宿主把我们填好的栏清空（2026-09-24 测试台 Lever Spotify / Shield AI：附上简历约三秒后「Current location」
 * 的文字被清掉，晚于附完简历之后等宿主安静的那一段）：用同一张点击凭证按资料重填一次。
 */
describe('整轮之后宿主清空了我们填的栏：同一次点击之内重填一次', () => {
  class TrustedInput extends Event { get isTrusted() { return true; } }
  async function filled() {
    const base = input();
    const collected: KernelFillAudit[] = [];
    await fillFromGesture({ ...base, onAudit: (audit: KernelFillAudit) => { collected.push(audit); } } as never);
    const firstName = document.getElementById('first_name') as HTMLInputElement;
    expect(firstName.value).toBe('Taylor');
    return { audit: collected[0]!, proof: base.proof, firstName };
  }
  const setValue = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  };

  it('被清空的那一栏按资料重填，单子上那一行回到「已填」；只重填一次', async () => {
    const { audit, proof, firstName } = await filled();
    setValue(firstName, '');
    expect(audit.recheck().rows.find((row) => row.label === 'First Name')).toMatchObject({ status: 'FAILED', reason: 'LATE_REVERTED' });
    const repaired = await audit.repairReverted!(proof);
    expect(repaired).toMatchObject({ ok: true, written: 1 });
    expect(firstName.value).toBe('Taylor');
    if (repaired.ok) expect(repaired.view.rows.find((row) => row.label === 'First Name')).toMatchObject({ status: 'FILLED' });
    setValue(firstName, '');
    expect(await audit.repairReverted!(proof)).toEqual({ ok: false, code: 'GRANT_CONSUMED' });
    expect(firstName.value).toBe('');
  });

  it('宿主改成了别的值、或用户自己动过那一栏：一个字不写', async () => {
    const changed = await filled();
    setValue(changed.firstName, 'Parsed From Resume');
    expect(await changed.audit.repairReverted!(changed.proof)).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect(changed.firstName.value).toBe('Parsed From Resume');

    const edited = await filled();
    setValue(edited.firstName, '');
    edited.firstName.dispatchEvent(new TrustedInput('input', { bubbles: true }));
    expect(await edited.audit.repairReverted!(edited.proof)).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect(edited.firstName.value).toBe('');
  });
});

describe('信任根成立时真的会填', () => {
  it('可信点击 + 认得的厂商 → 产出逐项结果', async () => {
    const result = await fillFromGesture(input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes.length).toBeGreaterThan(0);
  });
});

/**
 * 「跑完了」不等于「填上了」。
 *
 * 2026-09-17 在真实 Greenhouse 页上实测：浮层走完整条手势路、画出终局那一幕
 * 「填写需要核对」，而页面上 44 个控件**一个值都没有**。原因是这条路铸票和
 * 执行用的是**两份计划**：`fillFromGesture` 先建一份算能力面、`fillFromGrant`
 * 里又建一份（带蜜罐几何）真正去跑，而 `plan.fingerprint` 是**每份计划一个新
 * 随机数**——于是 runner 第一行的 `auth.fingerprint !== plan.fingerprint` 必然
 * 成立，整轮 `PLAN_STALE`，零写入，且**全程无异常**。
 *
 * 所以这里不能只数 outcomes 的条数（那在全军覆没时照样 > 0），必须钉住
 * 「页面上真的有值了」。
 */
describe('填上了，不只是跑完了', () => {
  it('可信点击 + 认得的厂商 → 字段真的被写进页面', async () => {
    const result = await fillFromGesture(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.some((o) => o.ok)).toBe(true);
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('taylor@example.test');
  });

  it('全军覆没时不许有任何一条 outcome 谎报成功', async () => {
    const base = livePolicy();
    const off = { ...base, vendors: { ...base.vendors, greenhouse: false } };
    const result = await fillFromGesture({ ...input(), policy: off });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('');
  });
});

/**
 * 写什么由**后端下发的那一份策略**说了算，手势只证明「用户要填」。
 *
 * 这条路曾经写 `input.policy ?? createBundledApplyPolicy()`。那个默认值有两个
 * 静默的坏处：包内策略在构建三十天后必然过期（`notAfter = 构建时刻 + 30 天`），
 * 于是每一次手势填写都在 runner 里判 `POLICY_DISABLED`、零写入、零报错；而且它
 * 隔着一个模块绕开了 `execution-runtime-bundle-wiring` 那道「内容脚本不许用包内
 * 策略」的闸。所以 `policy` 现在是必填的——取不到就不该走到写这一步。
 */
describe('写策略只来自后端，过期了就一个字都不写', () => {
  it('策略过了有效期 → 零写入，且如实报 POLICY_DISABLED', async () => {
    const expired = livePolicy({ notAfter: Date.now() - 1 });
    const result = await fillFromGesture({ ...input(), policy: expired });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.every((o) => !o.ok)).toBe(true);
    expect(result.outcomes.every((o) => o.ok || o.reason === 'POLICY_DISABLED')).toBe(true);
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('');
  });
});

/**
 * 简历附件（P1-4）。接缝由内容脚本从 worker 的 PLAN 答复接来（resumeSeam.ts），
 * 这里钉的是内核那一侧：接缝在，文件就真的挂进宿主的 file input；接缝不在，
 * 简历栏如实 NO_VALUE 而其余字段照常——这一栏在真实批测里曾是 0/63，
 * 单字段最大的一笔缺口。
 */
describe('简历附件接缝', () => {
  // Greenhouse job-boards 的真实形状：隐藏的 file input + 可见的 Attach 按钮。
  const RESUME_FIELD = `
    <div class="field">
      <label for="resume">Resume/CV</label>
      <div>
        <input id="resume" type="file" accept=".pdf,.doc,.docx" required />
        <button type="button">Attach</button>
      </div>
    </div>`;
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3]);

  function withResumeField() {
    const value = input({}, RESUME_FIELD);
    const attach = document.querySelector('button[type="button"]') as HTMLButtonElement;
    // happy-dom 没有布局：给可见触发器一个真实的几何，否则写入器判「无可见触发器」。
    vi.spyOn(attach, 'getBoundingClientRect').mockReturnValue(
      { width: 96, height: 36, top: 0, left: 0, right: 96, bottom: 36, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    return value;
  }

  function auditRows() {
    const views: KernelFillAudit['view'][] = [];
    return {
      collect: (audit: KernelFillAudit) => { views.push(audit.view); },
      find: (label: RegExp) => views[0]?.rows.find((row) => label.test(row.label)),
      all: () => views[0]?.rows.map((row) => ({ key: row.key, label: row.label, reason: row.reason })) ?? [],
    };
  }

  it('接缝在 → 文件真的挂进 file input，逐项结果里简历栏 ok，其余字段照常', async () => {
    const file = new File([PDF], 'Taylor Kim.pdf', { type: 'application/pdf' });
    const resolve = vi.fn(async () => file);
    const result = await fillFromGesture({
      ...withResumeField(),
      resume: { fileName: 'Taylor Kim.pdf', targetVerified: true, resolve },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.outcomes.find((o) => o.key === 'resumeFile')).toMatchObject({ ok: true });
    expect((document.getElementById('resume') as HTMLInputElement).files?.[0]?.name).toBe('Taylor Kim.pdf');
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  // 跳过的栏不进 outcomes（那是写入面的逐项结果），进的是面板行：用户要在那里
  // 看到「简历：没有值」而不是少一行。
  it('接缝不在 → 简历栏在面板上如实 NO_VALUE、一个字节都不挂，其余字段照常', async () => {
    const rows = auditRows();
    const result = await fillFromGesture({ ...withResumeField(), onAudit: rows.collect });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.some((o) => o.key === 'resumeFile')).toBe(false);
    expect(rows.find(/resume/i)).toMatchObject({ reason: 'NO_VALUE' });
    expect((document.getElementById('resume') as HTMLInputElement).files?.length ?? 0).toBe(0);
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  // 「must never be inferred from hostname/DOM」：接缝在但目标没被后端证实，照样不挂。
  it('targetVerified 为假 → 不挂、不取字节，面板上如实 HOST_UNCONFIRMED', async () => {
    const resolve = vi.fn(async () => new File([PDF], 'Taylor Kim.pdf', { type: 'application/pdf' }));
    const rows = auditRows();
    const result = await fillFromGesture({
      ...withResumeField(),
      resume: { fileName: 'Taylor Kim.pdf', targetVerified: false, resolve },
      onAudit: rows.collect,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolve).not.toHaveBeenCalled();
    expect(rows.find(/resume/i)).toMatchObject({ reason: 'HOST_UNCONFIRMED' });
    expect((document.getElementById('resume') as HTMLInputElement).files?.length ?? 0).toBe(0);
  });
});

/**
 * 答案记忆（P1-6）。手势路没有 grant 点名的题；用户打开了「自动带出我记住的答案」时，
 * 本页认不出键的题交给 `resolveRememberedAnswers`，命中的答案与档案字段同一份计划、
 * 同一张票据写入，逐项结果标上 REMEMBERED_ANSWER。没打开就一个字都不写。
 */
describe('答案记忆接进手势填写路', () => {
  const QUESTION_FIELD = `
    <label for="why">Why do you want to work here?</label>
    <textarea id="why"></textarea>`;

  it('打开自动带出 → 记住的答案写进认不出键的题，来源标 REMEMBERED_ANSWER', async () => {
    const resolve = vi.fn(async (questions: readonly { questionId: string; question: { text: string } }[]) =>
      questions
        .filter((entry) => entry.question.text === 'Why do you want to work here?')
        .map((entry) => ({ questionId: entry.questionId, value: 'Because payments.' })));
    const result = await fillFromGesture({
      ...input({}, QUESTION_FIELD),
      reuseRememberedAnswers: true,
      resolveRememberedAnswers: resolve,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((document.getElementById('why') as HTMLTextAreaElement).value).toBe('Because payments.');
    const remembered = result.outcomes.find((o) => o.key.startsWith('question:'));
    expect(remembered).toMatchObject({ ok: true, source: 'REMEMBERED_ANSWER' });
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  it('没打开自动带出 → 不问记忆、不写那道题', async () => {
    const resolve = vi.fn(async () => [{ questionId: 'q0', value: 'Because payments.' }]);
    const result = await fillFromGesture({ ...input({}, QUESTION_FIELD), resolveRememberedAnswers: resolve });
    expect(result.ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect((document.getElementById('why') as HTMLTextAreaElement).value).toBe('');
  });
});

/**
 * 结构化档案（P1-8a）。教育 / 经历是**行内**字段：规则把 `school--0` 这类格认到
 * `education.school`，值从 worker 交来的集合按行取（第 1 行取第 1 段）。这一刀只填
 * **页面上已经有的行**——Greenhouse 默认渲染一段教育，从前它整段空着；加行（第 2 段起）
 * 是 P1-8b 的事。集合不在时行内格如实 NO_VALUE，一个字都不猜。
 */
describe('结构化档案接进手势填写路', () => {
  const EDUCATION_ROW = `
    <div class="education--container">
      <div class="education--form">
        <label for="school--0">School</label><input id="school--0" type="text" />
        <label for="discipline--0">Discipline</label><input id="discipline--0" type="text" />
      </div>
      <button type="button" class="add-another-button">Add another</button>
    </div>`;
  const COLLECTIONS = {
    educations: [{
      school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design',
      startDate: { year: 2018, month: 9 }, endDate: { year: 2022, month: 5 },
      location: null, gpa: null, gpaScale: null, isCurrent: false,
    }],
  } as const;

  function auditRows() {
    const views: KernelFillAudit['view'][] = [];
    return {
      collect: (audit: KernelFillAudit) => { views.push(audit.view); },
      find: (label: RegExp) => views[0]?.rows.find((row) => label.test(row.label)),
    };
  }

  it('集合在 → 第 1 行的学校与专业落字，逐项结果按行内角色记 ok，扁平字段照常', async () => {
    const result = await fillFromGesture({ ...input({}, EDUCATION_ROW), collections: COLLECTIONS } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'education.school')).toMatchObject({ ok: true });
    expect(result.outcomes.find((o) => o.key === 'education.fieldOfStudy')).toMatchObject({ ok: true });
    expect((document.getElementById('school--0') as HTMLInputElement).value).toBe('Example University');
    expect((document.getElementById('discipline--0') as HTMLInputElement).value).toBe('Design');
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  it('集合不在 → 行内格在面板上如实 NO_VALUE、不写，其余字段照常', async () => {
    const rows = auditRows();
    const result = await fillFromGesture({ ...input({}, EDUCATION_ROW), onAudit: rows.collect } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.some((o) => String(o.key).startsWith('education.'))).toBe(false);
    expect(rows.find(/^School$/)).toMatchObject({ reason: 'NO_VALUE' });
    expect((document.getElementById('school--0') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  it('档案里有两段、页面只有一行 → 只填第 1 段，第 2 段不硬塞进同一行', async () => {
    const two = { educations: [...COLLECTIONS.educations, { ...COLLECTIONS.educations[0], school: 'Second College', fieldOfStudy: 'History' }] };
    const result = await fillFromGesture({ ...input({}, EDUCATION_ROW), collections: two } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.filter((o) => o.key === 'education.school')).toHaveLength(1);
    expect((document.getElementById('school--0') as HTMLInputElement).value).toBe('Example University');
  });
});

/**
 * 乙档预填（自我认同 / 工作授权）接进手势路（2026-09-21 查到：从来没接上）。
 *
 * argoland 09-18 就把这两位跟 fill 一起放行了，但插件这边有三层各自没接：策略投影丢了这
 * 两个键（executionRuntimeAuthority）、计划期没把能力位交给内核（`ApplyPlanOptions.capabilities`
 * 一直没传）、工作授权记录没有数据源（`workAuthorizations` 没人喂）。三层接齐之后，这些题
 * 2026-09-21 起**直接写**：用户在档案里填下并保存的值就是同意，不再在面板上要他点第二次头。
 * 只有按岗位地点**推断**的工作授权仍走 PREFILLED_NEEDS_CONFIRMATION，面板预选、用户点头才落笔。
 */
describe('乙档预填接进手势填写路', () => {
  const SENSITIVE_FIELDS = `
    <fieldset>
      <legend>Gender</legend>
      <label><input name="gender" type="radio" value="1" /> Male</label>
      <label><input name="gender" type="radio" value="2" /> Female</label>
      <label><input name="gender" type="radio" value="3" /> Decline to self identify</label>
    </fieldset>
    <fieldset>
      <legend>Are you authorized to work in the United States?</legend>
      <label><input name="work_auth" type="radio" value="yes" /> Yes</label>
      <label><input name="work_auth" type="radio" value="no" /> No</label>
    </fieldset>`;
  const AUTHORIZATIONS = [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }] as const;
  const PROFILE_WITH_EEO = { firstName: 'Taylor', email: 'taylor@example.test', eeoGender: 'FEMALE' } as never;
  const released = () => livePolicy({
    capabilities: {
      ...createBundledApplyPolicy().capabilities,
      'set-self-identification': true,
      'set-work-authorization': true,
    },
  });

  function auditRows() {
    const audits: KernelFillAudit[] = [];
    return {
      collect: (audit: KernelFillAudit) => { audits.push(audit); },
      audit: () => audits[0]!,
      find: (label: RegExp) => audits[0]?.view.rows.find((row) => label.test(row.label)),
    };
  }

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

  it('能力位放行 + 有值 → 两题在这一轮里直接写进页面，键是档案键／工作授权键，面板上没有它们', async () => {
    const rows = auditRows();
    const result = await fillFromGesture({
      ...input({ policy: released(), profile: PROFILE_WITH_EEO }, SENSITIVE_FIELDS),
      workAuthorizations: AUTHORIZATIONS,
      onAudit: rows.collect,
    } as never);
    expect(result.ok).toBe(true);
    expect(rows.find(/^Gender$/)).toMatchObject({ status: 'FILLED', key: 'eeoGender' });
    expect(rows.find(/authorized to work/)).toMatchObject({ status: 'FILLED', key: 'workAuthorization' });
    const audit = rows.audit();
    expect(audit.questions.find((q) => q.text === 'Gender')).toBeUndefined();
    expect(audit.prefills.size).toBe(0);
    expect((document.querySelector('input[name="gender"][value="2"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[name="gender"][value="1"]') as HTMLInputElement).checked).toBe(false);
    expect((document.querySelector('input[name="work_auth"][value="yes"]') as HTMLInputElement).checked).toBe(true);
  });

  // 2026-09-23 负责人实测：他在门户里对「是否拉美裔」答过「否」，Greenhouse 这道必填题却一直是
  // 「只能由你本人填写」——那句回答在 worker 的翻译里被丢掉了（种族只留单值，推不出「否」）。
  it('「Are you Hispanic/Latino?」：用户在门户答过「否」→ 选 No；没带这句回答 → 照旧交还本人', async () => {
    const HISPANIC = `
      <fieldset>
        <legend>Are you Hispanic/Latino?</legend>
        <label><input name="hispanic" type="radio" value="yes" /> Yes</label>
        <label><input name="hispanic" type="radio" value="no" /> No</label>
        <label><input name="hispanic" type="radio" value="decline" /> Decline to self identify</label>
      </fieldset>`;
    const profile = { firstName: 'Taylor', email: 'taylor@example.test', eeoRace: 'ASIAN' } as never;

    const answered = auditRows();
    await fillFromGesture({
      ...input({ policy: released(), profile }, HISPANIC),
      hispanicLatino: 'NO',
      onAudit: answered.collect,
    } as never);
    expect(answered.find(/Hispanic/)).toMatchObject({ status: 'FILLED', key: 'eeoRace' });
    expect((document.querySelector('input[name="hispanic"][value="no"]') as HTMLInputElement).checked).toBe(true);

    const silent = auditRows();
    await fillFromGesture({
      ...input({ policy: released(), profile }, HISPANIC),
      onAudit: silent.collect,
    } as never);
    expect(silent.find(/Hispanic/)).toMatchObject({ reason: 'MANUAL_ONLY' });
    expect((document.querySelector('input[name="hispanic"]:checked') as HTMLInputElement | null)).toBeNull();
  });

  // 2026-09-23 负责人：EEO 用户填了什么就回答什么。Greenhouse Discord 的「I consider myself a member of
  // the LGBTQ+ community.」从前一直是「只能由你本人填写」——门户里的跨性别与性取向在这条路上被丢掉了。
  describe('跨性别、性取向、「是否 LGBTQ+」按门户里的回答作答（2026-09-23）', () => {
    const IDENTITY = `
      <fieldset>
        <legend>Do you identify as transgender?</legend>
        <label><input name="trans" type="radio" value="yes" /> Yes</label>
        <label><input name="trans" type="radio" value="no" /> No</label>
        <label><input name="trans" type="radio" value="decline" /> I don't wish to answer</label>
      </fieldset>
      <fieldset>
        <legend>What is your sexual orientation?</legend>
        <label><input name="orientation" type="radio" value="asexual" /> Asexual</label>
        <label><input name="orientation" type="radio" value="bi" /> Bisexual and/or pansexual</label>
        <label><input name="orientation" type="radio" value="gay" /> Gay</label>
        <label><input name="orientation" type="radio" value="straight" /> Heterosexual</label>
        <label><input name="orientation" type="radio" value="lesbian" /> Lesbian</label>
        <label><input name="orientation" type="radio" value="decline" /> I don't wish to answer</label>
      </fieldset>
      <fieldset>
        <legend>I consider myself a member of the LGBTQ+ community. (optional)</legend>
        <label><input name="lgbtq" type="radio" value="yes" /> Yes</label>
        <label><input name="lgbtq" type="radio" value="no" /> No</label>
        <label><input name="lgbtq" type="radio" value="decline" /> I don't wish to answer</label>
      </fieldset>`;
    const checked = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? null;

    it('带了这两句 → 三题在这一轮里直接写进页面，键各是自己的', async () => {
      const rows = auditRows();
      await fillFromGesture({
        ...input({ policy: released() }, IDENTITY),
        transgenderStatus: 'NO',
        sexualOrientation: 'BISEXUAL_PANSEXUAL',
        onAudit: rows.collect,
      } as never);
      expect(rows.find(/transgender/)).toMatchObject({ status: 'FILLED', key: 'eeoTransgender' });
      expect(rows.find(/sexual orientation/)).toMatchObject({ status: 'FILLED', key: 'eeoSexualOrientation' });
      expect(rows.find(/LGBTQ/)).toMatchObject({ status: 'FILLED', key: 'eeoLgbtqCommunity' });
      expect([checked('trans'), checked('orientation'), checked('lgbtq')]).toEqual(['no', 'bi', 'yes']);
    });

    it('异性恋、又不是跨性别 → LGBTQ+ 答「否」；两问都不想回答 → 三题都选「不想回答」', async () => {
      await fillFromGesture({ ...input({ policy: released() }, IDENTITY), transgenderStatus: 'NO', sexualOrientation: 'HETEROSEXUAL' } as never);
      expect([checked('trans'), checked('orientation'), checked('lgbtq')]).toEqual(['no', 'straight', 'no']);

      await fillFromGesture({ ...input({ policy: released() }, IDENTITY), transgenderStatus: 'DECLINE', sexualOrientation: 'DECLINE' } as never);
      expect([checked('trans'), checked('orientation'), checked('lgbtq')]).toEqual(['decline', 'decline', 'decline']);
    });

    it('没带这两句（没答、自行描述、没同意复用）→ 三题照旧交还本人', async () => {
      const rows = auditRows();
      await fillFromGesture({ ...input({ policy: released() }, IDENTITY), onAudit: rows.collect } as never);
      for (const label of [/transgender/, /sexual orientation/, /LGBTQ/]) {
        expect(rows.find(label), String(label)).toMatchObject({ reason: 'MANUAL_ONLY' });
      }
      expect([checked('trans'), checked('orientation'), checked('lgbtq')]).toEqual([null, null, null]);
    });

    it('能力位关着 → 带了也一题不写', async () => {
      const rows = auditRows();
      await fillFromGesture({
        ...input({ policy: livePolicy() }, IDENTITY),
        transgenderStatus: 'YES',
        sexualOrientation: 'GAY',
        onAudit: rows.collect,
      } as never);
      for (const label of [/transgender/, /sexual orientation/, /LGBTQ/]) {
        expect(rows.find(label), String(label)).toMatchObject({ reason: 'MANUAL_ONLY' });
      }
      expect([checked('trans'), checked('orientation'), checked('lgbtq')]).toEqual([null, null, null]);
    });
  });

  it('能力位关着 → 一题都不写：EEO 停在 MANUAL_ONLY、工作授权停在 JOB_DEPENDENT', async () => {
    const rows = auditRows();
    await fillFromGesture({
      ...input({ policy: livePolicy(), profile: PROFILE_WITH_EEO }, SENSITIVE_FIELDS),
      workAuthorizations: AUTHORIZATIONS,
      onAudit: rows.collect,
    } as never);
    expect(rows.find(/^Gender$/)).toMatchObject({ reason: 'MANUAL_ONLY' });
    expect(rows.find(/authorized to work/)).toMatchObject({ reason: 'JOB_DEPENDENT' });
    expect([...document.querySelectorAll<HTMLInputElement>('input[type=radio]')].some((r) => r.checked)).toBe(false);
  });

  // 2026-09-23 负责人改：按岗位地点推断出国家的也直接写（从前要用户在面板上点一下「回填」）。
  it('题目不点名国家、按岗位地点推断的 → 直接写，审计行带上推断的国家', async () => {
    const INFERRED_FIELD = `
      <fieldset>
        <legend>Are you authorized to work in the country in which this job is based?</legend>
        <label><input name="work_auth" type="radio" value="yes" /> Yes</label>
        <label><input name="work_auth" type="radio" value="no" /> No</label>
      </fieldset>`;
    const rows = auditRows();
    await fillFromGesture({
      ...input({ policy: released(), profile: PROFILE_WITH_EEO }, INFERRED_FIELD),
      workAuthorizations: AUTHORIZATIONS,
      jobRegionCode: 'US',
      onAudit: rows.collect,
    } as never);
    expect(rows.find(/authorized to work/)).toMatchObject({ key: 'workAuthorization', status: 'FILLED', inferredRegionCode: 'US' });
    expect(rows.audit().prefills.size, '不再留一道「待你确认」').toBe(0);
    expect((document.querySelector('input[name="work_auth"][value="yes"]') as HTMLInputElement).checked).toBe(true);
  });

  it('能力位没放行 → 退回 MANUAL_ONLY / JOB_DEPENDENT，没有建议', async () => {
    const rows = auditRows();
    await fillFromGesture({
      ...input({ profile: PROFILE_WITH_EEO }, SENSITIVE_FIELDS),
      workAuthorizations: AUTHORIZATIONS,
      onAudit: rows.collect,
    } as never);
    expect(rows.find(/^Gender$/)).toMatchObject({ reason: 'MANUAL_ONLY' });
    expect(rows.find(/authorized to work/)).toMatchObject({ reason: 'JOB_DEPENDENT' });
    expect(rows.audit().prefills.size).toBe(0);
  });
});

/**
 * 加行（P1-8b）：档案里的段数多于页面上的行数时，按厂商声明的「加一行」控件加行、重扫、
 * 只填新加的那一行。四道闸：手势路、交来了集合、远程策略放行 manage-rows、给了重扫手段。
 * 加不动就停在那里，已填的行都完整；停的原因记在审计里。
 */
describe('加行接进手势填写路', () => {
  function educationRow(index: number): string {
    return `
      <div class="education--form">
        <label for="school--${index}">School</label><input id="school--${index}" type="text" />
        <label for="discipline--${index}">Discipline</label><input id="discipline--${index}" type="text" />
      </div>`;
  }
  const container = (rows: number, withAdd = true) => `
    <div class="education--container">
      ${Array.from({ length: rows }, (_, index) => educationRow(index)).join('')}
      ${withAdd ? '<button type="button" class="add-another-button">Add another</button>' : ''}
    </div>`;
  /** 宿主的行为（Greenhouse 实测）：点「加一行」就在按钮前插一行。 */
  function hostAddsRows(): void {
    const button = document.querySelector<HTMLButtonElement>('.add-another-button')!;
    button.addEventListener('click', () => {
      const count = document.querySelectorAll('.education--form').length;
      button.insertAdjacentHTML('beforebegin', educationRow(count));
    });
  }
  const education = (school: string, fieldOfStudy: string) => ({
    school, fieldOfStudy, degreeLevel: null, startDate: null, endDate: null, location: null, gpa: null, gpaScale: null, isCurrent: false,
  });
  const TWO = { educations: [education('Example University', 'Design'), education('Second College', 'History')] };
  const THREE = { educations: [...TWO.educations, education('Third Institute', 'Physics')] };
  const rowPolicy = () => livePolicy({ capabilities: { ...createBundledApplyPolicy().capabilities, 'manage-rows': true } });
  const rescan = async () => {
    const descriptor = readApplyForm('greenhouse', document);
    return descriptor === null ? null : ({ descriptor } as never);
  };
  const schoolValue = (index: number) => (document.getElementById(`school--${index}`) as HTMLInputElement | null)?.value;

  function audits() {
    const collected: KernelFillAudit[] = [];
    return { collect: (audit: KernelFillAudit) => { collected.push(audit); }, audit: () => collected[0]! };
  }

  it('两段教育、页面一行 → 点一次加行、重扫、第 2 行也落字；审计合成一张单', async () => {
    const base = input({ policy: rowPolicy() }, container(1));
    hostAddsRows();
    const rows = audits();
    const result = await fillFromGesture({ ...base, collections: TWO, rowAdds: { rescan, settleMs: 0 }, onAudit: rows.collect } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(document.querySelectorAll('.education--form')).toHaveLength(2);
    expect(schoolValue(0)).toBe('Example University');
    expect(schoolValue(1)).toBe('Second College');
    expect((document.getElementById('discipline--1') as HTMLInputElement).value).toBe('History');
    expect(result.outcomes.filter((o) => o.key === 'education.school' && o.ok)).toHaveLength(2);
    const audit = rows.audit();
    expect(audit.view.rows.filter((row) => row.label === 'School').map((row) => row.status)).toEqual(['FILLED', 'FILLED']);
    expect(audit.rowAdds).toEqual({ added: 1, saved: 0, stop: null, unreachable: [] });
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  it('三段 → 逐段推进加两行；每次加完都重扫', async () => {
    const base = input({ policy: rowPolicy() }, container(1));
    hostAddsRows();
    const rows = audits();
    await fillFromGesture({ ...base, collections: THREE, rowAdds: { rescan, settleMs: 0 }, onAudit: rows.collect } as never);
    expect([schoolValue(0), schoolValue(1), schoolValue(2)]).toEqual(['Example University', 'Second College', 'Third Institute']);
    expect(rows.audit().rowAdds).toMatchObject({ added: 2, stop: null });
  });

  it('策略没放行 manage-rows → 一下都不点，只填页面上已有的行，审计里没有加行这一笔', async () => {
    const base = input({}, container(1));
    hostAddsRows();
    const rows = audits();
    await fillFromGesture({ ...base, collections: TWO, rowAdds: { rescan, settleMs: 0 }, onAudit: rows.collect } as never);
    expect(document.querySelectorAll('.education--form')).toHaveLength(1);
    expect(schoolValue(0)).toBe('Example University');
    expect(rows.audit().rowAdds).toBeNull();
  });

  it('没给重扫手段（mission 路的形状）→ 不加行', async () => {
    const base = input({ policy: rowPolicy() }, container(1));
    hostAddsRows();
    const rows = audits();
    await fillFromGesture({ ...base, collections: TWO, onAudit: rows.collect } as never);
    expect(document.querySelectorAll('.education--form')).toHaveLength(1);
    expect(rows.audit().rowAdds).toBeNull();
  });

  it('页面上没有「加一行」控件 → 停下并如实记 CLICK_DENIED；第 1 行照常', async () => {
    const base = input({ policy: rowPolicy() }, container(1, false));
    const rows = audits();
    await fillFromGesture({ ...base, collections: TWO, rowAdds: { rescan, settleMs: 0 }, onAudit: rows.collect } as never);
    expect(schoolValue(0)).toBe('Example University');
    expect(rows.audit().rowAdds).toMatchObject({ added: 0, stop: 'CLICK_DENIED' });
  });

  it('点了加行但重扫失败 → 停在那里，新行不填、不再点第二次', async () => {
    const base = input({ policy: rowPolicy() }, container(1));
    hostAddsRows();
    const rows = audits();
    await fillFromGesture({ ...base, collections: THREE, rowAdds: { rescan: async () => null, settleMs: 0 }, onAudit: rows.collect } as never);
    expect(document.querySelectorAll('.education--form')).toHaveLength(2);
    expect(schoolValue(1)).toBe('');
    expect(rows.audit().rowAdds).toMatchObject({ added: 0, stop: 'IDENTITY_CHANGED' });
  });

  it('点了加行但行数没涨（宿主没反应）→ 停下记 CLICK_DENIED，不连点', async () => {
    const base = input({ policy: rowPolicy() }, container(1));
    let clicks = 0;
    document.querySelector('.add-another-button')!.addEventListener('click', () => { clicks += 1; });
    const rows = audits();
    await fillFromGesture({ ...base, collections: THREE, rowAdds: { rescan, settleMs: 0, appearCapMs: 100 }, onAudit: rows.collect } as never);
    expect(clicks).toBe(1);
    expect(rows.audit().rowAdds).toMatchObject({ added: 0, stop: 'CLICK_DENIED' });
  });

  /** 2026-09-24 Workable 实测：点完「+ Add」几百毫秒才画出编辑框；从前固定等 150 毫秒就重扫，判成「点了没反应」。 */
  it('宿主过一会儿才把新行画出来：等到新行出现再重扫、照样填', async () => {
    const base = input({ policy: rowPolicy() }, container(1));
    const button = document.querySelector<HTMLButtonElement>('.add-another-button')!;
    button.addEventListener('click', () => {
      setTimeout(() => {
        const count = document.querySelectorAll('.education--form').length;
        button.insertAdjacentHTML('beforebegin', educationRow(count));
      }, 300);
    });
    const rows = audits();
    await fillFromGesture({ ...base, collections: TWO, rowAdds: { rescan, settleMs: 0 }, onAudit: rows.collect } as never);
    expect(schoolValue(1)).toBe('Second College');
    expect(rows.audit().rowAdds).toMatchObject({ added: 1, stop: null });
  });
});

/**
 * Workable（负责人 2026-09-24：「workable，那就和jobright一样全加全存」）：每一段经历／教育是一个编辑框，
 * 填完要点框里的「Update」才算留下，保存之前这个区的「+ Add」是禁用的。同一次点击里：加一段 → 等编辑框
 * 画出来 → 按资料里那一段填 → 回读过 → 用保存票按这一段自己的「Update」→ 等它收成卡片 → 下一段。
 * 保存成的每一段在单子上是一行「已替你保存」；没存成的那一段照实说还差什么，这个区后面几段不再加。
 *
 * 夹具是线上结构的骨架（packages/apply-kernel/tests/fixtures/workable/entrySections.ts）：新编辑框插在最前面、
 * 按 Update 之后整个 li 换成卡片，必填空着就不收。
 */
describe('每一段要单独保存的区（Workable）：全加全存', () => {
  function gesture(): never {
    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadowRoot.append(button);
    let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
    button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
    button.dispatchEvent(new TrustedClick('click'));
    return proof as never;
  }
  const experience = (title: string | null, company: string) => ({
    title, company, employmentType: null, location: null, startDate: null, endDate: null, isCurrent: false,
  });
  const education = (school: string, fieldOfStudy: string | null) => ({
    school, fieldOfStudy, degreeLevel: null, startDate: null, endDate: null, location: null, gpa: null, gpaScale: null, isCurrent: false,
  });
  const scanWorkable = async () => {
    const descriptor = readApplyForm('workable', document);
    return descriptor === null ? null : ({ descriptor } as never);
  };
  const rowsPolicy = (manageRows = true) =>
    livePolicy({ capabilities: { ...createBundledApplyPolicy().capabilities, 'manage-rows': manageRows } });
  const THREE = { experiences: [experience('Title A', 'Company A'), experience('Title B', 'Company B'), experience('Title C', 'Company C')] };

  async function run(collections: Record<string, unknown>, policy: ApplyPolicy = rowsPolicy()) {
    const proof = gesture();
    const collected: KernelFillAudit[] = [];
    const result = await fillFromGesture({
      proof,
      scan: await scanWorkable(),
      profile: { firstName: 'Taylor' } as never,
      policy,
      progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
      collections,
      rowAdds: { rescan: scanWorkable, settleMs: 0 },
      onAudit: (audit: KernelFillAudit) => { collected.push(audit); },
    } as never);
    return { result, audit: collected[0]! };
  }

  it('三段经历：逐段加、按那一段填、按 Update、等它收成卡片——三段都留下，整张表一次都没提交', async () => {
    const host = mountWorkableEntrySections(document, ['experience'], { addDelayMs: 200 });
    const { result, audit } = await run(THREE);
    expect(host.openEditors('experience')).toBe(0);
    // Workable 把新的一段插在最前面；规则声明了 insertsAt: top，从资料的最后一段加起——页面上从上到下就是资料的顺序。
    expect(host.savedTitles('experience')).toEqual(['Title A', 'Title B', 'Title C']);
    expect(host.submitted()).toBe(0);
    expect(audit.rowAdds).toMatchObject({ added: 3, saved: 3, stop: null });
    // 每一段一行「已替你保存」，值是填进去的内容；一格一格的 Title / Company 不再单列，也没有「要你按保存」。
    expect(audit.view.rows.filter((row) => row.savedEntry !== undefined).map((row) => [row.status, row.savedEntry, row.attemptedValue, row.label]))
      .toEqual([
        ['FILLED', { collection: 'experience', rowIndex: 0 }, 'Title A · Company A', 'Update'],
        ['FILLED', { collection: 'experience', rowIndex: 1 }, 'Title B · Company B', 'Update'],
        ['FILLED', { collection: 'experience', rowIndex: 2 }, 'Title C · Company C', 'Update'],
      ]);
    expect(audit.view.rows.some((row) => row.unsavedEntry !== undefined || row.label === 'Title')).toBe(false);
    // 逐项结果照旧报行内格。
    expect(result.ok && result.outcomes.filter((outcome) => outcome.key === 'experience.title' && outcome.ok)).toHaveLength(3);
  });

  /**
   * 2026-09-24 测试台 usa-vein-clinics：第 1 段存上、收成卡片之后，紧接着那一次重扫封不住（网站还在重排），
   * 整轮就停了，后面几段一段都没加。重扫一时封不住不是终局：隔一会儿再扫几次（与主轮同一个口径），扫到了就接着加。
   */
  it('存完一段、重扫一时封不住：隔一会儿再扫，扫到了就接着加下一段', async () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    const proof = gesture();
    const collected: KernelFillAudit[] = [];
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      // 第 1 次重扫是加完第 1 段之后；第 2 次是存完第 1 段之后——这一次封不住。
      return calls === 2 ? null : scanWorkable();
    };
    await fillFromGesture({
      proof,
      scan: await scanWorkable(),
      profile: { firstName: 'Taylor' } as never,
      policy: rowsPolicy(),
      progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
      collections: THREE,
      rowAdds: { rescan: flaky, settleMs: 0 },
      onAudit: (audit: KernelFillAudit) => { collected.push(audit); },
    } as never);
    expect(host.savedTitles('experience')).toEqual(['Title A', 'Title B', 'Title C']);
    expect(collected[0]!.rowAdds).toMatchObject({ added: 3, saved: 3, stop: null });
  });

  it('两个区都在：教育与经历各自逐段加满、保存；页面上的内容是资料里对应那一段的', async () => {
    const host = mountWorkableEntrySections(document, ['experience', 'education']);
    const { audit } = await run({
      experiences: [experience('Title A', 'Company A'), experience('Title B', 'Company B')],
      educations: [education('School One', 'Design'), education('School Two', null)],
    });
    expect(host.savedTitles('education')).toEqual(['School One', 'School Two']);
    expect(host.savedTitles('experience')).toEqual(['Title A', 'Title B']);
    expect(audit.rowAdds).toMatchObject({ added: 4, saved: 4, stop: null });
    expect(audit.view.rows.filter((row) => row.savedEntry?.collection === 'education').map((row) => row.attemptedValue))
      .toEqual(['School One · Design', 'School Two']);
  });

  it('资料里第 2 段没有职位（Title 必填）：不按 Update，单子上写还差 Title；这个区剩下的不加，另一个区照样加满', async () => {
    const host = mountWorkableEntrySections(document, ['experience', 'education']);
    const { audit } = await run({
      experiences: [experience('Title A', 'Company A'), experience(null, 'Company B'), experience('Title C', 'Company C')],
      educations: [education('School One', null)],
    });
    // 从最后一段加起：第 3 段存上了，第 2 段缺 Title 停下，第 1 段没加。
    expect(host.savedTitles('experience')).toEqual(['Title C']);
    expect(host.openEditors('experience'), '那一段的编辑框留着，Company 已经填好').toBe(1);
    expect((document.querySelector('[data-ui="experience"] [data-ui="editor"] input[name="company"]') as HTMLInputElement).value).toBe('Company B');
    expect(host.savedTitles('education')).toEqual(['School One']);
    expect(host.submitted()).toBe(0);
    const unsaved = audit.view.rows.find((row) => row.unsavedEntry !== undefined);
    expect(unsaved).toMatchObject({
      status: 'NEEDS_MANUAL', required: true, label: 'Update',
      unsavedEntry: { collection: 'experience', rowIndex: 1, missing: ['Title'] },
    });
    expect(unsaved?.element).toBe(document.querySelector('[data-ui="experience"] button[data-ui="save-section"]'));
    const unadded = audit.view.rows.find((row) => row.unaddedEntries !== undefined);
    expect(unadded).toMatchObject({ status: 'NEEDS_MANUAL', required: true, unaddedEntries: { collection: 'experience', from: 0, to: 0 } });
    expect(audit.rowAdds).toMatchObject({ added: 3, saved: 2 });
  });

  it('按了 Update 网站没收（编辑框还开着）：照实报 HOST_REJECTED，这个区停在这一段', async () => {
    const host = mountWorkableEntrySections(document, ['experience'], { refuseSave: true });
    const { audit } = await run(THREE);
    expect(host.openEditors('experience')).toBe(1);
    expect(host.savedTitles('experience')).toEqual([]);
    expect(audit.view.rows.find((row) => row.unsavedEntry !== undefined))
      .toMatchObject({ status: 'NEEDS_MANUAL', reason: 'HOST_REJECTED', unsavedEntry: { collection: 'experience', rowIndex: 2 } });
    expect(audit.view.rows.find((row) => row.unaddedEntries !== undefined))
      .toMatchObject({ unaddedEntries: { collection: 'experience', from: 0, to: 1 } });
    expect(audit.rowAdds).toMatchObject({ added: 1, saved: 0, stop: 'HOST_REJECTED' });
  });

  it('宿主在「Update」里想提交整张表：拦下、这一段不算存成，停在这一段；表单没有提交', async () => {
    const host = mountWorkableEntrySections(document, ['experience'], { submitOnSave: true });
    (document.getElementById('firstname') as HTMLInputElement).value = 'Taylor';
    const { audit } = await run(THREE);
    expect(host.submitted()).toBe(0);
    expect(audit.view.rows.find((row) => row.unsavedEntry !== undefined))
      .toMatchObject({ reason: 'ABORTED', unsavedEntry: { collection: 'experience', rowIndex: 2 } });
    expect(audit.rowAdds).toMatchObject({ added: 1, saved: 0, stop: 'ABORTED' });
  });

  it('点击凭证剩得不够一段（加、填、存三张票）：不开这一段，不留空着的编辑框；单子上说这几段还没加', async () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    const proof = gesture();
    const collected: KernelFillAudit[] = [];
    await fillFromGesture({
      proof,
      scan: await scanWorkable(),
      profile: { firstName: 'Taylor' } as never,
      policy: rowsPolicy(),
      progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
      collections: THREE,
      rowAdds: { rescan: scanWorkable, settleMs: 0 },
      // 这一次点击是 26 秒前按的（凭证 30 秒有效）：主轮照写，逐段那一段不再开。
      now: () => Date.now() + 26_000,
      onAudit: (audit: KernelFillAudit) => { collected.push(audit); },
    } as never);
    expect(document.querySelectorAll('[data-ui="experience"] li')).toHaveLength(0);
    expect(host.savedTitles('experience')).toEqual([]);
    const audit = collected[0]!;
    expect(audit.rowAdds).toMatchObject({ added: 0, saved: 0, stop: 'GESTURE_EXPIRED' });
    expect(audit.view.rows.find((row) => row.unaddedEntries !== undefined))
      .toMatchObject({ reason: 'GESTURE_EXPIRED', unaddedEntries: { collection: 'experience', from: 0, to: 2, afterUnsaved: false } });
  });

  it('编辑框里一格都认不出（宿主换了格的名字）：一格没写就不按保存，不存一段空的', async () => {
    const host = mountWorkableEntrySections(document, ['experience'], { unmappedCells: true });
    const { audit } = await run(THREE);
    expect(host.openEditors('experience')).toBe(1);
    expect(host.savedTitles('experience')).toEqual([]);
    expect(audit.view.rows.find((row) => row.unsavedEntry !== undefined))
      .toMatchObject({ reason: 'NO_VALUE', unsavedEntry: { collection: 'experience', rowIndex: 2 } });
    expect(audit.rowAdds).toMatchObject({ added: 1, saved: 0, stop: 'NO_VALUE' });
  });

  it('远程策略没放行 manage-rows：一段都不加、一颗保存都不按', async () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    const { audit } = await run(THREE, rowsPolicy(false));
    expect(document.querySelectorAll('[data-ui="experience"] li')).toHaveLength(0);
    expect(host.savedTitles('experience')).toEqual([]);
    expect(audit.rowAdds).toBeNull();
  });
});

/**
 * 工作授权按岗位地点推断（P1-7）。2026-09-21 定的是只预填等放行；2026-09-23 负责人改为直接写。
 * 内容脚本从申请卡片解出恰好一个国家码才交；题目一个地方都没点名时按它答，审计行带上推断的国家。
 */
describe('工作授权按岗位地点推断', () => {
  const ROLE_COUNTRY = `
    <fieldset>
      <legend>Are you currently legally authorized to work in the country in which this job is based?</legend>
      <label><input name="work_auth" type="radio" value="yes" /> Yes</label>
      <label><input name="work_auth" type="radio" value="no" /> No</label>
    </fieldset>`;
  const AUTHORIZATIONS = [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }] as const;
  const released = () => livePolicy({ capabilities: { ...createBundledApplyPolicy().capabilities, 'set-work-authorization': true } });
  function audits() {
    const collected: KernelFillAudit[] = [];
    return { collect: (audit: KernelFillAudit) => { collected.push(audit); }, audit: () => collected[0]! };
  }

  it('岗位在美国 → 直接写 Yes，审计行带上推断的国家（浮层据此写明依据）', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({ policy: released() }, ROLE_COUNTRY), workAuthorizations: AUTHORIZATIONS, jobRegionCode: 'US', onAudit: rows.collect } as never);
    const audit = rows.audit();
    expect(audit.view.rows.find((row) => row.label.startsWith('Are you currently')))
      .toMatchObject({ status: 'FILLED', inferredRegionCode: 'US' });
    expect(audit.prefills.size).toBe(0);
    expect((document.querySelector('input[name="work_auth"][value="yes"]') as HTMLInputElement).checked).toBe(true);
  });

  it('解不出岗位国家（没交 jobRegionCode）→ 照旧 JOB_DEPENDENT，没有建议、没有来源', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({ policy: released() }, ROLE_COUNTRY), workAuthorizations: AUTHORIZATIONS, onAudit: rows.collect } as never);
    const audit = rows.audit();
    expect(audit.view.rows.find((row) => row.label.startsWith('Are you currently'))).toMatchObject({ reason: 'JOB_DEPENDENT' });
    expect(audit.prefills.size).toBe(0);
    expect(audit.prefillBasis.size).toBe(0);
  });

  // 2026-09-24 负责人决定（Mike：「就答是的」）：他有别国的记录、唯独没有岗位那一国的，与 Jobright 一样按默认答
  // 「是」，审计行带上那一国，浮层据此写明、请他提交前核对。上午 #105 定的「不写、只说缺哪一国的记录」只剩他一条
  // 记录都没有的时候（下一条）。
  it('岗位在爱沙尼亚、他只有美国的记录（2026-09-24 Twilio）→ 按默认写 Yes，审计行带上爱沙尼亚', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({ policy: released() }, ROLE_COUNTRY), workAuthorizations: AUTHORIZATIONS, jobRegionCode: 'EE', onAudit: rows.collect } as never);
    expect(rows.audit().view.rows.find((row) => row.label.startsWith('Are you currently')))
      .toMatchObject({ key: 'workAuthorization', status: 'FILLED', defaultedRegionCode: 'EE', inferredRegionCode: 'EE' });
    expect((document.querySelector('input[name="work_auth"][value="yes"]') as HTMLInputElement).checked).toBe(true);
  });

  it('他一条工作许可记录都没有 → 照旧不写，审计行带上爱沙尼亚', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({ policy: released() }, ROLE_COUNTRY), workAuthorizations: [], jobRegionCode: 'EE', onAudit: rows.collect } as never);
    const row = rows.audit().view.rows.find((item) => item.label.startsWith('Are you currently'));
    expect(row).toMatchObject({ reason: 'JOB_DEPENDENT', regionWithoutRecord: 'EE' });
    expect(row?.defaultedRegionCode).toBeUndefined();
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="work_auth"]')) expect(radio.checked).toBe(false);
  });

  /** 2026-09-24 Lever Shield AI：「Are you local to or willing to relocate?」，岗位 Seattle, Washington。 */
  it('搬迁题没写搬去哪儿：内容脚本交来的岗位地点接到内核，按他列的搬迁城市答', async () => {
    const RELOCATE = `
      <label for="relocate">Are you local to or willing to relocate?</label>
      <select id="relocate"><option value="">Please select an option</option><option value="Yes">Yes</option><option value="No">No</option></select>`;
    const profile = { firstName: 'Taylor', email: 'taylor@example.test', city: 'Birmingham', openToRelocation: 'true', openToRelocationCities: 'San Francisco, New York, Seattle' };
    const rows = audits();
    await fillFromGesture({ ...input({ policy: released(), profile }, RELOCATE), jobLocation: 'Seattle, Washington', onAudit: rows.collect } as never);
    expect(rows.audit().view.rows.find((row) => row.label.startsWith('Are you local'))).toMatchObject({ key: 'relocation', status: 'FILLED' });
    expect((document.getElementById('relocate') as HTMLSelectElement).value).toBe('Yes');
  });
});

/**
 * 推荐人（P1-9，Mike 拍板：只开推荐人姓名，只取用户亲手存的列表）。
 * worker 交来用户确认过的推荐人，内容脚本交来申请卡片的公司名；恰好一条推荐到这家 → 直接写姓名
 * （2026-09-21 起：那条记录是用户自己存的，存下就是同意）；对不上 → 推荐人栏按 OTHER_PERSON 跳过，一个字不猜。
 */
describe('推荐人预填接进手势填写路', () => {
  const REFERRAL_FIELDS = `
    <label for="referred_by">Referred by</label><input id="referred_by" type="text" />
    <label for="referrer_email">Referrer email</label><input id="referrer_email" type="email" />`;
  const REFERRALS = [{ name: 'Dana Li', company: 'Acme, Inc.' }];
  const released = () => livePolicy({ capabilities: { ...createBundledApplyPolicy().capabilities, 'set-referral': true } });
  function audits() {
    const collected: KernelFillAudit[] = [];
    return { collect: (audit: KernelFillAudit) => { collected.push(audit); }, audit: () => collected[0]! };
  }

  it('恰好一条推荐到这家 → 姓名这一轮直接写进页面（键 referralName）；邮箱栏仍不代填', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({ policy: released() }, REFERRAL_FIELDS), referrals: REFERRALS, jobCompany: 'ACME', onAudit: rows.collect } as never);
    const audit = rows.audit();
    expect(audit.view.rows.find((row) => row.label === 'Referred by')).toMatchObject({ status: 'FILLED', key: 'referralName' });
    expect(audit.questions.find((q) => q.text === 'Referred by')).toBeUndefined();
    expect(audit.prefills.size).toBe(0);
    expect(audit.view.rows.find((row) => row.label === 'Referrer email')).toMatchObject({ reason: 'OTHER_PERSON' });
    expect((document.getElementById('referred_by') as HTMLInputElement).value).toBe('Dana Li');
    expect((document.getElementById('referrer_email') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  it('申请卡片没有公司名、或这家没有推荐人 → 推荐人栏 OTHER_PERSON，没有建议', async () => {
    for (const over of [{}, { jobCompany: 'Initech' }]) {
      const rows = audits();
      await fillFromGesture({ ...input({ policy: released() }, REFERRAL_FIELDS), referrals: REFERRALS, ...over, onAudit: rows.collect } as never);
      expect(rows.audit().view.rows.find((row) => row.label === 'Referred by')).toMatchObject({ reason: 'OTHER_PERSON' });
      expect(rows.audit().prefills.size).toBe(0);
    }
  });

  it('能力位没放行 → 照旧 OTHER_PERSON（从前 "Referred by" 会被当普通字段填进申请人自己的名字）', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({}, REFERRAL_FIELDS), referrals: REFERRALS, jobCompany: 'Acme', onAudit: rows.collect } as never);
    expect(rows.audit().view.rows.find((row) => row.label === 'Referred by')).toMatchObject({ reason: 'OTHER_PERSON' });
    expect((document.getElementById('referred_by') as HTMLInputElement).value).toBe('');
  });
});

/**
 * 按学历／工作经历推出来的两类答案（2026-09-24，负责人：「跟 Jobright 一样」）接进手势填写路：
 * 「是否年满 18 岁」（档案里没有明确的值时，有教育或工作经历就答是）与「你在这家公司工作过吗」
 * （经历里有这家答是、没有答否）。
 *
 * 写入面一条都没放宽：over18 本来就是档案键，由 grant 点名（手势路的 grant 点名全部档案键；mission 路
 * 没点名就 LEASE_INVALID）；previouslyEmployedHere 由交来的经历集合与申请卡片的公司名放行。写入原语仍是
 * 选项控件那几个能力位，策略关了照样一题不写。
 */
describe('按学历／工作经历推出来的答案接进手势填写路', () => {
  const HISTORY_FIELDS = `
    <fieldset>
      <legend>Are you at least 18 years of age?</legend>
      <label><input name="adult" type="radio" value="yes" /> Yes</label>
      <label><input name="adult" type="radio" value="no" /> No</label>
    </fieldset>
    <fieldset>
      <legend>Have you ever worked for Acme?</legend>
      <label><input name="worked" type="radio" value="yes" /> Yes</label>
      <label><input name="worked" type="radio" value="no" /> No</label>
    </fieldset>`;
  const COLLECTIONS = {
    experiences: [{
      company: 'Initech', title: 'Engineer', employmentType: 'FULL_TIME',
      startDate: { year: 2019, month: 1 }, endDate: { year: 2021, month: 6 }, location: null, isCurrent: false,
    }],
  } as const;
  const OVER_18 = /^Are you at least 18/;
  const WORKED = /^Have you ever worked for Acme/;
  function audits() {
    const collected: KernelFillAudit[] = [];
    return {
      collect: (audit: KernelFillAudit) => { collected.push(audit); },
      row: (label: RegExp) => collected[0]?.view.rows.find((row) => label.test(row.label)),
    };
  }
  const checked = (name: string) =>
    [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].filter((radio) => radio.checked).map((radio) => radio.value);

  it('交来经历与公司名 → 两题这一轮直接写进页面：年满 18 选 Yes，没在这家工作过选 No；审计行带上依据', async () => {
    const rows = audits();
    const result = await fillFromGesture({ ...input({}, HISTORY_FIELDS), collections: COLLECTIONS, jobCompany: 'Acme', onAudit: rows.collect } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'over18')).toMatchObject({ ok: true });
    expect(result.outcomes.find((o) => o.key === 'previouslyEmployedHere')).toMatchObject({ ok: true });
    expect(checked('adult')).toEqual(['yes']);
    expect(checked('worked')).toEqual(['no']);
    expect(rows.row(OVER_18)).toMatchObject({ status: 'FILLED', key: 'over18', historyBasis: 'ADULT_FROM_HISTORY' });
    expect(rows.row(WORKED)).toMatchObject({ status: 'FILLED', key: 'previouslyEmployedHere', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' });
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });

  it('经历集合没交来 → 两题都不写，照旧交还用户（CHOICE_NO_DATA）', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({}, HISTORY_FIELDS), jobCompany: 'Acme', onAudit: rows.collect } as never);
    expect(rows.row(OVER_18)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
    expect(rows.row(WORKED)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
    expect(checked('adult')).toEqual([]);
    expect(checked('worked')).toEqual([]);
  });

  it('申请卡片没有公司名 → 「工作过吗」不写；年满 18 照样按经历写', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({}, HISTORY_FIELDS), collections: COLLECTIONS, onAudit: rows.collect } as never);
    expect(rows.row(OVER_18)).toMatchObject({ status: 'FILLED' });
    expect(rows.row(WORKED)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
    expect(checked('worked')).toEqual([]);
  });

  it('策略关掉了选择题的写入位 → 推出来的答案同样一题不写（不绕开能力位）', async () => {
    const base = livePolicy();
    const policy = { ...base, capabilities: { ...base.capabilities, 'set-select': false } };
    const result = await fillFromGesture({ ...input({ policy }, HISTORY_FIELDS), collections: COLLECTIONS, jobCompany: 'Acme' } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'over18')).toMatchObject({ ok: false });
    expect(result.outcomes.find((o) => o.key === 'previouslyEmployedHere')).toMatchObject({ ok: false });
    expect(checked('adult')).toEqual([]);
    expect(checked('worked')).toEqual([]);
  });

  it('mission 路：grant 没点名 over18 → 推出来的年满 18 按 LEASE_INVALID 拒写（不绕开 grant）', async () => {
    const { scan, profile, progress } = input({}, HISTORY_FIELDS);
    const outcomes = await fillFromGrant({
      grant: {
        missionId: 'm_1', missionStepId: 'ms_1', fieldKeys: ['firstName', 'email'], allowedActions: ['FILL'],
        executionLease: 'lease_test_1', leaseExpiresAt: Math.floor(Date.now() / 1000) + 120, intentVersion: 1,
        planDigest: '', jobIdentityHash: '', fieldSchemaVersion: 1,
        profileSnapshot: { revision: '1', deletionEpoch: '0', snapshotDigest: '' },
      },
      scan, profile, progress, policy: livePolicy(), collections: COLLECTIONS,
    } as never);
    expect(outcomes.find((o) => o.key === 'over18')).toMatchObject({ ok: false, reason: 'LEASE_INVALID' });
    expect(checked('adult')).toEqual([]);
  });
});

/**
 * 「Are you a transitioning service member?」（2026-09-24，负责人：跟 Jobright 一样；Shield AI 的 Lever 表单）：
 * 规则认题（键 transitioningServiceMember），内核按工作经历答——有经历、没有一段像军队服役就选 No，审计行带依据；
 * 有一段像军职、或经历集合没交来，就照旧交还用户。写入面由交来的经历集合放行（与行内角色同一份担保）。
 */
describe('「Are you a transitioning service member?」按工作经历答', () => {
  const FIELD = `
    <fieldset>
      <legend>Are you a transitioning service member?</legend>
      <label><input name="tsm" type="radio" value="no" /> No</label>
      <label><input name="tsm" type="radio" value="yes" /> Yes</label>
    </fieldset>`;
  const experience = (company: string, title: string) => ({
    company, title, employmentType: 'FULL_TIME', startDate: { year: 2019, month: 1 }, endDate: { year: 2021, month: 6 }, location: null, isCurrent: false,
  });
  const QUESTION = /^Are you a transitioning service member/;
  function audits() {
    const collected: KernelFillAudit[] = [];
    return { collect: (audit: KernelFillAudit) => { collected.push(audit); }, row: () => collected[0]?.view.rows.find((row) => QUESTION.test(row.label)) };
  }
  const checked = () => [...document.querySelectorAll<HTMLInputElement>('input[name="tsm"]')].filter((radio) => radio.checked).map((radio) => radio.value);

  it('交来经历、没有一段像军职 → 这一轮直接选 No，审计行带上依据', async () => {
    const rows = audits();
    const result = await fillFromGesture({
      ...input({}, FIELD), collections: { experiences: [experience('Initech', 'Engineer')] }, onAudit: rows.collect,
    } as never);
    expect(result.ok && result.outcomes.find((o) => o.key === 'transitioningServiceMember')).toMatchObject({ ok: true });
    expect(checked()).toEqual(['no']);
    expect(rows.row()).toMatchObject({ status: 'FILLED', key: 'transitioningServiceMember', historyBasis: 'NO_MILITARY_SERVICE_IN_HISTORY' });
  });

  it('有一段是军职（U.S. Army）→ 不写，照旧交还用户', async () => {
    const rows = audits();
    await fillFromGesture({
      ...input({}, FIELD), collections: { experiences: [experience('Initech', 'Engineer'), experience('U.S. Army', 'Signal Officer')] }, onAudit: rows.collect,
    } as never);
    expect(checked()).toEqual([]);
    expect(rows.row()).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('经历集合没交来 → 不写', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({}, FIELD), onAudit: rows.collect } as never);
    expect(checked()).toEqual([]);
    expect(rows.row()).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });
});

/**
 * 反着问的年龄题修掉之后（2026-09-24），手势路上真的写对：档案年满 18，「未满 18 吗」写 No。
 */
describe('反着问的年龄题接进手势填写路', () => {
  const MINOR_FIELD = `
    <fieldset>
      <legend>Are you under the age of 18?</legend>
      <label><input name="minor" type="radio" value="yes" /> Yes</label>
      <label><input name="minor" type="radio" value="no" /> No</label>
    </fieldset>`;
  const checked = (name: string) =>
    [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].filter((radio) => radio.checked).map((radio) => radio.value);

  it('档案年满 18 →「未满 18 吗」写 No（从前写的是 Yes）', async () => {
    const profile = { firstName: 'Taylor', email: 'taylor@example.test', over18: 'true' } as never;
    const result = await fillFromGesture({ ...input({ profile }, MINOR_FIELD) } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'over18')).toMatchObject({ ok: true });
    expect(checked('minor')).toEqual(['no']);
  });
});

/**
 * 「年满 18 且有权在美国工作」修掉之后（2026-09-24），手势路上两半都有依据才写 Yes（键 workAuthorization，
 * 由授权记录与能力位放行）；只有年龄一半就不写。
 */
describe('「年满 18 且有权工作」接进手势填写路', () => {
  const BOTH_FIELD = `
    <fieldset>
      <legend>Are you at least 18 years of age and legally authorized to work in the United States?</legend>
      <label><input name="both" type="radio" value="yes" /> Yes</label>
      <label><input name="both" type="radio" value="no" /> No</label>
    </fieldset>`;
  const PROFILE_ADULT = { firstName: 'Taylor', email: 'taylor@example.test', over18: 'true' } as never;
  const released = () => livePolicy({ capabilities: { ...createBundledApplyPolicy().capabilities, 'set-work-authorization': true } });
  const checked = (name: string) =>
    [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].filter((radio) => radio.checked).map((radio) => radio.value);

  it('档案年满 18、美国授权「是」→ 写 Yes，键 workAuthorization', async () => {
    const result = await fillFromGesture({
      ...input({ policy: released(), profile: PROFILE_ADULT }, BOTH_FIELD),
      workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }],
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'workAuthorization')).toMatchObject({ ok: true });
    expect(checked('both')).toEqual(['yes']);
  });

  it('没有授权记录 → 不写（不再只凭年龄答 Yes）', async () => {
    await fillFromGesture({ ...input({ policy: released(), profile: PROFILE_ADULT }, BOTH_FIELD) } as never);
    expect(checked('both')).toEqual([]);
  });
});

/**
 * 按资料推出来的几类（2026-10-04，10-03 批测里「AI 在资料里找不到依据」那一批）接进手势填写路：语言题、到办公室上班、
 * 工作年限、现在在读吗、服过兵役吗。内核直接答，这几题不再送 AI。
 *
 * 写入面一条都没放宽：语言、年限、在读、兵役的数据面是调用方交来的集合（与行内角色同一份担保）；到办公室那一类的依据是
 * 扁平键 preferredWorkModes，grant 点名了它才放行（mission 路没点名就 LEASE_INVALID）。写入原语的能力位照常收窄。
 */
describe('按资料推出来的几类接进手势填写路', () => {
  const FIELDS = `
    <fieldset>
      <legend>Are you fluent in spoken and written English?</legend>
      <label><input name="english" type="radio" value="yes" /> Yes</label>
      <label><input name="english" type="radio" value="no" /> No</label>
    </fieldset>
    <fieldset>
      <legend>Can you work from our Austin office three days a week?</legend>
      <label><input name="office" type="radio" value="yes" /> Yes</label>
      <label><input name="office" type="radio" value="no" /> No</label>
    </fieldset>
    <label for="yoe">Years of Experience</label><input id="yoe" type="text" />`;
  const COLLECTIONS = {
    experiences: [{
      company: 'Initech', title: 'Engineer', employmentType: 'FULL_TIME',
      startDate: { year: 2020, month: 1 }, endDate: { year: 2023, month: 6 }, location: null, isCurrent: false,
    }],
    languages: [{ language: 'English', proficiency: 'PROFESSIONAL' }, { language: 'Mandarin', proficiency: 'NATIVE_OR_BILINGUAL' }],
  } as const;
  const OFFICE_PROFILE = { firstName: 'Taylor', email: 'taylor@example.test', city: 'Austin', addressRegion: 'TX', preferredWorkModes: 'HYBRID' } as never;
  const checked = (name: string) =>
    [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].filter((radio) => radio.checked).map((radio) => radio.value);
  function audits() {
    const collected: KernelFillAudit[] = [];
    return {
      collect: (audit: KernelFillAudit) => { collected.push(audit); },
      row: (label: RegExp) => collected[0]?.view.rows.find((row) => label.test(row.label)),
    };
  }

  it('交来集合、当天与档案 → 三题这一轮直接写进页面，审计行带上依据', async () => {
    const rows = audits();
    const result = await fillFromGesture({
      ...input({ profile: OFFICE_PROFILE }, FIELDS), collections: COLLECTIONS, today: '2026-10-04', onAudit: rows.collect,
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'languageAnswer')).toMatchObject({ ok: true });
    expect(result.outcomes.find((o) => o.key === 'workArrangement')).toMatchObject({ ok: true });
    expect(result.outcomes.find((o) => o.key === 'experienceYears')).toMatchObject({ ok: true });
    expect(checked('english')).toEqual(['yes']);
    expect(checked('office')).toEqual(['yes']);
    // 2020-01 → 2023-06：42 个月，3 年。
    expect((document.getElementById('yoe') as HTMLInputElement).value).toBe('3');
    expect(rows.row(/^Are you fluent/)).toMatchObject({ status: 'FILLED', key: 'languageAnswer', historyBasis: 'LANGUAGES_IN_PROFILE' });
    expect(rows.row(/^Can you work from our Austin office/)).toMatchObject({ status: 'FILLED', key: 'workArrangement', historyBasis: 'WORK_MODES_IN_PROFILE' });
    expect(rows.row(/^Years of Experience/)).toMatchObject({ status: 'FILLED', key: 'experienceYears', historyBasis: 'EXPERIENCE_YEARS_FROM_HISTORY' });
  });

  it('集合没交来、没给当天 → 语言与年限不写（照旧交还，可以送 AI）；办公方式只看档案，照样写', async () => {
    const rows = audits();
    await fillFromGesture({ ...input({ profile: OFFICE_PROFILE }, FIELDS), onAudit: rows.collect } as never);
    expect(checked('english')).toEqual([]);
    expect((document.getElementById('yoe') as HTMLInputElement).value).toBe('');
    expect(rows.row(/^Are you fluent/)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
    expect(checked('office')).toEqual(['yes']);
  });

  it('mission 路：grant 没点名 preferredWorkModes、也没交集合 → 一题不写', async () => {
    const { scan, progress } = input({}, FIELDS);
    const outcomes = await fillFromGrant({
      grant: {
        missionId: 'm_1', missionStepId: 'ms_1', fieldKeys: ['firstName', 'email'], allowedActions: ['FILL'],
        executionLease: 'lease_test_1', leaseExpiresAt: Math.floor(Date.now() / 1000) + 120, intentVersion: 1,
        planDigest: '', jobIdentityHash: '', fieldSchemaVersion: 1,
        profileSnapshot: { revision: '1', deletionEpoch: '0', snapshotDigest: '' },
      },
      scan, profile: OFFICE_PROFILE, progress, policy: livePolicy(),
    } as never);
    expect(outcomes.find((o) => o.key === 'workArrangement')).toMatchObject({ ok: false, reason: 'LEASE_INVALID' });
    expect(checked('office')).toEqual([]);
  });
});

/**
 * 出差题（2026-10-04，argoland #738 的「出差最多能接受多少」）接进手势填写路：交来了确认过的上限就按它答，审计行带依据；
 * 没交来就照旧交还用户。写入面由交来的上限放行，mission 路没有它就不写。
 */
describe('出差题按资料里的出差上限答', () => {
  const FIELD = `
    <fieldset>
      <legend>Are you able to travel occasionally to customer sites?</legend>
      <label><input name="travel" type="radio" value="yes" /> Yes</label>
      <label><input name="travel" type="radio" value="no" /> No</label>
    </fieldset>`;
  const checked = () => [...document.querySelectorAll<HTMLInputElement>('input[name="travel"]')].filter((radio) => radio.checked).map((radio) => radio.value);

  it('上限 25%：偶尔出差选 Yes，审计行带依据', async () => {
    const collected: KernelFillAudit[] = [];
    const result = await fillFromGesture({ ...input({}, FIELD), travelPercentMax: 25, onAudit: (audit: KernelFillAudit) => { collected.push(audit); } } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.find((o) => o.key === 'travelAnswer')).toMatchObject({ ok: true });
    expect(checked()).toEqual(['yes']);
    expect(collected[0]?.view.rows.find((row) => /^Are you able to travel/.test(row.label))).toMatchObject({ status: 'FILLED', key: 'travelAnswer', historyBasis: 'TRAVEL_IN_PROFILE' });
  });

  it('不出差：选 No', async () => {
    await fillFromGesture({ ...input({}, FIELD), travelPercentMax: 0 } as never);
    expect(checked()).toEqual(['no']);
  });

  it('资料里没答 → 不写', async () => {
    await fillFromGesture({ ...input({}, FIELD) } as never);
    expect(checked()).toEqual([]);
  });
});
