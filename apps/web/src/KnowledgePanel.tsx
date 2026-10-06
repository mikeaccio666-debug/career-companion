import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, FileText, Loader2, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import type { KnowledgePassage, KnowledgeSearchResult, KnowledgeSource, KnowledgeSourceSummary } from '@companion/platform-contracts';
import { KNOWLEDGE_SOURCE_MAX_BYTES, KNOWLEDGE_SOURCE_LIMIT } from '@companion/platform-contracts';
import { errorText } from './api';
import { useRequiredPlatformAccountClient } from './account-client';
import { createKnowledgeClient } from './knowledge-api';
import { KnowledgeOperationScope, isKnowledgeRevisionConflict, knowledgeAgentDraft, knowledgeContentBytes, knowledgeDraftFingerprint, knowledgeDraftFromSource, knowledgeSearchInput, newKnowledgeDraft, serializeKnowledgeDraft, type KnowledgeDraft } from './knowledge-editor';
import { Badge, Empty } from './ui';
import './knowledge.css';

type ReplaceRequest = { id: string; title: string } | 'new';
export default function KnowledgePanel({ accountId, onBringToAgent, handoffDisabled, onError }: { accountId: string; onBringToAgent: (draft: string) => void; handoffDisabled?: boolean; onError: (error: unknown) => void }) {
  const accountClient = useRequiredPlatformAccountClient();
  const api = useMemo(() => createKnowledgeClient(accountClient.request), [accountClient]);
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([]), [listLoading, setListLoading] = useState(true);
  const [draft, setDraft] = useState<KnowledgeDraft>(newKnowledgeDraft), [current, setCurrent] = useState<Pick<KnowledgeSource, 'id' | 'revision'> | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState(() => knowledgeDraftFingerprint(newKnowledgeDraft()));
  const [editorLoading, setEditorLoading] = useState(false), [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false);
  const [replaceRequest, setReplaceRequest] = useState<ReplaceRequest | null>(null), [deleteTarget, setDeleteTarget] = useState<KnowledgeSourceSummary | null>(null), [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(5), [sourceIds, setSourceIds] = useState<string[]>([]);
  const [searching, setSearching] = useState(false), [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const scope = useRef(new KnowledgeOperationScope());
  const mutationBusy = useRef(false);
  const callbacks = useRef({ onBringToAgent, onError }); callbacks.current = { onBringToAgent, onError };
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dirty = savedFingerprint !== knowledgeDraftFingerprint(draft), bytes = knowledgeContentBytes(draft.content);
  const busy = saving || deleting, editorDisabled = busy || editorLoading;
  const latest = current ? sources.find((source) => source.id === current.id) : undefined;
  const versionChanged = !!current && !!latest && latest.revision !== current.revision;

  function cancel(lane: string) { scope.current.cancel(lane); }
  function failed(failure: unknown) {
    if (failure instanceof DOMException && failure.name === 'AbortError') return;
    setError(errorText(failure)); callbacks.current.onError(failure);
  }
  async function run<T>(lane: string, work: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, finish?: () => void, reject: (failure: unknown) => void = failed) {
    return scope.current.run(lane, work, { apply, onError: reject, finally: finish });
  }
  function refreshList() {
    setListLoading(true);
    void run('knowledge-list', (signal) => api.list(signal), (items) => setSources(items), () => setListLoading(false));
  }
  useEffect(() => {
    mutationBusy.current = false; scope.current.mount(accountId); refreshList();
    return () => { scope.current.dispose(); mutationBusy.current = false; };
  }, [accountId, api]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  function remember(source: KnowledgeSource) {
    cancel('knowledge-list'); setListLoading(false);
    cancel('knowledge-search'); setSearching(false);
    const { content: _privateText, ...summary } = source;
    setSources((prior) => [summary, ...prior.filter((item) => item.id !== summary.id)]);
    setResult((prior) => prior ? { ...prior, matches: prior.matches.filter((item) => item.sourceId !== source.id) } : null);
  }
  function applySource(source: KnowledgeSource) {
    const next = knowledgeDraftFromSource(source); setDraft(next); setSavedFingerprint(knowledgeDraftFingerprint(next));
    setCurrent({ id: source.id, revision: source.revision }); setConflict(false); setReplaceRequest(null); setError(''); remember(source);
  }
  function openSource(id: string) {
    setEditorLoading(true); setReplaceRequest(null); setError(''); setNotice('');
    void run('knowledge-detail', (signal) => api.read(id, signal), applySource, () => setEditorLoading(false));
  }
  function startNew() {
    cancel('knowledge-detail'); setEditorLoading(false);
    const next = newKnowledgeDraft(); setDraft(next); setSavedFingerprint(knowledgeDraftFingerprint(next)); setCurrent(null); setConflict(false); setReplaceRequest(null); setNotice(''); setError('');
    requestAnimationFrame(() => editorRef.current?.focus());
  }
  function requestReplace(target: ReplaceRequest) { if (busy || mutationBusy.current) return; if (dirty) setReplaceRequest(target); else if (target === 'new') startNew(); else openSource(target.id); }
  function replaceConfirmed() { if (!replaceRequest || busy) return; if (replaceRequest === 'new') startNew(); else openSource(replaceRequest.id); }
  function edit(field: keyof KnowledgeDraft, value: string) { if (editorDisabled) return; setDraft((prior) => ({ ...prior, [field]: value })); setNotice(''); }
  function save(copy = false) {
    if (editorDisabled || mutationBusy.current || !scope.current.active) return; let input; try { input = serializeKnowledgeDraft(draft); } catch (failure) { setError(errorText(failure)); return; }
    mutationBusy.current = true; setSaving(true); setError(''); setNotice(''); cancel('knowledge-detail');
    void run('knowledge-save', (signal) => api.save(input, copy ? null : current, signal), (source) => { applySource(source); setNotice(copy ? '已保存为新资料，原来的版本保留。' : '资料已保存到你的账号。'); }, () => { mutationBusy.current = false; setSaving(false); }, (failure) => {
      if (isKnowledgeRevisionConflict(failure)) { setConflict(true); setError('资料已有新版本。当前草稿保留；可以载入最新版本或保存为副本。'); refreshList(); }
      else failed(failure);
    });
  }
  function removeSource() {
    if (!deleteTarget || busy || mutationBusy.current || !scope.current.active) return; const selected = deleteTarget; mutationBusy.current = true; setDeleting(true); setError(''); setNotice('');
    void run('knowledge-delete', (signal) => api.delete(selected, signal), () => {
      cancel('knowledge-list'); cancel('knowledge-detail'); setListLoading(false); setEditorLoading(false);
      cancel('knowledge-search'); setSearching(false);
      setSources((prior) => prior.filter((source) => source.id !== selected.id)); setSourceIds((prior) => prior.filter((id) => id !== selected.id));
      setResult((prior) => prior ? { ...prior, matches: prior.matches.filter((item) => item.sourceId !== selected.id) } : null);
      setDeleteTarget(null); if (current?.id === selected.id) startNew(); setNotice('资料已删除，之后不能再检索或引用它；已发送的摘录仍保留在相应聊天中。');
    }, () => { mutationBusy.current = false; setDeleting(false); }, (failure) => {
      if (isKnowledgeRevisionConflict(failure)) { setError('资料版本已变化，未执行删除。请刷新列表后重新确认；编辑草稿仍保留。'); setDeleteTarget(null); if (current?.id === selected.id) setConflict(true); refreshList(); }
      else failed(failure);
    });
  }
  function changeSearch(nextQuery = query, nextIds = sourceIds, nextLimit = limit) { cancel('knowledge-search'); setSearching(false); setResult(null); setQuery(nextQuery); setSourceIds(nextIds); setLimit(nextLimit); }
  function search(event: React.FormEvent) {
    event.preventDefault(); let input; try { input = knowledgeSearchInput(query, limit, sourceIds); } catch (failure) { setError(errorText(failure)); return; }
    setSearching(true); setResult(null); setError('');
    void run('knowledge-search', (signal) => api.search(input, signal), setResult, () => setSearching(false));
  }
  function bring(passage: KnowledgePassage) {
    if (handoffDisabled || !scope.current.active) return;
    try { callbacks.current.onBringToAgent(knowledgeAgentDraft(passage)); } catch (failure) { setError(errorText(failure)); }
  }

  return <section className="feature-page knowledge-page"><div className="page-kicker"><BookOpen size={15} />YOUR KNOWLEDGE</div><h1>把资料留下，<span>让思考有依据。</span></h1><p className="page-description">保存课程、项目或方法资料，找回原始段落，带着明确的来源继续讨论。只有你账号中的资料会出现在这里。</p><div className="knowledge-notice"><BookOpen size={17} /><p>保存和搜索不会调用模型。选择“带到 Agent”只会追加引用草稿；发送后，读取到的片段可能交给你选择的模型。来源网址只是说明，系统不会抓取网页。</p></div>{error && <div className="form-error knowledge-feedback" role="alert">{error}</div>}{notice && <div className="knowledge-success knowledge-feedback" role="status"><Check size={15} />{notice}</div>}
    <div className="knowledge-workspace"><aside className="knowledge-library"><div className="section-title"><h3><FileText size={16} />我的资料 <small>{sources.length}/{KNOWLEDGE_SOURCE_LIMIT}</small></h3><button className="icon-button" type="button" aria-label="刷新资料列表" disabled={listLoading || busy} onClick={refreshList}><RefreshCw size={15} className={listLoading ? 'spin' : ''} /></button></div><button className="secondary knowledge-new" type="button" disabled={busy} onClick={() => requestReplace('new')}><Plus size={15} />新建资料</button>{listLoading && !sources.length ? <p className="helper-text"><Loader2 size={15} className="spin" />正在读取资料…</p> : sources.length ? <ul className="knowledge-source-list">{sources.map((source) => <li key={source.id} className={current?.id === source.id ? 'selected' : ''}><button type="button" disabled={busy} onClick={() => requestReplace({ id: source.id, title: source.title })}><strong>{source.title}</strong><span>版本 {source.revision} · {source.passageCount} 段 · {(source.byteSize / 1024).toFixed(1)} KiB</span>{source.sourceLabel && <small>{source.sourceLabel}</small>}</button><button type="button" className="icon-button" aria-label={`删除资料 ${source.title}`} disabled={busy} onClick={() => setDeleteTarget(source)}><Trash2 size={14} /></button></li>)}</ul> : <p className="knowledge-library-empty">从一份课程笔记或项目说明开始。</p>}</aside>
      <div className="knowledge-editor"><div className="section-title"><h3>{current ? '编辑已保存的资料' : '新资料'}</h3><Badge tone={dirty ? 'amber' : 'neutral'}>{editorLoading ? '读取中' : dirty ? '有未保存修改' : current ? `版本 ${current.revision}` : '待保存'}</Badge></div>{replaceRequest && <div className="knowledge-confirm" role="alert"><p>当前修改尚未保存。{replaceRequest === 'new' ? '新建资料' : `载入“${replaceRequest.title}”`}会放弃当前草稿。</p><div><button className="secondary" type="button" disabled={busy} onClick={() => setReplaceRequest(null)}>保留当前草稿</button><button className="primary" type="button" disabled={busy} onClick={replaceConfirmed}>放弃草稿并继续</button></div></div>}{(conflict || versionChanged) && <div className="knowledge-confirm" role="status"><p>已有其他版本，当前草稿没有覆盖它。载入最新版本前可以先保存副本。</p><div><button className="secondary" type="button" disabled={editorDisabled || !current} onClick={() => current && requestReplace({ id: current.id, title: '最新版本' })}>载入最新版本</button><button className="primary" type="button" disabled={editorDisabled} onClick={() => save(true)}>把草稿保存为副本</button></div></div>}
        <form onSubmit={(event) => { event.preventDefault(); save(); }}><label>标题<input aria-label="资料标题" value={draft.title} onChange={(event) => edit('title', event.target.value)} maxLength={120} required disabled={editorDisabled} placeholder="例如：商业策略课程的方法笔记" /></label><div className="knowledge-source-fields"><label>来源说明（可选）<input aria-label="资料来源说明" value={draft.sourceLabel} onChange={(event) => edit('sourceLabel', event.target.value)} maxLength={200} disabled={editorDisabled} placeholder="课程、作者或资料提供方" /></label><label>来源网址（可选）<input aria-label="资料来源网址" type="url" value={draft.sourceUrl} onChange={(event) => edit('sourceUrl', event.target.value)} maxLength={2048} disabled={editorDisabled} placeholder="https://example.com/source" /></label></div><label>正文<textarea aria-label="资料正文" ref={editorRef} value={draft.content} onChange={(event) => edit('content', event.target.value)} rows={12} required disabled={editorDisabled} placeholder="粘贴纯文本或 Markdown。保留必要的原始出处，先去除不需要分享给模型的个人信息。" /></label><div className="knowledge-editor-footer"><span className={bytes > KNOWLEDGE_SOURCE_MAX_BYTES ? 'knowledge-over-limit' : ''}>{(bytes / 1024).toFixed(1)} / 64 KiB · 离开此页前请保存修改</span><button className="primary" type="submit" disabled={editorDisabled || bytes > KNOWLEDGE_SOURCE_MAX_BYTES || !draft.title.trim() || !draft.content.trim() || conflict || versionChanged}><Save size={15} />{saving ? '保存中…' : '保存资料'}</button></div></form></div></div>
    {deleteTarget && <div className="knowledge-confirm knowledge-delete-confirm" role="alert"><p>删除“{deleteTarget.title}”（版本 {deleteTarget.revision}）后，不能再检索或引用它；已发送的摘录仍保留在相应聊天中。{current?.id === deleteTarget.id && dirty ? '当前未保存的编辑也会丢弃。' : ''}</p><div><button className="secondary" type="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>保留资料</button><button className="primary" type="button" disabled={busy} onClick={removeSource}><Trash2 size={14} />{deleting ? '删除中…' : '确认删除'}</button></div></div>}
    <section className="knowledge-search"><div className="section-title"><h3><Search size={17} />找回原始段落</h3><span>按正文关键词匹配</span></div><form onSubmit={search}><div className="knowledge-search-row"><label>关键词<input aria-label="知识库搜索关键词" value={query} onChange={(event) => changeSearch(event.target.value)} maxLength={240} required placeholder="输入正文中的公司、课程或项目关键词" /></label><label>最多显示<select aria-label="知识库搜索结果数量" value={limit} onChange={(event) => changeSearch(query, sourceIds, Number(event.target.value))}>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 段</option>)}</select></label><button className="primary" type="submit" disabled={searching || !query.trim()}><Search size={15} />{searching ? '搜索中…' : '搜索资料'}</button></div>{sources.length > 0 && <details className="knowledge-filter"><summary>限定搜索资料：{sourceIds.length ? `已选 ${sourceIds.length} 份` : '全部资料'}</summary><div>{sources.map((source) => <label key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} disabled={sourceIds.length >= 10 && !sourceIds.includes(source.id)} onChange={(event) => changeSearch(query, event.target.checked ? [...sourceIds, source.id] : sourceIds.filter((id) => id !== source.id))} /><span>{source.title}</span></label>)}</div></details>}</form>{result && <p className="knowledge-query-label">“{result.query}” · {result.matches.length} 个原文段落</p>}{result?.matches.length ? <div className="knowledge-matches">{result.matches.map((passage) => { const stale = !sources.some((source) => source.id === passage.sourceId && source.revision === passage.revision); return <article className="knowledge-passage" key={`${passage.sourceId}:${passage.revision}:${passage.passageId}`}><div><h4>{passage.title}</h4><Badge tone={stale ? 'amber' : 'neutral'}>版本 {passage.revision} · 第 {passage.passageIndex + 1} 段{stale ? ' · 需重新检索' : ''}</Badge></div>{passage.sourceLabel && <p className="knowledge-source-label">{passage.sourceLabel}</p>}<pre>{passage.text}</pre><footer><span>资料更新于 {new Date(passage.updatedAt).toLocaleString()}</span><button className="secondary" type="button" disabled={handoffDisabled || stale} onClick={() => bring(passage)}>带到 Agent<ArrowRight size={14} /></button></footer>{passage.sourceUrl && <p className="knowledge-source-url">来源网址：{passage.sourceUrl}</p>}</article>; })}</div> : result ? <Empty icon={<Search size={23} />} title="没有找到对应原文">尝试正文中实际出现的词，或调整所选资料。这里不会用模型补出搜索结果。</Empty> : <p className="knowledge-search-empty">输入关键词后，这里会显示已保存资料中的真实段落与版本。</p>}</section>
  </section>;
}
