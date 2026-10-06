import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EXECUTION_RUNTIME_BUNDLE_ERROR_CODES,
  classifyExecutionRuntimeBundleTimeV1,
  compareExecutionRuntimeSemverV1,
  describeExecutionRuntimeBundleNoticesV1,
  APPLICATION_PROFILE_FIELD_KEYS,
  isCanonicalExecutionRuntimeSemverV1,
  parseExecutionRuntimeBundleEtagV1,
  parseExecutionRuntimeBundleJsonV1,
  parseExecutionRuntimeBundleV1,
  parseIsoDateTime,
  parseSha256Digest,
  type ExecutionRuntimeBundleV1,
  type ExecutionRuntimeBundleWithoutVersionV1,
  type Sha256Digest,
} from '../src/index.ts';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, Json>)[key]!)}`)
    .join(',')}}`;
}

function digest(value: Json): Sha256Digest {
  return parseSha256Digest(
    `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`,
  )!;
}

function runtimeVersion(value: ExecutionRuntimeBundleWithoutVersionV1): `rb1_${string}` {
  return `rb1_${digest(value as unknown as Json).slice('sha256:'.length)}`;
}

function makeBundle(
  overrides: Readonly<Record<string, unknown>> = {},
): ExecutionRuntimeBundleV1 {
  const definitions = [
    ['ASHBY', 'ashby', 'ashby-application-v1'],
    ['BAMBOOHR', 'bamboohr', 'bamboohr-application-v1'],
    ['GREENHOUSE', 'greenhouse', 'greenhouse-application-v1'],
    ['ICIMS', 'icims', 'icims-application-v1'],
    ['LEVER', 'lever', 'lever-application-v1'],
    ['SMARTRECRUITERS', 'smartrecruiters', 'smartrecruiters-application-v1'],
    ['WORKABLE', 'workable', 'workable-application-v1'],
    ['WORKDAY', 'workday', 'workday-application-v1'],
  ] as const;
  const entries = definitions.map(([atsProvider, vendor, pathRuleId]) => {
    const ruleset = {
      schemaVersion: 2,
      vendor,
      applyPath: { source: '\\/apply$' },
      anchors: ['form#application-form'],
      finalSubmitControl: null,
      excludeWithin: [],
      denyLabels: [],
      denyNameSubstrings: [],
      widgetNames: [],
      keySteps: [],
      rowScopes: [],
    } as const;
    const rulesetDigest = digest(ruleset);
    const version = `${vendor}-v2`;
    return {
      mapping: { atsProvider, pathRuleId, vendor, rulesetVersion: version, rulesetDigest },
      ruleset: { version, digest: rulesetDigest, ruleset },
    } as const;
  });
  const mappings = entries.map((entry) => entry.mapping);
  const rulesets = entries.map((entry) => entry.ruleset).sort((left, right) =>
    left.version.localeCompare(right.version, 'en'),
  );
  const rules = {
    releaseVersion: 'apply-rules-2026-08-23.2',
    releaseDigest: digest({ releaseVersion: 'apply-rules-2026-08-23.2', mappings, rulesets }),
    mappings,
    rulesets,
  } as const;
  const withoutVersion = {
    schemaVersion: 1,
    releaseRevision: '7',
    issuedAt: parseIsoDateTime('2026-08-23T10:00:00.000Z')!,
    notBefore: parseIsoDateTime('2026-08-23T10:00:00.000Z')!,
    freshUntil: parseIsoDateTime('2026-08-23T10:05:00.000Z')!,
    notAfter: parseIsoDateTime('2026-08-23T10:10:00.000Z')!,
    compatibility: {
      minExtensionVersion: '0.0.0',
      rulesSchemaVersion: 2,
      contractVersion: 1,
    },
    policy: {
      version: 'apply-policy-2026-08-23.1',
      killSwitchVersion: '7',
      enabled: false,
      automationLevelCeiling: 'L0_PREVIEW_ONLY',
      allowedActions: [],
      allowedFieldKeys: [],
      vendors: {
        greenhouse: false,
        lever: false,
        ashby: false,
        workable: false,
        workday: false,
        icims: false,
        smartrecruiters: false,
        bamboohr: false,
        avature: false,
      },
      capabilities: {
        'set-text': false,
        'set-select': false,
        'set-combobox': false,
        'set-file': false,
        'set-attestation': false,
      },
      minConfidence: 1,
      inferredRequiresConfirm: true,
      deniedHostSuffixes: [],
    },
    rules,
    ...overrides,
  } as unknown as ExecutionRuntimeBundleWithoutVersionV1;
  return { runtimeBundleVersion: runtimeVersion(withoutVersion), ...withoutVersion };
}

function withMappedProviders(
  bundle: ExecutionRuntimeBundleV1,
  providers: ReadonlySet<string>,
): ExecutionRuntimeBundleV1 {
  const mappings = bundle.rules.mappings.filter(({ atsProvider }) => providers.has(atsProvider));
  const referencedVersions = new Set(mappings.map(({ rulesetVersion }) => rulesetVersion));
  const rulesets = bundle.rules.rulesets.filter(({ version }) => referencedVersions.has(version));
  const rules = {
    ...bundle.rules,
    mappings,
    rulesets,
    releaseDigest: digest({
      releaseVersion: bundle.rules.releaseVersion,
      mappings,
      rulesets,
    } as unknown as Json),
  };
  const { runtimeBundleVersion: _version, ...withoutVersion } = bundle;
  const candidate = { ...withoutVersion, rules } as ExecutionRuntimeBundleWithoutVersionV1;
  return { runtimeBundleVersion: runtimeVersion(candidate), ...candidate };
}

/**
 * 改过 policy 之后重新封包。
 *
 * `runtimeBundleVersion` 是整包内容的摘要，所以任何字段一改，摘要就对不上、
 * 解码器在看 policy 之前就拒了。想断言"这个 policy 变化是被接受的"，就必须
 * 重新算一次版本号，否则测到的是摘要校验，不是 policy 语义。
 */
function withPolicy(
  bundle: ExecutionRuntimeBundleV1,
  policy: Readonly<Record<string, unknown>>,
): unknown {
  const { runtimeBundleVersion: _version, ...rest } = bundle;
  const candidate = { ...rest, policy } as unknown as ExecutionRuntimeBundleWithoutVersionV1;
  return { runtimeBundleVersion: runtimeVersion(candidate), ...candidate };
}

async function parse(value: unknown, nowMs?: number) {
  return parseExecutionRuntimeBundleV1(value, nowMs === undefined ? {} : { nowMs });
}

function wizardBundle(compatibilityVersion = 3): ExecutionRuntimeBundleV1 {
  const base = makeBundle();
  const rulesets = base.rules.rulesets.map((entry) => {
    if (entry.ruleset.vendor !== 'greenhouse') return entry;
    const ruleset = { ...entry.ruleset, schemaVersion: 3, wizard: {
      schemaVersion: 1, wizardKey: 'test-wizard', applicationRootSelector: '#application',
      indicatorContainerSelector: '#steps', steps: [{ stepKey: 'one', indicatorSelector: '#one' }],
    } };
    return { ...entry, ruleset, digest: digest(ruleset) };
  });
  const mappings = base.rules.mappings.map((mapping) => ({
    ...mapping, rulesetDigest: rulesets.find((entry) => entry.version === mapping.rulesetVersion)!.digest,
  }));
  const release = { releaseVersion: 'wizard-test-v3', mappings, rulesets };
  return makeBundle({
    releaseRevision: '8', policy: { ...base.policy, killSwitchVersion: '8' },
    compatibility: { ...base.compatibility, rulesSchemaVersion: compatibilityVersion },
    rules: { ...release, releaseDigest: digest(release as unknown as Json) },
  });
}

describe('runtime bundle v2/v3 rule reader compatibility', () => {
  it('accepts mixed v2/v3 rules only when compatibility declares the highest required reader', async () => {
    const candidate = wizardBundle();
    expect(await parse(candidate)).toEqual({ ok: true, value: candidate });
    expect(await parse(wizardBundle(2))).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
    const base = makeBundle();
    expect(await parse(makeBundle({ compatibility: { ...base.compatibility, rulesSchemaVersion: 3 } })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
  });
  it('retains all three digest fences around wizard data', async () => {
    const candidate = structuredClone(wizardBundle());
    const rule = candidate.rules.rulesets.find((entry) => entry.ruleset.vendor === 'greenhouse')!;
    (rule.ruleset.wizard as Record<string, unknown>).wizardKey = 'tampered';
    expect(await parse(candidate)).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH' });
  });
  it('allows a higher-revision v2 rollback and rejects a lower revision', async () => {
    const base = makeBundle();
    const rollback = makeBundle({ releaseRevision: '9', policy: { ...base.policy, killSwitchVersion: '9' } });
    expect(await parseExecutionRuntimeBundleV1(rollback, { minimumReleaseRevision: '8' as never }))
      .toEqual({ ok: true, value: rollback });
    expect(await parseExecutionRuntimeBundleV1(base, { minimumReleaseRevision: '8' as never }))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_ROLLBACK_REJECTED' });
  });
});

describe('execution runtime bundle v1 exact parser', () => {
  it('accepts the exact value-free, default-off bundle and exports the stable code set', async () => {
    const bundle = makeBundle();
    const result = await parse(bundle, Date.parse('2026-08-23T10:02:00.000Z'));

    expect(result).toEqual({ ok: true, value: bundle });
    expect(EXECUTION_RUNTIME_BUNDLE_ERROR_CODES).toEqual([
      'RUNTIME_BUNDLE_MALFORMED',
      'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED',
      'RUNTIME_BUNDLE_TIME_INVALID',
      'RUNTIME_BUNDLE_DIGEST_MISMATCH',
      'RUNTIME_BUNDLE_MAPPING_INVALID',
      'RUNTIME_BUNDLE_ROLLBACK_REJECTED',
      'RUNTIME_BUNDLE_ETAG_INVALID',
      'RUNTIME_BUNDLE_CACHE_UNAVAILABLE',
      'RUNTIME_BUNDLE_STALE',
      'RUNTIME_BUNDLE_HARD_EXPIRED',
    ]);
  });

  it('keeps the four-provider Greenhouse release valid when optional candidate mappings are absent', async () => {
    const core = withMappedProviders(
      makeBundle(),
      new Set(['ASHBY', 'GREENHOUSE', 'LEVER', 'WORKABLE']),
    );
    await expect(parse(core)).resolves.toEqual({ ok: true, value: core });

    const missingGreenhouse = withMappedProviders(
      makeBundle(),
      new Set(['ASHBY', 'LEVER', 'WORKABLE', 'WORKDAY']),
    );
    await expect(parse(missingGreenhouse)).resolves.toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MAPPING_INVALID',
    });
  });

  it('uses one strict canonical SemVer grammar and precedence comparator', async () => {
    expect(isCanonicalExecutionRuntimeSemverV1('1.2.3-rc.1+build.05')).toBe(true);
    expect(compareExecutionRuntimeSemverV1('1.2.3', '1.2.3-rc.1')).toBe(1);
    expect(compareExecutionRuntimeSemverV1('1.2.3-rc.2', '1.2.3-rc.10')).toBe(-1);
    expect(compareExecutionRuntimeSemverV1('1.2.3+left', '1.2.3+right')).toBe(0);

    for (const malformed of [
      '1.2',
      '01.2.3',
      '1.2.3-',
      '1.2.3-.',
      '1.2.3-alpha..1',
      '1.2.3-01',
      '1.2.3+',
      '1.2.3+build..1',
    ]) {
      expect(isCanonicalExecutionRuntimeSemverV1(malformed)).toBe(false);
      expect(compareExecutionRuntimeSemverV1(malformed, '1.2.3')).toBeNull();
      expect(await parse(makeBundle({
        compatibility: {
          minExtensionVersion: malformed,
          rulesSchemaVersion: 2,
          contractVersion: 1,
        },
      }))).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    }
  });

  it('rejects missing/unknown outer and nested keys plus unsafe object shapes', async () => {
    const bundle = makeBundle();
    const { rules: _rules, ...missing } = bundle;
    expect(await parse(missing)).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    const { schemaVersion: _schemaVersion, ...missingSchema } = bundle;
    expect(await parse(missingSchema)).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
    expect(await parse({ ...bundle, schemaVersion: '1' })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
    // 2026-09-28：顶层与 compatibility 里多出来的成员不再拒整包（见下面「后端先发」那一组）；
    // 但它们在摘要里——没按新内容重新封包就塞进来，照旧被整包摘要拒掉。
    expect(await parse({ ...bundle, surprise: true })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH',
    });
    expect(
      await parse({ ...bundle, compatibility: { ...bundle.compatibility, optional: 2 } }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH' });
    expect(await parse(Object.assign(new Date(), bundle))).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });

    const polluted = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: {} });
    expect(await parse(polluted)).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    const oversizedRuleset = {
      ...bundle.rules.rulesets[0]!.ruleset,
      note: 'x'.repeat(1_048_577),
    };
    expect(
      await parse({
        ...bundle,
        rules: {
          ...bundle.rules,
          rulesets: [
            { ...bundle.rules.rulesets[0]!, ruleset: oversizedRuleset },
            ...bundle.rules.rulesets.slice(1),
          ],
        },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
  });

  it.each([
    [
      'missing minExtensionVersion',
      { rulesSchemaVersion: 2, contractVersion: 1 },
    ],
    [
      'missing rulesSchemaVersion',
      { minExtensionVersion: '0.0.0', contractVersion: 1 },
    ],
    [
      'missing contractVersion',
      { minExtensionVersion: '0.0.0', rulesSchemaVersion: 2 },
    ],
    [
      'string rulesSchemaVersion',
      { minExtensionVersion: '0.0.0', rulesSchemaVersion: '1', contractVersion: 1 },
    ],
    [
      'string contractVersion',
      { minExtensionVersion: '0.0.0', rulesSchemaVersion: 2, contractVersion: '1' },
    ],
  ])('classifies a %s compatibility shape as malformed', async (_label, compatibility) => {
    expect(await parse({ ...makeBundle(), compatibility })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
  });

  it.each([
    [
      'newer rules schema',
      { minExtensionVersion: '0.0.0', rulesSchemaVersion: 4, contractVersion: 1 },
    ],
    [
      'newer contract',
      { minExtensionVersion: '0.0.0', rulesSchemaVersion: 2, contractVersion: 2 },
    ],
  ])('reserves schema-unsupported for a genuine %s version', async (_label, compatibility) => {
    expect(await parse({ ...makeBundle(), compatibility })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED',
    });
  });

  it('rejects duplicate JSON keys, including escape aliases, before JSON.parse can collapse them', async () => {
    const json = JSON.stringify(makeBundle());
    const duplicate = json.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    const escapedAlias = json.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"\\u0073chemaVersion":1',
    );

    expect(await parseExecutionRuntimeBundleJsonV1(duplicate)).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
    expect(await parseExecutionRuntimeBundleJsonV1(escapedAlias)).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
    expect(await parseExecutionRuntimeBundleJsonV1(`${'['.repeat(65)}0${']'.repeat(65)}`)).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
  });

  it('rejects unknown schema, non-canonical timestamps and impossible chronology', async () => {
    expect(await parse({ ...makeBundle(), schemaVersion: 2 })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED',
    });
    expect(await parse({ ...makeBundle(), issuedAt: '2026-08-23T10:00:00Z' })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_TIME_INVALID',
    });
    expect(
      await parse(makeBundle({ notBefore: '2026-08-23T10:06:00.000Z' })),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_TIME_INVALID' });
    expect(
      await parse(makeBundle({ freshUntil: '2026-08-23T10:11:00.000Z' })),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_TIME_INVALID' });
  });

  it('classifies future, stale, and hard-expired bundles without treating cache presence as authority', () => {
    const bundle = makeBundle();
    expect(
      classifyExecutionRuntimeBundleTimeV1(bundle, Date.parse('2026-08-23T09:58:00.000Z')),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_TIME_INVALID' });
    expect(
      classifyExecutionRuntimeBundleTimeV1(bundle, Date.parse('2026-08-23T10:06:00.000Z')),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_STALE' });
    expect(
      classifyExecutionRuntimeBundleTimeV1(bundle, Date.parse('2026-08-23T10:10:00.000Z')),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_HARD_EXPIRED' });
    expect(
      classifyExecutionRuntimeBundleTimeV1(bundle, Date.parse('2026-08-23T10:03:00.000Z')),
    ).toEqual({ ok: true, value: 'FRESH' });
  });

  it('requires exact closed records and canonical sorted unique arrays', async () => {
    const bundle = makeBundle();
    // 2026-09-15：厂商与能力位从"键集必须完全相等"改成容错读法。原因是键集相等
    // 把两边焊死成必须同时发布——后端每加一个能力位，没跟上的插件就把整个包判
    // malformed，自动填写全停，连已放行的厂商一起。而插件走商店审核、后端走部署，
    // 根本不可能同步。下面钉的是新语义，容错的是"有没有这个键"，不是"值是什么"。
    const { avature: _avature, ...missingVendor } = bundle.policy.vendors;
    expect(
      await parse(withPolicy(bundle, { ...bundle.policy, vendors: missingVendor })),
    ).toMatchObject({ ok: true });
    expect(
      await parse(
        withPolicy(bundle, { ...bundle.policy, vendors: { ...bundle.policy.vendors, ghost: false } }),
      ),
    ).toMatchObject({ ok: true });
    // 下面几条"应当被拒"也走 withPolicy 重新封包：不重算摘要的话它们同时违反
    // policy 与 digest，通过只是因为 parsePolicy 先于摘要校验跑；重算之后，唯一
    // 能拒它们的就只剩 policy 守卫本身，测的才是想测的东西。
    //
    // 2026-09-22：未知厂商被置 true **不再拒整包**。原来这条写的理由是「那是后端
    // 配置写错时的最后一道，放开它就等于允许插件跑到一个我们从没量过的页面上动手」
    // ——那句话在写下的时候是对的，现在已经不是了：2026-09-15／09-21 两次收口之后，
    // `remoteApplyPolicy` 按**本地已知的键集**重建策略（"包里多出来的键根本不在循环
    // 里"），未知厂商连进 `ApplyPolicy.vendors` 的机会都没有；识别那一侧也另有两道
    // （`detectApplyVendor` 读本地 VENDOR_CATALOG，装入表只装认得的厂商）。
    //
    // 而它的代价是实测出来的：后端一放行新厂商，所有还没升级的商店包连同认得的
    // 那十家一起停掉——商店审核 + 用户升级决定了两边永远有一段版本不一致的窗口。
    // 用「拒整包」去防一件下游已经防住的事，换来的只是一次全量停摆。
    //
    // 这条保证没有丢，只是换了地方：`execution-runtime-authority` 里钉着
    //「未知厂商开着也投影不出任何东西」。
    expect(
      await parse(
        withPolicy(bundle, { ...bundle.policy, vendors: { ...bundle.policy.vendors, ghost: true } }),
      ),
    ).toMatchObject({ ok: true });
    // 值不是布尔仍然拒——容错的是键的有无，不是值的类型。
    expect(
      await parse(
        withPolicy(bundle, { ...bundle.policy, vendors: { ...bundle.policy.vendors, workday: 'yes' } }),
      ),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    // 已知厂商被置 true 现在由后端的准入清单决定，契约不再钉死；插件侧仍有
    // executionRuntimeAuthority 的本地能力上限做第二道与运算。
    for (const vendor of ['workday', 'icims', 'smartrecruiters', 'bamboohr', 'avature'] as const) {
      expect(
        await parse(
          withPolicy(bundle, {
            ...bundle.policy,
            vendors: { ...bundle.policy.vendors, [vendor]: true },
          }),
        ),
        vendor,
      ).toMatchObject({ ok: true });
    }
    // 能力位：缺席读作关闭、未知键忽略，都不该拒整包。
    const { 'set-attestation': _attestation, ...missingCapability } = bundle.policy.capabilities;
    expect(
      await parse(withPolicy(bundle, { ...bundle.policy, capabilities: missingCapability })),
    ).toMatchObject({ ok: true });
    expect(
      await parse(
        withPolicy(bundle, {
          ...bundle.policy,
          capabilities: { ...bundle.policy.capabilities, 'set-telepathy': true },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await parse(
        withPolicy(bundle, {
          ...bundle.policy,
          capabilities: { ...bundle.policy.capabilities, 'set-text': 1 },
        }),
      ),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    expect(
      await parse({
        ...bundle,
        policy: { ...bundle.policy, allowedActions: ['SUBMIT', 'FILL'] },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    expect(
      await parse({
        ...bundle,
        policy: { ...bundle.policy, allowedFieldKeys: ['email', 'email'] },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    // 乱序同样拒（规范形式仍然强制）。
    // 这两条走 withPolicy（重算 runtimeBundleVersion），否则被摘要不匹配
    // 先拒掉，测不到清单校验本身。
    expect(
      await parse(withPolicy(bundle, { ...bundle.policy, allowedFieldKeys: ['phone', 'email'] })),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    expect(
      await parse(withPolicy(bundle, { ...bundle.policy, allowedFieldKeys: ['email', 42] })),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    expect(
      await parse({
        ...bundle,
        policy: { ...bundle.policy, deniedHostSuffixes: ['COM', 'example.test'] },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
  });

  it('清单里出现我们还不认识的成员，不拒整包', async () => {
    // 2026-09-16 实测：argoland #469 合并并部署后，api.argoland.ai 发的
    // allowedFieldKeys 从 11 个变成 14 个（多出 addressLine1 / addressRegion /
    // currentCompany）。旧解码器要求每一项都在我们的十一键集合里，于是后端一次
    // 纯加法的改动把整包判成 malformed，自动填写全线 fail closed。
    //
    // 陌生成员是惰性的：消费端只会拿**我们自己产得出的键**去反查这份清单
    // （kernelScanner 的 allowed.includes(ourKey)、
    //  grant.allowedActions.includes('FILL')），匹配不上就不放行。
    const bundle = makeBundle();
    expect(
      await parse(
        withPolicy(bundle, {
          ...bundle.policy,
          allowedFieldKeys: [
            'addressLine1', 'addressRegion', 'city', 'currentCompany', 'email',
            'firstName', 'fullName', 'githubUrl', 'lastName', 'linkedinUrl',
            'location', 'phone', 'portfolioUrl', 'preferredName',
          ],
        }),
      ),
    ).toMatchObject({ ok: true });
    // 动作面同理：后端先上线一个新动作，插件跟版之前也不该整包拒。
    expect(
      await parse(
        withPolicy(bundle, {
          ...bundle.policy,
          allowedActions: ['DISCOVER_SENSITIVE', 'FILL', 'FILL_SENSITIVE', 'REHEARSE'],
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('rejects duplicate mappings/rulesets, missing references, unreferenced rulesets and vendor drift', async () => {
    const bundle = makeBundle();
    const mapping = bundle.rules.mappings[0]!;
    const ruleset = bundle.rules.rulesets[0]!;
    expect(
      await parse({
        ...bundle,
        rules: { ...bundle.rules, mappings: [...bundle.rules.mappings, mapping] },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
    expect(
      await parse({
        ...bundle,
        rules: { ...bundle.rules, rulesets: [...bundle.rules.rulesets, ruleset] },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
    const unreferencedPayload = {
      ...ruleset.ruleset,
      vendor: 'workable',
    } as const;
    const unreferencedDigest = digest(unreferencedPayload);
    expect(
      await parse({
        ...bundle,
        rules: {
          ...bundle.rules,
          rulesets: [
            ...bundle.rules.rulesets,
            {
              version: 'zz-unreferenced-v1',
              digest: unreferencedDigest,
              ruleset: unreferencedPayload,
            },
          ],
        },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
    expect(
      await parse({
        ...bundle,
        rules: {
          ...bundle.rules,
          mappings: [
            { ...mapping, rulesetVersion: 'missing-v1' },
            ...bundle.rules.mappings.slice(1),
          ],
        },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
    expect(
      await parse({ ...bundle, rules: { ...bundle.rules, mappings: [] } }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
    expect(
      await parse({
        ...bundle,
        rules: {
          ...bundle.rules,
          mappings: [{ ...mapping, vendor: 'lever' }, ...bundle.rules.mappings.slice(1)],
        },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MAPPING_INVALID' });
  });

  it('checks ruleset, release, and whole-bundle digests independently', async () => {
    const bundle = makeBundle();
    const ruleset = bundle.rules.rulesets[0]!;
    expect(
      await parse({
        ...bundle,
        rules: {
          ...bundle.rules,
          rulesets: [
            { ...ruleset, digest: parseSha256Digest(`sha256:${'b'.repeat(64)}`)! },
            ...bundle.rules.rulesets.slice(1),
          ],
        },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH' });
    expect(
      await parse({
        ...bundle,
        rules: {
          ...bundle.rules,
          releaseDigest: parseSha256Digest(`sha256:${'c'.repeat(64)}`)!,
        },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH' });
    expect(
      await parse({ ...bundle, runtimeBundleVersion: `rb1_${'d'.repeat(64)}` }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH' });
  });

  it('rejects release rollback and validates an exact strong ETag', async () => {
    const bundle = makeBundle();
    expect(
      await parse({
        ...bundle,
        policy: { ...bundle.policy, killSwitchVersion: '8' },
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
    expect(await parseExecutionRuntimeBundleV1(bundle, { minimumReleaseRevision: '8' })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_ROLLBACK_REJECTED',
    });
    expect(parseExecutionRuntimeBundleEtagV1(`"${bundle.runtimeBundleVersion}"`, bundle)).toEqual({
      ok: true,
      value: bundle.runtimeBundleVersion,
    });
    expect(parseExecutionRuntimeBundleEtagV1(`W/"${bundle.runtimeBundleVersion}"`, bundle)).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_ETAG_INVALID',
    });
    expect(parseExecutionRuntimeBundleEtagV1('"rb1_deadbeef"', bundle)).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_ETAG_INVALID',
    });
  });
});

/** 改完整包任意一处之后按新内容重新封包（后端发版就是这个形状）。 */
function resealed(value: Readonly<Record<string, unknown>>): ExecutionRuntimeBundleV1 {
  const { runtimeBundleVersion: _old, ...rest } = value;
  const withoutVersion = rest as unknown as ExecutionRuntimeBundleWithoutVersionV1;
  return { runtimeBundleVersion: runtimeVersion(withoutVersion), ...withoutVersion };
}

/**
 * 后端先发、这个包还不认识的**加法**（2026-09-28）。
 *
 * 运行时包是所有填写的总闸：它读不懂，每一家、每一条路都停。在此之前顶层、`compatibility`、
 * `policy` 的键集都是封闭的——后端给其中任何一处加一个字段，所有已装的商店包就整包
 * `RUNTIME_BUNDLE_MALFORMED`，而商店包的更新是异步的（审核 + 用户升级），两边永远有一段版本
 * 不一致的窗口。
 *
 * 现在的口径（与 2026-09-15 起的能力位、09-22 起的厂商同一条）：
 *  · 多出来的成员**不解释**，原样留在解析结果里——整包摘要与规范正文都按送达的原样算，
 *    所以它们照样被摘要覆盖，改一个字就整包拒；
 *  · 认得的字段一个不少地照旧校验：版本、时间、摘要、kill switch、拒绝名单都不放松；
 *  · 刻意的「你太旧了」照旧有效：`schemaVersion`、`contractVersion`、`rulesSchemaVersion`、
 *    `minExtensionVersion`——后端要打断旧包，走这几根杠杆，而不是靠加一个旧包不认识的键。
 */
describe('后端先发：运行时包多了这一版不认识的成员', () => {
  const base = makeBundle();
  const additive = (): ExecutionRuntimeBundleV1 => resealed({
    ...base,
    recommendedExtensionVersion: '1.2.0',
    compatibility: { ...base.compatibility, maxTestedExtensionVersion: '9.9.9' },
    policy: {
      ...base.policy,
      automationLevelCeiling: 'L4_FUTURE_LEVEL',
      rateLimits: { perMinute: 5 },
      allowedActions: ['REHEARSE'],
      capabilities: { ...base.policy.capabilities, 'set-future-thing': true },
      vendors: { ...base.policy.vendors, paradox: true },
    },
  });

  it('整包照常收下，多出来的成员原样留着（不解释），认得的字段逐字照旧', async () => {
    const candidate = additive();
    const result = await parse(candidate, Date.parse('2026-08-23T10:02:00.000Z'));
    expect(result).toEqual({ ok: true, value: candidate });
  });

  it('多出来的成员也在摘要里：送达后被改过，整包拒', async () => {
    const candidate = additive() as unknown as Record<string, unknown>;
    expect(await parse({ ...candidate, recommendedExtensionVersion: '9.0.0' })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH',
    });
    const policy = candidate['policy'] as Record<string, unknown>;
    expect(await parse({ ...candidate, policy: { ...policy, rateLimits: { perMinute: 500 } } })).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_DIGEST_MISMATCH',
    });
  });

  it('原始正文与规范正文仍然逐字节相等（缓存与内容脚本的二次校验靠这一条）', async () => {
    const candidate = additive();
    const json = canonicalJson(candidate as unknown as Json);
    const parsed = await parseExecutionRuntimeBundleJsonV1(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(canonicalJson(parsed.value as unknown as Json)).toBe(json);
  });

  it('刻意打断旧包的几根杠杆不受影响', async () => {
    expect(await parse(resealed({ ...base, compatibility: { ...base.compatibility, contractVersion: 2, extra: true } })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED' });
    expect(await parse(resealed({ ...base, schemaVersion: 2, extra: true })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED' });
    expect(await parse(resealed({ ...base, compatibility: { ...base.compatibility, minExtensionVersion: '1.2' } })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
  });

  it('认得的字段坏了照旧拒：缺键、类型不对、拒绝名单不成形、自动化级别不像 token', async () => {
    const { enabled: _enabled, ...missingEnabled } = base.policy;
    for (const policy of [
      missingEnabled,
      { ...base.policy, enabled: 'yes' },
      { ...base.policy, deniedHostSuffixes: ['*.example.test'] },
      { ...base.policy, automationLevelCeiling: '' },
      { ...base.policy, automationLevelCeiling: 'L1 FILL' },
    ]) {
      expect(await parse(resealed({ ...base, policy })), JSON.stringify(policy)).toEqual({
        ok: false,
        code: 'RUNTIME_BUNDLE_MALFORMED',
      });
    }
    const { minExtensionVersion: _min, ...missingMin } = base.compatibility;
    expect(await parse(resealed({ ...base, compatibility: { ...missingMin, extra: true } })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
  });

  it('规则 release 的骨架（映射表、ruleset 信封）照旧封闭：它是授权的路由表', async () => {
    expect(await parse(resealed({ ...base, rules: { ...base.rules, extra: true } }))).toEqual({
      ok: false,
      code: 'RUNTIME_BUNDLE_MALFORMED',
    });
    const [first, ...rest] = base.rules.mappings;
    expect(await parse(resealed({ ...base, rules: { ...base.rules, mappings: [{ ...first!, priority: 1 }, ...rest] } })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
  });

  it('清单上限放宽到 512：档案字段键一个月涨过二十几个，64 这道线再过几个月就会整包打死旧包', async () => {
    const keys = Array.from({ length: 200 }, (_, index) => `fieldKey${String(index).padStart(3, '0')}`);
    expect(await parse(resealed({ ...base, policy: { ...base.policy, allowedFieldKeys: keys } })))
      .toMatchObject({ ok: true });
    const tooMany = Array.from({ length: 513 }, (_, index) => `fieldKey${String(index).padStart(3, '0')}`);
    expect(await parse(resealed({ ...base, policy: { ...base.policy, allowedFieldKeys: tooMany } })))
      .toEqual({ ok: false, code: 'RUNTIME_BUNDLE_MALFORMED' });
  });

  it('逐类报出这一版忽略了什么：只有稳定码，没有键名与取值', async () => {
    const candidate = additive();
    const notices = describeExecutionRuntimeBundleNoticesV1(candidate, APPLICATION_PROFILE_FIELD_KEYS);
    expect(notices).toEqual([
      'RUNTIME_BUNDLE_UNKNOWN_ACTION_IGNORED',
      'RUNTIME_BUNDLE_UNKNOWN_AUTOMATION_LEVEL',
      'RUNTIME_BUNDLE_UNKNOWN_CAPABILITY_IGNORED',
      'RUNTIME_BUNDLE_UNKNOWN_MEMBER_IGNORED',
      'RUNTIME_BUNDLE_UNKNOWN_VENDOR_IGNORED',
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/recommended|future|paradox|REHEARSE|L4/u);
    expect(describeExecutionRuntimeBundleNoticesV1(base, APPLICATION_PROFILE_FIELD_KEYS)).toEqual([]);
    const withFieldKey = resealed({ ...base, policy: { ...base.policy, allowedFieldKeys: ['email', 'favoriteColor'] } });
    expect(describeExecutionRuntimeBundleNoticesV1(withFieldKey, APPLICATION_PROFILE_FIELD_KEYS)).toEqual(['RUNTIME_BUNDLE_UNKNOWN_FIELD_KEY_IGNORED']);
  });
});
