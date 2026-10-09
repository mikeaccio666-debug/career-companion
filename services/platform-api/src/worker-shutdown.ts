/** One process-wide grace period, including heartbeat, maintenance, every worker,
 * producer, email sender and database pool. Timeout does not confirm job results.
 * A blocked event loop still requires the host's independent termination limit. */
export function createWorkerShutdownHandler(options:{
 timeoutMs:number;stopIntake():void;drain():Promise<void>;
 diagnostic(message:string):void;exit(code:0|1):void;
}):()=>void {
 if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>120000)
  throw Error('Invalid worker shutdown deadline.');
 let started=false,finished=false;
 return ()=>{
  if(started)return;started=true;
  const finish=(result:'drained'|'failed'|'deadline')=>{
   if(finished)return;finished=true;clearTimeout(timer);
   try {
    if(result==='failed')options.diagnostic('Worker shutdown could not be confirmed.\n');
    if(result==='deadline')options.diagnostic('Worker shutdown deadline exceeded; unfinished work is not confirmed.\n');
   } finally {options.exit(result==='drained'?0:1);}
  };
  // Keep the timer referenced: a pending Promise alone does not keep Node alive.
  const timer=setTimeout(()=>finish('deadline'),options.timeoutMs);
  try {
   options.stopIntake();
   void Promise.resolve().then(()=>options.drain()).then(()=>finish('drained'),()=>finish('failed'));
  }catch{finish('failed');}
 };
}
