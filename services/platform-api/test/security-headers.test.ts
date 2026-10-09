import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { readConfig } from '../src/config.ts';
import { platformSecurityHeaders, readWebApiOrigin } from '../src/security-headers.ts';
import { configurePlatformHttp } from '../src/http-policy.ts';
import { SseTurnSink } from '../src/turn-sinks.ts';

const origin = 'https://app.example.invalid';
const production = () => ({ ...readConfig({}), secureCookies: true, allowedOrigins: new Set([origin]) });
function headers(value: Record<string, unknown>, tls: boolean) {
  assert.equal(value['x-content-type-options'], 'nosniff');
  assert.equal(value['x-frame-options'], 'DENY');
  assert.equal(value['referrer-policy'], 'no-referrer');
  assert.equal(value['permissions-policy'], 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
  assert.equal(value['strict-transport-security'], tls ? 'max-age=15552000' : undefined);
}

test('API origins are exact deployment configuration, with no policy injection or private value echo', () => {
  assert.equal(readConfig({}).webApiOrigin, undefined);
  assert.equal(readConfig({ PLATFORM_WEB_API_ORIGIN: '' }).webApiOrigin, undefined);
  for (const value of ['https://api.example.invalid', 'https://api.example.invalid:8443']) {
    assert.equal(readWebApiOrigin(value, true), value);
    assert.equal(readConfig({ PLATFORM_WEB_API_ORIGIN: value }).webApiOrigin, value);
  }
  for (const value of ['http://localhost:4320', 'http://127.0.0.1:4320', 'http://[::1]:4320']) {
    assert.equal(readWebApiOrigin(value, false), value);
    assert.throws(() => readWebApiOrigin(value, true));
  }
  for (const value of [' ', 'https://api.example.invalid/', 'https://api.example.invalid/path',
    'https://user:fictional-secret@api.example.invalid', 'https://api.example.invalid?fictional-secret',
    'https://api.example.invalid#fictional-secret', 'https://*.example.invalid', 'https://evil;script-src.example.invalid',
    'https://api.example.invalid\n', 'http://localhost.example.invalid', 'data:fictional-secret',
    "https://api.example.invalid; script-src *", 'https://api.example.invalid\\fictional-secret']) {
    assert.throws(() => readWebApiOrigin(value, false), error => error instanceof Error
      && error.message === 'PLATFORM_WEB_API_ORIGIN must be an exact HTTPS origin (HTTP loopback is allowed only outside production).'
      && !Object.hasOwn(error, 'cause'));
  }
});

test('document policy permits only built assets, actual configured API and explicitly routed realtime negotiation', () => {
  const config = production(), base = platformSecurityHeaders(config), csp = base['Content-Security-Policy'];
  for (const directive of ["default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "worker-src 'self'", "connect-src 'self'"]) assert(csp.split('; ').includes(directive));
  assert(!csp.includes('unsafe-inline')); assert(!csp.includes('unsafe-eval')); assert(!csp.includes(origin));
  assert(!csp.includes('report-uri')); assert(!csp.includes('report-to')); assert(Object.isFrozen(base));
  assert(!base['Strict-Transport-Security'].includes('includeSubDomains'));
  const split = platformSecurityHeaders({ ...config, webApiOrigin: 'https://api.example.invalid',
    modelRoutes: {realtime: {provider: 'openai'}} })['Content-Security-Policy'];
  assert(split.includes("connect-src 'self' https://api.example.invalid https://api.openai.com/v1/realtime/calls"));
  assert(split.includes("img-src 'self' https://api.example.invalid data: blob:"));
  assert(split.includes("media-src 'self' https://api.example.invalid blob:"));
  assert(!split.includes('https://api.openai.com;'));
  assert(!platformSecurityHeaders({ ...config, modelRoutes: {chat: {provider: 'openai'}} })['Content-Security-Policy'].includes('api.openai.com'));
});

test('headers survive errors, preflight and private sandbox responses without trusting request origins or forwarded TLS', async () => {
  for (const tls of [false, true]) {
    const app = Fastify({logger: false});
    try {
      await configurePlatformHttp(app, {...production(), secureCookies: tls});
      app.get('/api/platform/fixture', async () => ({ok: true}));
      app.get('/api/platform/failure', async () => {throw new Error('Fictional error');});
      app.get('/api/platform/private-document', async (_request, reply) =>
        reply.header('Content-Security-Policy', "default-src 'none'; sandbox").type('application/octet-stream').send('fictional'));
      for (const [url, status] of [['/api/platform/fixture', 200], ['/api/platform/failure', 500], ['/missing', 404]] as const) {
        const response = await app.inject({url, headers: {origin: 'https://untrusted.example.invalid', 'x-forwarded-proto':'https', host:'untrusted.example.invalid'}});
        assert.equal(response.statusCode, status); headers(response.headers, tls);
        assert(!String(response.headers['content-security-policy']).includes('untrusted'));
        if (url.startsWith('/api/')) assert.equal(response.headers['cache-control'], 'private, no-store');
      }
      const preflight = await app.inject({method:'OPTIONS', url:'/api/platform/fixture',
        headers: {origin, 'access-control-request-method':'GET', 'access-control-request-headers':'x-companion-account'}});
      assert.equal(preflight.statusCode, 204); headers(preflight.headers, tls);
      assert.equal(preflight.headers['access-control-allow-origin'], origin);
      assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
      const privateDocument = await app.inject({url:'/api/platform/private-document'});
      headers(privateDocument.headers, tls);
      assert.equal(privateDocument.headers['content-security-policy'], "default-src 'none'; sandbox");
    } finally { await app.close(); }
  }
});

test('real hijacked SSE retains security and CORS headers and flushes before the turn finishes', async () => {
  const app = Fastify({logger: false});
  let release!: () => void;
  const finish = new Promise<void>(resolve => {release = resolve;});
  try {
    await configurePlatformHttp(app, production());
    app.get('/api/platform/stream-fixture', async (request, reply) => {
      const sink = new SseTurnSink(request, reply);
      sink.open({cancel: release, heartbeat() {}});
      try { sink.emit('delta', {text:'Fictional stream'}); await finish; sink.emit('done', {}); }
      finally {sink.settle(); sink.close();}
    });
    const address = await app.listen({host:'127.0.0.1',port:0});
    const response = await fetch(address + '/api/platform/stream-fixture', {headers:{origin}, signal:AbortSignal.timeout(5000)});
    assert.equal(response.status, 200); headers(Object.fromEntries(response.headers.entries()), true);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const reader = response.body!.getReader(), first = await reader.read();
    assert.equal(first.done, false); assert.match(new TextDecoder().decode(first.value), /Fictional stream/);
    release();
    let tail = ''; for (;;) {const next = await reader.read(); if(next.done) break; tail += new TextDecoder().decode(next.value);}
    assert.match(tail, /event: done/);
  } finally {release(); await app.close();}
});
