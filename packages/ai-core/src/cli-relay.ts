import { spawn } from 'node:child_process';
import type { ModelRelayRequest } from '@companion/platform-contracts';
import { ProviderError } from './errors.ts';

export const RELAY_PREFIX = '@companion-relay-v1 ';
const MAX_FRAME = 1536 * 1024;
const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_RESPONSES = 32 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_WIRE = 96 * 1024 * 1024;
const CHUNK = 48 * 1024;
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const protocolError = () => new ProviderError('CLI_RELAY_PROTOCOL', 'The coding harness sent an invalid relay message.');
const relayError = () => new ProviderError('MODEL_RELAY_UNCERTAIN', 'The authorized model result could not be confirmed. Review before retrying.');
const limitError = () => new ProviderError('CLI_RELAY_LIMIT', 'The coding harness exceeded its model relay limit.', 413);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(frame: Record<string, unknown>, keys: string[]): boolean { return Object.keys(frame).every(key => keys.includes(key)); }
const brokerCodes = new Set(['MODEL_RELAY_INVALID_REQUEST', 'MODEL_RELAY_CONFIG_INVALID', 'MODEL_RELAY_DISABLED', 'MODEL_RELAY_INPUT_LIMIT',
  'MODEL_RELAY_AUTH_REVOKED', 'MODEL_RELAY_PROVIDER_FAILED', 'MODEL_RELAY_UNCERTAIN', 'MODEL_RELAY_USAGE_INVALID', 'MODEL_RELAY_DUPLICATE',
  'MODEL_RELAY_BUDGET_LIMIT', 'MODEL_RELAY_PROVIDER_REJECTED', 'MODEL_RELAY_OUTPUT_LIMIT', 'MODEL_RELAY_POLICY_CHANGED']);
function safeRelayError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  // Cross-package broker errors are intentional public DTOs, not raw provider exceptions.
  if (object(error) && typeof error.code === 'string' && brokerCodes.has(error.code) && typeof error.publicMessage === 'string' &&
      error.publicMessage.length <= 500 && Number.isInteger(error.status) && Number(error.status) >= 400 && Number(error.status) <= 599)
    return new ProviderError(error.code, error.publicMessage, Number(error.status));
  return relayError();
}
function binary(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > CHUNK * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw protocolError();
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw protocolError();
  return result;
}

export interface RelayStart { prompt: string; model: string; command: string[]; }
/** No model URL, credential or HTTP listener is supplied to the disconnected container. */
export async function executeCliRelay(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, start: RelayStart,
  requestModel: (request: ModelRelayRequest) => Promise<Response>): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0), wire = 0, outputBytes = 0, responseBytes = 0, bootstrapBytes = 0, ready = false, exited = false, failure: unknown;
    const stdout: Buffer[] = [], stderr: Buffer[] = [], seen = new Set<string>();
    const active = new Map<string, AbortController>();
    const tasks = new Set<Promise<void>>();
    const stop = (error: unknown) => {
      if (failure) {
        // An aborted broker can still be confirming usage. Its explicit final status wins over transport cancellation.
        if (error instanceof ProviderError && brokerCodes.has(error.code)) failure = error;
        return;
      }
      failure = error;
      for (const controller of active.values()) controller.abort(error);
      child.kill('SIGKILL');
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const send = (frame: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      if (failure || child.stdin.destroyed) { reject(failure || relayError()); return; }
      const line = RELAY_PREFIX + JSON.stringify({ v: 1, ...frame }) + '\n';
      if (Buffer.byteLength(line) > MAX_FRAME) { reject(limitError()); return; }
      child.stdin.write(line, error => error ? reject(relayError()) : resolve());
    });
    async function relay(id: string, body: Record<string, unknown>) {
      const controller = new AbortController(); active.set(id, controller);
      let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        // The worker callback repeats authorization and pins its upstream. The server model also wins here.
        response = await requestModel({ requestId: id, body: { ...body, model: start.model, store: false }, signal: controller.signal });
        if (controller.signal.aborted) throw relayError();
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!['application/json', 'text/event-stream'].includes(contentType) || response.status < 200 || response.status > 599 || !response.body) throw relayError();
        await send({ type: 'model.response.start', id, status: response.status, contentType });
        reader = response.body.getReader(); let bytes = 0, complete = false;
        const cancel = () => { void reader?.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read(); if (chunk.done) { complete = true; break; }
            bytes += chunk.value.byteLength; responseBytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE || responseBytes > MAX_RESPONSES) throw limitError();
            for (let offset = 0; offset < chunk.value.byteLength; offset += CHUNK)
              await send({ type: 'model.response.chunk', id, data: Buffer.from(chunk.value.subarray(offset, offset + CHUNK)).toString('base64') });
          }
          if (controller.signal.aborted && !complete) throw relayError();
          if (!controller.signal.aborted) await send({ type: 'model.response.end', id });
        } finally { controller.signal.removeEventListener('abort', cancel); }
      } catch (error) {
        stop(safeRelayError(error));
      } finally {
        if (reader) await reader.cancel().catch(() => {});
        else await response?.body?.cancel().catch(() => {});
        if (active.get(id) === controller) active.delete(id);
      }
    }
    function receive(frame: unknown) {
      if (!object(frame) || frame.v !== 1 || typeof frame.type !== 'string' || exited) throw protocolError();
      if (frame.type === 'ready') {
        if (ready || !onlyKeys(frame, ['v', 'type'])) throw protocolError(); ready = true; return;
      }
      if (!ready) throw protocolError();
      if (frame.type === 'model.request') {
        if (!onlyKeys(frame, ['v', 'type', 'id', 'body']) || !idValid(frame.id) || !object(frame.body) || seen.has(frame.id)) throw protocolError();
        if (seen.size >= 32 || active.size >= 2 || Buffer.byteLength(JSON.stringify(frame.body)) > MAX_REQUEST) throw limitError();
        seen.add(frame.id); const task = relay(frame.id, frame.body); tasks.add(task); void task.finally(() => tasks.delete(task)); return;
      }
      if (frame.type === 'model.cancel') {
        if (!onlyKeys(frame, ['v', 'type', 'id']) || !idValid(frame.id) || !seen.has(frame.id)) throw protocolError();
        active.get(frame.id)?.abort(new ProviderError('JOB_CANCELLED', 'The model request was cancelled.', 409)); return;
      }
      if (frame.type === 'harness.output') {
        if (!onlyKeys(frame, ['v', 'type', 'stream', 'data']) || !['stdout', 'stderr'].includes(String(frame.stream))) throw protocolError();
        const bytes = binary(frame.data); outputBytes += bytes.length;
        if (outputBytes > MAX_OUTPUT) throw new ProviderError('CLI_OUTPUT_LIMIT', 'The CLI exceeded its output limit.', 413);
        (frame.stream === 'stdout' ? stdout : stderr).push(bytes); return;
      }
      if (frame.type === 'harness.exit') {
        if (!onlyKeys(frame, ['v', 'type', 'code']) || !Number.isInteger(frame.code)) throw protocolError();
        if (active.size) throw new ProviderError('MODEL_RELAY_UNCERTAIN', 'The model request did not settle before the harness exited. Review before retrying.');
        exited = true;
        if (frame.code !== 0) throw new ProviderError('CLI_EXECUTION_FAILED', 'The configured coding harness did not complete successfully.');
        child.stdin.end(); return;
      }
      throw protocolError();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        wire += chunk.length; if (wire > MAX_WIRE) throw limitError();
        pending = Buffer.concat([pending, chunk]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          if (newline > MAX_FRAME) throw limitError();
          const line = pending.subarray(0, newline).toString('utf8'); pending = pending.subarray(newline + 1);
          if (!line.startsWith(RELAY_PREFIX)) throw protocolError();
          receive(JSON.parse(line.slice(RELAY_PREFIX.length)));
        }
        if (pending.length > MAX_FRAME) throw limitError();
      } catch (error) { stop(error instanceof ProviderError ? error : protocolError()); }
    });
    // Docker may emit runtime warnings outside the protocol. Discard bounded bootstrap stderr, never log it.
    child.stderr.on('data', (chunk: Buffer) => { bootstrapBytes += chunk.length; if (bootstrapBytes > 16 * 1024) stop(protocolError()); });
    child.stdin.on('error', () => { if (!exited && !failure) stop(relayError()); });
    child.on('error', () => stop(new ProviderError('CLI_UNAVAILABLE', 'The Docker runtime is unavailable.', 503)));
    child.on('close', async code => {
      signal.removeEventListener('abort', abort);
      if (!failure && (pending.length || !ready || !exited || code !== 0 || active.size)) stop(protocolError());
      for (const controller of active.values()) controller.abort(relayError());
      // Wait for broker cancellation/usage persistence instead of reporting success while it is still running.
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.allSettled([...tasks]).then(() => true),
        new Promise<boolean>(resolve => { settleTimer = setTimeout(() => resolve(false), 5_000); }),
      ]);
      if (settleTimer) clearTimeout(settleTimer);
      if (!settled) failure = relayError();
      if (failure) reject(failure); else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    void send({ type: 'start', ...start }).catch(stop);
  });
}
