import { GOAL_PLAN_MAX_STEPS, GOAL_PLAN_PROPOSAL_DEFAULT_LIMIT, GOAL_PLAN_PROPOSAL_MAX_LIMIT, type GoalPlanProposalList, type GoalPlanProposalSummary } from '@companion/platform-contracts';

export type ConversationGoalPlanTransport = <T>(path: string, init?: RequestInit) => Promise<T>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
/** Title JSON may escape every UTF-16 unit; metadata has bounded IDs, dates and scalar fields. */
export const GOAL_PROPOSAL_METADATA_MAX_BYTES = GOAL_PLAN_PROPOSAL_MAX_LIMIT * (120 * 6 + 1024) + 1024;
const invalid = () => new Error('本对话的计划草稿记录不完整，请重新读取。');

export function parseConversationGoalPlanPage(value: unknown, conversationId: string, limit = GOAL_PLAN_PROPOSAL_DEFAULT_LIMIT, before?: string): GoalPlanProposalList {
  if (!uuid.test(conversationId) || !Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_PLAN_PROPOSAL_MAX_LIMIT || before !== undefined && !uuid.test(before) || !object(value) || !keys(value, ['proposals', 'nextBefore', 'limit']) || value.limit !== limit || !Array.isArray(value.proposals) || value.proposals.length > limit || value.nextBefore !== null && (typeof value.nextBefore !== 'string' || !uuid.test(value.nextBefore))) throw invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > GOAL_PROPOSAL_METADATA_MAX_BYTES) throw invalid();
  const seen = new Set<string>();
  const proposals = value.proposals.map((item): GoalPlanProposalSummary => {
    if (!object(item) || !keys(item, ['planId', 'conversationId', 'title', 'revision', 'status', 'stepCount', 'messageId', 'createdAt']) || typeof item.planId !== 'string' || !uuid.test(item.planId) || item.planId === before || seen.has(item.planId) || item.conversationId !== conversationId || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || Number(item.revision) > 1_000_000 || typeof item.status !== 'string' || !['draft', 'active', 'paused', 'cancelled'].includes(item.status) || !Number.isSafeInteger(item.stepCount) || Number(item.stepCount) < 1 || Number(item.stepCount) > GOAL_PLAN_MAX_STEPS || item.messageId !== null && (typeof item.messageId !== 'string' || !uuid.test(item.messageId)) || typeof item.createdAt !== 'string' || item.createdAt.length > 40 || !Number.isFinite(Date.parse(item.createdAt))) throw invalid();
    seen.add(item.planId);
    return { planId: item.planId, conversationId, title: item.title, revision: Number(item.revision), status: item.status as GoalPlanProposalSummary['status'], stepCount: Number(item.stepCount), messageId: item.messageId as string | null, createdAt: item.createdAt };
  });
  if (value.nextBefore !== null && (proposals.length !== limit || proposals.at(-1)?.planId !== value.nextBefore || value.nextBefore === before)) throw invalid();
  return { proposals, nextBefore: value.nextBefore as string | null, limit };
}

/** Only a captured account's owned metadata GET can create a card. Tool results are never decoded here. */
export function createConversationGoalPlanClient(transport: ConversationGoalPlanTransport) {
  return { async list(conversationId: string, options: { limit?: number; before?: string; signal?: AbortSignal } = {}): Promise<GoalPlanProposalList> {
    const limit = options.limit ?? GOAL_PLAN_PROPOSAL_DEFAULT_LIMIT;
    if (!uuid.test(conversationId) || !Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_PLAN_PROPOSAL_MAX_LIMIT || options.before !== undefined && !uuid.test(options.before)) throw invalid();
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({ limit: String(limit) }); if (options.before) query.set('before', options.before);
    const value = await transport<unknown>(`/conversations/${conversationId}/goal-plan-proposals?${query}`, { signal: options.signal });
    options.signal?.throwIfAborted();
    return parseConversationGoalPlanPage(value, conversationId, limit, options.before);
  } };
}
