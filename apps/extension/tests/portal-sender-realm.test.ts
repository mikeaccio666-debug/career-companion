import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  isAllowedPortalSender,
  resolvePortalSenderOrigin,
} from '../lib/portalSenderRealm';

const PORTAL = 'https://edaix.io';

describe('external Portal sender realm', () => {
  it('gates external ports before any handshake authority is created', () => {
    const background = readFileSync(
      new URL('../entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    const realmGate = background.indexOf('if (!isAllowedPortalSender(sender, allowedPortalOrigins))');
    const handshake = background.indexOf('createExtensionHandshakeCoordinator({');
    expect(realmGate).toBeGreaterThan(-1);
    expect(handshake).toBeGreaterThan(realmGate);
  });

  it('accepts only an exact allowlisted realm', () => {
    expect(isAllowedPortalSender({ origin: PORTAL }, [PORTAL])).toBe(true);
    expect(isAllowedPortalSender({ url: `${PORTAL}/workspace` }, [PORTAL])).toBe(true);
    expect(isAllowedPortalSender({ origin: 'https://evil.example' }, [PORTAL])).toBe(false);
    expect(isAllowedPortalSender({}, [PORTAL])).toBe(false);
  });

  it('fails closed when Chrome sender origin and URL disagree', () => {
    expect(resolvePortalSenderOrigin({
      origin: PORTAL,
      url: 'https://evil.example/workspace',
    })).toBeNull();
    expect(isAllowedPortalSender({
      origin: PORTAL,
      url: 'https://evil.example/workspace',
    }, [PORTAL])).toBe(false);
  });

  it.each([
    'https://edaix.io/',
    'https://user@edaix.io',
    'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'not-a-url',
  ])('rejects a non-canonical explicit origin %s', (origin) => {
    expect(resolvePortalSenderOrigin({ origin })).toBeNull();
  });
});
