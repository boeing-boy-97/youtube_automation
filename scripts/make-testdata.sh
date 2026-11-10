#!/usr/bin/env bash
# Generate the synthetic media the end-to-end suites upload.
#
#   bash scripts/make-testdata.sh [output-dir]     # default: /home/user/testdata
#
# Why speech and not a tone: the pipeline's quality gate refuses to invent highlights from media
# with no speech ("Transcription produced no speech segments"). A sine wave therefore exercises the
# rejection path, not the happy path. This script narrates tests/fixtures/speech-script.txt with
# espeak-ng and muxes it onto a moving test pattern, so the fixtures are reproducible offline and
# contain real, transcribable speech.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-/home/user/testdata}"
SCRIPT="$ROOT/tests/fixtures/speech-script.txt"
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (sudo apt-get install -y ffmpeg)" >&2; exit 1; }

if command -v espeak-ng >/dev/null; then
  TTS=espeak-ng
elif command -v espeak >/dev/null; then
  TTS=espeak
else
  TTS=""
fi

if [ -n "$TTS" ]; then
  # 150 wpm keeps the ~700-character script near 45 s of natural speech.
  "$TTS" -v en-us -s 150 -w "$OUT/speech.wav" "$(cat "$SCRIPT")"
  SPEECH="$OUT/speech.wav"
  echo "  narrated the fixture script with $TTS"
else
  SPEECH=""
  echo "  WARNING: espeak-ng not installed — generating silent fixtures. The pipeline will" >&2
  echo "  correctly reject them with ANALYSIS_REJECTED; install espeak-ng for full E2E runs." >&2
fi

# Sizes are deliberately modest: a 1080p/40 s source OOM-kills ffmpeg inside a small sandbox, and
# the pipeline needs real frames plus real speech, not resolution for its own sake.
# The narration is ~45 s, and the pipeline targets 30 s clips (the fixture provider needs a
# transcript window of at least 0.7 x target), so the video must span the speech, not a fixed 24 s.
if [ -n "$SPEECH" ]; then
  SECONDS_LEN="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SPEECH" | cut -d. -f1)"
else
  SECONDS_LEN=45
fi

build() { # name widthxheight fps bitrate
  local name="$1" size="$2" fps="$3" bitrate="$4"
  local audio_args
  if [ -n "$SPEECH" ]; then
    audio_args=(-i "$SPEECH")
  else
    audio_args=(-f lavfi -i "sine=frequency=440:sample_rate=44100:duration=$SECONDS_LEN")
  fi
  ffmpeg -hide_banner -loglevel error -y -threads 2 \
    -f lavfi -i "testsrc2=size=$size:rate=$fps:duration=$SECONDS_LEN" \
    "${audio_args[@]}" \
    -map 0:v:0 -map 1:a:0 \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v "$bitrate" \
    -c:a aac -b:a 96k -shortest "$OUT/$name"
}

# 1280x720: the full-workflow fixture (downscale, centre-crop, subtitle burn-in, audio).
build hd-source.mp4 1280x720 25 1800k
# 960x540: the lighter fixture the long scenario suite uses.
build light-source.mp4 960x540 25 1200k

for file in hd-source.mp4 light-source.mp4; do
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration \
    -of csv=p=0 "$OUT/$file" | awk -v f="$file" -F, '{printf "  %-18s %sx%s  %ss\n", f, $1, $2, $3}'
done
echo "test fixtures written to $OUT"
