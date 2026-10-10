import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseStaffContentWithdrawalPage} from '@companion/platform-contracts';
import {StaffContentController} from '../src/staff-content-controller.ts';
import {staffContentOrganization,readStaffContentWithdrawals,type StaffContentClient} from '../src/staff-content-api.ts';
import {ApiError} from '../src/api-error.ts';
const actor=randomUUID(),org=randomUUID(),time='2026-10-09T12:00:00.000Z';
const row=(sourceId=randomUUID())=>({sourceId,title:'Fictional withdrawn question',revision:3,withdrawnAt:time});
const page=(records=[row()],nextCursor:string|null=null)=>({actorId:actor,organizationId:org,records,nextCursor});
function harness(run:(p:string,i:RequestInit)=>unknown,timeout=1000){
 let current=true;const listeners=new Set<()=>void>();
 const client:StaffContentClient={account:{accountId:actor},isCurrent:()=>current,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
 request:async(p,i={})=>await run(p,i) as any};
 return {client,controller:new StaffContentController(client,org,()=>{},timeout),invalidate(){current=false;for(const f of listeners)f();}};
}
async function until(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert(check());}
test('exact organization route and account envelope reject malformed paths, unscoped and content-bearing responses',async()=>{
 assert.equal(staffContentOrganization('/staff/orgs/'+org+'/content-withdrawals'),org);
 for(const p of ['/staff/content-withdrawals','/staff/orgs/not-id/content-withdrawals','/staff/orgs/'+org+'/content-withdrawals/','/welcome'])assert.equal(staffContentOrganization(p),null);
 const ok=page();assert.deepEqual(parseStaffContentWithdrawalPage(ok),ok);
 for(const bad of [{...ok,actorId:randomUUID()},{...ok,organizationId:randomUUID()},{...ok,body:'forbidden'},
  {...ok,records:[{...ok.records[0],body:'forbidden'}]},{...ok,records:[{...ok.records[0],revision:0}]},
  {...ok,records:[{...ok.records[0],withdrawnAt:'yesterday'}]},{...ok,nextCursor:ok.records[0].sourceId},
  {...ok,records:[ok.records[0],ok.records[0]]}]){
  await assert.rejects(readStaffContentWithdrawals(harness(()=>bad).client,org));
 }
});
test('readonly pages retain organization, preserve server order and reject invalid cursor continuations',async()=>{
 const ids=Array.from({length:51},()=>randomUUID()).sort(),first=ids.slice(0,50).map(id=>row(id)),last=row(ids[50]),paths:string[]=[];
 const h=harness((path,init)=>{paths.push(path);assert.equal(init.method,undefined);assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');
 return path.includes('?')?page([last]):page(first,ids[49]);});
 h.controller.start();await until(()=>!h.controller.snapshot().busy);await h.controller.more();
 assert.equal(h.controller.snapshot().records?.length,51);assert.equal(h.controller.snapshot().nextCursor,null);
 assert.equal(paths[1],'/staff/orgs/'+org+'/content-withdrawals?after='+ids[49]);h.controller.stop();
 await assert.rejects(readStaffContentWithdrawals(harness(()=>page([first[0]])).client,org,ids[49]));
});
test('role denial on refresh or pagination clears all previously visible records',async()=>{
 const ids=Array.from({length:50},()=>randomUUID()).sort();let denied=false;
 const h=harness(()=>{if(denied)throw new ApiError('Denied',403,'STAFF_ROLE_REQUIRED');return page(ids.map(row),ids[49]);});
 h.controller.start();await until(()=>!h.controller.snapshot().busy);assert.equal(h.controller.snapshot().records?.length,50);
 denied=true;await h.controller.more();assert.equal(h.controller.snapshot().records,null);assert.match(h.controller.snapshot().error,/权限/);h.controller.stop();
});
test('hidden, offline and invalidated accounts clear records, cancel reads and ignore late replies',async()=>{
 let resolve:((v:unknown)=>void)|undefined,calls=0,signal:AbortSignal|undefined;
 const h=harness((_p,i)=>{calls++;signal=i.signal!;return new Promise(r=>{resolve=r;});});
 h.controller.start(true);assert.equal(calls,0);h.controller.resume();await until(()=>!!resolve);
 h.controller.suspend();assert(signal?.aborted);resolve!(page());await until(()=>!h.controller.snapshot().busy);assert.equal(h.controller.snapshot().records,null);
 await h.controller.refresh();assert.equal(calls,1);
 h.controller.resume();await until(()=>calls===2);h.invalidate();resolve!(page());await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().records,null);
 await assert.rejects(readStaffContentWithdrawals(h.client,org));assert.equal(calls,2);
});
test('a transport ignoring cancellation cannot leave an endless spinner and a later refresh recovers',async()=>{
 let hung=true;const h=harness(()=>hung?new Promise(()=>{}):page([]),10);
 h.controller.start();await until(()=>!!h.controller.snapshot().error);assert.equal(h.controller.snapshot().busy,false);
 hung=false;await h.controller.refresh();assert.deepEqual(h.controller.snapshot().records,[]);h.controller.stop();
});
test('staff content route shares account gates and never opens the student conversation',()=>{
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert(app.indexOf('if (!accountReady) return')<app.indexOf('if (staffRoute) return null'));
 assert(app.indexOf('if (staffRoute) return null')<app.indexOf('if (!consentCurrent) return'));
 assert(app.includes('const privateAllowed = false;'));
 assert(app.includes('contentOrganization !== null'));assert(app.includes('!accountReady || staffRoute'));
});
