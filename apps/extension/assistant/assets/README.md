# Accepted product artwork

These assets implement Mike's selected `ArgoLand 插件完整设计2.zip` design (SHA-256
`90cafeceb693088fe8ec6671cd93768d67025de3156e39a24484a8cee9821202`).

- `mentors/`: the four Portal portraits selected by the Fable design; product artwork,
  not QA screenshots. They match the same named Portal assets.
- `boat/boat-scene.js`: editable, procedural scene from the supplied design; imported
  once and bundled against the original Three.js 0.180.0. No remote script or model loader.
- `boat/THREE-LICENSE.txt`: the supplied Three.js MIT license.

The original reference bundle and all visual QA captures remain in ignored local
storage. `support.js`, generated screenshots and the original minified Three.js
bundle are not shipped by this implementation.
