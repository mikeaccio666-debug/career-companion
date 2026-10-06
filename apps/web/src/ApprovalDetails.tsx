import { useEffect, useRef, useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import type { Approval, Provider } from './types';
import BrowserPlanDetails from './BrowserPlanDetails';
import { browserFixtureOrigins, browserPlanReadiness, parseBrowserApprovalPlan, type BrowserPlan } from './browser-plan';
import './browser.css';
import ExecutionTemplateDetails from './ExecutionTemplateDetails';
import { taskExecutionTemplates } from './execution-template';
import McpApprovalDetails from './McpApprovalDetails';
import { mcpApprovalPlan } from './mcp-editor';
import { useRequiredPlatformAccountClient } from './account-client';
import { errorText } from './api';

export default function ApprovalDetails({ approval, providers, onDecision }: { approval: Approval; providers: Provider[]; onDecision: (approval: Approval, value: 'approve' | 'reject') => void | Promise<void> }) {
  const client = useRequiredPlatformAccountClient(), busy = useRef(false), live = useRef(false);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState('');
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, [client, approval.id]);
  async function decide(value: 'approve' | 'reject') {
    if (busy.current || !live.current || !client.isCurrent()) return;
    busy.current = true; setDeciding(true); setDecisionError('');
    try { await onDecision(approval, value); } catch (failure) { if (live.current && client.isCurrent()) setDecisionError(errorText(failure)); } finally { if (live.current && client.isCurrent()) { busy.current = false; setDeciding(false); } }
  }
  const browser = approval.toolName === 'browser' || approval.args.kind === 'browser';
  const mcp = approval.toolName === 'mcp' || approval.args.kind === 'mcp';
  const mcpPlan = mcp ? mcpApprovalPlan(approval) : undefined;
  let plan: BrowserPlan | undefined; let failure = '';
  const provider = providers.find((item) => item.id === 'browser');
  if (browser) {
    try {
      plan = parseBrowserApprovalPlan(approval.args, browserFixtureOrigins(provider));
    } catch { failure = '审批计划不完整或包含当前不支持的操作，暂时不能批准。请拒绝后重新创建完整计划。'; }
  }
  const readiness = plan ? browserPlanReadiness(plan, provider) : [];
  const executionTemplates = taskExecutionTemplates(approval.args);
  const missingTemplate = executionTemplates.some((entry) => !entry.binding);
  return <article className={`approval-card ${browser ? 'browser-approval-card' : ''}`}>
    <strong>{browser ? <><ShieldCheck size={14} />浏览器计划等待批准</> : mcp ? <><ShieldCheck size={14} />外部工具调用等待批准</> : approval.toolName}</strong>
    {executionTemplates.map((entry) => <ExecutionTemplateDetails key={entry.label} label={entry.label} binding={entry.binding} />)}
    {executionTemplates.length > 0 && <p className="browser-boundary-note">此任务使用创建时固定的生成模板。之后更新服务端模板不会改变本次任务。</p>}
    {missingTemplate && <p className="inline-error" role="status">此任务尚未固定有效的生成模板版本，暂时不能批准。请拒绝后使用当前模板重新审阅并创建。</p>}
    {mcp ? <McpApprovalDetails plan={mcpPlan} /> : plan ? <BrowserPlanDetails plan={plan} compact /> : browser ? <p className="inline-error" role="status">{failure}</p> : <pre>{JSON.stringify(approval.args, null, 2)}</pre>}
    {browser && approval.args.previousAttemptUncertain === true && <p className="browser-boundary-note">上次执行结果待确认，请先核对已保存结果。</p>}
    {readiness.length > 0 && <p className="browser-boundary-note">{readiness.join(' ')}</p>}
    {decisionError && <p className="inline-error" role="alert">{decisionError}</p>}
    <div className="approval-decisions"><button className="secondary" disabled={deciding} onClick={() => void decide('reject')}><X size={13} />拒绝</button><button className="primary" disabled={deciding || missingTemplate || mcp && !mcpPlan || browser && (!plan || readiness.length > 0)} onClick={() => void decide('approve')}><Check size={13} />{deciding ? '处理中…' : browser ? '批准此计划' : mcp ? '批准这次调用' : '批准'}</button></div>
  </article>;
}
