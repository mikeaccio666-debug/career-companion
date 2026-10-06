import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, Link2, Loader2, RefreshCw } from 'lucide-react';
import { MCP_ARGUMENT_MAX_BYTES, type Approval, type Job, type McpConnection, type McpTool } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { errorText } from './api';
import { createMcpClient } from './mcp-api';
import { McpOperationScope, mcpArgumentsBytes, mcpPrepareInput, sameMcpGrant } from './mcp-editor';
import McpConnectionsPanel from './McpConnectionsPanel';
import { Empty, JobCard } from './ui';
import './mcp.css';

export default function McpToolPanel({ jobs, onPrepared, onCancel, onRetry, onBringToAgent, handoffDisabled, onOpenApprovals }: { jobs: Job[]; onPrepared: (value: { job: Job; approval: Approval }) => void; onCancel: (job: Job) => void; onRetry: (job: Job) => void; onBringToAgent: (job: Job) => void; handoffDisabled?: boolean; onOpenApprovals: () => void }) {
  const account = useRequiredPlatformAccountClient(), api = useMemo(() => createMcpClient(account.request), [account]);
  const scope = useRef(new McpOperationScope()), preparingLatch = useRef(false);
  const [connection, setConnection] = useState<McpConnection | null>(null), [tools, setTools] = useState<McpTool[]>([]), [toolName, setToolName] = useState('');
  const [discovering, setDiscovering] = useState(false), [preparing, setPreparing] = useState(false), [goal, setGoal] = useState(''), [argumentsText, setArgumentsText] = useState('{}');
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const chosen = tools.find((tool) => tool.name === toolName) || null, bytes = mcpArgumentsBytes(argumentsText);
  const callbacks = useRef({ onPrepared }); callbacks.current = { onPrepared };
  const selection = useRef<McpConnection | null>(null);
  useEffect(() => { scope.current.mount(account.account.accountId, account.isCurrent); preparingLatch.current = false; return () => { scope.current.dispose(); preparingLatch.current = false; }; }, [account, api]);
  function invalidateSelection(message: string) {
    scope.current.cancel('tools', 'prepare'); preparingLatch.current = false;
    selection.current = null; setConnection(null); setTools([]); setToolName(''); setDiscovering(false); setPreparing(false); setNotice(message);
  }
  function connectionsChanged(items: McpConnection[]) {
    const current = selection.current; if (current && !items.some((item) => sameMcpGrant(current, item))) invalidateSelection('连接授权已变化，工具选择已清除。目标与参数草稿保留，请重新选择后准备。');
  }
  function select(next: McpConnection) {
    if (preparingLatch.current || !scope.current.active || !account.isCurrent()) return;
    scope.current.cancel('tools'); selection.current = next; setConnection(next); setTools([]); setToolName(''); setDiscovering(true); setError('');
    setNotice('正在读取当前授权下的已审阅工具。目标与参数草稿保留，不会执行工具。');
    void scope.current.run('tools', (signal) => api.tools(next.connectionId!, signal), { apply: (result) => {
      if (!sameMcpGrant(next, result.connection)) { invalidateSelection('授权版本已变化，请刷新连接并重新选择。目标与参数草稿保留。'); return; }
      selection.current = result.connection; setConnection(result.connection); setTools(result.tools); setNotice(result.tools.length ? '请选择工具并核对参数。只有准备后再明确批准，任务才会执行。' : '此连接没有服务器已审阅的可用工具。');
    }, onError: (failure) => { setError(errorText(failure)); setTools([]); setToolName(''); }, finally: () => setDiscovering(false) });
  }
  function prepare(event: React.FormEvent) {
    event.preventDefault(); if (preparingLatch.current || !scope.current.active || !account.isCurrent()) return;
    let input; try { input = mcpPrepareInput(connection, chosen, argumentsText, goal); } catch (failure) { setError(errorText(failure)); return; }
    preparingLatch.current = true; setPreparing(true); setError(''); setNotice('');
    void scope.current.run('prepare', (signal) => api.prepare(input, signal), { apply: (result) => { callbacks.current.onPrepared(result); setNotice('调用准备时未执行。后续审批和执行状态请查看“需要你的决定”及任务记录。'); }, onError: (failure) => { setError(`${errorText(failure)} 目标与参数草稿已保留。若准备结果未确认，请先检查任务记录，避免重复准备。`); scope.current.cancel('tools'); selection.current = null; setConnection(null); setTools([]); setToolName(''); setDiscovering(false); }, finally: () => { preparingLatch.current = false; setPreparing(false); } });
  }
  const filtered = jobs.filter((job) => job.kind === 'mcp');
  const priorUnknown = filtered.some((job) => job.status === 'uncertain' && job.mcp?.connectionId === connection?.connectionId && job.mcp?.toolName === toolName);
  return <section className="feature-page mcp-page"><div className="page-kicker"><Link2 size={15} />EXTERNAL TOOLS</div><h1>连接工具，<span>每一步由你决定。</span></h1><p className="page-description">使用服务器已审阅的只读工具，把调用目标和参数保存成待审批任务，查看真实结果。</p><McpConnectionsPanel onSelect={select} onChanged={connectionsChanged} onRevokeIntent={(item) => { if (selection.current?.catalogId === item.catalogId) invalidateSelection('连接授权正在更新，当前选择已清除。目标与参数草稿保留。'); }} selectedConnectionId={connection?.connectionId} />{error && <p className="form-error" role="alert">{error}</p>}{notice && <div className="mcp-notice" role="status"><p>{notice}</p>{notice.startsWith('调用准备时未执行') && <button className="text-button" type="button" onClick={onOpenApprovals}>查看待审批调用<ArrowRight size={13} /></button>}</div>}<form className="mcp-call-editor" onSubmit={prepare}><div className="section-title"><h3>准备一次工具调用</h3>{connection && <button className="text-button" type="button" disabled={discovering || preparing} onClick={() => select(connection)}><RefreshCw size={13} />重新读取工具</button>}</div><p className="mcp-boundary">{connection ? `${connection.name} · 本平台授权版本 ${connection.grantVersion}` : '先从连接列表选择已授权的服务。'} 工具描述和参数格式是外部资料，不授予新的权限。</p>{discovering && <p role="status" className="mcp-loading"><Loader2 size={15} className="spin" />正在读取工具…</p>}<label>已审阅工具<select aria-label="外部工具" value={toolName} disabled={!connection || discovering || preparing} onChange={(event) => { setToolName(event.target.value); setError(''); setNotice('工具已切换，原参数草稿保留，请按新工具格式核对。'); }}><option value="">选择工具</option>{tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}</select></label>{chosen && <div className="mcp-tool-schema">{chosen.description && <p>{chosen.description}</p>}<details><summary>查看服务器审阅的参数格式</summary><pre>{JSON.stringify(chosen.inputSchema, null, 2)}</pre><small>格式版本：{chosen.schemaHash}</small></details></div>}<label>这次调用的目标<textarea aria-label="外部工具调用目标" rows={3} maxLength={20000} value={goal} disabled={preparing} onChange={(event) => setGoal(event.target.value)} placeholder="说明你希望读取哪些信息，以及如何使用结果…" /></label><label>参数 JSON<textarea aria-label="外部工具参数 JSON" className="mcp-json-editor" rows={6} value={argumentsText} disabled={preparing} onChange={(event) => setArgumentsText(event.target.value)} spellCheck={false} /><small className={bytes > MCP_ARGUMENT_MAX_BYTES ? 'mcp-over-limit' : ''}>{bytes.toLocaleString()} / {MCP_ARGUMENT_MAX_BYTES.toLocaleString()} 字节 · 必须是 JSON 对象</small></label>{priorUnknown && <p className="mcp-confirm">这个工具已有结果待确认的任务。请先核对已有结果；新的准备会建立独立任务与审批，不会恢复旧任务。</p>}<div className="mcp-editor-footer"><p>准备不会调用工具。批准后，由服务端执行一次冻结的调用。</p><button className="primary" type="submit" disabled={!chosen || !goal.trim() || bytes > MCP_ARGUMENT_MAX_BYTES || preparing || discovering}>{preparing ? '准备中…' : '准备调用，等待批准'}<ArrowRight size={14} /></button></div></form><div className="section-title results-title"><h3>外部工具任务</h3><span>{filtered.length} TASKS</span></div>{filtered.length ? <div className="jobs-grid">{filtered.map((job) => <JobCard key={job.id} job={job} onCancel={onCancel} onRetry={onRetry} onBringMcpToAgent={onBringToAgent} handoffDisabled={handoffDisabled} />)}</div> : <Empty icon={<FolderOpen size={25} />} title="还没有外部工具任务">准备、审批和结果会保存在同一条任务记录中。</Empty>}</section>;
}
