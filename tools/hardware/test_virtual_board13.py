"""Fixture identity tests only; never evidence for a physical board or ASR."""
import unittest
import asyncio
import inspect
import json
import struct
from unittest.mock import patch

from virtual_board13 import VirtualBoard


class Device:
    def on(self, *_): pass
    def add_service(self, *_): pass


class VirtualBoardMetadataTest(unittest.TestCase):
    def board(self):
        with patch('virtual_board13.time.time', return_value=1000):
            return VirtualBoard(Device(), 0, speech=b'\x01\x00\x02\x00')

    def test_same_size_changed_audio_has_another_generation(self):
        board = self.board()
        before = board.metadata('讨论片段.wav')
        board.files['讨论片段.wav'] = b'\x03\x00\x04\x00'
        after = board.metadata('讨论片段.wav')
        self.assertEqual(before['file_bytes'], after['file_bytes'])
        self.assertNotEqual(before['generation'], after['generation'])
        self.assertNotEqual(before['checksum_sha256'], after['checksum_sha256'])

    def test_each_saved_file_uses_its_own_capture_date(self):
        board = self.board()
        board.files['新录音.wav'] = board.files['讨论片段.wav']
        board.created_by_name['新录音.wav'] = 2000000
        old, new = board.metadata('讨论片段.wav'), board.metadata('新录音.wav')
        self.assertEqual(1000000, old['created_epoch_ms'])
        self.assertEqual(2000000, new['created_epoch_ms'])
        self.assertEqual(old['checksum_sha256'], new['checksum_sha256'])
        self.assertNotEqual(old['generation'], new['generation'])

    def test_deliberate_bad_checksum_does_not_change_generation(self):
        board = self.board()
        before = board.metadata('讨论片段.wav')
        board.bad_checksum = True
        after = board.metadata('讨论片段.wav')
        self.assertEqual(before['generation'], after['generation'])
        self.assertEqual('sha256:' + '0' * 64, after['checksum_sha256'])


class VirtualBoardRepairTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.board = VirtualBoard(Device(), 0, live_repair=True)
        self.board.state = 'recording'; self.board.session = 'capture-fixture'; self.board.capture_stream = 101
        self.board.stream = 101; self.board.capture = bytearray((i*17)%256 for i in range(4096))
        self.responses = asyncio.Queue(); self.sent = asyncio.Queue()
        async def message(value): await self.responses.put(value)
        async def packets(data, kind, stream, offset=0, sequence=0):
            await self.sent.put((data, kind, stream, offset)); return 1
        self.board.message = message; self.board.packets = packets
        self.worker = asyncio.create_task(self.board.worker())

    async def asyncTearDown(self):
        self.worker.cancel()
        if self.board.repair_task: self.board.repair_task.cancel()
        await asyncio.gather(self.worker, self.board.repair_task or asyncio.sleep(0), return_exceptions=True)

    async def request(self, **changes):
        value={'op':'capture.audio.read','command_id':'fixture-'+str(self.responses.qsize()),
               'session_id':self.board.session,'stream_id':self.board.capture_stream,'offset':492,'length':984}
        value.update(changes);await self.board.commands.put((None,value))
        return await asyncio.wait_for(self.responses.get(),1)

    async def test_read_keeps_source_stream_and_returns_original_bytes(self):
        response = await self.request()
        self.assertTrue(response['ok']);t=response['transfer']
        data, kind, stream, offset = await asyncio.wait_for(self.sent.get(),1)
        self.assertEqual(bytes(self.board.capture[492:1476]), data)
        self.assertEqual((0x11,t['stream_id'],492),(kind,stream,offset))
        self.assertEqual(101,self.board.capture_stream)
        self.assertEqual(101,t['source_stream_id']);self.assertNotEqual(101,t['stream_id'])

    async def test_foreign_unaligned_or_future_ranges_do_not_read(self):
        for changes, code in [({'session_id':'old'},'invalid_state'),({'stream_id':9},'invalid_state'),
                              ({'offset':493},'invalid_argument'),({'length':True},'invalid_argument'),
                              ({'length':32770},'invalid_argument'),({'offset':4096},'source_range_unavailable')]:
            response=await self.request(**changes)
            self.assertFalse(response['ok']);self.assertEqual(code,response['error']['code'])
            self.assertTrue(self.sent.empty())

    async def test_cancel_releases_delayed_repair(self):
        self.board.repair_delay_ms=5000
        response=await self.request();self.assertTrue(response['ok'])
        response=await self.request(op='capture.audio.read.cancel',stream_id=response['transfer']['stream_id'])
        self.assertTrue(response['ok']);self.assertTrue(self.board.repair_task.done());self.assertTrue(self.sent.empty())

    async def test_source_interruption_keeps_reason_without_a_fake_completed_file(self):
        before=dict(self.board.files)
        source_session=self.board.session
        self.board.interrupt_after_ms=1
        self.board.interrupt_reason='audio_failed'
        await asyncio.wait_for(self.board.capture_loop(),1)
        event=await asyncio.wait_for(self.responses.get(),1)
        self.assertEqual('capture.interrupted',event['op'])
        self.assertEqual(source_session,event['session_id'])
        self.assertIsNone(self.board.session)
        self.assertEqual('audio_failed',event['reason'])
        self.assertEqual('ready',self.board.state)
        self.assertEqual(before,self.board.files)

    async def test_finished_event_retains_source_but_idle_status_has_no_active_identity(self):
        self.board.name='完成录音.wav'; self.board.capture_created=1234000
        source_session=self.board.session
        await self.board.commands.put((None,{'op':'capture.stop','command_id':'stop-1'}))
        reply=await asyncio.wait_for(self.responses.get(),1);self.assertTrue(reply['ok'])
        event=await asyncio.wait_for(self.responses.get(),1)
        self.assertEqual(source_session,event['session_id']);self.assertEqual('capture.finished',event['op'])
        self.assertEqual('完成录音.wav',event['recording_id'])
        self.assertIsNone(self.board.session);self.assertIsNone(self.board.name)
        await self.board.commands.put((None,{'op':'status.get','command_id':'status-1'}))
        status=(await asyncio.wait_for(self.responses.get(),1))['status']
        self.assertEqual('ready',status['state']);self.assertIsNone(status['session_id']);self.assertIsNone(status['recording_id'])

    async def test_preview_pagination_matches_file_identity_and_capture_time(self):
        for i in range(5):
            name=f'录音{i}.wav';self.board.files[name]=b'\x01\x00'*100
            self.board.created_by_name[name]=1000+i
        await self.board.commands.put((None,{'op':'recording.list','command_id':'list-1','include_previews':True,'limit':32}))
        reply=await asyncio.wait_for(self.responses.get(),1)
        self.assertEqual(4,len(reply['recordings']));self.assertEqual('4',reply['next_cursor'])
        self.assertEqual(reply['recordings'],[p['recording_id'] for p in reply['previews']])
        for preview in reply['previews']:
            meta=self.board.metadata(preview['recording_id'])
            self.assertTrue(all(preview[key]==meta[key] for key in preview))
        await self.board.commands.put((None,{'op':'recording.list','command_id':'list-2','include_previews':True,'limit':32,'cursor':'4'}))
        last=await asyncio.wait_for(self.responses.get(),1)
        self.assertEqual(2,len(last['recordings']));self.assertIsNone(last['next_cursor'])


class VirtualControlDelayTest(unittest.IsolatedAsyncioTestCase):
    async def test_only_one_matched_att_response_is_delayed_and_command_is_not_repeated(self):
        board = VirtualBoard(Device(), 0, control_write_delay_op='capture.pause', control_write_delay_ms=4500)
        def packet(op, fid):
            payload=json.dumps({'schema_version':1,'op':op,'command_id':str(fid)}).encode()
            raw=struct.pack('<BBBBI',1,3,0,0,len(payload))+payload
            return struct.pack('<HBBH',fid,0,1,len(raw))+raw
        self.assertIsNone(board.receive(None,packet('hello',1)))
        (await board.commands.get())
        with patch('virtual_board13.asyncio.sleep') as sleep:
            deferred=board.receive(None,packet('capture.pause',2))
            self.assertTrue(inspect.isawaitable(deferred))
            self.assertEqual('capture.pause',(await board.commands.get())[1]['op'])
            await deferred;sleep.assert_awaited_once_with(4.5)
            self.assertIsNone(board.receive(None,packet('capture.pause',3)))
            self.assertEqual(1,board.commands.qsize())
            self.assertEqual('3',(await board.commands.get())[1]['command_id'])

    async def test_implicit_or_unbounded_fault_config_is_rejected(self):
        for fields in [dict(control_write_delay_ms=1000),dict(control_write_delay_op='capture.pause'),
                       dict(control_write_delay_op='capture.pause',control_write_delay_ms=16000)]:
            with self.assertRaises(ValueError):VirtualBoard(Device(),0,**fields)


if __name__ == '__main__': unittest.main()
