import {createConnectedAutofillController} from '../features/autofill/controller';
import {createConnectedMaterialsController} from '../features/connected-materials-controller';
import {createCommerceController} from '../features/commerce/controller';
import { createPrivateIntakeController } from '../features/intake/private-controller';
import { createRoleController, interruptRoleManager } from '../features/targets/controller';
import { createProfileEditorController } from '../features/profile/controller';
import { interruptProfileEditor } from '../features/profile/editor-model';
import type { AssistantData, AssistantState, Phase, ProfileField, Scene } from '../state/types';
import type { AssistantPorts, UiResult } from '../ports/assistant-ports';
import { abortableDelay } from '../ports/assistant-ports';
import { createAssistantStore } from '../state/store';
import { emptyRun } from '../state/initial';
import { createIntakeController } from '../features/intake/controller';
import { createJobsController } from '../features/jobs-controller';
import { createMaterialsController } from '../features/materials-controller';
import type { ControllerContext } from './controller-context';
import { isCurrent, portResult } from './controller-context';
import { createTranslator, isAssistantLocale, resolveAssistantLocale } from '../i18n';
import { localizePresentationData } from '../presentation-data';

export function createAssistantController(data: AssistantData, ports: AssistantPorts, initial: AssistantState) {
  if (ports.commerce) initial={...initial,commerceEnabled:true,jobOptions:initial.jobOptions??[]};
  const store = createAssistantStore(initial); let sequence = 0, toastSequence = 0, voiceSequence = 0;
  const frameWaiters = new Set<() => void>();
  const ctx: ControllerContext = {
    get t() { return createTranslator(resolveAssistantLocale(store.getSnapshot().locale)); },
    get data() { const state=store.getSnapshot(),base=localizePresentationData(data,resolveAssistantLocale(state.locale));return {...base,...(state.jobOptions?{jobs:state.jobOptions}:{}),...(state.resumeOptions?{resumeVersions:state.resumeOptions}:{})}; }, ports, store, motion: null, get state() { return store.getSnapshot(); },
    patch(patch, scope = store.scope()) { return store.commit(scope, s => typeof patch === 'function' ? patch(s) : { ...s, ...patch }); },
    nextId(prefix) { return `${prefix}-${++sequence}`; },
    afterRender() { return new Promise(resolve => { frameWaiters.add(resolve); requestAnimationFrame(() => { frameWaiters.delete(resolve); resolve(); }); }); },
    async go(scene, morph = false) {
      const scope = store.scope(); const commit = () => ctx.patch({ scene, sheet: null, hostHighlight: false }, scope);
      if (ctx.motion) await ctx.motion.navigate(scene, commit, morph); else commit();
    },
    async close() {
      voiceSequence++;
      const state = ctx.state;
      store.reset({ ...state, profileEditor: interruptProfileEditor(state.profileEditor), roleManager: interruptRoleManager(state.roleManager), panelOpen: false, sheet: null, modal: null, deck: { ...state.deck, busy: false }, chat: { ...state.chat, stage: 'idle', messages: state.chat.messages.map(m => m.role === 'card' && m.card.busy ? { ...m, card: { ...m.card, busy: false, confirmLabel: ctx.t("确认这组资料") } } : m) }, voice: { ...state.voice, state: 'idle' }, prep: Object.fromEntries(Object.entries(state.prep).map(([id, p]) => [id, p === 'preparing' || p === 'queued' ? 'failed' : p])), atsResults: Object.fromEntries(Object.entries(state.atsResults).map(([id, r]) => [id, r.status === 'scoring' ? { ...r, status: state.commerceEnabled ? 'pending' as const : 'failed' as const } : r])), letters: Object.fromEntries(Object.entries(state.letters).map(([id, l]) => [id, l.status === 'generating' ? { ...l, status: 'failed' as const } : l])), run: state.run.status === 'running' ? { ...state.run, status: 'paused', failed: true } : state.run });
      await ctx.motion?.visibility(false, () => {});
    },
    async open() { ctx.patch({ launcherHidden: false, hiddenNote: false }); const commit = () => ctx.patch({ panelOpen: true }); if (ctx.motion) await ctx.motion.visibility(true, commit); else commit(); },
    toast(message) { const id = ++toastSequence, scope = store.scope(); ctx.patch({ toast: message }); void abortableDelay(3200, scope.signal).then(done => { if (done && id === toastSequence) ctx.patch({ toast: '' }, scope); }); },
  };
  const privateIntake = createPrivateIntakeController(ctx);
  const profile = createProfileEditorController(ctx);
  const roles = createRoleController(ctx);
  const intake = createIntakeController(ctx), jobs = createJobsController(ctx), materials = createMaterialsController(ctx);
  function login() {
    ctx.patch({ modal: { title: ctx.t("前往 ArgoLand Portal 登录"), text: ports.mode === 'preview' ? ctx.t("这里使用演示账号。选择一个登录结果，继续体验完整流程。") : ctx.t("连接服务尚未接入，请稍后再试。"), actions: ports.mode === 'preview' ? [{ id: 'login-wait', label: ctx.t("打开 Portal 并等待"), primary: true }, { id: 'login-ok', label: ctx.t("模拟登录成功返回") }, { id: 'noop', label: ctx.t("取消，留在这里"), ghost: true }] : [{ id: 'noop', label: ctx.t("返回") }] } });
  }
  async function modal(id: string) {
    ctx.patch({ modal: null });
    if (ports.mode === 'preview' && (id === 'login-ok' || id === 'login-wait')) {
      const scope = store.scope();
      ctx.patch({ session: 'connecting' });
      if (id === 'login-wait' && !await abortableDelay(2600, scope.signal)) return;
      if (ctx.state.session === 'connecting') { ctx.patch({ session: 'connected', everConnected: true }, scope); ctx.toast(ctx.t("演示账号已连接")); }
    } else if (id === 'to-profile') await intake.start();
    else if (id === 'demo-deck') await jobs.discover(true);
    else if (id === 'go-shortlist') await ctx.go('shortlist');
    else if (id === 'page-recheck') ctx.patch({ run: emptyRun() });
    else if (id === 'relogin') login();
  }
  async function voice(action: string) {
    if (action === 'voice-cancel') { voiceSequence++; ctx.patch(s => ({ ...s, voice: { ...s.voice, state: 'idle' } })); return; }
    if (action === 'voice-dismiss') { ctx.patch(s => ({ ...s, voice: { ...s.voice, notice: '' } })); return; }
    if (action === 'voice-start') {
      if (ctx.state.chat.stage !== 'idle' || ctx.state.voice.state === 'processing') return;
      const id = ++voiceSequence, scope = store.scope();
      ctx.patch({ voice: { state: 'recording', secs: 0, notice: '', draft: '' } });
      while (id === voiceSequence && ctx.state.voice.state === 'recording' && await abortableDelay(1000, scope.signal)) ctx.patch(s => ({ ...s, voice: { ...s.voice, secs: s.voice.secs + 1 } }), scope);
      return;
    }
    if (action !== 'voice-stop' || ctx.state.voice.state !== 'recording') return;
    const id = ++voiceSequence, scope = store.scope(); ctx.patch(s => ({ ...s, voice: { ...s.voice, state: 'processing' } }));
    const result = await portResult(() => ports.transcribe(ctx.state.chat.phase, scope.signal));
    if (!isCurrent(ctx, scope) || id !== voiceSequence) return;
    if (result.ok) ctx.patch(s => ({ ...s, voice: { ...s.voice, state: 'transcript', draft: result.value }, chat: { ...s.chat, input: result.value } }));
    else ctx.patch(s => ({ ...s, voice: { ...s.voice, state: 'idle', notice: result.code === 'VOICE_DENIED' ? ctx.t("未获得麦克风权限。你可以继续输入文字。") : result.code === 'VOICE_NO_DEVICE' ? ctx.t("没有可用的麦克风。你可以继续输入文字。") : ctx.t("没有听清楚，可以重试或改用文字。") } }));
  }
  async function action(act: string, arg = '') {
    if (act.startsWith('voice-')) { await voice(act); return; }
    switch (act) {
      case 'set-locale': if (isAssistantLocale(arg)) ctx.patch({ locale: arg }); break;
      case 'panel-close': await ctx.close(); break;
      case 'launcher-open': case 'toolbar-open': await ctx.open(); break;
      case 'launcher-hide': ctx.patch({ launcherHidden: true, hiddenNote: true }); break;
      case 'login': case 'signup': login(); break;
      case 'login-cancel': ctx.patch({ session: 'out' }); break;
      case 'modal-action': await modal(arg); break;
      case 'sheet-close': ctx.patch({ sheet: null }); break;
      case 'morph-home': await ctx.go('home', true); break;
      case 'home': await ctx.go('home'); break;
      case 'personalize': await intake.start(); break;
      case 'open-profile': if (ctx.state.confirmed[0] || ctx.state.profileDone) await ctx.go('profile'); else await intake.start(); break;
      case 'open-review': await ctx.go('profile'); break;
      case 'review-edit': if (['0', '1', '2'].includes(arg)) await intake.start(Number(arg) as Phase); break;
      case 'review-confirm': ctx.patch({ profileDone: true }); await ctx.go('home'); ctx.toast(ctx.t("资料已确认，保存在本次预览中。")); break;
      case 'chat-send': await intake.send(); break;
      case 'cand-confirm': await intake.confirm(arg); break;
      case 'cand-later': intake.later(arg); break;
      case 'target-done': intake.advance(1); break;
      case 'target-use': intake.useTarget(arg); break;
      case 'target-add': await intake.addTarget(); break;
      case 'privacy-skip': case 'privacy-decline': case 'privacy-provide': await intake.privacy(act.slice(8)); break;
      case 'upload-start': case 'upload-retry': case 'upload-cancel': case 'upload-manual': await intake.upload(act); break;
      case 'discover': await jobs.discover(); break;
      case 'next-batch': await jobs.nextBatch(); break;
      case 'deck-accept': case 'deck-skip': await jobs.decide(act === 'deck-accept'); break;
      case 'deck-undo': await jobs.undo(); break;
      case 'ats-score': case 'ats-retry': await jobs.score(arg); break;
      case 'ats-retry-sync': ctx.toast(ctx.t("权益仍在等待服务端确认。")); break;
      case 'pick-resume': jobs.pickResume(arg); break;
      case 'open-shortlist': await ctx.go('shortlist'); break;
      case 'short-remove': materials.remove(arg); break;
      case 'short-retry': await materials.retry(arg); break;
      case 'prepare': await materials.prepare(); break;
      case 'open-cover': await materials.openCover(arg); break;
      case 'cover-generate': await materials.generate(ctx.state.coverId); break;
      case 'cover-keep': materials.keepLetter(); break;
      case 'open-job-page': await materials.openJob(arg); break;
      case 'fill-start': ctx.patch({ sheet: { kind: 'fill' } }); break;
      case 'fill-confirm': await materials.fill(); break;
      case 'fill-rerun': ctx.patch({ run: emptyRun() }); break;
      case 'fill-handoff': await materials.handoff(); break;
      case 'open-resume': case 'open-letters': case 'open-usage': case 'open-targets': ctx.patch({ sheet: { kind: act.slice(5) as 'resume' | 'letters' | 'usage' | 'targets' } }); break;
      case 'open-jd': ctx.patch({ sheet: { kind: 'jd', id: arg } }); break;
      case 'ats-details': case 'ats-sample': ctx.patch({ sheet: { kind: 'ats', id: arg, sample: act === 'ats-sample' } }); break;
      case 'open-plans': ctx.toast(ctx.t("套餐页面尚未接入，此处可在预览控制栏切换权益场景。")); break;
      case 'host-submit': ctx.toast(ctx.t("这是演示页面，提交需由本人在真实网站完成。")); break;
      case 'toggle-motion': ctx.patch({ reduced: !ctx.state.reduced }); break;
      default: break;
    }
  }
  const commerce=createCommerceController(ctx),connectedMaterials=createConnectedMaterialsController(ctx),autofill=createConnectedAutofillController(ctx);
  async function connectedAction(act: string, arg: string): Promise<UiResult<void>> {
    if ((act === 'toolbar-open' || act === 'launcher-open') && ports.connection) {
      await action(act, arg);
      return ctx.state.session === 'connecting' ? { ok: true, value: undefined } : ports.connection.refresh();
    }
    if (act === 'login' || act === 'signup' || act === 'session-refresh' || act === 'logout') {
      const operation = act === 'session-refresh' ? 'refresh' : act === 'logout' ? 'logout' : 'login';
      const result = ports.connection ? await ports.connection[operation]() : { ok: false as const, code: 'UNAVAILABLE' as const };
      if (!result.ok && result.code !== 'CANCELLED') ctx.toast(operation === 'login' ? ctx.t("暂时无法打开登录连接，请稍后重试。") : ctx.t("暂时无法更新连接，请重试。"));
      return result;
    }
    if (act === 'intake-open' || act === 'personalize') { await privateIntake.open(); return { ok: true, value: undefined }; }
    if (act === 'panel-close') { privateIntake.interrupt(); await autofill.stop(); }
    if (['home','morph-home','open-shortlist','open-targets'].includes(act)||act.startsWith('role-')) await autofill.stop();
    const ordinary = ['set-locale', 'panel-close', 'launcher-open', 'toolbar-open', 'launcher-hide', 'sheet-close', 'toggle-motion', 'home', 'morph-home'];
    if (ordinary.includes(act)) { await action(act, arg); return { ok: true, value: undefined }; }
    if (act === 'modal-action' && arg === 'noop') { ctx.patch({ modal: null }); return { ok: true, value: undefined }; }
    if (ctx.state.session !== 'connected') return { ok: false, code: 'UNAVAILABLE' };
    if (act === 'open-targets' || act.startsWith('role-')) { await roles.action(act, arg); return { ok: true, value: undefined }; }
    if (act.startsWith('profile-')) { await profile.action(act, arg); return { ok: true, value: undefined }; }
    if (['open-review', 'open-profile', 'personalize'].includes(act)) {
      await ctx.go('profile'); return { ok: true, value: undefined };
    }
    if(ports.commerce){
      if(act==='open-job-page'){await autofill.open(arg);return {ok:true,value:undefined};}
      if(act.startsWith('fill-')){await autofill.action(act);return {ok:true,value:undefined};}
      if(act==='materials-refresh'){await connectedMaterials.refresh();return {ok:true,value:undefined};}
      if(act==='material-select'){connectedMaterials.select(arg);return {ok:true,value:undefined};}
      if(act==='prepare'){await connectedMaterials.prepare();return {ok:true,value:undefined};}
      if(act==='short-retry'){await connectedMaterials.retry(arg);return {ok:true,value:undefined};}
      if(act==='open-cover'){await connectedMaterials.openCover(arg);return {ok:true,value:undefined};}
      if(act==='cover-generate'||act==='cover-keep'||act==='cover-delete'){await connectedMaterials.coverWrite(act==='cover-generate'?'GENERATE':act==='cover-delete'?'DELETE':'SAVE');return {ok:true,value:undefined};}

      if(act==='discover'||act==='next-batch'){await commerce.nextBatch();return {ok:true,value:undefined};}
      if(act==='deck-accept'||act==='deck-skip'){await commerce.decide(act==='deck-accept');return {ok:true,value:undefined};}
      if(act==='deck-undo'){await commerce.undo();return {ok:true,value:undefined};}
      if(act==='open-shortlist'){await commerce.shortlist();await connectedMaterials.open();return {ok:true,value:undefined};}
      if(act==='short-more'){await commerce.moreSaved();await connectedMaterials.refresh(false);return {ok:true,value:undefined};}
      if(act==='short-remove'){await commerce.remove(arg);return {ok:true,value:undefined};}
      if(act==='open-jd'){await commerce.detail(arg);return {ok:true,value:undefined};}
      if(act==='ats-existing'){await commerce.existingReport(arg);return {ok:true,value:undefined};}
      if(act==='ats-score'||act==='ats-retry'){await commerce.score(arg);return {ok:true,value:undefined};}
      if(act==='ats-details'){ctx.patch({sheet:{kind:'ats',id:arg}});return {ok:true,value:undefined};}
      if(act==='open-usage'||act==='ats-retry-sync'){ctx.patch({sheet:{kind:'usage'}});await commerce.usage();return {ok:true,value:undefined};}
      if(act==='open-plans'){return ports.openBilling?ports.openBilling():{ok:false,code:'UNAVAILABLE'};}
    }
    if (['open-resume', 'open-usage'].includes(act)) { await action(act, arg); return { ok: true, value: undefined }; }
    if (act === 'pick-resume' && ctx.state.resumeOptions?.some(option => option.id === arg)) {
      jobs.pickResume(arg);ctx.patch({sheet:null}); return { ok: true, value: undefined };
    }
    ctx.toast(ctx.t("此功能尚未接入。你可以先查看已保存的资料与简历。"));
    return { ok: false, code: 'UNAVAILABLE' };
  }
  return { ctx, store, intake, privateIntake, jobs, materials, profile, roles,commerce,connectedMaterials,autofill,
    async dispatch(act: string, arg = ''): Promise<UiResult<void>> { try { if (ports.mode === 'connected') return await connectedAction(act, arg); await action(act, arg); return { ok: true, value: undefined }; } catch { ctx.toast(ctx.t("暂时无法完成此操作，请重试。")); return { ok: false, code: 'UNAVAILABLE' }; } },
    input(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
      if (element.dataset.chatInput) ctx.patch(s => ({ ...s, chat: { ...s.chat, input: element.value } }));
      else if (element.dataset.candMsg && element.dataset.candInput) intake.edit(element.dataset.candMsg, element.dataset.candInput as ProfileField, element.value);
      else if (element.dataset.coverText) { if(ports.commerce)connectedMaterials.edit(element.value);else materials.editLetter(element.value); }
    },
    reset(next = initial) { void autofill.stop(); voiceSequence++; store.reset({ ...structuredClone(next), locale: ctx.state.locale }); },
    rendered() { for (const resolve of frameWaiters) resolve(); frameWaiters.clear(); },
    dispose() { void autofill.stop(); privateIntake.interrupt(); voiceSequence++; store.dispose(); for (const resolve of frameWaiters) resolve(); frameWaiters.clear(); },
  };
}
export type AssistantController = ReturnType<typeof createAssistantController>;
