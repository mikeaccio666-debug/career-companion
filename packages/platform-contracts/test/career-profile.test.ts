import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCareerProfileFacts,parseCareerProfileCommand,parseCareerProfileSnapshot} from '../src/career-profile.ts';
const operationId='12345678-1234-4123-8123-123456789012';
const facts={degreeField:null,graduationMonth:null,graduated:null,targetTracks:[]};
test('unknowns remain explicit and detached while save requires owner confirmation',()=>{
 const input={...facts,targetTracks:['da']};const result=parseCareerProfileFacts(input);input.targetTracks.push('ds');assert.deepEqual(result.targetTracks,['da']);assert(Object.isFrozen(result.targetTracks));
 assert.deepEqual(parseCareerProfileCommand('save',{operationId,expectedRevision:0,facts,confirmed:true}).facts,facts);
 assert.throws(()=>parseCareerProfileCommand('save',{operationId,expectedRevision:0,facts}));
 assert.throws(()=>parseCareerProfileCommand('delete',{operationId,expectedRevision:0,facts}));
});
test('client attribution, invalid months, sparse/accessor/duplicate tracks and forged revision cannot enter a profile',()=>{
 for(const patch of [{graduationMonth:'2028-13'},{graduationMonth:'2028-05\n'},{graduationMonth:'2028-05-01'},{degreeField:'invented'},{graduated:'false'},{targetTracks:['da','da']},{targetTracks:new Array(1)},{ownerId:operationId}]){
  assert.throws(()=>parseCareerProfileFacts({...facts,...patch}));
 }
 let reads=0;const tracks:string[]=[];Object.defineProperty(tracks,'0',{get(){reads++;return 'da';},enumerable:true});assert.throws(()=>parseCareerProfileFacts({...facts,targetTracks:tracks}));assert.equal(reads,0);
 for(const revision of [-0,-1,1.5,2147483648])assert.throws(()=>parseCareerProfileCommand('delete',{operationId,expectedRevision:revision}));
 assert.throws(()=>parseCareerProfileSnapshot({ownerId:operationId,revision:0,profile:{...facts,id:operationId}}));
});
