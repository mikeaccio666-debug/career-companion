export class ProviderError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, readonly status = 502) {
    super(publicMessage); this.name = 'ProviderError';
  }
}

export function invalid(message: string): never {
  throw new ProviderError('INVALID_PROVIDER_INPUT', message, 400);
}
