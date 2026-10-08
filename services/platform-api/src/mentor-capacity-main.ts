import { careerRecordId,careerRecordObject } from '@companion/platform-contracts';
import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { loadLegalBundle } from './legal-documents.ts';
import { createStorage } from './storage.ts';
import { tokenHash } from './auth.ts';
import { MentorCapacity } from './mentor-capacity.ts';
import { parseMentorCapacityArguments,readMentorCapacityFile } from './mentor-capacity-files.ts';
let db:Database|undefined;
try{
  const args=parseMentorCapacityArguments(process.argv.slice(2));
  const v=careerRecordObject(await readMentorCapacityFile(args.sessionFile,4096),['userId','token']);
  if(typeof v.token!=='string'||v.token.length<16||v.token.length>1024||/[\s\u0000-\u001f\u007f]/.test(v.token))throw Error();
  const session=Object.freeze({userId:careerRecordId(v.userId),tokenHash:tokenHash(v.token)}),config=readConfig();
  const input=args.inputFile?await readMentorCapacityFile(args.inputFile,32768):undefined;
  db=new Database(config.databaseUrl,{max:1,connectionTimeoutMillis:config.databaseConnectTimeoutMs});
  const service=new MentorCapacity(db,config,await loadLegalBundle(config.legalBundlePath),createStorage(config));
  const result=args.action==='profile'?await service.setProfile(session,args.org,input):args.action==='slot'?await service.setSlot(session,args.org,input):
    args.action==='withdraw'?await service.withdraw(session,args.org,input):args.action==='observe'?await service.observe(session,args.org,args.operationId!):
    await service.list(session,args.org,args.kind!,args.after?{after:args.after}:{});
  process.stdout.write(JSON.stringify(result)+'\n');
}catch{process.stderr.write('Mentor capacity operation failed. Check the private source files, current organization role and confirmed mentor/time-window evidence.\n');process.exitCode=1;}
finally{await db?.close();}
