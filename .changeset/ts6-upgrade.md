---
"@withboundary/sdk": patch
---

Upgrade to TypeScript 6.

- `devDependencies.typescript`: `^5.5.0` → `^6.0.3`
- `tsconfig.json`: add `"ignoreDeprecations": "6.0"` to silence `TS5101` for the implicit `baseUrl` that tsup's dts builder emits internally. Will revisit before TS 7.

Supersedes dependabot PR #19, which couldn't land cleanly without the tsconfig mitigation. No runtime or API changes.
