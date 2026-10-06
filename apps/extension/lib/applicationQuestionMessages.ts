import {
  APPLICATION_QUESTION_ANSWER_CLASSES,
  APPLICATION_QUESTION_MEMORY_SCOPES,
  parseApplicationQuestionContextV1,
  parseApplicationQuestionSettingsUpdateV1,
  type ApplicationQuestionAnswerValueV1,
  type ApplicationQuestionV1,
} from '@edaix/contracts';
import { sameApplicationQuestionContext, type ApplicationQuestionClient, type ApplicationQuestionPage } from './applicationQuestionClient';

/**
 * One-shot `application-question/*` messages from the content script. The background
 * owns the API origin and the mission context; the content script only ever sends the
 * questions it scanned and the answers the user confirmed.
 */
export const APPLICATION_QUESTION_MESSAGE_PREFIX = 'application-question/';

type Message = Readonly<Record<string, unknown>>;
type Reply = Readonly<{ ok: true } & Record<string, unknown>> | Readonly<{ ok: false; code: string }>;

export async function handleApplicationQuestionMessage(client: ApplicationQuestionClient, kind: string, message: Message): Promise<Reply> {
  switch (kind) {
    case 'application-question/settings-get': {
      const result = await client.settings();
      return result.ok ? { ok: true, settings: result.value } : result;
    }
    case 'application-question/settings-update': {
      const update = parseApplicationQuestionSettingsUpdateV1(message['update']);
      if (!update) return { ok: false, code: 'INVALID' };
      const result = await client.updateSettings(update);
      return result.ok ? { ok: true, settings: result.value } : result;
    }
    case 'application-question/candidates': {
      const page = pageOf(message);
      if (!page || !Array.isArray(message['questions'])) return { ok: false, code: 'INVALID' };
      const context = await client.context(page);
      if (!context.ok) return context;
      const result = await client.candidates({
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        context: context.value,
        questions: message['questions'] as readonly ApplicationQuestionV1[],
      });
      return result.ok ? { ok: true, result: result.value } : result;
    }
    case 'application-question/schema': {
      const missionId = message['missionId'];
      if (typeof missionId !== 'string') return { ok: false, code: 'INVALID' };
      const result = await client.schema(missionId);
      return result.ok ? { ok: true, schema: result.value } : result;
    }
    case 'application-question/recheck': {
      const page = pageOf(message);
      const context = parseApplicationQuestionContextV1(message['context']);
      if (!page || !context) return { ok: false, code: 'INVALID' };
      const result = await client.recheck(page, context);
      return result.ok ? { ok: true, current: result.value.current } : result;
    }
    case 'application-question/remember': {
      const page = pageOf(message);
      const { question, answer, scope, answerClass } = message;
      // The context the user confirmed the answer under travels with the request. The fresh
      // read below may only refuse drift; it never replaces the confirmed context, so an answer
      // confirmed under one Mission revision can never be filed under a later one.
      const confirmed = parseApplicationQuestionContextV1(message['context']);
      if (!page || !confirmed || !isRecord(question) || !isRecord(answer) || !isMember(APPLICATION_QUESTION_MEMORY_SCOPES, scope)
        || !isMember(APPLICATION_QUESTION_ANSWER_CLASSES, answerClass)) return { ok: false, code: 'INVALID' };
      const current = await client.context(page);
      if (!current.ok) return current.code === 'UNAVAILABLE' ? { ok: false, code: 'STALE' } : current;
      if (!sameApplicationQuestionContext(current.value, confirmed)) return { ok: false, code: 'STALE' };
      const result = await client.remember({
        schemaVersion: 1,
        context: confirmed,
        question: question as never,
        answer: answer as ApplicationQuestionAnswerValueV1,
        scope,
        answerClass,
      });
      return result.ok ? { ok: true, record: result.value } : result;
    }
    default:
      return { ok: false, code: 'INVALID' };
  }
}

function pageOf(message: Message): ApplicationQuestionPage | null {
  const { missionId, pageId, pageGeneration } = message;
  return typeof missionId === 'string' && typeof pageId === 'string' && typeof pageGeneration === 'string'
    ? { missionId, pageId, pageGeneration }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}
