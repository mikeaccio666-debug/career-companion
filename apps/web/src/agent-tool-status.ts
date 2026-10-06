export type AgentToolState = 'pending' | 'returned' | 'failed' | 'unconfirmed' | 'approval';
export interface AgentToolStatus { key: string; name: string; state: AgentToolState; }
const labels: Record<string, string> = { read_saved_memories: '读取已保存记忆', list_jobs: '查询任务记录', get_browser_observation: '读取网页结果', get_artifact_reference: '读取图片引用', read_artifact_text: '读取成果文字', create_job: '准备任务', prepare_browser_task: '准备浏览器计划' };
const stateLabels: Record<AgentToolState, string> = { pending: '处理中', returned: '已返回', failed: '未成功返回', unconfirmed: '结果未确认', approval: '已请求审批' };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function name(value: unknown) { return typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : '工具'; }
export function agentToolStatusText(item: AgentToolStatus): string { return `${labels[item.name] || item.name} · ${stateLabels[item.state]}`; }
export function upsertAgentToolStatus(current: AgentToolStatus[], event: unknown): AgentToolStatus[] {
  if (!object(event)) return current;
  const callId = typeof event.callId === 'string' && event.callId.length <= 256 && event.callId ? event.callId : undefined;
  const key = callId ? `call:${callId}` : `legacy:${Math.max(0, ...current.map((item) => Number(item.key.slice(7)) || 0)) + 1}`;
  const previous = current.find((item) => item.key === key);
  const returned = Object.hasOwn(event, 'result');
  const error = returned && object(event.result) && Object.hasOwn(event.result, 'error') && event.result.error !== null && event.result.error !== undefined && event.result.error !== false;
  const state = returned ? error ? 'failed' : 'returned' : previous && previous.state !== 'pending' ? previous.state : 'pending';
  const item: AgentToolStatus = { key, name: name(event.name || event.toolName || previous?.name), state };
  return [...current.filter((entry) => entry.key !== key), item].slice(-6);
}
export function appendAgentApprovalStatus(current: AgentToolStatus[], event: { id: string; toolName?: string }): AgentToolStatus[] {
  const item: AgentToolStatus = { key: `approval:${event.id}`, name: name(event.toolName || '操作'), state: 'approval' };
  return [...current.filter((entry) => entry.key !== item.key), item].slice(-6);
}
export function finishAgentToolStatuses(current: AgentToolStatus[]): AgentToolStatus[] {
  return current.map((item) => item.state === 'pending' ? { ...item, state: 'unconfirmed' } : item);
}
