# `infrastructure/`

Everything required to run the system elsewhere.

```
docker/       Dockerfile.api, Dockerfile.web, Dockerfile.ai-engine, Dockerfile.video-processor
deployment/   Caddyfile, compose overrides, TLS/proxy notes
monitoring/   log and metric plumbing (see its README)
scripts/      run-service.sh, healthcheck.sh, backup.sh, restore.sh, verify-pipeline.py
```

`scripts/run-service.sh <ai-engine|video-processor> <port>` is the local launcher: it loads `.env`
without overwriting variables already set in the environment (which is how the test stack forces
`AI_PROVIDER=fixture`).

Production compose lives at the repository root (`docker-compose.prod.yml`) because it mounts the
whole project; service definitions here are referenced from it.
