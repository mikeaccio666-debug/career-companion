import test from 'node:test';
import assert from 'node:assert/strict';
import { chromiumProfile, sandboxUnavailable } from './prepare-chromium-sandbox.mjs';

test('userns exception attaches only to one exact downloaded Chromium executable', () => {
  for (const directory of ['chrome-linux', 'chrome-linux64']) {
    const executable = `/home/runner/.cache/ms-playwright/chromium-1234/${directory}/chrome`;
    const profile = chromiumProfile(executable);
    assert.match(profile, new RegExp('"' + executable.replaceAll('.', '\\.') + '" flags='));
    assert.match(profile, /\n  userns,\n/);
    assert.equal(profile.includes('*'), false);
  }
});

test('profile rejects wildcards, traversal, symlinks outside the resolved cache and injected rules', () => {
  for (const path of ['/usr/bin/chromium', '/home/runner/.cache/ms-playwright/*/chrome',
    '/home/runner/.cache/ms-playwright/chromium-1234/../chrome-linux64/chrome',
    '/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome" {\n capability,',
    '/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome\n']) {
    assert.throws(() => chromiumProfile(path));
  }
});

test('only recognized sandbox startup failures permit consideration of a profile', () => {
  assert.equal(sandboxUnavailable(new Error('No usable sandbox!')), true);
  assert.equal(sandboxUnavailable(new Error('Failed to move to new namespace: Operation not permitted')), true);
  for (const failure of [new Error('Missing library'), new Error('Timeout 10000ms'), new Error('Unexpected private page data'), 'No usable sandbox', {}]) {
    assert.equal(sandboxUnavailable(failure), false);
  }
});
