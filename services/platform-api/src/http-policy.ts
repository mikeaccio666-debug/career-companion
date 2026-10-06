import cors from '@fastify/cors';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';

const prefix = '/api/platform';
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const allowedHeaders = ['Content-Type', 'Accept', 'Range', 'If-Range', 'If-Match'];
const allowedHeaderNames = new Set(allowedHeaders.map(value => value.toLowerCase()));
const exposedHeaders = ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag', 'Content-Disposition', 'Retry-After'];

function platformRequest(request: FastifyRequest): boolean {
  const pathname = request.url.split('?', 1)[0];
  return pathname === prefix || pathname?.startsWith(`${prefix}/`) === true;
}

// This is a browser transport policy, not authentication or permission to execute a task.
export async function configurePlatformHttp(app: FastifyInstance, config: PlatformConfig): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!platformRequest(request)) return;
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Origin');
    if (request.method !== 'OPTIONS' || !request.headers.origin || !config.allowedOrigins.has(request.headers.origin)) return;
    const method = request.headers['access-control-request-method'];
    const headers = request.headers['access-control-request-headers'];
    if (method !== undefined && (typeof method !== 'string' || !methods.includes(method))
      || headers !== undefined && (typeof headers !== 'string' || headers.split(',').some(value => !allowedHeaderNames.has(value.trim().toLowerCase())))) {
      throw new ApiError(400, 'PREFLIGHT_REJECTED', 'This browser request is not supported.');
    }
  });
  await app.register(cors, {
    delegator: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, {
        origin: platformRequest(request) && typeof origin === 'string' && config.allowedOrigins.has(origin) ? origin : false,
        credentials: true, methods, allowedHeaders, exposedHeaders,
        strictPreflight: true, optionsSuccessStatus: 204,
      });
    },
  });
}
