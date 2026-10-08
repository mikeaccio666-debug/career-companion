import { useEffect, useMemo, useState } from 'react';
import { parseStudentOrgKnowledgePassage, type OrgKnowledgeReference, type StudentOrgKnowledgePassage } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { orgSourcePath } from './org-source-api';
import { OrgSourceController, emptyOrgSource, type OrgSourceSnapshot } from './org-source-controller';
import './career-design-tokens.css';
import './org-source-view.css';
/** Receives an already admitted server passage, never model prose or a label
 * guessed from a URL. Opening the link performs a new permission/version read. */
export function OrgSourceLabel({ passage }: { passage: StudentOrgKnowledgePassage }) {
  const checked = parseStudentOrgKnowledgePassage(passage);
  return <a className="career-source-link" href={orgSourcePath({ sourceId: checked.sourceId, revision: checked.revision, passageId: checked.passageId })}
    aria-label={'查看出处：' + checked.provenanceLabel + ' · ' + checked.title}><span className="career-source-label">{checked.provenanceLabel}<span aria-hidden="true"> ▸</span></span></a>;
}
const messages: Record<OrgSourceSnapshot['state'], string> = {
  idle: '打开后会重新核对这段出处。', loading: '正在读取这段出处…', ready: '',
  stale: '这段出处的版本已变化或内容已撤回。请回到对话，重新查看依据。',
  denied: '你目前无法查看这份内容。请回到对话，使用其他依据。',
  missing: '这段出处已不存在。请回到对话，重新查看依据。',
  unavailable: '这段出处暂时没接上。可以再试一次。',
  account_inactive: '当前登录或资料访问条件已变化。请回到对话重新确认。',
};
export function OrgSourceScene({ snapshot, onRetry }: { snapshot: OrgSourceSnapshot; onRetry: () => void }) {
  const passage = snapshot.state === 'ready' && snapshot.passage ? parseStudentOrgKnowledgePassage(snapshot.passage) : null;
  return <section className="career-source-panel" aria-labelledby="career-source-heading" aria-busy={snapshot.state === 'loading'}>
    <h1 id="career-source-heading">{passage ? passage.title : '查看出处'}</h1>
    {passage ? <article className="career-source-excerpt" aria-label="本次引用的原始段落">
      <p className="career-source-meta"><span className="career-source-tag">{passage.provenanceLabel}</span>
        <span>收录于 <time dateTime={passage.updatedAt}>{passage.updatedAt.slice(0, 7)}</time></span></p>
      <p className="career-source-kind">{passage.assetClass === 'question' ? '本次引用的题目或评分依据' : '本次引用的方法依据 · 真人导师整理'}</p>
      <blockquote>{passage.text}</blockquote>
      <p className="career-source-note">这里只展示本次引用的段落。它是参考资料，不代表你的经历或求职结果。</p>
      <button type="button" onClick={onRetry}>重新核对出处</button>
    </article> : <div className="career-source-message"><p role="status">{messages[snapshot.state]}</p>
      {['unavailable', 'stale', 'denied', 'missing'].includes(snapshot.state) && <button type="button" onClick={onRetry}>再试一次</button>}</div>}
  </section>;
}
export function OrgSourcePanel({ reference }: { reference: OrgKnowledgeReference }) {
  const client = useRequiredPlatformAccountClient();
  const [observed, setObserved] = useState<{ client: typeof client; controller: OrgSourceController; state: OrgSourceSnapshot } | null>(null);
  const controller = useMemo(() => {
    const next = new OrgSourceController(client, reference, state => setObserved({ client, controller: next, state }));
    return next;
  }, [client, reference.sourceId, reference.revision, reference.passageId]);
  useEffect(() => {
    controller.start();
    if (document.visibilityState === 'hidden' || !navigator.onLine) controller.suspend();
    const resume = () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) controller.suspend();
      else void controller.refresh();
    };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
    return () => { controller.stop(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', resume); };
  }, [controller]);
  if (!client.isCurrent()) return null;
  const state = observed?.client === client && observed.controller === controller ? observed.state : emptyOrgSource();
  return <OrgSourceScene snapshot={state} onRetry={() => void controller.refresh()} />;
}
export function OrgSourcePage({ reference, onLogout }: { reference: OrgKnowledgeReference | null; onLogout: () => void }) {
  return <main className="career-source-page career-surface"><nav aria-label="出处导航"><a href="/">回到对话</a><button type="button" onClick={onLogout}>退出登录</button></nav>
    <p className="career-source-ai">AI 主理人和队伍 · 看依据</p>
    {reference ? <OrgSourcePanel reference={reference} /> : <section className="career-source-panel"><h1>查看出处</h1><p>这个出处地址不完整。请回到对话，重新打开依据。</p></section>}
  </main>;
}
