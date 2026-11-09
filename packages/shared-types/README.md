# `packages/shared-types`

Types and constants both apps must agree on: the job state machine and its legal transitions,
`CONFIG_KEYS` + which are required for processing/publishing, platform enums, API DTO shapes.

If a value is used by more than one workspace package, it belongs here — not duplicated.
