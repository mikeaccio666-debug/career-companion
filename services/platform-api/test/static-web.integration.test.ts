import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http, { type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { configureStaticWeb } from '../src/static-web.ts';
import { Database } from '../src/database.ts';

const origin = 'http://localhost:4321';
const html = '<!doctype html><html><body>Synthetic production application</body></html>';
const script = 'console.log("Synthetic static asset");';
const runtime: PlatformProviderRuntime = {
  capabilities: () => [],
  async *streamChat() { throw new Error('No model is used by this fixture.'); },
  async executeJob() { throw new Error('No job is executed by this fixture.'); },
  async createVoiceSession() { throw new Error('No voice is used by this fixture.'); },
  async transcribe() { throw new Error('No voice is used by this fixture.'); },
  async speech() { throw new Error('No voice is used by this fixture.'); },
};
const base=readConfig(),schema=`static_web_${randomUUID().replaceAll('-','')}`,url=new URL(base.databaseUrl);
url.searchParams.set('options',`-c search_path=${schema}`);
const admin=new Database(base.databaseUrl),db=new Database(url.toString());
let schemaCreated=false;
let directory: string, root: string, port: number, system: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base.databaseUrl).hostname),'Only a local test database is allowed.');
  await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;await db.migrate();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-static-web-')); root = path.join(directory, 'web');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'index.html'), html), fs.writeFile(path.join(root, 'assets', 'app-abcdefgh.js'), script),
    fs.writeFile(path.join(root, 'assets', 'site.css'), 'body { color: black; }'), fs.writeFile(path.join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_NOT_PUBLIC=true'), fs.writeFile(path.join(root, 'assets', 'app-abcdefgh.js.map'), '{"synthetic":"not public"}'),
    fs.writeFile(path.join(directory, 'outside.js'), 'SYNTHETIC_OUTSIDE_BUILD=true'),
  ]);
  await fs.symlink(path.join(directory, 'outside.js'), path.join(root, 'linked.js'));
  await fs.symlink(directory, path.join(root, 'linked-directory'));
  system = await buildApp({ db, config: {...base,databaseUrl:url.toString(),webStaticDir:root,storageDir:path.join(directory,'blobs'),
    s3:undefined,allowedOrigins:new Set([origin])}, runtime, enableQueue: false });
  // The actual router includes shared public-capability limits, isolated in this fixture's schema.
  await system.app.listen({ host: '127.0.0.1', port: 0 }); port = (system.app.server.address() as AddressInfo).port;
});
after(async () => {
  await system?.app.close();await db.close();
  try {if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);}
  finally {await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});}
});

interface Response { status: number; headers: IncomingHttpHeaders; body: string; }
function request(url: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    // http.request preserves the raw path, including traversal attempts that URL normalizers would remove.
    const pending = http.request({ hostname: '127.0.0.1', port, path: url, method: options.method ?? 'GET', headers: options.headers, agent: false }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    pending.on('error', reject); pending.end();
  });
}
function assertNotFound(response: Response) {
  assert.equal(response.status, 404, response.body); assert.match(String(response.headers['content-type']), /^application\/json/);
  assert.equal(JSON.parse(response.body).error.code, 'NOT_FOUND'); assert.equal(response.headers['cache-control'], 'no-store');
}

test('React navigation serves HTML only for explicit GET HTML requests and never for unknown assets or APIs', async () => {
  for (const url of ['/', '/career/plan', '/career/plan?view=synthetic']) {
    const response = await request(url, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 200, response.body); assert.equal(response.body, html);
    assert.equal(response.headers['cache-control'], 'no-cache'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  for (const accept of ['application/json', '*/*', 'text/html;q=0', 'text/html;q=invalid']) assertNotFound(await request('/unknown', { headers: { accept } }));
  for (const url of ['/assets', '/assets/unknown', '/assets/missing.js', '/missing.css', '/missing.html', '/api', '/api/typo', '/api/platform', '/api/platform/unknown']) {
    assertNotFound(await request(url, { headers: { accept: 'text/html' } }));
  }
  const head = await request('/career/plan', { method: 'HEAD', headers: { accept: 'text/html' } }); assert.equal(head.status, 404); assert.equal(head.body, '');
  assertNotFound(await request('/career/plan', { method: 'POST', headers: { origin, accept: 'text/html' } }));
  const capabilities = await request('/api/platform/capabilities', { headers: { accept: 'text/html' } });
  assert.equal(capabilities.status, 200); assert.deepEqual(JSON.parse(capabilities.body), { capabilities: { chat: false, agent: false, realtime: false, transcription: false, speech: false, image: false, video: false, browser: false, cli: false, workflow: false, mcp: false } });
  const privateFile = await request('/api/platform/artifacts/00000000-0000-4000-8000-000000000000', { headers: { accept: 'text/html' } });
  assert.equal(privateFile.status, 401); assert.equal(JSON.parse(privateFile.body).error.code, 'AUTH_REQUIRED');
});

test('build assets use MIME types, conditional streaming and immutable caching only for fingerprinted assets', async () => {
  const response = await request('/assets/app-abcdefgh.js');
  assert.equal(response.status, 200); assert.equal(response.body, script); assert.match(String(response.headers['content-type']), /javascript/);
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable'); assert.ok(response.headers.etag);
  const conditional = await request('/assets/app-abcdefgh.js', { headers: { 'if-none-match': String(response.headers.etag) } });
  assert.equal(conditional.status, 304); assert.equal(conditional.body, '');
  const head = await request('/assets/app-abcdefgh.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(script));
  const plain = await request('/assets/site.css'); assert.equal(plain.status, 200); assert.equal(plain.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal((await request('/favicon.svg')).status, 200);
  const index = await request('/index.html'); assert.equal(index.status, 200); assert.equal(index.headers['cache-control'], 'no-cache');
});

test('traversal, dotfiles, symlinks, sourcemaps and case aliases cannot expose files or directory redirects', async () => {
  for (const url of ['/../outside.js', '/%2e%2e/outside.js', '/assets/../index.html', '/assets/%2e%2e/index.html', '/%252e%252e/outside.js', '/assets%2fapp-abcdefgh.js', '/assets%5capp-abcdefgh.js', '/.env', '/%2eenv', '/linked.js', '/linked-directory/outside.js', '/assets/app-abcdefgh.js.map', '/ASSETS/app-abcdefgh.js', '/assets/App-abcdefgh.js', '/assets//app-abcdefgh.js']) {
    assertNotFound(await request(url, { headers: { accept: 'text/html' } }));
  }
  // A file changed after boot is rejected instead of exposing an unreviewed replacement.
  await fs.writeFile(path.join(root, 'assets', 'site.css'), 'SYNTHETIC_CHANGED_BUILD=true');
  assertNotFound(await request('/assets/site.css'));
});

test('static serving is opt-in and an invalid or symlinked build index fails startup', async () => {
  const noWeb = await buildApp({ config: readConfig({}), runtime, enableQueue: false });
  try { const response = await noWeb.app.inject({ url: '/', headers: { accept: 'text/html' } }); assert.equal(response.statusCode, 404); assert.match(String(response.headers['content-type']), /application\/json/); }
  finally { await noWeb.app.close(); }
  const invalid = path.join(directory, 'invalid'); await fs.mkdir(invalid); await fs.symlink(path.join(root, 'index.html'), path.join(invalid, 'index.html'));
  for (const supplied of [invalid, path.join(directory, 'missing'), path.join(root, 'linked-directory')]) {
    const app = Fastify();
    try { await assert.rejects(configureStaticWeb(app, supplied), error => error instanceof Error && /PLATFORM_WEB_STATIC_DIR/.test(error.message) && !error.message.includes(directory)); }
    finally { await app.close(); }
  }
});

test('the validated hosted port and loopback host drive the actual HTTP listener', async () => {
  const app = Fastify(); app.get('/synthetic', async () => ({ ok: true }));
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const selectedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const config = readConfig({ PLATFORM_HOST: '127.0.0.1', PORT: String(selectedPort) });
  try {
    await app.listen({ host: config.host, port: config.port });
    assert.equal((app.server.address() as AddressInfo).port, selectedPort);
    assert.equal((app.server.address() as AddressInfo).address, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${selectedPort}/synthetic`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  }
  finally { await app.close(); }
});
