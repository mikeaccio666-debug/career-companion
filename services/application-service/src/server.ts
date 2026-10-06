import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readVerifiedRulesRelease } from './rules-release.ts';

const ROUTES = new Set(['/health', '/api/v1/automation/rules-release']);

export async function createApplicationReferenceServer() {
  const release = await readVerifiedRulesRelease();
  const rulesBody = JSON.stringify(release);
  const etag = `"rules1_${release.rules.releaseDigest.slice('sha256:'.length)}"`;

  return createServer((request, response) => {
    const pathname = request.url?.split('?')[0];
    // Legacy protected routes are deliberately absent from this local server.
    if (!pathname || !ROUTES.has(pathname)) {
      sendJson(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (!isEmptyRead(request)) {
      sendJson(response, 400, { code: 'READ_INPUT_NOT_ALLOWED' });
      return;
    }
    if (pathname === '/health') {
      sendJson(response, 200, { status: 'ok', referenceOnly: true, executionEnabled: false });
      return;
    }
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'public, max-age=60, must-revalidate, no-transform');
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.writeHead(200).end(rulesBody);
  });
}

function isEmptyRead(request: IncomingMessage): boolean {
  return !request.url?.includes('?') &&
    (request.headers['content-length'] === undefined || request.headers['content-length'] === '0') &&
    request.headers['transfer-encoding'] === undefined;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.writeHead(status).end(JSON.stringify(value));
}
