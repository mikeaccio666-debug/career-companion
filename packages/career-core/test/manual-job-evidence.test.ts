import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualJobEvidence } from '../src/manual-job-evidence.ts';
test('manual text detection cites original offsets without turning requirements, conditional language or conflicts into assurance',()=>{
 const cases:[string,string][]=[['We will provide visa sponsorship.','explicit_yes'],['We sponsor qualified candidates.','explicit_yes'],['We will not sponsor candidates.','explicit_no'],['Visa sponsorship is not available.','explicit_no'],['Candidates must be U.S. citizens.','explicit_no'],['Applicants must not require visa sponsorship.','explicit_no'],['Candidates must have work authorization.','unknown'],['Sponsorship may be available depending on the role.','unknown'],['U.S. citizenship is not required.','unknown'],['No security clearance is required.','unknown'],['No visa sponsorship is required.','unknown'],['U.S. citizenship is required.','explicit_no'],['If we cannot provide visa sponsorship, we will contact you.','unknown'],['We sponsor all roles except this position.','unknown'],['We can provide visa sponsorship. Sponsorship is subject to review.','unknown'],['We sponsor candidates. We will not sponsor this role.','unknown']];
 for(const [text,status] of cases){const result=manualJobEvidence(text);assert.equal(result.sponsorship,status,text);assert(result.sponsorshipEvidence.length);for(const e of result.sponsorshipEvidence)assert.equal(text.slice(e.start,e.end),e.text);}
});
test('line boundaries, US abbreviations, CRLF and original punctuation remain exact; no keyword remains unknown',()=>{
 const text='Fictional role.\r\n  Candidates must be U.S. Citizens.\r\nWork authorization is required.\n';const result=manualJobEvidence(text);assert.equal(result.sponsorshipEvidence[0].text,'Candidates must be U.S. Citizens.');assert.equal(result.sponsorship,'explicit_no');
 assert.deepEqual(manualJobEvidence('Fictional analytics role with SQL.'),{sponsorship:'unknown',sponsorshipEvidence:[],evidenceOverflow:false,ruleRevision:1});assert(Object.isFrozen(result.sponsorshipEvidence));
});
test('a bounded evidence view cannot conceal a later conflict or act as a complete policy determination',()=>{
 const text=Array.from({length:60},()=> 'We sponsor candidates.').join('\n')+'\nWe will not sponsor this role.';const result=manualJobEvidence(text);assert.equal(result.sponsorshipEvidence.length,50);assert.equal(result.evidenceOverflow,true);assert.equal(result.sponsorship,'unknown');
});
