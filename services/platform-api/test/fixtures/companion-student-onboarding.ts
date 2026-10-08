import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { companionLatinSealInitials } from '@companion/career-core';
import { PLATFORM_ACCOUNT_HEADER, type CompanionNamingAccepted, type CompanionNamingRequest, type PlatformProviderRuntime, type OnboardingDraft } from '@companion/platform-contracts';
import { buildApp } from '../../src/app.ts';
import { authorizeFixedSession, hashPassword, tokenHash, type FixedSessionContext } from '../../src/auth.ts';
import { readConfig, type PlatformConfig } from '../../src/config.ts';
import { processAccountEmails, type AccountEmailConfig, type AccountEmailPayload } from '../../src/account-mail.ts';
import { expectedCompanionIdentityBundleDigest, parseCompanionIdentityBundle } from '../../src/companion-identity-bundle.ts';
import { assertActiveCompanionIdentityBundle, expectedCompanionIdentityReviewDigest, parseCompanionIdentityReview, type CompanionIdentityReview } from '../../src/companion-identity-review.ts';
import { companionNameNotification } from '../../src/companion-name-dispatch-protocol.ts';
import { createPrebirthFixture, prebirthDetector, withPrebirthLoopback } from './companion-prebirth.ts';
import { FICTIONAL_LEGAL, fictionalRegistration } from './student-entry.ts';
import { fictionalNameBundle } from './companion-name-safety.ts';

export const studentJourneyPrefix = '/api/platform';
export const studentJourneyOrigin = 'https://fictional-student-journey.example.invalid';
const password = 'Fictional-journey-password-2026!';
export type StudentJourneyActor = FixedSessionContext & { cookie: string; email: string; password: string };
type Prebirth = Awaited<ReturnType<typeof createPrebirthFixture>>;
type JourneySystem = Awaited<ReturnType<typeof buildApp>>;
export interface StudentOnboardingFixture {
  prebirth: Prebirth;
  ready: Awaited<ReturnType<Prebirth['ready']>>;
  system: JourneySystem;
  student: JourneySystem['studentOnboarding'];
  who: StudentJourneyActor;
  config: PlatformConfig;
  runtime: PlatformProviderRuntime;
  requests: Record<string, unknown>[];
  address: string;
  identityAsset: ReturnType<typeof fictionalJourneyIdentityBundle>;
  identityReview: CompanionIdentityReview;
  risk?: { submissionId: string; publicationId: string; bodyProjectionId: string; presentationOperationId: string;
    acknowledgmentOperationId: string; continuationOperationId: string; occurrenceId: string; originalSource: string };
  register(name?: string, verify?: boolean): Promise<StudentJourneyActor>;
  login(who: StudentJourneyActor): Promise<StudentJourneyActor>;
  staff(): Promise<StudentJourneyActor>;
  command(name?: string, expectedEntryRevision?: number, expectedIdentityRevision?: number): CompanionNamingRequest;
  accept(command: CompanionNamingRequest, actor?: StudentJourneyActor): Promise<CompanionNamingAccepted>;
  execute(accepted: CompanionNamingAccepted): Promise<void>;
  evidence(userId?: string): Promise<Record<string, string[]>>;
  withoutLegal(): Promise<JourneySystem>;
  withoutIdentityAssets(): Promise<JourneySystem>;
  dropSelectionReply(payload: unknown, operationId: string): Promise<void>;
}
export const studentJourneyHeaders = (who: StudentJourneyActor) => ({ cookie: who.cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId, origin: studentJourneyOrigin });
export const assertStudentJourneyResponse = (response: { statusCode: number; headers: Record<string, unknown>; body: string }, status: number) => {
  assert.equal(response.statusCode, status, response.body);
  if (status < 400) assert.equal(response.headers['cache-control'], 'private, no-store');
};
const evidenceTables = [
  'platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_onboarding_safety_submissions',
  'platform_companion_generation_tasks', 'platform_companion_answers', 'platform_companion_revisions',
  'platform_companion_generation_requests', 'platform_companion_generation_outbox', 'platform_companion_source_prefixes',
  'platform_companion_name_entries', 'platform_companion_name_submissions', 'platform_companion_name_dispatches',
  'platform_companion_name_dispatch_outbox', 'platform_companion_name_dispatch_operations', 'platform_companion_prebirth_heads',
  'platform_companion_prebirth_inventory', 'platform_companion_identity_drafts', 'platform_companion_identity_operations',
  'platform_companion_identity_selections', 'platform_companion_identity_selection_operations',
  'platform_companion_name_identity_receipts', 'platform_companion_name_identity_provenance', 'platform_safety_model_usage',
  'platform_companion_name_safety_responses', 'platform_companion_name_safety_publications',
  'platform_companion_name_safety_followups', 'platform_companion_name_safety_handled',
  'platform_onboarding_safety_v2_publications', 'platform_onboarding_safety_v2_body_projections',
  'platform_onboarding_safety_v2_followups', 'platform_onboarding_safety_v2_handled',
  'platform_conversations', 'platform_memories', 'platform_jobs',
] as const;

// Explicit fictional complete maps validate only coverage and persistence. No
// real phonetic quality, tier-one membership or professional approval is claimed.
export function fictionalJourneyIdentityBundle() {
  const base = fictionalNameBundle(17);
  const content = { ...base, schemaVersion: 2, policy: { ...base.policy, englishSealRules: {
    normalization: 'latin_nfkd_initial_v1',
    initials: companionLatinSealInitials().map(spelling => ({ spelling, sealChar: '舟', reason: '虚构完整首字母映射，仅验证软件。' })),
    prefixes: [{ spelling: 'milo', sealChar: '墨', reason: '虚构 Milo 拼写映射，不是实际发音审核。' }],
  } } };
  return parseCompanionIdentityBundle({ ...content, contentDigest: expectedCompanionIdentityBundleDigest(content) });
}

/** Every fixture owns a schema and private directory. Provider and verification
 * email I/O traverse actual owned loopback listeners. No Redis worker or paid
 * network is started. The caller/root exclusively executes these tests. */
export async function withStudentOnboardingFixture(run: (fixture: StudentOnboardingFixture) => Promise<void>, options: { apiLimit?: number; exactOnlyAssets?: boolean; riskIntake?: boolean } = {}) {
  assert(process.env.PLATFORM_DATABASE_URL, 'Supply a dedicated PostgreSQL verification URL.');
  const baseline = readConfig(), database = new URL(baseline.databaseUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
  assert(database.port && !['5432', '5442'].includes(database.port));
  await withPrebirthLoopback(async (runtime, requests) => {
    const prebirth = await createPrebirthFixture();
    assert.match(prebirth.schema, /^companion_name_[0-9a-f]{32}$/);
    let system: Awaited<ReturnType<typeof buildApp>> | undefined, directory: string | undefined;
    const extraSystems: Awaited<ReturnType<typeof buildApp>>[] = [];
    try {
      const localRoot = fileURLToPath(new URL('../../.local/', import.meta.url));
      await fs.mkdir(localRoot, { recursive: true, mode: 0o700 });
      directory = await fs.mkdtemp(path.join(localRoot, 'companion-student-onboarding-')); await fs.chmod(directory, 0o700);
      async function asset(name: string, value: unknown) {
        const filename = path.join(directory!, name); await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); return filename;
      }
      const identityAsset = options.exactOnlyAssets ? fictionalNameBundle(17) : fictionalJourneyIdentityBundle();
      const reviewer = await prebirth.actor(true, 'Fictional C identity reviewer'), operator = await prebirth.actor(true, 'Fictional C identity operator'), orgId = randomUUID();
      await prebirth.db.query("INSERT INTO platform_orgs(id,slug,display_name,status) VALUES($1,$2,'Fictional C rules review, not professional approval','active')", [orgId, 'journey_' + orgId.replaceAll('-', '')]);
      for (const [actor, role] of [[reviewer.userId, 'content_reviewer'], [operator.userId, 'ops']]) await prebirth.db.query(`INSERT INTO platform_org_roles(org_id,user_id,role,status,granted_by,granted_at)
        VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [orgId, actor, role, operator.userId]);
      const content = { schemaVersion: identityAsset.schemaVersion, bundleRevision: identityAsset.revision, bundleDigest: identityAsset.contentDigest,
        coverage: 'complete_eligible_level_one', reviewerUserId: reviewer.userId, reviewedAt: '2026-10-01T12:34:56.789Z',
        reviewEvidenceRef: 'https://example.invalid/fictional-C-identity-review', tierOneSourceRef: 'https://example.invalid/fictional-C-tier-one',
        ...(identityAsset.schemaVersion === 2 ? { englishRuleCoverage: 'all_accepted_latin_initials_v1', englishRuleReviewRef: 'https://example.invalid/fictional-C-rule-review-not-professional-approval' } : {}) };
      const identityReview = parseCompanionIdentityReview({ ...content, reviewDigest: expectedCompanionIdentityReviewDigest(content) });
      database.searchParams.set('options', '-c search_path=' + prebirth.schema);
      const mail: AccountEmailConfig = { apiKey: 're_fictional_C_loopback_only', from: 'Fictional C QA <no-reply@example.invalid>',
        webOrigin: studentJourneyOrigin, encryptionKey: Buffer.alloc(32, 0x68) };
      const config = { ...baseline, ...prebirth.config, databaseUrl: database.toString(),
        queueName: 'student-journey-' + randomUUID(), allowedOrigins: new Set([studentJourneyOrigin]), storageDir: directory,
        accountEmail: mail, requireInvite: true, requireVerifiedEmail: true, workbenchEnabled: false, secureCookies: false,
        s3: undefined, mcp: undefined, webStaticDir: undefined,
        safetyDetectorProfilePath: await asset('fictional-detector.json', prebirthDetector),
        safetyResponseBundlePath: await asset('fictional-resources.json', prebirth.bundle), safetyDeliveryReviewPath: await asset('fictional-resources-review.json', prebirth.review),
        companionIdentityBundlePath: await asset('fictional-identity.json', identityAsset), companionIdentityReviewPath: await asset('fictional-identity-review.json', identityReview) };
      const requestLimits = { policies: Object.fromEntries(['api', 'control', 'auth-login', 'auth-register', 'auth-email-request', 'auth-email-consume']
        .map(scope => [scope, { max: scope === 'api' ? options.apiLimit ?? 2000 : 2000, windowSeconds: 60 }])) };
      system = await buildApp({ db: prebirth.db, config, legalBundle: FICTIONAL_LEGAL, runtime, enableQueue: false, requestLimits });
      const current = system, address = await current.app.listen({ host: '127.0.0.1', port: 0 });
      function actorFromResponse(response: { json(): any; headers: Record<string, unknown> }): StudentJourneyActor {
        const user = response.json().user, header = response.headers['set-cookie'];
        const setCookie = Array.isArray(header) ? header[0] : header; assert.equal(typeof setCookie, 'string'); assert.match(setCookie as string, /HttpOnly/);
        const cookie = (setCookie as string).split(';')[0]!, raw = cookie.slice('companion_session='.length);
        return { userId: user.id, tokenHash: tokenHash(raw), cookie, email: user.email, password };
      }
      async function register(name = 'Fictional C student', verify = true) {
        const payload = await fictionalRegistration(prebirth.db, { email: randomUUID() + '@example.invalid', name, password });
        const response = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + '/auth/register', headers: { origin: studentJourneyOrigin }, payload });
        assertStudentJourneyResponse(response, 201); const who = actorFromResponse(response);
        if (verify) await verifyEmail(who); return who;
      }
      async function verifyEmail(who: StudentJourneyActor) {
        const requested = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + '/auth/email-verification/request', headers: studentJourneyHeaders(who), payload: {} });
        assert.equal(requested.statusCode, 202, requested.body);
        const delivered: AccountEmailPayload[] = []; let failure: unknown;
        const server = http.createServer(async (request, response) => {
          try {
            assert.equal(request.method, 'POST'); assert.equal(request.url, '/emails');
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const message = JSON.parse(Buffer.concat(chunks).toString()) as AccountEmailPayload; assert.equal(message.to, who.email); delivered.push(message);
            response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: randomUUID() }));
          } catch (error) { failure = error; response.destroy(); }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const target = server.address(); assert(target && typeof target === 'object');
        try {
          assert.equal(await processAccountEmails(prebirth.db, mail, { limit: 1, fetch: (remote, init) => {
            assert.equal(String(remote), 'https://api.resend.com/emails'); assert.equal(init?.redirect, 'error');
            return fetch(`http://127.0.0.1:${target.port}/emails`, init);
          } }), 1);
          if (failure) throw failure; assert.equal(delivered.length, 1);
          const match = /#account-action=verify-email&token=([A-Za-z0-9_-]{43})/.exec(delivered[0].text); assert(match);
          const completed = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + '/auth/email-verification/complete', headers: studentJourneyHeaders(who), payload: { token: match[1] } });
          assert.equal(completed.statusCode, 200, completed.body); assert.equal(completed.json().user.emailVerified, true);
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      }
      async function login(who: StudentJourneyActor) {
        const response = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + '/auth/login', headers: { origin: studentJourneyOrigin }, payload: { email: who.email, password: who.password } });
        assert.equal(response.statusCode, 200, response.body); return actorFromResponse(response);
      }
      const who = await register();
      async function post(url: string, payload: unknown) {
        const response = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + url,
          headers: { ...studentJourneyHeaders(who), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
        assertStudentJourneyResponse(response, 200); return response.json();
      }
      async function patchIntake(payload: unknown): Promise<OnboardingDraft> {
        const response = await current.app.inject({ method: 'PATCH', url: studentJourneyPrefix + '/onboarding',
          headers: { ...studentJourneyHeaders(who), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
        assertStudentJourneyResponse(response, 200); return response.json().result.draft;
      }
      let risk: StudentOnboardingFixture['risk'];
      if (options.riskIntake) {
        let draft = await patchIntake({ expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } });
        assert(draft.currentQuestion);
        const raw = 'Fictional prebirth high marker; synthetic fixture, not a clinical scenario.';
        draft = await patchIntake({ expectedRevision: draft.revision, operationId: randomUUID(), action: { kind: 'text', questionId: draft.currentQuestion, text: raw } });
        assert(draft.pendingText); const rawOperationId = draft.pendingText.id;
        const detected = await post('/onboarding/safety/retry', {}); assert.equal(detected.entry.draft.safety.level, 'L2');
        assert.equal(detected.entry.draft.safety.mode, 'keyword_only');
        const sourceRows: { id: string }[] = (await prebirth.db.query(`SELECT id FROM platform_onboarding_safety_submissions
          WHERE user_id=$1 AND draft_id=$2 AND operation_id=$3`, [who.userId, draft.id, rawOperationId])).rows;
        assert.equal(sourceRows.length, 1); const submissionId = sourceRows[0].id;
        const originalSource = (await prebirth.db.query(`SELECT row_to_json(t)::text AS value FROM
          (SELECT s.id,s.user_id,s.draft_id,s.operation_id,s.submitted_revision,o.request_ciphertext,s.result_ciphertext,s.generation,s.level,s.detector_mode
          FROM platform_onboarding_safety_submissions s JOIN platform_onboarding_operations o ON o.user_id=s.user_id AND o.operation_id=s.operation_id
          WHERE s.id=$1 AND s.user_id=$2) t`, [submissionId, who.userId])).rows[0].value;
        const publication = (await post('/companion/support/publications', { sourceRef: { kind: 'onboarding', submissionId }, operationId: randomUUID(), expectedEdition: 0 })).publication;
        assert.equal(publication.sourceKind, 'onboarding');
        const target = { sourceKind: 'onboarding', publicationId: publication.publicationId };
        const projection = (await post('/companion/support/body', target)).projection;
        assert.deepEqual(Object.keys(projection.body).sort(), ['resourceCard', 'text']);
        assert.equal(Object.hasOwn(projection.body, 'question'), false);
        const presentationOperationId = randomUUID(), acknowledgmentOperationId = randomUUID(), continuationOperationId = randomUUID();
        // This is an explicit fictional client's declaration of display, not a
        // claim that this server test rendered a browser DOM or assessed safety.
        const present = (await post('/companion/support/actions', { ...target, operationId: presentationOperationId, expectedPublicationRevision: 0,
          action: { kind: 'present_body', bodyProjectionId: projection.bodyProjectionId } })).result;
        assert(present.presentationReceipt);
        const ack = (await post('/companion/support/actions', { ...target, operationId: acknowledgmentOperationId, expectedPublicationRevision: present.state.revision,
          action: { kind: 'acknowledge', presentationReceipt: present.presentationReceipt } })).result;
        const questionState = await current.safetyResources.questionDelivery.read(who, target), renderOwnerId = randomUUID();
        const reservation = (await post('/companion/support/questions/reservations', { ...target, operationId: randomUUID(),
          expectedQuestionScopeRevision: questionState.scopeRevision, renderOwnerId })).reservation;
        assert(reservation.reservationToken);
        const claim = (await post('/companion/support/questions/claims', { operationId: randomUUID(), occurrenceId: reservation.occurrenceId,
          reservationId: reservation.reservationId, reservationToken: reservation.reservationToken, generation: reservation.generation, renderOwnerId })).claim;
        assert.equal(claim.status, 'display_granted'); assert.equal(claim.sourceKind, 'onboarding');
        assert(claim.remainingDisplayMs > 0); assert.equal(typeof claim.serverNow, 'string'); assert.equal(typeof claim.question, 'string');
        await post('/companion/support/questions/presentations', { operationId: randomUUID(), occurrenceId: claim.occurrenceId,
          grantId: claim.grantId, grantPresentationToken: claim.grantPresentationToken, renderOwnerId });
        const continued = (await post('/companion/support/actions', { ...target, operationId: continuationOperationId, expectedPublicationRevision: ack.state.revision,
          action: { kind: 'continue_intake', presentationReceipt: present.presentationReceipt } })).result;
        assert.equal(continued.state.handled, true);
        risk = { submissionId, publicationId: publication.publicationId, bodyProjectionId: projection.bodyProjectionId, presentationOperationId,
          acknowledgmentOperationId, continuationOperationId, occurrenceId: claim.occurrenceId, originalSource };
      }
      const ready = await prebirth.ready(runtime, { who, generate: false });
      const generationOperation = randomUUID(), generated = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + '/companion/drafts',
        headers: studentJourneyHeaders(who), payload: { operationId: generationOperation, expectedRevision: ready.prepared.source.draftRevision } });
      assertStudentJourneyResponse(generated, 202); assert.equal(generated.json().entry.taskId, ready.prepared.taskId);
      await current.companion.executeNotification({ requestId: generationOperation, taskId: ready.prepared.taskId });
      // ready() intentionally uses its original V1 fictional operator policy.
      // Activate our actual configured V2 decision afterwards, under real staff
      // sessions and actual roles, never seeding a production/default approval.
      await prebirth.db.withBoundedTransaction(async client => {
        for (const actor of [reviewer, operator].sort((a, b) => a.userId.localeCompare(b.userId))) await authorizeFixedSession(client, actor);
        await client.query(`INSERT INTO platform_companion_identity_policy(singleton,revision,content_digest,review_digest,reviewed_by,org_id,activated_by,activated_at)
          VALUES(true,$1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,
          review_digest=EXCLUDED.review_digest,reviewed_by=EXCLUDED.reviewed_by,org_id=EXCLUDED.org_id,activated_by=EXCLUDED.activated_by,activated_at=EXCLUDED.activated_at`,
        [identityAsset.revision, identityAsset.contentDigest, identityReview.reviewDigest, reviewer.userId, orgId, operator.userId]);
        await assertActiveCompanionIdentityBundle(client, identityAsset, identityReview);
        await authorizeFixedSession(client, reviewer); await authorizeFixedSession(client, operator);
      });
      const fixture: StudentOnboardingFixture = { prebirth, ready, system: current, student: current.studentOnboarding, who, config, runtime, requests, address, identityAsset, identityReview, risk,
        register, login,
        async staff() { const actor = await prebirth.actor(true); await prebirth.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [actor.userId, await hashPassword(password)]);
          const row = (await prebirth.db.query('SELECT email FROM platform_users WHERE id=$1', [actor.userId])).rows[0];
          return login({ ...actor, email: row.email, password, cookie: '' }); },
        command(name = 'Milo', expectedEntryRevision = 0, expectedIdentityRevision = 0): CompanionNamingRequest {
          return { taskId: ready.prepared.taskId, operationId: randomUUID(), name, expectedEntryRevision, expectedIdentityRevision };
        },
        async accept(command: CompanionNamingRequest, actor = who) {
          const response = await current.app.inject({ method: 'POST', url: studentJourneyPrefix + '/companion/naming/submissions', headers: studentJourneyHeaders(actor), payload: command });
          assertStudentJourneyResponse(response, 202); return response.json<CompanionNamingAccepted>();
        },
        async execute(accepted: CompanionNamingAccepted) { await current.naming.executeNotification(companionNameNotification({ dispatchId: accepted.acceptance.dispatchId,
          taskId: accepted.acceptance.taskId, submissionId: accepted.acceptance.submissionId })); },
        async evidence(userId = who.userId) { const result: Record<string, string[]> = {}; for (const table of evidenceTables) result[table] = (await prebirth.db.query(`SELECT row_to_json(t)::text AS value
          FROM ${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`, [userId])).rows.map(row => row.value); return result; },
        async withoutLegal() { const result = await buildApp({ db: prebirth.db, config, legalBundle: null, runtime, enableQueue: false, requestLimits }); extraSystems.push(result); return result; },
        async withoutIdentityAssets() { const result = await buildApp({ db: prebirth.db, config: { ...config, companionIdentityBundlePath: undefined, companionIdentityReviewPath: undefined },
          legalBundle: FICTIONAL_LEGAL, runtime, enableQueue: false, requestLimits }); extraSystems.push(result); return result; },
        async dropSelectionReply(payload: unknown, operationId: string) {
          let resolve!: () => void, reject!: (error: unknown) => void; const committed = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); let armed = true;
          const intercept = (request: http.IncomingMessage, response: http.ServerResponse) => {
            if (!armed || request.method !== 'POST' || request.url !== studentJourneyPrefix + '/companion/journey/seal') return;
            armed = false; const originalEnd = response.end;
            response.end = (function(this: http.ServerResponse, ...args: any[]) { response.end = originalEnd; void (async () => {
              assert.equal(response.statusCode, 200); const saved = JSON.parse(String(args[0])).saved;
              assert.equal(saved.operation.id, operationId);
              assert.equal((await prebirth.db.query('SELECT operation_id FROM platform_companion_identity_selection_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, operationId])).rowCount, 1);
              resolve(); response.destroy();
            })().catch(error => { reject(error); response.destroy(); }); return this; }) as typeof response.end;
          };
          current.app.server.prependListener('request', intercept); const timer = setTimeout(() => reject(new Error('Owned selection response did not reach actual COMMIT.')), 8000);
          try {
            const dropped = new Promise<void>((done, fail) => { const request = http.request(address + studentJourneyPrefix + '/companion/journey/seal', { method: 'POST', agent: false,
              headers: { ...studentJourneyHeaders(who), 'content-type': 'application/json' } }, response => { response.resume(); fail(new Error('Intentionally dropped selection reply reached the client.')); });
              request.setTimeout(9000, () => request.destroy(new Error('Owned HTTP selection fixture timed out.')));
              request.on('error', error => (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? done() : fail(error)); request.end(JSON.stringify(payload)); });
            await Promise.all([committed, dropped]);
          } finally { clearTimeout(timer); current.app.server.removeListener('request', intercept); }
        },
      };
      await run(fixture);
    } finally {
      try { for (const extra of extraSystems) await extra.app.close(); if (system) await system.app.close(); }
      finally { try { await prebirth.close(); } finally { if (directory) { assert.match(path.basename(directory), /^companion-student-onboarding-[A-Za-z0-9]+$/); await fs.rm(directory, { recursive: true, force: true }); } } }
    }
  });
}
