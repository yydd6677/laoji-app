"""BLE 1.3 test peripheral for one Android netsim instance, never a real board.

Run: uv run --with 'bumble[android]' python3 tools/hardware/virtual_board13.py
Android traverses its real GATT API and LaoJi runtime; radio/SD/microphone are
fixtures. These results are NOT physical-board or speech-quality evidence.
--mirror-delay-bytes reproduces the observed late live mirror (source != mirror).
"""
import argparse
import asyncio
import hashlib
import json
import math
import struct
import time
import uuid
import wave
from pathlib import Path

from bumble import hci
from bumble.core import AdvertisingData
from bumble.device import Device
from bumble.gatt import Characteristic, CharacteristicValue, Service
from bumble.transport import open_transport

ROOT_UUID = "9f7a0001-6d6f-4a6f-8a4b-6c616f6a6901"
RX_UUID = ROOT_UUID.replace("0001-", "0002-")
TX_UUID = ROOT_UUID.replace("0001-", "0003-")
AUDIO_UUID = ROOT_UUID.replace("0001-", "0004-")
AUDIO = dict(codec="pcm_s16le", sample_rate_hz=16000, bits_per_sample=16, channels=1, local_storage=True)


def tone(offset, count):
    return b"".join(struct.pack("<h", int(5000*math.sin((offset//2+i)*2*math.pi*443/16000)))
                    for i in range(count//2))


class VirtualBoard:
    def __init__(self, device, mirror_delay, speech=None, bad_checksum=False, drop_live_sequence=None,
                 live_repair=False, drop_live_sequences=(), repair_delay_ms=0, stale_interruption=False,
                 interrupt_after_ms=0, interrupt_reason='audio_failed',
                 control_write_delay_op=None, control_write_delay_ms=0):
        self.device = device
        self.mirror_delay = mirror_delay
        self.speech = speech
        self.bad_checksum = bad_checksum
        self.drop_live_sequence = drop_live_sequence
        self.drop_live_sequences = set(drop_live_sequences)
        if drop_live_sequence is not None: self.drop_live_sequences.add(drop_live_sequence)
        self.live_repair = live_repair
        self.repair_delay_ms = repair_delay_ms
        self.stale_interruption = stale_interruption
        self.stale_sent = False
        self.interrupt_after_ms = interrupt_after_ms
        self.interrupt_reason = interrupt_reason
        if bool(control_write_delay_op) != bool(control_write_delay_ms) or not 0 <= control_write_delay_ms <= 15000:
            raise ValueError('Control response delay needs an explicit operation and 1..15000 milliseconds')
        self.control_write_delay_op = control_write_delay_op
        self.control_write_delay_ms = control_write_delay_ms
        self.control_write_delay_used = False
        self.parts = {}
        self.commands = asyncio.Queue()
        self.json_lock = asyncio.Lock()
        self.frame_id = 0
        self.stream = 100
        self.capture_stream = 0
        self.repair_stream = 0
        self.state = "ready"
        self.session = None
        self.name = None
        self.created = int(time.time()*1000)
        self.files = {"讨论片段.wav": speech if speech is not None else tone(0, 128000)}
        self.created_by_name = {name: self.created for name in self.files}
        self.context_by_name = {name: {'purpose':'meeting','capture_id':'fixture-initial','time_zone':'Asia/Shanghai'} for name in self.files}
        self.capture_context = None
        self.time_zone = 'Asia/Shanghai'
        self.capture_created = None
        self.capture = bytearray()
        self.live_sequence = 0
        self.live_offset = 0
        self.read_task = None
        self.capture_task = None
        self.repair_task = None
        device.on("connection",lambda c: asyncio.create_task(c.set_data_length(251,2120)))
        self.tx = Characteristic(TX_UUID, Characteristic.INDICATE, Characteristic.READABLE, b"")
        self.audio = Characteristic(AUDIO_UUID, Characteristic.NOTIFY, Characteristic.READABLE, b"")
        self.rx = Characteristic(RX_UUID, Characteristic.WRITE_WITHOUT_RESPONSE | Characteristic.WRITE,
                                 Characteristic.WRITEABLE, CharacteristicValue(write=self.receive))
        device.add_service(Service(ROOT_UUID, [self.rx, self.tx, self.audio]))

    def receive(self, connection, packet):
        fid, index, count, size = struct.unpack_from("<HBBH", packet)
        if size != len(packet)-6 or not 0<=index<count or len(self.parts)>16:
            raise ValueError("invalid fixture request fragmentation")
        pieces = self.parts.setdefault(fid,{})
        pieces[index]=packet[6:]
        if len(pieces)==count:
            raw=b"".join(pieces[i] for i in range(count));del self.parts[fid]
            major, minor, flags, reserved, length=struct.unpack_from("<BBBBI",raw)
            if (major,minor,flags,reserved)!=(1,3,0,0) or length!=len(raw)-8:
                raise ValueError("invalid fixture request envelope")
            request = json.loads(raw[8:])
            self.commands.put_nowait((connection, request))
            # The command reaches the device once; only the ATT write response
            # is delayed. JSON responses/events may arrive before its callback.
            # This is an explicit fault, never a production behavior or oracle.
            if request.get('op') == self.control_write_delay_op and not self.control_write_delay_used:
                self.control_write_delay_used = True
                return self.delay_control_write_response(request['op'])

    async def delay_control_write_response(self, op):
        print(json.dumps({'event': 'injected_control_write_delay', 'op': op,
                          'delay_ms': self.control_write_delay_ms,
                          'started_epoch_ms': int(time.time()*1000),
                          'boundary': 'virtual ATT callback, not physical radio'}), flush=True)
        await asyncio.sleep(self.control_write_delay_ms / 1000)
        print(json.dumps({'event':'delayed_control_response_returned','op':op,
                          'returned_epoch_ms':int(time.time()*1000)}),flush=True)

    async def message(self, value):
        value={"schema_version":1,**value}
        body=json.dumps(value,ensure_ascii=False,separators=(",",":")).encode()
        raw=struct.pack("<BBBBI",1,3,0,0,len(body))+body
        async with self.json_lock:
            self.frame_id=self.frame_id%65535+1
            mtu=min((c.att_mtu for c in self.device.connections.values()),default=23)
            capacity=min(512,mtu-3)-6
            count=(len(raw)+capacity-1)//capacity
            for i in range(count):
                fragment=raw[i*capacity:(i+1)*capacity]
                await self.device.indicate_subscribers(self.tx,struct.pack("<HBBH",self.frame_id,i,count,len(fragment))+fragment)

    def metadata(self, name):
        pcm=self.files[name]
        digest = hashlib.sha256(pcm).hexdigest()
        created = self.created_by_name[name]
        return dict(recording_id=name,generation=f"gen-fixture-{created:x}-{digest[:24]}",container="wav",audio=AUDIO,
                    audio_bytes=len(pcm),file_bytes=len(pcm)+44,samples=len(pcm)//2,
                    duration_ms=len(pcm)*1000//32000,checksum_scope="audio_payload",
                    checksum_sha256="sha256:"+("0"*64 if self.bad_checksum else digest),created_epoch_ms=created,recovered=False,
                    **self.context_by_name[name])

    async def packets(self, data, kind, stream, offset=0, sequence=0):
        for i in range(0,len(data),492):
            sequence+=1;chunk=data[i:i+492]
            final=int(kind==0x11 and i+len(chunk)==len(data))
            packet=struct.pack("<BBBBIIQ",1,3,kind,final,stream,sequence,offset+i)+chunk
            if kind == 0x10 and sequence in self.drop_live_sequences:
                print(json.dumps({'event': 'injected_live_gap', 'sequence': sequence,
                                  'source_offset': offset+i, 'bytes': len(chunk)}), flush=True)
            else:
                await self.device.notify_subscribers(self.audio,packet)
            if kind==0x11: await asyncio.sleep(.002)
        return sequence

    async def capture_loop(self):
        while self.state in ("recording","paused"):
            if self.state=="recording":
                if self.interrupt_after_ms and len(self.capture) >= self.interrupt_after_ms * 32:
                    self.state = 'ready'
                    interrupted_session = self.session
                    self.session = None
                    if self.repair_task and not self.repair_task.done():
                        self.repair_task.cancel(); await asyncio.gather(self.repair_task, return_exceptions=True)
                    await self.message({'op': 'capture.interrupted', 'session_id': interrupted_session, 'reason': self.interrupt_reason})
                    print(json.dumps({'event': 'injected_capture_interruption', 'reason': self.interrupt_reason}), flush=True)
                    return
                offset = len(self.capture)
                chunk = (self.speech[offset:offset+1024].ljust(1024, b'\0')
                         if self.speech is not None else tone(offset,1024))
                self.capture.extend(chunk)
                if len(self.capture)>self.mirror_delay:
                    self.live_sequence=await self.packets(chunk,0x10,self.capture_stream,self.live_offset,self.live_sequence)
                    self.live_offset+=len(chunk)
                if self.stale_interruption and not self.stale_sent and len(self.capture) >= 32000:
                    self.stale_sent = True
                    await self.message({'op': 'capture.interrupted', 'session_id': 'obsolete-capture', 'reason': 'fixture'})
            await asyncio.sleep(.032)

    async def send_repair(self, data, stream, offset):
        if self.repair_delay_ms: await asyncio.sleep(self.repair_delay_ms/1000)
        await self.packets(data, 0x11, stream, offset)

    async def worker(self):
        while True:
            connection,request=await self.commands.get()
            op=request["op"]
            print(json.dumps({"boundary":"virtual_peripheral_not_hardware","op":op}),flush=True)
            reply={"op":op,"command_id":request["command_id"],"ok":True}
            event=None;start_read=None;start_repair=None
            if op=="hello":
                reply.update(protocol={"major":1,"minor":3},device={"device_id":"virtual-board13",
                    "model":"virtual fixture","firmware_revision":"fixture-1","hardware_revision":"virtual"},
                    security={"mode":"development_ble"},capabilities={"transports":["ble"],"capture":{**AUDIO,
                    "codecs":["pcm_s16le"],"sample_rates_hz":[16000],"channels":[1],"purposes":["meeting","schedule"]},
                    "storage":{"available":True,"ble_audio_read":True},"wifi":{"bulk_transfer":False}})
                if self.live_repair:
                    reply['capabilities']['capture']['live_range_repair'] = {'max_bytes': 32768, 'retention_bytes': 262144}
            elif op=="time.sync": self.time_zone=request.get('time_zone','Asia/Shanghai')
            elif op=="status.get":
                reply["status"]={"state":self.state,"session_id":self.session,"recording_id":self.name,
                                 "pending_recordings":len(self.files)}
            elif op=="recording.list":
                names=list(self.files);offset=int(request.get('cursor') or 0)
                limit=min(32,max(1,request.get('limit',32)))
                if request.get('include_previews'):limit=min(limit,4)
                page=names[offset:offset+limit]
                reply.update(recordings=page,next_cursor=str(offset+len(page)) if offset+len(page)<len(names) else None)
                if request.get('include_previews'):
                    reply['previews']=[]
                    for name in page:
                        meta=self.metadata(name)
                        reply['previews'].append({key:meta[key] for key in
                            ('recording_id','generation','file_bytes','duration_ms','created_epoch_ms','purpose','capture_id')})
            elif op=="recording.get": reply["recording"]=self.metadata(request["recording_id"])
            elif op=="recording.audio.read":
                m=self.metadata(request["recording_id"]);offset=request.get("offset",0)
                if request["expected_generation"]!=m["generation"]: raise ValueError("fixture generation mismatch")
                self.stream+=1
                end=min(m["audio_bytes"],offset+request.get("length",m["audio_bytes"]))
                reply["transfer"]={"transport":"ble","stream_id":self.stream,"recording_id":m["recording_id"],
                    "generation":m["generation"],"offset_scope":"audio_payload","offset":offset,
                    "length":end-offset,"total_audio_bytes":m["audio_bytes"],"chunk_size_bytes":492,
                    "checksum_sha256":m["checksum_sha256"],"checksum_scope":"audio_payload"}
                start_read=(self.files[m["recording_id"]][offset:end],self.stream,offset)
            elif op=="recording.audio.read.cancel":
                if self.read_task and not self.read_task.done(): self.read_task.cancel()
            elif op=="capture.start":
                self.capture_created = int(time.time()*1000)
                self.session=request["session_id"];self.name=f'LJ_{self.capture_created}_{uuid.uuid4().hex[:8]}.wav'
                self.capture_context={'purpose':request.get('purpose','meeting'),'capture_id':self.session,'time_zone':self.time_zone}
                self.stream+=1;self.capture_stream=self.stream;self.state="recording";self.capture=bytearray();self.live_sequence=self.live_offset=0;self.stale_sent=False
                event={"op":"capture.started","session_id":self.session,"recording_id":self.name,
                       "stream_id":self.capture_stream,"audio":AUDIO,"created_epoch_ms":self.capture_created,**self.capture_context}
            elif op in ("capture.pause","capture.resume"):
                self.state="paused" if op.endswith("pause") else "recording"
                event={"op":"capture.paused" if self.state=="paused" else "capture.resumed","session_id":self.session}
            elif op=="capture.stop":
                self.state="ready"
                if self.repair_task and not self.repair_task.done():
                    self.repair_task.cancel(); await asyncio.gather(self.repair_task, return_exceptions=True)
                if self.capture_task: await self.capture_task
                self.files[self.name]=bytes(self.capture)
                self.created_by_name[self.name]=self.capture_created
                self.context_by_name[self.name]=self.capture_context
                event={"op":"capture.finished","session_id":self.session,"stream_id":self.capture_stream,**self.metadata(self.name)}
                self.session=None;self.name=None
            elif op=="capture.audio.read":
                offset=request.get('offset', -1);length=request.get('length',0)
                invalid = (type(offset) is not int or type(length) is not int or offset < 0 or offset % 2
                           or length not in range(2,32769,2))
                if not self.live_repair or self.state not in ('recording','paused') or request.get('session_id')!=self.session or request.get('stream_id')!=self.capture_stream:
                    reply.update(ok=False,error={'code':'invalid_state','retryable':False})
                elif invalid:
                    reply.update(ok=False,error={'code':'invalid_argument','retryable':False})
                elif offset < max(0,len(self.capture)-262144) or offset+length > len(self.capture):
                    reply.update(ok=False,error={'code':'source_range_unavailable','retryable':False})
                elif self.repair_task and not self.repair_task.done():
                    reply.update(ok=False,error={'code':'busy','retryable':True})
                else:
                    self.stream+=1;self.repair_stream=self.stream
                    reply['transfer']={'transport':'ble','session_id':self.session,'source_stream_id':self.capture_stream,
                        'stream_id':self.repair_stream,'offset_scope':'audio_payload','offset':offset,'length':length,'chunk_size_bytes':492}
                    start_repair=(bytes(self.capture[offset:offset+length]),self.repair_stream,offset)
            elif op=="capture.audio.read.cancel":
                if request.get('stream_id')!=self.repair_stream:
                    reply.update(ok=False,error={'code':'transfer_not_found','retryable':False})
                elif self.repair_task and not self.repair_task.done():
                    self.repair_task.cancel(); await asyncio.gather(self.repair_task,return_exceptions=True)
                reply['stream_id']=request.get('stream_id')
            elif op=="recording.rename":
                self.files[request["new_recording_id"]]=self.files.pop(request["recording_id"])
                self.created_by_name[request["new_recording_id"]]=self.created_by_name.pop(request["recording_id"])
                self.context_by_name[request["new_recording_id"]]=self.context_by_name.pop(request["recording_id"])
                reply["recording"]=self.metadata(request["new_recording_id"])
            elif op=="recording.delete":
                del self.files[request["recording_id"]]
                del self.created_by_name[request["recording_id"]]
                del self.context_by_name[request["recording_id"]]
            else: reply.update(ok=False,error={"code":"unsupported","retryable":False})
            await self.message(reply)
            if event:
                await self.message(event)
                print(json.dumps({"boundary":"virtual_peripheral_not_hardware","event":event["op"]}),flush=True)
            if op=="capture.start": self.capture_task=asyncio.create_task(self.capture_loop())
            if start_read:
                data,stream,offset=start_read
                self.read_task=asyncio.create_task(self.packets(data,0x11,stream,offset))
            if start_repair:
                self.repair_task=asyncio.create_task(self.send_repair(*start_repair))


async def main(args):
    speech = None
    if args.speech_wav:
        if args.speech_wav.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("speech fixture exceeds 8 MiB bound")
        with wave.open(str(args.speech_wav)) as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError("fixture must be mono PCM16 WAV at 16 kHz")
            speech = wav.readframes(wav.getnframes())
    async with await open_transport(args.transport) as transport:
        device=Device.with_hci("LaoJi Test Board",hci.Address("C0:DE:C0:DE:13:13"),transport.source,transport.sink)
        if args.live_repair and args.mirror_delay_bytes:
            raise ValueError('live repair fixture requires unshifted source offsets (--mirror-delay-bytes 0)')
        board=VirtualBoard(device,args.mirror_delay_bytes,speech,args.bad_checksum,args.drop_live_sequence,
            live_repair=args.live_repair,drop_live_sequences=args.drop_live_sequences,
            repair_delay_ms=args.repair_delay_ms,stale_interruption=args.stale_interruption,
            interrupt_after_ms=args.interrupt_after_ms,interrupt_reason=args.interrupt_reason,
            control_write_delay_op=args.control_write_delay_op,control_write_delay_ms=args.control_write_delay_ms)
        await device.power_on()
        await device.start_advertising(auto_restart=True,advertising_data=bytes(AdvertisingData([
            (AdvertisingData.FLAGS,b"\x06"),(AdvertisingData.COMPLETE_LOCAL_NAME,b"LaoJi Test Board")
        ])))
        print(json.dumps({"fixture_ready":True,"boundary":"virtual_peripheral_not_hardware",
                          "mirror_delay_bytes":args.mirror_delay_bytes}),flush=True)
        await board.worker()


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--transport",default="android-netsim:name=laoji-board13")
    p.add_argument("--mirror-delay-bytes",type=int,default=7168)
    p.add_argument("--speech-wav",type=Path)
    p.add_argument("--bad-checksum",action="store_true")
    p.add_argument("--drop-live-sequence",type=int)
    p.add_argument("--drop-live-sequences",type=lambda s: [int(v) for v in s.split(',')],default=[])
    p.add_argument("--live-repair",action="store_true")
    p.add_argument("--repair-delay-ms",type=int,default=0)
    p.add_argument("--stale-interruption",action="store_true")
    p.add_argument('--interrupt-after-ms',type=int,default=0)
    p.add_argument('--interrupt-reason',choices=('audio_failed','storage_failed','unknown'),default='audio_failed')
    p.add_argument('--control-write-delay-op', choices=('capture.pause', 'capture.stop', 'diagnostics.ping'))
    p.add_argument('--control-write-delay-ms', type=int, default=0)
    asyncio.run(main(p.parse_args()))
