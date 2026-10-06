import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=path.join(root,'.env.platform');
if(existsSync(config))process.loadEnvFile(config);
process.env.PLATFORM_STORAGE_DIR=path.resolve(root,process.env.PLATFORM_STORAGE_DIR||'.local/platform/blobs');
const children=new Set();let stopping=false;
function run(args){return new Promise((resolve,reject)=>{
  const child=spawn('pnpm',args,{cwd:root,stdio:'inherit',env:process.env,detached:process.platform!=='win32'});children.add(child);
  child.on('error',reject);child.on('exit',code=>{children.delete(child);code===0?resolve():reject(new Error(`Platform process exited with status ${code??'signal'}.`));});
});}
function stop(){if(stopping)return;stopping=true;for(const child of children){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{/* Already exited. */}}}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try{
  await run(['--filter','@companion/platform-api','migrate']);
  console.log('Open http://localhost:4321 — API 4320, independent worker. Provider calls stay disabled by default.');
  await Promise.all([run(['--filter','@companion/platform-api','dev']),run(['--filter','@companion/platform-api','worker']),run(['--filter','@companion/web','dev'])]);
}catch(error){const failed=!stopping;if(failed)console.error(error instanceof Error?error.message:'Platform startup failed.');stop();process.exitCode=failed?1:0;}
