import type { QuestionDraftClient } from './questionDraftClient';
import type { DockQuestionDraftIntent, DockQuestionDraftReply } from './questionDraftIntent';

export interface QuestionDraftProviderDeps {
  readonly client: QuestionDraftClient;
  readonly requestId?: () => string;
  readonly onDiagnostic?: (code: string) => void;
}

export interface QuestionDraftProvider {
  handle(intent: DockQuestionDraftIntent): Promise<DockQuestionDraftReply>;
}

/** worker 侧：铸 requestId、调端点、把结果投影成面板要的形状。题目与草稿是 Data-L1，不进诊断。 */
export function createQuestionDraftProvider(deps: QuestionDraftProviderDeps): QuestionDraftProvider {
  const diag = (code: string): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // 诊断通道自己坏了不该影响起草。
    }
  };
  return Object.freeze({
    async handle(intent: DockQuestionDraftIntent): Promise<DockQuestionDraftReply> {
      const result = await deps.client.create({
        schemaVersion: 1,
        requestId: (deps.requestId ?? (() => crypto.randomUUID()))(),
        job: intent.job,
        questions: intent.questions,
      });
      if (!result.ok) {
        diag(`QUESTION_DRAFT_${result.code}`);
        return { kind: 'REFUSED', code: result.code };
      }
      return { kind: 'QUESTION_DRAFTS', drafts: result.value };
    },
  });
}
