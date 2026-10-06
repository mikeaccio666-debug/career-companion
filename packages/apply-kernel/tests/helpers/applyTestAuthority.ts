import {
  mintAuthority,
  type HostWriteAuthority,
  type WriteCapability,
  type WritePurpose,
} from '../../src/grant';
import { createBundledApplyPolicy, type ApplyPolicy } from '../../src/policy';

/**
 * happy-dom cannot create a browser-trusted click itself. This helper only
 * models the trusted-event boundary for unit tests; production code still
 * checks the platform-owned `Event.isTrusted` value.
 */
export function testAuthority(
  fingerprint: string | null,
  purpose: WritePurpose = 'fill',
  capabilities?: readonly WriteCapability[],
): HostWriteAuthority {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [shadowRoot, host, document.body, document, window],
  });

  const minted = mintAuthority({
    event,
    shadowRoot,
    purpose,
    fingerprint,
    capabilities: capabilities ? new Set(capabilities) : undefined,
  });
  if (!minted.ok) throw new Error(`test authority unexpectedly rejected: ${minted.code}`);
  return minted.value;
}

/** A fresh, valid baseline for direct runner tests. */
export function testApplyPolicy(): ApplyPolicy {
  return createBundledApplyPolicy(Date.now());
}
