import { useState } from 'react';
import { APPLICATION_STAGES, APPLICATION_STAGE_LABELS, APPLICATION_CLOSE_REASON_LABELS, APPLICATION_OFFER_STATE_LABELS, type CareerApplicationSummary, type ApplicationStage } from '@companion/platform-contracts';
import { applicationHref } from './career-application-route';
import { displayInterviewTime } from './career-interview-time';
import './career-application-view.css';

/** Only displays records supplied by the owner's read port. Stage changes stay in the existing detail flow. */
export function ApplicationBoard({ rows }: { rows: readonly Readonly<CareerApplicationSummary>[] }) {
    const [closedOpen, setClosedOpen] = useState(false);
    const [mobileStage, setMobileStage] = useState<ApplicationStage>('saved');
    const card = (a: Readonly<CareerApplicationSummary>) => <article key={a.id} className="application-card">
  <strong>{a.job.employer}</strong><p>{a.job.title}</p><p>{a.job.location}</p>
  <span className={"application-chip " + (a.stage === 'offer' ? 'done' : ['oa', 'interview'].includes(a.stage) ? 'active' : 'neutral')}>{APPLICATION_STAGE_LABELS[a.stage]}{a.closedReason ? ' · ' + APPLICATION_CLOSE_REASON_LABELS[a.closedReason] : a.offerState ? ' · ' + APPLICATION_OFFER_STATE_LABELS[a.offerState] : ''}</span>
  {a.job.deadlineAt && <p>截止：{displayInterviewTime(a.job.deadlineAt, a.job.deadlineTimeZone ?? 'UTC')}（你填写的时间）</p>}
  <small>尚未关联材料包</small><small>你贴的 JD · 没核实是否还开放</small>
  {a.submittedVia === 'user_sends' && <small>由你记录已投</small>}
  <a href={applicationHref(a.id)}>查看与改阶段</a>
 </article>;
    return <>
   <div className="application-mobile-stages" role="group" aria-label="选择投递阶段">{APPLICATION_STAGES.map(s => <button type="button" key={s} aria-pressed={mobileStage === s} onClick={() => setMobileStage(s)}>{APPLICATION_STAGE_LABELS[s]}</button>)}</div>
   <div className={'application-board ' + (closedOpen ? 'closed-expanded' : 'closed-folded')}>
    {APPLICATION_STAGES.map(s => <section key={s} className={'application-column ' + (mobileStage === s ? 'mobile-selected' : '') + (s === 'closed' ? ' application-closed' : '')} aria-label={APPLICATION_STAGE_LABELS[s]}>
     <h2>{s === 'closed' ? <><button type="button" aria-expanded={closedOpen} onClick={() => setClosedOpen(!closedOpen)}>已结束 {closedOpen ? '收起' : '展开'}</button><span className="application-mobile-closed-title">已结束</span></> : <>{APPLICATION_STAGE_LABELS[s]} <span>{rows.filter(a => a.stage === s).length}</span></>}</h2>
     <div className="application-column-cards">{rows.filter(a => a.stage === s).map(card)}</div>
    </section>)}
   </div>
    </>;
}
