import {describe,expect,it,vi} from 'vitest';
import {createAssistantController} from '../assistant/app/controller';
import {createAssistantView} from '../assistant/app/view-model';
import {createReadOnlyPorts} from '../assistant/features/session/read-only-ports';
import {initialAssistantState} from '../assistant/state/initial';
import {previewData} from '../assistant/testing/fixtures';
import {createCommerceFixture,COMMERCE_FIXTURE_ROLE,COMMERCE_FIXTURE_RESUME} from '../assistant/testing/commerce-fixture';
import {panelDimensions} from '../assistant/shell/geometry';
import {atsInputKey,createViewContext} from '../assistant/app/view-context';
function setup(){
  const fixture=createCommerceFixture(),execute=vi.spyOn(fixture.ports,'execute');
  const connected=async()=>({ok:true as const,value:undefined});
  const initial={...initialAssistantState(previewData,{persona:'out',locale:'en-US',entitlements:{ats:{access:'unavailable'},jobs:{access:'unavailable'},letters:{access:'unavailable'},chat:{access:'unavailable'},voice:{access:'unavailable'}}}),session:'connected' as const,currentTargetId:COMMERCE_FIXTURE_ROLE,
    hasResume:true,resumeId:COMMERCE_FIXTURE_RESUME,resumeOptions:[{id:COMMERCE_FIXTURE_RESUME,track:'General',version:'v1',label:'Selected resume v1',kind:'existing' as const,current:true,note:''}]};
  const ui=createAssistantController(previewData,{...createReadOnlyPorts({login:connected,logout:connected,refresh:connected}),commerce:fixture.ports},initial);
  return {fixture,execute,ui};
}
describe('connected jobs and ATS UI',()=>{
  it.each(['LOCKED','USAGE_EXHAUSTED','VALIDATION_FAILED','LOGIN_REQUIRED','UNAVAILABLE'] as const)('never claims background work for a rejected start: %s',async code=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');execute.mockRestore();
    const original=fixture.ports.execute.bind(fixture.ports);
    vi.spyOn(fixture.ports,'execute').mockImplementation(async(command,signal)=>{
      if(command.operation==='ATS_START')return {operation:'ATS_START',ok:false,code};
      const result=await original(command,signal);
      if(result.ok&&result.operation==='USAGE')return {...result,value:{...result.value,usage:result.value.usage.map(value=>value.feature==='ats.report'?{...value,state:code==='LOCKED'?'DENIED':value.state,remaining:code==='USAGE_EXHAUSTED'?0:value.remaining}:value)}};
      return result;
    });
    await ui.dispatch('ats-score',fixture.entry().id);
    expect(Object.values(ui.ctx.state.atsResults)[0]?.status).toBe('failed');
    const view=createAssistantView(createViewContext(ui.ctx.state,ui.ctx.data,panelDimensions('deck',{width:1280,height:900})));
    expect(view.ats.title).not.toMatch(/background/i);
    if(code==='LOCKED')expect(view.ats.showLock).toBe(true);
    if(code==='USAGE_EXHAUSTED')expect(view.ats.actions.some(action=>action.act==='open-usage')).toBe(true);
    ui.dispose();
  });
  it('explains the daily provider cap and keeps existing reports accessible',async()=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');
    const original=fixture.ports.execute.bind(fixture.ports);execute.mockRestore();
    vi.spyOn(fixture.ports,'execute').mockImplementation(async(command,signal)=>{
      const result=await original(command,signal);
      return result.ok && result.operation==='ATS_START'?{...result,value:{...result.value,status:'FAILED',report:null,failureCode:'RATE_LIMITED'}}:result;
    });
    await ui.dispatch('ats-score',fixture.entry().id);
    const view=createAssistantView(createViewContext(ui.ctx.state,ui.ctx.data,panelDimensions('deck',{width:1280,height:900})));
    expect(view.ats.title).toMatch(/tomorrow/i);
    expect(view.ats.actions.map(action=>action.act)).toEqual(['ats-existing']);ui.dispose();
  });
  it('preserves an uncertain submission as pending for safe lookup',async()=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');
    execute.mockImplementationOnce(async()=>({operation:'ATS_START',ok:false,code:'SAVE_UNCERTAIN'}));
    await ui.dispatch('ats-score',fixture.entry().id);
    expect(Object.values(ui.ctx.state.atsResults)[0]?.status).toBe('pending');ui.dispose();
  });

  it('renders cached usage in the current language without fetching or consuming again',async()=>{
    const {ui,execute}=setup();await ui.dispatch('discover');
    const calls=execute.mock.calls.length;
    const context=createViewContext({...ui.ctx.state,locale:'zh-CN'},ui.ctx.data,panelDimensions('deck',{width:1280,height:900}));
    expect(context.ent('jobs')).toMatchObject({unit:'个岗位',period:'本周期',remaining:19});
    expect(context.ent('jobs').resetsAt).toBe(new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date('2026-10-01T00:00:00.000Z')));
    expect(execute).toHaveBeenCalledTimes(calls);ui.dispose();
  });
  it('uses server entries, receipts and usage instead of preview cards or local counters',async()=>{
    const {ui,fixture}=setup();expect(ui.ctx.data.jobs).toEqual([]);
    await ui.dispatch('discover');expect(ui.ctx.state.scene).toBe('deck');expect(ui.ctx.data.jobs.map(job=>job.id)).toEqual([fixture.entry().id]);
    expect(ui.ctx.state.entitlements.jobs).toMatchObject({remaining:19,used:1});
    await ui.dispatch('deck-accept');expect(ui.ctx.state.deck.selected).toEqual([fixture.entry().id]);
    expect(fixture.entry()).toMatchObject({state:'SAVED',revision:2});expect(ui.ctx.state.entitlements.jobs.used).toBe(1);
    await ui.dispatch('open-shortlist');expect(ui.ctx.state.deck.selected).toEqual([fixture.entry().id]);
    await ui.dispatch('short-remove',fixture.entry().id);expect(ui.ctx.state.deck.selected).toEqual([]);expect(fixture.entry().state).toBe('RECEIVED');
    ui.dispose();
  });
  it('does not advance the card until the server acknowledges a decision',async()=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');
    let finish!:(value:Awaited<ReturnType<typeof fixture.ports.execute>>)=>void;
    execute.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=ui.dispatch('deck-accept');expect(ui.ctx.state.deck.busy).toBe(true);expect(ui.ctx.state.deck.index).toBe(0);expect(ui.ctx.state.deck.selected).toEqual([]);
    finish({operation:'JOB_DECIDE',ok:false,code:'SAVE_UNCERTAIN'});await pending;
    expect(ui.ctx.state.deck.index).toBe(0);expect(ui.ctx.state.deck.selected).toEqual([]);expect(ui.ctx.state.deck.busy).toBe(false);ui.dispose();
  });
  it('binds scores to the selected version and renders provider denominators without sample labels',async()=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');await ui.dispatch('ats-score',fixture.entry().id);
    const job=ui.ctx.data.jobs[0]!,report=ui.ctx.state.atsResults[atsInputKey(job,COMMERCE_FIXTURE_RESUME)]!;
    expect(report.status).toBe('ready');expect(report.report?.definitions?.A.max).toBe(50);
    expect(execute).toHaveBeenCalledWith({operation:'ATS_START',request:{entryId:fixture.entry().id,resumeVersionId:COMMERCE_FIXTURE_RESUME}},expect.any(AbortSignal));
    const view=createAssistantView(createViewContext(ui.ctx.state,ui.ctx.data,panelDimensions('deck',{width:1280,height:900})));
    expect(view.deck.sourceLine).not.toMatch(/example|sample/i);expect(view.home.shortlistTitle).toBe('Saved jobs');
    expect(Object.values(ui.ctx.state.atsResults).some(result=>result.status==='scoring')).toBe(false);
    expect(view.ats.caption).not.toMatch(/example|sample/i);expect(view.ats.mini[0]?.pct).toBe(77);expect(ui.ctx.state.entitlements.ats.used).toBe(1);
    await ui.dispatch('ats-details',fixture.entry().id);
    const details=createAssistantView(createViewContext(ui.ctx.state,ui.ctx.data,panelDimensions('deck',{width:1280,height:900})));
    expect(details.sheet.ats.dims[0]?.scoreText).toBe('38.5 / 50');expect(details.sheet.ats.dims[3]?.scoreText).toBe('Unavailable');ui.dispose();
  });
  it('looks up old reports without starting or charging new work',async()=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');await ui.dispatch('ats-existing',fixture.entry().id);
    expect(execute.mock.calls.some(([command])=>command.operation==='ATS_START')).toBe(false);expect(fixture.scored()).toBe(false);ui.dispose();
  });
  it('fails visibly when a report does not belong to the current job',async()=>{
    const {ui,fixture,execute}=setup();await ui.dispatch('discover');
    const original=fixture.ports.execute.bind(fixture.ports);execute.mockRestore();
    vi.spyOn(fixture.ports,'execute').mockImplementation(async(command,signal)=>{
      const result=await original(command,signal);
      return result.ok&&result.operation==='ATS_START'?{...result,value:{...result.value,source:{...result.value.source,canonicalJobId:'99999999-9999-4999-8999-999999999999'}}}:result;
    });
    await ui.dispatch('ats-score',fixture.entry().id);
    expect(Object.values(ui.ctx.state.atsResults)).toEqual([expect.objectContaining({status:'failed',failureCode:'SOURCE_CHANGED'})]);
    ui.dispose();
  });
  it('discards late results after the owner scope is reset',async()=>{
    const {ui,fixture,execute}=setup();let release!:()=>void;
    execute.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({operation:'JOBS_LIST',ok:true,value:{schemaVersion:1,entries:[fixture.entry()],nextCursor:null,usage:{feature:'jobs.delivered',unit:'JOB',state:'AVAILABLE',limit:20,consumed:1,reserved:0,remaining:19,windowStart:'2026-09-01T00:00:00.000Z' as never,resetsAt:'2026-10-01T00:00:00.000Z' as never}}});}));
    const pending=ui.dispatch('discover');ui.reset({...ui.ctx.state,commerce:undefined,jobOptions:[],currentTargetId:null});release();await pending;
    expect(ui.ctx.data.jobs).toEqual([]);expect(ui.ctx.state.deck.items).toEqual([]);ui.dispose();
  });
});
