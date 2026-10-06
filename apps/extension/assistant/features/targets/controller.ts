import { parseAssistantRoleCreate, parseRolePreferences, parseUuid, type AssistantRoleView, type AssistantRoleCode, type RolePreferences, type RolePreferencesSnapshot } from '@edaix/contracts';
import type { ControllerContext } from '../../app/controller-context';
import { isCurrent } from '../../app/controller-context';
import type { Target } from '../../state/types';

export interface RoleDraft { location: string; workMode: string; min: string; max: string; currency: string; period: string; availableFrom: string }
export interface RoleManagerState {
  items: AssistantRoleView[]; nextCursor: string | null; loading: boolean; loaded: boolean; code?: AssistantRoleCode;
  editor?: { base: RolePreferencesSnapshot; draft: RoleDraft; phase: 'editing' | 'saving' | 'review'; latest?: RolePreferencesSnapshot; reading?: boolean; code?: AssistantRoleCode };
  create?: { name: string; location: string; requestId: string; phase: 'editing' | 'saving' | 'review'; code?: AssistantRoleCode };
}
export function roleDraft(p: RolePreferences): RoleDraft {
  return { location: p.preferredLocation ?? '', workMode: p.workMode ?? '', min: p.salary?.min ?? '', max: p.salary?.max ?? '',
    currency: p.salary?.currency ?? '', period: p.salary?.period ?? '', availableFrom: p.availableFrom ?? '' };
}
export function draftPreferences(d: RoleDraft): RolePreferences | null {
  return parseRolePreferences({ preferredLocation: d.location.normalize('NFC').trim() || null, workMode: d.workMode || null,
    salary: d.min || d.max || d.currency || d.period ? { min: d.min || null, max: d.max || null, currency: d.currency, period: d.period } : null,
    availableFrom: d.availableFrom || null });
}
export function interruptRoleManager(state?: RoleManagerState): RoleManagerState | undefined {
  if (!state) return undefined;
  return { ...state, loading: false, editor: state.editor ? { ...state.editor, reading: false, ...(state.editor.phase === 'saving' ? { phase: 'review', code: 'SAVE_UNCERTAIN' } as const : {}) } : undefined,
    create: state.create ? { ...state.create, ...(state.create.phase === 'saving' ? { phase: 'review', code: 'SAVE_UNCERTAIN' } as const : {}) } : undefined };
}
export function createRoleController(ctx: ControllerContext) {
  let sequence = 0;
  const admitted = () => ctx.state.roleManagementEnabled && ctx.state.session === 'connected' && !!ctx.ports.roles;
  const empty = (): RoleManagerState => ({ items: [], nextCursor: null, loading: false, loaded: false });
  const state = () => ctx.state.roleManager ?? empty();
  const set = (patch: Partial<RoleManagerState>) => ctx.patch({ roleManager: { ...state(), ...patch } });
  function sync(items: AssistantRoleView[], current = ctx.state.currentTargetId) {
    const targets: Target[] = items.filter(r => r.status === 'ACTIVE').map(r => ({ id: r.id, role: r.targetRole, locations: r.jobPreferences.preferredLocation ?? '', workMode: '', salary: '', start: '', source: 'Portal', savedAt: '' }));
    ctx.patch({ targets, currentTargetId: targets.some(t => t.id === current) ? current : null });
  }
  async function refresh(more = false) {
    if (!admitted() || state().loading) return;
    const before = state(), scope = ctx.store.scope(), seq = ++sequence;
    if (more && !before.nextCursor) return;
    set({ loading: true, code: undefined });
    const result = await ctx.ports.roles!.list(more ? before.nextCursor : null, scope.signal).catch(() => ({ ok: false, code: 'UNAVAILABLE' } as const));
    if (!isCurrent(ctx, scope) || seq !== sequence) return;
    if (!result.ok) { set({ loading: false, code: result.code }); return; }
    const items = [...new Map([...(more ? before.items : []), ...result.value.items].map(r => [r.id, r])).values()];
    set({ items, nextCursor: result.value.nextCursor, loaded: true, loading: false,
      ...(state().create?.phase === 'review' ? { create: { ...state().create!, phase: 'editing' } } : {}) });
    sync(items);
  }
  function edit(key: string, value: string) {
    if (!admitted()) return;
    const s = state();
    if (s.create?.phase === 'editing' && (key === 'name' || key === 'location')) set({ create: { ...s.create, [key]: value, requestId: crypto.randomUUID(), code: undefined } });
    else if (s.editor?.phase === 'editing' && Object.hasOwn(s.editor.draft, key)) set({ editor: { ...s.editor, draft: { ...s.editor.draft, [key]: value }, code: undefined } });
  }
  async function action(act: string, arg = '') {
    if (!admitted()) return;
    const s = state();
    if (act === 'open-targets') { ctx.patch({ sheet: { kind: 'targets' } }); if (!s.loaded) await refresh(); return; }
    if (act === 'role-refresh' || act === 'role-more') { await refresh(act === 'role-more'); return; }
    if (act === 'role-create-new' && !s.editor && !s.loading) { set({ create: { name: arg.slice(0, 120), location: '', requestId: crypto.randomUUID(), phase: 'editing' } }); return; }
    if (act === 'role-use') {
      if (s.items.some(r => r.id === arg && r.status === 'ACTIVE')) { ctx.patch({ currentTargetId: arg, sheet: null }); ctx.motion?.targetChanged(); }
      return;
    }
    if (act === 'role-edit' && !s.editor && !s.create && !s.loading) {
      const id = parseUuid(arg); if (!id || !s.items.some(r => r.id === id && r.status === 'ACTIVE')) return;
      const scope = ctx.store.scope(), seq = ++sequence; set({ loading: true, code: undefined });
      const r = await ctx.ports.roles!.read(id, scope.signal).catch(() => ({ ok: false, code: 'UNAVAILABLE' } as const));
      if (!isCurrent(ctx, scope) || seq !== sequence) return;
      set(r.ok && r.value.conversationId === id ? { loading: false, editor: { base: r.value, draft: roleDraft(r.value.preferences), phase: 'editing' } } : { loading: false, code: r.ok ? 'RESPONSE_MALFORMED' : r.code }); return;
    }
    if (act === 'role-create' && s.create?.phase === 'editing') {
      const form = s.create, scope = ctx.store.scope();
      const name = form.name.normalize('NFC').trim();
      const request = parseAssistantRoleCreate({ clientRequestId: form.requestId, kind: 'ROLE', targetRole: name, title: name, jobPreferences: { preferredLocation: form.location.normalize('NFC').trim() || null }, generationLocale: ctx.state.locale ?? 'en-US' });
      if (!request) { set({ create: { ...form, code: 'VALIDATION_FAILED' } }); return; }
      set({ create: { ...form, phase: 'saving', code: undefined } });
      const r = await ctx.ports.roles!.create(request, scope.signal).catch(() => ({ ok: false, code: 'SAVE_UNCERTAIN' } as const));
      if (!isCurrent(ctx, scope)) return;
      if (!r.ok) { set({ create: { ...form, phase: ['VALIDATION_FAILED', 'DISABLED', 'LOCKED', 'CANCELLED'].includes(r.code) ? 'editing' : 'review', code: r.code } }); return; }
      const items = [...state().items.filter(v => v.id !== r.value.role.id), r.value.role];
      set({ items, create: undefined }); sync(items, r.value.role.id);
      ctx.toast(ctx.t(r.value.role.status === 'ARCHIVED' ? '该岗位已归档，请先在 Portal 恢复。' : r.value.created ? '目标岗位已创建，可继续编辑独立偏好。' : '已找到同名目标岗位，原偏好保持不变。')); return;
    }
    const editor = s.editor;
    if (act === 'role-save' && editor?.phase === 'editing') {
      const preferences = draftPreferences(editor.draft); if (!preferences) { set({ editor: { ...editor, code: 'VALIDATION_FAILED' } }); return; }
      const scope = ctx.store.scope(); set({ editor: { ...editor, phase: 'saving', code: undefined } });
      const r = await ctx.ports.roles!.save(editor.base.conversationId, { expectedRevision: editor.base.revision, preferences }, scope.signal).catch(() => ({ ok: false, code: 'SAVE_UNCERTAIN' } as const));
      if (!isCurrent(ctx, scope)) return;
      if (r.ok) { const items = state().items.map(item => item.id === r.value.conversationId ? { ...item, revision: r.value.revision, jobPreferences: { preferredLocation: r.value.preferences.preferredLocation } } : item); set({ items, editor: undefined }); sync(items); ctx.toast(ctx.t('岗位偏好已保存并重新核对。')); }
      else set({ editor: { ...editor, phase: ['VALIDATION_FAILED', 'DISABLED', 'LOCKED', 'CANCELLED'].includes(r.code) ? 'editing' : 'review', code: r.code } }); return;
    }
    if (act === 'role-read-latest' && editor?.phase === 'review' && !editor.reading) {
      const scope = ctx.store.scope(); set({ editor: { ...editor, reading: true, latest: undefined } });
      const r = await ctx.ports.roles!.read(editor.base.conversationId, scope.signal).catch(() => ({ ok: false, code: 'UNAVAILABLE' } as const));
      if (isCurrent(ctx, scope)) set({ editor: { ...editor, reading: false, ...(r.ok && r.value.conversationId === editor.base.conversationId ? { latest: r.value } : { code: r.ok ? 'RESPONSE_MALFORMED' : r.code }) } }); return;
    }
    if (act === 'role-rebase' && editor?.latest && !editor.reading) {
      const old = roleDraft(editor.base.preferences), latest = roleDraft(editor.latest.preferences), draft = { ...latest };
      // Salary is a single unit, preventing mixed currencies/ranges after concurrent edits.
      for (const key of ['location', 'workMode', 'availableFrom'] as const) if (editor.draft[key] !== old[key]) draft[key] = editor.draft[key];
      if (['min', 'max', 'currency', 'period'].some(k => editor.draft[k as keyof RoleDraft] !== old[k as keyof RoleDraft])) for (const key of ['min', 'max', 'currency', 'period'] as const) draft[key] = editor.draft[key];
      set({ editor: { base: editor.latest, draft, phase: 'editing' } }); return;
    }
    if (act === 'role-cancel' && editor?.phase !== 'saving' && !editor?.reading && s.create?.phase !== 'saving') {
      const items = editor?.latest ? s.items.map(item => item.id === editor.latest!.conversationId ? { ...item, revision: editor.latest!.revision, jobPreferences: { preferredLocation: editor.latest!.preferences.preferredLocation } } : item) : s.items;
      set({ items, editor: undefined, create: undefined }); sync(items); return;
    }
  }
  return { action, edit, refresh };
}
