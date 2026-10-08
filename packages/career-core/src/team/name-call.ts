import type { ExpertKey } from '@companion/platform-contracts';
import { EXPERT_MEMBERS, expertRosterKeys, type ExpertMember } from './members.ts';
export interface ExpertNameCall {
  readonly expert: ExpertKey;
  readonly name: string;
  /** UTF-16 coordinates in the unchanged user text, not a normalized copy. */
  readonly start: number; readonly end: number;
  readonly syntax: 'vocative' | 'request' | 'question';
  readonly availability: 'enabled' | 'unavailable';
}
const aliases=EXPERT_MEMBERS.flatMap(member=>member.callNames.map(name=>({expert:member.key,name})))
  .sort((a,b)=>b.name.length-a.name.length);
const horizontal = /[ \t\u3000]/u;
const punctuation = /[，,:：]/u;
function spaces(text:string,index:number){while(horizontal.test(text[index]??''))index++;return index;}
/** Mask quoted/code data in place so matching never changes source offsets.
 * Ambiguous unclosed quotes/code remain data through the end of this message. */
function maskData(text:string):string {
  const chars=text.split('');
  const hide=(start:number,end:number)=>{for(let j=start;j<end;j++)if(!/[\r\n\u2028\u2029]/u.test(text[j]))chars[j]=' ';};
  let lineStart=0,fence:{char:string;length:number}|null=null;
  for(const line of text.split(/\r\n|[\r\n\u2028\u2029]/u)) {
    const marker=/^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if(fence) { hide(lineStart,lineStart+line.length);if(marker && marker[1][0]===fence.char && marker[1].length>=fence.length && !line.slice(marker[0].length).trim())fence=null; }
    else if(marker){fence={char:marker[1][0],length:marker[1].length};hide(lineStart,lineStart+line.length);}
    else if(/^\s*>/u.test(line))hide(lineStart,lineStart+line.length);
    lineStart+=line.length;if(text[lineStart]==='\r'&&text[lineStart+1]==='\n')lineStart+=2;else lineStart++;
  }
  let i=0;
  const pairs:Record<string,string>={'“':'”','「':'」','『':'』','"':'"',"'":"'"};
  while(i<text.length) {
    if(chars[i]===' '){i++;continue;}
    const c=text[i];
    if(c==='`') {
      let n=1;while(text[i+n]==='`')n++;
      let end=-1,search=i+n;
      while(search<text.length){const candidate=text.indexOf('`',search);if(candidate<0)break;let size=1;while(text[candidate+size]==='`')size++;if(size===n){end=candidate;break;}search=candidate+size;}
      const until=end<0?text.length:end+n;
      hide(i,until);i=until;continue;
    }
    if(pairs[c] && !(c==="'" && /[A-Za-z0-9]/u.test(text[i-1]??''))) {
      const stack=[pairs[c]];let end=i+1;
      for(;end<text.length;end++) {
        let backslashes=0;for(let j=end-1;j>=0&&text[j]==='\\';j--)backslashes++;
        if(backslashes%2)continue;
        if(text[end]===stack.at(-1)){stack.pop();if(!stack.length)break;}
        else if(pairs[text[end]] && !(text[end]==="'" && /[A-Za-z0-9]/u.test(text[end-1]??'')))stack.push(pairs[text[end]]);
      }
      const until=Math.min(text.length,end+1);hide(i,until);i=until;continue;
    }
    i++;
  }
  return chars.join('');
}
function at(text:string,index:number,short:boolean){return aliases.find(a=>(short||a.name.length>1)&&text.startsWith(a.name,index));}
function group(text:string,index:number) {
  const names: {expert:ExpertKey;name:string;start:number;end:number}[]=[];
  let cursor=index;
  while(true) {
    const name=at(text,cursor,false);if(!name)break;
    names.push({...name,start:cursor,end:cursor+name.name.length});cursor+=name.name.length;
    const separator=/^[ \t\u3000]*(?:、|和|与|及|，|,)[ \t\u3000]*/u.exec(text.slice(cursor));
    if(!separator || !at(text,cursor+separator[0].length,false))break;
    cursor+=separator[0].length;
  }
  return {names,end:cursor};
}
/** 03 §4.4 name detection only: no model, task inference, room/turn mutation,
 * consultation or permission. The actual room/reply-card precedence must be
 * applied by the authenticated caller before using these candidates. */
export function detectNameCall(text:string,roster:readonly ExpertMember[],inputKind:'text'|'transcript'='text'):readonly Readonly<ExpertNameCall>[] {
  const enabled=expertRosterKeys(roster);
  if(typeof text!=='string' || text.length>20000 || /[\ud800-\udfff]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))throw new Error('NAME_CALL_INVALID_TEXT');
  if(!['text','transcript'].includes(inputKind))throw new Error('NAME_CALL_INVALID_SOURCE');
  if(inputKind==='transcript' && /[\r\n\u2028\u2029]/u.test(text))return Object.freeze([]);
  const visible=maskData(text),found:ExpertNameCall[]=[];
  // Also exclude pasted multi-speaker transcripts. Ordinary multi-line user
  // requests remain eligible; structured field labels are not speakers.
  const fields=new Set(['材料','目标','问题','简历','项目','任务','要求','输入','输出','正文','备注','日期','时间','链接','背景']);
  const labels=visible.split(/\r\n|[\r\n\u2028\u2029]/u).flatMap(line=>{const m=/^\s*([^\s:：]{1,30})[:：]/u.exec(line);return m&&!fields.has(m[1])?[m[1]]:[];});
  if(labels.length>=2 && labels.some(label=>aliases.some(a=>a.name===label)||/^(?:用户|主理人|User|Assistant|Speaker\d*)$/iu.test(label)))return Object.freeze([]);
  const add=(items:readonly {expert:ExpertKey;name:string;start:number;end:number}[],syntax:ExpertNameCall['syntax'])=>{
    for(const item of items)found.push({...item,syntax,availability:enabled.has(item.expert)?'enabled':'unavailable'});
  };
  const starts=[0,...Array.from(visible.matchAll(/[。！？!?；;\r\n\u2028\u2029]/gu),m=>m.index!+m[0].length)];
  for(const boundary of starts) {
    const start=spaces(visible,boundary),names=group(visible,start);
    if(names.names.length && (punctuation.test(visible[names.end]??'') || horizontal.test(visible[names.end]??'')))add(names.names,'vocative');
    if(names.names.length && /[？?]/u.test(visible[names.end]??''))add(names.names,'question');
    const request=/^(?:你[ \t\u3000]*)?(?:帮我[ \t\u3000]*)?(?:让|叫|请|找)[ \t\u3000]*/u.exec(visible.slice(start));
    if(request)add(group(visible,start+request[0].length).names,'request');
  }
  // The single-character rule is deliberately narrower than full names.
  const first=spaces(visible,0),short=at(visible,first,true);
  if(short?.name.length===1 && !/后[ \t]*[:：]/u.test(visible) && /[，,:：？?]/u.test(visible[first+1]??''))add([{...short,start:first,end:first+1}],'vocative');
  for(const alias of aliases.filter(a=>a.name.length>1)) {
    const question=new RegExp('(?:^|[，,:：。！？!?；; \t\u3000\r\n])('+alias.name+')[？?]','gu');
    for(const match of visible.matchAll(question)){const start=match.index!+match[0].indexOf(alias.name);add([{...alias,start,end:start+alias.name.length}],'question');}
  }
  const seen=new Set<ExpertKey>();
  return Object.freeze(found.sort((a,b)=>a.start-b.start).filter(call=>{if(seen.has(call.expert))return false;seen.add(call.expert);return true;}).map(call=>Object.freeze(call)));
}

/** MentionPicker and Discord /ask supply a structured expert key after their
 * own source/identity checks. Never parse an email or arbitrary @ text as this. */
export function resolveExplicitExpertCall(expert:ExpertKey,roster:readonly ExpertMember[]) {
  const enabled=expertRosterKeys(roster);
  if(!EXPERT_MEMBERS.some(member=>member.key===expert))throw new Error('NAME_CALL_INVALID_EXPERT');
  return Object.freeze({expert,availability:enabled.has(expert)?'enabled' as const:'unavailable' as const});
}
