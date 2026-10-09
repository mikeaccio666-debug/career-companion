import { constants,type Stats } from 'node:fs';
import { lstat,mkdir,open,realpath } from 'node:fs/promises';
import { isAbsolute,join,resolve } from 'node:path';
import type { EvalBudgetLedgerEvent } from './budget.ts';
import type { ProviderBaselineResult } from './probe.ts';
import type { EvalPilotReport } from './pilot.ts';

export class EvalJournalError extends Error {
 readonly code='EVAL_JOURNAL_UNAVAILABLE';
 constructor(){super('The private evaluation record could not be saved. No automatic retry is allowed.');}
}
function fail():never{throw new EvalJournalError();}
const id=(x:unknown)=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,149}$/.exec(x)?.[0]===x;
function plain(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length!==Object.keys(descriptors).length||Object.values(descriptors).some(d=>!d.enumerable||!('value' in d)))fail();
 return value as Record<string,unknown>;
}
function closed(value:unknown,keys:readonly string[]){const row=plain(value);if(Object.keys(row).some(k=>!keys.includes(k)))fail();return row;}
const callFields=['runId','caseId','stage','callId','index','studyDigest','scriptId','scriptDigest','seedInputDigest','provider','model','purpose','priceSnapshotId','approvedConfigId','tariffProfileId','atMs'];
const ledgerFields:Record<string,readonly string[]>={
 started_reserve:[...callFields,'type','inputReserveTokens','outputReserveTokens','reservedMicroUsd'],
 finished_settled:[...callFields,'type','status','usageStatus','inputTokens','outputTokens','actualMicroUsd','reservedMicroUsd'],
 finished_uncertain:[...callFields,'type','status','usageStatus','actualMicroUsd','reservedMicroUsd'],
 case_completed:['type','runId','caseId','studyDigest','stage','calls','actualMicroUsd','atMs'],
 forecast_approved:['type','runId','studyDigest','totalEstimatedMicroUsd','formalBasis','atMs'],
 batch_stopped:['type','runId','reason','atMs'],
};
const resultFields=['scope','caseId','runId','studyDigest','scriptId','scriptDigest','stage','provider','model','purpose','priceSnapshotId','inputScope','toolExecution','timingBasis','status','errorCode','seedInputDigest','outputDigest','outputChars','baselineFirstDeltaMs','baselineCompletedMs','productMetrics','qualityScore','qualityStatus'];
const reportFields=['scope','runId','studyDigest','status','stopReason','plannedCases','persistedCases','completedCases','lastCaseId','budget','productGate','qualityStatus'];
const budgetFields=['status','reason','capMicroUsd','actualSpentMicroUsd','pendingReservedMicroUsd','committedMicroUsd','startedCalls','reportedCalls','uncertainCalls','inflightCalls','completedCaseIds','revision'];
function scalars(row:Record<string,unknown>,skip:readonly string[]=[]){
 for(const [key,value] of Object.entries(row)){
  if(skip.includes(key)||value===null)continue;
  if(typeof value==='number'){if(!Number.isFinite(value)||value<0)fail();}
  else if(!id(value))fail();
 }
}
export interface EvalRunManifest {
 schemaVersion:1;scope:'isolated_provider_loop_pilot';runId:string;studyDigest:string;promptDigest:string;corpusDigest:string;
 provider:'openai';model:'gpt-6-luna';serviceTier:'default';capMicroUsd:number;priceSnapshotId:string;createdAt:string;
 pilotCaseIds:readonly string[];productGate:'not_evaluated';qualityStatus:'not_scored';
}
/** One private directory per run, never reopened. Each bounded content-free JSON
 * record and its directory entry are synced before a caller may send a request.
 * A crash leaves evidence in place; incomplete runs must not auto-resume. */
export async function createEvalJournal(root:string,manifest:EvalRunManifest){
 let directory:string,identity:{dev:number;ino:number},sequence=0,stopped=false;
 const runId=manifest.runId;let frozenManifest:EvalRunManifest;
 const recordKeys=['schemaVersion','scope','runId','studyDigest','promptDigest','corpusDigest','provider','model','serviceTier','capMicroUsd','priceSnapshotId','createdAt','pilotCaseIds','productGate','qualityStatus'];
 const own=(stat:Stats)=>stat.isDirectory()&&(stat.mode&0o077)===0&&(process.getuid===undefined||stat.uid===process.getuid());
 try{
  closed(manifest,recordKeys);scalars(manifest as unknown as Record<string,unknown>,['pilotCaseIds','createdAt']);
  if(manifest.schemaVersion!==1||manifest.provider!=='openai'||manifest.model!=='gpt-6-luna'||manifest.serviceTier!=='default'||
   !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)||!Array.isArray(manifest.pilotCaseIds)||manifest.pilotCaseIds.length!==12||
   manifest.pilotCaseIds.some(x=>!id(x))||new Set(manifest.pilotCaseIds).size!==12||!Number.isFinite(Date.parse(manifest.createdAt))||
   !isAbsolute(root)||resolve(root)!==root)fail();
  frozenManifest=Object.freeze({...manifest,pilotCaseIds:Object.freeze([...manifest.pilotCaseIds])});
  await mkdir(root,{recursive:true,mode:0o700});
  if(await realpath(root)!==root||!own(await lstat(root)))fail();
  directory=join(root,runId);await mkdir(directory,{mode:0o700});
  const stat=await lstat(directory);if(!own(stat))fail();identity={dev:stat.dev,ino:stat.ino};
  const parent=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await parent.sync();}finally{await parent.close();}
 }catch{throw new EvalJournalError();}
 const write=async(kind:string,value:unknown)=>{
  if(stopped)fail();
  try{
   const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>64*1024)fail();
   const stat=await lstat(directory);if(!own(stat)||stat.dev!==identity.dev||stat.ino!==identity.ino||await realpath(directory)!==directory)fail();
   const filename=String(sequence++).padStart(6,'0')+'-'+kind+'.json';
   const file=await open(join(directory,filename),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   const folder=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   try{await folder.sync();}finally{await folder.close();}
  }catch{stopped=true;throw new EvalJournalError();}
 };
 // Freeze authorization coordinates by capturing them before awaiting any writes.
 const cases=new Set(frozenManifest.pilotCaseIds),studyDigest=frozenManifest.studyDigest,provider=frozenManifest.provider,model=frozenManifest.model;
 const validate=(row:Record<string,unknown>)=>{
  if(row.runId!==runId||row.studyDigest!==undefined&&row.studyDigest!==studyDigest||row.caseId!==undefined&&!cases.has(row.caseId as string)||
   row.provider!==undefined&&row.provider!==provider||row.model!==undefined&&row.model!==model)fail();
 };
 await write('manifest',frozenManifest);
 let tail:Promise<unknown>=Promise.resolve();
 const serial=(run:()=>Promise<void>)=>{const next=tail.then(run);tail=next.catch(()=>{stopped=true;});return next;};
 return Object.freeze({
  persistLedger:(value:Readonly<EvalBudgetLedgerEvent>)=>serial(async()=>{
   const raw=plain(value),type=raw.type;
   if(typeof type!=='string'||!Object.hasOwn(ledgerFields,type))fail();
   const row=closed(value,ledgerFields[type]!);validate(row);scalars(row);await write('ledger',row);
  }),
  persistResult:(value:Readonly<ProviderBaselineResult>)=>serial(async()=>{
   const row=closed(value,resultFields);validate(row);scalars(row,['productMetrics']);
   if(row.qualityScore!==null||row.qualityStatus!=='not_scored'||row.toolExecution!=='not_exercised')fail();
   const metrics=plain(row.productMetrics);
   for(const [key,metric] of Object.entries(metrics)){
    if(!id(key))fail();const m=closed(metric,['value','status','reason']);scalars(m);
    if(m.value!==null||m.status!=='blocked')fail();
   }
   await write('result',row);
  }),
  persistReport:(value:Readonly<EvalPilotReport>)=>serial(async()=>{
   const row=closed(value,reportFields);validate(row);scalars(row,['budget']);
   if(row.productGate!=='not_evaluated'||row.qualityStatus!=='not_scored'||row.plannedCases!==12)fail();
   const budget=closed(row.budget,budgetFields);scalars(budget,['completedCaseIds']);
   if(!Array.isArray(budget.completedCaseIds)||budget.completedCaseIds.some(x=>!cases.has(x as string)))fail();
   await write('report',row);stopped=true;
  }),
 });
}
