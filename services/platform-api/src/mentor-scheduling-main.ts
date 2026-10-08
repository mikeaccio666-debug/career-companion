import { careerRecordId,careerRecordObject } from '@companion/platform-contracts';
import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { loadLegalBundle } from './legal-documents.ts';
import { createStorage } from './storage.ts';
import { tokenHash } from './auth.ts';
import { MentorServiceOffers } from './mentor-service-offers.ts';
import { MentorCapacity } from './mentor-capacity.ts';
import { MentorIntents } from './mentor-intents.ts';
import { readOrgOperatorFile } from './org-content-files.ts';
let db:Database|undefined;
try{
 const [action,...flags]=process.argv.slice(2);if(action!=='record')throw Error();const args=new Map<string,string>();
 for(let i=0;i<flags.length;i+=2){const k=flags[i],v=flags[i+1];if(!['--org','--session-file','--input-file'].includes(k)||args.has(k)||!v||v.startsWith('--'))throw Error();args.set(k,v);}
 if(args.size!==3)throw Error();
 const raw=careerRecordObject(await readOrgOperatorFile(args.get('--session-file')!,4096),['userId','token']);
 if(typeof raw.token!=='string'||raw.token.length<16||raw.token.length>1024||/[\s\u0000-\u001f\u007f]/.test(raw.token))throw Error();
 const session=Object.freeze({userId:careerRecordId(raw.userId),tokenHash:tokenHash(raw.token)}),input=await readOrgOperatorFile(args.get('--input-file')!,32768),config=readConfig();
 db=new Database(config.databaseUrl,{max:1,connectionTimeoutMillis:config.databaseConnectTimeoutMs});const legal=await loadLegalBundle(config.legalBundlePath),storage=createStorage(config);
 const offers=new MentorServiceOffers(db,config,legal,storage),capacity=new MentorCapacity(db,config,legal,storage),service=new MentorIntents(db,config,legal,offers,undefined,capacity,storage);
 process.stdout.write(JSON.stringify(await service.recordSchedule(session,args.get('--org')!,input))+'\n');
}catch{process.stderr.write('Mentor scheduling failed. Check current staff access, actual matched intent, confirmed window and private confirmation evidence.\n');process.exitCode=1;}
finally{await db?.close();}
