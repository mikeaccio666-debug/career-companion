import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyJobDeadline,jobDeadlineFields,resolveJobDeadline} from '../src/manual-job-deadline.ts';
import {displayZonedTime} from '../src/zoned-date-time.ts';
test('optional deadline is empty only when both time and zone are absent',()=>{
 assert.deepEqual(jobDeadlineFields(emptyJobDeadline()),{deadlineAt:null,deadlineTimeZone:null});
 for(const value of [{localTime:'2026-10-09T23:59',timeZone:''},{localTime:'',timeZone:'America/Los_Angeles'}]){
  assert.equal(resolveJobDeadline({...value,selectedInstant:''}).savable,false);
  assert.throws(()=>jobDeadlineFields({...value,selectedInstant:''}));
 }
});
test('a west-coast deadline saves its exact next-day instant and original zone',()=>{
 const value={localTime:'2026-10-09T23:59',timeZone:'America/Los_Angeles',selectedInstant:''};
 assert.deepEqual(jobDeadlineFields(value),{deadlineAt:'2026-10-10T06:59:00.000Z',deadlineTimeZone:'America/Los_Angeles'});
 assert.match(displayZonedTime('2026-10-10T06:59:00.000Z','America/Los_Angeles'),/2026-10-09 23:59.*UTC-07:00/);
 assert.match(displayZonedTime('2026-10-10T06:59:00.000Z','UTC'),/2026-10-10 06:59.*UTC\+00:00/);
});
test('overlap requires explicit selection; changing a time or zone cannot carry an old choice',()=>{
 const draft={localTime:'2026-11-01T01:30',timeZone:'America/New_York',selectedInstant:''};
 assert.equal(resolveJobDeadline(draft).savable,false);assert.throws(()=>jobDeadlineFields(draft));
 for(const selectedInstant of ['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']){
  assert.equal(jobDeadlineFields({...draft,selectedInstant}).deadlineAt,selectedInstant);
  assert.throws(()=>jobDeadlineFields({...draft,localTime:'2026-11-01T02:30',selectedInstant}));
  assert.throws(()=>jobDeadlineFields({...draft,timeZone:'UTC',selectedInstant}));
 }
});
test('gap, invalid date and zone are rejected rather than moved or guessed',()=>{
 for(const [localTime,timeZone] of [['2026-03-08T02:30','America/New_York'],['2026-10-04T02:15','Australia/Lord_Howe'],
  ['2026-02-29T12:00','UTC'],['2026-10-09T12:00','PT'],['2026-10-09T12:00','Invalid/Fictional']]){
  assert.throws(()=>jobDeadlineFields({localTime,timeZone,selectedInstant:''}));
 }
});
test('saved conversion is independent of the device timezone',()=>{
 const old=process.env.TZ;try{
  for(const zone of ['UTC','Asia/Shanghai','America/Los_Angeles']){
   process.env.TZ=zone;
   assert.equal(jobDeadlineFields({localTime:'2026-10-09T12:00',timeZone:'Asia/Shanghai',selectedInstant:''}).deadlineAt,'2026-10-09T04:00:00.000Z');
  }
 }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
