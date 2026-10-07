import type { GoalPlanProposalSummary } from '@companion/platform-contracts';
export function conversationGoalPlanLabel(status: GoalPlanProposalSummary['status']) {
  return { draft: '草稿已保存待审阅', active: '已确认', paused: '已暂停', cancelled: '已取消' }[status];
}
/** A tool result is only a refresh hint. Neither ID nor content is used as a navigation target. */
export function shouldRefreshGoalPlanProposals(event: unknown): boolean {
  return !!event && typeof event === 'object' && !Array.isArray(event) && (event as Record<string, unknown>).name === 'propose_goal_plan' && Object.hasOwn(event, 'result');
}
