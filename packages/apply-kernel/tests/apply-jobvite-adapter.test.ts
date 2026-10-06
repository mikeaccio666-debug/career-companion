import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFieldDescriptor } from '../src/contracts';
import { isNonResumeFileField, isResumeFileField } from '../src/dict/guards';
import { buildApplyPlan } from '../src/engine';
import { jobviteAdapter } from '../src/sites/jobvite/applyForm';

/**
 * Jobvite adapter，结构来自 2026-08-23 对
 * `jobs.jobvite.com/ninjaone/job/<id>/apply` 真实在招岗位的实测
 * （50-证据库 §F.8-a／§F.8-g）。**同意闸由负责人本人过**，我们在之后接管。
 *
 * 这份夹具保住四件实测到的事：
 *
 *  1. **钩子是标准 HTML `autocomplete` 词表** —— 九家里唯一一家。
 *     `name` 与 `id` 反而是逐字段 token（`input-yH3T0fwn`），跨租户不可用，
 *     所以夹具里刻意保留那些 token：任何靠 name/id 过的断言都没在测真链路。
 *  2. **锚点是 `div.jv-apply-form` 而不是 `<form>`** —— 两个文件输入在 form
 *     **之外**（实测 form 内 10 个、容器内 14 个）。
 *  3. **两个文件输入的 label 都只是 `File`** —— 唯一的区分信号是旁邻文本。
 *  4. `g-recaptcha-response` 在场。
 *
 * 全部取值为合成值。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountJobviteFixture(): void {
  document.body.innerHTML = `
    <article class="jv-page-body">
      <div class="jv-wrapper">
        <div class="jv-form jv-apply-form">
          <form name="scopeData.applyForm">
            <label for="jv-field-yH3T0fwn">Chosen First Name*</label>
            <input id="jv-field-yH3T0fwn" name="input-yH3T0fwn" type="text" autocomplete="given-name" required />
            <label for="jv-field-yG3T0fwm">Chosen Last Name*</label>
            <input id="jv-field-yG3T0fwm" name="input-yG3T0fwm" type="text" autocomplete="family-name" required />
            <label for="jv-field-yF3T0fwl">Email*</label>
            <input id="jv-field-yF3T0fwl" name="input-yF3T0fwl" type="text" autocomplete="email" required />
            <label for="jv-field-yI3T0fwo">Cell Phone*</label>
            <input id="jv-field-yI3T0fwo" name="input-yI3T0fwo" type="tel" autocomplete="tel" required />
            <label for="jv-field-yL3T0fwr">Country*</label>
            <select id="jv-field-yL3T0fwr" name="input-yL3T0fwr" autocomplete="country-name" required>
              <option value="">Select</option><option value="DE">Germany</option>
            </select>
            <label for="jv-field-yK3T0fwq">State*</label>
            <select id="jv-field-yK3T0fwq" name="input-yK3T0fwq" autocomplete="address-level1" required>
              <option value="">Select</option><option value="BE">Berlin</option>
            </select>
            <label for="jv-field-yJ3T0fwp">City*</label>
            <input id="jv-field-yJ3T0fwp" name="input-yJ3T0fwp" type="text" autocomplete="address-level2" required />
            <textarea id="g-recaptcha-response" name="g-recaptcha-response"></textarea>
          </form>
          <!-- ⚠️ 两个文件输入在 <form> **之外**：锚点必须是容器，不是 form。 -->
          <div><label for="file-input-0">File</label>
            <input id="file-input-0" type="file" />
            <textarea id="jv-paste-resume-textarea0" placeholder="Type or paste your Resume here"></textarea></div>
          <div><label for="file-input-1">File</label>
            <input id="file-input-1" type="file" />
            <textarea id="jv-paste-resume-textarea1" placeholder="Type or paste your Cover Letter here"></textarea></div>
        </div>
      </div>
    </article>`;
}

function scan(): ApplyFieldDescriptor[] {
  mountJobviteFixture();
  const root = jobviteAdapter.resolveRoot(document);
  expect(root, '锚点 div.jv-apply-form 没认出来').toBeTruthy();
  return [...jobviteAdapter.scan(root!)];
}

describe('Jobvite adapter · 申请路径', () => {
  it('只认 /job/<id>/apply', () => {
    expect(jobviteAdapter.isApplyPath('/ninjaone/job/oZNAAfwG/apply')).toBe(true);
    expect(jobviteAdapter.isApplyPath('/ninjaone/job/oZNAAfwG/apply/')).toBe(true);
    // 岗位描述页没有表单；列表页更没有。认作申请面只会让 resolveRoot 反复扑空。
    expect(jobviteAdapter.isApplyPath('/ninjaone/job/oZNAAfwG')).toBe(false);
    expect(jobviteAdapter.isApplyPath('/ninjaone/search')).toBe(false);
  });
});

describe('Jobvite adapter · autocomplete 是钩子', () => {
  it('五个有档案键的字段全部认出来', () => {
    const fields = scan();
    const keyOf = (ac: string) =>
      fields.find((f) => f.element.getAttribute('autocomplete') === ac)?.key ?? null;
    expect(keyOf('given-name')).toBe('firstName');
    expect(keyOf('family-name')).toBe('lastName');
    expect(keyOf('email')).toBe('email');
    expect(keyOf('tel')).toBe('phone');
    expect(keyOf('address-level2')).toBe('city');
  });

  // ⚠️ 这一条防的是「attrMap 是死数据而没人发现」——上面那五个键可能其实是标签
  // 兜底认出来的（这一家标签也很干净）。
  //
  // 2026-09-22 起标签那条路**确实**认得出 Email 了（给 email / addressLine1 /
  // addressPostalCode 补了 labelPatterns，因为自建域页面上 attrMap 整条路不成立）。
  // 所以原来那句「摘掉 autocomplete 就一个都认不出」不再是对的不变量。用意没变，
  // 换一种更强的问法：两条路都拿掉时一个都不许认出，只还原钩子时五个键必须回来。
  const strip = (): void => {
    for (const el of document.querySelectorAll('[autocomplete]')) el.removeAttribute('autocomplete');
    for (const el of document.querySelectorAll('label')) el.textContent = ' ';
  };

  it('钩子与标签都拿掉：一个都不许认出（两条路都不会凭空造键）', () => {
    mountJobviteFixture();
    strip();
    const fields = [...jobviteAdapter.scan(jobviteAdapter.resolveRoot(document)!)];
    expect(fields.filter((f) => f.key !== null).map((f) => f.key)).toEqual([]);
  });

  it('只把钩子还原：五个键必须回来 —— 证明 attrMap 真的在干活', () => {
    mountJobviteFixture();
    const hooks = [...document.querySelectorAll('[autocomplete]')].map(
      (el) => [el, el.getAttribute('autocomplete')!] as const,
    );
    strip();
    for (const [el, value] of hooks) el.setAttribute('autocomplete', value);
    const fields = [...jobviteAdapter.scan(jobviteAdapter.resolveRoot(document)!)];
    const keyOf = (ac: string) =>
      fields.find((f) => f.element.getAttribute('autocomplete') === ac)?.key ?? null;
    expect(keyOf('given-name')).toBe('firstName');
    expect(keyOf('family-name')).toBe('lastName');
    expect(keyOf('email')).toBe('email');
    expect(keyOf('tel')).toBe('phone');
    expect(keyOf('address-level2')).toBe('city');
  });

  it('国家与州各归各的键 —— 不许被塞进 location 或 city', () => {
    // 2026-09-22 改：这条原先断言「country/state 没有档案键」，理由是「APPLY_FIELD_KEYS
    // 是 11 键闭集」。那个前提早就不成立了——闭集现在 38 键，`addressCountry` 与
    // `addressRegion` 都在里面，后端下发的 35 键放行名单里也都有。旧断言把「这一版还没
    // 扩键」写成了永久事实，于是 jobvite 的这两栏在真实页面上一直落进「没把握，没敢填」
    //（2026-09-22 实测各 3 次）。
    //
    // 这一条真正要守的从来是后半句：**不许被塞进 `location` 或 `city`**。那才是真事故。
    const fields = scan();
    const keyOf = (ac: string) =>
      fields.find((x) => x.element.getAttribute('autocomplete') === ac)?.key ?? null;
    expect(keyOf('country-name')).toBe('addressCountry');
    expect(keyOf('address-level1')).toBe('addressRegion');
    for (const ac of ['country-name', 'address-level1']) {
      expect(['location', 'city']).not.toContain(keyOf(ac));
    }
  });

  it('reCAPTCHA 的回填控件不进扫描面', () => {
    expect(
      scan().some((f) => (f.element.getAttribute('name') ?? '').includes('recaptcha')),
    ).toBe(false);
  });
});

describe('Jobvite adapter · 锚点必须罩住 form 之外的文件输入', () => {
  it('两个文件输入都在扫描面里', () => {
    // 它们在 <form> **之外**（实测 form 内 10 个控件、容器内 14 个）。
    // 锚点写成 `form` 的话这两个永远扫不到，而那正是简历上传要落脚的地方。
    const files = scan().filter((f) => f.element.getAttribute('type') === 'file');
    expect(files, '文件输入没进扫描面——锚点选错了，简历这一栏会永远不存在').toHaveLength(2);
  });

  it('适配器层面它们仍然没有档案键 —— label 只有 `File`', () => {
    // 文件栏没有 11 键里的键；简历身份在引擎层判（下一条）。
    const files = scan().filter((f) => f.element.getAttribute('type') === 'file');
    expect(files.map((f) => f.key ?? null)).toEqual([null, null]);
  });

  /**
   * 2026-09-15：邻近上下文信号接上了——旁邻那句 "Type or paste your Resume here"
   * 认出简历栏。这条正是 2026-08-23 那条备注里说的「转绿时要回来确认」：
   * 求职信栏（旁邻 "…your Cover Letter here"）必须仍报需手动填。
   */
  it('引擎层：旁邻文字把 file-input-0 认成简历，file-input-1（求职信）仍拒绝', () => {
    const fields = scan();
    const root = jobviteAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'jobvite', root, fields },
      { firstName: 'Ada' },
      { resumeFileName: 'Ada.pdf', resumeHostConfirmed: true },
    );
    const resume = plan.entries.filter((entry) => entry.key === 'resumeFile');
    expect(resume.map((entry) => entry.element.id)).toEqual(['file-input-0']);
    const coverLetter = plan.skipped.find((skip) => skip.element.id === 'file-input-1');
    expect(coverLetter?.reason, '求职信栏永远收不到简历').toBe('UNSUPPORTED_CONTROL');
  });
});

/**
 * 2026-09-15 重测 `jobs.jobvite.com/ninjaone/job/<id>/apply` 的**真实**简历上传形态。
 * 它与上面那份 2026-08-23 夹具不是同一回事，所以单独摆一份、不去改旧夹具：
 * 旧夹具锁的是「两个文件输入都在 div.jv-apply-form 里、旁邻文字能认出简历」，
 * 那条语义本身没坏；变了的是**这一家今天不长那样**。
 *
 * 今天量到的：
 *  · `div.jv-apply-form` 里一个 `input[type=file]` 都没有；
 *  · `#file-input-0`（简历）与 `#file-input-1`（求职信）各自住在一个
 *    `div#attachmentDropdown` 里（**重复 id**，role=dialog，aria-label="Attachment Options"），
 *    两个都是 `<body>` 的直接子节点，由各自的 `button[jv-add-attachment]` 指令渲染；
 *  · 平时 `ng-hide`、1×1 剪裁，点了对应触发器那一个才可见；
 *  · 两个文件输入的 `<label for>` 都只写 `File`——dict/guards.ts 记的那个陷阱；
 *  · 区分信号在各自弹层内部（"Type or Paste Resume" / "…Cover Letter"）与**触发器
 *    自己的可访问名**（"Add Resume*" / "Add Cover Letter"）上。
 *
 * 只读实测还证明宿主这一侧是通的：先点简历触发器、再往 `#file-input-0` 放一份
 * PDF 并派 change，`ul.jv-file-list` 立刻变成「Taylor-Example-Resume.pdf remove」、
 * 弹层自动关闭，而 `#file-input-1` 仍为空。差的是 kernel 侧的一项能力，不是宿主配合度。
 *
 * 这一组锁住现状与那项能力的入口契约：文件输入今天扫不到（锚点之外），
 * 而**触发器的可访问名**足以既认出简历、又否决求职信。
 */
function mountJobvitePortaledAttachments(): void {
  document.body.innerHTML = `
    <div class="jv-form jv-apply-form">
      <form name="scopeData.applyForm">
        <div class="jv-apply-step">
          <h3 class="jv-step-header" id="jv-resume-header">Add Resume*</h3>
          <div class="jv-apply-with jv-apply-section" id="attachResume">
            <div>
              <button jv-add-attachment="{ social: true }" attachment-label="Resume"
                      pasted-label="Pasted Resume" class="jv-button" type="button"
                      aria-haspopup="true" aria-labelledby="jv-resume-header"
                      aria-expanded="false" aria-required="true">Select</button>
            </div>
            <ul class="jv-file-list"></ul>
          </div>
          <div class="jv-additional-files jv-apply-section">
            <span><button jv-add-attachment="" attachment-label="Cover Letter"
                          pasted-label="Pasted Cover Letter" class="jv-button" type="button"
                          aria-haspopup="true" aria-expanded="false"
                          aria-label="Add Cover Letter">Add Cover Letter</button></span>
          </div>
          <label for="jv-field-yH3T0fwn">Chosen First Name*</label>
          <input id="jv-field-yH3T0fwn" name="input-yH3T0fwn" type="text" autocomplete="given-name" required />
        </div>
      </form>
    </div>
    <div class="jv-add-attachment ng-hide" id="attachmentDropdown" role="dialog"
         aria-label="Attachment Options" aria-hidden="true">
      <div class="jv-add-attachment-item"><span role="button">Dropbox</span></div>
      <hr>
      <div class="jv-add-attachment-item">
        <label class="jv-text-block" for="file-input-0"><span role="button">File</span></label>
        <input id="file-input-0" type="file">
      </div>
      <div class="jv-add-attachment-item"><span role="button">Type or Paste Resume</span></div>
      <div class="jv-add-attachment-paste ng-hide">
        <label for="jv-paste-resume-textarea0" class="jv-visually-hidden">Type or paste your Resume here</label>
        <textarea id="jv-paste-resume-textarea0" placeholder="Type or paste your Resume here"></textarea>
      </div>
    </div>
    <div class="jv-add-attachment ng-hide" id="attachmentDropdown" role="dialog"
         aria-label="Attachment Options" aria-hidden="true">
      <div class="jv-add-attachment-item"><span role="button">Dropbox</span></div>
      <hr>
      <div class="jv-add-attachment-item">
        <label class="jv-text-block" for="file-input-1"><span role="button">File</span></label>
        <input id="file-input-1" type="file">
      </div>
      <div class="jv-add-attachment-item"><span role="button">Type or Paste Cover Letter</span></div>
      <div class="jv-add-attachment-paste ng-hide">
        <label for="jv-paste-resume-textarea1" class="jv-visually-hidden">Type or paste your Cover Letter here</label>
        <textarea id="jv-paste-resume-textarea1" placeholder="Type or paste your Cover Letter here"></textarea>
      </div>
    </div>`;
}

describe('Jobvite · 简历弹层被 portal 到 <body>（2026-09-15 实测形态）', () => {
  it('两个文件输入都在锚点之外，所以今天一个都扫不到', () => {
    mountJobvitePortaledAttachments();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(2);
    const root = jobviteAdapter.resolveRoot(document)!;
    const fields = jobviteAdapter.scan(root);
    expect(fields.filter((field) => field.element.getAttribute('type') === 'file')).toHaveLength(0);
    // 它们在扫描面之外，所以引擎连「需手动填」都报不出来——这一栏整个不存在。
    for (const input of document.querySelectorAll('input[type="file"]')) {
      expect(root.isExcluded(input)).toBe(true);
    }
  });

  it('两个弹层在激活之前完全同形 —— 归属只能由「点开哪一个」证明', () => {
    mountJobvitePortaledAttachments();
    const dropdowns = [...document.querySelectorAll('#attachmentDropdown')];
    expect(dropdowns).toHaveLength(2);
    // 同 id、同 class、同 role、同 aria-label：静态选择器分不出哪个是简历的。
    expect(new Set(dropdowns.map((node) => node.getAttribute('role')))).toEqual(new Set(['dialog']));
    expect(new Set(dropdowns.map((node) => node.getAttribute('aria-label')))).toEqual(
      new Set(['Attachment Options']),
    );
    expect(new Set(dropdowns.map((node) => node.className))).toEqual(new Set(['jv-add-attachment ng-hide']));
  });

  it('文件输入自己的 label 只写 `File` —— 正向白名单认不出，也不该认出', () => {
    mountJobvitePortaledAttachments();
    for (const id of ['file-input-0', 'file-input-1']) {
      const label = document.querySelector(`label[for="${id}"]`)!;
      expect(label.textContent?.trim()).toBe('File');
      expect(isResumeFileField('File', [id])).toBe(false);
    }
  });

  /**
   * 这条是那项待建能力的入口契约：一旦规则能声明「这个文件输入由这个触发器
   * materialise」，控件的人读名字就该是**触发器的可访问名**，而它足以分辨两边。
   */
  it('触发器的可访问名足以认出简历并否决求职信', () => {
    mountJobvitePortaledAttachments();
    const root = jobviteAdapter.resolveRoot(document)!;
    const byLabel = (value: string) =>
      document.querySelector(`[jv-add-attachment][attachment-label="${value}"]`)!;

    const resumeName = root.labelTextFor(byLabel('Resume'));
    const coverName = root.labelTextFor(byLabel('Cover Letter'));
    expect(resumeName).toContain('Add Resume');
    expect(coverName).toBe('Add Cover Letter');

    expect(isResumeFileField(resumeName)).toBe(true);
    expect(isNonResumeFileField(resumeName)).toBe(false);
    // 求职信那一侧必须被否决——挂错栏比不挂糟。
    expect(isNonResumeFileField(coverName)).toBe(true);
  });
});
