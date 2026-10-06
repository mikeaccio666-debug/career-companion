import { parseAssistantAutofillRequest, parseAssistantAutofillResponse, type AssistantAutofillResult } from '@edaix/contracts';
import type { AutofillPorts } from '../features/autofill/ports';
import {parseAssistantCommerceRequest,parseAssistantCommerceResponse,type AssistantCommerceResult,type AssistantCommerceOperation} from '@edaix/contracts';
import type {CommercePorts} from '../features/commerce/ports';
import { parseIntakeVoiceEvent, type AssistantIntakeAbort, type IntakeVoiceControl, type IntakeClientCode } from '@edaix/contracts';
import type { PrivateIntakePorts } from '../features/intake/private-ports';
import { parseAssistantIntakeRequest, parseAssistantIntakeResponse, parseAssistantIntakeProgress, type IntakeResult, type IntakeEvent, type IntakeCommand } from '@edaix/contracts';
import { ASSISTANT_ROLES_PORT, parseAssistantRoleRequest, parseAssistantRoleResponse, type AssistantRoleOperation, type AssistantRoleResponse } from '@edaix/contracts';
import type { RolePorts } from '../features/targets/owner-roles';
import { browser } from 'wxt/browser';
import { ASSISTANT_READ_PORT, parseAssistantReadRequest, parseAssistantReadResponse, parseAssistantReadNotification,
  type AssistantReadOperation, type AssistantReadRequest, type AssistantReadResponse, type AssistantUiLocale } from '@edaix/contracts';
import { ASSISTANT_PROFILE_PORT, ASSISTANT_READ_CODES, parseAssistantProfileRequest, parseAssistantProfileResponse, parseCandidateProfileV2Patch,
  type AssistantProfileResponse, type PatchCandidateProfileV2 } from '@edaix/contracts';
import type { ProfileSaveResult } from '../features/profile/owner-writer';
import type { AssistantReadPorts, ReadResult } from '../features/session/read-ports';
import { reportAssistantDiagnostic } from './diagnostics';

/** The renderer receives only closed, validated projections. No storage or bearer access. */
export function createAssistantReadClient(events: { invalidated(code: 'UNAVAILABLE' | 'OWNER_CHANGED'): void; locale(value: AssistantUiLocale): void }, options: { readonly profileEditing?: boolean; readonly roleManagement?: boolean } = {}) {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  const autofillPending=new Map<string,(r:AssistantAutofillResult)=>void>(),autofillRetired=new Set<string>();
  let voice: { id: string; finish(code: IntakeClientCode | null): void; transcript(text: string): void; state(value: 'recording' | 'processing'): void } | null = null;
  const intakePending = new Map<string, { finish(result: IntakeResult): void; onEvent?: (event: IntakeEvent) => void }>();
  const intakeRetired = new Set<string>();
  const commercePending=new Map<string,{operation:AssistantCommerceOperation;finish(value:AssistantCommerceResult):void}>();
  const commerceRetired=new Set<string>();
  const retired = new Map<string, AssistantRoleOperation>();
  const pending = new Map<string, { operation: AssistantRoleOperation; finish(value: AssistantReadResponse | AssistantProfileResponse | AssistantRoleResponse | null): void }>();
  const disconnect = () => { for(const finish of [...autofillPending.values()])finish({ok:false,code:'RESULT_UNKNOWN'}); autofillRetired.clear(); voice?.finish('UNAVAILABLE'); if (!port && pending.size === 0 && intakePending.size === 0 && commercePending.size === 0) return; for(const item of [...commercePending.values()])item.finish({operation:item.operation,ok:false,code:'SAVE_UNCERTAIN'});commerceRetired.clear();for (const item of [...intakePending.values()]) item.finish({ ok: false, code: 'SAVE_UNCERTAIN' }); intakePending.clear(); intakeRetired.clear(); port = null; for (const item of [...pending.values()]) item.finish(null); pending.clear(); retired.clear(); events.invalidated('UNAVAILABLE'); };
  function connected() {
    if (port) return port;
    const next = browser.runtime.connect({ name: options.roleManagement === true ? ASSISTANT_ROLES_PORT : options.profileEditing === true ? ASSISTANT_PROFILE_PORT : ASSISTANT_READ_PORT }); port = next;
    next.onDisconnect.addListener(() => {
      // Read lastError inside its callback; never publish the browser's arbitrary error text.
      const receiverMissing = browser.runtime.lastError?.message === 'Could not establish connection. Receiving end does not exist.';
      if (port === next) {
        reportAssistantDiagnostic(receiverMissing ? 'CLIENT_RECEIVER_MISSING' : 'CLIENT_PORT_DISCONNECTED');
        disconnect();
      }
    });
    next.onMessage.addListener(raw => {
      if (port !== next) return;
      const notification = parseAssistantReadNotification(raw);
      if (notification?.kind === 'assistant/state-invalidated-v1') {
        for(const finish of [...autofillPending.values()])finish({ok:false,code:'OWNER_CHANGED'});
        voice?.finish('OWNER_CHANGED');
        for(const item of [...commercePending.values()])item.finish({operation:item.operation,ok:false,code:'OWNER_CHANGED'});
        for (const item of [...intakePending.values()]) item.finish({ ok: false, code: 'OWNER_CHANGED' });
        for (const item of [...pending.values()]) if (!['LAYOUT_CONTEXT', 'LOGOUT', 'OPEN_PORTAL', 'SET_LOCALE'].includes(item.operation)) item.finish(null); events.invalidated('OWNER_CHANGED'); return;
      }
      if (notification?.kind === 'assistant/locale-changed-v1') { events.locale(notification.locale); return; }
      if(raw?.kind==='assistant/autofill-result-v1'){
        const response=parseAssistantAutofillResponse(raw);
        if(!response){disconnect();next.disconnect();return;}
        if(autofillRetired.delete(response.id))return;
        const finish=autofillPending.get(response.id);if(!finish){disconnect();next.disconnect();return;}
        finish(response);return;
      }
      if(raw?.kind==='assistant/commerce-result-v1'){
        const result=parseAssistantCommerceResponse(raw);
        if(!result){disconnect();next.disconnect();return;}
        if(commerceRetired.delete(result.id))return;
        const waiter=commercePending.get(result.id);
        if(!waiter||waiter.operation!==result.operation){disconnect();next.disconnect();return;}
        waiter.finish(result);return;
      }
      if (raw?.kind === 'assistant/voice-event-v1') {
        const event = parseIntakeVoiceEvent(raw); if (!event) { disconnect(); next.disconnect(); return; }
        if (voice?.id !== event.id) return;
        if (event.event === 'STATE') voice.state(event.state);
        else if (event.event === 'TRANSCRIPT') voice.transcript(event.text);
        else voice.finish(event.code); return;
      }
      if (raw?.kind === 'assistant/intake-progress-v1') {
        const progress = parseAssistantIntakeProgress(raw);
        if (!progress) { disconnect(); next.disconnect(); return; }
        if (intakeRetired.has(progress.id)) return;
        const waiter = intakePending.get(progress.id); if (!waiter) { disconnect(); next.disconnect(); return; }
        waiter.onEvent?.(progress.event); return;
      }
      if (raw?.kind === 'assistant/intake-result-v1') {
        const result = parseAssistantIntakeResponse(raw);
        if (!result) { disconnect(); next.disconnect(); return; }
        if (intakeRetired.delete(result.id)) return;
        const waiter = intakePending.get(result.id); if (!waiter) { disconnect(); next.disconnect(); return; }
        waiter.finish(result); return;
      }
      const response = options.roleManagement === true ? parseAssistantRoleResponse(raw) : options.profileEditing === true ? parseAssistantProfileResponse(raw) : parseAssistantReadResponse(raw);
      if (!response) { reportAssistantDiagnostic('CLIENT_RESPONSE_MALFORMED'); disconnect(); next.disconnect(); return; }
      const waiter = pending.get(response.id);
      if (!waiter && retired.get(response.id) === response.operation) { retired.delete(response.id); return; }
      if (!waiter || waiter.operation !== response.operation) { reportAssistantDiagnostic('CLIENT_RESPONSE_UNEXPECTED'); disconnect(); next.disconnect(); return; }
      waiter.finish(response);
    });
    return next;
  }
  async function request(operation: AssistantRoleOperation, signal: AbortSignal, locale?: AssistantUiLocale, patch?: PatchCandidateProfileV2, extra: Record<string, unknown> = {}): Promise<AssistantReadResponse | AssistantProfileResponse | AssistantRoleResponse | null> {
    if (signal.aborted) return null;
    const raw = { kind: options.roleManagement === true ? 'assistant/roles-v1' : options.profileEditing === true ? 'assistant/profile-v1' : 'assistant/read-v1', id: crypto.randomUUID(), operation, ...(locale ? { locale } : {}), ...(patch ? { patch } : {}), ...extra };
    const input = options.roleManagement === true ? parseAssistantRoleRequest(raw) : options.profileEditing === true ? parseAssistantProfileRequest(raw) : parseAssistantReadRequest(raw);
    if (!input) return null;
    return new Promise(resolve => {
      const finish = (value: AssistantReadResponse | AssistantProfileResponse | AssistantRoleResponse | null) => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); pending.delete(input.id); if (!value) { retired.set(input.id, operation); if (retired.size > 256) retired.delete(retired.keys().next().value!); } resolve(value); };
      const cancelled = () => finish(null), timer = setTimeout(cancelled, ['PATCH_PROFILE_V2', 'PATCH_ROLE_PREFS', 'CREATE_ROLE'].includes(operation) ? 24_000 : 12_000);
      signal.addEventListener('abort', cancelled, { once: true });
      pending.set(input.id, { operation, finish });
      try { connected().postMessage(input); }
      catch { reportAssistantDiagnostic('CLIENT_SEND_FAILED'); finish(null); disconnect(); }
    });
  }
  const failure = (response: AssistantReadResponse | AssistantProfileResponse | AssistantRoleResponse | null): ReadResult<never> => ({ ok: false,
    code: response && !response.ok && response.code !== 'SENDER_REJECTED' && (ASSISTANT_READ_CODES as readonly string[]).includes(response.code) ? response.code as import('@edaix/contracts').AssistantReadCode as Exclude<import('@edaix/contracts').AssistantReadCode, 'SENDER_REJECTED'> : 'UNAVAILABLE' });
  const ports: AssistantReadPorts = {
    async session(signal) {
      const r = await request('SESSION', signal);
      if (r?.ok && r.operation === 'SESSION') { events.locale(r.value.locale); return { ok: true, value: r.value.identity }; }
      return failure(r);
    },
    async openPortal(signal) { const r = await request('OPEN_PORTAL', signal); return r?.ok ? { ok: true, value: undefined } : failure(r); },
    async logout(signal) { const r = await request('LOGOUT', signal); return r?.ok ? { ok: true, value: undefined } : failure(r); },
    async personal(_identity, signal) { const r = await request('PERSONAL', signal); return r?.ok && r.operation === 'PERSONAL' ? { ok: true, value: r.value } : failure(r); },
    async profileV2(_identity, signal) { const r = await request('PROFILE_V2', signal); return r?.ok && r.operation === 'PROFILE_V2' ? { ok: true, value: r.value } : failure(r); },
    async resumes(_identity, signal) { const r = await request('RESUMES', signal); return r?.ok && r.operation === 'RESUMES' ? { ok: true, value: r.value } : failure(r); },
  };
  const rolePorts: RolePorts = {
    async list(cursor, signal) { const r = await request('LIST_ROLES', signal, undefined, undefined, { cursor }); return r?.ok && r.operation === 'LIST_ROLES' ? { ok: true, value: r.value } : { ok: false, code: r && !r.ok ? r.code : 'UNAVAILABLE' }; },
    async create(create, signal) { const r = await request('CREATE_ROLE', signal, undefined, undefined, { request: create }); return r?.ok && r.operation === 'CREATE_ROLE' ? { ok: true, value: r.value } : { ok: false, code: r && !r.ok ? r.code : 'SAVE_UNCERTAIN' }; },
    async read(conversationId, signal) { const r = await request('READ_ROLE_PREFS', signal, undefined, undefined, { conversationId }); return r?.ok && r.operation === 'READ_ROLE_PREFS' ? { ok: true, value: r.value } : { ok: false, code: r && !r.ok ? r.code : 'UNAVAILABLE' }; },
    async save(conversationId, patch, signal) { const r = await request('PATCH_ROLE_PREFS', signal, undefined, undefined, { conversationId, patch }); return r?.ok && r.operation === 'PATCH_ROLE_PREFS' ? { ok: true, value: r.value } : { ok: false, code: r && !r.ok ? r.code : 'SAVE_UNCERTAIN' }; },
  };
  const commercePorts:CommercePorts={async execute(command,signal){
    const failure=(code:import('@edaix/contracts').AssistantCommerceCode):AssistantCommerceResult=>({operation:command.operation,ok:false,code});
    if(signal.aborted)return failure('CANCELLED');
    if(options.roleManagement!==true)return failure('UNAVAILABLE');
    const request=parseAssistantCommerceRequest({kind:'assistant/commerce-request-v1',id:crypto.randomUUID(),...command});
    if(!request)return failure('VALIDATION_FAILED');
    return new Promise(resolve=>{
      const finish=(value:AssistantCommerceResult)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);commercePending.delete(request.id);resolve(value);};
      const cancel=()=>{commerceRetired.add(request.id);if(commerceRetired.size>256)commerceRetired.delete(commerceRetired.values().next().value!);
        finish(failure(['JOBS_DELIVER','JOB_DECIDE','ATS_START','PREPARATION_START','PREPARATION_RETRY','COVER_WRITE'].includes(command.operation)?'SAVE_UNCERTAIN':'CANCELLED'));};
      const timer=setTimeout(cancel,command.operation==='COVER_WRITE'&&command.request.operation==='GENERATE'?95_000:15_000);signal.addEventListener('abort',cancel,{once:true});
      commercePending.set(request.id,{operation:command.operation,finish});
      try{connected().postMessage(request);}catch{finish(failure('UNAVAILABLE'));disconnect();}
    });
  }};
  const privateIntakePorts: PrivateIntakePorts = {
    async record(signal, onTranscript, onState) {
      if (signal.aborted) return { ok: false, code: 'CANCELLED' };
      if (voice || options.roleManagement !== true) return { ok: false, code: 'UNAVAILABLE' };
      return new Promise(resolve => {
        const id = crypto.randomUUID();
        const cancel = () => { try { port?.postMessage({ kind: 'assistant/voice-control-v1', id, operation: 'CANCEL' } satisfies IntakeVoiceControl); } catch { reportAssistantDiagnostic('CLIENT_SEND_FAILED'); } finish('CANCELLED'); };
        const finish = (code: IntakeClientCode | null) => { clearTimeout(timer); signal.removeEventListener('abort', cancel); if (voice?.id === id) voice = null; resolve(code ? { ok: false, code } : { ok: true }); };
        const timer = setTimeout(cancel, 1080000);
        voice = { id, finish, transcript: onTranscript, state: onState }; signal.addEventListener('abort', cancel, { once: true });
        try { connected().postMessage({ kind: 'assistant/voice-control-v1', id, operation: 'START' } satisfies IntakeVoiceControl); } catch { finish('UNAVAILABLE'); }
      });
    },
    stopRecording() { if (!voice) return; try { port?.postMessage({ kind: 'assistant/voice-control-v1', id: voice.id, operation: 'STOP' } satisfies IntakeVoiceControl); } catch { voice.finish('UNAVAILABLE'); } },
    async execute(command: IntakeCommand, signal: AbortSignal, onEvent?: (event: IntakeEvent) => void): Promise<IntakeResult> {
    if (options.roleManagement !== true) return { ok: false, code: 'UNAVAILABLE' };
    if (signal.aborted) return { ok: false, code: 'CANCELLED' };
    const request = parseAssistantIntakeRequest({ kind: 'assistant/intake-request-v1', id: crypto.randomUUID(), ...command });
    if (!request) return { ok: false, code: 'VALIDATION_FAILED' };
    return new Promise(resolve => {
      const finish = (result: IntakeResult) => { clearTimeout(timer); signal.removeEventListener('abort', cancel); intakePending.delete(request.id); resolve(result); };
      const cancel = () => { intakeRetired.add(request.id); if (intakeRetired.size > 256) intakeRetired.delete(intakeRetired.values().next().value!);
        try { port?.postMessage({ kind: 'assistant/intake-abort-v1', id: request.id } satisfies AssistantIntakeAbort); } catch { reportAssistantDiagnostic('CLIENT_SEND_FAILED'); }
        finish({ ok: false, code: command.operation === 'CURRENT' ? 'CANCELLED' : 'SAVE_UNCERTAIN' }); };
      const timer = setTimeout(cancel, command.operation === 'REPLY' ? 115000 : 18000); signal.addEventListener('abort', cancel, { once: true });
      intakePending.set(request.id, { finish, onEvent });
      try { connected().postMessage(request); } catch { finish({ ok: false, code: 'UNAVAILABLE' }); disconnect(); }
    });
  } };
  const autofillPorts:AutofillPorts={async execute(operation,selection,signal,reviewId){
    if(signal.aborted||options.roleManagement!==true)return {ok:false,code:'UNAVAILABLE'};
    const request=parseAssistantAutofillRequest({kind:'assistant/autofill-request-v1',id:crypto.randomUUID(),operation,selection,...(operation==='START'?{reviewId}:{})});
    if(!request)return {ok:false,code:'UNAVAILABLE'};
    return new Promise(resolve=>{
      const finish=(r:AssistantAutofillResult)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);autofillPending.delete(request.id);resolve(r);};
      const cancel=()=>{
        autofillRetired.add(request.id);if(autofillRetired.size>256)autofillRetired.delete(autofillRetired.values().next().value!);
        finish({ok:false,code:'RESULT_UNKNOWN'});
        if(operation==='START')void autofillPorts.execute('STOP',selection,AbortSignal.timeout(8000));
      };
      const timer=setTimeout(cancel,18000);signal.addEventListener('abort',cancel,{once:true});autofillPending.set(request.id,finish);
      try{connected().postMessage(request);}catch{finish({ok:false,code:'UNAVAILABLE'});disconnect();}
    });
  }};
  return { ports, rolePorts, privateIntakePorts,commercePorts,autofillPorts,
    async saveProfile(patch: PatchCandidateProfileV2, signal: AbortSignal): Promise<ProfileSaveResult> {
      if (options.profileEditing !== true) return { ok: false, code: 'DISABLED' };
      if (signal.aborted) return { ok: false, code: 'CANCELLED' };
      const normalized = parseCandidateProfileV2Patch(patch);
      if (!normalized) return { ok: false, code: 'VALIDATION_FAILED' };
      const r = await request('PATCH_PROFILE_V2', signal, undefined, normalized);
      return r?.ok && r.operation === 'PATCH_PROFILE_V2' ? { ok: true, value: r.value }
        : { ok: false, code: r && !r.ok && r.code !== 'NOT_FOUND' ? r.code : 'SAVE_UNCERTAIN' };
    }, async layoutContext() {
      const r = await request('LAYOUT_CONTEXT', AbortSignal.timeout(12_000));
      return r?.ok && r.operation === 'LAYOUT_CONTEXT' ? r.value : null;
    }, async setLocale(locale: AssistantUiLocale) { const r = await request('SET_LOCALE', AbortSignal.timeout(12_000), locale); return r?.ok ? { ok: true as const } : failure(r); },
    dispose() { const current = port; disconnect(); current?.disconnect(); },
  };
}
