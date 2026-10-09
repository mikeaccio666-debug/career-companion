import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountReauthentication } from '../src/account-privacy.ts';
test('privacy verification accepts only an explicit supported purpose and bounded password', () => {
  const value = parseAccountReauthentication({ purpose: 'account_export', password: 'Fictional password' }); assert(Object.isFrozen(value));
  for (const raw of [{ purpose: 'model_call', password: 'x' }, { purpose: 'account_delete', password: '' },
    { purpose: 'account_export', password: '字'.repeat(342) }, { purpose: 'account_export', password: 'x', userId: 'foreign' },
    { purpose: 'account_export', password: 'x', [Symbol()]: 1 }]) assert.throws(() => parseAccountReauthentication(raw));
  let read = false; const raw = { purpose: 'account_export', get password() { read = true; return 'x'; } };
  assert.throws(() => parseAccountReauthentication(raw)); assert.equal(read, false);
});
