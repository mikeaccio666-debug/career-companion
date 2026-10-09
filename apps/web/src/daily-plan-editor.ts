import type {DailyPlanView} from '@companion/platform-contracts';
export interface DailyEditBasis {readonly localDate:string;readonly planId:string;readonly revision:number;}
export interface DailyItemEditor {readonly itemId:string;readonly title:string;readonly minutes:string;readonly basis:DailyEditBasis;}
export function editableDailyItem(view:Readonly<DailyPlanView>,id:string){
 if(view.paused)return null;return view.plan?.items.find(i=>i.id===id&&i.rule==='user'&&(i.state==='proposed'||i.state==='accepted'))??null;
}
export function dailyEditBasis(view:Readonly<DailyPlanView>,id:string):DailyEditBasis|null{
 return view.plan&&editableDailyItem(view,id)?Object.freeze({localDate:view.localDate,planId:view.plan.id,revision:view.plan.revision}):null;
}
export function dailyEditMatches(view:Readonly<DailyPlanView>,id:string,basis:DailyEditBasis){
 const current=dailyEditBasis(view,id);return !!current&&current.localDate===basis.localDate&&current.planId===basis.planId&&current.revision===basis.revision;
}
