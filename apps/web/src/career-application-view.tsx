import { useCallback, useEffect, useRef, useState } from 'react';
import { APPLICATION_STAGES, APPLICATION_STAGE_LABELS, APPLICATION_CLOSE_REASONS, APPLICATION_CLOSE_REASON_LABELS, APPLICATION_OFFER_STATES, APPLICATION_OFFER_STATE_LABELS, careerApplicationSummary, parseCareerApplicationCommand, type CareerApplication, type CareerApplicationSummary, type CareerApplicationEvent, type ManualJobSummary, type ApplicationStage, type ApplicationCloseReason, type ApplicationOfferState } from '@companion/platform-contracts';
import { ApiError } from './api';
import { useRequiredPlatformAccountClient } from './account-client';
import { readManualJobs } from './manual-job-api';
import { readCareerApplications, readCareerApplication, readCareerApplicationEvents, changeCareerApplication, observeCareerApplication, type ApplicationIntent, type ApplicationResult } from './career-application-api';
import './career-target-view.css';
import './career-application-view.css';
const time = (at: string) => new Date(at).toLocaleString();
export function CareerApplicationPage({ onLogout }: {
    onLogout: () => void;
}) {
    const client = useRequiredPlatformAccountClient(), live = useRef(true), epoch = useRef(0), request = useRef<AbortController | null>(null), pending = useRef<ApplicationIntent | null>(null);
    const [rows, setRows] = useState<readonly Readonly<CareerApplicationSummary>[]>([]), [next, setNext] = useState<string | null>(null);
    const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [closedOpen, setClosedOpen] = useState(false), [mobileStage, setMobileStage] = useState<ApplicationStage>('saved');
    const [detail, setDetail] = useState<Readonly<CareerApplication> | null>(null), [events, setEvents] = useState<readonly Readonly<CareerApplicationEvent>[]>([]), [eventNext, setEventNext] = useState<string | null>(null);
    const [stage, setStage] = useState<ApplicationStage>('saved'), [reason, setReason] = useState<ApplicationCloseReason | ''>(''), [offer, setOffer] = useState<ApplicationOfferState | ''>(''), [note, setNote] = useState(''), [remove, setRemove] = useState(false);
    const [jobs, setJobs] = useState<readonly Readonly<ManualJobSummary>[]>([]), [jobNext, setJobNext] = useState<string | null>(null), [creating, setCreating] = useState(false), [jobId, setJobId] = useState(''), [createNote, setCreateNote] = useState('');
    const current = () => live.current && client.isCurrent();
    const load = useCallback(async (after: string | null = null) => {
        if (!live.current || !client.isCurrent() || request.current)
            return;
        const n = ++epoch.current, c = new AbortController();
        request.current = c;
        setBusy(true);
        const timer = setTimeout(() => c.abort(), 12000);
        try {
            const page = await readCareerApplications(client, after, null, c.signal);
            if (live.current && client.isCurrent() && n === epoch.current) {
                setRows(old => after ? [...old, ...page.applications.filter(a => !old.some(b => b.id === a.id))] : page.applications);
                setNext(page.nextAfter);
                setLoaded(true);
                setError('');
            }
        }
        catch (e) {
            if (live.current && client.isCurrent() && n === epoch.current)
                setError(e instanceof ApiError ? e.message : '申请记录暂时没读到，请重新读取。');
        }
        finally {
            clearTimeout(timer);
            if (live.current && client.isCurrent() && n === epoch.current) {
                request.current = null;
                setBusy(false);
            }
        }
    }, [client]);
    useEffect(() => {
        live.current = true;
        void load();
        const unsubscribe = client.subscribe(() => { if (!client.isCurrent()) {
            live.current = false;
            epoch.current++;
            request.current?.abort();
            pending.current = null;
            setRows([]);
            setNext(null);
            setDetail(null);
            setEvents([]);
            setEventNext(null);
            setJobs([]);
            setJobNext(null);
            setCreating(false);
            setJobId('');
            setCreateNote('');
            setNote('');
            setReason('');
            setOffer('');
            setRemove(false);
            setUncertain(false);
            setError('');
            setNotice('');
            setLoaded(false);
        } });
        return () => { live.current = false; epoch.current++; request.current?.abort(); request.current = null; pending.current = null; unsubscribe(); };
    }, [client, load]);
    function show(a: Readonly<CareerApplication> | null) { setDetail(a); setNote(a?.privateNote ?? ''); setStage(a?.stage ?? 'saved'); setReason(a?.closedReason ?? ''); setOffer(a?.offerState ?? ''); setRemove(false); setEvents([]); setEventNext(null); }
    async function read(run: (signal: AbortSignal) => Promise<() => void>) {
        if (busy || request.current || !current())
            return;
        const n = ++epoch.current, c = new AbortController();
        request.current = c;
        setBusy(true);
        const timer = setTimeout(() => c.abort(), 12000);
        try {
            const apply = await run(c.signal);
            if (current() && n === epoch.current) {
                apply();
                setError('');
            }
        }
        catch (e) {
            if (current() && n === epoch.current)
                setError(e instanceof ApiError ? e.message : '这次读取没有完成，请重新读取。');
        }
        finally {
            clearTimeout(timer);
            if (current() && n === epoch.current) {
                request.current = null;
                setBusy(false);
            }
        }
    }
    function accept(result: ApplicationResult) {
        setRows(old => [...(result.application ? [careerApplicationSummary(result.application)] : []), ...old.filter(a => a.id !== result.operation.applicationId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
        pending.current = null;
        setUncertain(false);
        setCreating(false);
        setCreateNote('');
        setJobId('');
        show(result.application);
        setNotice(result.application ? '记录已保存。' : '这份申请记录已移除。');
    }
    async function execute(observe = false) {
        const value = pending.current;
        if (!value || busy || request.current || !current())
            return;
        const n = ++epoch.current, c = new AbortController();
        request.current = c;
        setBusy(true);
        setError('');
        const timer = setTimeout(() => c.abort(), 8000);
        try {
            const result = await (observe ? observeCareerApplication : changeCareerApplication)(client, value, c.signal);
            if (current() && n === epoch.current)
                accept(result);
        }
        catch (e) {
            if (!current() || n !== epoch.current)
                return;
            if (!observe && e instanceof ApiError && e.status >= 400 && e.status < 500) {
                pending.current = null;
                setUncertain(false);
                setError(e.status === 409 ? '记录有变化。请重新读取详情，再核对你的修改。' : e.message);
            }
            else {
                setUncertain(true);
                setError(observe && e instanceof ApiError && e.status === 404 ? '暂时没有读到这次操作的结果。还不能确认没有保存，请用原操作重试。' : '还不能确认这次操作是否完成。请查询原结果，或用原操作重试。');
            }
        }
        finally {
            clearTimeout(timer);
            if (current() && n === epoch.current) {
                request.current = null;
                setBusy(false);
            }
        }
    }
    function start(value: ApplicationIntent) { if (busy || uncertain || request.current || !current())
        return; try {
        pending.current = { ...value, body: parseCareerApplicationCommand(value.action, value.body) };
        void execute();
    }
    catch {
        setError('请核对岗位、阶段信息和备注，再保存。');
    } }
    function loadJobs(after: string | null = null) { void read(async (signal) => { const page = await readManualJobs(client, after, signal); return () => { setJobs(old => after ? [...old, ...page.jobs.filter(j => !old.some(k => k.id === j.id))] : page.jobs); setJobNext(page.nextAfter); setCreating(true); }; }); }
    function open(id: string) { void read(async (signal) => { const a = await readCareerApplication(client, id, signal); return () => show(a); }); }
    function history(after: string | null = null) { if (!detail)
        return; const id = detail.id; void read(async (signal) => { const page = await readCareerApplicationEvents(client, id, after, signal); return () => { if (detail.id !== id)
        return; setEvents(old => after ? [...old, ...page.events.filter(e => !old.some(p => p.id === e.id))] : page.events); setEventNext(page.nextAfter); }; }); }
    const disabled = busy || uncertain;
    const card = (a: Readonly<CareerApplicationSummary>) => <article key={a.id} className="application-card">
  <strong>{a.job.employer}</strong><p>{a.job.title}</p><p>{a.job.location}</p>
  <span className={"application-chip " + (a.stage === 'offer' ? 'done' : ['oa', 'interview'].includes(a.stage) ? 'active' : 'neutral')}>{APPLICATION_STAGE_LABELS[a.stage]}{a.closedReason ? ' · ' + APPLICATION_CLOSE_REASON_LABELS[a.closedReason] : a.offerState ? ' · ' + APPLICATION_OFFER_STATE_LABELS[a.offerState] : ''}</span>
  {a.job.deadlineAt && <p>截止：{time(a.job.deadlineAt)} · {a.job.deadlineTimeZone}（你填写的时间）</p>}
  <small>尚未关联材料包</small><small>你贴的 JD · 没核实是否还开放</small>
  {a.submittedVia === 'user_sends' && <small>由你记录已投</small>}
  <button type="button" disabled={busy} onClick={() => open(a.id)}>查看与改阶段</button>
 </article>;
    return <main className="career-target-page application-page"><nav><a href="/">回到对话</a><a href="/journey/jobs">收藏的岗位</a><a href="/journey/targets">目标方向</a><button type="button" onClick={onLogout}>退出登录</button></nav>
  <section className="career-target-panel"><header><h1>你的投递旅程</h1><p>从收藏的岗位开始，按你的实际进展更新。</p></header>
   <div className="career-target-actions"><button type="button" disabled={disabled} onClick={() => loadJobs()}>从收藏建立记录</button><button type="button" disabled={busy} onClick={() => void load()}>重新读取看板</button></div>
   {busy && <p role="status">正在读取或保存…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="career-target-notice">{error}</p>}
   {uncertain && <div className="career-target-actions"><button type="button" disabled={busy} onClick={() => void execute(true)}>查询这次操作的结果</button><button type="button" disabled={busy} onClick={() => void execute()}>用原操作重试</button></div>}
   {creating && <form className="career-target-editor" onSubmit={e => { e.preventDefault(); const job = jobs.find(j => j.id === jobId); if (job)
            start({ action: 'create', id: null, body: { operationId: crypto.randomUUID(), expectedRevision: 0, jobObservationId: job.id, jobObservationRevision: job.revision, privateNote: createNote } }); }}>
    <h2>从你的收藏开始</h2><label>选择岗位<select required value={jobId} disabled={disabled} onChange={e => setJobId(e.target.value)}><option value="">请选择</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.employer} · {j.title}</option>)}</select></label>
    {!jobs.length && <p>还没有读到收藏。可以先去<a href="/journey/jobs">收藏岗位</a>。</p>}{jobNext && <button type="button" disabled={busy} onClick={() => loadJobs(jobNext)}>继续读取收藏</button>}
    <label>申请的私人备注<textarea maxLength={2000} value={createNote} disabled={disabled} onChange={e => setCreateNote(e.target.value)}/></label>
    <div className="career-target-actions"><button type="submit" disabled={disabled || !jobId}>建立收藏阶段的记录</button><button type="button" disabled={disabled} onClick={() => setCreating(false)}>先不建立</button></div>
   </form>}
   {detail && <section className="career-target-editor" aria-label="申请详情"><h2>{detail.job.employer} · {detail.job.title}</h2><p>创建于 {time(detail.createdAt)} · 最近更新 {time(detail.updatedAt)}</p>
    <p>你贴的 JD · 没核实是否还开放。需要核对原文时，去<a href="/journey/jobs">收藏的岗位</a>读取。</p>
    <form onSubmit={e => { e.preventDefault(); start({ action: 'stage', id: detail.id, body: { operationId: crypto.randomUUID(), expectedRevision: detail.revision, stage, ...(stage === 'closed' ? { closedReason: reason } : stage === 'offer' ? { offerState: offer } : {}) } }); }}>
     <label>改阶段<select value={stage} disabled={disabled} onChange={e => { setStage(e.target.value as ApplicationStage); setReason(''); setOffer(''); }}>{APPLICATION_STAGES.map(s => <option key={s} value={s}>{APPLICATION_STAGE_LABELS[s]}</option>)}</select></label>
     {stage === 'closed' && <label>结束原因<select required value={reason} disabled={disabled} onChange={e => setReason(e.target.value as ApplicationCloseReason)}><option value="">请选择</option>{APPLICATION_CLOSE_REASONS.map(r => <option key={r} value={r}>{APPLICATION_CLOSE_REASON_LABELS[r]}</option>)}</select></label>}
     {stage === 'offer' && <label>Offer 状态<select required value={offer} disabled={disabled} onChange={e => setOffer(e.target.value as ApplicationOfferState)}><option value="">请选择</option>{APPLICATION_OFFER_STATES.map(o => <option key={o} value={o}>{APPLICATION_OFFER_STATE_LABELS[o]}</option>)}</select></label>}
     {stage === 'applied' && <p>确认表示你自己记录已经投过。</p>}<button type="submit" disabled={disabled}>确认改阶段</button>
    </form>
    <form onSubmit={e => { e.preventDefault(); start({ action: 'edit', id: detail.id, body: { operationId: crypto.randomUUID(), expectedRevision: detail.revision, privateNote: note } }); }}><label>私人备注<textarea maxLength={2000} value={note} disabled={disabled} onChange={e => setNote(e.target.value)}/></label><button type="submit" disabled={disabled}>保存备注</button></form>
    <div className="career-target-actions"><button type="button" disabled={busy} onClick={() => open(detail.id)}>重新读取详情</button><button type="button" disabled={busy} onClick={() => history()}>读取阶段历史</button><button type="button" disabled={disabled} onClick={() => setRemove(true)}>移除记录</button><button type="button" disabled={disabled} onClick={() => show(null)}>收起详情</button></div>
    {remove && <section aria-label="移除申请确认"><p>移除这份申请及私人备注？收藏的岗位会保留；不含正文的操作历史会留作对账。</p><div className="career-target-actions"><button type="button" disabled={disabled} onClick={() => start({ action: 'delete', id: detail.id, body: { operationId: crypto.randomUUID(), expectedRevision: detail.revision } })}>确认移除</button><button type="button" disabled={disabled} onClick={() => setRemove(false)}>保留记录</button></div></section>}
    {events.length > 0 && <ol className="application-history">{events.map(e => <li key={e.id}><time dateTime={e.createdAt}>{time(e.createdAt)}</time> · {e.action === 'create' ? '建立记录' : e.action === 'edit' ? '更改备注' : e.action === 'delete' ? '移除记录' : (e.previous ? APPLICATION_STAGE_LABELS[e.previous.stage] + ' → ' : '') + (e.next ? APPLICATION_STAGE_LABELS[e.next.stage] : '')}{e.next?.closedReason ? ' · ' + APPLICATION_CLOSE_REASON_LABELS[e.next.closedReason] : e.next?.offerState ? ' · ' + APPLICATION_OFFER_STATE_LABELS[e.next.offerState] : ''}</li>)}</ol>}
    {eventNext && <button type="button" disabled={busy} onClick={() => history(eventNext)}>继续读取历史</button>}
   </section>}
   {loaded && rows.length === 0 && <p className="career-target-empty">还没有申请记录。先选一个你收藏的岗位。</p>}
   <p className="application-read-caption">看板显示已读取的记录{next ? '，还有记录可以继续读取。' : '。'}</p>
   <div className="application-mobile-stages" role="group" aria-label="选择投递阶段">{APPLICATION_STAGES.map(s => <button type="button" key={s} aria-pressed={mobileStage === s} onClick={() => setMobileStage(s)}>{APPLICATION_STAGE_LABELS[s]}</button>)}</div>
   <div className={'application-board ' + (closedOpen ? 'closed-expanded' : 'closed-folded')}>
    {APPLICATION_STAGES.map(s => <section key={s} className={'application-column ' + (mobileStage === s ? 'mobile-selected' : '') + (s === 'closed' ? ' application-closed' : '')} aria-label={APPLICATION_STAGE_LABELS[s]}>
     <h2>{s === 'closed' ? <><button type="button" aria-expanded={closedOpen} onClick={() => setClosedOpen(!closedOpen)}>已结束 {closedOpen ? '收起' : '展开'}</button><span className="application-mobile-closed-title">已结束</span></> : <>{APPLICATION_STAGE_LABELS[s]} <span>{rows.filter(a => a.stage === s).length}</span></>}</h2>
     <div className="application-column-cards">{rows.filter(a => a.stage === s).map(card)}</div>
    </section>)}
   </div>{next && <button type="button" disabled={busy} onClick={() => void load(next)}>继续读取申请记录</button>}
  </section></main>;
}
