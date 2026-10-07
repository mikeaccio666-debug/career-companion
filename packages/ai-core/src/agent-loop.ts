import { createHash } from 'node:crypto';
import type { AgentEvent, AgentLoopContext, AgentToolDefinition, ChatInput, ModelStepContext, ModelStepEvent, ModelStepResult, ModelToolCall, ModelToolResult, PlatformProviderRuntime } from '@companion/platform-contracts';
import { ProviderError, invalid } from './errors.ts';

/** The new loop never delegates to the legacy multi-request streamChat method. */
export class ProviderAdapter {
  constructor(private readonly runtime: Pick<PlatformProviderRuntime, 'streamModelStep'>) {
    if (!runtime.streamModelStep) throw new ProviderError('MODEL_STEP_UNAVAILABLE', 'This runtime has no single-call model adapter.', 503);
  }
  stream(input: ChatInput, context: ModelStepContext): AsyncGenerator<ModelStepEvent, ModelStepResult> {
    return this.runtime.streamModelStep!(input, context);
  }
}
const effects = new Set(['read', 'draft', 'act', 'consult', 'ask_user', 'background', 'none']);
function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function fatal(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError') || ['LEASE_LOST', 'TURN_LEASE_LOST', 'RUNTIME_LEASE_LOST', 'USAGE_RECORD_UNCONFIRMED', 'AGENT_DEADLINE'].includes(codeOf(error) ?? '');
}
function envelope(code: string, message: string) { return { error: { code, message } }; }
function errorResult(value: unknown): boolean { return Boolean(value && typeof value === 'object' && 'error' in value && value.error); }
function canonical(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
function fingerprint(call: ModelToolCall): string {
  let args: unknown; try { args = JSON.parse(call.arguments); } catch { args = call.arguments; }
  return createHash('sha256').update(call.name).update('\0').update(canonical(args)).digest('hex');
}
function validateTool(tool: AgentToolDefinition) {
  if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 128 || /[\u0000-\u001f\u007f]/.test(tool.name) || !effects.has(tool.effect) || typeof tool.progressPhrase !== 'string' || !tool.progressPhrase.trim() || typeof tool.endsTurn !== 'boolean') invalid('Agent tools require complete server-owned execution metadata.');
  if (tool.timeoutMs !== undefined && (!Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 600_000)) invalid('Use bounded tool timeouts.');
  if (tool.maxResultChars !== undefined && (!Number.isSafeInteger(tool.maxResultChars) || tool.maxResultChars < 1 || tool.maxResultChars > 64_000)) invalid('Use bounded tool result limits.');
}
function sameDefinition(left: AgentToolDefinition, right: AgentToolDefinition) { return canonical(left) === canonical(right); }
function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
async function boundedHook<T>(operation: () => Promise<T> | T, deadline: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new ProviderError('AGENT_DEADLINE', 'The agent turn deadline was reached.', 504)), Math.max(1, deadline - Date.now()));
  try { return await raceSignal(Promise.resolve().then(operation), signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
  finally { clearTimeout(timer); }
}
async function waitRetry(signal?: AbortSignal) {
  await raceSignal(new Promise<void>(resolve => setTimeout(resolve, 1000)), signal);
}
function validateContext(ctx: AgentLoopContext) {
  const { maxRounds, maxToolCalls, maxOutputTokens, timeoutMs } = ctx.limits;
  if (!ctx.turnId?.trim() || !ctx.purpose?.trim() || !Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 30 || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 60 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 128_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) invalid('Use bounded server-owned agent limits and identifiers.');
  if (ctx.consultDepth !== undefined && (!Number.isSafeInteger(ctx.consultDepth) || ctx.consultDepth < 0 || ctx.consultDepth > 1)) invalid('Agent consultation depth is limited to one.');
  for (const value of [ctx.callTimeoutMs, ctx.firstTokenTimeoutMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 600_000)) invalid('Use bounded model timeouts.');
  if (ctx.finalTimeoutMs !== undefined && (!Number.isSafeInteger(ctx.finalTimeoutMs) || ctx.finalTimeoutMs < 1 || ctx.finalTimeoutMs > 5000)) invalid('Final completion time must not exceed five seconds.');
  if (!Array.isArray(ctx.toolDefinitions) || ctx.toolDefinitions.length > 128) invalid('An agent requires a stable server tool catalogue.');
  ctx.toolDefinitions.forEach(validateTool);
  if (new Set(ctx.toolDefinitions.map(tool => tool.name)).size !== ctx.toolDefinitions.length) invalid('Tool names must be unique.');
}

/** Provider-neutral execution only. Persisted turns, safety/output gates and channel transport live outside this engine. */
export async function* runAgentLoop(adapter: ProviderAdapter, initial: ChatInput, ctx: AgentLoopContext): AsyncGenerator<AgentEvent> {
  validateContext(ctx);
  const catalogue = structuredClone(ctx.toolDefinitions), startedAt = Date.now(), invocation = Object.freeze({});
  let deadline = startedAt + ctx.limits.timeoutMs;
  const limits = { ...ctx.limits };
  const failures = new Map<string, number>(), removed = new Set<string>();
  let input: ChatInput = { ...initial, messages: [...initial.messages] }, continuation: object | undefined, toolResults: ModelToolResult[] | undefined;
  let callIndex = 0, toolCount = 0, rounds = 0, extraInterjection = false, closing = false;
  let hookDeadline = deadline, finalDeadline: number | undefined;
  const active = async () => { ctx.signal?.throwIfAborted(); await boundedHook(() => ctx.assertActive?.(), hookDeadline, ctx.signal); ctx.signal?.throwIfAborted(); };
  const allowed = async (): Promise<AgentToolDefinition[]> => {
    await active(); const resolved = await boundedHook(() => ctx.resolveTools(), hookDeadline, ctx.signal);
    if (!Array.isArray(resolved)) invalid('Resolve a real server-owned tool mask.');
    for (const tool of resolved) {
      validateTool(tool); const declared = catalogue.find(entry => entry.name === tool.name);
      if (!declared || !sameDefinition(declared, tool)) invalid('Resolved tools must match the stable server catalogue.');
    }
    const names = new Set(resolved.map(tool => tool.name));
    return catalogue.filter(tool => names.has(tool.name) && tool.effect !== 'act' && (ctx.purpose !== 'background' || ['read', 'draft', 'none'].includes(tool.effect)) && !removed.has(tool.name) && !(tool.effect === 'consult' && (ctx.consultDepth ?? 0) > 0));
  };
  while (true) {
    if (Date.now() >= deadline && finalDeadline === undefined) finalDeadline = Date.now() + (ctx.finalTimeoutMs ?? Math.min(5000, ctx.limits.timeoutMs));
    hookDeadline = finalDeadline ?? deadline;
    await active();
    if (ctx.beforeStep) input = await boundedHook(() => ctx.beforeStep!(input), hookDeadline, ctx.signal);
    if (ctx.resolveLimits) {
      const narrowed = await boundedHook(() => ctx.resolveLimits!(), hookDeadline, ctx.signal);
      for (const key of ['maxRounds', 'maxToolCalls', 'maxOutputTokens', 'timeoutMs'] as const) {
        const value = narrowed?.[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < (key === 'maxToolCalls' ? 0 : 1)) invalid('Prepared-skill limits must be bounded server-owned integers.');
        limits[key] = Math.min(limits[key], value);
      }
      deadline = Math.min(deadline, startedAt + limits.timeoutMs);
      if (Date.now() >= deadline && finalDeadline === undefined) finalDeadline = Date.now() + (ctx.finalTimeoutMs ?? Math.min(5000, limits.timeoutMs));
      hookDeadline = finalDeadline ?? deadline;
    }
    const overTime = Date.now() >= deadline;
    const forceNone = closing || rounds >= limits.maxRounds || toolCount >= limits.maxToolCalls || overTime;
    const tools = forceNone ? [] : await allowed(); rounds++;
    if (forceNone) input = { ...input, messages: [...input.messages, { role: 'system', content: closing
      ? 'Address the newly joined user message briefly. Tools are disabled for this single final interjection step; do not claim to have performed new actions.'
      : `Tools are disabled because the ${overTime ? 'turn deadline' : rounds > limits.maxRounds ? 'model-step budget' : 'tool-call budget'} was reached. Clearly state what work is completed and what remains; do not imply unperformed work is complete.` }] };
    yield { type: 'round_started', round: rounds };
    const progress = new Map<number, string>();
    let out!: ModelStepResult, visible = false;
    for (let attempt = 0; ; attempt++) {
      await active();
      progress.clear();
      const timeoutMs = Math.max(1, Math.min(ctx.callTimeoutMs ?? limits.timeoutMs, hookDeadline - Date.now()));
      const attemptController = new AbortController(), attemptTimer = setTimeout(() => attemptController.abort(new ProviderError(Date.now() >= hookDeadline ? 'AGENT_DEADLINE' : 'PROVIDER_INTERRUPTED', 'The model step deadline was reached.', 504)), timeoutMs);
      const attemptSignal = ctx.signal ? AbortSignal.any([ctx.signal, attemptController.signal]) : attemptController.signal;
      let stream: AsyncGenerator<ModelStepEvent, ModelStepResult> | undefined;
      try {
        stream = adapter.stream(input, { tools: catalogue, allowedToolNames: tools.map(tool => tool.name), toolChoice: forceNone ? 'none' : 'auto', limits: { maxOutputTokens: limits.maxOutputTokens }, callIndex: ++callIndex, purpose: ctx.purpose,
          timeoutMs, firstTokenTimeoutMs: ctx.firstTokenTimeoutMs === undefined ? undefined : Math.min(ctx.firstTokenTimeoutMs, timeoutMs), reasoningEffort: ctx.reasoningEffort,
          signal: attemptSignal, requestAdmission: ctx.requestAdmission, onModelCall: ctx.onModelCall, continuation, invocation, toolResults });
        while (true) {
          const next = await raceSignal(stream.next(), attemptSignal); if (next.done) { out = next.value; break; }
          await active(); const event = next.value;
          if (event.type === 'tool_started') {
            if ((event.callId !== undefined && (typeof event.callId !== 'string' || !event.callId.trim() || event.callId.length > 240 || /[\u0000-\u001f\u007f]/.test(event.callId))) || (event.name !== undefined && (typeof event.name !== 'string' || event.name.length > 128 || /[\u0000-\u001f\u007f]/.test(event.name)))) invalid('The model returned invalid bounded tool identifiers.');
            const tool = tools.find(entry => entry.name === event.name);
            const id = event.callId || `step-${rounds}-attempt-${attempt + 1}-tool-${event.index}`; progress.set(event.index, id);
            // Progress comes from trusted catalogue text, never incomplete provider arguments.
            yield { type: 'tool_started', callId: id, phrase: tool?.progressPhrase ?? '正在整理这一步…' };
          } else { if (event.type === 'delta' && event.text.length) visible = true; yield event; }
        }
        break;
      } catch (error) {
        if (!fatal(error, ctx.signal) && Date.now() < hookDeadline) {
          for (const callId of new Set(progress.values())) { await active(); yield { type: 'tool_finished', callId, ok: false }; }
        }
        if (fatal(error, ctx.signal) || visible || attempt >= 1 || !['PROVIDER_UNREACHABLE', 'PROVIDER_STREAM_INTERRUPTED'].includes(codeOf(error) ?? '') || Date.now() + 1000 >= deadline) throw error;
        await waitRetry(ctx.signal);
      } finally {
        // A runtime must honor the signal; do not wait for a non-cooperative fixture iterator on explicit cancellation.
        clearTimeout(attemptTimer);
        if (stream) { const cleanup = stream.return(undefined as never); if (attemptSignal.aborted) void cleanup.catch(() => {}); else await boundedHook(() => cleanup, hookDeadline, ctx.signal); }
      }
    }
    await active();
    if (!out || typeof out.text !== 'string' || !Array.isArray(out.calls) || out.calls.length > 128) invalid('The model step returned invalid output.');
    continuation = out.continuation;
    if (!out.calls.length) {
      if (extraInterjection) return;
      const more = await boundedHook(() => ctx.drainInterjections(), hookDeadline, ctx.signal);
      if (!more.length) return;
      extraInterjection = true; closing = true; input = { ...input, messages: [...input.messages, ...more] }; toolResults = []; continue;
    }
    const ids = new Set<string>();
    for (const call of out.calls) {
      if (!call || typeof call.callId !== 'string' || !call.callId.trim() || call.callId.length > 240 || /[\u0000-\u001f\u007f]/.test(call.callId) || ids.has(call.callId) || typeof call.name !== 'string' || !call.name.trim() || call.name.length > 128 || /[\u0000-\u001f\u007f]/.test(call.name) || typeof call.arguments !== 'string' || call.arguments.length > 64_000) invalid('The model returned invalid bounded tool call data.'); ids.add(call.callId);
    }
    const results: ModelToolResult[] = new Array(out.calls.length), definitions: (AgentToolDefinition | undefined)[] = new Array(out.calls.length), args: (Record<string, unknown> | undefined)[] = new Array(out.calls.length);
    let consults = 0;
    out.calls.forEach((call, index) => {
      const definition = tools.find(tool => tool.name === call.name); definitions[index] = definition;
      if (forceNone || !definition) results[index] = { callId: call.callId, result: envelope('TOOL_NOT_ALLOWED', 'This tool is not allowed for this step. Use an available tool or explain what remains.') };
      else if (++toolCount > limits.maxToolCalls) results[index] = { callId: call.callId, result: envelope('TOOL_BUDGET_EXCEEDED', 'No more tool calls are available. Explain what is done and what remains.') };
      else if (definition.effect === 'consult' && ++consults > 1) results[index] = { callId: call.callId, result: envelope('CONSULT_LIMIT', 'Only one expert consultation is allowed in a step. Wait for its result.') };
      else {
        try { const parsed: unknown = JSON.parse(call.arguments); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); args[index] = parsed as Record<string, unknown>; }
        catch { results[index] = { callId: call.callId, result: envelope('INVALID_TOOL_ARGUMENTS', 'Tool arguments must be a valid JSON object. Correct them; no tool was executed.') }; }
      }
    });
    const run = async (index: number, peerSignal?: AbortSignal) => {
      if (results[index]) return;
      const call = out.calls[index], tool = definitions[index]!;
      await active();
      if (Date.now() >= deadline) { results[index] = { callId: call.callId, result: envelope('TOOL_BUDGET_EXCEEDED', 'The turn deadline has been reached. Explain what is done and what remains.') }; return; }
      // Same-step skill loading never expands this mask. The executor additionally checks current trusted scope.
      const nowAllowed = await allowed();
      if (!nowAllowed.some(entry => entry.name === tool.name)) { results[index] = { callId: call.callId, result: envelope('TOOL_NOT_ALLOWED', 'This tool is no longer permitted. Ask for the missing prerequisite.') }; return; }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new ProviderError('TOOL_TIMEOUT', 'The tool did not finish in time.', 504)), Math.max(1, Math.min(tool.timeoutMs ?? limits.timeoutMs, deadline - Date.now())));
      const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : []), ...(peerSignal ? [peerSignal] : [])]);
      try {
        const value = await raceSignal(Promise.resolve().then(() => ctx.executeTool(call.name, args[index]!, { callId: call.callId, idempotencyKey: `${ctx.turnId}:${call.callId}`, turnId: ctx.turnId, effect: tool.effect, signal })), signal);
        const encoded = JSON.stringify(value) ?? 'null';
        results[index] = { callId: call.callId, result: encoded.length > (tool.maxResultChars ?? 64_000) ? envelope('TOOL_RESULT_TOO_LARGE', 'The result is too large. Request a smaller scope or fewer records.') : JSON.parse(encoded) };
      } catch (error) {
        if (fatal(error, ctx.signal) || peerSignal?.aborted) throw error;
        const safeCode = codeOf(error) === 'TOOL_NOT_ALLOWED' ? 'TOOL_NOT_ALLOWED' : codeOf(error) === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TOOL_EXECUTION_FAILED';
        results[index] = { callId: call.callId, result: envelope(safeCode, safeCode === 'TOOL_NOT_ALLOWED' ? 'This tool is no longer permitted. Ask for the missing prerequisite; no execution permission is granted.' : 'This tool did not complete. Correct the request or explain the unavailable information; no success is confirmed.') };
      } finally { clearTimeout(timer); }
    };
    // Wait for every read to settle before drafts. Fatal rejection aborts peer reads too.
    const peerController = new AbortController();
    const readIndices = out.calls.map((_call, index) => index).filter(index => definitions[index]?.effect === 'read');
    const settled = await Promise.allSettled(readIndices.map(index => run(index, peerController.signal).catch(error => { peerController.abort(error); throw error; })));
    const failed = settled.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    for (let index = 0; index < out.calls.length; index++) if (definitions[index]?.effect !== 'read') await run(index);
    let endTurn = false;
    for (let index = 0; index < out.calls.length; index++) {
      await active(); const call = out.calls[index], value = results[index].result, ok = !errorResult(value);
      const signature = fingerprint(call); if (!ok) { const count = (failures.get(signature) ?? 0) + 1; failures.set(signature, count); if (count >= 2) removed.add(call.name); }
      if (ok && (definitions[index]?.endsTurn || ['consult', 'ask_user'].includes(definitions[index]?.effect ?? '') || (value && typeof value === 'object' && 'endTurn' in value && value.endTurn === true))) endTurn = true;
      yield { type: 'tool_finished', callId: progress.get(call.index ?? index) ?? call.callId, ok };
    }
    if (endTurn || forceNone) return;
    toolResults = results;
    const more = await boundedHook(() => ctx.drainInterjections(), hookDeadline, ctx.signal);
    if (more.length) input = { ...input, messages: [...input.messages, ...more] };
  }
}
