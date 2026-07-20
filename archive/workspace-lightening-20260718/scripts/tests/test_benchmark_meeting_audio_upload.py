import argparse
import importlib.util
import pathlib
import sys
import tempfile
import unittest
import wave


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "benchmark_meeting_audio_upload.py"
SPEC = importlib.util.spec_from_file_location("benchmark_meeting_audio_upload", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MeetingAudioUploadBenchmarkHelpersTest(unittest.TestCase):
    def test_base_url_validation(self):
        self.assertEqual(MODULE.validate_base_url("https://example.com/root/"), "https://example.com/root")
        for value in ("ftp://example.com", "https://user:pass@example.com", "https://example.com?a=1"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                MODULE.validate_base_url(value)

    def test_minutes_validation(self):
        self.assertEqual(MODULE.parse_minutes("0.5, 1,10"), [0.5, 1.0, 10.0])
        for value in ("", "0", "181", "nan", "one"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                MODULE.parse_minutes(value)

    def test_percentile_uses_nearest_rank(self):
        self.assertEqual(MODULE.percentile([1, 2, 3, 100], 0.95), 100)
        self.assertIsNone(MODULE.percentile([], 0.95))

    def test_generated_wav_has_expected_format_and_size(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sample.wav"
            size = MODULE.write_silence_wav(path, 0.01, sample_rate=16_000)
            self.assertEqual(size, 44 + 16_000 * 2 * 60 // 100)
            with wave.open(str(path), "rb") as source:
                self.assertEqual(source.getnchannels(), 1)
                self.assertEqual(source.getsampwidth(), 2)
                self.assertEqual(source.getframerate(), 16_000)


if __name__ == "__main__":
    unittest.main()
