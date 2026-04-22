---
"@withboundary/sdk": patch
---

Bump `@withboundary/contract` peer dep to `^1.4.0` and move the test suite to `zod@^4`.

Contract 1.4.0 accepts both zod v3 and v4 schemas via an internal adapter, so consumers on either zod major are supported transparently. The SDK itself has no direct zod coupling — all schema typing flows through `@withboundary/contract`'s `ContractSchema<T>`.
