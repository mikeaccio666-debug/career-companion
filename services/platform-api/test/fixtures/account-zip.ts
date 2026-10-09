import assert from 'node:assert/strict';
import {open,type Entry as ZipEntry} from 'yauzl';
export async function readZip(filename:string){
 const zip=await new Promise<import('yauzl').ZipFile>((resolve,reject)=>open(filename,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value!)));
 return new Promise<Map<string,Buffer>>((resolve,reject)=>{
  const files=new Map<string,Buffer>();
  const fail=(error:Error)=>{zip.close();reject(error);};
  zip.on('error',fail);zip.on('end',()=>resolve(files));
  zip.on('entry',(entry:ZipEntry)=>{
   try{assert(!files.has(entry.fileName));assert.equal((entry.externalFileAttributes>>>16)&0o777,0o600);}
   catch(error){fail(error as Error);return;}
   zip.openReadStream(entry,(error,stream)=>{
    if(error){fail(error);return;}const chunks:Buffer[]=[];
    stream!.on('error',fail).on('data',chunk=>chunks.push(chunk)).on('end',()=>{files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});
   });
  });
  zip.readEntry();
 });
}
