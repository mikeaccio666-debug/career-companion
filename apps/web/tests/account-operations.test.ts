import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.ts';
import { AccountOperationScope, currentAccountSelectionRequest, executeAccountOperation, executeAccountSelection, refreshAccountData, requireAccountResult, StaleAccountOperation, transitionAccount, type AccountDataCallbacks } from '../src/account-operations.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const paths = ['/conversations', '/jobs', '/memories', '/approvals'];
function batch() {
  const requests = new Map(paths.map((path) => [path, deferred<unknown>()]));
  const called: string[] = [];
  return {
    read(path: string) { called.push(path); return requests.get(path)!.promise; }, called,
    settle(label: string, failurePath?: string, failure?: unknown) {
      for (const path of paths) {
        if (path === failurePath) requests.get(path)!.reject(failure);
        else requests.get(path)!.resolve({ [path.slice(1)]: [{ id: `${label}-${path.slice(1)}` }] });
      }
    },
    requests,
  };
}
function harness() {
  const scope = new AccountOperationScope();
  const state = { user: null as { id: string } | null, conversations: [] as string[], jobs: [] as string[], memories: [] as string[], approvals: [] as string[], messages: [] as string[], uploads: [] as string[], draft: '', dialog: null as string | null, loading: false, error: '' };
  const events: string[] = [];
  function authenticate(id: string | null) {
    transitionAccount(scope, id ? { id } : null, () => {
      events.push('reset'); state.conversations = []; state.jobs = []; state.memories = []; state.approvals = []; state.messages = []; state.uploads = []; state.draft = ''; state.dialog = null; state.loading = false; state.error = '';
    }, (user) => { events.push('user'); state.user = user; });
  }
  const callbacks: AccountDataCallbacks = {
    conversations: (values) => { events.push('conversations'); state.conversations = values.map((value) => value.id); },
    jobs: (values) => { events.push('jobs'); state.jobs = values.map((value) => value.id); },
    memories: (values) => { events.push('memories'); state.memories = values.map((value) => value.id); },
    approvals: (values) => { events.push('approvals'); state.approvals = values.map((value) => value.id); },
    onError(error) { events.push('error'); if (error instanceof ApiError && error.status === 401) authenticate(null); else state.error = (error as Error).message; },
  };
  return { scope, state, events, authenticate, callbacks };
}
function assertPrivateBatch(state: ReturnType<typeof harness>['state'], label: string) {
  for (const key of ['conversations', 'jobs', 'memories', 'approvals'] as const) assert.deepEqual(state[key], [`${label}-${key}`]);
}

test('normal authenticated refresh executes the four real request callbacks and applies all current collections', async () => {
  const context = harness(); context.authenticate('fictional-a');
  const request = batch(), refresh = refreshAccountData(context.scope, request.read, context.callbacks, { workbench: true });
  assert.deepEqual(request.called, paths); request.settle('current');
  assert.equal((await refresh).status, 'applied'); assertPrivateBatch(context.state, 'current');
  assert.equal(context.state.user!.id, 'fictional-a'); assert.equal(context.state.error, '');
});

test('old account refresh success cannot overwrite a newly authenticated account after its current refresh', async () => {
  const context = harness(); context.authenticate('fictional-a');
  const previous = batch(), oldRefresh = refreshAccountData(context.scope, previous.read, context.callbacks, { workbench: true });
  context.authenticate('fictional-b');
  const active = batch(), currentRefresh = refreshAccountData(context.scope, active.read, context.callbacks, { workbench: true });
  active.settle('account-b'); await currentRefresh;
  previous.settle('account-a'); assert.equal((await oldRefresh).status, 'discarded');
  assertPrivateBatch(context.state, 'account-b'); assert.equal(context.state.user!.id, 'fictional-b');
});

test('old account 401 is discarded instead of clearing the new account or showing its private error', async () => {
  const context = harness(); context.authenticate('fictional-a');
  const previous = batch(), refresh = refreshAccountData(context.scope, previous.read, context.callbacks, { workbench: true });
  context.authenticate('fictional-b'); context.state.draft = 'Fictional B draft.'; context.state.error = 'Current B message.';
  previous.settle('account-a', '/jobs', new ApiError('Fictional expired A session.', 401));
  assert.equal((await refresh).status, 'discarded');
  assert.equal(context.state.user!.id, 'fictional-b'); assert.equal(context.state.draft, 'Fictional B draft.'); assert.equal(context.state.error, 'Current B message.');
  assert.equal(context.events.includes('error'), false);
});

test('logout followed by login to the same account creates a new session that rejects old success and 401', async () => {
  for (const error of [undefined, new ApiError('Fictional previous session expired.', 401)]) {
    const context = harness(); context.authenticate('fictional-a');
    const previous = batch(), oldRefresh = refreshAccountData(context.scope, previous.read, context.callbacks, { workbench: true });
    context.authenticate(null); context.authenticate('fictional-a'); context.state.jobs = ['current-same-account-job'];
    previous.settle('previous-session', error ? '/jobs' : undefined, error);
    assert.equal((await oldRefresh).status, 'discarded');
    assert.equal(context.state.user!.id, 'fictional-a'); assert.deepEqual(context.state.jobs, ['current-same-account-job']);
    assert.equal(context.events.includes('error'), false);
  }
});

test('overlapping polling applies the newer response first and discards the slower older response', async () => {
  const context = harness(); context.authenticate('fictional-a');
  const older = batch(), newer = batch();
  const oldRefresh = refreshAccountData(context.scope, older.read, context.callbacks, { workbench: true });
  const newRefresh = refreshAccountData(context.scope, newer.read, context.callbacks, { workbench: true });
  newer.settle('newest'); await newRefresh; older.settle('older');
  assert.equal((await oldRefresh).status, 'discarded'); assertPrivateBatch(context.state, 'newest');
});

test('overlapping stale polling errors cannot log out an otherwise valid same-session refresh', async () => {
  const context = harness(); context.authenticate('fictional-a');
  const older = batch(), newer = batch();
  const oldRefresh = refreshAccountData(context.scope, older.read, context.callbacks, { workbench: true });
  const newRefresh = refreshAccountData(context.scope, newer.read, context.callbacks, { workbench: true });
  newer.settle('current'); await newRefresh; older.settle('older', '/approvals', new ApiError('Fictional stale request 401.', 401));
  await oldRefresh; assertPrivateBatch(context.state, 'current'); assert.equal(context.state.user!.id, 'fictional-a'); assert.equal(context.events.includes('error'), false);
});

test('a current 401 resets authentication and all transient private state before applying any partial response', async () => {
  const context = harness(); context.authenticate('fictional-a');
  context.state.draft = 'Fictional private draft.'; context.state.uploads = ['fictional-private-upload']; context.state.dialog = 'Fictional memory edit.'; context.state.messages = ['Fictional message.']; context.state.loading = true;
  const requests = batch(), refresh = refreshAccountData(context.scope, requests.read, context.callbacks, { workbench: true });
  requests.requests.get('/conversations')!.reject(new ApiError('Fictional non-auth failure.', 500));
  requests.requests.get('/jobs')!.resolve({ jobs: [{ id: 'must-not-be-applied' }] });
  requests.requests.get('/memories')!.resolve({ memories: [{ id: 'must-not-be-applied' }] });
  requests.requests.get('/approvals')!.reject(new ApiError('Fictional current session expired.', 401));
  await refresh;
  assert.equal(context.state.user, null); assert.equal(context.state.draft, ''); assert.deepEqual(context.state.uploads, []); assert.equal(context.state.dialog, null); assert.deepEqual(context.state.messages, []); assert.equal(context.state.loading, false);
  assert.equal(context.events.includes('jobs'), false); assert.equal(context.events.includes('memories'), false);
  assert.deepEqual(context.events.slice(-2), ['reset', 'user']);
});

test('late conversation, upload, voice, memory and job operations cannot apply data, errors or loading cleanup to a new account', async () => {
  for (const operation of ['conversation', 'upload', 'voice-record', 'memory', 'job']) {
    const context = harness(); context.authenticate('fictional-a');
    const reply = deferred<string>(), token = context.scope.begin()!;
    const result = executeAccountOperation(context.scope, token, () => reply.promise, {
      apply: (value) => { context.state.messages.push(value); }, onError: () => { context.state.error = 'Old error.'; }, finally: () => { context.state.loading = false; },
    });
    context.authenticate('fictional-b'); context.state.loading = true; context.state.messages = ['Current B data.'];
    reply.resolve(`Fictional late ${operation}.`); assert.equal((await result).status, 'discarded');
    assert.deepEqual(context.state.messages, ['Current B data.']); assert.equal(context.state.loading, true); assert.equal(context.state.error, '');
  }
});

test('an old callback cannot even start a private request after a session switch', async () => {
  const context = harness(); context.authenticate('fictional-a'); const token = context.scope.begin()!;
  context.authenticate(null); context.authenticate('fictional-a');
  let requests = 0;
  const result = await executeAccountOperation(context.scope, token, async () => { ++requests; return 'Fictional upload.'; }, { apply: (value) => context.state.uploads.push(value) });
  assert.equal(requests, 0); assert.equal(result.status, 'discarded'); assert.deepEqual(context.state.uploads, []);
  assert.throws(() => requireAccountResult(result), StaleAccountOperation);
});

test('conversation selection invalidates stale messages and their errors while current selection completes normally', async () => {
  const context = harness(); context.authenticate('fictional-a'); const old = deferred<string>(), active = deferred<string>();
  const previous = executeAccountOperation(context.scope, context.scope.begin('messages')!, () => old.promise, { apply: (value) => context.state.messages.push(value), onError: () => context.authenticate(null), finally: () => { context.state.loading = false; } });
  const current = executeAccountOperation(context.scope, context.scope.begin('messages')!, () => active.promise, { apply: (value) => { context.state.messages = [value]; }, finally: () => { context.state.loading = false; } });
  context.state.loading = true; old.reject(new ApiError('Fictional old conversation expired.', 401));
  assert.equal((await previous).status, 'discarded'); assert.equal(context.state.loading, true);
  active.resolve('Current selected conversation.'); await current;
  assert.deepEqual(context.state.messages, ['Current selected conversation.']); assert.equal(context.state.loading, false); assert.equal(context.state.user!.id, 'fictional-a');
});

test('publishing a current task and approval invalidates an older poll that predates that mutation', async () => {
  const context = harness(); context.authenticate('fictional-a'); const old = batch();
  const poll = refreshAccountData(context.scope, old.read, context.callbacks, { workbench: true });
  await executeAccountOperation(context.scope, context.scope.begin()!, async () => ({ jobId: 'fictional-new-task', approvalId: 'fictional-new-approval' }), {
    apply({ jobId, approvalId }) { context.scope.invalidate('private-refresh'); context.state.jobs = [jobId]; context.state.approvals = [approvalId]; },
  });
  old.settle('before-creation'); assert.equal((await poll).status, 'discarded');
  assert.deepEqual(context.state.jobs, ['fictional-new-task']); assert.deepEqual(context.state.approvals, ['fictional-new-approval']);
});

test('disposed application operations cannot publish late initialization or private errors', async () => {
  const context = harness(), reply = deferred<{ id: string }>();
  const initializing = executeAccountOperation(context.scope, context.scope.begin('initialization', false)!, () => reply.promise, { apply: (user) => context.authenticate(user.id), onError: () => context.authenticate(null) });
  context.scope.dispose(); reply.resolve({ id: 'fictional-late-user' });
  assert.equal((await initializing).status, 'discarded'); assert.equal(context.state.user, null); assert.deepEqual(context.events, []);
});

function selectionHarness() {
  const context = harness(); context.authenticate('fictional-a');
  const navigation = { activeId: null as string | null, view: 'chat', selected: [] as string[] };
  const callbacks = {
    remember(id: string) { context.state.conversations.push(id); },
    select(id: string) { context.scope.invalidate('conversation-selection'); navigation.activeId = id; navigation.view = 'chat'; navigation.selected.push(id); context.state.messages = []; },
    onError(error: unknown) { context.state.error = (error as Error).message; },
  };
  return { ...context, navigation, callbacks };
}

test('a current delayed creation remembers and selects the new conversation exactly once', async () => {
  const context = selectionHarness(), reply = deferred<string>();
  const operation = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => reply.promise, context.callbacks);
  context.state.messages = ['Fictional prior message.']; reply.resolve('fictional-created-current');
  assert.equal(requireAccountResult(await operation), 'fictional-created-current');
  assert.deepEqual(context.state.conversations, ['fictional-created-current']); assert.deepEqual(context.navigation.selected, ['fictional-created-current']);
  assert.equal(context.navigation.activeId, 'fictional-created-current'); assert.deepEqual(context.state.messages, []);
});

test('a delayed new-conversation POST preserves its record without replacing a newer selected conversation or its loaded messages', async () => {
  const context = selectionHarness(), reply = deferred<string>(), loaded = deferred<string[]>();
  const operation = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => reply.promise, context.callbacks);
  context.scope.invalidate('conversation-selection'); context.navigation.activeId = 'fictional-existing-b';
  const messages = executeAccountOperation(context.scope, context.scope.begin('messages')!, () => loaded.promise, { apply: (value) => { context.state.messages = value; } });
  loaded.resolve(['Fictional B loaded message.']); await messages;
  reply.resolve('fictional-created-late'); await operation;
  assert.deepEqual(context.state.conversations, ['fictional-created-late']); assert.equal(context.navigation.activeId, 'fictional-existing-b');
  assert.deepEqual(context.state.messages, ['Fictional B loaded message.']); assert.deepEqual(context.navigation.selected, []);
});

test('navigation to create, voice, cli and settings prevents a delayed creation from changing pages', async () => {
  for (const destination of ['create', 'voice', 'cli', 'settings']) {
    const context = selectionHarness(), reply = deferred<string>();
    const operation = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => reply.promise, context.callbacks);
    context.scope.invalidate('conversation-selection'); context.navigation.view = destination; context.state.messages = ['Fictional retained history.'];
    reply.resolve(`fictional-created-for-${destination}`); await operation;
    assert.equal(context.navigation.view, destination); assert.equal(context.navigation.activeId, null); assert.deepEqual(context.navigation.selected, []);
    assert.deepEqual(context.state.conversations, [`fictional-created-for-${destination}`]); assert.deepEqual(context.state.messages, ['Fictional retained history.']);
  }
});

test('newer creation can select first while a slower older creation remains in the owned list', async () => {
  const context = selectionHarness(), old = deferred<string>(), newest = deferred<string>();
  const first = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => old.promise, context.callbacks);
  const second = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => newest.promise, context.callbacks);
  newest.resolve('fictional-newest'); await second; old.resolve('fictional-older'); await first;
  assert.deepEqual(context.state.conversations, ['fictional-newest', 'fictional-older']); assert.equal(context.navigation.activeId, 'fictional-newest');
  assert.deepEqual(context.navigation.selected, ['fictional-newest']);
});

test('voice creation deduplicates only the current navigation and returns an old created id solely to its original caller', async () => {
  const context = selectionHarness(), old = deferred<string>(), newest = deferred<string>();
  const oldSelection = context.scope.begin('conversation-selection')!;
  const oldOperation = executeAccountSelection(context.scope, context.scope.begin()!, oldSelection, () => old.promise, context.callbacks).then(requireAccountResult);
  const oldPending = { selection: oldSelection, operation: oldOperation };
  assert.equal(currentAccountSelectionRequest(context.scope, oldPending), oldOperation);
  context.scope.invalidate('conversation-selection'); context.navigation.view = 'voice';
  assert.equal(currentAccountSelectionRequest(context.scope, oldPending), undefined);
  const newSelection = context.scope.begin('conversation-selection')!;
  const newOperation = executeAccountSelection(context.scope, context.scope.begin()!, newSelection, () => newest.promise, context.callbacks).then(requireAccountResult);
  const newPending = { selection: newSelection, operation: newOperation };
  assert.equal(currentAccountSelectionRequest(context.scope, newPending), newOperation);
  old.resolve('fictional-old-voice'); assert.equal(await oldOperation, 'fictional-old-voice');
  assert.equal(context.navigation.activeId, null); assert.equal(context.navigation.view, 'voice'); assert.deepEqual(context.navigation.selected, []);
  newest.resolve('fictional-current-voice'); assert.equal(await newOperation, 'fictional-current-voice');
  assert.deepEqual(context.state.conversations, ['fictional-old-voice', 'fictional-current-voice']); assert.equal(context.navigation.activeId, 'fictional-current-voice');
  assert.deepEqual(context.navigation.selected, ['fictional-current-voice']);
});

test('a stale selection failure does not surface in a later page while a current creation failure does', async () => {
  const context = selectionHarness(), old = deferred<string>(), current = deferred<string>();
  const first = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => old.promise, context.callbacks);
  context.scope.invalidate('conversation-selection'); context.navigation.view = 'create'; context.state.error = 'Fictional current page message.';
  old.reject(new ApiError('Fictional old POST failure.', 401)); assert.equal((await first).status, 'failed');
  assert.equal(context.state.error, 'Fictional current page message.'); assert.equal(context.navigation.view, 'create');
  const second = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => current.promise, context.callbacks);
  current.reject(new Error('Fictional current POST failure.')); assert.equal((await second).status, 'failed');
  assert.equal(context.state.error, 'Fictional current POST failure.');
});

test('a navigation creation from an earlier login cannot even remember its record in the new session', async () => {
  for (const nextAccount of ['fictional-b', 'fictional-a']) {
    const context = selectionHarness(), reply = deferred<string>();
    const operation = executeAccountSelection(context.scope, context.scope.begin()!, context.scope.begin('conversation-selection')!, () => reply.promise, context.callbacks);
    context.authenticate(null); context.authenticate(nextAccount); context.state.conversations = ['fictional-current-session'];
    reply.resolve('fictional-old-session-created'); assert.equal((await operation).status, 'discarded');
    assert.deepEqual(context.state.conversations, ['fictional-current-session']); assert.deepEqual(context.navigation.selected, []);
  }
});
