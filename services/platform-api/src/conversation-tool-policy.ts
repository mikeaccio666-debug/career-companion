import type { ToolDefinition } from '@companion/platform-contracts';
import { ApiError } from './errors.ts';

const workbenchTools = new Set(['create_job', 'prepare_browser_task', 'prepare_mcp_task', 'get_execution_capabilities', 'propose_goal_plan']);

/** Saved-source readers remain available; new workbench preparation is internal. */
export function conversationTools(tools: readonly ToolDefinition[], workbenchEnabled: boolean): ToolDefinition[] {
  return tools.filter(tool => workbenchEnabled === true || !workbenchTools.has(tool.name));
}

/** Runtime injection or an unexpected model call cannot bypass the advertised surface. */
export function assertConversationToolAdmission(name: string, workbenchEnabled: boolean): void {
  if (workbenchEnabled !== true && workbenchTools.has(name)) {
    throw new ApiError(403, 'WORKBENCH_DISABLED', 'Workbench preparation tools are disabled on this server.');
  }
}
