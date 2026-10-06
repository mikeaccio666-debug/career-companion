import { applicationQuestionIdentityPreimage, questionClaimKeyForIdentityDigest } from '@edaix/contracts';
import type { QuestionIdentity } from '@edaix/apply-kernel/questions';
import { sha256Utf8 } from './canonicalDigest';

/**
 * 题目身份 → claim key。与后端 question memory 落库时同一份身份归一
 * （`applicationQuestionIdentityPreimage`），所以两边算出的是同一个 key。
 *
 * 单独成一个模块（2026-09-23）：记住的答案（kernelFiller）与 AI 代答（aiAnswers）都用它，
 * 而 AI 代答那一半只在手势路上，不该为了这几行把整个填写模块拉过去。
 */
export async function questionClaimKeyFor(identity: QuestionIdentity): Promise<string> {
  const digest = await sha256Utf8(applicationQuestionIdentityPreimage(identity));
  const key = questionClaimKeyForIdentityDigest(digest);
  if (!key) throw new Error('QUESTION_CLAIM_KEY_UNAVAILABLE');
  return key;
}
