import {test} from 'node:test';
import assert from 'node:assert/strict';
import {libraryRequest} from '../src/career-library-request.ts';
test('hung transport is aborted and stops blocking even when it ignores the signal',async()=>{
 const controller=new AbortController();let resolve!:(v:string)=>void;
 const result=libraryRequest(controller,()=>new Promise<string>(r=>{resolve=r;}),15);
 await assert.rejects(result,{name:'AbortError'});assert.equal(controller.signal.aborted,true);
 resolve('late response');await assert.rejects(result,{name:'AbortError'});
});
test('account/page cancellation interrupts promptly; a completed read clears its deadline',async()=>{
 const controller=new AbortController(),result=libraryRequest(controller,()=>new Promise(()=>{}),10000);
 controller.abort();await assert.rejects(result,{name:'AbortError'});
 let called=false;await assert.rejects(libraryRequest(controller,async()=>{called=true;return 1;}));assert.equal(called,false);
 const success=new AbortController();assert.equal(await libraryRequest(success,async()=>42,10),42);
 await new Promise(r=>setTimeout(r,25));assert.equal(success.signal.aborted,false);
});
