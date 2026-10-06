# Deterministic application interpreter

Copied from `edaix-official/argoland-extension` main `d1a496bfce8249c694792ad70c237fe5b943aaee` (2026-10-05), retaining all source, tests and synthetic fixtures.

This package interprets validated application-rule data and produces guarded operations. Browser execution remains in `apps/extension`; product UI, Chrome APIs, networking and credentials must not be introduced here. Site knowledge belongs in `packages/apply-rules`, and shared wire contracts are owned by this workspace's `packages/contracts`.

```sh
pnpm --filter @edaix/apply-kernel check
pnpm --filter @edaix/apply-kernel test
```

Historical comments and fixture provenance describe the original implementation; they do not imply that this new product is deployed or authorized for sensitive writes. The compatibility package name is temporary.
