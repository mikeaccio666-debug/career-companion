import { useEffect, useRef } from 'react';
import { countIntakeText, type IntakeClientCode } from '@edaix/contracts';
import type { AssistantController } from '../../app/controller';
import { initialPrivateIntake } from './private-controller';
import { sectionFields, sectionLabels } from '../profile/editor-model';
import type { MessageKey } from '../../i18n';
import './private-intake.css';
export function PrivateIntakeScene({ controller }: { controller: AssistantController }) {
  const state = controller.ctx.state.privateIntake ?? initialPrivateIntake(), t = controller.ctx.t, intake = controller.privateIntake;
  const session = state.view?.session, usage = state.view?.usage, scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' }); }, [session?.turns.length, state.streaming]);
  const pending = session?.turns.some(turn => turn.status === 'PENDING'), busy = state.busy || pending;
  const unit = (value: typeof usage extends infer _T ? import('@edaix/contracts').IntakeUsageUnit | undefined : never) => !value || value.state === 'UNAVAILABLE' ? t('暂不可用') : value.remaining === null ? t('不限量') : String(value.remaining);
  return <section className="argo-intake" data-scene="chat">
    <header className="argo-intake-heading"><div><small>YOUR STORY</small><h2>{t('聊聊你的经历')}</h2><p>{t('想到哪里就说到哪里。整理出的资料由你核对后保存。')}</p></div><button type="button" data-act="open-review">{t('查看资料')}</button></header>
    <div className="argo-intake-balance"><span>{t('AI 回复剩余：{v0}', { v0: unit(usage?.replies) })}</span><span>{t('语音剩余秒数：{v0}', { v0: unit(usage?.speechSeconds) })}</span>{usage?.replies.resetsAt && <span>{t('下次重置：{v0}', { v0: new Date(usage.replies.resetsAt).toLocaleString(controller.ctx.state.locale) })}</span>}<button type="button" disabled={state.busy} onClick={() => void intake.refresh()}>{t('刷新')}</button></div>
    <div className="argo-intake-body"><div className="argo-intake-conversation" ref={scroll}>
      {!session?.turns.some(turn => turn.kind === 'REPLY') && <div className="argo-intake-bubble"><b>ArgoLand.AI</b><p>{t('你最近在做什么？可以从一段工作、学习或项目经历说起，还没确定目标岗位也没关系。')}</p></div>}
      {session?.turns.filter(turn => turn.kind === 'REPLY').map(turn => <div className="argo-intake-turn" key={turn.id}>
        <div className="argo-intake-bubble argo-intake-user"><small>{t('你')}</small><p>{turn.text}</p></div>
        {turn.reply && <div className="argo-intake-bubble"><b>ArgoLand.AI</b><p>{turn.reply}</p>{turn.clarifications.map((q, i) => <p key={i}>{q}</p>)}</div>}
        {turn.failure && <p className="argo-intake-note" role="status">{t('这一轮未完成，没有扣除 AI 轮次。可以修改文字后重新发送。')}</p>}
      </div>)}
      {state.streaming && <div className="argo-intake-bubble" aria-live="polite"><b>ArgoLand.AI</b><p>{state.streaming}</p><small>{t('正在整理，尚未保存')}</small></div>}
      {busy && !state.streaming && <p role="status">{t('正在整理你的经历…')}</p>}
    </div><aside className="argo-intake-candidates" aria-label={t('待核对资料')}>
      <h3>{t('待核对资料')}</h3><p className="argo-intake-note">{t('每次只确认一组。确认和手动修改不消耗 AI 轮次。')}</p>
      {session?.turns.flatMap(turn => turn.candidates.map(item => <article className="argo-intake-candidate" key={`${turn.id}-${item.candidate.id}`}>
        <div className="argo-intake-card-heading"><b>{t(sectionLabels[item.candidate.section])}</b><small>{t(item.decision === 'CONFIRMED' ? '已保存' : item.decision === 'DEFERRED' ? '稍后核对' : item.decision === 'DISMISSED' ? '已忽略' : '待核对')}</small></div>
        {item.candidate.fields.map(field => <dl key={field.path}><dt>{t(sectionFields[item.candidate.section].find(s => s.key === field.path)?.label ?? sectionLabels[item.candidate.section])}</dt><dd>{field.value}</dd></dl>)}
        <details><summary>{t('查看原话')}</summary>{item.candidate.fields.flatMap(f => f.sources).map((source, i) => <blockquote key={i}>{source.quote}</blockquote>)}</details>
        {['PENDING', 'DEFERRED'].includes(item.decision) && <div className="argo-intake-card-actions"><button type="button" className="argo-intake-primary" disabled={!!busy} onClick={() => void intake.review(turn.id, item.candidate.id)}>{t('核对并保存')}</button><button type="button" disabled={!!busy} onClick={() => void intake.decide(turn.id, item.candidate.id, 'DEFERRED')}>{t('稍后')}</button><button type="button" disabled={!!busy} onClick={() => void intake.decide(turn.id, item.candidate.id, 'DISMISSED')}>{t('忽略')}</button></div>}
      </article>))}
      {session?.turns.flatMap(turn => turn.roleSuggestions.map(role => <article className="argo-intake-candidate" key={`${turn.id}-${role.id}`}><small>{t('可以探索的方向')}</small><h4>{role.title}</h4><p>{role.rationale}</p><button type="button" onClick={async () => { await controller.roles.action('open-targets'); await controller.roles.action('role-create-new', role.title); }}>{t('核对并创建目标岗位')}</button></article>))}
      {!session?.turns.some(turn => turn.candidates.length || turn.roleSuggestions.length) && <div className="argo-intake-empty">{t('可保存的信息会出现在这里。没有确定的信息会留作问题。')}</div>}
    </aside></div>
    <footer className="argo-intake-composer">
      {state.code && <p className="argo-intake-notice" role="alert">{t(codeLabels[state.code] ?? '暂时无法完成此操作，请重试。')}</p>}
      {usage?.replies.state === 'EXHAUSTED' && <p className="argo-intake-notice">{t('AI 轮次已用完。你仍可确认候选、手动修改资料，或使用剩余语音时长整理文字。')}</p>}
      {state.source === 'TRANSCRIPT' && <p className="argo-intake-note">{t('这是转写草稿。请校对后再发送，录音本身不会自动发给 AI。')}</p>}
      {state.truncated && <p className="argo-intake-notice" role="alert">{t('内容已截取到 6,000 字，请检查下方实际发送内容；其余部分可分次发送。')}</p>}
      <label className="argo-intake-input"><span className="argo-intake-sr">{t('输入你的经历')}</span><textarea aria-label={t('输入你的经历')} rows={3} value={state.input} disabled={state.busy} placeholder={t('说说你的经历、擅长的事情，或正在探索的方向…')} onChange={e => intake.edit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void intake.send(); } }}/></label>
      <div className="argo-intake-tools"><div><button type="button" disabled={state.busy || usage?.speechSeconds.state === 'EXHAUSTED'} onClick={() => state.recording === 'idle' ? void intake.record() : intake.stopRecording()}>{t(state.recording === 'idle' ? '录音转文字' : state.recording === 'recording' ? '结束录音' : '正在转写…')}</button><small>{countIntakeText(state.input).toLocaleString()} / 6,000</small></div><div><button type="button" disabled={!!busy || state.recording !== 'idle' || !session} onClick={() => void intake.clear()}>{t('清空访谈')}</button>{busy ? <button type="button" onClick={() => void intake.cancel()}>{t('停止')}</button> : <button type="button" className="argo-intake-primary" disabled={state.recording !== 'idle' || !state.input.trim() || usage?.replies.state === 'EXHAUSTED'} onClick={() => void intake.send()}>{t('发送')}</button>}</div></div>
    </footer>
  </section>;
}
const codeLabels: Partial<Record<IntakeClientCode, MessageKey>> = { RATE_LIMITED: '今天的服务调用次数已达安全上限，请明天再试；已保存资料仍可编辑。', UNAVAILABLE: '访谈服务暂不可用，你可以先手动修改资料。', SAVE_UNCERTAIN: '连接中断，请刷新访谈核对结果；草稿仍在这里。', REVISION_CONFLICT: '资料或访谈已变化，请刷新后重新核对。', USAGE_EXHAUSTED: '本次操作的额度已用完。', AUDIO_INVALID: '录音为空、格式不支持或超过时长限制，请重新录音。', VOICE_DENIED: '未获得麦克风权限。你可以继续输入文字。', VOICE_NO_DEVICE: '没有可用的麦克风。你可以继续输入文字。', LIMIT_REACHED: '本次访谈已达到上限。保存需要的候选后，可以清空并开始新访谈。', CANCELLED: '已停止，草稿已保留。', LOGIN_REQUIRED: '请先连接账号。', LOCKED: '当前账号暂不可使用此服务。' };
