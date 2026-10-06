import {
  APPLY_RULES_RELEASE_MANIFEST_V1,
  APPLY_RULES_RUNTIME_RELEASE_V1,
} from '@edaix/apply-rules/runtime-release';
import { buildApplyRulesRelease } from '@edaix/apply-kernel/runtimeRegistry';

/**
 * Re-prove source interpretation, mappings and digests before exposing rules.
 * These reference bytes are never a runtime policy, signed intent or lease.
 */
export async function readVerifiedRulesRelease() {
  const sources = Object.fromEntries(
    APPLY_RULES_RUNTIME_RELEASE_V1.rulesets.map((entry) => [entry.ruleset.vendor, entry.ruleset]),
  );
  const release = await buildApplyRulesRelease(APPLY_RULES_RELEASE_MANIFEST_V1, sources);
  if (!release.ok) throw new Error(`RULES_REFERENCE_UNAVAILABLE:${release.code}`);
  return Object.freeze({
    schemaVersion: 1 as const,
    referenceOnly: true as const,
    executionEnabled: false as const,
    rules: release.value,
  });
}
