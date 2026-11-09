# `packages/platform-connectors`

YouTube Data API v3 and Instagram Graph API clients. Both expose the same shape: exchange tokens,
list channels, upload/publish, verify, refresh, and a `PlatformError` carrying `classification`
(`AUTH` | `RATE_LIMIT` | `RETRYABLE` | `PERMANENT`) that the publish worker maps to retry policy.

`http.ts` holds the shared transport: timeouts, retry-after handling, redaction of tokens in logs.
