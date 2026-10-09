import { useEffect, useRef, useState } from 'react';
import type { TodayWeeklyActivity } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { JourneySectionController, type JourneySectionState } from './journey-section-controller';
import { readTodayWeekly } from './today-weekly-api';

export function TodayWeeklyContent({view}:{view:Readonly<TodayWeeklyActivity>}){
 return <section className="today-weekly" aria-label="本周你做了什么">
  <h2>本周你做了什么</h2>
  <p><time dateTime={view.weekStart}>{view.weekStart}</time> — <time dateTime={view.localDate}>{view.localDate}</time> · {view.timeZone}</p>
  <dl className="today-weekly-counts">
   <div><dt>练习题目</dt><dd>暂未开放</dd></div>
   <div><dt>改过的故事</dt><dd>{view.storiesEdited}<span> 个</span></dd></div>
   <div><dt>确认过的简历</dt><dd>{view.resumesConfirmed}<span> 份</span></dd></div>
  </dl>
  {view.storiesEdited===0&&view.resumesConfirmed===0&&<p>这周还没有故事修改或简历确认记录。</p>}
  <p>按你保存的操作记录统计。同一故事或简历本周只算一次，删除后不再计入。练习功能开放后，再记录练习次数。</p>
  <div className="companion-settings-actions"><a href="/journey/stories">查看故事库</a><a href="/pending">查看简历</a></div>
 </section>;
}
export function TodayWeeklyPanel({ suspended = false }: { suspended?: boolean }) {
  const client = useRequiredPlatformAccountClient();
  const [unavailable, setUnavailable] = useState(() => !navigator.onLine || document.visibilityState === 'hidden');
  const [observed, setObserved] = useState<{ client: typeof client; state: JourneySectionState<Readonly<TodayWeeklyActivity>> } | null>(null);
  const controller = useRef<JourneySectionController<Readonly<TodayWeeklyActivity>> | null>(null);
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
    const c = new JourneySectionController(client, signal => readTodayWeekly(client, signal), state => setObserved({ client, state }));
    controller.current = c; c.start();
    return () => { c.stop(); if (controller.current === c) controller.current = null; };
  }, [client, suspended, unavailable]);
  const state = !suspended && !unavailable && client.isCurrent() && observed?.client === client ? observed.state : null;
  return <div className="today-agenda-group">
    {state?.busy && <p role="status">正在读取本周记录…</p>}
    {state?.failed && <p role="alert">本周记录暂时没读到，请重新读取。</p>}
    {state?.value && <TodayWeeklyContent view={state.value}/>}
    {unavailable ? <p role="status">回到页面并恢复连接后，再读取本周记录。</p> : <button type="button" disabled={suspended || !client.isCurrent() || state?.busy} onClick={() => void controller.current?.refresh()}>重新读取本周记录</button>}
  </div>;
}
