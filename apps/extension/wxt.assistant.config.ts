import { defineConfig } from 'wxt';

/** Local container experiment. This config is never selected by a release script. */
export default defineConfig({
  srcDir: 'assistant/spike',
  outDir: '.assistant-spike',
  manifest: {
    name: 'ArgoLand.AI UI Container Lab',
    version: '0.0.2',
    permissions: [],
    host_permissions: [],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; connect-src 'none'" },
    web_accessible_resources: [{ resources: ['assistant.html', 'chunks/*', 'assets/*'], matches: ['http://127.0.0.1/*'] }],
  },
});
