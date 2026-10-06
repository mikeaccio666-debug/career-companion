import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Link2, Loader2, RefreshCw, Unplug } from 'lucide-react';
import type { McpConnection } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { errorText } from './api';
import { createMcpClient } from './mcp-api';
import { McpOperationScope, mcpCanConnect } from './mcp-editor';
import './mcp.css';

const statusText = { available: '可连接', connected: '已授权', revoked: '已撤销', unavailable: '当前不可用' };
export default function McpConnectionsPanel({ onSelect, onChanged, onRevokeIntent, selectedConnectionId, onOpenTools }: { onSelect?: (connection: McpConnection) => void; onChanged?: (connections: McpConnection[]) => void; onRevokeIntent?: (connection: McpConnection) => void; selectedConnectionId?: string; onOpenTools?: () => void }) {
  const account = useRequiredPlatformAccountClient(), api = useMemo(() => createMcpClient(account.request), [account]);
  const scope = useRef(new McpOperationScope()), mutation = useRef(false);
  const [connections, setConnections] = useState<McpConnection[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [revokeTarget, setRevokeTarget] = useState<McpConnection | null>(null);
  const callbacks = useRef({ onSelect, onChanged, onRevokeIntent }); callbacks.current = { onSelect, onChanged, onRevokeIntent };
  function publish(items: McpConnection[]) { setConnections(items); callbacks.current.onChanged?.(items); }
  function refresh() {
    if (mutation.current || !scope.current.active) return;
    setLoading(true); setError('');
    void scope.current.run('list', (signal) => api.list(signal), { apply: publish, onError: (failure) => setError(errorText(failure)), finally: () => setLoading(false) });
  }
  useEffect(() => { scope.current.mount(account.account.accountId, account.isCurrent); mutation.current = false; refresh(); return () => { scope.current.dispose(); mutation.current = false; }; }, [api, account]);
  function change(connection: McpConnection, revoke: boolean) {
    if (mutation.current || !scope.current.active || !account.isCurrent()) return;
    if (!revoke && !mcpCanConnect(connection)) return;
    if (revoke && (!connection.connectionId || !connection.grantVersion)) return;
    mutation.current = true; scope.current.cancel('list'); setLoading(false); setBusy(connection.catalogId); setError(''); setNotice('');
    // Clear the selected grant before awaiting: an old discovery may already be in flight.
    callbacks.current.onRevokeIntent?.(connection); setRevokeTarget(null);
    void scope.current.run('mutation', (signal) => revoke ? api.revoke(connection.connectionId!, connection.grantVersion!, signal) : api.connect(connection.catalogId, signal), {
      apply: (updated) => { const items = connections.map((item) => item.catalogId === updated.catalogId ? updated : item); publish(items); setNotice(revoke ? '本平台授权已撤销。已保存的任务结果仍保留。' : updated.status === 'connected' ? '已完成工具发现并建立本平台授权。每次调用仍需要你明确批准。' : updated.reason || '连接状态已更新，请查看实际状态。'); },
      onError: (failure) => { setError(`${errorText(failure)} 当前工具选择已清除，请刷新后重新选择；不会自动重试。`); },
      finally: () => { mutation.current = false; setBusy(''); },
    });
  }
  return <section className="mcp-connections" aria-label="外部工具连接"><div className="section-title"><h3><Link2 size={17} />外部工具连接</h3><button className="text-button" type="button" onClick={refresh} disabled={loading || !!busy}><RefreshCw size={14} className={loading ? 'spin' : ''} />刷新</button></div><p className="mcp-boundary">连接授权仅属于本平台。它不代表已登录 Gmail 等第三方账号；当前只使用服务器配置的公共服务或服务凭据。网页不接收 URL 或密钥。</p>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="mcp-notice" role="status">{notice}</p>}{loading ? <p className="mcp-loading" role="status"><Loader2 size={15} className="spin" />正在读取服务器连接目录…</p> : connections.length ? <div className="mcp-connection-grid">{connections.map((item) => <article key={item.catalogId} className={`mcp-connection-card ${selectedConnectionId === item.connectionId && item.status === 'connected' ? 'selected' : ''}`}><div><strong>{item.name}</strong><span className={`badge ${item.status === 'connected' ? 'green' : 'neutral'}`}>{statusText[item.status]}</span></div>{item.description && <p>{item.description}</p>}{item.reason && <p className="mcp-reason">{item.reason}</p>}<small>{item.status === 'connected' ? `${item.toolCount} 个已审阅工具 · 授权版本 ${item.grantVersion}` : '是否可用以实际发现结果为准'}{item.discoveredAt ? ` · ${new Date(item.discoveredAt).toLocaleString('zh-CN')}` : ''}</small><div className="mcp-connection-actions">{item.status === 'connected' ? <>{onSelect && <button className="secondary" type="button" disabled={!!busy} onClick={() => callbacks.current.onSelect?.(item)}>选择工具<ArrowRight size={13} /></button>}<button className="text-button" type="button" disabled={!!busy} onClick={() => setRevokeTarget(item)}><Unplug size={13} />撤销授权</button></> : <button className="secondary" type="button" disabled={!!busy || !mcpCanConnect(item)} onClick={() => change(item, false)}>{busy === item.catalogId ? '连接中…' : item.connectionId ? '重新连接并发现工具' : '连接并发现工具'}</button>}</div></article>)}</div> : <div className="mcp-empty"><strong>{error ? '连接目录未能读取' : '服务器尚未配置外部工具目录'}</strong><p>{error ? '请检查当前服务状态后明确点击刷新。不会自动连接或重试。' : '添加并审阅服务器连接后，这里会显示真实可连接的服务。现有对话和其它工作台能力仍可使用。'}</p></div>}{revokeTarget && <div className="mcp-confirm" role="group" aria-label="确认撤销外部工具授权"><p>撤销“{revokeTarget.name}”在本平台的授权？后续调用和旧授权下的审批会由服务端拒绝。已经开始的外部调用可能仍有结果，已保存结果不会删除。</p><div><button className="secondary" type="button" onClick={() => setRevokeTarget(null)}>保留授权</button><button className="primary" type="button" disabled={!!busy} onClick={() => change(revokeTarget, true)}>确认撤销</button></div></div>}{onOpenTools && <button className="text-button mcp-open-tools" type="button" onClick={onOpenTools}>打开外部工具工作区<ArrowRight size={14} /></button>}</section>;
}
