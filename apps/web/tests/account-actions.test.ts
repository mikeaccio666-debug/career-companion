import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountActionInbox, accountActionFailure, canOpenAuthenticatedAccount, canOpenPrivateWorkspace, parseAuthOptions, passwordResetAcceptedText, passwordResetValidation, takeAccountActionLink } from '../src/account-actions.ts';

const token = 'A'.repeat(43);
function location(hash: string) {
  const calls: unknown[][] = [];
  const current = { hash, pathname: '/workspace/', search: '?language=zh' };
  const history = { state: { fictional: 'navigation' }, replaceState(...args: unknown[]) { calls.push(args); current.hash = ''; } };
  return { current, history, calls };
}

test('account fragments are erased before any consumer receives the in-memory token, preserving ordinary navigation', () => {
  for (const kind of ['password-reset', 'verify-email'] as const) {
    const page = location(`#account-action=${kind}&token=${token}`);
    const action = takeAccountActionLink(page.current, page.history);
    assert.equal(page.current.hash, '');
    assert.deepEqual(page.calls, [[page.history.state, '', '/workspace/?language=zh']]);
    assert.deepEqual(action, { kind, token });
    assert.equal(JSON.stringify(page.calls).includes(token), false);
    assert.equal(takeAccountActionLink(page.current, page.history), null);
  }
});

test('duplicate, encoded, oversized, additional and malformed action fragments never deliver a token', () => {
  for (const fragment of [
    `#account-action=password-reset&token=${token}&token=${token}`,
    `#account-action=verify-email&token=${token}&redirect=https://example.test/`,
    `#account-action=password-reset&token=${'A'.repeat(42)}`,
    `#account-action=verify-email&token=${'A'.repeat(44)}`,
    `#account-action=password-reset&token=%41${'A'.repeat(42)}`,
    '#account-action=unknown&token=fictional',
    '#account-action=password-reset',
    '#account-action=verify-email&token=contains space',
  ]) {
    const page = location(fragment), action = takeAccountActionLink(page.current, page.history);
    assert.equal(page.current.hash, ''); assert.equal(page.calls.length, 1);
    assert.equal(action?.kind, 'invalid'); assert.equal(action && 'token' in action, false);
  }
  const page = location('#ordinary-navigation');
  assert.equal(takeAccountActionLink(page.current, page.history), null); assert.deepEqual(page.calls, []);
});

test('StrictMode can read the one-time memory inbox twice and clearing it retains no action', () => {
  const page = location(`#account-action=password-reset&token=${token}`);
  const inbox = new AccountActionInbox(takeAccountActionLink(page.current, page.history));
  assert.deepEqual(inbox.peek(), { kind: 'password-reset', token }); assert.deepEqual(inbox.peek(), { kind: 'password-reset', token });
  assert.equal(page.calls.length, 1); inbox.clear(); assert.equal(inbox.peek(), null); assert.equal(page.current.hash, '');
});

test('private workspace fails closed for missing configuration, unverified production accounts and every pending account action', () => {
  const production = parseAuthOptions({ emailActionsEnabled: true, requireVerifiedEmail: true }), development = parseAuthOptions({ emailActionsEnabled: false, requireVerifiedEmail: false });
  assert.equal(canOpenAuthenticatedAccount(null, { emailVerified: true }, null), false);
  assert.equal(canOpenAuthenticatedAccount(production, null, null), false);
  assert.equal(canOpenAuthenticatedAccount(production, {}, null), false);
  assert.equal(canOpenAuthenticatedAccount(production, { emailVerified: false }, null), false);
  assert.equal(canOpenAuthenticatedAccount(production, { emailVerified: true }, null), true);
  assert.equal(canOpenAuthenticatedAccount(development, {}, null), true);
  assert.equal(canOpenPrivateWorkspace(production, { emailVerified: true }, null), false);
  assert.equal(canOpenPrivateWorkspace(development, {}, null), false);
  for (const action of [{ kind: 'password-reset', token }, { kind: 'verify-email', token }, { kind: 'invalid' }] as const) {
    assert.equal(canOpenAuthenticatedAccount(production, { emailVerified: true }, action), false);
    assert.equal(canOpenAuthenticatedAccount(development, { emailVerified: false }, action), false);
  }
});

test('malformed auth metadata cannot silently grant development access', () => {
  for (const value of [null, {}, { emailActionsEnabled: true }, { emailActionsEnabled: 'true', requireVerifiedEmail: true }, { emailActionsEnabled: false, requireVerifiedEmail: 0 }]) assert.throws(() => parseAuthOptions(value));
  assert.deepEqual(parseAuthOptions({ emailActionsEnabled: false, requireVerifiedEmail: true, unrelated: 'ignored' }), { emailActionsEnabled: false, requireVerifiedEmail: true, requireInvite: true, legal: { status: 'unavailable' } });
});

test('password reset bounds and confirmation are applied before a completion request', () => {
  assert.match(passwordResetValidation('short', 'short')!, /10/);
  assert.equal(passwordResetValidation('A'.repeat(10), 'A'.repeat(10)), null);
  assert.equal(passwordResetValidation('A'.repeat(256), 'A'.repeat(256)), null);
  assert.match(passwordResetValidation('A'.repeat(257), 'A'.repeat(257))!, /256/);
  assert.match(passwordResetValidation('fictional-password', 'different-password')!, /不一致/);
});

test('uniform invalid links permit manual account switching without exposing reflected token or failure reasons', () => {
  const invalid = accountActionFailure({ code: 'ACCOUNT_ACTION_INVALID', message: `wrong owner secret ${token}` });
  assert.equal(invalid.discardToken, false); assert.match(invalid.text, /登录了收到邮件的账号/);
  for (const failure of [invalid, accountActionFailure({ message: token }), accountActionFailure({ code: token }), accountActionFailure({ code: 'ACCOUNT_EMAIL_UNAVAILABLE', message: token })]) assert.equal(failure.text.includes(token), false);
  assert.match(accountActionFailure({ status: 401 }).text, /登录已失效/);
  assert.deepEqual(accountActionFailure({ code: 'REQUEST_LIMIT_REACHED', status: 429, message: token }), { text: '操作过于频繁，请稍后再试。', discardToken: false });
  assert.equal(passwordResetAcceptedText, '如果存在该账号，我们会发送找回邮件。');
});
