import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShortlistScene } from '../assistant/scenes/ShortlistScene';
import { CoverScene } from '../assistant/scenes/CoverScene';
import { createAssistantView } from '../assistant/app/view-model';
import { createViewContext } from '../assistant/app/view-context';
import { panelDimensions } from '../assistant/shell/geometry';
import {it,expect,vi} from 'vitest';
import {parseUuid,type AssistantCommerceResult,type ApplicationPreparationView,type AssistantCoverDraftResponse} from '@edaix/contracts';
import {createAssistantController} from '../assistant/app/controller';
import {createReadOnlyPorts} from '../assistant/features/session/read-only-ports';
import {initialAssistantState} from '../assistant/state/initial';
import {previewData} from '../assistant/testing/fixtures';
import {createCommerceFixture,COMMERCE_FIXTURE_ROLE as role,COMMERCE_FIXTURE_RESUME as resume} from '../assistant/testing/commerce-fixture';
const uuid=(n:number)=>parseUuid(`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`)!;
const now='2026-09-13T00:00:00.000Z' as never;
function harness(){
 const f=createCommerceFixture(),first={...f.entry(),state:'SAVED' as const},second={...first,id:uuid(2),batchId:uuid(3),itemId:uuid(4),canonicalJobId:uuid(5)};
 const entries=[first,second],preps=new Map<string,ApplicationPreparationView>();let cover:AssistantCoverDraftResponse={schemaVersion:1,entryId:first.id,revision:0,draft:null};
 const execute=vi.fn(async(c:Parameters<typeof f.ports.execute>[0]):Promise<AssistantCommerceResult>=>{
  if(c.operation==='JOBS_LIST')return {operation:c.operation,ok:true,value:{schemaVersion:1,entries,nextCursor:null,usage:{feature:'jobs.delivered',unit:'JOB',state:'AVAILABLE',limit:20,consumed:2,reserved:0,remaining:18,windowStart:now,resetsAt:'2026-10-01T00:00:00.000Z' as never}}};
  if(c.operation==='RESUME_SELECTION')return {operation:c.operation,ok:true,value:{schemaVersion:1,libraryRevision:'2' as never,defaultResumeVersionId:parseUuid(resume),items:[{trackId:uuid(6),trackName:'General',resumeVersionId:parseUuid(resume)!,label:'My CV',fileName:'cv.pdf',mimeType:'application/pdf',fileSize:100,versionNumber:1,contentRevision:'1' as never,isDefault:true,createdAt:now,updatedAt:now}]}};
  if(c.operation==='RESUME_LIBRARY')return {operation:c.operation,ok:true,value:{schemaVersion:1,libraryRevision:'2' as never,defaultTrackId:uuid(6),tracks:[{trackId:uuid(6),name:'General',archivedAt:null,isDefault:true,currentVersionId:parseUuid(resume),hasMoreVersions:false,createdAt:now,updatedAt:now,versions:[]}]}};
  if(c.operation==='PREPARATION_BATCH'){const e=entries.find(e=>e.batchId===c.batchId)!;return {operation:c.operation,ok:true,value:{schemaVersion:1,batch:{id:parseUuid(e.batchId)!,conversationId:parseUuid(role)!,revision:'1' as never,status:'OPEN',localDate:'2026-09-13' as never,generatedAt:now,expiresAt:'2026-09-14T00:00:00.000Z' as never,updatedAt:now,items:[{id:parseUuid(e.itemId)!,revision:'1' as never,status:'PENDING',job:e.job,missionId:null,decidedAt:null}],counts:{total:1,pending:1,approved:0,skipped:0,unavailable:0}}}};}
  if(c.operation==='PREPARATION_START'){const e=entries.find(e=>e.batchId===c.batchId)!;preps.set(e.id,{preparationId:uuid(e.id===first.id?7:8),itemId:parseUuid(e.itemId)!,revision:'1' as never,status:'READY',failureCode:null,retryable:false,resumeVersionId:parseUuid(resume),missionId:uuid(9),updatedAt:now});}
  if(c.operation==='PREPARATION_RETRY'){const e=entries.find(e=>e.batchId===c.batchId)!;preps.set(e.id,{...preps.get(e.id)!,revision:'2' as never,status:'READY',failureCode:null,retryable:false,missionId:uuid(9)});}
  if(c.operation==='PREPARATION_LIST'||c.operation==='PREPARATION_START'||c.operation==='PREPARATION_RETRY')return {operation:c.operation,ok:true,value:{schemaVersion:1,batchId:parseUuid(c.batchId)!,conversationId:parseUuid(role)!,items:entries.filter(e=>e.batchId===c.batchId).flatMap(e=>preps.has(e.id)?[preps.get(e.id)!]:[])}};
  if(c.operation==='COVER_READ')return {operation:c.operation,ok:true,value:cover};
  if(c.operation==='COVER_WRITE'){cover={schemaVersion:1,entryId:c.entryId,revision:cover.revision+1,draft:c.request.operation==='DELETE'?null:{id:uuid(10),body:c.request.operation==='SAVE'?c.request.body:'Generated confirmed facts.',origin:c.request.operation==='SAVE'?'USER_EDITED':'GENERATED',updatedAt:now,deliveryAuthorized:false}};return {operation:c.operation,ok:true,value:cover};}
  return {operation:c.operation,ok:false,code:'UNAVAILABLE'};
 });
 const make=()=>{const session=async()=>({ok:true as const,value:undefined});return createAssistantController(previewData,{...createReadOnlyPorts({login:session,logout:session,refresh:session}),commerce:{execute}},
  {...initialAssistantState(previewData,{persona:'out',locale:'en-US',entitlements:{ats:{access:'unavailable'},jobs:{access:'unavailable'},letters:{access:'unavailable'},chat:{access:'unavailable'},voice:{access:'unavailable'}}}),session:'connected',currentTargetId:role});};
 return {execute,make,entries,preps,first,second};
}
it('requires an explicit plan, prepares across batches and restores accepted results without duplicate Start',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');expect(ui.ctx.state.materials?.choice).toBeNull();
 await ui.dispatch('prepare');expect(h.execute.mock.calls.some(([c])=>c.operation==='PREPARATION_START')).toBe(false);
 await ui.dispatch('material-select',`existing:${resume}`);await ui.dispatch('prepare');
 expect(h.execute.mock.calls.filter(([c])=>c.operation==='PREPARATION_START')).toHaveLength(2);
 for(const [c] of h.execute.mock.calls)if(c.operation==='PREPARATION_START')expect(c.request.materialPlan).toEqual({mode:'USE_EXISTING',trackId:uuid(6),resumeVersionId:resume,expectedLibraryRevision:'2'});
 expect(ui.ctx.state.preparedResume).toEqual({[h.first.id]:resume,[h.second.id]:resume});ui.dispose();
 const next=h.make();await next.dispatch('open-shortlist');expect(Object.values(next.ctx.state.prep)).toEqual(['ready','ready']);
 await next.dispatch('material-select',`generate:${uuid(6)}`);expect(next.ctx.state.materials?.choice).toBe(`generate:${uuid(6)}`);
 await next.dispatch('prepare');expect(h.execute.mock.calls.filter(([c])=>c.operation==='PREPARATION_START')).toHaveLength(2);next.dispose();
});
it('retries only the server-retryable failed job and retains the successful binding',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');await ui.dispatch('material-select',`existing:${resume}`);await ui.dispatch('prepare');
 h.preps.set(h.second.id,{...h.preps.get(h.second.id)!,status:'FAILED',missionId:null,failureCode:'MISSION_UNAVAILABLE',retryable:true});
 await ui.dispatch('materials-refresh');await ui.dispatch('short-retry',h.first.id);await ui.dispatch('short-retry',h.second.id);
 expect(h.execute.mock.calls.filter(([c])=>c.operation==='PREPARATION_RETRY')).toHaveLength(1);expect(ui.ctx.state.prep).toEqual({[h.first.id]:'ready',[h.second.id]:'ready'});ui.dispose();
});
it('edits, restores and deletes account drafts with server revisions',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');await ui.dispatch('open-cover',h.first.id);ui.connectedMaterials.edit('My checked draft.');
 await ui.dispatch('cover-keep');expect(ui.ctx.state.letters[h.first.id]).toMatchObject({status:'kept',text:'My checked draft.'});ui.dispose();
 const next=h.make();await next.dispatch('open-shortlist');await next.dispatch('open-cover',h.first.id);expect(next.ctx.state.letters[h.first.id]?.text).toBe('My checked draft.');
 await next.dispatch('cover-delete');expect(next.ctx.state.materials?.covers[h.first.id]).toMatchObject({revision:2,draft:null});next.dispose();
});
it('drops late private material responses after scope reset',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');let done!:(r:AssistantCommerceResult)=>void;
 h.execute.mockImplementationOnce(()=>new Promise(r=>{done=r;}));const read=ui.dispatch('open-cover',h.first.id);
 await Promise.resolve();await Promise.resolve();ui.reset({...ui.ctx.state,currentTargetId:null,materials:undefined,letters:{}});
 done({operation:'COVER_READ',ok:true,value:{schemaVersion:1,entryId:h.first.id,revision:1,draft:{id:uuid(10),body:'Private fixture',origin:'USER_EDITED',updatedAt:now,deliveryAuthorized:false}}});await read;
 expect(ui.ctx.state.letters).toEqual({});expect(ui.ctx.state.materials).toBeUndefined();ui.dispose();
});

it('keeps newer edits unsaved when an uncertain old save is replayed',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');await ui.dispatch('open-cover',h.first.id);
 ui.connectedMaterials.edit('Version one.');h.execute.mockResolvedValueOnce({operation:'COVER_WRITE',ok:false,code:'SAVE_UNCERTAIN'});
 await ui.dispatch('cover-keep');ui.connectedMaterials.edit('Version two.');await ui.dispatch('cover-keep');
 expect(ui.ctx.state.materials?.covers[h.first.id]?.draft?.body).toBe('Version one.');
 expect(ui.ctx.state.letters[h.first.id]).toMatchObject({text:'Version two.',status:'draft'});
 expect(ui.ctx.state.toast).toMatch(/current edits are still unsaved/i);ui.dispose();
});
it('allows a fresh explicit plan after SOURCE_CHANGED without retrying the failed identity',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');await ui.dispatch('material-select',`existing:${resume}`);await ui.dispatch('prepare');
 h.preps.set(h.second.id,{...h.preps.get(h.second.id)!,status:'FAILED',missionId:null,failureCode:'SOURCE_CHANGED',retryable:false});
 await ui.dispatch('materials-refresh');await ui.dispatch('material-select',`generate:${uuid(6)}`);await ui.dispatch('prepare');
 const starts=h.execute.mock.calls.filter(([c])=>c.operation==='PREPARATION_START');expect(starts).toHaveLength(3);
 expect(starts[2]![0]).toMatchObject({request:{materialPlan:{mode:'GENERATE_FOR_JOB'}}});
 expect(h.execute.mock.calls.some(([c])=>c.operation==='PREPARATION_RETRY')).toBe(false);ui.dispose();
});
it('explains a daily generation cap instead of suggesting immediate retries',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');await ui.dispatch('open-cover',h.first.id);
 h.execute.mockResolvedValueOnce({operation:'COVER_WRITE',ok:false,code:'RATE_LIMITED'});await ui.dispatch('cover-generate');
 expect(ui.ctx.state.toast).toMatch(/tomorrow/i);ui.dispose();
});

it('renders separate shortlist JD and draft actions, and deletion for unreadable drafts',async()=>{
 const h=harness(),ui=h.make();await ui.dispatch('open-shortlist');
 const view=()=>createAssistantView(createViewContext(ui.ctx.state,ui.ctx.data,panelDimensions('shortlist',{width:375,height:800})));
 const markup=renderToStaticMarkup(createElement(ShortlistScene,{view:view(),events:{} as never}));
 expect(markup).toContain('data-act="open-jd"');expect(markup).toContain('data-act="open-cover"');
 h.execute.mockResolvedValueOnce({operation:'COVER_READ',ok:true,value:{schemaVersion:1,entryId:h.first.id,revision:2,draft:null,unavailableReason:'CONTENT_UNAVAILABLE'}});
 await ui.dispatch('open-cover',h.first.id);
 const cover=renderToStaticMarkup(createElement(CoverScene,{view:view(),events:{} as never}));
 expect(cover).toContain('data-act="cover-delete"');expect(cover).toContain('cannot be read right now');ui.dispose();
});

for (const operation of ['PREPARATION_START','PREPARATION_RETRY'] as const) {
 it(`recovers a lost ${operation} acknowledgement without changing the accepted request`,async()=>{
  const h=harness(),ui=h.make();
  try {
   await ui.dispatch('open-shortlist');await ui.dispatch('material-select',`existing:${resume}`);
   if(operation==='PREPARATION_RETRY'){
    await ui.dispatch('prepare');
    h.preps.set(h.first.id,{...h.preps.get(h.first.id)!,status:'FAILED',missionId:null,failureCode:'MISSION_UNAVAILABLE',retryable:true});
    await ui.dispatch('materials-refresh');
   }
   const base=h.execute.getMockImplementation()!,receipts=new Map<string,AssistantCommerceResult>();
   let accepted=0;
   h.execute.mockImplementation(async(c)=>{
    if(c.operation!==operation||c.batchId!==h.first.batchId)return base(c);
    const prior=receipts.get(c.request.clientRequestId);if(prior)return prior;
    const result=await base(c);receipts.set(c.request.clientRequestId,result);accepted++;
    return {operation:c.operation,ok:false,code:'SAVE_UNCERTAIN'};
   });
   if(operation==='PREPARATION_START')await ui.dispatch('prepare');else await ui.dispatch('short-retry',h.first.id);
   await ui.dispatch('materials-refresh');
   expect(ui.ctx.state.prep[h.first.id]).toBe('ready');
   await ui.dispatch('material-select',`generate:${uuid(6)}`);
   expect(ui.ctx.state.materials?.choice).toBe(`generate:${uuid(6)}`);
   const calls=h.execute.mock.calls.map(([c])=>c).filter(c=>c.operation===operation&&c.batchId===h.first.batchId);
   expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(accepted).toBe(1);
  } finally {ui.dispose();}
 });
}
it('keeps the original plan locked until replay is acknowledged, even when reads show READY',async()=>{
 const h=harness(),ui=h.make();
 try {
  await ui.dispatch('open-shortlist');await ui.dispatch('material-select',`existing:${resume}`);
  const base=h.execute.getMockImplementation()!;let acknowledge=false;
  h.execute.mockImplementation(async(c)=>{
   const result=await base(c);
   return c.operation==='PREPARATION_START'&&c.batchId===h.first.batchId&&!acknowledge
    ? {operation:c.operation,ok:false,code:'SAVE_UNCERTAIN'}:result;
  });
  await ui.dispatch('prepare');await ui.dispatch('materials-refresh');
  expect(ui.ctx.state.prep[h.first.id]).toBe('ready');
  await ui.dispatch('material-select',`generate:${uuid(6)}`);
  expect(ui.ctx.state.materials?.choice).toBe(`existing:${resume}`);
  acknowledge=true;await ui.dispatch('prepare');await ui.dispatch('materials-refresh');
  await ui.dispatch('material-select',`generate:${uuid(6)}`);
  expect(ui.ctx.state.materials?.choice).toBe(`generate:${uuid(6)}`);
  const calls=h.execute.mock.calls.map(([c])=>c).filter(c=>c.operation==='PREPARATION_START'&&c.batchId===h.first.batchId);
  expect(calls.length).toBeGreaterThan(1);for(const c of calls)expect(c).toEqual(calls[0]);
 } finally {ui.dispose();}
});
it('polls preparation status without repeatedly replaying an uncertain write',async()=>{
 vi.useFakeTimers();const h=harness(),ui=h.make();
 try{
  const base=h.execute.getMockImplementation()!;
  h.execute.mockImplementation(async(c)=>{
   const result=await base(c);
   if(c.operation==='PREPARATION_START'&&c.batchId===h.first.batchId){
    h.preps.set(h.first.id,{...h.preps.get(h.first.id)!,status:'QUEUED',missionId:null});
    return {operation:c.operation,ok:false,code:'SAVE_UNCERTAIN'};
   }return result;
  });
  await ui.dispatch('open-shortlist');await ui.dispatch('material-select',`existing:${resume}`);await ui.dispatch('prepare');
  const count=()=>h.execute.mock.calls.filter(([c])=>c.operation==='PREPARATION_START').length;
  const before=count();await vi.advanceTimersByTimeAsync(6000);expect(count()).toBe(before);
  await ui.dispatch('materials-refresh');expect(count()).toBe(before+1);
 }finally{ui.dispose();vi.useRealTimers();}
});
