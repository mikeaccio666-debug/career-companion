import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { safetyResourceHref } from './safety-resource-api';
import { SafetyResourceController, type SafetyResourceCardView, type SafetyResourceObservation } from './safety-resource-controller';
import { browserSafetyResourceVisibility, isSafetyResourceDomVisible, isSafetyResourceQuestionSlotReady } from './safety-resource-visibility';
import './onboarding.css';
import './safety-resource.css';

function ResourceCard({ view, controller }: { view: SafetyResourceCardView; controller: SafetyResourceController }) {
  const body = useRef<HTMLElement | null>(null), question = useRef<HTMLParagraphElement | null>(null);
  const [outside, setOutside] = useState(false);
  const state = view.state, target = useMemo(() => ({ sourceKind: state.sourceKind, publicationId: state.publicationId }), [state.sourceKind, state.publicationId]);
  useLayoutEffect(() => {
    const bodyNode = body.current, questionNode = question.current;
    if (!view.projection || !bodyNode || !questionNode) return;
    return controller.attach(target, {
      bodyConnected: () => isSafetyResourceDomVisible(bodyNode, browserSafetyResourceVisibility),
      questionConnected: () => isSafetyResourceQuestionSlotReady(bodyNode, questionNode, browserSafetyResourceVisibility),
      writeQuestion(text) { questionNode.textContent = text; },
      clearQuestion() { questionNode.textContent = ''; },
    });
  }, [controller, target, view.projection?.bodyProjectionId]);
  const projection = view.projection, card = projection?.body.resourceCard;
  return <article className="onboarding-safety-message" ref={body}>
    <div className="onboarding-speaker">你的主理人<span className="onboarding-ai">AI</span></div>
    {projection && card && <>
      <p className="onboarding-bubble">{projection.body.text}</p>
      {/* The controller writes one live grant into this empty connected slot. No question enters React state. */}
      <p ref={question} className="onboarding-bubble onboarding-safety-question" aria-live="polite" />
      <section className="onboarding-resource-card" role="region" aria-label="求助资源"><h2>{card.title}</h2>
        {card.contacts.map(contact => <div className="onboarding-contact" key={contact.id}>
          <h3>{contact.name}</h3><p>{contact.description}</p>
          <div className="onboarding-choices">{contact.actions.map(action => <a key={action.kind} href={safetyResourceHref(action)}
            {...(action.kind === 'web' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{action.label}</a>)}</div>
        </div>)}
        <p>{card.schoolUnknown}</p><p>{card.footer}</p>
        <button type="button" className="onboarding-link" aria-expanded={outside} onClick={() => setOutside(value => !value)}>{card.outsideUs.label}</button>
        {outside && <p>{card.outsideUs.text}</p>}
      </section>
    </>}
    {state.status === 'expired' && <div><p>这份资源的展示期限已到，可以请求重新确认一份资源。</p>
      <button type="button" className="onboarding-link" disabled={view.busy} onClick={() => void controller.recover({ kind: state.sourceKind, submissionId: state.submissionId })}>{view.recoveryUncertain ? '重试这次资源恢复' : '重新确认支持资源'}</button></div>}
    {state.status === 'ready' && <button type="button" className="onboarding-link" disabled={view.busy}
      onClick={() => void controller.redisplay(target)}>{projection ? '重新展示这张资源卡' : '展示支持资源'}</button>}
    {projection && !state.handled && <div className="onboarding-followup-buttons">
      {!view.canContinue ? <button type="button" disabled={view.busy || !view.canAcknowledge} onClick={() => void controller.acknowledge(target)}>我收到了这些支持资源</button>
        : <>
          <button type="button" disabled={view.busy} onClick={() => void controller.continue(target)}>{state.sourceKind === 'onboarding' ? '我想继续刚才的问题' : '我想继续起名'}</button>
          <button type="button" disabled={view.busy} onClick={() => void controller.continue(target, true)}>我现在安全，刚才只是夸张表达，继续</button>
        </>}
      <button type="button" disabled={view.busy} onClick={() => void controller.needSupport(target)}>我还想找人说说</button>
    </div>}
    {state.handled && <p>好，我们接着来。资源卡留在这里。</p>}
    {view.questionNotice && <p role="status">{view.questionNotice}</p>}
    {view.error && <p role="alert">{view.error}</p>}
  </article>;
}

/** A stable resource-session client keeps this independent of consent/email and onboarding/naming widgets. */
export default function StudentSafetyResources({ refreshVersion, onSourcesChanged, onBlockersChanged }: {
  refreshVersion: number; onSourcesChanged: () => void; onBlockersChanged?: (blocked: boolean) => void;
}) {
  const client = useRequiredPlatformAccountClient(), onChange = useRef(onSourcesChanged); onChange.current = onSourcesChanged;
  const onBlockers = useRef(onBlockersChanged); onBlockers.current = onBlockersChanged;
  const blank: SafetyResourceObservation = { cards: [], publicationRetries: [], pending: 0, unavailable: 0, checking: false, error: '' };
  const [view, setView] = useState({ client, observation: blank });
  const controller = useMemo(() => new SafetyResourceController(client,
    observation => setView({ client, observation }), () => onChange.current(), undefined, blocked => onBlockers.current?.(blocked)), [client]);
  useEffect(() => {
    controller.start(); const resume = () => controller.resume(), recheck = () => controller.recheckDom();
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
    window.addEventListener('scroll', recheck, { passive: true, capture: true }); window.addEventListener('resize', recheck);
    return () => { controller.stop(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', resume);
      window.removeEventListener('scroll', recheck, true); window.removeEventListener('resize', recheck); };
  }, [controller]);
  useEffect(() => { controller.refresh(); }, [controller, refreshVersion]);
  if (!client.isCurrent()) return null;
  const observation = view.client === client ? view.observation : blank;
  if (!observation.cards.length && !observation.publicationRetries.length && !observation.pending && !observation.unavailable && !observation.error) return null;
  return <section className="onboarding-safety student-safety-resources" aria-label="支持资源与继续对话" aria-busy={observation.checking}>
    {observation.cards.map(card => <ResourceCard key={`${card.state.sourceKind}:${card.state.publicationId}`} view={card} controller={controller} />)}
    {observation.pending > 0 && <p role="status">正在确认你刚才的文字。已经显示的支持资源仍可以使用。</p>}
    {observation.unavailable > 0 && <p role="status">有一张支持资源暂时无法确认。你可以继续使用这里已经显示的资源。</p>}
    {observation.publicationRetries.map(source => <div key={`${source.kind}:${source.submissionId}`}>
      <p>这张支持资源还没有确认完成。重新读取不会重复发送；手动重试会保留原来这一次请求。</p>
      <button type="button" className="onboarding-link" disabled={observation.checking} onClick={() => void controller.retryPublication(source)}>重试这次资源请求</button>
    </div>)}
    {observation.error && <p role="alert">{observation.error}</p>}
    <button type="button" className="onboarding-link" disabled={observation.checking} onClick={() => controller.refresh()}>重新读取资源状态</button>
  </section>;
}
