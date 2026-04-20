---
"@withboundary/sdk": patch
---

Publish with [npm provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC trusted publishing.

Every release now ships with a signed attestation linking the tarball back to the exact commit and workflow that built it in [`withboundary/sdk-js`](https://github.com/withboundary/sdk-js). Consumers can verify the supply chain themselves with:

```bash
npm audit signatures
```

No API or behavior changes.
