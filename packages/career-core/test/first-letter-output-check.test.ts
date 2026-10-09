import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCompanionOutput,checkGroundedOutputClaims,companionOutputForbiddenRules,
 type FirstLetterOutputCheckInput,type CompanionOutputRule} from '../src/companion/output-check.ts';

const identity='我是墨，名字是你起的。我是 AI。';
const memory='只记你同意的；在「我 → 它记得的你」可查看、修改、删除。';
const external='要发给别人的消息和材料，都先进待确认；表单里哪些项可以替你做，由你在对话里逐项确认；最终提交永远由你本人点。';
const personal='你填的专业是 DS / 统计，目前在投，还没面试。';
const team='前辈帮你整理简历，投递官帮你整理投递，面试官陪你练面试。';
const today='接下来一起看今天的三件事。';
const body=identity+memory+external+personal+team+today;
type MutableInput={-readonly [K in keyof FirstLetterOutputCheckInput]:FirstLetterOutputCheckInput[K]};
function input(text=body):MutableInput{
 const quotes=['DS / 统计','在投，还没面试'],refs=['study','search_stage'];
 return {surface:'first_letter',channel:'web',companionId:'00000000-0000-4000-8000-000000000001',
  dimensions:{warmth:0,directness:0,drive:0,structure:0,levity:0,code_mix:0,length:'medium'},text,
  sources:quotes.map((text,i)=>({ref:refs[i],kind:'profile',revision:1,text})),
  claims:quotes.filter(q=>text.includes(q)).map(quote=>({start:text.indexOf(quote),end:text.indexOf(quote)+quote.length,
   kind:'user_fact',sourceRefs:[refs[quotes.indexOf(quote)]]})),
  letter:{name:'墨',sealChar:'墨',date:'2026-10-09',emotionLanguage:'zh',enabledExperts:['guide','applier','interviewer']}};
}
const check=(text:string)=>checkCompanionOutput(input(text));
const block=(text:string,rule:CompanionOutputRule)=>{
 const r=check(text);assert.equal(r.status,'blocked');assert(r.rules.includes(rule),r.rules.join(','));
};
test('complete factual letter enters common review, and future expert help is not reported as completed execution',()=>{
 const result=check(body);
 assert.equal(result.status,'requires_review');assert(!result.rules.includes('unverified_execution'));
 assert(result.rules.includes('semantic_review_required'));assert(Object.isFrozen(result));assert(Object.isFrozen(result.rules));
 assert.equal(result.assurance,'deterministic_rules_with_heuristic_fact_detection');
 for(const key of ['text','approved','ready','sources','completed'])assert(!Object.hasOwn(result,key));
});
test('existing forbidden configuration applies to first letters, including first-letter sales pressure',()=>{
 for(const text of ['宝子','冲鸭','稳了','限时','别人都已经'])block(body+text,'forbidden_expression');
 assert(companionOutputForbiddenRules({text:'最后三个名额',surface:'first_letter'}).includes('sales_pressure'));
});
for(const [extra,rule] of [
 ['保证你拿到offer。','outcome_promise'],['我是一个真人。','identity_claim'],
 ['我以前在学校帮别人找工作。','identity_claim'],['只有我懂你。','identity_claim'],
 ['我使用 ＯｐｅｎＡＩ。','provider_disclosure'],['先买套餐。','paid_without_authorization'],
 ['你符合OPT资格。','immigration_fact'],['我已经发送邮件。','unverified_execution'],
 ['I have submitted the application.','unverified_execution'],
 ['先看看！！','channel_limit'],['先看 https://example.test','channel_limit']
] as const)test('first letter blocks '+rule+' '+extra,()=>block(body+extra,rule));

test('required identity, memory controls, external authorization and today introduction are independently checked',()=>{
 for(const [original,replacement,rule] of [
  [identity,'我是墨。','first_letter_identity_missing'],
  [memory,'我会记住所有事情。','first_letter_memory_missing'],
  ['、删除','','first_letter_memory_missing'],
  ['可查看','可以','first_letter_memory_missing'],
  ['逐项确认','确认','first_letter_external_rule_missing'],
  ['最终提交永远由你本人点','最后由我们处理','first_letter_external_rule_missing'],
  [today,'接下来先聊聊。','first_letter_today_missing']
 ] as const)block(body.replace(original,replacement),rule);
});
test('actual roster is checked independently from generic P0 labels, including unavailable and missing team members',()=>{
 block(body+'规划师也在。','first_letter_team_mismatch');
 block(body.replace('面试官陪你练面试。',''),'first_letter_team_mismatch');
 const r=input(body.replace(team,''));
 r.letter={...r.letter,enabledExperts:[]};
 assert.equal(checkCompanionOutput(r).status,'requires_review');
});
test('zero or one fact needs a candid next information step and never two manufactured references',()=>{
 const empty=input(identity+memory+external+team+today);
 empty.sources=[];empty.claims=[];
 assert(checkCompanionOutput(empty).rules.includes('first_letter_followup_missing'));
 empty.text+='接下来可以先了解你的方向。';
 assert.equal(checkCompanionOutput(empty).status,'requires_review');
 const one=input();
 one.sources=one.sources.slice(0,1);one.claims=one.claims.slice(0,1);one.text+='接下来可以先了解你的方向。';
 assert.equal(checkCompanionOutput(one).status,'requires_review');
});
test('missing, foreign or repeated references cannot satisfy the minimum facts requirement',()=>{
 const r=input();
 for(const claims of [[],[r.claims[0]],[r.claims[0],r.claims[0]],
  [r.claims[0],{...r.claims[1],sourceRefs:['invented']}]])
  assert(checkCompanionOutput({...r,claims}).rules.includes('first_letter_facts_missing'));
 const raw=input();
 assert.deepEqual(checkCompanionOutput({...raw,sources:raw.sources.map(s=>({...s,kind:'tool_result'}))}).rules,['invalid_input']);
});
test('exact matching, partial citations and coverage phrases never certify factual semantics',()=>{
 const r=input();
 assert.equal(checkGroundedOutputClaims({text:r.text,surface:'first_letter',sources:r.sources,claims:r.claims}).status,'matched_spans');
 const invented=check(body+'你拥有博士学位。');
 assert.equal(invented.status,'requires_review');assert(invented.rules.includes('unverified_user_fact'));
 const mismatch={...r,sources:r.sources.map(s=>({...s,text:'A different fictional fact.'}))};
 const result=checkCompanionOutput(mismatch);
 assert.equal(result.status,'requires_review');assert(result.rules.includes('unverified_user_fact'));
 // A quoted keyword can occur inside a wrong proposition; it is still review.
 const misleading=check(body.replace('你填的专业是','你已经获得博士学位，专业是'));
 assert.notEqual(misleading.status,'passed_rules');
 assert.notEqual(check(body.replace('我是 AI','不是说我是 AI')).status,'passed_rules');
 assert.notEqual(check(body+'你的毕业时间是2030年。').status,'passed_rules');
});
test('English letter, absent-language fallback and wrong-language detection preserve actual preference',()=>{
 const english="You chose my name. I am AI. I remember only with consent. View, edit, delete in What I remember about you. Messages and materials await review. Form: each field approved in chat; final submit is by you. Next, tell me your goals. Today's three things.";
 const r=input(english);r.sources=[];r.claims=[];
 r.letter={...r.letter,enabledExperts:[],emotionLanguage:'en'};
 assert.equal(checkCompanionOutput(r).status,'requires_review');
 assert(checkCompanionOutput({...r,letter:{...r.letter,emotionLanguage:'zh'}}).rules.includes('first_letter_language_mismatch'));
 const chinese=input(body.replace('DS / 统计','数据科学').replace('AI','人工智能'));
 chinese.letter={...chinese.letter,emotionLanguage:'en'};
 assert(checkCompanionOutput(chinese).rules.includes('first_letter_language_mismatch'));
 const unset=input();unset.letter={...unset.letter,emotionLanguage:null};
 assert.equal(checkCompanionOutput(unset).status,'requires_review');
});
test('length includes the real name/date and explicit persona contradictions still block',()=>{
 block(body+'界'.repeat(350),'channel_limit');
 const r=input(body+'我会紧盯进度。');r.dimensions={...r.dimensions,drive:-1};
 assert(checkCompanionOutput(r).rules.includes('personality_conflict'));
});
test('closed input never accepts a model semantic permit, getter, invalid seal/date or invented enabled expert',()=>{
 let reads=0;const r=input();
 for(const value of [
  {...r,approved:true},{...r,semanticReview:{approved:true}},
  {...r,get text(){reads++;return 'PRIVATE';}},
  {...r,letter:{...r.letter,enabledExperts:['invented']}},
  {...r,letter:{...r.letter,date:'2026-02-30'}},
  {...r,letter:{...r.letter,sealChar:'XX'}},
  {...r,letter:{...r.letter,get name(){reads++;return 'PRIVATE';}}},
  {...r,dimensions:{...r.dimensions,drive:-0}}
 ]){
  const result=checkCompanionOutput(value);
  assert.equal(result.status,'blocked');assert.deepEqual(result.rules,['invalid_input']);
  assert(!JSON.stringify(result).includes('PRIVATE'));
 }
 assert.equal(reads,0);
});
