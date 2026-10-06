// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { createBundledApplyPolicy } from '@edaix/apply-kernel/policy';
import type { NeedsUserInputKind, ReceiptFieldOutcome } from '@edaix/contracts/draft';
import type { ExecutionGrant, FillProgress } from '@edaix/agent-channel';
import { scanCurrentPage } from '../lib/kernelScanner';
import { fillFromGrant, questionClaimKeyFor } from '../lib/kernelFiller';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * A remembered answer whose key the server granted is filled in the same run as the
 * profile fields, with no per-question click, and the receipt names it as remembered.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const GH_LOC = {
  hostname: 'job-boards.greenhouse.io',
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/acme/jobs/12345',
};

const PROFILE = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' };
const ANSWER = 'Because the product is the job search I wanted.';

function mountForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="last_name">Last name*</label>
      <input id="last_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      <label for="why">Why do you want to work here?*</label>
      <textarea id="why" required></textarea>
    </form>`;
}

function grantFor(fieldKeys: readonly string[], questionKeys: readonly string[]): ExecutionGrant {
  return {
    missionId: 'm_1',
    missionStepId: 'ms_1',
    fieldKeys,
    questionKeys,
    allowedActions: ['FILL'],
    executionLease: 'lease_test_1',
    leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
    intentVersion: 1,
    planDigest: `sha256:${'b'.repeat(64)}`,
    jobIdentityHash: `sha256:${'a'.repeat(64)}`,
    fieldSchemaVersion: 1,
    profileSnapshot: { revision: '7', deletionEpoch: '0', snapshotDigest: `sha256:${'c'.repeat(64)}` },
  };
}

function progressRecorder() {
  const outcomes: ReceiptFieldOutcome[] = [];
  const needs: Array<{ kind: NeedsUserInputKind; fieldKey?: string }> = [];
  const progress: FillProgress = {
    onOutcome: (outcome) => outcomes.push(outcome),
    onNeedsUserInput: (kind, fieldKey) => needs.push(fieldKey === undefined ? { kind } : { kind, fieldKey }),
    shouldStop: () => false,
  };
  return { progress, outcomes, needs };
}

const freshPolicy = () => createBundledApplyPolicy(Date.now());
const answerText = () => document.querySelector<HTMLTextAreaElement>('#why')!.value;

async function whyKey(): Promise<string> {
  return questionClaimKeyFor({
    text: 'Why do you want to work here?',
    controlType: 'TEXTAREA',
    optionTexts: [],
  });
}

describe('remembered answers in the Fill run', () => {
  it('fills a granted remembered answer with the profile fields and names it in the receipt', async () => {
    mountForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const key = await whyKey();
    const { progress, outcomes } = progressRecorder();
    const asked: unknown[] = [];

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys, [key]),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      resolveRememberedAnswers: async (questions) => {
        asked.push(questions.map((question) => question.claimKey));
        return questions.map((question) => ({ questionId: question.questionId, value: ANSWER }));
      },
      onAudit: () => {},
    });

    expect(asked).toEqual([[key]]);
    expect(answerText()).toBe(ANSWER);
    const remembered = outcomes.find((outcome) => outcome.key === key);
    expect(remembered).toEqual({ key, ok: true, source: 'REMEMBERED_ANSWER' });
    expect(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.key)).toEqual(
      expect.arrayContaining(['firstName', 'lastName', 'email', key]),
    );
  });

  it('writes nothing for a granted key whose answer the server no longer hands back', async () => {
    mountForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const key = await whyKey();
    const { progress, outcomes } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys, [key]),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      // A memory forgotten, or reuse turned off, between issuance and fill.
      resolveRememberedAnswers: async () => [],
      onAudit: () => {},
    });

    expect(answerText()).toBe('');
    expect(outcomes.find((outcome) => outcome.key === key)).toEqual({
      key,
      ok: false,
      reason: 'POLICY_DISABLED',
    });
  });

  it('reports a granted key that is no longer a question on the page', async () => {
    mountForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const absent = await questionClaimKeyFor({
      text: 'A question this page never asked',
      controlType: 'TEXTAREA',
      optionTexts: [],
    });
    const { progress, outcomes } = progressRecorder();

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys, [absent]),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      resolveRememberedAnswers: async () => [],
      onAudit: () => {},
    });

    expect(outcomes.find((outcome) => outcome.key === absent)).toEqual({
      key: absent,
      ok: false,
      reason: 'LEASE_INVALID',
    });
  });

  it('never asks for an answer, and leaves the question to review, when nothing was granted', async () => {
    mountForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { progress, outcomes } = progressRecorder();
    let asked = 0;
    const audits: { questions: readonly { questionId: string }[] }[] = [];

    await fillFromGrant({
      grant: grantFor(scan!.fieldKeys, []),
      scan: scan!,
      profile: PROFILE,
      progress,
      policy: freshPolicy(),
      resolveRememberedAnswers: async () => {
        asked += 1;
        return [];
      },
      onAudit: (audit) => audits.push(audit),
    });

    expect(asked).toBe(0);
    expect(answerText()).toBe('');
    expect(outcomes.every((outcome) => !outcome.key.startsWith('question:'))).toBe(true);
    expect(audits[0]!.questions.length).toBeGreaterThan(0);
  });
});
