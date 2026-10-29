# LaoJi Recorder source firmware

This is an independently buildable replacement for the second ESP32-S3 voice-memo V1.0 board. It does **not** link, disassemble, relocate or inject code into `usb_wireless_disk`. The older repair project is rollback/reference material only.

## Build

Pinned SDK: Espressif ESP-IDF **v5.5.1**, commit `fcae32885b0296b32044cb99ecbdc50d98dddb83`, including its recorded submodules. Install with its official `install.sh esp32s3` (Linux) or `install.bat esp32s3` (Windows), activate `export.sh` / `export.bat`, then run `idf.py build` in this directory. `sdkconfig.defaults` is the maintained configuration; generated SDK/build output is ignored.

Run host invariants:

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -I main main/wire.c tests/wire_test.c -o wire-test
./wire-test
```

The application binary, ELF with symbols, linker map, SDK config and build description are generated together. All application behavior is in the source tree; there are no fixed donor addresses or binary patches.

## Audio ownership and storage stalls

The I2S task only reads the codec and appends complete PCM16 blocks to a bounded
256 KiB PSRAM FIFO (8.192 seconds at the current format). It does not wait for
FatFS, hashing, Bluetooth or `fsync`. A separate single writer drains that FIFO,
writes the SD file, updates the streaming SHA and publishes committed absolute
offsets to the existing live/repair ring. Stop drains the accepted prefix before
sealing the file; pause excludes new input without discarding already accepted
samples. FIFO exhaustion or genuine I2S loss seals an interrupted source rather
than silently dropping, renumbering or inserting silence. The DMA geometry,
codec setup and BLE 1.3 contract are unchanged.

The writer still attempts its existing approximately one-second flush/sync.
This is not a power-loss guarantee: a stalled card can leave queued or buffered
audio uncommitted. The final full-file/PCM verification and `.part` recovery
remain necessary. Host `pcm_fifo_test.c` model-checks 100,000 queue operations;
`test_capture_owner.py` guards the producer/writer boundary, not microphone
quality. Real 2.1.2 board tests completed two three-minute recordings with
pause/resume, complete SHA and live/source equality. Observed SD writes stalled
for 278/378 ms, beyond the old approximately 192 ms DMA window, without losing
the accepted prefix. Evidence is recorded in `docs/hardware/AUTONOMOUS-IMPROVEMENTS.md`.

## Board profile

ESP32-S3R8, 8 MiB external flash / octal PSRAM. I2C SCL=1, SDA=2; ES7210 address `0x41`. I2S DI/WS/BCK/MCK=10/11/12/13, four 16-bit TDM slots at 16 kHz, MCLK=256x. Wire order is MIC1, MIC3, MIC2, MIC4; the two fitted analog microphones feed MIC1/MIC2, so mono averages wire slots 0 and 2, not adjacent slots. This is host-tested in `tests/board_audio_test.c`. ES7210 setup follows Espressif's Apache-2.0 esp-bsp driver register definitions; the explicit channel order is also documented by Espressif's esp-audio-dev ES7210 `order_info` table.

SDMMC 1-bit DAT0/CLK/CMD=14/21/47. GPIO38 is active-low: idle long press (800 ms) starts a meeting, double press (320 ms window) starts schedule dictation. During either capture, short press pauses/resumes and long press stops. Boot-held keys and consumed releases cannot start another capture. BOOT and reset retain their hardware function. Battery/charger and unknown expansion pins are not driven; battery reporting and software shutdown are not advertised. A missing SD card or codec error does not trigger formatting or a reboot loop.

## Ownership and persistence

- `control.c`: single serialized control owner, BLE 1.3 command/reply/event contract, bounded command replay cache, button negotiation and file transfer admission.
- `recorder.c`: one I2S/PCM writer, streaming SHA-256, SD journal (`.wav.part`), complete final header/flush/fsync/rename, committed absolute-offset live ring. Radio failures never change recorded bytes or relabel the source offset.
- `storage.c`: RIFF chunk parser, actual-file generation, bounded memory cache and optional persistent metadata index, source-preserving own-journal recovery. Never assumes arbitrary input WAV data begins at byte 44. No card formatting.
- `ble.c`: bounded 6-byte fragment reassembly and 8-byte JSON envelope, confirmed indications, separate 20-byte-header PCM notifications, negotiated MTU, backpressure without source-counter mutation. BLE disconnect does not stop SD recording; it disables that session's live mirror.
- `wifi.c`: lazy SoftAP/HTTP allocation, random per-offer WPA2 password and bearer token, expiration/revocation, safe one-pass UTF-8 percent decoding, generation/Range protection, HEAD and exact-length GET. No credentials or recording names/bodies are logged.
- `wire.c`: host-tested endian/framing, file-name, HTTP range and ring-window functions shared by firmware (not a test-only reimplementation).

Live and stored audio always share PCM offset zero. If a stalled sender falls behind the bounded ring, later packets retain their actual source offset. The phone can detect the gap and use BLE range recovery, rather than accepting a wrong-length or wrong-content prefix. Recorded samples are not padded or discarded to satisfy a transport chunk size.

Input validation, bounded queues, generation fences and final SHA remain mandatory. The firmware identifies itself as `laoji-recorder-2.2.0`; BLE remains 1.3. Purpose and original capture time are durable RIFF metadata, not per-packet audio headers. Development BLE/HTTP are development security, not production pairing or end-to-end encryption.

`recording.list` optionally accepts `include_previews=true`, with at most four header-only previews per page. Preview objects have no checksum and cannot satisfy an audio-transfer contract. The Android catalog and full metadata use separate DTOs; only a selected file invokes `recording.get` for its full source/generation/SHA contract. Older name-only responses remain display-only.

The fs-mutex-owned hash workspace (8 KiB) and single-worker HTTP workspace (4 KiB) are bounded PSRAM allocations, not stack arrays. Compiler frame limits apply to all application files (3 KiB, except the dedicated 4 KiB TDM input frame on the 8 KiB PCM task). High-water marks alone cannot prove stack safety: an untouched automatic array can reserve space beyond the stack without filling every canary byte. Wi-Fi/LWIP prefer PSRAM, DMA/TX buffers remain bounded, and temporary AP setup never imports donor Wi-Fi NVS configuration.

Each bulk read stream now owns a 16 KiB internal DMA-capable **stdio** buffer until fclose. Real-board comparisons showed that changing only the outer fread destination did not improve the slow disk path. Under internal-memory pressure allocation falls back to 8/4 KiB, then default buffering; it never weakens checksums. Metadata, BLE file reads and HTTP use the same reader helper, without sharing a mutable FILE buffer between streams.

The bulk socket uses TCP_NODELAY and a bounded 32 KiB send window. Offer expiry (120 seconds) governs admission, not the lifetime of an already admitted download: a valid in-flight request can finish, an expired token cannot start another request, and explicit close still revokes active I/O. The expiry owner rechecks queued events against the current offer and active request count. Host tests share the actual `wifi_lease.h` policy; the physical slow-download regression crossed expiry and verified the entire PCM SHA.

Explicit close uses BSD `shutdown` on the admitted socket to wake blocked I/O before stopping the HTTP worker. The HTTP server remains the sole descriptor-close owner; this uses the pinned ESP-lwIP full-duplex socket support, not the raw TCP API from another task. The physical blocked-download test returned close in 0.299 seconds. An expired offer alone does not take this path while a request is admitted. Unauthorized HTTP responses include the protocol's `WWW-Authenticate: Bearer` challenge.

The AP name uses its public hardware MAC instead of changing on every transfer. This lets Android reuse approval for a specific previously approved AP, without adding a saved internet network or overriding system consent. Password (64 random bits) and bearer token (256 independent random bits) rotate on **every offer**, including retries; old tokens are revoked. This development board already broadcasts stable public BLE/Wi-Fi MACs; a production private-address/pairing design is still a separate contract. No credential is derived from the name/MAC or stored in Wi-Fi NVS. Actual Android approval caching is device-dependent and is measured separately from body transfer latency.

The optional `/disk/.laoji-meta` directory holds 136-byte versioned, CRC-checked index entries keyed by a SHA-256 of the filename. Entries bind the filename, file size/mtime, parsed audio range and first 44 source-header bytes to the audio SHA and capture time. New completed recordings save their already-computed streaming SHA; old recordings populate the index on first lookup. A temporary file, flush/fsync and rename publish the index. Missing, torn, invalid or mismatched entries fall back to a full validated scan. Index write failure never downgrades a successfully saved audio recording. Rename/delete forget the old entry. The index is not a signature: deliberately changing only a payload while preserving size, timestamp and header still requires the receiver's final full-audio SHA check to detect the change. No audio bytes or recording names are logged by this cache.

Host test `metadata_index_test.c` covers encoding, bounds, every single-byte corruption and all truncated lengths. `tools/hardware/verify_storage_performance.py` exercises cold/warm and post-reset metadata, new-recording persistence, Chinese rename, complete/range SHA and removal of its own scratch recording without deleting pre-existing audio.

USB is currently a debug/flash/console connection, not a mobile audio transport or writable USB disk. The replacement implements LaoJi's recorder and transfer contract, not every peripheral demo from the donor. Simultaneous USB-disk and firmware writers to the same SD filesystem are deliberately absent. No battery measurements, charge controls, software power switch or production BLE/TLS security are invented for undocumented hardware.

## App-only deployment and rollback

**Do not run `idf.py flash` on the prototype.** It writes more than the application. Back up the complete existing 8 MiB flash first and verify its application baseline. Then use the SDK Python environment:

```sh
python3 tools/flash_app.py --port PORT --backup ORIGINAL-FLASH.bin --evidence EVIDENCE
python3 tools/flash_app.py --port PORT --backup ORIGINAL-FLASH.bin --evidence EVIDENCE --write --erase-application
```

Use the environment's `python` command on Windows if it is not named `python3`. The script validates the backup partition table, backup baseline hash, connected prototype MAC and image bounds. `--erase-application` clears the whole existing factory range before writing **only `0x10000`**; it never runs `erase_chip`. It verifies the application and confirms the bootloader, partition table and PHY partition stayed unchanged. The extra storage partition is outside the erased range. It never issues an SD/eFuse/NVS erase or write command. The new SDK may refresh its NVS `phy/cal_data` at startup; both snapshots are retained and that difference is reported, not silently restored. The generated `partitions.csv` is for compile/link size checking only. This guarded flashing tool intentionally targets the authorized second prototype, not an arbitrary production board.

To roll back, use the exact backed-up factory application range and the same app-only write/verify procedure. Never erase the chip. The original raw firmware cannot be called an original source project; its mirror, hash and related repair source are the reproducible rollback evidence.

After migration to source firmware, `tools/update_app.py` requires the exact **currently deployed** source image, reads a fresh factory/head snapshot itself, checks the authorized MAC/layout/erased tail, saves and verifies a private compressed application rollback, and writes only the existing factory range. It verifies the candidate plus preserved boot/table/PHY bytes and attempts an exact application rollback on update failure. A physical disconnect can still require reconnecting before rollback; this is not a guarantee against loss of power or hardware. Do not pass a stale backup as current-state proof.

## Acceptance boundary

Build/host tests are not board acceptance. Require real board boot, codec/SD health, BLE handshake and all control operations, exact live-vs-stored byte comparisons, intentional missing-prefix/range repair, pause/stop/reconnect, Chinese rename, generation rejection, Wi-Fi/Range/token expiry, reset recovery and original card-file preservation. Record actual pass/fail evidence separately; never present a generated signal or virtual peripheral as a microphone pass.

Repository acceptance drivers are in `tools/hardware/verify_source_firmware.py`, `verify_source_recovery.py` and `verify_source_wifi.py`. The last is a Linux NetworkManager integration probe: it temporarily joins the board AP, with original-connection restoration and an independent watchdog. It is not required to build or flash on Windows. Full-flash/NVS backups and raw JTAG memory evidence are private and must never be included in a public source package.
