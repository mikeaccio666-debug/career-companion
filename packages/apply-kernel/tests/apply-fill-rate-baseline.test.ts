import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { ADAPTERS } from '../src/bundledAdapters';
import { APPLY_VENDORS, type ApplyVendor, type ScanRootOptions } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { mintIntentAuthority, type HostWriteAuthority } from '../src/grant';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/** 整页填充在生产里的授权形态：窗口绑服务端 lease，不是 5 秒手势票。 */
function leaseAuthority(fingerprint: string): HostWriteAuthority {
  const minted = mintIntentAuthority({
    lease: { executionLease: `fill-rate-baseline-${fingerprint}`, expiresAtMs: Date.now() + 120_000 },
    purpose: 'fill',
    fingerprint,
    capabilities: new Set(['set-text', 'set-select', 'set-combobox', 'set-file'] as const),
  });
  if (!minted.ok) throw new Error(`baseline lease authority rejected: ${minted.code}`);
  return minted.value;
}

/**
 * 填充率基准回归（来自 archive/AUTOFILL-施工计划 §2「上线前必须完成」，
 * 2026-08-15 核对发现从未进本仓，同日补建）。
 *
 * 它防两件事，第二件比第一件重要：
 *  1. **selector 腐烂**：站点改版后适配器悄悄少认几个字段，全部测试照样绿
 *     ——因为没有任何一条断言在数"到底填成了几个"。
 *  2. **对外数字没有可复验来源**：50-证据库要求对外数字只能引可复验来源。
 *     没有基线，"填充率 N%"这种话就没有出处，只能靠感觉——而这正是竞品
 *     被用户投诉的形态（"静默失败 + 无解释的汇总数字"，20 §5.1）。
 *
 * **量三个数，名字各管各的**（2026-08-16 审查意见 PR #7 [高]：初版只跑
 * `buildApplyPlan`，量的是"能生成填充计划的比例"，却自称填充率——那是把计划
 * 覆盖率当成实际成功率对外说，正是本文件要防的第 2 件事本身）：
 *
 * | 数 | 含义 | 能不能叫"填充率" |
 * |---|---|---|
 * | `discovered` | 适配器扫出的字段数 | 分母 |
 * | `planned` | 进入写入计划的条目数 | ❌ 这是**计划覆盖率** |
 * | `filled` | `runApplyPlan` 真写进 DOM 且读回校验通过的条目数 | ✅ 这才是填充率 |
 * | `envBlocked` | 计划里有、但本环境量不到的条目（简历文件；带 listbox binding 的 combobox，静态夹具里菜单开不了） | 引用 filled 必须连它一起说 |
 *
 * `filled` 不信 runner 自报的 `summary.filled`：另外独立读回每个目标控件的
 * 当前值逐一比对，两个数必须一致。runner 报成功但 DOM 没变，是本项目实测出过的
 * 形态（2026-08-01 Workday）。
 *
 * 口径（刻意选的）：**给满档案**跑真实夹具，量的是"数据齐全时能填多少"——
 * 把选择器健康度与数据模型缺口解耦。档案缺字段导致的少填属于另一件事
 * （41-能力地图 数据模型域），不该混进这条门禁。
 *
 * 棘轮是**双向**的：掉了红（回归），涨了也红（提示锁住提升）。只有单向的
 * 棘轮挡不住"改好又悄悄改回去"——涨到 5 不锁，回落到 4 时基线还是 4，全绿。
 * 更新基线：`UPDATE_FILL_RATE_BASELINE=1 pnpm --filter @edaix/apply-kernel test`
 */

const BASELINE_PATH = resolve(process.cwd(), 'tests/fixtures/fill-rate-baseline.json');
const UPDATE = process.env.UPDATE_FILL_RATE_BASELINE === '1';

/**
 * 对外引用这份基线时必须一起说的话。
 *
 * 写成常量并被断言锁住，而不是只写在注释里：口径漂了要有东西变红
 * （审查意见 PR #7 [中]）。
 */
const CITATION_SCOPE = [
  '八家各有夹具（greenhouse 2 份，lever / ashby / workable / rippling / dover / bamboohr / jobvite 各 1 份）。' +
    'lever / ashby / workable 三份由各自适配器测试里已对真实 posting 核实过的' +
    '结构提升而来（2026-08-21），rippling / dover / bamboohr / jobvite 四份同理（2026-08-23），' +
    '出处写在各夹具文件头。2026-09-15 lever / ashby / rippling / dover 四份各追加了当日真实 posting ' +
    '只读实测的自定义题结构（题干容器、单选/复选组、下拉、长文本），出处同样写在各夹具文件头；' +
    'dover / bamboohr 两份的文件栏同日按真实页面复测更新（react-dropzone 形状、上方的 Resume 标签块）。' +
    '已接入但**没有**夹具的另有 smartrecruiters / icims，' +
    '登记在 vendorsWithoutFixture——这份基线不覆盖它们。',
  '样本是 9 个静态页面快照，不是线上抓取，也不代表该厂商全部表单形态；' +
    '每家只有 1–2 种表单形状，不能当作该厂商的整体填充率。',
  'skippedByReason 与 filled 同等重要，而且要把原因说对：workable 有 3 个、lever 有 ' +
    '4 个 LOW_CONFIDENCE，实测（2026-08-21 / 2026-09-15）它们的标签都很干净——' +
    'Current company / Address / Postcode / Country / Years of experience，lever 的第 4 个是 ' +
    '2026-09-15 追加的下拉题 Please tell us how you heard about this opportunity。两家各有 1 道「Why do you want to work here?」、rippling 有 2 道 Describe / Tell us about 作文题，从 2026-09-21 起单独记 USER_ONLY（P4-15）：只有用户能答，不是认不出，别拿它去修选择器或加档案键。认不出来是因为' +
    '**档案里没有这些字段**（11 键上限，CAP-AF-018 归 T3），既不是选择器腐烂，' +
    '也不是标签推断缺口。同批追加的自定义题里，题干靠规则的 questionScopes 才读得到：lever 的 ' +
    'Preferred Name 题因此映到 preferredName（planned 7→8），工作授权单选题落 JOB_DEPENDENT、' +
    'AI 记录同意题落 MANUAL_ONLY——题干读对了，守卫才拦得住它们；ashby 的 sponsorship yes/no 同理落 ' +
    'JOB_DEPENDENT。Workable 的 Cover letter 从 T9 Phase D2 起被识别为独立材料；' +
    '基线没有 T9 exact body 与当次 target release 时按 UNSUPPORTED_CONTROL fail closed，' +
    '不得退回档案字段或猜测正文。把这些原因读错会让人去修错的东西。',
  '2026-09-15 同日 lever / workable 两份还按各自真实 apply 页只读实测补上了**标签内部结构**：' +
    'workable 的图标 `<svg><desc>` 与 intl-tel-input 的国家区号表、lever typeahead 与简历上传的' +
    '状态文案——都是 label 的 textContent 里有、用户读不到的文字。这份基线因此与生产一样注入了' +
    'ScanRootOptions.readVisibility（类名藏起来的那部分属性层读不到）；不注入量到的是线上不存在的' +
    '噪声标签。三处只改标签结构，控件的 id / name / 必填性一律未动，所以 discovered / planned / ' +
    'filled 三个数与 2026-09-15 前逐字相同。',
  '分母是**适配器扫出的字段数**，不是页面上全部可填写控件数。',
  'planned 是计划覆盖率，filled 才是填充率；引用时不许把 planned 说成填充率。',
  '简历文件那一栏在本环境**量不到**（envBlocked）：happy-dom 没有布局引擎，' +
    '所有元素报 0×0，而 setFile 的可见触发器检查刻意 fail-closed（src/write/setFile.ts 的' +
    '"Zero geometry fails closed"）。这是测试环境限制，不是简历上传的产品缺口——' +
    '引用 filled 时必须连 envBlocked 一起说，否则 3/4 会被读成"简历上传坏了"。' +
    '这个归因本身被本文件最后一条用例锁住：补上几何后简历文件必须真挂上，' +
    '否则那就不是环境限制。',
  '当前数字不能代表产品整体填充率，不得单独写成"填充率 100%"。',
] as const;

/** 满档案：11 个 canonical 键全给值，隔离"数据缺"这个变量。 */
const FULL_PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  preferredName: 'Ada',
  email: 'ada@example.test',
  phone: '+1 555 0100',
  linkedinUrl: 'https://www.linkedin.com/in/ada',
  githubUrl: 'https://github.com/ada',
  portfolioUrl: 'https://ada.example.test',
  city: 'London',
  location: 'London, UK',
};

const RESUME_FILE_NAME = 'Ada.pdf';

interface FixtureMeasurement {
  readonly discovered: number;
  /** 计划覆盖率的分子——**不是**填充率。 */
  readonly planned: number;
  /** 填充率的分子：真写进 DOM 且读回校验通过。 */
  readonly filled: number;
  /**
   * 计划里有、但**本环境量不到**的条目——今天只有简历文件一类。
   *
   * 单独记而不是混进 filled：它随时可能被误读成产品缺口。这个数一旦
   * 出现 file 以外的类别，说明有真回归躲在"环境限制"后面，测试会红。
   */
  readonly envBlocked: number;
  readonly skippedByReason: Record<string, number>;
}
interface Baseline {
  readonly $comment: string;
  readonly citationScope: readonly string[];
  readonly measuredAt: string;
  readonly fixtures: Record<string, FixtureMeasurement>;
  readonly vendorsWithoutFixture: readonly string[];
}

/** 有真实页面夹具的入口；新增夹具时在这里登记，基线随之扩表。 */
const FIXTURES: ReadonlyArray<{ id: string; vendor: ApplyVendor; file: string }> = [
  { id: 'greenhouse/application-form-with-footer', vendor: 'greenhouse', file: 'greenhouse/application-form-with-footer.html' },
  { id: 'greenhouse/legacy-embed-application-form', vendor: 'greenhouse', file: 'greenhouse/legacy-embed-application-form.html' },
  // 2026-08-21 补齐其余三家（CAP-AF-058）。此前基线只覆盖 greenhouse，
  // 于是"填充率"这个数对四家里的三家没有任何出处，而 CAP-AF-006 白标接线
  // 的验收恰恰要求"先有填充率基线才能证明覆盖真的放大了"。
  // 三份夹具由各自适配器测试里**已对真实 posting 核实过**的结构提升而来，
  // 出处逐份写在文件头注释里。
  { id: 'lever/application-form', vendor: 'lever', file: 'lever/application-form.html' },
  { id: 'ashby/application-form', vendor: 'ashby', file: 'ashby/application-form.html' },
  { id: 'workable/application-form', vendor: 'workable', file: 'workable/application-form.html' },
  // 第七家（2026-08-23）。加它进基线不是补覆盖率，是因为这一家的键**只**靠
  // data-testid 认得出（name 每次页面加载都重新生成、id 是位置序号、
  // autocomplete 一律 off）。没有这条基线，那条路腐烂的时候不会有任何数字变。
  { id: 'rippling/application-form', vendor: 'rippling', file: 'rippling/application-form.html' },
  // 第八家（2026-08-23）。这一家进基线的理由和 Rippling 相反但同样硬：它的
  // label 全是零宽空格，**name 是唯一信号**。那条路腐烂时不会有任何标签兜底
  // 接住它，也不会有任何数字变——除非这里有一条。
  { id: 'dover/application-form', vendor: 'dover', file: 'dover/application-form.html' },
  // 第九家（2026-08-23）。进基线的理由是这一家有**蜜罐**：填错的后果不是少填一栏，
  // 是整份申请被站点静默丢弃。这里的数字一旦变多，第一件要查的就是它。
  { id: 'bamboohr/application-form', vendor: 'bamboohr', file: 'bamboohr/application-form.html' },
  // 第十家（2026-08-23）。进基线的理由：这一家的键**只**靠标准 autocomplete 词表，
  // 而它的标签也很干净 —— 两条路同时成立时最容易发生的事是「attrMap 其实是死数据、
  // 一直是标签在兜底」。基线的数字会在那一刻变。
  { id: 'jobvite/application-form', vendor: 'jobvite', file: 'jobvite/application-form.html' },
];

/**
 * 与生产逐字同形的扫描期注入（kernelScanner.ts / lab.content.ts 都传这一个）。
 *
 * 不传它，这份基线量的就不是生产量到的东西：Workable 电话标签里那张国家区号表
 * 与 Lever typeahead 的状态文案都靠**类名**藏起来，属性层读不到——2026-09-15
 * 两份夹具按真实页面补上那两种形状之后，少了这道注入，基线会把线上根本不存在的
 * 噪声标签当成"实测"锁进 JSON。kernel 自己不碰 getComputedStyle
 *（RULE-KERNEL-DETERMINISTIC-BOUNDARY），读法由调用方给。
 */
const SCAN_OPTIONS: ScanRootOptions = {
  readVisibility: (element) => {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style ? { display: style.display, visibility: style.visibility } : {};
  },
};

afterEach(() => {
  document.documentElement.innerHTML = '';
});

/** 独立读回：一个条目算不算填上了，以宿主控件当前状态为准，不看 runner 的自报。 */
function landedInDom(entry: { kind: string; value: string; element: unknown }): boolean {
  const element = entry.element as HTMLInputElement;
  if (entry.kind === 'file') return element.files?.[0]?.name === entry.value;
  return element.value === entry.value;
}

async function measure(fixture: (typeof FIXTURES)[number]): Promise<FixtureMeasurement> {
  document.documentElement.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures', fixture.file),
    'utf8',
  );
  const adapter = ADAPTERS[fixture.vendor];
  if (adapter === null) throw new Error(`${fixture.vendor} 没有适配器，夹具登记有误`);
  const root = adapter.resolveRoot(document, SCAN_OPTIONS);
  if (root === null) throw new Error(`${fixture.id}: 适配器认不出表单——这本身就是回归`);
  const fields = [...adapter.scan(root, SCAN_OPTIONS)];
  const plan = buildApplyPlan(
    { vendor: fixture.vendor, root, fields },
    FULL_PROFILE,
    { resumeFileName: RESUME_FILE_NAME, resumeHostConfirmed: true },
  );
  const skippedByReason: Record<string, number> = {};
  for (const item of plan.skipped) {
    skippedByReason[item.reason] = (skippedByReason[item.reason] ?? 0) + 1;
  }

  // 真跑一遍写入——这一步是 planned 与 filled 的分水岭。
  // 四个能力位全给：基线量的是"能力齐备时能填多少"，能力位是运行期授权问题，
  // 不该混进选择器健康度。少给 set-file 会让简历那栏落 CAPABILITY_DISABLED，
  // 把授权配置问题记成填充率下降。
  const summary = await runApplyPlan({
    plan,
    // 授权走 **lease** 而不是 5 秒的可信手势票（2026-09-15）：生产与 lab 的整页填充
    // 用的都是 mintIntentAuthority（kernelFiller.ts / lab.content.ts），窗口由服务端
    // lease 决定。这里改口径是因为 lever 夹具接进 typeahead 之后，那一栏在静态夹具里
    // 要等满两次查询预算（部件脚本不在场，菜单永远不开），排在它后面的四个文本框
    // 于是全落 GESTURE_EXPIRED——量到的是手势票时长，不是选择器健康度或填充率，
    // 而后两者才是这份基线的唯一口径。手势票路径本身另有测试覆盖。
    auth: leaseAuthority(plan.fingerprint),
    journal: createUndoJournal(),
    root,
    policy: testApplyPolicy(),
    // 生产总是带着延时复检窗口调用；listbox combobox 通路把缺省视为未授权
    //（CAPABILITY_DISABLED），基线要量的是部件在本环境能否落地，不是这条预检。
    lateRecheckMs: 250,
    resolveResumeFile: async () =>
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], RESUME_FILE_NAME, {
        type: 'application/pdf',
      }),
  });

  const landed = plan.entries.filter(landedInDom).length;
  if (landed !== summary.filled) {
    throw new Error(
      `${fixture.id}: runner 自报填了 ${summary.filled} 个，独立读回 DOM 只有 ${landed} 个——` +
        '"报成功但没写"是 2026-08-01 Workday 实测过的形态，基线不许在这种状态下产出数字',
    );
  }

  // 环境量不到的条目：只允许两类。文件类（happy-dom 无布局 → 可见触发器检查
  // fail-closed），以及带 listbox binding 的 combobox——静态夹具里没有宿主的部件脚本，
  // 菜单永远不会出现，写入器只能以 WIDGET_TIMEOUT 关闭（2026-09-15 Ashby location 进夹具后
  // 出现的形态）。归因锁在原因码上：不是 WIDGET_TIMEOUT 的 combobox 失败仍算真回归。
  // 别的类别出现在这里就是真回归躲在"环境限制"后面。
  const unlanded = plan.entries.filter((entry) => !landedInDom(entry));
  const resultByKey = new Map(summary.results.map((result) => [result.key, result]));
  // 静态夹具里菜单开不了：要么等到超时（WIDGET_TIMEOUT），要么选项集始终为空
  //（CHOICE_NO_DATA）。两者都是"部件脚本不在场"，其余原因码仍算真回归。
  const menuNeverOpened = (entry: (typeof plan.entries)[number]): boolean => {
    if (entry.kind !== 'combobox' || entry.listbox === undefined) return false;
    const result = resultByKey.get(entry.key);
    return result !== undefined && !result.ok && (result.reason === 'WIDGET_TIMEOUT' || result.reason === 'CHOICE_NO_DATA');
  };
  const notFile = unlanded.filter((entry) => entry.kind !== 'file' && !menuNeverOpened(entry));
  if (notFile.length > 0) {
    throw new Error(
      `${fixture.id}: 有 ${notFile.length} 个非文件条目没落到 DOM（${notFile
        .map((entry) => {
          const result = resultByKey.get(entry.key);
          return `${entry.key}:${entry.kind}:${result === undefined ? 'no-result' : result.ok ? 'ok' : result.reason}`;
        })
        .join(', ')}）——这不是环境限制，是真的填不上`,
    );
  }

  return {
    discovered: fields.length,
    planned: plan.entries.length,
    filled: landed,
    envBlocked: unlanded.length,
    skippedByReason,
  };
}

describe('填充率基准（selector 腐烂门禁 + 对外数字的可复验来源）', () => {
  const vendorsWithoutFixture = APPLY_VENDORS.filter(
    (vendor) => !FIXTURES.some((f) => f.vendor === vendor),
  );

  if (UPDATE) {
    it('更新基线（UPDATE_FILL_RATE_BASELINE=1）', async () => {
      // 必须串行：measure() 往同一个全局 document 里灌夹具，并发会互相冲掉
      // （首次改造时踩到——两个夹具并发跑，runner 报 0 而 DOM 里有 3 个值）。
      const measured: Record<string, FixtureMeasurement> = {};
      for (const fixture of FIXTURES) measured[fixture.id] = await measure(fixture);
      const next: Baseline = {
        $comment:
          '填充率基准：给满档案跑真实页面夹具，真执行写入并读回 DOM 的实测计数。' +
          'planned = 计划覆盖率（进入写入计划的条目数）；filled = 填充率（真写进去且校验通过）；'+
          'envBlocked = 本环境量不到的条目数（见 citationScope）。' +
          '掉点或涨点都会让门禁变红——涨了要显式锁住（重跑本文件带 UPDATE_FILL_RATE_BASELINE=1），' +
          '否则日后悄悄退回不会被发现。对外引用这些数字时只能引这份文件，且必须完整转述 citationScope。',
        citationScope: CITATION_SCOPE,
        measuredAt: new Date().toISOString().slice(0, 10),
        fixtures: measured,
        vendorsWithoutFixture,
      };
      writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
      expect(next.fixtures).toBeTruthy();
      // listbox combobox 条目在静态夹具里要等菜单超时，九个夹具串行跑超过默认 5 秒。
    }, 120_000);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;

  it.each(FIXTURES.map((f) => f.id))('%s：填充计数与基线一致（双向棘轮）', async (id) => {
    const fixture = FIXTURES.find((f) => f.id === id)!;
    const now = await measure(fixture);
    const before = baseline.fixtures[id];
    expect(before, `基线里没有 ${id}——新增夹具后请用 UPDATE_FILL_RATE_BASELINE=1 锁基线`).toBeTruthy();
    expect(
      now.discovered,
      `${id} 扫描到的字段数变了（${before!.discovered} → ${now.discovered}）：` +
        '夹具或扫描面改了，必须显式确认后重锁基线',
    ).toBe(before!.discovered);
    expect(
      now.planned,
      now.planned < before!.planned
        ? `${id} 计划覆盖率掉点（${before!.planned} → ${now.planned}）——selector 腐烂或判决路径回归`
        : `${id} 计划覆盖率提升（${before!.planned} → ${now.planned}）——请用 UPDATE_FILL_RATE_BASELINE=1 锁住`,
    ).toBe(before!.planned);
    expect(
      now.filled,
      now.filled < before!.filled
        ? `${id} 填充率掉点（${before!.filled} → ${now.filled}）——真写入失败，比计划掉点严重`
        : `${id} 填充率提升（${before!.filled} → ${now.filled}）——请用 UPDATE_FILL_RATE_BASELINE=1 锁住，否则日后退回不会被发现`,
    ).toBe(before!.filled);
    expect(
      now.envBlocked,
      `${id} 环境量不到的条目数变了（${before!.envBlocked} → ${now.envBlocked}）——` +
        '这个数变动意味着"哪些栏在本环境测不到"变了，必须显式确认',
    ).toBe(before!.envBlocked);
    expect(now.skippedByReason, `${id} 跳过原因分布变了，说明判决路径变了`).toEqual(
      before!.skippedByReason,
    );
  }, 30_000);

  it('未被任何真实夹具覆盖的厂商必须如实登记（对外数字不许拿一家的数说四家）', () => {
    expect(baseline.vendorsWithoutFixture).toEqual(vendorsWithoutFixture);

    // 意图是"别假装补齐了"，不是"必须有人没补齐"。
    // 原先这里断言 vendorsWithoutFixture.length > 0——那是把**当日事实**
    // （只有 greenhouse 有夹具）写成了永久断言，2026-08-21 补齐四家后它反而
    // 变成拦路的假红。改成不依赖当日数量的闭合断言：每一家要么有夹具、
    // 要么如实登记在册，两者的并集必须**恰好**是全部厂商，且不重不漏。
    const covered = [...new Set(FIXTURES.map((fixture) => fixture.vendor))];
    const union = [...covered, ...baseline.vendorsWithoutFixture].sort();
    expect(
      union,
      '有厂商既没夹具也没登记（对外数字会拿有夹具的那几家的数说全部）——或登记重复',
    ).toEqual([...APPLY_VENDORS].sort());
  });

  it('对外引用口径必须原样存在基线文件里（口径漂了要有东西变红）', () => {
    expect(
      baseline.citationScope,
      '基线文件里的 citationScope 与测试常量不一致——对外说法和可复验来源脱钩了',
    ).toEqual([...CITATION_SCOPE]);
  });

  /**
   * `envBlocked` 的归因必须被锁住，不能只写在注释里（审查意见 PR #7 复审 [高]，
   * 2026-08-16）。
   *
   * 审查的探针一针见血：把 `resolveResumeFile` 改成 `async () => null`，
   * 基线仍然全绿——因为真实取件失败和 happy-dom 几何限制**落进同一个桶**。
   * 那样一来"只是环境限制、不是产品缺口"这句话就没有任何东西担保。
   *
   * 更麻烦的是原因码也区分不开：`isApprovedResumeFileTarget` 排在取件**之前**
   * （runner.ts 里 preflight → 目标核准 → 才 resolve），所以两种情况都报
   * `IDENTITY_CHANGED`，resolver 甚至一次都没被调用。
   *
   * 所以这里不靠区分失败，靠**正面证明**：把那个 file input 的几何补上
   * （happy-dom 没有布局引擎，`getBoundingClientRect` 恒 0×0），别的一律不动，
   * 简历文件就该真的挂上去。
   *
   * 这条一旦红，说明简历上传是**真坏了**，`envBlocked` 的归因当场作废。
   * 顺带它也吃掉了审查那个探针：resolver 返回 null 时这里必红。
   */
  it('envBlocked 的归因：补上几何后简历文件就该真挂上——否则那不是环境限制', async () => {
    const fixture = FIXTURES[0]!;
    document.documentElement.innerHTML = readFileSync(
      resolve(process.cwd(), 'tests/fixtures', fixture.file),
      'utf8',
    );
    const adapter = ADAPTERS[fixture.vendor]!;
    const root = adapter.resolveRoot(document, SCAN_OPTIONS)!;
    const fields = [...adapter.scan(root, SCAN_OPTIONS)];
    const plan = buildApplyPlan({ vendor: fixture.vendor, root, fields }, FULL_PROFILE, {
      resumeFileName: RESUME_FILE_NAME,
      resumeHostConfirmed: true,
    });
    const fileEntry = plan.entries.find((entry) => entry.kind === 'file');
    expect(fileEntry, '夹具里没有 file 条目，这条对照测不了任何东西').toBeTruthy();

    // 唯一的改动：给它一个真实渲染过的盒子。不碰适配器、不碰 runner、
    // 不放宽任何守卫——如果只有几何是拦路虎，这一步就足够。
    const input = fileEntry!.element as HTMLInputElement;
    input.getBoundingClientRect = () =>
      ({ width: 220, height: 32, top: 10, left: 10, right: 230, bottom: 42, x: 10, y: 10 }) as DOMRect;

    let resolverCalls = 0;
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-text', 'set-select', 'set-combobox', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => {
        resolverCalls += 1;
        return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], RESUME_FILE_NAME, {
          type: 'application/pdf',
        });
      },
    });

    const fileResult = summary.results.find((result) => result.key === 'resumeFile');
    expect(
      resolverCalls,
      '几何补上了，取件回调却一次都没被调用——说明卡点根本不在几何，envBlocked 的归因是错的',
    ).toBe(1);
    expect(
      fileResult,
      `补上几何后简历文件仍失败（${fileResult?.ok === false ? fileResult.reason : '?'}）——` +
        'envBlocked 归因作废：这不是 happy-dom 的布局限制，是简历上传真的坏了',
    ).toMatchObject({ key: 'resumeFile', ok: true });
    expect(input.files?.[0]?.name, '回执说成功但 DOM 上没有文件').toBe(RESUME_FILE_NAME);
  });
});
