import { test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { parseResumeUploadCommand,parseResumeUploadSnapshot,parseResumeReviewCommand,parseResumeReviewPayload } from '../src/resume-review.ts';
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

test('uploaded original commands cannot supply extracted text, provider claims, provenance or confirmation',()=>{
 const command={operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional file',uploadId:randomUUID(),sha256:'1'.repeat(64)};assert.equal(parseResumeUploadCommand(command).uploadId,command.uploadId);
 for(const patch of [{text:'Forged extraction.'},{source:'upload'},{uploadSource:{}},{draftedBy:'guide'},{approvedAt:'2026-10-08T00:00:00.000Z'},{expectedRevision:1},{sha256:'not-a-digest'}])assert.throws(()=>parseResumeUploadCommand({...command,...patch}));
 const snapshot={uploadId:command.uploadId,storageVersion:'"fictional-stable-version"',byteSize:100,sha256:command.sha256,textSha256:'2'.repeat(64),parser:'pdftotext',engineVersion:'26.01.0'};assert(Object.isFrozen(parseResumeUploadSnapshot(snapshot)));
 for(const patch of [{storageVersion:'W/"weak"'},{byteSize:0},{textSha256:null},{parser:'provider'},{engineVersion:'unverified'}])assert.throws(()=>parseResumeUploadSnapshot({...snapshot,...patch}));
});
