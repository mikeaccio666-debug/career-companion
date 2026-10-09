import { useId } from 'react';
import { resolveJobDeadline, type JobDeadlineDraft } from './manual-job-deadline';
export function JobDeadlineInput({value,disabled,onChange}:{value:JobDeadlineDraft;disabled:boolean;onChange:(value:JobDeadlineDraft)=>void}) {
 const id=useId(), resolution=resolveJobDeadline(value);
 return <fieldset className="job-deadline-editor" disabled={disabled}><legend>岗位截止时间（可留空）</legend>
  <p>按岗位原文填写日期、时间和时区；不清楚时先留空，核对后再记录。</p>
  <label>截止日期与时间<input type="datetime-local" step="60" value={value.localTime} required={Boolean(value.timeZone)}
   onChange={e=>onChange({...value,localTime:e.target.value,selectedInstant:''})}/></label>
  <label>截止时区<input value={value.timeZone} required={Boolean(value.localTime)} maxLength={80} list={id+'-zones'} placeholder="例如 America/Los_Angeles"
   onChange={e=>onChange({...value,timeZone:e.target.value,selectedInstant:''})}/></label>
  <datalist id={id+'-zones'}>{['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','Asia/Shanghai','UTC'].map(zone=><option key={zone} value={zone}/>)}</datalist>
  {resolution.message&&<p role="status">{resolution.message}</p>}
  {resolution.kind==='ambiguous'&&<fieldset className="job-deadline-offsets"><legend>请选择原文对应的那一次</legend>
   {resolution.candidates.map(candidate=><label key={candidate.instant}><input type="radio" name={id+'-offset'} value={candidate.instant}
    checked={value.selectedInstant===candidate.instant} onChange={()=>onChange({...value,selectedInstant:candidate.instant})}/>{candidate.label}</label>)}
  </fieldset>}
  {resolution.selected&&<p className="job-deadline-preview">将保存的截止时间：{resolution.selected.label}</p>}
 </fieldset>;
}
