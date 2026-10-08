import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationRoute, applicationHref } from '../src/career-application-route.ts';
const id = 'ABCDEF01-2345-6789-ABCD-0123456789AB';
test('documented application links select exactly the requested normalized ID', () => {
  assert.deepEqual(applicationRoute('/journey/applications'), { kind: 'list' });
  const href = applicationHref(id);
  assert.equal(href, '/journey/applications/' + id.toLowerCase());
  assert.deepEqual(applicationRoute('/journey/applications/' + id), { kind: 'detail', id: id.toLowerCase() });
});
test('malformed application deep links stay a missing object, not another page or list', () => {
  for (const suffix of ['', 'other-user', '../stories', id + '/edit', id + '?m=x', '%2e%2e', '%2F' + id]) {
    assert.deepEqual(applicationRoute('/journey/applications/' + suffix), { kind: 'missing' });
    assert.throws(() => applicationHref(suffix));
  }
  for (const path of ['/', '/journey/stories/' + id, '/journey/applications-other', 'https://example.invalid/journey/applications/' + id]) assert.equal(applicationRoute(path), null);
});
