import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 注入性能预算（CAP-AF-065）。
 *
 * 这是竞品 1 星差评的**第一主题**：Simplify Firefox 版「lags my computer to a
 * complete stop」，用户三次死机只能硬关机。长表单上一旦卡顿，用户不会归因于
 * 页面，会直接卸载。而我们走的是 AUTOFILL_WIDE_MATCHES 全网宽注入，代价面更大。
 *
 * ## 已知的伸缩形态（实测 2026-08-21，happy-dom）
 *
 * ```
 *   n=200  ~15ms      n=400  ~36ms      n=800  ~105ms
 * ```
 *
 * 字段数翻倍，扫描约三倍——**二次方，而且是设计使然，不是 bug**。
 * `scanRoot.identityScope()` 每个字段调一次，每次都活查 DOM 重算行作用域与
 * 同域控件集合。
 *
 * ## ⚠️ 不要用缓存去"修"它
 *
 * `identityScope` 的活查是 **identity recheck 的地基**：runner 在写入时用保留
 * 的 ScanRoot 重算字段签名，页面在预览与写入之间变了就保守失败。缓存会让
 * recheck 拿到快照而不是当下的页面，那道保护会静默失效——比慢得多。
 *
 * ## 这个文件锁什么，以及为什么没有一个绝对毫秒数
 *
 * 锁**上界**，不锁具体数字。真实 ATS 申请表是几十个字段（实测 Lever 单页 48
 * 个 choice），800 字段已经是病态页面。要抓的是"有人把它变成十倍差"，不是
 * 几毫秒的抖动。
 *
 * 这件事**曾经用绝对毫秒来抓，失败了**：800 字段的预算写死 400ms，实测稳定落在
 * 380–400ms，余量只剩 ~5%，于是机器负载本身就能把它推红——2026-08-23 满载并行
 * 下偶发红两次（420ms、439ms），同一天另有 7 次全绿；隔离单跑 5/5 绿，去掉当天
 * 唯一相关改动（engine 里一行 `getAttribute`）后同样 5/5 绿。**红的是负载，不是
 * 代码**。偶发红比没有门禁更糟：它教会所有人"重跑一次就好"，等于把门禁关掉。
 *
 * 单纯把 400ms 调大也不是答案——那会连真的十倍级劣化一起放过。所以这里换成两层，
 * 两层都不看绝对毫秒：
 *
 * 1. **主门禁：确定性的每字段查询工作量**（`measureQueryWork`）。这条路径的代价
 *    几乎全部来自"每个字段要扫过多少元素"，而那个数字可以直接数出来，与 CPU
 *    有多忙**完全无关**。它同时比计时**更灵敏**：往每字段路径上加一次全树查询，
 *    计数当场就红（时间上才涨 ~1.3 倍，旧门禁根本看不见）。
 * 2. **兜底：墙钟，但比的是"同一次运行里对照负载的倍数"**，不是毫秒。机器忙的
 *    时候对照和被测一起变慢，比值不动。实测（2026-08-23 本机）：空载 800 字段
 *    /对照 = 15.0，16 路 CPU 满载下最高 15.9（+6%），而旧的绝对门禁在同一负载
 *    下 3/3 全红（879–933ms）。
 *
 * 两层的分工是明确的：查询路径的灵敏度归计数器，兜底只管"不走 querySelectorAll
 * 的那部分开销"（每字段的正则、字符串、textContent、closest 遍历……），阈值放到
 * 约 4 倍。**中间那一档（不走查询、只涨 20–30% 的开销）是有意放过的**，不然就
 * 又回到了拿噪声当门禁。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * 每个字段允许发起的 DOM 查询次数。实测恒为 **6.00**，与表单规模无关
 * （identityScope 的行作用域探测 2 次 + 同域控件 2 次，labelTextFor 2 次）。
 * 预算就取实测值：这个数确定性、无抖动，多出一次就是有人在每字段路径上加了
 * 新查询，应当被看见并解释，而不是被 11% 的"余量"吸收掉。
 */
const QUERIES_PER_FIELD_BUDGET = 6;

/**
 * 每字段扫过的元素数 ÷ 容器元素总数 = **"整树扫描当量"**：一个字段要把整棵
 * 容器树走几遍。实测恒为 3.50（n=100 与 n=800 同值），它就是二次方项的系数。
 * 预算 3.9 只留 ~11%：计数没有噪声，余量不是给抖动的，是给无害微调的。
 * 任何一次新增的每字段全树查询至少 +0.5，必红。
 */
const FULL_TREE_SCANS_PER_FIELD_BUDGET = 3.9;

/**
 * 病态规模（800 字段）的墙钟兜底，单位是**对照负载的倍数**，不是毫秒。
 * 实测空载 15.0、16 路满载 15.9。预算 60 ≈ 4 倍余量：十倍级劣化（比值 150）
 * 必红，同时给机器差异和负载留足空间。灵敏度由上面两条计数门禁承担。
 */
const PATHOLOGICAL_FORM_BUDGET_RATIO = 60;

/**
 * 真实规模（50 字段）必须是"瞬时"档，同样按对照倍数计。
 * 实测空载 0.215、满载 0.277；预算 1.0 ≈ 3.6 倍余量。
 */
const REALISTIC_FORM_BUDGET_RATIO = 1.0;

/**
 * shadow 那条不是精细预算，是"会不会挂住"的判据（实测 7ms，满载 54ms），
 * 所以留一个绝对上界就够，不必为它再测一次对照。
 */
const HANG_GUARD_MS = 2000;

/** 墙钟取样次数：取中位数，单次负载尖峰要连中两次才可能翻案。 */
const TIMING_SAMPLES = 3;

/**
 * 对照负载的轮数。选 2000 是让它落在 ~10ms：够大到远离计时噪声，
 * 又不至于让这个文件变慢。
 */
const REFERENCE_ROUNDS = 2000;

/** 对照低于这个值就说明它被优化掉了——分母变小会把比值抬成假红。 */
const REFERENCE_SANITY_FLOOR_MS = 1;

const PROFILE: ApplyProfileDraft = { email: 'ada@example.test', firstName: 'Ada' };

function mountForm(fieldCount: number): void {
  const rows = Array.from(
    { length: fieldCount },
    (_, index) =>
      `<label for="f${index}">Field ${index}</label>` +
      `<input id="f${index}" name="f${index}" type="text" />`,
  ).join('');
  document.body.innerHTML = `<form id="application-form">${rows}</form>`;
}

function resolveMountedRoot(): ReturnType<typeof greenhouseAdapter.resolveRoot> {
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，度量没有意义').not.toBeNull();
  return root;
}

function scanAndPlan(root: NonNullable<ReturnType<typeof greenhouseAdapter.resolveRoot>>): number {
  const fields = [...greenhouseAdapter.scan(root)];
  buildApplyPlan({ vendor: 'greenhouse', root, fields }, PROFILE);
  return fields.length;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 机器速度对照。
 *
 * 形态刻意与被测路径同构——大数组的复制、筛选、线性查找，正是扫描热路径真正
 * 花时间的地方（`querySelectorAll` 本身在 happy-dom 里有缓存，实测只占 3.7/150ms，
 * 时间都花在遍历它交回来的那些集合上）。但它**完全不经过 kernel**：这是关键，
 * 拿被测路径自己当对照的话，劣化会同时抬高分子和分母，比值不动，门禁形同虚设。
 */
function referenceWorkloadMs(): number {
  const pool = Array.from({ length: 1600 }, (_, index) => ({
    index,
    tag: index % 2 === 0 ? 'input' : 'label',
  }));
  const started = performance.now();
  let sink = 0;
  for (let round = 0; round < REFERENCE_ROUNDS; round += 1) {
    const snapshot = [...pool];
    const controls = snapshot.filter((entry) => entry.tag === 'input');
    sink += controls.findIndex((entry) => entry.index === (round * 7) % 1600) + controls.length;
  }
  // 用掉结果，免得整段被 JIT 判成死代码消掉。
  if (sink < 0) throw new Error('对照负载被优化掉了');
  return performance.now() - started;
}

/**
 * 对照的中位数。**前两轮丢掉不是仪式**：JIT 没热身时对照偏快，分母变小会把
 * 比值抬到 1.5 倍，正好是假红的方向（实测热身不足时比值从 4.0 跳到 6.2）。
 */
function machineReferenceMs(): number {
  referenceWorkloadMs();
  referenceWorkloadMs();
  const reference = median([referenceWorkloadMs(), referenceWorkloadMs(), referenceWorkloadMs()]);
  expect(
    reference,
    `对照负载只跑了 ${reference.toFixed(2)}ms，快得不可信——它多半被优化掉了。` +
      '分母失真会让下面的比值失去意义，先修对照，不要动预算。',
  ).toBeGreaterThan(REFERENCE_SANITY_FLOOR_MS);
  return reference;
}

/** 一次扫描+计划里发起的 DOM 查询次数，以及这些查询一共交回多少元素。 */
interface QueryWork {
  calls: number;
  visited: number;
}

/**
 * 数 DOM 查询工作量。
 *
 * 只包 `Element.prototype`：扫描面上的每一次查询都由 ScanRoot 发在受验证容器
 * （一个 Element）上；`document` 级查询在这条路径上本来就是越界的，另有
 * apply-greenhouse-adapter 的「不向全局逃逸」锁着。
 *
 * ⚠️ **这里的顺序是结论，不是随手写的**：happy-dom 的 `<form>` 是一层 Proxy
 * （它要支持 `form.fieldName` 命名访问），**首次取到方法就把绑定好的那个函数
 * 缓住**。只要在装计数器之前先 `container.querySelectorAll(...)` 一次，缓存住的
 * 就是原函数，之后的补丁全部穿不过去——计数**静默归零**，而 0 是"低于预算"的，
 * 门禁会变成一道空门。所以：计数器必须在**任何人碰到容器之前**装好（连
 * `resolveRoot` 都包进来），量容器规模这种会污染缓存的动作只能放到计数之后。
 * 调用方那条"计数必须非零"的哨兵断言就是为这个陷阱留的。
 *
 * ⚠️ 包裹本身有开销（实测 +10%），所以计数与计时**分开跑**，不要合并成一次。
 */
function measureQueryWork(fieldCount: number): { work: QueryWork; fields: number; containerElements: number } {
  mountForm(fieldCount);

  const proto = Element.prototype as unknown as {
    querySelectorAll: (selector: string) => ArrayLike<Element>;
  };
  const original = proto.querySelectorAll;
  const work: QueryWork = { calls: 0, visited: 0 };
  proto.querySelectorAll = function counted(this: ParentNode, selector: string) {
    const found = original.call(this, selector);
    work.calls += 1;
    work.visited += found.length;
    return found;
  };

  let fields: number;
  try {
    fields = scanAndPlan(resolveMountedRoot()!);
  } finally {
    proto.querySelectorAll = original;
  }

  // 量容器规模只能放在这里（见上）。含容器自身：一次"整树扫描"就是走这么多元素。
  const container = document.querySelector('#application-form')!;
  const containerElements = container.querySelectorAll('*').length + 1;
  return { work, fields, containerElements };
}

function timeScanAndPlan(fieldCount: number): { ms: number; fields: number } {
  mountForm(fieldCount);
  const root = resolveMountedRoot();
  const started = performance.now();
  const fields = scanAndPlan(root!);
  return { ms: performance.now() - started, fields };
}

function medianScanAndPlanMs(fieldCount: number): { ms: number; fields: number } {
  const runs = Array.from({ length: TIMING_SAMPLES }, () => {
    const run = timeScanAndPlan(fieldCount);
    document.body.innerHTML = '';
    return run;
  });
  return { ms: median(runs.map((run) => run.ms)), fields: runs[0].fields };
}

describe('注入性能预算', () => {
  it('真实规模（50 字段）的扫描+计划在瞬时档内', () => {
    const reference = machineReferenceMs();
    const { ms, fields } = medianScanAndPlanMs(50);
    expect(fields).toBe(50);

    const ratio = ms / reference;
    expect(
      ratio,
      `50 字段耗时 ${ms.toFixed(2)}ms，是同机对照（${reference.toFixed(1)}ms）的 ${ratio.toFixed(2)} 倍，` +
        `超过 ${REALISTIC_FORM_BUDGET_RATIO}——真实申请表就这个规模，这里慢等于每次都卡。`,
    ).toBeLessThan(REALISTIC_FORM_BUDGET_RATIO);
  });

  /**
   * 主门禁。两个规模一起量：单看一个规模的绝对数，一次性开销（resolveRoot、
   * 厂商指纹）会混在里面；两点相减才拿得到**纯粹的每字段斜率**。
   */
  it('每字段的 DOM 查询工作量不随规模变化——防的是十倍级劣化', () => {
    const small = measureQueryWork(100);
    const large = measureQueryWork(800);
    expect(small.fields).toBe(100);
    expect(large.fields).toBe(800);

    // 哨兵：计数器一旦被 happy-dom 的 form Proxy 缓存挡掉（见 measureQueryWork
    // 头注），所有计数会变成 0，而 0 是"低于预算"的——门禁会静默变成空门。
    for (const sample of [small, large]) {
      expect(
        sample.work.calls,
        `${sample.fields} 字段一次查询都没数到：计数器没生效，这条门禁此刻什么都没在守。` +
          '先修计数器（多半是有人在装补丁之前先碰了容器），不要改预算。',
      ).toBeGreaterThan(0);
    }

    // 斜率：两个规模的查询次数之差 ÷ 字段数之差，天然剔除一次性开销。
    const queriesPerField = (large.work.calls - small.work.calls) / (large.fields - small.fields);
    expect(
      queriesPerField,
      `每字段发起 ${queriesPerField.toFixed(2)} 次 DOM 查询，超过预算 ${QUERIES_PER_FIELD_BUDGET}。` +
        '有人在每字段路径上加了新查询——先确认它是不是真的必须逐字段重算，' +
        '不是就提到扫描外面只做一次。注意：已知形态是二次方且不可缓存' +
        '（见文件头注），所以这条红的时候要查的是"谁加了查询"，不是"去加缓存"。',
    ).toBeLessThanOrEqual(QUERIES_PER_FIELD_BUDGET);

    for (const sample of [small, large]) {
      const scansPerField = sample.work.visited / (sample.fields * sample.containerElements);
      expect(
        scansPerField,
        `${sample.fields} 字段：每字段扫过 ${scansPerField.toFixed(2)} 棵整树的元素` +
          `（${sample.work.visited} 个元素 ÷ ${sample.fields} 字段 ÷ ${sample.containerElements} 元素/整树），` +
          `超过预算 ${FULL_TREE_SCANS_PER_FIELD_BUDGET}。这个数就是二次方项的系数：` +
          '它涨一点，长表单上就是涨很多。',
      ).toBeLessThanOrEqual(FULL_TREE_SCANS_PER_FIELD_BUDGET);
    }
  });

  /**
   * 墙钟兜底。计数器看不见的那部分开销（每字段的正则、字符串拼接、textContent、
   * closest 遍历……）只有时间抓得到，所以这条留着；但它比的是同机对照的倍数，
   * 阈值约 4 倍——宁可放过 20–30% 的劣化，也不要一条会因为机器忙而红的门禁。
   */
  it('病态规模（800 字段）的墙钟相对同机对照仍在兜底预算内', () => {
    const reference = machineReferenceMs();
    const { ms, fields } = medianScanAndPlanMs(800);
    expect(fields).toBe(800);

    const ratio = ms / reference;
    expect(
      ratio,
      `800 字段的 ${TIMING_SAMPLES} 次中位数是 ${ms.toFixed(1)}ms，是同机对照` +
        `（${reference.toFixed(1)}ms）的 ${ratio.toFixed(1)} 倍，超过 ${PATHOLOGICAL_FORM_BUDGET_RATIO}。` +
        '比值把机器负载消掉了，所以这条红**不是抖动**：是真的多出了一大块' +
        '不走 querySelectorAll 的每字段开销。',
    ).toBeLessThan(PATHOLOGICAL_FORM_BUDGET_RATIO);
  });

  /**
   * Shadow 穿透遍历有独立的节点预算（scanRoot 的 SHADOW_TRAVERSAL_NODE_BUDGET）。
   * 这条证明预算真的会截断，而不是写在那儿好看——一个深到离谱的影子树不会把
   * 扫描拖死。截断的代价是少扫到字段，不是卡住宿主页面：**宁可少扫，不可卡住**。
   */
  it('shadow 穿透的节点预算会真的截断，不会把扫描拖死', () => {
    mountForm(10);
    const form = document.querySelector('#application-form')!;
    // 造一条 400 层的影子链，每层一个宿主元素。
    let host: Element = form;
    for (let depth = 0; depth < 400; depth += 1) {
      const next = document.createElement('div');
      host.append(next);
      const shadow = next.attachShadow({ mode: 'open' });
      const inner = document.createElement('div');
      shadow.append(inner);
      host = inner;
    }

    const root = greenhouseAdapter.resolveRoot(document);
    const started = performance.now();
    const fields = [...greenhouseAdapter.scan(root!)];
    const ms = performance.now() - started;

    expect(fields.length, '正常字段仍要扫到').toBe(10);
    expect(
      ms,
      `深影子树把扫描拖到 ${ms.toFixed(1)}ms——遍历预算没有生效。` +
        `（这条是"会不会挂住"的判据，实测 7ms、满载 54ms，${HANG_GUARD_MS}ms 是绝对上界。）`,
    ).toBeLessThan(HANG_GUARD_MS);
  });
});
