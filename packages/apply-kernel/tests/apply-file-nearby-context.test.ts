import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { consumeAuthority } from '../src/grant';
import { fieldSignature } from '../src/fieldIdentity';
import { createScanRoot } from '../src/scanRoot';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import {
  attachHostFile,
  hasApprovedResumeFileIdentity,
  isApprovedResumeFileTarget,
  nearbyFileContext,
} from '../src/write/setFile';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyPlan } from '../src/contracts';

/**
 * 简历文件栏的**邻近上下文**证据（2026-09-15 四家真实页面只读实测 + 一次本地
 * DataTransfer 探针，均未提交）：
 *
 * | 家 | input 自己的标签 | 真正说明它是简历的东西 |
 * |---|---|---|
 * | Rippling | 包裹式 `<label>`，文案 "Drop or select (.doc / .docx / .pdf)" | label 的 `aria-labelledby` → `Résumé`；隔两层的前置兄弟 `Résumé*` |
 * | Dover | 无 label；dropzone 文案 "Drag and drop file or browse computer" | 隔两层的前置兄弟 `Resume *` |
 * | BambooHR | `aria-label="file-input"`（两个栏一样） | 隔两层的前置兄弟 `Resume*` |
 * | Jobvite | `<label>File</label>`（两个栏一样） | 同容器旁边的 textarea placeholder "…your Resume here" |
 *
 * 这些证据必须**计划期与写入期同源**（engine 与 setFile 都走
 * `hasApprovedResumeFileIdentity`）：Rippling 原本计划期靠 data-testid 认出、写入期
 * 不认，整轮被 IDENTITY_CHANGED 收场，一个字节都没写。
 *
 * 同样重要的是它**不能**证明什么：触发器（按钮 / role=button / 链接）的名字永远
 * 只能否决，不能作证（S0 合同）；求职信、成绩单、作品集、厂商自己的
 * "Autofill from resume" 解析器永远收不到简历；上下文有界——不越过第二个文件控件，
 * 后向兄弟只看 input 自己的容器，超过一个标签长度的段落不算。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface Box {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left?: number;
}

/** happy-dom 没有布局引擎；显式喂进几何，只给真实页面上可见的那些元素。 */
function stubLayout(boxes: ReadonlyMap<Element, Box>): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { width: 0, height: 0, top: 0 };
    const left = box.left ?? 0;
    return {
      width: box.width, height: box.height, top: box.top, left,
      right: left + box.width, bottom: box.top + box.height, x: left, y: box.top,
      toJSON: () => ({}),
    } as DOMRect;
  });
  Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
}

function rootOf(): ReturnType<typeof createScanRoot> {
  return createScanRoot(document.querySelector('form') as HTMLFormElement, []);
}

function fileInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll('input')].filter((input) => input.type === 'file');
}

/** 真实页面把 type 写成 `File`；happy-dom 的属性选择器分大小写，这里用小写，kernel 侧按反射的 `.type` 判。 */
const RIPPLING_FIELD = (name: string, testid: string, tip: string): string => `
  <div data-testid="field">
    <div><span id="${testid}-label">${name}</span><span>*</span></div>
    <div>
      <div data-testid="screen-reader-only" id="${testid}-count">Total 0 file selected</div>
      <label data-testid="${testid}" tabindex="-1" aria-labelledby="${testid}-count ${testid}-label">
        <input title="" accept=".doc,.docx,.pdf" data-testid="input-${testid}" type="file" />
        <button data-testid="test_button" type="button"><span><span><div><span>Drop or select (.doc / .docx / .pdf)</span></div></span></span></button>
      </label>
      <span>${tip}</span>
    </div>
  </div>`;

function mountRippling(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <h4>Application: Product Manager</h4>
      ${RIPPLING_FIELD('Résumé', 'resume', 'The résumé will be parsed to fill in the application details')}
      <label for="first">First name*</label><input id="first" type="text" autocomplete="given-name" required />
      <label for="email">Email*</label><input id="email" type="email" autocomplete="email" required />
      ${RIPPLING_FIELD('Cover letter', 'cover_letter', '')}
    </form>`;
}

const DOVER_DROPZONE = (prompt: string): string => `
  <div role="button" tabindex="0">
    <input type="file" accept=".pdf" multiple autocomplete="off" tabindex="-1" style="display: none;" />
    <div>${prompt}</div>
  </div>`;

function mountDover(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <div>
        ${DOVER_DROPZONE('<span>Autofill from resume</span><span>Drag &amp; drop or upload to autofill your application.</span><span>Upload file</span>')}
      </div>
      <label for="first">First Name *</label><input id="first" type="text" required />
      <div>
        <div class="FormLabel">Resume *</div>
        <div>${DOVER_DROPZONE('<span>Drag and drop file or browse computer(PDF, 5 MB maximum)</span>')}</div>
      </div>
    </form>`;
}

const BAMBOO_UPLOAD = (heading: string, button: string, hiddenName: string, multiple: boolean): string => `
  <div>
    <div><span>${heading}</span></div>
    <div>
      <div>
        <div>
          <button type="button"><span>${button}</span></button>
          <div><p>No file selected</p></div>
        </div>
        <input accept=".pdf,.doc,.docx" aria-invalid="false" aria-label="file-input" data-bi-id="-file-input"
               ${multiple ? 'multiple' : ''} required tabindex="-1" type="file" />
      </div>
      <input name="${hiddenName}" type="hidden" value="" />
    </div>
  </div>`;

function mountBamboo(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first">First Name *</label><input id="first" type="text" />
      ${BAMBOO_UPLOAD('Resume*', 'Choose File*', 'resumeFileId', false)}
      <label for="wu">Website, Blog or Portfolio</label><input id="wu" type="text" />
      ${BAMBOO_UPLOAD('Do you have a recent example of a BIRP (Behavior, Intervention, Response, Plan) that you could share? Please change any client names or sensitive information as needed.*', 'Choose Files*', 'customQuestionAnswers.file_54', true)}
    </form>`;
}

function mountJobvite(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <div><label for="file-input-0">File</label>
        <input id="file-input-0" type="file" />
        <textarea id="jv-paste-resume-textarea0" placeholder="Type or paste your Resume here"></textarea></div>
      <div><label for="file-input-1">File</label>
        <input id="file-input-1" type="file" />
        <textarea id="jv-paste-resume-textarea1" placeholder="Type or paste your Cover Letter here"></textarea></div>
    </form>`;
}

describe('简历身份 · 邻近上下文（四家真实形状）', () => {
  it('Rippling：包裹 label 的 aria-labelledby 与前置标题都说 Résumé；求职信栏不收', () => {
    mountRippling();
    const [resume, coverLetter] = fileInputs();
    expect(hasApprovedResumeFileIdentity(resume!, rootOf())).toBe(true);
    expect(hasApprovedResumeFileIdentity(coverLetter!, rootOf())).toBe(false);
    expect(nearbyFileContext(resume!, rootOf()).positive).toContain('Résumé');
  });

  it('Rippling：data-testid 现在是写入期认可的正向钩子（计划期早就靠它）', () => {
    mountRippling();
    const resume = fileInputs()[0]!;
    // 把所有文案证据都摘掉，只剩 data-testid。
    document.getElementById('resume-label')!.remove();
    resume.parentElement!.removeAttribute('aria-labelledby');
    expect(hasApprovedResumeFileIdentity(resume, rootOf())).toBe(true);
    resume.removeAttribute('data-testid');
    expect(hasApprovedResumeFileIdentity(resume, rootOf())).toBe(false);
  });

  it('Dover：隔两层的前置 `Resume *` 认出真附件栏；Autofill 解析器仍拒绝', () => {
    mountDover();
    const [decoy, real] = fileInputs();
    expect(hasApprovedResumeFileIdentity(decoy!, rootOf()), 'Autofill from resume 是解析器，不是附件栏').toBe(false);
    expect(hasApprovedResumeFileIdentity(real!, rootOf())).toBe(true);
    // 探针：上下文是这一家唯一的证据。
    document.querySelector('.FormLabel')!.remove();
    expect(hasApprovedResumeFileIdentity(real!, rootOf())).toBe(false);
  });

  it('BambooHR：两个 file-input 只靠上方文字区分；BIRP 附件题不收', () => {
    mountBamboo();
    const [resume, birp] = fileInputs();
    expect(hasApprovedResumeFileIdentity(resume!, rootOf())).toBe(true);
    expect(hasApprovedResumeFileIdentity(birp!, rootOf())).toBe(false);
  });

  it('BambooHR：上传控件在 shadow root 里时，`Resume*` 在外面也要读得到', () => {
    // 2026-09-17 实测：线上八个页面 inventory 都报 `shadowRoots: 1`，那个 input
    // 没有 name、没有 id，aria-label 是通用的 `file-input`，唯一能证明它是简历栏的
    // `Resume*` 在 shadow 之外。祖先链走 `parentElement` 到 shadow root 就断，
    // 于是每页填了 139 个字段而唯一必填的简历栏一个没填（必填 0/10）。
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first">First Name *</label><input id="first" type="text" />
        <div><span>Resume*</span></div>
        <div id="upload-host"></div>
      </form>`;
    const host = document.getElementById('upload-host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <div>
        <button type="button"><span>Choose File*</span></button>
        <div><p>No file selected</p></div>
        <input accept=".pdf,.doc,.docx" aria-label="file-input" required type="file" />
      </div>`;
    const inside = host.shadowRoot!.querySelector('input[type="file"]') as HTMLInputElement;
    expect(hasApprovedResumeFileIdentity(inside, rootOf())).toBe(true);
  });

  it('Jobvite：同容器旁边的 textarea placeholder 分出简历与求职信', () => {
    mountJobvite();
    const [resume, coverLetter] = fileInputs();
    expect(hasApprovedResumeFileIdentity(resume!, rootOf())).toBe(true);
    expect(hasApprovedResumeFileIdentity(coverLetter!, rootOf()), '求职信栏永远收不到简历').toBe(false);
  });
});

describe('简历身份 · 上下文不能证明什么', () => {
  it('触发器的名字只能否决不能作证：generic upload 旁边一个 "Attach resume" 按钮不算', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div><button type="button">Attach resume</button><input name="upload" type="file" /></div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
    document.body.innerHTML = `
      <form id="application-form">
        <div><input name="upload" type="file" /><a href="#">Upload your resume</a></div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
  });

  it('跳过中间的按钮去够前面的标题，但按钮文案仍参与否决', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div><div>Resume</div><button type="button">Choose file</button><input name="upload" type="file" /></div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(true);
    document.body.innerHTML = `
      <form id="application-form">
        <div><div>Resume</div><button type="button">Choose cover letter</button><input name="upload" type="file" /></div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
  });

  it('后向兄弟只看 input 自己的容器——下一栏的标题不属于这一栏', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <section><div><input name="upload" type="file" /></div><div>Resume</div></section>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
  });

  it('不越过第二个文件控件：另一栏的标题够不着', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div>Resume</div>
        <div><input name="resume-upload" type="file" /></div>
        <div><input name="other" type="file" /></div>
      </form>`;
    const [resume, other] = fileInputs();
    expect(hasApprovedResumeFileIdentity(resume!, rootOf())).toBe(true);
    expect(hasApprovedResumeFileIdentity(other!, rootOf())).toBe(false);
  });

  it('同一段上下文同时点名别的附件时否决胜出', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div><div>Resume or cover letter (one file)</div><input name="upload" type="file" /></div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
  });

  it('一整段说明文字不是标签：超过标签长度的前置文本不作证', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div>
          <p>${'Please read our guidance before uploading. '.repeat(3)}We accept a resume in PDF only, and we will not read any other format you attach here.</p>
          <input name="upload" type="file" />
        </div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
  });

  it('input 自己的 label 说求职信时，邻近上下文救不回来', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div><div>Resume</div><label for="cl">Cover letter</label><input id="cl" type="file" /></div>
      </form>`;
    expect(hasApprovedResumeFileIdentity(fileInputs()[0]!, rootOf())).toBe(false);
  });
});

describe('可见触发器 · dropzone 与深藏的按钮', () => {
  it('Dover：role=button 的 dropzone 本身就是触发器（有盒子才算）', () => {
    mountDover();
    const real = fileInputs()[1]!;
    const dropzone = real.parentElement!;
    expect(isApprovedResumeFileTarget(real, rootOf()), '0×0 时仍须 fail closed').toBe(false);
    stubLayout(new Map([[dropzone, { width: 520, height: 96, top: 300, left: 40 }]]));
    expect(isApprovedResumeFileTarget(real, rootOf())).toBe(true);
  });

  it('BambooHR：input 容器里套了两层的 "Choose File*" 按钮是触发器', () => {
    mountBamboo();
    const resume = fileInputs()[0]!;
    const button = resume.parentElement!.querySelector('button') as HTMLButtonElement;
    stubLayout(new Map([[button, { width: 160, height: 40, top: 300, left: 40 }]]));
    expect(isApprovedResumeFileTarget(resume, rootOf())).toBe(true);
  });

  it('Rippling：包裹 label（aria-labelledby → Résumé）与 "Drop or select" 按钮都算触发器', () => {
    mountRippling();
    const resume = fileInputs()[0]!;
    const label = resume.parentElement as HTMLLabelElement;
    const button = label.querySelector('button') as HTMLButtonElement;
    stubLayout(new Map([[button, { width: 420, height: 56, top: 300, left: 40 }]]));
    expect(isApprovedResumeFileTarget(resume, rootOf())).toBe(true);
    // 只有 label 有盒子也够：它的可读名称含 Résumé。
    vi.restoreAllMocks();
    stubLayout(new Map([[label, { width: 420, height: 56, top: 300, left: 40 }]]));
    expect(isApprovedResumeFileTarget(resume, rootOf())).toBe(true);
  });
});

function attachTo(input: HTMLInputElement, file: File) {
  const root = rootOf();
  const journal = createUndoJournal();
  const authority = testAuthority('file-plan', 'fill', ['set-file']);
  expect(consumeAuthority(authority).ok, '测试前置：授权没能进入运行态').toBe(true);
  return attachHostFile({
    element: input,
    file,
    root,
    authority,
    ticket: journal.record(input),
    policy: testApplyPolicy(),
  });
}

describe('写后 · 宿主已经显示了文件名', () => {
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Taylor-Example-Resume.pdf', { type: 'application/pdf' });

  it('宿主在 change 里同步清空 files 但已渲染文件名 → 收下（unverified）', () => {
    mountDover();
    const real = fileInputs()[1]!;
    const dropzone = real.parentElement!;
    stubLayout(new Map([[dropzone, { width: 520, height: 96, top: 300, left: 40 }]]));
    real.addEventListener('change', () => {
      real.files = new DataTransfer().files;
      dropzone.appendChild(Object.assign(document.createElement('span'), { textContent: 'Resume: Taylor-Example-Resume.pdf' }));
    });
    // 宿主把 files 清了，只留下一个文件名——没有可读的控件状态，判决只能是
    // host-adopted，runner 据此继续报 unverified。
    expect(attachTo(real, pdf())).toEqual({ ok: true, value: 'host-adopted' });
  });

  it('宿主清空了 files 却什么都没显示 → 仍是 VALUE_COERCED', () => {
    mountDover();
    const real = fileInputs()[1]!;
    stubLayout(new Map([[real.parentElement!, { width: 520, height: 96, top: 300, left: 40 }]]));
    real.addEventListener('change', () => {
      real.files = new DataTransfer().files;
    });
    expect(attachTo(real, pdf())).toEqual({ ok: false, code: 'VALUE_COERCED' });
  });

  it('文件名只认这一栏的容器，页面别处出现同名不算', () => {
    mountDover();
    const real = fileInputs()[1]!;
    stubLayout(new Map([[real.parentElement!, { width: 520, height: 96, top: 300, left: 40 }]]));
    real.addEventListener('change', () => {
      real.files = new DataTransfer().files;
      document.querySelector('h4, form')!.prepend(Object.assign(document.createElement('p'), { textContent: 'Uploaded: Taylor-Example-Resume.pdf' }));
    });
    expect(attachTo(real, pdf())).toEqual({ ok: false, code: 'VALUE_COERCED' });
  });
});

describe('整轮 · 文件条目的身份问题不连坐', () => {
  const geometryOf = (element: Element) =>
    element instanceof HTMLInputElement && element.type === 'file'
      ? { width: 1, height: 1, left: 40, right: 41 }
      : { width: 240, height: 36, left: 40, right: 280 };

  it('Rippling 形状端到端：计划期与写入期同源，宿主稍后清空 input 也不算失败', async () => {
    mountRippling();
    const resume = fileInputs()[0]!;
    const button = resume.parentElement!.querySelector('button') as HTMLButtonElement;
    stubLayout(new Map([[button, { width: 420, height: 56, top: 300, left: 40 }]]));
    // 2026-09-15 实测时序：同步与微任务里文件都还在，下一个宏任务才清空并渲染文件名。
    resume.addEventListener('change', () => {
      setTimeout(() => {
        resume.files = new DataTransfer().files;
        resume.parentElement!.querySelector('button')!.textContent = 'Taylor-Example-...pdf remove';
      }, 0);
    });
    const root = greenhouseAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { firstName: 'Taylor', email: 'taylor@example.test' },
      { readGeometry: geometryOf, resumeFileName: 'Taylor-Example-Resume.pdf', resumeHostConfirmed: true },
    );
    expect(plan.entries.map((entry) => entry.key)).toEqual(['firstName', 'email', 'resumeFile']);
    expect(plan.entries.find((entry) => entry.key === 'resumeFile')!.element).toBe(resume);

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => new File([new Uint8Array([0x25])], 'Taylor-Example-Resume.pdf', { type: 'application/pdf' }),
    });
    expect(summary.abortedBy).toBeNull();
    // 写入返回的那一刻回读是真的：exact File 就在 files 里，宿主也收到了 change。
    // 与文本同一条纪律——判决在 settle 时点定下（write/verify.ts），下一个宏任务
    // 里宿主把 input 换成文件名 chip 是它收下了这份文件，不是我们没写成。
    expect(summary.results).toEqual([
      { key: 'firstName', label: 'First name', ok: true },
      { key: 'email', label: 'Email', ok: true },
      { key: 'resumeFile', label: expect.any(String), ok: true },
    ]);
  });

  it('第一个文件条目身份漂了：那一栏报 IDENTITY_CHANGED、整轮如实记一次漂移，第二个文件条目照常写', async () => {
    // 引擎按键去重，一份计划里不会有两个 resumeFile；这里手搭计划锁的是 runner 的
    // 合同本身：文件条目排在最后，前一条的身份问题不得把后一条连坐成 ABORTED。
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email*</label><input id="email" type="email" autocomplete="email" required />
        <label for="primary">Resume</label><input id="primary" type="file" />
        <label for="secondary">Resume (alternate format)</label><input id="secondary" type="file" />
      </form>`;
    const email = document.getElementById('email') as HTMLInputElement;
    const [primary, secondary] = fileInputs();
    stubLayout(new Map([
      [primary!, { width: 230, height: 40, top: 300, left: 40 }],
      [secondary!, { width: 230, height: 40, top: 360, left: 40 }],
    ]));
    const root = rootOf();
    const entry = (element: HTMLInputElement, kind: 'text' | 'file', key: 'email' | 'resumeFile', label: string, value: string, order: number) =>
      ({ kind, required: false, key, label, value, element, order, confidence: 1, signature: fieldSignature(element, root) }) as ApplyPlan['entries'][number];
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'two-file-entries',
      fillEmptyOnly: true,
      entries: [
        entry(email, 'text', 'email', 'Email*', 'ada@example.test', 0),
        entry(primary!, 'file', 'resumeFile', 'Resume', 'resume.pdf', 1),
        entry(secondary!, 'file', 'resumeFile', 'Resume (alternate format)', 'resume.pdf', 2),
      ],
      skipped: [],
    };
    // 审阅之后、Fill 之前，第一栏的标签变成了成绩单：不再是批准过的目标。
    document.querySelector('label[for="primary"]')!.textContent = 'Transcript';

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => new File([new Uint8Array([0x25])], 'resume.pdf', { type: 'application/pdf' }),
    });
    // 身份漂移仍是页面级信号：2026-09-23 起记在 identityDrift（调用方据此重扫），不再置 abortedBy。
    expect(summary.identityDrift, '身份漂移仍是页面级信号，整轮如实记下').toBe(1);
    expect(summary.abortedBy).toBeNull();
    expect(summary.results.map((result) => (result.ok ? `ok${result.unverified ? '/unverified' : ''}` : result.reason))).toEqual([
      'ok',
      'IDENTITY_CHANGED',
      'ok',
    ]);
    expect(secondary!.files?.[0]?.name).toBe('resume.pdf');
    expect(primary!.files?.length ?? 0).toBe(0);
  });
});

describe('文件目标判定不做全树深查', () => {
  /**
   * 2026-09-15 Lever 实测（CDP 采样）：`root.querySelectorAll` 是穿透 shadow 的
   * 全树遍历，每个元素都要调一次宿主的 shadow opener；文件条目写前/写后共约六次
   * 这样的遍历，在 Lever 那张大表上占了整轮约三分之一的同步时间，而那段时间里
   * 前面文本条目的 C6 回读帧正挂着——1 秒看门狗被我们自己的工作耗尽，就是偶发
   * VERIFY_TIMEOUT 的来路。成员判定改走 O(深度) 的 isExcluded；这里钉住"零次深查"。
   */
  it('身份、触发器与写入全程零次 root.querySelectorAll', () => {
    mountDover();
    const real = fileInputs()[1]!;
    const dropzone = real.parentElement!;
    stubLayout(new Map([[dropzone, { width: 520, height: 96, top: 300, left: 40 }]]));
    const base = rootOf();
    let deepQueries = 0;
    const counting: typeof base = {
      ...base,
      querySelectorAll: (selector: string) => {
        deepQueries += 1;
        return base.querySelectorAll(selector);
      },
    };

    expect(hasApprovedResumeFileIdentity(real, counting)).toBe(true);
    expect(isApprovedResumeFileTarget(real, counting)).toBe(true);
    const authority = testAuthority('file-plan', 'fill', ['set-file']);
    expect(consumeAuthority(authority).ok).toBe(true);
    const attached = attachHostFile({
      element: real,
      file: new File([new Uint8Array([0x25])], 'resume.pdf', { type: 'application/pdf' }),
      root: counting,
      authority,
      ticket: createUndoJournal().record(real),
      policy: testApplyPolicy(),
    });
    expect(attached).toEqual({ ok: true, value: 'readback' });
    expect(deepQueries, '文件目标判定又走了全树深查——Lever 那类大表上会把回读帧饿死').toBe(0);
  });

  it('根节点自己不是成员：根的直接子按钮仍不能当触发器', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input id="resume" name="resume" type="file" />
        <button type="button">Attach resume</button>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    stubLayout(new Map([[button, { width: 230, height: 40, top: 300, left: 40 }]]));
    expect(isApprovedResumeFileTarget(input, rootOf())).toBe(false);
  });
});
