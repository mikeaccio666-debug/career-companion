import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingAction, OnboardingAnswerSummary, OnboardingEntryState, OnboardingFollowupAction, OnboardingFollowupCommand,
  OnboardingFollowupState, OnboardingQuestionValues, OnboardingRoleFamily, OnboardingSafetyPublication } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { readOnboardingEntry, readOnboardingFollowup, retryOnboardingSafety, saveOnboardingDraft, saveOnboardingFollowup, onboardingResourceHref } from './onboarding-api';
import { acknowledgeOnboardingPresentation, onboardingContinuationAvailable, onboardingDraftCommand, replaceOnboardingPresentation, type OnboardingPresentation } from './onboarding-ui';
import type { User } from './types';
import './onboarding.css';

const name = '你的主理人 · 还没有名字';

export function OnboardingAnsweredHistory({ summaries }: { summaries: readonly OnboardingAnswerSummary[] }) {
  // Fast track never asks O3/O4. Keep its server history intact without presenting unasked questions.
  const visible = summaries.filter(summary => !(summary.kind === 'skipped' && summary.reason === 'fast_track'));
  if (!visible.length) return null;
  const explanations = { user: '你选择跳过了这一问。', fast_track: '快速通道略过了这一问，没有推断你的答案。',
    remaining: '你选择跳过剩下的情境题，没有推断你的答案。', unmatched_text: '你这段文字没有对应到选项，这一问暂未作答。' } as const;
  return <section className="onboarding-history" aria-label="之前的回答">
    {visible.map(summary => <details className="onboarding-answer-summary" key={summary.questionId}><summary>{summary.label}</summary><p>{summary.prompt}</p>{summary.kind === 'skipped' && <p>{explanations[summary.reason]}</p>}</details>)}
  </section>;
}

/** Available independently of current legal consent. All resources are the reviewed server projection. */
export function OnboardingSafetyResources({ onChange }: { onChange?: () => void }) {
  const client = useRequiredPlatformAccountClient();
  const [followup, setFollowup] = useState<OnboardingFollowupState | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [presentations, setPresentations] = useState<Record<string, OnboardingPresentation>>({});
  const [outside, setOutside] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const live = useRef(true), busy = useRef(false), controller = useRef<AbortController | null>(null);
  const attempted = useRef(new Set<string>()), currentFollowup = useRef(followup); currentFollowup.current = followup;
  const changed = useRef(onChange); changed.current = onChange;
  const current = (signal: AbortSignal) => live.current && !signal.aborted && client.isCurrent();
  const reload = useCallback(async () => {
    if (!live.current || busy.current || !client.isCurrent()) return;
    busy.current = true; setPending(true); setError(''); const request = new AbortController(); controller.current = request;
    try { const state = await readOnboardingFollowup(client, request.signal); if (live.current && !request.signal.aborted && client.isCurrent()) setFollowup(state); }
    catch { if (live.current && !request.signal.aborted && client.isCurrent()) setError('支持资源暂时无法读取，可以稍后重新读取。'); }
    finally { if (controller.current === request) { busy.current = false; controller.current = null; if (live.current && !request.signal.aborted && client.isCurrent()) setPending(false); } }
  }, [client]);
  useEffect(() => {
    live.current = true; void reload();
    return () => { live.current = false; controller.current?.abort(); controller.current = null; busy.current = false; attempted.current.clear(); };
  }, [client, reload]);
  useEffect(() => client.subscribe(() => { if (!client.isCurrent()) { controller.current?.abort(); setFollowup(null); setPresentations({}); setOutside({}); } }), [client]);
  async function act(publication: OnboardingSafetyPublication, action: OnboardingFollowupAction) {
    const state = currentFollowup.current;
    if (!state?.draft || busy.current || !live.current || !client.isCurrent()) return;
    busy.current = true; setPending(true); setError(''); setNotice('');
    const request = new AbortController(); controller.current = request;
    const command: OnboardingFollowupCommand = { operationId: crypto.randomUUID(), expectedDraftRevision: state.draft.revision, publicationId: publication.publicationId, action };
    try {
      const result = await saveOnboardingFollowup(client, command, request.signal); if (!current(request.signal)) return;
      if (action.kind === 'present') setPresentations(previous => ({ ...previous, [publication.publicationId]: replaceOnboardingPresentation(result.presentationReceipt!) }));
      else if (action.kind === 'acknowledge') setPresentations(previous => {
        const known = previous[publication.publicationId]; if (!known || known.receipt !== action.presentationReceipt) return previous;
        return { ...previous, [publication.publicationId]: acknowledgeOnboardingPresentation(known, action.presentationReceipt) };
      });
      if (result.resumeStatus === 'remaining_safety') setNotice('还有一张支持资源需要你确认，确认后可以继续。');
      else if (result.resumeStatus === 'waiting_for_safety') setNotice('正在确认你刚才的文字，请稍后重新读取进度。');
      else if (result.resumeStatus === 'resumed') setNotice('好，我们接着来。资源卡留在这里。');
      const latest = await readOnboardingFollowup(client, request.signal); if (!current(request.signal)) return;
      setFollowup(latest);
      if (action.kind === 'continue_intake' || action.kind === 'clarify_exaggeration') changed.current?.();
    } catch { if (current(request.signal)) setError('这一步暂时没有确认完成。可以重新读取资源卡；重新展示后，请再确认一次。'); }
    finally { if (controller.current === request) { busy.current = false; controller.current = null; if (current(request.signal)) setPending(false); } }
  }
  // Runs only after the server projection is committed to the rendered tree. This records a client
  // presentation claim, never human reading, user acknowledgment or safety clearance.
  useEffect(() => {
    if (pending || !followup?.draft || !client.isCurrent()) return;
    const publication = followup.publications.find(item => !item.handled && !presentations[item.publicationId] && !attempted.current.has(item.publicationId));
    if (!publication) return;
    attempted.current.add(publication.publicationId); void act(publication, { kind: 'present' });
  }, [followup, presentations, pending, client]);
  if (!client.isCurrent()) return null;
  if (!error && !followup?.publications.length && !followup?.pendingResponses.length) return null;
  return <section className="onboarding-safety" aria-label="支持资源与继续对话">
    {followup?.publications.map(publication => {
      const presentation = presentations[publication.publicationId], ready = onboardingContinuationAvailable(publication, presentation);
      const response = publication.response, card = response.resourceCard;
      return <div className="onboarding-safety-message" key={publication.publicationId}>
        <div className="onboarding-speaker">{name}<span className="onboarding-ai">AI</span></div>
        <p className="onboarding-bubble">{response.text}</p>{response.question && <p className="onboarding-bubble">{response.question}</p>}
        <section className="onboarding-resource-card" role="region" aria-label="求助资源"><h2>{card.title}</h2>
          {card.contacts.map(contact => <div className="onboarding-contact" key={contact.id}><h3>{contact.name}</h3><p>{contact.description}</p><div className="onboarding-choices">{contact.actions.map(action => <a key={action.kind} href={onboardingResourceHref(action)} {...(action.kind === 'web' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{action.label}</a>)}</div></div>)}
          <p>{card.schoolUnknown}</p><p>{card.footer}</p><button type="button" className="onboarding-link" aria-expanded={!!outside[publication.publicationId]} onClick={() => setOutside(previous => ({ ...previous, [publication.publicationId]: !previous[publication.publicationId] }))}>{card.outsideUs.label}</button>
          {outside[publication.publicationId] && <p>{card.outsideUs.text}</p>}
        </section>
        {!publication.handled && <div className="onboarding-followup-buttons">
          {!ready ? <button type="button" disabled={pending || !presentation} onClick={() => { if (presentation) void act(publication, { kind: 'acknowledge', presentationReceipt: presentation.receipt }); }}>我收到了这些支持资源</button> : <>
            <button type="button" disabled={pending} onClick={() => void act(publication, { kind: 'continue_intake', presentationReceipt: presentation!.receipt })}>我想继续刚才的问题</button>
            <button type="button" disabled={pending} onClick={() => void act(publication, { kind: 'clarify_exaggeration', presentationReceipt: presentation!.receipt, safe: true, exaggeration: true })}>我现在安全，刚才只是夸张表达，继续</button>
          </>}
          <button type="button" disabled={pending} onClick={() => void act(publication, { kind: 'need_support' })}>先看看支持资源</button>
        </div>}
      </div>;
    })}
    {!!followup?.pendingResponses.length && <p role="status">支持资源正在准备，暂时停在这里。可以重新读取，查看已准备好的内容。</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <button className="onboarding-link" type="button" disabled={pending} onClick={() => { attempted.current.clear(); void reload(); }}>{pending ? '正在确认…' : '重新读取支持资源'}</button>
  </section>;
}

function QuestionChoices({ entry, disabled, answer }: { entry: OnboardingEntryState; disabled: boolean; answer: (action: OnboardingAction) => void }) {
  const question = entry.question!, [program, setProgram] = useState<OnboardingQuestionValues['study']['programChoice']>(null);
  const [month, setMonth] = useState(''), [graduated, setGraduated] = useState(false), [roles, setRoles] = useState<OnboardingQuestionValues['roles']>({ kind: 'selected', roles: [] });
  if (question.questionId === 'study') return <div className="onboarding-answer-panel"><label>学制（可以不选）<select value={program ?? ''} disabled={disabled} onChange={event => setProgram((event.target.value || null) as typeof program)}><option value="">暂时不选</option><option value="12_month">一年制</option><option value="16_month">一年半</option><option value="24_month">两年</option><option value="other">其他</option></select></label><div className="onboarding-choices">{question.choices.map(choice => <button key={choice.value} type="button" disabled={disabled} onClick={() => answer({ kind: 'answer', questionId: 'study', value: { degreeField: choice.value as OnboardingQuestionValues['study']['degreeField'], programChoice: program } })}>{choice.label}</button>)}</div></div>;
  if (question.questionId === 'graduation') return <form className="onboarding-answer-panel" onSubmit={event => { event.preventDefault(); if (month) answer({ kind: 'answer', questionId: 'graduation', value: { month, graduated } }); }}><label>毕业月份<input type="month" value={month} disabled={disabled} onChange={event => setMonth(event.target.value)} required /></label><label className="onboarding-inline-check"><input type="checkbox" checked={graduated} disabled={disabled} onChange={event => setGraduated(event.target.checked)} />已经毕业</label><button type="submit" disabled={disabled || !month}>记下这个月份</button></form>;
  if (question.questionId === 'roles') return <form className="onboarding-answer-panel" onSubmit={event => { event.preventDefault(); if (roles.kind === 'undecided' || roles.roles.length) answer({ kind: 'answer', questionId: 'roles', value: roles }); }}><div className="onboarding-choices">{question.choices.map(choice => {
    const selected = roles.kind === 'undecided' ? choice.value === 'undecided' : roles.roles.includes(choice.value as never);
    return <button type="button" aria-pressed={selected} disabled={disabled} key={choice.value} onClick={() => {
      if (choice.value === 'undecided') setRoles({ kind: 'undecided' });
      else { const prior = roles.kind === 'selected' ? roles.roles : [], value = choice.value as OnboardingRoleFamily; setRoles({ kind: 'selected', roles: selected ? prior.filter(role => role !== value) : [...prior, value] }); }
    }}>{choice.label}</button>;
  })}</div><button type="submit" disabled={disabled || roles.kind === 'selected' && !roles.roles.length}>记下这些方向</button></form>;
  if (question.questionId === 'extra') return null;
  return <div className="onboarding-choices">{question.choices.map(choice => <button type="button" key={choice.value} disabled={disabled} onClick={() => answer({ kind: 'answer', questionId: question.questionId, value: choice.value } as OnboardingAction)}>{choice.label}</button>)}</div>;
}

export default function StudentOnboarding({ user, onLogout }: { user: User; onLogout: () => void }) {
  const client = useRequiredPlatformAccountClient();
  const [entry, setEntry] = useState<OnboardingEntryState | null>(null), [pending, setPending] = useState(false), [text, setText] = useState(''), [error, setError] = useState(''), [about, setAbout] = useState(false);
  const [resourcesVersion, setResourcesVersion] = useState(0);
  const live = useRef(true), busy = useRef(false), controller = useRef<AbortController | null>(null), entryRef = useRef(entry); entryRef.current = entry;
  const current = (signal: AbortSignal) => live.current && !signal.aborted && client.isCurrent();
  const reload = useCallback(async () => {
    if (!live.current || busy.current || !client.isCurrent()) return;
    busy.current = true; setPending(true); setError(''); const request = new AbortController(); controller.current = request;
    try { const next = await readOnboardingEntry(client, request.signal); if (live.current && !request.signal.aborted && client.isCurrent()) setEntry(next); }
    catch { if (live.current && !request.signal.aborted && client.isCurrent()) setError('初见进度暂时无法读取，请稍后重试。'); }
    finally { if (controller.current === request) { busy.current = false; controller.current = null; if (live.current && !request.signal.aborted && client.isCurrent()) setPending(false); } }
  }, [client]);
  useEffect(() => { live.current = true; void reload(); return () => { live.current = false; controller.current?.abort(); controller.current = null; busy.current = false; }; }, [client, reload]);
  useEffect(() => client.subscribe(() => { if (!client.isCurrent()) { controller.current?.abort(); setEntry(null); setText(''); } }), [client]);
  async function save(action: OnboardingAction) {
    const state = entryRef.current; if (!state || !state.draft && action.kind !== 'start' || busy.current || !live.current || !client.isCurrent()) return;
    if (action.kind === 'text' && !state.freeTextAvailable) return;
    busy.current = true; setPending(true); setError(''); const request = new AbortController(); controller.current = request;
    try {
      const result = await saveOnboardingDraft(client, onboardingDraftCommand(state, action, crypto.randomUUID()), request.signal); if (!current(request.signal)) return;
      setEntry({ ...state, draft: result.draft, question: null }); if (action.kind === 'text') setText('');
      const next = action.kind === 'text' ? await retryOnboardingSafety(client, request.signal) : await readOnboardingEntry(client, request.signal);
      if (!current(request.signal)) return; setEntry(next); setResourcesVersion(version => version + 1);
    } catch { if (current(request.signal)) { setError('这一步暂时没有确认完成。请重新读取进度后继续。'); setResourcesVersion(version => version + 1); } }
    finally { if (controller.current === request) { busy.current = false; controller.current = null; if (current(request.signal)) setPending(false); } }
  }
  async function retry() {
    if (busy.current || !live.current || !client.isCurrent()) return;
    busy.current = true; setPending(true); setError(''); const request = new AbortController(); controller.current = request;
    try { const next = await retryOnboardingSafety(client, request.signal); if (current(request.signal)) { setEntry(next); setResourcesVersion(version => version + 1); } }
    catch { if (current(request.signal)) setError('文字暂时还没有确认，可以稍后再试。'); }
    finally { if (controller.current === request) { busy.current = false; controller.current = null; if (current(request.signal)) setPending(false); } }
  }
  const draft = entry?.draft, collecting = !!entry && (!draft || draft.state === 'collecting') && entry.safety.status === 'clear';
  if (!client.isCurrent()) return null;
  return <main className="onboarding-page"><header className="onboarding-room-header"><div className="onboarding-empty-seal" aria-hidden="true" /><div><h1>{name}</h1><span className="onboarding-ai">AI</span></div><button type="button" className="onboarding-link" onClick={onLogout}>退出</button></header>
    <section className="onboarding-conversation" aria-label="初见对话">
      {entry && (!draft || draft.step === 'O1') && <><p className="onboarding-bubble">你好，{user.name || '你'}。我会是你的求职主理人，现在还没有名字和性格。先说清楚：我是 AI。你确认过的事，我才会记住。</p><div className="onboarding-choices"><button type="button" disabled={pending || !collecting} onClick={() => void save({ kind: 'start', mode: 'standard' })}>花 3 分钟认识一下</button><button type="button" disabled={pending || !collecting} onClick={() => void save({ kind: 'start', mode: 'fast_track' })}>赶时间，先开始</button><button type="button" onClick={() => setAbout(!about)} aria-expanded={about}>先说说这是什么</button></div>{about && <p className="onboarding-bubble">我们会从你的处境开始，陪你整理方向、准备材料、练习表达。只有你确认过的内容才会作为经历记下来，对外发出前也会请你确认。</p>}</>}
      {entry && <OnboardingAnsweredHistory summaries={entry.answerSummaries} />}
      {draft?.step === 'O3' && <p className="onboarding-question-progress">情境题 {Number(draft.currentQuestion?.slice(1))} / 7</p>}
      {entry?.question && draft?.step !== 'O1' && <section key={`${draft?.id}:${entry.question.questionId}`} aria-label="当前问题"><p className="onboarding-bubble">{entry.question.prompt}</p><QuestionChoices key={entry.question.questionId} entry={entry} disabled={pending || !collecting} answer={action => void save(action)} /><div className="onboarding-choices"><button type="button" disabled={pending || !collecting} onClick={() => void save({ kind: 'skip', questionId: entry.question!.questionId })}>跳过这一问</button>{draft?.step === 'O3' && <button type="button" disabled={pending || !collecting} onClick={() => void save({ kind: 'skip_remaining' })}>剩下的跳过，先用默认</button>}</div></section>}
      {draft?.state === 'safety_pending' && <div className="onboarding-wait"><p role="status">你的文字已保存，正在确认。确认完成后会从刚才的问题继续。</p><button type="button" disabled={pending} onClick={() => void retry()}>重新确认这段文字</button></div>}
      <OnboardingSafetyResources key={resourcesVersion} onChange={() => void reload()} />
      {draft?.state === 'intake_ready' && <div className="onboarding-wait"><p role="status">认识你的这几问已经保存好了。</p><p>主理人的生成与预览还没有开放。你可以稍后回来，进度会从这里继续。</p></div>}
      {error && <p role="alert" className="onboarding-notice">{error}</p>}{pending && <p role="status">正在确认进度…</p>}
      {collecting && entry?.question && <form className="onboarding-composer" onSubmit={event => { event.preventDefault(); if (text.trim()) void save({ kind: 'text', questionId: entry.question!.questionId, text }); }}><label htmlFor="onboarding-text">也可以用自己的话说</label><textarea id="onboarding-text" value={text} maxLength={4000} disabled={pending || !entry.freeTextAvailable} onChange={event => setText(event.target.value)} placeholder={entry.freeTextAvailable ? '写给还没有名字的主理人…' : '暂时不能发送文字，可以用选项或跳过'} /><button type="submit" disabled={pending || !entry.freeTextAvailable || !text.trim()}>发送</button>{!entry.freeTextAvailable && <p>暂时不能发送文字，可以用选项或跳过。</p>}</form>}
      <button type="button" className="onboarding-link" disabled={pending} onClick={() => void reload()}>重新读取进度</button>
    </section>
  </main>;
}
