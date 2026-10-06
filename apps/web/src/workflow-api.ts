import type { WorkflowTemplate, WorkflowTemplateInput } from '@companion/platform-contracts';
import { collection, entity, post, remove, request } from './api.ts';

export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  return collection<WorkflowTemplate>(await request('/workflow-templates'), 'templates');
}
export async function saveWorkflowTemplate(input: WorkflowTemplateInput, current?: Pick<WorkflowTemplate, 'id' | 'revision'>): Promise<WorkflowTemplate> {
  const data = current
    ? await request(`/workflow-templates/${encodeURIComponent(current.id)}`, { method: 'PUT', body: JSON.stringify({ ...input, revision: current.revision }) })
    : await post('/workflow-templates', input);
  const template = entity<WorkflowTemplate>(data, 'template');
  if (!template?.id || !Number.isInteger(template.revision)) throw new Error('服务没有返回完整的已保存流程，请重新加载列表确认。');
  return template;
}
export const deleteWorkflowTemplate = (id: string) => remove(`/workflow-templates/${encodeURIComponent(id)}`);
