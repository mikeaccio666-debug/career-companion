import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFieldDescriptor } from '../src/contracts';
import { buildApplyPlan } from '../src/engine';
import { doverAdapter } from '../src/sites/dover/applyForm';

/**
 * Dover adapter，结构来自 2026-08-23 对
 * `app.dover.com/apply/<slug>/<uuid>` 真实在招岗位的只读实测
 * （50-证据库 §F.8-d）。
 *
 * 这份夹具刻意保住三件实测到的、会咬人的事：
 *
 *  1. **label 全是零宽空格**（`​`）。这一家没有可用的标签文案，
 *     `name` 是唯一信号——所以任何一条断言如果能靠标签过，它就没在测真链路。
 *  2. **两个 `accept=".pdf"` 的文件输入**：第一个是厂商自己的简历解析器
 *     （`Autofill from resume`），第二个才是真附件栏，而它的文案里一个
 *     resume 字都没有。正向白名单会正好挑中假的。
 *  3. **Cloudflare Turnstile 的回填输入**在同一个 form 里。
 *
 * 全部取值为合成值。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** 零宽空格：实测这一家的 label 就是这个，不是空串。 */
const ZWSP = '​';

/**
 * 2026-09-15 复测（同一租户另一岗位 aa378aa1-…）：两个文件栏都是 react-dropzone
 * 形状——`div[role=button]` 包着 `display:none` 的 input。真附件栏上方多了一个
 * `Resume *` 标签块（隔两层的前置兄弟）；dropzone 自己的文案里仍然没有 resume 字。
 */
function mountDoverFixture(): void {
  document.body.innerHTML = `
    <div id="root">
      <div class="InboundApplication__FormWrapper-cAfoSR">
        <form>
          <div>
            <div role="button" tabindex="0">
              <input type="file" accept=".pdf" multiple autocomplete="off" tabindex="-1" style="display: none;" />
              <div><span>Autofill from resume</span><span>Drag &amp; drop or upload to autofill your application.</span><span>Upload file</span></div>
            </div>
          </div>
          <label for="r3">${ZWSP}</label>
          <input id="r3" name="firstName" type="text" required />
          <label for="r4">${ZWSP}</label>
          <input id="r4" name="lastName" type="text" required />
          <label for="r5">${ZWSP}</label>
          <input id="r5" name="email" type="email" required />
          <label for="r6">${ZWSP}</label>
          <input id="r6" name="linkedinUrl" type="text" required />
          <label for="r7">${ZWSP}</label>
          <input id="r7" name="phoneNumber" type="text" />
          <div>
            <div class="FormLabel">Resume *</div>
            <div>
              <div role="button" tabindex="0">
                <input type="file" accept=".pdf" multiple autocomplete="off" tabindex="-1" style="display: none;" />
                <div><span>Drag and drop file or browse computer(PDF, 5 MB maximum)</span></div>
              </div>
            </div>
          </div>
          <input name="cf-turnstile-response" type="hidden" />
        </form>
      </div>
    </div>`;
}

function scan(): ApplyFieldDescriptor[] {
  mountDoverFixture();
  const root = doverAdapter.resolveRoot(document);
  expect(root, '锚点没认出来——后面每条断言都是空跑').toBeTruthy();
  return [...doverAdapter.scan(root!)];
}

const UUID = '885f0f71-a784-4957-a1f2-e3b6980d6ed0';

describe('Dover adapter · 申请路径', () => {
  it('只认 /apply/<slug>/<uuid>', () => {
    expect(doverAdapter.isApplyPath(`/apply/kubbly/${UUID}`)).toBe(true);
    expect(doverAdapter.isApplyPath(`/apply/kubbly/${UUID}/`)).toBe(true);
    // slug 保留雇主原始大小写（实测 /apply/Paces/ 与 /apply/mixrank/ 并存）。
    expect(doverAdapter.isApplyPath(`/apply/Paces/${UUID}`)).toBe(true);
  });

  it('同一主机上的后台路径一条都不认 —— 这一家分不开主机，只能靠这里', () => {
    for (const path of ['/login', '/', '/settings/company', '/candidates/9f2a', `/apply/kubbly`]) {
      expect(doverAdapter.isApplyPath(path), path).toBe(false);
    }
  });
});

describe('Dover adapter · name 是唯一信号', () => {
  it('五个核心字段全部认出来', () => {
    const fields = scan();
    const keyOf = (name: string) =>
      fields.find((f) => f.element.getAttribute('name') === name)?.key ?? null;
    expect(keyOf('firstName')).toBe('firstName');
    expect(keyOf('lastName')).toBe('lastName');
    expect(keyOf('email')).toBe('email');
    expect(keyOf('linkedinUrl')).toBe('linkedinUrl');
    expect(keyOf('phoneNumber')).toBe('phone');
  });

  it('标签这条路在这一家是死的 —— 把 name 全摘掉就一个都认不出', () => {
    // ⚠️ 这条不是补覆盖率：它证明上面那五个键**真的**来自 name。
    // 如果哪天有人给这家加了标签兜底，这条会红，那时要重新想清楚——
    // 零宽空格标签配上模糊匹配，是"认错字段"的温床。
    mountDoverFixture();
    for (const el of document.querySelectorAll('input[name]')) {
      if (el.getAttribute('name') !== 'cf-turnstile-response') el.removeAttribute('name');
    }
    const fields = [...doverAdapter.scan(doverAdapter.resolveRoot(document)!)];
    expect(fields.filter((f) => f.key !== null).map((f) => f.key)).toEqual([]);
  });

  it('Turnstile 的回填输入不进扫描面', () => {
    const fields = scan();
    expect(fields.some((f) => (f.element.getAttribute('name') ?? '').includes('turnstile'))).toBe(
      false,
    );
  });
});

describe('Dover adapter · 两个 .pdf 文件栏', () => {
  /**
   * 2026-09-15 复测：真附件栏上方多了 `Resume *`（隔两层的前置兄弟），dropzone 自己
   * 的文案里仍然一个 resume 字都没有；第一个仍是厂商的简历解析器
   * （Autofill from resume），传上去是回填表单不是附件。邻近上下文只许认出前者。
   */
  it('引擎层：`Resume *` 认出真附件栏，Autofill 解析器仍报需手动填', () => {
    const fields = scan();
    const root = doverAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'dover', root, fields },
      { firstName: 'Ada' },
      { resumeFileName: 'Ada.pdf', resumeHostConfirmed: true },
    );
    const files = fields.filter((f) => (f.element as HTMLInputElement).type === 'file');
    expect(files, '两个文件栏都该在扫描面里').toHaveLength(2);
    const [decoy, real] = files;
    expect(plan.entries.filter((entry) => entry.key === 'resumeFile').map((entry) => entry.element)).toEqual([real!.element]);
    expect(plan.skipped.find((skip) => skip.element === decoy!.element)?.reason).toBe('UNSUPPORTED_CONTROL');
  });
});
