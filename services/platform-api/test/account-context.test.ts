import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { PLATFORM_ACCOUNT_HEADER, PLATFORM_ACCOUNT_QUERY } from '@companion/platform-contracts';
import { requireAccountContext } from '../src/account-context.ts';
import { ApiError } from '../src/errors.ts';

const alice = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bob = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function request(header?: unknown, query: Record<string, unknown> = {}, rawHeaders?: string[]): FastifyRequest {
  return { headers: header === undefined ? {} : { [PLATFORM_ACCOUNT_HEADER]: header }, query,
    raw: { rawHeaders: rawHeaders ?? (typeof header === 'string' ? [PLATFORM_ACCOUNT_HEADER, header] : []) } } as unknown as FastifyRequest;
}
const failure = (status: number, code: string) => (error: unknown) => error instanceof ApiError && error.status === status && error.code === code;

test('account assertions normalize UUID case and never choose the authenticated account', () => {
  requireAccountContext(request(alice), alice);
  requireAccountContext(request(alice.toUpperCase()), alice);
  assert.throws(() => requireAccountContext(request(bob), alice), failure(409, 'ACCOUNT_CONTEXT_CHANGED'));
  assert.throws(() => requireAccountContext(request(alice), bob), failure(409, 'ACCOUNT_CONTEXT_CHANGED'));
  assert.throws(() => requireAccountContext(request(), alice), failure(409, 'ACCOUNT_CONTEXT_REQUIRED'));
});

test('invalid and duplicate header assertions are rejected before any comparison', () => {
  for (const header of ['', ' '+alice, alice+' ', 'fictional-not-an-id', alice+','+alice, [alice], [alice, alice]]) {
    assert.throws(() => requireAccountContext(request(header), alice), failure(400, 'ACCOUNT_CONTEXT_INVALID'));
  }
  assert.throws(() => requireAccountContext(request(alice, {}, [PLATFORM_ACCOUNT_HEADER, alice, PLATFORM_ACCOUNT_HEADER.toUpperCase(), alice]), alice), failure(400, 'ACCOUNT_CONTEXT_INVALID'));
});

test('only file requests allow one query assertion, with no malformed, duplicate or conflicting alternative', () => {
  requireAccountContext(request(undefined, { [PLATFORM_ACCOUNT_QUERY]: alice }), alice, true);
  requireAccountContext(request(alice, { [PLATFORM_ACCOUNT_QUERY]: alice.toUpperCase() }), alice, true);
  assert.throws(() => requireAccountContext(request(undefined, { [PLATFORM_ACCOUNT_QUERY]: bob }), alice, true), failure(409, 'ACCOUNT_CONTEXT_CHANGED'));
  assert.throws(() => requireAccountContext(request(alice, { [PLATFORM_ACCOUNT_QUERY]: bob }), alice, true), failure(400, 'ACCOUNT_CONTEXT_INVALID'));
  for (const value of ['', ' '+alice, [alice], [alice, alice], null]) {
    assert.throws(() => requireAccountContext(request(undefined, { [PLATFORM_ACCOUNT_QUERY]: value }), alice, true), failure(400, 'ACCOUNT_CONTEXT_INVALID'));
  }
  assert.throws(() => requireAccountContext(request(alice, { [PLATFORM_ACCOUNT_QUERY]: alice }), alice), failure(400, 'ACCOUNT_CONTEXT_INVALID'));
  assert.throws(() => requireAccountContext(request(undefined, { [PLATFORM_ACCOUNT_QUERY]: alice }), alice), failure(400, 'ACCOUNT_CONTEXT_INVALID'));
  assert.throws(() => requireAccountContext(request(), alice, true), failure(409, 'ACCOUNT_CONTEXT_REQUIRED'));
});
