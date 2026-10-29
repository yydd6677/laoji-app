"""Narrow source-owner invariants; real-board tests still required."""
from pathlib import Path
import re
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'main' / 'recorder.c').read_text()


class CaptureOwnerTest(unittest.TestCase):
    def test_i2s_consumer_never_waits_for_sd_hash_or_radio(self):
        producer = SOURCE.split('static void capture_task(', 1)[1].split('static void storage_task(', 1)[0]
        for forbidden in ('lj_fs_mutex', 'fwrite(', 'fflush(', 'fsync(', 'mbedtls_', 'lj_ble_audio(', 'finish('):
            self.assertNotIn(forbidden, producer)
        self.assertIn('lj_pcm_fifo_put(', producer)
        self.assertIn('source_failure = "audio_failed"', producer)

    def test_file_hash_and_live_ring_have_only_one_writer(self):
        writer = SOURCE.split('static void storage_task(', 1)[1].split('static void live_task(', 1)[0]
        self.assertEqual(len(re.findall(r'cap\.bytes \+=', SOURCE)), 1)
        self.assertIn('cap.bytes += bytes', writer)
        self.assertLess(writer.index('fwrite('), writer.index('mbedtls_sha256_update('))
        self.assertLess(writer.index('mbedtls_sha256_update('), writer.index('cap.bytes += bytes'))
        # A stop drains the bounded accepted prefix, not a dummy/silent tail.
        self.assertLess(writer.index('lj_pcm_fifo_get('), writer.index('if (!bytes)'))
        self.assertIn('if (s.finalizing)', writer)


if __name__ == '__main__': unittest.main()
