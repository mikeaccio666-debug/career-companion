import assert from 'node:assert/strict';
import { createProviderRuntime } from '@companion/ai-core';
import { Database } from '../../src/database.ts';
import { readConfig } from '../../src/config.ts';
import { readDataCrypto } from '../../src/data-crypto.ts';
import { BackgroundGeneration } from '../../src/background-generation.ts';
import { CompanionIdentityDrafts } from '../../src/companion-identity-drafts.ts';
import { CompanionNameSafety } from '../../src/companion-name-safety.ts';
import type { FixedSessionContext } from '../../src/auth.ts';
import type { CompanionIdentityBundle } from '../../src/companion-identity-bundle.ts';
import type { CompanionIdentityReview } from '../../src/companion-identity-review.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';
import { prebirthDetector } from './companion-prebirth.ts';

interface Input {databaseUrl:string;who:FixedSessionContext;taskId:string;sourceId:string;asset:CompanionIdentityBundle;review:CompanionIdentityReview;}
process.once('message',async value=>{
  let db:Database|undefined;
  try {
    const input=value as Input,url=new URL(input.databaseUrl);
    assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.notEqual(url.port,'5442');
    assert.match(url.searchParams.get('options')??'',/^-c search_path=companion_name_[0-9a-f]{32}$/);
    const crypto=readDataCrypto({PLATFORM_DATA_KEY:'e5'.repeat(32)})!;
    db=new Database(url.toString());const config={...readConfig(),databaseUrl:url.toString(),dataCrypto:crypto,requireVerifiedEmail:true};
    const runtime=createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:()=>{throw new Error('No provider may run in the unstarted claim child.');}});
    const background=new BackgroundGeneration(db,config,FICTIONAL_LEGAL,runtime);
    const identities=new CompanionIdentityDrafts(db,config,FICTIONAL_LEGAL,background,input.asset,input.review);
    const names=new CompanionNameSafety(db,config,FICTIONAL_LEGAL,background,identities);
    const claim=await names.claimSubmission(input.who,{taskId:input.taskId,submissionId:input.sourceId,detectorRevision:prebirthDetector.revision,leaseMs:100});
    assert(claim);assert.equal(claim.generation,1);
    process.send?.({kind:'claim_committed',sourceId:input.sourceId,generation:claim.generation});
    // The parent receives proof after claim COMMIT, then truly SIGKILLs this PID.
    // No process/start call, artificial lease update or caller-made claim occurs.
    setInterval(()=>{},1000);
  } catch {process.send?.({kind:'failed'});await db?.close();process.exitCode=1;process.disconnect?.();}
});
