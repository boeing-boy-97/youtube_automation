# Monitoring

Two independent layers, both reading the real services:

1. **In-app health** (always on) — `GET /api/system/health` and `GET /api/system/overview`
   probe PostgreSQL, Redis, storage, the AI engine, the video processor, Gemini and the
   platform integrations on every request. The dashboard's *System administration* page renders
   exactly these probes, so there is no separate source of truth to drift.
2. **Prometheus + exporters** (optional) — `prometheus.yml` scrapes the same endpoints and
   `alerts.yml` defines availability and backlog alerts. Add the exporters to your compose
   override if you want the scrapes to succeed:

   ```yaml
   postgres-exporter:
     image: prometheuscommunity/postgres-exporter:v0.16.0
     environment: { DATA_SOURCE_NAME: "postgresql://clipforge:${POSTGRES_PASSWORD}@postgres:5432/clipforge?sslmode=disable" }
   redis-exporter:
     image: oliver006/redis_exporter:v1.67.0
     environment: { REDIS_ADDR: "redis://redis:6379" }
   ```

A `404` on `metrics_path: /api/system/health` from Prometheus is expected: that endpoint returns
a JSON health document, not a Prometheus exposition format. Use it with a blackbox exporter, or
scrape `postgres-exporter`/`redis-exporter` for time series and rely on the alerting above for
service availability.
