import { parseCareerProgressSnapshot } from '@companion/platform-contracts';
import { careerProgress } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { CareerStories } from './career-stories.ts';
import type { CareerApplications } from './career-applications.ts';

/** One owner lock and transaction for the complete current source snapshot.
 * Sources authenticate records and immutable receipts before deriving counts.
 * Private owner statistics only; not shared memory or a model input. */
export class CareerProgressService {
    constructor(private readonly db: Database,
        private readonly stories: Pick<CareerStories, 'readProgressEvidenceInTransaction'>,
        private readonly applications: Pick<CareerApplications, 'readProgressEvidenceInTransaction'>) {}
    async read(context: FixedSessionContext, signal?: AbortSignal) {
        return this.db.withBoundedTransaction(async client => {
            const projects = await this.stories.readProgressEvidenceInTransaction(client, context, signal);
            const applications = await this.applications.readProgressEvidenceInTransaction(client, context, signal);
            await authorizeFixedSession(client, context, signal);
            signal?.throwIfAborted();
            return parseCareerProgressSnapshot({ ownerId: context.userId, progress: careerProgress(context.userId, [...projects, ...applications]),
                coverage: Object.freeze(['project', 'application'] as const) });
        });
    }
}
