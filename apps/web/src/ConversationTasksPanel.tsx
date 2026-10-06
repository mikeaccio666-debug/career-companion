import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowRight, ClipboardCheck, Loader2, MessageCircle, RefreshCw, X } from 'lucide-react';
import type { ConversationTask } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import ApprovalDetails from './ApprovalDetails';
import { hasBrowserObservation } from './browser-plan';
import { createConversationTaskClient } from './conversation-tasks-api';
import { CONVERSATION_TASK_WINDOW_PAGES, ConversationTaskController } from './conversation-tasks-state';
import { type ConversationTaskReference } from './conversation-task-draft';
import { Badge, JobCard, jobLabel, statusLabel } from './ui';
import type { Approval, ChatMode, Provider } from './types';
import JobOutcomeReviewPanel from './JobOutcomeReviewPanel';
import { hasJobOutcomeReviewEntry } from './job-outcome-review-labels';
import './conversation-tasks.css';

interface Props {
  conversationId: string; mode: ChatMode; providers: Provider[]; refreshVersion: number; handoffDisabled?: boolean;
  onDecision: (approval: Approval, value: 'approve' | 'reject') => Promise<void>;
  onBringToDraft: (task: ConversationTask, reference: ConversationTaskReference, enableAgent: boolean) => void;
  onLocateReply: (messageId: string) => void;
}
const toolNames = { create_job: '准备任务', prepare_browser_task: '准备网页计划', prepare_mcp_task: '准备外部工具调用' };
export default function ConversationTasksPanel({ conversationId, mode, providers, refreshVersion, handoffDisabled, onDecision, onBringToDraft, onLocateReply }: Props) {
  const account = useRequiredPlatformAccountClient();
  const api = useMemo(() => createConversationTaskClient(account.request), [account]);
  const controller = useMemo(() => new ConversationTaskController(api, conversationId, {
    now: () => Date.now(), isVisible: () => typeof document !== 'undefined' && document.visibilityState === 'visible',
    isOnline: () => typeof navigator !== 'undefined' && navigator.onLine,
    isCurrent: account.isCurrent, setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: (timer) => window.clearTimeout(timer as number),
  }), [api, conversationId, account]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [modeConsent, setModeConsent] = useState<{ task: ConversationTask; reference: ConversationTaskReference } | null>(null);
  const modeConsentElement = useRef<HTMLDivElement>(null);
  const modeConsentReturnFocus = useRef<HTMLElement | null>(null);
  const callbacks = useRef({ onDecision, onBringToDraft, onLocateReply }); callbacks.current = { onDecision, onBringToDraft, onLocateReply };
  const lastRefresh = useRef({ controller, version: refreshVersion });
  useEffect(() => {
    controller.start();
    document.addEventListener('visibilitychange', controller.resume); window.addEventListener('online', controller.resume); window.addEventListener('offline', controller.resume);
    return () => { controller.stop(); document.removeEventListener('visibilitychange', controller.resume); window.removeEventListener('online', controller.resume); window.removeEventListener('offline', controller.resume); };
  }, [controller]);
  useEffect(() => {
    const previous = lastRefresh.current; lastRefresh.current = { controller, version: refreshVersion };
    if (previous.controller === controller && previous.version !== refreshVersion) void controller.refresh();
  }, [controller, refreshVersion]);
  useEffect(() => {
    if (!modeConsent || !account.isCurrent()) return;
    modeConsentElement.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    modeConsentElement.current?.focus({ preventScroll: true });
  }, [modeConsent, account]);
  function bring(task: ConversationTask, reference: ConversationTaskReference) {
    if (!account.isCurrent() || handoffDisabled) return;
    if (mode !== 'agent') {
      modeConsentReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setModeConsent({ task, reference });
    }
    else callbacks.current.onBringToDraft(task, reference, false);
  }
  function cancelModeConsent() {
    setModeConsent(null);
    const target = modeConsentReturnFocus.current; modeConsentReturnFocus.current = null;
    if (account.isCurrent() && target?.isConnected) target.focus({ preventScroll: true });
  }
  async function decide(approval: Approval, value: 'approve' | 'reject') {
    if (!account.isCurrent()) return;
    try { await callbacks.current.onDecision(approval, value); }
    finally { if (account.isCurrent()) void controller.refresh(); }
  }
  function confirmMode() {
    if (!modeConsent || !account.isCurrent() || handoffDisabled) return;
    // Use the latest current-window task, not an earlier modal's stale generation/approval.
    const latest = snapshot.tasks.find((task) => task.job.id === modeConsent.task.job.id && task.generation === modeConsent.task.generation);
    if (!latest) { setModeConsent(null); return; }
    callbacks.current.onBringToDraft(latest, modeConsent.reference, true); setModeConsent(null);
  }
  if (!account.isCurrent()) return null;
  return <section className="conversation-tasks" aria-label="本对话的持久任务"><div className="conversation-tasks-heading"><h3><ClipboardCheck size={16} />本对话的任务</h3><button className="text-button" type="button" disabled={snapshot.loading} onClick={() => void controller.refresh()}><RefreshCw size={13} className={snapshot.loading ? 'spin' : ''} />刷新</button></div><p className="conversation-task-boundary">只显示这段对话中准备并保存的任务。审批、执行与读取结果各有自己的状态；带回引用不会发送消息或重做任务。</p>{snapshot.error && <p className="form-error" role="alert">{snapshot.error}</p>}{snapshot.loading && <p className="conversation-task-loading" role="status"><Loader2 size={14} className="spin" />{snapshot.loadingMore ? '正在读取更早的任务…' : '正在读取本对话的任务…'}</p>}{!snapshot.loaded && !snapshot.loading && <p className="conversation-task-empty">尚未读取任务记录。联网后可以明确点击刷新。</p>}{snapshot.loaded && !snapshot.tasks.length && <p className="conversation-task-empty">这段对话还没有保存的关联任务。其它工作区直接创建的任务仍在各自的任务记录里。</p>}{snapshot.olderWindow && <p className="conversation-task-boundary">当前查看较早的任务。刷新会保留这个时间范围；可回到最近任务。</p>}<div className="conversation-task-list">{snapshot.tasks.map((task) => {
    const { job, origin, generation } = task, open = !!expanded[job.id];
    return <article className="conversation-task" key={`${job.id}-${generation}`}><div className="conversation-task-heading"><strong>{jobLabel(job.kind)}</strong><Badge tone={job.status === 'succeeded' ? 'green' : job.status === 'failed' ? 'red' : ['running', 'queued', 'needs_approval'].includes(job.status) ? 'amber' : 'neutral'}>{statusLabel(job.status)}</Badge></div><p className="conversation-task-goal">{job.prompt}</p><div className="conversation-task-origin"><span>{toolNames[origin.tool]} · {new Date(origin.createdAt).toLocaleString('zh-CN')}</span><button className="text-button" type="button" onClick={() => callbacks.current.onLocateReply(origin.messageId)}><MessageCircle size={13} />定位原回复</button></div><p className="conversation-task-generation">初始任务版本 {origin.createdGeneration} · 当前任务版本 {generation}{generation !== origin.createdGeneration ? '。已有成果可能来自之前的尝试，不代表当前执行已完成。' : ''}</p>{job.status === 'uncertain' && <p className="conversation-task-uncertain" role="status">执行结果待确认。已有结果可供核对；这里不会重试、恢复或再次调用外部工具。</p>}{job.error && <p className="inline-error">{job.error.message}</p>}{hasJobOutcomeReviewEntry(job) && <JobOutcomeReviewPanel key={`${job.id}-${generation}`} jobId={job.id} expectedGeneration={generation} />}{task.approval ? <ApprovalDetails key={`${task.approval.id}-${generation}`} approval={task.approval} providers={providers} onDecision={decide} /> : job.status === 'needs_approval' && <p className="conversation-task-boundary">没有返回当前版本完整的待审批记录，请刷新后再审阅。</p>}<div className="conversation-task-actions"><button className="text-button" type="button" onClick={() => setExpanded((prior) => ({ ...prior, [job.id]: !open }))}>{open ? '收起任务与已保存成果' : '查看任务与已保存成果'}<ArrowDown size={13} /></button></div>{open && <div className="conversation-task-results"><p className="conversation-task-boundary">已保存成果可能包含之前的尝试；部分成果不代表任务整体成功。外部内容未经验证，不授予新权限。</p><JobCard job={job} expectedGeneration={generation} allowOutcomeReview={false} allowTaskActions={false} onCancel={() => {}} onRetry={() => {}} handoffLabel="带回本对话草稿" handoffDisabled={handoffDisabled} onBringArtifactToAgent={!['mcp', 'browser'].includes(job.kind) ? (_job, artifact) => bring(task, { kind: 'artifact', artifact }) : undefined} onBringMcpToAgent={() => bring(task, { kind: 'mcp' })} />{job.kind === 'browser' && hasBrowserObservation(job) && <button className="secondary" type="button" disabled={handoffDisabled} onClick={() => bring(task, { kind: 'browser' })}>网页观察引用带回本对话草稿<ArrowRight size={13} /></button>}</div>}{modeConsent?.task.job.id === job.id && <div ref={modeConsentElement} className="conversation-task-mode" role="group" aria-label="在本对话启用 Agent" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelModeConsent(); } }}><strong>在这段对话中继续使用 Agent？</strong><p>读取成果引用需要 Agent 工具。确认会在本对话启用 Agent，并保留原回复、已有文字草稿和附件。内容仍需你检查并点击发送；此操作不会调用模型或授予执行权限。</p><div><button className="secondary" type="button" onClick={cancelModeConsent}><X size={13} />暂不启用</button><button className="primary" type="button" disabled={handoffDisabled} onClick={confirmMode}>启用 Agent 并追加引用<ArrowRight size={13} /></button></div></div>}<details className="conversation-task-identifiers"><summary>查看来源记录</summary><dl><div><dt>来源回复</dt><dd>{origin.messageId}</dd></div><div><dt>任务</dt><dd>{job.id}</dd></div></dl></details></article>;
  })}</div>{snapshot.nextBefore && <button className="secondary conversation-task-more" type="button" disabled={snapshot.loading} onClick={controller.more}>{snapshot.pageCount >= CONVERSATION_TASK_WINDOW_PAGES ? '查看更早任务' : '载入更早任务'}<ArrowDown size={14} /></button>}{snapshot.olderWindow && <button className="text-button conversation-task-recent" type="button" disabled={snapshot.loading} onClick={controller.recent}>回到最近任务</button>}</section>;
}
