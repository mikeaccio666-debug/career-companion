import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, CheckCircle2, Circle, Clock3, Download, Loader2, RotateCcw, X } from 'lucide-react';
import type { Artifact, Job, Provider } from './types';
import type { CreativeKind } from './creative-plan';
import { jobRetryPresentation } from './job-retry';
import { browserExecutionPresentation } from './browser-plan';
import MediaPreview from './MediaPreview';
import ExecutionTemplateDetails from './ExecutionTemplateDetails';
import { taskExecutionTemplates } from './execution-template';
import ArtifactAgentAction from './ArtifactAgentAction';
import { usePlatformAccountClient } from './account-client';
import { holdPrivateResource } from './private-media';
import PrivateFileLink from './PrivateFileLink';
import PrivateImage from './PrivateImage';
import McpResultView from './McpResultView';
import './agent-handoff.css';
export function isProviderReady(provider?: Provider, _capability?: string) { return !!provider?.keyConfigured && provider.enabled !== false; }
export function hasCapability(provider: Provider, capability: string): boolean {
  if (capability === 'companion') return provider.capabilities.includes('chat');
  if (capability === 'voice') return provider.capabilities.some((value) => ['speech', 'transcription', 'realtime'].includes(value));
  return provider.capabilities.some((value) => value === capability);
}
export function providerModels(provider: Provider | undefined, capability: string): string[] {
  const effective = capability === 'companion' ? 'chat' : capability;
  if (provider?.modelsByCapability) return (provider.modelsByCapability as Record<string, string[] | undefined>)[effective] || [];
  return provider?.models || [];
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><img src="/mark.svg" alt="" /><span>openfield<span className="brand-dot">.</span></span></div>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>; }
export function ProviderSelect({ providers, value, onChange, capability, disabled = false, label = '能力服务' }: { providers: Provider[]; value: string; onChange: (value: string) => void; capability: string; disabled?: boolean; label?: string }) {
  const options = providers.filter((provider) => hasCapability(provider, capability) || (capability === 'agent' && provider.capabilities.includes('chat')));
  return <label className="provider-select"><span className={`connection-dot ${isProviderReady(options.find((p) => p.id === value), capability) ? 'online' : ''}`} /><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}><option value="">选择模型服务</option>{value && !options.some((provider) => provider.id === value) && <option value={value}>{value} · 当前不可用</option>}{options.map((provider) => <option value={provider.id} key={provider.id}>{provider!.name || provider!.id}{isProviderReady(provider, capability) ? '' : provider.keyConfigured ? ' · 已停用' : ' · 待配置'}</option>)}</select></label>;
}
export function ArtifactView({ artifact, onUseImage, imageActionsDisabled = false, onBringToAgent, handoffDisabled = false, handoffLabel }: { artifact: Artifact; onUseImage?: (artifact: Artifact, kind: CreativeKind) => void; imageActionsDisabled?: boolean; onBringToAgent?: (artifact: Artifact) => void; handoffDisabled?: boolean; handoffLabel?: string }) {
  const client = usePlatformAccountClient();
  const type = artifact.mime || '';
  const reusableImage = ['image/png', 'image/jpeg', 'image/webp'].includes(type);
  const browserObservation = artifact.name === 'browser-observation.json' && type === 'application/json';
  const image = type.startsWith('image') || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(artifact.url);
  const video = type.startsWith('video') || /\.(mp4|webm|mov)(\?|$)/i.test(artifact.url);
  const audio = type.startsWith('audio') || /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(artifact.url);
  const isText = !browserObservation && (type.startsWith('text/') || type === 'application/json');
  const fileUrl = client?.privateFileUrl(artifact.url);
  const [preview, setPreview] = useState<{ client: typeof client; url: string | undefined; text: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!isText || !fileUrl || !client?.isCurrent()) return;
    const controller = new AbortController();
    const stop = holdPrivateResource(client, () => { controller.abort(); if (!client.isCurrent()) setPreview(null); });
    client.readPrivateFileText(artifact.url, controller.signal).then((content) => {
      if (!controller.signal.aborted && client.isCurrent()) setPreview({ client, url: fileUrl, text: content.slice(0, 100_000), failed: false });
    }).catch(() => { if (!controller.signal.aborted && client.isCurrent()) setPreview({ client, url: fileUrl, text: null, failed: true }); });
    return stop;
  }, [client, fileUrl, artifact.url, isText]);
  const currentPreview = preview?.client === client && preview?.url === fileUrl ? preview : null;
  if (!client?.isCurrent()) return <div className="artifact" role="status">登录状态已变化，产物预览已关闭。</div>;
  if (browserObservation) return <div className="artifact"><div className="file-result"><ArrowUpRight size={22} /><span>可供 Agent 读取的网页线索</span></div><PrivateFileLink className="artifact-download" url={artifact.url} download name={artifact.name}><Download size={14} />下载网页线索</PrivateFileLink></div>;
  return <div className={`artifact ${image ? 'image-artifact' : ''}`}>{image ? <PrivateImage url={artifact.url} alt={artifact.name || '生成的图片'} /> : video || audio ? <MediaPreview key={`${artifact.id || ''}:${artifact.url}`} url={artifact.url} name={artifact.name} kind={video ? 'video' : 'audio'} /> : isText ? <pre className="text-artifact">{currentPreview?.text ?? (!fileUrl || currentPreview?.failed ? '暂时无法读取预览，可以打开产物重试。' : '正在读取产物…')}</pre> : <div className="file-result"><ArrowUpRight size={22} /><span>{artifact.name || '任务产物'}</span></div>}<PrivateFileLink className="artifact-download" url={artifact.url} download name={artifact.name}><Download size={14} />{artifact.name || '打开产物'}</PrivateFileLink><ArtifactAgentAction artifact={artifact} onBring={onBringToAgent} disabled={handoffDisabled} label={handoffLabel} />{reusableImage && onUseImage && <div className="creative-artifact-actions"><button className="text-button" type="button" disabled={imageActionsDisabled} onClick={() => onUseImage(artifact, 'image')}>继续修改图片<ArrowUpRight size={13} /></button><button className="text-button" type="button" disabled={imageActionsDisabled} onClick={() => onUseImage(artifact, 'video')}>以此生成视频<ArrowUpRight size={13} /></button></div>}</div>;
}
export function isJobActive(job: Job) { return ['queued', 'pending', 'running', 'awaiting_approval', 'needs_approval', 'waiting', 'processing'].includes(job.status); }
export function statusLabel(status: string) { return ({ queued: '排队中', pending: '等待中', running: '执行中', processing: '处理中', succeeded: '已完成', completed: '已完成', failed: '失败', cancelled: '已取消', awaiting_approval: '等待批准', needs_approval: '等待批准', uncertain: '状态待确认', waiting: '等待中' } as Record<string, string>)[status] || status; }
export function jobLabel(kind: string) { return ({ image: '图片', video: '视频', speech: '语音', browser: '浏览器', cli: '终端', workflow: '工作流', mcp: '外部工具' } as Record<string, string>)[kind] || kind; }
export function workflowStepLabel(state: string) { return ({ pending: '尚未开始', started: '执行中', provider_task: '供应商处理中', completed: '已完成', failed: '失败', uncertain: '结果待确认' } as Record<string, string>)[state] || state; }
export function JobCard({ job, onCancel, onRetry, onUseImage, imageActionsDisabled = false, onBringArtifactToAgent, onBringMcpToAgent, handoffDisabled = false, handoffLabel, allowTaskActions = true }: { job: Job; onCancel: (job: Job) => void; onRetry: (job: Job) => void; onUseImage?: (artifact: Artifact, kind: CreativeKind) => void; imageActionsDisabled?: boolean; onBringArtifactToAgent?: (job: Job, artifact: Artifact) => void; onBringMcpToAgent?: (job: Job) => void; handoffDisabled?: boolean; handoffLabel?: string; allowTaskActions?: boolean }) {
  const active = isJobActive(job);
  const success = ['succeeded', 'completed'].includes(job.status);
  const error = job.error?.message;
  const { canRetry, label: retryLabel, note: retryNote } = jobRetryPresentation(job);
  const browserExecution = job.kind === 'browser' ? browserExecutionPresentation(job.browserExecution) : undefined;
  const executionTemplates = taskExecutionTemplates(job);
  return <article className="job-card"><div className="job-heading"><Badge tone={success ? 'green' : job.status === 'failed' ? 'red' : active ? 'amber' : 'neutral'}>{active ? <Loader2 size={12} className="spin" /> : success ? <Check size={12} /> : <Circle size={11} />}{statusLabel(job.status)}</Badge><span>{jobLabel(job.kind)} · {job.provider}</span></div><p className="job-prompt">{job.prompt}</p>{executionTemplates.map((entry) => <ExecutionTemplateDetails key={entry.label} label={entry.label} binding={entry.binding} />)}{error && <p className="inline-error">{error}</p>}{job.progress !== undefined && active && <progress max="100" value={job.progress} aria-label="任务进度" />}{browserExecution && <div className="browser-job-progress"><strong>{browserExecution.progress}</strong><span>{browserExecution.state}</span>{browserExecution.reviewRequired && ['failed', 'cancelled', 'uncertain'].includes(job.status) && <p>请核对已有结果，再决定新的完整计划。</p>}</div>}{job.workflowSteps?.length ? <ol className="workflow-job-steps" aria-label="工作流步骤状态">{job.workflowSteps.map((step) => <li key={step.index}><span>{step.index + 1}. {step.kind === 'chat' ? '文字' : jobLabel(step.kind)}</span><span>{workflowStepLabel(step.state)}</span><small>{step.provider}{step.model ? ` · ${step.model}` : ''}{step.errorCode ? ` · ${step.errorCode}` : ''}</small></li>)}</ol> : null}{job.kind === 'mcp' && job.mcp && <p className="mcp-task-summary">{job.mcp.connectionName} · {job.mcp.toolName}<br />本平台授权版本 {job.mcp.grantVersion}</p>}{job.kind === 'mcp' && ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(job.status) && <McpResultView job={job} onBringToAgent={onBringMcpToAgent} handoffDisabled={handoffDisabled} handoffLabel={handoffLabel} />}{job.kind !== 'mcp' && job.artifacts?.length ? <div className="artifact-grid">{job.artifacts.map((artifact, index) => <ArtifactView key={artifact.id || `${job.id}-${index}`} artifact={artifact} onUseImage={onUseImage} imageActionsDisabled={imageActionsDisabled} onBringToAgent={onBringArtifactToAgent ? (selected) => onBringArtifactToAgent(job, selected) : undefined} handoffDisabled={handoffDisabled} handoffLabel={handoffLabel} />)}</div> : null}<div className="job-actions">{allowTaskActions && active && <button className="text-button" onClick={() => onCancel(job)}><X size={14} />取消任务</button>}{allowTaskActions && canRetry && <button className="text-button" onClick={() => onRetry(job)}><RotateCcw size={14} />{retryLabel}</button>}<span><Clock3 size={12} />{job.createdAt ? new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '已保存'}</span></div>{retryNote && <p className="retry-note">{retryNote}</p>}</article>;
}
export function ConnectionNote({ provider }: { provider?: Provider }) { return isProviderReady(provider) ? <p className="connection-note"><CheckCircle2 size={14} />已配置 {provider!.name || provider!.id}。请求由所选服务处理，首次调用确认可用性。</p> : <p className="connection-note unavailable"><Circle size={14} />{provider ? provider.reason || (provider.keyConfigured ? '此服务当前停用，请检查服务端执行策略。' : '此服务待配置，请在服务端设置环境变量。') : '选择已配置并启用的服务开始。'}</p>; }
