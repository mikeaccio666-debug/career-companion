/**
 * Canonical role catalog wire shape (L1 additive, ported from argoland 2026-09-07).
 * The catalog itself lives in the API; the portal reads it to name roles and the
 * ingestion projection keys role matches by `canonicalRoleKey`.
 */
export type CanonicalRole = Readonly<{
  canonicalRoleKey: string;
  displayName: string;
  active: boolean;
  aliases: readonly string[];
}>;

/** Stable machine identity derived from a canonical display name. */
export function canonicalRoleKeyForDisplayName(displayName: string): string {
  return displayName.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export type CanonicalRoleList = Readonly<{ roles: readonly CanonicalRole[] }>;
