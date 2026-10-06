/**
 * Stable public surface for the backend HTTP contract mirror.
 *
 * `src/draft/*` is intentionally not re-exported from this stable root.
 *
 * T5 Gap/Strength（规划老师）按 additive L1 原子切片进入此稳定入口，
 * 供 repository runtime candidate 引用；production activation 仍独立 fail closed。
 */

export * from './common.ts';
export * from './deployment.ts';
export * from './auth.ts';
export * from './calendar.ts';
export * from './applicationLedger.ts';
export * from './conversations.ts';
export * from './dailyReports.ts';
export * from './executionIntent.ts';
export * from './executionIntentV2Parsers.ts';
export * from './executionRuntime.ts';
export * from './executionWizard.ts';
export * from './executionRuntimeAuthorization.ts';
export * from './http.ts';
export * from './ianaTimeZones.ts';
export * from './missions.ts';
export * from './missionDock.ts';
export * from './applicationPage.ts';
export * from './jobIntake.ts';
export * from './canonical-roles.ts';
export * from './payments.ts';
export * from './profileDirectory.ts';
export * from './profileV2.ts';
export * from './profileSnapshotValidation.ts';
export * from './assistantRead.ts';
export * from './profilePatchValidation.ts';
export * from './assistantProfile.ts';
export * from './profileAnswerSources.ts';
export * from './eeoSelfIdentification.ts';
export * from './applicationSigningConsent.ts';
export * from './recommendations.ts';
export * from './adminPolicies.ts';
export * from './applicationPreparations.ts';
export * from './referrals.ts';
export * from './referralStudentWire.ts';
export * from './resumeProfileSuggestions.ts';
export * from './resumeStructuredFacts.ts';
export * from './resumeLibrary.ts';
export * from './resumeSelection.ts';
export * from './jobIngestion.ts';
export * from './jobResumeGeneration.ts';
export * from './resumePdf.ts';
export * from './resumeAtsAttachment.ts';
export * from './applicationQuestionAnswers.ts';
export * from './applicationQuestionDrafts.ts';
export * from './sensitiveWrite.ts';
export * from './gap-strength.ts';
export * from './gap-analysis-v2.ts';
export * from './gap-strength-input.ts';
export * from './gap-strength-engine.ts';
export * from './gap-strength-planner.ts';
export * from './profile-strength.ts';
export * from './skill-library.ts';
export * from './learning-recommendation.ts';
export * from './learning-recommendation-v2.ts';
export * from './trustTelemetry.ts';
export * from './applicationQuestionCandidates.ts';
export * from './applicationQuestionMemory.ts';
export * from './applicationQuestionSchema.ts';
export * from './missionAutofillConsent.ts';
export * from './coverLetterProduct.ts';
export * from './coverLetterAttachment.ts';
export * from './coverLetterProductV2.ts';

export * from './applicationLedgerWire.ts';
export * from './mcp.ts';
export * from './deploymentComposition.ts';

export * from './deployment-preview.ts';
export * from './deployment-staging.ts';
export * from './deployment-accepted-runtime.ts';
export * from './deployment-single-admin.ts';
export * from './deployment-single-admin-operation.ts';
export * from './auth-single-admin-operation.ts';
export * from './deployment-cutover.ts';
export * from './deployment-staging-publishing.ts';
export * from './deployment-staging-migrations.ts';
export * from './deployment-staging-initial-transition.ts';
export * from './payment-catalog.ts';
export * from './commercial-usage.ts';

export * from './calendar-google.ts';
export * from './rolePreferences.ts';
export * from './assistantRoles.ts';

export * from "./profileIntake.ts";
export * from './assistantIntake.ts';

export * from './assistantIntakeVoice.ts';

export * from './job-card.ts';

export * from './assistant-jobs.ts';
export * from './ats-reports.ts';
export * from './assistantCommerce.ts';
export * from './subscription-lifecycle.ts';
export * from './assistantCoverDraft.ts';
export * from './assistantAutofill.ts';
export * from './assistantMissionRun.ts';
export * from './notifications.ts';
export * from './fullAiAutofill.ts';
