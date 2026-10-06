import { portalConnectUrl } from '../../lib/portalConnectUrl';
import { parseAssistantAutofillRequest, parseAssistantAutofillResponse } from '@edaix/contracts';
import { createAssistantAutofillHost, type AssistantAutofillHostDependencies } from '../features/autofill/host';
import { createSelectedMaterialResolver } from '../features/autofill/selected-material';
import { createMissionApplicationTargetClient } from '../../lib/missionApplicationTargetClient';
import { parseAssistantCommerceRequest,parseAssistantCommerceResponse,type AssistantCommerceCode } from '@edaix/contracts';
import { createOwnerCommerce } from '../features/commerce/owner-commerce';
import { parseAssistantIntakeAbort, parseIntakeVoiceControl } from '@edaix/contracts';
import { installIntakeVoiceWorker } from './intake-voice-worker';
import { parseAssistantIntakeRequest, parseAssistantIntakeResponse, type AssistantIntakeProgress, type IntakeClientCode } from '@edaix/contracts';
import { createOwnerIntake } from '../features/intake/owner-intake';
import { ASSISTANT_ROLES_PORT, parseAssistantRoleRequest, parseAssistantRoleResponse, type AssistantRoleCode } from '@edaix/contracts';
import { createOwnerRoles, type RoleCommand } from '../features/targets/owner-roles';
import { browser } from 'wxt/browser';
import { ASSISTANT_READ_PORT, parseAssistantReadRequest, parseAssistantReadResponse, parseAssistantPortalLocale, parseUuid,
  parseAssistantHostAttestation, type AssistantHostAttest,
  isAssistantUiLocale, type AssistantReadNotification, type AssistantReadResponse, type AssistantReadCode, type AssistantSessionIdentity, type AssistantUiLocale } from '@edaix/contracts';
import { ASSISTANT_PROFILE_PORT, parseAssistantProfileRequest, parseAssistantProfileResponse, type AssistantProfileCode } from '@edaix/contracts';
import { createOwnerProfileWriter } from '../features/profile/owner-writer';
import type { AuthClient } from '../../lib/authClient';
import { createOwnerReader } from '../features/session/owner-reader';
import { assistantFrameRejection, assistantDocumentUrl } from './frame-admission';
import { createAssistantLaunchRegistry } from './launch-registry';
import { reportAssistantDiagnostic } from './diagnostics';

const LOCALE_KEY = 'assistantUiLocaleV1';
/** Composed only by the explicitly enabled ordinary development build. Credentials stay in this worker. */
export function installAssistantWorker(auth: AuthClient, apiBase: string, portalOrigin: string, options: { readonly profileEditing?: boolean; readonly roleManagement?: boolean; readonly prepareAutofill?:AssistantAutofillHostDependencies['prepare']; readonly runAutofill?:AssistantAutofillHostDependencies['run'];
  /** 开门前预铸握手 state（authHandoff.beginPending，写进 storage.session 之后才给）。没有它就开不了连接门——fail closed。 */
  readonly connectState?: () => Promise<string> } = {}) {
  const launches = createAssistantLaunchRegistry(browser.storage.session, browser.runtime.getURL('/assistant.html'));
  const ports = new Set<ReturnType<typeof browser.runtime.connect>>();
  const dockOwners = new Set<ReturnType<typeof browser.runtime.connect>>();
  const dockReleases = new Map<ReturnType<typeof browser.runtime.connect>, () => void>();
  const intakeAborters = new Set<AbortController>();
  let generation = 1, locale: AssistantUiLocale = 'en-US';
  let localeRevision = 0;
  const diagnostic = (code: 'ASSISTANT_CONTEXT_UNAVAILABLE' | 'ASSISTANT_LOCALE_UNAVAILABLE') => ({ ok: false as const, code });
  const invalidate = () => {
    generation++;
    for (const release of dockReleases.values()) release();
    autofill.invalidate();
    voice.invalidate();
    for (const abort of intakeAborters) abort.abort();
    for (const port of ports) {
      try { port.postMessage({ kind: 'assistant/state-invalidated-v1' } satisfies AssistantReadNotification); }
      catch { ports.delete(port); }
    }
  };
  const localeReady = browser.storage.local.get(LOCALE_KEY).then(value => {
    if (localeRevision === 0 && isAssistantUiLocale(value[LOCALE_KEY])) locale = value[LOCALE_KEY];
  }).catch(() => diagnostic('ASSISTANT_LOCALE_UNAVAILABLE'));
  let localeWrite = Promise.resolve();
  const setLocale = async (next: AssistantUiLocale) => {
    locale = next; const revision = ++localeRevision;
    const write = localeWrite.then(() => browser.storage.local.set({ [LOCALE_KEY]: next }));
    localeWrite = write.catch(() => { diagnostic('ASSISTANT_LOCALE_UNAVAILABLE'); });
    await write;
    if (revision !== localeRevision) return;
    for (const port of ports) {
      try { port.postMessage({ kind: 'assistant/locale-changed-v1', locale } satisfies AssistantReadNotification); }
      catch { ports.delete(port); }
    }
  };
  const currentSession = async (): Promise<AssistantSessionIdentity | null> => {
    const epoch = generation, id = parseUuid(await auth.getUserId());
    return id && epoch === generation ? { ownerId: id, generation: epoch } : null;
  };
  const reader = createOwnerReader({ enabled: true, apiBase, currentSession,
    accessToken: () => auth.getAccessToken(), refreshAccessToken: () => auth.forceRefresh() });

  const writer = createOwnerProfileWriter({ enabled: options.profileEditing === true, apiBase, currentSession,
    accessToken: () => auth.getAccessToken() });

  const intake = createOwnerIntake({ apiBase, currentSession, accessToken: () => auth.getAccessToken() });
  const voice = installIntakeVoiceWorker(intake, currentSession, () => locale);
  const commerce = createOwnerCommerce({enabled:options.roleManagement === true,apiBase,currentSession,accessToken:()=>auth.getAccessToken()});
  const roles = createOwnerRoles({ enabled: options.roleManagement === true, apiBase, currentSession, accessToken: () => auth.getAccessToken() });
  const targets=createMissionApplicationTargetClient({apiBase,getAccessToken:()=>auth.getAccessToken(),refreshAccessToken:()=>auth.forceRefresh()});
  const materialAuthority=createSelectedMaterialResolver({apiBase,accessToken:()=>auth.getAccessToken(),refreshAccessToken:()=>auth.forceRefresh(),resolveTarget:id=>targets.resolve(id)});
  const autofill=createAssistantAutofillHost({
    resolve:materialAuthority,approve:materialAuthority.approve,prepare:options.prepareAutofill??(async()=>({ok:false,code:'EXECUTOR_UNAVAILABLE'})),
    run:options.runAutofill??(async()=>({kind:'STOPPED',runId:null,code:'RUN_ABORTED'})),
    openTarget:async url=>{await browser.tabs.create({url});},
  });

  const unavailable = async (tabId: number) => {
    await browser.action.setBadgeText({ tabId, text: '!' });
    await browser.action.setTitle({ tabId, title: locale === 'zh-CN' ? 'ArgoLand.AI 无法在此页面打开，请换一个普通网页后重试。' : 'ArgoLand.AI cannot open here. Try again on a regular web page.' });
  };
  browser.action.onClicked.addListener(tab => {
    if (typeof tab.id !== 'number') return;
    const tabId = tab.id;
    void (async () => {
      const top = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
      if (!top?.documentId || !/^https?:\/\//.test(top.url)) { await unavailable(tabId); return; }
      await browser.action.setBadgeText({ tabId, text: '' });
      await browser.action.setTitle({ tabId, title: 'Open ArgoLand.AI' });
      const previous = await launches.get(tabId);
      if (previous?.topDocumentId === top.documentId && previous.topUrl === top.url) {
        try { await browser.tabs.sendMessage(tabId, { kind: 'assistant/host-open-v1' }, { documentId: top.documentId }); return; }
        catch { await launches.delete(tabId); }
      }
      const frameUrl = browser.runtime.getURL('/assistant.html') + '?launch=' + crypto.randomUUID();
      if (!await launches.set({ tabId, topDocumentId: top.documentId, topUrl: top.url, frameUrl, layoutNonce: crypto.randomUUID() })) { await unavailable(tabId); return; }
      await browser.scripting.executeScript({ target: { tabId, documentIds: [top.documentId] }, files: ['/content-scripts/assistant-host.js'] });
    })().catch(async () => {
      try { await launches.delete(tabId); await unavailable(tabId); }
      catch { return diagnostic('ASSISTANT_CONTEXT_UNAVAILABLE'); }
    });
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.kind !== 'assistant/host-ready-v1') return;
    const launch = typeof sender.tab?.id === 'number' ? launches.peek(sender.tab.id) : undefined;
    if (!launch || sender.id !== browser.runtime.id || sender.frameId !== 0 ||
      sender.documentId !== launch.topDocumentId || sender.url !== launch.topUrl || Object.keys(message).length !== 1) return;
    return Promise.resolve({ frameUrl: launch.frameUrl, nonce: launch.layoutNonce });
  });
  browser.runtime.onMessageExternal.addListener((message, sender) => {
    const request = parseAssistantPortalLocale(message);
    if (!request || sender.frameId !== 0 || !sender.url) return;
    let origin: string;
    try { origin = new URL(sender.url).origin; } catch { return; }
    if (origin !== portalOrigin || (sender.origin && sender.origin !== portalOrigin)) return;
    return setLocale(request.locale).then(() => ({ ok: true })).catch(() => diagnostic('ASSISTANT_LOCALE_UNAVAILABLE'));
  });
  browser.runtime.onConnect.addListener(port => {
    const rolePort = port.name === ASSISTANT_ROLES_PORT;
    const profilePort = port.name === ASSISTANT_PROFILE_PORT;
    if (!rolePort && !profilePort && port.name !== ASSISTANT_READ_PORT) return;
    if (rolePort && options.roleManagement !== true) { port.disconnect(); return; }
    if (profilePort && options.profileEditing !== true) { port.disconnect(); return; }
    const sender = port.sender;
    if (!sender) { reportAssistantDiagnostic('WORKER_SENDER_MISSING'); port.disconnect(); return; }
    if (sender.id !== browser.runtime.id) { reportAssistantDiagnostic('WORKER_SENDER_ID_MISMATCH'); port.disconnect(); return; }
    if (typeof sender.tab?.id !== 'number') { reportAssistantDiagnostic('WORKER_SENDER_TAB_MISSING'); port.disconnect(); return; }
    const tabId = sender.tab.id;
    let launch: Awaited<ReturnType<typeof launches.get>>;
    const abort = new AbortController();
    let bound: AssistantSessionIdentity | null = null;
    const seen = new Set<string>();
    const polling = new Set<string>();
    const recentPolls = new Set<string>();
    let inFlight = 0;
    let ownsDock = false;
    const intakeRequests = new Map<string, AbortController>();
    ports.add(port);
    const releaseDock = () => {
      const held = ownsDock; ownsDock = false; dockOwners.delete(port);
      if(held&&launch&&![...dockOwners].some(p=>p.sender?.tab?.id===tabId))void browser.tabs.sendMessage(tabId,{kind:'assistant/dock-visibility-v1',hidden:false},{documentId:launch.topDocumentId}).catch(()=>reportAssistantDiagnostic('WORKER_OPERATION_FAILED'));
    };
    dockReleases.set(port, releaseDock);
    port.onDisconnect.addListener(() => { abort.abort(); bound = null; ports.delete(port); releaseDock(); dockReleases.delete(port); });
    // Register message handlers synchronously; the first request may arrive while
    // the worker is restoring its browser-session routing record.
    const admitted = async () => {
      if (abort.signal.aborted) return false;
      try { launch ??= await launches.get(tabId); }
      catch { reportAssistantDiagnostic('WORKER_LAUNCH_READ_FAILED'); return false; }
      if (!launch) { reportAssistantDiagnostic('WORKER_LAUNCH_MISSING'); return false; }
      if (launches.peek(tabId) !== launch) { reportAssistantDiagnostic('WORKER_LAUNCH_REPLACED'); return false; }
      let frames;
      try { frames = await browser.webNavigation.getAllFrames({ tabId }) ?? []; }
      catch { reportAssistantDiagnostic('WORKER_FRAME_LOOKUP_FAILED'); return false; }
      if (abort.signal.aborted) return false;
      if (launches.peek(tabId) !== launch) { reportAssistantDiagnostic('WORKER_LAUNCH_REPLACED'); return false; }
      let contexts;
      try { contexts = await browser.runtime.getContexts({ tabIds: [tabId], documentUrls: [assistantDocumentUrl(browser.runtime.id, launch.frameUrl)] }); }
      catch { reportAssistantDiagnostic('WORKER_CONTEXT_LOOKUP_FAILED'); return false; }
      let host;
      try {
        host = parseAssistantHostAttestation(await browser.tabs.sendMessage(tabId,
          { kind: 'assistant/host-attest-v1', frameUrl: launch.frameUrl } satisfies AssistantHostAttest,
          { documentId: launch.topDocumentId }));
      } catch { reportAssistantDiagnostic('WORKER_HOST_ATTESTATION_UNAVAILABLE'); return false; }
      if (abort.signal.aborted || launches.peek(tabId) !== launch) return false;
      const rejection = assistantFrameRejection(browser.runtime.id, launch, sender, frames, contexts, host?.present === true);
      if (rejection) reportAssistantDiagnostic(rejection);
      if(!rejection&&!ownsDock&&bound?.generation===generation){ownsDock=true;dockOwners.add(port);void browser.tabs.sendMessage(tabId,{kind:'assistant/dock-visibility-v1',hidden:true},{documentId:launch.topDocumentId}).catch(()=>reportAssistantDiagnostic('WORKER_OPERATION_FAILED'));}
      return rejection === null;
    };
    port.onMessage.addListener(raw => {
      if(raw?.kind==='assistant/autofill-request-v1'){
        const request=rolePort?parseAssistantAutofillRequest(raw):null;
        if(!request||seen.has(request.id)||polling.has(request.id)||recentPolls.has(request.id)){port.disconnect();return;}
        const isPoll = request.operation === 'READ';
        if(!isPoll && seen.size>=4096){port.disconnect();return;}
        if(isPoll) { recentPolls.add(request.id); if(recentPolls.size>128) recentPolls.delete(recentPolls.values().next().value!); }
        else seen.add(request.id);
        const failure=(code:'UNAVAILABLE'|'LOGIN_REQUIRED'|'OWNER_CHANGED')=>({kind:'assistant/autofill-result-v1',id:request.id,ok:false,code});
        if(inFlight>=4){port.postMessage(failure('UNAVAILABLE'));return;}inFlight++;if(isPoll)polling.add(request.id);
        void(async()=>{
          if(!await admitted()){port.disconnect();return;}
          const identity=bound,epoch=generation;
          if(!identity||identity.generation!==epoch){port.postMessage(failure('LOGIN_REQUIRED'));return;}
          const context={tabId,ownerKey:`${identity.ownerId}:${epoch}`,topUrl:launch!.topUrl,topDocumentId:launch!.topDocumentId,signal:abort.signal,
            current:async()=>!abort.signal.aborted&&generation===epoch&&await auth.getUserId()===identity.ownerId&&generation===epoch&&await admitted()};
          const result=await autofill.execute(context,request.operation,request.selection,request.reviewId);
          if(!await admitted()){port.disconnect();return;}
          port.postMessage(generation===epoch?(parseAssistantAutofillResponse({kind:'assistant/autofill-result-v1',id:request.id,...result})??failure('UNAVAILABLE')):failure('OWNER_CHANGED'));
        })().catch(()=>{if(!abort.signal.aborted)try{port.postMessage(failure('UNAVAILABLE'));}catch{port.disconnect();}}).finally(()=>{inFlight--;polling.delete(request.id);});return;
      }
      if (raw?.kind === 'assistant/voice-control-v1') {
        const request = rolePort ? parseIntakeVoiceControl(raw) : null;
        if (!request || !bound) { port.disconnect(); return; }
        void voice.control(port, request, bound, abort.signal, admitted).catch(() => port.disconnect()); return;
      }
      if (raw?.kind === 'assistant/intake-abort-v1') {
        if (!rolePort || !parseAssistantIntakeAbort(raw)) { port.disconnect(); return; }
        intakeRequests.get(raw.id)?.abort(); return;
      }
      if (raw?.kind === 'assistant/intake-request-v1') {
        const command = rolePort ? parseAssistantIntakeRequest(raw) : null;
        if (!command || seen.has(command.id) || seen.size >= 4096) { port.disconnect(); return; }
        if (inFlight >= 4) {
          seen.add(command.id);
          port.postMessage({kind:'assistant/intake-result-v1',id:command.id,ok:false,code:'UNAVAILABLE'}); return;
        }
        seen.add(command.id); inFlight++;
        const operation = new AbortController(); intakeRequests.set(command.id, operation); intakeAborters.add(operation);
        const failure = (code: IntakeClientCode) => ({ kind: 'assistant/intake-result-v1' as const, id: command.id, ok: false as const, code });
        void (async () => {
          if (!await admitted()) { port.disconnect(); return; }
          if (!bound || bound.generation !== generation) { port.postMessage(failure('LOGIN_REQUIRED')); return; }
          const epoch = generation;
          const result = await intake.execute(bound, command, AbortSignal.any([abort.signal, operation.signal]), admitted, event => {
            if (!abort.signal.aborted && !operation.signal.aborted && epoch === generation) port.postMessage({ kind: 'assistant/intake-progress-v1', id: command.id, event } satisfies AssistantIntakeProgress);
          });
          if (!await admitted()) { port.disconnect(); return; }
          const response = epoch !== generation ? failure('OWNER_CHANGED') : { kind: 'assistant/intake-result-v1', id: command.id, ...result };
          port.postMessage(parseAssistantIntakeResponse(response) ?? failure('RESPONSE_MALFORMED'));
        })().catch(() => { if (!abort.signal.aborted) { try { port.postMessage(failure('SAVE_UNCERTAIN')); } catch { port.disconnect(); } } })
          .finally(() => { intakeAborters.delete(operation); intakeRequests.delete(command.id); inFlight--; });
        return;
      }

      if (raw?.kind === 'assistant/commerce-request-v1') {
        const command=rolePort?parseAssistantCommerceRequest(raw):null;
        if(!command||seen.has(command.id)||seen.size>=4096){port.disconnect();return;}
        const failure=(code:AssistantCommerceCode)=>({kind:'assistant/commerce-result-v1' as const,id:command.id,operation:command.operation,ok:false as const,code});
        seen.add(command.id);
        if(inFlight>=4){reportAssistantDiagnostic('WORKER_INFLIGHT_LIMIT');port.postMessage(failure('UNAVAILABLE'));return;}
        inFlight++;
        void (async()=>{
          if(!await admitted()){port.disconnect();return;}
          if(!bound||bound.generation!==generation){port.postMessage(failure('LOGIN_REQUIRED'));return;}
          const epoch=generation;
          const result=await commerce.execute(bound,command,abort.signal,admitted);
          if(!await admitted()){port.disconnect();return;}
          const response=epoch!==generation?failure('OWNER_CHANGED'):{kind:'assistant/commerce-result-v1',id:command.id,...result};
          port.postMessage(parseAssistantCommerceResponse(response)??failure('RESPONSE_MALFORMED'));
        })().catch(()=>{if(!abort.signal.aborted){try{port.postMessage(failure('SAVE_UNCERTAIN'));}catch{port.disconnect();}}})
          .finally(()=>{inFlight--;});
        return;
      }

      const request = rolePort ? parseAssistantRoleRequest(raw) : profilePort ? parseAssistantProfileRequest(raw) : parseAssistantReadRequest(raw);
      if (!request) { reportAssistantDiagnostic('WORKER_REQUEST_MALFORMED'); port.disconnect(); return; }
      if (seen.has(request.id)) { reportAssistantDiagnostic('WORKER_REQUEST_REPLAY'); port.disconnect(); return; }
      if (seen.size >= 4096) { reportAssistantDiagnostic('WORKER_REQUEST_LIMIT'); port.disconnect(); return; }
      if (inFlight >= 4) {
        reportAssistantDiagnostic('WORKER_INFLIGHT_LIMIT'); seen.add(request.id);
        port.postMessage({kind:rolePort?'assistant/roles-result-v1':profilePort?'assistant/profile-result-v1':'assistant/read-result-v1',id:request.id,operation:request.operation,ok:false,code:'UNAVAILABLE'}); return;
      }
      seen.add(request.id); inFlight++;
      void (async () => {
        const envelope = { kind: rolePort ? 'assistant/roles-result-v1' as const : profilePort ? 'assistant/profile-result-v1' as const : 'assistant/read-result-v1' as const, id: request.id, operation: request.operation };
        const failure = (code: AssistantRoleCode) => ({ ...envelope, ok: false as const, code });
        if (!await admitted()) { port.disconnect(); return; }
        let response: unknown;
        const epoch = generation;
        if (request.operation === 'LAYOUT_CONTEXT') {
          response = { ...envelope, ok: true, value: { nonce: launch!.layoutNonce, origin: new URL(launch!.topUrl).origin } };
        } else if (request.operation === 'SESSION') {
          await localeReady;
          const identity = await currentSession();
          // Preserve the existing authority's distinction between absent login
          // and a failed probe; neither case grants access to owner reads.
          const readiness = identity ? await auth.readConnectionReadiness(identity.ownerId) : 'UNAUTHENTICATED';
          if (generation !== epoch) response = failure('OWNER_CHANGED');
          else {
            bound = readiness === 'READY' ? identity : null;
            response = readiness === 'AUTHORITY_UNAVAILABLE' ? failure('UNAVAILABLE')
              : readiness === 'OWNER_MISMATCH' ? failure('OWNER_CHANGED')
              : { ...envelope, ok: true, value: { identity: bound, locale } };
          }
        } else if (request.operation === 'OPEN_PORTAL') {
          // 见 lib/portalConnectUrl.ts：连接门打的是握手完成页，要带开门前预铸的 state。
          // 没有铸 state 的能力就不开门——开一个门户会判「Invalid request」的页面比不开更糟。
          const state = await options.connectState?.();
          if (state === undefined) response = failure('UNAVAILABLE');
          else {
            await browser.tabs.create({
              url: portalConnectUrl(portalOrigin, browser.runtime.id, state),
            });
            response = { ...envelope, ok: true, value: null };
          }
        } else if (request.operation === 'SET_LOCALE') {
          await setLocale(request.locale); response = { ...envelope, ok: true, value: locale };
        } else if (request.operation === 'LOGOUT') {
          bound = null; invalidate(); await auth.logout();
          response = { ...envelope, ok: true, value: null };
        } else if (!bound || bound.generation !== generation) response = failure('LOGIN_REQUIRED');
        else if (rolePort && ['LIST_ROLES', 'CREATE_ROLE', 'READ_ROLE_PREFS', 'PATCH_ROLE_PREFS'].includes(request.operation)) {
          const result = await roles.execute(bound, request as RoleCommand, abort.signal, admitted);
          response = result.ok ? { ...envelope, ok: true, value: result.value } : failure(result.code);
        } else if (request.operation === 'PATCH_PROFILE_V2') {
          if (options.profileEditing !== true) { port.postMessage(failure('DISABLED')); return; }
          const result = await writer.patch(bound, request.patch, abort.signal, admitted);
          response = result.ok ? { ...envelope, ok: true, value: result.value } : failure(result.code);
        } else {
          const result = await (request.operation === 'PERSONAL' ? reader.personal(bound, abort.signal)
            : request.operation === 'PROFILE_V2' ? reader.profileV2(bound, abort.signal) : reader.resumes(bound, abort.signal));
          response = result.ok ? { ...envelope, ok: true, value: result.value } : failure(result.code);
        }
        if (!await admitted()) { port.disconnect(); return; }
        if (epoch !== generation && !['LAYOUT_CONTEXT', 'LOGOUT', 'SET_LOCALE', 'OPEN_PORTAL'].includes(request.operation)) response = failure('OWNER_CHANGED');
        const parsed = rolePort ? parseAssistantRoleResponse(response) : profilePort ? parseAssistantProfileResponse(response) : parseAssistantReadResponse(response);
        port.postMessage(parsed ?? failure('RESPONSE_MALFORMED'));
      })().catch(() => {
        if (!abort.signal.aborted) {
          reportAssistantDiagnostic('WORKER_OPERATION_FAILED');
          try { port.postMessage({ kind: rolePort ? 'assistant/roles-result-v1' as const : profilePort ? 'assistant/profile-result-v1' : 'assistant/read-result-v1', id: request.id, operation: request.operation, ok: false, code: ['PATCH_PROFILE_V2', 'PATCH_ROLE_PREFS', 'CREATE_ROLE'].includes(request.operation) ? 'SAVE_UNCERTAIN' : 'UNAVAILABLE' }); }
          catch { reportAssistantDiagnostic('WORKER_RESPONSE_POST_FAILED'); port.disconnect(); }
        }
      }).finally(() => { inFlight--; });
    });
  });
  const clearTab = (tabId: number) => {
    void launches.delete(tabId).catch(() => diagnostic('ASSISTANT_CONTEXT_UNAVAILABLE'));
    for (const port of ports) if (port.sender?.tab?.id === tabId) { reportAssistantDiagnostic('WORKER_TOP_CONTEXT_CHANGED'); port.disconnect(); }
  };
  browser.tabs.onRemoved.addListener(clearTab);
  browser.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) clearTab(details.tabId);
    else for (const port of ports) if (port.sender?.tab?.id === details.tabId && port.sender.frameId === details.frameId && port.sender.documentId !== details.documentId) { reportAssistantDiagnostic('WORKER_CHILD_DOCUMENT_CHANGED'); port.disconnect(); }
  });
  browser.webNavigation.onHistoryStateUpdated.addListener(details => { if (details.frameId === 0) clearTab(details.tabId); });
  browser.webNavigation.onReferenceFragmentUpdated.addListener(details => { if (details.frameId === 0) clearTab(details.tabId); });
  return { invalidate };
}
