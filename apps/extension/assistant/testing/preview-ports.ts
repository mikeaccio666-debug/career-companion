import { abortableDelay, type AssistantPorts, type UiFailureCode, type UiResult } from '../ports/assistant-ports';
import { extract, previewData, scores } from './fixtures';

/** Faults are consumed at the service boundary, never baked into UI controllers. */
export function createPreviewPorts(speed = 1) {
  const faults = new Map<keyof AssistantPorts, UiFailureCode>();
  const wait = (ms: number, signal: AbortSignal) => abortableDelay(ms * speed, signal);
  async function result<T>(method: keyof AssistantPorts, value: () => T, ms: number, signal: AbortSignal): Promise<UiResult<T>> {
    if (!await wait(ms, signal)) return { ok: false, code: 'CANCELLED' };
    const code = faults.get(method);
    if (code) { faults.delete(method); return { ok: false, code }; }
    return { ok: true, value: value() };
  }
  const ports: AssistantPorts = {
    mode: 'preview',
    extract: (input, signal) => result('extract', () => extract(input.text, input.phase), 720, signal),
    saveCandidate: (_input, signal) => result('saveCandidate', () => undefined, 900, signal),
    async parseResume(onStage, signal) {
      for (const state of ['uploading', 'reading', 'organizing'] as const) {
        onStage({ state });
        if (!await wait(750, signal)) return { ok: false, code: 'CANCELLED' };
      }
      return result('parseResume', () => structuredClone(previewData.profile), 400, signal);
    },
    transcribe: (phase, signal) => result('transcribe', () => previewData.phases[phase].demoVoice, 1400, signal),
    score: (input, signal) => result('score', () => structuredClone(scores[input.job.id] ?? scores[previewData.jobs[0].id]), 1600, signal),
    prepare: (input, signal) => result('prepare', () => ({ resumeId: input.resumeId === 'gen' ? `prepared-${input.job.id}` : input.resumeId }), 900, signal),
    generateLetter: (input, signal) => result('generateLetter', () => `Dear ${input.job.company} team,\n\nI'm excited to apply for the ${input.job.title} role.\n\n${input.profile.summary}\n\n${input.job.matches.join('；')}。关于 ${input.job.gap}，我愿意在面谈中展开说明。\n\nThank you for your consideration.\n${input.profile.name}`, 1800, signal),
    async run(_input, onRow, signal) {
      const fault = faults.get('run'); faults.delete('run');
      for (let i = 0; i < previewData.runRows.length; i++) {
        const row = previewData.runRows[i];
        if (!await wait(200, signal)) return { ok: false, code: 'CANCELLED' };
        onRow({ ...row, state: 'active' });
        if (!await wait(500, signal)) return { ok: false, code: 'CANCELLED' };
        if (fault && i === 3) { onRow({ ...row, state: 'failed' }); return { ok: false, code: fault }; }
        onRow({ ...row, state: row.outcome });
      }
      return { ok: true, value: undefined };
    },
  };
  return { ports, failNext(method: keyof AssistantPorts, code: UiFailureCode) { faults.set(method, code); } };
}
