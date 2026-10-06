import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.ts';
import { generateArkVideo, generateFal } from '../src/media.ts';
import type { JobExecutionContext } from '@companion/platform-contracts';

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const uri=`data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const context:JobExecutionContext={jobId:'fictional-media-job',userId:'fictional-user',workspaceDirectory:'/tmp/fictional-media',readAttachment:async()=>({name:'fictional.png',mime:'image/png',bytes:png})};
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
const fake=(fn:(url:string,init:RequestInit)=>Response|Promise<Response>):typeof fetch=>((url:any,init:RequestInit={})=>fn(String(url),init)) as typeof fetch;
const resolver=async()=>[{address:'203.0.113.4',family:4}];
function arkTransport(sent:unknown[],saved:()=>boolean){return new HttpClient(fake((url,init)=>{
  if(init.method==='POST'){sent.push(JSON.parse(String(init.body)));return json({id:'fictional-task'});}
  if(url.includes('/tasks/')){assert(saved(),'provider task must persist before polling');return json({status:'succeeded',content:{video_url:'https://cdn.volces.com/fictional.mp4'}});}
  return new Response(new Uint8Array([1,2,3]));
}),resolver);}

test('Ark private images become in-request data URIs with exclusive first/last/reference roles',async()=>{
  for(const [ids,mode,roles] of [
    [['one'],undefined,['first_frame']],
    [['one','two'],undefined,['first_frame','last_frame']],
    [['one','two'],'reference_image',['reference_image','reference_image']],
  ] as const){
    const sent:any[]=[];let saved=false;
    await generateArkVideo(arkTransport(sent,()=>saved),{ARK_API_KEY:'fictional-key',ARK_VIDEO_MODEL:'fictional-model'},
      {kind:'video',provider:'ark',prompt:'An invented scene',attachmentIds:[...ids],options:mode?{referenceMode:mode}:{}},{...context,onProviderTask:()=>{saved=true;}});
    assert.deepEqual(sent[0].content.slice(1).map((item:any)=>item.role),roles);
    assert(sent[0].content.slice(1).every((item:any)=>item.image_url.url===uri));
    assert(!JSON.stringify(sent[0]).includes('fictional-key'));assert(!JSON.stringify(sent[0]).includes('/api/platform/uploads'));
  }
});

test('private references reject forbidden formats, duplicate IDs, incompatible binding and oversized totals before submission',async()=>{
  let calls=0;
  const transport=new HttpClient(fake(()=>{calls++;return json({});}),resolver);
  const input={kind:'video' as const,provider:'ark',prompt:'Fictional',attachmentIds:['one']};
  await assert.rejects(generateArkVideo(transport,{ARK_VIDEO_MODEL:'fictional'},input,{...context,readAttachment:async()=>({name:'invented.svg',mime:'image/svg+xml',bytes:new Uint8Array([1])})}),{code:'INVALID_PROVIDER_INPUT'});
  await assert.rejects(generateArkVideo(transport,{ARK_VIDEO_MODEL:'fictional'},{...input,attachmentIds:['one','one']},context),{code:'INVALID_PROVIDER_INPUT'});
  await assert.rejects(generateArkVideo(transport,{ARK_VIDEO_MODEL:'fictional'},{...input,options:{referenceMode:'first_last_frame'}},context),{code:'INVALID_PROVIDER_INPUT'});
  const large=new Uint8Array(11*1024*1024);large.set(png);
  await assert.rejects(generateArkVideo(transport,{ARK_VIDEO_MODEL:'fictional'},{...input,attachmentIds:['one','two']},{...context,readAttachment:async()=>({name:'fictional.png',mime:'image/png',bytes:large})}),{code:'INVALID_PROVIDER_INPUT'});
  assert.equal(calls,0);
});

test('Ark resumed task polls its saved handle without re-reading or sending reference images',async()=>{
  const sent:unknown[]=[];
  await generateArkVideo(arkTransport(sent,()=>true),{ARK_API_KEY:'fictional-key',ARK_VIDEO_MODEL:'fictional-model'},
    {kind:'video',provider:'ark',prompt:'Fictional',attachmentIds:['one']},{...context,previousProviderTaskId:'fictional-task',readAttachment:async()=>{throw new Error('Completed submission must not re-read its references');}});
  assert.equal(sent.length,0);
});

test('fal binds private images to the selected file field without a public storage upload',async()=>{
  for(const field of ['image_url','image_urls']){
    let sent:any,saved='',posts=0;
    const transport=new HttpClient(fake((url,init)=>{
      if(init.method==='POST'){posts++;sent=JSON.parse(String(init.body));return json({request_id:'fictional',status_url:'https://queue.fal.run/fal-ai/fixture/requests/fictional/status',response_url:'https://queue.fal.run/fal-ai/fixture/requests/fictional/response',cancel_url:'https://queue.fal.run/fal-ai/fixture/requests/fictional/cancel'});}
      if(url.endsWith('/status')){assert(saved);return json({status:'COMPLETED'});}
      if(url.endsWith('/response'))return json({video:{url:'https://v3.fal.media/fictional.mp4'}});
      return new Response(new Uint8Array([1,2,3]));
    }),resolver);
    const input={kind:'video' as const,provider:'fal',model:'fal-ai/fixture',prompt:'Fictional',attachmentIds:field==='image_url'?['one']:['one','two'],options:{referenceField:field,input:{duration:5}}};
    const result=await generateFal(transport,{FAL_KEY:'fictional-key'},input,{...context,onProviderTask:id=>{saved=id;}});
    assert.deepEqual(sent[field],field==='image_url'?uri:[uri,uri]);assert.equal(sent.duration,5);assert.equal(posts,1);
    assert(!JSON.stringify(sent).includes('fictional-key'));
    await generateFal(transport,{FAL_KEY:'fictional-key'},input,{...context,previousProviderTaskId:result.providerTaskId,readAttachment:async()=>{throw new Error('No repeat reference delivery');}});
    assert.equal(posts,1);
  }
});

test('fal reference fields cannot replace credentials or conflict with model input',async()=>{
  let calls=0;const transport=new HttpClient(fake(()=>{calls++;return json({});}),resolver);
  const input={kind:'image' as const,provider:'fal',model:'fal-ai/fixture',prompt:'Fictional',attachmentIds:['one']};
  for(const options of [{referenceField:'Authorization'},{input:{image_url:'https://example.invalid/conflicting.png'}},{referenceField:'image_url'}]){
    await assert.rejects(generateFal(transport,{FAL_KEY:'fictional-key'},{...input,attachmentIds:options.referenceField==='image_url'?['one','two']:['one'],options},context),{code:'INVALID_PROVIDER_INPUT'});
  }
  assert.equal(calls,0);
});
