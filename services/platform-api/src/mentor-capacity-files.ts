export { readOrgOperatorFile as readMentorCapacityFile } from './org-content-files.ts';
export function parseMentorCapacityArguments(args:readonly string[]){
  const [action,...flags]=args;
  if(!['profile','slot','withdraw','list','observe'].includes(action))throw Error();
  const values=new Map<string,string>();
  for(let i=0;i<flags.length;i+=2){
    const k=flags[i],v=flags[i+1];
    if(!['--org','--session-file','--input-file','--kind','--after','--operation-id'].includes(k)||values.has(k)||!v||v.startsWith('--'))throw Error();
    values.set(k,v);
  }
  if(!values.has('--org')||!values.has('--session-file'))throw Error();
  const allowed=action==='list'?['--org','--session-file','--kind','--after']:action==='observe'?['--org','--session-file','--operation-id']:['--org','--session-file','--input-file'];
  if([...values.keys()].some(k=>!allowed.includes(k))||action==='list'&&!['profile','slot'].includes(values.get('--kind')??'')||
    action==='observe'&&!values.has('--operation-id')||!['list','observe'].includes(action)&&!values.has('--input-file'))throw Error();
  return Object.freeze({action,org:values.get('--org')!,sessionFile:values.get('--session-file')!,inputFile:values.get('--input-file'),
    kind:values.get('--kind') as 'profile'|'slot'|undefined,after:values.get('--after'),operationId:values.get('--operation-id')});
}
