import { test } from 'node:test';import assert from 'node:assert/strict';import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { extractPdfResume,runResumeTextProcess } from '../src/resume-file-text.ts';import { ApiError } from '../src/errors.ts';import { fictionalResumePdf } from './fixtures/resume-pdf.ts';
const error=(code:string)=>(e:unknown)=>e instanceof ApiError&&e.code===code;
test('actual Poppler stdin/stdout reads every fictional text page and reports its real local version',async()=>{const v=await extractPdfResume(fictionalResumePdf(['Fictional CV first page.','Fictional CV second page.']));assert(v.text.includes('first page'));assert(v.text.includes('second page'));assert.match(v.engineVersion,/^[0-9]+\.[0-9]+\.[0-9]+/);});
test('actual invalid, blank or partly blank PDF cannot produce a fictional successful original',async()=>{await assert.rejects(extractPdfResume(Buffer.from('%PDF-1.7 invalid private fictional fragment')),error('RESUME_TEXT_UNAVAILABLE'));for(const pages of [[''],['Fictional readable page.','']])await assert.rejects(extractPdfResume(fictionalResumePdf(pages)),error('RESUME_TEXT_INCOMPLETE'));});
test('process timeout waits for real child termination and keeps diagnostics out of user errors',async()=>{const directory=await mkdtemp(path.join(os.tmpdir(),'fictional-resume-process-')),pidfile=path.join(directory,'pid');try{const script='require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';await assert.rejects(runResumeTextProcess(process.execPath,['-e',script,pidfile],new Uint8Array(),undefined,{milliseconds:500,outputBytes:100}),error('RESUME_TEXT_TIMEOUT'));const pid=Number(await readFile(pidfile,'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');}finally{await rm(directory,{recursive:true,force:true});}});
test('actual child output bounds and cancellation are terminal without logging or returning private output',async()=>{await assert.rejects(runResumeTextProcess(process.execPath,['-e','process.stdout.write("x".repeat(200))'],new Uint8Array(),undefined,{milliseconds:1000,outputBytes:20}),error('RESUME_TEXT_TOO_LARGE'));const c=new AbortController(),work=runResumeTextProcess(process.execPath,['-e','setInterval(()=>{},1000)'],new Uint8Array(),c.signal);c.abort();await assert.rejects(work,error('RESUME_TEXT_CANCELLED'));});

// Genuine subprocess failures, rather than mocked status codes. No PDF or
// parser stderr may be included in a user-facing infrastructure error.
test('missing fixed executable and missing prlimit child are service failures, not invalid resumes',async()=>{
 for(const [program,args] of [['/usr/bin/fictional-missing-resume-executor',[]],['/usr/bin/prlimit',['--','/usr/bin/fictional-missing-resume-executor']]] as const){
  await assert.rejects(runResumeTextProcess(program,args,Buffer.from('Fictional private bytes')),e=>e instanceof ApiError&&e.status===503&&e.code==='RESUME_TEXT_EXECUTOR_UNAVAILABLE'&&!e.message.includes('Fictional'));
 }
});
test('actual unexecutable child and externally signalled process do not blame resume contents',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'fictional-resume-executor-'));
 try{
  const file=path.join(directory,'unexecutable');await writeFile(file,'Fictional private diagnostic',{mode:0o600});
  await assert.rejects(runResumeTextProcess(file,[],new Uint8Array()),error('RESUME_TEXT_EXECUTOR_UNAVAILABLE'));
  await assert.rejects(runResumeTextProcess(process.execPath,['-e','process.kill(process.pid,"SIGTERM")'],new Uint8Array()),e=>e instanceof ApiError&&e.status===503&&e.code==='RESUME_TEXT_EXECUTOR_INTERRUPTED');
 }finally{await rm(directory,{recursive:true,force:true});}
});
