import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * The user's own gesture on our panel, reported to the worker.
 *
 * Kept apart from the UA-5 transport it borrows its page rules from. That file
 * is a reviewed production source whose surface the Field Lab ceiling is pinned
 * against, and this is a different concern: not a step of a run, but the report
 * that a person asked for one.
 *
 * The message carries no authority. It names the page the gesture happened on
 * so the worker can check that against the sender it already registered, and
 * nothing else — every decision about whether a write lease is minted stays in
 * the worker, where the page cannot reach it.
 */
export interface DockFillIntent {
  readonly kind: 'pilot-ua5/dock-fill-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
}

const KEYS = ['kind', 'version', 'origin', 'pathname'] as const;

export function parseDockFillIntent(value: unknown): DockFillIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = keysBesidesDocumentPath(value);
  // Exact keys, not merely sufficient ones: an extra field is a shape we did not
  // agree to, and this message is one hop from minting write authority.
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'pilot-ua5/dock-fill-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string'
  ) return null;
  // Reuse the page identity rules rather than restating them: an origin or a
  // path the page-ready report would refuse is not one a gesture may name.
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  return Object.freeze({
    kind: 'pilot-ua5/dock-fill-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
  });
}

/** The message a trusted gesture on our panel sends; null for a page we refuse. */
export function createDockFillIntent(origin: string, pathname: string): DockFillIntent | null {
  return parseDockFillIntent({
    kind: 'pilot-ua5/dock-fill-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
  });
}
