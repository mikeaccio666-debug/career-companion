/** Routes identify records; the authenticated API remains the ownership check. */
export type ApplicationRoute = { readonly kind: 'list' } | { readonly kind: 'detail'; readonly id: string } | { readonly kind: 'missing' };
const root = '/journey/applications';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function applicationRoute(pathname: string): ApplicationRoute | null {
  if (pathname === root) return { kind: 'list' };
  if (!pathname.startsWith(root + '/')) return null;
  const id = pathname.slice(root.length + 1);
  return uuid.test(id) ? { kind: 'detail', id: id.toLowerCase() } : { kind: 'missing' };
}
export function applicationHref(id: string): string {
  if (!uuid.test(id)) throw Error('无法打开这份投递记录。');
  return root + '/' + id.toLowerCase();
}
