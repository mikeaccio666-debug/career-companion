import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountOperationScope, executeAccountOperation } from '../src/account-operations.ts';
import { applyVoiceDraftHandoff, canFocusVoiceHandoff } from '../src/voice-handoff.ts';

function session() {
  const scope = new AccountOperationScope(); scope.changeSession('fictional-voice-account');
  return scope;
}

test('voice excerpts append without sending or replacing unsent words and attachments', () => {
  const scope = session(), uploads = [{ id: 'fictional-private-attachment' }], draft = '  原稿：请先比较两个虚构方向。\n保留这些空格。  ';
  const excerpt = '语音来源：手动整理，用户\n“先做一个小验证。”';
  let current = { draft, uploads }, applied = 0;
  const apply = (plan: typeof current) => { current = plan; applied++; };
  const first = applyVoiceDraftHandoff(scope, scope.snapshot(), 'fictional-thread', () => 'fictional-thread', current, excerpt, apply)!;
  assert.equal(current.draft, `${draft}\n\n${excerpt}`); assert.equal(current.uploads, uploads);
  assert.equal(first.plan.duplicate, false); assert.equal(applied, 1);
  const second = applyVoiceDraftHandoff(scope, scope.snapshot(), 'fictional-thread', () => 'fictional-thread', current, excerpt, apply)!;
  assert.equal(second.plan.duplicate, true); assert.equal(current.draft, first.plan.draft); assert.equal(current.uploads, uploads);
});

test('old account or old conversation voice actions do not touch the current draft', () => {
  const scope = session(), token = scope.snapshot(), current = { draft: 'Fictional draft.', uploads: [] };
  let applications = 0;
  const apply = () => { applications++; };
  assert.equal(applyVoiceDraftHandoff(scope, token, 'fictional-a', () => 'fictional-b', current, 'Fictional excerpt.', apply), undefined);
  scope.changeSession('fictional-other-account');
  assert.equal(applyVoiceDraftHandoff(scope, token, 'fictional-a', () => 'fictional-a', current, 'Fictional excerpt.', apply), undefined);
  scope.changeSession('fictional-voice-account');
  assert.equal(applyVoiceDraftHandoff(scope, token, 'fictional-a', () => 'fictional-a', current, 'Fictional excerpt.', apply), undefined);
  assert.equal(applications, 0);
});

test('returning to the source conversation does not revive an earlier voice action', () => {
  const scope = session(), source = scope.snapshot('conversation-selection');
  scope.invalidate('conversation-selection'); scope.invalidate('conversation-selection');
  let applications = 0;
  const state = { draft: 'Fictional current draft.', uploads: [] };
  assert.equal(applyVoiceDraftHandoff(scope, source, 'fictional-a', () => 'fictional-a', state, 'Fictional old excerpt.', () => { applications++; }), undefined);
  const fresh = applyVoiceDraftHandoff(scope, scope.snapshot('conversation-selection'), 'fictional-a', () => 'fictional-a', state, 'Fictional new excerpt.', () => { applications++; });
  assert.equal(applications, 1); assert.equal(scope.isCurrent(fresh!.selection), true);
});

test('a voice handoff discards pending message loads and delayed focus yields to later navigation', async () => {
  const scope = session(), old = scope.begin('messages')!;
  let resolve!: (value: string) => void, loaded = false;
  const wait = new Promise<string>((done) => { resolve = done; });
  const load = executeAccountOperation(scope, old, () => wait, { apply: () => { loaded = true; } });
  const result = applyVoiceDraftHandoff(scope, scope.snapshot(), 'fictional-thread', () => 'fictional-thread', { draft: '', uploads: [] }, 'Fictional excerpt.', () => {})!;
  resolve('Fictional old messages.'); assert.equal((await load).status, 'discarded'); assert.equal(loaded, false);
  assert.equal(canFocusVoiceHandoff(scope, result.selection, 'fictional-thread', 'fictional-thread'), true);
  assert.equal(canFocusVoiceHandoff(scope, result.selection, 'fictional-thread', 'fictional-other-thread'), false);
  scope.invalidate('conversation-selection');
  assert.equal(canFocusVoiceHandoff(scope, result.selection, 'fictional-thread', 'fictional-thread'), false);
});

test('new unsaved voice discussions preserve full oversized drafts, and blank excerpts cause no mutation', () => {
  const scope = session(), draft = '字'.repeat(20_000), uploads = [{ id: 'fictional-file' }];
  const result = applyVoiceDraftHandoff(scope, scope.snapshot(), null, () => null, { draft, uploads }, 'Fictional excerpt.', () => {})!;
  assert.equal(result.plan.exceedsLimit, true); assert.equal(result.plan.draft, `${draft}\n\nFictional excerpt.`); assert.equal(result.plan.uploads, uploads);
  let mutated = false;
  assert.throws(() => applyVoiceDraftHandoff(scope, scope.snapshot(), null, () => null, { draft, uploads }, '  ', () => { mutated = true; }), /摘录为空/);
  assert.equal(mutated, false);
});
