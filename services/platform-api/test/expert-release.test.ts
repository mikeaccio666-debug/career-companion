import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseExpertRelease,readExpertRelease} from '../src/expert-release.ts';
import {readConfig} from '../src/config.ts';
test('released expert roster is absent by default and an explicit empty roster advertises nobody',()=>{
 assert.equal(readConfig({}).expertRoster,undefined);
 const v=readConfig({PLATFORM_EXPERT_ROSTER_JSON:JSON.stringify({schemaVersion:1,revision:1,enabledExperts:[]})}).expertRoster!;
 assert.deepEqual(v,{schemaVersion:1,revision:1,enabledExperts:[]});assert(Object.isFrozen(v));assert(Object.isFrozen(v.enabledExperts));
});
test('operator roster is copied, versioned and never defaults to P0 membership',()=>{
 const input={schemaVersion:1,revision:2,enabledExperts:['guide','interviewer']};
 assert.throws(()=>parseExpertRelease({...input,enabledExperts:undefined}));
 const v=parseExpertRelease(input);input.enabledExperts.push('applier');assert.deepEqual(v.enabledExperts,['guide','interviewer']);
});
test('malformed, extra, duplicate and unknown release declarations fail without echoing source text',()=>{
 const good={schemaVersion:1,revision:1,enabledExperts:[]};
 for(const x of [{...good,extra:'PRIVATE_CONFIG'}, {...good,revision:0},{...good,revision:1.1},{...good,schemaVersion:2},
  {...good,enabledExperts:['guide','guide']},{...good,enabledExperts:['PRIVATE_CONFIG']},{schemaVersion:1,revision:1},
  {...good,enabledExperts:null}]){
  assert.throws(()=>readExpertRelease(JSON.stringify(x)),e=>e instanceof Error&&!e.message.includes('PRIVATE_CONFIG'));
 }
 for(const x of ['','PRIVATE_CONFIG','x'.repeat(2049)])assert.throws(()=>readExpertRelease(x));
});
