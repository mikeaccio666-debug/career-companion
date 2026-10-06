import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAuditView } from '../src/audit';
import { buildApplyPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 文件写入的回读判决必须如实传出来（2026-09-17）。
 *
 * 真实回归：2026-09-17 那轮 121 个 Ashby posting，必填缺口 107 条里 89 条是同一
 * 栏 —— `resumeFile` 报 FILLED_UNVERIFIED。同一轮的 Greenhouse 15 条 resumeFile
 * **也全是** FILLED_UNVERIFIED，只是 Greenhouse 那栏 `required=false`，不进必填
 * 分母，所以没人看见。两家的差别只在必填标记，不在写入路径。
 *
 * 当天对 jobs.ashbyhq.com 真实 application 页的只读复核（ats-lab 构建，未提交）：
 * 写完之后 `_systemfield_resume` 仍 `isConnected`、`files.length === 1`、
 * `willValidate && valid` 从 false 翻成 true。也就是说**回读完全读得到**——
 * `attachHostFile` 自己就用 `hasExactFile` 读过一遍，只是 `Result<void, …>`
 * 没有位置把这个判决带出来，runner 于是对每一次成功写入无条件盖上 unverified。
 *
 * 文件控件的回读不是字符串比对，是 `input.files` 的对象同一性。读得到就不该
 * 报"读不回"：FILLED_UNVERIFIED 不进 `requiredHandled`，用户因此被告知"这一栏
 * 你自己去看一眼"，而那一栏其实已经填好了。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function stubVisibleNativeFileInput(input: HTMLInputElement): void {
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    width: 230,
    height: 40,
    top: 300,
    left: 0,
    right: 230,
    bottom: 340,
    x: 0,
    y: 300,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Ashby 的实测形状：required 的简历栏 + 一个非简历上传栏。 */
function mountResumeForm(): { root: ReturnType<typeof createScanRoot>; resume: HTMLInputElement } {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label><input id="email" type="email" />
      <label for="resume">Resume</label>
      <input id="resume" type="file" accept=".pdf,.doc,.docx" required />
    </form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const resume = document.getElementById('resume') as HTMLInputElement;
  stubVisibleNativeFileInput(resume);
  return { root: createScanRoot(form, []), resume };
}

function plan() {
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，后面的断言就是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    { email: 'ada@example.test' },
    { resumeFileName: 'Ada_Lovelace.pdf', resumeHostConfirmed: true },
  );
}

const pdf = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Ada_Lovelace.pdf', {
    type: 'application/pdf',
  });

async function fill(
  root: ReturnType<typeof createScanRoot>,
  built: ReturnType<typeof plan>,
  extra: Partial<Parameters<typeof runApplyPlan>[0]> = {},
) {
  return runApplyPlan({
    plan: built,
    auth: testAuthority(built.fingerprint, 'fill', [
      ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
    ]),
    journal: createUndoJournal(),
    root,
    policy: testApplyPolicy(),
    resolveResumeFile: async () => pdf(),
    ...extra,
  });
}

describe('简历文件的回读判决', () => {
  it('回读读得到那个 File 时报"已验证"，不报 unverified', async () => {
    const { root, resume } = mountResumeForm();
    const built = plan();

    const summary = await fill(root, built);

    // 前提：文件真的挂上去了，并且宿主那边这一栏还在（Ashby 实测形状）。
    expect(resume.isConnected).toBe(true);
    expect(resume.files?.length, '文件没挂上去，后面的断言是空转').toBe(1);

    const result = summary.results.find((entry) => entry.key === 'resumeFile');
    expect(result?.ok).toBe(true);
    expect(
      result?.ok === true ? result.unverified : 'no-result',
      '回读明明读得到 input.files，却仍报"读不回确认"',
    ).toBeUndefined();
  });

  it('回读确认过的简历栏计入 requiredHandled', async () => {
    const { root } = mountResumeForm();
    const built = plan();

    const summary = await fill(root, built);
    const view = buildAuditView(built, summary.results);
    const row = view.rows.find((item) => item.key === 'resumeFile');

    expect(row?.required, '这一栏不是必填，必填分母的断言就是空转').toBe(true);
    expect(row?.status).toBe('FILLED');
    expect(
      view.requiredHandled,
      'FILLED_UNVERIFIED 不进 requiredHandled —— 已经填好的简历栏被算成"还没办完"',
    ).toBe(view.requiredTotal);
  });

  it('宿主判这一栏无效时报 HOST_REJECTED，与文本同一纪律', async () => {
    const { root, resume } = mountResumeForm();
    const built = plan();

    const summary = await fill(root, built, {
      readHostValidation: (element: Element) =>
        element === resume ? { ariaInvalid: 'true' } : {},
    });

    const result = summary.results.find((entry) => entry.key === 'resumeFile');
    expect(result?.ok).toBe(false);
    expect(
      result?.ok === false ? result.reason : null,
      '宿主红着一条错误，面板却报"已填"',
    ).toBe('HOST_REJECTED');
  });

  /**
   * 反向锁：宿主在 change 处理器里把 input 卸掉、换成一个文件名 chip
   * （Greenhouse 2026-09-10 实测形状）。这时**真的**读不回来，必须继续报
   * unverified —— 修这条 bug 不许把"读不到"也一起洗成绿的。
   */
  it('宿主在 change 里卸掉 input 时仍报 unverified', async () => {
    const { root, resume } = mountResumeForm();
    const built = plan();
    resume.addEventListener('change', () => resume.remove());

    const summary = await fill(root, built);

    expect(resume.isConnected, '宿主没有卸掉 input，这条反向锁是空转').toBe(false);
    const result = summary.results.find((entry) => entry.key === 'resumeFile');
    expect(result?.ok).toBe(true);
    expect(
      result?.ok === true ? result.unverified : undefined,
      '读不回来的写入被冒充成"已验证"',
    ).toBe(true);
  });
});
