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

const projectedTables=Object.freeze(['platform_users','platform_terms_consents','platform_sessions','platform_memories','platform_memory_operations','platform_memory_events','platform_memory_uses',...Object.keys(CAREER_EXPORT_TABLES),...Object.keys(RESUME_EXPORT_TABLES),...CONVERSATION_EXPORT_TABLES,...WELCOME_EXPORT_TABLES,...BIRTH_EXPORT_TABLES,...COMPANION_EXPORT_TABLES]);
type ArraySection='termsConsents'|'sessions'|'memories'|'memoryOperations'|'memoryEvents'|'memoryUses'|CareerExportSection|ResumeExportSection|ConversationExportSection|WelcomeExportSection|BirthExportSection|CompanionExportSection;
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
  private readonly memories:SharedMemories;
  private readonly welcomes:AccountWelcomeExport;
  private readonly companions:AccountCompanionExport;
  private readonly births:CompanionBirthOriginStore;
  private readonly maxBytes:number;
  private readonly careerReaders:readonly (CareerTargets|CareerStories|ManualJobs|CareerApplications|CareerInterviews|CareerIdentityRecords|ResumeOriginalReview)[];
  constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,limits:{maxBytes?:number}={}){
    this.memories=new SharedMemories(db,config,null);
    this.welcomes=new AccountWelcomeExport(config);
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
        companions:[],companionPaidSettingOperations:[],
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
      for(const reader of this.careerReaders)for await(const item of reader.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of exportConversationsInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.welcomes.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.births.exportInTransaction(client,who,signal))append(item.section,item.record);
      for await(const item of this.companions.exportInTransaction(client,who,signal))append(item.section,item.record);
      await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
      return freeze({schemaVersion:1 as const,scope:'account_core_export_sections' as const,complete:false as const,
        ownerId:who.userId,capturedAt,sections,
        includedTables:projectedTables,
        remainingTables:coverage.tables.filter(table=>table.exportStatus!=='excluded_nonpersonal'&&!projectedTables.includes(table.table)).map(table=>table.table),
        filesIncluded:false as const});
    },{timeoutMs:5000});}catch(error){
      if(signal?.aborted)throw new ApiError(499,'ACCOUNT_EXPORT_CANCELLED','The private export was cancelled.');
      if(error instanceof ApiError)throw error;throw unavailable();
    }
  }
}
