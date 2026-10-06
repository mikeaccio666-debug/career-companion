import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { ClipboardCheck, Loader2, RefreshCw, X } from 'lucide-react';
import { JOB_OUTCOME_REVIEW_NOTE_CHARACTERS, JOB_OUTCOME_REVIEW_OUTCOMES, type JobOutcomeEvidence, type JobOutcomeReviewOutcome, type JobOutcomeReviewReason } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { createJobOutcomeReviewClient, validJobOutcomeReviewNote } from './job-outcome-reviews-api';
import { JobOutcomeReviewController } from './job-outcome-reviews-controller';
import { JOB_OUTCOME_NOT_FOUND_BOUNDARY, JOB_OUTCOME_REVIEW_BOUNDARY, jobOutcomeLabels } from './job-outcome-review-labels';
import './job-outcome-reviews.css';

const stateLabels: Record<string, string> = { needs_approval: '待独立批准', queued: '排队中', running: '执行中', succeeded: '服务器记录成功', failed: '失败', cancelled: '已取消', uncertain: '结果待确认', ready: '尚未执行', started: '已记录开始', completed: '已记录完成', provider_task: '已有供应商任务记录', tool_error: '工具返回错误' };
const reasonLabels: Record<JobOutcomeReviewReason, string> = {
  job_uncertain: '任务执行结果尚未确认', browser_execution_started: '已有浏览器执行记录', browser_checkpoint_missing: '缺少可核对的浏览器检查点', workflow_result_unknown: '工作流步骤结果未确认', workflow_checkpoint_missing: '缺少可核对的工作流检查点', mcp_call_recorded: '已有外部工具调用记录', cli_cleanup_unconfirmed: '终端执行清理尚未确认', model_relay_uncertain: '模型请求结果尚未确认', comfyui_submission_unknown: '图像工作流提交结果尚未确认',
};
function ServerFacts({ facts }: { facts: JobOutcomeEvidence }) {
  return <div className="outcome-server-facts">
    <h5>服务器记录的事实</h5>
    <p>任务版本 {facts.generation} · {stateLabels[facts.status]}。这些事实与下面的个人观察分开保存。</p>
    <dl><div><dt>累计尝试</dt><dd>{facts.totalAttempts}</dd></div><div><dt>供应商任务记录</dt><dd>{facts.hasProviderTask ? '存在；不等同于成功' : '未记录；不证明没有执行'}</dd></div><div><dt>执行清理</dt><dd>{facts.cleanupPending ? '尚未确认，暂不能保存新核对' : '当前未保留任务租约；不代表外部操作或容器已停止'}</dd></div></dl>
    {facts.reasons.length > 0 && <ul>{facts.reasons.map((reason) => <li key={reason}>{reasonLabels[reason]}</li>)}</ul>}
    {facts.attempts.length > 0 && <details><summary>查看本任务版本的尝试记录</summary><ul>{facts.attempts.map((attempt) => <li key={attempt.attempt}>尝试 {attempt.attempt}：{stateLabels[attempt.status]}；{attempt.hasProviderTask ? '有供应商任务记录' : '未记录供应商任务'}</li>)}</ul>{facts.attemptsHasMore && <p>只显示本版本最近 20 次尝试，更早记录未列出。</p>}</details>}
    {facts.browser && <p>浏览器任务检查点：{stateLabels[facts.browser.state]}，动作 {facts.browser.completedActions} / {facts.browser.totalActions}，检查点版本 {facts.browser.revision}。这是任务整体的检查点，可能保留较早尝试完成的动作，不代表当前版本成功。</p>}
    {facts.workflow && <details><summary>查看工作流任务检查点</summary><p>检查点版本 {facts.workflow.revision}。可能保留较早尝试的结果，不代表当前版本整体成功。</p><ul>{facts.workflow.steps.map((step) => <li key={step.index}>步骤 {step.index + 1}：{stateLabels[step.state]}；{step.hasProviderTask ? '有供应商任务记录' : '未记录供应商任务'}</li>)}</ul></details>}
    {facts.mcp && <p>外部工具调用记录属于任务版本 {facts.mcp.generation}：{stateLabels[facts.mcp.status]}；{facts.mcp.hasSavedResult ? '有保存的工具结果' : '没有保存的工具结果'}。调用记录和用户观察都不授予再次调用权限。</p>}
    <details><summary>查看本次事实版本标识</summary><code>{facts.version}</code></details>
  </div>;
}

/** A shared, inline observation form. Saving has no execution or plan-advancement callback. */
export default function JobOutcomeReviewPanel({ jobId, expectedGeneration }: { jobId: string; expectedGeneration?: number }) {
  const account = useRequiredPlatformAccountClient(), formId = useId();
  const api = useMemo(() => createJobOutcomeReviewClient(account.request), [account]);
  const controller = useMemo(() => new JobOutcomeReviewController(api, jobId, expectedGeneration, { isCurrent: account.isCurrent, isOnline: () => navigator.onLine, requestId: () => crypto.randomUUID() }), [api, account, jobId, expectedGeneration]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const entry = useRef<HTMLButtonElement>(null), group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    controller.start();
    const unsubscribe = account.subscribe(() => { if (!account.isCurrent()) controller.stop(); });
    return () => { unsubscribe(); controller.stop(); };
  }, [controller, account]);
  useEffect(() => {
    if (!snapshot.opened || !account.isCurrent()) return;
    group.current?.scrollIntoView({ block: 'nearest' }); group.current?.focus({ preventScroll: true });
  }, [snapshot.opened, account]);
  function close() { controller.close(); if (account.isCurrent()) entry.current?.focus({ preventScroll: true }); }
  if (!account.isCurrent()) return null;
  const page = snapshot.page, historical = page?.requestedGeneration !== page?.currentGeneration;
  const editable = !!page?.writeEligibility.allowed && snapshot.readCurrent && !snapshot.loading && !snapshot.saving && snapshot.phase === 'editing' && !snapshot.pending;
  return <section className="job-outcome-review" aria-label="用户核对未知执行结果">
    <button ref={entry} className="secondary outcome-entry" type="button" aria-expanded={snapshot.opened} aria-controls={`${formId}-panel`} onClick={() => snapshot.opened ? close() : void controller.open()}><ClipboardCheck size={15} />{snapshot.opened ? '收起用户核对' : '核对这次未知结果'}{expectedGeneration ? ` · 任务版本 ${expectedGeneration}` : ''}</button>
    {snapshot.opened && <div id={`${formId}-panel`} ref={group} className="outcome-review-body" role="group" aria-label="用户结果核对表" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="outcome-heading"><h4>{snapshot.generation ? `任务版本 ${snapshot.generation} 的结果核对` : '读取任务版本后核对结果'}</h4><button type="button" className="text-button" aria-label="收起用户核对" onClick={close}><X size={16} /></button></div>
      <p className="outcome-boundary"><strong>个人观察，不是服务器确认成功。</strong>{JOB_OUTCOME_REVIEW_BOUNDARY}</p>
      <div className="outcome-actions"><button type="button" className="secondary" disabled={snapshot.loading || snapshot.saving} onClick={() => void controller.refresh()}><RefreshCw size={14} className={snapshot.loading ? 'spin' : ''} />{snapshot.pending ? '读取记录确认保存' : '读取最新事实与记录'}</button>{snapshot.loading && <span role="status"><Loader2 size={14} className="spin" />正在读取…</span>}</div>
      {snapshot.error && <p className="outcome-warning" role="alert">{snapshot.error}</p>}
      {snapshot.notice && <p className="outcome-notice" role="status">{snapshot.notice}</p>}
      {page && !snapshot.readCurrent && <p className="outcome-warning">下面保留上次读取的内容，不能当作最新事实。请先重新读取，原稿不会发送。</p>}
      {page?.evidence && <ServerFacts facts={page.evidence} />}
      {historical && page && <p className="outcome-warning">这是历史任务版本 {page.requestedGeneration} 的用户核对记录，只读。任务当前版本为 {page.currentGeneration}；这里不展示新版本的执行事实，也不会把原稿转给新版本。</p>}
      {page?.writeEligibility.reason === 'cleanup_pending' && <p className="outcome-warning">执行清理仍待确认，暂不能新增用户核对记录。请稍后明确读取；此处不会取消、清理或重试执行。</p>}
      {page?.writeEligibility.reason === 'not_reviewable' && <p className="outcome-warning">当前服务器事实不允许新增未知结果核对。已有用户记录仍可查看，任务状态不会因此改变。</p>}
      {snapshot.phase === 'save_unconfirmed' && <div className="outcome-warning"><strong>保存状态未确认</strong><p>请求可能已经提交。请用上方按钮读取同一任务版本的记录。即使最近 20 条中未找到，也不证明没有保存；不会自动重发。</p></div>}
      {snapshot.phase === 'conflict' && <div className="outcome-warning"><strong>原核对稿已保留</strong><p>任务版本或核对记录发生变化，不能沿用旧事实直接保存。先读取并审阅上面的最新内容，再明确接受最新事实版本；不会改写已有记录。</p><button type="button" className="secondary" disabled={!snapshot.readCurrent || snapshot.loading || !page?.writeEligibility.allowed || !!snapshot.pending} onClick={controller.acknowledgeConflict}>已核对最新内容，保留原稿继续</button></div>}
      {page && <form onSubmit={(event) => { event.preventDefault(); void controller.save(); }}>
        <fieldset disabled={!editable}><legend>我亲自核对后的观察</legend>{JOB_OUTCOME_REVIEW_OUTCOMES.map((outcome) => <label className="outcome-choice" key={outcome}><input type="radio" name={`${formId}-outcome`} value={outcome} checked={snapshot.outcome === outcome} onChange={() => controller.edit({ outcome: outcome as JobOutcomeReviewOutcome })} /><span>{jobOutcomeLabels[outcome]}</span></label>)}
          {snapshot.outcome === 'no_effect_observed' && <p className="outcome-warning">{JOB_OUTCOME_NOT_FOUND_BOUNDARY}</p>}
          <label className="outcome-note" htmlFor={`${formId}-note`}>核对说明（可选）<textarea id={`${formId}-note`} rows={3} maxLength={JOB_OUTCOME_REVIEW_NOTE_CHARACTERS} value={snapshot.note} onChange={(event) => controller.edit({ note: event.target.value })} placeholder="记录你亲自查看了什么、看到什么；请勿填写密钥、验证码或敏感个人资料。" /></label><small>{snapshot.note.length} / {JOB_OUTCOME_REVIEW_NOTE_CHARACTERS} 字 · {new TextEncoder().encode(snapshot.note).length} / 8192 UTF-8 字节</small>
        </fieldset>
        <div className="outcome-actions"><button type="submit" className="primary" disabled={!editable || !snapshot.outcome || !validJobOutcomeReviewNote(snapshot.note)}>{snapshot.saving ? '正在保存核对记录…' : '保存用户核对记录'}</button>{snapshot.phase === 'saved' && <button type="button" className="secondary" disabled={!snapshot.readCurrent || snapshot.loading || !page.writeEligibility.allowed} onClick={controller.newReport}>新增一条核对记录</button>}</div>
      </form>}
      {page && <div className="outcome-history"><h5>用户核对记录</h5><p>只显示任务版本 {page.requestedGeneration} 最近 20 条记录。每条都是用户观察，未经服务器验证；不改变任务状态。</p>{!page.records.length && <p>这个任务版本还没有用户核对记录。</p>}<ol>{page.records.map((record) => <li key={record.id}><strong>{jobOutcomeLabels[record.outcome]}</strong><span>用户自述 · 未验证 · 核对记录 {record.revision}</span>{record.outcome === 'no_effect_observed' && <p>{JOB_OUTCOME_NOT_FOUND_BOUNDARY}</p>}{record.note && <p>{record.note}</p>}<time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol>{page.hasMore && <p>还有更早的用户记录未列出。这个列表不是完整历史，也不能证明某次请求没有保存。</p>}</div>}
    </div>}
  </section>;
}
