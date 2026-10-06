import { CONVERSATION_TASK_TOOLS, type ConversationTask, type ConversationTaskPage } from '@companion/platform-contracts';

export type ConversationTaskTransport = <T>(path: string, init?: RequestInit) => Promise<T>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2147483647;
const statuses = ['needs_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
const kinds = ['image', 'video', 'speech', 'browser', 'cli', 'workflow', 'mcp'];

export function parseConversationTaskPage(value: unknown, conversationId: string, limit = 20, before?: string): ConversationTaskPage {
  if (!value || typeof value !== 'object') throw new Error('服务没有返回本对话的任务记录。');
  const page = value as ConversationTaskPage;
  if (!Array.isArray(page.tasks) || page.tasks.length > limit || page.nextBefore !== null && !uuid.test(page.nextBefore)) throw new Error('本对话的任务分页不完整，请刷新。');
  const seen = new Set<string>();
  for (const task of page.tasks) {
    const job = task?.job, origin = task?.origin;
    if (!job || !origin || !uuid.test(job.id) || seen.has(job.id) || job.id === before || origin.conversationId !== conversationId || !uuid.test(origin.messageId) || !(CONVERSATION_TASK_TOOLS as readonly string[]).includes(origin.tool) || !revision(task.generation) || !revision(origin.createdGeneration) || origin.createdGeneration > task.generation || typeof origin.createdAt !== 'string' || !Number.isFinite(Date.parse(origin.createdAt)) || !statuses.includes(job.status) || !kinds.includes(job.kind) || typeof job.prompt !== 'string' || typeof job.provider !== 'string' || !Array.isArray(job.artifacts) || job.artifacts.some((artifact) => !artifact || !uuid.test(artifact.id) || typeof artifact.name !== 'string' || typeof artifact.mime !== 'string' || typeof artifact.url !== 'string')) throw new Error('任务来源、版本或保存的成果不完整，请刷新本对话。');
    if (origin.tool === 'prepare_browser_task' && job.kind !== 'browser' || origin.tool === 'prepare_mcp_task' && job.kind !== 'mcp') throw new Error('任务与本对话的准备记录不一致。');
    if (task.approval) {
      const approval = task.approval;
      if (!uuid.test(approval.id) || approval.jobId !== job.id || approval.status !== 'pending' || job.status !== 'needs_approval' || !approval.args || typeof approval.args !== 'object' || Array.isArray(approval.args) || approval.toolName !== job.kind || approval.args.kind !== job.kind || approval.args.provider !== job.provider || approval.args.prompt !== job.prompt || !revision(approval.generation) || approval.generation !== task.generation) throw new Error('待审批记录不属于任务的当前版本，请刷新后审阅。');
    }
    seen.add(job.id);
  }
  if (page.nextBefore !== null && (page.nextBefore === before || page.tasks.at(-1)?.job.id !== page.nextBefore)) throw new Error('任务分页没有向更早的记录推进，请刷新。');
  return page;
}

/** Fixed private transport; no global job list or model request participates in this read. */
export function createConversationTaskClient(transport: ConversationTaskTransport) {
  return {
    async list(conversationId: string, options: { before?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ConversationTaskPage> {
      const limit = options.limit ?? 20;
      if (!uuid.test(conversationId) || options.before !== undefined && !uuid.test(options.before) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('本对话任务的分页参数无效。');
      options.signal?.throwIfAborted();
      const query = new URLSearchParams({ limit: String(limit) }); if (options.before) query.set('before', options.before);
      const page = await transport<unknown>(`/conversations/${encodeURIComponent(conversationId)}/tasks?${query}`, { signal: options.signal });
      options.signal?.throwIfAborted();
      return parseConversationTaskPage(page, conversationId, limit, options.before);
    },
  };
}
