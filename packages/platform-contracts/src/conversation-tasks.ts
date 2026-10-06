import type { Approval, Job } from './index.ts';

export const CONVERSATION_TASK_TOOLS = ['create_job', 'prepare_browser_task', 'prepare_mcp_task'] as const;
export type ConversationTaskTool = typeof CONVERSATION_TASK_TOOLS[number];
/** Server-fixed origin of a task prepared during an assistant response. */
export interface ConversationTaskOrigin {
  conversationId: string;
  messageId: string;
  tool: ConversationTaskTool;
  createdGeneration: number;
  createdAt: string;
}
/** Current job state; generation is an authorization revision, not an execution attempt count. */
export interface ConversationTask {
  origin: ConversationTaskOrigin;
  job: Job;
  generation: number;
  /** Only a pending approval for this exact current generation. */
  approval?: Approval & { generation: number };
}
export interface ConversationTaskPage {
  tasks: ConversationTask[];
  /** Owned job ID used as an older-page cursor; null means no older page. */
  nextBefore: string | null;
}
