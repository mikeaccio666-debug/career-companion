import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCliRelay, RELAY_PREFIX } from '../src/cli-relay.ts';
import { executeCli } from '../src/executors.ts';
import { ProviderError } from '../src/errors.ts';
import type { ModelRelayRequest } from '@companion/platform-contracts';
import { fakeCodexResponse } from './fixtures/codex-responses.ts';

const start = { prompt: 'Synthetic coding task', model: 'server-fixture-model', command: ['codex', 'exec', '--json', '-'] };
const code = (expected: string) => (error: unknown) => error instanceof ProviderError && error.code === expected;
async function fixture(mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'companion-stdio-fixture-'));
  const program = `#!${process.execPath}
const prefix=${JSON.stringify(RELAY_PREFIX)},mode=${JSON.stringify(mode)};
const send=frame=>process.stdout.write(prefix+JSON.stringify({v:1,...frame})+'\\n');
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const frame=JSON.parse(line.slice(prefix.length));
 if(frame.type==='start') {
  if(mode==='raw') {process.stdout.write('unframed sensitive bootstrap output\\n');continue;}
  if(mode==='oversized-frame') {process.stdout.write('x'.repeat(2*1024*1024));continue;}
  send({type:'ready'});
  if(mode==='unknown') {send({type:'model.cancel',id:'unknown'});continue;}
  send({type:'model.request',id:'one',body:{model:'client-cannot-choose',input:'synthetic request',stream:true,store:true}});
  if(mode==='duplicate') send({type:'model.request',id:'one',body:{}});
  if(mode==='concurrency') {send({type:'model.request',id:'two',body:{}});send({type:'model.request',id:'three',body:{}});}
  if(mode==='cancel-exit') {send({type:'model.cancel',id:'one'});send({type:'harness.exit',code:0});process.stdin.destroy();}
 }
 if(frame.type==='model.response.chunk' && mode==='success') send({type:'harness.output',stream:'stdout',data:frame.data});
 if(frame.type==='model.response.end') {
  if(mode==='output-limit') for(let i=0;i<24;i++)send({type:'harness.output',stream:'stdout',data:Buffer.alloc(48*1024).toString('base64')});
  send({type:'harness.exit',code:0});process.exitCode=0;process.stdin.destroy();
 }
}});
`;
  await writeFile(join(directory, 'docker'), program, { mode: 0o700 });
  return { directory, env: { PATH: directory + ':' + process.env.PATH }, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('stdio relay pins the server model, streams native Response and keeps protocol out of output', async () => {
  const fake = await fixture();
  try {
    const result = await executeCliRelay([], fake.env, new AbortController().signal, start, async request => {
      assert.equal(request.body.model, start.model); assert.equal(request.body.store, false); assert.ok(request.signal instanceof AbortSignal);
      return new Response('Synthetic SSE bytes', { headers: { 'content-type': 'text/event-stream', authorization: 'must-not-cross-relay' } });
    });
    assert.equal(result.stdout.toString(), 'Synthetic SSE bytes'); assert.equal(result.stderr.length, 0);
    assert.ok(!result.stdout.toString().includes(RELAY_PREFIX));
  } finally { await fake.dispose(); }
});

test('stdio relay rejects invalid framing, unknown IDs, duplicates, concurrency and output overrun', async () => {
  for (const mode of ['raw', 'unknown', 'duplicate', 'concurrency', 'oversized-frame', 'output-limit']) {
    const fake = await fixture(mode);
    let cancellations = 0;
    try {
      const expected = ['duplicate', 'concurrency'].includes(mode) ? 'MODEL_RELAY_UNCERTAIN' : mode === 'oversized-frame' ? 'CLI_RELAY_LIMIT' : mode === 'output-limit' ? 'CLI_OUTPUT_LIMIT' : 'CLI_RELAY_PROTOCOL';
      await assert.rejects(executeCliRelay([], fake.env, new AbortController().signal, start, async request => {
        // These cases exercise invalid framing while broker work is still in flight.
        // Keep the request pending even if stdout frames arrive in separate chunks.
        if (['duplicate', 'concurrency'].includes(mode)) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => { cancellations++; resolve(); }, { once: true }));
        return new Response('fixture', { headers: { 'content-type': 'text/event-stream' } });
      }), code(expected), `Relay fixture ${mode} must reject with ${expected}.`);
      if (['duplicate', 'concurrency'].includes(mode)) assert.equal(cancellations, mode === 'duplicate' ? 1 : 2, 'Invalid frames must abort all pending broker requests.');
    } finally { await fake.dispose(); }
  }
});

test('stdio relay aborts an active model request and fails on an interrupted response stream', async () => {
  const fake = await fixture(), cancellation = new AbortController();
  let aborted = false;
  try {
    const promise = executeCliRelay([], fake.env, cancellation.signal, start, request => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true });
      cancellation.abort(new ProviderError('JOB_CANCELLED', 'Synthetic cancellation', 409));
    }));
    await assert.rejects(promise, code('JOB_CANCELLED')); assert.equal(aborted, true);
  } finally { await fake.dispose(); }
  const broken = await fixture();
  try {
    await assert.rejects(executeCliRelay([], broken.env, new AbortController().signal, start, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')); controller.error(new Error('synthetic stream cut')); },
    }), { headers: { 'content-type': 'text/event-stream' } })), code('MODEL_RELAY_UNCERTAIN'));
  } finally { await broken.dispose(); }
});

test('stdio relay preserves structured broker status and waits for cancelled callback persistence', async () => {
  for (const errorCode of ['MODEL_RELAY_UNCERTAIN', 'MODEL_RELAY_USAGE_INVALID', 'MODEL_RELAY_OUTPUT_LIMIT', 'MODEL_RELAY_AUTH_REVOKED', 'MODEL_RELAY_POLICY_CHANGED']) {
    const fake = await fixture();
    try {
      await assert.rejects(executeCliRelay([], fake.env, new AbortController().signal, start, async () => {
        throw { code: errorCode, publicMessage: 'Synthetic broker public message', status: 502, message: 'private upstream text must be discarded' };
      }), error => error instanceof ProviderError && error.code === errorCode && error.publicMessage === 'Synthetic broker public message');
    } finally { await fake.dispose(); }
  }
  const fake = await fixture('cancel-exit'); let persisted = false;
  try {
    await assert.rejects(executeCliRelay([], fake.env, new AbortController().signal, start, request => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => setTimeout(() => {
        persisted = true; reject({ code: 'MODEL_RELAY_UNCERTAIN', publicMessage: 'Synthetic pending result needs review.', status: 502 });
      }, 30), { once: true });
    })), code('MODEL_RELAY_UNCERTAIN'));
    assert.equal(persisted, true, 'executor must wait for broker audit persistence');
  } finally { await fake.dispose(); }
});

test('stdio relay bounds model response bytes', async () => {
  const fake = await fixture();
  try {
    await assert.rejects(executeCliRelay([], fake.env, new AbortController().signal, start, async () => new Response(new Uint8Array(9 * 1024 * 1024),
      { headers: { 'content-type': 'text/event-stream' } })), code('CLI_RELAY_LIMIT'));
  } finally { await fake.dispose(); }
});

test('a cancelled broker that ignores its signal cannot keep the executor open indefinitely', { timeout: 8_000 }, async () => {
  const fake = await fixture('cancel-exit');
  try {
    await assert.rejects(executeCliRelay([], fake.env, new AbortController().signal, start, () => new Promise(() => {})), code('MODEL_RELAY_UNCERTAIN'));
  } finally { await fake.dispose(); }
});

test('official Codex in a disconnected Docker container writes code through fake Responses', { skip: process.env.PLATFORM_TEST_REAL_HARNESS !== '1', timeout: 60000 }, async context => {
  // Docker Desktop/Colima must see the host path; macOS private temp folders are not always shared.
  const parent = join(process.cwd(), '../../.local/harness-fixtures'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'companion-real-codex-'));
  let turns = 0, sawCommandResult = false, toolFailure = 'unclassified';
  try {
    const requestModel = async (request: ModelRelayRequest) => {
      turns++; assert.equal(request.body.model, 'fixture-model'); assert.equal(request.body.store, false);
      if (process.env.PLATFORM_TEST_CAPTURE_SCHEMA === '1') context.diagnostic(JSON.stringify({ turn: turns, fields: Object.keys(request.body).sort(), tools: (request.body.tools as any[]).map(tool => ({type:tool.type,name:tool.name,fields:Object.keys(tool).sort(),nested: tool.tools?.map((nested: any) => ({ type:nested.type,name:nested.name,fields:Object.keys(nested).sort() }))})), inputTypes: [...new Set((request.body.input as any[]).map(item => item.type || item.role))] }));
      if (turns > 1) {
        sawCommandResult = JSON.stringify(request.body.input).includes('function_call_output');
        const toolOutput = JSON.stringify((request.body.input as any[]).filter(item => item.type === 'function_call_output'));
        toolFailure = /bwrap.*namespace/i.test(toolOutput) ? 'bubblewrap namespace unavailable' : /sandbox/i.test(toolOutput) ? 'inner sandbox rejected the command' : /denied|permission/i.test(toolOutput) ? 'permission rejected the command' : 'no classified execution error';
      }
      return fakeCodexResponse(request.body, turns);
    };
    const result = await executeCli({ kind: 'cli', provider: 'cli', prompt: 'Create fixture.ts containing one synthetic exported constant.', model: 'ignored-client-model' },
      { jobId: 'real-codex-fixture', userId: 'synthetic-user', workspaceDirectory: directory, requestModel }, {
        ...process.env, PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_IMAGE: 'companion-codex-relay:local', PLATFORM_CLI_MODEL_RELAY: '1', PLATFORM_CLI_MODEL: 'fixture-model', PLATFORM_CLI_NETWORK: 'none',
        PLATFORM_CLI_EXTERNAL_SANDBOX: process.env.PLATFORM_TEST_CLI_EXTERNAL_SANDBOX,
        PLATFORM_CLI_COMMAND: JSON.stringify(['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', process.env.PLATFORM_TEST_CLI_EXTERNAL_SANDBOX === '1' ? 'danger-full-access' : 'workspace-write', '--ephemeral', '-']), PLATFORM_CLI_TIMEOUT_MS: '45000',
      });
    assert.ok(turns >= 2 && sawCommandResult);
    const artifact = result.artifacts.find(artifact => artifact.name.endsWith('fixture.ts')); assert.ok(artifact, `official CLI must actually write the file (${toolFailure})`);
    assert.equal(Buffer.from(artifact.bytes).toString(), 'export const synthetic = 42;\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
