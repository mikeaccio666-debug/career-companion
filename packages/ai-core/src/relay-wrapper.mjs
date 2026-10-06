import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const PREFIX = '@companion-relay-v1 ';
const MAX_FRAME = 1536 * 1024, MAX_REQUEST = 1024 * 1024, CHUNK = 48 * 1024;
let buffer = Buffer.alloc(0), initialized = false, ending = false, server, harness, home, inputBytes = 0, responseBytes = 0;
const active = new Map(), closed = new Set(), sockets = new Set();
let outputBytes = 0, requestCount = 0;
function emit(frame) {
  const line = PREFIX + JSON.stringify({ v: 1, ...frame }) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME) return stop();
  process.stdout.write(line);
}
function validObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value, keys) { return Object.keys(value).every(key => keys.includes(key)); }
function textOutput(stream, data) {
  outputBytes += data.length;
  if (outputBytes > 1024 * 1024) return stop();
  for (let offset = 0; offset < data.length; offset += CHUNK)
    emit({ type: 'harness.output', stream, data: data.subarray(offset, offset + CHUNK).toString('base64') });
}
async function stop(code = 1) {
  if (ending) return; ending = true;
  for (const [id, entry] of active) { emit({ type: 'model.cancel', id }); entry.response.destroy(); }
  active.clear(); harness?.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  emit({ type: 'harness.exit', code });
  process.stdin.destroy(); process.exitCode = code;
}
async function initialize(frame) {
  if (initialized || !onlyKeys(frame, ['v', 'type', 'prompt', 'model', 'command']) || typeof frame.prompt !== 'string' || Buffer.byteLength(frame.prompt) > 72 * 1024 ||
      typeof frame.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(frame.model) || !Array.isArray(frame.command) || !frame.command.length || frame.command.length > 32 ||
      frame.command.some(arg => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0')) || basename(frame.command[0]) !== 'codex') return stop();
  initialized = true;
  server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(request.url) || ending) { response.writeHead(404); response.end(); return; }
    if (active.size >= 2 || requestCount >= 32) { response.writeHead(429); response.end(); return; }
    let body = Buffer.alloc(0);
    try {
      for await (const chunk of request) {
        if (body.length + chunk.length > MAX_REQUEST) { response.writeHead(413); response.end(); return; }
        body = Buffer.concat([body, chunk]);
      }
      const parsed = JSON.parse(body.toString('utf8'));
      if (!validObject(parsed)) { response.writeHead(400); response.end(); return; }
      if (active.size >= 2 || requestCount >= 32) { response.writeHead(429); response.end(); return; }
      const id = randomUUID(); requestCount++;
      const entry = { response, started: false, bytes: 0, timer: setTimeout(() => stop(), 120_000) }; active.set(id, entry);
      response.on('close', () => {
        if (active.get(id) === entry) { active.delete(id); closed.add(id); clearTimeout(entry.timer); emit({ type: 'model.cancel', id }); }
      });
      emit({ type: 'model.request', id, body: parsed });
    } catch { if (!response.destroyed) { response.writeHead(400); response.end(); } }
  });
  server.maxConnections = 12; server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (_request, socket) => socket.destroy()); server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('error', () => stop());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') return stop();
  home = await mkdtemp(join(tmpdir(), 'companion-codex-'));
  const config = `model = ${JSON.stringify(frame.model)}\nmodel_provider = "companion_relay"\napproval_policy = "never"\nweb_search = "disabled"\ncli_auth_credentials_store = "ephemeral"\n[features]\nenable_request_compression = false\nmulti_agent = false\n[history]\npersistence = "none"\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[model_providers.companion_relay]\nname = "Task authorized stdio relay"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nsupports_standalone_web_search = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 120000\n`;
  await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
  emit({ type: 'ready' });
  // This environment contains only nonsecret local process settings. The host never sends an API key.
  harness = spawn(frame.command[0], frame.command.slice(1), { shell: false, cwd: '/workspace/output',
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: home, TMPDIR: tmpdir(), RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
  harness.stdin.on('error', () => {}); harness.on('error', () => stop());
  harness.stdout.on('data', chunk => textOutput('stdout', chunk)); harness.stderr.on('data', chunk => textOutput('stderr', chunk));
  harness.on('close', code => stop(code === 0 ? 0 : 1));
  harness.stdin.end(frame.prompt);
}
function receive(frame) {
  if (!validObject(frame) || frame.v !== 1 || typeof frame.type !== 'string' || ending) return stop();
  if (frame.type === 'start') { void initialize(frame).catch(() => stop()); return; }
  if (!initialized || typeof frame.id !== 'string') return stop();
  // A client may close after its last SSE event before the queued end frame is consumed.
  if (closed.has(frame.id) && ['model.response.start', 'model.response.chunk', 'model.response.end'].includes(frame.type)) return;
  if (!active.has(frame.id)) return stop();
  const entry = active.get(frame.id);
  if (frame.type === 'model.response.start') {
    if (!onlyKeys(frame, ['v', 'type', 'id', 'status', 'contentType']) || entry.started || !Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599 || !['application/json', 'text/event-stream'].includes(frame.contentType)) return stop();
    entry.started = true; entry.response.writeHead(frame.status, { 'content-type': frame.contentType, 'cache-control': 'no-store' }); return;
  }
  if (frame.type === 'model.response.chunk') {
    if (!onlyKeys(frame, ['v', 'type', 'id', 'data']) || !entry.started || typeof frame.data !== 'string' || frame.data.length > CHUNK * 4 / 3 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) return stop();
    const bytes = Buffer.from(frame.data, 'base64'); if (bytes.toString('base64') !== frame.data) return stop();
    entry.bytes += bytes.length; responseBytes += bytes.length;
    if (entry.bytes > 8 * 1024 * 1024 || responseBytes > 32 * 1024 * 1024) return stop();
    entry.response.write(bytes); return;
  }
  if (frame.type === 'model.response.end') {
    if (!onlyKeys(frame, ['v', 'type', 'id']) || !entry.started) return stop();
    active.delete(frame.id); closed.add(frame.id); clearTimeout(entry.timer); entry.response.end(); return;
  }
  return stop();
}
process.stdin.on('data', chunk => {
  if (ending) return;
  try {
    inputBytes += chunk.length; if (inputBytes > 64 * 1024 * 1024) return stop();
    buffer = Buffer.concat([buffer, chunk]); let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      if (newline > MAX_FRAME) return stop();
      const line = buffer.subarray(0, newline).toString('utf8'); buffer = buffer.subarray(newline + 1);
      if (!line.startsWith(PREFIX)) return stop();
      receive(JSON.parse(line.slice(PREFIX.length)));
    }
    if (buffer.length > MAX_FRAME) void stop();
  } catch { void stop(); }
});
process.stdin.on('end', () => { if (!ending) void stop(); });
process.stdin.on('error', () => stop()); process.stdout.on('error', () => stop());
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
setTimeout(() => { if (!initialized) void stop(); }, 10_000).unref();
