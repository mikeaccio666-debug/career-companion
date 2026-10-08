import assert from 'node:assert/strict';
import http from 'node:http';
import { createProviderRuntime } from '@companion/ai-core';
import { SharedMemorySafety } from '../../src/shared-memory-safety.ts';
import { expectedSafetyProfileDigests,parseSafetyDetectorProfile,type SafetyDetectorProfile } from '../../src/safety-detector-profile.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';
import type { createCompanionNameSafetyFixture } from './companion-name-safety.ts';
import { SharedMemories } from '../../src/shared-memories.ts';
export const MEMORY_PROFILE_CONTENT={schemaVersion:1,revision:271,instructions:'Fictional QA policy; synthetic examples only, not clinical approval.',algorithm:'literal_substring_v1',lexicon:[
 {id:'en-low',language:'en',level:'L1',phrases:['Synthetic low marker']},{id:'zh-low',language:'zh',level:'L1',phrases:['虚构低风险标记']},
 {id:'en-high',language:'en',level:'L2',phrases:['Synthetic high marker']},{id:'zh-high',language:'zh',level:'L2',phrases:['虚构高风险标记']}],mergeRule:'highest_level',fallbackNoHit:'unavailable',
 review:{reference:'fictional-memory-policy-review',approvedAt:'2026-10-08T00:00:00.000Z'}};
export const MEMORY_PROFILE=parseSafetyDetectorProfile({...MEMORY_PROFILE_CONTENT,...expectedSafetyProfileDigests(MEMORY_PROFILE_CONTENT)});
export function memoryReply(reply:http.ServerResponse,decision:unknown={level:'L0'},usage:unknown={input_tokens:34,output_tokens:8}){
 reply.writeHead(200,{'content-type':'text/event-stream'});reply.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(decision)}]}],usage}})+'\n\ndata: [DONE]\n\n');
}
type Fixture=Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
export async function createMemorySafetyLoopback(f:Fixture,memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL)){
 const bodies:Record<string,any>[]=[];let handler:(body:Record<string,any>,reply:http.ServerResponse)=>Promise<void>|void=(_b,r)=>memoryReply(r),failure:unknown;
 const server=http.createServer(async(req,reply)=>{try{assert.equal(req.url,'/v1/responses');assert.equal(req.method,'POST');const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.store,false);assert.equal(body.model,'fictional-memory-safety');assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');bodies.push(body);await handler(body,reply);
 }catch(e){failure=e;reply.destroy();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
 const env={PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-loopback-only',OPENAI_SAFETY_CLASSIFY_MODEL:'fictional-memory-safety'};
 const makeRuntime=(patch:Record<string,string>={})=>createProviderRuntime({env:{...env,...patch},fetch:(target,init)=>{const url=new URL(String(target));assert.equal(url.origin,'https://api.openai.com');assert.equal(url.pathname,'/v1/responses');return fetch('http://127.0.0.1:'+address.port+url.pathname,init);}});
 const config={...f.config,modelRoutes:{safety_classify:{provider:'openai'}},safetyDailyModelCallLimit:10};
 const activate=async(profile:SafetyDetectorProfile=MEMORY_PROFILE)=>{const staff=await f.actor(true);await f.db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by) VALUES(true,$1,$2,$3,clock_timestamp(),$4)
 ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,[profile.revision,profile.digest,profile.reviewDigest,staff.userId]);};
 await activate();const runtime=makeRuntime(),safety=new SharedMemorySafety(f.db,config,FICTIONAL_LEGAL,memories,runtime,MEMORY_PROFILE);
 return {safety,bodies,config,runtime,makeRuntime,activate,setHandler(next:typeof handler){handler=next;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));if(failure)throw failure;}};
}
