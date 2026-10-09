import { createProviderRuntime,type RuntimeOptions } from '@companion/ai-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { createEvalBudget,type EvalCaseBinding,type EvalPriceSnapshot } from './budget.ts';
import { createEvalStudyPlan } from './study-plan.ts';
import { createEvalJournal,type EvalRunManifest } from './journal.ts';
import { runProviderPilot } from './pilot.ts';
import { haikuPilotRuntime } from './haiku-runtime.ts';

/** The user approved only Luna and Haiku 5.5 and delegated budget selection.
 * Each invocation selects one exact route; failures never switch providers. */
export const LIVE_PILOT_ROUTE=Object.freeze({provider:'openai',model:'gpt-6-luna',serviceTier:'default',capMicroUsd:1_000_000} as const);
export const LIVE_PILOT_PRICE:Readonly<EvalPriceSnapshot>=Object.freeze({
 id:'openai-luna-standard-global-20261009',provider:'openai',model:'gpt-6-luna',tier:'development',
 sourceUrl:'https://developers.openai.com/api/docs/pricing',checkedAt:'2026-10-09T04:26:02.000Z',expiresAt:'2026-10-16T04:26:02.000Z',
 reviewedBy:'agent_with_user_authorization',approvedConfigId:'user-approved-luna-pilot-20261008',tariffProfileId:'standard-global-upper-tariff',
 // Long-context maximum including cache writes; no assumed cache discount.
 maxContextInputTokens:922_000,maxOutputTokens:2048,inputMicroUsdPerMillion:250_000,outputMicroUsdPerMillion:750_000,
});
export const HAIKU_PILOT_ROUTE=Object.freeze({provider:'anthropic',model:'claude-haiku-5-5',serviceTier:'standard_only',capMicroUsd:2_000_000} as const);
export const HAIKU_PILOT_PRICE:Readonly<EvalPriceSnapshot>=Object.freeze({
 id:'anthropic-haiku-standard-global-20261009',provider:'anthropic',model:'claude-haiku-5-5',tier:'development',
 sourceUrl:'https://platform.claude.com/docs/en/models/haiku-5-5/overview',checkedAt:'2026-10-09T04:40:10.000Z',expiresAt:'2026-10-16T04:40:10.000Z',
 reviewedBy:'agent_with_user_authorization',approvedConfigId:'user-approved-haiku-pilot-20261008',tariffProfileId:'standard-global-upper-tariff',
 // Shared context window used only as an upper bound, including the highest
 // long-context cache-write tariff. These are conservative estimates, not invoices.
 maxContextInputTokens:1_000_000,maxOutputTokens:2048,inputMicroUsdPerMillion:1_000_000,outputMicroUsdPerMillion:2_500_000,
});
export type LivePilotChoice='openai-luna'|'anthropic-haiku';
export class EvalLiveError extends Error {
 readonly code:string;
 constructor(code:'EVAL_LIVE_DISABLED'|'EVAL_KEY_MISSING'|'EVAL_LIVE_INPUT_INVALID'|'EVAL_ROUTE_UNAVAILABLE'|'EVAL_REQUEST_REJECTED'){
  super('The isolated evaluation configuration could not be confirmed.');this.code=code;
 }
}
/** The production adapter still parses streaming and accounts for every request.
 * This final transport boundary pins the exact route/tariff before network I/O.
 * Ambient API base URLs, other credentials, defaults and Fast tiers are ignored. */
export function lunaPilotRuntime(key:string,fetch:typeof globalThis.fetch=globalThis.fetch):Pick<PlatformProviderRuntime,'streamModelStep'>{
 const guarded:RuntimeOptions['fetch']=async(url,init)=>{
  if(String(url)!=='https://api.openai.com/v1/responses'||init?.method!=='POST'||typeof init.body!=='string')throw new EvalLiveError('EVAL_REQUEST_REJECTED');
  const body=JSON.parse(init.body);
  if(body.model!=='gpt-6-luna'||body.store!==false||body.stream!==true||body.max_output_tokens!==2048||
   !Array.isArray(body.tools)||body.tools.length||!['none','auto'].includes(body.tool_choice)||body.reasoning?.effort!=='low')throw new EvalLiveError('EVAL_REQUEST_REJECTED');
  return fetch(url,{...init,body:JSON.stringify({...body,service_tier:'default'}),redirect:'error'});
 };
 const runtime=createProviderRuntime({env:{OPENAI_API_KEY:key,OPENAI_CHAT_MODEL:'gpt-6-luna',PLATFORM_ALLOW_PROVIDER_CALLS:'1'},fetch:guarded});
 const step=runtime.streamModelStep;if(!step)throw new EvalLiveError('EVAL_ROUTE_UNAVAILABLE');
 return {streamModelStep:(input,context)=>step(input,context)};
}

type LiveOptions={env:NodeJS.ProcessEnv;runId:string;signal?:AbortSignal};
type LiveDependencies={now?:()=>Date;runtimeFactory?:typeof lunaPilotRuntime};
export function runLiveLunaPilot(options:LiveOptions,dependencies:LiveDependencies={}){
 return runLivePilot({...options,choice:'openai-luna'},dependencies);
}
export async function runLivePilot(options:LiveOptions&{choice:LivePilotChoice},dependencies:LiveDependencies={}){
 const choice=options.choice;
 if(choice!=='openai-luna'&&choice!=='anthropic-haiku')throw new EvalLiveError('EVAL_ROUTE_UNAVAILABLE');
 const route=choice==='openai-luna'?LIVE_PILOT_ROUTE:HAIKU_PILOT_ROUTE,price=choice==='openai-luna'?LIVE_PILOT_PRICE:HAIKU_PILOT_PRICE;
 // Snapshot only this command's private configuration. Never load the main app env.
 const enabled=options.env.CAREER_EVAL_ALLOW_PAID_CALLS,key=choice==='openai-luna'?options.env.CAREER_EVAL_OPENAI_API_KEY:options.env.CAREER_EVAL_ANTHROPIC_API_KEY,root=options.env.CAREER_EVAL_RESULTS_DIR;
 const runId=options.runId,signal=options.signal,now=dependencies.now??(()=>new Date());
 if(enabled!=='1')throw new EvalLiveError('EVAL_LIVE_DISABLED');
 if(typeof key!=='string'||!key.trim()||key.trim()!==key||key.length>500||/[\x00-\x20\x7f]/.test(key))throw new EvalLiveError('EVAL_KEY_MISSING');
 if(typeof root!=='string'||!root||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId))throw new EvalLiveError('EVAL_LIVE_INPUT_INVALID');
 signal?.throwIfAborted();
 const study=createEvalStudyPlan();
 const cases:EvalCaseBinding[]=study.entries.filter(e=>e.stage==='pilot').map(({speaker:_speaker,...entry})=>({
  ...entry,studyDigest:study.digest,provider:route.provider,model:route.model,
  priceSnapshotId:price.id,maxOutputTokens:2048,maxModelCalls:1,
 }));
 // Validate budget and expired prices before creating files or the transport.
 let journal:Awaited<ReturnType<typeof createEvalJournal>>|undefined;
 const budget=createEvalBudget({runId,study,prices:[price],cases,capMicroUsd:route.capMicroUsd,now,signal,
  persist:async event=>{if(!journal)throw new EvalLiveError('EVAL_LIVE_INPUT_INVALID');await journal.persistLedger(event);}});
 const manifest:EvalRunManifest={schemaVersion:1,scope:'isolated_provider_loop_pilot',runId,studyDigest:study.digest,promptDigest:study.promptDigest,
  corpusDigest:study.corpusDigest,...route,priceSnapshotId:price.id,createdAt:now().toISOString(),
  pilotCaseIds:study.pilotCaseIds,productGate:'not_evaluated',qualityStatus:'not_scored'};
 journal=await createEvalJournal(root,manifest);
 signal?.throwIfAborted();
 const runtime=(dependencies.runtimeFactory??(choice==='openai-luna'?lunaPilotRuntime:haikuPilotRuntime))(key);
 const report=await runProviderPilot({budget,runtime,persistResult:journal.persistResult,signal});
 await journal.persistReport(report);return report;
}
