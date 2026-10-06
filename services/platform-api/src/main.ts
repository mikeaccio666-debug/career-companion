import { buildApp } from './app.ts';
import { readConfig } from './config.ts';
const config=readConfig();
const {app}=await buildApp({config});
try{await app.listen({host:config.host,port:config.port});process.stdout.write(`Platform API listener started on ${config.host}:${config.port}\n`);}
catch{process.stderr.write('Platform API could not start. Check its port and local services.\n');process.exitCode=1;await app.close();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
