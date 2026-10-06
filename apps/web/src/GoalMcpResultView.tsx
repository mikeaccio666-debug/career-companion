import { useEffect, useMemo, useRef, useState } from 'react';
import type { GoalPlanTaskReceipt, Job, McpResult, McpResultInput } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { createMcpClient } from './mcp-api';
import { McpOperationScope } from './mcp-editor';
import { assertGoalMcpResult } from './goal-plans-api';
import { errorText } from './api';

/** A manual bounded read of this receipt's result, never a latest-attempt proxy or an external tool call. */
export default function GoalMcpResultView({ job, receipt }: { job: Job; receipt: GoalPlanTaskReceipt }) {
  const account = useRequiredPlatformAccountClient(), api = useMemo(() => createMcpClient(account.request), [account]);
  const scope = useRef(new McpOperationScope()), loadingLatch = useRef(false);
  const [page, setPage] = useState<McpResult | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const binding = `${receipt.jobId}:${receipt.generation}:${receipt.artifactIds.join(',')}`;
  useEffect(() => { scope.current.mount(account.account.accountId, account.isCurrent); loadingLatch.current = false; setPage(null); setError(''); setLoading(false); return () => { scope.current.dispose(); loadingLatch.current = false; }; }, [account, api, job.id, binding]);
  function read(next = false) {
    if (!account.isCurrent() || !scope.current.active || loadingLatch.current) return;
    const input: McpResultInput = next && page?.nextOffset !== null && page?.nextOffset !== undefined ? { jobId: receipt.jobId, offset: page.nextOffset, version: page.version } : { jobId: receipt.jobId };
    loadingLatch.current = true; setLoading(true); setError('');
    void scope.current.run('result', (signal) => api.result(input, signal), { apply(result) { assertGoalMcpResult(result, job, receipt); setPage(result); }, onError(failure) { setError(`${errorText(failure)}${page ? ' 已保留之前读取的一页，不能当作最新全文。' : ''}`); }, finally() { loadingLatch.current = false; setLoading(false); } });
  }
  if (!account.isCurrent()) return null;
  return <section className="mcp-result" aria-label="本计划精确版本的外部工具结果"><div className="mcp-result-heading"><strong>已保存的工具结果 · 任务版本 {receipt.generation}</strong><button className="text-button" type="button" disabled={loading} onClick={() => read()}>{page ? '从第一页重新读取' : '读取本步结果'}</button></div>{loading && <p role="status">正在读取已保存的一页…</p>}{error && <p className="form-error" role="alert">{error}</p>}{page ? <><p className="mcp-boundary">外部内容未经验证。当前显示从第 {page.offset.toLocaleString()} 字节开始的一页{page.truncated ? '，并非全文' : ''}。资源链接只作为文本显示，不会自动访问。</p><pre>{page.text}</pre>{page.nextOffset !== null && <button className="secondary" type="button" disabled={loading} onClick={() => read(true)}>读取同版本下一页</button>}</> : <p className="mcp-boundary">只读取本步成功回执对应的已保存结果。任务版本或成果变化会拒绝显示，不会重新调用工具。</p>}</section>;
}
