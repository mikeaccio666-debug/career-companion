import { test } from 'node:test';
import assert from 'node:assert/strict';
import { careerRecordObject } from '@companion/platform-contracts';
import { careerHttpQuery } from '../src/career-http-query.ts';

test('framework query prototype becomes plain own fields without relaxing the domain parser', () => {
  const query = Object.create(Object.create(null));
  query.after = 'fictional-cursor';
  assert.throws(() => careerRecordObject(query, [], ['after']));
  const dto = careerHttpQuery(query);
  assert.equal(Object.getPrototypeOf(dto), null);
  assert.deepEqual(careerRecordObject(dto, [], ['after']).after, 'fictional-cursor');
  const inherited = Object.create({ after: 'inherited' });
  assert.deepEqual(Object.keys(careerHttpQuery(inherited)), []);
  assert.deepEqual(careerHttpQuery({ after: ['first', 'second'] }).after, ['first', 'second']);
});
test('query accessors, symbols, hidden fields and non-records are rejected without invoking getters', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'after', { enumerable: true, get() { calls++; return 'cursor'; } });
  for (const value of [getter, { [Symbol('hidden')]: 'x' }, Object.defineProperty({}, 'after', { value: 'hidden' }), [], null, 'after=x']) assert.throws(() => careerHttpQuery(value));
  assert.equal(calls, 0);
});
