import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalPlanWorkspaceStore, type GoalPlanWorkspace } from '../src/goal-plan-workspace.ts';
import { goalInputToDraft } from '../src/goal-plans-editor.ts';
import { input, planId } from './goal-plans-fixture.ts';
const a = { accountId: '74000000-0000-4000-8000-000000000001', generation: 1 }, b = { ...a, generation: 2 };
const workspace = (): GoalPlanWorkspace => ({ selectedId: planId, editor: goalInputToDraft(input()), editing: true, dirty: true, editorPlanId: planId, editorRevision: 1, conflict: false });

test('selection and unsaved editor are isolated by account generation and conversation and copied both ways', () => {
  const store = new GoalPlanWorkspaceStore(); store.changeSession(a); const value = workspace(); store.save(a, 'fictional-one', value); value.editor.goal = 'Fictional mutation after save';
  const restored = store.read(a, 'fictional-one')!; assert.equal(restored.editor.goal, input().goal); assert.equal(restored.selectedId, planId); restored.editor.title = 'Fictional read mutation'; assert.equal(store.read(a, 'fictional-one')!.editor.title, input().title);
  assert.equal(store.read(a, 'fictional-two'), undefined); store.changeSession(b); assert.equal(store.read(b, 'fictional-one'), undefined); store.save(a, 'fictional-one', value); assert.equal(store.read(b, 'fictional-one'), undefined); store.save(b, 'fictional-two', workspace()); store.clear(); assert.equal(store.read(b, 'fictional-two'), undefined);
});

test('forgetting a deleted conversation cannot erase a newly authenticated session', () => {
  const store = new GoalPlanWorkspaceStore(); store.changeSession(b); store.save(b, 'fictional-one', workspace()); store.forget(a, 'fictional-one'); assert.ok(store.read(b, 'fictional-one')); store.forget(b, 'fictional-one'); assert.equal(store.read(b, 'fictional-one'), undefined);
});
