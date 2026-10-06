import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./assistant/preview', import.meta.url)),
  base: './',
  server: { host: '127.0.0.1', port: 8871, strictPort: true },
  build: { outDir: '../../.assistant-preview', emptyOutDir: true, target: 'es2022',
    rollupOptions: { input: {
      preview: fileURLToPath(new URL('./assistant/preview/index.html', import.meta.url)),
      profile: fileURLToPath(new URL('./assistant/preview/profile.html', import.meta.url)),
      session: fileURLToPath(new URL('./assistant/preview/session.html', import.meta.url)),
    } },
  },
});
