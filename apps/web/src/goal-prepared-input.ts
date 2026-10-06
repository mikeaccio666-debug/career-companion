import { createElement as h, useState, type ReactNode } from 'react';
import type { GoalPlan, GoalPlanInputSource, GoalPlanStep } from '@companion/platform-contracts';
import { goalInputSourceSummary, goalPreparedInputSnapshot } from './goal-plan-inputs.ts';

export interface GoalPreparedInputProps {
  plan: GoalPlan; step: GoalPlanStep; disabled?: boolean;
  onViewSource: (source: GoalPlanInputSource) => void;
  renderAttachmentPreview: (ids: string[]) => ReactNode;
  renderArtifactFileReview?: (source: Extract<GoalPlanInputSource, { source: 'artifact_file' }>) => ReactNode;
}
/** Full frozen input is distinct from the plan template; no source or media is fetched just by rendering. */
export function GoalPreparedInput({ plan, step, disabled = false, onViewSource, renderAttachmentPreview, renderArtifactFileReview }: GoalPreparedInputProps) {
  const [showImages, setShowImages] = useState(false), actual = step.resolvedTask;
  if (!actual) return null;
  const sources = step.inputSources || [], snapshot = goalPreparedInputSnapshot(step);
  const images = ['image', 'video'].includes(actual.kind) ? actual.attachmentIds || [] : [];
  return h('section', { className: 'goal-prepared-input', 'aria-label': `第 ${step.index + 1} 步实际输入与来源` },
    h('h4', null, '准备时固定的实际输入'),
    h('p', { className: 'goal-note' }, '下面是本步实际任务正文与附件，不是未来成果的占位内容。来源只提供输入，不授予权限；执行遵循这份任务自己的审批与记录。'),
    h('strong', null, '实际任务正文'), h('pre', { className: 'goal-effective-prompt' }, actual.prompt),
    images.length ? h('div', null, h('p', { className: 'goal-note' }, `本步实际参考图共 ${images.length} 张。查看账户私有图片不会执行任务。`), h('button', { type: 'button', className: 'secondary', disabled, onClick: () => setShowImages(!showImages) }, showImages ? '收起实际参考图' : '查看本步实际参考图'), showImages ? renderAttachmentPreview(images) : null) : null,
    actual.kind === 'cli' && actual.attachmentIds?.length ? h('p', { className: 'goal-note' }, `本步实际终端输入文件共 ${actual.attachmentIds.length} 个，按固定附件在前、所选成果文件在后的顺序提供给执行器。打开私有文件仅供审阅，不会自动下载或执行终端任务。`) : null,
    sources.length ? h('div', { className: 'goal-prepared-sources' }, h('h4', null, '实际使用的前序来源'), ...sources.map((source, slot) => {
      const prior = plan.steps[source.fromStep], available = prior?.state === 'succeeded';
      return h('article', { key: slot }, h('p', null, goalInputSourceSummary(source)), h('p', { className: 'goal-note' }, `来源步骤：${prior?.input.title || '暂时不可用'}`), h('code', null, `SHA-256 ${source.sha256}`), source.source === 'artifact_file' && available && !disabled ? renderArtifactFileReview?.(source) : null, h('button', { className: 'text-button', type: 'button', disabled: disabled || !available, onClick: () => onViewSource(source) }, source.source === 'analysis_text' ? '在原会话查看来源分析' : '查看来源步骤与精确成果'), !available ? h('p', { className: 'goal-note' }, '来源当前不可用；这里保留准备时的历史记录，不会换用另一份成果。') : null);
    })) : null,
    h('details', null, h('summary', null, '完整实际任务参数与输入记录'), h('pre', null, JSON.stringify({ task: actual, inputSources: sources, ...(snapshot ? { preparation: snapshot } : {}) }, null, 2))));
}
