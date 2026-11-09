# `services/video-processor` — rendering

FastAPI service wrapping FFmpeg. Stateless: bytes in, an MP4 and a measurement report out.

## Modules

| file | responsibility |
| --- | --- |
| `main.py` | `/health`, `/probe`, `/validate`, `/audio-analysis`, `/render` |
| `renderer.py` | filter graph, encode, output validation (probe + content scan) |
| `framing.py` | face-track / centre-crop / blur decisions, 9:16 composition |
| `subtitles.py` | ASS generation from real word timings, highlight events |
| `audio.py` | loudness (EBU R128), silence, clipping, volume measurement |

## Rules

* A render is only successful when the **content** is publishable, not merely decodable: no audio
  stream, silent audio (`< -55 dB`), A/V drift (`> 0.5 s`), mostly-black (`> 60%`) or mostly-frozen
  (`> 50%`) output is rejected with a classified error.
* Every number in the report is measured with ffprobe/ffmpeg — nothing is estimated.
* Source with no audio is refused before encoding (a clear error beats an FFmpeg exit code).
