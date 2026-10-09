import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { auditAccountDataCoverage,readAccountSchemaInventory } from './account-data-coverage.ts';

/** Internal catalog inspection only. Exit zero means schema review matches,
 * never that export is implemented, authorized or ready for users. */
export async function accountCoverageCommand(args: readonly string[]) {
  if(args.length)return {exitCode:2,result:{status:'rejected',code:'ACCOUNT_COVERAGE_NO_ARGUMENTS'}};
  let db:Database|undefined;
  try{
    db=new Database(readConfig().databaseUrl,{max:1});
    const result=await db.withBoundedTransaction(async client=>
      auditAccountDataCoverage(await readAccountSchemaInventory(client)),{readOnly:true});
    await db.close();db=undefined;
    return {exitCode:result.schemaStatus==='reviewed'?0:1,result};
  }catch{
    return {exitCode:1,result:{status:'unavailable',code:'ACCOUNT_COVERAGE_UNAVAILABLE'}};
  }finally{await db?.close().catch(()=>{});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const outcome=await accountCoverageCommand(process.argv.slice(2));
  process.stdout.write(JSON.stringify(outcome.result,null,2)+'\n');process.exitCode=outcome.exitCode;
}
