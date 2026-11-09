# AI pipeline

## Stages

1. **Probe** — the video processor runs FFprobe; the API records duration, dimensions, frame rate,
   codecs, bitrate and audio-stream presence. Anything outside the configured limits is rejected
   with a reason, not truncated silently.
2. **Audio extraction** — FFmpeg extracts 16 kHz mono WAV for transcription.
3. **Transcription** — Faster-Whisper (`WHISPER_MODEL` is configured explicitly, never defaulted)
   returns word-level timestamps. The model, device and compute type are recorded with the job.
4. **Frame sampling** — key frames are sampled across the source for visual context (scene
   changes, on-screen text, presenter vs. B-roll).
5. **Structured analysis** — Gemini receives the timestamped transcript plus the sampled frames and
   must answer with JSON conforming to a strict schema. The request is bounded
   (`ai.max_candidates_per_call`), retried a bounded number of times on transport errors, and a
   response that fails schema validation is rejected rather than coerced.

## Candidate contract

```json
{
  "start_time": 12.4,
  "end_time": 42.9,
  "target_duration": 30,
  "hook": "the exact line that opens the clip",
  "reason": "why this moment stands alone",
  "transcript": "verbatim words inside the window",
  "content_category": "educational",
  "quality_score": 82,
  "confidence": 0.78,
  "visual_context": "what the frame shows at the start"
}
```

## Validation before anything is rendered

The model proposes; `services/ai-engine/app/selection.py` decides.

* Timestamps must lie inside the source and must map onto the transcript.
* Boundaries snap to sentence ends where possible and word timestamps otherwise, so a clip never
  starts mid-word.
* `transcript` is re-derived from the Whisper words rather than trusted from the model.
* Quality score is recomputed from the rubric below; the model's number is only a signal.
* Candidates below `ai.min_quality_score` are dropped. If nothing survives, the job completes with
  an explicit *no candidates above threshold* result — it does not invent clips.
* The clip count is emergent. Nothing is padded to reach 5, 10 or any other number.

## Scoring rubric

| Factor | Weight | Question |
| --- | --- | --- |
| hookQuality | 0.16 | Does the first 1–2 seconds work alone? |
| standaloneMeaning | 0.12 | Understandable without the surrounding video? |
| completeness | 0.12 | A finished thought, not a fragment? |
| informationalValue | 0.12 | Does the viewer gain something concrete? |
| emotionalEngagement | 0.10 | Emotion, tension, curiosity or surprise? |
| viewerInterest | 0.10 | Would a cold viewer stop scrolling? |
| storytelling | 0.09 | Micro-narrative with a payoff? |
| audioClarity | 0.07 | Clear speech, no clipping or heavy noise? |
| visualSuitability | 0.07 | Usable in a vertical crop? |
| contextPreservation | 0.05 | Essential context preserved? |

## Duplicate suppression

Two candidates are the same moment when their transcript windows overlap and their text similarity
(`difflib` ratio) exceeds `clips.duplicate_similarity_threshold`. The lower scoring candidate is
dropped and the decision is recorded in the job result, so an operator can see what was suppressed
rather than wondering where a clip went.

## Dual duration (15 s / 30 s)

A 30 s clip is the analysed window. A 15 s variant is produced only when a coherent sub-window
exists — the boundary must land on a sentence or word boundary and the shortened text must retain
standalone meaning. When it does not, no 15 s file is produced and the reason is stored on the
clip. Both variants carry their own word-level caption timings; nothing is stretched or time-shifted.

## Metadata generation

Per-platform metadata is generated in a second structured call with the workspace brand profile
(voice, audience) and the clip's own transcript in context:

* **YouTube** — title (≤100 chars), description, hashtags, tags, category.
* **Instagram** — caption (≤2200 chars), hashtags, CTA, and source attribution when a reference URL
  exists.

Previews are shown before publishing, and metadata can be edited (`PATCH /api/clips/:id/metadata`)
which is audited as `CLIP_METADATA_EDITED`.

## Provider modes

`AI_PROVIDER=gemini` is the production path. `AI_PROVIDER=fixture` exists **only** for automated
tests and requires `TEST_MODE=1`; every fixture output is prefixed `[fixture provider — no model
was called]` so it can never be mistaken for a model result.
