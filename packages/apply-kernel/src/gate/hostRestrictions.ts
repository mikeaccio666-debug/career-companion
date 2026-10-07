/** Pure host restrictions shared by browser execution and server rule interpretation. */
export interface HostRestrictionPolicy {
  readonly deniedHostSuffixes: readonly string[];
}

/** Local automation restriction (product/11 §5.1, §6.2), independent of remote policy. */
export const LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES = Object.freeze([
  'linkedin.com',
  // Includes the documented apply.indeed.com and smartapply.indeed.com frames.
  'indeed.com',
] as const);

export function isLocallyAutomationDenied(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** Label-boundary matching: nav.no matches www.nav.no, never notnav.no. */
export function isHostDenied(policy: HostRestrictionPolicy, hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return false;
  // Remote-only or manually constructed projections cannot erase the local rule.
  if (isLocallyAutomationDenied(host)) return true;
  return policy.deniedHostSuffixes.some((raw) => {
    const suffix = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    return suffix !== '' && (host === suffix || host.endsWith(`.${suffix}`));
  });
}
