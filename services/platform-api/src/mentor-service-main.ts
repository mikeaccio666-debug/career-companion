import { careerRecordObject, careerRecordId } from '@companion/platform-contracts';
import { readConfig } from './config.ts';
import { Database } from './database.ts';
import { loadLegalBundle } from './legal-documents.ts';
import { createStorage } from './storage.ts';
import { tokenHash } from './auth.ts';
import { MentorServiceOffers } from './mentor-service-offers.ts';
import { parseMentorOperatorArguments, readMentorOperatorFile } from './mentor-service-files.ts';
// Explicit operator invocation. No migration, student mutations, payment, model calls or notifications.
let db: Database|undefined;
try {
  const args=parseMentorOperatorArguments(process.argv.slice(2));
  const v=careerRecordObject(await readMentorOperatorFile(args.sessionFile,4096),['userId','token']);
  if (typeof v.token !== 'string' || v.token.length<16 || v.token.length>1024 || /[\s\u0000-\u001f\u007f]/.test(v.token)) throw Error();
  const session=Object.freeze({userId:careerRecordId(v.userId),tokenHash:tokenHash(v.token)}),org=careerRecordId(args.org),config=readConfig();
  const input=args.inputFile ? await readMentorOperatorFile(args.inputFile,32768) : undefined;
  db=new Database(config.databaseUrl,{max:1,connectionTimeoutMillis:config.databaseConnectTimeoutMs});
  const service=new MentorServiceOffers(db,config,await loadLegalBundle(config.legalBundlePath),createStorage(config));
  const result=args.action==='list' ? await service.staffList(session,org)
    : args.action==='set' ? await service.set(session,org,input) : await service.withdraw(session,org,input);
  process.stdout.write(JSON.stringify(result)+'\n');
} catch {
  process.stderr.write('Service operation failed. Check the private input, reviewed service terms, current session and organization role.\n');
  process.exitCode=1;
} finally {await db?.close();}
