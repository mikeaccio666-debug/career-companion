import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EXPERT_PERSONAS, EXPERT_PERSONA_RULES, EXPERT_MEMBERS, P0_EXPERT_KEYS, expertPersona, compileExpertPersona, careerSkill, careerCapability, COMPANION_MEMORY_CATEGORIES } from '../src/index.ts';
function characters(value:unknown):number {
  if(typeof value==='string')return Array.from(value).length;
  if(value && typeof value==='object')return Object.values(value).reduce<number>((sum,item)=>sum+characters(item),0);
  return 0;
}
test('P0 personas have canonical identity, complete distinct examples, bounded card text and deeply frozen revisions',()=>{
  assert.deepEqual(EXPERT_PERSONAS.map(p=>p.card.key).sort(),[...P0_EXPERT_KEYS].sort());
  for(const persona of EXPERT_PERSONAS){
    const card=persona.card,member=EXPERT_MEMBERS.find(m=>m.key===card.key)!;
    assert.equal(card.displayName,member.label);assert.equal(card.sealChar,member.callNames.at(-1));assert.equal(card.ink_token,card.key);assert.equal(card.roleLabel,'AI 专家');
    assert(characters(card)<=600,`${card.key} card values: ${characters(card)}`);
    assert(persona.exemplars.length>=12&&persona.exemplars.length<=16);assert.equal(new Set(persona.exemplars).size,persona.exemplars.length);
    assert(persona.signatures.length>=1&&persona.signatures.length<=2);assert.equal(persona.antiExemplars.length,3);
    assert(Object.isFrozen(persona)&&Object.isFrozen(card)&&Object.isFrozen(card.do)&&Object.isFrozen(persona.exemplars));
    assert.throws(()=>{(card.do as string[]).push('tamper');});assert.throws(()=>{(persona.exemplars as string[])[0]='tamper';});
  }
});
test('role skill/tool references agree with actual manifests without granting act or cross-expert consultation',()=>{
  for(const {card} of EXPERT_PERSONAS){
    for(const id of card.skills){const skill=careerSkill(id);assert.equal(skill.owner,card.key);assert.equal(skill.phase,'P0');}
    for(const id of card.tools){const tool=careerCapability(id)!;assert(tool,id);assert(tool.speakers.includes(card.key));assert.notEqual(tool.effect,'act');assert.notEqual(tool.effect,'consult');}
    for(const category of card.memoryCategories)assert(COMPANION_MEMORY_CATEGORIES.includes(category));
    assert(!card.memoryCategories.includes('emotion_rhythm'));assert(!('enabled' in card));
  }
});
test('expert revisions do not silently fall back or activate future experts, human mentors or companion personas',()=>{
  for(const key of ['planner','coach','networker','mentor','companion','administrator',null])assert.throws(()=>expertPersona(key as never),/EXPERT_PERSONA_UNAVAILABLE/);
  for(const revision of [0,2,-1,NaN,Infinity,'1',null])assert.throws(()=>compileExpertPersona('guide',revision as never),/EXPERT_PERSONA_UNAVAILABLE/);
  assert(!compileExpertPersona('applier').includes('后台筛岗'));
});
test('role-specific form and common boundaries remain in the actual compiled layer, while negative examples are explicitly labeled',()=>{
  const guide=compileExpertPersona('guide'),interviewer=compileExpertPersona('interviewer'),applier=compileExpertPersona('applier');
  for(const value of [guide,interviewer,applier]){assert(value.includes(EXPERT_PERSONA_RULES));assert(value.includes('反例（禁止模仿）'));assert(value.includes('不是用户事实'));assert(value.includes('不授权调用'));}
  for(const text of ['改前 / 改后','课程项目','团队贡献','___'])assert(guide.includes(text));
  for(const text of ['一次一题','等你回答','真实面试','不评价口音外貌','What did you personally do next?'])assert(interviewer.includes(text));
  for(const text of ['还没核实是否开放','时区','需要你自己回答','以你确认的授权卡为准','没有真实回执'])assert(applier.includes(text));
});
test('compiled persona bytes are independent of mutable callers and stable across interleaved roles',()=>{
  const guide=compileExpertPersona('guide');compileExpertPersona('interviewer');compileExpertPersona('applier');assert.equal(compileExpertPersona('guide'),guide);
  const copy=JSON.parse(JSON.stringify(expertPersona('guide')));copy.card.roleLine='change';assert.equal(compileExpertPersona('guide'),guide);
  assert.notEqual(createHash('sha256').update(guide).digest('hex'),createHash('sha256').update(compileExpertPersona('interviewer')).digest('hex'));
});

test('published persona revision bytes are pinned for prefix stability; intentional text changes require a reviewed revision',()=>{
 const expected={guide:'f2e5db762ed8df8279323e6cd1e3c92219f12ba9701ee54304e9faab750fa194',interviewer:'14745b3575e32f71d40bed1b00c12e2554fb3cf14b679a7615c923ee28551c01',applier:'b01d4695178a5e3021565dd9b4c1e302a86eb722ac16dc6fd03d23bee633dcae'};
 for(const key of ['guide','interviewer','applier'] as const){assert.equal(expertPersona(key).card.revision,1);assert.equal(createHash('sha256').update(compileExpertPersona(key,1)).digest('hex'),expected[key]);}
});
