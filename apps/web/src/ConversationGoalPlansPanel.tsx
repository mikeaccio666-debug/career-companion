import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowRight, ClipboardCheck, Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import type { GoalPlanProposalSummary } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { createConversationGoalPlanClient } from './conversation-goal-plans-api';
import { ConversationGoalPlanController, GOAL_PROPOSAL_WINDOW_PAGES } from './conversation-goal-plans-state';
import { conversationGoalPlanLabel } from './conversation-goal-plan-labels';
import { Badge } from './ui';
import './conversation-goal-plans.css';

interface Props { conversationId: string; refreshVersion: number; disabled?: boolean; onReview: (proposal: GoalPlanProposalSummary) => void; onLocateReply: (messageId: string) => void }
export default function ConversationGoalPlansPanel({ conversationId, refreshVersion, disabled, onReview, onLocateReply }: Props) {
  const account = useRequiredPlatformAccountClient();
  const api = useMemo(() => createConversationGoalPlanClient(account.request), [account]);
  const controller = useMemo(() => new ConversationGoalPlanController(api, conversationId, { now: Date.now, isCurrent: account.isCurrent, isVisible: () => document.visibilityState === 'visible', isOnline: () => navigator.onLine, setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: (timer) => window.clearTimeout(timer as number) }), [api, account, conversationId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const callbacks = useRef({ onReview, onLocateReply }); callbacks.current = { onReview, onLocateReply };
  const previous = useRef({ controller, version: refreshVersion });
  useEffect(() => { controller.start(); document.addEventListener('visibilitychange', controller.resume); window.addEventListener('online', controller.resume); window.addEventListener('offline', controller.resume); return () => { controller.stop(); document.removeEventListener('visibilitychange', controller.resume); window.removeEventListener('online', controller.resume); window.removeEventListener('offline', controller.resume); }; }, [controller]);
  useEffect(() => { const old = previous.current; previous.current = { controller, version: refreshVersion }; if (old.controller === controller && old.version !== refreshVersion) void controller.refresh(); }, [controller, refreshVersion]);
  if (!account.isCurrent()) return null;
  return <section className="conversation-goal-plans" aria-label="本对话的计划草稿"><div className="conversation-goal-heading"><h3><ClipboardCheck size={16} />本对话的计划</h3><button type="button" className="text-button" disabled={state.loading} onClick={() => void controller.refresh()}><RefreshCw size={13} />刷新</button></div><p>以下是本对话中提出并保存的计划。审阅会打开原会话的指定计划，保留聊天草稿与附件；不会确认计划、准备任务或发送消息。执行状态请在计划页核对。</p>{state.error && <p className="form-error" role="alert">{state.error}</p>}{state.loading && <p role="status"><Loader2 size={14} className="spin" />正在读取计划记录…</p>}{!state.loaded && !state.loading && <p>尚未读取计划记录。联网后可以明确刷新。</p>}{state.loaded && !state.proposals.length && <p>这段对话尚未保存 Agent 提出的计划草稿。</p>}{state.olderWindow && <p>正在查看较早的计划；刷新保留这个范围。</p>}<div className="conversation-goal-list">{state.proposals.map((proposal) => <article key={proposal.planId}><div className="conversation-goal-card-heading"><strong>{proposal.title}</strong><Badge tone={proposal.status === 'draft' ? 'amber' : 'neutral'}>{conversationGoalPlanLabel(proposal.status)}</Badge></div><p>{proposal.stepCount} 步 · 当前保存版本 {proposal.revision} · {new Date(proposal.createdAt).toLocaleString('zh-CN')}</p><div className="conversation-goal-actions"><button type="button" className="secondary" disabled={disabled} onClick={() => { if (account.isCurrent()) callbacks.current.onReview(proposal); }}>审阅计划<ArrowRight size={14} /></button>{proposal.messageId ? <button type="button" className="text-button" disabled={disabled} onClick={() => { if (account.isCurrent() && proposal.messageId) callbacks.current.onLocateReply(proposal.messageId); }}><MessageCircle size={13} />定位提出计划的原回复</button> : <span>原回复已删除，已保存计划仍可审阅。</span>}</div></article>)}</div>{state.nextBefore && <button type="button" className="secondary" disabled={state.loading} onClick={controller.more}>{state.pageCount >= GOAL_PROPOSAL_WINDOW_PAGES ? '查看更早计划' : '载入更早计划'}<ArrowDown size={14} /></button>}{state.olderWindow && <button type="button" className="text-button" disabled={state.loading} onClick={controller.recent}>回到最近计划</button>}</section>;
}
