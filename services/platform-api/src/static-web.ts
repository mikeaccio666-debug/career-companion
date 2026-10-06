import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';

const extensions = new Set(['.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.webmanifest']);
const hashedAsset = /^assets\/(?:[^/]+\/)*[^/]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/;

function notFound(reply: FastifyReply) {
  return reply.code(404).header('Cache-Control', 'no-store').send({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' } });
}

/** Decode once before filesystem resolution; never normalize away a traversal. */
function requestPath(rawUrl: string): string | undefined {
  const raw = rawUrl.split('?', 1)[0];
  if (!raw.startsWith('/') || raw.length > 4096 || raw.includes('#')) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (/[\x00-\x1f\x7f\\%]/.test(decoded) || decoded.includes('//') || /%2f|%5c/i.test(raw)) return undefined;
  if (decoded.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) return undefined;
  return decoded;
}

function acceptsHtml(request: FastifyRequest): boolean {
  return (request.headers.accept ?? '').split(',').some(entry => {
    const [media, ...parameters] = entry.trim().split(';');
    if (media.toLowerCase() !== 'text/html') return false;
    const quality = parameters.map(item => item.trim()).find(item => /^q=/i.test(item));
    return quality === undefined || /^(?:1(?:\.0{1,3})?|0(?:\.[0-9]{1,3})?)$/.test(quality.slice(2)) && Number(quality.slice(2)) > 0;
  });
}

async function publicFiles(root: string): Promise<Map<string, Stats>> {
  const files = new Map<string, Stats>();
  async function visit(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile() || name !== 'index.html' && !extensions.has(path.posix.extname(name).toLowerCase())) continue;
      const file = await fs.lstat(path.join(root, name));
      if (!file.isFile() || file.isSymbolicLink()) continue;
      files.set(name, file);
    }
  }
  await visit('');
  return files;
}

/** Only immutable build files are served; no directory redirects, listings or user uploads. */
export async function configureStaticWeb(app: FastifyInstance, directory: string): Promise<void> {
  let root: string, files: Map<string, Stats>;
  try {
    const supplied = await fs.lstat(directory);
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) throw new Error();
    root = await fs.realpath(directory);
    files = await publicFiles(root);
    if (!files.has('index.html')) throw new Error();
  } catch { throw new Error('PLATFORM_WEB_STATIC_DIR must contain a regular, built index.html'); }

  // The plugin supplies MIME types, ETags and streaming; it never chooses a path itself.
  await app.register(fastifyStatic, { root, serve: false, dotfiles: 'deny', index: false, redirect: false, cacheControl: false });
  app.setNotFoundHandler((_request, reply) => notFound(reply));
  app.addHook('onRequest', async (request, reply) => {
    if (requestPath(request.raw.url ?? '') === undefined) return notFound(reply);
  });

  async function serve(request: FastifyRequest, reply: FastifyReply) {
    const pathname = requestPath(request.raw.url ?? '');
    if (pathname === undefined || pathname === '/api' || pathname.startsWith('/api/')) return notFound(reply);
    let relative = pathname.slice(1);
    if (!files.has(relative)) {
      const navigation = request.method === 'GET' && acceptsHtml(request) && !path.posix.extname(relative)
        && pathname !== '/assets' && !pathname.startsWith('/assets/');
      if (!navigation) return notFound(reply);
      relative = 'index.html';
    }
    const expected = files.get(relative)!;
    const filename = path.join(root, relative);
    try {
      const actual = await fs.lstat(filename);
      if (!actual.isFile() || actual.isSymbolicLink() || await fs.realpath(filename) !== filename
        || actual.ino !== expected.ino || actual.dev !== expected.dev || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) return notFound(reply);
    } catch { return notFound(reply); }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', relative === 'index.html' ? 'no-cache' : hashedAsset.test(relative)
      ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    return reply.sendFile(relative, { cacheControl: false });
  }
  app.route({ method: ['GET', 'HEAD'], url: '/', handler: serve });
  app.route({ method: ['GET', 'HEAD'], url: '/*', handler: serve });
}
