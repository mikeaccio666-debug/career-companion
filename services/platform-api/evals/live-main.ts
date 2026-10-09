import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runLivePilot,type LivePilotChoice } from './live-pilot.ts';

export async function evalLiveCommand(args:readonly string[],env:NodeJS.ProcessEnv,signal?:AbortSignal){
 // Invalid arguments are rejected before reading credentials, creating files or importing a runtime instance.
 if(args.length!==4||args[0]!=='--live'||!['openai-luna','anthropic-haiku'].includes(args[1]??'')||args[2]!=='--run-id'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args[3]!))
  return {exitCode:2,result:{status:'rejected',code:'EVAL_LIVE_ARGUMENTS_INVALID'}};
 try{const report=await runLivePilot({env,runId:args[3]!,signal,choice:args[1] as LivePilotChoice});return {exitCode:report.status==='completed'?0:1,result:report};}
 catch(error){
  const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
  const known=['EVAL_LIVE_DISABLED','EVAL_KEY_MISSING','EVAL_LIVE_INPUT_INVALID','EVAL_PRICE_UNCONFIRMED','EVAL_JOURNAL_UNAVAILABLE'];
  return {exitCode:1,result:{status:'stopped',code:signal?.aborted?'EVAL_CANCELLED':typeof code==='string'&&known.includes(code)?code:'EVAL_LIVE_FAILED'}};
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{const outcome=await evalLiveCommand(process.argv.slice(2),process.env,controller.signal);process.stdout.write(JSON.stringify(outcome.result)+'\n');process.exitCode=outcome.exitCode;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
