/** Synthetic v3 source, recomputing all three digest layers. NON_ACCEPTANCE / NOT_RELEASED. */
import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../packages/apply-rules/runtime-release';
import { digestApplyRulesJson } from '../../packages/apply-kernel/src/runtimeRegistry';
import { canonicalizeExecutionRuntimeJsonV1, type ExecutionRuntimeBundleV1 } from '../../packages/contracts/src/executionRuntime';
import { createBackgroundExecutionRuntimeAuthority } from '../../apps/extension/lib/executionRuntimeAuthority';

export async function syntheticWizardRuntime(now: number) {
  const rulesets = await Promise.all(APPLY_RULES_RUNTIME_RELEASE_V1.rulesets.map(async (entry) => {
    if (entry.ruleset.vendor !== 'greenhouse') return entry;
    const ruleset = { ...entry.ruleset, schemaVersion: 3, wizard: {
      schemaVersion: 1, wizardKey: 'synthetic-local-wizard', applicationRootSelector: '#application', indicatorContainerSelector: '#steps',
      steps: [0, 1, 2].map((index) => ({ stepKey: `step-${index}`, indicatorSelector: `#step-${index}` })),
    } };
    return { ...entry, ruleset, digest: await digestApplyRulesJson(ruleset) };
  }));
  const mappings = APPLY_RULES_RUNTIME_RELEASE_V1.mappings.map((mapping) => ({ ...mapping,
    rulesetDigest: rulesets.find((entry) => entry.version === mapping.rulesetVersion)!.digest }));
  const release = { releaseVersion: APPLY_RULES_RUNTIME_RELEASE_V1.releaseVersion, mappings, rulesets };
  const content = { schemaVersion: 1, releaseRevision: '7',
    issuedAt: new Date(now - 2_000).toISOString(), notBefore: new Date(now - 1_000).toISOString(),
    freshUntil: new Date(now + 60_000).toISOString(), notAfter: new Date(now + 120_000).toISOString(),
    compatibility: { minExtensionVersion: '0.0.0', rulesSchemaVersion: 3, contractVersion: 1 },
    policy: { version: 'synthetic-readonly-v1', killSwitchVersion: '7', enabled: true, automationLevelCeiling: 'L0_PREVIEW_ONLY',
      allowedActions: [], allowedFieldKeys: ['firstName'],
      vendors: { greenhouse: true, lever: false, ashby: false, workable: false, workday: false, icims: false,
        smartrecruiters: false, bamboohr: false, avature: false },
      capabilities: { 'set-text': false, 'set-select': false, 'set-combobox': false, 'set-file': false, 'set-attestation': false },
      minConfidence: 0.7, inferredRequiresConfirm: true, deniedHostSuffixes: [] },
    rules: { ...release, releaseDigest: await digestApplyRulesJson(release) } };
  const bundle = { ...content, runtimeBundleVersion: `rb1_${(await digestApplyRulesJson(content)).slice(7)}` } as unknown as ExecutionRuntimeBundleV1;
  const canonical = canonicalizeExecutionRuntimeJsonV1(bundle);
  if (!canonical.ok) throw new Error(canonical.code);
  const authorized = await createBackgroundExecutionRuntimeAuthority({ client: { refresh: async () => ({
    ok: true, source: 'NETWORK', etag: `"${bundle.runtimeBundleVersion}"`, bundle,
  }) } }).authorizeDiscovery({ atsProvider: 'GREENHOUSE', pathRuleId: 'greenhouse-application-v1' });
  if (!authorized.ok) throw new Error(authorized.code);
  return Object.freeze({ authorization: authorized.value, stored: Object.freeze({ schemaVersion: 1,
    etag: `"${bundle.runtimeBundleVersion}"`, runtimeBundleVersion: bundle.runtimeBundleVersion,
    releaseRevision: bundle.releaseRevision, rawBody: canonical.value }) });
}
