import { useEffect, useMemo, useState } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { CompanionPreviewObserver, type CompanionPreviewObservation } from './companion-preview-api';
import './companion-preview.css';

/** A saved preview is an example of its voice, not a companion birth or a delivered chat message. */
export function CompanionPreviewContent({ observation, refresh }: { observation: CompanionPreviewObservation; refresh: () => void }) {
  const { entry, checking, error } = observation;
  const working = entry?.kind === 'generation' && entry.hold === null && ['pending', 'running'].includes(entry.status);
  return <section className="companion-preview" aria-label="主理人生成与预览" aria-busy={checking}>
    {entry?.kind === 'preview' ? <>
      <div className="companion-preview-heading"><span className="companion-preview-seal" data-ink={entry.preview.inkToken} aria-hidden="true" /><div><h2>这是会陪你走完这段路的主理人。</h2><span className="onboarding-ai">AI · 性格预览</span></div></div>
      <p className="companion-preview-summary">{entry.preview.summary}</p>
      <div className="companion-preview-samples" aria-label="说话方式示例">{entry.preview.samples.map((sample, index) => <p key={index}>{sample}</p>)}</div>
      {entry.preview.generatedBy === 'fallback' && <p className="companion-preview-provenance">根据你的回答，用规则生成。</p>}
      <p className="companion-preview-next">预览已保存。起名、换一种感觉和刻章暂时还没有开放，你可以稍后回来继续。</p>
    </> : <div className="companion-preview-status">
      {working && <span className="companion-preview-seal companion-preview-seal-generating" aria-hidden="true" />}
      <p role="status">{!entry ? '正在确认生成进度…' : entry.kind === 'intake_required' ? '请先完成认识你的这几问。'
        : entry.kind === 'not_prepared' ? entry.generationAvailable ? checking ? '正在保存生成任务…' : '认识你的这几问已经保存好了。' : '服务暂时不可用。你的回答已经保存，可以稍后回来继续。'
        : entry.hold === 'authorization_required' ? '这项任务的授权已失效，暂时不能继续生成。你的回答已经保存。'
        : entry.hold === 'configuration_unavailable' ? '服务暂时不可用。任务和你的回答已经保存，可以稍后重新读取进度。'
        : entry.hold === 'requires_review' ? '这项任务暂时需要核实，不能继续生成。你的回答已经保存，可以重新读取进度。'
        : entry.status === 'pending' ? '任务已保存，等待生成。'
        : entry.status === 'running' ? '正在生成……'
        : entry.status === 'uncertain' ? '这次生成的结果还在核实，暂时不会重复请求。你的回答已经保存。'
        : entry.status === 'interrupted' ? '生成中断了。你的回答已经保存，可以重新读取进度。'
        : '生成没成功，不是你的问题。你的回答都保存了。'}</p>
      {working && <p>离开页面不会取消已保存的任务。回来时会读取它的进度。</p>}
    </div>}
    {error && <p role="alert" className="companion-preview-notice">{error}</p>}
    <button type="button" className="onboarding-link" disabled={checking} onClick={refresh}>{checking ? '正在确认…' : '重新读取生成进度'}</button>
  </section>;
}

export default function StudentCompanionPreview({ intakeRevision }: { intakeRevision: number }) {
  const client = useRequiredPlatformAccountClient();
  const empty: CompanionPreviewObservation = { entry: null, checking: false, error: '' };
  const [view, setView] = useState({ client, intakeRevision, observation: empty });
  const observer = useMemo(() => new CompanionPreviewObserver(client, intakeRevision,
    observation => setView({ client, intakeRevision, observation })), [client, intakeRevision]);
  useEffect(() => {
    setView({ client, intakeRevision, observation: { entry: null, checking: false, error: '' } }); observer.start();
    const resume = () => observer.resume();
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
    return () => { observer.stop(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', resume); };
  }, [observer, client, intakeRevision]);
  if (!client.isCurrent()) return null;
  const observation = view.client === client && view.intakeRevision === intakeRevision ? view.observation : empty;
  return <CompanionPreviewContent observation={observation} refresh={() => observer.refresh()} />;
}
