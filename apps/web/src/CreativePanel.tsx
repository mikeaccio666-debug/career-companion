import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clapperboard, FolderOpen, Image, Loader2, Paperclip, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import type { CreateJobInput } from '@companion/platform-contracts';
import { errorText } from './api';
import { referenceCreativeArtifact } from './creative-api';
import { CreativeOperationScope, type CreativeOperationToken } from './creative-session';
import { CREATIVE_IMAGE_MIMES, creativeAspectRatios, creativeModels, creativePlanJob, creativeReadiness, creativeReferencePolicy, freshCreativeDraft, moveCreativeReference, serializeCreativeDraft, validateCreativeFiles, validateCreativeReferences, type CreativeDraft, type CreativeKind, type CreativePlan } from './creative-plan';
import CreativeReferenceList from './CreativeReferenceList';
import PrivateImage from './PrivateImage';
import { Badge, ConnectionNote, Empty, JobCard, ProviderSelect } from './ui';
import type { Artifact, Job, Provider, Upload } from './types';
import './creative.css';
import ExecutionTemplateDetails from './ExecutionTemplateDetails';
import { captureExecutionTemplate } from './execution-template';

export default function CreativePanel({ accountId, providers, jobs, onCreate, onCancel, onRetry, onUpload, onRefreshCapabilities, onBringArtifactToAgent, handoffDisabled, onError }: {
  accountId: string; providers: Provider[]; jobs: Job[]; onCreate: (body: CreateJobInput) => Promise<void>;
  onCancel: (job: Job) => void; onRetry: (job: Job) => void; onUpload: (file: File) => Promise<Upload>; onRefreshCapabilities: () => Promise<void>; onError: (text: string) => void;
  onBringArtifactToAgent?: (job: Job, artifact: Artifact) => void; handoffDisabled?: boolean;
}) {
  const freshDrafts = () => ({ image: freshCreativeDraft(providers), video: freshCreativeDraft(providers, 'video') });
  const [kind, setKind] = useState<CreativeKind>('image');
  const [drafts, setDrafts] = useState<Record<CreativeKind, CreativeDraft>>(freshDrafts);
  const [review, setReview] = useState<CreativePlan | null>(null);
  const [pending, setPending] = useState<'upload' | 'reuse' | 'create' | 'refresh' | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryCount, setLibraryCount] = useState(12);
  const file = useRef<HTMLInputElement>(null), composer = useRef<HTMLTextAreaElement>(null), reviewSection = useRef<HTMLElement>(null);
  const scope = useRef(new CreativeOperationScope(accountId));
  const referenceRequest = useRef<AbortController | null>(null);
  scope.current.setAccount(accountId);
  const draft = drafts[kind], provider = providers.find((entry) => entry.id === draft.provider);
  const policy = creativeReferencePolicy(provider, kind);
  const ratios = creativeAspectRatios(provider, kind);
  const disabled = !!pending || !!review;
  const readiness = review ? creativeReadiness(review, providers) : [];
  const filtered = jobs.filter((job) => ['image', 'video'].includes(job.kind));
  const savedImages = jobs.filter((job) => ['image', 'workflow'].includes(job.kind)).flatMap((job) => job.artifacts.filter((artifact) => CREATIVE_IMAGE_MIMES.some((mime) => mime === artifact.mime)).map((artifact) => ({ job, artifact })));
  const Icon = kind === 'image' ? Image : Clapperboard;

  useEffect(() => {
    scope.current.mount(accountId);
    setDrafts(freshDrafts()); setKind('image'); setReview(null); setPending(null); setNotice(''); setAdvanced(false); setLibraryOpen(false); setLibraryCount(12);
    return () => { scope.current.dispose(); referenceRequest.current?.abort(); };
  }, [accountId]);
  useEffect(() => {
    setDrafts((prior) => {
      const next = { ...prior };
      for (const target of ['image', 'video'] as const) if (!prior[target].provider) {
        const selected = freshCreativeDraft(providers, target);
        next[target] = { ...prior[target], provider: selected.provider, model: selected.model, aspectRatio: selected.aspectRatio };
      }
      return next;
    });
  }, [providers]);
  useEffect(() => { if (review) { reviewSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); reviewSection.current?.focus({ preventScroll: true }); } }, [review]);

  function update(change: Partial<CreativeDraft>) {
    setDrafts((prior) => ({ ...prior, [kind]: { ...prior[kind], ...change } })); setNotice('');
  }
  function begin(operation: NonNullable<typeof pending>) {
    if (review) return null;
    const token = scope.current.begin(); if (token) setPending(operation);
    return token;
  }
  function current(token: CreativeOperationToken) {
    return scope.current.isCurrent(token);
  }
  function finish(token: CreativeOperationToken) {
    if (scope.current.finish(token)) setPending(null);
  }
  async function attach(selected: FileList | null) {
    if (!selected?.length) return;
    const files = Array.from(selected), token = begin('upload'); if (!token) return;
    const target = kind; let references = [...draft.references];
    try {
      validateCreativeFiles(files, references, policy);
      for (const entry of files) {
        if (!current(token)) return;
        const attachment = await onUpload(entry); if (!current(token)) return;
        references = [...references, { attachment, source: { kind: 'upload' as const } }];
        validateCreativeReferences(references, policy);
        setDrafts((prior) => ({ ...prior, [target]: { ...prior[target], references, ...(policy?.binding === 'fal_input' && references.length > 1 ? { referenceField: 'image_urls' } : {}) } }));
      }
      setNotice(`已加入 ${files.length} 张参考图片。可以调整顺序，再审阅创作任务。`);
    } catch (error) { if (current(token)) onError(errorText(error)); }
    finally { if (current(token) && file.current) file.current.value = ''; finish(token); }
  }
  async function reuse(artifact: Artifact, job: Job, target: CreativeKind) {
    const token = begin('reuse'); if (!token) return;
    let next = drafts[target];
    let selectedProvider = providers.find((entry) => entry.id === next.provider);
    if (!creativeReferencePolicy(selectedProvider, target)) {
      const selected = freshCreativeDraft(providers, target, true);
      next = { ...next, provider: selected.provider, model: selected.model, optionsText: '' };
      selectedProvider = providers.find((entry) => entry.id === selected.provider);
    }
    const selectedPolicy = creativeReferencePolicy(selectedProvider, target);
    const controller = new AbortController(); referenceRequest.current = controller;
    try {
      if (!selectedPolicy) throw new Error(`当前没有支持参考图片的${target === 'image' ? '图片' : '视频'}服务，请配置对应服务后再带入作品。`);
      const reference = await referenceCreativeArtifact(artifact.id, job.id, controller.signal); if (!current(token)) return;
      if (reference.source.kind === 'artifact') reference.source.jobPrompt = job.prompt;
      const references = next.references.some((item) => item.attachment.id === reference.attachment.id) ? next.references : [...next.references, reference];
      validateCreativeReferences(references, selectedPolicy);
      setDrafts((prior) => ({ ...prior, [target]: { ...next, references, ...(selectedPolicy.binding === 'fal_input' && references.length > 1 ? { referenceField: 'image_urls' } : {}), ...(selectedPolicy.binding === 'ark_video' && next.referenceMode === 'first_frame' ? { aspectRatio: 'adaptive' } : {}) } }));
      setKind(target); setNotice(`作品已带入${target === 'image' ? '图片修改' : '视频创作'}草稿。${selectedPolicy.binding === 'ark_video' && next.referenceMode === 'first_frame' ? '首帧画幅已设为“随参考图”。' : ''}请写下${target === 'image' ? '想修改的地方' : '画面如何运动'}，审阅后再确认创作。`);
      requestAnimationFrame(() => { if (current(token)) { composer.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); composer.current?.focus({ preventScroll: true }); } });
    } catch (error) { if (current(token)) onError(errorText(error)); }
    finally { if (referenceRequest.current === controller) referenceRequest.current = null; finish(token); }
  }
  function prepare(event: React.FormEvent) {
    event.preventDefault(); if (scope.current.busy) return;
    try { setReview(serializeCreativeDraft(draft, providers)); setNotice(''); } catch (error) { onError(errorText(error)); }
  }
  async function create() {
    if (!review || scope.current.busy || creativeReadiness(review, providers).length) return;
    const token = scope.current.begin(); if (!token) return; setPending('create');
    try {
      await onCreate(creativePlanJob(review)); if (!current(token)) return;
      const target = review.job.kind as CreativeKind;
      setDrafts((prior) => ({ ...prior, [target]: { ...prior[target], prompt: '', references: [] } }));
      setReview(null); setNotice(`已创建新的${target === 'image' ? '图片' : '视频'}任务，执行状态和结果会显示在下方。`);
    } catch (error) { if (current(token)) onError(errorText(error)); } finally { finish(token); }
  }
  async function refreshTemplateStatus() {
    const token = scope.current.begin(); if (!token) return;
    setPending('refresh');
    try {
      await onRefreshCapabilities(); if (!current(token)) return;
      setNotice(review ? '模板状态已刷新，已审阅版本保持不变。请返回编辑，使用当前模板重新审阅。' : '模板状态已刷新。草稿保留，审阅时将使用当前模板版本。');
    } catch (error) { if (current(token)) onError(errorText(error)); }
    finally { finish(token); }
  }

  return <section className="feature-page creative-page">
    <div className="page-kicker"><Image size={15} />CREATIVE STUDIO</div>
    <h1>让想法，<span>变成可以继续创作的作品。</span></h1>
    <p className="page-description">从文字或参考图片开始，生成图片与视频。已有图片可以直接带入下一轮草稿，审阅后再开始新的创作。</p>
    <div className="studio-tabs"><button type="button" className={kind === 'image' ? 'selected' : ''} disabled={disabled} onClick={() => { setKind('image'); setNotice(''); }}><Image size={16} />图片创作</button><button type="button" className={kind === 'video' ? 'selected' : ''} disabled={disabled} onClick={() => { setKind('video'); setNotice(''); }}><Clapperboard size={16} />视频创作</button></div>
    {notice && <p className="creative-notice" role="status">{notice}</p>}
    <form className="task-composer creative-composer" onSubmit={prepare}>
      <fieldset disabled={disabled}><div className="task-composer-top"><span><Icon size={17} />{kind === 'image' ? draft.references.length ? '描述你想修改的地方' : '描述你的画面' : '描述画面如何运动'}</span><Badge>{kind === 'image' ? 'IMAGE' : 'VIDEO'}</Badge></div>
        <label className="creative-prompt-label">创作描述<textarea aria-label="创作描述" ref={composer} value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder={kind === 'image' ? '例如：保留主体，把背景改成雨后的城市街道…' : '例如：镜头缓慢向前，树叶轻轻摇动，保持参考图中的主体…'} rows={4} maxLength={20000} /></label>
        <div className="task-parameters"><ProviderSelect providers={providers} value={draft.provider} onChange={(id) => { const selected = providers.find((entry) => entry.id === id); const supported = creativeAspectRatios(selected, kind); update({ provider: id, model: creativeModels(selected, kind)[0] || '', aspectRatio: supported.includes(draft.aspectRatio) ? draft.aspectRatio : supported[0] || '16:9' }); }} capability={kind} label="创作服务" />{provider?.id !== 'comfyui' && <label className="model-field"><span>模型</span><input aria-label="创作模型" value={draft.model} onChange={(event) => update({ model: event.target.value })} maxLength={150} placeholder="服务端默认" list="creative-models" /><datalist id="creative-models">{creativeModels(provider, kind).map((entry) => <option key={entry} value={entry} />)}</datalist></label>}{ratios.length > 0 && <label className="compact-select"><span>画幅</span><select aria-label="创作画幅" value={draft.aspectRatio} onChange={(event) => update({ aspectRatio: event.target.value })}>{ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio === 'adaptive' ? '随参考图' : ratio}</option>)}</select></label>}{policy?.binding === 'ark_video' && <label className="compact-select"><span>时长</span><select aria-label="创作视频时长" value={draft.duration} onChange={(event) => update({ duration: event.target.value })}><option value="5">5 秒</option><option value="10">10 秒</option></select></label>}</div>
        <div className="creative-references"><div className="creative-reference-heading"><strong>参考图片<span>可选</span></strong><button className="secondary" type="button" onClick={() => file.current?.click()} disabled={!policy || draft.references.length >= (policy?.maxImages || 0)}><Paperclip size={15} />添加图片</button><input ref={file} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={(event) => attach(event.target.files)} /></div>
          <p className="creative-helper">{policy ? `支持 ${policy.mimeTypes.map((mime) => mime === 'image/jpeg' ? 'JPEG' : mime.split('/')[1].toUpperCase()).join('、')}，最多 ${policy.maxImages} 张，总计 ${(policy.maxTotalBytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB。手机可从照片或文件中选择。` : '所选服务尚未提供参考图片支持；可以先用文字创作，或切换支持参考图片的服务。'}视频文件与其他格式不用于这里的图片参考。</p>{provider?.id === 'comfyui' && <p className="creative-helper">模型、画幅和其他生成参数由固定生成模板决定。审阅时使用当前模板版本。</p>}{policy?.binding === 'fal_input' && <p className="creative-helper">画幅、时长等模型参数请按所选模型说明填写在高级 input 中。</p>}
          <button type="button" className="text-button" disabled={!policy || !savedImages.length} aria-expanded={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}><FolderOpen size={14} />{libraryOpen ? '收起已有图片' : '从已有作品选择'}{savedImages.length ? ` · ${savedImages.length} 张` : ''}</button>
          {libraryOpen && <div className="creative-image-library" aria-label="已有图片作品"><p className="creative-helper">包括已完成创作和工作流中已保存的图片。选中只会加入当前草稿。</p><div>{savedImages.slice(0, libraryCount).map(({ job, artifact }) => <button key={artifact.id} type="button" disabled={disabled} onClick={() => reuse(artifact, job, kind)}><PrivateImage url={artifact.url} alt={artifact.name} /><span>{artifact.name}<small>来源任务：{job.prompt}</small></span><ArrowRight size={15} /></button>)}</div>{savedImages.length > libraryCount && <button type="button" className="text-button" onClick={() => setLibraryCount(libraryCount + 12)}>显示更多图片</button>}</div>}
          <CreativeReferenceList references={draft.references} disabled={disabled} firstLast={policy?.binding === 'ark_video' && draft.referenceMode === 'first_last_frame'} onMove={(index, direction) => update({ references: moveCreativeReference(draft.references, index, direction) })} onRemove={(id) => update({ references: draft.references.filter((entry) => entry.attachment.id !== id) })} />
          {draft.references.length > 0 && policy?.binding === 'openai_edits' && <p className="creative-helper">这些图片将作为图片修改的输入，所选服务根据创作描述生成新的作品。</p>}
          {draft.references.length > 0 && policy?.binding === 'ark_video' && <label className="creative-reference-binding">图片在视频中的用途<select aria-label="图片在视频中的用途" value={draft.referenceMode} onChange={(event) => update({ referenceMode: event.target.value as CreativeDraft['referenceMode'] })}><option value="first_frame">首帧 · 恰好一张图片</option><option value="first_last_frame">首尾帧 · 恰好两张，按顺序使用</option><option value="reference_image">参考图 · 使用图片中的主体与画面线索</option></select><small>首尾帧顺序就是上方图片顺序。参考图模式是否适用，取决于所选模型。部分首帧/首尾帧模型需要画幅选择“随参考图”。</small></label>}
          {draft.references.length > 0 && policy?.binding === 'fal_input' && <label className="creative-reference-binding">模型的图片输入方式<select aria-label="模型的图片输入方式" value={draft.referenceField} onChange={(event) => update({ referenceField: event.target.value as CreativeDraft['referenceField'] })}><option value="image_url">单图输入 · image_url</option><option value="image_urls">多图输入 · image_urls</option></select><small>所选服务提供图片输入通道；具体模型需要支持对应字段。多图不能使用单图字段，请核对模型说明。</small></label>}
        </div>
        <button className="text-button" type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><SlidersHorizontal size={15} />高级参数</button>
        {advanced && <label className="advanced-options">高级参数 JSON<textarea aria-label="高级创作参数" value={draft.optionsText} onChange={(event) => update({ optionsText: event.target.value })} rows={3} maxLength={20000} placeholder={policy?.binding === 'fal_input' || provider?.id === 'fal' ? '{"input": {"seed": 42}}' : provider?.id === 'openai' || provider?.id === 'comfyui' ? '{}' : '{"seed": 42}'} /><small>ComfyUI 参数由固定模板决定，留空即可。其他服务仅填写所选模型支持的参数；fal 的模型参数放在 input 中。参考绑定、画幅和时长由上方选项设置，请勿填写密钥或连接配置。</small></label>}
        <div className="creative-composer-footer"><span>{pending === 'upload' ? '正在上传图片…' : pending === 'reuse' ? '正在读取作品参考…' : '图片只在确认创作后交给所选服务。'}</span><button className="primary" type="submit" disabled={!draft.prompt.trim() || !draft.provider}>{pending && <Loader2 size={15} className="spin" />}{provider?.id === 'comfyui' ? '使用当前模板审阅' : '审阅本次创作'}<ArrowRight size={15} /></button></div>
      </fieldset>
    </form>
    <ConnectionNote provider={provider} />
    {!review && provider?.id === 'comfyui' && <><ExecutionTemplateDetails binding={captureExecutionTemplate(provider.id, providers)} fixed={false} /><button className="secondary" type="button" disabled={!!pending} onClick={refreshTemplateStatus}><RotateCcw size={14} className={pending === 'refresh' ? 'spin' : ''} />{pending === 'refresh' ? '正在刷新…' : '刷新模板状态'}</button></>}
    {review && <section ref={reviewSection} tabIndex={-1} className="creative-review" aria-label="完整创作任务审阅"><div className="creative-review-heading"><h2>本次创作审阅</h2><Badge tone="amber">确认后开始</Badge></div><dl><div><dt>创作类型</dt><dd>{review.job.kind === 'image' ? review.references.length ? '参考图片修改' : '文字生成图片' : review.references.length ? '参考图片生成视频' : '文字生成视频'}</dd></div><div><dt>所选服务</dt><dd>{providers.find((entry) => entry.id === review.job.provider)?.name || review.job.provider}</dd></div><div><dt>模型</dt><dd>{review.job.provider === 'comfyui' ? '由固定生成模板决定' : review.job.model || '服务端默认模型'}</dd></div>{review.job.options?.aspectRatio === undefined && <div><dt>生成规格</dt><dd>{review.job.provider === 'comfyui' ? '由服务端模板决定' : '使用所选模型默认规格；高级 input 可设置模型支持的参数'}</dd></div>}{review.job.options?.aspectRatio !== undefined && <div><dt>画幅{review.job.options?.duration !== undefined ? '与时长' : ''}</dt><dd>{review.job.options.aspectRatio === 'adaptive' ? '随参考图' : String(review.job.options.aspectRatio)}{review.job.options?.duration !== undefined ? ` · ${String(review.job.options.duration)} 秒` : ''}</dd></div>}</dl>{review.job.provider === 'comfyui' && <><ExecutionTemplateDetails binding={review.job.executionTemplate} /><button className="secondary" type="button" disabled={!!pending} onClick={refreshTemplateStatus}><RotateCcw size={14} className={pending === 'refresh' ? 'spin' : ''} />{pending === 'refresh' ? '正在刷新…' : '刷新模板状态'}</button><p className="creative-helper">刷新保留已审阅版本。返回编辑后，使用当前模板重新审阅。</p></>}<h3>创作描述</h3><pre className="creative-review-prompt">{review.job.prompt}</pre>
      {review.references.length > 0 && <><h3>按以下顺序使用参考图片</h3><CreativeReferenceList references={review.references} firstLast={review.job.options?.referenceMode === 'first_last_frame'} /><p className="creative-helper">{review.job.options?.referenceMode === 'first_frame' ? '第一张图片作为视频首帧。' : review.job.options?.referenceMode === 'first_last_frame' ? '第一张作为首帧，第二张作为尾帧。' : review.job.options?.referenceMode === 'reference_image' ? '图片作为主体与画面线索的参考，具体效果由所选模型决定。' : review.job.options?.referenceField ? `图片通过${review.job.options.referenceField === 'image_urls' ? '多图' : '单图'}输入交给所选模型，请确认模型支持。` : '参考图片作为此次图片修改的输入。'}</p></>}
      {Object.keys(review.job.options || {}).some((key) => !['aspectRatio', 'duration', 'referenceMode', 'referenceField'].includes(key)) && <details className="creative-advanced-review"><summary>已审阅的高级参数</summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(review.job.options || {}).filter(([key]) => !['aspectRatio', 'duration', 'referenceMode', 'referenceField'].includes(key))), null, 2)}</pre></details>}
      <p className="creative-helper">确认后会创建一个新的创作任务，执行时可能产生所选服务费用。既有作品保留；修改草稿需返回编辑，后来修改不会改变已创建任务。</p>
      {readiness.length > 0 && <div className="creative-readiness" role="status"><strong>开始前需要处理</strong>{readiness.map((issue) => <p key={issue}>{issue}</p>)}</div>}
      <div className="creative-review-actions"><button className="secondary" type="button" disabled={!!pending} onClick={() => setReview(null)}><X size={14} />返回编辑</button><button className="primary" type="button" disabled={!!pending || readiness.length > 0} onClick={create}>{pending === 'create' ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}确认并开始创作</button></div>
    </section>}
    <div className="section-title results-title"><h3>你的创作</h3><span>{filtered.length ? `${filtered.length} TASKS` : 'A CLEAN SLATE'}</span></div>
    {filtered.length ? <div className="jobs-grid">{filtered.map((job) => <JobCard key={job.id} job={job} onCancel={onCancel} onRetry={onRetry} onBringArtifactToAgent={onBringArtifactToAgent} handoffDisabled={handoffDisabled} onUseImage={(artifact, target) => reuse(artifact, job, target)} imageActionsDisabled={disabled} />)}</div> : <Empty icon={<FolderOpen size={27} strokeWidth={1.4} />} title="第一件作品，从你的想法开始">审阅并确认后，执行状态和作品会显示在这里。图片作品可以继续用于下一轮创作。</Empty>}
  </section>;
}
