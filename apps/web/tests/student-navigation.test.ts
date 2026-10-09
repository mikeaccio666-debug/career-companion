import assert from 'node:assert/strict';
import test from 'node:test';
import {studentRoute} from '../src/app/student-route.ts';
import {studentSection,studentPageTitle,STUDENT_NAVIGATION} from '../src/app/student-navigation.ts';
test('student subpages retain their parent section and explicit title without inferring from user data',()=>{
 for(const [url,section,title] of [
  ['/today','today','今天'],['/journey','journey','旅程'],['/journey/jobs','journey','收藏的岗位'],
  ['/journey/stories/11111111-1111-4111-8111-111111111111','journey','项目与故事'],
  ['/pending/11111111-1111-4111-8111-111111111111','pending','待确认'],
  ['/me/memory','me','它记得的你'],['/community/mentors','me','蔓藤导师'],
  ['/journey/interviews/not-an-id','journey','查看记录'],
 ]){
  const route=studentRoute(url);assert(route);assert.equal(studentSection(route),section);assert.equal(studentPageTitle(route),title);
 }
 const source=studentRoute('/sources/org/invalid');assert(source);assert.equal(studentSection(source),null);assert.equal(studentPageTitle(source),'资料来源');
});
test('top-level navigation follows product route names and carries no fabricated counters or user data',()=>{
 assert.deepEqual(STUDENT_NAVIGATION.map(x=>x.href),['/today','/chats','/pending','/journey','/me']);
 for(const entry of STUDENT_NAVIGATION)assert.deepEqual(Object.keys(entry).sort(),['href','key','label']);
});
