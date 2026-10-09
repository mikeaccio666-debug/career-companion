import {StandaloneStudentHeader} from './app/StudentPageNavigation';
import { MentorRatingProvider } from './mentor-rating-scope-view';
import { MentorRatingPanel } from './mentor-rating-view';
import { useEffect, useMemo, useState } from 'react';
import type { MentorIntent, MentorServiceOffer, MentorOrder } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { MentorIntentController, type MentorSnapshot } from './mentor-intent-controller';
import { freezeMentorMutation } from './mentor-intent-api';
import { MentorHumanEntry } from './mentor-human-entry';
import './mentor-intent-view.css';

export interface MentorEditor {
  readonly offer: Readonly<MentorServiceOffer>; readonly contactName: string; readonly note: string; readonly confirmed: boolean;
}
type Controls = Pick<MentorIntentController, 'refresh'|'loadMore'|'loadOrder'|'begin'|'observe'|'retry'>;
export function MentorIntentPanel() {
  const client = useRequiredPlatformAccountClient();
  const [observed, setObserved] = useState<{client: typeof client; state: MentorSnapshot} | null>(null);
  const [editor, setEditor] = useState<MentorEditor | null>(null);
  const [cancelling, setCancelling] = useState<Readonly<MentorIntent> | null>(null);
  const [inputError, setInputError] = useState('');
  const controller = useMemo(() => new MentorIntentController(client, state => {
    setObserved({client, state});
    if (state.lastResult) { setEditor(null); setCancelling(null); setInputError(''); }
  }), [client]);
  useEffect(() => {
    setObserved(null); setEditor(null); setCancelling(null); setInputError('');
    controller.start();
    const visibility = () => { if (document.hidden || !navigator.onLine) controller.suspend(); else controller.resume(); };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', visibility); window.addEventListener('offline', visibility);
    return () => { controller.stop(); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', visibility); window.removeEventListener('offline', visibility); };
  }, [controller]);
  useEffect(() => client.subscribe(() => {
    if (!client.isCurrent()) { setEditor(null); setCancelling(null); setInputError(''); }
  }), [client]);
  const state = observed?.client === client ? observed.state : null;
  useEffect(() => {
    if (!state?.pending) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [state?.pending]);
  if (!client.isCurrent()) return null;
  return <MentorRatingProvider visibleSessions={state?.loaded && !state.suspended ? state.records.filter(r=>r.status==='completed').map(r=>r.id) : []}><MentorIntentScene state={state} editor={editor} setEditor={setEditor} cancelling={cancelling}
    setCancelling={setCancelling} inputError={inputError} setInputError={setInputError} controller={controller} /></MentorRatingProvider>;
}
export function mentorTime(at: string, timeZone?: string): string {
  try { return new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',
    timeZoneName:'short', ...(timeZone ? {timeZone} : {})}).format(new Date(at)); } catch { return at + ' · UTC'; }
}
export function mentorPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}).format(cents/100);
}
export function MentorServiceCard({offer, disabled, onChoose}: {
  offer: Readonly<MentorServiceOffer>; disabled: boolean; onChoose: () => void;
}) {
  return <article className="mentor-service-card" aria-label={offer.title}>
    <header><span className="mentor-human-tag">真人 · 蔓藤导师</span><h2>{offer.title}</h2></header>
    <section><h3>你付的是什么</h3><p>{offer.description}</p></section>
    <section><h3>不包含什么</h3><p>{offer.exclusions}</p><p>不承诺面试或 offer，不包含内推服务。</p></section>
    <section><h3>价格、时长与收款方</h3><dl className="mentor-service-facts">
      <div><dt>价格</dt><dd className="mentor-num">{mentorPrice(offer.priceCents)} USD</dd></div>
      <div><dt>时长</dt><dd className="mentor-num">{offer.durationMin} min</dd></div>
      <div><dt>收款方</dt><dd>{offer.collector}</dd></div>
    </dl></section>
    <section><h3>退款与申诉</h3><p>{offer.refundRules}</p><p>{offer.appealInstructions}</p></section>
    <section><h3>利益关系</h3><p>{offer.disclosure}</p></section>
    <section><h3>对方能看到什么</h3><p>{offer.intentPrivacy}</p></section>
    <section><h3>可约安排</h3>{offer.availability === 'available' && offer.earliestSlotAt
      ? <p>最早可约：<time className="mentor-num" dateTime={offer.earliestSlotAt}>{mentorTime(offer.earliestSlotAt)}</time></p>
      : <p>目前没有确认的可约时段。</p>}<p>提交意向后，由运营人工匹配并确认安排与报价。</p></section>
    <button type="button" className="mentor-primary" disabled={disabled || offer.availability !== 'available'} onClick={onChoose}>我想约一次</button>
  </article>;
}
function mentorOrderNotice(order:Readonly<MentorOrder>,session?:Readonly<MentorIntent>):string {
  if(order.status==='void')return '这份报价已作废。';
  if(order.status==='refunded_partial')return '已记录部分退款。';
  if(order.status==='refunded_full')return '已记录全额退款。';
  if(order.status==='paid'){
    if(session?.status==='completed')return '已记录线下收款，真人服务已完成。';
    if(session?.status==='scheduled')return '已记录线下收款，预约时间已确认。';
    if(session?.status==='cancelled')return '已记录线下收款，预约已取消；退款情况请以此处订单记录为准。';
    return '已记录线下收款，排期待确认。';
  }
  if(session?.status==='completed')return '真人服务已完成，尚无收款记录。';
  return session?.status==='scheduled'?'报价已记录，预约时间已确认；付款记录请以此处订单状态为准。':'报价已记录，付款安排和排期待运营确认。';
}
export function MentorQuoteCard({order,session}: {order: Readonly<MentorOrder>;session?:Readonly<MentorIntent>}) {
  const offer = order.shownOffer;
  return <article className="mentor-service-card" aria-label="这份请求的报价">
    <header><span className="mentor-human-tag">真人 · 蔓藤导师</span><h2>{offer.title} · 报价</h2></header>
    <p className="mentor-system-notice" role="status">系统 · {mentorOrderNotice(order,session)}</p>
    <section><h3>你付的是什么</h3><p>{offer.description}</p></section>
    <section><h3>不包含什么</h3><p>{offer.exclusions}</p><p>不承诺面试或 offer，不包含内推服务。</p></section>
    <section><h3>报价、时长与收款方</h3><dl className="mentor-service-facts">
      <div><dt>这份报价</dt><dd className="mentor-num">{mentorPrice(order.priceCents)} USD</dd></div>
      <div><dt>时长</dt><dd className="mentor-num">{offer.durationMin} min</dd></div>
      <div><dt>收款方</dt><dd>{offer.collector}</dd></div>
    </dl></section>
    {order.payment && <p className="mentor-num">已记录收款：{mentorPrice(order.priceCents)} USD · 累计退款：{mentorPrice(order.payment.refundedCents)} USD</p>}
    <section><h3>退款与申诉</h3><p>{offer.refundRules}</p><p>{offer.appealInstructions}</p></section>
    <section><h3>利益关系</h3><p>{offer.disclosure}</p></section>
    <section><h3>对方能看到什么</h3><p>{offer.intentPrivacy}</p></section>
  </article>;
}
interface SceneProps {
  state: MentorSnapshot | null; editor: MentorEditor | null; setEditor: (v: MentorEditor | null) => void;
  cancelling: Readonly<MentorIntent> | null; setCancelling: (v: Readonly<MentorIntent> | null) => void;
  inputError: string; setInputError: (v: string) => void; controller: Controls;
}
const serviceLabels = {mock_interview:'模拟面试',resume_direction:'简历与方向',offer_negotiation:'Offer 比较与沟通'};
function MentorOperationStatus({state,controller}: {state: MentorSnapshot; controller: Controls}) {
  return <>
    {state.pending && state.uncertain && <div className="mentor-notice">
      <p>提交结果还没确认，请先核对这次操作。</p><div className="mentor-actions">
        <button type="button" disabled={state.busy} onClick={() => void controller.observe()}>核对这次操作</button>
        <button type="button" disabled={state.busy} onClick={() => void controller.retry()}>用原操作重试</button>
      </div>
    </div>}
    {state.lastResult && <p className="mentor-notice" role="status">{state.lastResult.session.status === 'cancelled'
      ? '这份意向已取消。' : state.lastResult.session.status === 'completed' ? '这次真人服务已完成。' : state.lastResult.session.status === 'scheduled' ? '已约好，请查看确认时间与会议链接。' : state.lastResult.session.status === 'matched' ? '已匹配蔓藤导师（真人），请查看报价；排期仍待确认。' : '收到了，预计 48 小时内由运营为你匹配蔓藤导师（真人）。'}</p>}
  </>;
}
export function MentorIntentScene({state,editor,setEditor,cancelling,setCancelling,inputError,setInputError,controller}: SceneProps) {
  if (state?.suspended) return <section className="mentor-loading"><p role="status">页面暂时暂停读取。回来后会重新核对服务与请求。</p></section>;
  if (!state?.loaded || !state.entry) return <section className="mentor-loading">
    <p role="status">{state?.error || '正在读取真人服务与请求…'}</p>
    <button type="button" disabled={state?.busy} onClick={() => void controller.refresh()}>重新读取</button>
    {state && <MentorOperationStatus state={state} controller={controller} />}
  </section>;
  const locked = state.busy || !!state.pending || state.needsRefresh;
  const currentOffer = editor ? state.entry.offers.find(o => o.id === editor.offer.id) : null;
  const staleEditor = !!editor && (!currentOffer || currentOffer.revision !== editor.offer.revision || currentOffer.availability !== 'available');
  const currentCancellation = cancelling ? state.records.find(r => r.id === cancelling.id) : null;
  const staleCancellation = !!cancelling && (!currentCancellation || currentCancellation.revision !== cancelling.revision || !['requested','matched'].includes(currentCancellation.status));
  function submit() {
    if (!editor || !state?.entry || locked || staleEditor) return;
    try {
      controller.begin(freezeMentorMutation({action:'create',sessionId:null,body:{
        operationId:crypto.randomUUID(),offerId:editor.offer.id,offerRevision:editor.offer.revision,
        contactName:editor.contactName,intentNote:editor.note,privacyVersion:state.entry.privacyVersion,confirmVisibility:editor.confirmed,
      }})); setInputError('');
    } catch { setInputError('请填写称呼和想聊的内容，并确认运营能看到的信息。'); }
  }
  return <section className="mentor-panel" aria-labelledby="mentor-title">
    <header><p className="mentor-eyebrow">真人与社区</p><h1 id="mentor-title">蔓藤导师（真人）</h1>
      <p>付费服务 · 看不到你的对话</p></header>
    <div className="mentor-actions"><button type="button" disabled={state.busy} onClick={() => void controller.refresh()}>重新读取服务与请求</button></div>
    {state.busy && <p role="status">正在读取或确认…</p>}
    {(state.error || inputError) && <p className="mentor-notice" role="alert">{inputError || state.error}</p>}
    <MentorOperationStatus state={state} controller={controller} />
    {!state.entry.configured || !state.entry.offers.length
      ? <p className="mentor-empty">真人服务当前暂无可预约的安排。你可以回到主理人继续聊，也可以稍后重新查看。</p>
      : <div className="mentor-service-list">{state.entry.offers.map(offer => <MentorServiceCard key={offer.id} offer={offer}
          disabled={locked || !!cancelling} onChoose={() => {setEditor({offer,contactName:editor?.contactName ?? '',note:editor?.note ?? '',confirmed:false});setInputError('');}} />)}</div>}
    {editor && <form className="mentor-editor" aria-labelledby="mentor-editor-title" onSubmit={event => {event.preventDefault();submit();}}>
      <h2 id="mentor-editor-title">你想和真人聊什么？</h2><p>服务：{editor.offer.title} · <span className="mentor-num">{mentorPrice(editor.offer.priceCents)}</span></p>
      {staleEditor && <div className="mentor-notice" role="alert"><p>这项服务已有变化。请重新阅读上方最新说明，再重新选择服务并确认。</p></div>}
      <label>你希望运营怎么称呼你<input autoComplete="off" value={editor.contactName} maxLength={100} disabled={locked}
        onChange={event => setEditor({...editor,contactName:event.target.value})} /></label>
      <p>联系邮箱：<span className="mentor-email">{state.entry.contactEmail}</span></p>
      <label>你自己写的需求<textarea value={editor.note} maxLength={4000} rows={5} disabled={locked}
        onChange={event => setEditor({...editor,note:event.target.value})} /></label>
      <p className="mentor-privacy">{state.entry.intentPrivacy}</p>
      <label className="mentor-checkbox"><input type="checkbox" checked={editor.confirmed} disabled={locked || staleEditor}
        onChange={event => setEditor({...editor,confirmed:event.target.checked})} /><span>我确认将上述称呼、邮箱和我写的需求提供给蔓藤运营。</span></label>
      <div className="mentor-actions"><button type="submit" className="mentor-primary"
        disabled={locked || staleEditor || !editor.confirmed || !editor.contactName.trim() || !editor.note.trim()}>确认并提交意向</button>
        <button type="button" disabled={state.busy || !!state.pending} onClick={() => {setEditor(null);setInputError('');}}>先不提交</button></div>
    </form>}
    {cancelling && <section className="mentor-cancel" aria-label="确认取消预约意向"><p>取消这份「{serviceLabels[cancelling.kind]}」意向？</p>
      <div className="mentor-actions">{staleCancellation && <p role="alert">请求已有变化，请先重新读取并选择当前意向。</p>}<button type="button" disabled={locked || staleCancellation} onClick={() => controller.begin(freezeMentorMutation({
        action:'cancel',sessionId:cancelling.id,body:{operationId:crypto.randomUUID(),expectedRevision:cancelling.revision},
      }))}>确认取消这份意向</button><button type="button" disabled={state.busy || !!state.pending} onClick={() => setCancelling(null)}>保留</button></div>
    </section>}
    {state.quote && <MentorQuoteCard order={state.quote.order} session={state.quote.session} />}
    <section className="mentor-history" aria-labelledby="mentor-history-title"><h2 id="mentor-history-title">我的请求</h2>
      {!state.records.length && <p>你还没有提交真人服务意向。</p>}
      <ul>{state.records.map(record => <li key={record.id}>
        <div className="mentor-record-heading"><h3>{serviceLabels[record.kind]}</h3>
          <span className={'mentor-session-status '+record.status}>{record.status === 'requested' ? '已提交意向' : record.status === 'matched' ? '已匹配 · 排期待确认' : record.status === 'scheduled' ? '已约好' : record.status === 'completed' ? '已完成' : '已取消'}</span></div>
        <p className="mentor-private-note">{record.intentNote}</p>
        <p className="mentor-record-contact">称呼：{record.contactName} · 邮箱：{record.contactEmail}</p>
        <time className="mentor-num" dateTime={record.createdAt}>{mentorTime(record.createdAt)}</time>
        {record.status === 'requested' && <p>等待人工匹配与报价。</p>}
        {record.assignment && <p>匹配导师：{record.assignment.mentorDisplayName}（真人）<br />{record.scheduled?'确认时间：':'建议时段：'}<time className="mentor-num" dateTime={record.assignment.startsAt}>{mentorTime(record.assignment.startsAt,record.assignment.timeZone)}</time> · {record.assignment.timeZone}</p>}
        {record.status === 'matched' && <p>报价已记录，付款安排和排期待运营确认。</p>}
        {record.status==='scheduled'&&record.scheduled&&<p className="mentor-system-notice">系统 · 已约好。<a href={record.scheduled.meetingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开会议链接</a><br />需要取消或改期时，请联系为你确认预约的运营；退款按原服务说明人工处理。</p>}
        {record.status==='completed'&&record.completedAt&&<><p className="mentor-system-notice">系统 · 真人服务已完成。</p><MentorRatingPanel sessionId={record.id}/></>}
        {record.orderId && <button type="button" disabled={locked} onClick={() => void controller.loadOrder(record.id)}>查看报价</button>}
        {['requested','matched'].includes(record.status) && <button type="button" disabled={locked || !!editor}
          onClick={() => setCancelling(record)}>取消这份意向</button>}
      </li>)}</ul>
      {state.nextCursor && <button type="button" disabled={locked} onClick={() => void controller.loadMore()}>查看更早的请求</button>}
    </section>
  </section>;
}
export function MentorIntentPage({onLogout}: {onLogout:() => void}) {
  return <div className="mentor-page career-surface">
    <aside className="mentor-sidebar"><nav aria-label="个人导航"><a href="/">回到主理人 · AI</a><a href="/me/profile">我</a></nav>
      <section className="mentor-human-group" aria-label="真人与社区"><h2>真人与社区</h2><MentorHumanEntry current /></section></aside>
    <main><StandaloneStudentHeader className="mentor-page-header"><span>AI 主理人与队伍 · 真人服务入口</span>
      <button type="button" onClick={onLogout}>退出登录</button></StandaloneStudentHeader><MentorIntentPanel /></main>
  </div>;
}
