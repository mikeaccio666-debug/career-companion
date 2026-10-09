import type {StudentRoute} from './student-route.ts';

export type StudentSection='today'|'chats'|'pending'|'journey'|'me';
export const STUDENT_NAVIGATION=Object.freeze([
 {key:'today',label:'今天',href:'/today'},
 {key:'chats',label:'对话',href:'/chats'},
 {key:'pending',label:'待确认',href:'/pending'},
 {key:'journey',label:'旅程',href:'/journey'},
 {key:'me',label:'我',href:'/me'},
] as const);
export function studentSection(route:StudentRoute):StudentSection|null {
 if(route.kind==='source')return null;
 if(route.kind==='missing')return route.returnHref.slice(1) as Exclude<StudentSection,'chats'>;
 switch(route.page){
  case 'today':return 'today';
  case 'pending':return 'pending';
  case 'journey':case 'stories':case 'interviews':case 'applications':case 'jobs':case 'targets':return 'journey';
  default:return 'me';
 }
}
export function studentPageTitle(route:StudentRoute):string{
 if(route.kind==='source')return '资料来源';
 if(route.kind==='missing')return '查看记录';
 const titles={today:'今天',journey:'旅程',pending:'待确认',stories:'项目与故事',interviews:'面试安排',
 applications:'投递记录',jobs:'收藏的岗位',targets:'目标方向',mentors:'蔓藤导师',profile:'个人资料',
 companion:'主理人设置',memory:'它记得的你',me:'我'};
 return titles[route.page];
}
