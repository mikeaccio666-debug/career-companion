import type { CreateJobInput } from '@companion/platform-contracts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';

/** Deployment admission policy for new workbench execution, never user authority. */
export function assertWorkbenchAdmission(config: Pick<PlatformConfig, 'workbenchEnabled'>, kind: CreateJobInput['kind']): void {
  if (config.workbenchEnabled !== true && ['browser', 'cli', 'workflow', 'image', 'video', 'mcp'].includes(kind)) {
    throw new ApiError(403, 'WORKBENCH_DISABLED', 'Workbench task creation and new starts are disabled on this server.');
  }
}
