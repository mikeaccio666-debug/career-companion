import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, Copy, FolderOpen, Layers3, Loader2, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import type { CreateJobInput, WorkflowStep, WorkflowTemplate, WorkflowTemplateInput } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { ApiError, errorText } from './api';
import { Badge, Empty, JobCard, ProviderSelect } from './ui';
import type { Artifact, Job, Provider } from './types';
import { deleteWorkflowTemplate, listWorkflowTemplates, saveWorkflowTemplate } from './workflow-api';
import { canChangeWorkflowKind, draftFromTemplate, insertWorkflowPlaceholder, modelsForStep, moveWorkflowStep, newWorkflowStep, nextWorkflowImageReference, removeWorkflowStep, serializeWorkflowDraft, workflowJob, workflowKindLabels, workflowKinds, workflowReadiness, WORKFLOW_STEP_LIMIT, type WorkflowDraft, type WorkflowStepDraft } from './workflow-editor';
import './workflow.css';
import ExecutionTemplateDetails from './ExecutionTemplateDetails';
import { captureExecutionTemplate, captureWorkflowExecutionTemplates } from './execution-template';
import { CreativeOperationScope } from './creative-session';

interface Review { template: WorkflowTemplateInput; job: CreateJobInput; revision?: number; }
const fingerprint = (draft: WorkflowDraft) => JSON.stringify({ ...draft, steps: draft.steps.map(({ editorId: _id, ...step }) => step) });
export default function WorkflowPanel({ providers, jobs, onCreate, onCancel, onRetry, onRefreshCapabilities, onBringArtifactToAgent, handoffDisabled, onError }: {
  providers: Provider[]; jobs: Job[]; onCreate: (input: CreateJobInput) => Promise<void>;
  onCancel: (job: Job) => void; onRetry: (job: Job) => void; onRefreshCapabilities: () => Promise<void>; onError: (message: string) => void;
  onBringArtifactToAgent?: (job: Job, artifact: Artifact) => void; handoffDisabled?: boolean;
}) {
  const freshDraft = (): WorkflowDraft => ({ name: '我的第一个流程', description: '', steps: [newWorkflowStep('chat', providers)] });
  const accountClient = useRequiredPlatformAccountClient();
  const [draft, setDraft] = useState<WorkflowDraft>(freshDraft);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [current, setCurrent] = useState<Pick<WorkflowTemplate, 'id' | 'revision'> | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [refreshingTemplate, setRefreshingTemplate] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [addKind, setAddKind] = useState<WorkflowStep['kind']>('chat');
  const promptFields = useRef(new Map<string, HTMLTextAreaElement>());
  const reviewSection = useRef<HTMLElement>(null);
  const live = useRef(true);
  const templateRefreshScope = useRef(new CreativeOperationScope('workflow-panel'));
  const librarySequence = useRef(0);
  const workflowProvider = providers.find((provider) => provider.id === 'workflow');
  const disabled = pending || refreshingTemplate || !!review;
  const dirty = savedFingerprint !== fingerprint(draft);
  const readiness = review ? workflowReadiness(review.template.steps, providers) : [];
  if (review && (!workflowProvider?.enabled || !workflowProvider.keyConfigured)) readiness.push('工作流执行器待配置或已停用。');
  const filteredJobs = jobs.filter((job) => job.kind === 'workflow');

  useEffect(() => {
    live.current = true;
    templateRefreshScope.current.mount('workflow-panel');
    let cancelled = false;
    const sequence = ++librarySequence.current;
    listWorkflowTemplates(accountClient).then((items) => { if (!cancelled && sequence === librarySequence.current) setTemplates(items); }).catch((error) => { if (!cancelled && sequence === librarySequence.current) onError(errorText(error)); }).finally(() => { if (!cancelled && sequence === librarySequence.current) setLoading(false); });
    return () => { cancelled = true; live.current = false; templateRefreshScope.current.dispose(); };
  }, []);
  useEffect(() => {
    if (!providers.length || current) return;
    setDraft((prior) => ({ ...prior, steps: prior.steps.map((step) => step.provider ? step : { ...newWorkflowStep(step.kind, providers), editorId: step.editorId, prompt: step.prompt, optionsText: step.optionsText }) }));
  }, [providers, current]);
  useEffect(() => { if (review) { reviewSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); reviewSection.current?.focus({ preventScroll: true }); } }, [review]);

  function updateStep(id: string, change: Partial<WorkflowStepDraft>) {
    setDraft((prior) => ({ ...prior, steps: prior.steps.map((step) => step.editorId === id ? { ...step, ...change } : step) }));
    setNotice('');
  }
  function reorderStep(index: number, direction: -1 | 1) {
    try { const steps = moveWorkflowStep(draft.steps, index, direction); setDraft((prior) => ({ ...prior, steps })); }
    catch (error) { onError(errorText(error)); }
  }
  function removeStep(index: number) {
    try { const steps = removeWorkflowStep(draft.steps, index); setDraft((prior) => ({ ...prior, steps })); }
    catch (error) { onError(errorText(error)); }
  }
  function changeKind(index: number, kind: WorkflowStep['kind']) {
    try {
      canChangeWorkflowKind(draft.steps, index, kind);
      const step = draft.steps[index]; const next = newWorkflowStep(kind, providers);
      updateStep(step.editorId, { ...next, editorId: step.editorId, prompt: step.prompt, referenceImages: ['image', 'video'].includes(kind) ? step.referenceImages : undefined });
    } catch (error) { onError(errorText(error)); }
  }
  function loadTemplate(template: WorkflowTemplate) {
    const next = draftFromTemplate(template);
    setDraft(next); setCurrent({ id: template.id, revision: template.revision }); setSavedFingerprint(fingerprint(next)); setReview(null); setConflict(false); setNotice('已载入流程设计。本次目标单独填写；生成步骤在完整审阅时使用当前模板固定版本。');
  }
  function newTemplate() { setDraft(freshDraft()); setCurrent(null); setSavedFingerprint(null); setReview(null); setConflict(false); setNotice(''); }
  function cloneTemplate() {
    setDraft((prior) => ({ ...prior, name: `${prior.name.slice(0, 95)}（副本）`, steps: prior.steps.map((step) => ({ ...step, editorId: crypto.randomUUID() })) }));
    setCurrent(null); setSavedFingerprint(null); setReview(null); setConflict(false); setNotice('保存后会创建一个新的私有模板。');
  }
  async function reloadTemplates(reloadCurrent = false) {
    const sequence = ++librarySequence.current;
    setLoading(true);
    try { const items = await listWorkflowTemplates(accountClient); if (!live.current || sequence !== librarySequence.current) return; setTemplates(items); if (reloadCurrent && current) { const template = items.find((item) => item.id === current.id); if (template) loadTemplate(template); else { setCurrent(null); setSavedFingerprint(null); setConflict(false); setNotice('已保存模板被删除，你的草稿仍保留。'); } } }
    catch (error) { onError(errorText(error)); } finally { if (live.current && sequence === librarySequence.current) setLoading(false); }
  }
  async function save() {
    try {
      const input = serializeWorkflowDraft(draft); const captured = fingerprint(draft);
      ++librarySequence.current; setLoading(false); setPending(true); setNotice('');
      const template = await saveWorkflowTemplate(input, current || undefined, accountClient);
      if (!live.current) return;
      setTemplates((items) => [template, ...items.filter((item) => item.id !== template.id)]);
      setCurrent({ id: template.id, revision: template.revision }); setSavedFingerprint(captured); setConflict(false); setNotice(`已保存私有模板 · 版本 ${template.revision}`);
    } catch (error) { if (error instanceof ApiError && error.status === 409) { setConflict(true); onError('此模板已在另一页面更新。本地草稿保留；可以保存副本，或重新载入服务器版本。'); } else onError(errorText(error)); }
    finally { if (live.current) setPending(false); }
  }
  async function deleteCurrent() {
    if (!current) return;
    const id = current.id; ++librarySequence.current; setLoading(false); setPending(true);
    try { await deleteWorkflowTemplate(id, accountClient); if (!live.current) return; setTemplates((items) => items.filter((item) => item.id !== id)); setCurrent(null); setSavedFingerprint(null); setConflict(false); setNotice('已删除保存的模板，当前草稿仍可编辑或重新保存。'); }
    catch (error) { onError(errorText(error)); } finally { if (live.current) setPending(false); }
  }
  function prepareReview(event: React.FormEvent) {
    event.preventDefault();
    try { const template = captureWorkflowExecutionTemplates(serializeWorkflowDraft(draft), providers); const job = workflowJob(template, prompt); setReview({ template, job, ...(current && !dirty ? { revision: current.revision } : {}) }); setNotice(''); }
    catch (error) { onError(errorText(error)); }
  }
  async function createReviewedJob() {
    if (!review || readiness.length || refreshingTemplate) return;
    setPending(true);
    try { await onCreate(review.job); if (!live.current) return; setReview(null); setNotice('已创建待审批任务。批准后才会开始执行，任务记录保留本次步骤快照。'); }
    catch (error) { onError(errorText(error)); } finally { if (live.current) setPending(false); }
  }
  async function refreshTemplateStatus() {
    if (refreshingTemplate || pending) return;
    const token = templateRefreshScope.current.begin(); if (!token) return;
    setRefreshingTemplate(true);
    try {
      await onRefreshCapabilities(); if (!templateRefreshScope.current.isCurrent(token)) return;
      setNotice(review ? '模板状态已刷新，已审阅版本保持不变。请返回编辑，使用当前模板重新审阅。' : '模板状态已刷新。流程设计保留，完整审阅时将使用当前模板版本。');
    } catch (error) { if (templateRefreshScope.current.isCurrent(token)) onError(errorText(error)); }
    finally { if (templateRefreshScope.current.finish(token)) setRefreshingTemplate(false); }
  }
  function addPlaceholder(step: WorkflowStepDraft, token: '{{input}}' | '{{previous}}') {
    const field = promptFields.current.get(step.editorId);
    const result = insertWorkflowPlaceholder(step.prompt, token, field?.selectionStart, field?.selectionEnd);
    if (result.prompt.length > 20_000) { onError('提示词最多 20,000 字，请先缩短内容。'); return; }
    updateStep(step.editorId, { prompt: result.prompt });
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(result.cursor, result.cursor); });
  }

  return <section className="feature-page workflow-page">
    <div className="page-kicker"><Layers3 size={15} />WORKFLOW LAB</div>
    <h1>把多个能力，<span>连成自己的流程。</span></h1>
    <p className="page-description">组合文字、图片、视频与配音，保存成你的私有模板。每次运行先审阅完整任务，再由你批准执行。</p>
    <div className="workflow-library">
      <label>我的模板<select aria-label="选择工作流模板" value={current?.id || ''} disabled={disabled || loading} onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); if (template) loadTemplate(template); }}><option value="">{loading ? '正在加载…' : '选择已保存模板'}</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.revision}</option>)}</select></label>
      <div className="workflow-library-actions"><button className="secondary" type="button" disabled={disabled} onClick={newTemplate}><Plus size={14} />新建</button><button className="icon-button" type="button" aria-label="刷新工作流模板" disabled={pending || loading} onClick={() => reloadTemplates()}><RotateCcw size={15} className={loading ? 'spin' : ''} /></button></div>
    </div>
    {!review && draft.steps.some((step) => step.provider === 'comfyui') && <button className="secondary" type="button" disabled={pending || refreshingTemplate} onClick={refreshTemplateStatus}><RotateCcw size={14} className={refreshingTemplate ? 'spin' : ''} />{refreshingTemplate ? '正在刷新…' : '刷新模板状态'}</button>}
    <form className="workflow-editor" onSubmit={prepareReview}>
      <fieldset disabled={disabled}>
        <div className="workflow-editor-heading"><h2>流程设计</h2><Badge>{current ? `V${current.revision}${dirty ? ' · 未保存修改' : ''}` : '未保存草稿'}</Badge></div>
        <div className="workflow-template-meta"><label>名称<input aria-label="流程名称" value={draft.name} onChange={(event) => setDraft((prior) => ({ ...prior, name: event.target.value }))} maxLength={100} required /></label><label>说明<span className="field-optional">可选</span><input aria-label="流程说明" value={draft.description} onChange={(event) => setDraft((prior) => ({ ...prior, description: event.target.value }))} maxLength={1000} placeholder="描述适合使用这个流程的场景" /></label></div>
        <div className="workflow-steps-list">{draft.steps.map((step, index) => {
          const provider = providers.find((item) => item.id === step.provider);
          const models = modelsForStep(provider, step.kind);
          const imageSources = draft.steps.map((source, sourceIndex) => ({ source, sourceIndex })).filter(({ source, sourceIndex }) => sourceIndex < index && source.kind === 'image');
          return <article className="workflow-edit-step" key={step.editorId}>
            <div className="workflow-edit-step-top"><span className="workflow-number">{String(index + 1).padStart(2, '0')}</span><label>能力<select aria-label={`第 ${index + 1} 步能力`} value={step.kind} onChange={(event) => changeKind(index, event.target.value as WorkflowStep['kind'])}>{workflowKinds.map((kind) => <option key={kind} value={kind}>{workflowKindLabels[kind]}</option>)}</select></label><div className="workflow-order-controls"><button className="icon-button" type="button" aria-label={`上移第 ${index + 1} 步`} disabled={index === 0} onClick={() => reorderStep(index, -1)}><ArrowUp size={15} /></button><button className="icon-button" type="button" aria-label={`下移第 ${index + 1} 步`} disabled={index === draft.steps.length - 1} onClick={() => reorderStep(index, 1)}><ArrowDown size={15} /></button><button className="icon-button" type="button" aria-label={`删除第 ${index + 1} 步`} disabled={draft.steps.length === 1} onClick={() => removeStep(index)}><Trash2 size={15} /></button></div></div>
            <div className="workflow-step-service"><ProviderSelect providers={providers} capability={step.kind} value={step.provider} label={`第 ${index + 1} 步服务`} onChange={(value) => updateStep(step.editorId, { provider: value, model: modelsForStep(providers.find((item) => item.id === value), step.kind)[0] || '' })} />{step.provider !== 'comfyui' && <label>模型<input aria-label={`第 ${index + 1} 步模型`} value={step.model || ''} onChange={(event) => updateStep(step.editorId, { model: event.target.value })} list={`workflow-models-${step.editorId}`} maxLength={150} placeholder="服务端默认" /><datalist id={`workflow-models-${step.editorId}`}>{models.map((model) => <option key={model} value={model} />)}</datalist></label>}</div>
            {step.provider === 'comfyui' && <><p className="workflow-context-note">模型与生成规格由模板决定；完整审阅时将固定当前版本。</p><ExecutionTemplateDetails binding={captureExecutionTemplate(step.provider, providers)} fixed={false} /></>}
            <label className="workflow-prompt-label">提示词<textarea ref={(field) => { if (field) promptFields.current.set(step.editorId, field); else promptFields.current.delete(step.editorId); }} aria-label={`第 ${index + 1} 步提示词`} value={step.prompt} onChange={(event) => updateStep(step.editorId, { prompt: event.target.value })} rows={3} maxLength={20000} required /></label>
            <div className="workflow-placeholder-controls"><span>插入：</span><button type="button" onClick={() => addPlaceholder(step, '{{input}}')}>本次目标</button><button type="button" onClick={() => addPlaceholder(step, '{{previous}}')}>最近文字输出</button></div>
            {['image', 'video'].includes(step.kind) && <div className="workflow-image-references"><strong>使用前面图片步骤的成果</strong>{step.referenceImages?.map((reference, referenceIndex) => <div className="workflow-image-reference" key={referenceIndex}><label>来源<select aria-label={`第 ${index + 1} 步图片引用 ${referenceIndex + 1} 来源`} value={reference.fromStep} onChange={(event) => updateStep(step.editorId, { referenceImages: step.referenceImages!.map((item, position) => position === referenceIndex ? { ...item, fromStep: Number(event.target.value) } : item) })}>{imageSources.map(({ source, sourceIndex }) => <option key={source.editorId} value={sourceIndex}>第 {sourceIndex + 1} 步图片</option>)}</select></label><label>成果<select aria-label={`第 ${index + 1} 步图片引用 ${referenceIndex + 1} 序号`} value={reference.imageIndex || 0} onChange={(event) => updateStep(step.editorId, { referenceImages: step.referenceImages!.map((item, position) => position === referenceIndex ? { ...item, imageIndex: Number(event.target.value) } : item) })}>{Array.from({ length: 8 }, (_, imageIndex) => <option key={imageIndex} value={imageIndex}>第 {imageIndex + 1} 张</option>)}</select></label><button type="button" className="icon-button" aria-label={`删除第 ${index + 1} 步图片引用 ${referenceIndex + 1}`} onClick={() => updateStep(step.editorId, { referenceImages: step.referenceImages!.filter((_, position) => position !== referenceIndex) })}><X size={15} /></button></div>)}<button className="text-button" type="button" disabled={!imageSources.length || (step.referenceImages?.length || 0) >= 4} onClick={() => { const reference = nextWorkflowImageReference(step.referenceImages || [], imageSources.map((item) => item.sourceIndex)); if (reference) updateStep(step.editorId, { referenceImages: [...(step.referenceImages || []), reference] }); }}><Plus size={14} />添加图片引用</button><small>{imageSources.length ? '图片由后端从本次任务读取并直接交给所选模型，不需要公开作品链接。请选择不同的图片成果，序号需对应实际生成的图片。' : '先在前面添加一个图片步骤，再选择它的成果。'}</small></div>}
            <details className="workflow-step-options"><summary>高级参数 JSON</summary><textarea aria-label={`第 ${index + 1} 步高级参数`} value={step.optionsText} onChange={(event) => updateStep(step.editorId, { optionsText: event.target.value })} rows={3} maxLength={120000} placeholder={step.kind === 'video' ? '{"aspectRatio": "16:9", "duration": 5}' : step.kind === 'speech' ? '{"voice": "alloy"}' : '{}'} /><small>ComfyUI 参数由固定模板决定，请留空。其他服务由服务端校验参数。图片支持 aspectRatio / input / referenceField；视频另支持 duration / seed / resolution / referenceMode；配音支持 voice，文字步骤留空。Ark referenceMode 可选 first_frame / first_last_frame / reference_image，fal referenceField 可选 image_url / image_urls。不要填写密钥或连接地址。</small></details>
          </article>;
        })}</div>
        <div className="workflow-add-step"><label>添加能力<select aria-label="新增步骤能力" value={addKind} onChange={(event) => setAddKind(event.target.value as WorkflowStep['kind'])}>{workflowKinds.map((kind) => <option key={kind} value={kind}>{workflowKindLabels[kind]}</option>)}</select></label><button className="secondary" type="button" disabled={draft.steps.length >= WORKFLOW_STEP_LIMIT} onClick={() => setDraft((prior) => ({ ...prior, steps: [...prior.steps, newWorkflowStep(addKind, providers)] }))}><Plus size={15} />添加步骤</button><span>{draft.steps.length} / {WORKFLOW_STEP_LIMIT}</span></div>
        <p className="workflow-context-note"><code>{'{{input}}'}</code> 使用本次目标；<code>{'{{previous}}'}</code> 使用最近一次文字输出，第一步为空。图片传递使用单独的成果引用；各步产物保存在任务结果。</p>
        <div className="workflow-save-actions"><button className="primary" type="button" onClick={save}><Save size={15} />{pending ? '保存中…' : current ? '保存修改' : '保存模板'}</button><button className="secondary" type="button" onClick={cloneTemplate}><Copy size={14} />复制为新模板</button>{current && <button className="text-button" type="button" onClick={deleteCurrent}><Trash2 size={14} />删除模板</button>}</div>
        <p className="workflow-private-note">流程设计保存在你的账号中。保存不会调用模型，也不会固定生成模板版本；执行前完整审阅时使用当前版本。本次目标不会写入模板。</p>
        <div className="workflow-run-input"><label>本次目标<textarea aria-label="工作流本次目标" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} placeholder="这一次，你希望这个流程完成什么？" /></label><button className="primary" type="submit" disabled={!prompt.trim()}>审阅完整任务<ArrowRight size={15} /></button></div>
      </fieldset>
    </form>
    {conflict && <div className="workflow-conflict"><p>本地草稿仍保留。重新载入会替换当前草稿；复制为新模板可保留这份设计。</p><button type="button" className="secondary" disabled={pending || loading || !!review} onClick={() => reloadTemplates(true)}><RotateCcw size={14} />载入服务器版本</button></div>}
    {notice && <p className="workflow-notice" role="status"><Check size={14} />{notice}</p>}
    {review && <section ref={reviewSection} tabIndex={-1} className="workflow-review" aria-label="完整工作流任务审阅"><div className="workflow-editor-heading"><h2>本次任务审阅</h2><Badge tone="amber">批准后执行</Badge></div><h3>{review.template.name}{review.revision ? <small> · 模板 v{review.revision}</small> : <small> · 当前草稿快照</small>}</h3><p className="workflow-review-input"><strong>本次目标</strong>{review.job.prompt}</p><ol>{review.template.steps.map((step, index) => <li key={index}><div><strong>{index + 1}. {workflowKindLabels[step.kind]}</strong><span>{providers.find((item) => item.id === step.provider)?.name || step.provider} · {step.provider === 'comfyui' ? '模型由固定生成模板决定' : step.model || '服务端默认模型'}</span></div>{step.provider === 'comfyui' && <ExecutionTemplateDetails binding={step.executionTemplate} />}<pre>{step.prompt}</pre>{step.referenceImages?.length ? <p className="workflow-review-references">图片输入：{step.referenceImages.map((reference) => `第 ${reference.fromStep + 1} 步的第 ${(reference.imageIndex || 0) + 1} 张图片`).join('、')}</p> : null}{step.options && <details><summary>高级参数</summary><pre>{JSON.stringify(step.options, null, 2)}</pre></details>}</li>)}</ol>{review.template.steps.some((step) => step.provider === 'comfyui') && <><button className="secondary" type="button" disabled={pending || refreshingTemplate} onClick={refreshTemplateStatus}><RotateCcw size={14} className={refreshingTemplate ? 'spin' : ''} />{refreshingTemplate ? '正在刷新…' : '刷新模板状态'}</button><p className="workflow-context-note">刷新保留已审阅版本。返回编辑后，使用当前模板重新审阅。</p></>}<p className="workflow-context-note">执行时按顺序填入目标、最近文字输出和所选图片成果。创建任务后，这份步骤快照固定；后来修改模板不会改动已提交任务。</p>{readiness.length > 0 && <div className="workflow-readiness" role="status"><strong>执行前需要处理</strong>{readiness.map((item) => <p key={item}>{item}</p>)}<p>可以返回设计并保存模板，配置服务后再提交。</p></div>}<div className="workflow-review-actions"><button className="secondary" type="button" disabled={pending || refreshingTemplate} onClick={() => setReview(null)}><X size={14} />返回编辑</button><button className="primary" type="button" disabled={pending || refreshingTemplate || readiness.length > 0} onClick={createReviewedJob}>{pending ? <Loader2 size={15} className="spin" /> : <Layers3 size={15} />}创建待审批任务</button></div></section>}
    <div className="section-title results-title"><h3>工作流任务</h3><span>{filteredJobs.length ? `${filteredJobs.length} TASKS` : 'A CLEAN SLATE'}</span></div>
    {filteredJobs.length ? <div className="jobs-grid">{filteredJobs.map((job) => <JobCard key={job.id} job={job} onCancel={onCancel} onRetry={onRetry} onBringArtifactToAgent={onBringArtifactToAgent} handoffDisabled={handoffDisabled} />)}</div> : <Empty icon={<FolderOpen size={27} strokeWidth={1.4} />} title="为常做的事，设计一次流程">保存设计，按需运行。执行状态与每一步产物会保留在任务中。</Empty>}
  </section>;
}
