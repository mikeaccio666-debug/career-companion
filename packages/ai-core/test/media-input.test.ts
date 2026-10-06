import test from 'node:test';
import assert from 'node:assert/strict';
import type { CreateJobInput, JobExecutionContext, ProviderAttachment } from '@companion/platform-contracts';
import { createProviderRuntime, validateMediaJobInput, validateMediaReferenceImages } from '../src/index.ts';
import { HttpClient } from '../src/http.ts';
import { generateArkVideo, generateFal, generateOpenAIImage } from '../src/media.ts';

// Synthetic headers, not user images or a commercial provider connection.
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg = new Uint8Array([255,216,255,224,0,0,0,0,0,0,0,0]);
const webp = new Uint8Array(Buffer.from('RIFF0000WEBP'));
const image = (bytes=png,mime='image/png'):ProviderAttachment => ({name:'fictional-private-name.png',mime,bytes});
const ctx:JobExecutionContext = {jobId:'fictional-media-job',userId:'fictional-user',workspaceDirectory:'/tmp/fictional-media'};
const json = (value:unknown) => Response.json(value);
const fake = (callback:(url:string,init:RequestInit)=>Promise<Response>|Response):typeof fetch =>
  ((url:any,init:RequestInit={})=>callback(String(url),init)) as typeof fetch;
const resolver = async()=>[{address:'203.0.113.4',family:4}];
const input = (provider:string,options:Record<string,unknown>={}):CreateJobInput =>
  ({kind:provider==='ark'?'video':'image',provider,prompt:'An invented scene',options});
const queue = {request_id:'fixture-task',status_url:'https://queue.fal.run/fal-ai/fixture/requests/fixture-task/status',response_url:'https://queue.fal.run/fal-ai/fixture/requests/fixture-task/response',cancel_url:'https://queue.fal.run/fal-ai/fixture/requests/fixture-task/cancel'};

test('all media adapters reject invalid IDs, signatures and aggregate reference size before any provider submission',async()=>{
  let calls=0,reads=0;
  const http=new HttpClient(fake(()=>{calls++;return json({});}),resolver);
  const env={OPENAI_API_KEY:'fixture',ARK_API_KEY:'fixture',ARK_VIDEO_MODEL:'fixture-model',FAL_KEY:'fixture',FAL_IMAGE_ENDPOINT:'fal-ai/fixture'};
  const invoke=(job:CreateJobInput,ref:ProviderAttachment)=>(job.provider==='openai'?generateOpenAIImage:job.provider==='ark'?generateArkVideo:generateFal)(http,env,job,{...ctx,readAttachment:async()=>{reads++;return ref;}});
  for(const provider of ['openai','ark','fal']){
    const job=input(provider);
    for(const ids of [['one','one'],['one','two','three','four','five'],[123] as unknown as string[]])await assert.rejects(invoke({...job,attachmentIds:ids},image()),{code:'INVALID_PROVIDER_INPUT'});
    assert.equal(reads,0);
    for(const ref of [image(jpeg,'image/png'),image(png,'image/svg+xml'),image(new Uint8Array())])await assert.rejects(invoke({...job,attachmentIds:['one']},ref),{code:'INVALID_PROVIDER_INPUT'});
    const bytes=new Uint8Array(11*1024*1024);bytes.set(png);
    const options=provider==='fal'?{referenceField:'image_urls'}:{};
    await assert.rejects(invoke({...job,attachmentIds:['one','two'],options},image(bytes)),{code:'INVALID_PROVIDER_INPUT'});
    reads=0;
  }
  assert.equal(calls,0);
  assert.throws(()=>validateMediaReferenceImages([image(),image(),image(),image(),image()]),{code:'INVALID_PROVIDER_INPUT'});
  validateMediaReferenceImages([image(png),image(jpeg,'image/jpeg'),image(webp,'image/webp')]);
});

test('media options are strict without string coercion or silently ignored parameters',()=>{
  for(const [provider,options] of [
    ['openai',{aspectRatio:['16:9']}],['openai',{aspectRatio:'unknown'}],['openai',{mask:'invented-mask'}],
    ['ark',{referenceMode:['first_frame']}],['ark',{aspectRatio:['16:9']}],['ark',{resolution:['720p']}],['ark',{duration:5.5}],['ark',{seed:1.5}],
    ['fal',{referenceField:['image_url']}],['fal',{aspectRatio:'16:9'}],['fal',{input:{sync_mode:true}}],['fal',{input:{sync_mode:'false'}}],
    ['fal',{input:{prompt:'silently replaced'}}],['fal',{input:{duration:Number.NaN}}],['comfyui',{aspectRatio:'16:9'}],
  ] as [string,Record<string,unknown>][])assert.throws(()=>validateMediaJobInput({...input(provider,options),attachmentIds:['one']}),{code:'INVALID_PROVIDER_INPUT'});
  for(const options of [{input:{image_url:'https://example.invalid/one'}},{referenceField:'image_urls',input:{image_url:'https://example.invalid/one'}},{input:{image_urls:['https://example.invalid/two']}}])
    assert.throws(()=>validateMediaJobInput({...input('fal',options),attachmentIds:['one']}),{code:'INVALID_PROVIDER_INPUT'});
  assert.throws(()=>validateMediaJobInput({...input('openai'),options:null as any}),{code:'INVALID_PROVIDER_INPUT'});
  assert.throws(()=>validateMediaJobInput({...input('openai'),attachmentIds:null as any}),{code:'INVALID_PROVIDER_INPUT'});
});

test('OpenAI edit multipart uses the same validated PNG/JPEG/WebP references and excludes original filenames',async()=>{
  const refs=[image(),image(jpeg,'image/jpeg'),image(webp,'image/webp')];let calls=0;
  const http=new HttpClient(fake(async(url,init)=>{
    calls++;assert(url.endsWith('/images/edits'));assert(init.body instanceof FormData);
    const sent=init.body.getAll('image[]');assert.equal(sent.length,3);
    for(const [index,item] of sent.entries()){
      assert(item instanceof File);assert.equal(item.name,`reference-${index+1}.${['png','jpg','webp'][index]}`);
      assert.equal(item.type,refs[index].mime);assert.deepEqual(new Uint8Array(await item.arrayBuffer()),refs[index].bytes);
    }
    return json({data:[{b64_json:Buffer.from(png).toString('base64')}]});
  }));
  const result=await generateOpenAIImage(http,{OPENAI_API_KEY:'fictional'}, {...input('openai'),attachmentIds:['0','1','2']},{...ctx,readAttachment:async id=>refs[Number(id)]});
  assert.equal(calls,1);assert.equal(result.artifacts[0].mime,'image/png');
});

test('fal JPEG without optional MIME metadata can feed two edits and both image-to-video bindings',async()=>{
  const falImage=new HttpClient(fake((url,init)=>{
    if(init.method==='POST')return json(queue);
    if(url.endsWith('/status'))return json({status:'COMPLETED'});
    if(url.endsWith('/response'))return json({images:[{url:'https://v3.fal.media/fictional.jpg'}]});
    return new Response(jpeg,{headers:{'Content-Type':'image/jpeg'}});
  }),resolver);
  const generated=await generateFal(falImage,{FAL_KEY:'fictional',FAL_IMAGE_ENDPOINT:'fal-ai/fixture-jpeg'},input('fal'),ctx);
  assert.equal(generated.artifacts[0].mime,'image/jpeg');assert.equal(generated.artifacts[0].name,'image-1.jpg');
  let previous:ProviderAttachment=generated.artifacts[0],edits=0;
  const editor=new HttpClient(fake(async(url,init)=>{
    assert(url.endsWith('/images/edits'));assert(init.body instanceof FormData);const ref=init.body.get('image[]');assert(ref instanceof Blob);
    assert.equal(ref.type,previous.mime);assert.deepEqual(new Uint8Array(await ref.arrayBuffer()),previous.bytes);edits++;
    return json({data:[{b64_json:Buffer.from(png).toString('base64')}]});
  }));
  for(let index=0;index<2;index++){const edited=await generateOpenAIImage(editor,{OPENAI_API_KEY:'fictional'},{...input('openai'),attachmentIds:['owned-output']},{...ctx,readAttachment:async()=>previous});previous=edited.artifacts[0];}
  assert.equal(edits,2);
  const expected=`data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
  for(const provider of ['ark','fal']){
    let posts=0;
    const transport=new HttpClient(fake((url,init)=>{
      if(init.method==='POST'){posts++;const body=JSON.parse(String(init.body));assert.equal(provider==='ark'?body.content[1].image_url.url:body.image_url,expected);return json(provider==='ark'?{id:'fixture-task'}:queue);}
      if(url.includes('/tasks/'))return json({status:'succeeded',content:{video_url:'https://cdn.volces.com/fictional.mp4'}});
      if(url.endsWith('/status'))return json({status:'COMPLETED'});
      if(url.endsWith('/response'))return json({video:{url:'https://v3.fal.media/fictional.mp4'}});
      return new Response(new Uint8Array([1,2,3]));
    }),resolver);
    await (provider==='ark'?generateArkVideo:generateFal)(transport,{ARK_API_KEY:'fictional',ARK_VIDEO_MODEL:'fixture-model',FAL_KEY:'fictional',FAL_VIDEO_ENDPOINT:'fal-ai/fixture'},{kind:'video',provider,prompt:'An invented moving scene',attachmentIds:['owned-jpeg']},{...ctx,readAttachment:async()=>generated.artifacts[0]});
    assert.equal(posts,1);
  }
});

test('fal rejects inconsistent image output metadata without publishing a mislabeled artifact',async()=>{
  const transport=new HttpClient(fake((url,init)=>{
    if(init.method==='POST')return json(queue);if(url.endsWith('/status'))return json({status:'COMPLETED'});
    if(url.endsWith('/response'))return json({images:[{url:'https://v3.fal.media/fictional.jpg',content_type:'image/png'}]});
    return new Response(jpeg);
  }),resolver);
  await assert.rejects(generateFal(transport,{FAL_IMAGE_ENDPOINT:'fal-ai/fixture',FAL_KEY:'fictional'},input('fal'),ctx),{code:'INVALID_PROVIDER_RESPONSE'});
});

test('fal advanced model input remains literal when there are no private references',async()=>{
  let sent:any;
  const params={image_url:'https://example.invalid/public-reference.jpg',custom_model_field:{enabled:true},seed:42,output_format:'jpeg',sync_mode:false};
  const transport=new HttpClient(fake((url,init)=>{
    if(init.method==='POST'){sent=JSON.parse(String(init.body));return json(queue);}
    if(url.endsWith('/status'))return json({status:'COMPLETED'});
    if(url.endsWith('/response'))return json({images:[{url:'https://v3.fal.media/fictional.jpg'}]});return new Response(jpeg);
  }),resolver);
  await generateFal(transport,{FAL_IMAGE_ENDPOINT:'fal-ai/fixture',FAL_KEY:'fictional'},input('fal',{input:params}),ctx);
  assert.deepEqual(sent,{...params,prompt:'An invented scene'});
});

test('known Seedance 2.5 validates adaptive frame binding without guessing account endpoint capabilities',()=>{
  const frame={...input('ark'),model:'doubao-seedance-2-5-260628',attachmentIds:['one']};
  assert.throws(()=>validateMediaJobInput({...frame,options:{aspectRatio:'16:9'}}),{code:'INVALID_PROVIDER_INPUT'});
  assert.throws(()=>validateMediaJobInput({...frame,options:{aspectRatio:'adaptive',duration:2}}),{code:'INVALID_PROVIDER_INPUT'});
  validateMediaJobInput({...frame,options:{aspectRatio:'adaptive',duration:30}});
  validateMediaJobInput({...frame,options:{referenceMode:'reference_image',aspectRatio:'16:9',duration:-1}});
  validateMediaJobInput({...frame,model:'ep-fictional-account-endpoint',options:{aspectRatio:'16:9',duration:5}});
});

test('GPT Image 2.5 sends exact selected dimensions; older models never silently substitute another ratio',async()=>{
  let calls=0;
  const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'synthetic-only',OPENAI_IMAGE_MODEL:'gpt-image-2.5-flare'},fetch:fake((_url,init)=>{
    calls++;const body=init.body instanceof FormData?{size:init.body.get('size')}:JSON.parse(String(init.body));
    assert.equal(body.size,(['1024x1024','1536x864','864x1536','1536x1152'] as string[])[calls-1]);
    return json({data:[{b64_json:Buffer.from(png).toString('base64')}]});
  })});
  for(const aspectRatio of ['1:1','16:9','9:16','4:3'])await runtime.executeJob(input('openai',{aspectRatio}),ctx);
  await assert.rejects(runtime.executeJob({...input('openai',{aspectRatio:'16:9'}),model:'gpt-image-1.5'},ctx),{code:'INVALID_PROVIDER_INPUT'});
  assert.equal(calls,4);
});
