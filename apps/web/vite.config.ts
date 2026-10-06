import { defineConfig, loadEnv } from 'vite';
import { createPlatformEndpoints } from './src/platform-endpoints.ts';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  createPlatformEndpoints(env.VITE_PLATFORM_API_ORIGIN);
  return {
    server: { host: '127.0.0.1', port: 4321, proxy: { '/api': { target: env.VITE_PLATFORM_PROXY || 'http://127.0.0.1:4320', changeOrigin: false } } },
    build: { target: 'es2022' },
  };
});
