/**
 * ATS lab vendor attribution (VIBE_DIST=ats-lab only).
 *
 * Production attributes a vendor only through the backend's exact
 * `(atsProvider, pathRuleId)` mapping. The lab has no backend, so it keeps a
 * small explicit host table for the vendors whose local catalog is empty
 * (Rippling, Dover, Jobvite, iCIMS) on top of `detectApplyVendor`. Host and
 * page vetoes still run through the kernel gate.
 */

import { ADAPTERS } from '@edaix/apply-kernel/bundledAdapters';
import { detectApplyVendor } from '@edaix/apply-kernel/vendors';
import { workdayAdapter } from '@edaix/apply-kernel/sites/workday';
import {
  createRuntimeApplyRegistry,
  resolveRuntimeApplyAdapter,
  type ResolvedRuntimeApplyAdapter,
} from '@edaix/apply-kernel/runtimeRegistry';
import type { ApplyVendor, VendorAdapter } from '@edaix/apply-kernel/contracts';
import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';

const LAB_EXACT_HOSTS: Readonly<Record<string, ApplyVendor>> = Object.freeze({
  'ats.rippling.com': 'rippling',
  'app.dover.com': 'dover',
  'jobs.jobvite.com': 'jobvite',
});

export function labVendorForHost(hostname: string): ApplyVendor | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const exact = detectApplyVendor(host);
  if (exact !== null) return exact;
  const labExact = LAB_EXACT_HOSTS[host];
  if (labExact !== undefined) return labExact;
  // Per-tenant iCIMS subdomains: careers-<company>.icims.com, <region>.icims.com.
  if (host.endsWith('.icims.com') && host !== 'www.icims.com') return 'icims';
  return null;
}

/** Compiled adapter for the lab: the registry's, or the Workday scaffold the registry keeps null. */
export function labAdapterFor(vendor: ApplyVendor): VendorAdapter | null {
  if (vendor === 'workday') return workdayAdapter;
  return ADAPTERS[vendor];
}

/** The generic lane's exact mapping in the checked-in release (`release-manifest.json`). */
const GENERIC_MAPPING_TARGET = Object.freeze({ atsProvider: 'GENERIC', pathRuleId: 'generic-application-v1' });

let genericMapping: Promise<ResolvedRuntimeApplyAdapter | null> | null = null;

/**
 * The generic lane (company-built forms: neither the host table nor a vendor
 * fingerprint answers — `pageVendor`'s third layer in `lib/autofillDockDecision.ts`).
 *
 * `ADAPTERS.generic` is null on purpose and stays null (bundledAdapters.ts): a
 * bundled generic adapter would be a local entry that skips the backend's vendor
 * allowlist. So the lab compiles it the way production does — a verified runtime
 * release, then the exact GENERIC mapping — from this repo's checked-in release
 * (the one argoland publishes once it has synced). Only lab builds reach this module.
 */
export function labGenericMapping(): Promise<ResolvedRuntimeApplyAdapter | null> {
  genericMapping ??= createRuntimeApplyRegistry(APPLY_RULES_RUNTIME_RELEASE_V1).then((registry) => {
    if (!registry.ok) return null;
    const resolved = resolveRuntimeApplyAdapter(registry.value, GENERIC_MAPPING_TARGET);
    return resolved.ok ? resolved.value : null;
  });
  return genericMapping;
}

/**
 * That ruleset's own `excludeWithin`, read from the same release rather than copied:
 * the lab's generic diagnostics build extra scan roots (each `<form>`, the body) with it.
 */
export function labGenericExcludeWithin(mapping: ResolvedRuntimeApplyAdapter): readonly string[] {
  const entry = APPLY_RULES_RUNTIME_RELEASE_V1.rulesets.find((ruleset) => ruleset.version === mapping.rulesetVersion);
  const value = entry?.ruleset['excludeWithin'];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
