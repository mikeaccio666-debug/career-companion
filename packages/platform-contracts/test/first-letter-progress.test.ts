import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFirstLetterProgress,FIRST_LETTER_PROGRESS_STATES} from '../src/first-letter-progress.ts';
const id='11111111-1111-4111-8111-111111111111';
const data={ownerId:id,companionId:id,welcomeId:id,state:'prepared',capturedAt:'2026-10-09T20:00:00.000Z',delivered:false};
test('progress accepts documented states without implying delivery or exposing extra model fields',()=>{
 for(const state of FIRST_LETTER_PROGRESS_STATES){const value=parseFirstLetterProgress({...data,state});assert.equal(value.delivered,false);assert(Object.isFrozen(value));}
 for(const patch of [{state:'delivered'},{delivered:true},{body:'private'},{model:'private'},{ownerId:'bad'},{capturedAt:'2026-02-30T00:00:00.000Z'}])
  assert.throws(()=>parseFirstLetterProgress({...data,...patch}));
 let accessed=false;const bad={...data};Object.defineProperty(bad,'state',{get(){accessed=true;return 'reviewed';}});
 assert.throws(()=>parseFirstLetterProgress(bad));assert.equal(accessed,false);
});
