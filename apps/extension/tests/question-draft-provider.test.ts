import { describe, expect, it, vi } from 'vitest';
import { createDockQuestionDraftIntent } from '../lib/questionDraftIntent';
import { createQuestionDraftProvider } from '../lib/questionDraftProvider';

const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;
const JOB = { company: 'Acme', title: 'Analyst', location: null };
const QUESTIONS = [{ questionId: 'q1', text: 'Why Acme?', maxLength: null }];

describe('起草的 worker 侧', () => {
  it('铸 requestId、原样转交岗位与题目、把草稿投影成面板要的形状', async () => {
    const create = vi.fn(async () => ({ ok: true as const, value: [{ questionId: 'q1', text: 'Because…' }] }));
    const provider = createQuestionDraftProvider({ client: { create }, requestId: () => '22222222-2222-4222-8222-222222222222' });
    expect(await provider.handle(createDockQuestionDraftIntent(...PAGE, JOB, QUESTIONS)!))
      .toEqual({ kind: 'QUESTION_DRAFTS', drafts: [{ questionId: 'q1', text: 'Because…' }] });
    expect(create).toHaveBeenCalledWith({ schemaVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', job: JOB, questions: QUESTIONS });
  });

  it('失败照码转交，并只把码记进诊断——题目与草稿一个字不进', async () => {
    const diagnostics: string[] = [];
    const provider = createQuestionDraftProvider({
      client: { create: async () => ({ ok: false as const, code: 'QUOTA_EXCEEDED' as const }) },
      onDiagnostic: (code) => diagnostics.push(code),
    });
    expect(await provider.handle(createDockQuestionDraftIntent(...PAGE, JOB, QUESTIONS)!)).toEqual({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' });
    expect(diagnostics).toEqual(['QUESTION_DRAFT_QUOTA_EXCEEDED']);
  });
});
