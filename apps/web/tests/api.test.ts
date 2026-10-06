import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ApiError, createPlatformClient, type StreamEvent } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';

test('the production request client applies the configured origin and credential policy and preserves supplied headers', async () => {
  let calls = 0;
  const client = createPlatformClient(createPlatformEndpoints('https://api.example.test'), async (input, init) => {
    calls++;
    assert.equal(input, 'https://api.example.test/api/platform/jobs');
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{"prompt":"Fictional project."}');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Content-Type'), 'application/json'); assert.equal(headers.get('X-Fictional'), 'fixture');
    return Response.json({ job: { id: 'fictional-job' } });
  });
  assert.deepEqual(await client.request('/jobs', { method: 'POST', headers: { 'X-Fictional': 'fixture' }, body: '{"prompt":"Fictional project."}', credentials: 'omit', redirect: 'follow' }), { job: { id: 'fictional-job' } });
  assert.equal(calls, 1);
});

test('the default client makes no implicit remote connection and malformed paths are rejected before transport', async () => {
  let calls = 0;
  const client = createPlatformClient(createPlatformEndpoints(), async (input) => {
    calls++; assert.equal(input, '/api/platform/auth/me'); return Response.json({ user: null });
  });
  assert.deepEqual(await client.request('/auth/me'), { user: null });
  for (const path of ['https://attacker.example.test', '//attacker.example.test', '/%2e%2e/private']) await assert.rejects(client.request(path), /请求路径无效/);
  assert.equal(calls, 1);
});

test('the actual separate API client omits no-body content headers while preserving JSON, multipart and fragmented UTF-8 SSE', async () => {
  let multipart = '', contentType = '', uploadPath = '', streamBody = '', jsonBody = '';
  const seenHeaders: Array<{ method: string | undefined; contentType: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/platform/auth/me') {
      seenHeaders.push({ method: request.method, contentType: request.headers['content-type'] });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"user":null}'); return;
    }
    if (request.url === '/api/platform/jobs') {
      seenHeaders.push({ method: request.method, contentType: request.headers['content-type'] });
      for await (const chunk of request) jsonBody += chunk.toString();
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"job":{"id":"fictional-job"}}'); return;
    }
    if (request.url === '/api/platform/uploads') {
      uploadPath = request.url; contentType = request.headers['content-type'] || '';
      for await (const chunk of request) multipart += chunk.toString();
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"upload":{"id":"fictional-upload"}}');
      return;
    }
    if (request.url === '/api/platform/conversations/fictional-conversation/messages') {
      assert.equal(request.method, 'POST'); assert.equal(request.headers.accept, 'text/event-stream');
      for await (const chunk of request) streamBody += chunk.toString();
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bytes = Buffer.from('event: delta\r\ndata: {"text":"虚构回复"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n');
      for (const byte of bytes) response.write(Buffer.from([byte]));
      response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const endpoints = createPlatformEndpoints(`http://127.0.0.1:${address.port}`);
    const client = createPlatformClient(endpoints);
    assert.deepEqual(await client.request('/auth/me'), { user: null });
    assert.equal(await client.request('/auth/me', { method: 'HEAD' }), null);
    assert.deepEqual(await client.request('/auth/me', { headers: { 'Content-Type': 'text/plain' } }), { user: null });
    assert.deepEqual(await client.request('/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'Fictional project.' }) }), { job: { id: 'fictional-job' } });
    assert.deepEqual(seenHeaders, [{ method: 'GET', contentType: undefined }, { method: 'HEAD', contentType: undefined }, { method: 'GET', contentType: 'text/plain' }, { method: 'POST', contentType: 'application/json' }]);
    assert.deepEqual(JSON.parse(jsonBody), { prompt: 'Fictional project.' });
    const form = new FormData(); form.append('file', new File(['Fictional attachment bytes.'], 'fixture.txt', { type: 'text/plain' }));
    assert.deepEqual(await client.request('/uploads', { method: 'POST', body: form }), { upload: { id: 'fictional-upload' } });
    assert.equal(uploadPath, '/api/platform/uploads'); assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(multipart, /name="file"; filename="fixture.txt"/); assert.match(multipart, /Fictional attachment bytes\./);
    const events: StreamEvent[] = [];
    await client.streamMessage('fictional-conversation', { content: 'Fictional prompt.', provider: 'fixture' }, new AbortController().signal, event => events.push(event));
    assert.deepEqual(events, [{ event: 'delta', data: { text: '虚构回复' } }, { event: 'done', data: {} }]);
    assert.deepEqual(JSON.parse(streamBody), { content: 'Fictional prompt.', provider: 'fixture' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('multipart boundaries remain browser-owned and a canceled request retains its abort signal and error', async () => {
  const controller = new AbortController(); const form = new FormData(); form.append('provider', 'fixture');
  const client = createPlatformClient(createPlatformEndpoints('https://api.example.test'), async (_, init) => {
    assert.equal(init?.body, form); assert.equal(new Headers(init?.headers).has('Content-Type'), false);
    assert.equal(init?.signal, controller.signal);
    controller.abort(); throw new DOMException('Fixture canceled.', 'AbortError');
  });
  await assert.rejects(client.request('/voice/transcribe', { method: 'POST', body: form, signal: controller.signal }), { name: 'AbortError' });
});

test('HTTP error attribution is preserved and connection errors contain no URL or sensitive provider details', async () => {
  const endpoints = createPlatformEndpoints('https://api.example.test');
  const unauthorized = createPlatformClient(endpoints, async () => Response.json({ error: { code: 'AUTH_REQUIRED', message: '请登录。' } }, { status: 401 }));
  await assert.rejects(unauthorized.request('/auth/me'), error => error instanceof ApiError && error.status === 401 && error.code === 'AUTH_REQUIRED' && error.message === '请登录。');
  const failed = createPlatformClient(endpoints, async () => { throw new TypeError('https://fictional-user:fictional-secret@example.test'); });
  await assert.rejects(failed.request('/jobs'), error => error instanceof ApiError && /无法连接工作台 API/.test(error.message) && !error.message.includes('fictional-secret'));
});

test('SSE uses configured credentials, abort signal and endpoint while parsing chunk boundaries and completion', async () => {
  const controller = new AbortController(); const events: StreamEvent[] = [];
  const chunks = ['event: delta\r', '\ndata: {"text":"fixture"}\r\n\r', '\nevent: done\ndata: [DONE]'];
  const client = createPlatformClient(createPlatformEndpoints('https://api.example.test'), async (input, init) => {
    assert.equal(input, 'https://api.example.test/api/platform/conversations/fictional-id/messages');
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error'); assert.equal(init?.signal, controller.signal);
    assert.equal(new Headers(init?.headers).get('Accept'), 'text/event-stream');
    return new Response(new ReadableStream({ start(stream) { for (const chunk of chunks) stream.enqueue(new TextEncoder().encode(chunk)); stream.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await client.streamMessage('fictional-id', { content: 'Fixture.' }, controller.signal, event => events.push(event));
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'fixture' } }, { event: 'done', data: {} }]);
});

test('SSE distinguishes HTTP rejection, early EOF and a genuine terminal error event', async () => {
  const signal = new AbortController().signal, endpoints = createPlatformEndpoints();
  const malformed = createPlatformClient(endpoints, async () => Response.json(null, { status: 403 }));
  await assert.rejects(malformed.streamMessage('fixture', {}, signal, () => {}), error => error instanceof ApiError && error.status === 403);
  const incomplete = createPlatformClient(endpoints, async () => new Response('event: delta\ndata: {"text":"partial"}\n\n'));
  const partial: StreamEvent[] = [];
  await assert.rejects(incomplete.streamMessage('fixture', {}, signal, event => partial.push(event)), /连接提前结束/);
  assert.deepEqual(partial, [{ event: 'delta', data: { text: 'partial' } }]);
  const failed = createPlatformClient(endpoints, async () => new Response('event: error\ndata: {"code":"FIXTURE_ERROR"}\n\n'));
  const events: StreamEvent[] = [];
  await failed.streamMessage('fixture', {}, signal, event => events.push(event));
  assert.deepEqual(events, [{ event: 'error', data: { code: 'FIXTURE_ERROR' } }]);
});

test('canceling an active SSE request propagates abort and does not invent a completion event', async () => {
  const controller = new AbortController(); const events: StreamEvent[] = [];
  const client = createPlatformClient(createPlatformEndpoints('https://api.example.test'), async (_, init) => {
    assert.equal(init?.signal, controller.signal);
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'));
      init!.signal!.addEventListener('abort', () => stream.error(new DOMException('Canceled.', 'AbortError')), { once: true });
    } }));
  });
  await assert.rejects(client.streamMessage('fixture', {}, controller.signal, event => { events.push(event); controller.abort(); }), { name: 'AbortError' });
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'partial' } }]);
});
