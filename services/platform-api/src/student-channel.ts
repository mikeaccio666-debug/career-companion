import type { Capability, Conversation, PlatformProviderRuntime, ProviderStatus, PublicCapabilities } from '@companion/platform-contracts';
import type { PlatformConfig } from './config.ts';
import { chatAttachmentSupport } from './audio-transcriptions.ts';
import { ApiError, invalid, object, string } from './errors.ts';
import { mode } from './conversation-turns.ts';
import { modelRouteAvailability, resolveModelRoute } from './model-routing.ts';
import { projectPublicCapabilities } from './student-projection.ts';

/** The HTTP channel accepts intent, never caller-owned provider or model routing. */
export function serverMessageInput(config: PlatformConfig, runtime: PlatformProviderRuntime, value: unknown): Record<string, unknown> {
  const data = object(value);
  if (Object.hasOwn(data, 'provider') || Object.hasOwn(data, 'model')) throw invalid('Model selection is managed by the server.');
  if (Object.hasOwn(data, 'goalPlanStep')) {
    if (Object.keys(data).some(key => key !== 'goalPlanStep')) throw invalid('Use only the original goal-plan checkpoint.');
    return { goalPlanStep: data.goalPlanStep };
  }
  const allowed = config.workbenchEnabled ? ['content', 'attachmentIds', 'audioTranscripts', 'mode', 'persona'] : ['content', 'attachmentIds', 'audioTranscripts'];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw invalid('Unsupported conversation request field.');
  // Preserve content validation before a configured-route availability failure.
  const content = string(data.content, 'content', 20_000), requestedMode = config.workbenchEnabled ? mode(data.mode) : 'chat';
  const route = resolveModelRoute(config, runtime, requestedMode === 'agent' ? 'agent' : 'chat');
  return { ...data, content, mode: requestedMode, provider: route.provider, model: route.model };
}

export function serverConversationInput(config: PlatformConfig, value: unknown): Pick<Conversation, 'title' | 'mode' | 'persona'> {
  const data = object(value), allowed = config.workbenchEnabled ? ['title', 'mode', 'persona'] : ['title'];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw invalid('Unsupported conversation request field.');
  return { title: string(data.title, 'title', 200, false) || 'New conversation', mode: config.workbenchEnabled ? mode(data.mode) : 'chat',
    ...(config.workbenchEnabled ? { persona: string(data.persona, 'persona', 2000, false) || undefined } : {}) };
}

/** Extra HTTP admission closes legacy speech and generic definition entry points.
 * Accepted worker execution and the shared JobService retain their own semantics. */
export function assertHttpWorkbench(config: Pick<PlatformConfig, 'workbenchEnabled'>): void {
  if (config.workbenchEnabled !== true) throw new ApiError(403, 'WORKBENCH_DISABLED', 'Workbench creation and new starts are disabled on this server.');
}

/** Availability uses one genuine runtime catalogue; it does not probe a provider. */
export function serverPublicCapabilities(config: PlatformConfig, runtime: PlatformProviderRuntime, mcp?: ProviderStatus): PublicCapabilities {
  let providers: ProviderStatus[];
  try { providers = runtime.capabilities(); } catch { providers = []; }
  const snapshot = { ...runtime, capabilities: () => providers };
  const available = modelRouteAvailability(config, snapshot);
  const capabilities: Record<Capability, boolean> = {
    ...available, speech: config.workbenchEnabled && available.speech,
    image: false, video: false, browser: false, cli: false, workflow: false, mcp: false,
  };
  if (config.workbenchEnabled) {
    for (const capability of ['image', 'video', 'browser', 'cli', 'workflow', 'mcp'] as const) {
      capabilities[capability] = [...providers, ...(mcp ? [mcp] : [])].some(provider => provider.enabled === true && provider.capabilities.includes(capability));
    }
  }
  let support;
  if (available.chat) {
    const selected = resolveModelRoute(config, snapshot, 'chat');
    support = chatAttachmentSupport(snapshot, providers.find(provider => provider.id === selected.provider)!);
  }
  return projectPublicCapabilities(capabilities, support);
}
