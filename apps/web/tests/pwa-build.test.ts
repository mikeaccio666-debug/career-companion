import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { generateSW } from 'workbox-build';
import { PWA_NAVIGATION_ALLOWLIST, PWA_NAVIGATION_DENYLIST, PWA_PUBLIC_FILES, platformPwaOptions, publicPrecacheIntegrity, publicPrecachePath } from '../pwa-build.ts';

const asset = 'assets/index-fixtureA123.js';
const sourceRoot = path.resolve(import.meta.dirname, '..');
async function fixture() {
  const privateRoot = path.resolve(sourceRoot, '../../.local/pwa-build'); await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(privateRoot, 'fixture-'));
  const entries = [];
  for (const relative of [...PWA_PUBLIC_FILES, asset]) {
    const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(relative === 'index.html' ? '<!doctype html><title>Fictional build A</title>' : `Fictional public build file: ${relative}`);
    await writeFile(file, bytes); entries.push({ url: relative, revision: 'fixture-version', size: bytes.length });
  }
  return { directory, entries, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('precache paths exclude private endpoints, parameters, files, media, traversal and external origins', () => {
  for (const value of [...PWA_PUBLIC_FILES, asset, 'assets/style-fixtureA123.css', 'assets/font-fixtureA123.woff2']) assert.equal(publicPrecachePath(value), value);
  for (const value of ['api/platform/auth/me', 'uploads/fictional.wav', 'artifacts/fictional.mp4', 'auth/token.html', 'assets/resume.pdf', 'assets/audio-fixtureA123.mp3', 'assets/index-fixtureA123.js?token=fictional', 'index.html?token=fictional', 'index.html#private', '/index.html', '../index.html', 'assets/../index.html', 'assets/%2e%2e/index.html', 'assets\\index-fixtureA123.js', 'assets/index.js', 'https://example.invalid/index.html', 'manifest.webmanifest?x=1', 'private.json', 'constructor', null]) assert.throws(() => publicPrecachePath(value), /non-public/);
});

test('navigation fallback only handles plain public shell paths and never private/query-bearing navigations', () => {
  const allowed = (value: string) => PWA_NAVIGATION_ALLOWLIST.some((pattern) => pattern.test(value)) && !PWA_NAVIGATION_DENYLIST.some((pattern) => pattern.test(value));
  for (const value of ['/', '/index.html']) assert.equal(allowed(value), true, value);
  for (const value of ['/api/platform/auth/me', '/uploads/fixture', '/artifacts/fixture', '/auth/reset', '/?action=reset_password&token=fictional', '/index.html?token=fictional', '/?utm_source=fixture', '/career', '/index']) assert.equal(allowed(value), false, value);
});

test('every manifest entry carries exact content integrity and changed HTML changes integrity independently of URL/revision', async () => {
  const value = await fixture();
  try {
    const transform = publicPrecacheIntegrity(value.directory), initial = await transform(value.entries);
    assert.equal(initial.manifest.length, value.entries.length);
    for (const entry of initial.manifest) {
      const bytes = await readFile(path.join(value.directory, entry.url));
      assert.equal(entry.integrity, `sha256-${createHash('sha256').update(bytes).digest('base64')}`);
    }
    const original = initial.manifest.find((entry) => entry.url === 'index.html')!;
    await writeFile(path.join(value.directory, 'index.html'), '<!doctype html><title>Fictional build B</title>');
    const changed = (await transform(value.entries)).manifest.find((entry) => entry.url === 'index.html')!;
    assert.equal(changed.url, original.url); assert.equal(changed.revision, original.revision); assert.notEqual(changed.integrity, original.integrity);
  } finally { await value.dispose(); }
});

test('omitted shell/assets, duplicate or injected private manifest entries fail before worker generation', async () => {
  const value = await fixture();
  try {
    const transform = publicPrecacheIntegrity(value.directory);
    await assert.rejects(transform(value.entries.filter((entry) => entry.url !== 'index.html')), /missing/);
    await assert.rejects(transform(value.entries.filter((entry) => entry.url !== asset)), /missing/);
    await assert.rejects(transform([...value.entries, value.entries[0]]), /duplicate/);
    await assert.rejects(transform([...value.entries, { url: 'api/platform/auth/me', revision: null, size: 1 }]), /non-public/);
  } finally { await value.dispose(); }
});

test('symlinks to a build file outside the allowed root cannot become public precache contents', async () => {
  const value = await fixture();
  try {
    const link = path.join(value.directory, 'mark.svg'); await rm(link); await symlink(path.join(value.directory, 'index.html'), link);
    await assert.rejects(publicPrecacheIntegrity(value.directory)(value.entries), /regular build/);
  } finally { await value.dispose(); }
});

test('actual Workbox generation retains every integrity, private-route boundary and waiting lifecycle without runtime caching', async () => {
  const value = await fixture();
  try {
    const options = platformPwaOptions(() => value.directory); assert.equal(options.injectRegister, false); assert.equal(options.registerType, 'prompt');
    const generated = await generateSW({ ...options.workbox, globDirectory: value.directory, swDest: path.join(value.directory, 'sw.js'), mode: 'development' });
    assert.equal(generated.count, value.entries.length); assert.deepEqual(generated.warnings, []);
    const worker = await readFile(path.join(value.directory, 'sw.js'), 'utf8');
    const manifest = JSON.parse(worker.match(/precacheAndRoute\(\s*(\[[\s\S]*?\])\s*,/)![1]);
    assert.equal(manifest.length, value.entries.length);
    for (const entry of manifest) assert.equal(entry.integrity, `sha256-${createHash('sha256').update(await readFile(path.join(value.directory, entry.url))).digest('base64')}`);
    assert.ok(/["']?ignoreURLParametersMatching["']?:\s*\[\]/.test(worker), 'generated route must retain an empty ignored-query list');
    assert.ok(/addEventListener\(['"]message['"],/.test(worker) && /SKIP_WAITING/.test(worker), 'Workbox only permits explicit message-driven takeover');
    assert.equal((worker.match(/self\.skipWaiting\(\)/g) || []).length, 1, 'no unconditional skipWaiting outside the message handler');
    assert.ok(!/clients\.claim\(/.test(worker), 'no forced client claim');
    assert.equal(options.workbox!.runtimeCaching!.length, 0);
    assert.equal(options.workbox!.cleanupOutdatedCaches, false);
  } finally { await value.dispose(); }
});

test('legacy cache cleanup waits for zero same-origin windows including uncontrolled pages and only deletes the exact old product cache', async () => {
  const code = await readFile(path.join(sourceRoot, 'public/pwa-legacy-cleanup.js'), 'utf8');
  for (const windows of [[], [{ id: 'fictional-old-controlled-page' }]]) {
    let activate!: (event: { waitUntil(value: Promise<unknown>): void }) => void;
    const deleted: string[] = []; let pending!: Promise<unknown>;
    vm.runInNewContext(code, { self: { addEventListener(type: string, callback: typeof activate) { assert.equal(type, 'activate'); activate = callback; }, clients: { async matchAll(options: unknown) { assert.equal(JSON.stringify(options), '{"type":"window","includeUncontrolled":true}'); return windows; } } }, caches: { async delete(name: string) { deleted.push(name); return true; } } });
    activate({ waitUntil(value) { pending = value; } }); await pending;
    assert.deepEqual(deleted, windows.length ? [] : ['openfield-shell-v1']);
  }
});

test('public install icons are real correctly sized PNG files and maskable artwork uses its own asset', async () => {
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
    const bytes = await readFile(path.join(sourceRoot, 'public/icons', name));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
  }
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'public/manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.icons.some((entry: any) => entry.src === '/icons/maskable-512.png' && entry.purpose === 'maskable'));
  assert.notDeepEqual(await readFile(path.join(sourceRoot, 'public/icons/icon-512.png')), await readFile(path.join(sourceRoot, 'public/icons/maskable-512.png')));
});
