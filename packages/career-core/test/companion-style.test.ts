import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionStyleError, compileFallbackCompanionStyle } from '../src/companion/style.ts';
import type { CompanionDimensions } from '../src/companion/mapping.ts';

const dimensions: CompanionDimensions = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const compile = (patch: Partial<CompanionDimensions> = {}, n = 1) => compileFallbackCompanionStyle({ companionId: id(n), dimensions: { ...dimensions, ...patch } });

test('fallback is a frozen deterministic rule preview with exactly three samples, not a model or birth record', () => {
  const result = compile(); assert.deepEqual(compile(), result);
  assert.equal(result.generatedBy, 'fallback'); assert.equal(result.generatorVersion, 1); assert.equal(result.samples.length, 3);
  assert.deepEqual(Object.keys(result), ['generatedBy', 'generatorVersion', 'summary', 'samples', 'styleCard', 'quirks', 'inkToken']);
  for (const value of [result, result.samples, result.quirks]) assert.equal(Object.isFrozen(value), true);
  assert.ok(Array.from(result.styleCard).length <= 600); assert.ok(result.summary.trim());
  for (const field of ['model', 'active', 'completed', 'bornAt', 'firstLetter', 'fingerprint', 'userId']) assert.equal(Object.hasOwn(result, field), false);
});
test('low levity removes the metaphor source and every dimension value uses the explicit speaking rules', () => {
  for (let n = 1; n <= 24; n++) { const result = compile({ levity: -1 }, n); assert.equal(result.quirks.metaphorSource, null); assert.match(result.styleCard, /不使用比喻或玩笑/); }
  assert.match(compile({ warmth: -1 }).summary, /克制/); assert.match(compile({ warmth: 1 }).summary, /温和/);
  assert.match(compile({ directness: 1 }).summary, /先说结论/); assert.equal(compile({ directness: 1 }).quirks.openingStyle, 'conclusion');
  assert.match(compile({ directness: -1 }).summary, /先说材料/); assert.notEqual(compile({ directness: -1 }).quirks.openingStyle, 'conclusion');
  assert.match(compile({ drive: -1 }).summary, /可选/); assert.match(compile({ drive: 1 }).summary, /确认再做/);
  assert.match(compile({ structure: -1 }).styleCard, /连贯短段落/); assert.match(compile({ structure: 1 }).styleCard, /数字和日期只来自已核实来源/);
});
test('ink stays in the seven approved design tokens and warm/cold preference never invents a color', () => {
  const warm = new Set(['yanzhi', 'zheshi', 'ganlan', 'jiangzi']), cold = new Set(['dai', 'yanzi', 'hehui']);
  for (let n = 1; n <= 30; n++) {
    assert.ok(warm.has(compile({ warmth: 1, levity: 0 }, n).inkToken)); assert.ok(cold.has(compile({ warmth: -1, levity: 0 }, n).inkToken));
    assert.ok(new Set([...warm, ...cold]).has(compile({}, n).inkToken));
  }
  const choices = new Set(Array.from({ length: 32 }, (_, n) => JSON.stringify(compile({}, n + 1).quirks)));
  assert.ok(choices.size > 1, 'different actual seeds can produce different preview detail');
});
test('preview wording has no invented user histories, names, quantities, signatures or model claim', () => {
  for (let n = 1; n <= 10; n++) {
    const result = compile({ directness: 1, drive: 1, code_mix: 1 }, n);
    const copy = [result.summary, ...result.samples].join('\n');
    assert.doesNotMatch(copy, /[0-9]|IBM|Juno|F-1|OPT|offer|你已经|你投了|你的实习|已发送|已记住|我是真人|我是模型/);
    assert.match(result.styleCard, /明确自己是AI/); assert.match(result.styleCard, /不添加用户未提供的经历、数字或身份事实/);
    assert.match(result.styleCard, /最终提交由本人操作/);
  }
});
test('style records the actual scope/frequency constraints without executing them', () => {
  const result = compile({ levity: 1, code_mix: -1, length: 'short' });
  assert.notEqual(result.quirks.metaphorSource, null); assert.match(result.styleCard, /每十条最多一次，只用于事情，不用于用户处境或拖延/);
  assert.match(result.styleCard, /长回复才采用/); assert.match(result.styleCard, /落款仅在信件/);
  assert.match(result.styleCard, /情绪对话用中文/); assert.match(result.styleCard, /练习材料、简历和外联草稿一律英文/);
  assert.match(result.styleCard, /一至四行/); assert.match(compile({ length: 'long' }).styleCard, /最多十行/);
  const withPhrase = Array.from({ length: 20 }, (_, n) => compile({}, n + 1)).find(item => item.quirks.catchphrase !== null);
  assert.ok(withPhrase); assert.match(withPhrase.styleCard, /用户纠正立即停用/);
  assert.equal(Object.hasOwn(result, 'utteranceCount'), false);
});
test('all 729 dimension combinations and three length choices stay bounded, deterministic and facts-free', () => {
  const values = [-1, 0, 1] as const;
  for (const warmth of values) for (const directness of values) for (const drive of values) for (const structure of values)
    for (const levity of values) for (const code_mix of values) for (const length of ['short', 'medium', 'long'] as const) {
      const input = { companionId: id(7), dimensions: { warmth, directness, drive, structure, levity, code_mix, length } };
      const result = compileFallbackCompanionStyle(input);
      assert.ok(Array.from(result.styleCard).length <= 600); assert.equal(result.samples.length, 3);
      if (levity < 0) assert.equal(result.quirks.metaphorSource, null);
      assert.deepEqual(compileFallbackCompanionStyle(input), result);
    }
});
test('closed input rejects getters, unknown authority fields and invalid UUID/dimension values', () => {
  let reads = 0;
  const input = { companionId: id(1), get dimensions() { reads++; return dimensions; } };
  assert.throws(() => compileFallbackCompanionStyle(input), CompanionStyleError); assert.equal(reads, 0);
  for (const patch of [{ companionId: id(1) + '\n' }, { companionId: 'not-a-uuid' }, { userName: 'Do not invent a user' }, { generatedBy: 'model' },
    { dimensions: { ...dimensions, warmth: 2 } }, { dimensions: { ...dimensions, drive: NaN } }, { dimensions: { ...dimensions, directness: -0 } },
    { dimensions: { ...dimensions, length: 'unlimited' } }, { dimensions: { ...dimensions, approved: true } }]) {
    assert.throws(() => compileFallbackCompanionStyle({ companionId: id(1), dimensions, ...patch } as never), CompanionStyleError);
  }
  assert.throws(() => compileFallbackCompanionStyle({ companionId: id(1), dimensions: { ...dimensions, get warmth() { reads++; return 1 as const; } } }), CompanionStyleError);
  assert.equal(reads, 0);
});
