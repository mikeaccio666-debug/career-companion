import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { executeBrowser, executeCli } from '../src/executors.ts';
import { ProviderError } from '../src/errors.ts';
import type { CreateJobInput, JobExecutionContext } from '@companion/platform-contracts';

const browserExecutable = existsSync(chromium.executablePath()) ? chromium.executablePath() :
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;
const job = (kind: 'browser' | 'cli', options?: Record<string, unknown>, prompt = 'Synthetic fixture only'): CreateJobInput => ({ kind, provider: kind, prompt, options });
const context = (directory: string, id = 'fixture-job'): JobExecutionContext => ({ jobId: id, userId: 'synthetic-user', workspaceDirectory: directory });
const errorCode = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code;
async function listening(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('browser is disabled unless explicitly enabled', async () => {
  await assert.rejects(executeBrowser(job('browser', { url: 'https://example.com' }), context(tmpdir()), {}), errorCode('BROWSER_DISABLED'));
});
test('browser rejects private/reserved/metadata and unsupported URL schemes before launch', async () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.169.254',
    'https://100.100.100.200', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[2002:7f00:1::]',
    'https://metadata.google.internal', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com']) {
    await assert.rejects(executeBrowser(job('browser', { url }), context(tmpdir()), { PLATFORM_ENABLE_BROWSER: '1' }), errorCode('BROWSER_ADDRESS_BLOCKED'));
  }
});
test('fixture override accepts exact loopback origins and rejects caller scripts or invalid actions', async () => {
  await assert.rejects(executeBrowser(job('browser', { url: 'http://127.0.0.1' }), context(tmpdir()),
    { PLATFORM_ENABLE_BROWSER: '1', PLATFORM_BROWSER_ALLOWED_ORIGINS: 'http://169.254.169.254' }), errorCode('EXECUTOR_CONFIGURATION'));
  await assert.rejects(executeBrowser(job('browser', { url: 'https://example.com', actions: [{ click: '#submit' }] }), context(tmpdir()),
    { PLATFORM_ENABLE_BROWSER: '1' }), errorCode('INVALID_PROVIDER_INPUT'));
  await assert.rejects(executeBrowser(job('browser', { url: 'https://example.com', script: 'synthetic()' }), context(tmpdir()),
    { PLATFORM_ENABLE_BROWSER: '1' }), errorCode('INVALID_PROVIDER_INPUT'));
});

test('real browser reads synthetic HTML, returns PNG, isolates storage and blocks POST', { skip: !browserExecutable }, async () => {
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') { posts++; response.end('unexpected'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<title>Synthetic career fixture</title><h1>Public fixture heading</h1><p id="state"></p><p id="cookie-state"></p><p id="guard-state"></p><script>
      document.querySelector('#state').textContent=localStorage.getItem('marker') || 'fresh context';
      localStorage.setItem('marker','reused context');
      document.cookie='synthetic=must-not-store';
      document.querySelector('#cookie-state').textContent=document.cookie?'Cookie unexpectedly stored':'Cookie disabled';
      document.querySelector('#guard-state').textContent=window.__companionBrowserGuardReady===true&&Number.isSafeInteger(window.__companionBlockedSubmissions)&&typeof RTCPeerConnection==='undefined'&&typeof WebTransport==='undefined'?'Browser guards ready':'Guard unavailable';
      fetch('/write',{method:'POST',body:'synthetic'}).catch(()=>{});
    </script>`);
  });
  const origin = await listening(server);
  const directory = await mkdtemp(join(tmpdir(), 'companion-browser-fixture-'));
  const hostOrigin = origin.replace('127.0.0.1', 'localhost');
  const env = { PLATFORM_ENABLE_BROWSER: '1', PLATFORM_BROWSER_ALLOWED_ORIGINS: origin + ',' + hostOrigin, PLATFORM_BROWSER_EXECUTABLE: browserExecutable };
  try {
    for (const id of ['one', 'two']) {
      const result = await executeBrowser(job('browser', { url: id === 'one' ? origin : hostOrigin }), context(directory, id), env);
      assert.match(result.text || '', /Public fixture heading/);
      assert.match(result.text || '', /fresh context/);
      assert.match(result.text || '', /Cookie disabled/);
      assert.match(result.text || '', /Browser guards ready/);
      assert.doesNotMatch(result.text || '', /reused context/);
      const screenshot = result.artifacts.find(a => a.mime === 'image/png'); assert.ok(screenshot);
      assert.equal(Buffer.from(screenshot.bytes).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(result.artifacts.some(a => a.name === 'browser-snapshot.txt'));
      const observed = result.artifacts.find(a => a.name === 'browser-observation.json'); assert.ok(observed);
      assert.equal(JSON.parse(Buffer.from(observed.bytes).toString()).provenance,'untrusted_page');
    }
    assert.equal(posts, 0);
  } finally { await close(server); await rm(directory, { recursive: true, force: true }); }
});

test('real browser blocks private redirect and subresources on a different fixture origin', { skip: !browserExecutable }, async () => {
  let forbiddenRequests = 0, forbiddenConnections = 0;
  const target = createServer((_request, response) => { forbiddenRequests++; response.end('private data'); });
  target.on('connection', () => { forbiddenConnections++; });
  const targetOrigin = await listening(target);
  const source = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: targetOrigin }); response.end(); }
    else { response.setHeader('content-type', 'text/html'); response.end(`<link rel="preconnect" href="${targetOrigin}" crossorigin><h1>Allowed fixture</h1><img src="${targetOrigin}/private.png">`); }
  });
  const origin = await listening(source);
  const env = { PLATFORM_ENABLE_BROWSER: '1', PLATFORM_BROWSER_ALLOWED_ORIGINS: origin, PLATFORM_BROWSER_EXECUTABLE: browserExecutable };
  try {
    await assert.rejects(executeBrowser(job('browser', { url: origin + '/redirect' }), context(tmpdir()), env), errorCode('BROWSER_ADDRESS_BLOCKED'));
    const result = await executeBrowser(job('browser', { url: origin }), context(tmpdir()), env);
    assert.match(result.text || '', /Allowed fixture/);
    assert.equal(forbiddenRequests, 0);
    assert.equal(forbiddenConnections, 0, 'browser native preconnect cannot connect around request routing');
  } finally { await close(source); await close(target); }
});

test('real browser bounds response size and closes on cancellation', { skip: !browserExecutable }, async () => {
  let startedRequest: () => void;
  const requestStarted = new Promise<void>(resolve => { startedRequest = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/large') { response.setHeader('content-length', String(3 * 1024 * 1024)); response.end('oversize'); }
    if (request.url === '/slow') startedRequest();
    // /slow intentionally does not respond; cancellation must terminate the request and browser.
  });
  const origin = await listening(server);
  const env = { PLATFORM_ENABLE_BROWSER: '1', PLATFORM_BROWSER_ALLOWED_ORIGINS: origin, PLATFORM_BROWSER_EXECUTABLE: browserExecutable };
  try {
    await assert.rejects(executeBrowser(job('browser', { url: origin + '/large' }), context(tmpdir()), env), errorCode('BROWSER_LIMIT_EXCEEDED'));
    const controller = new AbortController();
    const execution = executeBrowser(job('browser', { url: origin + '/slow' }), { ...context(tmpdir()), signal: controller.signal }, env);
    // Measure cancellation of an active read, not uninterruptible Chromium cold startup.
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([requestStarted, execution.then(() => assert.fail('The slow fixture must remain pending')),
        new Promise<void>((_resolve, reject) => { readinessTimer = setTimeout(() => reject(new Error('The synthetic browser request did not start within 30 seconds.')), 30_000); })]);
    } catch (error) {
      controller.abort(); await execution.catch(() => {}); throw error;
    } finally { if (readinessTimer) clearTimeout(readinessTimer); }
    const started = Date.now();
    controller.abort();
    await assert.rejects(execution, errorCode('JOB_CANCELLED'));
    assert.ok(Date.now() - started < 5000);
  } finally { await close(server); }
});

async function dockerFixture(mode: 'success' | 'hold' | 'oversize' | 'materials' | 'symlink' | 'bigfile' | 'count' | 'deep' | 'growing' | 'uncertain' = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'companion-docker-fixture-'));
  const log = join(directory, 'events.jsonl');
  const program = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({args,envKeys:Object.keys(process.env)})+'\\n');
if(args[0]==='image') { process.stdout.write('sha256:'+'a'.repeat(64)+'\\n'); }
else if(args[0]==='rm') { process.exitCode=${JSON.stringify(mode)}==='uncertain'?1:0; }
else if(args[0]==='container' && ${JSON.stringify(mode)}==='uncertain') { process.stdout.write('synthetic-container-still-present'); }
else if(args[0]==='run') {
  let prompt=''; process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>prompt+=chunk);
  process.stdin.on('end',()=>{
    fs.appendFileSync(log, JSON.stringify({prompt})+'\\n');
    if(${JSON.stringify(mode)}==='hold') setInterval(()=>{},1000);
    else if(${JSON.stringify(mode)}==='oversize') process.stdout.write('x'.repeat(2*1024*1024));
    else {
      const mount=args[args.indexOf('--mount')+1];
      const workspace=mount.slice('type=bind,source='.length).split(',target=')[0];
      const output=workspace+'/output';
      if(${JSON.stringify(mode)}==='materials') {
        const names=fs.readdirSync(workspace+'/input');
        fs.appendFileSync(log,JSON.stringify({inputs:names.map(name=>({name,text:fs.readFileSync(workspace+'/input/'+name,'utf8')}))})+'\\n');
        fs.mkdirSync(output+'/source');
        fs.writeFileSync(output+'/source/main.ts','export const fixture = 42;');
        fs.writeFileSync(output+'/readme.md','# Synthetic material');
        fs.writeFileSync(output+'/page.html','<script>synthetic only</script>');
        fs.writeFileSync(output+'/fake.png','not a PNG');
        fs.writeFileSync(output+'/bad.txt',Buffer.from([255,254]));
      }
      if(${JSON.stringify(mode)}==='symlink') fs.symlinkSync(workspace+'/input',output+'/linked-input');
      if(${JSON.stringify(mode)}==='bigfile') fs.writeFileSync(output+'/oversize.txt','x'.repeat(9*1024*1024));
      if(${JSON.stringify(mode)}==='count') for(let i=0;i<21;i++) fs.writeFileSync(output+'/'+i+'.txt','fixture');
      if(${JSON.stringify(mode)}==='deep') fs.mkdirSync(output+'/one/two/three/four',{recursive:true});
      if(${JSON.stringify(mode)}==='growing') {
        for(let i=0;i<5;i++) fs.writeFileSync(output+'/'+i+'.txt','x'.repeat(7*1024*1024));
        setInterval(()=>{},1000);
      }
      process.stdout.write('Synthetic Codex fixture result');
    }
  });
}
`;
  await writeFile(join(directory, 'docker'), program, { mode: 0o700 });
  return { directory, log, env: { PATH: directory + ':' + (process.env.PATH || ''), PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'local/codex-fixture:ready',
    PLATFORM_CLI_COMMAND: '["codex","exec","--json","-"]', MODEL_SECRET_SENTINEL: 'must-not-be-inherited' },
    events: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('CLI is disabled without image and rejects user commands, external networking and implicit sandbox bypass', async () => {
  await assert.rejects(executeCli(job('cli'), context(tmpdir()), {}), errorCode('CLI_DISABLED'));
  await assert.rejects(executeCli(job('cli', { command: 'touch host-file' }), context(tmpdir()), { PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'fixture' }), errorCode('INVALID_PROVIDER_INPUT'));
  await assert.rejects(executeCli(job('cli'), context(tmpdir()), { PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'fixture', PLATFORM_CLI_NETWORK: 'bridge' }), errorCode('EXECUTOR_CONFIGURATION'));
  await assert.rejects(executeCli(job('cli'), context(tmpdir()), { PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'fixture', PLATFORM_CLI_MODEL_RELAY: '1' }), errorCode('CLI_MODEL_RELAY_UNAVAILABLE'));
  await assert.rejects(executeCli(job('cli'), context(tmpdir()), { PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'fixture', PLATFORM_CLI_COMMAND: '["/bin/sh","-c","evil"]' }), errorCode('EXECUTOR_CONFIGURATION'));
  await assert.rejects(executeCli(job('cli'), context(tmpdir()), { PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'fixture', PLATFORM_CLI_USER: '0:0' }), errorCode('EXECUTOR_CONFIGURATION'));
  for (const command of [
    ['codex', 'exec', '--sandbox', 'danger-full-access', '-'],
    ['codex', 'exec', '--sandbox=danger-full-access', '-'],
    ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
    ['codex', 'exec', '--yolo', '-'],
    ['codex', 'exec', '-c', 'sandbox_mode="danger\\u002dfull\\u002daccess"', '-'],
    ['codex', 'exec', '-p', 'unreviewed-profile', '-'],
  ]) await assert.rejects(executeCli(job('cli'), context(tmpdir()), { PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'fixture', PLATFORM_CLI_COMMAND: JSON.stringify(command) }), errorCode('EXECUTOR_CONFIGURATION'));
});

test('server sandbox opt-in preserves every Docker isolation boundary', async () => {
  const fixture = await dockerFixture();
  try {
    await executeCli(job('cli'), context(fixture.directory), { ...fixture.env, PLATFORM_CLI_EXTERNAL_SANDBOX: '1',
      PLATFORM_CLI_COMMAND: '["codex","exec","--json","--sandbox","danger-full-access","-"]' });
    const run = (await fixture.events()).find(event => event.args?.[0] === 'run'); assert.ok(run);
    for (const flag of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges:true']) assert.ok(run.args.includes(flag));
    assert.equal(run.args[run.args.indexOf('--network') + 1], 'none');
    assert.equal(run.args[run.args.indexOf('--tmpfs') + 1], '/tmp:rw,noexec,nosuid,size=64m');
    assert.match(run.args[run.args.indexOf('--user') + 1], /^[1-9][0-9]*:[0-9]+$/);
  } finally { await fixture.dispose(); }
});

test('CLI uses immutable existing image, hardened arguments, isolated mounts, stdin and no host secrets', async () => {
  const fixture = await dockerFixture();
  const prompt = 'Synthetic prompt; $(touch /tmp/should-not-run) `echo ignored`';
  try {
    const first = await executeCli(job('cli', undefined, prompt), context(fixture.directory, 'one'), fixture.env);
    const second = await executeCli(job('cli'), context(fixture.directory, 'two'), fixture.env);
    assert.match(first.text || '', /Synthetic Codex fixture result/); assert.ok(second.artifacts.length);
    const events = await fixture.events(), runs = events.filter(e => e.args?.[0] === 'run'); assert.equal(runs.length, 2);
    for (const { args, envKeys } of runs) {
      for (const flag of ['--pull=never', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges:true', '--pids-limit', '--memory', '--cpus', '--init', '--no-healthcheck', '--ulimit']) assert.ok(args.includes(flag), flag);
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.equal(args[args.indexOf('--log-driver') + 1], 'none');
      assert.equal(args[args.indexOf('--workdir') + 1], '/workspace/output');
      const mounts = args.filter((_: string, i: number) => args[i - 1] === '--mount');
      assert.equal(mounts.length, 2);
      assert.ok(mounts[0].includes('target=/workspace,readonly,bind-recursive=disabled'));
      assert.ok(mounts[1].includes('target=/workspace/output,bind-recursive=disabled'));
      assert.ok(!mounts[1].includes('readonly'));
      const source = mounts[0].slice('type=bind,source='.length).split(',target=')[0];
      assert.equal(existsSync(source), false, 'temporary workspace removed after container cleanup');
      assert.match(args[args.indexOf('--entrypoint') + 2], /^sha256:a{64}$/);
      assert.ok(!args.includes('-e') && !args.includes('--env-file'));
      assert.ok(!JSON.stringify(args).includes('docker.sock'));
      assert.ok(!envKeys.includes('MODEL_SECRET_SENTINEL'));
      assert.ok(!args.includes(prompt));
    }
    assert.notEqual(runs[0].args[runs[0].args.indexOf('--mount') + 1], runs[1].args[runs[1].args.indexOf('--mount') + 1]);
    assert.ok(events.some(e => e.prompt?.startsWith(prompt + '\n\nExecution workspace: /workspace/output')));
    assert.equal(events.filter(e => e.args?.[0] === 'rm').length, 2);
  } finally { await fixture.dispose(); }
});

test('CLI stages only explicit attachments with generated names and returns safe material downloads', async () => {
  const fixture = await dockerFixture('materials');
  const requested: string[] = [];
  const ctx: JobExecutionContext = { ...context(fixture.directory), readAttachment: async id => {
    requested.push(id);
    return { name: '../../private/original-profile.txt', mime: 'text/plain', bytes: Buffer.from('Synthetic attached profile') };
  } };
  try {
    const result = await executeCli({ ...job('cli'), attachmentIds: ['synthetic-attachment'] }, ctx, fixture.env);
    assert.deepEqual(requested, ['synthetic-attachment']);
    const events = await fixture.events(), staged = events.find(e => e.inputs)?.inputs;
    assert.equal(staged.length, 1);
    assert.match(staged[0].name, /^[a-f0-9-]{36}\.txt$/);
    assert.equal(staged[0].text, 'Synthetic attached profile');
    const stdin = events.find(e => e.prompt)?.prompt;
    assert.ok(stdin.includes('/workspace/input/' + staged[0].name));
    assert.doesNotMatch(stdin, /original-profile|private\//);
    const materials = result.artifacts.filter(a => a.name.startsWith('cli-output-'));
    assert.equal(materials.length, 5);
    const source = materials.find(a => a.name.endsWith('source_main.ts')); assert.ok(source);
    assert.equal(source.mime, 'text/plain');
    assert.equal(Buffer.from(source.bytes).toString(), 'export const fixture = 42;');
    assert.equal(materials.find(a => a.name.endsWith('readme.md'))?.mime, 'text/plain');
    for (const suffix of ['page.html', 'fake.png', 'bad.txt']) assert.equal(materials.find(a => a.name.endsWith(suffix))?.mime, 'application/octet-stream');
    assert.ok(materials.every(a => !/[\/\\\r\n]/.test(a.name)));
  } finally { await fixture.dispose(); }
});

test('CLI rejects extra, unauthorized, duplicate and oversized input attachments', async () => {
  const fixture = await dockerFixture();
  try {
    const attached = (attachmentIds: string[]) => ({ ...job('cli'), attachmentIds });
    await assert.rejects(executeCli(attached(['1', '2', '3', '4', '5']), context(fixture.directory), fixture.env), errorCode('INVALID_PROVIDER_INPUT'));
    await assert.rejects(executeCli(attached(['one']), context(fixture.directory), fixture.env), errorCode('INVALID_PROVIDER_INPUT'));
    const ctx: JobExecutionContext = { ...context(fixture.directory), readAttachment: async () => ({ name: 'fiction.txt', mime: 'text/plain', bytes: new Uint8Array(11 * 1024 * 1024) }) };
    await assert.rejects(executeCli(attached(['one', 'one']), ctx, fixture.env), errorCode('INVALID_PROVIDER_INPUT'));
    await assert.rejects(executeCli(attached(['one']), ctx, fixture.env), errorCode('CLI_INPUT_LIMIT'));
    assert.ok(!(await fixture.events()).some(e => e.args?.[0] === 'run'));
  } finally { await fixture.dispose(); }
});

test('CLI refuses a symlink workspace and unsafe or excessive material outputs', async () => {
  const fixture = await dockerFixture();
  try {
    const linked = join(fixture.directory, 'linked-root'); await symlink(fixture.directory, linked);
    await assert.rejects(executeCli(job('cli'), context(linked), fixture.env), errorCode('EXECUTOR_CONFIGURATION'));
  } finally { await fixture.dispose(); }
  for (const mode of ['symlink', 'bigfile', 'count', 'deep'] as const) {
    const unsafe = await dockerFixture(mode);
    try {
      await assert.rejects(executeCli(job('cli'), context(unsafe.directory), unsafe.env), errorCode(mode === 'symlink' ? 'CLI_UNSAFE_FILE' : 'CLI_MATERIAL_LIMIT'));
      assert.ok((await unsafe.events()).some(e => e.args?.[0] === 'rm'));
    } finally { await unsafe.dispose(); }
  }
});

test('CLI running output guard stops aggregate output growth and cleans its bind directory', async () => {
  const fixture = await dockerFixture('growing'), started = Date.now();
  try {
    await assert.rejects(executeCli(job('cli'), context(fixture.directory), fixture.env), errorCode('CLI_MATERIAL_LIMIT'));
    assert.ok(Date.now() - started < 5000);
    const events = await fixture.events(), run = events.find(e => e.args?.[0] === 'run');
    assert.ok(events.some(e => e.args?.[0] === 'rm'));
    const source = run.args[run.args.indexOf('--mount') + 1].slice('type=bind,source='.length).split(',target=')[0];
    assert.equal(existsSync(source), false);
  } finally { await fixture.dispose(); }
});

test('CLI retains temporary files when container shutdown cannot be confirmed', async () => {
  const fixture = await dockerFixture('uncertain');
  try {
    await assert.rejects(executeCli(job('cli'), context(fixture.directory), fixture.env), errorCode('CLI_CLEANUP_UNCONFIRMED'));
    const events = await fixture.events(), run = events.find(e => e.args?.[0] === 'run');
    const source = run.args[run.args.indexOf('--mount') + 1].slice('type=bind,source='.length).split(',target=')[0];
    assert.equal(existsSync(source), true);
    assert.ok(events.some(e => e.args?.[0] === 'container'));
  } finally { await fixture.dispose(); }
});

test('CLI cancellation and excessive output both remove the container', async () => {
  for (const mode of ['hold', 'oversize'] as const) {
    const fixture = await dockerFixture(mode), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ctx = { ...context(fixture.directory), signal: controller.signal,
        onProviderTask: () => { if (mode === 'hold') timer = setTimeout(() => controller.abort(), 150); } };
      await assert.rejects(executeCli(job('cli'), ctx, fixture.env), errorCode(mode === 'hold' ? 'JOB_CANCELLED' : 'CLI_OUTPUT_LIMIT'));
      assert.ok((await fixture.events()).some(e => e.args?.[0] === 'rm' && e.args[1] === '--force'));
    } finally { if (timer) clearTimeout(timer); await fixture.dispose(); }
  }
});
