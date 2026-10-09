/** Stop waiting even if a transport ignores cancellation. The caller must
 * retain an uncertain write's operation ID; timeout is not a failed write. */
export async function libraryRequest<T>(controller:AbortController,run:(signal:AbortSignal)=>Promise<T>,timeoutMs=8000):Promise<T>{
 controller.signal.throwIfAborted();
 let interrupted:(()=>void)|undefined;
 const cancelled=new Promise<never>((_,reject)=>{interrupted=()=>reject(new DOMException('Interrupted','AbortError'));controller.signal.addEventListener('abort',interrupted,{once:true});});
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{return await Promise.race([run(controller.signal),cancelled]);}
 finally{clearTimeout(timer);if(interrupted)controller.signal.removeEventListener('abort',interrupted);}
}
