import {exportModelAuditInTransaction,MODEL_AUDIT_EXPORT_TABLES,type ModelAuditExportSection} from './account-model-audit-export.ts';
import {AccountMemorySafetyExport,MEMORY_SAFETY_EXPORT_TABLES,type MemorySafetyExportSection} from './account-memory-safety-export.ts';
import {DailyPlans} from './daily-plans.ts';
import {TodayRestService} from './today-rest.ts';
import {CompanionDailySettingsService} from './companion-daily-settings.ts';
import {exportExecutionInTransaction,EXECUTION_EXPORT_TABLES,type ExecutionExportSection} from './account-execution-export.ts';
import {exportTasksInTransaction,TASK_EXPORT_TABLES,type TaskExportSection} from './account-task-export.ts';
import {AccountUploadJournalExport,UPLOAD_JOURNAL_EXPORT_TABLES,type UploadJournalExportSection} from './account-upload-journal-export.ts';
import type {AccountFileCapture,AccountFileSection,ArchiveFile} from './account-file-capture.ts';
import {AccountMentorExport,MENTOR_EXPORT_TABLES,type MentorExportSection} from './account-mentor-export.ts';
import {exportPlansInTransaction,PLAN_EXPORT_TABLES,type PlanExportSection} from './account-plan-export.ts';
import {exportMcpInTransaction,MCP_EXPORT_TABLES,type McpExportSection} from './account-mcp-export.ts';
import {exportPrivateKnowledgeInTransaction,PRIVATE_KNOWLEDGE_EXPORT_TABLES,type PrivateKnowledgeExportSection} from './account-private-knowledge-export.ts';
import {exportVoiceUsageInTransaction,VOICE_USAGE_EXPORT_TABLES,type VoiceUsageExportSection} from './account-voice-usage-export.ts';
import {exportSecurityInTransaction,SECURITY_EXPORT_TABLES,type SecurityExportSection} from './account-security-export.ts';
import {exportCostsInTransaction,COST_EXPORT_TABLES,type CostExportSection} from './account-cost-export.ts';
import {AccountOnboardingExport,ONBOARDING_EXPORT_TABLES,type OnboardingExportSection} from './account-onboarding-export.ts';
import {AccountCompanionGenerationExport,COMPANION_GENERATION_EXPORT_TABLES,type CompanionGenerationExportSection} from './account-companion-generation-export.ts';
import {AccountCompanionExport,COMPANION_EXPORT_TABLES,type CompanionExportSection} from './account-companion-export.ts';
import {CompanionBirthOriginStore,BIRTH_EXPORT_TABLES,type BirthExportSection} from './companion-birth-origin-store.ts';
import {AccountWelcomeExport,WELCOME_EXPORT_TABLES,type WelcomeExportSection} from './account-welcome-export.ts';
import {exportConversationsInTransaction,CONVERSATION_EXPORT_TABLES,type ConversationExportSection} from './account-conversation-export.ts';
import { ResumeOriginalReview,RESUME_EXPORT_TABLES,type ResumeExportSection } from './resume-original-review.ts';
import { CAREER_EXPORT_TABLES,type CareerExportSection } from './account-export-rows.ts';
import { CareerTargets } from './career-targets.ts';
import { CareerStories } from './career-stories.ts';
import { ManualJobs } from './manual-jobs.ts';
import { CareerApplications } from './career-applications.ts';
import { CareerInterviews } from './career-interviews.ts';
import { CareerIdentityRecords } from './career-identity.ts';
import { careerRecordId,careerRecordObject } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import { AccountReauthentication } from './account-reauthentication.ts';
import { auditAccountDataCoverage,readAccountSchemaInventory } from './account-data-coverage.ts';
import { SharedMemories } from './shared-memories.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';

const projectedTables=Object.freeze(['platform_daily_plans','platform_daily_plan_items','platform_daily_plan_operations','platform_today_rest','platform_companion_daily_settings','platform_users','platform_terms_consents','platform_sessions','platform_memories','platform_memory_operations','platform_memory_events','platform_memory_uses',...Object.keys(CAREER_EXPORT_TABLES),...Object.keys(RESUME_EXPORT_TABLES),...CONVERSATION_EXPORT_TABLES,...WELCOME_EXPORT_TABLES,...BIRTH_EXPORT_TABLES,...COMPANION_EXPORT_TABLES,...COMPANION_GENERATION_EXPORT_TABLES,...ONBOARDING_EXPORT_TABLES,...COST_EXPORT_TABLES,...SECURITY_EXPORT_TABLES,...VOICE_USAGE_EXPORT_TABLES,...PRIVATE_KNOWLEDGE_EXPORT_TABLES,...MCP_EXPORT_TABLES,...PLAN_EXPORT_TABLES,...MENTOR_EXPORT_TABLES,...UPLOAD_JOURNAL_EXPORT_TABLES,...TASK_EXPORT_TABLES,...EXECUTION_EXPORT_TABLES,...MEMORY_SAFETY_EXPORT_TABLES,...MODEL_AUDIT_EXPORT_TABLES]);
type ArraySection='dailyPlans'|'dailyPlanHistory'|'todayRest'|'companionDailySettings'|'termsConsents'|'sessions'|'memories'|'memoryOperations'|'memoryEvents'|'memoryUses'|CareerExportSection|ResumeExportSection|ConversationExportSection|WelcomeExportSection|BirthExportSection|CompanionExportSection|CompanionGenerationExportSection|OnboardingExportSection|CostExportSection|SecurityExportSection|VoiceUsageExportSection|PrivateKnowledgeExportSection|McpExportSection|PlanExportSection|MentorExportSection|AccountFileSection|UploadJournalExportSection|TaskExportSection|ExecutionExportSection|MemorySafetyExportSection|ModelAuditExportSection;
const unavailable=()=>new ApiError(503,'ACCOUNT_EXPORT_UNAVAILABLE','The private export could not be confirmed. Try again.');
const tooLarge=()=>new ApiError(503,'ACCOUNT_EXPORT_TOO_LARGE','This export requires the archive worker. No partial export was returned.');
function fixed(value:FixedSessionContext):Readonly<FixedSessionContext>{
  try{const row=careerRecordObject(value,['userId','tokenHash']);
    if(typeof row.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(row.tokenHash))throw unavailable();
    return Object.freeze({userId:careerRecordId(row.userId),tokenHash:row.tokenHash});
  }catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
function freeze<T>(value:T):T{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
/** Partial internal archive input, not a complete export or a download endpoint.
 * No consumer sees the returned private sections before COMMIT succeeds. */
export class AccountCoreExport {
  private readonly dailyPlans:DailyPlans;
  private readonly rest:TodayRestService;
  private readonly dailySettings:CompanionDailySettingsService;
  private readonly uploadJournals:AccountUploadJournalExport;
  private readonly fileCapture:AccountFileCapture|undefined;
  private readonly mentors:AccountMentorExport;
  private readonly memories:SharedMemories;
  private readonly memorySafety:AccountMemorySafetyExport;
  private readonly welcomes:AccountWelcomeExport;
  private readonly onboarding:AccountOnboardingExport;
  private readonly generations:AccountCompanionGenerationExport;
  private readonly companions:AccountCompanionExport;
  private readonly births:CompanionBirthOriginStore;
  private readonly maxBytes:number;
  private readonly careerReaders:readonly (CareerTargets|CareerStories|ManualJobs|CareerApplications|CareerInterviews|CareerIdentityRecords|ResumeOriginalReview)[];
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,limits:{maxBytes?:number;fileCapture?:AccountFileCapture}={}){
    this.dailyPlans=new DailyPlans(db,config,null);
    this.rest=new TodayRestService(db,config,null);
    this.dailySettings=new CompanionDailySettingsService(db,config,null);
    this.uploadJournals=new AccountUploadJournalExport(config);
    this.fileCapture=limits.fileCapture;
    this.mentors=new AccountMentorExport(config);
    this.memories=new SharedMemories(db,config,null);
    this.memorySafety=new AccountMemorySafetyExport(config);
    this.welcomes=new AccountWelcomeExport(config);
    this.onboarding=new AccountOnboardingExport(config);
    this.generations=new AccountCompanionGenerationExport(config);
    this.companions=new AccountCompanionExport(config);
    this.births=new CompanionBirthOriginStore(config.dataCrypto);
    const jobs=new ManualJobs(db,config,null),applications=new CareerApplications(db,config,null,jobs);
    this.careerReaders=Object.freeze([new CareerTargets(db,config,null),new CareerStories(db,config,null),jobs,applications,
      new CareerInterviews(db,config,null,applications),new CareerIdentityRecords(db,config,null),new ResumeOriginalReview(db,config,null)]);
    this.maxBytes=limits.maxBytes??16*1024*1024;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024||this.maxBytes>16*1024*1024)throw unavailable();
  }
  async capture(context:FixedSessionContext,proof:string,signal?:AbortSignal){
    const who=fixed(context);
    try{return await this.db.withBoundedTransaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await new AccountReauthentication(this.db).consumeInTransaction(client,who,'account_export',proof,signal);
      const coverage=auditAccountDataCoverage(await readAccountSchemaInventory(client));
      if(coverage.schemaStatus!=='reviewed')throw new ApiError(503,'ACCOUNT_EXPORT_SCHEMA_UNREVIEWED','The data coverage must be reviewed before exporting.');
      const account=(await client.query(`SELECT id,email,name,account_kind AS "accountKind",created_at AS "createdAt",
        email_verified_at AS "emailVerifiedAt" FROM platform_users WHERE id=$1`,[who.userId])).rows[0];
      if(account?.accountKind!=='student')throw new ApiError(403,'STUDENT_ACCOUNT_REQUIRED','Use a student account.');
      const capturedAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
      const sections:{account:Record<string,unknown>}&Record<ArraySection,unknown[]>={
        account:{...account,createdAt:account.createdAt.toISOString(),emailVerifiedAt:account.emailVerifiedAt?.toISOString()??null},
        uploads:[],artifacts:[],privateFiles:[],memorySafetySources:[],memorySafetyBlocks:[],
        workflowTemplates:[],workflowCheckpoints:[],workflowStepEvents:[],browserCheckpoints:[],browserActionEvents:[],
        jobs:[],jobApprovals:[],jobAttempts:[],jobDispatches:[],conversationTasks:[],jobOutcomeReviews:[],
        uploadWrites:[],uploadWriteEvents:[],uploadRemovals:[],uploadRemovalEvents:[],
        mentorSessions:[],mentorIntentOperations:[],mentorRatings:[],
        mentorOrders:[],mentorOrderOperations:[],mentorSlotReservations:[],mentorReservationOperations:[],mentorFinancialRecords:[],mentorFinancialOperations:[],
        goalPlans:[],goalPlanRevisions:[],goalPlanSteps:[],goalPlanProposals:[],
        mcpConnections:[],mcpReceipts:[],
        privateKnowledgeSources:[],privateKnowledgePassages:[],
        voiceSessions:[],voiceRecords:[],legacyUsage:[],safetyModelUsage:[],modelRelayRequests:[],
        accountActions:[],accountEmailDeliveries:[],accountActionLimits:[],accountReauthentications:[],requestLimits:[],runtimeLeases:[],invitations:[],
        costPolicies:[],costReservations:[],costLedger:[],
        onboardingDrafts:[],onboardingOperations:[],onboardingSafetySubmissions:[],
        companionSourceManifests:[],companionGenerationRequests:[],companionGenerationOutbox:[],companionGenerationCheckpoints:[],
        companionAnswers:[],companionGenerationTasks:[],companionRevisions:[],companionGenerationCalls:[],companionOutputBlocks:[],
        dailyPlans:[],dailyPlanHistory:[],todayRest:[],companionDailySettings:[],companions:[],companionPaidSettingOperations:[],
        companionBirthReceipts:[],companionBirthAssetMetadata:[],
        conversations:[],messages:[],chatCalls:[],audioTranscriptions:[],companionWelcomes:[],companionWelcomeOperations:[],
        termsConsents:[],sessions:[],memories:[],memoryOperations:[],memoryEvents:[],memoryUses:[],
        careerTargets:[],careerTargetOperations:[],careerProjects:[],careerStories:[],careerLibraryOperations:[],
        savedJobs:[],savedJobOperations:[],careerApplications:[],careerApplicationOperations:[],careerApplicationEvents:[],
        careerInterviews:[],careerInterviewOperations:[],careerIdentity:[],careerIdentityOperations:[],
        pendingItems:[],pendingItemRevisions:[],pendingItemDecisions:[],pendingItemOperations:[],careerResumes:[],careerResumeCounters:[],
      };
      let bytes=Buffer.byteLength(JSON.stringify(sections));
      const append=(section:Exclude<keyof typeof sections,'account'>,record:unknown)=>{
        signal?.throwIfAborted();bytes+=Buffer.byteLength(JSON.stringify(record))+1;
        if(bytes>this.maxBytes)throw tooLarge();
        sections[section].push(record);
      };
      if(bytes>this.maxBytes)throw tooLarge();
      let consentAfter:readonly[string,string]|null=null;
      for(;;){
        const rows:{version:string;contentDigest:string;consentedAt:Date}[]=(await client.query(`SELECT terms_version AS version,content_digest AS "contentDigest",consented_at AS "consentedAt"
          FROM platform_terms_consents WHERE user_id=$1 AND ($2::text IS NULL OR (terms_version,content_digest)>($2::text,$3::text))
          ORDER BY terms_version,content_digest LIMIT 100`,[who.userId,consentAfter?.[0]??null,consentAfter?.[1]??null])).rows;
        for(const row of rows)append('termsConsents',{...row,consentedAt:row.consentedAt.toISOString()});
        if(rows.length<100)break;consentAfter=[rows.at(-1)!.version,rows.at(-1)!.contentDigest];
      }
      let after:string|null=null;
      for(;;){
        const rows:{token_hash:string;created_at:Date;expires_at:Date}[]=(await client.query(`SELECT token_hash,created_at,expires_at FROM platform_sessions
          WHERE user_id=$1 AND ($2::text IS NULL OR token_hash>$2) ORDER BY token_hash LIMIT 100`,[who.userId,after])).rows;
        for(const row of rows)append('sessions',{createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),current:row.token_hash===who.tokenHash});
        if(rows.length<100)break;after=rows.at(-1)!.token_hash;
      }
      for await(const item of this.memories.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.memorySafety.exportInTransaction(client,who,signal))append(item.section,item.record);
      for(const reader of this.careerReaders)for await(const item of reader.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportConversationsInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.welcomes.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.births.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.dailyPlans.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.rest.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.dailySettings.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.companions.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.generations.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.onboarding.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportCostsInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportSecurityInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportVoiceUsageInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportModelAuditInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportPrivateKnowledgeInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportMcpInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportPlansInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.mentors.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.uploadJournals.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportTasksInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportExecutionInTransaction(client,who,signal))append(item.section,item.record);
      if(this.fileCapture){
        for(const item of await this.fileCapture.captureInTransaction(client,who,signal))append(item.section,item.record);
        const files=sections.privateFiles as ArchiveFile[];
        sections.companionBirthAssetMetadata=sections.companionBirthAssetMetadata.map(value=>{
          const record=value as {id:string;svgDigest:string;pngDigest:string;svgSizeBytes:number;pngSizeBytes:number};
          for(const format of ['svg','png'] as const){const file=files.find(f=>f.source==='companion_birth_'+format&&f.sourceId===record.id);
            if(!file||file.sha256!==record[format==='svg'?'svgDigest':'pngDigest']||file.size!==record[format==='svg'?'svgSizeBytes':'pngSizeBytes'])throw unavailable();}
          return {...record,bytesIncluded:true};
        });
        if(files.filter(f=>f.source!=='upload').length!==sections.companionBirthAssetMetadata.length*2)throw unavailable();
      }
      await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
      const includedTables=this.fileCapture?Object.freeze([...projectedTables,...this.fileCapture.tables]):projectedTables;
      const result=freeze({schemaVersion:1 as const,scope:'account_core_export_sections' as const,complete:false as const,
        ownerId:who.userId,capturedAt,sections,
        includedTables,
        exclusions:coverage.tables.filter(table=>table.exportStatus==='excluded_nonpersonal'||table.exportStatus==='excluded_product_policy')
          .map(table=>({table:table.table,status:table.exportStatus,reason:table.reason,policyReference:table.policyReference})),
        remainingTables:coverage.tables.filter(table=>table.exportStatus==='blocked_projection_required'&&!includedTables.includes(table.table)).map(table=>table.table),
        filesIncluded:Boolean(this.fileCapture)});
      if(this.fileCapture)await this.fileCapture.finish(result,signal);
      await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();return result;
    },{timeoutMs:5000});}catch(error){
      if(signal?.aborted)throw new ApiError(499,'ACCOUNT_EXPORT_CANCELLED','The private export was cancelled.');
      if(error instanceof ApiError)throw error;throw unavailable();
    }
  }
}
