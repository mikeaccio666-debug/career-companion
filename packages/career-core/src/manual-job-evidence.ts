import type { ManualJobEvidence,SponsorshipEvidenceStatus } from '@companion/platform-contracts';
export const MANUAL_JOB_EVIDENCE_RULE_REVISION=1;
const relevant=/\b(?:sponsor(?:ship|ing)?|visas?|work\s+authori[sz]ation|citizenship|citizens?|U\.?S\.?\s+person|ITAR|(?:security\s+)?clearance)\b/i;
function classify(text:string):SponsorshipEvidenceStatus {
 const conditional=/\b(?:if|may|might|depending|subject to|case.by.case|discretion|conditional|unless|except|not all|only certain|select roles|limited)\b/i.test(text);
 const deniedSponsor=/\b(?:do(?:es)? not|will not|cannot|can't|won't|unable to|not able to)\s+sponsor\b/i.test(text);
 const requiresWithout=/\b(?:must|should)\s+not\s+require\b[^.!?\n]{0,60}\b(?:sponsorship|visa)/i.test(text);
 const noNeed=/\b(?:no|without)\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:required|needed)\b/i.test(text);
 const no=deniedSponsor||requiresWithout||!noNeed&&/(?:\b(?:do(?:es)? not|will not|cannot|can't|won't|unable to|not able to)\s+(?:provide|offer|support|sponsor)\b[^.!?\n]{0,80}\b(?:sponsor(?:ship)?|visa)|\b(?:no|without)\s+(?:visa\s+|immigration\s+|employment.based\s+)?sponsorship\b|\bsponsorship\s+(?:is\s+)?not\s+(?:available|provided|offered)\b)/i.test(text);
 const required=/(?:\b(?:U\.?S\.?\s+(?:citizenship|citizens?|person)|United States\s+citizenship|ITAR|(?:security\s+)?clearance)\b[^!?\n]{0,100}\b(?:required|mandatory)\b)|\b(?:must|required|requires?|shall|only)\b[^.!?\n]{0,100}(?:U\.?S\.?\s+(?:citizens?|person)|United States\s+citizens?|ITAR|(?:security\s+)?clearance)\b/i.test(text)&&!/(?:\b(?:not|no)\b[^.!?\n]{0,25}\b(?:required|requires?|clearance|citizenship)|\b(?:clearance|citizenship)\b[^.!?\n]{0,25}\bnot\b)/i.test(text);
 const yes=/(?:\b(?:we|company|employer)\s+(?:will\s+)?sponsor\b|\b(?:will|can)\s+(?:provide|offer|support)\s+(?:visa\s+|immigration\s+|employment.based\s+)?sponsorship\b|\bsponsorship\s+(?:is\s+)?(?:available|provided|offered)\b)/i.test(text);
 if((no||required)&&!yes&&!conditional)return 'explicit_no';if(yes&&!no&&!required&&!conditional)return 'explicit_yes';return 'unknown';
}
/** Deterministic text evidence only. It makes no statement about an employer's
 * actual policy, a student's eligibility, or whether a posting is still open. */
export function manualJobEvidence(jobText:string){
 const spans:{start:number;end:number}[]=[];let start=0;
 const boundaries=/[.!?](?=\s+[A-Z0-9])|\r?\n/g;let match:RegExpExecArray|null;
 while((match=boundaries.exec(jobText))){const end=match.index+(match[0].includes('\n')?0:1);if(!match[0].includes('\n')&&/\b(?:U\.S|U\.S\.A|e\.g|i\.e|Mr|Ms|Dr)\.$/i.test(jobText.slice(start,end)))continue;spans.push({start,end});start=match.index+match[0].length;}
 spans.push({start,end:jobText.length});const all:Readonly<ManualJobEvidence>[]=[];
 for(const span of spans){while(span.start<span.end&&/\s/.test(jobText[span.start]))span.start++;while(span.end>span.start&&/\s/.test(jobText[span.end-1]))span.end--;const text=jobText.slice(span.start,span.end);if(relevant.test(text))all.push(Object.freeze({...span,text,status:classify(text)}));}
 const overflow=all.length>50,yes=all.some(e=>e.status==='explicit_yes'),no=all.some(e=>e.status==='explicit_no');
 const ambiguous=all.some(e=>e.status==='unknown'&&/\bsponsor/i.test(e.text));
 const sponsorship:SponsorshipEvidenceStatus=overflow||ambiguous||yes===no?'unknown':no?'explicit_no':'explicit_yes';
 return Object.freeze({sponsorship,sponsorshipEvidence:Object.freeze(all.slice(0,50)),evidenceOverflow:overflow,ruleRevision:MANUAL_JOB_EVIDENCE_RULE_REVISION});
}
