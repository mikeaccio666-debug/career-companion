import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * The user asked for this posting to be added to their list.
 *
 * Kept apart from the fill gesture because it asks for something different: not
 * a step of a run, but that a posting enter the catalog. Sharing one message
 * would mean one check deciding two unrelated permissions.
 *
 * The message carries no authority and no description of the posting. It names
 * the page the gesture happened on so the worker can check that against the
 * sender it already registered, and nothing else -- the worker builds the URL it
 * sends from that, so a content script cannot nominate what gets added.
 */
export interface DockAddJobIntent {
  readonly kind: 'dock/add-job-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
}

const KEYS = ['kind', 'version', 'origin', 'pathname'] as const;

export function parseDockAddJobIntent(value: unknown): DockAddJobIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = keysBesidesDocumentPath(value);
  // Exact keys, not merely sufficient ones: an extra field is a shape we did not
  // agree to, and this message reaches an authenticated write.
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'dock/add-job-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string'
  ) return null;
  // Reuse the page identity rules rather than restating them: an origin or path
  // the page-ready report would refuse is not one a gesture may name.
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  return Object.freeze({
    kind: 'dock/add-job-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
  });
}

/** The message a trusted gesture on our panel sends; null for a page we refuse. */
export function createDockAddJobIntent(origin: string, pathname: string): DockAddJobIntent | null {
  return parseDockAddJobIntent({
    kind: 'dock/add-job-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
  });
}
