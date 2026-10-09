import test from 'node:test';import assert from 'node:assert/strict';
import {createWorkerShutdownHandler} from '../src/worker-shutdown.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function deferred(){let resolve!:()=>void,reject!:(e:Error)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
test('one signal stops intake synchronously and all repeated signals share one drain',async()=>{
 const gate=deferred(),order:string[]=[],exits:number[]=[];
 const stop=createWorkerShutdownHandler({timeoutMs:5000,stopIntake(){order.push('intake');},async drain(){order.push('drain');await gate.promise;},diagnostic(){assert.fail();},exit(code){exits.push(code);}});
 stop();assert.deepEqual(order,['intake']);stop();await pause(0);assert.deepEqual(order,['intake','drain']);assert.deepEqual(exits,[]);
 gate.resolve();await pause(0);assert.deepEqual(exits,[0]);stop();assert.deepEqual(exits,[0]);
});
test('unsettled drain reaches one deadline without inventing success and late settlement cannot exit twice',async()=>{
 const gate=deferred(),exits:number[]=[],messages:string[]=[];
 const stop=createWorkerShutdownHandler({timeoutMs:15,stopIntake(){},drain:()=>gate.promise,diagnostic:x=>messages.push(x),exit:c=>exits.push(c)});
 stop();stop();await pause(35);assert.deepEqual(exits,[1]);assert.deepEqual(messages,['Worker shutdown deadline exceeded; unfinished work is not confirmed.\n']);
 gate.resolve();await pause(0);assert.deepEqual(exits,[1]);
});
test('drain failures redact exception details, cancel the deadline and exit unsuccessfully',async()=>{
 const exits:number[]=[],messages:string[]=[];
 createWorkerShutdownHandler({timeoutMs:15,stopIntake(){},async drain(){throw Error('PRIVATE_FICTIONAL_DETAIL');},diagnostic:x=>messages.push(x),exit:c=>exits.push(c)})();
 await pause(35);assert.deepEqual(exits,[1]);assert.deepEqual(messages,['Worker shutdown could not be confirmed.\n']);
});
test('synchronous intake failure and invalid deadlines are explicit, without double exits',async()=>{
 const exits:number[]=[],messages:string[]=[];
 createWorkerShutdownHandler({timeoutMs:15,stopIntake(){throw Error('PRIVATE_FICTIONAL_DETAIL');},async drain(){assert.fail();},diagnostic:x=>messages.push(x),exit:c=>exits.push(c)})();
 await pause(35);assert.deepEqual(exits,[1]);assert.equal(messages.length,1);
 for(const timeoutMs of [0,-1,NaN,Infinity,120001])assert.throws(()=>createWorkerShutdownHandler({timeoutMs,stopIntake(){},async drain(){},diagnostic(){},exit(){}}));
});
