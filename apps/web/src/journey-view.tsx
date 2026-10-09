import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import type { BoundPlatformClient } from './api';
import { useRequiredPlatformAccountClient } from './account-client';
import { BRAND } from './brand';
import { journeyReads } from './journey-api';
import { JourneySectionController, type JourneySectionState } from './journey-section-controller';
import { ApplicationBoard } from './application-board';
import { CareerProgressPanel } from './career-progress-view';
import { interviewRoundLabels, interviewStatusLabels } from './career-interview-presentation';
import { displayInterviewTime } from './career-interview-time';
import './career-design-tokens.css';
import './journey-view.css';

const targetLabels = { exploring: '还在比较', active: '暂定主攻', paused: '先暂停', dropped: '已放下' };
const tracks = { swe: '软件工程', mle: '机器学习工程', ds: '数据科学', da: '数据分析', de: '数据工程', hw: '硬件等本专业方向', other: '其他方向' };
const resumeLabels = { pending: '等你确认', approved: '已确认', declined: '不要了', expired: '过期了', superseded: '已被替换' };
const mentorLabels = { requested: '已登记 · 等运营联系', matched: '已匹配蔓藤导师', scheduled: '已约好', completed: '已完成', cancelled: '已取消' };
const serviceLabels = { mock_interview: '模拟面试', resume_direction: '简历与方向', offer_negotiation: 'Offer 谈判' };
function subscribeVisibility(change: () => void) {
  window.addEventListener('online', change); window.addEventListener('offline', change); document.addEventListener('visibilitychange', change);
  return () => { window.removeEventListener('online', change); window.removeEventListener('offline', change); document.removeEventListener('visibilitychange', change); };
}
const visibleOnline = () => navigator.onLine && document.visibilityState !== 'hidden';

function JourneySection<T>({ title, href, read, children }: {
  title: string; href: string;
  read: (client: BoundPlatformClient, signal: AbortSignal) => Promise<T>;
  children: (value: T) => ReactNode;
}) {
  const client = useRequiredPlatformAccountClient();
  const [observed, setObserved] = useState<{ controller: JourneySectionController<T>; state: JourneySectionState<T> } | null>(null);
  const controller = useMemo(() => {
    const next = new JourneySectionController(client, signal => read(client, signal), state => setObserved({ controller: next, state }));
    return next;
  }, [client, read]);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  if (!client.isCurrent()) return null;
  const state = observed?.controller === controller ? observed.state : null;
  return <section className="journey-section" aria-label={title}>
    <header><h2>{title}</h2><a href={href}>查看与整理<ArrowUpRight size={16} aria-hidden="true" /></a></header>
    <button className="journey-refresh" type="button" disabled={!state || state.busy} onClick={() => void controller.refresh()}>重新读取{title}</button>
    {(!state || state.busy) && <p role="status">正在读取你的记录…</p>}
    {state?.failed && <p role="alert">这部分记录暂时没读到，请重新读取。其他部分可以继续查看。</p>}
    {state?.value != null && children(state.value)}
  </section>;
}
function PageNote({ more }: { more: boolean }) {
  return <p className="journey-page-note">{more ? '这里只显示本次读取的一页，还有记录。点「查看与整理」继续读取。' : '以上是本次读取到的记录。'}</p>;
}
function JourneyRecords() {
  return <>
    <JourneySection title="目标方向" href="/journey/targets" read={journeyReads.targets}>{targets => <>
      {targets.length === 0 && <p>方向还可以慢慢比较。先记下一个想了解的方向。</p>}
      <ul className="journey-cards">{targets.map(target => <li key={target.id}>
        <h3>{target.title}</h3><span className="journey-tag">{targetLabels[target.status]}</span>
        <p>{tracks[target.roleFamily]}{target.locations.length > 0 ? ' · ' + target.locations.join('、') : ''}</p>
        <p>复看日期：{target.reviewOn ?? '还没定'}</p>
      </li>)}</ul>
    </>}</JourneySection>
    <JourneySection title="投递看板" href="/journey/applications" read={journeyReads.applications}>{page => <>
      <p>按你记录的阶段整理。数字只表示下面已读取的记录。</p>
      {page.applications.length === 0 && <p>还没有投递记录。<a href="/journey/jobs">收藏一个岗位</a>，再从收藏建立记录。</p>}
      <ApplicationBoard rows={page.applications}/><PageNote more={page.nextAfter !== null}/>
    </>}</JourneySection>
    <div className="journey-details-grid">
      <JourneySection title="面试安排" href="/journey/interviews" read={journeyReads.interviews}>{page => <>
        {page.interviews.length === 0 && <p>还没有记下面试安排。有消息时，把时间和轮次记在这里。</p>}
        <ul className="journey-rows">{page.interviews.map(record => <li key={record.id}>
          <h3><a href={'/journey/interviews/' + record.id}>{record.application.employer} · {record.application.title}</a></h3>
          <p>{interviewRoundLabels[record.roundType]} · <span className="journey-tag">{interviewStatusLabels[record.status]}</span></p>
          <time dateTime={record.startsAt}>{displayInterviewTime(record.startsAt, record.timeZone)}</time><p>{record.durationMin} 分钟 · 你记录的安排</p>
        </li>)}</ul><PageNote more={page.nextAfter !== null}/>
      </>}</JourneySection>
      <JourneySection title="故事库" href="/journey/stories" read={journeyReads.stories}>{page => <>
        {page.records.length === 0 && <p>还没有故事。先记下一段课程、项目或实习经历。</p>}
        <ul className="journey-rows">{page.records.map(({ record, evidenceAvailability }) => <li key={record.id}>
          <h3><a href={'/journey/stories/' + record.id}>{record.title}</a></h3>
          <p>{'status' in record && record.status === 'confirmed' ? '你已确认这版故事' : '草稿 · 待你核对'}</p>
          {evidenceAvailability !== 'current' && <p>关联证据需要再核对。</p>}
        </li>)}</ul><PageNote more={page.nextAfter !== null}/>
      </>}</JourneySection>
      <JourneySection title="简历版本" href="/pending" read={journeyReads.resumes}>{page => <>
        {page.items.length === 0 && <p>还没有简历。上传一份，或者贴文字。</p>}
        <ul className="journey-rows">{page.items.map(item => <li key={item.id}>
          <h3><a href={'/pending/' + item.id}>{item.label} · v{item.sequence}</a></h3>
          <p>{tracks[item.track]} · {resumeLabels[item.status]} · {({ draft: '草稿', active: '可用版本', archived: '已归档' })[item.resumeStatus]}</p>
          <p>{item.source === 'paste' ? '你粘贴的原稿' : item.source === 'upload' ? '你上传的原稿' : '从已确认版本另存的修改版'}</p>
          {item.derivedFrom && <a href={'/pending/' + item.derivedFrom.pendingItemId}>查看来源版本</a>}
        </li>)}</ul><PageNote more={page.nextAfter !== null}/>
      </>}</JourneySection>
      <JourneySection title="真人服务" href="/me/mentors" read={journeyReads.mentors}>{page => <>
        {page.sessions.length === 0 && <p>还没有登记真人服务意向。需要时可以查看蔓藤的服务说明。</p>}
        <ul className="journey-rows">{page.sessions.map(session => <li key={session.id}>
          <h3>{serviceLabels[session.kind]} · 真人</h3><p>{mentorLabels[session.status]}</p>
          {session.assignment && <><p>{session.assignment.mentorDisplayName}</p><time dateTime={session.assignment.startsAt}>{displayInterviewTime(session.assignment.startsAt, session.assignment.timeZone)}</time></>}
          <p>{session.durationMin} 分钟</p>
        </li>)}</ul><PageNote more={page.nextCursor !== null}/>
      </>}</JourneySection>
    </div>
    <CareerProgressPanel/>
  </>;
}
export function JourneyPage({ onLogout }: { onLogout: () => void }) {
  const client = useRequiredPlatformAccountClient();
  const available = useSyncExternalStore(subscribeVisibility, visibleOnline, () => false);
  return <main className="career-surface journey-page" aria-labelledby="journey-title">
    <nav className="journey-nav" aria-label="旅程导航"><a href="/"><ArrowLeft size={18} aria-hidden="true"/>回到首页</a><a href="/today">今天</a><a href="/me">我</a><span>{BRAND.name} · AI</span>
      {client.isCurrent() && available && <button type="button" onClick={() => { if (client.isCurrent()) onLogout(); }}>退出登录</button>}
    </nav>
    <header className="journey-heading"><h1 id="journey-title">你的求职旅程</h1><p>想清楚一点，准备好一点。回到你的记录，接着做下一步。</p></header>
    {!client.isCurrent() ? <p role="status">账号状态已变化，请<a href="/">重新确认账号</a>。</p> : !available ? <p role="status">回到页面并恢复连接后，再读取你的旅程。</p> : <JourneyRecords/>}
  </main>;
}
