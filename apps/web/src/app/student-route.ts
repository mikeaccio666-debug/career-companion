/** Page identity only. The account gate and each API still enforce access.
 * Unmigrated chat routes remain with the existing app until the engine gate passes. */
export type StudentPage = 'journey' | 'pending' | 'stories' | 'interviews' | 'applications'
  | 'jobs' | 'targets' | 'mentors' | 'profile' | 'companion' | 'memory' | 'me';
export type StudentRoute =
  | { kind: 'page'; page: StudentPage; id?: string }
  | { kind: 'source'; pathname: string }
  | { kind: 'missing'; returnHref: '/journey' | '/pending' | '/me'; returnLabel: string };
const pages: Readonly<Record<string, StudentPage>> = Object.freeze({
  '/journey': 'journey', '/pending': 'pending', '/journey/stories': 'stories',
  '/journey/interviews': 'interviews', '/journey/applications': 'applications',
  '/journey/jobs': 'jobs', '/journey/targets': 'targets',
  '/me/mentors': 'mentors', '/community/mentors': 'mentors', '/me/profile': 'profile',
  '/me/companion': 'companion', '/me/memory': 'memory', '/me': 'me',
});
const details = [['/pending', 'pending'], ['/journey/stories', 'stories'],
  ['/journey/interviews', 'interviews'], ['/journey/applications', 'applications']] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function studentRoute(pathname: string): StudentRoute | null {
  // Do not decode arbitrary paths, accept encoded slashes or echo paths into UI.
  const page = Object.hasOwn(pages, pathname) ? pages[pathname] : undefined;
  if (page) return { kind: 'page', page };
  for (const [base, detail] of details) {
    if (!pathname.startsWith(base + '/')) continue;
    const id = pathname.slice(base.length + 1);
    if (uuid.test(id)) return { kind: 'page', page: detail, id: id.toLowerCase() };
    return detail === 'pending'
      ? { kind: 'missing', returnHref: '/pending', returnLabel: '回到待确认' }
      : { kind: 'missing', returnHref: '/journey', returnLabel: '回到旅程' };
  }
  // Source parsing stays with its domain client; invalid references render its
  // existing unavailable view, and are never passed through to ordinary chat.
  if (pathname.startsWith('/sources/org/')) return { kind: 'source', pathname };
  return null;
}
