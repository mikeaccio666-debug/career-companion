/** Operational identity only: this response does not assert business-feature or database release approval. */
export type DeploymentVersion = Readonly<{ schemaVersion: 1; revision: string; releaseId: string }>;
export const DEPLOYMENT_VERSION_UNAVAILABLE = Object.freeze({ code: 'DEPLOYMENT_VERSION_UNAVAILABLE' as const });
export type DeploymentVersionResponse = DeploymentVersion | typeof DEPLOYMENT_VERSION_UNAVAILABLE;

export function parseDeploymentVersion(value: unknown): DeploymentVersion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.schemaVersion !== 1
    || typeof record.revision !== 'string' || !/^[a-f0-9]{40}$/u.test(record.revision)
    || typeof record.releaseId !== 'string'
    || !/^[a-f0-9]{40}-[a-z][a-z0-9-]{0,31}-(?:x64|arm64)-[a-f0-9]{12}$/u.test(record.releaseId)
    || !record.releaseId.startsWith(`${record.revision}-`)) return null;
  return { schemaVersion: 1, revision: record.revision, releaseId: record.releaseId };
}

export function deploymentVersionFromEnvironment(environment: Readonly<Record<string, string | undefined>>): DeploymentVersion | null {
  return parseDeploymentVersion({ schemaVersion: 1, revision: environment.EDAIX_RELEASE_REVISION, releaseId: environment.EDAIX_RELEASE_ID });
}

/** Explicit container listener for infra/deployment/compose.yaml: app ports are never host-published. */
export function deploymentListenHost(environment: Readonly<Record<string, string | undefined>>): '127.0.0.1' | '0.0.0.0' {
  const host = environment.EDAIX_LISTEN_HOST ?? '127.0.0.1';
  if (host === '127.0.0.1') return host;
  if (host === '0.0.0.0' && deploymentVersionFromEnvironment(environment)) return host;
  throw new Error('DEPLOYMENT_LISTEN_HOST_INVALID');
}
