/**
 * ATS lab apply policy (VIBE_DIST=ats-lab only).
 *
 * Starts from the bundled baseline and widens four things for local
 * experiments: every vendor with a compiled adapter is on (Workday included),
 * `manage-rows` / `set-richtext` are on, the two tier-B bits the mock applicant
 * has data for are on, and expiry is one day from now. The
 * reserved `set-attestation` bit is left untouched: generic minting strips it
 * regardless. The function refuses to run outside a lab build, so no
 * shippable artifact can ever evaluate it.
 */

import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { APPLY_VENDORS, type ApplyVendor } from '@edaix/apply-kernel/contracts';

const LAB_POLICY_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function labApplyPolicy(now: number = Date.now()): ApplyPolicy {
  if (!__VIBE_ATS_LAB__) throw new Error('LAB_POLICY_FORBIDDEN');
  const base = createBundledApplyPolicy();
  const vendors = Object.fromEntries(
    APPLY_VENDORS.map((vendor: ApplyVendor) => [vendor, vendor !== 'avature']),
  ) as Record<ApplyVendor, boolean>;
  return Object.freeze({
    ...base,
    version: 'ats-lab-v1',
    vendors,
    capabilities: {
      ...base.capabilities,
      'set-richtext': true,
      'manage-rows': true,
      // lab 有 mock 的推荐人数据，所以这一位在实验里打开；出厂策略仍是 false。
      'set-other-person': true,
      // 乙档两位：mock 申请人带了 EEO 自选项与一条美国工作授权记录，实验里打开
      // 才能量到这两类题的实际命中率。出厂策略仍是 false——它们要后端按 CAP-AF-024
      // 的发布闸逐用户下发，不是包里带着。
      'set-self-identification': true,
      'set-work-authorization': true,
    },
    notAfter: now + LAB_POLICY_LIFETIME_MS,
  });
}
