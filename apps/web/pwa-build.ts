import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestTransform } from 'workbox-build';
import type { VitePWAOptions } from 'vite-plugin-pwa';
import { BRAND } from './src/brand.ts';

export const PWA_PUBLIC_FILES = [
  'index.html', 'mark.svg', 'manifest.webmanifest', 'pwa-legacy-cleanup.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
] as const;
const staticFiles = new Set<string>(PWA_PUBLIC_FILES);
const hashedAsset = /^assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|jpe?g|webp|avif|woff2?)$/;

/** Build-owned URLs only: no query normalization, external URL, raw upload, or private response. */
export function publicPrecachePath(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\\%?#\x00-\x20\x7f]/.test(value) || value.startsWith('/')
    || !(staticFiles.has(value) || hashedAsset.test(value))) throw new Error('PWA precache contains a non-public build path.');
  return value;
}

/** Every byte, including HTML, is integrity checked by Workbox's actual installation fetch. */
export function publicPrecacheIntegrity(directory: string): ManifestTransform {
  return async (entries) => {
    const root = await realpath(directory), seen = new Set<string>();
    const manifest = [];
    for (const entry of entries) {
      const relative = publicPrecachePath(entry.url);
      if (seen.has(relative)) throw new Error('PWA precache contains a duplicate build path.');
      seen.add(relative);
      const filename = path.join(root, relative), metadata = await lstat(filename);
      if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(filename) !== filename) throw new Error('PWA precache requires regular build files.');
      const bytes = await readFile(filename);
      manifest.push({ ...entry, integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}` });
    }
    // Workbox warns and omits oversized files. A missing required shell must fail this build.
    const assets = path.join(root, 'assets');
    const metadata = await lstat(assets);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('PWA assets require a regular build directory.');
    const required = [...PWA_PUBLIC_FILES, ...(await readdir(assets)).map((name) => `assets/${name}`).filter((name) => hashedAsset.test(name))];
    if (required.some((name) => !seen.has(name))) throw new Error('PWA precache is missing a required public build file.');
    return { manifest, warnings: [] };
  };
}

/** No private endpoint or parameter-bearing navigation is routed through the cached shell. */
export const PWA_NAVIGATION_ALLOWLIST = [/^\/(?:index\.html)?$/];
export const PWA_NAVIGATION_DENYLIST = [/^\/(?:api|uploads|artifacts|auth)(?:\/|$)/, /[?]/];

export function platformPwaOptions(directory: () => string): Partial<VitePWAOptions> {
  return {
    strategies: 'generateSW', filename: 'sw.js', registerType: 'prompt', injectRegister: false,
    manifest: {
      name: BRAND.name, short_name: BRAND.name, description: BRAND.description,
      id: '/', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#f7f8f2', theme_color: BRAND.themeColor,
      icons: [
        { src: BRAND.mark, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    includeAssets: [], includeManifestIcons: false, devOptions: { enabled: false },
    workbox: {
      cacheId: 'companion', skipWaiting: false, clientsClaim: false, cleanupOutdatedCaches: false,
      inlineWorkboxRuntime: true, sourcemap: false, runtimeCaching: [],
      importScripts: ['/pwa-legacy-cleanup.js'], globFollow: false,
      globPatterns: [...PWA_PUBLIC_FILES, 'assets/*.{js,css,svg,png,jpg,jpeg,webp,avif,woff,woff2}'],
      globIgnores: ['**/*.map'], maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
      manifestTransforms: [(entries) => publicPrecacheIntegrity(directory())(entries)],
      navigateFallback: '/index.html', navigateFallbackAllowlist: PWA_NAVIGATION_ALLOWLIST,
      navigateFallbackDenylist: PWA_NAVIGATION_DENYLIST,
      ignoreURLParametersMatching: [],
    },
  };
}
