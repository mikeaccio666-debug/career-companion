import { useEffect, useRef, useState } from 'react';
import type { ResumeReviewDiff, ResumeReviewItem } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { readResumeDiff } from './resume-diff-api';
import './resume-diff-view.css';
export function ResumeDiffContent({ diff }: { diff: Readonly<ResumeReviewDiff> }) {
    const { prefix, removed, added, suffix } = diff.text;
    if (!removed && !added) return <p>两次保存的正文相同。版本名称等其他信息不在这次正文对比中。</p>;
    return <><p>下面标出内容有变化的区段；区段中也可能包含未变的文字。这里不判断事实是否准确，请对照全文核对。</p><div className="resume-diff-desktop"><section aria-label={'修改前 r' + diff.from.revision}><h4>修改前 · r{diff.from.revision}</h4><pre>{prefix}<del>{removed}</del>{suffix}</pre></section><section aria-label={'修改后 r' + diff.to.revision}><h4>修改后 · r{diff.to.revision}</h4><pre>{prefix}<ins>{added}</ins>{suffix}</pre></section></div><div className="resume-diff-mobile"><p>r{diff.from.revision} → r{diff.to.revision} · 删除加删除线，新增加下划线</p><pre>{prefix}{removed && <del aria-label="修改前的变化区段">{removed}</del>}{removed && added && '\n'}{added && <ins aria-label="修改后的变化区段">{added}</ins>}{suffix}</pre></div></>;
}
/** Mounted with immutable item coordinates; private text never survives a
 * version/account change or a closed comparison. Read-only and page-memory. */
export function ResumeDiffPanel({ item, disabled }: { item: Readonly<ResumeReviewItem>; disabled: boolean }) {
    const client = useRequiredPlatformAccountClient();
    const [opened, setOpened] = useState(false), [from, setFrom] = useState(String(Math.max(1, item.revision - 1)));
    const [view, setView] = useState<{ client: typeof client; diff: Readonly<ResumeReviewDiff> | null; busy: boolean; error: string }>({ client, diff: null, busy: false, error: '' });
    const epoch = useRef(0), active = useRef(true), request = useRef<AbortController | null>(null);
    const reset = () => { epoch.current++; request.current?.abort(); request.current = null; setView({ client, diff: null, busy: false, error: '' }); };
    useEffect(() => { active.current = true; const clear = () => { reset(); setOpened(false); }; const unsubscribe = client.subscribe(() => { if (!client.isCurrent()) clear(); }); window.addEventListener('offline', clear); return () => { active.current = false; epoch.current++; request.current?.abort(); request.current = null; unsubscribe(); window.removeEventListener('offline', clear); }; }, [client]);
    useEffect(() => { if (disabled) reset(); }, [disabled]);
    const state = client.isCurrent() && view.client === client ? view : { diff: null, busy: false, error: '' };
    async function load() {
        if (!active.current || !client.isCurrent() || request.current || disabled || !/^[1-9][0-9]{0,9}$/.test(from)) return;
        const number = Number(from); if (number >= item.revision) { setView({ client, diff: null, busy: false, error: '请选择早于当前正文的版本。' }); return; }
        const c = new AbortController(), n = ++epoch.current; request.current = c; setView({ client, diff: null, busy: true, error: '' });
        let cancel: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(new DOMException('Interrupted', 'AbortError')); c.signal.addEventListener('abort', cancel, { once: true }); });
        const timer = setTimeout(() => c.abort(), 8000);
        try { const diff = await Promise.race([readResumeDiff(client, { itemId: item.id, from: number, to: item.revision, currentRevision: item.revision, currentDigest: item.payloadDigest }, c.signal), interrupted]); if (active.current && client.isCurrent() && epoch.current === n) setView({ client, diff, busy: false, error: '' }); }
        catch { if (active.current && client.isCurrent() && epoch.current === n) setView({ client, diff: null, busy: false, error: '差异暂时没读到，或原稿已经更新。请重试；仍不一致时，先重新读取完整原稿。' }); }
        finally { clearTimeout(timer); if (cancel) c.signal.removeEventListener('abort', cancel); if (request.current === c) request.current = null; }
    }
    if (item.revision < 2 || !client.isCurrent()) return null;
    return <section className="resume-diff-panel" aria-label="正文版本对比"><button type="button" disabled={disabled} aria-expanded={opened} onClick={() => { reset(); setOpened(!opened); }}> {opened ? '收起改动' : '看改动'} </button>{opened && <><h3>对照已保存的正文</h3><p>比较同一份原稿的历史修改；另存的简历是不同对象。查看差异不会确认或发送任何内容。</p><form onSubmit={e => { e.preventDefault(); void load(); }}><label>从正文版本<input type="number" min={1} max={item.revision - 1} step={1} required value={from} disabled={disabled || state.busy} onChange={e => { reset(); setFrom(e.target.value); }}/></label><span>到 r{item.revision}</span><button type="submit" disabled={disabled || state.busy}>比较正文</button></form>{state.busy && <p role="status">正在核对历史版本…</p>}{state.error && <p role="alert">{state.error}</p>}{state.diff && <ResumeDiffContent diff={state.diff}/>}</>}</section>;
}
