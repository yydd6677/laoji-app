import importlib.util
import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "generate_meeting_asr_samples.py"
SPEC = importlib.util.spec_from_file_location("generate_meeting_asr_samples", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class GenerateMeetingAsrSamplesTest(unittest.TestCase):
    def test_manifest_count_matches_samples(self):
        manifest = Path("test-assets/meeting-asr-voice-samples/manifest.json")
        self.assertEqual(28, len(MODULE.load_samples(manifest)))

    def test_manifest_rejects_count_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({"count": 2, "samples": [{"id": "x"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "count"):
                MODULE.load_samples(manifest)

    def test_wav_validator_accepts_mobile_recording_format(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "sample.wav"
            with wave.open(str(output), "wb") as audio:
                audio.setframerate(16000)
                audio.setsampwidth(2)
                audio.setnchannels(1)
                audio.writeframes(b"\x00\x00" * 160)
            MODULE.validate_wav(output)


if __name__ == "__main__":
    unittest.main()
