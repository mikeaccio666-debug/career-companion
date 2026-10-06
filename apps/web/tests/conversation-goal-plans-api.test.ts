import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalPlanProposalSummary } from '@companion/platform-contracts';
import { createConversationGoalPlanClient, GOAL_PROPOSAL_METADATA_MAX_BYTES, parseConversationGoalPlanPage } from '../src/conversation-goal-plans-api.ts';
import { conversationGoalPlanLabel, shouldRefreshGoalPlanProposals } from '../src/conversation-goal-plan-labels.ts';
import { conversationId, instant, messageId, planId } from './goal-plans-fixture.ts';

const summary = (number = 1): GoalPlanProposalSummary => ({ planId: number === 1 ? planId : `72000000-0000-4000-8000-${String(number).padStart(12, '0')}`, conversationId, title: 'Fictional reviewable plan', revision: 1, status: 'draft', stepCount: 3, messageId, createdAt: instant });
const page = (proposals = [summary()], nextBefore: string | null = null, limit = 20) => ({ proposals, nextBefore, limit });

test('owned metadata preserves current status/revision and a deleted original reply without inventing completion', () => {
  const item = { ...summary(), revision: 4, status: 'active' as const, messageId: null };
  assert.deepEqual(parseConversationGoalPlanPage(page([item]), conversationId).proposals[0], item);
  assert.equal(conversationGoalPlanLabel('active'), '已确认');
  assert.equal(conversationGoalPlanLabel('draft'), '草稿已保存待审阅');
  assert.throws(() => parseConversationGoalPlanPage(page([{ ...item, status: 'completed' as never }]), conversationId));
});

test('one malformed, cross-conversation, duplicated or raw model-enriched item rejects the whole page', () => {
  const bad = [null, { ...summary(), conversationId: planId }, { ...summary(), messageId: 'not-an-owned-message' }, { ...summary(), revision: 0 }, { ...summary(), stepCount: 9 }, { ...summary(), title: 'x'.repeat(121) }, { ...summary(), createdAt: 'not-a-date' }, { ...summary(), prompt: 'Fictional untrusted model output' }, { ...summary(), status: { value: 'draft' } }];
  for (const item of bad) assert.throws(() => parseConversationGoalPlanPage(page([summary(2), item as GoalPlanProposalSummary]), conversationId));
  assert.throws(() => parseConversationGoalPlanPage(page([summary(), summary()]), conversationId));
  assert.throws(() => parseConversationGoalPlanPage({ ...page(), rawToolResult: {} }, conversationId));
});

test('stable server cursor must be the last full-page item and cannot repeat its anchor', () => {
  const all = Array.from({ length: 20 }, (_, index) => summary(index + 1));
  assert.equal(parseConversationGoalPlanPage(page(all, all.at(-1)!.planId), conversationId).nextBefore, all.at(-1)!.planId);
  for (const candidate of [page(all, all[0].planId), page([], planId), page([summary()], planId), page(all, 'bad-cursor')]) assert.throws(() => parseConversationGoalPlanPage(candidate, conversationId));
  assert.throws(() => parseConversationGoalPlanPage(page(all, all.at(-1)!.planId), conversationId, 20, all.at(-1)!.planId));
});

test('the metadata bound fits fifty maximum escaped titles and rejects wider values and bad request parameters', async () => {
  const all = Array.from({ length: 50 }, (_, index) => ({ ...summary(index + 1), title: '\u0001'.repeat(120) }));
  assert.equal(parseConversationGoalPlanPage(page(all, null, 50), conversationId, 50).proposals.length, 50);
  assert.ok(new TextEncoder().encode(JSON.stringify(page(all, null, 50))).byteLength < GOAL_PROPOSAL_METADATA_MAX_BYTES);
  assert.throws(() => parseConversationGoalPlanPage(page([...all, summary(100)], null, 50), conversationId, 50));
  let calls = 0; const api = createConversationGoalPlanClient(async <T>() => { ++calls; return page() as T; });
  for (const options of [{ limit: 0 }, { limit: 51 }, { before: 'https://fictional.invalid/private' }]) await assert.rejects(api.list(conversationId, options));
  assert.equal(calls, 0);
});

test('fixed metadata client sends only GETs and discards an aborted response even when transport ignores the signal', async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [], controller = new AbortController();
  const api = createConversationGoalPlanClient(async <T>(path: string, init?: RequestInit) => { requests.push({ path, init }); return page() as T; });
  await api.list(conversationId); assert.match(requests[0].path, /goal-plan-proposals\?limit=20$/); assert.equal(requests[0].init?.method, undefined);
  const stale = createConversationGoalPlanClient(async <T>() => { controller.abort(); return page() as T; });
  await assert.rejects(stale.list(conversationId, { signal: controller.signal }), { name: 'AbortError' });
});

test('an arbitrary tool result is only a refresh hint, never a plan-card or navigation decoder', () => {
  for (const result of [null, {}, { proposal: { planId: 'untrusted-other-plan' } }, { error: 'Fictional tool failure' }]) assert.equal(shouldRefreshGoalPlanProposals({ name: 'propose_goal_plan', result }), true);
  for (const value of [null, { name: 'propose_goal_plan' }, { name: 'create_job', result: {} }]) assert.equal(shouldRefreshGoalPlanProposals(value), false);
  assert.equal(shouldRefreshGoalPlanProposals(Object.create({ name: 'propose_goal_plan', result: {} })), false);
});
