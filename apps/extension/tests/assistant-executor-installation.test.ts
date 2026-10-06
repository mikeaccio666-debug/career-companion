import { expect, it, vi } from 'vitest';
import { createAssistantExecutorInstaller, claimAssistantExecutor, markAssistantExecutorReady, readAssistantExecutorState } from '../assistant/features/autofill/executor-installation';
const setup = () => {
  let current = true, ready = false;
  const controller = new AbortController();
  const context = { tabId: 7, topDocumentId: 'doc', topUrl: 'https://example.test/apply', ownerKey: 'owner', signal: controller.signal, current: async () => current };
  const probe = vi.fn(async () => [{ frameId: 0, documentId: 'doc', result: ready ? 'READY' : 'ABSENT' }]);
  const inject = vi.fn(async () => { ready = true; return [{ frameId: 0, documentId: 'doc' }]; });
  const install = createAssistantExecutorInstaller({ probe, inject });
  return { context, controller, probe, inject, install, stale: () => { current = false; } };
};
it('injects once into the exact document and survives a worker installer restart', async () => {
  const s = setup();
  expect(await s.install(s.context, s.controller.signal)).toEqual({ok:true});
  expect(s.inject).toHaveBeenCalledExactlyOnceWith(7, 'doc');
  expect(await createAssistantExecutorInstaller(s)(s.context, s.controller.signal)).toEqual({ok:true});
  expect(s.inject).toHaveBeenCalledTimes(1);
});
it('serializes concurrent installation in the same document', async () => {
  const s = setup();
  expect(await Promise.all([s.install(s.context,s.controller.signal),s.install(s.context,s.controller.signal)])).toEqual([{ok:true},{ok:true}]);
  expect(s.inject).toHaveBeenCalledTimes(1);
});
it.each(['missing','stale','aborted'])('refuses %s context before probing', async kind => {
  const s = setup();
  if(kind==='missing') s.context.topDocumentId = '';
  if(kind==='stale') s.stale();
  if(kind==='aborted') s.controller.abort();
  expect(await s.install(s.context,s.controller.signal)).toMatchObject({ok:false});
  expect(s.probe).not.toHaveBeenCalled(); expect(s.inject).not.toHaveBeenCalled();
});
it.each([
  [], [{frameId:1,documentId:'doc',result:'READY'}], [{frameId:0,documentId:'other',result:'READY'}],
  [{frameId:0,documentId:'doc',result:true}], [{frameId:0,documentId:'doc',result:'UNAVAILABLE'}],
].map(results => ({results})))('does not inject on unverifiable probe results', async ({results}) => {
  const s=setup(); s.probe.mockResolvedValue(results as never);
  expect(await s.install(s.context,s.controller.signal)).toMatchObject({ok:false}); expect(s.inject).not.toHaveBeenCalled();
});
it('rechecks currentness after the probe and injection', async () => {
  for(const phase of ['probe','inject']) {
    const s=setup(); const method=phase==='probe'?s.probe:s.inject; const original=method.getMockImplementation()!;
    method.mockImplementation(async () => { const result=await original(); s.stale(); return result as never; });
    expect(await s.install(s.context,s.controller.signal)).toMatchObject({ok:false});
    if(phase==='probe') expect(s.inject).not.toHaveBeenCalled();
  }
});
it('does not accept failed injection or a missing ready witness', async () => {
  const s=setup(); s.inject.mockRejectedValue(new Error('private details'));
  expect(await s.install(s.context,s.controller.signal)).toMatchObject({ok:false});
  const t=setup(); t.inject.mockResolvedValue([{frameId:0,documentId:'doc'}]);
  expect(await t.install(t.context,t.controller.signal)).toMatchObject({ok:false});
});
it('the isolated-world marker only deduplicates installation and becomes ready explicitly', () => {
  expect(readAssistantExecutorState()).toBe('ABSENT');
  expect(claimAssistantExecutor()).toBe(true); expect(claimAssistantExecutor()).toBe(false);
  expect(readAssistantExecutorState()).toBe('INSTALLING');
  markAssistantExecutorReady(); expect(readAssistantExecutorState()).toBe('READY');
});
it('times out a stuck probe without allowing late injection', async () => {
  vi.useFakeTimers();
  try {
    const s=setup(); let resolve!: (value: never) => void;
    s.probe.mockImplementation(() => new Promise(r => { resolve=r; }));
    const pending=s.install(s.context,s.controller.signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ok:false,code:'EXECUTOR_TIMEOUT'});
    const second = s.install(s.context,s.controller.signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await second).toEqual({ok:false,code:'EXECUTOR_TIMEOUT'});
    expect(s.probe).toHaveBeenCalledTimes(1);
    resolve([{frameId:0,documentId:'doc',result:'ABSENT'}] as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.inject).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it.each([['INSTALLING','EXECUTOR_RELOAD_REQUIRED'],['FAILED','EXECUTOR_RELOAD_REQUIRED'],['garbage','EXECUTOR_PROBE_INVALID']])('reports recoverable init state %s as %s',async(state,code)=>{
 const s=setup();s.probe.mockResolvedValue([{frameId:0,documentId:'doc',result:state}]);
 expect(await s.install(s.context,s.controller.signal)).toEqual({ok:false,code});expect(s.inject).not.toHaveBeenCalled();
});
it('reports cancellation promptly while a browser probe is stalled', async () => {
  const s=setup();s.probe.mockImplementation(()=>new Promise(()=>{}));
  const pending=s.install(s.context,s.controller.signal);
  await Promise.resolve();s.controller.abort();
  expect(await pending).toEqual({ok:false,code:'RUN_STOPPED'});expect(s.inject).not.toHaveBeenCalled();
});

it('reports unavailable capacity without claiming there is a running fill', async () => {
 const s=setup();s.probe.mockImplementation(()=>new Promise(()=>{}));
 const pending=Array.from({length:64},(_,i)=>s.install({...s.context,tabId:i},s.controller.signal));
 expect(await s.install({...s.context,tabId:64},s.controller.signal)).toEqual({ok:false,code:'EXECUTOR_UNAVAILABLE'});
 s.controller.abort();await Promise.all(pending);expect(s.inject).not.toHaveBeenCalled();
});
