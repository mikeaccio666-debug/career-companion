import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, Paperclip, SlidersHorizontal, TerminalSquare, X } from 'lucide-react';
import type { CreateJobInput } from '@companion/platform-contracts';
import { errorText } from './api';
import { Badge, ConnectionNote, Empty, isProviderReady, JobCard, ProviderSelect } from './ui';
import type { Artifact, Job, Provider, Upload } from './types';

export default function TaskPanel({ providers, jobs, onCreate, onCancel, onRetry, onUpload, onBringArtifactToAgent, handoffDisabled, onError }: {
  view?: 'cli'; providers: Provider[]; jobs: Job[]; onCreate: (body: CreateJobInput) => Promise<void>;
  onCancel: (job: Job) => void; onRetry: (job: Job) => void; onUpload: (file: File) => Promise<Upload>; onError: (text: string) => void;
  onBringArtifactToAgent?: (job: Job, artifact: Artifact) => void; handoffDisabled?: boolean;
}) {
  const [providerId, setProviderId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [optionsText, setOptionsText] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const provider = providers.find((entry) => entry.id === providerId);
  useEffect(() => {
    const possible = providers.filter((entry) => entry.capabilities.includes('cli'));
    setProviderId((prior) => possible.find((entry) => entry.id === prior)?.id || possible.find((entry) => isProviderReady(entry, 'cli'))?.id || possible[0]?.id || '');
  }, [providers]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isProviderReady(provider, 'cli')) { onError(provider?.reason || '所选能力待配置或已停用。请在设置页查看服务端配置项。'); return; }
    if (!prompt.trim()) return;
    setPending(true);
    try {
      let options: Record<string, unknown> = {};
      if (optionsText.trim()) {
        const parsed = JSON.parse(optionsText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('高级参数需要是 JSON 对象。');
        options = parsed;
      }
      await onCreate({ kind: 'cli', provider: providerId, prompt: prompt.trim(), options, attachmentIds: uploads.map((entry) => entry.id) });
      setPrompt(''); setUploads([]);
    } catch (error) { onError(errorText(error)); } finally { setPending(false); }
  }
  async function attach(files: FileList | null) {
    if (!files) return; setUploading(true);
    try { for (const entry of Array.from(files)) { const upload = await onUpload(entry); setUploads((prior) => [...prior, upload]); } }
    catch (error) { onError(errorText(error)); } finally { setUploading(false); if (file.current) file.current.value = ''; }
  }
  const filtered = jobs.filter((job) => job.kind === 'cli');
  return <section className="feature-page cli-page">
    <div className="page-kicker"><TerminalSquare size={15} />TERMINAL HARNESS</div>
    <h1>想清楚之后，<span>动手做出来。</span></h1>
    <p className="page-description">为终端执行器定义目标。服务端决定隔离环境、允许的工具和执行权限，你可以跟踪输出与审批。</p>
    <form className="task-composer" onSubmit={submit}>
      <div className="task-composer-top"><span><TerminalSquare size={17} />描述任务目标</span><Badge>CLI</Badge></div>
      <textarea aria-label="任务描述" placeholder="描述要在隔离工作区完成的任务、输入和验收标准…" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={20000} />
      <div className="attachments">{uploads.map((upload) => <span className="attachment-chip" key={upload.id}><Paperclip size={12} />{upload.name}<button type="button" aria-label={`移除 ${upload.name}`} onClick={() => setUploads((prior) => prior.filter((entry) => entry.id !== upload.id))}><X size={12} /></button></span>)}</div>
      <div className="task-parameters"><ProviderSelect providers={providers} value={providerId} onChange={setProviderId} capability="cli" /></div>
      {advanced && <label className="advanced-options">高级参数 JSON<textarea aria-label="高级任务参数" rows={3} value={optionsText} onChange={(event) => setOptionsText(event.target.value)} placeholder={'{"seed": 42}'} /><small>参数由所选服务解释，支持项以服务文档为准。</small></label>}
      <div className="task-footer"><div><input ref={file} type="file" multiple hidden onChange={(event) => attach(event.target.files)} /><button className="icon-button" title="添加参考文件" aria-label="添加参考文件" type="button" onClick={() => file.current?.click()} disabled={uploading}><Paperclip size={17} /></button><button type="button" className={`text-button ${advanced ? 'active' : ''}`} onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={15} />参数</button><span className="helper-text">{uploading ? '上传中…' : '参考文件只会在提交任务时使用'}</span></div><button className="primary" disabled={!prompt.trim() || pending || uploading} type="submit">{pending ? '创建任务中…' : '开始任务'}<ArrowRight size={15} /></button></div>
    </form>
    <ConnectionNote provider={provider} />
    <div className="section-title results-title"><h3>任务记录</h3><span>{filtered.length ? `${filtered.length} TASKS` : 'A CLEAN SLATE'}</span></div>
    {filtered.length ? <div className="jobs-grid">{filtered.map((job) => <JobCard key={job.id} job={job} onCancel={onCancel} onRetry={onRetry} onBringArtifactToAgent={onBringArtifactToAgent} handoffDisabled={handoffDisabled} />)}</div> : <Empty icon={<FolderOpen size={27} strokeWidth={1.4} />} title="还没有执行任务">提交后，执行状态、结果和产物会出现在这里。</Empty>}
  </section>;
}
