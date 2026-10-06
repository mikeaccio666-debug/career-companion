import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { ADAPTERS } from '../src/bundledAdapters';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 简历文件目标不可写，**不该把整页其余字段一起废掉**。
 *
 * 实测发现（2026-08-21，给 Lever 补填充率夹具时暴露）：同一个失败，因为文件
 * 输入在 DOM 里的位置不同，后果差七倍——
 *
 * ```
 *   Lever     （file 排第一）  resumeFile=IDENTITY_CHANGED → 其余 6 个全 ABORTED
 *   Greenhouse（file 排最后）  3 个 text 全 ok，只有 resumeFile 失败
 * ```
 *
 * 根因是 `runner.ts` 里那道 preflight：
 * `isApprovedResumeFileTarget` = 身份对 ∧ 未 disabled ∧ 有可见触发器，
 * **三个完全不同的原因塌成同一个码 `IDENTITY_CHANGED`，而且都 break 整轮**。
 *
 * 三者里只有第一个是页面级信号（我们批准过的字段身份变了 ⇒ 页面可能重渲染，
 * 保守停手合理）。后两个只说明"这一栏现在用不了"，跟其他文本字段毫无关系。
 *
 * 真实后果：用户没传简历、或雇主把上传控件藏在一个按钮后面（懒渲染），
 * Lever 形状的页面就**一个字段都不填**，而给用户看的原因码是 `ABORTED`
 * ——一个他既看不懂、也不指向任何可操作动作的码。
 *
 * 同一分支里的邻居本来就是这个姿势：`CAPABILITY_DISABLED` 与能力位 preflight
 * 失败都是 `continue` 不中断。这条把文件目标对齐到同一纪律。
 *
 * 2026-09-10 起计划把文件条目排到最后（宿主收下文件常会卸掉上传控件，
 * 后面字段的序号身份会变），所以 file 在 DOM 里排第几已经不影响执行顺序。
 */

afterEach(() => {
  document.documentElement.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
};

/** file 输入**排在最前**——正是 Lever 真实结构的形状。 */
function mountFileFirstForm(fileAttrs = ''): void {
  document.documentElement.innerHTML = `
    <body>
      <form id="application-form">
        <div class="application-field">
          <input type="file" name="resume" id="resume-upload-input" ${fileAttrs} />
        </div>
        <label for="first_name">First Name*</label>
        <input id="first_name" type="text" autocomplete="given-name" required />
        <label for="last_name">Last Name*</label>
        <input id="last_name" type="text" autocomplete="family-name" required />
        <label for="email">Email*</label>
        <input id="email" type="email" autocomplete="email" required />
      </form>
    </body>`;
}

async function run() {
  const adapter = ADAPTERS['greenhouse'];
  const root = adapter!.resolveRoot(document);
  expect(root, '适配器没认出表单').not.toBeNull();
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...adapter!.scan(root!)] },
    PROFILE,
    { resumeFileName: 'resume.pdf', resumeHostConfirmed: true },
  );
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
    journal: createUndoJournal(),
    root: root!,
    policy: testApplyPolicy(),
    resolveResumeFile: async () =>
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'resume.pdf', { type: 'application/pdf' }),
  });
  return {
    plan,
    summary,
    byKey: Object.fromEntries(
      summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]),
    ) as Record<string, string>,
  };
}

describe('文件目标不可写不拖垮整页', () => {
  it('文件输入排第一且本环境量不到几何时，其余文本字段照常填上', async () => {
    // happy-dom 没有布局引擎，所有元素 getBoundingClientRect 恒 0×0，
    // 于是 hasVisibleFileTrigger 一定 fail closed——这正是真实浏览器里
    // "上传控件被藏起来"的等价形态。
    mountFileFirstForm();
    const { byKey } = await run();

    expect(
      [byKey['firstName'], byKey['lastName'], byKey['email']],
      '文件那一栏不可写，把整页其余字段一起废成 ABORTED 了',
    ).toEqual(['ok', 'ok', 'ok']);
    expect(
      byKey['resumeFile'],
      '文件栏本身仍要如实报失败——不许为了不级联就假装成功',
    ).not.toBe('ok');
  });

  it('不可写的文件目标不报 IDENTITY_CHANGED——身份没变过', async () => {
    mountFileFirstForm();
    const { byKey } = await run();
    expect(
      byKey['resumeFile'],
      'disabled / 无可见触发器被报成"身份变了"，用户与下一个接手的人都会查错方向',
    ).not.toBe('IDENTITY_CHANGED');
  });

  it('disabled 的文件输入同样不拖垮其余字段', async () => {
    mountFileFirstForm('disabled');
    const { byKey } = await run();
    expect([byKey['firstName'], byKey['lastName'], byKey['email']]).toEqual(['ok', 'ok', 'ok']);
  });

  /**
   * 反向探针：**身份真的漂了**仍然是页面级信号，不许被洗成别的码。
   *
   * 文件条目现在排在最后，它后面已经没有字段可停；2026-09-23 起漂移不连坐、不再置
   * `abortedBy`，页面级信号改记在 `identityDrift` 里（调用方据此重扫）——但它必须
   * 如实出现，不能把"页面已经不是用户批准的那个"悄悄吞掉，也一个字节都不能挂上去。
   */
  it('反向探针：文件目标的身份真漂了，这一栏报 IDENTITY_CHANGED、不挂文件，整轮如实记一次漂移', async () => {
    mountFileFirstForm();
    const adapter = ADAPTERS['greenhouse'];
    const root = adapter!.resolveRoot(document);
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root: root!, fields: [...adapter!.scan(root!)] },
      PROFILE,
      { resumeFileName: 'resume.pdf', resumeHostConfirmed: true },
    );

    // 把那个 file input 换成一个身份完全不同的控件：不再是被批准的简历目标。
    const fileEntry = plan.entries.find((entry) => entry.kind === 'file');
    expect(fileEntry, '夹具里没有 file 条目，这条对照测不了任何东西').toBeTruthy();
    (fileEntry!.element as HTMLInputElement).setAttribute('name', 'transcript');
    (fileEntry!.element as HTMLInputElement).setAttribute('id', 'transcript-upload');

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
      journal: createUndoJournal(),
      root: root!,
      policy: testApplyPolicy(),
      resolveResumeFile: async () =>
        new File([new Uint8Array([0x25])], 'resume.pdf', { type: 'application/pdf' }),
    });
    const byKey = Object.fromEntries(
      summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]),
    ) as Record<string, string>;

    expect(byKey['resumeFile']).toBe('IDENTITY_CHANGED');
    expect((fileEntry!.element as HTMLInputElement).files?.length ?? 0, '身份变了的上传栏收到了文件').toBe(0);
    expect(summary.identityDrift, '身份漂移是页面级信号，整轮必须如实记下').toBe(1);
    expect(summary.abortedBy, '写前漂移只放弃那一栏，不再是整轮中止').toBeNull();
    expect(
      [byKey['firstName'], byKey['lastName'], byKey['email']],
      '文件排在最后，漂移发现时其余字段早已写完，不该被追溯改成 ABORTED',
    ).toEqual(['ok', 'ok', 'ok']);
  });
});
