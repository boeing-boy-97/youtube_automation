# `services/ai-engine` — transcription and analysis

FastAPI service. Receives a video path, returns scored clip candidates. Holds no database
connection; the API persists everything.

## Modules

| file | responsibility |
| --- | --- |
| `main.py` | HTTP surface: `/health`, `/probe`, `/analyse` |
| `pipeline.py` | stage sequence + report assembly |
| `media.py` | ffprobe/ffmpeg helpers, frame sampling, scene detection |
| `transcribe.py` | faster-whisper, word-level timestamps |
| `vision.py` | batched frame description (cost-controlled), returns token usage |
| `gemini.py` | Gemini client: structured output, bounded retries, usage extraction |
| `selection.py` | the rubric: validation, snapping to word boundaries, scoring, dedup, variants |
| `captions.py` | deterministic per-platform title/caption generation |
| `fixture_provider.py` | TEST ONLY — mechanical candidates so the pipeline can be tested without a key |
| `config.py` | settings; refuses to start without an explicit `AI_PROVIDER` |

## Rules

* The model proposes, this service validates. Model timestamps are never trusted verbatim.
* Calls are cost-bounded: frames are sampled and batched, and token usage is returned to the caller.
* `AI_PROVIDER=fixture` requires `TEST_MODE=1` and is refused in production.
