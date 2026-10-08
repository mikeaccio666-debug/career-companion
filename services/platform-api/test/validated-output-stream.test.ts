import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { streamValidatedText, type ValidatedTextOptions, type OutputDecision, type OutputCandidate } from '../src/validated-output-stream.ts';
const base = (patch: Partial<ValidatedTextOptions> = {}): ValidatedTextOptions => ({ mode: 'sentences', signal: new AbortController().signal,
  maxOutputChars: 64000, maxBufferedChars: 16000, reviewTimeoutMs: 1000, review: async () => 'approve', ...patch });
async function* chunks(values: readonly string[]) { for (const value of values) yield value; }
async function collect(values: AsyncIterable<string>, options = base()) {
  const events = [], stream = streamValidatedText(values, options);
  while (true) { const value = await stream.next(); if (value.done) return { events, outcome: value.value }; events.push(value.value); }
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
test('provider chunks are not publications: a complete candidate waits for explicit review, with exact prefix and offsets', async () => {
  const approval = deferred<OutputDecision>(), seen: OutputCandidate[] = [];
  const stream = streamValidatedText(chunks(['First', ' sentence.', ' Next one.']), base({ review: async candidate => { seen.push(candidate); return seen.length === 1 ? approval.promise : 'approve'; } }));
  let published = false; const next = stream.next().then(value => { published=true; return value; });
  await tick(); assert.equal(published, false); assert.equal(seen.length,1); assert.equal(seen[0].text,'First sentence. ');
  assert.equal(seen[0].approvedPrefix,''); assert(Object.isFrozen(seen[0]));
  approval.resolve('approve'); const first=await next; assert(!first.done); assert.equal(first.value.text,'First sentence. '); assert.equal(first.value.offset,0);
  const second=await stream.next(); assert(!second.done); assert.equal(second.value.text,'Next one.'); assert.equal(second.value.offset,'First sentence. '.length);
  assert.equal(seen[1].approvedPrefix,'First sentence. '); assert.equal(seen[1].final,true);
  const end=await stream.next(); assert(end.done); assert.equal(end.value.status,'complete'); assert.equal(end.value.approvedChars,'First sentence. Next one.'.length);
});
test('decimals, closing quotes, CRLF and split surrogate pairs remain byte-for-byte speaker text', async () => {
  for(const text of ['Value is 3.14. Next sentence.', '“先看材料。”然后决定。', 'Quoted \"hello.\" Next.', 'A paragraph.\r\nNext paragraph.', 'Emoji 😀. 再说一件事。', 'Use example.invalid/a.b. Then check.', 'Try Dr. Smith. Keep going.']) {
    for (const pieces of [[text], text.split('')]) {
      const r=await collect(chunks(pieces)); assert.equal(r.outcome.status,'complete'); assert.equal(r.events.map(e=>e.text).join(''),text);
      let offset=0;for(const e of r.events){assert.equal(e.offset,offset);offset+=e.text.length;}
      if(text.startsWith('Value')) assert(r.events[0].text.includes('3.14'));
      if(text.startsWith('“')) assert(r.events[0].text.includes('”'));
    }
  }
});
test('whole mode withholds letters and deliverables until completion and reviews exactly once', async () => {
  const gate=deferred<string>();let calls=0,emitted=false;
  async function* source(){yield 'First paragraph. ';yield await gate.promise;}
  const stream=streamValidatedText(source(),base({mode:'whole',review:async c=>{calls++;assert(c.final);assert.equal(c.text,'First paragraph. Second.');return 'approve';}}));
  const first=stream.next().then(x=>{emitted=true;return x;});await tick();assert.equal(calls,0);assert.equal(emitted,false);
  gate.resolve('Second.');assert.equal((await first).done,false);assert.equal(calls,1);assert.equal((await stream.next()).done,true);
});
test('a rejected tail preserves only already released segments and never exposes rejection text or thrown details', async () => {
  let reviews=0,closed=false;
  async function* source(){try{yield 'Allowed. Forbidden.';yield ' Must not read.';}finally{closed=true;}}
  const r=await collect(source(),base({review:async()=>++reviews===1?'approve':'block'}));
  assert.deepEqual(r.events.map(x=>x.text),['Allowed. ']);assert.equal(r.outcome.status,'blocked');assert.equal(r.outcome.reason,'policy_blocked');
  assert.equal(r.outcome.approvedChars,'Allowed. '.length);assert.equal(r.outcome.approvedSegments,1);await tick();assert(closed);
  assert(!JSON.stringify(r).includes('Forbidden'));
});
test('requires-review and preview passed_rules cannot silently become approval', async()=>{
  for(const decision of ['review','passed_rules',true,{status:'passed_rules'}]){
    const r=await collect(chunks(['Unreviewed.']),base({review:async()=>decision as OutputDecision}));
    assert.equal(r.events.length,0);assert.equal(r.outcome.status,'blocked');assert.equal(r.outcome.reason,decision==='review'?'review_required':'review_failed');
  }
});
test('cancellation while review is pending returns promptly; late approval cannot publish or alter counters', async()=>{
  const controller=new AbortController(),gate=deferred<OutputDecision>();let reviewSignal:AbortSignal|undefined;
  const stream=streamValidatedText(chunks(['Pending.']),base({signal:controller.signal,review:async(_c,s)=>{reviewSignal=s;return gate.promise;}}));
  const pending=stream.next();await tick();controller.abort();const result=await pending;assert(result.done);assert.equal(result.value.reason,'cancelled');assert.equal(result.value.approvedChars,0);assert(reviewSignal!.aborted);
  gate.resolve('approve');await tick();assert.equal((await stream.next()).done,true);
});
test('cancelling a suspended source does not wait on a source next/return that never resolves',async()=>{
  const controller=new AbortController();let cleaned=0;
  const source:AsyncIterable<string>={[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{}),return:()=>{cleaned++;return new Promise(()=>{});}})};
  const stream=streamValidatedText(source,base({signal:controller.signal}));const pending=stream.next();await tick();controller.abort();
  const result=await pending;assert(result.done);assert.equal(result.value.reason,'cancelled');assert.equal(cleaned,1);
});
test('review timeouts cancel the review signal and reject later approvals',async()=>{
  let signal:AbortSignal|undefined;const gate=deferred<OutputDecision>();
  const r=await collect(chunks(['Pending.']),base({reviewTimeoutMs:15,review:async(_c,s)=>{signal=s;return gate.promise;}}));
  assert.equal(r.outcome.reason,'review_timeout');assert.equal(r.events.length,0);assert(signal!.aborted);gate.resolve('approve');await tick();assert.equal(r.events.length,0);
});
test('review exceptions are safe failures; source failures never flush an unchecked tail',async()=>{
  const r=await collect(chunks(['private source text']),base({review:async()=>{throw Error('private failure detail');}}));
  assert.equal(r.outcome.reason,'review_failed');assert(!JSON.stringify(r).includes('private'));
  async function* broken(){yield 'Allowed. Incomplete';throw Error('private transport detail');}
  const failed=await collect(broken());assert.deepEqual(failed.events.map(e=>e.text),['Allowed. ']);assert.equal(failed.outcome.reason,'source_failed');
  assert.equal((await collect(broken(),base({mode:'whole'}))).events.length,0);
});
test('invalid Unicode, controls, non-string chunks and configured limits fail closed without arbitrary chunk flushing',async()=>{
  for(const text of ['bad\u0000text','bad\ud800','bad\udc00']){const r=await collect(chunks([text]));assert.equal(r.outcome.reason,'invalid_text');assert.equal(r.events.length,0);}
  const wrong=await collect(chunks([42 as unknown as string]));assert.equal(wrong.outcome.reason,'invalid_text');
  const long=await collect(chunks(['12345']),base({maxOutputChars:10,maxBufferedChars:4}));assert.equal(long.outcome.reason,'buffer_limit');assert.equal(long.events.length,0);
  const total=await collect(chunks(['12345']),base({maxOutputChars:4,maxBufferedChars:4}));assert.equal(total.outcome.reason,'output_limit');
  const whole=await collect(chunks(['A. B. C.']),base({mode:'whole',maxOutputChars:20,maxBufferedChars:4}));assert.equal(whole.outcome.reason,'buffer_limit');assert.equal(whole.events.length,0);
});
test('configuration is captured once; callers cannot broaden limits or replace the reviewer mid-stream',async()=>{
  const gate=deferred<string>();const config=base({review:async()=> 'block'});
  async function* source(){yield await gate.promise;}
  const stream=streamValidatedText(source(),config);const next=stream.next();await tick();
  (config as any).review=async()=> 'approve';gate.resolve('Never approved.');const r=await next;assert(r.done);assert.equal(r.value.reason,'policy_blocked');
});
test('empty input invents no response; pre-cancelled input starts neither source nor reviewer',async()=>{
  const empty=await collect(chunks([]));assert.deepEqual(empty.events,[]);assert.equal(empty.outcome.approvedSegments,0);
  const abort=new AbortController();abort.abort();let calls=0;
  async function* source(){calls++;yield 'Not started.';}
  const r=await collect(source(),base({signal:abort.signal,review:async()=>{calls++;return 'approve';}}));assert.equal(r.outcome.reason,'cancelled');assert.equal(calls,0);
});
test('consumer termination closes the source and never reviews remaining text',async()=>{
  let closed=false,reviews=0;
  async function* source(){try{yield 'One. Two.';}finally{closed=true;}}
  const stream=streamValidatedText(source(),base({review:async()=>{reviews++;return 'approve';}}));assert.equal((await stream.next()).done,false);
  await stream.return({status:'interrupted',reason:'cancelled',approvedChars:5,approvedSegments:1});await tick();assert(closed);assert.equal(reviews,1);
});

test('already cancelled input does not even acquire the source iterator; invalid options start no work',async()=>{
  let acquired=0;const source:AsyncIterable<string>={[Symbol.asyncIterator](){acquired++;return chunks(['Not started.']);}};
  const controller=new AbortController();controller.abort();const result=await collect(source,base({signal:controller.signal}));assert.equal(result.outcome.reason,'cancelled');assert.equal(acquired,0);
  for(const patch of [{maxOutputChars:0},{maxBufferedChars:64001},{reviewTimeoutMs:Infinity},{mode:'other'}]) {
    await assert.rejects(collect(source,base(patch as any)),/OUTPUT_STREAM_INVALID_OPTIONS/);assert.equal(acquired,0);
  }
});
test('stopping after the first emitted sentence keeps exact released counters and does not review the tail',async()=>{
  const controller=new AbortController();let calls=0;
  const stream=streamValidatedText(chunks(['Published. Unreviewed.']),base({signal:controller.signal,review:async()=>{calls++;return 'approve';}}));
  const first=await stream.next();assert(!first.done);controller.abort();const end=await stream.next();assert(end.done);
  assert.equal(end.value.reason,'cancelled');assert.equal(end.value.approvedChars,first.value.text.length);assert.equal(end.value.approvedSegments,1);assert.equal(calls,1);
});
test('300 fictional chunking cases preserve source text; this tests buffering, not semantic false-positive rates',async()=>{
  const templates=['先核对材料。再选下一步。','Value 3.14. Check again.','“Ready?” she asked. Next.','One.\r\nTwo.','Hello 😀! 再看一眼。'];
  for(let i=0;i<300;i++){
    const value=templates[i%templates.length],width=1+i%13,parts=[];for(let n=0;n<value.length;n+=width)parts.push(value.slice(n,n+width));
    const result=await collect(chunks(parts));assert.equal(result.outcome.status,'complete');assert.equal(result.events.map(e=>e.text).join(''),value);
  }
});
test('the shared provider adapter and agent loop can feed the review boundary without releasing raw deltas',async()=>{
  const {ProviderAdapter,runAgentLoop}=await import('@companion/ai-core');let modelCalls=0,closed=false;
  const adapter=new ProviderAdapter({async *streamModelStep(){modelCalls++;try{yield {type:'delta' as const,text:'Allowed. '};yield {type:'delta' as const,text:'Forbidden.'};return {text:'Allowed. Forbidden.',calls:[]};}finally{closed=true;}}});
  const controller=new AbortController();
  async function* source(){for await(const event of runAgentLoop(adapter,{provider:'fictional',model:'fictional',mode:'chat',messages:[{role:'user',content:'Fictional test.'}]},
    {turnId:'fictional-output-test',purpose:'companion',limits:{maxRounds:1,maxToolCalls:0,maxOutputTokens:100,timeoutMs:1000},toolDefinitions:[],resolveTools:()=>[],executeTool:async()=>{throw Error('No tools in this test');},drainInterjections:()=>[],signal:controller.signal}))if(event.type==='delta')yield event.text;}
  const result=await collect(source(),base({signal:controller.signal,review:async c=>c.text.includes('Forbidden')?'block':'approve'}));
  assert.equal(modelCalls,1);assert(closed);assert.deepEqual(result.events.map(e=>e.text),['Allowed. ']);assert.equal(result.outcome.reason,'policy_blocked');
});

test('immediate empty source chunks cannot starve real cancellation timers',async()=>{
  const controller=new AbortController();let pulled=0;
  async function* source(){for(let i=0;i<10000;i++){pulled++;yield '';}}
  const timer=setTimeout(()=>controller.abort(),1);
  try{const r=await collect(source(),base({signal:controller.signal}));assert.equal(r.outcome.reason,'cancelled');assert.equal(r.events.length,0);assert(pulled<10000);}finally{clearTimeout(timer);}
});

test('a source factory that cancels the turn cannot start next or leak a scheduled rejection',async()=>{
  const controller=new AbortController();let nextCalls=0;
  const source:AsyncIterable<string>={[Symbol.asyncIterator](){controller.abort();return {next:async()=>{nextCalls++;throw Error('Must not start');}};}};
  const r=await collect(source,base({signal:controller.signal}));assert.equal(r.outcome.reason,'cancelled');await tick();assert.equal(nextCalls,0);
});
test('one large chunk with many sentences also yields to the real turn cancellation timer',async()=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1);
  try{const r=await collect(chunks(['A. '.repeat(10000)]),base({signal:controller.signal}));assert.equal(r.outcome.reason,'cancelled');assert(r.events.length<10000);assert.equal(r.outcome.approvedChars,r.events.reduce((n,e)=>n+e.text.length,0));}finally{clearTimeout(timer);}
});
