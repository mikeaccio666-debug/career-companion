import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRuntime } from '../src/index.ts';

const response=()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Synthetic reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
async function collect(runtime:ReturnType<typeof createProviderRuntime>,provider='ollama'){
  for await(const _event of runtime.streamChat({provider,mode:'chat',messages:[{role:'user',content:'Synthetic configuration check.'}]})){}
}
test('explicit Ollama reasoning configuration reaches compatible requests; unset preserves defaults',async()=>{
  for(const effort of [undefined,'none','low','medium','high']){
    let body:any;const runtime=createProviderRuntime({env:{OLLAMA_BASE_URL:'http://127.0.0.1:11434/v1',OLLAMA_CHAT_MODEL:'synthetic-model',...(effort===undefined?{}:{OLLAMA_REASONING_EFFORT:effort})},fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return response();}});
    await collect(runtime);assert.equal(body.reasoning_effort,effort);assert.equal(Object.hasOwn(body,'reasoning_effort'),effort!==undefined);assert.equal(body.max_tokens,4096);
  }
});
test('invalid Ollama reasoning configuration fails before any request; does not affect another provider',async()=>{
  for(const effort of ['','default','NONE','none ','fictional-secret']){
    let called=0;const runtime=createProviderRuntime({env:{OLLAMA_BASE_URL:'http://127.0.0.1:11434/v1',OLLAMA_CHAT_MODEL:'synthetic-model',OLLAMA_REASONING_EFFORT:effort,PLATFORM_ALLOW_PROVIDER_CALLS:'1',ARK_API_KEY:'synthetic',ARK_CHAT_MODEL:'synthetic'},fetch:async(_url,init)=>{called++;assert(!Object.hasOwn(JSON.parse(String(init?.body)),'reasoning_effort'));return response();}});
    await assert.rejects(collect(runtime),error=>{assert.equal((error as any).code,'INVALID_PROVIDER_CONFIG');assert(!String((error as Error).message).includes(effort||'fictional-secret'));return true;});assert.equal(called,0);
    await collect(runtime,'ark');assert.equal(called,1);
  }
});
