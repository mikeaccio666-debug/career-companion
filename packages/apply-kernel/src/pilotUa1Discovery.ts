import {
  PILOT_UA1_DETECTION_OUTCOMES,
  PILOT_UA1_SCHEMA_VERSION,
  parsePilotUa1DiscoveryPacket,
  type PilotUa1DiscoveryParseResult,
  type PilotUa1DiscoveryResult,
} from '@edaix/contracts/draft';

/**
 * Deterministic UA-1 interpreter. It validates and copies the value-free wire,
 * then emits one closed detection receipt for every supplied visible control.
 * Canonical-field inference belongs to UA-2; DOM access, network, writes,
 * clicks, events, and Submit do not exist on this package surface.
 */
export function scanPilotUa1Discovery(
  input: unknown,
): PilotUa1DiscoveryParseResult<PilotUa1DiscoveryResult> {
  const parsed = parsePilotUa1DiscoveryPacket(input);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: PILOT_UA1_SCHEMA_VERSION,
      binding: parsed.value.binding,
      outcomes: Object.freeze(parsed.value.controls.map((control) => Object.freeze({
        identityDigest: control.identityDigest,
        outcome: PILOT_UA1_DETECTION_OUTCOMES[0],
      }))),
    }),
  };
}
