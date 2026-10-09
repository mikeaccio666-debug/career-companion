import {test} from 'node:test';
import {verifyRecovery} from './backup-restore-fixture.ts';
test('backup restores the full database and version-pinned private S3 objects', {timeout:180_000},t=>verifyRecovery(t,'s3'));
