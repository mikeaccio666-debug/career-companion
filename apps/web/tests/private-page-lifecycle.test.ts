import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPrivatePageLifecycle} from '../src/private-page-lifecycle.ts';

function fixture(visible=true,connected=true) {
  const events=new EventTarget(),page=Object.assign(new EventTarget(),{visibilityState:visible?'visible':'hidden'});
  let online=connected;const calls:string[]=[];
  const controller={start:(s=false)=>calls.push('start:'+s),suspend:()=>calls.push('suspend'),resume:()=>calls.push('resume'),stop:()=>calls.push('stop')};
  const binding=bindPrivatePageLifecycle(controller,events,page,()=>online);
  return {binding,calls,visibility(value:string){page.visibilityState=value;page.dispatchEvent(new Event('visibilitychange'));},
    connection(value:boolean){online=value;events.dispatchEvent(new Event(value?'online':'offline'));}};
}
test('initially hidden pages wait until both visibility and connection permit reading',()=>{
 const f=fixture(false,false);assert.deepEqual(f.calls,['start:true']);
 f.connection(true);f.binding.refresh();assert.deepEqual(f.calls,['start:true']);
 f.connection(false);f.visibility('visible');assert.deepEqual(f.calls,['start:true']);
 f.connection(true);f.connection(true);f.visibility('visible');assert.deepEqual(f.calls,['start:true','resume']);
 f.visibility('hidden');f.connection(false);f.binding.refresh();assert.deepEqual(f.calls,['start:true','resume','suspend']);f.binding.dispose();
});
test('an explicit invalidation rereads only active pages; disposal detaches all callbacks',()=>{
 const f=fixture();f.binding.refresh();assert.deepEqual(f.calls,['start:false','suspend','resume']);
 f.visibility('hidden');f.binding.refresh();f.connection(true);assert.deepEqual(f.calls,['start:false','suspend','resume','suspend']);
 f.visibility('visible');assert.equal(f.calls.at(-1),'resume');f.binding.dispose();const calls=[...f.calls];
 f.visibility('hidden');f.visibility('visible');f.connection(false);f.connection(true);f.binding.refresh();f.binding.dispose();assert.deepEqual(f.calls,calls);assert.equal(f.calls.at(-1),'stop');
});
