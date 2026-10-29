"""Optional live-repair JSON contract; not a radio or audio-quality test."""
import json
import unittest
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[4]
SCHEMA = json.loads((ROOT / 'contracts/hardware/laoji-hardware-control-v1.3.schema.json').read_text())
VALIDATOR = Draft202012Validator(SCHEMA)


class LiveRepairContractTest(unittest.TestCase):
    def request(self):
        return dict(schema_version=1, op='capture.audio.read', command_id='request-1',
                    session_id='capture-1', stream_id=11, offset=492, length=984)

    def test_valid_request_cancel_reply_and_failure(self):
        VALIDATOR.check_schema(SCHEMA)
        VALIDATOR.validate(self.request())
        VALIDATOR.validate(dict(schema_version=1, op='capture.audio.read.cancel', command_id='cancel-1', stream_id=12))
        VALIDATOR.validate(dict(schema_version=1, op='capture.audio.read', command_id='request-1', ok=True,
            transfer=dict(transport='ble', session_id='capture-1', source_stream_id=11, stream_id=12,
                          offset_scope='audio_payload', offset=492, length=984, chunk_size_bytes=492)))
        VALIDATOR.validate(dict(schema_version=1, op='capture.audio.read', command_id='request-1', ok=False,
                               error=dict(code='source_range_unavailable', retryable=False)))

    def test_invalid_request_dimensions_and_identity(self):
        for key, value in [('length',0),('length',32770),('length',3),('offset',493),('offset',1.5),
                           ('stream_id',0),('stream_id',4294967296),('session_id','')]:
            value_to_check=self.request();value_to_check[key]=value
            self.assertFalse(VALIDATOR.is_valid(value_to_check), key)
        for key in ('command_id','session_id','stream_id','offset','length'):
            value_to_check=self.request();del value_to_check[key]
            self.assertFalse(VALIDATOR.is_valid(value_to_check), key)

    def test_existing_control_surface_remains_valid(self):
        for op in ('status.get','capture.start','recording.list','recording.audio.read','transport.wifi.offer'):
            VALIDATOR.validate(dict(schema_version=1,op=op,command_id='legacy-compatible'))


if __name__ == '__main__': unittest.main()
