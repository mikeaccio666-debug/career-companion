import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.ts';

test('organization brand is server configuration with strict validation and grants no runtime capability', () => {
  assert.equal(readConfig({}).orgContentBrand, '蔓藤');
  const config = readConfig({ PLATFORM_ORG_CONTENT_BRAND: 'Fictional Organization' });
  assert.equal(config.orgContentBrand, 'Fictional Organization');
  assert.deepEqual(config.modelRoutes, {});
  assert.equal(config.workbenchEnabled, false);
  assert.equal(config.dataCrypto, undefined);
  for (const value of ['', ' ', ' fictional-private', 'fictional-private\n', '<fictional-private>', 'fictional-private·v2', 'fictional-private\u202e', 'x'.repeat(41)]) {
    assert.throws(() => readConfig({ PLATFORM_ORG_CONTENT_BRAND: value }), error => error instanceof Error && !error.message.includes('fictional-private'));
  }
});
