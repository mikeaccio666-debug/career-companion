import { useEffect, useRef, useState } from 'react';
import type { TodayAgenda } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { JourneySectionController, type JourneySectionState } from './journey-section-controller';
import { readTodayAgenda } from './today-agenda-api';
import { displayInterviewTime } from './career-interview-time';

export function TodayAgendaContent({ view, hidePending = false }: { view: Readonly<TodayAgenda>; hidePending?: boolean }) {
  return <>
    {view.events.length > 0 && <section className="today-agenda" aria-label="今天的日程">
      <h2>今天的日程</h2><p>按你保存的面试安排和岗位截止时间显示。</p>
      <ul>{view.events.map(event => <li key={event.kind + ':' + event.id}>
        <span className="today-state">{event.kind === 'interview' ? '面试' : '岗位截止'}</span>
        <h3>{event.employer} · {event.title}</h3>
        <p><time dateTime={event.at}>{displayInterviewTime(event.at, view.timeZone)}</time><span> · 你的时区</span></p>
        {event.timeZone !== view.timeZone && <p><time dateTime={event.at}>{displayInterviewTime(event.at, event.timeZone)}</time><span> · 原记录时区</span></p>}
        {event.endsAt && <p>结束：<time dateTime={event.endsAt}>{displayInterviewTime(event.endsAt, view.timeZone)}</time></p>}
        {event.kind === 'job_deadline' && <p>来自你保存的岗位，开放状态请以招聘页面为准。</p>}
        <a href={event.kind === 'interview' ? '/journey/interviews/' + event.id : '/journey/jobs'}>{event.kind === 'interview' ? '查看面试安排' : '查看岗位收藏'}</a>
      </li>)}</ul>
    </section>}
    {!hidePending && view.pending && <section className="today-agenda" aria-label="待你确认的简历">
      <h2>待你确认的简历</h2>
      {view.pending.count === 0 ? <p>没有待你确认的简历。</p> : <>
        <p className="today-pending-count">{view.pending.count} <span>份</span></p>
        <p>最早到期：<time dateTime={view.pending.earliestExpiresAt!}>{displayInterviewTime(view.pending.earliestExpiresAt!, view.timeZone)}</time></p>
        <a href="/pending">去确认</a>
      </>}
    </section>}
  </>;
}
export function TodayAgendaPanel({ suspended = false, hidePending = false }: { suspended?: boolean; hidePending?: boolean }) {
  const client = useRequiredPlatformAccountClient();
  const [unavailable, setUnavailable] = useState(() => !navigator.onLine || document.visibilityState === 'hidden');
  const [observed, setObserved] = useState<{ client: typeof client; state: JourneySectionState<Readonly<TodayAgenda>> } | null>(null);
  const controller = useRef<JourneySectionController<Readonly<TodayAgenda>> | null>(null);
  useEffect(() => {
    const clear = () => { controller.current?.stop(); setObserved(null); setUnavailable(true); };
    const resume = () => setUnavailable(!navigator.onLine || document.visibilityState === 'hidden');
    const visible = () => document.visibilityState === 'hidden' ? clear() : resume();
    window.addEventListener('offline', clear); window.addEventListener('online', resume); document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('offline', clear); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => {
    setObserved(null);
    if (suspended || unavailable || !client.isCurrent()) return;
    const c = new JourneySectionController(client, signal => readTodayAgenda(client, signal), state => setObserved({ client, state }));
    controller.current = c; c.start();
    return () => { c.stop(); if (controller.current === c) controller.current = null; };
  }, [client, suspended, unavailable]);
  const state = !suspended && !unavailable && client.isCurrent() && observed?.client === client ? observed.state : null;
  return <div className="today-agenda-group">
    {state?.busy && <p role="status">正在读取今天的日程与待确认记录…</p>}
    {state?.failed && <p role="alert">日程与待确认记录暂时没读到，请重新读取。</p>}
    {state?.value && <TodayAgendaContent view={state.value} hidePending={hidePending}/>}
    {unavailable ? <p role="status">回到页面并恢复连接后，再读取日程。</p> : <button type="button" disabled={suspended || !client.isCurrent() || state?.busy} onClick={() => void controller.current?.refresh()}>重新读取日程与待确认</button>}
  </div>;
}
