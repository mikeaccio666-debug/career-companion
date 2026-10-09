import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureLoader } from '../src/feature-loader.ts';
function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
test('features load on demand, concurrent readers share one code request, and successful code is reused',async()=>{
 let calls=0;const d=deferred<object>(),load=createFeatureLoader(()=>{calls++;return d.promise;});assert.equal(calls,0);const a=load(),b=load();await Promise.resolve();assert.equal(calls,1);const module={fictional:true};d.resolve(module);assert.equal(await a,module);assert.equal(await b,module);assert.equal(await load(),module);assert.equal(calls,1);
});
test('import rejection or synchronous failure does not poison an explicit retry',async()=>{
 for(const sync of [false,true]){let calls=0;const module={fictional:true};const load=createFeatureLoader(()=>{calls++;if(calls===1){if(sync)throw Error('Fictional import failure');return Promise.reject(Error('Fictional import failure'));}return Promise.resolve(module);});await assert.rejects(load());assert.equal(await load(),module);assert.equal(calls,2);}
});
test('a hung import has bounded waiting without duplicate requests, and late code is available only to a later reader',async()=>{
 let calls=0;const d=deferred<object>(),load=createFeatureLoader(()=>{calls++;return d.promise;},10);await assert.rejects(load(),/Feature load unavailable/);await assert.rejects(load(),/Feature load unavailable/);assert.equal(calls,1);const module={fictional:true};d.resolve(module);assert.equal(await load(),module);assert.equal(calls,1);
});
