import type { ComboboxSemanticAuthority } from '../contracts';

/**
 * Runtime provenance for a combobox authority compiled from one validated
 * apply-rules descriptor.
 *
 * This module is intentionally not re-exported from the package surface. The
 * interpreter is the sole production minter; runner only receives the
 * predicate. A structurally identical caller-created object therefore remains
 * default-off instead of becoming a host-click capability.
 */
const RULE_OWNED_AUTHORITIES = new WeakSet<object>();

export function sealRuleOwnedComboboxSemanticAuthority(
  authority: ComboboxSemanticAuthority,
): ComboboxSemanticAuthority {
  const sealed = Object.freeze(authority);
  RULE_OWNED_AUTHORITIES.add(sealed);
  return sealed;
}

export function isRuleOwnedComboboxSemanticAuthority(
  authority: unknown,
): authority is ComboboxSemanticAuthority {
  return typeof authority === 'object' &&
    authority !== null &&
    RULE_OWNED_AUTHORITIES.has(authority);
}
