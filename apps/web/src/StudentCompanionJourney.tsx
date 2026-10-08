import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { CompanionJourneyController, type CompanionJourneyObservation } from './companion-journey-controller';
import { CompanionNamingController, type CompanionNamingObservation } from './companion-naming-controller';
import { CompanionNameView, CompanionSealView } from './companion-naming-view';
import StudentCompanionPreview, { CompanionPreviewContent } from './StudentCompanionPreview';

const emptyJourney = (): CompanionJourneyObservation => ({ journey: null, selection: null, acceptance: 'idle', checking: false, submitting: false, error: '' });
const emptyNaming = (): CompanionNamingObservation => ({ state: null, accepted: null, acceptance: 'idle', checking: false, submitting: false, error: '' });

/** A saved preview/name/choice is preparation. This view cannot claim a birth,
 * create rooms, skip resource followups or authorize an external action. */
export default function StudentCompanionJourney({ intakeRevision, refreshVersion = 0, supportBlocked = false, onSourcesChanged }: {
  intakeRevision: number; refreshVersion?: number; supportBlocked?: boolean; onSourcesChanged?: () => void;
}) {
  const client = useRequiredPlatformAccountClient();
  const [journeyView, setJourneyView] = useState({ client, observation: emptyJourney() });
  const [namingView, setNamingView] = useState({ client, observation: emptyNaming() });
  const [wantsName, setWantsName] = useState(false), [rawName, setRawName] = useState('');
  const [choice, setChoice] = useState<{ identityRevision: number; char: string } | null>(null);
  const changed = useRef(onSourcesChanged); changed.current = onSourcesChanged;
  const journey = useMemo(() => new CompanionJourneyController(client,
    observation => setJourneyView({ client, observation })), [client]);
  const naming = useMemo(() => new CompanionNamingController(client,
    observation => setNamingView({ client, observation })), [client]);
  const refresh = useCallback(() => { journey.refresh(); naming.refresh(); }, [journey, naming]);
  useEffect(() => {
    setJourneyView({ client, observation: emptyJourney() }); setNamingView({ client, observation: emptyNaming() });
    setWantsName(false); setRawName(''); setChoice(null); journey.start(); naming.start();
    const resume = () => { journey.resume(); naming.resume(); };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
    return () => { journey.stop(); naming.stop(); document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume); window.removeEventListener('offline', resume); };
  }, [client, journey, naming]);
  useEffect(() => { journey.refresh(); }, [journey, refreshVersion]);
  const observation = journeyView.client === client ? journeyView.observation : emptyJourney();
  const names = namingView.client === client ? namingView.observation : emptyNaming();
  const state = observation.journey;
  const named = names.state?.kind === 'naming' ? names.state : null;
  const progress = names.accepted?.progress ?? named?.latest ?? null;
  // This dependency is a persisted cursor, not every transport/checking render.
  const cursor = progress ? [progress.submissionId, progress.detection.status, progress.detection.generation,
    progress.application.status, progress.application.identityRevision, progress.resource, progress.hold].join(':') : '';
  useEffect(() => { if (cursor && client.isCurrent()) { journey.refresh(); changed.current?.(); } }, [cursor, client, journey]);
  useEffect(() => client.subscribe(() => { if (!client.isCurrent()) { setRawName(''); setWantsName(false); setChoice(null); } }), [client]);
  if (!client.isCurrent()) return null;
  if (!state || state.kind === 'not_started') return <>
    {state?.kind === 'not_started' && <StudentCompanionPreview intakeRevision={intakeRevision} onPreviewReady={refresh} />}
    {observation.error && <p className="onboarding-notice" role="alert">{observation.error}</p>}
    <button type="button" className="onboarding-link" disabled={observation.checking} onClick={refresh}>重新读取准备进度</button>
  </>;
  const identity = state.identity, selection = state.selection;
  const effectiveNaming = named && named.entry.taskId === state.taskId
    && (state.naming.kind === 'not_started' || named.entry.revision >= state.naming.entry.revision) ? named : state.naming;
  const pendingName = names.submitting || names.acceptance === 'unknown' || !!progress && progress.hold === null
    && (['queued', 'checking'].includes(progress.phase) || progress.detection.level === 'L0' && progress.application.status === 'pending');
  const currentIdentity = !!identity && state.stage !== 'naming'
    && (effectiveNaming.kind === 'not_started' || effectiveNaming.latest?.application.identityRevision === identity.revision);
  const selected = identity && choice?.identityRevision === identity.revision ? choice.char : selection?.selectedSeal ?? null;
  const category = progress?.application.rejectedCategory;
  // A current authenticated persisted operation can restore the explicit
  // preparation button after refresh. It cannot replace an unresolved local
  // submission or grant permission to execute the original operation.
  const resumeOperationId = names.accepted?.acceptance.operation.id
    ?? (names.acceptance === 'idle' ? state.latestNamingOperationId : null);
  const ownPending = names.accepted?.progress ?? (names.acceptance === 'idle' && resumeOperationId
    && state.naming.kind === 'naming' ? state.naming.latest : null);
  const canResume = !!ownPending && ownPending.detection.status === 'detected' && ownPending.detection.level === 'L0'
    && ownPending.detection.mode === 'full' && ownPending.application.status === 'pending'
    && ownPending.hold !== 'authorization_required';
  return <section aria-label="主理人起名与印章">
    {state.preview && <CompanionPreviewContent observation={{ entry: { kind: 'preview', preview: state.preview },
      checking: observation.checking, error: '' }} refresh={refresh}
      onChooseName={state.stage === 'preview' && !wantsName ? () => setWantsName(true) : undefined} />}
    {(wantsName || state.stage === 'naming') && !currentIdentity && <CompanionNameView value={rawName}
      pending={pendingName} available={!supportBlocked && names.acceptance !== 'unknown'}
      unavailableText={supportBlocked ? '请先完成支持资源和文字的确认，再继续起名。' : undefined} issue={category ? { category } : undefined}
      error={names.error} onChange={setRawName} onSubmit={name => {
        if (naming.submit({ taskId: state.taskId, expectedEntryRevision: effectiveNaming.kind === 'naming' ? effectiveNaming.entry.revision : 0,
          expectedIdentityRevision: identity?.revision ?? 0, name })) setRawName('');
      }} />}
    {names.submitting || names.acceptance === 'unknown' ? <p role="status" className="onboarding-notice">
      {names.submitting ? '正在发送这个名字，保存结果还没有确认。'
        : '这次名字提交的保存结果还没有确认。请重新读取原提交记录。'}
    </p> : progress && (pendingName || progress.hold || progress.detection.level && progress.detection.level !== 'L0') && <p role="status" className="onboarding-notice">
      {progress.hold === 'authorization_required' ? '这次提交的授权已失效。保存的进度还在，但暂时不能继续处理。'
        : progress.hold ? '名字已经保存，处理暂时无法继续。可以重新读取进度。'
        : progress.detection.level && progress.detection.level !== 'L0' ? '先看看支持资源。想继续起名时，请在资源卡里确认。'
        : '名字已经保存，正在确认。离开页面后，已保存的任务仍会继续。'}
    </p>}
    {canResume && resumeOperationId && <button type="button" className="onboarding-link" disabled={supportBlocked || observation.submitting || observation.acceptance === 'unknown'}
      onClick={() => journey.resumePreparation(resumeOperationId)}>继续准备这个名字的印章</button>}
    {currentIdentity && identity && state.stage === 'seal_ready' && <CompanionSealView name={identity.name}
      candidates={identity.sealCandidates} inkToken={identity.inkToken} selectedChar={selected}
      pending={observation.submitting} available={!supportBlocked && observation.acceptance !== 'unknown'}
      unavailableText={supportBlocked ? '请先完成支持资源和文字的确认，再选择印章。' : undefined} error={observation.error}
      onChange={char => setChoice({ identityRevision: identity.revision, char })}
      onConfirm={sealChar => journey.select({ taskId: state.taskId, expectedIdentityRevision: identity.revision,
        expectedRevision: selection?.revision ?? 0, sealChar })} />}
    {currentIdentity && identity && state.stage === 'seal_saved' && selection?.selectedSeal && <section className="companion-naming" aria-label="已保存的名字与印章">
      <span className="companion-naming-ai">你的主理人 · AI</span><h2>{identity.name}</h2>
      <span className="companion-naming-seal" data-ink={identity.inkToken} aria-hidden="true"><span>{selection.selectedSeal}</span></span>
      <p role="status">名字和印章字已经保存。诞生这一步尚未开放，之后可以从这里继续。</p>
    </section>}
    {observation.error && state.stage !== 'seal_ready' && <p role="alert" className="onboarding-notice">{observation.error}</p>}
    <button type="button" className="onboarding-link" disabled={observation.checking || observation.submitting || names.submitting}
      onClick={refresh}>重新读取准备进度</button>
  </section>;
}
