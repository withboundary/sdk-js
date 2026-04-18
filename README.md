# @withboundary/sdk-js

JavaScript/TypeScript SDKs for [Boundary](https://withboundary.com) — observability, tracing, and correctness tooling for LLM applications.

## Packages

- **[@withboundary/sdk](./packages/sdk)** — Trace SDK. Ships contract runs to Boundary's cloud dashboard with batching, retries, and redaction.

Pairs with **[@withboundary/contract](https://github.com/withboundary/contract-js)** — the OSS correctness engine.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Publishing

Releases are managed with [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset           # describe the change
pnpm changeset version   # bump versions, update CHANGELOGs
pnpm changeset publish   # publish to npm (usually in CI)
```

## Other language SDKs

This repo ships the JavaScript/TypeScript SDKs only. Other runtimes live in sibling repos under the [withboundary](https://github.com/withboundary) GitHub organization:

- (Python, Go, etc. — published as needed.)

## License

[MIT](./LICENSE)
