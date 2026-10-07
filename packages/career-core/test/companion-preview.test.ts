import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANION_PREVIEW_JSON_SCHEMA, COMPANION_PREVIEW_MAX_JSON_BYTES, CompanionPreviewError,
  parseCompanionModelPreview, parseCompanionModelPreviewJson,
} from '../src/companion/preview.ts';

const preview = () => ({ summary: '说话平实，先给依据，再一起选下一步。', samples: [
  '可以先停一下，把眼前的事情理清。',
  '材料能支持的和还待核对的地方，我们分开看。',
  '想继续时，先选一个小动作。',
] });
const rejected = (run: () => unknown) => assert.throws(run, error => {
  assert.ok(error instanceof CompanionPreviewError);
  assert.equal(error.code, 'COMPANION_PREVIEW_INVALID');
  assert.equal(error.message, 'The companion preview could not be parsed.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
});

test('closed preview snapshots only summary and three samples and freezes nested data', () => {
  const input = preview(), expected = preview(), output = parseCompanionModelPreview(input);
  assert.deepEqual(output, expected); assert.deepEqual(Object.keys(output), ['summary', 'samples']);
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.samples));
  input.summary = 'Changed'; input.samples[0] = 'Changed'; input.samples.push('Extra');
  assert.deepEqual(output, expected);
  for (const key of ['generatedBy', 'styleCard', 'quirks', 'inkToken', 'approved', 'active', 'model', 'userId']) {
    assert.equal(Object.hasOwn(output, key), false);
  }
});
test('schema is deeply frozen and represents only the model-owned fields', () => {
  const schema = COMPANION_PREVIEW_JSON_SCHEMA;
  assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ['summary', 'samples']);
  assert.deepEqual(Object.keys(schema.properties), ['summary', 'samples']);
  assert.equal(schema.properties.samples.minItems, 3); assert.equal(schema.properties.samples.maxItems, 3);
  for (const node of [schema, schema.required, schema.properties, schema.properties.summary, schema.properties.samples,
    schema.properties.samples.items]) assert.ok(Object.isFrozen(node));
  assert.equal(Object.hasOwn(schema.properties.summary, 'maxLength'), false, 'no invented product copy-length requirement');
});
test('plain and null-prototype records parse without mutating or normalizing output', () => {
  const input = Object.assign(Object.create(null), preview());
  assert.deepEqual(parseCompanionModelPreview(input), preview());
  const whitespace = { summary: '  Keep this wording.  ', samples: ['One.', 'Two.', 'Three.'] };
  assert.equal(parseCompanionModelPreview(whitespace).summary, whitespace.summary);
});
test('unknown fields, missing fields, wrong types and authority metadata are rejected', () => {
  for (const input of [null, undefined, [], 'text', 1, {}, { summary: 'x' }, { samples: preview().samples },
    { ...preview(), summary: 1 }, { ...preview(), samples: 'x' }, { ...preview(), generatedBy: 'model' },
    { ...preview(), styleCard: 'x' }, { ...preview(), quirks: {} }, { ...preview(), inkToken: 'dai' },
    { ...preview(), firstLetter: 'x' }, { ...preview(), approved: true }, { ...preview(), [Symbol('extra')]: true }]) {
    rejected(() => parseCompanionModelPreview(input));
  }
});
test('custom prototypes and accessor or hidden properties are rejected without reading getters', () => {
  let reads = 0;
  const getter = { ...preview(), get summary() { reads++; return 'Private text'; } };
  const hidden = Object.defineProperty(preview(), 'summary', { value: 'Private text', enumerable: false });
  const prototype = Object.assign(Object.create({ inherited: true }), preview());
  const inherited = Object.create(preview());
  const extraGetter = Object.defineProperty(preview(), 'extra', { enumerable: true, get() { reads++; return true; } });
  for (const input of [getter, hidden, prototype, inherited, extraGetter]) rejected(() => parseCompanionModelPreview(input));
  assert.equal(reads, 0);
});
test('sample tuple rejects holes, accessors, hidden items, custom prototypes and extra keys', () => {
  let reads = 0;
  const hole = ['One.', , 'Three.'];
  const getter = Object.defineProperty(['One.', 'Two.', 'Three.'], '1', { enumerable: true, get() { reads++; return 'Private'; } });
  const hidden = Object.defineProperty(['One.', 'Two.', 'Three.'], '1', { value: 'Two.', enumerable: false });
  const custom = Object.setPrototypeOf(['One.', 'Two.', 'Three.'], Object.create(Array.prototype));
  const extra = Object.assign(['One.', 'Two.', 'Three.'], { extra: 'Private' });
  const symbol = Object.assign(['One.', 'Two.', 'Three.'], { [Symbol('extra')]: 'Private' });
  for (const samples of [[], ['One.', 'Two.'], ['One.', 'Two.', 'Three.', 'Four.'], ['One.', 2, 'Three.'],
    hole, getter, hidden, custom, extra, symbol]) rejected(() => parseCompanionModelPreview({ ...preview(), samples }));
  assert.equal(reads, 0);
});
test('every textual field rejects blank, multiline, controls, bidi formatting and lone surrogates', () => {
  for (const invalid of ['', '  ', '\n', 'a\nb', 'a\rb', 'a\tb', 'a\0b', 'a\u007fb', 'a\u2028b', 'a\u2029b',
    'a\u061cb', 'a\u200eb', 'a\u200fb', 'a\u202ab', 'a\u202eb', 'a\u2066b', 'a\u2069b', '\ud800', '\udfff']) {
    rejected(() => parseCompanionModelPreview({ ...preview(), summary: invalid }));
    for (let index = 0; index < 3; index++) {
      const input = preview(); input.samples[index] = invalid; rejected(() => parseCompanionModelPreview(input));
    }
  }
});
test('valid non-BMP characters and accents survive as text, without semantic approval', () => {
  const input = { summary: 'Élodie 和𠮷先看材料。', samples: ['A composed é.', 'A decomposed e\u0301.', 'A valid pair: 𠮷.'] };
  assert.deepEqual(parseCompanionModelPreviewJson(JSON.stringify(input)), input);
  const semanticPending = { summary: 'A claim awaiting separate policy review.', samples: ['Text.', 'Text.', 'Text.'] };
  assert.deepEqual(parseCompanionModelPreview(semanticPending), semanticPending);
});
test('transport cap counts UTF-8 bytes, accepts its exact boundary and rejects excess', () => {
  const base = { summary: '', samples: ['One.', 'Two.', 'Three.'] };
  const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const exact = { ...base, summary: 'a'.repeat(COMPANION_PREVIEW_MAX_JSON_BYTES - overhead) };
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).byteLength, COMPANION_PREVIEW_MAX_JSON_BYTES);
  assert.deepEqual(parseCompanionModelPreview(exact), exact);
  assert.deepEqual(parseCompanionModelPreviewJson(JSON.stringify(exact)), exact);
  rejected(() => parseCompanionModelPreview({ ...exact, summary: exact.summary + 'a' }));
  rejected(() => parseCompanionModelPreviewJson(JSON.stringify({ ...exact, summary: exact.summary + 'a' })));
  const multiByte = { ...base, summary: '汉'.repeat(Math.floor(COMPANION_PREVIEW_MAX_JSON_BYTES / 2)) };
  assert.ok(JSON.stringify(multiByte).length < COMPANION_PREVIEW_MAX_JSON_BYTES);
  rejected(() => parseCompanionModelPreview(multiByte)); rejected(() => parseCompanionModelPreviewJson(JSON.stringify(multiByte)));
});
test('JSON parser accepts either key order, legal surrounding whitespace and escaped punctuation', () => {
  const input = { summary: '先说 "材料"，再看依据。', samples: ['A \\ B.', 'Quoted: "next".', 'A valid pair: 𠮷.'] };
  assert.deepEqual(parseCompanionModelPreviewJson(` \r\n${JSON.stringify(input)}\t `), input);
  assert.deepEqual(parseCompanionModelPreviewJson(JSON.stringify({ samples: input.samples, summary: input.summary })), input);
  assert.deepEqual(parseCompanionModelPreviewJson('{"summary":"S","samples":["A","B","C"]}'), { summary: 'S', samples: ['A', 'B', 'C'] });
});
test('JSON parser rejects duplicate decoded keys and additional fields instead of taking the last value', () => {
  for (const json of [
    '{"summary":"first","summary":"second","samples":["A","B","C"]}',
    '{"summary":"first","\\u0073ummary":"second"}',
    '{"samples":["A","B","C"],"samples":["D","E","F"]}',
    '{"summary":"S","samples":["A","B","C"],"approved":true}',
    '{"summary":"S","__proto__":{"approved":true}}',
    '{"refusal":"Private model refusal"}',
  ]) rejected(() => parseCompanionModelPreviewJson(json));
});
test('incomplete JSON, fences, comments, trailing text and tuple grammar failures remain failures', () => {
  const valid = JSON.stringify(preview());
  for (const json of ['', '{}', '[]', 'null', '"text"', valid.slice(0, -1), `${valid} trailing`, `${valid}${valid}`,
    `\u00a0${valid}`, `\uFEFF${valid}`, `\x60\x60\x60json\n${valid}\n\x60\x60\x60`, `/* comment */${valid}`,
    '{"summary":"S","samples":["A","B"]}', '{"summary":"S","samples":["A","B","C","D"]}',
    '{"summary":"S","samples":["A","B","C",]}', '{"summary":"S","samples":["A",null,"C"]}',
    '{"summary":"bad\\q","samples":["A","B","C"]}', '{"summary":"bad\\u12zz","samples":["A","B","C"]}',
    '{"summary":"raw\nline","samples":["A","B","C"]}', '{"summary":"S","samples":["A","B","C"],}',
  ]) rejected(() => parseCompanionModelPreviewJson(json));
});
test('all errors stay constant without exposing rejected text or parser/reflection causes', () => {
  const secret = 'FICTIONAL_PRIVATE_MARKER';
  rejected(() => parseCompanionModelPreview({ ...preview(), extra: secret }));
  rejected(() => parseCompanionModelPreviewJson(`${JSON.stringify(preview())}${secret}`));
  rejected(() => parseCompanionModelPreviewJson(7 as never));
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  rejected(() => parseCompanionModelPreview(proxy));
});
