# Browser execution adapter

This module was copied from `edaix-official/argoland-extension` main `d1a496bfce8249c694792ad70c237fe5b943aaee` (2026-10-05), with its source, tests, synthetic fixtures and accepted UI assets. It is one optional part of the new career product.

## Local commands

From this workspace:

```sh
pnpm --filter @edaix/extension preview:ui
pnpm --filter @edaix/extension build:ui
pnpm --filter @edaix/extension check
pnpm --filter @edaix/extension build
```

`preview:ui` serves the independent React preview at `http://127.0.0.1:8871/`. It uses fictional service adapters and requires no backend, account or employer page. `/profile.html` and `/session.html` demonstrate the profile editor and session states. This makes styling and flow changes independently reviewable.

`build` creates `.output-local/chrome-mv3/` and then verifies the actual artifact. The default API is `http://localhost:3000`, the portal is `http://localhost:3100`, and host writing, runtime-bundle reads and telemetry are disabled. The build's public identity is separate from the source product; no private key is stored.

Direct WXT builds without overrides use the deliberately inert `.invalid` origins in `lib/deploymentConfig.ts`. Both the manifest and worker import that same boundary. Old staging/production build shortcuts were removed. Store build commands are retired; a direct `VIBE_DIST=store` invocation fails with `NEW_PRODUCT_STORE_RELEASE_UNCONFIGURED`. A future release needs an explicit new-product realm, identity and write policy. The original artifact tests remain as historical source until that release is designed.

## Module ownership

- `entrypoints/` and `lib/`: Chrome execution, session and page adapters; exact-page authorization and write safeguards.
- `assistant/scenes`, `assistant/shell`, `assistant/design`: React presentation and motion.
- `assistant/app`, `assistant/state`, `assistant/features`: presentation state and feature controllers, with typed ports.
- `assistant/runtime`: the installed extension adapter; its credentials and Chrome APIs stay out of the fictional preview.
- `assistant/testing`, `assistant/preview`: local fixtures and preview controls, excluded from installed runtime entries.
- `packages/apply-kernel`: deterministic interpreter; it does not own accounts, networking or product screens.
- `packages/apply-rules`: validated site-rule data; not executable remote scripts.
- `packages/agent-channel` and `packages/contracts`: messaging and shared protocol imports owned by this workspace.

The `@edaix/*` package names remain temporary import compatibility names. They do not imply a dependency on an external ArgoLand checkout or backend.

## Current limits

The source contains two UI systems: a modular React assistant and an older imperative dock. The dock, main content entry and background entry are large and should be split gradually behind their existing tests. The copy preserves behavior rather than claiming that every old product responsibility has already been extracted.

The installed runtime still needs a compatible auth/API service, signed intents, leases, runtime rules and reviewed write policy. A green build or fictional preview does not prove real ATS support. No actual form filling, application submission or paid model request was performed as part of this migration.

The source's review-queue proposal is not implemented here. Existing final submission requires a real user click inside the extension shadow root plus a current remote capability and a rule-declared final control. A phone approval does not satisfy that click. Several submission-animation and mission caches are still worker-memory-only; a durable queue would need a separately designed persisted state machine and idempotent recovery.
