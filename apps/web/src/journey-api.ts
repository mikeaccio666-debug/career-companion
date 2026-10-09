import type { BoundPlatformClient } from './api.ts';
import { readCareerTargets } from './career-target-api.ts';
import { readCareerApplications } from './career-application-api.ts';
import { readInterviewRecords } from './career-interview-api.ts';
import { readCareerLibrary } from './career-story-api.ts';
import { readResumeReviews } from './resume-review-api.ts';
import { readMentorIntents } from './mentor-intent-api.ts';

/** Reuse domain decoders/owner checks. These are independent pages, never a
 * cross-domain transactional snapshot or a complete journey-stage calculation. */
function read<T>(operation: (client: BoundPlatformClient, signal: AbortSignal) => Promise<T>) {
  return async (client: BoundPlatformClient, signal: AbortSignal): Promise<T> => {
    if (!client.isCurrent()) throw Error('Account changed.');
    signal.throwIfAborted();
    const value = await operation(client, signal);
    signal.throwIfAborted();
    if (!client.isCurrent()) throw Error('Account changed.');
    return value;
  };
}
export const journeyReads = {
  targets: read((client, signal) => readCareerTargets(client, signal)),
  applications: read((client, signal) => readCareerApplications(client, null, null, signal)),
  interviews: read((client, signal) => readInterviewRecords(client, null, null, signal)),
  stories: read((client, signal) => readCareerLibrary(client, 'story', null, signal)),
  resumes: read((client, signal) => readResumeReviews(client, null, signal)),
  mentors: read((client, signal) => readMentorIntents(client, null, signal)),
} as const;
