/** A window's expected account is an assertion, never authentication or authorization. */
export const PLATFORM_ACCOUNT_HEADER = 'x-companion-account';
/** Native private-file GET/HEAD requests cannot carry custom headers. */
export const PLATFORM_ACCOUNT_QUERY = 'expectedAccount';

export function platformAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
