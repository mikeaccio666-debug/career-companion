import {expect,it} from 'vitest';
import {parseGetRecommendationBatchResponse} from '../src/recommendations.ts';
import {parseJobCardView} from '../src/job-card.ts';
const id='10000000-0000-4000-8000-000000000001';
const job={jobId:'synthetic',title:'Engineer',company:'Fixture',location:null,employmentType:null,sourcePlatform:'GREENHOUSE',atsProvider:'GREENHOUSE',qualification:{eligibility:'ELIGIBLE',score:null,scoreScale:100,reasons:[],risks:[],missingRequirements:[],sponsorship:{status:'UNKNOWN',sourceCode:'UNKNOWN',confidence:null},referralAvailability:'UNKNOWN'}};
const batch={id,conversationId:id,revision:'1',status:'OPEN',localDate:'2026-09-14',generatedAt:'2026-09-14T00:00:00.000Z',expiresAt:'2026-09-15T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z',items:[{id,revision:'1',status:'PENDING',job,missionId:null,decidedAt:null}],counts:{total:1,pending:1,approved:0,skipped:0,unavailable:0}};
it('accepts legacy batches and declared optional policy provenance only',()=>{
 for(const extra of [{},{policyVersion:null},{policyVersion:'recommendation:1'}])expect(parseGetRecommendationBatchResponse({schemaVersion:1,batch:{...batch,...extra}})).not.toBeNull();
 for(const extra of [{policyVersion:'invalid'},{policyVersion:'recommendation:0'},{policyVersion:'recommendation:1000000000'},{policyVersion:2},{policyVersion:''},{policyVersion:'x'.repeat(513)},{policyVersion:'private\ntext'},{arbitrary:true}])expect(parseGetRecommendationBatchResponse({schemaVersion:1,batch:{...batch,...extra}})).toBeNull();
});
it('validates the declared optional qualification vocabulary without relaxing arbitrary response keys',()=>{
 const qualification={...job.qualification,locationTier:'B',pendingConfirmations:[{code:'LOCATION',defaultText:'Confirm location',safeParams:{}}]};
 expect(parseJobCardView({...job,qualification})).not.toBeNull();
 for(const delta of [{locationTier:'Z'},{pendingConfirmations:[{code:'UNKNOWN_CODE',defaultText:'',safeParams:{}}]},{unexpected:true}])expect(parseJobCardView({...job,qualification:{...qualification,...delta}})).toBeNull();
});
