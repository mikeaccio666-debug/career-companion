import type { CompanionDimensions } from './mapping.ts';
import { EXPERT_KEYS, type ExpertKey } from '@companion/platform-contracts';
import { enabledExpertRoster } from '../team/members.ts';

export type CompanionOutputSurface = 'companion_preview' | 'first_letter' | 'conversation' | 'outbound' | 'proactive' | 'paid_suggestion' | 'mode_card' | 'ui';
export type CompanionOutputRule = 'invalid_input' | 'unsupported_context' | 'forbidden_expression' | 'outcome_promise'
  | 'identity_claim' | 'provider_disclosure' | 'paid_without_authorization' | 'unverified_numeric'
  | 'unverified_entity' | 'unverified_user_fact' | 'unverified_execution' | 'immigration_fact'
  | 'channel_limit' | 'personality_conflict' | 'semantic_review_required'
  | 'first_letter_identity_missing' | 'first_letter_memory_missing' | 'first_letter_external_rule_missing'
  | 'first_letter_facts_missing' | 'first_letter_followup_missing' | 'first_letter_team_mismatch'
  | 'first_letter_today_missing' | 'first_letter_language_mismatch';
export interface CompanionOutputCheckResult {
  readonly status: 'passed_rules' | 'blocked' | 'requires_review';
  readonly rules: readonly CompanionOutputRule[];
  readonly policyRevision: 1;
  readonly assurance: 'deterministic_rules_with_heuristic_fact_detection';
}
export interface CompanionPreviewOutputCheckInput {
  readonly surface: 'companion_preview';
  readonly slot: 'summary' | 'sample_1' | 'sample_2' | 'sample_3';
  readonly channel: 'web' | 'discord';
  readonly companionId: string;
  readonly dimensions: CompanionDimensions;
  readonly text: string;
  readonly sources: readonly GroundedOutputSource[];
  readonly claims: readonly GroundedOutputClaim[];
}
export interface FirstLetterOutputCheckInput {
  readonly surface: 'first_letter'; readonly channel: 'web' | 'discord';
  readonly companionId: string; readonly dimensions: CompanionDimensions; readonly text: string;
  readonly sources: readonly GroundedOutputSource[]; readonly claims: readonly GroundedOutputClaim[];
  readonly letter: Readonly<{ name: string; sealChar: string; date: string;
    emotionLanguage: 'zh' | 'en' | 'either' | null; enabledExperts: readonly ExpertKey[] }>;
}
interface ForbiddenDefinition {
  readonly id: string; readonly category: 'expression' | 'sales' | 'ui';
  readonly pattern: string; readonly surfaces: readonly CompanionOutputSurface[];
}
const allSurfaces = Object.freeze(['companion_preview', 'first_letter', 'conversation', 'outbound', 'proactive', 'paid_suggestion', 'mode_card', 'ui'] as const);
const salesSurfaces = Object.freeze(['first_letter', 'proactive', 'paid_suggestion', 'mode_card', 'ui'] as const);
const uiSurfaces = Object.freeze(['ui'] as const);
/** One configuration, with the applicability boundaries from 02 §3.3, 06 §9 and 08 §9.3. */
export const COMPANION_OUTPUT_FORBIDDEN_CONFIG: readonly ForbiddenDefinition[] = Object.freeze([
  { id: 'expression_address', category: 'expression', pattern: '(?:^|[，,。！？!?\\s])(?:亲|宝)(?=$|[，,。！？!?])|宝子|家人们', surfaces: allSurfaces },
  { id: 'expression_cheerleading', category: 'expression', pattern: '冲鸭|加油哦|相信自己你是最棒的', surfaces: allSurfaces },
  { id: 'expression_promises', category: 'expression', pattern: '稳了|保\\s*offer|包过', surfaces: allSurfaces },
  { id: 'expression_pressure', category: 'expression', pattern: '限时|名额有限|最后机会|别人都已经|你再不[^。！？\\n]{0,80}就来不及了', surfaces: allSurfaces },
  { id: 'sales_pressure', category: 'sales', pattern: '名额只剩|(?:仅剩|最后)\\s*(?:[0-9]+|[一二三四五六七八九十百千万两]+|N)\\s*个|错过就没|再不[^。！？\\n]{0,80}就|同届都|报了课的都', surfaces: salesSurfaces },
  { id: 'sales_promises', category: 'sales', pattern: '包内推|稳过|必考|一定会考|上岸率|保证拿|内推保证', surfaces: salesSurfaces },
  { id: 'ui_competition', category: 'ui', pattern: '打卡|连胜|\\bstreak\\b|积分|等级|排名|打败了|超过了\\s*(?:[0-9]+|x)\\s*%\\s*的用户|完成率', surfaces: uiSurfaces },
  { id: 'ui_failure_label', category: 'ui', pattern: '\\bRejected\\b|拒绝率|淘汰|失败', surfaces: uiSurfaces },
  { id: 'ui_decoration', category: 'ui', pattern: '我们想你了|你已经\\s*(?:[0-9]+|x)\\s*天没|智能|赋能|一站式|黑科技|Openfield|THINKING\\s+PARTNER', surfaces: uiSurfaces },
  { id: 'ui_punctuation', category: 'ui', pattern: '[!！]{2,}', surfaces: uiSurfaces },
].map(item => Object.freeze(item as ForbiddenDefinition)));

const surfaces = new Set<string>(allSurfaces);
const MAX_TEXT_BYTES = 16 * 1024;
function invalid(): never { throw new Error('OUTPUT_CHECK_INVALID_INPUT'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value), length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string'
      || /^(0|[1-9][0-9]*)$/.exec(key)?.[0] !== key || Number(key) >= length))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) { const entry = descriptors[index]; if (!entry?.enumerable) invalid(); result.push(entry.value); }
  return result;
}
function text(value: unknown, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_BYTES
    || new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES
    || /[\ud800-\udfff]|\p{Cf}/u.test(value)
    || /\p{Cc}/u.test(multiline ? value.replace(/\n/g, '') : value)) invalid();
  return value;
}
function ref(value: unknown): string {
  const result = text(value); if (result.length > 300 || result !== result.trim()) invalid(); return result;
}
function dimensionSnapshot(value: unknown): Readonly<CompanionDimensions> {
  const data = record(value, ['warmth', 'directness', 'drive', 'structure', 'levity', 'code_mix', 'length']);
  for (const key of ['warmth', 'directness', 'drive', 'structure', 'levity', 'code_mix']) {
    if (![-1, 0, 1].includes(data[key] as number) || Object.is(data[key], -0)) invalid();
  }
  if (!['short', 'medium', 'long'].includes(data.length as string)) invalid();
  return Object.freeze(data as unknown as CompanionDimensions);
}
function result(status: CompanionOutputCheckResult['status'], rules: readonly CompanionOutputRule[]): CompanionOutputCheckResult {
  return Object.freeze({ status, rules: Object.freeze([...new Set(rules)]), policyRevision: 1,
    assurance: 'deterministic_rules_with_heuristic_fact_detection' });
}
function forbidden(raw: string, surface: CompanionOutputSurface): readonly string[] {
  const normalized = raw.normalize('NFKC');
  return Object.freeze(COMPANION_OUTPUT_FORBIDDEN_CONFIG.filter(rule => rule.surfaces.includes(surface)
    && new RegExp(rule.pattern, 'iu').test(normalized)).map(rule => rule.id));
}
/** Configuration matching only; it is not an output-approval result. */
export function companionOutputForbiddenRules(value: { text: string; surface: CompanionOutputSurface }): readonly string[] {
  try {
    const data = record(value, ['text', 'surface']);
    if (typeof data.surface !== 'string' || !surfaces.has(data.surface)) invalid();
    return forbidden(text(data.text, true), data.surface as CompanionOutputSurface);
  } catch { throw new Error('OUTPUT_CHECK_INVALID_INPUT'); }
}

export type OutputSourceKind = 'user_message' | 'profile' | 'confirmed_memory' | 'project_facts' | 'confirmed_story'
  | 'active_resume' | 'tool_result' | 'immigration_fact';
export interface GroundedOutputSource { readonly ref: string; readonly kind: OutputSourceKind; readonly revision: number; readonly text: string; }
export type OutputClaimKind = 'user_fact' | 'number' | 'date' | 'organization' | 'role' | 'immigration_fact' | 'sponsorship_quote' | 'execution_fact';
export interface GroundedOutputClaim { readonly start: number; readonly end: number; readonly kind: OutputClaimKind; readonly sourceRefs: readonly string[]; }
export interface OutputGroundingInput { readonly text: string; readonly surface: 'conversation' | 'outbound' | 'companion_preview' | 'first_letter'; readonly sources: readonly GroundedOutputSource[]; readonly claims: readonly GroundedOutputClaim[]; }
export interface OutputGroundingResult {
  readonly status: 'matched_spans' | 'unmatched_spans';
  readonly failures: readonly Readonly<{ claimIndex: number; rule: 'invalid_input' | 'source_missing' | 'source_kind' | 'source_text_mismatch' }>[];
  readonly assurance: 'caller_spans_and_exact_source_text_only';
  readonly sourceAuthority: 'not_established_by_this_function';
  readonly semanticCoverage: 'not_established_by_this_function';
}
const sourceKinds: readonly OutputSourceKind[] = ['user_message', 'profile', 'confirmed_memory', 'project_facts', 'confirmed_story', 'active_resume', 'tool_result', 'immigration_fact'];
const claimKinds: readonly OutputClaimKind[] = ['user_fact', 'number', 'date', 'organization', 'role', 'immigration_fact', 'sponsorship_quote', 'execution_fact'];
const ownedFactSources = new Set<OutputSourceKind>(['profile', 'confirmed_memory', 'project_facts', 'confirmed_story', 'active_resume']);
function sourcesSnapshot(value: unknown): readonly GroundedOutputSource[] {
  const sources = array(value, 100).map(value => {
    const data = record(value, ['ref', 'kind', 'revision', 'text']);
    if (!sourceKinds.includes(data.kind as OutputSourceKind) || !Number.isSafeInteger(data.revision) || (data.revision as number) < 1) invalid();
    return Object.freeze({ ref: ref(data.ref), kind: data.kind as OutputSourceKind, revision: data.revision as number, text: text(data.text, true) });
  });
  if (new Set(sources.map(source => source.ref)).size !== sources.length) invalid();
  return Object.freeze(sources);
}
function claimsSnapshot(value: unknown, raw: string): readonly GroundedOutputClaim[] {
  return Object.freeze(array(value, 100).map(value => {
    const data = record(value, ['start', 'end', 'kind', 'sourceRefs']);
    if (!Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.end) || (data.start as number) < 0
      || (data.end as number) <= (data.start as number) || (data.end as number) > raw.length || !claimKinds.includes(data.kind as OutputClaimKind)) invalid();
    const start = data.start as number, end = data.end as number;
    if (/[\ud800-\udfff]/u.test(raw.slice(start, end))) invalid();
    const sourceRefs = Object.freeze(array(data.sourceRefs, 20).map(ref));
    if (!sourceRefs.length || new Set(sourceRefs).size !== sourceRefs.length) invalid();
    return Object.freeze({ start, end, kind: data.kind as OutputClaimKind, sourceRefs });
  }));
}
function matchingExactSpan(source: string, span: string, numeric: boolean): boolean {
  let offset = source.indexOf(span);
  while (offset !== -1) {
    const before = source[offset - 1] ?? '', after = source[offset + span.length] ?? '';
    if (!numeric || !/\p{N}/u.test(before) && !/\p{N}/u.test(after)
      && !(before === '.' && /\p{N}/u.test(source[offset - 2] ?? ''))
      && !(after === '.' && /\p{N}/u.test(source[offset + span.length + 1] ?? ''))) return true;
    offset = source.indexOf(span, offset + 1);
  }
  return false;
}
/**
 * Verifies caller-specified spans against exact source text. It does not discover
 * omitted facts or establish source ownership, confirmation, professional review,
 * current-turn eligibility, or execution authority. Model-provided refs are data.
 */
export function checkGroundedOutputClaims(value: OutputGroundingInput): OutputGroundingResult {
  const finish = (failures: OutputGroundingResult['failures']): OutputGroundingResult => Object.freeze({
    status: failures.length ? 'unmatched_spans' : 'matched_spans', failures: Object.freeze(failures.map(item => Object.freeze(item))),
    assurance: 'caller_spans_and_exact_source_text_only', sourceAuthority: 'not_established_by_this_function', semanticCoverage: 'not_established_by_this_function',
  });
  try {
    const data = record(value, ['text', 'surface', 'sources', 'claims']), raw = text(data.text, true);
    if (!['conversation', 'outbound', 'companion_preview', 'first_letter'].includes(data.surface as string)) invalid();
    const sources = sourcesSnapshot(data.sources), claims = claimsSnapshot(data.claims, raw), failures: OutputGroundingResult['failures'][number][] = [];
    for (const [claimIndex, claim] of claims.entries()) {
      const span = raw.slice(claim.start, claim.end);
      for (const sourceRef of claim.sourceRefs) {
        const source = sources.find(source => source.ref === sourceRef);
        if (!source) { failures.push({ claimIndex, rule: 'source_missing' }); continue; }
        if (claim.kind === 'immigration_fact' && !['immigration_fact', 'user_message'].includes(source.kind)
          || claim.kind === 'sponsorship_quote' && source.kind !== 'tool_result'
          || claim.kind === 'execution_fact' && source.kind !== 'tool_result'
          || (data.surface === 'outbound' || data.surface === 'first_letter') && !ownedFactSources.has(source.kind)) {
          failures.push({ claimIndex, rule: 'source_kind' }); continue;
        }
        if (!matchingExactSpan(source.text, span, claim.kind === 'number' || claim.kind === 'date')) failures.push({ claimIndex, rule: 'source_text_mismatch' });
      }
    }
    return finish(failures);
  } catch { return finish([{ claimIndex: -1, rule: 'invalid_input' }]); }
}

const providers = /\b(?:openai|anthropic|claude|chatgpt|gpt(?:[-\s]?\d[\w.-]*)?|gemini|deepseek|qwen|mistral|llama|cohere|ollama|sonnet|haiku|opus|o[134](?:[-\w]*)?)\b|通义千问|智谱|豆包|腾讯混元|月之暗面/iu;
const immigration = /\b(?:OPT|STEM\s*OPT|H[-\s]?1B|CPT|I[-\s]?20|I[-\s]?983|EAD|SEVIS|USCIS|DSO|visa|citizenship|sponsorship|work\s+authorization|grace\s+period)\b|签证|身份(?:资格|政策|期限|天数)|工作授权|待业|宽限期|移民|工卡|抽签/iu;
const paid = /[$￥¥€£]|美元|人民币|付费|收费|价格|折扣|购买|会员|套餐|蔓藤|导师|内推|保录|\b(?:paid|pricing|price|purchase|subscription|tuition|discount|mentor|referral)\b/iu;
const numeric = /\p{N}|(?:[零〇一二三四五六七八九十百千万亿两]+)(?:年|月|日|天|周|份|封|道题|分钟|小时|美元|元|分)|[零〇二三四五六七八九十百千万亿两]+(?:个|件|次|条)|[一二三四五六七八九十]+(?:成|倍|%|％)/u;
const humanIdentity = /(?:我是|我也是|我其实是|作为)(?:一个|一名)?(?:真人|人类|人类导师|你的家人)|我不是\s*(?:AI|人工智能)|我(?:曾经|以前|当年|之前|毕业|读大学|上大学|在学校|实习过|工作过|帮过|带过|面过|经历过|求职过)|(?:我|我的)[^。！？;；\n]{0,30}(?:学历|学位|大学经历|实习经历|工作经历|当年求职)|\b(?:I\s*(?:am|'m)\s+(?:a\s+)?(?:real\s+person|human)|I\s*(?:am|'m)\s+not\s+(?:an?\s+)?AI|as\s+a\s+human|I\s+(?:graduated|studied|worked|interned|attended|remember\s+when))\b/iu;
const outcomePromise = /(?:保证|包|保|一定|肯定|必定|必然)(?:你|能|会|拿到|获得|通过|得到|进|帮你|为你){0,5}(?:offer|录取|面试|内推|上岸|过关|成功)|包内推|稳过|一定会考|必考|\b(?:guarantee(?:d)?\s+(?:an?\s+|your\s+)?(?:offer|job|interview|admission|success)|you\s+will\s+(?:definitely\s+)?(?:get|land)\s+(?:an?\s+)?(?:offer|job))\b/iu;
const dependency = /我永远在|只有我(?:懂|理解)|你只需要我|不用再找别人|离不开我|做你的(?:家人|伴侣|男朋友|女朋友)|\b(?:only\s+I\s+understand|you\s+only\s+need\s+me|I\s+will\s+always\s+be\s+here)\b/iu;
const userFact = /(?:你|您)(?:的)?[^。！？;；\n]{0,24}(?:已经|曾经|曾在|做过|拥有|毕业|就读|任职|实习|参加过|获得|得到|拿到了|投了|投过|申请了|收到了|收到过|完成了|积累了|工作经验|学历|绩点|年薪|薪资|获奖|擅长|目前(?:是|在|有))|你有|你(?:其实|本来|一直)?(?:很|非常)(?:优秀|努力|厉害|聪明|胆小|紧张|焦虑|自信)|\b(?:you|your)\b[^.!?;\n]{0,80}\b(?:have|had|earned|graduated|studied|worked|interned|joined|applied|received|completed|won|salary|gpa|degree|employed)\b/iu;
const execution = /(?:已经|刚刚|已|替你|帮你)[^。！？;；\n]{0,16}(?:发送|发出|提交|申请|投递|付款|注册|登录|记住|保存|签名|签好|写好|改好|安排好|预订)|我(?:给你|替你|帮你)?(?:写了|改了|提交了|发送了|核对过|投递过|提交过|保存过|记住了)|\b(?:I|we)\s+(?:(?:have|already|just)\s+)*(?:sent|submitted|applied|paid|registered|logged\s+in|saved|remembered|signed)\b/iu;
const roleImpersonation = /(?:^|\n)\s*(?:规划师|前辈|导师|面试官|人脉官|投递官|技能教练|前|投|面|规|教|脉)\s*[:：]|我是(?:蔓藤导师|规划师|前辈|面试官|人脉官|投递官|技能教练)/u;
const englishOrdinaryCapitals = new Set(['AI', 'STAR', 'ATS', 'JD', 'I', 'We', 'You', 'Your', 'Let', 'Lets', 'First', 'Next', 'This', 'That', 'The', 'A', 'An', 'Need', 'Want', 'When', 'If', 'It', 'Start', 'Keep', 'Take', 'Before', 'After', 'Try', 'Also', 'And', 'But', 'For', 'Do', 'Make', 'There', 'Here', 'Check', 'Plan', 'No']);
// Vocabulary, not a company whitelist. Unrecognized Latin identifiers in Chinese copy require a source.
const mixedLanguageVocabulary = new Set(['ai', 'star', 'ats', 'jd', 'draft', 'bullet', 'behavioral', 'story', 'resume', 'feedback', 'evidence', 'next', 'step', 'job', 'interview', 'project']);
function unknownEntity(raw: string): boolean {
  if (/[\p{Script=Han}]{2,20}(?:公司|科技|集团|大学|学院|银行|研究院|实验室|工作室)/u.test(raw)
    || /(?:在|来自|去了|就读于|任职于|毕业于|加入)[\p{Script=Han}A-Za-z]{2,20}(?:工作|实习|读书|任职)/u.test(raw)
    || /\b(?:named|called|employed\s+at|work(?:ed)?\s+(?:at|for)|studied\s+at)\s+[A-Za-z][\w'-]*/iu.test(raw)) return true;
  if (/\p{Script=Han}/u.test(raw) && [...raw.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*/g)]
    .some(match => !mixedLanguageVocabulary.has(match[0].toLowerCase()))) return true;
  return [...raw.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*\b/g)].some(match => !englishOrdinaryCapitals.has(match[0]));
}
function personalityConflict(raw: string, d: CompanionDimensions): boolean {
  return d.warmth < 0 && /热情外露|热烈表达|特别热情|非常热情/u.test(raw)
    || d.warmth > 0 && /情绪表达克制|冷淡|不表达感受/u.test(raw)
    || d.directness < 0 && /先(?:说|给)结论|直接给结论/u.test(raw)
    || d.directness > 0 && /不(?:说|给)结论|绕着说/u.test(raw)
    || d.drive < 0 && /盯(?:着)?进度|催(?:你|着你)|紧盯进度/u.test(raw)
    || d.levity < 0 && /(?:爱|喜欢|会|常常)开玩笑|爱打比方/u.test(raw)
    || d.code_mix < 0 && /\b(?:draft|bullet|behavioral|story|next\s+step)\b/iu.test(raw);
}
function recognizedNonfactualClause(clause: string, slot: CompanionPreviewOutputCheckInput['slot']): boolean {
  // Deliberately heuristic categories, not a semantic certificate or a sentence allowlist.
  if (/^我是\s*(?:AI|人工智能)(?:\s*求职(?:主理人|助理))?$/iu.test(clause)
    || /^I\s*(?:am|'m)\s+(?:an?\s+)?AI(?:\s+(?:career\s+)?(?:assistant|companion))?$/iu.test(clause)) return true;
  if (/[?？]$/.test(clause)) return true;
  if (/^(?:需要时|想(?:继续|停|缓|休息|再看)|如果|当|要是|在你|你想|你不想|不用|不必|可以|不妨|要不要|愿意的话|现在不做)/u.test(clause)
    || /^你(?:确认|同意|愿意|准备好)(?:之后|以后|后|时|了再)/u.test(clause) || /(?:时候|时|的话)$/.test(clause)) return true;
  if (/^(?:(?:我|我们|它)(?:会|愿意|可以|通常|习惯|倾向于)?|先|再|把|给你|等你|和你|一起|需要时|长回复|轻轻|也|愿意|接着|然后|最后)?(?:多|稍微|慢慢)?(?:先|再|把|给|等|看|核对|整理|理清|理顺|说清|写清|解释|分开|拆|选|提|帮|陪|确认|留|接住|决定|讨论|展开|停)/u.test(clause)) return true;
  if (/^(?:下一步|材料|简历|依据|事实|要点|草稿|结论|内容|思路|事情|问题|行动)[^。！？]{0,80}(?:可选|先放|核对|待核对|能支持|说清|写清|理清|整理|确认|讨论|再看)/u.test(clause)) return true;
  if (slot === 'summary' && /(?:说话|语气|表达|话不多|话少|温和|温柔|平实|平稳|克制|直接|简明|清楚|清晰|轻松|给空间|留出口|稳重|谨慎|耐心|务实|平和|从容|冷静|有条理|不催促)/u.test(clause)) return true;
  return /^(?:let'?s|we\s+(?:can|will)|I\s+(?:can|will)|you\s+can|first|next|if|when|start|check|keep|take|try|before|after|no\s+need)\b/iu.test(clause)
    || slot === 'summary' && /\b(?:tone|speaks?|speaking|warm|gentle|calm|clear|direct|patient|practical|structured|concise)\b/iu.test(clause);
}

/**
 * 02 §§3.3–3.4: shared preview/first-letter rule entry. Preview has no user
 * facts or paid permission; first letters require independent semantic review.
 * A passed_rules result is NOT a proof that arbitrary natural language contains no
 * facts. Detectors and clause classification are heuristic; unmatched statements
 * require review. Provider completion, owned source eligibility, safety state,
 * semantic quality, authorization and persistence remain server responsibilities.
 */
export function checkCompanionOutput(value: CompanionPreviewOutputCheckInput | FirstLetterOutputCheckInput | unknown): CompanionOutputCheckResult {
  try {
    const data = record(value, ['surface', 'text'], ['slot', 'channel', 'companionId', 'dimensions', 'sources', 'claims', 'letter']);
    if (data.surface === 'first_letter') return checkFirstLetterOutput(value);
    if (data.surface !== 'companion_preview') return result('blocked', ['unsupported_context']);
    record(value, ['surface', 'text', 'slot', 'channel', 'companionId', 'dimensions', 'sources', 'claims']);
    if (!['summary', 'sample_1', 'sample_2', 'sample_3'].includes(data.slot as string)
      || !['web', 'discord'].includes(data.channel as string) || typeof data.companionId !== 'string'
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(data.companionId)?.[0] !== data.companionId) invalid();
    const d = dimensionSnapshot(data.dimensions), sourceData = sourcesSnapshot(data.sources);
    const raw = text(data.text, true), normalized = raw.normalize('NFKC'), claimData = claimsSnapshot(data.claims, raw), rules: CompanionOutputRule[] = [];
    if (sourceData.length || claimData.length) return result('blocked', ['unsupported_context']);
    if (raw.includes('\n') || /[\u2028\u2029]/u.test(raw) || data.channel === 'discord' && raw.length > 2000
      || /[!！]{2,}|[~～]|[<>`]|https?:\/\/|\p{Extended_Pictographic}/u.test(raw)) rules.push('channel_limit');
    if (forbidden(normalized, 'companion_preview').length) rules.push('forbidden_expression');
    if (outcomePromise.test(normalized)) rules.push('outcome_promise');
    if (humanIdentity.test(normalized) || dependency.test(normalized) || roleImpersonation.test(normalized)) rules.push('identity_claim');
    if (providers.test(normalized)) rules.push('provider_disclosure');
    if (paid.test(normalized)) rules.push('paid_without_authorization');
    if (numeric.test(normalized)) rules.push('unverified_numeric');
    if (immigration.test(normalized)) rules.push('immigration_fact');
    if (userFact.test(normalized)) rules.push('unverified_user_fact');
    if (execution.test(normalized)) rules.push('unverified_execution');
    if (unknownEntity(normalized)) rules.push('unverified_entity');
    if (personalityConflict(normalized, d)) rules.push('personality_conflict');
    if (rules.length) return result('blocked', rules);
    const clauses = normalized.split(/(?<=[?？])|[，,。.!！；;：:\n]/u).map(clause => clause.trim()).filter(Boolean);
    if (!clauses.length || clauses.some(clause => !recognizedNonfactualClause(clause, data.slot as CompanionPreviewOutputCheckInput['slot']))) {
      return result('requires_review', ['semantic_review_required']);
    }
    return result('passed_rules', []);
  } catch { return result('blocked', ['invalid_input']); }
}


// First-letter clauses are checked as a whole before publication. These are
// coverage detectors, not a static letter template or semantic equivalence proof.
const letterCoverage = Object.freeze({
 identity: [/(?:我是|我是一名|我作为)[^。！？\n]{0,12}(?:AI|人工智能)|\bI(?: am|'m) (?:an? )?AI\b/iu,
  /(?:这?个?名字|我的名字|这个称呼)[^。！？\n]{0,12}(?:你起|你取|你选)|你(?:给我|为我)(?:起|取)(?:了|的)?(?:这个)?名字|\byou (?:chose|picked|gave me) (?:my |this |the )?name\b/iu],
 memory: [/(?:只|只有)[^。！？\n]{0,20}(?:你(?:同意|点头|允许)|征得你同意)[^。！？\n]{0,20}(?:记|保存)|(?:只记|只会记)[^。！？\n]{0,20}你(?:同意|允许)|\b(?:remember|save|store)\b[^.!?\n]{0,40}\bonly\b[^.!?\n]{0,25}\b(?:consent|agree|approve|permission)\b/iu,
  /它记得的你|what (?:I|it) remember(?:s)? about you/iu,
  /查看|看见|看到|\b(?:view|see|review)\b/iu,/修改|更改|编辑|\b(?:edit|change|update)\b/iu,
  /删除|删掉|可删|可以删|能删|\b(?:delete|remove)\b/iu],
 external: [/(?:消息|邮件)[^。！？\n]{0,15}材料[^。！？\n]{0,25}待确认|(?:messages|emails)[^.!?\n]{0,15}materials[^.!?\n]{0,45}(?:pending (?:your )?(?:review|confirmation)|await (?:your )?(?:review|confirmation))/iu,
  /(?:表单|字段)[^。！？\n]{0,50}(?:对话|聊天)[^。！？\n]{0,20}(?:逐项|每一项)[^。！？\n]{0,12}(?:确认|授权)|form[^.!?\n]{0,45}(?:each|per.field|field.by.field)[^.!?\n]{0,30}(?:chat|conversation)/iu,
  /最终提交[^。！？\n]{0,20}你本人|(?:final submission|final submit)[^.!?\n]{0,25}(?:you|yourself)|you[^.!?\n]{0,20}(?:final submission|final submit)/iu],
 today: [/今天[^。！？\n]{0,15}(?:三件事|三件小事)|today[^.!?\n]{0,15}(?:three|3) (?:things|tasks)/iu],
 followup: [/(?:接下来|下一步|之后|随后)[^。！？\n]{0,45}(?:了解|问问|聊聊|告诉我)|\bnext\b[^.!?\n]{0,70}\b(?:learn|ask|tell|understand|discuss)\b/iu]
});
const letterExpertPatterns: Readonly<Record<ExpertKey,RegExp>> = Object.freeze({
 guide:/前辈|(?:^|[，,、；;：:\s])前(?=帮|来|负责|陪)|\b(?:career guide|senior peer)\b/iu,
 applier:/投递官|(?:^|[，,、；;：:\s])投(?=帮|来|负责|陪)|\b(?:application specialist|application agent)\b/iu,
 interviewer:/面试官|(?:^|[，,、；;：:\s])面(?=帮|来|负责|陪)|\binterviewer\b/iu,
 planner:/规划师|\bcareer planner\b/iu,
 coach:/技能教练|\bskills? coach\b/iu,
 networker:/人脉官|\bnetworking (?:specialist|agent)\b/iu
});
function checkFirstLetterOutput(value: unknown): CompanionOutputCheckResult {
 try {
  const r=record(value,['surface','channel','companionId','dimensions','text','sources','claims','letter']);
  if(!['web','discord'].includes(r.channel as string)||typeof r.companionId!=='string'
   ||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(r.companionId)?.[0]!==r.companionId)invalid();
  const d=dimensionSnapshot(r.dimensions),raw=text(r.text,true),normalized=raw.normalize('NFKC');
  const sources=sourcesSnapshot(r.sources),claims=claimsSnapshot(r.claims,raw);
  const letter=record(r.letter,['name','sealChar','date','emotionLanguage','enabledExperts']);
  const name=text(letter.name),seal=text(letter.sealChar),date=text(letter.date);
  if([...name].length>40||!/^\p{Script=Han}$/u.test(seal)
   ||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
   ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date
   ||![null,'zh','en','either'].includes(letter.emotionLanguage as never))invalid();
  const keys=array(letter.enabledExperts,6);
  if(keys.some(k=>!EXPERT_KEYS.includes(k as ExpertKey))||new Set(keys).size!==keys.length)invalid();
  enabledExpertRoster(keys as ExpertKey[]);
  if(sources.some(s=>!['profile','confirmed_memory'].includes(s.kind))
   ||claims.some(c=>c.kind!=='user_fact'||c.sourceRefs.length!==1))invalid();
  const hard:CompanionOutputRule[]=[],review:CompanionOutputRule[]=[];
  const cited=new Set(claims.flatMap(c=>c.sourceRefs));
  if([...cited].some(ref=>!sources.some(s=>s.ref===ref))
   ||cited.size<Math.min(2,sources.length))hard.push('first_letter_facts_missing');
  if([...raw+'\n'+name+'\n'+date].length>350||r.channel==='discord'&&raw.length>2000
   ||/[!！]{2,}|[~～]|[<>]|https?:\/\/|\p{Extended_Pictographic}/u.test(raw))hard.push('channel_limit');
  if(forbidden(normalized,'first_letter').length)hard.push('forbidden_expression');
  if(outcomePromise.test(normalized))hard.push('outcome_promise');
  if(humanIdentity.test(normalized)||dependency.test(normalized)||roleImpersonation.test(normalized))hard.push('identity_claim');
  if(providers.test(normalized))hard.push('provider_disclosure');
  if(paid.test(normalized))hard.push('paid_without_authorization');
  if(immigration.test(normalized))hard.push('immigration_fact');
  // Preview forbids even unverified help/execution phrases; letters must be
  // able to introduce an expert's future help. Only completed-action claims
  // use this detector; the full promise/permission meaning remains in review.
  if(/(?:已经|刚刚|已)[^。！？;；\n]{0,20}(?:发送|发出|提交|申请|投递|付款|注册|登录|记住|保存|签名|签好|写好|改好|安排好|预订)|我(?:给你|替你|帮你)?(?:写了|改了|提交了|发送了|核对过|投递过|保存过|记住了)|\b(?:I|we)\s+(?:(?:have|already|just)\s+)*(?:sent|submitted|applied|paid|registered|logged\s+in|saved|remembered|signed)\b/iu.test(normalized))hard.push('unverified_execution');
  if(personalityConflict(normalized,d))hard.push('personality_conflict');
  for(const [key,rule] of [
   ['identity','first_letter_identity_missing'],['memory','first_letter_memory_missing'],
   ['external','first_letter_external_rule_missing'],['today','first_letter_today_missing']
  ] as const)if(!letterCoverage[key].every(pattern=>pattern.test(normalized)))hard.push(rule);
  if(sources.length<2&&!letterCoverage.followup.every(pattern=>pattern.test(normalized)))hard.push('first_letter_followup_missing');
  for(const key of EXPERT_KEYS){
   if(letterExpertPatterns[key].test(normalized)!==keys.includes(key))hard.push('first_letter_team_mismatch');
  }
  // Script coverage catches an entirely wrong language, not bilingual quality.
  // Chinese UI labels and the saved name must not reject an otherwise English letter.
  const languageText=normalized.replaceAll(name.normalize('NFKC'),'').replaceAll('它记得的你','');
  if((letter.emotionLanguage==='zh'||letter.emotionLanguage===null)&&!/[\p{Script=Han}]/u.test(languageText)
   ||letter.emotionLanguage==='en'&&!/\b[A-Za-z]{3,}\b/u.test(languageText))hard.push('first_letter_language_mismatch');
  const grounding=checkGroundedOutputClaims({text:raw,surface:'first_letter',sources,claims});
  if(grounding.status!=='matched_spans')review.push('unverified_user_fact');
  let remainder=raw;
  if(grounding.status==='matched_spans')for(const claim of [...claims].sort((a,b)=>b.start-a.start))
    remainder=remainder.slice(0,claim.start)+' '.repeat(claim.end-claim.start)+remainder.slice(claim.end);
  remainder=remainder.normalize('NFKC');
  if(userFact.test(remainder))review.push('unverified_user_fact');
  if(/(?:你|您|\byou(?:r)?\b)[^。！？.!?;；\n]{0,70}\p{N}/iu.test(remainder))review.push('unverified_numeric');
  if(unknownEntity(remainder))review.push('unverified_entity');
  // Exact spans cannot certify the surrounding proposition, omitted claims,
  // paraphrases, negation, expert availability or tone. No semantic permit is
  // accepted from the model/caller. A real independent review stage is still
  // needed; this surface intentionally never returns passed_rules by regex alone.
  review.push('semantic_review_required');
  return hard.length?result('blocked',[...hard,...review]):result('requires_review',review);
 }catch{return result('blocked',['invalid_input']);}
}
