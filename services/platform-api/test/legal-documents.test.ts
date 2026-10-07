import { readConfig } from '../src/config.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { legalContentDigest, parseLegalBundle, loadLegalBundle } from '../src/legal-documents.ts';
import { parseTermsAcceptance } from '../src/student-entry.ts';
import { FICTIONAL_LEGAL, fictionalAcceptance } from './fixtures/student-entry.ts';

test('missing or malformed legal data stays unavailable without synthesizing approved terms', async()=>{
  assert.equal(await loadLegalBundle(),null); assert.equal(await loadLegalBundle('/nonexistent-fictional-bundle.json'),null);
  for(const value of [null,{}, {...FICTIONAL_LEGAL,digest:'0'.repeat(64)}, {...FICTIONAL_LEGAL,reviewDigest:'0'.repeat(64)}, {...FICTIONAL_LEGAL,extra:true}, {...FICTIONAL_LEGAL,terms:{title:'Test',body:''}}, {...FICTIONAL_LEGAL,review:{reference:'fictional',approvedAt:'bad'}}])assert.equal(parseLegalBundle(value),null);
});
test('legal digest binds all displayed documents and notice; parsed input is immutable',()=>{
  const parsed=parseLegalBundle(FICTIONAL_LEGAL)!; assert.equal(parsed.digest,legalContentDigest(parsed));
  assert(Object.isFrozen(parsed));assert(Object.isFrozen(parsed.terms));assert(Object.isFrozen(parsed.review));
  assert.notEqual(legalContentDigest({...parsed,dataNotice:parsed.dataNotice+' changed'}),parsed.digest);
});
test('loader reads exact explicit file content and malformed UTF8 fails closed',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-legal-'));
  try{const file=path.join(dir,'bundle.json');await fs.writeFile(file,JSON.stringify(FICTIONAL_LEGAL));assert.deepEqual(await loadLegalBundle(file),FICTIONAL_LEGAL);
    await fs.writeFile(file,Buffer.from([0xff,0xfe]));assert.equal(await loadLegalBundle(file),null);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('acceptance is explicit, exact-version and closed, with no consent defaults',()=>{
  assert.deepEqual(parseTermsAcceptance(fictionalAcceptance()),fictionalAcceptance());
  for(const value of [undefined,{}, {...fictionalAcceptance(),accepted:false}, {...fictionalAcceptance(),userId:'fictional'}, ...['\n','\r','\r\n','\u2028','\u2029'].flatMap(char=>[{...fictionalAcceptance(),version:FICTIONAL_LEGAL.version+char},{...fictionalAcceptance(),digest:FICTIONAL_LEGAL.digest+char}])])assert.throws(()=>parseTermsAcceptance(value));
});

test('invitation configuration defaults closed and permits explicit development-only open registration',()=>{
  assert.equal(readConfig({}).requireInvite,true);assert.equal(readConfig({PLATFORM_REQUIRE_INVITE:'1'}).requireInvite,true);assert.equal(readConfig({PLATFORM_REQUIRE_INVITE:'0'}).requireInvite,false);
  assert.throws(()=>readConfig({NODE_ENV:'production',PLATFORM_REQUIRE_INVITE:'0'}),/requires invitations/);
  for(const value of ['true','false','','1\n'])assert.throws(()=>readConfig({PLATFORM_REQUIRE_INVITE:value}));
  assert.equal(readConfig({}).legalBundlePath,undefined);
});
