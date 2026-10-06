import { createHash } from 'node:crypto';

import ashbyRules from '@edaix/apply-rules/ashby.json';
import bamboohrRules from '@edaix/apply-rules/bamboohr.json';
import doverRules from '@edaix/apply-rules/dover.json';
import genericRules from '@edaix/apply-rules/generic.json';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import icimsRules from '@edaix/apply-rules/icims.json';
import jobviteRules from '@edaix/apply-rules/jobvite.json';
import leverRules from '@edaix/apply-rules/lever.json';
import ripplingRules from '@edaix/apply-rules/rippling.json';
import releaseManifest from '@edaix/apply-rules/release-manifest.json';
import {
  APPLY_RULES_RUNTIME_RELEASE_V1,
  resolveApplyRulesReleaseMappingV1,
} from '@edaix/apply-rules/runtime-release';
import workableRules from '@edaix/apply-rules/workable.json';
import smartrecruitersRules from '@edaix/apply-rules/smartrecruiters.json';
import workdayRules from '@edaix/apply-rules/workday.json';
import { describe, expect, it } from 'vitest';

import {
  buildApplyRulesRelease,
  canonicalizeApplyRulesJson,
  createRuntimeApplyRegistry,
  createRuntimeApplyMetadataRegistry,
  resolveRuntimeApplyMapping,
  readRuntimeApplyFormResult,
  readRuntimeApplyWizardDeclaration,
  resolveRuntimeApplyAdapter,
  type ApplyRulesReleaseV1,
} from '../src/runtimeRegistry';

const SOURCES = {
  ashby: ashbyRules,
  bamboohr: bamboohrRules,
  dover: doverRules,
  generic: genericRules,
  greenhouse: greenhouseRules,
  icims: icimsRules,
  jobvite: jobviteRules,
  lever: leverRules,
  rippling: ripplingRules,
  smartrecruiters: smartrecruitersRules,
  workable: workableRules,
  workday: workdayRules,
} as const;

async function builtRelease(): Promise<ApplyRulesReleaseV1> {
  const built = await buildApplyRulesRelease(releaseManifest, SOURCES);
  expect(built).toMatchObject({ ok: true });
  if (!built.ok) throw new Error(built.code);
  return built.value;
}

function containsAnnotation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAnnotation);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => key.startsWith('$comment') || containsAnnotation(child),
  );
}

function withMappedProviders(
  release: ApplyRulesReleaseV1,
  providers: ReadonlySet<string>,
): ApplyRulesReleaseV1 {
  const mappings = release.mappings.filter(({ atsProvider }) => providers.has(atsProvider));
  const referencedVersions = new Set(mappings.map(({ rulesetVersion }) => rulesetVersion));
  const rulesets = release.rulesets.filter(({ version }) => referencedVersions.has(version));
  const releaseDigest = `sha256:${createHash('sha256')
    .update(canonicalizeApplyRulesJson({ releaseVersion: release.releaseVersion, mappings, rulesets }), 'utf8')
    .digest('hex')}` as ApplyRulesReleaseV1['releaseDigest'];
  return { ...release, releaseDigest, mappings, rulesets };
}

describe('apply-rules release builder', () => {
  it('exposes one immutable annotation-free release for the backend publisher', async () => {
    const release = await builtRelease();
    expect(releaseManifest.unavailableAtsProviders).toEqual(['INDEED_APPLY']);
    expect(APPLY_RULES_RUNTIME_RELEASE_V1).toEqual(release);
    expect(Object.isFrozen(APPLY_RULES_RUNTIME_RELEASE_V1)).toBe(true);
    expect(Object.isFrozen(APPLY_RULES_RUNTIME_RELEASE_V1.rulesets[0]!.ruleset)).toBe(true);
    expect(
      resolveApplyRulesReleaseMappingV1('GREENHOUSE', 'greenhouse-application-v3'),
    ).toMatchObject({ vendor: 'greenhouse', rulesetVersion: 'greenhouse-rules-v23' });
    expect(resolveApplyRulesReleaseMappingV1('INDEED_APPLY', 'indeed-apply-v1')).toBeNull();
    expect(resolveApplyRulesReleaseMappingV1('greenhouse', 'greenhouse-application-v3')).toBeNull();
  });

  it('strips source annotations and locks every exact transmitted ruleset with JCS/SHA-256', async () => {
    expect(containsAnnotation(greenhouseRules)).toBe(true);

    const release = await builtRelease();
    expect(containsAnnotation(release)).toBe(false);
    expect(release.mappings.map(({ atsProvider, pathRuleId }) => `${atsProvider}\u0000${pathRuleId}`)).toEqual([
      'ASHBY\u0000ashby-application-v1',
      'BAMBOOHR\u0000bamboohr-application-v1',
      // 2026-09-22 放行：这三家的规则与适配器早就在仓里、ats-lab 在真实在招岗位上实测能填，
      // 只是从来没进过发布，于是生产上一律「这一页没有认出申请表」。
      'DOVER\u0000dover-application-v1',
      // 2026-09-22：不绑厂商的那条路（argoland #584）。规则随发布下发、映射也在，
      // 但随包适配器是 null、内置 policy 关着、没有任何调用方打开那个开关——
      // 发布里有这一条 ≠ 这条路已放行（见 apply-generic-ruleset.test.ts）。
      'GENERIC\u0000generic-application-v1',
      'GREENHOUSE\u0000greenhouse-application-v1',
      'GREENHOUSE\u0000greenhouse-application-v3',
      'ICIMS\u0000icims-application-v1',
      'JOBVITE\u0000jobvite-application-v1',
      'LEVER\u0000lever-application-v1',
      'RIPPLING\u0000rippling-application-v1',
      'SMARTRECRUITERS\u0000smartrecruiters-application-v1',
      'WORKABLE\u0000workable-application-v1',
      'WORKDAY\u0000workday-application-v1',
    ]);

    for (const ruleset of release.rulesets) {
      const digest = createHash('sha256')
        .update(canonicalizeApplyRulesJson(ruleset.ruleset), 'utf8')
        .digest('hex');
      expect(ruleset.digest).toBe(`sha256:${digest}`);
    }

    const releaseDigest = createHash('sha256')
      .update(
        canonicalizeApplyRulesJson({
          releaseVersion: release.releaseVersion,
          mappings: release.mappings,
          rulesets: release.rulesets,
        }),
        'utf8',
      )
      .digest('hex');
    expect(release.releaseDigest).toBe(`sha256:${releaseDigest}`);
  });

  it('rejects a source whose exact payload no longer matches the manifest digest', async () => {
    const changed = structuredClone(greenhouseRules) as Record<string, unknown>;
    changed['anchors'] = ['form.changed-without-release'];

    await expect(
      buildApplyRulesRelease(releaseManifest, { ...SOURCES, greenhouse: changed }),
    ).resolves.toEqual({ ok: false, code: 'RUNTIME_RULESET_DIGEST_MISMATCH' });
  });
});

describe('dynamic runtime registry', () => {
  it('retains wizard provenance only on exact mappings minted from a verified v3 release', async () => {
    const original = await builtRelease();
    const rulesets = original.rulesets.map((entry) => {
      if (entry.ruleset.vendor !== 'greenhouse') return entry;
      const ruleset = { ...entry.ruleset, schemaVersion: 3, wizard: {
        schemaVersion: 1, wizardKey: 'test-wizard', applicationRootSelector: '#application',
        indicatorContainerSelector: '#steps', steps: [{ stepKey: 'personal', indicatorSelector: '#personal' }],
      } };
      return { ...entry, ruleset, digest: `sha256:${createHash('sha256').update(canonicalizeApplyRulesJson(ruleset)).digest('hex')}` };
    });
    const mappings = original.mappings.map((mapping) => ({ ...mapping,
      rulesetDigest: rulesets.find((entry) => entry.version === mapping.rulesetVersion)!.digest,
    }));
    const content = { releaseVersion: original.releaseVersion, mappings, rulesets };
    const candidate = { ...content, releaseDigest: `sha256:${createHash('sha256').update(canonicalizeApplyRulesJson(content)).digest('hex')}` };
    const registry = await createRuntimeApplyRegistry(candidate);
    expect(registry.ok).toBe(true);
    if (!registry.ok) throw new Error(registry.code);
    const mapping = resolveRuntimeApplyAdapter(registry.value, { atsProvider: 'GREENHOUSE', pathRuleId: 'greenhouse-application-v1' });
    if (!mapping.ok) throw new Error(mapping.code);
    const declaration = readRuntimeApplyWizardDeclaration(mapping.value);
    expect(declaration?.wizardKey).toBe('test-wizard');
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(readRuntimeApplyWizardDeclaration({ ...mapping.value })).toBeNull();
    const metadata = await createRuntimeApplyMetadataRegistry(candidate);
    if (!metadata.ok) throw new Error(metadata.code);
    const selected = resolveRuntimeApplyMapping(metadata.value, { atsProvider: 'GREENHOUSE', pathRuleId: 'greenhouse-application-v1' });
    if (!selected.ok) throw new Error(selected.code);
    expect(Object.keys(selected.value)).toEqual(['atsProvider', 'pathRuleId', 'vendor', 'rulesetVersion', 'rulesetDigest']);
    expect(readRuntimeApplyWizardDeclaration(selected.value)).toEqual(declaration);
    expect(readRuntimeApplyWizardDeclaration({ ...selected.value })).toBeNull();
    expect(JSON.stringify(mapping.value)).not.toContain('applicationRootSelector');
    const oldRegistry = await createRuntimeApplyRegistry(original);
    if (!oldRegistry.ok) throw new Error(oldRegistry.code);
    expect(oldRegistry.value.mappings.every((value) => readRuntimeApplyWizardDeclaration(value) === null)).toBe(true);
    const tampered = structuredClone(candidate);
    (tampered.rulesets.find((entry) => (entry.ruleset as Record<string, unknown>).vendor === 'greenhouse')!.ruleset as { schemaVersion: number }).schemaVersion = 2;
    expect((await createRuntimeApplyRegistry(tampered)).ok).toBe(false);
    expect((await createRuntimeApplyMetadataRegistry(tampered)).ok).toBe(false);
  });
  it('嵌入路径只在调用方声明子帧时放行（P2-10）：顶层帧 PATH_NOT_APPLY，子帧读到同一张表', async () => {
    const created = await createRuntimeApplyRegistry(await builtRelease());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const mapping = resolveRuntimeApplyAdapter(created.value, {
      atsProvider: 'GREENHOUSE',
      pathRuleId: 'greenhouse-application-v1',
    });
    expect(mapping.ok).toBe(true);
    if (!mapping.ok) return;
    const resolved = mapping.value;
    // 官方嵌入帧里的那张表：与现代 board 同一个 form#application-form、同一套 id。
    document.body.innerHTML = `
      <form id="application-form" action="/embed/job_app">
        <label for="first_name">First Name</label><input id="first_name" type="text" autocomplete="given-name" />
        <label for="email">Email</label><input id="email" type="email" autocomplete="email" />
      </form>`;
    try {
      expect(readRuntimeApplyFormResult(resolved, '/embed/job_app', document))
        .toEqual({ ok: false, stop: 'PATH_NOT_APPLY' });
      expect(readRuntimeApplyFormResult(resolved, '/embed/job_app', document, {}, { embedded: false }))
        .toEqual({ ok: false, stop: 'PATH_NOT_APPLY' });
      const embedded = readRuntimeApplyFormResult(resolved, '/embed/job_app', document, {}, { embedded: true });
      expect(embedded.ok).toBe(true);
      if (embedded.ok) {
        expect(embedded.descriptor.fields.map((field) => field.key)).toEqual(['firstName', 'email']);
      }
      // 子帧声明只放行规则点名的那条嵌入路径，不放行别的。
      expect(readRuntimeApplyFormResult(resolved, '/embed/job_board', document, {}, { embedded: true }))
        .toEqual({ ok: false, stop: 'PATH_NOT_APPLY' });
    } finally {
      document.body.innerHTML = '';
    }
  });

  it('keeps Greenhouse available when optional Workday and expansion mappings are omitted', async () => {
    const release = withMappedProviders(
      await builtRelease(),
      new Set(['ASHBY', 'GREENHOUSE', 'LEVER', 'WORKABLE']),
    );
    const created = await createRuntimeApplyRegistry(release);
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(created.code);

    expect(resolveRuntimeApplyAdapter(created.value, {
      atsProvider: 'GREENHOUSE',
      pathRuleId: 'greenhouse-application-v1',
    })).toMatchObject({ ok: true, value: { vendor: 'greenhouse' } });
    expect(resolveRuntimeApplyAdapter(created.value, {
      atsProvider: 'WORKDAY',
      pathRuleId: 'workday-application-v1',
    })).toEqual({ ok: false, code: 'RUNTIME_RULES_MAPPING_NOT_FOUND' });
  });

  it('resolves only exact (atsProvider, pathRuleId) mappings and returns the mapped vendor', async () => {
    const created = await createRuntimeApplyRegistry(await builtRelease());
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(created.code);

    const v1 = resolveRuntimeApplyAdapter(created.value, {
      atsProvider: 'GREENHOUSE',
      pathRuleId: 'greenhouse-application-v1',
    });
    const v3 = resolveRuntimeApplyAdapter(created.value, {
      atsProvider: 'GREENHOUSE',
      pathRuleId: 'greenhouse-application-v3',
    });
    expect(v1.ok && v1.value.vendor).toBe('greenhouse');
    expect(v3.ok && v3.value.vendor).toBe('greenhouse');
    expect(v1.ok && v3.ok && v1.value.adapter).toBe(v3.ok && v3.value.adapter);

    expect(
      resolveRuntimeApplyAdapter(created.value, {
        atsProvider: 'GREENHOUSE',
        pathRuleId: 'greenhouse-application-v2',
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_RULES_MAPPING_NOT_FOUND' });
    expect(
      resolveRuntimeApplyAdapter(created.value, {
        atsProvider: 'greenhouse',
        pathRuleId: 'greenhouse-application-v1',
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_RULES_MAPPING_NOT_FOUND' });
  });

  it('keeps INDEED_APPLY unavailable, resolves Workday remotely, and has no Avature/static fallback', async () => {
    const created = await createRuntimeApplyRegistry(await builtRelease());
    if (!created.ok) throw new Error(created.code);

    expect(
      resolveRuntimeApplyAdapter(created.value, {
        atsProvider: 'INDEED_APPLY',
        pathRuleId: 'indeed-apply-v1',
      }),
    ).toEqual({ ok: false, code: 'RUNTIME_RULES_PROVIDER_UNAVAILABLE' });
    const releasedVendors = [...created.value.mappings.values()].map(({ vendor }) => vendor as string);
    expect(
      resolveRuntimeApplyAdapter(created.value, {
        atsProvider: 'WORKDAY',
        pathRuleId: 'workday-application-v1',
      }),
    ).toMatchObject({ ok: true, value: { vendor: 'workday' } });
    expect(releasedVendors).not.toContain('avature');

    const emptyRelease: ApplyRulesReleaseV1 = {
      ...(await builtRelease()),
      mappings: [],
      rulesets: [],
    };
    const empty = await createRuntimeApplyRegistry(emptyRelease);
    expect(empty).toEqual({ ok: false, code: 'RUNTIME_RULES_MALFORMED' });
  });

  it('rejects incomplete, annotated, vendor-drifted, and digest-drifted releases as a whole', async () => {
    const release = await builtRelease();
    const cases: Array<[string, ApplyRulesReleaseV1, string]> = [];

    cases.push([
      'missing ruleset',
      { ...release, rulesets: release.rulesets.slice(1) },
      'RUNTIME_RULES_MAPPING_MISMATCH',
    ]);

    const annotated: ApplyRulesReleaseV1 = {
      ...release,
      rulesets: release.rulesets.map((ruleset, index) =>
        index === 0
          ? { ...ruleset, ruleset: { ...ruleset.ruleset, '$comment.remote': 'must not ship' } }
          : ruleset,
      ),
    };
    cases.push(['annotation leaked', annotated, 'RUNTIME_RULES_ANNOTATION_PRESENT']);

    const vendorDrift: ApplyRulesReleaseV1 = {
      ...release,
      mappings: release.mappings.map((mapping, index) =>
        index === 0 ? { ...mapping, vendor: 'lever' } : mapping,
      ),
    };
    cases.push(['vendor drift', vendorDrift, 'RUNTIME_RULES_MAPPING_MISMATCH']);

    const digestDrift: ApplyRulesReleaseV1 = {
      ...release,
      rulesets: release.rulesets.map((ruleset, index) =>
        index === 0
          ? {
              ...ruleset,
              digest: `sha256:${'0'.repeat(64)}` as ApplyRulesReleaseV1['releaseDigest'],
            }
          : ruleset,
      ),
    };
    cases.push(['ruleset digest drift', digestDrift, 'RUNTIME_RULESET_DIGEST_MISMATCH']);

    for (const [label, candidate, code] of cases) {
      const result = await createRuntimeApplyRegistry(candidate);
      expect(result, label).toEqual({ ok: false, code });
    }
  });
});
