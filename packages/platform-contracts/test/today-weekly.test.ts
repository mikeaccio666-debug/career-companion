import test from 'node:test';
import assert from 'node:assert/strict';
import { todayWeekWindow, parseTodayWeeklyActivity } from '../src/today-weekly.ts';
const owner='11111111-1111-4111-8111-111111111111';
const value=()=>({...todayWeekWindow('2026-11-01T16:00:00.000Z','America/New_York'),ownerId:owner,companionId:owner,storiesEdited:2,resumesConfirmed:1,practiceQuestions:null,coverage:['retained_story_edits','retained_resume_approvals']});
test('local Monday boundaries survive DST, UTC crossover and year rollover',()=>{
 assert.equal(todayWeekWindow('2026-11-02T04:59:59.999Z','America/New_York').weekStart,'2026-10-26');
 assert.equal(todayWeekWindow('2026-11-02T05:00:00.000Z','America/New_York').weekStart,'2026-11-02');
 assert.equal(todayWeekWindow('2026-03-09T03:59:59.999Z','America/New_York').weekStart,'2026-03-02');
 assert.equal(todayWeekWindow('2026-03-09T04:00:00.000Z','America/New_York').weekStart,'2026-03-09');
 assert.equal(todayWeekWindow('2026-01-01T00:00:00.000Z','Pacific/Kiritimati').weekStart,'2025-12-29');
 const v=parseTodayWeeklyActivity(value());assert(Object.isFrozen(v));assert(Object.isFrozen(v.coverage));assert.equal(v.practiceQuestions,null);
});
test('invalid totals, unknown coverage and false practice zeros cannot become a weekly summary',()=>{
 for(const patch of [{storiesEdited:-1},{resumesConfirmed:-0},{storiesEdited:501},{storiesEdited:1.1},{practiceQuestions:0},{weekStart:'2026-11-01'},{localDate:'2026-11-02'},{timeZone:'Invalid/Zone'},{capturedAt:'yesterday'},{ownerId:'wrong'},{coverage:[]},{coverage:['retained_story_edits','all_materials']},{body:'private'}])
  assert.throws(()=>parseTodayWeeklyActivity({...value(),...patch}));
 let accessed=false;const coverage=['retained_story_edits','retained_resume_approvals'];Object.defineProperty(coverage,0,{get(){accessed=true;return 'retained_story_edits';}});
 assert.throws(()=>parseTodayWeeklyActivity({...value(),coverage}));assert.equal(accessed,false);
});
