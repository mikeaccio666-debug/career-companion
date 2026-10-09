import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { TodayWeeklyService } from '../src/today-weekly.ts';
import { CareerStories } from '../src/career-stories.ts';
import { CompanionDailySettingsService } from '../src/companion-daily-settings.ts';
import { TodayRestService } from '../src/today-rest.ts';
import { ManualJobs } from '../src/manual-jobs.ts';
import { CareerApplications } from '../src/career-applications.ts';
import { CareerInterviews } from '../src/career-interviews.ts';
import { ResumeOriginalReview } from '../src/resume-original-review.ts';
import { ApiError } from '../src/errors.ts';
import type { FixedSessionContext } from '../src/auth.ts';
let f: PrebirthFixture, settings: CompanionDailySettingsService, rest: TodayRestService, jobs: ManualJobs,
  applications: CareerApplications, interviews: CareerInterviews, resumes: ResumeOriginalReview, weekly: TodayWeeklyService, stories: CareerStories;
const operation = (expectedRevision = 0) => ({ operationId: randomUUID(), expectedRevision });
const prefs = { timeZone: 'America/New_York', morningTime: '09:00', quietStart: '22:30', quietEnd: '08:30', dailyMinutes: 90, webAlert: 'none' as const };
const denied = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
before(async () => {
  f = await createPrebirthFixture(); settings = new CompanionDailySettingsService(f.db, f.config, FICTIONAL_LEGAL);
  rest = new TodayRestService(f.db, f.config, FICTIONAL_LEGAL); jobs = new ManualJobs(f.db, f.config, FICTIONAL_LEGAL);
  applications = new CareerApplications(f.db, f.config, FICTIONAL_LEGAL, jobs);
  interviews = new CareerInterviews(f.db, f.config, FICTIONAL_LEGAL, applications); resumes = new ResumeOriginalReview(f.db, f.config, FICTIONAL_LEGAL);
  stories = new CareerStories(f.db,f.config,FICTIONAL_LEGAL); weekly = new TodayWeeklyService(f.db, { settings, stories, resumes });
});
after(async () => { await f?.close(); });
async function born(save = true) {
  let who!: FixedSessionContext;
  await withPrebirthLoopback(async runtime => { const b = await readyBirth(f, runtime); who = b.ready.who; await b.service.birth(who, b.body, b.key); });
  if (save) await settings.change(who, { ...operation(), companionId: (await settings.read(who)).settings.companionId, preferences: prefs });
  return who;
}
async function resume(who: FixedSessionContext, track: 'da' | 'ds' = 'da') { return (await resumes.mutate(who, 'create', null, { ...operation(), track, label: 'PRIVATE_FICTIONAL_RESUME_LABEL', text: 'PRIVATE_FICTIONAL_RESUME_BODY' }, 'web')).view!; }
async function clock(at: string, run: () => Promise<void>) {
  const original = f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction = async (fn, options) => original(c => fn(new Proxy(c, { get(target, key) {
    if (key === 'query') return async (sql: any, ...args: any[]) => sql === 'SELECT clock_timestamp() at'
      ? { rows: [{ at: new Date(at) }] } : (target.query as any)(sql, ...args);
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
  } })), options);
  try { await run(); } finally { f.db.withBoundedTransaction = original; }
}

const storyFields=(patch:Record<string,unknown>={})=>({...operation(),title:'PRIVATE_FICTIONAL_STORY',experienceKind:'course_project',sensitivity:'sensitive',
 english:{situation:'Fictional class',task:'Compare sources',action:'I compared them',result:'Feedback'},
 chinese:{situation:'虚构课程',task:'虚构任务',action:'虚构行动',result:'虚构反馈'},tags:[],projects:[],...patch});
async function edited(who:FixedSessionContext){
 const s=(await stories.mutate(who,'story','create',null,storyFields())).record!;
 return (await stories.mutate(who,'story','edit',s.id,storyFields({expectedRevision:1,title:'PRIVATE_FICTIONAL_EDIT'}))).record!;
}
async function approved(who:FixedSessionContext){
 const r=await resume(who);
 return (await resumes.mutate(who,'approve',r.item.id,{...operation(r.item.revision),payloadDigest:r.item.payloadDigest},'web')).view!;
}
test('actual edit and approval receipts count retained objects once, with truthful unconnected practice and no private content',async()=>{
 const who=await born(),other=await born();const empty=await weekly.read(who);
 assert.equal(empty.storiesEdited,0);assert.equal(empty.resumesConfirmed,0);assert.equal(empty.practiceQuestions,null);
 const s=await edited(who);await stories.mutate(who,'story','edit',s.id,storyFields({expectedRevision:2}));
 await stories.mutate(who,'story','confirm',s.id,operation(3));
 await stories.mutate(who,'story','create',null,storyFields());await edited(other);await approved(other);
 const r=await approved(who),v=await weekly.read(who);
 assert.equal(v.storiesEdited,1);assert.equal(v.resumesConfirmed,1);assert.equal(v.practiceQuestions,null);
 for(const text of ['PRIVATE_FICTIONAL',who.tokenHash,s.id,r.item.id,'ciphertext','acceptedAuthVersion'])assert(!JSON.stringify(v).includes(text));
 await stories.mutate(who,'story','delete',s.id,operation(4));
 await resumes.mutate(who,'delete',r.item.id,{...operation(r.item.revision),payloadDigest:r.item.payloadDigest},'web');
 const after=await weekly.read(who);assert.equal(after.storiesEdited,0);assert.equal(after.resumesConfirmed,0);
});
test('local week uses event time across DST; later confirmation is not a story edit and later changes do not erase an approval',async()=>{
 const who=await born();let s:any,r:any;
 await clock('2026-11-02T04:59:59.999Z',async()=>{s=await edited(who);r=await approved(who);const v=await weekly.read(who);assert.equal(v.weekStart,'2026-10-26');assert.equal(v.storiesEdited,1);assert.equal(v.resumesConfirmed,1);});
 await clock('2026-11-02T05:00:00.000Z',async()=>{
  await stories.mutate(who,'story','confirm',s.id,operation(s.revision));
  let v=await weekly.read(who);assert.equal(v.weekStart,'2026-11-02');assert.equal(v.storiesEdited,0);assert.equal(v.resumesConfirmed,0);
  const second=await approved(who);await resumes.mutate(who,'archive',second.item.id,{...operation(second.item.revision),payloadDigest:second.item.payloadDigest},'web');
  v=await weekly.read(who);assert.equal(v.resumesConfirmed,1);
 });
});
test('full source sets cross list pages; foreign sessions and revoked admission cannot receive counts',async()=>{
 const who=await born(),other=await born();
 for(let n=0;n<55;n++)await edited(who);
 assert.equal((await weekly.read(who)).storiesEdited,55);assert.equal((await weekly.read(other)).storiesEdited,0);
 await assert.rejects(weekly.read({userId:who.userId,tokenHash:other.tokenHash}),denied(401));
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await assert.rejects(weekly.read(who),denied(403));
 await assert.rejects(weekly.read(await born(false)),denied(409));await assert.rejects(weekly.read(await f.actor(true)),denied(403));
});
test('damaged current records and approval decisions fail the whole summary instead of producing partial totals',async()=>{
 const who=await born(),s=await edited(who);await approved(who);
 await f.db.query('UPDATE platform_career_stories SET record_ciphertext=$2 WHERE id=$1',[s.id,Buffer.alloc(100,1)]);
 await assert.rejects(weekly.read(who),denied(503));
 const other=await born(),r=await approved(other);
 // Corrupt only the isolated fixture, restoring the immutable trigger before reading.
 await f.db.withBoundedTransaction(async c=>{
  await c.query('ALTER TABLE platform_pending_item_decisions DISABLE TRIGGER pending_decision_immutable');
  await c.query("UPDATE platform_pending_item_decisions SET payload_digest=$2 WHERE item_id=$1",[r.item.id,'a'.repeat(64)]);
  await c.query('ALTER TABLE platform_pending_item_decisions ENABLE TRIGGER pending_decision_immutable');
 });
 await assert.rejects(weekly.read(other),denied(503));
});
test('late session revocation and cancellation never release stale counts',async()=>{
 const who=await born();await edited(who);
 const original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(c=>run(new Proxy(c,{get(target,key){
  if(key==='query')return async(sql:any,...args:any[])=>{const result=await (target.query as any)(sql,...args);
   if(typeof sql==='string'&&sql.includes('SELECT o.*,d.revision,d.payload_digest'))await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);
   return result;};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }})),options);
 try{await assert.rejects(weekly.read(who),denied(401));}finally{f.db.withBoundedTransaction=original;}
 await assert.rejects(weekly.read(await born(),AbortSignal.abort()));
});

test('reconfirmation has no second decision and never creates another weekly accomplishment',async()=>{
 const who=await born();let first:any;
 await clock('2026-11-02T04:50:00.000Z',async()=>{
  first=await approved(who);
  const repeat={...operation(first.item.revision),payloadDigest:first.item.payloadDigest};
  const again=(await resumes.mutate(who,'approve',first.item.id,repeat,'web')).view!;
  assert.equal(again.item.approvalOperationId,first.item.approvalOperationId);
  assert.equal((await f.db.query('SELECT * FROM platform_pending_item_decisions WHERE item_id=$1',[first.item.id])).rowCount,1);
  assert.equal((await f.db.query("SELECT * FROM platform_pending_item_operations WHERE item_id=$1 AND action='approve'",[first.item.id])).rowCount,2);
  assert.equal((await weekly.read(who)).resumesConfirmed,1);
  await resumes.mutate(who,'approve',first.item.id,repeat,'web');
  assert.equal((await weekly.read(who)).resumesConfirmed,1);
 });
 await clock('2026-11-02T05:10:00.000Z',async()=>{
  await resumes.mutate(who,'approve',first.item.id,{...operation(first.item.revision),payloadDigest:first.item.payloadDigest},'web');
  assert.equal((await weekly.read(who)).resumesConfirmed,0,'A new-week acknowledgement is not a new confirmed original.');
  await resumes.mutate(who,'archive',first.item.id,{...operation(first.item.revision),payloadDigest:first.item.payloadDigest},'web');
  await resumes.mutate(who,'approve',first.item.id,{...operation(first.item.revision),payloadDigest:first.item.payloadDigest},'web');
  assert.equal((await weekly.read(who)).resumesConfirmed,0);
  await approved(who);
  assert.equal((await weekly.read(who)).resumesConfirmed,1);
 });
});

test('a missing first approval decision is still corruption, even when a later acknowledgement exists',async()=>{
 const who=await born(),first=await approved(who);
 await resumes.mutate(who,'approve',first.item.id,{...operation(first.item.revision),payloadDigest:first.item.payloadDigest},'web');
 await f.db.withBoundedTransaction(async c=>{
  await c.query('ALTER TABLE platform_pending_item_decisions DISABLE TRIGGER pending_decision_immutable');
  await c.query('DELETE FROM platform_pending_item_decisions WHERE item_id=$1',[first.item.id]);
  await c.query('ALTER TABLE platform_pending_item_decisions ENABLE TRIGGER pending_decision_immutable');
 });
 await assert.rejects(weekly.read(who),denied(503));
});
