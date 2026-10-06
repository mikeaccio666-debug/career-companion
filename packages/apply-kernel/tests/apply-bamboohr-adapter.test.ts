import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import type { ApplyFieldDescriptor } from '../src/contracts';
import { bamboohrAdapter } from '../src/sites/bamboohr/applyForm';
import { isHoneyPotField, isHoneypotGeometry, isHoneypotIdentity } from '../src/dict/guards';

/**
 * BambooHR adapter，结构来自 2026-08-23 对
 * `touchstonetherapycenter.bamboohr.com/careers/33` 真实在招岗位的只读实测
 * （50-证据库 §F.8-d／§F.8-f）。点了一次「Apply for This Job」把表单展开，
 * 未填任何字段、未提交。
 *
 * 这份夹具保住三件实测到的、会咬人的东西：
 *
 *  1. **蜜罐 `nickname_hpcsaf`** —— 表单的**第一个**控件，label 就是
 *     `Please leave this field blank`，藏在 `position:absolute; left:-9999px`
 *     的 0×0 父节点里。填进去 = 申请被静默丢弃，而用户以为投出去了。
 *     它的后缀 `hpcsaf` 看着是随机的，所以**不能按名字认**。
 *  2. **`g-recaptcha-response`** 在同一个 `<form>` 里（铁律 5）。
 *  3. 地址三栏与国家 2026-09-22 起**按 name 精确映射**（P1-5 给了它们各自的键）；
 *     学历那两栏仍然没有扁平键（答案在教育集合里），必须如实报「需手动填」，
 *     不许被塞进别的键。
 *
 * 全部取值为合成值。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountBambooFixture(): void {
  document.body.innerHTML = `
    <section>
      <form id="job-application-form">
        <!-- 蜜罐：实测的藏法就是把父节点推到视口外，元素自己 visibility:visible -->
        <div style="position:absolute; left:-9999px; overflow:hidden; height:0; width:0;">
          <label for="nickname_hpcsaf">Please leave this field blank</label>
          <input id="nickname_hpcsaf" name="nickname_hpcsaf" type="text"
                 autocomplete="newAppNicknameInput_hpcsaf" tabindex="-1"
                 placeholder="Enter your text here" />
        </div>
        <label for="firstName">First Name *</label><input id="firstName" name="firstName" type="text" />
        <label for="lastName">Last Name *</label><input id="lastName" name="lastName" type="text" />
        <label for="email">Email *</label><input id="email" name="email" type="text" />
        <label for="phone">Phone *</label><input id="phone" name="phone" type="text" />
        <label for="sa">Address *</label><input id="sa" name="streetAddress.value" type="text" />
        <label for="ci">City *</label><input id="ci" name="city.value" type="text" />
        <label for="zp">ZIP *</label><input id="zp" name="zip.value" type="text" />
        <!-- 2026-09-15 复测（careers/21）：两个文件栏的 aria-label 都只是 file-input，
             唯一的区分是各自上方那段文字；"Choose File*" 按钮在 input 容器里再套两层。 -->
        <div>
          <div><span>Resume*</span></div>
          <div>
            <div>
              <div>
                <button type="button"><span>Choose File*</span></button>
                <div><p>No file selected</p></div>
              </div>
              <input accept=".pdf,.doc,.docx,.txt,.rtf" aria-invalid="false" aria-label="file-input"
                     data-bi-id="-file-input" required tabindex="-1" type="file" />
            </div>
            <input name="resumeFileId" type="hidden" value="" />
          </div>
        </div>
        <label for="wu">Website, Blog or Portfolio</label><input id="wu" name="websiteUrl" type="text" />
        <label for="lu">LinkedIn URL</label><input id="lu" name="linkedinUrl" type="text" />
        <label for="ei">College/University *</label><input id="ei" name="educationInstitutionName" type="text" />
        <label for="rb">Who referred you for this position?</label><input id="rb" name="referredBy" type="text" />
        <div>
          <div><span>Do you have a recent example of a BIRP (Behavior, Intervention, Response, Plan) that you could share? Please change any client names or sensitive information as needed.*</span></div>
          <div>
            <div>
              <div>
                <button type="button"><span>Choose Files*</span></button>
                <div><p>No files selected</p></div>
              </div>
              <input accept=".pdf,.doc,.docx,.txt,.rtf" aria-invalid="false" aria-label="file-input"
                     data-bi-id="-file-input" multiple required tabindex="-1" type="file" />
            </div>
            <input name="customQuestionAnswers.file_54" type="hidden" value="" />
          </div>
        </div>
        <textarea id="gr" name="g-recaptcha-response"></textarea>
      </form>
    </section>`;
  // happy-dom 没有布局引擎，所有元素恒 0×0 —— 那会让**每一个**控件看起来都像蜜罐，
  // 几何守卫就测不出东西了。所以给普通控件补上真实盒子，只把蜜罐留在视口外：
  // 这样几何这一层的判据是真的在起作用，而不是被环境默认值糊过去。
  for (const el of document.querySelectorAll('input, textarea')) {
    const hidden = el.getAttribute('name')?.startsWith('nickname_');
    (el as HTMLElement).getBoundingClientRect = () =>
      (hidden
        ? { width: 178, height: 28, top: -9751, left: -9935, right: -9757, bottom: -9723, x: -9935, y: -9751 }
        : { width: 240, height: 32, top: 100, left: 20, right: 260, bottom: 132, x: 20, y: 100 }) as DOMRect;
  }
}

function scan(): ApplyFieldDescriptor[] {
  mountBambooFixture();
  const root = bamboohrAdapter.resolveRoot(document);
  expect(root, '锚点 form#job-application-form 没认出来').toBeTruthy();
  return [...bamboohrAdapter.scan(root!)];
}

const FULL = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  phone: '+1 555 0100',
  linkedinUrl: 'https://www.linkedin.com/in/ada',
  portfolioUrl: 'https://ada.example.test',
  city: 'London',
};

describe('BambooHR adapter · 申请路径', () => {
  it('岗位页（兼申请表）认，列表页不认', () => {
    expect(bamboohrAdapter.isApplyPath('/careers/33')).toBe(true);
    expect(bamboohrAdapter.isApplyPath('/careers/33/')).toBe(true);
    expect(bamboohrAdapter.isApplyPath('/jobs/view.php')).toBe(true);
    // 列表页上没有表单：认作申请面只会让 resolveRoot 反复扑空。
    expect(bamboohrAdapter.isApplyPath('/careers')).toBe(false);
    // 同一台机器上的 HR 后台，一条都不认。
    for (const p of [
      '/',
      '/employees/directory',
      '/saml/consume.php',
      '/authorize.php',
      '/admin/careers/33',
      '/admin/jobs/view.php',
    ]) {
      expect(bamboohrAdapter.isApplyPath(p), p).toBe(false);
    }
  });
});

describe('BambooHR adapter · 字段', () => {
  it('七个有档案键的字段全部认出来', () => {
    const fields = scan();
    const keyOf = (name: string) =>
      fields.find((f) => f.element.getAttribute('name') === name)?.key ?? null;
    expect(keyOf('firstName')).toBe('firstName');
    expect(keyOf('lastName')).toBe('lastName');
    expect(keyOf('email')).toBe('email');
    expect(keyOf('phone')).toBe('phone');
    expect(keyOf('linkedinUrl')).toBe('linkedinUrl');
    expect(keyOf('city.value')).toBe('city');
    expect(keyOf('websiteUrl')).toBe('portfolioUrl');
  });

  it('地址三栏与国家按 name 映到各自的键（2026-09-22：P1-5 之后它们有键了）', () => {
    const fields = scan();
    const keyOfName = (name: string) =>
      fields.find((field) => field.element.getAttribute('name') === name)?.key ?? null;
    expect(keyOfName('streetAddress.value')).toBe('addressLine1');
    expect(keyOfName('zip.value')).toBe('addressPostalCode');
  });

  it('真的没有扁平键的那几栏，一栏都不许被塞进别的键', () => {
    // 学历在教育集合里、推荐人是他人信息：被塞进 `location` 或 `city` 才是真事故。
    const fields = scan();
    for (const name of ['educationInstitutionName', 'referredBy']) {
      const field = fields.find((f) => f.element.getAttribute('name') === name);
      expect(field?.key ?? null, name).toBeNull();
    }
  });

  it('reCAPTCHA 的回填控件不进扫描面', () => {
    const fields = scan();
    expect(fields.some((f) => (f.element.getAttribute('name') ?? '').includes('recaptcha'))).toBe(
      false,
    );
  });
});

describe('BambooHR adapter · 蜜罐', () => {
  /**
   * 这是本文件最重要的一条。
   *
   * 蜜罐填进去的后果不是「填错一栏」，是**整份申请被静默丢弃** ——
   * 用户看到我们报「已填」，然后永远等不到回音。
   *
   * ## 三层里只有一层接住了它（探针实测，别把话说宽）
   *
   *  · **属性身份层** `HONEYPOT_IDENTITY` —— **认不出**。它认的是
   *    `honeypot` / `bot-trap` / `beecatcher` 这类词，而 `nickname_hpcsaf`
   *    一个都不含，后缀还是随机的（按名字认这条路在这一家走不通）。
   *  · **几何层** `isHoneypotGeometry` —— **也认不出**。它判的是
   *    `width <= 1 || height <= 1`，而实测这个蜜罐是 **178×28**：
   *    厂商是把**父节点**推到 `left:-9999px` 视口外，元素自己尺寸正常。
   *    「推到视口外」这一招我们今天不看。
   *  · **文案层** `HONEYPOT`（`leave (this|the)?\s*(field|box)?\s*blank`）——
   *    **就是它**。label 逐字是 `Please leave this field blank`。
   *
   * 所以这一家的蜜罐防线是**单点**的。叠加探针实测过：把它映射成 `firstName`
   * 再从 `HONEYPOT` 里删掉 blank 那一段 ⇒ 它**真的进了填充计划**。
   * 只做其中一步都是绿的 —— 这正是为什么下面那条用例要把两步叠起来看。
   */
  it('不进填充计划 —— 填进去整份申请会被静默丢弃', () => {
    const fields = scan();
    const root = bamboohrAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan({ vendor: 'bamboohr', root, fields }, FULL);
    expect(
      plan.entries.some((e) => (e.element.getAttribute('name') ?? '').startsWith('nickname_')),
      '蜜罐进了填充计划——这一次投递会被站点静默丢弃',
    ).toBe(false);
    // ⚠️ 上面那句**单独看是空跑的**：`nickname_hpcsaf` 本来就不在 attrMap 里，
    // 不映射的字段当然不进计划。真正的判据是下一条——三层里哪一层认得出它。
    // 叠加探针（映射成 firstName + 从 HONEYPOT 删掉 blank 那一段）实测：它会进计划。
  });

  it('三层里只有文案层认得出它 —— 把这个事实钉住，别以为有三道防线', () => {
    const fields = scan();
    const trap = fields.find((f) => (f.element.getAttribute('name') ?? '').startsWith('nickname_'));
    expect(trap, '蜜罐根本没进扫描面——那这条对照测不了任何东西').toBeTruthy();

    const name = trap!.element.getAttribute('name')!;
    const box = trap!.element.getBoundingClientRect();
    // 属性身份层认不出：名字里没有任何蜜罐词汇。
    expect(isHoneypotIdentity([name, trap!.element.id])).toBe(false);
    // 几何层认不出：厂商推的是**父节点**，元素自己 178×28。
    expect(isHoneypotGeometry({ width: box.width, height: box.height })).toBe(false);
    // 只剩文案层。
    expect(isHoneyPotField('Please leave this field blank')).toBe(true);
  });

  it('正常字段没有被几何守卫误伤', () => {
    // 与上一条成对：只证明「蜜罐被挡住」是不够的，happy-dom 里所有元素恒 0×0，
    // 一个过宽的几何判据会把整张表都挡掉，而那同样全绿。
    const fields = scan();
    const root = bamboohrAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan({ vendor: 'bamboohr', root, fields }, FULL);
    expect(plan.entries.map((e) => e.key).sort()).toEqual([
      'city',
      'email',
      'firstName',
      'lastName',
      'linkedinUrl',
      'phone',
      'portfolioUrl',
    ]);
  });
});

describe('BambooHR adapter · 两个 file-input', () => {
  /**
   * 2026-09-15 复测（careers/21）：两个文件栏的 aria-label 都只是 `file-input`，
   * 唯一的区分是各自上方那段文字。简历栏上方是 `Resume*`；第二个是自定义题
   * （BIRP 示例附件），必须仍报需手动填。
   */
  it('引擎层：上方的 `Resume*` 认出简历栏，自定义附件题仍拒绝', () => {
    const fields = scan();
    const root = bamboohrAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'bamboohr', root, fields },
      FULL,
      { resumeFileName: 'Ada.pdf', resumeHostConfirmed: true },
    );
    const files = fields.filter((f) => (f.element as HTMLInputElement).type === 'file');
    expect(files, '两个文件栏都该在扫描面里').toHaveLength(2);
    const [resume, birp] = files;
    expect(plan.entries.filter((entry) => entry.key === 'resumeFile').map((entry) => entry.element)).toEqual([resume!.element]);
    expect(plan.skipped.find((skip) => skip.element === birp!.element)?.reason).toBe('UNSUPPORTED_CONTROL');
  });
});
