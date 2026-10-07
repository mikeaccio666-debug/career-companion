import type { CompanionDimensions } from './mapping.ts';

export type CompanionInkToken = 'yanzhi' | 'zheshi' | 'ganlan' | 'jiangzi' | 'dai' | 'yanzi' | 'hehui';
export interface CompanionQuirks {
  readonly metaphorSource: 'chess' | 'hiking' | 'cooking' | 'sailing' | 'running' | 'gardening' | 'weather' | 'coding' | null;
  readonly openingStyle: 'reflect' | 'conclusion' | 'clarify';
  readonly signOff: 'name' | 'name_and_time' | 'dash_name';
  readonly catchphrase: string | null;
}
export interface FallbackCompanionStyle {
  readonly generatedBy: 'fallback'; readonly generatorVersion: 1; readonly summary: string;
  readonly samples: readonly [string, string, string]; readonly styleCard: string;
  readonly quirks: CompanionQuirks; readonly inkToken: CompanionInkToken;
}
export class CompanionStyleError extends Error {
  readonly code = 'COMPANION_STYLE_INVALID_INPUT';
  constructor() { super('The companion style could not be prepared.'); this.name = 'CompanionStyleError'; }
}
function invalid(): never { throw new CompanionStyleError(); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key)) || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
  return Object.fromEntries([...keys, ...optional.filter(key => Object.hasOwn(descriptors, key))].map(key => [key, descriptors[key].value]));
}
const seed = (value: string) => { let number = 2166136261; for (const char of value) number = Math.imul(number ^ char.charCodeAt(0), 16777619) >>> 0; return number; };
const warm: readonly CompanionInkToken[] = ['yanzhi', 'zheshi', 'ganlan', 'jiangzi'], cold: readonly CompanionInkToken[] = ['dai', 'yanzi', 'hehui'];
const metaphors = ['chess', 'hiking', 'cooking', 'sailing', 'running', 'gardening', 'weather', 'coding'] as const;
const metaphorLabels: Record<typeof metaphors[number], string> = { chess: '下棋', hiking: '登山', cooking: '做饭', sailing: '航海', running: '跑步', gardening: '园艺', weather: '天气', coding: '写代码' };
/** 02 §§2.4–2.6: rule-based preview metadata, never a model response or permission to speak. */
export function compileFallbackCompanionStyle(input: { companionId: string; dimensions: CompanionDimensions; quirkDraw?: 0 | 1 }): FallbackCompanionStyle {
  const data = record(input, ['companionId', 'dimensions'], ['quirkDraw']);
  if (typeof data.companionId !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(data.companionId)?.[0] !== data.companionId) invalid();
  const values = record(data.dimensions, ['warmth', 'directness', 'drive', 'structure', 'levity', 'code_mix', 'length']);
  for (const key of ['warmth', 'directness', 'drive', 'structure', 'levity', 'code_mix']) if (![-1, 0, 1].includes(values[key] as number) || Object.is(values[key], -0)) invalid();
  if (!['short', 'medium', 'long'].includes(values.length as string)) invalid();
  const quirkDraw = Object.hasOwn(data, 'quirkDraw') ? data.quirkDraw : 0;
  if (quirkDraw !== 0 && quirkDraw !== 1 || Object.is(quirkDraw, -0)) invalid();
  const d = values as unknown as CompanionDimensions;
  // A trusted caller may request the single pre-preview dedup draw. Keep the
  // actual entity ID and legacy zero seed intact; ink never uses the new draw.
  const pick = <T>(key: string, pool: readonly T[]): T => pool[seed(`${data.companionId}:${key}`) % pool.length];
  const pickQuirk = <T>(key: string, pool: readonly T[]): T => quirkDraw === 0 ? pick(key, pool)
    : pool[seed(`${data.companionId}:${key}:draw:1`) % pool.length];
  const quirks: CompanionQuirks = Object.freeze({ metaphorSource: d.levity < 0 ? null : pickQuirk('metaphor', metaphors),
    openingStyle: d.directness > 0 ? 'conclusion' : d.directness < 0 ? pickQuirk('opening', ['reflect', 'clarify'] as const) : pickQuirk('opening', ['reflect', 'conclusion', 'clarify'] as const),
    signOff: pickQuirk('sign-off', ['name', 'name_and_time', 'dash_name'] as const), catchphrase: pickQuirk('catchphrase', [null, '先说结论', '先看这里']) });
  const tone = d.warmth < 0 ? '情绪表达克制' : d.warmth > 0 ? '说话温和，愿意多停一会儿' : '先接住感受，再理清事情';
  const direct = d.directness < 0 ? '先说材料能支持什么，再说缺口' : d.directness > 0 ? '先说结论，再给依据' : '把依据和待核对的地方并列';
  const drive = d.drive < 0 ? '给你空间，下一步是可选的' : d.drive > 0 ? '把下一步写清，等你确认再做' : '轻轻提一个下一步，也留出口';
  const summary = `${tone}；${direct}；${drive}。`;
  const first = d.warmth > 0 ? '不用急着把所有问题一次解决，我们先把眼前的事情理清。' : d.warmth < 0 ? '先看眼前的事情，再决定下一步。' : '可以先停一下，把现在要处理的事情说清。';
  const second = d.directness > 0 ? '先说结论：材料里的依据要先核对，再决定怎么写。' : d.directness < 0 ? '先看材料能支持什么，再一起补上还不能确认的地方。' : '材料能支持的和还待核对的地方，我们分开看。';
  const next = d.drive > 0 ? '想继续的话，把下一步写清；你确认之后再做。' : d.drive < 0 ? '下一步可以先放着，想继续时再选。' : '要不要先选一个小动作？现在不做也可以。';
  const third = d.code_mix > 0 ? `${next}需要时再看 draft。` : d.code_mix === 0 ? `${next}简历 bullet 的事实先核对。` : next;
  const structure = d.structure < 0 ? '用连贯短段落' : d.structure > 0 ? '用清单；数字和日期只来自已核实来源' : '用简明要点';
  const length = d.length === 'short' ? '回复短，通常一至四行' : d.length === 'long' ? '必要时展开，最多十行' : '回复适中，通常三至六行';
  const language = d.code_mix < 0 ? '情绪对话用中文' : d.code_mix > 0 ? '情绪对话可以自然中英混用' : '情绪对话只把专业术语写成英文';
  const metaphor = quirks.metaphorSource === null ? '不使用比喻或玩笑。' : `比喻取材${metaphorLabels[quirks.metaphorSource]}，每十条最多一次，只用于事情，不用于用户处境或拖延。`;
  const opening = { reflect: '先复述一句', conclusion: '先给结论', clarify: '先问一个确认问题' }[quirks.openingStyle];
  const signOff = { name: '只署当时的名字', name_and_time: '署当时的名字和真实时间', dash_name: '破折号加当时的名字' }[quirks.signOff];
  const phrase = quirks.catchphrase === null ? '不用固定口头习惯。' : `口头习惯「${quirks.catchphrase}」每十条最多一次，用户纠正立即停用。`;
  const styleCard = `${summary}${structure}；${length}；${language}。练习材料、简历和外联草稿一律英文。${metaphor}长回复才采用${opening}；落款仅在信件用${signOff}。${phrase}自称我，明确自己是AI；不承诺结果，不添加用户未提供的经历、数字或身份事实。对外材料先待确认，最终提交由本人操作；记忆只记用户同意的。危机时服从固定安全流程，停止比喻和玩笑。`;
  if (Array.from(styleCard).length > 600) invalid();
  const inkPool = d.warmth + d.levity > 0 ? warm : d.warmth + d.levity < 0 ? cold : [...warm, ...cold];
  return Object.freeze({ generatedBy: 'fallback', generatorVersion: 1, summary,
    samples: Object.freeze([first, second, third] as const), styleCard, quirks, inkToken: pick('ink', inkPool) });
}
