# Independent assistant UI preview

This is the inherited React assistant presentation, retained to inspect and reuse its interaction patterns. It is not the final new-product design. The preview uses fictional data and service ports; installed runtime wiring is a separate adapter.

From this workspace:

```sh
pnpm --filter @edaix/extension preview:ui
pnpm --filter @edaix/extension build:ui
```

Open `http://127.0.0.1:8871/`. Preview controls switch identity, scenes, entitlements and synthetic service failures. Reset cancels pending work and restores fictional state. `/profile.html` demonstrates editing, and `/session.html` demonstrates refresh, expiry and owner switching. The build is ignored under `.assistant-preview/`.

## Where to change the UI

- `design/`: palette, tokens and motion constants.
- `shell/`: panel geometry, launcher, headers, overlays and the lazy boat scene.
- `scenes/`: the actual screen layouts.
- `app/*-view.ts`: pure projections from presentation state.
- `features/` and `state/`: controllers, immutable snapshots and cancellation epochs.
- `ports/`: typed UI service interfaces, separate from HTTP/channel protocols.
- `runtime/`: the installed extension's Chrome and authenticated-service adapter.
- `testing/` and `preview/`: fictional data and adapters, excluded from installed runtime entries.

Changes to the React styling and scene layouts can be reviewed without modifying the fill interpreter or a backend. The old imperative dock lives separately under `../lib/dock`; editing one UI does not automatically update the other.

The preview does not upload real files, record real audio, save profiles remotely, fill employer pages or submit applications. Paid-model calls are not required. A preview success is not evidence of real authentication or ATS behavior.

## Historical source limitations

The source README described dated S2/S3 staging builds, old extension IDs, nonexistent `docs/plans` links and package tasks that are absent from the current source snapshot. Those instructions are retired for this new product. Prior product staging and production shortcuts were removed from `../package.json`; use the local commands above.

A future installed assistant integration should use this workspace's shared contracts and explicit new-product API configuration. Do not connect the inherited UI to ArgoLand staging as a development shortcut. The main extension README documents the local artifact and its execution limits.
