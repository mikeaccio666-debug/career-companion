import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, FolderOpen, Globe2, Loader2, MessageCircle, Plus, Trash2, X } from 'lucide-react';
import type { BrowserAction, CreateJobInput } from '@companion/platform-contracts';
import { errorText } from './api';
import { Badge, ConnectionNote, Empty, JobCard } from './ui';
import type { Job, Provider } from './types';
import BrowserPlanDetails from './BrowserPlanDetails';
import { BROWSER_ACTION_LIMIT, browserActionLabels, browserActionTypes, browserAgentDraft, browserFixtureOrigins, browserPlanJob, browserPlanReadiness, browserRoleLabels, browserRolesForAction, hasBrowserObservation, newBrowserAction, serializeBrowserDraft, type BrowserActionDraft, type BrowserPlan, type BrowserPlanDraft } from './browser-plan';
import './browser.css';

export default function BrowserPanel({ providers, jobs, onCreate, onCancel, onRetry, onBringToAgent, onError }: {
  providers: Provider[]; jobs: Job[]; onCreate: (input: CreateJobInput) => Promise<void>;
  onCancel: (job: Job) => void; onRetry: (job: Job) => void; onBringToAgent: (draft: string) => void; onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<BrowserPlanDraft>({ url: '', prompt: '', actions: [] });
  const [addType, setAddType] = useState<BrowserAction['type']>('click');
  const [review, setReview] = useState<BrowserPlan | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const reviewSection = useRef<HTMLElement>(null);
  const live = useRef(true);
  const provider = providers.find((item) => item.id === 'browser');
  const fixtureOrigins = browserFixtureOrigins(provider);
  const readiness = review ? browserPlanReadiness(review, provider) : [];
  const filtered = jobs.filter((job) => job.kind === 'browser');
  const disabled = pending || !!review;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (review) { reviewSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); reviewSection.current?.focus({ preventScroll: true }); } }, [review]);

  function updateAction(id: string, change: Partial<BrowserActionDraft>) {
    setDraft((prior) => ({ ...prior, actions: prior.actions.map((action) => action.editorId === id ? { ...action, ...change } : action) })); setNotice('');
  }
  function moveAction(index: number, direction: -1 | 1) {
    setDraft((prior) => { const actions = [...prior.actions]; const target = index + direction; if (target < 0 || target >= actions.length) return prior; [actions[index], actions[target]] = [actions[target], actions[index]]; return { ...prior, actions }; });
  }
  function prepareReview(event: React.FormEvent) {
    event.preventDefault();
    try { setReview(serializeBrowserDraft(draft, fixtureOrigins)); setNotice(''); }
    catch (error) { onError(errorText(error)); }
  }
  async function submitReviewedPlan() {
    if (!review || readiness.length) return;
    setPending(true);
    try { await onCreate(browserPlanJob(review)); if (!live.current) return; setReview(null); setNotice('已创建待审批任务。请检查访问站点、操作顺序与填入内容，再批准执行。'); }
    catch (error) { onError(errorText(error)); } finally { if (live.current) setPending(false); }
  }

  return <section className="feature-page browser-page">
    <div className="page-kicker"><Globe2 size={15} />BROWSER WORKSPACE</div>
    <h1>把一个网页，<span>变成能继续讨论的线索。</span></h1>
    <p className="page-description">先读取公开网页，也可以设计点击、填写、选择与滚动的计划。每次执行都先审阅并批准；浏览器结果可以带回 Agent，让它帮助你判断下一步。</p>
    <form className="browser-editor" onSubmit={prepareReview}><fieldset disabled={disabled}>
      <div className="browser-editor-heading"><h2>设计网页计划</h2><Badge>{draft.actions.length ? `${draft.actions.length} 个步骤` : '只读浏览'}</Badge></div>
      <label>网页地址<input type="url" aria-label="浏览器网页地址" value={draft.url} onChange={(event) => setDraft((prior) => ({ ...prior, url: event.target.value }))} maxLength={2000} placeholder="https://example.com" required /></label>
      <label>这次希望了解或完成什么<textarea aria-label="浏览器任务目标" value={draft.prompt} onChange={(event) => setDraft((prior) => ({ ...prior, prompt: event.target.value }))} maxLength={20000} rows={3} placeholder="例如：读取产品介绍，整理最适合我继续研究的问题。" required /></label>
      <div className="browser-design-note">没有步骤时，只读取网页文字并截图。添加步骤只会修改当前草稿，不会操作网页。</div>
      {draft.actions.length > 0 && <div className="browser-actions-list">{draft.actions.map((action, index) => <article className="browser-edit-action" key={action.editorId}>
        <div className="browser-action-top"><span className="browser-action-number">{index + 1}</span><label>操作<select aria-label={`浏览器第 ${index + 1} 步操作`} value={action.type} onChange={(event) => { const type = event.target.value as BrowserAction['type']; updateAction(action.editorId, { type, role: browserRolesForAction(type).includes(action.role) ? action.role : browserRolesForAction(type)[0] || 'link' }); }}>{browserActionTypes.map((type) => <option key={type} value={type}>{browserActionLabels[type]}</option>)}</select></label><div className="browser-order-actions"><button type="button" className="icon-button" aria-label={`上移浏览器第 ${index + 1} 步`} disabled={index === 0} onClick={() => moveAction(index, -1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label={`下移浏览器第 ${index + 1} 步`} disabled={index === draft.actions.length - 1} onClick={() => moveAction(index, 1)}><ArrowDown size={15} /></button><button type="button" className="icon-button" aria-label={`删除浏览器第 ${index + 1} 步`} onClick={() => setDraft((prior) => ({ ...prior, actions: prior.actions.filter((item) => item.editorId !== action.editorId) }))}><Trash2 size={15} /></button></div></div>
        {action.type === 'scroll' ? <div className="browser-action-fields"><label>方向<select aria-label={`浏览器第 ${index + 1} 步滚动方向`} value={action.direction} onChange={(event) => updateAction(action.editorId, { direction: event.target.value as 'up' | 'down' })}><option value="down">向下</option><option value="up">向上</option></select></label><label>距离（像素）<input type="number" aria-label={`浏览器第 ${index + 1} 步滚动距离`} value={action.pixels} onChange={(event) => updateAction(action.editorId, { pixels: event.target.value })} min={1} max={1200} step={1} required /></label></div> : <>
          <div className="browser-action-fields"><label>怎样找到目标<select aria-label={`浏览器第 ${index + 1} 步定位方式`} value={action.by} onChange={(event) => updateAction(action.editorId, { by: event.target.value as BrowserActionDraft['by'] })}><option value="role">元素类型与名称</option><option value="label">字段标签</option></select></label>{action.by === 'role' && <label>元素类型<select aria-label={`浏览器第 ${index + 1} 步元素类型`} value={action.role} onChange={(event) => updateAction(action.editorId, { role: event.target.value as BrowserActionDraft['role'] })}>{browserRolesForAction(action.type).map((role) => <option key={role} value={role}>{browserRoleLabels[role]}</option>)}</select></label>}</div>
          <label>{action.by === 'label' ? '字段标签文字' : '页面上的元素名称'}<input aria-label={`浏览器第 ${index + 1} 步目标名称`} value={action.name} onChange={(event) => updateAction(action.editorId, { name: event.target.value })} maxLength={200} placeholder={action.type === 'fill' ? '例如：Search' : action.type === 'select' ? '例如：Language' : '例如：Learn more'} required /></label>
          {action.type === 'fill' && <label>完整填入内容<textarea aria-label={`浏览器第 ${index + 1} 步填入内容`} value={action.value} onChange={(event) => updateAction(action.editorId, { value: event.target.value })} maxLength={2000} rows={2} placeholder="仅填写普通、非敏感内容；留空表示清空字段。" /></label>}
          {action.type === 'select' && <label>要选择的选项文字<input aria-label={`浏览器第 ${index + 1} 步选项文字`} value={action.optionLabel} onChange={(event) => updateAction(action.editorId, { optionLabel: event.target.value })} maxLength={200} placeholder="例如：English" required /></label>}
        </>}
      </article>)}</div>}
      <div className="browser-add-action"><label>添加操作<select aria-label="新增浏览器操作" value={addType} onChange={(event) => setAddType(event.target.value as BrowserAction['type'])}>{browserActionTypes.map((type) => <option key={type} value={type}>{browserActionLabels[type]}</option>)}</select></label><button type="button" className="secondary" disabled={draft.actions.length >= BROWSER_ACTION_LIMIT} onClick={() => setDraft((prior) => ({ ...prior, actions: [...prior.actions, newBrowserAction(addType)] }))}><Plus size={15} />添加步骤</button><span>{draft.actions.length} / {BROWSER_ACTION_LIMIT}</span></div>
      {provider?.browserActionsEnabled !== true && <p className="browser-design-note">交互操作尚未启用，仍可设计和审阅草稿；只读任务可按浏览器服务的配置提交。</p>}
      {fixtureOrigins.length > 0 && <p className="browser-design-note">本地演练已开启，可使用：{fixtureOrigins.join('、')}。这些地址用于演练，不代表开放任意内网页面。</p>}
      <p className="browser-boundary-note">目前支持公开网页中的这些有限操作。完整电脑操作能力还在接入；登录、验证码、敏感资料、付款和最终提交由你参与。</p>
      <div className="browser-editor-footer"><span>草稿保留在当前页面，离开后不自动保存。</span><button className="primary" type="submit" disabled={!draft.url.trim() || !draft.prompt.trim()}>审阅完整计划<ArrowRight size={15} /></button></div>
    </fieldset></form>
    {review && <section ref={reviewSection} tabIndex={-1} className="browser-review" aria-label="完整浏览器计划审阅"><div className="browser-editor-heading"><h2>确认这次浏览器计划</h2><Badge tone="amber">批准后执行</Badge></div><BrowserPlanDetails plan={review} />{readiness.length > 0 && <div className="browser-readiness" role="status">{readiness.map((item) => <p key={item}>{item}</p>)}</div>}<div className="browser-review-actions"><button type="button" className="secondary" disabled={pending} onClick={() => setReview(null)}><X size={14} />返回编辑</button><button type="button" className="primary" disabled={pending || readiness.length > 0} onClick={submitReviewedPlan}>{pending ? <Loader2 size={15} className="spin" /> : <Globe2 size={15} />}创建待审批任务</button></div></section>}
    {notice && <p className="browser-notice" role="status">{notice}</p>}
    <ConnectionNote provider={provider} />
    <div className="section-title results-title"><h3>浏览器任务与线索</h3><span>{filtered.length ? `${filtered.length} TASKS` : 'A CLEAN SLATE'}</span></div>
    {filtered.length ? <div className="jobs-grid">{filtered.map((job) => <div className="browser-job-with-draft" key={job.id}><JobCard job={job} onCancel={onCancel} onRetry={onRetry} /><div className="browser-result-next"><button type="button" className="secondary" disabled={!hasBrowserObservation(job)} onClick={() => onBringToAgent(browserAgentDraft(job))}><MessageCircle size={14} />带回 Agent 草稿</button><small>{hasBrowserObservation(job) ? '只放入任务引用，发送后 Agent 才会读取你的结果。' : job.artifacts.length ? '已有结果可以查看，尚无可供 Agent 读取的网页观察记录。' : '已有网页观察记录后，可以带回 Agent 继续讨论。'}</small></div></div>)}</div> : <Empty icon={<FolderOpen size={27} strokeWidth={1.4} />} title="从一个公开网页开始">审阅计划后提交。网页文字、截图、执行状态与部分结果会保存在你的账号中。</Empty>}
  </section>;
}
