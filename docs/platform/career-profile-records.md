# Owner-confirmed career profiles

This implements the ordinary career facts referenced by product 03 §3.4 and the /career/profile endpoint in 09 §3A. The existing identity clock remains a separate, conditionally visible surface.

## Current behavior

The personal profile page lets a signed-in student explicitly confirm, edit or delete degree field, graduation month, graduated status and interested role families. Empty values remain unknown. Role interest does not activate a career target. There is no automatic intake backfill or model-authored confirmation.

Migration 088 creates one encrypted current record per user and an immutable encrypted operation journal. Every write uses the current revision and an owner-generated operation UUID. Deletion physically removes the facts, keeps only coordinate/digest receipts, and preserves the revision counter. Retrying an earlier save after deletion cannot restore it; observing an old deletion after recreation returns the newer current record. Account deletion cascades both tables.

Routes: GET/PATCH/DELETE /api/platform/career/profile and GET /api/platform/career/profile/operations/:id. Existing real session, window-account binding, origin checks, cancellation and bounded transactions apply. New confirmations require current legal consent and verified email; owner reads, read-only operation recovery, deletion and private export remain available after that admission is withdrawn. Responses are private/no-store.

The Web client verifies owner, operation, revision and confirmed facts. An uncertain response preserves the original command; observation only reads. Hidden/offline pages hide the profile and suspend requests. Resume observes an uncertain command rather than sending it again. Account invalidation clears the local state.

CareerPreparationSources now reads the actual profile in the same transaction as other career data. It distinguishes an unavailable adapter from an available-but-empty record, includes profile metadata in the source digest, and builds confirmed-profile only when degree field, graduation month and at least one role family are known. Profile changes invalidate captured source coordinates. This does not grant execution tools or bypass conversation/evaluation admission.

Account export includes decoded current facts and sanitized operation metadata. Catalog review covers both direct user ownership FKs, the composite operation FK and account deletion. The complete public account export remains subject to its existing coverage gates.

## Remaining product work

05 asks the user to choose program duration, while 09 says to infer it from graduation month. That conflict is awaiting product clarification. program_type, program_start_date and recruiting_cycle are not implemented by this increment, and no values are inferred for them. Projection from confirmed onboarding answers remains to be integrated. This is not completion of all profile or onboarding requirements.

The main student route still requires the real first-letter/onboarding gate. The isolated browser fixture mounts the actual profile page and account client against real authenticated fixture APIs; it does not assert that the complete onboarding or main conversation is available.

## Verification and rollout

Automated coverage exercises actual PostgreSQL persistence/restarts, concurrent edits, deletion/recreation and old retries, owner/staff/revoked sessions, admission withdrawal, ciphertext/receipt integrity, transaction rollback, profile source revision checks, HTTP authentication/origin/account boundaries and account export.

Browser checks use fictional accounts and an isolated schema on edaix-dev. No production/main-preview migration, main-preview restart, real user data, paid model call or deployment is part of this change. Migration 088 must be applied through the reviewed release process before enabling this page in a deployed build.

Verification passed: 47 targeted API/database tests, 29 Web tests and 86 contract tests; API/Web/contracts type checks and Web production build. The 395-test affected export regression had 393 initial passes and two old file-archive table-count assertions; after reviewing the two added profile projections, both corrected cases passed their focused rerun. All 17 additional file-export tests passed.

Browser save/reload, clearing a field to unknown, offline hiding and recovery, and delete/reload passed at 390px and 1440px. Screenshots were visually inspected. The browser fixture was closed, its isolated schema was removed and its provider-call counter was zero.
