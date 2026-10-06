import { createElement as h } from 'react';
import type { GoalPlan } from '@companion/platform-contracts';
import { goalBindingRuleSummary } from './goal-plan-bindings.ts';

const kinds: Record<string, string> = { image: '图片', video: '视频', speech: '语音', browser: '浏览器', cli: '终端', workflow: '工作流', mcp: '外部工具' };
/** Complete review surface, shared by the actual confirmation UI and server-rendered boundary tests. */
export function GoalDefinition({ plan }: { plan: Pick<GoalPlan, 'title' | 'goal' | 'steps' | 'revision' | 'definitionHash'> }) {
  return h('div', { className: 'goal-definition' }, h('h3', null, plan.title), h('p', null, plan.goal), h('ol', null, ...plan.steps.map((step) => {
    const input = step.input, analysis = input.kind === 'agent_turn', provider = analysis ? input.provider : input.task.provider, model = analysis ? input.model : input.task.model;
    return h('li', { key: step.index }, h('strong', null, `${step.index + 1}. ${input.title}`), h('span', null, `${analysis ? '分析' : kinds[input.task.kind] || input.task.kind} · ${provider}${model ? ` · ${model}` : ''}`), h('p', null, analysis ? input.instruction : input.task.prompt), analysis ? null : h('div', null, input.bindings ? h('div', { className: 'goal-binding-review' }, h('strong', null, '前序成果使用规则'), ...goalBindingRuleSummary(input.bindings).map((rule) => h('p', { key: rule }, rule)), h('p', null, '这里保存的是使用规则，不代表前序成果已经产生。实际输入在准备本步时固定，再独立审阅实际正文和附件。')) : null, h('details', null, h('summary', null, '完整基础任务参数与固定附件'), h('pre', null, JSON.stringify(input.task, null, 2)))));
  })), h('dl', null, h('div', null, h('dt', null, '计划版本'), h('dd', null, String(plan.revision))), h('div', null, h('dt', null, '审阅定义'), h('dd', null, plan.definitionHash))));
}
