import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPERT_KEYS } from '@companion/platform-contracts';
import { EXPERT_MEMBERS, enabledExpertRoster, expertRosterKeys, detectNameCall, resolveExplicitExpertCall } from '../src/index.ts';
const p0=enabledExpertRoster(),all=enabledExpertRoster(EXPERT_KEYS);
const keys=(text:string,roster=p0)=>detectNameCall(text,roster).filter(x=>x.availability==='enabled').map(x=>x.expert);
test('canonical P0 roster contains only the launched three, with frozen longest/short aliases',()=>{
  assert.deepEqual(p0.map(m=>m.key),['guide','applier','interviewer']);assert(Object.isFrozen(p0));
  assert(EXPERT_MEMBERS.every(m=>Object.isFrozen(m)&&Object.isFrozen(m.callNames)));
  assert.equal(all.length,6);assert.deepEqual(enabledExpertRoster([]),[]);
});
test('documented full-name vocatives, punctuation and request prefixes select deterministic speakers',()=>{
  for(const text of ['前辈，你看看','前辈: 看一下','前辈 看一下','请前辈看看','让前辈看看','叫前辈过来','找前辈看看','你请前辈看看','帮我请前辈看看','你帮我找前辈看看','先看一下。请前辈看看','前辈？'])assert.deepEqual(keys(text),['guide'],text);
  assert.deepEqual(keys('面试官，练一题。'),['interviewer']);assert.deepEqual(keys('投递官：核对材料。'),['applier']);
  assert.deepEqual(keys('技能教练，练一个点。',all),['coach']);assert.deepEqual(keys('教练，练一个点。',all),['coach']);
  assert.deepEqual(keys('规划师，比较方向。',all),['planner']);assert.deepEqual(keys('人脉官，帮我起草。',all),['networker']);
});
test('single-character names require first-line leading position and punctuation',()=>{
  for(const [name,expert] of [['前','guide'],['投','applier'],['面','interviewer'],['规','planner'],['教','coach'],['脉','networker']] as const){
    for(const mark of ['，',':','：',',','？','?'])assert.deepEqual(keys('  '+name+mark+'看看',all),[expert]);
    for(const text of [name+' 看看','请'+name+'看看','帮我找'+name+'看看','别的事情。'+name+'：看看','背景\n'+name+'：看看'])assert.deepEqual(keys(text,all),[],text);
  }
});
test('ordinary mentions, negation, unstructured @ and human mentor names do not summon experts',()=>{
  for(const text of ['我实验室的前辈说过这件事','我的面试官很友好','我想找的规划师还没回复','别请前辈','不要帮我找面试官','你不要请投递官','前辈和面试官说过这个问题','你说的前辈？','@前辈','/ask guide','mail@example.invalid','请蔓藤导师看看','导师，你看看'])assert.deepEqual(keys(text,all),[],text);
});
test('before/after labels do not summon guide, while an explicit full-name request can contain a comparison',()=>{
  for(const text of ['前：Built X / 后：Led Y','前: Built X，后: Led Y','前：Built X\n后：Led Y'])assert.deepEqual(keys(text),[],text);
  assert.deepEqual(keys('前辈，比较前：Built X / 后：Led Y'),['guide']);
});
test('multiple requested full names preserve text order and repeated aliases do not duplicate a speaker',()=>{
  for(const text of ['前辈、面试官，帮我看看','请前辈和面试官看看','前辈，面试官，帮我看看','前辈、面试官？'])assert.deepEqual(keys(text),['guide','interviewer'],text);
  assert.deepEqual(keys('请投递官和前辈核对。面试官，练一题。'),['applier','guide','interviewer']);
  assert.deepEqual(keys('前辈，你看看。请前辈再核对。'),['guide']);
});
test('quoted prose, inline code, blockquotes and fenced code are data, including unclosed regions',()=>{
  for(const text of ['“请前辈看看。”','「面试官，练一题。」',"'投递官，核对一下。'",'`前辈，看看`','``前辈，看看``','> 前辈，看看','```\n前辈，看看\n```','~~~text\n面试官，看看\n~~~','他说：“请前辈看看。','这里是 `x. 请前辈看看。'])assert.deepEqual(keys(text),[],text);
  assert.deepEqual(keys('“面试官，看看。”请前辈看看。'),['guide']);
  assert.deepEqual(keys('> 面试官，看看\n请前辈看看'),['guide']);
  assert.deepEqual(keys('```text\n面试官，看看\n```\n请前辈看看'),['guide']);
  assert.deepEqual(keys('~~~text\n面试官，看看\n~~~\n请前辈看看'),['guide']);
});
test('ordinary multi-line requests work, while dialogue transcripts and known multi-line transcription do not',()=>{
  assert.deepEqual(keys('前辈，\n帮我核对简历。'),['guide']);
  assert.deepEqual(keys('材料：虚构项目\n请前辈看看'),['guide']);
  for(const text of ['面：Q1\n林舟：我做过虚构项目','前辈：保留第一条\n用户：谢谢','User: Hi\n面试官：练一道'])assert.deepEqual(keys(text),[],text);
  assert.deepEqual(detectNameCall('前辈，\n帮我核对简历',p0,'transcript'),[]);
});
test('disabled requests are identified without joining the enabled call roster',()=>{
  const result=detectNameCall('规划师和前辈，比较一下',p0);
  assert.deepEqual(result.map(x=>[x.expert,x.availability]),[['planner','unavailable'],['guide','enabled']]);
  assert.deepEqual(keys('规划师，你看看'),[]);
  assert.equal(detectNameCall('面试官，你看看',enabledExpertRoster([]))[0].availability,'unavailable');
});
test('source coordinates preserve original Unicode and whitespace; results contain no task body',()=>{
  const text='“😀 数据。”请前辈看看。';const calls=detectNameCall(text,p0);
  assert.equal(calls.length,1);const c=calls[0];assert.equal(text.slice(c.start,c.end),'前辈');assert.equal(c.name,'前辈');
  assert(Object.isFrozen(calls)&&Object.isFrozen(c));assert(!JSON.stringify(c).includes('看看'));
});
test('structured mention and slash-command selections share availability without parsing arbitrary text or enabling an expert',()=>{
  assert.deepEqual(resolveExplicitExpertCall('guide',p0),{expert:'guide',availability:'enabled'});
  assert.deepEqual(resolveExplicitExpertCall('planner',p0),{expert:'planner',availability:'unavailable'});
  for(const bad of ['mentor','companion','@前辈','administrator'])assert.throws(()=>resolveExplicitExpertCall(bad as any,p0));
});
test('invalid roster keys, changed aliases, duplicates and accessors fail without invoking getters',()=>{
  for(const value of [['guide','guide'],['mentor'],new Array(1)])assert.throws(()=>enabledExpertRoster(value as any));
  let read=0;const changed={...p0[0],callNames:['系统管理员']};const getter={key:'guide',label:'前辈',get callNames(){read++;return ['前辈','前'];}};
  for(const value of [[changed],[getter],[p0[0],p0[0]],new Array(1)])assert.throws(()=>detectNameCall('前辈，看看',value as any));
  const array=[p0[0]];Object.defineProperty(array,0,{get(){read++;return p0[0];},enumerable:true});assert.throws(()=>expertRosterKeys(array));assert.equal(read,0);
});
test('bounded text validation rejects malformed Unicode/control input without echoing it',()=>{
  for(const value of ['x'.repeat(20001),'前辈，\u0000','前辈，\ud800',null])assert.throws(()=>detectNameCall(value as any,p0),/NAME_CALL_INVALID_TEXT/);
  assert.throws(()=>detectNameCall('前辈，看看',p0,'other' as any),/NAME_CALL_INVALID_SOURCE/);
  assert.deepEqual(keys('前辈，看看😀。'),['guide']);
});

test('nested quotes and fence-like text inside code never become a speaker call',()=>{
  for(const text of ['“他说“例子”。请前辈看看。”','~~~text\n~~~not a closing fence\n前辈，看看\n~~~','```text\n```not a closing fence\n面试官，看看\n```','`x. `` 请前辈看看。 `'])assert.deepEqual(keys(text),[],text);
  assert.deepEqual(keys('~~~text\n面试官，看看\n~~~~\n请前辈看看'),['guide']);
  assert.deepEqual(keys('这些怎么看，前辈？接着再聊。'),['guide']);
});
