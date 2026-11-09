# syntax=docker/dockerfile:1.7
# FastAPI renderer: FFmpeg framing, face tracking, subtitle burn-in, loudness normalisation.
FROM python:3.13-slim-bookworm AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates fonts-inter fontconfig \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10004 app && useradd --uid 10004 --gid app --create-home app
WORKDIR /srv
COPY services/video-processor/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=app:app services/video-processor/app ./app
USER app
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8200/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200", "--workers", "1"]
