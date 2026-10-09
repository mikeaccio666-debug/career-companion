import {StudentPageNavigation} from './app/StudentPageNavigation';
import { useEffect, useMemo, useState } from 'react';
import { parseStudentOrgKnowledgePassage, parseStudentOrgMethod, type StudentOrgMethod, type OrgKnowledgeReference, type StudentOrgKnowledgePassage } from '@companion/platform-contracts';
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
export function OrgSourceScene({ snapshot, onRetry, onExpandMethod, onCollapseMethod }: { snapshot: OrgSourceSnapshot; onRetry: () => void; onExpandMethod?: () => void; onCollapseMethod?: () => void }) {
  const passage = snapshot.state === 'ready' && snapshot.passage ? parseStudentOrgKnowledgePassage(snapshot.passage) : null;
  const details = snapshot.details ?? { state: 'closed', method: null };
  return <section className="career-source-panel" aria-labelledby="career-source-heading" aria-busy={snapshot.state === 'loading'}>
    <h1 id="career-source-heading">{passage ? passage.title : '查看出处'}</h1>
    {passage ? <article className="career-source-excerpt" aria-label="本次引用的原始段落">
      <p className="career-source-meta"><span className="career-source-tag">{passage.provenanceLabel}</span>
        <span>收录于 <time dateTime={passage.updatedAt}>{passage.updatedAt.slice(0, 7)}</time></span></p>
      <p className="career-source-kind">{passage.assetClass === 'question' ? '本次引用的题目或评分依据' : '本次引用的方法依据 · 真人导师整理'}</p>
      {passage.older && <p className="career-source-note">这是历史方法版本；查看它不会自动更新已有计划。</p>}
      <blockquote>{passage.text}</blockquote>
      <p className="career-source-note">这里只展示本次引用的段落。它是参考资料，不代表你的经历或求职结果。</p>
      <button type="button" onClick={onRetry}>重新核对出处</button>
      {passage.assetClass === 'method_card' && <div className="career-method-disclosure">
        <button type="button" aria-expanded={details.state !== 'closed'} aria-controls="career-method-content"
          disabled={!onExpandMethod || !onCollapseMethod} onClick={details.state === 'closed' ? onExpandMethod : onCollapseMethod}>
          {details.state === 'closed' ? '查看适用条件与完整方法' : '收起完整方法'}
        </button>
        <section id="career-method-content" hidden={details.state === 'closed'} aria-busy={details.state === 'loading'}>
          {details.state === 'closed' ? null : details.state === 'ready' && details.method ? <OrgMethodDetails method={details.method} /> : <>
            <p role="status">{details.state === 'loading' ? '正在核对完整方法…' : details.state === 'limited' ? '这份资料目前只开放摘录，完整方法尚未授权展示。' : '完整方法暂时没接上，可以再试一次。'}</p>
            {['limited', 'unavailable'].includes(details.state) && <button type="button" onClick={onExpandMethod}>重新核对完整方法</button>}
          </>}
        </section>
      </div>}
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
  return <OrgSourceScene snapshot={state} onRetry={() => void controller.refresh()} onExpandMethod={() => void controller.expandMethod()} onCollapseMethod={() => controller.closeMethod()} />;
}
export function OrgSourcePage({ reference, onLogout }: { reference: OrgKnowledgeReference | null; onLogout: () => void }) {
  return <main className="career-source-page career-surface"><StudentPageNavigation aria-label="出处导航"><a href="/">回到对话</a><button type="button" onClick={onLogout}>退出登录</button></StudentPageNavigation>
    <p className="career-source-ai">AI 主理人和队伍 · 看依据</p>
    {reference ? <OrgSourcePanel reference={reference} /> : <section className="career-source-panel"><h1>查看出处</h1><p>这个出处地址不完整。请回到对话，重新打开依据。</p></section>}
  </main>;
}

const methodRoleLabels: Record<string, string> = { swe: '软件工程', mle: '机器学习工程', ds: '数据科学', da: '数据／业务分析', de: '数据工程', hw: '硬件工程', other: '其他方向' };
const methodLabels: Record<string, string> = { 'profile': '个人背景', 'project-facts': '项目事实', 'target-role': '目标岗位', 'target-job': '目标职位',
  'current-jobs': '当前岗位记录', 'knowledge': '参考资料', 'skill-gaps': '技能缺口', 'conversation-goal': '交流目标', 'confirmed-profile': '已确认的个人背景',
  'reviewed-resume': '已审核简历', 'resume-source': '简历原稿', 'target-direction': '职业方向', contact: '联系人',
  preparation: '准备阶段', interview: '面试阶段', application: '投递阶段', preparing: '准备中', course_project: '课程项目', new_grad: '应届求职', intern: '实习求职' };
const methodLabel = (value: string) => methodLabels[value] ?? value.replaceAll('_', ' ').replaceAll('-', ' ');
export function OrgMethodDetails({ method }: { method: StudentOrgMethod }) {
  const checked = parseStudentOrgMethod(method), content = checked.content;
  const list = (title: string, values: readonly string[]) => values.length > 0 && <section><h3>{title}</h3><ul>{values.map((value, i) => <li key={i}>{value}</li>)}</ul></section>;
  return <div className="career-method-details">
    <h2>适用条件与完整方法</h2><p>{content.whenToUse}</p>
    <p className="career-source-note">{checked.provenanceLabel} · 依据性质：{content.evidenceNature}</p>
    <dl className="career-method-conditions">
      <dt>适用岗位</dt><dd>{content.appliesTo.role_families.map(role => methodRoleLabels[role]).join('、')}</dd>
      <dt>适用阶段</dt><dd>{content.appliesTo.stages.length ? content.appliesTo.stages.map(methodLabel).join('、') : '资料未单列阶段'}</dd>
      <dt>适用情境</dt><dd>{content.appliesTo.situations.length ? content.appliesTo.situations.map(methodLabel).join('、') : '资料未单列情境'}</dd>
      <dt>准备条件</dt><dd>{content.prerequisites.length ? content.prerequisites.map(methodLabel).join('、') : '资料未单列准备条件'}</dd>
    </dl>
    <h3>怎么做</h3><ol className="career-method-steps">{content.steps.map((step, i) => <li key={i}>
      <h4>{step.goal}</h4><p>{step.method}</p><p><strong>这一步的产出：</strong>{step.output}</p>
    </li>)}</ol>
    {list('什么时候可以停下', content.stopWhen)}
    {list('哪些情况不适用', content.counterexamples)}
    {list('什么时候需要真人帮助', content.escalateWhen)}
    <p className="career-source-note">这是方法参考，不代表你的经历、能力或求职结果。查看方法不会自动修改你的计划。</p>
  </div>;
}
