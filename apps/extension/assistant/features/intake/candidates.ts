import { createTranslator, resolveAssistantLocale, type MessageKey } from '../../i18n';
import { C } from '../../design/palette';
import { emptyCandidate } from '../../app/message-view';
import type { AssistantData, AssistantState, CandidateCard, ExtractHit, Phase, ProfileField } from '../../state/types';

const privateOptions: Partial<Record<ProfileField, MessageKey[]>> = {
  gender: ['女', '男', '非二元'], race: ['亚裔', '白人', '黑人或非裔', '西班牙裔或拉丁裔', '两种或以上'], disability: ['有', '没有'], veteran: ['是', '不是'],
};

export function buildCandidate(data: AssistantData, state: AssistantState, hits: ExtractHit[], id: string, group?: { index: number; total: number }): CandidateCard {
  const t = createTranslator(resolveAssistantLocale(state.locale));
  const phase = state.chat.phase;
  const byField = new Map(hits.map(hit => [hit.field, hit.value]));
  const declined = byField.has('decline');
  const fields = data.phases[phase].fields.map(key => {
    const meta = data.fieldMeta[key] ?? { label: key, group: '' };
    let value = byField.get(key) ?? '';
    let source = t("未提到"), srcBg = C.grey, srcColor = C.muted;
    if (byField.has(key)) { source = '来自你的描述'; srcBg = '#EEF1FB'; srcColor = C.ink2; }
    else if (meta.optional) { value = declined ? '不愿回答' : ''; source = value ? t("你的选择") : t("由你决定"); }
    else if (meta.self) { source = '需本人确认'; srcBg = C.peach; srcColor = '#8A5A2B'; }
    else if (state.profile[key]) { value = state.profile[key]; source = state.hasResume ? t("来自简历 / Portal") : t("来自 Portal"); }
    const isSelect = !!(meta.self || meta.optional);
    const options = meta.optional
      ? [{ v: '', t: t("未选择") }, { v: '不愿回答', t: t("不愿回答") }, ...(privateOptions[key] ?? []).map(v => ({ v, t: t("{v0}（示例选项）", { v0: t(v) }) }))]
      : key === 'workAuth'
        ? [{ v: '', t: t("未确认") }, { v: '有工作许可', t: t("有工作许可") }, { v: '无工作许可', t: t("无工作许可") }]
        : [{ v: '', t: t("未确认") }, { v: '不需要', t: t("不需要") }, { v: '需要', t: t("需要") }];
    if (isSelect && value && !options.some(option => option.v === value)) {
      // Only normalize explicit source text. No answer is inferred from other fields.
      if (key === 'sponsorship' && /不需要签证支持|需要签证支持/.test(value)) value = value.startsWith('不需要') ? '不需要' : '需要';
      else if (key === 'workAuth' && /有美国工作许可|有工作许可/.test(value)) value = '有工作许可';
      else if (key === 'workAuth' && /没有工作许可|无工作许可/.test(value)) value = '无工作许可';
      else value = '';
    }
    return { key, label: meta.label, value, source, srcBg, srcColor, placeholder: t("未提到 · 可补充"), isInput: !isSelect, isSelect, options, fromHit: byField.has(key) || !!(meta.optional && declined) };
  });
  const role = fields.find(field => field.key === 'role')?.value || t("目标岗位");
  return {
    ...emptyCandidate(), phase, fields, editable: true, readOnly: false, targetId: phase === 1 ? `target-${id}` : null,
    eyebrow: phase === 1 ? group ? `TARGET ${group.index} / ${group.total}` : t("TARGET · 目标岗位") : t("CANDIDATE · 第 {v0} 组", { v0: phase + 1 }),
    title: phase === 1 ? t("「{v0}」的工作与偏好", { v0: role }) : t("请核对这组{v0}", { v0: data.phases[phase].short }), badge: t("候选 · 未保存"), badgeBg: C.lilac, badgeColor: C.ink2, confirmLabel: t("确认这组资料"),
    note: phase === 1 ? t("工作许可与签证支持不会由 AI 推断，请你亲自确认或暂时留空。确认不等于允许所有网站自动填写这些答案。")
      : phase === 2 ? t("这些选择只会在你确认后保存；不会推断，也不代表对所有岗位的统一授权。")
        : t("来自简历或 Portal 的内容已预填；你可以直接修改。确认后写入你的求职资料。"),
  };
}

export function candidateValues(card: CandidateCard): Partial<Record<ProfileField, string>> {
  return Object.fromEntries(card.fields.map(field => [field.key, field.value]));
}

export function applyConfirmedCandidate(state: AssistantState, card: CandidateCard, messageId: string): AssistantState {
  const t = createTranslator(resolveAssistantLocale(state.locale));
  const values = candidateValues(card);
  const savedCount = Object.values(values).filter(Boolean).length;
  const saved = { ...card, editable: false, readOnly: true, busy: false, notice: false, badge: t("已保存 · {v0} 项", { v0: savedCount }), badgeBg: C.mint, badgeColor: C.green, eyebrow: card.phase === 1 ? t("SAVED · 目标岗位") : t("SAVED · 第 {v0} 组", { v0: card.phase + 1 }) };
  const chat = { ...state.chat, stage: 'idle' as const, messages: state.chat.messages.map(message => message.role === 'card' && message.id === messageId ? { ...message, card: saved } : message) };
  const targetFields = new Set(['role', 'locations', 'workMode', 'salary', 'start']);
  const personal = card.phase === 1 ? Object.fromEntries(Object.entries(values).filter(([key, value]) => !targetFields.has(key) && (value !== '' || card.fields.find(field => field.key === key)?.edited === true))) : values;
  const next: AssistantState = { ...state, profile: { ...state.profile, ...personal }, confirmed: { ...state.confirmed, [card.phase]: true }, chat };
  if (card.phase === 2) next.privacy = Object.values(values).every(value => value === '不愿回答') ? 'declined' : 'provided';
  if (card.phase === 1 && card.targetId) {
    const role = values.role?.trim() || t("目标岗位");
    const existing = state.targets.find(target => target.role.toLocaleLowerCase() === role.toLocaleLowerCase());
    const target = { id: existing?.id ?? card.targetId, role, locations: values.locations ?? '', workMode: values.workMode ?? '', salary: values.salary ?? '', start: values.start ?? '', source: t("对话保存"), savedAt: t("刚刚") };
    next.targets = [...state.targets.filter(item => item.id !== target.id), target];
    next.currentTargetId = target.id;
  }
  return next;
}
