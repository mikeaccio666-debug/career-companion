import { describe, expect, it } from 'vitest';

import { createDockSignOutIntent, parseDockSignOutIntent } from '../lib/dockSignOutIntent';

describe('dock/sign-out 意图', () => {
  it('只认精确的一个键', () => {
    expect(parseDockSignOutIntent({ kind: 'dock/sign-out' })).toEqual({ kind: 'dock/sign-out' });
    expect(parseDockSignOutIntent(createDockSignOutIntent())).toEqual({ kind: 'dock/sign-out' });
  });

  it.each([
    ['别的 kind', { kind: 'dock/open-portal', page: 'CONNECT' }],
    ['多一个键', { kind: 'dock/sign-out', all: true }],
    ['缺 kind', {}],
    ['不是对象', 'dock/sign-out'],
    ['数组', ['dock/sign-out']],
    ['null', null],
  ])('拒绝：%s', (_why, value) => {
    expect(parseDockSignOutIntent(value)).toBeNull();
  });
});
