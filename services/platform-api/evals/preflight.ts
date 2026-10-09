import { createEvalStudyPlan } from './study-plan.ts';
export { evalDigest } from './baseline-input.ts';
import { evalDigest } from './baseline-input.ts';
import { PROPOSED_EVAL_PRICES, PROPOSED_PRICE_STATUS } from './prices.ts';

/** Availability describes this foundation, not an automatic audit of later code. */
export const PRODUCT_METRIC_BLOCKERS = Object.freeze({
  first_feedback_ms: 'durable_turn_and_channel_not_connected',
  companion_first_sentence_ms: 'sentence_validation_not_connected',
  card_first_sentence_ms: 'expert_runner_and_sentence_validation_not_connected',
  forward_card_verbatim: 'expert_runner_and_forward_card_not_connected',
  route_accuracy: 'speaker_routing_not_connected',
  name_call_accuracy: 'name_call_routing_not_connected',
  validator_false_positive_rate: 'output_validator_not_connected',
  cache_hit_ratio: 'cached_token_breakdown_not_available',
  interjection_join_ms: 'durable_interjections_not_connected',
  stop_ms: 'durable_cancel_not_connected',
  resume_loss: 'durable_event_replay_not_connected',
  task_progress_gap_s: 'background_agent_runner_not_connected',
});

export function buildEvalPreflight() {
  const study = createEvalStudyPlan();
  const cases = study.scripts.map(item => ({ id: item.id, pairId: item.pairId,
    speaker: item.speaker, language: item.language, turnKind: item.turnKind }));
  const counts = Object.fromEntries(['companion', 'guide', 'applier', 'interviewer'].map(speaker => [speaker,
    cases.filter(item => item.speaker === speaker).length]));
  return {
    version: 1, scope: 'provider_loop_baseline_preparation', mode: 'dry_run',
    status: 'prepared_not_executed', providerCalls: 0, liveCommandAvailable: true, liveCommand: 'eval:pilot', liveProviders: ['openai'], pendingAdapters: ['anthropic'],
    caseSetDigest: study.corpusDigest, studyDigest: study.digest, promptDigest: study.promptDigest,
    inputScope: study.scope, toolExecution: 'not_exercised', priceCandidateDigest: evalDigest(PROPOSED_EVAL_PRICES),
    languageScripts: cases.length, semanticScenarios: new Set(cases.map(item => item.pairId)).size,
    speakerCounts: counts,
    stages: { developmentPilot: [...study.pilotCaseIds], developmentAll: [...study.developmentCaseIds],
      formalPilot: [...study.formalPilotCaseIds], formalAll: [...study.formalCaseIds] },
    entries: study.entries.map(({ caseId, scriptId, scriptDigest, seedInputDigest, speaker, purpose, stage }) =>
      ({ caseId, scriptId, scriptDigest, seedInputDigest, speaker, purpose, stage })),
    priceStatus: PROPOSED_PRICE_STATUS, proposedPrices: PROPOSED_EVAL_PRICES,
    // Research prices are not silently promoted to a signed/approved live budget.
    approvedBudgetMicroUsd: null, spentMicroUsd: null, forecastMicroUsd: null,
    cases,
    productMetrics: Object.fromEntries(Object.entries(PRODUCT_METRIC_BLOCKERS).map(([key, reason]) => [key,
      { value: null, status: 'blocked', reason }])),
    pr3EntryGate: { status: 'blocked', reasons: ['scope_alignment_pending', 'real_model_study_not_run', 'product_metric_dependencies_missing'] },
  } as const;
}
