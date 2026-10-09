import assert from 'node:assert/strict';
import test from 'node:test';
import { studentRoute } from '../src/app/student-route.ts';

const id = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
test('existing student pages retain their exact deep links, including the mentor alias', () => {
  const routes = { '/journey': 'journey', '/pending': 'pending', '/journey/stories': 'stories',
    '/journey/interviews': 'interviews', '/journey/applications': 'applications', '/journey/jobs': 'jobs',
    '/journey/targets': 'targets', '/me/mentors': 'mentors', '/community/mentors': 'mentors',
    '/me/profile': 'profile', '/me/companion': 'companion', '/me/memory': 'memory', '/me': 'me' };
  for (const [path, page] of Object.entries(routes)) assert.deepEqual(studentRoute(path), { kind: 'page', page });
});
test('all four detail families preserve the selected record and normalize mixed-case UUIDs', () => {
  for (const [base, page] of [['/pending', 'pending'], ['/journey/stories', 'stories'],
    ['/journey/interviews', 'interviews'], ['/journey/applications', 'applications']]) {
    assert.deepEqual(studentRoute(base + '/' + id), { kind: 'page', page, id: id.toLowerCase() });
    assert.deepEqual(studentRoute(base + '/' + id.toLowerCase()), studentRoute(base + '/' + id));
  }
});
test('malformed detail URLs cannot silently open a list or ordinary chat', () => {
  for (const base of ['/pending', '/journey/stories', '/journey/interviews', '/journey/applications']) {
    for (const suffix of ['', 'missing', id + '/extra', id + '/', '%2F' + id, id + '%00', '../me', '%3Cscript%3E', id + '?m=x']) {
      const route = studentRoute(base + '/' + suffix);
      assert.equal(route?.kind, 'missing');
      if (route?.kind === 'missing') assert.equal(route.returnHref, base === '/pending' ? '/pending' : '/journey');
      assert.deepEqual(Object.keys(route!).sort(), ['kind', 'returnHref', 'returnLabel']);
    }
  }
});
test('institution source references remain in their domain parser including malformed references', () => {
  for (const pathname of ['/sources/org/' + id + '/1/abc', '/sources/org/%ZZ', '/sources/org/'])
    assert.deepEqual(studentRoute(pathname), { kind: 'source', pathname });
});
test('public, onboarding, internal and not-yet-migrated chat paths stay outside this dispatcher', () => {
  for (const pathname of ['/', '/welcome', '/privacy', '/terms', '/workbench', '/today', '/chats', '/group', '/group/applier', '/pending-extra', '/journey/stories-extra', 'constructor', '__proto__'])
    assert.equal(studentRoute(pathname), null);
});
