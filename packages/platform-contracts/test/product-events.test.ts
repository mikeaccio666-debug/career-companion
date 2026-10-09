import test from 'node:test';import assert from 'node:assert/strict';
import {parseProductEvent} from '../src/product-events.ts';
test('career event props copy and freeze only the implemented enum fields',()=>{
 const raw={event:'application_stage_changed',props:{from_stage:'applied',to_stage:'closed',closed_reason:'not_advanced'}};
 const v=parseProductEvent(raw);raw.props.to_stage='saved';assert.equal(v.props.to_stage,'closed');assert(Object.isFrozen(v.props));assert(Object.isFrozen(v));
 for(const source of ['paste','upload','derived'])assert.equal(parseProductEvent({event:'resume_version_created',props:{source}}).props.source,source);
 assert.equal(parseProductEvent({event:'story_saved',props:{source:'user_entered'}}).event,'story_saved');
});
test('unknown events, free text, nulls, invalid transitions and exotic records are rejected without echoing input',()=>{
 const story={event:'story_saved',props:{source:'user_entered'}};
 const getter={...story};Object.defineProperty(getter,'props',{get(){throw Error('PRIVATE GETTER');}});
 const inherited=Object.create({props:story.props});inherited.event='story_saved';
 for(const input of [{...story,event:'message_sent'},{...story,props:{source:'PRIVATE BODY'}},{...story,props:{...story.props,text:'PRIVATE BODY'}},
 {...story,props:null},{...story,ownerId:'PRIVATE BODY'},getter,inherited,
 {event:'application_stage_changed',props:{from_stage:'applied',to_stage:'closed',closed_reason:'none'}},
 {event:'application_stage_changed',props:{from_stage:'applied',to_stage:'offer',closed_reason:'not_advanced'}}]){
  assert.throws(()=>parseProductEvent(input),e=>e instanceof Error&&e.message==='Unsupported product event.');
 }
});
