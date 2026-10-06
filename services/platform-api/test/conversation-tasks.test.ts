import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationTaskOrigin, parseConversationTaskQuery } from '../src/conversation-tasks.ts';
import { parseJob } from '../src/jobs.ts';
import { ApiError } from '../src/errors.ts';

const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const badInput = (error: unknown) => error instanceof ApiError && error.status === 400;

test('conversation-task pages accept only bounded canonical limits and one UUID cursor', () => {
  assert.deepEqual(parseConversationTaskQuery({}), { limit: 20 });
  assert.deepEqual(parseConversationTaskQuery({ limit: '50', before: id }), { limit: 50, before: id.toLowerCase() });
  for (const limit of ['', '0', '51', '01', '-1', '1.0', '1e1', ' 1', '1 ', 1, null, ['1', '2']]) assert.throws(() => parseConversationTaskQuery({ limit }), badInput);
  for (const before of ['', id + ' ', id.slice(1), [id, id], null, 1]) assert.throws(() => parseConversationTaskQuery({ before }), badInput);
  for (const query of [{ owner: id }, { offset: '1' }, { expectedAccount: id }, null, []]) assert.throws(() => parseConversationTaskQuery(query), badInput);
});

test('server origins have exactly three reference fields and a supported tool', () => {
  for (const tool of ['create_job', 'prepare_browser_task', 'prepare_mcp_task']) {
    assert.deepEqual(parseConversationTaskOrigin({ conversationId: id, messageId: id, tool }), { conversationId: id.toLowerCase(), messageId: id.toLowerCase(), tool });
  }
  const origin = { conversationId: id, messageId: id, tool: 'create_job' };
  for (const input of [{ ...origin, tool: 'execute_task' }, { ...origin, messageId: 'not-a-uuid' }, { ...origin, conversationId: id + ' ' },
    { ...origin, userId: id }, { ...origin, createdGeneration: 1 }, { ...origin, args: {} }, null, []]) assert.throws(() => parseConversationTaskOrigin(input), badInput);
});

test('ordinary job input cannot claim a conversation, assistant message or origin', () => {
  const input = { kind: 'speech', provider: 'synthetic', prompt: 'Fictional text' };
  for (const extra of [{ origin: { conversationId: id, messageId: id, tool: 'create_job' } }, { conversationId: id }, { messageId: id }, { tool: 'create_job' }]) assert.throws(() => parseJob({ ...input, ...extra }), badInput);
});
