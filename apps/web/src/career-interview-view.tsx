import { applicationHref } from './career-application-route';
import { useEffect, useMemo, useState } from 'react';
import { CAREER_INTERVIEW_ROUND_TYPES, type CareerInterview } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { CareerInterviewController, type InterviewSnapshot } from './career-interview-controller';
import { interviewDraft, interviewEditorIntent, interviewRoundLabels, interviewStatusLabels, type InterviewEditor } from './career-interview-presentation';
import { deviceInterviewTimeZone, displayInterviewTime, resolveInterviewTime } from './career-interview-time';
import './career-interview-view.css';

interface RecordDecision { readonly kind: 'done' | 'cancelled' | 'delete'; readonly record: Readonly<CareerInterview>; }
export function CareerInterviewPanel({ initialInterviewId }: { initialInterviewId?: string }) {
  const client = useRequiredPlatformAccountClient();
  const [observed, setObserved] = useState<{ client: typeof client; controller: CareerInterviewController; state: InterviewSnapshot } | null>(null);
  const controller = useMemo(() => {
    const next = new CareerInterviewController(client, state => setObserved({ client, controller: next, state }), initialInterviewId ?? null);
    return next;
  }, [client, initialInterviewId]);
  const [editor, setEditor] = useState<InterviewEditor | null>(null), [decision, setDecision] = useState<RecordDecision | null>(null);
  const [inputError, setInputError] = useState(''), [viewerZone, setViewerZone] = useState('');
  useEffect(() => {
    setObserved(null); setEditor(null); setDecision(null); setInputError(''); setViewerZone(deviceInterviewTimeZone());
    controller.start(); return () => controller.stop();
  }, [controller]);
  useEffect(() => client.subscribe(() => {
    if (!client.isCurrent()) { setEditor(null); setDecision(null); setInputError(''); setViewerZone(''); }
  }), [client]);
  const state = observed?.client === client && observed.controller === controller ? observed.state : null;
  useEffect(() => { if (state?.lastResult) { setEditor(null); setDecision(null); setInputError(''); } }, [state?.lastResult]);
  if (!client.isCurrent()) return null;
  return <CareerInterviewScene state={state} initialInterviewId={initialInterviewId} editor={editor} setEditor={setEditor}
    decision={decision} setDecision={setDecision} inputError={inputError} setInputError={setInputError}
    viewerZone={viewerZone} setViewerZone={setViewerZone} controller={controller} />;
}
interface SceneProps {
  state: InterviewSnapshot | null; initialInterviewId?: string;
  editor: InterviewEditor | null; setEditor: (v: InterviewEditor | null) => void;
  decision: RecordDecision | null; setDecision: (v: RecordDecision | null) => void;
  inputError: string; setInputError: (v: string) => void;
  viewerZone: string; setViewerZone: (v: string) => void;
  controller: Pick<CareerInterviewController, 'refresh' | 'loadMore' | 'loadApplications' | 'begin' | 'observe' | 'retry'>;
}
function InterviewTime({ record, viewerZone }: { record: Readonly<CareerInterview>; viewerZone: string }) {
  return <div className="interview-times"><p>面试时区 <time dateTime={record.startsAt}>{displayInterviewTime(record.startsAt, record.timeZone)}</time></p>
    <p>你的显示时区 <time dateTime={record.startsAt}>{viewerZone ? displayInterviewTime(record.startsAt, viewerZone) : '请填写显示时区'}</time></p></div>;
}
/** Presentation only; authenticated reads, receipts and uncertain-write recovery
 * stay in the account-bound client/controller. No calendar or model claims. */
export function CareerInterviewScene({ state, initialInterviewId, editor, setEditor, decision, setDecision,
  inputError, setInputError, viewerZone, setViewerZone, controller }: SceneProps) {
  if (!state?.loaded) return <section className="interview-loading"><p role="status">{state?.error || '正在读取你的面试记录…'}</p><button type="button" disabled={state?.busy} onClick={() => void controller.refresh()}>重新读取</button></section>;
  const locked = state.busy || !!state.pending, writeLocked = locked || state.needsRefresh;
  const visible = initialInterviewId ? state.detail ? [state.detail] : [] : state.records;
  const resolution = editor && editor.kind !== 'edit' ? resolveInterviewTime(editor.localTime, editor.timeZone) : null;
  const selected = resolution?.candidates.length === 1 ? resolution.candidates[0].startsAt
    : resolution?.candidates.find(c => c.startsAt === editor?.selectedInstant)?.startsAt ?? '';
  const currentEditorRecord = editor?.record ? state.detail?.id === editor.record.id ? state.detail
    : state.records.find(r => r.id === editor.record!.id) : null;
  const staleEditor = !!editor?.record && currentEditorRecord?.revision !== editor.record.revision;
  const currentDecision = decision ? state.detail?.id === decision.record.id ? state.detail : state.records.find(r => r.id === decision.record.id) : null;
  const staleDecision = !!decision && currentDecision?.revision !== decision.record.revision;
  function update(patch: Partial<InterviewEditor>) { if (editor) { setEditor({ ...editor, ...patch, confirmed: false }); setInputError(''); } }
  function save() {
    if (!editor || writeLocked || staleEditor) return;
    try { controller.begin(interviewEditorIntent(editor, state!.applications, crypto.randomUUID())); setInputError(''); }
    catch (e) { setInputError(e instanceof Error ? e.message : '请核对这次记录。'); }
  }
  function confirmDecision() {
    if (!decision || writeLocked || staleDecision) return;
    controller.begin({ action: decision.kind === 'delete' ? 'delete' : 'status', id: decision.record.id,
      body: { operationId: crypto.randomUUID(), expectedRevision: decision.record.revision, ...(decision.kind === 'delete' ? {} : { status: decision.kind }) } });
  }
  return <section className="interview-panel" aria-labelledby="interview-title">
    <header><p className="interview-eyebrow">旅程 · 你录入的面试</p><h1 id="interview-title">{initialInterviewId ? '这场面试' : '面试安排'}</h1><p>把邀请里的时间记清楚。记录和投递阶段分别由你确认。</p></header>
    <div className="interview-toolbar">
      {!initialInterviewId && <button type="button" disabled={writeLocked} onClick={() => {
        setEditor(interviewDraft('create')); setDecision(null); setInputError(''); void controller.loadApplications();
      }}>记一场面试</button>}
      <button type="button" disabled={state.busy} onClick={() => void controller.refresh()}>重新读取</button>
      <label>你的显示时区（初始取当前设备）<input value={viewerZone} maxLength={100} disabled={locked} placeholder="例如 America/Los_Angeles"
        onChange={e => { setViewerZone(e.target.value); if (editor) setEditor({ ...editor, confirmed: false }); }} /></label>
    </div>
    {state.busy && <p role="status">正在读取或确认…</p>}
    {(inputError || state.error) && <p className="interview-notice" role="alert">{inputError || state.error}</p>}
    {state.lastResult && <p role="status">{state.lastResult.interview ? '这次操作已确认，下面显示当前记录。' : '这次操作已核对；这条面试记录目前已删除。'}</p>}
    {state.uncertain && <div className="interview-actions"><button type="button" disabled={state.busy} onClick={() => void controller.observe()}>核对这次操作</button><button type="button" disabled={state.busy} onClick={() => void controller.retry()}>用原操作重试</button></div>}
    {editor && <form className="interview-editor" onSubmit={e => { e.preventDefault(); save(); }}>
      <h2>{editor.kind === 'create' ? '按邀请记下来' : editor.kind === 'reschedule' ? '确认新的时间' : '修改轮次和时长'}</h2>
      {editor.kind === 'create' && <>
        <label>对应的投递记录<select required value={editor.applicationId} disabled={locked} onChange={e => update({ applicationId: e.target.value })}><option value="">请选择你自己的投递记录</option>
          {state.applications.map(a => <option key={a.id} value={a.id}>{a.job.employer} · {a.job.title}</option>)}</select></label>
        {state.sourceError && <p role="alert">{state.sourceError}</p>}
        {state.applicationsReady && !state.applications.length && <p>还没有投递记录。可以先去<a href="/journey/applications">投递旅程</a>记下岗位。</p>}
        <div className="interview-actions"><button type="button" disabled={locked} onClick={() => void controller.loadApplications()}>重新读取投递记录</button>
          {state.applicationNext && <button type="button" disabled={locked} onClick={() => void controller.loadApplications(true)}>继续读取投递记录</button>}</div>
      </>}
      {editor.record && <p>{editor.record.application.employer} · {editor.record.application.title}</p>}
      {editor.kind !== 'reschedule' && <div className="interview-fields">
        <label>轮次类型<select required value={editor.roundType} disabled={locked} onChange={e => update({ roundType: e.target.value as InterviewEditor['roundType'] })}><option value="">请按邀请选择</option>
          {CAREER_INTERVIEW_ROUND_TYPES.map(k => <option key={k} value={k}>{interviewRoundLabels[k]}</option>)}</select></label>
        <label>时长（分钟）<input required type="text" inputMode="numeric" value={editor.duration} disabled={locked} onChange={e => update({ duration: e.target.value })} /></label>
      </div>}
      {editor.kind !== 'edit' && <>
        <div className="interview-fields"><label>面试邀请里的日期和时间<input required type="datetime-local" step="0.001" value={editor.localTime} disabled={locked}
          onChange={e => update({ localTime: e.target.value, selectedInstant: '' })} /></label>
          <label>面试时区（必须明确选择）<input required value={editor.timeZone} maxLength={100} list="interview-zone-options" disabled={locked} placeholder="例如 America/New_York"
            onChange={e => update({ timeZone: e.target.value, selectedInstant: '' })} /></label></div>
        <datalist id="interview-zone-options">{['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'Asia/Shanghai', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist>
        {resolution?.message && (editor.localTime || editor.timeZone) && <p role="status">{resolution.message}</p>}
        {resolution?.kind === 'ambiguous' && <fieldset className="interview-offsets" disabled={locked}><legend>同一时间的两次出现，请明确选一次</legend>
          {resolution.candidates.map(c => <label key={c.startsAt}><input type="radio" name="interview-offset" checked={editor.selectedInstant === c.startsAt}
            onChange={() => update({ selectedInstant: c.startsAt })} />{c.label}<small>对应 UTC：{c.startsAt}</small></label>)}</fieldset>}
        {selected && <div className="interview-confirm-time"><p>面试时区 <time dateTime={selected}>{displayInterviewTime(selected, editor.timeZone)}</time></p>
          <p>你的显示时区 <time dateTime={selected}>{viewerZone ? displayInterviewTime(selected, viewerZone) : '请填写显示时区'}</time></p><small>保存的 UTC：{selected}</small></div>}
      </>}
      {staleEditor && <p role="alert">这条记录已经变化。<button type="button" disabled={locked || !currentEditorRecord} onClick={() => {
        if (currentEditorRecord) { setEditor(interviewDraft(editor.kind, currentEditorRecord)); setInputError(''); }
      }}>放弃这次修改，用最新记录重新开始</button></p>}
      <label className="interview-confirm-check"><input type="checkbox" checked={editor.confirmed} disabled={locked}
        onChange={e => setEditor({ ...editor, confirmed: e.target.checked })} />我已核对{editor.kind === 'edit' ? '轮次和时长' : '对应岗位、日期和时区'}，确认这次记录</label>
      <div className="interview-actions"><button type="submit" disabled={writeLocked || staleEditor || !editor.confirmed || editor.kind !== 'edit' && !selected}>确认并保存</button>
        <button type="button" disabled={locked} onClick={() => { setEditor(null); setInputError(''); }}>先取消</button></div>
    </form>}
    {decision && <section className="interview-decision" aria-label="确认面试操作">
      <h2>{decision.kind === 'delete' ? '删除这条记录？' : decision.kind === 'done' ? '确认已经面完？' : '确认这场面试已取消？'}</h2>
      <p>{decision.record.application.employer} · {decision.record.application.title} · {interviewRoundLabels[decision.record.roundType]}</p>
      <InterviewTime record={decision.record} viewerZone={viewerZone} />
      <p>{decision.kind === 'delete' ? '保存的这条面试记录会移除。' : '按你确认的状态记下。投递阶段可以在投递旅程里单独修改。'}</p>
      {staleDecision && <p role="alert">记录已变化，请先重新读取并核对。</p>}
      <div className="interview-actions"><button type="button" disabled={writeLocked || staleDecision} onClick={confirmDecision}>确认{decision.kind === 'delete' ? '删除' : decision.kind === 'done' ? '已面完' : '已取消'}</button>
        <button type="button" disabled={locked} onClick={() => setDecision(null)}>先保留</button></div>
    </section>}
    {initialInterviewId && state.detailMissing && <p>这条内容不存在或已经处理。</p>}
    {!initialInterviewId && !state.records.length && !editor && <p className="interview-empty">你还没有记下面试。有邀请时，再把它记在这里。</p>}
    <ul className="interview-records">{visible.map(record => <li key={record.id}>
      <div className="interview-record-heading"><h2>{record.application.employer} · {record.application.title}</h2>
        <span className={'interview-status ' + record.status}>{interviewStatusLabels[record.status]}</span></div>
      <p>{interviewRoundLabels[record.roundType]} · <span className="interview-num">{record.durationMin} min</span></p>
      <InterviewTime record={record} viewerZone={viewerZone} />
      <small>你录入的 · 公司和岗位来自创建时的投递记录</small>
      <div className="interview-actions">
        {!initialInterviewId && <a href={'/journey/interviews/' + record.id}>查看这场面试</a>}
        <a href={applicationHref(record.application.id)}>查看对应的投递记录</a>
        <button type="button" disabled={writeLocked} onClick={() => { setEditor(interviewDraft('edit', record)); setDecision(null); setInputError(''); }}>修改轮次 / 时长</button>
        <button type="button" disabled={writeLocked} onClick={() => { setEditor(interviewDraft('reschedule', record)); setDecision(null); setInputError(''); }}>改期</button>
        <button type="button" disabled={writeLocked} onClick={() => { setDecision({ kind: 'done', record }); setEditor(null); }}>记为已面完</button>
        <button type="button" disabled={writeLocked} onClick={() => { setDecision({ kind: 'cancelled', record }); setEditor(null); }}>记为已取消</button>
        <button type="button" disabled={writeLocked} onClick={() => { setDecision({ kind: 'delete', record }); setEditor(null); }}>删除记录</button>
      </div>
    </li>)}</ul>
    {!initialInterviewId && state.nextAfter && <button type="button" disabled={state.busy} onClick={() => void controller.loadMore()}>继续读取面试</button>}
  </section>;
}
export function CareerInterviewPage({ initialInterviewId, onLogout }: { initialInterviewId?: string; onLogout: () => void }) {
  return <main className="interview-page"><nav aria-label="旅程导航"><a href="/">回到对话</a><a href="/journey/applications">投递旅程</a>
    <a href="/journey/interviews">面试安排</a><a href="/journey/stories">故事库</a><button type="button" onClick={onLogout}>退出登录</button></nav>
    <p className="interview-ai">AI 主理人和队伍 · 你的旅程</p><CareerInterviewPanel initialInterviewId={initialInterviewId} /></main>;
}
