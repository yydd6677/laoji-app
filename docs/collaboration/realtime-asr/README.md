# Realtime ASR Collaboration Notes

This folder collects realtime speech-recognition materials shared by collaborators so the LaoJi workspace keeps the API contract close to the mobile implementation.

## Files

- `realtime-asr-api.md`: collaborator API guide for the realtime ASR WebSocket service.
- `live_asr_mic_client.py`: collaborator Python microphone client for command-line testing.

## Source

The current files were copied on 2026-07-08 from WeChat attachment paths under:

```text
/home/yydd/文档/xwechat_files/wxid_au18x4y91fz322_d9d5/msg/attach/6468dfc685aa8c690b98eba21a3ba572/2026-07/Rec/6b6bc9dbda22408c/F/
```

## Mobile Integration Notes

- LaoJi mobile uses the FunASR endpoint first: `ws://183.36.243.124:8020/ws/meeting/{meeting_id}/funasr`.
- The WebSocket accepts raw binary PCM frames, not m4a, wav, mp3, or base64 text.
- Required PCM format: 16 kHz, mono, signed 16-bit little-endian.
- True realtime microphone streaming requires a development build or release build that includes the native audio stream module. Expo Go does not include that module, so the app keeps file-recording upload as a fallback there.
