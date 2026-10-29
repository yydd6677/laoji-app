"""Observation-owner tests, not physical device or ASR-quality evidence."""
import hashlib
import subprocess
import unittest
from unittest.mock import patch

from verify_gatt_timeout_recovery import read_received_wave

MEETING='556c751f-38fe-3c63-a8f9-ed94b2de1db1'
RECORDING='878169a6-6398-3c66-a9f9-9e6d9b390424'
DATA=b'RIFF'+bytes(range(64))
RECEIPT=dict(captureMeetingId=MEETING,recordingId=RECORDING,
             localUri='file:///private/meeting-audio/hardware-pending/'+RECORDING+'.wav',
             byteSize=len(DATA),checksumSha256='sha256:'+hashlib.sha256(DATA).hexdigest())
ASSET={**RECEIPT,'localState':'local_ready',
       'localUri':'file:///private/meeting-audio/imports/'+MEETING+'/'+RECORDING+'.wav'}


class Phone:
    def __init__(self, missing_pending=False, data=DATA):self.calls=[];self.missing_pending=missing_pending;self.data=data
    def cmd(self,*args):
        self.calls.append(args)
        if self.missing_pending and 'hardware-pending' in args[-1]:raise subprocess.CalledProcessError(1,args)
        return self.data


class ReceivedOwnerTest(unittest.TestCase):
    def test_adopted_asset_is_the_current_owner(self):
        phone=Phone()
        with patch('verify_gatt_timeout_recovery.runtime',return_value=[ASSET]):
            self.assertEqual(DATA,read_received_wave(phone,RECEIPT))
        self.assertEqual(('shell','-T','run-as'),phone.calls[0][:3])
        self.assertIn('/imports/'+MEETING+'/',phone.calls[0][-1])

    def test_pending_media_remains_readable_before_adoption(self):
        with patch('verify_gatt_timeout_recovery.runtime',return_value=None):
            self.assertEqual(DATA,read_received_wave(Phone(),RECEIPT))

    def test_only_a_disappeared_pending_path_rechecks_the_same_owner(self):
        phone=Phone(missing_pending=True)
        with patch('verify_gatt_timeout_recovery.runtime',side_effect=[[],[ASSET]]),patch('verify_gatt_timeout_recovery.time.sleep'):
            self.assertEqual(DATA,read_received_wave(phone,RECEIPT))
        self.assertEqual(2,len(phone.calls))

    def test_changed_metadata_or_existing_corruption_does_not_use_a_fallback(self):
        for assets,data in [([{**ASSET,'checksumSha256':'sha256:'+'0'*64}],DATA),([ASSET],b'cat: missing'),([],b'RIFF'+bytes(64))]:
            with patch('verify_gatt_timeout_recovery.runtime',return_value=assets) as resolve:
                with self.assertRaises(AssertionError):read_received_wave(Phone(data=data),RECEIPT)
                self.assertEqual(1,resolve.call_count)

    def test_an_unavailable_handoff_has_a_bounded_read_only_observation(self):
        phone=Phone(missing_pending=True)
        with patch('verify_gatt_timeout_recovery.runtime',return_value=[]),patch('verify_gatt_timeout_recovery.time.sleep'):
            with self.assertRaises(subprocess.CalledProcessError):read_received_wave(phone,RECEIPT)
        self.assertEqual(3,len(phone.calls))


if __name__=='__main__':unittest.main()
