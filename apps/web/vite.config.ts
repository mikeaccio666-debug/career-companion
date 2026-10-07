import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { createPlatformEndpoints } from './src/platform-endpoints.ts';
import { platformPwaOptions } from './pwa-build.ts';
import { BRAND } from './src/brand.ts';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  createPlatformEndpoints(env.VITE_PLATFORM_API_ORIGIN);
  let pwaOutputDirectory = '';
  return {
    plugins: [{
      name: 'companion-public-shell',
      configResolved(config) { pwaOutputDirectory = path.resolve(config.root, config.build.outDir); },
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
          return html.replaceAll('__BRAND_NAME__', escape(BRAND.name))
            .replaceAll('__BRAND_DESCRIPTION__', escape(BRAND.description))
            .replaceAll('__BRAND_THEME_COLOR__', escape(BRAND.themeColor));
        },
      },
    },
      ...VitePWA(platformPwaOptions(() => pwaOutputDirectory))],
    server: { host: '127.0.0.1', port: 4321, proxy: { '/api': { target: env.VITE_PLATFORM_PROXY || 'http://127.0.0.1:4320', changeOrigin: false } } },
    build: { target: 'es2022' },
  };
});
