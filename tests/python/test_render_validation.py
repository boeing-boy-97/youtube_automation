"""Tests for render output validation (probe + content scanning).

Run with:  .venv/bin/python tests/python/test_render_validation.py   (or `npm run test:python`)

The parser tests fake FFmpeg's stderr so they are instant and deterministic. The verdict tests
encode real fixtures with FFmpeg and assert that the validator rejects files that are technically
valid MP4s but unpublishable (silent, black, frozen, wrong size).
"""
from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# The service directory contains a dash, so it is a namespace package imported by name, exactly
# as uvicorn does in production: uvicorn services.video-processor.app.main:app
renderer = importlib.import_module("services.video-processor.app.renderer")

FFMPEG = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe") or "ffprobe"
HAVE_FFMPEG = bool(shutil.which(FFMPEG))


def _stderr(text: str) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr=text)


class ContentScanParserTests(unittest.TestCase):
    """`_scan_content` must read FFmpeg's blackdetect/freezedetect log lines faithfully."""

    def _scan(self, stderr: str, duration: float | None = None) -> dict:
        with mock.patch.object(renderer.subprocess, "run", return_value=_stderr(stderr)):
            return renderer._scan_content("ffmpeg", "irrelevant.mp4", duration)

    def test_clean_output_reports_nothing(self):
        content = self._scan("frame= 240 fps=0.0 q=-0.0 size=N/A time=00:00:08.00\n", 8.0)
        self.assertEqual(content["blackSegments"], [])
        self.assertEqual(content["frozenSegments"], [])
        self.assertEqual(content["blackSeconds"], 0)
        self.assertEqual(content["frozenSeconds"], 0)

    def test_black_segments_are_summed(self):
        stderr = (
            "[blackdetect @ 0x1] black_start:0.5 black_end:2.0 black_duration:1.5\n"
            "[blackdetect @ 0x1] black_start:5.0 black_end:5.5 black_duration:0.5\n"
        )
        content = self._scan(stderr, 8.0)
        self.assertEqual(len(content["blackSegments"]), 2)
        self.assertAlmostEqual(content["blackSeconds"], 2.0, places=3)
        self.assertEqual(content["blackSegments"][0], {"start": 0.5, "end": 2.0, "seconds": 1.5})

    def test_freeze_with_end_is_recorded(self):
        stderr = (
            "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1\n"
            "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3.5\n"
            "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 4.5\n"
        )
        content = self._scan(stderr, 8.0)
        self.assertEqual(content["frozenSegments"], [{"start": 1.0, "end": 4.5, "seconds": 3.5}])

    def test_freeze_running_to_end_of_file_is_counted(self):
        """FFmpeg only logs freeze_end when motion resumes; a clip frozen to EOF must still fail."""
        stderr = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0\n"
        content = self._scan(stderr, 6.0)
        self.assertEqual(content["frozenSegments"], [{"start": 0.0, "end": 6.0, "seconds": 6.0}])
        self.assertAlmostEqual(content["frozenSeconds"], 6.0, places=3)

    def test_open_freeze_without_known_duration_is_not_invented(self):
        content = self._scan("[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0\n", None)
        self.assertEqual(content["frozenSegments"], [])

    def test_freeze_starting_after_measured_duration_is_ignored(self):
        content = self._scan("[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 9\n", 6.0)
        self.assertEqual(content["frozenSegments"], [])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg is not installed")
class ValidationVerdictTests(unittest.TestCase):
    """End-to-end verdicts against real encoded fixtures (1 s each, ~200x360)."""

    WIDTH = 202
    HEIGHT = 360
    SECONDS = 2

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="vp-validate-")
        cls.fixtures = {
            # moving picture + tone: the only fixture that should pass
            "healthy": (
                f"-f lavfi -i testsrc=size={cls.WIDTH}x{cls.HEIGHT}:rate=30:duration={cls.SECONDS} "
                f"-f lavfi -i sine=frequency=440:duration={cls.SECONDS}"
            ),
            # moving picture + digital silence
            "silent": (
                f"-f lavfi -i testsrc=size={cls.WIDTH}x{cls.HEIGHT}:rate=30:duration={cls.SECONDS} "
                f"-f lavfi -i anullsrc=r=48000:cl=stereo -t {cls.SECONDS}"
            ),
            # black picture + tone
            "black": (
                f"-f lavfi -i color=c=black:s={cls.WIDTH}x{cls.HEIGHT}:d={cls.SECONDS}:r=30 "
                f"-f lavfi -i sine=frequency=440:duration={cls.SECONDS}"
            ),
        }
        for name, inputs in cls.fixtures.items():
            path = os.path.join(cls.tmp, f"{name}.mp4")
            subprocess.run(
                f"{FFMPEG} -v error {inputs} -t {cls.SECONDS} -c:v libx264 -pix_fmt yuv420p "
                f"-c:a aac -shortest -y {path}",
                shell=True,
                check=True,
                capture_output=True,
            )
            cls.fixtures[name] = path

        # A still image encoded as video: nothing moves for the whole clip.
        frozen = os.path.join(cls.tmp, "frozen.mp4")
        subprocess.run(
            f"{FFMPEG} -v error -f lavfi -i color=c=0x2e7d32:s={cls.WIDTH}x{cls.HEIGHT}:r=30:d={cls.SECONDS} "
            f"-f lavfi -i sine=frequency=440:duration={cls.SECONDS} -c:v libx264 -pix_fmt yuv420p "
            f"-c:a aac -shortest -y {frozen}",
            shell=True,
            check=True,
            capture_output=True,
        )
        cls.fixtures["frozen"] = frozen

        # A file with no audio stream at all.
        mute = os.path.join(cls.tmp, "mute.mp4")
        subprocess.run(
            f"{FFMPEG} -v error -f lavfi -i testsrc=size={cls.WIDTH}x{cls.HEIGHT}:rate=30:duration={cls.SECONDS} "
            f"-c:v libx264 -pix_fmt yuv420p -an -y {mute}",
            shell=True,
            check=True,
            capture_output=True,
        )
        cls.fixtures["mute"] = mute

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _validate(self, name: str, **overrides) -> dict:
        kwargs = dict(
            ffmpeg_path=FFMPEG,
            ffprobe_path=FFPROBE,
            output_path=self.fixtures[name],
            expected_width=self.WIDTH,
            expected_height=self.HEIGHT,
            expected_duration=float(self.SECONDS),
            expected_fps=30,
        )
        kwargs.update(overrides)
        return renderer.validate_output(**kwargs)

    def test_healthy_output_passes_without_errors_or_warnings(self):
        result = self._validate("healthy")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["warnings"], [])
        self.assertIsNotNone(result["meanVolumeDb"])
        self.assertGreater(result["meanVolumeDb"], -40)
        self.assertEqual(result["content"]["blackSegments"], [])
        self.assertEqual(result["content"]["frozenSegments"], [])
        self.assertEqual(result["probe"]["audio_duration_seconds"], self.SECONDS)

    def test_silent_audio_is_an_error(self):
        result = self._validate("silent")
        self.assertTrue(any("silent" in e for e in result["errors"]), result["errors"])

    def test_black_video_is_an_error(self):
        result = self._validate("black")
        self.assertTrue(any("black frames" in e for e in result["errors"]), result["errors"])

    def test_frozen_video_is_an_error(self):
        result = self._validate("frozen")
        self.assertTrue(any("frozen frames" in e for e in result["errors"]), result["errors"])

    def test_missing_audio_stream_is_an_error(self):
        result = self._validate("mute")
        self.assertTrue(any("No audio stream" in e for e in result["errors"]), result["errors"])

    def test_wrong_resolution_is_an_error(self):
        result = self._validate("healthy", expected_width=1080, expected_height=1920)
        self.assertTrue(any("Resolution" in e for e in result["errors"]), result["errors"])

    def test_missing_file_is_an_error(self):
        result = renderer.validate_output(
            ffmpeg_path=FFMPEG,
            ffprobe_path=FFPROBE,
            output_path=os.path.join(self.tmp, "does-not-exist.mp4"),
            expected_width=self.WIDTH,
            expected_height=self.HEIGHT,
            expected_duration=float(self.SECONDS),
            expected_fps=30,
        )
        self.assertEqual(result["errors"], ["Output file is missing or empty"])


if __name__ == "__main__":
    unittest.main()
