import { test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { parseResumeReviewCommand,parseResumeReviewPayload } from '../src/resume-review.ts';
test('owner original commands reject forged approval, author, channel, source, model claims and executable actions',()=>{
 const command={operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional original',text:'Fictional course project; personal contribution.'};
 assert.equal(parseResumeReviewCommand('create',command).text,command.text);
 for(const patch of [{source:'model'},{draftedBy:'guide'},{ownerId:randomUUID()},{approvedDigest:'0'.repeat(64)},{claims:[]},{channel:'web'},{finalAction:'extension'},{uploadId:randomUUID()}])assert.throws(()=>parseResumeReviewCommand('create',{...command,...patch}));
 assert.throws(()=>parseResumeReviewCommand('create',{...command,expectedRevision:1}));assert.throws(()=>parseResumeReviewCommand('create',{...command,track:'unknown'}));
 assert.throws(()=>parseResumeReviewCommand('create',{...command,get text(){throw Error('getter must not run');}}));
});
test('the owner-original payload has one actual first-revision reference and cannot pretend model claims were evaluated',()=>{
 const id=randomUUID(),payload={text:'Fictional raw text.',claims:[],source_refs:[{kind:'owner_resume_input',id,revision:1}]};assert(Object.isFrozen(parseResumeReviewPayload(payload).source_refs));
 for(const patch of [{claims:[{id:randomUUID(),resolution:'user_affirmed'}]},{source_refs:[]},{source_refs:[{kind:'profile',id,revision:1}]},{source_refs:[{kind:'owner_resume_input',id,revision:2}]},{source_refs:new Array(1)}])assert.throws(()=>parseResumeReviewPayload({...payload,...patch}));
});
