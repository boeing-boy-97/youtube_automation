# `packages/validation`

One zod schema per request/response contract, imported by the API (to parse) and the web app (to
type its forms). Adding an endpoint means adding a schema here first, so both sides cannot drift.

Conventions: `.strict()` where extra fields are a bug, `z.coerce` for query strings, human-readable
error messages (they are shown to the user verbatim).
