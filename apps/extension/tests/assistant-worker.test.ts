import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthClient } from '../lib/authClient';
const h = vi.hoisted(() => ({ onConnect: null as any, onExternal: null as any, onCommit: null as any, frames: [] as any[],
  roleExecute: vi.fn(), write: vi.fn(), read: vi.fn(), getUserId: vi.fn(), attest: vi.fn(), current: null as any,
  contexts: null as any[] | null, probe: vi.fn(), session: {} as Record<string, unknown> }));
vi.mock('../assistant/features/session/owner-reader', async (importOriginal) => ({ ...await importOriginal<typeof import('../assistant/features/session/owner-reader')>(), createOwnerReader: (options: any) => {
  h.current = options.currentSession; return { personal: h.read, profileV2: h.read, resumes: h.read };
} }));
vi.mock('../assistant/features/profile/owner-writer', () => ({ createOwnerProfileWriter: () => ({ patch: h.write }) }));
vi.mock('../assistant/features/targets/owner-roles', () => ({ createOwnerRoles: () => ({ execute: h.roleExecute }) }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', connect: vi.fn(), getURL: (path: string) => 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + path,
    getContexts: async () => h.contexts ?? h.frames.slice(1).map(f => ({ tabId: 1, frameId: f.frameId, documentId: f.documentId, documentUrl: f.url })),
    onConnect: { addListener: (fn: any) => { h.onConnect = fn; } }, onMessage: { addListener: vi.fn() },
    onMessageExternal: { addListener: (fn: any) => { h.onExternal = fn; } } },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: {
    get: async (key: string) => ({ [key]: structuredClone(h.session[key]) }),
    set: async (values: Record<string, unknown>) => { Object.assign(h.session, structuredClone(values)); },
    remove: async (key: string) => { delete h.session[key]; },
  } },
  action: { onClicked: { addListener: (fn: any) => { (h as any).click = fn; } }, setBadgeText: async () => {}, setTitle: async () => {} },
  tabs: { onRemoved: { addListener: vi.fn() }, create: vi.fn(), sendMessage: (...args: any[]) => h.probe(...args) },
  scripting: { executeScript: async () => {} },
  webNavigation: { getFrame: async () => h.frames[0], getAllFrames: async () => h.frames,
    onCommitted: { addListener: (fn: any) => { h.onCommit = fn; } }, onHistoryStateUpdated: { addListener: vi.fn() }, onReferenceFragmentUpdated: { addListener: vi.fn() } },
} }));
import { installAssistantWorker } from '../assistant/runtime/worker';
import { ASSISTANT_READ_PORT, ASSISTANT_PROFILE_PORT, ASSISTANT_ROLES_PORT, parseUuid } from '@edaix/contracts';
const ownerId = parseUuid('10000000-0000-4000-8000-000000000001')!;
const drain = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
function connect(overrides = {}, profile = false, roles = false) {
  let receive: (v: any) => void = () => {}, gone: () => void = () => {};
  const port = { name: roles ? ASSISTANT_ROLES_PORT : profile ? ASSISTANT_PROFILE_PORT : ASSISTANT_READ_PORT, sender: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tab: { id: 1 }, frameId: 2, documentId: 'child', url: h.frames[1]?.url, ...overrides },
    onMessage: { addListener: (fn: any) => { receive = fn; } }, onDisconnect: { addListener: (fn: any) => { gone = fn; } },
    disconnect: vi.fn(() => gone()), postMessage: vi.fn() };
  h.onConnect(port);
  return { port, raw: (value: unknown) => receive(value), send(operation: string, extra = {}) { receive({ kind: roles ? 'assistant/roles-v1' : profile ? 'assistant/profile-v1' : 'assistant/read-v1', id: crypto.randomUUID(), operation, ...extra }); } };
}
beforeEach(async () => {
  h.roleExecute.mockReset().mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
  h.write.mockReset().mockResolvedValue({ ok: false, code: 'REVISION_CONFLICT' });
  h.session = {}; h.contexts = null; h.probe.mockReset().mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: true });
  h.read.mockReset().mockResolvedValue({ ok: true, value: { schemaVersion: 1, libraryRevision: '0', defaultTrackId: null, tracks: [] } });
  h.getUserId.mockReset().mockResolvedValue(ownerId); h.attest.mockReset().mockResolvedValue('READY');
  h.frames = [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://host.example.test/page' }];
});
function startWorker(profileEditing = false, roleManagement = false) {
  return installAssistantWorker({ getUserId: h.getUserId, readConnectionReadiness: h.attest,
    attestInstallLinked: async () => await h.attest() === 'READY' ? { userId: ownerId } : null,
    getAccessToken: vi.fn(), forceRefresh: vi.fn(), logout: vi.fn() } as unknown as AuthClient, 'https://api.example.test', 'https://portal.example.test', { profileEditing, roleManagement });
}
async function setup(profileEditing = false, roleManagement = false) {
  const worker = startWorker(profileEditing, roleManagement);
  // Capture the generated URL by deterministic UUID so admission still checks the worker's launch.
  const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('20000000-0000-4000-8000-000000000001').mockReturnValueOnce('30000000-0000-4000-8000-000000000001');
  (h as any).click({ id: 1 }); await drain(); uuid.mockRestore();
  h.frames.push({ frameId: 2, parentFrameId: 0, documentId: 'child', parentDocumentId: 'top', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/assistant.html?launch=20000000-0000-4000-8000-000000000001' });
  return worker;
}
afterEach(() => vi.restoreAllMocks());
describe('installed assistant worker ownership and provenance', () => {
  it('admits a real extension context omitted by Chrome webNavigation without skipping the host witness', async () => {
    await setup(); h.contexts = [{ tabId: 1, frameId: 2, documentId: 'child', documentUrl: h.frames[1].url }];
    h.frames = h.frames.slice(0, 1);
    const c = connect({ url: h.contexts[0].documentUrl }); c.send('SESSION'); await drain();
    expect(c.port.disconnect).not.toHaveBeenCalled();
    expect(c.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'SESSION', ok: true }));
    expect(h.probe).toHaveBeenCalledWith(1, expect.objectContaining({ kind: 'assistant/host-attest-v1' }), { documentId: 'top' });
    h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: false });
    c.send('RESUMES'); await drain();
    expect(c.port.disconnect).toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });

  it('rejects unknown host responses and never publishes a read after the host disappears', async () => {
    await setup(); h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: true, extra: 'untrusted' });
    const bad = connect(); bad.send('SESSION'); await drain();
    expect(bad.port.disconnect).toHaveBeenCalled(); expect(h.getUserId).not.toHaveBeenCalled();
    h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: true });
    const c = connect(); c.send('SESSION'); await drain(); c.port.postMessage.mockClear();
    let resolve!: (v: unknown) => void; h.read.mockReturnValue(new Promise(r => { resolve = r; }));
    c.send('RESUMES'); await drain();
    h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: false });
    resolve({ ok: true, value: { schemaVersion: 1, libraryRevision: '0', defaultTrackId: null, tracks: [] } }); await drain();
    expect(c.port.disconnect).toHaveBeenCalled(); expect(c.port.postMessage).not.toHaveBeenCalled();
  });
  it('reports only a fixed rejection reason and never sender or owner values', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setup(); const c = connect({ tab: undefined });
    expect(c.port.disconnect).toHaveBeenCalled();
    expect(log.mock.calls).toEqual([['[ArgoLand.AI]', 'WORKER_SENDER_TAB_MISSING']]);
    expect(h.getUserId).not.toHaveBeenCalled();
  });
  it('distinguishes missing launch records from a failed host attestation', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setup(); h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: false });
    const c = connect(); c.send('SESSION'); await drain();
    expect(log.mock.calls).toEqual([['[ArgoLand.AI]', 'FRAME_HOST_ATTESTATION_FAILED']]);
    expect(c.port.disconnect).toHaveBeenCalled(); expect(h.getUserId).not.toHaveBeenCalled();
    log.mockClear(); h.session = {}; startWorker();
    const missing = connect(); missing.send('SESSION'); await drain();
    expect(log.mock.calls).toEqual([['[ArgoLand.AI]', 'WORKER_LAUNCH_MISSING']]);
    expect(missing.port.disconnect).toHaveBeenCalled(); expect(h.getUserId).not.toHaveBeenCalled();
  });
  it('restores only the registered frame after worker restart and requires a fresh owner attestation', async () => {
    await setup(); const first = connect(); first.send('SESSION'); await drain(); first.port.disconnect();
    startWorker(); const resumed = connect();
    resumed.send('RESUMES'); await drain(); expect(h.read).not.toHaveBeenCalled();
    resumed.send('SESSION'); await drain();
    expect(resumed.port.disconnect).not.toHaveBeenCalled();
    expect(resumed.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'SESSION', ok: true,
      value: { identity: { ownerId, generation: 1 }, locale: 'en-US' } }));
    resumed.send('RESUMES'); await drain(); expect(h.read).toHaveBeenCalledOnce();
  });

  it('rejects a restored launch after the top document changes before reading credentials', async () => {
    await setup(); startWorker(); h.frames[0].documentId = 'new-top';
    const resumed = connect(); resumed.send('SESSION'); await drain();
    expect(resumed.port.disconnect).toHaveBeenCalled(); expect(h.getUserId).not.toHaveBeenCalled();
  });
  it('does not misreport an unavailable install attestation as a logged-out account', async () => {
    await setup(); h.attest.mockResolvedValue('AUTHORITY_UNAVAILABLE');
    const c = connect(); c.send('SESSION'); await drain();
    expect(c.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ operation: 'SESSION', ok: false, code: 'UNAVAILABLE' }));
    c.send('RESUMES'); await drain(); expect(h.read).not.toHaveBeenCalled();
  });
  it('rejects wrong extension, frame, document, URL and duplicate frames before authentication', async () => {
    await setup();
    for (const sender of [{ id: 'other' }, { frameId: 0 }, { documentId: 'stale' }, { url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/assistant.html' }]) {
      const c = connect(sender); c.send('SESSION'); await drain(); expect(c.port.disconnect).toHaveBeenCalled();
    }
    h.frames.push({ ...h.frames[1], frameId: 3 });
    const c = connect(); c.send('SESSION'); await drain(); expect(c.port.disconnect).toHaveBeenCalled();
    expect(h.getUserId).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });
  it('requires fresh install linkage and a bound session before any owner read', async () => {
    await setup(); const c = connect(); c.send('RESUMES'); await drain(); expect(h.read).not.toHaveBeenCalled();
    h.attest.mockResolvedValue('INSTALL_UNLINKED'); c.send('SESSION'); await drain(); c.send('RESUMES'); await drain(); expect(h.read).not.toHaveBeenCalled();
    h.attest.mockResolvedValue('READY'); c.send('SESSION'); await drain(); c.send('RESUMES'); await drain();
    expect(h.read).toHaveBeenCalledOnce(); expect(c.port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'RESUMES', ok: true });
  });
  it('never publishes a late owner response after invalidation or top-document navigation', async () => {
    const worker = await setup(), c = connect(); c.send('SESSION'); await drain();
    let resolve!: (v: any) => void; h.read.mockReturnValue(new Promise(r => { resolve = r; })); c.send('RESUMES'); await drain();
    worker.invalidate(); resolve({ ok: true, value: { schemaVersion: 1, libraryRevision: '0', defaultTrackId: null, tracks: [] } }); await drain();
    expect(c.port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'RESUMES', ok: false, code: 'OWNER_CHANGED' });
    h.onCommit({ tabId: 1, frameId: 0 }); expect(c.port.disconnect).toHaveBeenCalled();
  });
  it('accepts only closed locale messages from the configured top-level Portal origin', async () => {
    await setup();
    const m = { kind: 'assistant/portal-locale-v1', locale: 'zh-CN' };
    expect(h.onExternal(m, { frameId: 0, url: 'https://attacker.test' })).toBeUndefined();
    expect(h.onExternal(m, { frameId: 1, url: 'https://portal.example.test/settings' })).toBeUndefined();
    expect(h.onExternal({ ...m, ownerId }, { frameId: 0, url: 'https://portal.example.test/settings' })).toBeUndefined();
    expect(await h.onExternal(m, { frameId: 0, url: 'https://portal.example.test/settings' })).toEqual({ ok: true });
  });
});


describe('dedicated assistant Profile write port', () => {
  const patch = { schemaVersion: 2, expectedRevision: '1', expectedDeletionEpoch: '0', fields: { summary: 'Owner edit' } };
  it('disconnects the new port while editing is disabled', async () => {
    await setup(); const c = connect({}, true); c.send('SESSION'); await drain();
    expect(c.port.disconnect).toHaveBeenCalled(); expect(h.getUserId).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  });
  it('requires a fresh session and forwards only the validated patch plus a live window check', async () => {
    await setup(true); const c = connect({}, true);
    c.send('PATCH_PROFILE_V2', { patch }); await drain(); expect(h.write).not.toHaveBeenCalled();
    c.send('SESSION'); await drain(); c.send('PATCH_PROFILE_V2', { patch }); await drain();
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.write).toHaveBeenCalledWith({ ownerId, generation: 1 }, patch, expect.any(AbortSignal), expect.any(Function));
    expect(c.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'assistant/profile-result-v1', operation: 'PATCH_PROFILE_V2', ok: false, code: 'REVISION_CONFLICT' }));
    h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: false });
    expect(await h.write.mock.calls[0][3]()).toBe(false);
  });
  it('does not extend the readonly port even in an editing build', async () => {
    await setup(true); const c = connect(); c.send('SESSION'); await drain(); c.send('PATCH_PROFILE_V2', { patch }); await drain();
    expect(c.port.disconnect).toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  });
  it('never publishes a stale write response after a session transition', async () => {
    const worker = await setup(true); const c = connect({}, true); c.send('SESSION'); await drain();
    let resolve!: (v: unknown) => void; h.write.mockReturnValue(new Promise(r => { resolve = r; }));
    c.send('PATCH_PROFILE_V2', { patch }); await drain(); worker.invalidate();
    resolve({ ok: false, code: 'REVISION_CONFLICT' }); await drain();
    expect(c.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'PATCH_PROFILE_V2', ok: false, code: 'OWNER_CHANGED' }));
  });
});

it('delivers the layout secret only to the admitted frame, including after worker restart', async () => {
  await setup(); startWorker();
  const c = connect(); c.send('LAYOUT_CONTEXT'); await drain();
  expect(c.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'LAYOUT_CONTEXT', ok: true,
    value: { nonce: '30000000-0000-4000-8000-000000000001', origin: 'https://host.example.test' } }));
  expect(h.getUserId).not.toHaveBeenCalled();
  const impostor = connect({ frameId: 3 }); impostor.send('LAYOUT_CONTEXT'); await drain();
  expect(impostor.port.disconnect).toHaveBeenCalled(); expect(impostor.port.postMessage).not.toHaveBeenCalled();
});

it('keeps layout admission independent of an account generation change', async () => {
  const worker = await setup(), c = connect();
  h.probe.mockImplementation(async () => { worker.invalidate(); return { kind: 'assistant/host-attestation-v1', present: true }; });
  c.send('LAYOUT_CONTEXT'); await drain();
  expect(c.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'LAYOUT_CONTEXT', ok: true }));
  expect(c.port.disconnect).not.toHaveBeenCalled();
});

 it('keeps Role operations on the explicitly enabled private port with READY owner and live host admission', async () => {
    await setup(true); const disabled = connect({}, false, true); expect(disabled.port.disconnect).toHaveBeenCalled();
    h.frames = h.frames.slice(0, 1); h.session = {};
    await setup(true, true); const c = connect({}, false, true); c.send('LIST_ROLES', { cursor: null }); await drain();
    expect(h.roleExecute).not.toHaveBeenCalled();
    c.send('SESSION'); await drain(); c.send('LIST_ROLES', { cursor: null }); await drain();
    expect(h.roleExecute).toHaveBeenCalledOnce();
    expect(c.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'assistant/roles-result-v1', operation: 'LIST_ROLES', ok: true }));
    h.probe.mockResolvedValue({ kind: 'assistant/host-attestation-v1', present: false });
    c.send('LIST_ROLES', { cursor: null }); await drain(); expect(c.port.disconnect).toHaveBeenCalled(); expect(h.roleExecute).toHaveBeenCalledOnce();
  });

 it('reports commerce backpressure without disconnecting or invalidating the session', async () => {
  await setup(true, true); const c = connect({}, false, true); c.send('SESSION'); await drain();
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.read.mockReturnValue(new Promise(() => {}));
  for (let i = 0; i < 4; i++) c.send('RESUMES');
  const id = crypto.randomUUID(); c.raw({kind:'assistant/commerce-request-v1',id,operation:'USAGE'}); await drain();
  expect(c.port.postMessage).toHaveBeenLastCalledWith({kind:'assistant/commerce-result-v1',id,operation:'USAGE',ok:false,code:'UNAVAILABLE'});
  expect(c.port.disconnect).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('[ArgoLand.AI]', 'WORKER_INFLIGHT_LIMIT');
 });

it('answers intake backpressure without dropping the shared authenticated port', async () => {
  await setup(true, true); const c = connect({}, false, true); c.send('SESSION'); await drain();
  h.read.mockReturnValue(new Promise(() => {}));
  for (let i = 0; i < 4; i++) c.send('RESUMES');
  const id = crypto.randomUUID(); c.raw({kind:'assistant/intake-request-v1',id,operation:'CURRENT'}); await drain();
  expect(c.port.postMessage).toHaveBeenLastCalledWith({kind:'assistant/intake-result-v1',id,ok:false,code:'UNAVAILABLE'});
  expect(c.port.disconnect).not.toHaveBeenCalled();
});

describe('disabled Role and intake port boundary', () => {
  it('disconnects intake and voice messages on disabled Role or ordinary read ports before authentication', async () => {
    await setup(true, false);
    const roles=connect({},false,true);
    roles.raw({kind:'assistant/intake-request-v1',id:crypto.randomUUID(),operation:'CURRENT'});
    expect(roles.port.disconnect).toHaveBeenCalled();
    const read=connect();
    read.raw({kind:'assistant/intake-request-v1',id:crypto.randomUUID(),operation:'CURRENT'});
    expect(read.port.disconnect).toHaveBeenCalled();
    const voice=connect();
    voice.raw({kind:'assistant/voice-control-v1',id:crypto.randomUUID(),operation:'START'});
    expect(voice.port.disconnect).toHaveBeenCalled();
    expect(h.getUserId).not.toHaveBeenCalled(); expect(h.roleExecute).not.toHaveBeenCalled();
  });
});

it('restricts Autofill to the owner-bound role port and never accepts nominated authority',async()=>{
 await setup(false,true);
 const id=crypto.randomUUID(),selection={batchId:id,preparationId:id,missionId:id,resumeVersionId:id};
 const request={kind:'assistant/autofill-request-v1',id,operation:'READ',selection};
 const read=connect();read.raw(request);expect(read.port.disconnect).toHaveBeenCalled();
 const roles=connect({},false,true);roles.raw({...request,id:crypto.randomUUID()});await drain();
 expect(roles.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ok:false,code:'LOGIN_REQUIRED'}));
 roles.send('SESSION');await drain();roles.raw({...request,id:crypto.randomUUID()});await drain();
 expect(roles.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ok:false,code:'RESULT_UNKNOWN'}));
 roles.raw({...request,id:crypto.randomUUID(),url:'https://untrusted.example.test'});expect(roles.port.disconnect).toHaveBeenCalled();
});
it('gives an admitted Assistant sole Dock visibility until the last port disconnects',async()=>{
 await setup(false,true);const a=connect(),b=connect({},false,true);
 a.send('SESSION');b.send('SESSION');await drain();
 expect(h.probe).toHaveBeenCalledWith(1,{kind:'assistant/dock-visibility-v1',hidden:true},{documentId:'top'});
 h.probe.mockClear();a.port.disconnect();expect(h.probe).not.toHaveBeenCalledWith(1,{kind:'assistant/dock-visibility-v1',hidden:false},{documentId:'top'});
 b.port.disconnect();expect(h.probe).toHaveBeenCalledWith(1,{kind:'assistant/dock-visibility-v1',hidden:false},{documentId:'top'});
});
it('restores Dock when an unadmitted port remains after the admitted Assistant closes',async()=>{
 await setup(false,true);const admitted=connect(),pending=connect({},false,true);
 admitted.send('SESSION');await drain();h.probe.mockClear();admitted.port.disconnect();
 expect(h.probe).toHaveBeenCalledWith(1,{kind:'assistant/dock-visibility-v1',hidden:false},{documentId:'top'});
 pending.port.disconnect();
});

it('keeps read polling bounded without exhausting the mutation replay budget',async()=>{
 await setup(false,true);const c=connect({},false,true);c.send('SESSION');await drain();
 const selection={batchId:ownerId,preparationId:ownerId,missionId:ownerId,resumeVersionId:ownerId};
 for(let i=0;i<4100;i++){c.raw({kind:'assistant/autofill-request-v1',id:crypto.randomUUID(),operation:'READ',selection});await drain();}
 expect(c.port.disconnect).not.toHaveBeenCalled();
});
it('releases the Dock lease on session invalidation',async()=>{
 const worker=await setup(false,true);const c=connect({},false,true);c.send('SESSION');await drain();h.probe.mockClear();
 worker.invalidate();await drain();
 expect(h.probe).toHaveBeenCalledWith(1,{kind:'assistant/dock-visibility-v1',hidden:false},{documentId:'top'});
});

it('reports a stable diagnostic when a Dock visibility send fails',async()=>{
 await setup(false,true);const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 h.probe.mockImplementation(async(_tab,message)=>{if(message.kind==='assistant/dock-visibility-v1')throw new Error('private detail');return {kind:'assistant/host-attestation-v1',present:true};});
 const c=connect();c.send('SESSION');await drain();
 expect(warn).toHaveBeenCalledWith('[ArgoLand.AI]','WORKER_OPERATION_FAILED');
 warn.mockClear();c.port.disconnect();await drain();expect(warn).toHaveBeenCalledWith('[ArgoLand.AI]','WORKER_OPERATION_FAILED');
 expect(JSON.stringify(warn.mock.calls)).not.toContain('private detail');
});
