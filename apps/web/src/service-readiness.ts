export type ExecutionAvailability = 'ready' | 'degraded' | 'disabled' | 'unknown';
export interface ServiceReadinessState {
  status: 'connected' | 'unavailable';
  execution: ExecutionAvailability;
  checkedAt?: string;
}

/** Public service checks share one order across bootstrap and explicit refreshes. */
export class ServiceReadinessChecks {
  private revision = 0;
  begin() {
    const revision = ++this.revision;
    return { isCurrent: () => revision === this.revision };
  }
  invalidate() { ++this.revision; }
  async refresh<T>(read: () => Promise<T>, apply: (value: T) => void) {
    const check = this.begin();
    const value = await read();
    if (!check.isCurrent()) return 'discarded' as const;
    apply(value);
    return 'applied' as const;
  }
}

/** Public status is service evidence, never provider quality or a task receipt. */
export function serviceReadinessState(result: PromiseSettledResult<unknown>): ServiceReadinessState {
  const unavailable: ServiceReadinessState = { status: 'unavailable', execution: 'unknown' };
  if (result.status !== 'fulfilled' || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return unavailable;
  const value = result.value as Record<string, unknown>;
  if (value.ok !== true || value.database !== 'ready' || typeof value.checkedAt !== 'string'
    || !Number.isFinite(Date.parse(value.checkedAt)) || new Date(value.checkedAt).toISOString() !== value.checkedAt
    || !['ready', 'degraded', 'disabled', 'unknown'].includes(value.execution as string)) return unavailable;
  return { status: 'connected', execution: value.execution as ExecutionAvailability, checkedAt: value.checkedAt };
}

export function executionAvailabilityCopy(status: ServiceReadinessState['status'] | undefined, execution: ExecutionAvailability | undefined) {
  if (status !== 'connected' || execution === 'ready') return null;
  if (execution === 'disabled') return { title: '执行服务尚未启用', text: '已保存的内容仍可查看。执行任务需要等待服务启用。' };
  if (execution === 'degraded') return { title: '执行服务暂不可用', text: '已保存的内容仍可查看。执行任务需等待服务恢复。' };
  return { title: '执行服务状态待确认', text: '已保存的内容仍可查看。尚未确认执行服务是否可用。' };
}
