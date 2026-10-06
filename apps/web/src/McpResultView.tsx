import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileText, Loader2, RefreshCw } from 'lucide-react';
import type { Job, McpResult, McpResultInput } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { errorText } from './api';
import { createMcpClient } from './mcp-api';
import { McpOperationScope, parseMcpSummary } from './mcp-editor';
import './mcp.css';

export default function McpResultView({ job, onBringToAgent, handoffDisabled, handoffLabel = '结果引用带到 Agent' }: { job: Job; onBringToAgent?: (job: Job) => void; handoffDisabled?: boolean; handoffLabel?: string }) {
  const account = useRequiredPlatformAccountClient(), api = useMemo(() => createMcpClient(account.request), [account]);
  const scope = useRef(new McpOperationScope()), loadingLatch = useRef(false);
  const [page, setPage] = useState<McpResult | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => { scope.current.mount(account.account.accountId, account.isCurrent); loadingLatch.current = false; return () => { scope.current.dispose(); loadingLatch.current = false; }; }, [account, api, job.id]);
  function read(next = false) {
    if (loadingLatch.current || !scope.current.active || !account.isCurrent()) return;
    const input: McpResultInput = next && page?.nextOffset !== null && page?.nextOffset !== undefined ? { jobId: job.id, offset: page.nextOffset, version: page.version } : { jobId: job.id };
    loadingLatch.current = true; setLoading(true); setError('');
    void scope.current.run('result', (signal) => api.result(input, signal), { apply: (result) => {
      const summary = parseMcpSummary(job.mcp);
      if (!summary || Object.entries(summary).some(([key, value]) => result.source[key as keyof typeof summary] !== value)) throw new Error('结果与当前任务的冻结连接不匹配，请刷新任务记录。');
      setPage(result);
    }, onError: (failure) => setError(`${errorText(failure)}${page ? ' 已显示的内容来自之前读取的一页，不能当作最新全文。' : ''}`), finally: () => { loadingLatch.current = false; setLoading(false); } });
  }
  return <section className="mcp-result" aria-label="外部工具原始结果"><div className="mcp-result-heading"><strong><FileText size={14} />已保存的工具结果</strong><button className="text-button" type="button" disabled={loading} onClick={() => read()}><RefreshCw size={13} />{page ? '从第一页重新读取' : '读取结果'}</button></div>{loading && <p className="mcp-loading" role="status"><Loader2 size={14} className="spin" />正在读取已保存结果…</p>}{error && <p className="form-error" role="alert">{error}</p>}{page ? <><p className="mcp-boundary">外部资料，未经验证。当前显示从第 {page.offset.toLocaleString()} 字节开始的一页{page.truncated ? '，并非全文' : ''}。</p><pre>{page.text}</pre><div className="mcp-result-actions">{page.nextOffset !== null && <button className="secondary" type="button" disabled={loading} onClick={() => read(true)}>读取下一页<ArrowRight size={13} /></button>}{onBringToAgent && <button className="text-button" type="button" disabled={handoffDisabled || loading || !account.isCurrent()} onClick={() => onBringToAgent(job)}>{handoffLabel}<ArrowRight size={13} /></button>}</div>{onBringToAgent && <small>只追加任务引用草稿，不复制结果或自动发送；发送后读取的资料可能交给你选择的模型。</small>}</> : <p className="mcp-boundary">只读取服务端已保存的结果。没有结果时会显示实际错误，不会重新调用外部工具。</p>}</section>;
}
