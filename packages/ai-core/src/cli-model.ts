import { ProviderError } from './errors.ts';

export const OPENAI_CLI_ENDPOINT = 'https://api.openai.com/v1/responses';
export type CliModelProvider = 'openai' | 'ollama';
export interface CliModelConfiguration {
  provider: CliModelProvider; model: string; endpoint: string; configured: boolean; enabled: boolean;
}

/** Server configuration only. No caller URL or credential enters the container. */
export function cliModelConfiguration(env: NodeJS.ProcessEnv): CliModelConfiguration {
  const provider = env.PLATFORM_CLI_MODEL_PROVIDER || 'openai';
  if (provider !== 'openai' && provider !== 'ollama')
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Select a supported server CLI model provider.', 503);
  const model = env.PLATFORM_CLI_MODEL || (provider === 'ollama' ? env.OLLAMA_CHAT_MODEL : env.OPENAI_CHAT_MODEL || 'gpt-6-astra');
  if (!model || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model))
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Configure the server CLI model.', 503);
  if (provider === 'openai') return { provider, model, endpoint: OPENAI_CLI_ENDPOINT,
    configured: Boolean(env.OPENAI_API_KEY), enabled: Boolean(env.OPENAI_API_KEY) && env.PLATFORM_ALLOW_PROVIDER_CALLS === '1' };

  const base = env.PLATFORM_CLI_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL;
  // Check the literal authority before URL parsing normalizes alternative IP forms.
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(?:\/v1)?\/?$/.exec(base || '');
  if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Connect the CLI to a literal loopback Ollama HTTP service.', 503);
  // This adapter is for installed models. Cloud models belong behind a commercial gate.
  if (/(?:-cloud|:cloud)$/.test(model))
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Select an installed local model for the Ollama CLI relay.', 503);
  const endpoint = new URL('/v1/responses', base).toString();
  return { provider, model, endpoint, configured: true, enabled: true };
}
