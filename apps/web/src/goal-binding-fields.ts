import { createElement as h, type ChangeEvent } from 'react';
import { CLI_INPUT_MAX_FILES, CLI_INPUT_MAX_FILE_BYTES, CLI_INPUT_MAX_TOTAL_BYTES } from '@companion/platform-contracts';
import { goalArtifactFileTarget, goalArtifactTextSource, goalBindingOptions, goalBindingProblem, goalBindingResultLimit, goalPromptTarget, goalReferenceImageTarget, type GoalBindingStep, type GoalTaskBindings } from './goal-plan-bindings.ts';

export interface GoalBindingFieldsProps {
  steps: readonly GoalBindingStep[]; index: number; bindings?: GoalTaskBindings; attachmentCount: number;
  disabled?: boolean; onChange: (bindings: GoalTaskBindings | undefined) => void;
}
/** Human choices only: no UUIDs, binding JSON, model planning or future-result placeholders. */
export function GoalBindingFields({ steps, index, bindings, attachmentCount, disabled = false, onChange }: GoalBindingFieldsProps) {
  const humanIndex = (value = 0) => value === -1 || !Number.isFinite(value) ? '' : value + 1;
  const resultIndex = (value: string) => value.trim() ? Number(value) - 1 : -1;
  const step = steps[index], promptAllowed = goalPromptTarget(step), imageAllowed = goalReferenceImageTarget(step), fileAllowed = goalArtifactFileTarget(step);
  const problem = goalBindingProblem({ ...step, bindings }, index, steps, attachmentCount), choices = goalBindingOptions(steps, index);
  const images = bindings?.referenceImages || [], priorTasks = steps.slice(0, index).map((source, fromStep) => ({ source, fromStep })).filter(({ source }) => source.kind === 'task');
  const files = bindings?.artifactFiles || [], fileSources = priorTasks.filter(({ source }) => goalArtifactTextSource(source));
  const update = (next: GoalTaskBindings) => onChange(next.prompt || next.referenceImages?.length || next.artifactFiles?.length ? next : undefined);
  const promptValue = bindings?.prompt ? `${bindings.prompt.fromStep}:${bindings.prompt.source}` : '';
  const promptExists = choices.some((choice) => `${choice.fromStep}:${choice.source}` === promptValue);
  return h('section', { className: 'goal-input-bindings', 'aria-label': `第 ${index + 1} 步前序成果绑定` },
    h('h4', null, '使用前序成果'),
    h('p', { className: 'goal-note' }, '只选择这份计划更早的步骤。这里保存使用规则；准备本步时才核对成功成果、固定实际正文、参考图与文件，再由你独立审阅批准。缺少指定成果会停止，不会换用另一份。'),
    problem ? h('p', { className: 'goal-blocked', role: 'alert' }, problem) : null,
    h('label', { className: 'goal-binding-toggle' }, h('input', { type: 'checkbox', checked: !!bindings?.prompt, disabled: disabled || !promptAllowed && !bindings?.prompt, onChange: (event: ChangeEvent<HTMLInputElement>) => update({ ...bindings, prompt: event.target.checked ? { fromStep: -1, source: 'analysis_text', mode: 'append' } : undefined }) }), '将前序文字用于任务正文'),
    !promptAllowed ? h('p', { className: 'goal-note' }, '正文绑定支持图片、视频、语音和终端任务。其他任务的外层要求不是实际执行参数。') : null,
    bindings?.prompt ? h('div', { className: 'goal-binding-row' },
      h('label', null, '文字来源', h('select', { value: promptValue, disabled, 'aria-label': `第 ${index + 1} 步文字来源`, onChange: (event: ChangeEvent<HTMLSelectElement>) => { const choice = choices.find((item) => `${item.fromStep}:${item.source}` === event.target.value); update({ ...bindings, prompt: choice ? { fromStep: choice.fromStep, source: choice.source, mode: bindings.prompt!.mode } : { fromStep: -1, source: 'analysis_text', mode: bindings.prompt!.mode } }); } }, h('option', { value: '' }, '选择前序成果'), !promptExists && promptValue ? h('option', { value: promptValue, disabled: true }, '当前来源不可用，请重新选择') : null, ...choices.map((choice) => h('option', { key: `${choice.fromStep}:${choice.source}`, value: `${choice.fromStep}:${choice.source}` }, choice.label)))),
      bindings.prompt.source === 'artifact_text' ? h('label', null, '第几份文字成果', h('input', { type: 'number', min: 1, max: goalBindingResultLimit, value: humanIndex(bindings.prompt.artifactIndex), disabled, 'aria-label': `第 ${index + 1} 步文字成果序号`, onChange: (event: ChangeEvent<HTMLInputElement>) => update({ ...bindings, prompt: { ...bindings.prompt!, artifactIndex: resultIndex(event.target.value) } }) })) : null,
      h('label', null, '使用方式', h('select', { value: bindings.prompt.mode, disabled, 'aria-label': `第 ${index + 1} 步文字使用方式`, onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ ...bindings, prompt: { ...bindings.prompt!, mode: event.target.value as 'append' | 'replace' } }) }, h('option', { value: 'append' }, '追加到本步要求之后'), h('option', { value: 'replace' }, '使用来源全文作为任务正文'))),
      bindings.prompt.mode === 'replace' ? h('p', { className: 'goal-note' }, '已填写的基础任务要求仍保存在定义里；实际执行正文会使用这份来源全文，不会同时发送基础要求。') : null) : null,
    images.length || imageAllowed ? h('div', { className: 'goal-binding-images' },
      h('p', { className: 'goal-note' }, '参考图按来源成功回执中的 PNG、JPEG、WebP 图片顺序选择，文字成果按可读取文字的顺序选择。第一份的序号是 1；准备前不代表成果已经存在。固定附件与这些参考图合计最多 4 张，服务还可能有更小限制。'),
      ...images.map((image, imageSlot) => h('div', { className: 'goal-binding-row', key: imageSlot },
        h('label', null, `参考图 ${imageSlot + 1} 来源`, h('select', { value: String(image.fromStep), disabled, 'aria-label': `第 ${index + 1} 步参考图 ${imageSlot + 1} 来源`, onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ ...bindings, referenceImages: images.map((entry, slot) => slot === imageSlot ? { fromStep: Number(event.target.value) } : entry) }) }, h('option', { value: '-1' }, '选择前序任务'), !priorTasks.some((entry) => entry.fromStep === image.fromStep) && image.fromStep >= 0 ? h('option', { value: String(image.fromStep), disabled: true }, '当前来源不可用，请重新选择') : null, ...priorTasks.map(({ source, fromStep }) => h('option', { key: fromStep, value: String(fromStep) }, `第 ${fromStep + 1} 步「${source.title || '未命名'}」`)))),
        h('label', null, '第几份图片成果', h('input', { type: 'number', min: 1, max: goalBindingResultLimit, value: humanIndex(image.imageIndex), disabled, 'aria-label': `第 ${index + 1} 步参考图 ${imageSlot + 1} 序号`, onChange: (event: ChangeEvent<HTMLInputElement>) => update({ ...bindings, referenceImages: images.map((entry, slot) => slot === imageSlot ? { ...entry, imageIndex: resultIndex(event.target.value) } : entry) }) })),
        h('button', { type: 'button', className: 'text-button', disabled, onClick: () => update({ ...bindings, referenceImages: images.filter((_, slot) => slot !== imageSlot) }) }, `移除参考图 ${imageSlot + 1}`))),
      h('button', { type: 'button', className: 'secondary', disabled: disabled || !imageAllowed || !priorTasks.length || images.length + attachmentCount >= 4, onClick: () => update({ ...bindings, referenceImages: [...images, { fromStep: -1 }] }) }, '添加前序参考图')) : null,
    files.length || fileAllowed ? h('div', { className: 'goal-binding-files' },
      h('p', { className: 'goal-note' }, `终端文件按来源成功回执中全部成果的顺序选择，不按图片、视频、音频或文字筛选；第一份的序号是 1。只支持前序普通任务，不支持分析、浏览器或外部工具。固定附件与这些文件合计最多 ${CLI_INPUT_MAX_FILES} 个，每个最多 ${CLI_INPUT_MAX_FILE_BYTES / 1024 / 1024} MiB，合计最多 ${CLI_INPUT_MAX_TOTAL_BYTES / 1024 / 1024} MiB；准备时核对大小与私有文件访问权限。`),
      ...files.map((file, fileSlot) => h('div', { className: 'goal-binding-row', key: fileSlot },
        h('label', null, `文件 ${fileSlot + 1} 来源`, h('select', { value: String(file.fromStep), disabled, 'aria-label': `第 ${index + 1} 步文件 ${fileSlot + 1} 来源`, onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ ...bindings, artifactFiles: files.map((entry, slot) => slot === fileSlot ? { fromStep: Number(event.target.value) } : entry) }) }, h('option', { value: '-1' }, '选择前序普通任务'), !fileSources.some((entry) => entry.fromStep === file.fromStep) && file.fromStep >= 0 ? h('option', { value: String(file.fromStep), disabled: true }, '当前来源不可用，请重新选择') : null, ...fileSources.map(({ source, fromStep }) => h('option', { key: fromStep, value: String(fromStep) }, `第 ${fromStep + 1} 步「${source.title || '未命名'}」`)))),
        h('label', null, '第几份成果文件（全部成果顺序）', h('input', { type: 'number', min: 1, max: goalBindingResultLimit, value: humanIndex(file.artifactIndex), disabled, 'aria-label': `第 ${index + 1} 步文件 ${fileSlot + 1} 序号`, onChange: (event: ChangeEvent<HTMLInputElement>) => update({ ...bindings, artifactFiles: files.map((entry, slot) => slot === fileSlot ? { ...entry, artifactIndex: resultIndex(event.target.value) } : entry) }) })),
        h('button', { type: 'button', className: 'text-button', disabled, onClick: () => update({ ...bindings, artifactFiles: files.filter((_, slot) => slot !== fileSlot) }) }, `移除文件 ${fileSlot + 1}`))),
      h('button', { type: 'button', className: 'secondary', disabled: disabled || !fileAllowed || !fileSources.length || files.length + attachmentCount >= CLI_INPUT_MAX_FILES, onClick: () => update({ ...bindings, artifactFiles: [...files, { fromStep: -1 }] }) }, '添加前序成果文件')) : null,
    bindings ? h('button', { type: 'button', className: 'text-button', disabled, onClick: () => onChange(undefined) }, '取消全部前序绑定') : null);
}
