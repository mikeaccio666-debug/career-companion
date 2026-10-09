import { parseTodayWeeklyActivity, todayWeekWindow, careerRecordObject, careerRecordId } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { CompanionDailySettingsService } from './companion-daily-settings.ts';
import type { CareerStories } from './career-stories.ts';
import type { ResumeOriginalReview } from './resume-original-review.ts';
import { ApiError } from './errors.ts';
interface Ports {
 settings:Pick<CompanionDailySettingsService,'readForPolicyInTransaction'>;
 stories:Pick<CareerStories,'readWeeklyEditsInTransaction'>;
 resumes:Pick<ResumeOriginalReview,'readWeeklyApprovalsInTransaction'>;
}
/** Private read model, never a proactive message or skill/completion claim. */
export class TodayWeeklyService{
 constructor(private readonly db:Database,private readonly ports:Ports){}
 async read(value:FixedSessionContext,signal?:AbortSignal){
  let who:FixedSessionContext;
  try{const r=careerRecordObject(value,['userId','tokenHash']);if(typeof r.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(r.tokenHash))throw Error();
   who=Object.freeze({userId:careerRecordId(r.userId),tokenHash:r.tokenHash});}
  catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
  return this.db.withBoundedTransaction(async c=>{
   const settings=await this.ports.settings.readForPolicyInTransaction(c,who,signal);
   if(!settings.preferences)throw new ApiError(409,'DAILY_SETTINGS_REQUIRED','Choose your time zone first.');
   const at=(await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
   const window=todayWeekWindow(at,settings.preferences.timeZone);
   const stories=await this.ports.stories.readWeeklyEditsInTransaction(c,who,window,signal);
   const resumes=await this.ports.resumes.readWeeklyApprovalsInTransaction(c,who,window,signal);
   if([settings,stories,resumes].some(r=>r.ownerId!==who.userId))throw new ApiError(503,'TODAY_WEEKLY_UNAVAILABLE','The owned weekly records could not be confirmed.');
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
   return parseTodayWeeklyActivity({...window,ownerId:who.userId,companionId:settings.companionId,
    storiesEdited:stories.count,resumesConfirmed:resumes.count,practiceQuestions:null,
    coverage:['retained_story_edits','retained_resume_approvals']});
  });
 }
}
