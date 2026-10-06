import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import type { ApplyFieldDescriptor } from '../src/contracts';
import { ripplingAdapter } from '../src/sites/rippling/applyForm';

/**
 * Rippling adapter，结构来自 2026-08-23 对
 * `ats.rippling.com/peach-finance/jobs/<uuid>/apply` 真实在招岗位的只读实测
 * （50-证据库 §F.8-b／§F.8-c，两次页面加载对照）。
 *
 * 这一家值得单独留夹具的地方，是**三个常规属性钩子全部不可用**：
 *
 *  1. `name` **每次页面加载都重新生成**。同一个 first_name，第一次是
 *     `z7FRYsYUls`，刷新之后是 `Ka37Cca77m`。
 *  2. `id` 是位置序号（`field-8` / `field-12`），跨加载稳定但没有语义，
 *     且随表单字段增删整体漂——做不了跨岗位的键。
 *  3. `autocomplete` 一律 `off`，厂商主动关掉的。
 *
 * 唯一稳定且语义化的是 `data-testid`。所以这份夹具里的 `name` **刻意写成随机串**：
 * 任何一条断言如果是靠 name 过的，它就没在测我们真正依赖的那条路。
 *
 * 另外两个实测出来的坑，各有一条负例守着：
 *
 *  · `data-testid` **不唯一**——`input-select-search-input` 同页出现 3 次
 *    （Pronouns／一个无标签必填项／`Please identify your race`）。写进 attrMap
 *    会一次命中三个控件。
 *  · 厂商把 Location 那一栏的 testid 渲染成了字面量 `input-undefined`
 *    （厂商 bug，改天修好就失效），所以 Location 只能靠标签够到。
 *
 * 全部取值为合成值。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** 第一次加载量到的那批随机 name；换一次加载就是另一批，这里保持原样。 */
function mountRipplingFixture(): void {
  document.body.innerHTML = `
    <div id="__next">
      <div>
        <form>
          <div data-testid="field">
            <label for="field-4">Résumé</label>
            <input data-testid="input-resume" id="field-4" type="file" />
          </div>
          <div data-testid="field">
            <label for="field-8">First name*</label>
            <input data-testid="input-first_name" id="field-8" name="z7FRYsYUls" type="text" required />
          </div>
          <div data-testid="field">
            <label for="field-12">Last name*</label>
            <input data-testid="input-last_name" id="field-12" name="kRxpj8ayh3o" type="text" required />
          </div>
          <div data-testid="field">
            <label for="field-16">Email*</label>
            <input data-testid="input-email" id="field-16" name="nHpG1iQfETF" type="text" required />
          </div>
          <div data-testid="field">
            <label for="field-20">Pronouns</label>
            <input data-testid="input-select-search-input" id="field-20" name="9c4Q2jDSQg1" type="text" role="combobox" />
          </div>
          <div data-testid="field">
            <label for="field-27">Current company</label>
            <input data-testid="input-current_company" id="field-27" name="AgUymFF1XW_" type="text" />
          </div>
          <div data-testid="field">
            <label for="field-31">Phone number*</label>
            <input data-testid="input-phone_number" id="field-31" name="Vfu-KG_FTjf" type="text" required />
          </div>
          <div data-testid="field">
            <label for="field-42">Location*</label>
            <input data-testid="input-undefined" id="field-42" name="K5QPDou5hfT" type="text" required />
            <input data-testid="input-externalPlaceId" id="field-47" name="4r25Qj8oiZd" type="hidden" />
          </div>
          <div data-testid="field">
            <label for="field-73">Please identify your race</label>
            <input data-testid="input-select-search-input" id="field-73" name="cjqGEvFZvfz" type="text" role="combobox" />
          </div>
          <div data-testid="field">
            <span>Yes - I consent to receiving text messages</span>
            <input data-testid="radio-sms_opt_in" name="sms_opt_in" type="radio" value="yes" />
            <input data-testid="radio-sms_opt_in" name="sms_opt_in" type="radio" value="no" />
          </div>
          <input name="cf-turnstile-response" type="hidden" />
        </form>
      </div>
    </div>`;
}

function scan(): ApplyFieldDescriptor[] {
  mountRipplingFixture();
  const root = ripplingAdapter.resolveRoot(document);
  expect(root, '锚点没认出来——申请表根都拿不到，后面每条断言都是空跑').toBeTruthy();
  return [...ripplingAdapter.scan(root!)];
}

function keyOf(fields: ApplyFieldDescriptor[], testid: string): string | null {
  const field = fields.find((f) => f.element.getAttribute('data-testid') === testid);
  return field ? (field.key ?? null) : null;
}

describe('Rippling adapter · 申请路径', () => {
  it('只在 /jobs/<uuid>/apply 上认，岗位描述页不认', () => {
    const uuid = 'b507c21b-2ee2-4ffc-8b58-250881fb6463';
    expect(ripplingAdapter.isApplyPath(`/peach-finance/jobs/${uuid}/apply`)).toBe(true);
    expect(ripplingAdapter.isApplyPath(`/peach-finance/jobs/${uuid}/apply/`)).toBe(true);
    // 岗位页只渲染描述，申请表要点「Apply now」才展开（实测）。在那上面
    // 认作申请面的后果是 resolveRoot 反复扑空。
    expect(ripplingAdapter.isApplyPath(`/peach-finance/jobs/${uuid}`)).toBe(false);
    expect(ripplingAdapter.isApplyPath('/peach-finance/jobs')).toBe(false);
  });
});

describe('Rippling adapter · data-testid 是唯一能用的钩子', () => {
  it('四个核心字段靠 data-testid 认出来，且 name 一个都没参与', () => {
    const fields = scan();
    expect(keyOf(fields, 'input-first_name')).toBe('firstName');
    expect(keyOf(fields, 'input-last_name')).toBe('lastName');
    expect(keyOf(fields, 'input-email')).toBe('email');
    expect(keyOf(fields, 'input-phone_number')).toBe('phone');
  });

  it('name 换一批（模拟一次页面重新加载）不影响任何一个键', () => {
    const first = scan();
    // 实测：刷新之后 first_name 从 z7FRYsYUls 变成 Ka37Cca77m。
    document.body.innerHTML = document.body.innerHTML
      .replace('z7FRYsYUls', 'Ka37Cca77m')
      .replace('kRxpj8ayh3o', 'YmKqkpf49At')
      .replace('nHpG1iQfETF', 'JAyCLmjAWL9')
      .replace('Vfu-KG_FTjf', 'wC55cZ218p8');
    const second = [...ripplingAdapter.scan(ripplingAdapter.resolveRoot(document)!)];
    const keys = (fields: ApplyFieldDescriptor[]) =>
      fields.map((f) => `${f.element.getAttribute('data-testid')}=${f.key ?? '∅'}`);
    expect(keys(second)).toEqual(keys(first));
    // ⚠️ 只比「两次相同」会空跑：如果键根本认不出来，两次都是 ∅ 也相等。
    expect(second.filter((f) => f.key !== null).map((f) => f.key).sort()).toEqual([
      // 2026-09-22 新增：这一家的「Current company」本来就在页面上，键也在闭集与后端放行
      // 名单里，只是十家里只有三家写了这条规则——于是它在真实页面上一直报「没把握，
      // 没敢填」（那句话的内核含义是 `!field.key`，实测这一家 6 次）。
      'currentCompany',
      'email',
      'firstName',
      'lastName',
      'location',
      'phone',
      // 2026-09-21 填写键扩展：Pronouns 靠标签认到代词键（它的 testid 与别的控件共用，见下一组）。
      'preferredPronouns',
    ]);
  });

  it('Location 靠标签认——它的 testid 是厂商 bug（input-undefined）', () => {
    const fields = scan();
    expect(keyOf(fields, 'input-undefined')).toBe('location');
  });
});

describe('Rippling adapter · 实测出来的两个坑各有一条负例', () => {
  it('重复的 input-select-search-input 不靠 testid 映射：只有 Pronouns 靠自己的标签认出来', () => {
    const fields = scan();
    const shared = fields.filter(
      (f) => f.element.getAttribute('data-testid') === 'input-select-search-input',
    );
    // 同页 3 个（夹具留了其中 2 个：Pronouns 与 Please identify your race）。
    expect(shared.length).toBeGreaterThan(1);
    // 把这个 testid 写进 attrMap 会让三个控件同时变成同一个键。2026-09-21 起 Pronouns
    // 有了自己的键（preferredPronouns），但那是**标签**认出来的；族裔那一栏仍然没有键。
    expect(shared.map((f) => f.key ?? null)).toEqual(['preferredPronouns', null]);
  });

  /**
   * Turnstile —— 这里要说准一件事，别把防御性摆设说成承重墙。
   *
   * 实测这一家挂的是 Cloudflare Turnstile（`load-turnstile-script` +
   * `turnstile-container`），它的回填输入是 **`type="hidden"`**。所以在真实
   * 页面上，把它挡在扫描面之外的是 **hidden**，不是规则里的 `denyNameSubstrings`
   * ——这一点与 Ashby 相反（那家的 `g-recaptcha-response` 是容器内的具名
   * textarea，deny 表在那里是承重墙）。
   *
   * 第一条按真实形态测；第二条用一个**刻意不忠实**的变体测——把回填输入改成
   * 可见控件。Cloudflare 不会那样渲染，它证明的不是页面形态，而是**这一家的
   * deny 表确实接上了、不是死数据**：去掉规则里的 `turnstile` 那一项，
   * 第二条当场红（探针实测；只留第一条时全绿，因为 hidden 已经吃掉了它）。
   */
  it('真实形态：turnstile 的回填输入不进扫描面', () => {
    const fields = scan();
    expect(fields.some((f) => (f.element.getAttribute('name') ?? '').includes('turnstile'))).toBe(
      false,
    );
  });

  it('deny 表是活的：即便回填输入是可见控件，也一样挡在扫描面外', () => {
    mountRipplingFixture();
    const holder = document.querySelector('input[name="cf-turnstile-response"]')!;
    holder.setAttribute('type', 'text');
    const fields = [...ripplingAdapter.scan(ripplingAdapter.resolveRoot(document)!)];
    // 铁律 5：人机验证永远由用户本人操作。要的是根本看不见，不是看得见但不填——
    // 不映射的控件仍会进候选集、仍会被标签兜底看到。
    expect(fields.some((f) => (f.element.getAttribute('name') ?? '').includes('turnstile'))).toBe(
      false,
    );
  });
});

describe('Rippling adapter · 简历那一栏', () => {
  /**
   * 这一栏两层判据都差点够不着，所以单独立一条端到端的。
   *
   *  · 文案层：标签是 `Résumé`，重音在**第一个** e 上——`\bresum[eé]\b` 匹配不到；
   *  · 属性身份层：`name` 为空、`id` 是位置序号 `field-4`，唯一语义化的是
   *    `data-testid="input-resume"`，而 `engine.ts` 的 identities 原本不读它。
   *
   * 两层各漏一半的后果是「简历上传永不触发且完全静默」——面板显示「需手动填」，
   * 看起来像我们不支持这个控件（2026-08-01 Greenhouse 那次同一形状）。
   *
   * 探针：从 identities 里删掉 `data-testid` 这一行，本条当场红。
   */
  it('进得了填充计划——文案层与属性身份层各自都够得着', () => {
    const fields = scan();
    const root = ripplingAdapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'rippling', root, fields },
      { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      { resumeFileName: 'Ada.pdf', resumeHostConfirmed: true },
    );
    const resume = plan.entries.find((entry) => entry.key === 'resumeFile');
    expect(resume, '简历那一栏没进计划——两层判据至少有一层没够着').toBeTruthy();
    expect(resume!.element.getAttribute('data-testid')).toBe('input-resume');

    // 属性身份层单独成立：把标签摘掉，只剩 data-testid 也要够得着。
    document.querySelector('label[for="field-4"]')!.remove();
    const bare = [...ripplingAdapter.scan(ripplingAdapter.resolveRoot(document)!)];
    const barePlan = buildApplyPlan(
      { vendor: 'rippling', root: ripplingAdapter.resolveRoot(document)!, fields: bare },
      { firstName: 'Ada' },
      { resumeFileName: 'Ada.pdf', resumeHostConfirmed: true },
    );
    expect(
      barePlan.entries.some((entry) => entry.key === 'resumeFile'),
      '标签没了就够不着——说明属性身份层没读 data-testid',
    ).toBe(true);
  });
});
