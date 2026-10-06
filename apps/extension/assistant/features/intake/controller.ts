import { C } from '../../design/palette';
import type { ControllerContext } from '../../app/controller-context';
import { isCurrent, portResult } from '../../app/controller-context';
import type { CandidateCard, ChatMessage, Phase, ProfileField } from '../../state/types';
import { buildCandidate, candidateValues, applyConfirmedCandidate } from './candidates';

export function createIntakeController(ctx: ControllerContext) {
  const chat = (patch: Partial<typeof ctx.state.chat>) => ctx.patch(s => ({ ...s, chat: { ...s.chat, ...patch } }));
  const push = (message: ChatMessage) => { chat({ messages: [...ctx.state.chat.messages, message] }); ctx.motion?.scrollChat(); };
  const ai = (text: string, onDone: 'privacy' | 'review' | 'more' | null = null) => push({ id: ctx.nextId('ai'), role: 'ai', text, stream: true, onDone });
  const updateCard = (id: string, patch: Partial<CandidateCard>) => chat({ messages: ctx.state.chat.messages.map(m => m.role === 'card' && m.id === id ? { ...m, card: { ...m.card, ...patch } } : m) });
  function finish(text: string) { chat({ privacyPrompt: false, morePrompt: false, stage: 'idle' }); ai(text, 'review'); }
  function advance(done: Phase) {
    if (done < 2) { const phase = (done + 1) as Phase; chat({ phase, stage: 'idle', morePrompt: false }); ai(ctx.t("已经保存，谢谢。\n") + ctx.data.phases[phase].intro, phase === 2 ? 'privacy' : null); }
    else finish(ctx.t("资料都整理好了。你可以完整回看每一组，也可以随时修改。"));
  }
  async function addCard(hits: Parameters<typeof buildCandidate>[2], from: string | null, group?: { index: number; total: number }) {
    const scope = ctx.store.scope(); const id = ctx.nextId('candidate');
    const card = buildCandidate(ctx.data, ctx.state, hits, id, group);
    push({ id, role: 'card', card }); chat({ stage: 'card' });
    await ctx.afterRender();
    if (isCurrent(ctx, scope)) await ctx.motion?.candidate(id, from, card.fields);
    if (isCurrent(ctx, scope)) chat({ stage: 'idle', messages: ctx.state.chat.messages.map(m => m.id === from && m.role === 'user' ? { ...m, showExtract: false } : m) });
  }
  async function start(phase?: Phase) {
    if (ctx.state.session !== 'connected') { ctx.toast(ctx.t("请先连接演示账号。")); return; }
    const ph = phase ?? (!ctx.state.confirmed[0] ? 0 : !ctx.state.confirmed[1] ? 1 : 2);
    ctx.store.reset({ ...ctx.state, chat: { phase: ph, messages: [], input: '', stage: 'idle', privacyPrompt: false, reviewPrompt: false, morePrompt: false, initialized: true }, voice: { state: 'idle', secs: 0, notice: '', draft: '' } });
    if (!ctx.state.hasResume) {
      ai(ctx.t("从一份简历开始吧。\n我会读取文件、理解你的经历，整理成候选资料卡，再请你逐项核对。你确认前，不会保存。"));
      push({ id: ctx.nextId('upload'), role: 'upload', upload: { state: 'idle' } });
    } else ai(ctx.state.addingTarget ? ctx.t("再告诉我想找的方向、地点、工作方式、薪酬与可开始时间。一句话里说几个方向也可以，我会分别整理。") : ctx.data.phases[ph].intro, ph === 2 ? 'privacy' : null);
    await ctx.go('chat');
  }
  async function send() {
    const text = ctx.state.chat.input.trim();
    if (!text || ctx.state.chat.stage !== 'idle') return;
    const scope = ctx.store.scope(), phase = ctx.state.chat.phase, id = ctx.nextId('user');
    const fromVoice = ctx.state.voice.state === 'transcript';
    chat({ input: '', stage: 'thinking', morePrompt: false });
    ctx.patch(s => ({ ...s, voice: { ...s.voice, state: 'idle' } }));
    push({ id, role: 'user', text, segments: [{ id: 'plain', text, key: false }], hits: [], fromVoice, showExtract: false });
    const result = await portResult(() => ctx.ports.extract({ text, phase }, scope.signal));
    if (!isCurrent(ctx, scope)) return;
    if (!result.ok) { chat({ stage: 'idle', input: text }); ctx.toast(ctx.t("暂时无法整理，你的输入已保留。")); return; }
    const hits = result.value.hits.map(h => ({ ...h, label: h.field === 'decline' ? ctx.t("本组选择") : ctx.data.fieldMeta[h.field]?.label }));
    chat({ stage: hits.length ? 'extracting' : 'idle', messages: ctx.state.chat.messages.map(m => m.id === id && m.role === 'user' ? { ...m, segments: result.value.segments, hits, showExtract: hits.length > 0 } : m) });
    if (!hits.length) { ai(ctx.t("还没有捕捉到可以放进资料卡的信息，可以再具体一点。"), phase === 2 ? 'privacy' : null); return; }
    await ctx.afterRender(); await ctx.motion?.extract(id);
    if (!isCurrent(ctx, scope)) return;
    const roles = hits.filter(h => h.field === 'role');
    if (phase === 1 && roles.length > 1) {
      const shared = hits.filter(h => h.field !== 'role');
      for (let i = 0; i < roles.length; i++) {
        if (!isCurrent(ctx, scope)) return;
        await addCard([...shared, roles[i]], i === 0 ? id : null, { index: i + 1, total: roles.length });
      }
    } else await addCard(hits, id);
  }
  async function confirm(id: string) {
    const message = ctx.state.chat.messages.find(m => m.id === id);
    if (message?.role !== 'card' || message.card.busy || message.card.readOnly) return;
    const card = message.card, values = candidateValues(card), scope = ctx.store.scope();
    if (card.phase === 0 && !values.nick?.trim()) { ctx.toast(ctx.t("请填写你希望的称呼。")); return; }
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) { ctx.toast(ctx.t("请检查邮箱格式。")); return; }
    updateCard(id, { busy: true, notice: false, confirmLabel: ctx.t("正在保存…") });
    const result = await portResult(() => ctx.ports.saveCandidate({ phase: card.phase, fields: values, targetId: card.targetId }, scope.signal));
    if (!isCurrent(ctx, scope)) return;
    if (!result.ok) {
      updateCard(id, { busy: false, confirmLabel: ctx.t("确认这组资料"), notice: true, noticeText: result.code === 'CONFLICT' ? ctx.t("Portal 上的资料在此期间有修改。当前候选已保留，请重新核对后重试。") : ctx.t("保存没有成功，你的修改仍在卡片上。可以重试，或稍后保存。"), noticeBg: C.rose, noticeActions: [{ act: 'cand-confirm', label: ctx.t("重试保存") }, { act: 'cand-later', label: ctx.t("稍后") }] }); return;
    }
    ctx.patch(s => applyConfirmedCandidate(s, card, id), scope); ctx.motion?.saved(id);
    const pending = ctx.state.chat.messages.some(m => m.role === 'card' && !m.card.readOnly);
    if (pending) { chat({ stage: 'card' }); return; }
    if (card.phase === 1) { chat({ stage: 'idle' }); ai(ctx.t("这组方向已保存。还想找其他方向吗？也可以继续下一组。"), 'more'); }
    else advance(card.phase);
  }
  function edit(id: string, key: ProfileField, value: string) {
    const m = ctx.state.chat.messages.find(m => m.id === id);
    if (m?.role !== 'card' || m.card.busy || m.card.readOnly) return;
    updateCard(id, { fields: m.card.fields.map(f => f.key === key ? { ...f, value, edited: true, source: ctx.t("你的修改"), srcBg: C.mint, srcColor: C.green } : f) });
  }
  async function upload(action: string) {
    const m = ctx.state.chat.messages.find(m => m.role === 'upload'); if (!m) return;
    const setUpload = (upload: import('../../state/types').UploadState) => chat({ messages: ctx.state.chat.messages.map(x => x.id === m.id && x.role === 'upload' ? { ...x, upload } : x) });
    if (action === 'upload-cancel' || action === 'upload-manual') {
      ctx.store.reset({ ...ctx.state }); setUpload({ state: 'skipped' }); ai(ctx.data.phases[0].introNoResume ?? ctx.data.phases[0].intro); return;
    }
    if (m.role === 'upload' && ['uploading', 'reading', 'organizing'].includes(m.upload.state)) return;
    const scope = ctx.store.scope();
    const result = await portResult(() => ctx.ports.parseResume(stage => { if (isCurrent(ctx, scope)) setUpload(stage); }, scope.signal));
    if (!isCurrent(ctx, scope)) return;
    if (!result.ok) { setUpload({ state: 'failed' }); return; }
    // Parsed content remains a candidate source until explicit confirmation.
    ctx.patch({ hasResume: true }); setUpload({ state: 'done' });
    const hits = ctx.data.phases[0].fields.filter(key => typeof result.value[key] === 'string').map(key => ({ field: key, value: result.value[key] as string, start: 0, end: 0 }));
    ai(ctx.t("简历已读完。请核对这组基本资料。")); await addCard(hits, null);
  }
  return { start, send, confirm, edit, upload, advance, ai,
    streamDone(id: string) {
      const m = ctx.state.chat.messages.find(m => m.id === id); if (m?.role !== 'ai' || !m.stream) return;
      chat({ messages: ctx.state.chat.messages.map(x => x.id === id && x.role === 'ai' ? { ...x, stream: false } : x), ...(m.onDone === 'privacy' ? { privacyPrompt: true } : m.onDone === 'review' ? { reviewPrompt: true } : m.onDone === 'more' ? { morePrompt: true } : {}) });
    },
    later(id: string) { updateCard(id, { busy: false, notice: false }); chat({ stage: 'idle' }); ctx.toast(ctx.t("候选保留在对话里，可以稍后确认。")); },
    async privacy(kind: string) {
      if (kind === 'skip') { ctx.patch(s => ({ ...s, privacy: 'skipped', confirmed: { ...s.confirmed, 2: true } })); finish(ctx.t("这一组已跳过，不影响资料完整度。之后想提供时随时可以回来。")); }
      else { chat({ privacyPrompt: false }); await addCard(kind === 'decline' ? [{ field: 'decline', value: '不愿回答', start: 0, end: 0 }] : [], null); }
    },
    addTarget() { ctx.patch({ addingTarget: true, sheet: null }); return start(1); },
    useTarget(id: string) { if (!ctx.state.targets.some(t => t.id === id)) return; ctx.patch({ currentTargetId: id, sheet: null }); ctx.motion?.targetChanged(); },
  };
}
