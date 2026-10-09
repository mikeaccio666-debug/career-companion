import {test} from 'node:test';
import {verifyRecovery} from './backup-restore-fixture.ts';
test('backup restores the full database, encrypted history and local private files', {timeout:180_000},t=>verifyRecovery(t,'local'));
