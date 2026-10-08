import type { CompanionSafetyBodyProjection, CompanionSafetyResourceBody, CompanionSafetyResourceState,
  CompanionSafetyQuestionState } from '@companion/platform-contracts';

// Transport/DOM fixtures only. These are not actual reviewed professional assets or live resources.
export const id = (n: number) => `24000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const at = '2026-10-07T12:00:00.000Z';
export const until = '2026-11-07T12:00:00.000Z';
export const receipt = 'F'.repeat(43), reservationToken = 'R'.repeat(43), grantToken = 'G'.repeat(43);
export const body: CompanionSafetyResourceBody = { text: 'Fictional reviewed body.', resourceCard: {
  title: 'Fictional support resources', contacts: [{ id: 'fictional-resource', verifiedAt: at, name: 'Fictional contact', description: 'Fictional description.',
    actions: [{ kind: 'call', number: '123456', label: 'Fictional call' }, { kind: 'sms', number: '123456', body: 'FICTIONAL TEST', label: 'Fictional SMS' },
      { kind: 'web', url: 'https://example.com/', label: 'Fictional website' }] }], schoolUnknown: 'Fictional school lookup.',
  footer: 'Fictional no contact action.', outsideUs: { label: 'Fictional outside-US option', text: 'Fictional local resource instruction.' },
} };
export const resourceState = (patch: Partial<CompanionSafetyResourceState> = {}): CompanionSafetyResourceState => ({
  sourceKind: 'companion_name', publicationId: id(3), submissionId: id(4), edition: 1, revision: 0, status: 'ready', level: 'L2', mode: 'full',
  preparedAt: at, publishedAt: at, retentionUntil: until, presented: false, acknowledged: false, handled: false, clarifiedAt: null, ...patch,
});
export const projection = (state = resourceState(), projectionId = id(5)): CompanionSafetyBodyProjection => ({
  sourceKind: state.sourceKind, publicationId: state.publicationId, submissionId: state.submissionId, revision: state.revision,
  bodyProjectionId: projectionId, body, retentionUntil: state.retentionUntil,
});
export const questionState = (patch: Partial<CompanionSafetyQuestionState> = {}): CompanionSafetyQuestionState => ({
  sourceKind: 'companion_name', publicationId: id(3), submissionId: id(4), scopeRevision: 0, possibleLegacyExposure: false,
  deliveryUncertain: false, receiptReceivedAt: null, sourcePhase: null, ...patch,
});
export const claim = (request: { operationId: string; occurrenceId: string; generation: number; renderOwnerId: string }, remaining = 10000) => ({
  sourceKind: 'companion_name' as const, publicationId: id(3), occurrenceId: request.occurrenceId, grantId: id(7), generation: request.generation,
  renderOwnerId: request.renderOwnerId, scopeRevision: 2, status: 'display_granted' as const, question: 'Fictional direct safety question?',
  grantPresentationToken: grantToken, displayUntil: new Date(Date.parse(at) + remaining).toISOString(), serverNow: at, remainingDisplayMs: remaining,
  operation: { id: request.operationId, appliedRevision: 2, replayed: false },
});
