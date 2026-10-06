import { PLATFORM_ACCOUNT_HEADER, PLATFORM_ACCOUNT_QUERY, platformAccountId } from '@companion/platform-contracts';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

const invalidContext = () => new ApiError(400, 'ACCOUNT_CONTEXT_INVALID', 'Use one valid account context for this request.');

/** An assertion about the window's account, never authentication or an identity grant. */
export function requireAccountContext(request: FastifyRequest, authenticatedId: string, allowFileQuery = false): void {
  const header = request.headers[PLATFORM_ACCOUNT_HEADER];
  const query = request.query as Record<string, unknown> | undefined;
  const hasQuery = !!query && Object.hasOwn(query, PLATFORM_ACCOUNT_QUERY);
  const queryValue = hasQuery ? query![PLATFORM_ACCOUNT_QUERY] : undefined;
  const rawHeaders = request.raw.rawHeaders;
  let headerCount = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === PLATFORM_ACCOUNT_HEADER) ++headerCount;
  }
  if (headerCount > 1 || header !== undefined && !platformAccountId(header)
    || hasQuery && (!allowFileQuery || !platformAccountId(queryValue))) throw invalidContext();
  if (header !== undefined && hasQuery && header.toLowerCase() !== (queryValue as string).toLowerCase()) throw invalidContext();
  const expected = header ?? queryValue;
  if (expected === undefined) throw new ApiError(409, 'ACCOUNT_CONTEXT_REQUIRED', 'Confirm the signed-in account before continuing.');
  if ((expected as string).toLowerCase() !== authenticatedId.toLowerCase()) {
    throw new ApiError(409, 'ACCOUNT_CONTEXT_CHANGED', 'The signed-in account changed. Confirm it before continuing.');
  }
}
