#!/usr/bin/env python3

from __future__ import annotations

import unittest

from ljhw_protocol import (
    FLAG_FINAL,
    Frame,
    FrameDecoder,
    KIND_CONTROL_REQUEST,
    KIND_LIVE_AUDIO,
    ProtocolError,
    control_payload,
)


class FrameContractTest(unittest.TestCase):
    def test_fragmented_round_trip_and_boot_noise(self) -> None:
        expected = Frame(
            kind=KIND_CONTROL_REQUEST,
            flags=0,
            stream_id=0,
            sequence=7,
            correlation_id=9,
            payload=control_payload("diagnostics.ping", command_id="probe-1"),
        )
        wire = b"ESP-ROM boot noise\r\n" + expected.encode()
        decoder = FrameDecoder()
        actual = []
        for offset in range(0, len(wire), 3):
            actual.extend(decoder.feed(wire[offset : offset + 3]))
        self.assertEqual(actual, [expected])
        self.assertEqual(actual[0].json()["op"], "diagnostics.ping")

    def test_audio_final_round_trip(self) -> None:
        frame = Frame(
            kind=KIND_LIVE_AUDIO,
            flags=FLAG_FINAL,
            stream_id=42,
            sequence=11,
            correlation_id=0,
            payload=b"\x01\x00\xff\xff",
        )
        self.assertEqual(FrameDecoder().feed(frame.encode()), [frame])

    def test_crc_failure_is_closed(self) -> None:
        frame = Frame(
            kind=KIND_LIVE_AUDIO,
            flags=0,
            stream_id=2,
            sequence=1,
            correlation_id=0,
            payload=b"audio",
        )
        wire = bytearray(frame.encode())
        wire[-1] ^= 0x80
        with self.assertRaises(ProtocolError):
            FrameDecoder().feed(bytes(wire))

    def test_reserved_flag_is_rejected(self) -> None:
        with self.assertRaises(ProtocolError):
            Frame(
                kind=KIND_LIVE_AUDIO,
                flags=0x80,
                stream_id=1,
                sequence=1,
                correlation_id=0,
                payload=b"",
            ).encode()

    def test_usb_short_packet_terminator_is_ignored_between_frames(self) -> None:
        first = Frame(
            kind=KIND_CONTROL_REQUEST,
            flags=0,
            stream_id=0,
            sequence=1,
            correlation_id=1,
            payload=control_payload("recording.list", command_id="probe-1"),
        )
        second = Frame(
            kind=KIND_CONTROL_REQUEST,
            flags=0,
            stream_id=0,
            sequence=2,
            correlation_id=2,
            payload=control_payload("status.get", command_id="probe-2"),
        )
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(first.encode() + b"\x00"), [first])
        self.assertEqual(decoder.feed(second.encode()), [second])


if __name__ == "__main__":
    unittest.main()
