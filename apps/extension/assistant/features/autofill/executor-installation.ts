import type { AssistantAutofillCode } from '@edaix/contracts';
import { reportAssistantDiagnostic } from '../../runtime/diagnostics';
import type { AutofillHostContext } from './host';

export const ASSISTANT_EXECUTOR_FILE = '/content-scripts/apply.js';
const INSTALL_TIMEOUT_MS = 3000;
type ExecutorScope = typeof globalThis & { __edaixAssistantExecutorV1?: 'INSTALLING' | 'READY' | 'FAILED' };
/** Isolated-world bookkeeping only. This marker never authorizes DOM reads or writes. */
export function claimAssistantExecutor(): boolean {
  const scope = globalThis as ExecutorScope;
  if (scope.__edaixAssistantExecutorV1 !== undefined) return false;
  scope.__edaixAssistantExecutorV1 = 'INSTALLING';
  return true;
}
export function markAssistantExecutorReady(): void {
  (globalThis as ExecutorScope).__edaixAssistantExecutorV1 = 'READY';
}
export function markAssistantExecutorFailed(): void {
  (globalThis as ExecutorScope).__edaixAssistantExecutorV1 = 'FAILED';
}
/** Must remain closure-free: scripting.executeScript serializes this function. */
export function readAssistantExecutorState(): 'ABSENT' | 'READY' | 'INSTALLING' | 'FAILED' | 'UNAVAILABLE' {
  const state = (globalThis as ExecutorScope).__edaixAssistantExecutorV1;
  return state === undefined ? 'ABSENT' : state === 'READY' || state === 'INSTALLING' || state === 'FAILED' ? state : 'UNAVAILABLE';
}
export type ExecutorInstallationResult = { readonly ok: true } | { readonly ok: false; readonly code: AssistantAutofillCode };
type Injection = { frameId: number; documentId?: string; result?: unknown };
export function createAssistantExecutorInstaller(deps: {
  probe(tabId: number, documentId: string): Promise<Injection[]>;
  inject(tabId: number, documentId: string): Promise<Injection[]>;
}) {
  const pending = new Map<string, Promise<ExecutorInstallationResult>>();
  const fail = (code: AssistantAutofillCode): ExecutorInstallationResult => ({ok:false,code});
  return async (context: AutofillHostContext, signal: AbortSignal): Promise<ExecutorInstallationResult> => {
    const documentId = context.topDocumentId;
    const expiresAt = Date.now() + INSTALL_TIMEOUT_MS;
    const current = async (): Promise<ExecutorInstallationResult> => {
      if (signal.aborted || context.signal.aborted) return fail('RUN_STOPPED');
      if (Date.now() >= expiresAt) return fail('EXECUTOR_TIMEOUT');
      if (!await context.current()) return fail('PAGE_CHANGED');
      if (signal.aborted || context.signal.aborted) return fail('RUN_STOPPED');
      return Date.now() < expiresAt ? {ok:true} : fail('EXECUTOR_TIMEOUT');
    };
    const exact = (results: Injection[]) => results.length === 1 &&
      results[0]?.frameId === 0 && results[0]?.documentId === documentId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ExecutorInstallationResult>(resolve => {
      timer = setTimeout(() => resolve(fail('EXECUTOR_TIMEOUT')), INSTALL_TIMEOUT_MS);
    });
    let onAbort: () => void = () => {};
    const cancelled = new Promise<ExecutorInstallationResult>(resolve => {
      onAbort = () => resolve(fail('RUN_STOPPED'));
      signal.addEventListener('abort', onAbort, {once:true});
      context.signal.addEventListener('abort', onAbort, {once:true});
      if (signal.aborted || context.signal.aborted) onAbort();
    });
    const attempt = async (): Promise<ExecutorInstallationResult> => {
      if (!documentId || !Number.isInteger(context.tabId) || context.tabId < 0) return fail('EXECUTOR_DOCUMENT_MISSING');
      const key = `${context.tabId}:${documentId}`;
      // Hold the single-flight reservation until the actual browser operation settles,
      // even if a caller times out. Never inject a second partially initialized copy.
      let operation = pending.get(key);
      if (!operation) {
        if (pending.size >= 64) return fail('EXECUTOR_UNAVAILABLE');
        operation = (async (): Promise<ExecutorInstallationResult> => {
          let checked = await current(); if (!checked.ok) return checked;
          const before = await deps.probe(context.tabId, documentId);
          checked = await current(); if (!checked.ok) return checked;
          if (!exact(before)) return fail('EXECUTOR_PROBE_INVALID');
          if (before[0].result === 'READY') return {ok:true};
          if (before[0].result === 'INSTALLING' || before[0].result === 'FAILED') return fail('EXECUTOR_RELOAD_REQUIRED');
          if (before[0].result !== 'ABSENT') return fail('EXECUTOR_PROBE_INVALID');
          const injected = await deps.inject(context.tabId, documentId);
          checked = await current(); if (!checked.ok) return checked;
          if (!exact(injected)) return fail('EXECUTOR_PROBE_INVALID');
          const after = await deps.probe(context.tabId, documentId);
          checked = await current(); if (!checked.ok) return checked;
          if (!exact(after)) return fail('EXECUTOR_PROBE_INVALID');
          return after[0].result === 'READY' ? {ok:true} : fail('EXECUTOR_RELOAD_REQUIRED');
        })().catch(() => fail('EXECUTOR_UNAVAILABLE'));
        pending.set(key, operation);
        void operation.then(() => { if (pending.get(key) === operation) pending.delete(key); });
      }
      const checked = await current(); if (!checked.ok) return checked;
      const result = await operation;
      if (!result.ok) return result;
      return current();
    };
    try {
      const result = await Promise.race([attempt(), timeout, cancelled]);
      if (!result.ok) reportAssistantDiagnostic(result.code);
      return result;
    } catch {
      reportAssistantDiagnostic('EXECUTOR_UNAVAILABLE');
      return fail('EXECUTOR_UNAVAILABLE');
    } finally { clearTimeout(timer); signal.removeEventListener('abort',onAbort); context.signal.removeEventListener('abort',onAbort); }
  };
}
