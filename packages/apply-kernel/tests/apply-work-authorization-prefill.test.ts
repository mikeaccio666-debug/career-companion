/**
 * 工作授权／担保：题目点名了国家、用户有那条记录 → **直接写**（2026-09-21 起，那条记录
 * 是他自己填的）；题目没点名、按岗位地点推断的 → 2026-09-23 起同样直接写。
 * 标签逐字取自 352 个真实申请页上的必填题。
 *
 * 「不答」的用例比「答对」的多，是刻意的：答错不是少填一栏，是在一份正式申请里
 * 向雇主做了不实的事实陈述。
 *
 * 2026-09-24 负责人决定（Mike，Twilio 爱沙尼亚岗上那道「Are you legally authorized to work in the country
 * in which this role is located?」，他只有美国记录：「就答是的」）：说得出是哪一国、他有别国的记录唯独没有
 * 这一国的，与 Jobright 一样按默认答——有权工作「是」、要不要担保「否」、不需担保就有权工作「是」，条目带上
 * `defaultedRegionCode`，浮层写明、请他提交前核对。风险（他其实不能在那里合法工作时就是一句不实陈述）已向他
 * 说明，他选了这样做。一条记录都没有的照旧不答：很多用户是国际学生，替他们在美国岗上答「不需要担保」就是错的。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { inferRegionCode } from '../src/dict/regions';
import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFormDescriptor } from '../src/contracts';

const YES_NO = ['Yes', 'No'];

/** 用户手上：美国有权工作、不需担保；加拿大无权工作、需要担保。 */
const AUTHORIZATIONS = [
  { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' },
  { regionCode: 'CA', authorizedToWork: 'NO', requiresSponsorship: 'YES' },
] as const;

function form(label: string, options: readonly string[] = YES_NO): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${options.map((text, index) => `
    <label for="o${index}">${text}</label>
    <input type="radio" id="o${index}" name="q" value="${index}">`).join('')}</form>`;
  const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[];
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'choice', element: inputs[0]!, key: null, label, required: true, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: { control: 'radio', options: inputs.map((e, i) => ({ element: e, label: options[i]! })) },
    }],
  } as never;
}

type Opts = Partial<{ capability: boolean; authorizations: unknown }>;

function planFor(label: string, opts: Opts = {}) {
  return buildApplyPlan(form(label), {} as never, {
    fillEmptyOnly: false,
    ...((opts.capability ?? true) ? { capabilities: { 'set-work-authorization': true } } : {}),
    workAuthorizations: opts.authorizations ?? AUTHORIZATIONS,
  } as never);
}

/** 「不答」的判据：一个字不写，且那一行停在 JOB_DEPENDENT。 */
function skip(label: string, opts: Opts = {}) {
  const plan = planFor(label, opts);
  expect(plan.entries).toHaveLength(0);
  return plan.skipped[0];
}

function written(label: string, opts: Opts = {}) {
  const plan = planFor(label, opts);
  expect(plan.skipped).toHaveLength(0);
  return plan.entries[0];
}

afterEach(() => { document.body.innerHTML = ''; });

describe('点名了国家、而且用户有那条记录：直接写', () => {
  it('美国有权工作 → 写 Yes，键是 workAuthorization', () => {
    expect(written('Are you authorized to work in the United States?')).toMatchObject({
      kind: 'choice', key: 'workAuthorization', value: 'Yes',
    });
  });

  it('加拿大无权工作 → 写 No，不拿美国那条顶替', () => {
    expect(written('Are you legally entitled to work in Canada?')).toMatchObject({
      key: 'workAuthorization', value: 'No',
    });
  });

  it('担保是另一问：美国不需担保 → No，键是 workSponsorship', () => {
    expect(written('Will you now or in the future require visa sponsorship to work in the US?'))
      .toMatchObject({ key: 'workSponsorship', value: 'No' });
  });

  it('同一个人在加拿大需要担保 → Yes', () => {
    expect(written('Will you now or in the future require visa sponsorship to work in Canada?'))
      .toMatchObject({ key: 'workSponsorship', value: 'Yes' });
  });

  it('英式拼写 authorised：英国有权工作 → 写 Yes', () => {
    // 从前「随岗位而定」的判据只认 authoriz，这一题连工作授权那条分支都进不去。
    expect(written('Are you legally authorised to work in the United Kingdom?', {
      authorizations: [{ regionCode: 'GB', authorizedToWork: 'YES', requiresSponsorship: 'NO' }],
    })).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
  });

  it('页面上已经选了别的：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = form('Are you authorized to work in the United States?');
    (document.querySelector('#o1') as HTMLInputElement).checked = true;
    const plan = buildApplyPlan(descriptor, {} as never, {
      capabilities: { 'set-work-authorization': true }, workAuthorizations: AUTHORIZATIONS,
    } as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'workAuthorization' });
  });
});

describe('这些一律退回 JOB_DEPENDENT', () => {
  it('题目不点名国家——语料里一半以上是这种', () => {
    for (const label of [
      'Are you currently legally authorized to work in the country in which this job is based?',
      'Are you authorized to work in the country for which you applied?',
      'Are you authorized to work in the stated location of this role?',
      'Do you now or will you in the future require immigration sponsorship to work at Cloudflare?',
      'Do you require visa sponsorship?',
    ]) {
      expect(skip(label)).toMatchObject({ reason: 'JOB_DEPENDENT' });
      expect(skip(label)?.prefill).toBeUndefined();
    }
  });

  it('能力位没开', () => {
    expect(skip('Are you authorized to work in the United States?', { capability: false }))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('清单为空：2026-09-24 起的默认答只给有别国记录的人，一条记录都没有照旧不答', () => {
    expect(skip('Are you authorized to work in the United States?', { authorizations: [] }))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
    expect(skip('Will you now or in the future require visa sponsorship to work in the US?', { authorizations: [] }))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('记录是 UNSPECIFIED——那不是一个答案', () => {
    expect(skip('Are you authorized to work in the United States?', {
      authorizations: [{ regionCode: 'US', authorizedToWork: 'UNSPECIFIED', requiresSponsorship: 'UNSPECIFIED' }],
    })).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('页面上没有对得上的选项', () => {
    const plan = buildApplyPlan(
      form('Are you authorized to work in the United States?', ['Definitely', 'Absolutely not']),
      {} as never,
      { fillEmptyOnly: false, capabilities: { 'set-work-authorization': true }, workAuthorizations: AUTHORIZATIONS } as never,
    );
    expect(plan.skipped[0]).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });
});

/**
 * 题目不点名国家、按岗位地点推断（P1-7）。
 *
 * 2026-09-21 Mike 定的是「开，只预填等放行」；2026-09-23 改为**直接写**：「Will you now or in the future
 * require sponsorship (e.g., H-1B)」几乎每家都问、几乎都不点名国家，每次都要用户多点一下「回填」。
 * 前提没变：调用方从申请卡片解出恰好一个国家码才传；内核只在题目一个地方都没提、问的也不是「你现在
 * 住的国家」时用它；用户在那国有明确的是／否记录。写进去的条目带上推断的国家，浮层写明依据。
 */
describe('题目不点名国家：按岗位地点推断', () => {
  const inferredPlan = (label: string, jobRegionCode: string | undefined) =>
    buildApplyPlan(form(label), {} as never, {
      fillEmptyOnly: false,
      capabilities: { 'set-work-authorization': true },
      workAuthorizations: AUTHORIZATIONS,
      ...(jobRegionCode === undefined ? {} : { jobRegionCode }),
    } as never);
  /** 推断得出 → 直接写，返回那一条；推断不出 → 不写，返回跳过的那一条。 */
  const inferredEntry = (label: string, jobRegionCode: string) => {
    const plan = inferredPlan(label, jobRegionCode);
    expect(plan.skipped, '推断得出的答案直接写，不再等放行').toHaveLength(0);
    return plan.entries[0];
  };
  const inferred = (label: string, jobRegionCode: string | undefined) => {
    const plan = inferredPlan(label, jobRegionCode);
    expect(plan.entries, '推断不出的不写').toHaveLength(0);
    return plan.skipped[0];
  };

  it('岗位在美国 + 用户有美国记录 → 直接写，并带上推断的国家', () => {
    expect(inferredEntry('Are you currently legally authorized to work in the country in which this job is based?', 'US'))
      .toMatchObject({ key: 'workAuthorization', value: 'Yes', inferredRegionCode: 'US' });
    expect(inferredEntry('Do you now or will you in the future require immigration sponsorship to work at Cloudflare?', 'US'))
      .toMatchObject({ key: 'workSponsorship', value: 'No', inferredRegionCode: 'US' });
  });

  it('H-1B 的几种常见问法（不点名国家）→ 按担保那一项直接写', () => {
    for (const label of [
      'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?',
      'Do you now, or will you in the future, require visa sponsorship (e.g. H1B) to work for us?',
      'Will you require the company to sponsor an H-1B visa for you?',
    ]) {
      expect(inferredEntry(label, 'US'), label).toMatchObject({ key: 'workSponsorship', value: 'No', inferredRegionCode: 'US' });
    }
  });

  it('问的是现在的签证身份，不是要不要担保 → 不答', () => {
    expect(inferred('Are you currently on an H-1B visa?', 'US')).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('岗位在加拿大：按加拿大那条答，不拿美国那条顶替', () => {
    expect(inferredEntry('Are you authorized to work in the country for which you applied?', 'CA'))
      .toMatchObject({ key: 'workAuthorization', value: 'No', inferredRegionCode: 'CA' });
  });

  it('调用方解不出岗位国家（Remote / EMEA）→ 不传 → 照旧 JOB_DEPENDENT', () => {
    expect(inferred('Are you authorized to work in the country for which you applied?', undefined))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  // 2026-09-24 负责人决定：点名的日本他没有记录、但有别国的记录 → 按默认答（担保题「否」），带上日本，
  // 不拿岗位所在的美国那条顶替。
  it('题目点名了地方就只认点名的：点名日本、岗位在美国 → 按日本默认答；点名美国、岗位在加拿大 → 按美国那条直接写', () => {
    const japan = inferredEntry('Will you now or in the future require sponsorship to work in Japan?', 'US');
    expect(japan).toMatchObject({ key: 'workSponsorship', value: 'No', defaultedRegionCode: 'JP' });
    expect(japan?.inferredRegionCode, '日本是题目点名的，不是按岗位地点推的').toBeUndefined();
    const named = inferredPlan('Are you authorized to work in the United States?', 'CA');
    expect(named.entries[0]).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
    expect(named.entries[0]?.defaultedRegionCode, '有记录就按记录答，不是默认').toBeUndefined();
    expect(named.skipped).toHaveLength(0);
  });

  // 2026-09-24 负责人决定：岗位国家他没有记录、但有别国的记录 → 按默认答「是」，推断与默认两个依据都带上。
  it('岗位国家用户没有记录、但有别国的记录 → 按默认答，带上推断的国家与「按默认答」', () => {
    expect(inferredEntry('Are you authorized to work in the country for which you applied?', 'JP'))
      .toMatchObject({ key: 'workAuthorization', value: 'Yes', inferredRegionCode: 'JP', defaultedRegionCode: 'JP' });
  });

  it('nvidia.wd5 Workday 第 3 步那两题（美国岗）：有权工作 → Yes；需要雇主支持 → No', () => {
    // 第二题从前被判成「有权工作」，预填的是 Yes——替一个不需要担保的人说「我需要雇主支持」。
    expect(inferredEntry('Are you legally authorized to work in the country where this position is located', 'US'))
      .toMatchObject({ key: 'workAuthorization', value: 'Yes', inferredRegionCode: 'US' });
    expect(inferredEntry('Will you require employer support to obtain or maintain authorization to work in the country where this position is located?', 'US'))
      .toMatchObject({ key: 'workSponsorship', value: 'No', inferredRegionCode: 'US' });
  });

  it('问的是「你现在住的国家」→ 不拿岗位地点推，交还用户', () => {
    expect(inferred("Are you authorized to work in the country you're currently living in?", 'US'))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
    expect(inferred('Will you now or in the future require sponsorship for a visa to remain in your current location?', 'US'))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
  });
});

/** 带着任意选项跑一遍计划：默认有两条记录（美国、加拿大），`extra` 覆盖。 */
const planWith = (label: string, extra: Record<string, unknown> = {}, options: readonly string[] = YES_NO) =>
  buildApplyPlan(form(label, options), {} as never, {
    fillEmptyOnly: false,
    capabilities: { 'set-work-authorization': true },
    workAuthorizations: AUTHORIZATIONS,
    ...extra,
  } as never);

/** 只有美国一条记录——测试台 Twilio 8185918（Remote - Estonia）与 Starburst 5119301008（Warsaw, Poland）上的真实情形。 */
const US_ONLY = [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }] as const;

/**
 * 说得出是哪一国（题目点名、或按岗位地点推断）、而他在那一国没有记录。
 *
 * 2026-09-24 上午（#105）定的是照旧不答、原因照实说「你的资料里没有在这一国工作的许可记录」。同一天负责人改了
 * （Mike，测试台 Twilio 爱沙尼亚岗那道「Are you legally authorized to work in the country in which this role is
 * located?」，他只有美国记录：「就答是的」）：他有别国的记录、唯独没有这一国的，与 Jobright 一样按默认答——
 * 有权工作「是」、要不要担保「否」、不需担保就有权工作「是」，条目带上 `defaultedRegionCode`，浮层写明、请他提交前
 * 核对。风险（他其实不能在那里合法工作时，这就是一句不实陈述）已向他说明，他选了这样做。
 *
 * 不变的：明确的记录（包括明确的「否」）永远优先；一条记录都没有的照旧不答，并带上是哪一国（下一组）。
 */
describe('说得出是哪一国、他有别国的记录唯独没有这一国的：按默认答（2026-09-24 负责人决定）', () => {
  it('岗位在爱沙尼亚、他只有美国的记录：有权工作答 Yes、要不要担保答 No，带上爱沙尼亚', () => {
    const authorized = planWith('Are you legally authorized to work in the country in which this role is located?', {
      jobRegionCode: 'EE', workAuthorizations: US_ONLY,
    });
    expect(authorized.skipped).toHaveLength(0);
    expect(authorized.entries[0]).toMatchObject({
      key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'EE', inferredRegionCode: 'EE',
    });
    const sponsorship = planWith('Will you now or in the future require sponsorship for employment visa status?', {
      jobRegionCode: 'EE', workAuthorizations: US_ONLY,
    });
    expect(sponsorship.skipped).toHaveLength(0);
    expect(sponsorship.entries[0]).toMatchObject({
      key: 'workSponsorship', value: 'No', defaultedRegionCode: 'EE', inferredRegionCode: 'EE',
    });
  });

  it('岗位在波兰（Starburst，Warsaw）、他有美国与加拿大两条记录：同样按默认答', () => {
    expect(planWith('Are you authorized to work in the country for which you applied?', { jobRegionCode: 'PL' }).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'PL' });
    expect(planWith('Do you require visa sponsorship?', { jobRegionCode: 'PL' }).entries[0])
      .toMatchObject({ key: 'workSponsorship', value: 'No', defaultedRegionCode: 'PL' });
  });

  it('「不需要担保就有权工作吗」→ Yes', () => {
    expect(planWith('Are you legally authorized to work in the country where this role is located without requiring sponsorship?', {
      jobRegionCode: 'EE', workAuthorizations: US_ONLY,
    }).entries[0]).toMatchObject({ key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'EE' });
  });

  it('题目自己点名了一个他没有记录的国家（波兰、日本）：按默认答，带上那一国，不拿岗位国家顶替', () => {
    const poland = planWith('Are you legally authorized to work in Poland?', { jobRegionCode: 'US', workAuthorizations: US_ONLY });
    expect(poland.skipped).toHaveLength(0);
    expect(poland.entries[0]).toMatchObject({ key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'PL' });
    expect(poland.entries[0]?.inferredRegionCode, '波兰是题目点名的，不是按岗位地点推的').toBeUndefined();
    expect(planWith('Will you now or in the future require sponsorship to work in Japan?').entries[0])
      .toMatchObject({ key: 'workSponsorship', value: 'No', defaultedRegionCode: 'JP' });
  });

  it('明确的记录永远优先：那一国的记录是「否」就答「否」（要担保就答「是」），不按默认', () => {
    const records = [...US_ONLY, { regionCode: 'EE', authorizedToWork: 'NO', requiresSponsorship: 'YES' }];
    const authorized = planWith('Are you legally authorized to work in the country in which this role is located?', {
      jobRegionCode: 'EE', workAuthorizations: records,
    }).entries[0];
    expect(authorized).toMatchObject({ key: 'workAuthorization', value: 'No', inferredRegionCode: 'EE' });
    expect(authorized?.defaultedRegionCode).toBeUndefined();
    const sponsorship = planWith('Will you now or in the future require sponsorship to work in Estonia?', {
      workAuthorizations: records,
    }).entries[0];
    expect(sponsorship).toMatchObject({ key: 'workSponsorship', value: 'Yes' });
    expect(sponsorship?.defaultedRegionCode).toBeUndefined();
    const canada = planWith('Are you legally entitled to work in Canada?').entries[0];
    expect(canada).toMatchObject({ key: 'workAuthorization', value: 'No' });
    expect(canada?.defaultedRegionCode).toBeUndefined();
  });

  it('那一国有记录、只是这一问没填（UNSPECIFIED）：不拿默认顶替他的记录，交还用户', () => {
    const records = [...US_ONLY, { regionCode: 'EE', authorizedToWork: 'UNSPECIFIED', requiresSponsorship: 'NO' }];
    for (const label of [
      'Are you legally authorized to work in the country in which this role is located?',
      'Are you legally authorized to work in the country where this role is located without requiring sponsorship?',
    ]) {
      const result = planWith(label, { jobRegionCode: 'EE', workAuthorizations: records });
      expect(result.entries, label).toHaveLength(0);
      expect(result.skipped[0], label).toMatchObject({ reason: 'JOB_DEPENDENT' });
      expect(result.skipped[0]?.regionWithoutRecord, label).toBeUndefined();
    }
  });

  it('问的是「你现在住的国家」：不拿岗位地点推，也就没有默认可答', () => {
    const result = planWith("Are you authorized to work in the country you're currently living in?", {
      jobRegionCode: 'EE', workAuthorizations: US_ONLY,
    });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('页面上没有对得上的选项：默认答案写不下，照实说缺的是哪一国的记录', () => {
    const result = planWith('Are you legally authorized to work in the country in which this role is located?', {
      jobRegionCode: 'EE', workAuthorizations: US_ONLY,
    }, ['Definitely', 'Absolutely not']);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: 'JOB_DEPENDENT', regionWithoutRecord: 'EE' });
  });

  it('题目点名的国家他有记录：照旧按记录直接写，不拿岗位国家顶替', () => {
    const named = planWith('Are you authorized to work in the United States?', { jobRegionCode: 'EE' }).entries[0];
    expect(named).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
    expect(named?.defaultedRegionCode).toBeUndefined();
  });
});

/**
 * 说得出是哪一国、但他一条工作许可记录都没有（2026-09-24）：照旧不答——很多用户是国际学生，替他们在美国岗上
 * 答「不需要担保」就是错的。原因照实说「你的资料里没有在这一国工作的许可记录」，不说「取决于这个岗位」。
 */
describe('说得出是哪一国、但他一条记录都没有：照旧不答，并带上是哪一国', () => {
  it('岗位国家、题目点名的国家都一样', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['Are you authorized to work in the country for which you applied?', 'US', 'US'],
      ['Are you legally authorized to work in the country in which this role is located?', 'EE', 'EE'],
      ['What is the source of your right to work where this role is listed?', 'EE', 'EE'],
      ['Will you now or in the future require sponsorship for employment visa status?', 'EE', 'EE'],
      ['Are you legally authorized to work in Poland?', 'US', 'PL'],
      ['Will you now or in the future require sponsorship to work in Japan?', undefined, 'JP'],
    ];
    for (const [label, jobRegionCode, region] of cases) {
      const result = planWith(label, { workAuthorizations: [], ...(jobRegionCode === undefined ? {} : { jobRegionCode }) });
      expect(result.entries, label).toHaveLength(0);
      expect(result.skipped[0], label).toMatchObject({ reason: 'JOB_DEPENDENT', regionWithoutRecord: region });
    }
  });

  it('说不出是哪一国、记录没读到、记录是 UNSPECIFIED、或能力位没开：只说取决于岗位，也不按默认答', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Are you authorized to work in the country for which you applied?', {}],
      ['Are you authorized to work in the US or Canada?', {}],
      ['Are you authorized to work in the country for which you applied?', { jobRegionCode: 'EE', workAuthorizations: undefined }],
      ['Are you authorized to work in the United States?', {
        workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'UNSPECIFIED', requiresSponsorship: 'UNSPECIFIED' }],
      }],
      ['Are you authorized to work in the country for which you applied?', { jobRegionCode: 'EE', capabilities: {} }],
    ];
    for (const [label, extra] of cases) {
      const result = planWith(label, extra);
      expect(result.entries, label).toHaveLength(0);
      expect(result.skipped[0], label).toMatchObject({ reason: 'JOB_DEPENDENT' });
      expect(result.skipped[0]?.regionWithoutRecord, label).toBeUndefined();
    }
  });
});

/**
 * 题目点名的是美国的一个州（2026-09-24 协调方跟进）。从前州名与同码的国家混在一起：「California」按加拿大那条记录答、
 * 「Delaware」按德国、「Indiana」按印度，题面上的裸码 CA、DE、IN 也一样——替一个在美国有权工作的人按他加拿大的「否」
 * 答了「否」。现在州名按美国认（工作授权是联邦的：有权在美国工作就有权在加州工作），美国那条记录有就按它答，没有就走
 * 默认那条路；两字母州码与三十来个国家码同形，谁都不认，交还用户；Georgia 既是州又是国家，交还用户。
 * 从前「点名加州、他只有美国记录」交还用户（上一个提交还钉着），现在按美国那条答。
 */
describe('题目点名了美国的一个州：按美国答，从不按同码国家的记录', () => {
  const CANADA_NO = [{ regionCode: 'CA', authorizedToWork: 'NO', requiresSponsorship: 'YES' }] as const;

  it('California：美国与加拿大都有记录 → 按美国那条（Yes／担保 No），不按加拿大的 No', () => {
    expect(planWith('Are you legally authorized to work in California?').entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'Yes' });
    expect(planWith('Will you now or in the future require sponsorship to work in California?').entries[0])
      .toMatchObject({ key: 'workSponsorship', value: 'No' });
    const usOnly = planWith('Are you legally authorized to work in California?', { workAuthorizations: US_ONLY }).entries[0];
    expect(usOnly).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
    expect(usOnly?.defaultedRegionCode, '按记录答的').toBeUndefined();
  });

  it('California：只有加拿大的记录 → 不按加拿大的 No；美国没有记录，按默认答，带上美国', () => {
    const entry = planWith('Are you legally authorized to work in California?', { workAuthorizations: CANADA_NO }).entries[0];
    expect(entry).toMatchObject({ key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'US' });
  });

  it('裸码 CA、DE、IN：说不清是州还是国家，交还用户，也不按默认答', () => {
    for (const [label, records] of [
      ['Are you legally authorized to work in CA?', AUTHORIZATIONS],
      ['Are you legally authorized to work in DE?', [...US_ONLY, { regionCode: 'DE', authorizedToWork: 'NO', requiresSponsorship: 'YES' }]],
      ['Are you legally authorized to work in IN?', [...US_ONLY, { regionCode: 'IN', authorizedToWork: 'NO', requiresSponsorship: 'YES' }]],
    ] as const) {
      const result = planWith(label, { workAuthorizations: records });
      expect(result.entries, label).toHaveLength(0);
      expect(result.skipped[0], label).toMatchObject({ reason: 'JOB_DEPENDENT' });
      expect(result.skipped[0]?.regionWithoutRecord, label).toBeUndefined();
    }
  });

  it('Delaware 不按德国、Indiana 不按印度；Germany、India 照旧按各自那条', () => {
    const records = [
      ...US_ONLY,
      { regionCode: 'DE', authorizedToWork: 'NO', requiresSponsorship: 'YES' },
      { regionCode: 'IN', authorizedToWork: 'NO', requiresSponsorship: 'YES' },
    ];
    expect(planWith('Are you legally authorized to work in Delaware?', { workAuthorizations: records }).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'Yes' });
    expect(planWith('Are you legally authorized to work in Indiana?', { workAuthorizations: records }).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'Yes' });
    expect(planWith('Are you legally authorized to work in Germany?', { workAuthorizations: records }).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'No' });
    expect(planWith('Are you legally authorized to work in India?', { workAuthorizations: records }).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'No' });
  });

  it('Georgia：州还是国家说不清 → 交还用户，谁的记录都不按，也不按默认', () => {
    for (const records of [
      [...US_ONLY, { regionCode: 'GE', authorizedToWork: 'NO', requiresSponsorship: 'YES' }],
      [{ regionCode: 'GE', authorizedToWork: 'NO', requiresSponsorship: 'YES' }],
      US_ONLY,
    ]) {
      const result = planWith('Are you legally authorized to work in Georgia?', { workAuthorizations: records });
      expect(result.entries, JSON.stringify(records)).toHaveLength(0);
      expect(result.skipped[0], JSON.stringify(records)).toMatchObject({ reason: 'JOB_DEPENDENT' });
    }
  });
});

/**
 * 岗位地点里的两字母码（2026-09-24）：推错了国家，就是拿错一条记录答题。内容脚本就是这样接的——`inferRegionCode(岗位地点)`
 * 解出的国家当 `jobRegionCode` 交给内核（apply.content.ts）。从前「Toronto, CA」解成加州 → 美国，他在加拿大无权工作，这道题
 * 却按美国那条答了「是」；「Berlin, DE」解成 Delaware → 美国，本该写明「你的资料里没有德国的记录」按默认答，却按美国那条答了；
 * 「Remote - IN」说不清是印度还是 Indiana，也按美国答了。
 */
describe('岗位地点里的两字母码：推错国家就是拿错记录答（2026-09-24）', () => {
  const LABEL = 'Are you authorized to work in the country for which you applied?';
  const jobRegion = (location: string) => {
    const code = inferRegionCode(location);
    return code === null ? {} : { jobRegionCode: code };
  };

  it('Toronto, CA 是加拿大：按加拿大那条答 No，不按加州（美国那条）答 Yes', () => {
    expect(planWith(LABEL, jobRegion('Toronto, CA')).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'No', inferredRegionCode: 'CA' });
  });

  it('Berlin, DE 是德国：他没有德国的记录 → 按默认答并带上德国，不按美国（Delaware）那条', () => {
    expect(planWith(LABEL, jobRegion('Berlin, DE')).entries[0])
      .toMatchObject({ key: 'workAuthorization', value: 'Yes', inferredRegionCode: 'DE', defaultedRegionCode: 'DE' });
  });

  it('Remote - IN 说不清是印度还是 Indiana：不推，交还用户', () => {
    const plan = planWith(LABEL, jobRegion('Remote - IN'));
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });
});

/**
 * 「不需要担保就有权工作吗」：答案由两项记录一起决定——有权工作、且不需要担保才是 Yes。
 * 从前它被当成担保题、按「需要担保 = No」答了 No，等于替一个有权工作的人说「我没有权利」。
 */
describe('不需要担保就有权工作吗', () => {
  const LABEL_US = 'Are you legally authorized to work in the United States without requiring employer sponsorship?';

  it('有权工作、不需要担保 → Yes', () => {
    expect(written(LABEL_US)).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
  });

  it('无权工作 → No', () => {
    expect(written('Are you eligible to work in Canada without sponsorship?'))
      .toMatchObject({ key: 'workAuthorization', value: 'No' });
  });

  it('有权工作、但需要担保 → No（离开担保就不能工作）', () => {
    expect(written(LABEL_US, {
      authorizations: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'YES' }],
    })).toMatchObject({ key: 'workAuthorization', value: 'No' });
  });

  it('担保那一项没填 → 说不清，不答', () => {
    expect(skip(LABEL_US, {
      authorizations: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'UNSPECIFIED' }],
    })).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });
});
