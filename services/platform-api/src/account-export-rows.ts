import type { PoolClient } from 'pg';
import { careerRecordId } from '@companion/platform-contracts';
import { ApiError } from './errors.ts';

/** Reviewed internal identifiers, never supplied by an HTTP caller or model. */
export const CAREER_EXPORT_TABLES = Object.freeze({
  platform_career_targets: Object.freeze({key:'id',section:'careerTargets'} as const),
  platform_career_target_operations: Object.freeze({key:'operation_id',section:'careerTargetOperations'} as const),
  platform_career_evidence: Object.freeze({key:'id',section:'careerProjects'} as const),
  platform_career_stories: Object.freeze({key:'id',section:'careerStories'} as const),
  platform_career_library_operations: Object.freeze({key:'operation_id',section:'careerLibraryOperations'} as const),
  platform_career_job_observations: Object.freeze({key:'id',section:'savedJobs'} as const),
  platform_career_job_observation_operations: Object.freeze({key:'operation_id',section:'savedJobOperations'} as const),
  platform_career_applications: Object.freeze({key:'id',section:'careerApplications'} as const),
  platform_career_application_operations: Object.freeze({key:'operation_id',section:'careerApplicationOperations'} as const),
  platform_career_application_events: Object.freeze({key:'id',section:'careerApplicationEvents'} as const),
  platform_career_interviews: Object.freeze({key:'id',section:'careerInterviews'} as const),
  platform_career_interview_operations: Object.freeze({key:'operation_id',section:'careerInterviewOperations'} as const),
  platform_career_identity_dates: Object.freeze({key:'id',section:'careerIdentity'} as const),
  platform_career_identity_operations: Object.freeze({key:'operation_id',section:'careerIdentityOperations'} as const),
});
export type CareerExportSection = typeof CAREER_EXPORT_TABLES[keyof typeof CAREER_EXPORT_TABLES]['section'];

/** Raw rows stay inside authenticated domain readers, which must decode and
 * validate before yielding explicit projections to the export coordinator. */
export async function* accountExportRows(client:PoolClient,ownerId:string,table:keyof typeof CAREER_EXPORT_TABLES,signal?:AbortSignal){
  const owner=careerRecordId(ownerId);
  if(!Object.hasOwn(CAREER_EXPORT_TABLES,table))throw new ApiError(503,'ACCOUNT_EXPORT_TABLE_UNREVIEWED','The export table has not been reviewed.');
  const {key}=CAREER_EXPORT_TABLES[table];let after:string|null=null;
  for(;;){
    signal?.throwIfAborted();
    const rows:Record<string,any>[]=(await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND ($2::uuid IS NULL OR ${key}>$2) ORDER BY ${key} LIMIT 100`,[owner,after])).rows;
    for(const row of rows){signal?.throwIfAborted();yield row;}
    if(rows.length<100)break;after=careerRecordId(rows.at(-1)![key]);
  }
}
