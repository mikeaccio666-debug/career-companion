import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { FixedSessionContext } from '../../src/auth.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../../src/safety-detector-profile.ts';
import { expectedSafetyDeliveryReviewDigest, parseSafetyDeliveryReview, SafetyDeliveryReviewRegistry } from '../../src/safety-delivery-review.ts';
import { CompanionNameSafetyResponses } from '../../src/companion-name-safety-responses.ts';
import { CompanionNameSafetyDelivery } from '../../src/companion-name-safety-delivery.ts';
import { CompanionNameSafetyRunner } from '../../src/companion-name-safety-runner.ts';
import { createCompanionNameSafetyFixture } from './companion-name-safety.ts';
import { fictionalBundle } from './onboarding-followup.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';

// These fictional assets exercise real persistence and authorization, never
// professional approval or classifier quality. All provider I/O stays loopback.
const profileContent = {
  schemaVersion: 1, revision: 96,
  instructions: 'Fictional prebirth composition test; not professional review.',
  algorithm: 'literal_substring_v1',
  lexicon: [
    { id: 'fictional-prebirth-low-en', language: 'en', level: 'L1', phrases: ['Fictional prebirth low marker'] },
    { id: 'fictional-prebirth-high-en', language: 'en', level: 'L2', phrases: ['Fictional prebirth high marker'] },
    { id: 'fictional-prebirth-low-zh', language: 'zh', level: 'L1', phrases: ['虚构诞生前低风险标记'] },
    { id: 'fictional-prebirth-high-zh', language: 'zh', level: 'L2', phrases: ['虚构诞生前高风险标记'] },
  ],
  mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-prebirth-fixture-not-production-approval', approvedAt: '2026-10-01T00:00:00.000Z' },
};
export const prebirthDetector = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const syntheticPreview = {
  summary: '先把事情理清楚，再选一个小行动。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'],
};
const generationModel = 'fictional-companion-model';
const classifierModel = 'fictional-prebirth-classifier';
export type PrebirthFixture = Awaited<ReturnType<typeof createPrebirthFixture>>;
export type ReadyPrebirthSource = Awaited<ReturnType<PrebirthFixture['ready']>>;

/** Uses an ephemeral owned HTTP listener. The injected fetch rejects any other
 * provider destination before translating the one allowed request to loopback. */
export async function withPrebirthLoopback(
  run: (runtime: PlatformProviderRuntime, requests: Record<string, unknown>[]) => Promise<void>,
  decision: 'L0' | 'L1' | 'L2' = 'L0',
) {
  const requests: Record<string, unknown>[] = [];
  let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push(body);
      assert.equal(body.store, false);
      assert.equal(body.tool_choice, 'none');
      assert.deepEqual(body.tools, []);
      assert.equal(body.text.format.strict, true);
      assert([generationModel, classifierModel].includes(body.model));
      const value = body.model === generationModel ? syntheticPreview : { level: decision };
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        usage: { input_tokens: 34, output_tokens: 21 },
      } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const runtime = createProviderRuntime({
    env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
      OPENAI_COMPANION_GENERATION_MODEL: generationModel, OPENAI_SAFETY_CLASSIFY_MODEL: classifierModel },
    fetch: (target, init) => {
      const remote = new URL(String(target));
      assert.equal(remote.origin, 'https://api.openai.com');
      assert.equal(remote.pathname, '/v1/responses');
      assert.equal(remote.search, '');
      return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
    },
  });
  try { await run(runtime, requests); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function createPrebirthFixture() {
  const fixture = await createCompanionNameSafetyFixture();
  try {
    const operator = await fixture.actor(true, 'Fictional prebirth detector operator');
    await fixture.db.query(`INSERT INTO platform_safety_detector_policy
      (singleton,revision,content_digest,review_digest,activated_at,activated_by)
      VALUES(true,$1,$2,$3,clock_timestamp(),$4)`,
    [prebirthDetector.revision, prebirthDetector.digest, prebirthDetector.reviewDigest, operator.userId]);
    const bundle = fictionalBundle();
    const reviewer = await fixture.actor(true, 'Fictional prebirth safety reviewer');
    const orgId = randomUUID();
    await fixture.db.query(`INSERT INTO platform_orgs(id,slug,display_name,status)
      VALUES($1,$2,'Fictional prebirth QA; not professional approval','active')`,
    [orgId, 'prebirth_' + orgId.replaceAll('-', '')]);
    for (const [user, role] of [[reviewer.userId, 'safety_reviewer'], [operator.userId, 'ops']])
      await fixture.db.query(`INSERT INTO platform_org_roles(org_id,user_id,role,status,granted_by,granted_at)
        VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [orgId, user, role, operator.userId]);
    const content = { schemaVersion: 1, bundleRevision: bundle.revision, contentDigest: bundle.contentDigest,
      bundleReviewDigest: bundle.reviewDigest, reviewerUserId: reviewer.userId, orgId,
      reviewedAt: '2026-10-01T12:34:56.789Z',
      reviewEvidenceRef: 'https://example.invalid/fictional-prebirth-review-not-professional-approval',
      coverage: 'body_question_separated', variablePolicy: 'unnamed_empty_user', evidenceRetentionDays: 40,
      legacyPolicy: 'no_auto_reask_possible_exposure' };
    const review = parseSafetyDeliveryReview({ ...content, reviewDigest: expectedSafetyDeliveryReviewDigest(content) });
    const registry = new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, bundle, review);
    const recorded = await registry.recordReview(reviewer, { operationId: randomUUID() });
    await registry.activate(operator, { operationId: randomUUID(), assetId: recorded.assetId });
    const original = new CompanionNameSafetyResponses(fixture.db, fixture.config, bundle);
    const resources = new CompanionNameSafetyDelivery(fixture.db, fixture.config, FICTIONAL_LEGAL, original, bundle, review);
    return { ...fixture, bundle, review, resources, original };
  } catch (error) { await fixture.close(); throw error; }
}

export async function classifyPrebirthName(fixture: PrebirthFixture, ready: ReadyPrebirthSource,
  runtime: PlatformProviderRuntime, name = 'Juno') {
  const state = await ready.safety.read(ready.who, { taskId: ready.prepared.taskId });
  const identity = await ready.names.read(ready.who, { taskId: ready.prepared.taskId });
  const submitted = await ready.safety.submit(ready.who, { taskId: ready.prepared.taskId,
    operationId: randomUUID(), expectedEntryRevision: state?.revision ?? 0,
    expectedIdentityRevision: identity?.revision ?? 0, name });
  await new CompanionNameSafetyRunner(ready.safety, fixture.config, runtime, prebirthDetector)
    .runSubmission(ready.who, { taskId: ready.prepared.taskId, submissionId: submitted.submissionId });
  return submitted;
}

export async function readyStandardPrebirth(fixture: PrebirthFixture, runtime: PlatformProviderRuntime) {
  const who = await fixture.actor();
  let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(),
    action: { kind: 'start', mode: 'standard' } })).draft;
  while (draft.currentQuestion) draft = (await fixture.store.save(who, { expectedRevision: draft.revision,
    operationId: randomUUID(), action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
  assert.equal(draft.fastTrack, false);
  return fixture.ready(runtime, { who });
}

/** Synthetic client declarations test the real resource receipt chain. They
 * establish neither an actual DOM render nor human reading or safety. */
export async function handlePrebirthResource(fixture: PrebirthFixture, who: FixedSessionContext, submissionId: string) {
  const prepared = await fixture.original.prepareSubmission(submissionId);
  assert(prepared);
  assert.equal(prepared.status, 'ready');
  const publication = await fixture.resources.publish(who, { operationId: randomUUID(), submissionId, expectedEdition: 0 });
  assert(publication);
  const projection = await fixture.resources.issueBodyProjection(who, { publicationId: publication.publicationId });
  const presented = await fixture.resources.act(who, { operationId: randomUUID(), publicationId: publication.publicationId,
    expectedPublicationRevision: projection.revision, action: { kind: 'present_body', bodyProjectionId: projection.bodyProjectionId } });
  assert.equal(typeof presented.presentationReceipt, 'string');
  const acknowledged = await fixture.resources.act(who, { operationId: randomUUID(), publicationId: publication.publicationId,
    expectedPublicationRevision: presented.state.revision, action: { kind: 'acknowledge', presentationReceipt: presented.presentationReceipt! } });
  const handled = await fixture.resources.act(who, { operationId: randomUUID(), publicationId: publication.publicationId,
    expectedPublicationRevision: acknowledged.state.revision, action: { kind: 'continue_naming', presentationReceipt: presented.presentationReceipt! } });
  assert.equal(handled.state.handled, true);
  return { publication, projection, presented, acknowledged, handled };
}
