import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { configureStaticWeb } from '../src/static-web.ts';
import { configurePlatformHttp } from '../src/http-policy.ts';
import { readConfig } from '../src/config.ts';

test('PWA worker and HTML revalidate while manifest, PNG and fingerprinted assets retain distinct MIME/cache policies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-pwa-static-'));
  const html = '<!doctype html><html><body>Synthetic PWA shell</body></html>';
  const app = Fastify({ logger: false });
  try {
    await fs.mkdir(path.join(root, 'assets'));
    await Promise.all([
      fs.writeFile(path.join(root, 'index.html'), html),
      fs.writeFile(path.join(root, 'sw.js'), '/* Synthetic worker fixture. */'),
      fs.writeFile(path.join(root, 'manifest.webmanifest'), '{"name":"Synthetic PWA"}'),
      fs.writeFile(path.join(root, 'icon-192.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      fs.writeFile(path.join(root, 'assets', 'app-abcdefgh.js'), '/* Synthetic fingerprinted asset. */'),
    ]);
    await configurePlatformHttp(app, readConfig({}));
    app.get('/api/platform/private-fixture', async (_request, reply) => reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Synthetic sign-in boundary.' } }));
    await configureStaticWeb(app, root);
    for (const url of ['/', '/index.html', '/sw.js']) {
      const result = await app.inject({ url, headers: { accept: 'text/html' } });
      assert.equal(result.statusCode, 200, result.body); assert.equal(result.headers['cache-control'], 'no-cache');
      assert.equal(result.headers['x-content-type-options'], 'nosniff'); assert.ok(result.headers.etag);
      assert.equal(result.headers['x-frame-options'], 'DENY');
      assert.equal(result.headers['referrer-policy'], 'no-referrer');
      assert.match(String(result.headers['content-security-policy']), /frame-ancestors 'none'/);
      const conditional = await app.inject({ url, headers: { accept: 'text/html', 'if-none-match': String(result.headers.etag) } });
      assert.equal(conditional.statusCode, 304); assert.equal(conditional.body, ''); assert.equal(conditional.headers['cache-control'], 'no-cache');
      assert.equal(conditional.headers['content-security-policy'], result.headers['content-security-policy']);
    }
    assert.match(String((await app.inject({ url: '/sw.js' })).headers['content-type']), /javascript/);
    for (const [url, mime] of [['/manifest.webmanifest', /application\/manifest\+json/], ['/icon-192.png', /image\/png/]] as const) {
      const result = await app.inject({ url }); assert.equal(result.statusCode, 200, result.body);
      assert.match(String(result.headers['content-type']), mime); assert.equal(result.headers['cache-control'], 'public, max-age=0, must-revalidate');
      const head = await app.inject({ method: 'HEAD', url }); assert.equal(head.statusCode, 200); assert.equal(head.body, '');
    }
    const asset = await app.inject({ url: '/assets/app-abcdefgh.js' });
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    const privateRoute = await app.inject({ url: '/api/platform/private-fixture', headers: { accept: 'text/html' } });
    assert.equal(privateRoute.statusCode, 401); assert.equal(privateRoute.headers['cache-control'], 'private, no-store');
    for (const url of ['/api', '/api/token?token=synthetic-only', '/api/platform/auth/token?token=synthetic-only', '/assets/missing.js']) {
      const missing = await app.inject({ url, headers: { accept: 'text/html' } });
      assert.equal(missing.statusCode, 404, url); assert.equal(missing.json().error.code, 'NOT_FOUND');
      assert.equal(missing.headers['cache-control'], 'no-store'); assert.doesNotMatch(missing.body, /Synthetic PWA shell/);
    }
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});
