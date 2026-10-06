import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import type { BrowserAction, BrowserCheckpoint, BrowserCheckpointEvent, BrowserObservation, CreateJobInput, JobExecutionContext, JobExecutionResult } from '@companion/platform-contracts';
import { executeBrowser } from '../src/executors.ts';
import { createProviderRuntime, parseBrowserTaskOptions, browserDefinitionHash, ProviderError } from '../src/index.ts';
import { performBrowserAction } from '../src/browser-actions.ts';

const executable = existsSync(chromium.executablePath()) ? chromium.executablePath() : existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;
const click: BrowserAction = { type: 'click', target: { by: 'role', role: 'button', name: 'Preview' } };
const task = (url: string, actions?: BrowserAction[]): CreateJobInput => ({ kind: 'browser', provider: 'browser', prompt: 'Synthetic browser fixture', options: { url, ...(actions ? { actions } : {}) } });
const base: JobExecutionContext = { jobId: 'synthetic-browser', userId: 'synthetic-user', workspaceDirectory: tmpdir() };
const code = (expected: string) => (error: unknown) => error instanceof ProviderError && error.code === expected;
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function journal(input: CreateJobInput) {
  let checkpoint: BrowserCheckpoint = { definitionHash: browserDefinitionHash(input), revision: 0, nextIndex: 0, state: 'ready' };
  const events: BrowserCheckpointEvent[] = [], results: JobExecutionResult[] = [];
  const port = {
    events, results, snapshot: () => structuredClone(checkpoint),
    before: undefined as ((event: BrowserCheckpointEvent) => Promise<void> | void) | undefined,
    after: undefined as ((event: BrowserCheckpointEvent) => Promise<void> | void) | undefined,
    authorize: undefined as (() => Promise<void> | void) | undefined,
    context(): JobExecutionContext {
      return { ...base, browserCheckpoint: port.snapshot(), assertBrowserAuthorized: async () => { await port.authorize?.(); }, onBrowserCheckpoint: async event => {
        await port.before?.(event); assert.equal(event.expectedRevision,checkpoint.revision); assert.equal(event.definitionHash,checkpoint.definitionHash);
        checkpoint = { ...checkpoint, revision: checkpoint.revision + 1, nextIndex: event.type === 'completed' ? event.index + 1 : event.index,
          state: event.type === 'started' ? 'started' : event.index + 1 === (input.options!.actions as BrowserAction[]).length ? 'completed' : 'ready' };
        events.push(event); if (event.type === 'completed') results.push(event.result);
        await port.after?.(event); return port.snapshot();
      } };
    },
  }; return port;
}
function observation(result: JobExecutionResult): BrowserObservation {
  const file = result.artifacts.find(file => file.name === 'browser-observation.json'); assert.ok(file); assert.equal(file.mime,'application/json');
  return JSON.parse(Buffer.from(file.bytes).toString('utf8'));
}
const env = (origin: string) => ({ PLATFORM_ENABLE_BROWSER: '1', PLATFORM_ENABLE_BROWSER_ACTIONS: '1', PLATFORM_BROWSER_ALLOWED_ORIGINS: origin, PLATFORM_BROWSER_EXECUTABLE: executable });

test('browser DTO, canonical plan hash, capability gates and advertised fixture origins are strict', async () => {
  const input = task('https://example.com',[click]);
  assert.equal(browserDefinitionHash(input),browserDefinitionHash({ ...input, options: { ...input.options, serverReviewConfirmed: true } }));
  assert.notEqual(browserDefinitionHash(input),browserDefinitionHash({ ...input, prompt: 'Changed synthetic goal' }));
  assert.deepEqual(parseBrowserTaskOptions({ url: 'https://example.com', actions: [] }),{ url: 'https://example.com/' });
  for (const options of [
    { url: 'https://example.com', script: 'synthetic()' }, { url: 'https://example.com', css: '#private' },
    { url: 'https://example.com', actions: [{ ...click, x: 20 }] }, { url: 'https://example.com', actions: [{ type: 'keyboard', key: 'Enter' }] },
    { url: 'https://example.com', actions: [{ type: ['click'], target: click.target }] },
    { url: 'https://example.com', actions: [{ type: 'click', target: { by: 'role', role: ['button'], name: 'Preview' } }] },
    { url: 'https://example.com', actions: [{ type: 'scroll', direction: ['down'], pixels: 10 }] },
    { url: 'https://example.com', actions: [{ type: 'fill', target: { by: 'css', name: '#email' }, value: 'fixture' }] },
    { url: 'https://example.com', actions: [{ type: 'fill', target: { by: 'role', role: 'button', name: 'Preview' }, value: 'fixture' }] },
    { url: 'https://example.com', actions: [{ type: 'scroll', direction: 'down', pixels: 1201 }] },
    { url: 'https://example.com', actions: [{ type: 'fill', target: { by: 'label', name: 'Topic' }, value: 'x'.repeat(2001) }] },
    { url: 'https://example.com', actions: Array(13).fill(click) }, { url: 'https://example.com/' + '中'.repeat(1000) },
  ]) assert.throws(() => parseBrowserTaskOptions(options),code('INVALID_PROVIDER_INPUT'));
  await assert.rejects(executeBrowser(input,base,{ PLATFORM_ENABLE_BROWSER: '1' }),code('BROWSER_ACTIONS_DISABLED'));
  await assert.rejects(executeBrowser(input,base,{ PLATFORM_ENABLE_BROWSER: '1', PLATFORM_ENABLE_BROWSER_ACTIONS: '1' }),code('BROWSER_CHECKPOINT_UNAVAILABLE'));
  await assert.rejects(executeBrowser({ ...input, attachmentIds: ['fictional-upload'] },base,env('http://127.0.0.1:4333')),code('INVALID_PROVIDER_INPUT'));
  const catalog = (settings: NodeJS.ProcessEnv) => createProviderRuntime({ env: settings }).capabilities().find(provider => provider.id === 'browser')!;
  assert.equal(catalog({ PLATFORM_ENABLE_BROWSER_ACTIONS: '1' }).browserActionsEnabled,false);
  assert.equal(catalog({ PLATFORM_ENABLE_BROWSER: '1' }).browserActionsEnabled,false);
  assert.equal(catalog({ PLATFORM_ENABLE_BROWSER: '1', PLATFORM_ENABLE_BROWSER_ACTIONS: '1' }).browserActionsEnabled,true);
  assert.deepEqual(catalog({ PLATFORM_BROWSER_ALLOWED_ORIGINS: 'http://127.0.0.1:4333,http://localhost:4333,https://[::1]:4333' }).browserFixtureOrigins,['http://127.0.0.1:4333','http://localhost:4333','https://[::1]:4333']);
  assert.deepEqual(catalog({ PLATFORM_BROWSER_ALLOWED_ORIGINS: 'http://127.0.0.1:4333,http://10.0.0.1' }).browserFixtureOrigins,[]);
});

test('real isolated Chromium executes reviewed click/fill/select/scroll and saves each private observation', { skip: !executable }, async () => {
  let posts = 0, previews = 0, websockets = 0, cookieHeaders = 0;
  const server = createServer((request,response) => {
    if (request.headers.cookie) cookieHeaders++;
    if (request.method === 'POST') { posts++; response.end('unexpected'); return; }
    if (request.url === '/preview') { previews++; response.end('ok'); return; }
    if (request.url === '/next') { response.setHeader('content-type','text/html'); response.end('<h1>Second synthetic page</h1>'); return; }
    response.setHeader('content-type','text/html'); response.setHeader('set-cookie','fixture=must-not-forward');
    response.end(`<h1>Safe synthetic page</h1><label>Topic<input type="text" value="field-value-sentinel" oninput="document.querySelector('#filled').textContent='Filled safely'"></label><p id="filled"></p>
      <label>Category<select onchange="document.querySelector('#selected').textContent='Selected safely'"><option>Alpha</option><option>Beta</option></select></label><p id="selected"></p>
      <button type="button" onclick="document.querySelector('#previewed').textContent='Preview ready';fetch('/preview');fetch('/write',{method:'POST',body:'fictional'}).catch(()=>{})">Preview</button><p id="previewed"></p>
      <p id="scroll-state" style="position:fixed;right:10px;top:10px">At heading</p>
      <a href="/next">Read details</a><label>Password<input type="password" value="synthetic-password-sentinel"></label><button>Default control</button><div style="height:2500px">Long fixture</div>
      <script>addEventListener('scroll',()=>document.querySelector('#scroll-state').textContent=scrollY>100?'Page moved below heading':'At heading');document.cookie='fixture=must-not-forward';new WebSocket('ws://'+location.host+'/socket');</script>`);
  });
  server.on('upgrade',(_request,socket) => { websockets++; socket.destroy(); });
  const origin = await listen(server);
  const actions: BrowserAction[] = [
    { type: 'fill', target: { by: 'role', role: 'textbox', name: 'Topic' }, value: 'private-fill-value' },
    { type: 'select', target: { by: 'label', name: 'Category' }, optionLabel: 'Beta' }, click,
    { type: 'scroll', direction: 'down', pixels: 600 }, { type: 'scroll', direction: 'up', pixels: 600 },
    { type: 'click', target: { by: 'role', role: 'link', name: 'Read details' } },
  ];
  const input = task(origin,actions), port = journal(input);
  try {
    const result = await executeBrowser(input,port.context(),env(origin)).catch(error => { throw new Error(`Synthetic action index ${port.snapshot().nextIndex} failed with ${error.code}`); });
    assert.deepEqual(result,{ artifacts: [] });
    assert.equal(port.results.length,6); assert.equal(port.events.length,12); assert.equal(port.snapshot().state,'completed');
    for (const [index,result] of port.results.entries()) {
      assert.equal(result.artifacts.length,3); const view = observation(result);
      assert.equal(view.version,1); assert.equal(view.provenance,'untrusted_page'); assert.equal(view.completedActions,index + 1);
      assert.ok(Buffer.byteLength(view.text) <= 64 * 1024);
      assert.doesNotMatch(JSON.stringify(view),/field-value-sentinel|synthetic-password-sentinel|private-fill-value/);
      assert.ok(view.targets.every(item => !('value' in item.target) && !('href' in item.target) && !/Password|Default control/.test(item.target.name)));
      assert.equal(Buffer.from(result.artifacts.find(file => file.mime === 'image/png')!.bytes).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    }
    assert.match(observation(port.results[0]).text,/Filled safely/); assert.match(observation(port.results[1]).text,/Selected safely/);
    assert.match(observation(port.results[2]).text,/Preview ready/); assert.match(observation(port.results[5]).text,/Second synthetic page/);
    assert.match(observation(port.results[3]).text,/Page moved below heading/); assert.match(observation(port.results[4]).text,/At heading/);
    assert.notDeepEqual(port.results[2].artifacts.find(file => file.mime === 'image/png')!.bytes,port.results[3].artifacts.find(file => file.mime === 'image/png')!.bytes);
    assert.equal(previews,1); assert.equal(posts,0); assert.equal(websockets,0); assert.equal(cookieHeaders,0);
    const count = port.events.length;
    await assert.rejects(executeBrowser(input,port.context(),env(origin)),code('BROWSER_REPLAY_BLOCKED')); assert.equal(port.events.length,count); assert.equal(previews,1);
  } finally { await close(server); }
});

test('real DOM guards reject sensitive, default/submit, fake-role and ambiguous controls', { skip: !executable }, async () => {
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage(); await page.setContent(`<form action="/submit"><button>Default control</button><button type="submit">Continue</button><button type="button" name="finalSubmit">Finish review</button></form>
      <label>Password<input type="password"></label><label>Contact<input type="email"></label><label>Number<input type="tel"></label>
      <label>Verification code<input type="text"></label><label>Social security<input type="text"></label><label>Card number<input type="text"></label>
      <button type="button">Agree to terms</button><div role="button" aria-label="Fake action">Fake</div>
      <button type="button">Duplicate</button><button type="button">Duplicate</button><a href="java&#x09;script:alert(1)">Malformed link</a>
      <label>Category<select><option>Agree to terms</option></select></label>`);
    const actions: BrowserAction[] = [
      ...['Default control','Continue','Finish review','Agree to terms','Fake action','Duplicate'].map(name => ({ type: 'click' as const, target: { by: 'role' as const, role: 'button' as const, name } })),
      ...['Password','Contact','Number','Verification code','Social security','Card number'].map(name => ({ type: 'fill' as const, target: { by: 'label' as const, name }, value: 'synthetic' })),
      { type: 'click', target: { by: 'role', role: 'link', name: 'Malformed link' } },
      { type: 'select', target: { by: 'label', name: 'Category' }, optionLabel: 'Agree to terms' },
    ];
    for (const action of actions) await assert.rejects(performBrowserAction(page,action),code('BROWSER_TARGET_BLOCKED'));
    assert.equal(await page.locator('input').evaluateAll(nodes => nodes.every(node => !(node as HTMLInputElement).value)),true);
  } finally { await browser.close(); }
});

test('native and dynamic form submission is blocked despite a safe-looking button', { skip: !executable }, async () => {
  let submissions = 0;
  const server = createServer((request,response) => {
    if (request.url?.startsWith('/final')) submissions++;
    const mode = request.url?.slice(1) ?? 'submit';
    const script = mode === 'request' ? "this.form.action='/final';this.form.requestSubmit()" : mode === 'dynamic' ? "this.form.action='/final';this.type='submit'" : mode === 'hover' ? '' : "this.form.action='/final';this.form.submit()";
    response.setHeader('content-type','text/html'); response.end(`<form action="/preview" method="GET"><input name="fictional" value="fixture"><button type="button" onclick="${script}" ${mode === 'hover' ? 'onmouseenter="this.form.action=\'/final\';this.removeAttribute(\'type\')"' : ''}>Preview</button></form>`);
  });
  const origin = await listen(server);
  try {
    for (const mode of ['submit','request','dynamic','hover']) {
      const input = task(origin + '/' + mode,[click]), port = journal(input);
      await assert.rejects(executeBrowser(input,port.context(),env(origin)),code('BROWSER_TARGET_BLOCKED'));
      assert.equal(submissions,0); assert.equal(port.snapshot().state,'started'); assert.equal(port.results.length,0);
    }
  } finally { await close(server); }
});

test('checkpoint refusal, authorization revocation and cancellation stop before dispatch and cannot replay started contexts', { skip: !executable }, async () => {
  let previews = 0;
  const server = createServer((request,response) => {
    if (request.url === '/preview') previews++;
    response.setHeader('content-type','text/html'); response.end('<button type="button" onclick="fetch(\'/preview\')">Preview</button>');
  });
  const origin = await listen(server), input = task(origin,[click]);
  try {
    const refused = journal(input); refused.before = () => { throw new Error('Synthetic lease refusal'); };
    await assert.rejects(executeBrowser(input,refused.context(),env(origin)),code('BROWSER_CHECKPOINT_UNCONFIRMED')); assert.equal(previews,0);
    const revoked = journal(input); revoked.authorize = () => { if (revoked.snapshot().state === 'started') throw new Error('Synthetic revoked approval'); };
    await assert.rejects(executeBrowser(input,revoked.context(),env(origin)),code('BROWSER_AUTH_REVOKED')); assert.equal(previews,0);
    await assert.rejects(executeBrowser(input,revoked.context(),env(origin)),code('BROWSER_REPLAY_BLOCKED'));
    const cancelled = journal(input); const controller = new AbortController();
    let started = 0;
    cancelled.after = event => { if (event.type === 'started') { started = Date.now(); controller.abort(); } };
    await assert.rejects(executeBrowser(input,{ ...cancelled.context(), signal: controller.signal },env(origin)),code('JOB_CANCELLED'));
    assert.ok(started > 0,'The executor deadline bounds readiness while this assertion measures only active cancellation.');
    assert.ok(Date.now() - started < 5000,'Active action cancellation closes Chromium within five seconds.');
    assert.equal(previews,0); assert.equal(cancelled.snapshot().state,'started'); assert.equal(cancelled.results.length,0);
  } finally { await close(server); }
});

test('readonly live authorization and UTF8 observations stay bounded without form values', { skip: !executable }, async () => {
  const server = createServer((_request,response) => { response.setHeader('content-type','text/html; charset=utf-8'); response.end('<h1>中文观察</h1><p>' + '汉字🌱'.repeat(25_000) + '</p><textarea>field-value-sentinel</textarea>'); });
  const origin = await listen(server);
  try {
    const result = await executeBrowser(task(origin),base,env(origin)); const view = observation(result);
    assert.ok(Buffer.byteLength(view.text) <= 64 * 1024); assert.ok(!view.text.includes('\uFFFD')); assert.doesNotMatch(view.text,/field-value-sentinel/);
    assert.ok(result.artifacts.find(file => file.name === 'browser-observation.json')!.bytes.length <= 512 * 1024);
    let revoked = false;
    await assert.rejects(executeBrowser(task(origin),{ ...base, assertBrowserAuthorized: async () => { if (revoked) throw new Error('Synthetic read revocation'); }, onProgress: progress => { if (progress === 65) revoked = true; } },env(origin)),code('BROWSER_AUTH_REVOKED'));
  } finally { await close(server); }
});

test('authentication parameters remain blocked after reviewed links and redirects', { skip: !executable }, async () => {
  let protectedReads = 0;
  const server = createServer((request,response) => {
    if (request.url?.startsWith('/protected')) { protectedReads++; response.end('must not read'); return; }
    if (request.url === '/redirect') { response.writeHead(302,{ location: '/protected?access_token=fictional' }); response.end(); return; }
    response.setHeader('content-type','text/html'); response.end('<a href="/redirect">Read details</a>');
  });
  const origin = await listen(server);
  const input = task(origin,[{ type: 'click', target: { by: 'role', role: 'link', name: 'Read details' } }]), port = journal(input);
  try {
    await assert.rejects(executeBrowser(input,port.context(),env(origin)),code('BROWSER_ADDRESS_BLOCKED')); assert.equal(protectedReads,0); assert.equal(port.snapshot().state,'started');
  } finally { await close(server); }
});
