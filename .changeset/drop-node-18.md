---
"@withboundary/sdk": patch
---

Drop Node 18 support. Bump minimum `engines.node` to `>=20` and update the CI matrix to Node 20/22/24.

Node 18 LTS ended on 2025-04-30. Several dev-only deps (vitest 4+, rolldown) already use Node-20-only APIs (`node:util.styleText`), so Node 18 was effectively unsupported at the dev/tooling level — this just formalizes it for consumers.

No runtime behavior change; no API change. Users on Node 20+ are unaffected. Mirrors the same drop in `@withboundary/contract@1.4.1`.
