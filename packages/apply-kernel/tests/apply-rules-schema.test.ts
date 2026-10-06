import { describe, expect, it } from 'vitest';

import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import leverRules from '@edaix/apply-rules/lever.json';
import ashbyRules from '@edaix/apply-rules/ashby.json';
import workableRules from '@edaix/apply-rules/workable.json';
import icimsRules from '@edaix/apply-rules/icims.json';
import workdayRules from '@edaix/apply-rules/workday.json';

import { parseVendorRuleset } from '../src/rules/schema';
import { compileBundledAdapter, compileRuleAdapter } from '../src/rules/interpreter';
import { createScanRoot } from '../src/scanRoot';

/**
 * apply-rules 是要走网络的数据（后端下发热更新，docs/20-技术架构.md §3），
 * 校验器按不可信输入对待：整份拒收 + 稳定原因码。这套测试锁两件事——
 * 随包内置的四份 JSON 永远过校验（数据↔schema 不许漂移），以及每一类
 * 畸形输入都折叠到正确的稳定码而不是半吞半用。
 */

const BUNDLED = [
  ['greenhouse', greenhouseRules],
  ['lever', leverRules],
  ['ashby', ashbyRules],
  ['workable', workableRules],
  ['workday', workdayRules],
] as const;

/** 变异基底。structuredClone 保证测试之间互不污染。 */
function base(): Record<string, unknown> {
  return structuredClone(workableRules) as Record<string, unknown>;
}

describe('parseVendorRuleset · 随包内置数据', () => {
  it.each(BUNDLED)('%s.json 过校验，vendor 与文件名一致', (vendor, rules) => {
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok, `${vendor}.json 被自己的校验器拒收`).toBe(true);
    if (parsed.ok) expect(parsed.value.vendor).toBe(vendor);
  });

  it.each(BUNDLED)('%s.json 能编译出完整的 VendorAdapter', (_vendor, rules) => {
    const adapter = compileBundledAdapter(rules);
    expect(typeof adapter.isApplyPath).toBe('function');
    expect(typeof adapter.resolveRoot).toBe('function');
    expect(typeof adapter.scan).toBe('function');
    expect(typeof adapter.resolveFinalSubmitControl).toBe('function');
  });
});

describe('parseVendorRuleset · rowScopes（行标识 + 行内序号的数据面）', () => {
  it('greenhouse 内置数据带教育行作用域；缺省厂商归一化为空数组', () => {
    const greenhouse = parseVendorRuleset(greenhouseRules);
    expect(greenhouse.ok && greenhouse.value.rowScopes).toEqual([
      {
        kind: 'contains',
        container: 'div.education--container',
        row: 'div.education--form',
        collection: 'education',
        // 教育行内一个 name 都没有，只有 `school--0` 这种「单元名 + 行号」的 id。
        cellIdPattern: /^(.+)--\d+$/,
        fieldMap: {
          school: 'school', degree: 'degreeLevel', discipline: 'fieldOfStudy',
          // 2026-09-17 在 launchdarkly/jobs/7993283003 实测补的四栏；此前那份
          // posting 整段没有日期栏，规则注释里写着「量到再补」。
          'start-month': 'startMonth', 'start-year': 'startYear',
          'end-month': 'endMonth', 'end-year': 'endYear',
        },
        // Greenhouse 加完行直接能填，没有分段保存那一步——所以 actions 里只有 add。
        actions: { add: 'button.add-another-button' },
      },
    ]);
    // lever.json 根本没写 rowScopes 键——缺省必须是空数组而不是 undefined，
    // 解释器才能无条件把它交给 createScanRoot。
    const lever = parseVendorRuleset(leverRules);
    expect(lever.ok && lever.value.rowScopes).toEqual([]);
  });

  it('kind 必填，不给默认值', () => {
    // 两种行模型的失败形态完全不同：contains 写错只是少认几行，
    // idPrefix 写错会把整个容器的控件当成同一行。让作者写一次，
    // 比让引擎猜一次便宜得多。
    const rules = base();
    rules['rowScopes'] = [{ container: 'div.rows', row: 'div.row' }];
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('idPrefix：行序编在 id 里的厂商（iCIMS 形态）', () => {
    const rules = base();
    rules['rowScopes'] = [
      {
        kind: 'idPrefix',
        container: 'form#profileForm',
        idPattern: { source: '^(-?\\d+)_PersonProfileFields\\.' },
      },
    ];
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok).toBe(true);
    const scope = parsed.ok ? parsed.value.rowScopes[0] : null;
    expect(scope?.kind).toBe('idPrefix');
    // 规则数据里是可序列化的 {source}，解释器拿到的必须已经是编译好的 RegExp——
    // 每次扫描都重新编译一遍正则是纯浪费。
    expect(scope && scope.kind === 'idPrefix' && scope.idPattern).toBeInstanceOf(RegExp);
    expect(
      scope && scope.kind === 'idPrefix' && scope.idPattern.exec('-1_PersonProfileFields.Phone')?.[1],
    ).toBe('-1');
  });

  it('idPrefix 的 idPattern 必须正好一个捕获组——那一组就是行标识', () => {
    // 零个捕获组：取不出行标识，整行归属无从判断。
    // 两个捕获组：作者以为的行标识和引擎取的第一组可能不是同一个东西，
    // 后果是把两行当成一行（或反过来），而这在扫描期是静默的。
    for (const bad of ['^-?\\d+_Person', '^(-?\\d+)_(Person)']) {
      const rules = base();
      rules['rowScopes'] = [{ kind: 'idPrefix', container: 'form', idPattern: { source: bad } }];
      expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });

  it('畸形行作用域整份拒收：缺 row / 空串 / 白名单外的键 / 跨 kind 混写字段', () => {
    for (const bad of [
      [{ kind: 'contains', container: 'div.rows' }],
      [{ kind: 'contains', container: 'div.rows', row: '' }],
      [{ kind: 'contains', container: 'div.rows', row: 'div.row', submitAfter: true }],
      // contains 不认 idPattern，idPrefix 不认 row：两边的字段白名单互不相通，
      // 否则一份写错 kind 的规则会被静默当成另一种模型解释。
      [{ kind: 'contains', container: 'div.rows', row: 'div.row', idPattern: { source: '(a)' } }],
      [{ kind: 'idPrefix', container: 'form', idPattern: { source: '(a)' }, row: 'li' }],
      [{ kind: 'idPrefix', container: 'form' }],
      [{ kind: 'rowIndex', container: 'form', row: 'li' }],
      // 行动作按钮只对参与增删行编排的行有意义。给一个没有 collection 的行
      // 配动作按钮，说明作者把「行身份」和「增删行编排」当成了一件事。
      [{ kind: 'contains', container: 'div.rows', row: 'li', actions: { add: 'button.x' } }],
      // 空选择器：匹配不到任何东西，而调用方看到的是「声明过 add」，
      // 于是会去等一个永远不来的新行。
      [{ kind: 'contains', container: 'div.rows', row: 'li', collection: 'education', actions: { add: '' } }],
      [{ kind: 'contains', container: 'div.rows', row: 'li', collection: 'phones' }],
      [{ kind: 'contains', container: 'div.rows', row: 'li', collection: 'education', actions: { submit: 'button.x' } }],
      // cellIdPattern 没有 fieldMap 就是死数据：没有查表的对象。
      [{ kind: 'contains', container: 'div.rows', row: 'li', collection: 'education', cellIdPattern: { source: '^(.+)--\\d+$' } }],
      // 捕获组不是恰好一个：零个取不出单元名，两个说明作者对「哪一段是单元名」没想清楚。
      [{ kind: 'contains', container: 'div.rows', row: 'li', collection: 'education',
         fieldMap: { school: 'school' }, cellIdPattern: { source: '^.+--\\d+$' } }],
      [{ kind: 'contains', container: 'div.rows', row: 'li', collection: 'education',
         fieldMap: { school: 'school' }, cellIdPattern: { source: '^(.+)--(\\d+)$' } }],
      'div.rows',
    ]) {
      const rules = base();
      rules['rowScopes'] = bad;
      expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });
});

describe('parseVendorRuleset · fail-closed', () => {
  it('比解释器新的 schemaVersion 拒收：RULES_SCHEMA_TOO_NEW', () => {
    const rules = base();
    rules['schemaVersion'] = 4;
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_SCHEMA_TOO_NEW' });
  });

  it('缺必需字段拒收：RULES_MALFORMED', () => {
    const rules = base();
    delete rules['anchors'];
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('空 anchors 拒收——没有厂商锚点的规则等于全页扫描，绝不放行', () => {
    const rules = base();
    rules['anchors'] = [];
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('目录外的 vendor 拒收：RULES_VENDOR_UNKNOWN', () => {
    const rules = base();
    // 曾经用 'workday' 当反例；2026-08-21 Workday 进了目录（PENDING-B1 放行），
    // 拿一个真实厂商当"目录外"的例子会随目录扩张而失效——换成永远不会是厂商的串。
    rules['vendor'] = 'not-a-vendor';
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_VENDOR_UNKNOWN' });
  });

  it('编译不过的正则拒收：RULES_REGEX_INVALID', () => {
    const rules = base();
    rules['applyPath'] = { source: '([unclosed' };
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_REGEX_INVALID' });
  });

  it('g flag 拒收——lastIndex 让同一条规则第二次 test 得到不同答案', () => {
    const rules = base();
    rules['applyPath'] = { source: 'apply', flags: 'g' };
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_REGEX_INVALID' });
  });

  /**
   * 规则由后端热更新下发，而键表随插件版本走。后端加一个新键 + 它的标签模式，
   * 旧版内核不能因此整包拒收（2026-09-16 argoland #469 那次：纯加法把插件打死）。
   * 运行时默认只让那一条失效；发布侧用严格模式，随包规则里拼错的键当场红。
   */
  it('运行时默认：指向未知键的那一条跳过，其余照常，键名逐个回报', () => {
    const rules = base();
    (rules['keySteps'] as Array<Record<string, unknown>>)[0]!['map'] = {
      firstname: 'ssn',
      email: 'email',
    };
    const skipped: string[] = [];
    const parsed = parseVendorRuleset(rules, { onUnknownFieldKey: (key) => skipped.push(key) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const step = parsed.value.keySteps[0];
    expect(step?.type === 'attrMap' ? step.map : null).toEqual({ email: 'email' });
    expect(skipped).toEqual(['ssn']);
  });

  it('运行时默认：labelPatterns 里指向未知键的模式跳过，正则仍先过形状校验', () => {
    const rules = base();
    (rules['keySteps'] as Array<Record<string, unknown>>).push({
      type: 'labelPatterns',
      confidence: 0.75,
      patterns: [
        { regex: { source: 'pronouns', flags: 'i' }, key: 'pronouns' },
        { regex: { source: 'first name', flags: 'i' }, key: 'firstName' },
      ],
    });
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const step = parsed.value.keySteps.at(-1);
    expect(step?.type === 'labelPatterns' ? step.patterns.map((p) => p.key) : null).toEqual(['firstName']);

    const badRegex = base();
    (badRegex['keySteps'] as Array<Record<string, unknown>>).push({
      type: 'labelPatterns',
      confidence: 0.75,
      patterns: [{ regex: { source: 'pronouns', flags: 'g' }, key: 'pronouns' }],
    });
    expect(parseVendorRuleset(badRegex)).toEqual({ ok: false, code: 'RULES_REGEX_INVALID' });
  });

  it('严格模式（发布侧）：映射到契约之外的键整份拒收：RULES_FIELD_KEY_UNKNOWN', () => {
    const rules = base();
    (rules['keySteps'] as Array<Record<string, unknown>>)[0]!['map'] = {
      firstname: 'ssn',
    };
    expect(parseVendorRuleset(rules, { unknownFieldKeys: 'reject' })).toEqual({ ok: false, code: 'RULES_FIELD_KEY_UNKNOWN' });
  });

  /**
   * 行内映射（`rowScopes[].fieldMap`）指向这一版不认识的行内角色（2026-09-28）。
   *
   * 在此之前它**无论运行时还是发布侧**都整份 `RULES_FIELD_KEY_UNKNOWN`，与 keySteps 里的陌生键
   * （只跳过那一条）口径不一：后端给经历段加一个新角色，旧包连同所有厂商一起停。现在同一个口径：
   * 运行时只让那一格不认（它退回全局 keySteps，与没写这一格时一样），发布侧照旧红。
   * 掩码格（`maskedCells`）按**声明过的**格名校验——那一格认不出角色，也照旧不许往里写。
   */
  it('运行时默认：行内映射指向未知角色的那一格跳过；掩码声明照旧有效；发布侧整份拒收', () => {
    const rules = base();
    rules['rowScopes'] = [{
      kind: 'contains', container: 'div.rows', row: 'li', collection: 'education', writeMode: 'typed',
      fieldMap: { school: 'school', honors: 'honorsReceived' }, maskedCells: ['honors'],
    }];
    const skipped: string[] = [];
    const parsed = parseVendorRuleset(rules, { onUnknownFieldKey: (key) => skipped.push(key) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rowScopes[0]).toMatchObject({ fieldMap: { school: 'school' }, maskedCells: ['honors'] });
      expect(parsed.value.rowScopes[0]?.fieldMap).not.toHaveProperty('honors');
    }
    expect(skipped).toEqual(['education.honorsReceived']);

    expect(parseVendorRuleset(rules, { unknownFieldKeys: 'reject' })).toEqual({
      ok: false,
      code: 'RULES_FIELD_KEY_UNKNOWN',
    });
    // 角色名位上不成形（空串、带空格、非字符串），不是「将来的角色」，照旧整份拒收。
    for (const bad of ['', 'has space', 7]) {
      const malformed = base();
      malformed['rowScopes'] = [{
        kind: 'contains', container: 'div.rows', row: 'li', collection: 'education', fieldMap: { school: bad },
      }];
      expect(parseVendorRuleset(malformed), JSON.stringify(bad)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });

  it('跳过的只能是长得像键名的东西：键位上不是字符串或不成形，仍整份 RULES_MALFORMED', () => {
    for (const bad of [7, '', 'has space', '../x']) {
      const rules = base();
      (rules['keySteps'] as Array<Record<string, unknown>>)[0]!['map'] = { firstname: bad };
      expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });

  it('plain-text contenteditable authority 只允许一个 exact attrMap target', () => {
    const accepted = base();
    (accepted['keySteps'] as unknown[]).unshift({
      type: 'attrMap', attr: 'id', confidence: 1,
      map: { cover_letter: 'coverLetterPlainTextContenteditable' },
    });
    expect(parseVendorRuleset(accepted).ok).toBe(true);

    for (const step of [
      { type: 'attrMap', attr: 'autocomplete', confidence: 1,
        map: { off: 'coverLetterPlainTextContenteditable' } },
      { type: 'attrMap', attr: 'id', confidence: 0.75,
        map: { cover_letter: 'coverLetterPlainTextContenteditable' } },
      { type: 'attrMap', attr: 'id', confidence: 1,
        map: { '': 'coverLetterPlainTextContenteditable' } },
      { type: 'ancestorAttrMap', attr: 'data-testid', confidence: 1,
        map: { cover_letter: 'coverLetterPlainTextContenteditable' } },
      { type: 'labelPatterns', confidence: 1,
        patterns: [{ regex: { source: 'cover letter', flags: 'i' }, key: 'coverLetterPlainTextContenteditable' }] },
    ]) {
      const rejected = base();
      (rejected['keySteps'] as unknown[]).unshift(step);
      expect(parseVendorRuleset(rejected).ok).toBe(false);
    }

    const duplicate = structuredClone(accepted);
    (duplicate['keySteps'] as unknown[]).unshift({
      type: 'attrMap', attr: 'name', confidence: 1,
      map: { cover_letter_body: 'coverLetterPlainTextContenteditable' },
    });
    expect(parseVendorRuleset(duplicate)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('认不得的 step 类型整份拒收——跳过它会让新旧解释器产生两种填法', () => {
    const rules = base();
    (rules['keySteps'] as unknown[]).push({ type: 'xpathMap', map: {} });
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('白名单外的顶层键：发布侧拒收，运行时不解释也不保留；$comment 打头的随行注释放行', () => {
    const annotated = base();
    annotated['$comment.extra'] = '注释不算数据';
    expect(parseVendorRuleset(annotated).ok).toBe(true);

    const smuggled = base();
    smuggled['submitSelector'] = 'button[type=submit]';
    // 发布侧（本仓是规则的作者）：拼错或夹带的顶层键当场红。
    expect(parseVendorRuleset(smuggled, { unknownTopLevelKeys: 'reject' })).toEqual({
      ok: false,
      code: 'RULES_MALFORMED',
    });
    // 运行时（2026-09-28）：后端新版规则多出来的顶层键不拖垮这一份。它**不进解析结果**，
    // 解释器根本读不到——夹带的选择器没有任何一条路能被用上。
    const ignored: string[] = [];
    const parsed = parseVendorRuleset(smuggled, { onUnknownTopLevelKey: (key) => ignored.push(key) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual((parseVendorRuleset(base()) as { value: unknown }).value);
      expect(JSON.stringify(parsed.value)).not.toContain('submitSelector');
    }
    expect(ignored).toEqual(['submitSelector']);

    // 能被当成「将来的键」忽略的，只有长得像 schema 键的名字（小驼峰）；别的是坏数据，不是新版本。
    for (const junk of ['has space', 'Upper', '_private', 'constructor', 'prototype', '']) {
      const rules = base();
      rules[junk] = true;
      expect(parseVendorRuleset(rules), JSON.stringify(junk)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }

    // v2 规则里的 `wizard` 是 v3 才认的键：v2 读者本来就不解释它，按陌生顶层键处理。
    const wizardInV2 = base();
    wizardInV2['wizard'] = null;
    expect(parseVendorRuleset(wizardInV2).ok).toBe(true);
    expect(parseVendorRuleset(wizardInV2, { unknownTopLevelKeys: 'reject' }).ok).toBe(false);

    for (const bad of [
      undefined,
      '',
      { selector: '', activation: 'native-submit' },
      { selector: 'button', activation: 'click' },
      { selector: 'button', activation: 'native-submit', fallbackText: 'Submit' },
    ]) {
      const rules = base();
      if (bad === undefined) delete rules['finalSubmitControl'];
      else rules['finalSubmitControl'] = bad;
      expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });

  it('attrMap 的键必须已小写——解释器查表前小写化属性值，混排键永远查不中', () => {
    const rules = base();
    (rules['keySteps'] as Array<Record<string, unknown>>)[0]!['map'] = {
      FirstName: 'firstName',
    };
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('非对象输入拒收，绝不抛异常', () => {
    for (const input of [null, undefined, 42, 'rules', [], true]) {
      expect(parseVendorRuleset(input)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });
});

describe('strict v2/v3 wizard rule compatibility', () => {
  const wizard = {
    schemaVersion: 1, wizardKey: 'test-wizard', applicationRootSelector: '#application',
    indicatorContainerSelector: '#steps', steps: [
      { stepKey: 'one', indicatorSelector: '#step-one' },
      { stepKey: 'two', indicatorSelector: '#step-two' },
    ],
  };
  it('retains the v2 normalized shape; wizard data on v2 is rejected at publish and never interpreted at runtime', () => {
    const old = parseVendorRuleset(base());
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.value).not.toHaveProperty('wizard');
    expect(parseVendorRuleset({ ...base(), wizard }, { unknownTopLevelKeys: 'reject' }))
      .toEqual({ ok: false, code: 'RULES_MALFORMED' });
    // 运行时（2026-09-28）：v2 读者不解释 wizard，它按陌生顶层键被忽略，结果里没有它。
    const runtime = parseVendorRuleset({ ...base(), wizard });
    expect(runtime.ok).toBe(true);
    if (runtime.ok) expect(runtime.value).not.toHaveProperty('wizard');
  });
  it('accepts an explicit v3 declaration or null and retains that schema version', () => {
    const withWizard = parseVendorRuleset({ ...base(), schemaVersion: 3, wizard });
    expect(withWizard).toMatchObject({ ok: true, value: { schemaVersion: 3, wizard } });
    if (withWizard.ok && withWizard.value.schemaVersion === 3) {
      expect(Object.isFrozen(withWizard.value.wizard)).toBe(true);
    }
    expect(parseVendorRuleset({ ...base(), schemaVersion: 3, wizard: null }))
      .toMatchObject({ ok: true, value: { schemaVersion: 3, wizard: null } });
  });
  it('rejects missing wizard disposition, unknown keys inside the declaration and malformed v3 declarations', () => {
    for (const candidate of [
      { ...base(), schemaVersion: 3 },
      { ...base(), schemaVersion: 3, wizard: { ...wizard, clickNext: true } },
      { ...base(), schemaVersion: 3, wizard: { ...wizard, steps: [wizard.steps[0], wizard.steps[0]] } },
    ]) expect(parseVendorRuleset(candidate)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });
  it('an unknown top-level key next to a v3 declaration: rejected at publish, never interpreted at runtime', () => {
    const candidate = { ...base(), schemaVersion: 3, wizard, execute: 'forbidden' };
    expect(parseVendorRuleset(candidate, { unknownTopLevelKeys: 'reject' }))
      .toEqual({ ok: false, code: 'RULES_MALFORMED' });
    const runtime = parseVendorRuleset(candidate);
    expect(runtime).toMatchObject({ ok: true, value: { schemaVersion: 3, wizard } });
    if (runtime.ok) expect(runtime.value).not.toHaveProperty('execute');
  });
});

describe('compileBundledAdapter', () => {
  it('内置数据坏了在 import 时就爆炸，错误信息只带稳定码', () => {
    expect(() => compileBundledAdapter({ schemaVersion: 4 })).toThrowError(
      /RULES_SCHEMA_TOO_NEW/,
    );
  });
});

describe('finalSubmitControl · selector-free live authority', () => {
  function workableTarget(markup: string) {
    document.body.innerHTML = markup;
    const parsed = parseVendorRuleset(workableRules);
    if (!parsed.ok) throw new Error(parsed.code);
    const adapter = compileRuleAdapter(parsed.value);
    const root = adapter.resolveRoot(document);
    if (!root) return null;
    const fields = adapter.scan(root);
    return adapter.resolveFinalSubmitControl(root, fields);
  }

  it('requires one connected enabled native control associated with the exact scanned form', () => {
    const target = workableTarget(`
      <form data-ui="application-form">
        <input name="firstname" />
        <button data-ui="apply-button" type="submit">Submit application</button>
      </form>`);

    expect(target?.activation).toBe('native-submit');
    expect(target?.element.getAttribute('data-ui')).toBe('apply-button');
    expect(target?.form).toBe(document.querySelector('form'));
    expect(target?.isCurrent()).toBe(true);
  });

  it('fails closed for zero/multiple/non-native matches and detects live identity or attribute drift', () => {
    expect(workableTarget(`
      <form data-ui="application-form"><input name="firstname" /></form>
    `)).toBeNull();
    expect(workableTarget(`
      <form data-ui="application-form">
        <input name="firstname" />
        <button data-ui="apply-button" type="button">Not final</button>
      </form>
    `)).toBeNull();
    expect(workableTarget(`
      <form data-ui="application-form">
        <input name="firstname" />
        <button data-ui="apply-button" type="submit">A</button>
        <button data-ui="apply-button" type="submit">B</button>
      </form>
    `)).toBeNull();

    const target = workableTarget(`
      <form data-ui="application-form">
        <input name="firstname" />
        <button data-ui="apply-button" type="submit">Submit application</button>
      </form>
    `);
    expect(target).not.toBeNull();
    target!.element.setAttribute('formaction', '/changed');
    expect(target!.isCurrent()).toBe(false);
  });
});

describe('rowScopes · 同一集合只许一条', () => {
  it('两条 rowScope 指向同一个 collection ⇒ 整份拒收', () => {
    const rules = base();
    rules['rowScopes'] = [
      {
        kind: 'contains',
        container: 'div.edu-a',
        row: 'div.row',
        collection: 'education',
        actions: { add: 'button.add-a' },
      },
      {
        kind: 'contains',
        container: 'div.edu-b',
        row: 'div.row',
        collection: 'education',
        actions: { add: 'button.add-b' },
      },
    ];
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('不同 collection 各一条照旧放行', () => {
    const rules = base();
    rules['rowScopes'] = [
      {
        kind: 'contains',
        container: 'div.edu',
        row: 'div.row',
        collection: 'education',
        actions: { add: 'button.add-edu' },
      },
      {
        kind: 'contains',
        container: 'div.exp',
        row: 'div.row',
        collection: 'experience',
        actions: { add: 'button.add-exp' },
      },
    ];
    expect(parseVendorRuleset(rules).ok).toBe(true);
  });

  it('没有 collection 的行作用域不受这条限制', () => {
    const rules = base();
    rules['rowScopes'] = [
      { kind: 'contains', container: 'div.a', row: 'div.row' },
      { kind: 'contains', container: 'div.b', row: 'div.row' },
    ];
    expect(parseVendorRuleset(rules).ok).toBe(true);
  });

  it('现有内置数据全部满足唯一 collection 约束', () => {
    for (const [vendor, data] of BUNDLED) {
      const parsed = parseVendorRuleset(data);
      expect(parsed.ok, `${vendor}.json 被 duplicate-rowScope 闸误伤`).toBe(true);
    }
  });
});

describe('attrMap 的属性白名单', () => {
  it('data-testid 与 data-automation-id 放行，白名单之外仍 fail closed', () => {
    const accepted = base();
    accepted['keySteps'] = [
      { type: 'attrMap', attr: 'data-testid', confidence: 1, map: { 'input-email': 'email' } },
    ];
    expect(parseVendorRuleset(accepted).ok).toBe(true);

    const workday = base();
    workday['keySteps'] = [
      {
        type: 'ancestorAttrMap',
        attr: 'data-automation-id',
        confidence: 1,
        map: { 'formfield-email': 'email' },
      },
    ];
    expect(parseVendorRuleset(workday).ok).toBe(true);

    for (const attr of ['data-ui', 'class', 'placeholder']) {
      const rejected = base();
      rejected['keySteps'] = [{ type: 'attrMap', attr, confidence: 1, map: { x: 'email' } }];
      expect(parseVendorRuleset(rejected), attr).toEqual({
        ok: false,
        code: 'RULES_MALFORMED',
      });
    }
  });

  it('解释器真的按 data-testid 认字段', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input data-testid="input-email" id="field-21" name="random-field" type="text" />
      </form>`;
    const rules = base();
    rules['anchors'] = ['#application-form'];
    rules['keySteps'] = [
      { type: 'attrMap', attr: 'data-testid', confidence: 1, map: { 'input-email': 'email' } },
    ];
    const parsed = parseVendorRuleset(rules);
    if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.code}`);
    const adapter = compileRuleAdapter(parsed.value);
    const root = createScanRoot(document.querySelector('#application-form')!, [], []);
    expect([...adapter.scan(root)][0]?.key).toBe('email');
  });
});

/** Regexes and prefixes compared against lowercased names must be comparable. */
describe('比对小写值的模式不许带未转义大写字母', () => {
  it('labelFallbackGate 大写且无 i 标志时整份拒收', () => {
    const rules = base();
    rules['keySteps'] = [{
      type: 'labelFallbackGate',
      nameRegex: { source: '^(?!(Person|Portal)ProfileFields\\.).+$' },
      allowEmptyName: true,
    }];
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('显式 i 标志或全小写时放行', () => {
    for (const nameRegex of [
      { source: '^(?!(Person|Portal)ProfileFields\\.).+$', flags: 'i' },
      { source: '^(?!(person|portal)profilefields\\.).+$' },
    ]) {
      const rules = base();
      rules['keySteps'] = [{ type: 'labelFallbackGate', nameRegex, allowEmptyName: true }];
      expect(parseVendorRuleset(rules).ok).toBe(true);
    }
  });

  it('\\D/\\W/\\S/\\B 是正则语法而非大写字面量', () => {
    const rules = base();
    rules['keySteps'] = [{
      type: 'labelFallbackGate',
      nameRegex: { source: '^\\D+\\w*\\S\\B$' },
      allowEmptyName: false,
    }];
    expect(parseVendorRuleset(rules).ok).toBe(true);
  });

  it('stopNamePrefix 同样拒绝永远匹配不到的大写前缀', () => {
    const rules = base();
    rules['keySteps'] = [{ type: 'stopNamePrefix', prefixes: ['URLs['] }];
    expect(parseVendorRuleset(rules)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
  });
});

describe('iCIMS：带命名空间的字段不落标签兜底', () => {
  it('只接受候选人 application path，拒绝同 host 的嵌套后台路径', () => {
    const adapter = compileBundledAdapter(icimsRules);
    expect(adapter.isApplyPath('/jobs/123/product-designer/candidate')).toBe(true);
    expect(adapter.isApplyPath('/jobs/123/product-designer/candidate/')).toBe(true);
    expect(adapter.isApplyPath('/employer/jobs/123/product-designer/candidate')).toBe(false);
    expect(adapter.isApplyPath('/admin/jobs/123/product-designer/candidate')).toBe(false);
  });

  it('行前缀后的 ProfileFields 被拦，自定义题仍可用标签', () => {
    document.body.innerHTML = `
      <form id="profileForm">
        <label for="-1_PersonProfileFields.AddressCity">City</label>
        <input id="-1_PersonProfileFields.AddressCity" name="-1_PersonProfileFields.AddressCity" type="text" />
        <label for="q_custom_1">City you are applying from</label>
        <input id="q_custom_1" name="q_custom_1" type="text" />
      </form>`;
    const parsed = parseVendorRuleset(icimsRules);
    if (!parsed.ok) throw new Error(`icims.json rejected: ${parsed.code}`);
    const adapter = compileBundledAdapter(icimsRules);
    const root = createScanRoot(
      document.querySelector('#profileForm')!,
      parsed.value.excludeWithin,
      parsed.value.rowScopes,
    );
    const fields = [...adapter.scan(root)];

    expect(
      fields.find((field) =>
        field.element.getAttribute('name') === '-1_PersonProfileFields.AddressCity')?.key,
    ).toBeNull();
    expect(
      fields.find((field) => field.element.getAttribute('name') === 'q_custom_1')?.key,
    ).toBe('city');
  });
});

describe('parseVendorRuleset · embeddedApplyPath（官方嵌入帧承载同一张表的路径，可缺省）', () => {
  it('greenhouse 内置数据声明了嵌入路径；没写的厂商归一化为 null', () => {
    const greenhouse = parseVendorRuleset(greenhouseRules);
    expect(greenhouse.ok && greenhouse.value.embeddedApplyPath).toEqual({ source: '^\\/embed\\/job_app\\/?$' });
    const lever = parseVendorRuleset(leverRules);
    expect(lever.ok && lever.value.embeddedApplyPath).toBeNull();
  });

  it('写了就按正则全量校验：不是对象整份拒收，flags 只放行 i，写 null 等于没写', () => {
    const malformed = base();
    malformed['embeddedApplyPath'] = '^/embed/';
    expect(parseVendorRuleset(malformed)).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    const flags = base();
    flags['embeddedApplyPath'] = { source: '^/embed/', flags: 'g' };
    expect(parseVendorRuleset(flags)).toMatchObject({ ok: false, code: 'RULES_REGEX_INVALID' });
    const nulled = base();
    nulled['embeddedApplyPath'] = null;
    const parsed = parseVendorRuleset(nulled);
    expect(parsed.ok && parsed.value.embeddedApplyPath).toBeNull();
  });

  it('编译出的适配器只对自称在子帧里的调用方放行嵌入路径，顶层帧照旧拒绝', () => {
    const rules = base();
    rules['embeddedApplyPath'] = { source: '^\\/embed\\/only$' };
    const adapter = compileBundledAdapter(rules);
    expect(adapter.isApplyPath('/embed/only')).toBe(false);
    expect(adapter.isApplyPath('/embed/only', { embedded: false })).toBe(false);
    expect(adapter.isApplyPath('/embed/only', { embedded: true })).toBe(true);
    expect(adapter.isApplyPath('/embed/other', { embedded: true })).toBe(false);
  });
});

describe('parseVendorRuleset · whitelabelRoot（白标 B 的退路，可缺省）', () => {
  it('greenhouse 内置数据声明了 form + 3 个钩子；没写的厂商归一化为 null', () => {
    const greenhouse = parseVendorRuleset(greenhouseRules);
    expect(greenhouse.ok && greenhouse.value.whitelabelRoot).toEqual({ container: 'form', minHooks: 3 });
    const lever = parseVendorRuleset(leverRules);
    expect(lever.ok && lever.value.whitelabelRoot).toBeNull();
  });

  it('容器必填、minHooks 是 2..8 的整数、不认多余的键', () => {
    for (const bad of [
      'form',
      { container: '', minHooks: 3 },
      { container: 'form' },
      { container: 'form', minHooks: 1 },
      { container: 'form', minHooks: 9 },
      { container: 'form', minHooks: 2.5 },
      { container: 'form', minHooks: 3, hooks: ['#email'] },
    ]) {
      const rules = base();
      rules['whitelabelRoot'] = bad;
      expect(parseVendorRuleset(rules), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    }
    const nulled = base();
    nulled['whitelabelRoot'] = null;
    const parsed = parseVendorRuleset(nulled);
    expect(parsed.ok && parsed.value.whitelabelRoot).toBeNull();
  });
});
