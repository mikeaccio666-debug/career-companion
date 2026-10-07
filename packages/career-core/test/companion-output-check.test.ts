import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANION_OUTPUT_FORBIDDEN_CONFIG, checkCompanionOutput, checkGroundedOutputClaims, companionOutputForbiddenRules,
  type CompanionPreviewOutputCheckInput, type GroundedOutputClaim, type GroundedOutputSource,
} from '../src/companion/output-check.ts';
import { compileFallbackCompanionStyle } from '../src/companion/style.ts';
import type { CompanionDimensions } from '../src/companion/mapping.ts';

const dimensions: CompanionDimensions = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
const companionId = '00000000-0000-4000-8000-000000000001';
const input = (text: string, patch: Partial<CompanionPreviewOutputCheckInput> = {}): CompanionPreviewOutputCheckInput => ({
  surface: 'companion_preview', slot: 'sample_1', channel: 'web', companionId, dimensions, text, sources: [], claims: [], ...patch,
});
const check = (text: string, patch: Partial<CompanionPreviewOutputCheckInput> = {}) => checkCompanionOutput(input(text, patch));
const blocked = (text: string, rule?: string) => {
  const result = check(text); assert.equal(result.status, 'blocked', text);
  if (rule) assert.ok(result.rules.includes(rule as never), `${text}: ${result.rules.join(',')}`);
};
const source = (text: string, kind: GroundedOutputSource['kind'] = 'profile', ref = 'fictional-profile:1'): GroundedOutputSource => ({ ref, kind, revision: 1, text });
const claim = (text: string, fragment: string, kind: GroundedOutputClaim['kind'] = 'user_fact', sourceRefs = ['fictional-profile:1']): GroundedOutputClaim => ({
  start: text.indexOf(fragment), end: text.indexOf(fragment) + fragment.length, kind, sourceRefs,
});
const grounding = (text: string, sources: readonly GroundedOutputSource[], claims: readonly GroundedOutputClaim[], surface: 'conversation' | 'outbound' | 'companion_preview' = 'conversation') => checkGroundedOutputClaims({ text, surface, sources, claims });

test('freely worded process samples and style summaries can pass rules without a static sentence catalog', () => {
  for (const sample of [
    '先把眼前的问题分开看看，想停一下也可以。',
    '我们可以先看依据，接着再决定怎么写。',
    '我会先理清材料里的依据，再和你讨论下一步。',
    '要不要先说说你想怎么开始？',
    '我是 AI 求职助理，先一起看看眼前的问题。',
    'We can check the evidence first. Next, we can choose a small action.',
  ]) assert.equal(check(sample).status, 'passed_rules', sample);
  const summary = '语气平稳，先把理由说清楚，也给你留出选择的余地。';
  assert.equal(check(summary, { slot: 'summary' }).status, 'passed_rules');
  assert.equal(check('A gentle tone, with clear explanations.', { slot: 'summary', dimensions: { ...dimensions, warmth: 1 } }).status, 'passed_rules');
});
test('passed_rules explicitly reports heuristic assurance and contains no model, source or persistence authority', () => {
  const result = check('先核对依据，再决定怎么写。');
  assert.equal(result.assurance, 'deterministic_rules_with_heuristic_fact_detection'); assert.equal(result.policyRevision, 1);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.rules));
  for (const key of ['text', 'approved', 'generatedBy', 'sourceAuthority', 'semanticProof', 'ready', 'bornAt', 'model']) assert.equal(Object.hasOwn(result, key), false);
});
test('every fallback summary/sample for all 729 dimension combinations and three lengths passes the same checker', () => {
  const values = [-1, 0, 1] as const;
  for (const warmth of values) for (const directness of values) for (const drive of values) for (const structure of values)
    for (const levity of values) for (const code_mix of values) for (const length of ['short', 'medium', 'long'] as const) {
      const d = { warmth, directness, drive, structure, levity, code_mix, length }, fallback = compileFallbackCompanionStyle({ companionId, dimensions: d });
      const slots: [CompanionPreviewOutputCheckInput['slot'], string][] = [['summary', fallback.summary],
        ['sample_1', fallback.samples[0]], ['sample_2', fallback.samples[1]], ['sample_3', fallback.samples[2]]];
      for (const [slot, text] of slots) assert.equal(check(text, { slot, dimensions: d }).status, 'passed_rules', `${JSON.stringify(d)} ${slot}: ${text}`);
    }
});
test('forbidden configuration is a single frozen phrase/scopes configuration and does not harm kinship nouns', () => {
  assert.ok(Object.isFrozen(COMPANION_OUTPUT_FORBIDDEN_CONFIG));
  for (const rule of COMPANION_OUTPUT_FORBIDDEN_CONFIG) { assert.ok(Object.isFrozen(rule)); assert.ok(Object.isFrozen(rule.surfaces)); }
  assert.equal(new Set(COMPANION_OUTPUT_FORBIDDEN_CONFIG.map(rule => rule.id)).size, COMPANION_OUTPUT_FORBIDDEN_CONFIG.length);
  assert.deepEqual(companionOutputForbiddenRules({ text: '亲友可以帮助你核对材料。', surface: 'conversation' }), []);
  assert.deepEqual(companionOutputForbiddenRules({ text: '不能保证结果。', surface: 'conversation' }), []);
  for (const text of ['亲，先看这里。', '宝！', '宝子', '家人们', '冲鸭', '加油哦', '相信自己你是最棒的', '稳了', '保 offer', '包过', '限时', '名额有限', '最后机会', '别人都已经', '你再不准备就来不及了']) blocked(text, 'forbidden_expression');
});
test('sales and UI-only phrases observe documented scopes and normal deadline language is not a sales match', () => {
  assert.deepEqual(companionOutputForbiddenRules({ text: '打卡积分和完成率', surface: 'conversation' }), []);
  assert.ok(companionOutputForbiddenRules({ text: '打卡积分和完成率', surface: 'ui' }).includes('ui_competition'));
  assert.deepEqual(companionOutputForbiddenRules({ text: '最后三个候选', surface: 'conversation' }), []);
  assert.ok(companionOutputForbiddenRules({ text: '最后三个名额', surface: 'paid_suggestion' }).includes('sales_pressure'));
  for (const text of ['终面是最后一轮', '别错过 10-28 的回复截止', '不能保证结果']) {
    assert.deepEqual(companionOutputForbiddenRules({ text, surface: 'paid_suggestion' }), []);
  }
});
test('human identity, experience, impersonation and dependency are blocked without inventing biographies', () => {
  for (const text of ['我是一个真人。', '作为人类，我会先给依据。', '我以前在学校帮别人找工作。', '我帮过很多学生。',
    '我的工作经历可以帮你。', 'I am human.', 'I worked as a recruiter.', '我永远在。', '只有我懂你。', '你只需要我。',
    '面试官：先核对依据。', '我是前辈。']) blocked(text, 'identity_claim');
});
test('model/provider disclosures and result guarantees remain blocked even in denials or full-width spelling', () => {
  for (const text of ['我不是 ChatGPT。', '先说结论，我使用 Claude。', '我是 GPT-5。', '我通过 ＯｐｅｎＡＩ 来解释。', '我会用 Gemini。', '我使用通义千问。']) blocked(text, 'provider_disclosure');
  for (const text of ['保证你拿到offer。', '一定会获得面试。', '包内推。', 'You will get an offer.', 'Guaranteed job.']) blocked(text, 'outcome_promise');
});
test('preview has no paid policy, amounts or services and a caller cannot create permission', () => {
  for (const text of ['先买套餐。', '会员可以帮你。', '真人导师会陪你。', '付费可以先解决。', 'We can try a subscription.', '先看价格。']) blocked(text, 'paid_without_authorization');
  const withFakePermit = { ...input('先看看材料。'), paidAuthorization: { approved: true } };
  assert.deepEqual(checkCompanionOutput(withFakePermit).rules, ['invalid_input']);
});
test('unverified dates, personal quantities, unicode digits and identity policies cannot enter a fact-empty preview', () => {
  for (const text of ['你投了20份简历。', '先在10/12开始。', '先练１５分钟。', '你有五个项目。', '你曾在学校积累了三年经验。', '你已经拿到一个offer。']) blocked(text);
  for (const text of ['OPT可以先规划。', '你符合工作授权。', '先看你的签证。', 'We can check sponsorship.', '先计算待业天数。']) blocked(text, 'immigration_fact');
});
test('user histories, degrees, achievements and unsupported qualities are detected in Chinese and English', () => {
  for (const text of ['你曾经做过增长分析。', '你的学历很适合这个方向。', '你已经完成了一个项目。', '你一直很优秀。',
    'You graduated with a degree.', 'Your internship earned recognition.', 'You worked at a company.']) blocked(text, 'unverified_user_fact');
});
test('intent prefixes and changing the preview slot never suppress protected facts or unknown named entities', () => {
  const cases = [
    '我会告诉你，你已经完成课程。', '我会解释你有工作经验。', '先给你说明你的课程项目获得奖项。',
    '我会提醒你有xexperience。', 'We can explain that you have experience.', '可以看看IBM。',
    '先告诉你我不是AI。', '先看你的签\u200b证。', '先介绍 acme 的情况。',
  ];
  for (const text of cases) for (const slot of ['summary', 'sample_1', 'sample_2', 'sample_3'] as const) {
    assert.equal(check(text, { slot }).status, 'blocked', `${slot}: ${text}`);
  }
});
test('unverified proper names and organization/location syntax fail closed without a fake company whitelist', () => {
  for (const text of ['先看 Zephyra 的资料。', '先帮你核对玫瑰科技的材料。', '你在海岸公司实习。', '先整理星云大学的资料。',
    'I worked at unknownco.', 'A source named unknownco.']) blocked(text, 'unverified_entity');
});
test('claimed external execution, saving, signatures and completed edits require actual receipts', () => {
  for (const text of ['我已经发送邮件。', '替你提交申请。', '我刚刚保存了资料。', '我已签好。', '我记住了。', '我帮你写了简历。',
    'I have sent the email.', 'We already submitted the application.']) blocked(text, 'unverified_execution');
});
test('unknown declarative clauses require review rather than being silently accepted', () => {
  for (const text of ['玫瑰的叶子长得很快。', '银河是蓝色的。', '先核对依据，树叶在睡觉。', 'A completely novel assertion.']) {
    assert.notEqual(check(text).status, 'passed_rules', text);
  }
  assert.equal(check('银河是蓝色的。').status, 'requires_review');
  assert.deepEqual(check('银河是蓝色的。').rules, ['semantic_review_required']);
});
test('preview enforces one-line transport/channel restrictions and no unsupported voice or ordinary-chat release', () => {
  for (const text of ['先看看。\n再决定。', '先看看！！', '先看看~', '先看看 https://example.test', '先看看 <b>材料</b>', '先看看🙂']) blocked(text, 'channel_limit');
  assert.equal(check('先看看' + '材料'.repeat(1100), { channel: 'discord' }).status, 'blocked');
  assert.deepEqual(checkCompanionOutput({ surface: 'conversation', text: '先核对资料。' }).rules, ['unsupported_context']);
  assert.deepEqual(checkCompanionOutput({ surface: 'outbound', text: 'Reviewed copy.' }).rules, ['unsupported_context']);
  assert.deepEqual(checkCompanionOutput({ ...input('先核对资料。'), channel: 'voice' }).rules, ['invalid_input']);
});
test('explicit personality contradictions are blocked, while absence of a contradiction is no semantic equivalence proof', () => {
  const texts: [string, Partial<CompanionDimensions>][] = [
    ['说话非常热情。', { warmth: -1 }], ['情绪表达克制。', { warmth: 1 }], ['先给结论。', { directness: -1 }],
    ['不说结论。', { directness: 1 }], ['紧盯进度。', { drive: -1 }], ['喜欢开玩笑。', { levity: -1 }],
    ['先看 draft。', { code_mix: -1 }],
  ];
  for (const [text, patch] of texts) {
    const result = check(text, { slot: 'summary', dimensions: { ...dimensions, ...patch } });
    assert.equal(result.status, 'blocked'); assert.ok(result.rules.includes('personality_conflict'));
  }
});
test('facts and model-supplied claims cannot override the preview detectors or open unsupported contexts', () => {
  const text = '你已经完成了项目。', fact = source(text), cited = claim(text, text);
  assert.deepEqual(check(text, { sources: [fact], claims: [cited] }).rules, ['unsupported_context']);
  assert.equal(check(text).status, 'blocked');
});
test('closed preview input rejects getters, symbols, inherited data and malformed dimensions without invoking caller getters', () => {
  let reads = 0;
  const getter = { ...input('先核对资料。'), get text() { reads++; return 'FICTIONAL_PRIVATE_TEXT'; } };
  const sources = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return source('Private'); } });
  for (const value of [getter, { ...input('先核对资料。'), sources }, { ...input('先核对资料。'), [Symbol('extra')]: true },
    Object.assign(Object.create({ inherited: true }), input('先核对资料。')),
    { ...input('先核对资料。'), dimensions: { ...dimensions, warmth: -0 } },
    { ...input('先核对资料。'), dimensions: { ...dimensions, extra: 'private' } },
    { ...input('先核对资料。'), companionId: companionId + '\n' }, { ...input('先核对资料。'), approved: true }]) {
    const result = checkCompanionOutput(value); assert.equal(result.status, 'blocked'); assert.deepEqual(result.rules, ['invalid_input']);
    assert.equal(Object.hasOwn(result, 'cause'), false); assert.doesNotMatch(JSON.stringify(result), /FICTIONAL_PRIVATE_TEXT/);
  }
  assert.equal(reads, 0);
});
test('exact-span source matching reports provenance limits and does not certify all facts or source authority', () => {
  const text = '课程项目分析了实验结果。', result = grounding(text, [source(text)], [claim(text, text)], 'outbound');
  assert.equal(result.status, 'matched_spans'); assert.equal(result.sourceAuthority, 'not_established_by_this_function');
  assert.equal(result.semanticCoverage, 'not_established_by_this_function'); assert.equal(result.assurance, 'caller_spans_and_exact_source_text_only');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.failures));
  for (const field of ['text', 'sources', 'approved', 'passed', 'ready']) assert.equal(Object.hasOwn(result, field), false);
});
test('matching a numeral alone is not evidence for the entire user claim, and numeric substrings do not match larger tokens', () => {
  const text = '你拥有3年工作经验。';
  assert.equal(grounding(text, [source('3')], [claim(text, text)]).status, 'unmatched_spans');
  for (const sourceText of ['30', '13', '3.14', '0.3']) {
    assert.equal(grounding('3', [source(sourceText)], [claim('3', '3', 'number')]).status, 'unmatched_spans', sourceText);
  }
  assert.equal(grounding('3', [source('一共 3 份')], [claim('3', '3', 'number')]).status, 'matched_spans');
});
test('source refs must exist and every claimed source must contain the exact phrase, without fuzzy invented translations', () => {
  const text = '课程项目分析了实验结果。';
  assert.equal(grounding(text, [], [claim(text, text)]).failures[0].rule, 'source_missing');
  assert.equal(grounding(text, [source('我分析过一个实验')], [claim(text, text)]).failures[0].rule, 'source_text_mismatch');
  const claims = [claim(text, text, 'user_fact', ['fictional-profile:1', 'missing:1'])];
  assert.equal(grounding(text, [source(text)], claims).status, 'unmatched_spans');
});
test('outbound claims exclude unconfirmed user messages and remote tool data; identity and execution use their own source types', () => {
  const text = 'This is an exact fictional source phrase.';
  for (const kind of ['tool_result', 'user_message'] as const) assert.equal(grounding(text, [source(text, kind)], [claim(text, text)], 'outbound').failures[0].rule, 'source_kind');
  assert.equal(grounding(text, [source(text)], [claim(text, text, 'immigration_fact')]).failures[0].rule, 'source_kind');
  assert.equal(grounding(text, [source(text, 'immigration_fact')], [claim(text, text, 'immigration_fact')]).status, 'matched_spans');
  assert.equal(grounding(text, [source(text, 'user_message')], [claim(text, text, 'immigration_fact')]).status, 'matched_spans');
  for (const kind of ['execution_fact', 'sponsorship_quote'] as const) {
    assert.equal(grounding(text, [source(text)], [claim(text, text, kind)]).failures[0].rule, 'source_kind');
    assert.equal(grounding(text, [source(text, 'tool_result')], [claim(text, text, kind)]).status, 'matched_spans');
  }
});
test('malformed or duplicate sources, omitted span refs and surrogate-split claims cannot be treated as valid evidence', () => {
  const text = 'A valid 𠮷 character.', fact = source(text), cited = claim(text, text);
  const valid = { text, surface: 'conversation' as const, sources: [fact], claims: [cited] };
  for (const value of [{ ...valid, sources: [fact, fact] }, { ...valid, sources: [{ ...fact, revision: 0 }] },
    { ...valid, sources: [{ ...fact, confirmed: true }] }, { ...valid, claims: [{ ...cited, sourceRefs: [] }] },
    { ...valid, claims: [{ ...cited, start: -1 }] }, { ...valid, claims: [{ ...cited, end: text.length + 1 }] },
    { ...valid, claims: [{ ...cited, sourceRefs: ['fictional-profile:1', 'fictional-profile:1'] }] },
    { ...valid, claims: [{ ...cited, start: text.indexOf('𠮷'), end: text.indexOf('𠮷') + 1 }] },
  ]) { const result = checkGroundedOutputClaims(value as never); assert.equal(result.status, 'unmatched_spans'); assert.deepEqual(result.failures, [{ claimIndex: -1, rule: 'invalid_input' }]); }
});
test('caller mutation and accessor evidence do not produce stored mutable approval objects or expose raw text', () => {
  let reads = 0;
  const text = 'FICTIONAL_PRIVATE_SOURCE';
  const value = { text, surface: 'conversation' as const, sources: [source(text)], claims: [claim(text, text)] };
  const result = checkGroundedOutputClaims(value); value.sources[0] = source('Changed'); value.claims[0] = claim(text, 'PRIVATE');
  assert.equal(result.status, 'matched_spans'); assert.doesNotMatch(JSON.stringify(result), /FICTIONAL_PRIVATE_SOURCE/);
  const sourceGetter = { ...source(text), get text() { reads++; return text; } };
  const failure = grounding(text, [sourceGetter], [claim(text, text)]);
  assert.equal(failure.status, 'unmatched_spans'); assert.equal(reads, 0); assert.ok(Object.isFrozen(failure.failures[0]));
});
