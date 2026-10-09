import { useEffect, useRef, useState } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { CareerProgressController, type CareerProgressState } from './career-progress-controller';
import './career-progress-view.css';
export function CareerProgressPanel({ suspended = false }: { suspended?: boolean }) {
    const client = useRequiredPlatformAccountClient();
    const [unavailable, setUnavailable] = useState(() => !navigator.onLine || document.visibilityState === 'hidden');
    const [view, setView] = useState<{ client: typeof client; state: CareerProgressState } | null>(null);
    const controller = useRef<CareerProgressController | null>(null);
    useEffect(() => {
        const clear = () => { controller.current?.stop(); setView(null); setUnavailable(true); };
        const resume = () => setUnavailable(!navigator.onLine || document.visibilityState === 'hidden');
        const visibility = () => document.visibilityState === 'hidden' ? clear() : resume();
        window.addEventListener('offline', clear); window.addEventListener('online', resume); document.addEventListener('visibilitychange', visibility);
        return () => { window.removeEventListener('offline', clear); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', visibility); };
    }, []);
    useEffect(() => {
        setView(null);
        if (suspended || unavailable || !client.isCurrent()) return;
        const c = new CareerProgressController(client, state => setView({ client, state })); controller.current = c; c.start();
        return () => { c.stop(); if (controller.current === c) controller.current = null; };
    }, [client, suspended, unavailable]);
    const state = !suspended && !unavailable && client.isCurrent() && view?.client === client ? view.state : null;
    const progress = state?.value?.progress;
    return <section className="career-surface career-progress-panel" aria-label="本人成长记录">
        <header><h2>你留下的求职记录</h2><span>Career Companion · AI</span></header>
        <p>记录做过的事，方便回看；数量不代表技能水平或求职结果。</p>
        {unavailable ? <p role="status">恢复连接并回到页面后，再读取你的记录。</p> : suspended ? <p role="status">当前记录正在处理，核对完成后再更新这里。</p> : <>
            <button type="button" disabled={state?.busy || !client.isCurrent()} onClick={() => void controller.current?.refresh()}>重新读取成长记录</button>
            {state?.busy && <p role="status">正在核对已保存的项目、投递和面试记录…</p>}
            {state?.error && <p role="alert">{state.error}</p>}
            {progress && <>
                {progress.counts.project + progress.provisionalCounts.project + progress.provisionalCounts.application + progress.provisionalCounts.interview === 0 && <p>还没有保存的项目、投递声明或面试完成记录。可以先记下一段课程经历，或者更新旅程中的记录。</p>}
                <dl className="career-progress-counts">
                    <div><dt>已由你确认的项目</dt><dd>{progress.counts.project}<span> 项</span></dd></div>
                    <div><dt>待你核对的项目</dt><dd>{progress.provisionalCounts.project}<span> 项</span></dd></div>
                    <div><dt>由你记录已投</dt><dd>{progress.provisionalCounts.application}<span> 份</span></dd></div>
                    <div><dt>由你记录完成的面试</dt><dd>{progress.provisionalCounts.interview}<span> 场</span></dd></div>
                </dl>
                {progress.milestones.includes('first_project_evidence') && <p className="career-progress-milestone">你已确认了一段项目事实，可以回到项目里继续完善。</p>}
                <p>这里只统计当前保存的项目、投递声明与标为已完成的面试。确认项目是你核对过事实；已投和面试完成来自你的记录，尚未通过外部系统核实。改期、取消或移除面试后，数量会随当前记录更新。</p>
                <p>练习、导师评阅和外联等其他经历暂未包含；面试记录不代表通过面试。</p>
            </>}
        </>}
        <nav aria-label="成长记录来源"><a href="/journey/stories">查看项目与故事</a><a href="/journey/applications">查看投递记录</a><a href="/journey/interviews">查看面试记录</a></nav>
    </section>;
}
