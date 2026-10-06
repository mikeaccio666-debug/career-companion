# Career domain foundation

This package defines the career companion's business rules independently of the model SDK, UI, legacy Argoland portal and browser extension. It currently provides seven versioned skill definitions, draft-run preparation, knowledge/job ports and evidence-derived progress. It has no API routes, persistence implementation, model execution or connected private knowledge base.

`prepareCareerRun` consumes an authenticated server context and current references. Missing connectors, foreign ownership, withdrawn/stale references, conflicting references and changed profile revisions block preparation. A ready result is a bounded draft plan that always requires review and forbids external actions. It is not a signed grant, authorization decision, task lease or execution receipt. The real API must recheck ownership, current revisions and authority whenever a port runs.

`careerProgress` consumes a current owner-scoped evidence ledger snapshot. It deduplicates stable subjects, lets withdrawal/rejection override old observations, and separates provisional observations from confirmed evidence. Practice/resume review milestones require a mentor review; this indicates a review occurred, not mastery or improvement. AI feedback and user-completed practice can still be displayed as provisional practice activity. Project/outreach/application/interview milestones require user confirmation or mentor review. A Gmail header is only a provisional observation. Ingestion must validate references, reviewer identity and confirmation; do not accept a model's or client's `verification` field as trusted.

Mentor review additionally needs an authenticated reviewer reference, matching evidence scope, review date and rubric revision. A review of one artifact cannot endorse every skill. User-confirmed evidence must be labelled as the user's confirmation, not independent verification.

References contain no raw CV, email, audio, token or screenshot. Knowledge retrieval must apply document access before search and return source revisions/passages. Citation `updatedAt` is knowledge-version registration time; unknown original modification dates stay unknown in the adapter. Jobs preserve their source, observation time, open/unknown state and explicit/unknown sponsorship; they are not a national vacancy count or an interview probability.

```sh
pnpm --filter @companion/career-core check
pnpm --filter @companion/career-core test
```

Tests use fictional references and run without models, browsers, databases or external services. See [career architecture](../../docs/career/architecture.md) for the next authenticated persistence and runtime integration.
