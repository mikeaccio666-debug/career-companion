import type { PlatformProviderRuntime, ProviderStatus } from '@companion/platform-contracts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';

export const MODEL_ROUTE_PURPOSES = ['chat', 'agent', 'realtime', 'transcription', 'speech'] as const;
export type PublicModelRoutePurpose = typeof MODEL_ROUTE_PURPOSES[number];
export type ModelRoutePurpose = PublicModelRoutePurpose | 'safety_classify' | 'companion_generation';
export interface ResolvedModelRoute {
  purpose: ModelRoutePurpose; provider: string; model: string; voice?: string;
}

type RouteConfig = Pick<PlatformConfig, 'modelRoutes'>;
type RouteRuntime = Pick<PlatformProviderRuntime, 'capabilities'>;

function unavailable(): ApiError {
  return new ApiError(503, 'MODEL_ROUTE_UNAVAILABLE', 'The requested capability is unavailable.');
}

function boundedValue(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.trim() === value && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}

function catalogue(runtime: RouteRuntime): ProviderStatus[] {
  try {
    const statuses = runtime.capabilities();
    if (Array.isArray(statuses)) return statuses;
  } catch {
    // Configuration diagnostics stay private; no alternate runtime is selected.
  }
  return [];
}

function selectedRoute(config: RouteConfig, statuses: ProviderStatus[], purpose: ModelRoutePurpose): ResolvedModelRoute | undefined {
  const internal = purpose === 'safety_classify' || purpose === 'companion_generation';
  if (!internal && !(MODEL_ROUTE_PURPOSES as readonly string[]).includes(purpose)) return undefined;
  const providerId = config.modelRoutes[purpose]?.provider;
  if (typeof providerId !== 'string' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.exec(providerId)?.[0] !== providerId) return undefined;
  const matches = statuses.filter(status => status?.id === providerId);
  if (matches.length !== 1) return undefined;
  const provider = matches[0];
  if (provider.enabled !== true || !Array.isArray(provider.capabilities) || !provider.capabilities.includes(internal ? 'chat' : purpose as PublicModelRoutePurpose)) return undefined;

  // Internal generation/classification require explicit server models. Ordinary chat metadata cannot configure them.
  if (internal) {
    const descriptor = Object.getOwnPropertyDescriptor(provider, 'modelsByPurpose');
    const mapping = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))) return undefined;
    const entry = Object.getOwnPropertyDescriptor(mapping, purpose);
    const models = entry && 'value' in entry ? entry.value : undefined;
    if (provider.id !== 'openai' || !Array.isArray(models) || models.length !== 1 || !boundedValue(models[0], 150)) return undefined;
    return { purpose, provider: providerId, model: models[0] };
  }

  const mapping = provider.modelsByCapability;
  // Only trusted legacy runtimes lacking capability-specific metadata may use
  // one flat model. An explicit empty/missing capability entry never falls back.
  if (mapping !== undefined && (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))) return undefined;
  const models = mapping === undefined ? provider.models : mapping[purpose];
  if (!Array.isArray(models) || models.length !== 1 || !boundedValue(models[0], 150)) return undefined;
  const route: ResolvedModelRoute = { purpose, provider: providerId, model: models[0] };
  if (purpose === 'speech' || purpose === 'realtime') {
    const options = provider.voiceOptions?.[purpose];
    if (!options || !boundedValue(options.defaultVoice, 100) || !Array.isArray(options.voices)
      || !options.voices.every(voice => boundedValue(voice, 100)) || !options.voices.includes(options.defaultVoice)) return undefined;
    route.voice = options.defaultVoice;
  }
  return route;
}

/** Resolves only a server binding and advertised runtime metadata; never calls a model. */
export function resolveModelRoute(config: RouteConfig, runtime: RouteRuntime, purpose: ModelRoutePurpose): ResolvedModelRoute {
  const route = selectedRoute(config, catalogue(runtime), purpose);
  if (!route) throw unavailable();
  return route;
}

/** Configuration availability, not a network health probe or execution authorization. */
export function modelRouteAvailability(config: RouteConfig, runtime: RouteRuntime): Record<PublicModelRoutePurpose, boolean> {
  const statuses = catalogue(runtime);
  return Object.fromEntries(MODEL_ROUTE_PURPOSES.map(purpose => [purpose, !!selectedRoute(config, statuses, purpose)])) as Record<PublicModelRoutePurpose, boolean>;
}

/** The single platform model admission facade; provider adapters remain database-free. */
export { ModelConsent, requireModelConsent, requireRequestAdmission } from './model-consent.ts';
export type { ModelJobClaim } from './model-consent.ts';
