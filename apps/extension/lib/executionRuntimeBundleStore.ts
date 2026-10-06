import type { ExecutionRuntimeBundleV1 } from '@edaix/contracts';

/**
 * One-key MV3 storage record.  The browser storage API commits the value for
 * one key atomically, so readers can never observe an ETag/version/revision
 * from one release next to another release's raw canonical response body.
 * Keeping rawBody means every later reader can re-run the duplicate-key-aware
 * contract decoder; no permissively parsed object becomes an authority.
 */
export const EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY = 't10ExecutionRuntimeBundleV1';

export interface ExecutionRuntimeBundleKeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ExecutionRuntimeBundleStore {
  read(): Promise<unknown>;
  write(
    etag: string,
    bundle: ExecutionRuntimeBundleV1,
    rawBody: string,
  ): Promise<void>;
}

export function createExecutionRuntimeBundleStore(
  storage: ExecutionRuntimeBundleKeyValueStore,
): ExecutionRuntimeBundleStore {
  return Object.freeze({
    read: () => storage.get(EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY),
    write: (
      etag: string,
      bundle: ExecutionRuntimeBundleV1,
      rawBody: string,
    ) => storage.set(
      EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY,
      Object.freeze({
        schemaVersion: 1 as const,
        etag,
        runtimeBundleVersion: bundle.runtimeBundleVersion,
        releaseRevision: bundle.releaseRevision,
        rawBody,
      }),
    ),
  });
}
