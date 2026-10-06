import { parseAssistantJobEntry,parseAtsReportResponse,type AssistantCommerceResult,type AssistantJobEntry,type ApplicationPreparationView,type AssistantCoverDraftResponse,parseUuid } from '@edaix/contracts';
import type {CommercePorts} from '../features/commerce/ports';
export const COMMERCE_FIXTURE_ROLE='22222222-2222-4222-8222-222222222222';
export const COMMERCE_FIXTURE_RESUME='33333333-3333-4333-8333-333333333333';
const jobId='44444444-4444-4444-8444-444444444444',entryId='55555555-5555-4555-8555-555555555555',batchId='66666666-6666-4666-8666-666666666666';
export function createCommerceFixture(){
  let entry=parseAssistantJobEntry({id:entryId,conversationId:COMMERCE_FIXTURE_ROLE,batchId,itemId:'77777777-7777-4777-8777-777777777777',canonicalJobId:jobId,
    revision:1,state:'RECEIVED',createdAt:'2026-09-13T00:00:00.000Z',job:{jobId:'fictional-design-role',company:'Harbor Studio',title:'Senior Product Designer',location:'Toronto, Canada',employmentType:'Full-time',
      atsProvider:'GREENHOUSE',sourcePlatform:'GREENHOUSE',qualification:{eligibility:'ELIGIBLE',score:null,scoreScale:100,reasons:[],risks:[],missingRequirements:[],
        sponsorship:{status:'UNKNOWN',sourceCode:'UNKNOWN',confidence:null},referralAvailability:'UNKNOWN'}}})!;
  let delivered=false,scored=false;
  const trackId=parseUuid('10000000-0000-4000-8000-000000000001')!,stamp='2026-09-13T00:00:00.000Z' as never;
  let preparation:ApplicationPreparationView|null=null;
  let cover:AssistantCoverDraftResponse={schemaVersion:1,entryId,revision:0,draft:null};
  const usage=(feature:'jobs.delivered'|'ats.report')=>({feature,unit:feature==='jobs.delivered'?'JOB' as const:'REPORT' as const,state:'AVAILABLE' as const,
    limit:20,consumed:feature==='jobs.delivered'?Number(delivered):Number(scored),reserved:0,remaining:20-(feature==='jobs.delivered'?Number(delivered):Number(scored)),
    windowStart:'2026-09-01T00:00:00.000Z' as never,resetsAt:'2026-10-01T00:00:00.000Z' as never});
  const report=()=>parseAtsReportResponse({schemaVersion:1,id:'88888888-8888-4888-8888-888888888888',entryId,resumeVersionId:COMMERCE_FIXTURE_RESUME,status:'SUCCEEDED',failureCode:null,
    source:{resumeHash:'a'.repeat(64),resumeRevision:1,canonicalJobId:jobId,canonicalJobRevision:'1',listingGenerationKey:'fixture-g1',descriptionDigest:'sha256:'+'b'.repeat(64),providerIdentity:'c'.repeat(64)},
    report:{total:76.5,max:100,dimensions:{A:{label:'Skills and tools',score:38.5,max:50,problems:['Add an example that explains how you used research to inform a product decision.']},
      B:{label:'Relevant experience',score:19,max:25,problems:[]},C:{label:'Evidence of impact',score:9,max:15,problems:['Add measurable outcomes for your portfolio case studies.']},D:null,E:{label:'Clarity',score:10,max:10,problems:[]},F:null},
      problems:[],suggestions:['Use one concrete example of collaborating with engineers to ship a product.'],missingKeywords:['accessibility'],rubricVersion:'fixture-v1',measuredAt:'2026-09-13T12:00:00.000Z'}})!;
  const ports:CommercePorts={async execute(command,signal):Promise<AssistantCommerceResult>{
    if(signal.aborted)return {operation:command.operation,ok:false,code:'CANCELLED'};
    switch(command.operation){
      case 'USAGE':return {operation:command.operation,ok:true,value:{schemaVersion:1,usage:[usage('jobs.delivered'),usage('ats.report')]}};
      case 'JOBS_BATCHES':return {operation:command.operation,ok:true,value:{schemaVersion:1,batches:delivered?[]:[{id:batchId,generatedAt:'2026-09-13T00:00:00.000Z' as never,expiresAt:'2026-09-14T00:00:00.000Z' as never}]}};
      case 'JOBS_LIST':return {operation:command.operation,ok:true,value:{schemaVersion:1,entries:delivered&&(!command.query.state||command.query.state===entry.state)?[entry]:[],nextCursor:null,usage:usage('jobs.delivered')}};
      case 'JOBS_DELIVER':delivered=true;return {operation:command.operation,ok:true,value:{schemaVersion:1,entries:[entry],nextCursor:null,usage:usage('jobs.delivered')}};
      case 'JOB_DECIDE':if(command.request.expectedRevision!==entry.revision)return {operation:command.operation,ok:false,code:'REVISION_CONFLICT'};
        entry={...entry,state:command.request.state,revision:entry.revision+1};return {operation:command.operation,ok:true,value:{schemaVersion:1,entry}};
      case 'JOB_DETAIL':return {operation:command.operation,ok:true,value:{schemaVersion:1,item:{batchId:entry.batchId as never,itemId:entry.itemId as never,conversationId:entry.conversationId as never,job:entry.job,
        canonicalJobId:jobId as never,canonicalJobRevision:'1',listingGenerationKey:'fixture-g1',descriptionDigest:('sha256:'+'b'.repeat(64)) as never,
        description:'About the role\n\nHarbor Studio is a fictional team designing accessible products for growing communities.\n\nYou will lead discovery, design clear user experiences, and partner with engineering to deliver thoughtful products.\n\nWhat you bring\n• Product design and user research experience\n• A portfolio with clear evidence of impact\n• Care for accessibility and inclusive design'}}};
      case 'ATS_LOOKUP':return {operation:command.operation,ok:true,value:{schemaVersion:1,report:scored?report():null}};
      case 'ATS_START':scored=true;return {operation:command.operation,ok:true,value:report()};
      case 'ATS_GET':return {operation:command.operation,ok:true,value:report()};
      case 'RESUME_SELECTION':return {operation:command.operation,ok:true,value:{schemaVersion:1,libraryRevision:'1' as never,defaultResumeVersionId:parseUuid(COMMERCE_FIXTURE_RESUME),items:[{trackId,trackName:'Product Design',resumeVersionId:parseUuid(COMMERCE_FIXTURE_RESUME)!,label:'Product Design · v1',fileName:'design.pdf',mimeType:'application/pdf',fileSize:200,versionNumber:1,contentRevision:'1' as never,isDefault:true,createdAt:stamp,updatedAt:stamp}]}};
      case 'RESUME_LIBRARY':return {operation:command.operation,ok:true,value:{schemaVersion:1,libraryRevision:'1' as never,defaultTrackId:trackId,tracks:[{trackId,name:'Product Design',archivedAt:null,isDefault:true,currentVersionId:parseUuid(COMMERCE_FIXTURE_RESUME),hasMoreVersions:false,createdAt:stamp,updatedAt:stamp,versions:[]}]}};
      case 'PREPARATION_BATCH':return {operation:command.operation,ok:true,value:{schemaVersion:1,batch:{id:parseUuid(batchId)!,conversationId:parseUuid(COMMERCE_FIXTURE_ROLE)!,revision:'1' as never,status:'OPEN',localDate:'2026-09-13' as never,generatedAt:stamp,expiresAt:'2026-09-14T00:00:00.000Z' as never,updatedAt:stamp,items:[{id:parseUuid(entry.itemId)!,revision:'1' as never,status:'PENDING',job:entry.job,missionId:null,decidedAt:null}],counts:{total:1,pending:1,approved:0,skipped:0,unavailable:0}}}};
      case 'PREPARATION_START':case 'PREPARATION_RETRY':
        preparation={preparationId:parseUuid('10000000-0000-4000-8000-000000000002')!,itemId:parseUuid(entry.itemId)!,revision:'1' as never,status:'READY',failureCode:null,retryable:false,resumeVersionId:parseUuid(COMMERCE_FIXTURE_RESUME),missionId:parseUuid('10000000-0000-4000-8000-000000000003'),updatedAt:stamp};
        return {operation:command.operation,ok:true,value:{schemaVersion:1,batchId:parseUuid(batchId)!,conversationId:parseUuid(COMMERCE_FIXTURE_ROLE)!,items:[preparation]}};
      case 'PREPARATION_LIST':return {operation:command.operation,ok:true,value:{schemaVersion:1,batchId:parseUuid(batchId)!,conversationId:parseUuid(COMMERCE_FIXTURE_ROLE)!,items:preparation?[preparation]:[]}};
      case 'COVER_READ':return {operation:command.operation,ok:true,value:cover};
      case 'COVER_WRITE':
        if(command.request.expectedRevision!==cover.revision)return {operation:command.operation,ok:false,code:'REVISION_CONFLICT'};
        cover={schemaVersion:1,entryId,revision:cover.revision+1,draft:command.request.operation==='DELETE'?null:{id:'10000000-0000-4000-8000-000000000004',body:command.request.operation==='SAVE'?command.request.body:'Dear Harbor Studio team,\n\nI am interested in the Senior Product Designer role. I would welcome the opportunity to discuss my work in product design and research.\n\nThank you for your consideration.',origin:command.request.operation==='SAVE'?'USER_EDITED':'GENERATED',updatedAt:stamp,deliveryAuthorized:false}};
        return {operation:command.operation,ok:true,value:cover};
    }
  }};
  return {ports,entry:()=>entry,delivered:()=>delivered,scored:()=>scored};
}
