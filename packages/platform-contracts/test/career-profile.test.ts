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

test('intake provenance is optional for legacy profiles, closed and immutable, and cannot be supplied in a manual command',()=>{
 const profile={...facts,id:operationId,ownerId:operationId,revision:1,source:'user_entered',
  confirmedAt:'2026-10-01T00:00:00.000Z',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',lastOperationId:operationId};
 const snapshot=(p:unknown)=>parseCareerProfileSnapshot({ownerId:operationId,revision:1,profile:p});
 assert(!Object.hasOwn(snapshot(profile).profile!,'intakeSource'));
 const intakeSource={draftId:operationId,revision:2},parsed=snapshot({...profile,intakeSource});
 intakeSource.revision=9;assert.equal(parsed.profile?.intakeSource?.revision,2);assert(Object.isFrozen(parsed.profile?.intakeSource));
 for(const value of [null,undefined,{draftId:operationId,revision:0},{draftId:'invalid',revision:1},{draftId:operationId,revision:1,ownerId:operationId}]){
  assert.throws(()=>snapshot({...profile,intakeSource:value}));
 }
 assert.throws(()=>parseCareerProfileCommand('save',{operationId,expectedRevision:0,facts,confirmed:true,intakeSource}));
});
