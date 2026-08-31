#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <SPI.h>
#include "driver/i2s.h"

#include "LaojiHardwareProtocol.h"
#include "RecorderStorage.h"
#include "RecorderWifiTransfer.h"

namespace {
using namespace laoji::hardware;
using namespace laoji::recorder;

constexpr char kFirmwareRevision[] = "laoji-test-board-1.2.3";
constexpr char kModel[] = "PD-AILAMP-D01-test";
constexpr char kBleName[] = "LaoJi Test Board";
constexpr char kBleServiceUuid[] = "9f7a0001-6d6f-4a6f-8a4b-6c616f6a6901";
constexpr char kBleControlRxUuid[] = "9f7a0002-6d6f-4a6f-8a4b-6c616f6a6901";
constexpr char kBleControlTxUuid[] = "9f7a0003-6d6f-4a6f-8a4b-6c616f6a6901";
constexpr char kBleAudioTxUuid[] = "9f7a0004-6d6f-4a6f-8a4b-6c616f6a6901";

constexpr i2s_port_t kI2sPort = I2S_NUM_0;
constexpr int kMicWsPin = 9;
constexpr int kMicSckPin = 10;
constexpr int kMicSdPin = 11;
constexpr int kRecordButtonPin = 0;
constexpr int kStorageCsPin = 5;
constexpr int kStorageMosiPin = 6;
constexpr int kStorageClockPin = 7;
constexpr int kStorageMisoPin = 15;
constexpr uint32_t kSampleRate = 16000;
constexpr size_t kSamplesPerFrame = 320;
constexpr uint32_t kButtonDebounceMs = 45;
constexpr uint32_t kButtonLongPressMs = 2000;
constexpr size_t kMaximumOutboundPayload = 8192;
constexpr size_t kBleFragmentHeaderLength = 6;
constexpr size_t kBleMaximumPacketLength = 512;
constexpr size_t kBleMaximumFrameLength = 48 * 1024;
constexpr size_t kRecordingPageSize = 12;

enum class Link : uint8_t { kNone = 0, kUsb = 1, kBle = 2 };
enum class CaptureState : uint8_t { kIdle = 0, kRecording = 1, kPaused = 2, kFinalizing = 3 };
enum class ButtonAction : uint8_t { kShortPress = 1, kLongPress = 2 };

struct BleIncomingPacket {
  uint16_t length = 0;
  uint8_t bytes[kBleMaximumPacketLength];
};

SPIClass storageSpi(FSPI);
RecorderStorage recordingStorage(storageSpi);
RecorderWifiTransfer wifiTransfer(recordingStorage);

int32_t i2sSamples[kSamplesPerFrame];
int16_t pcmSamples[kSamplesPerFrame];
uint8_t serialReceiveBuffer[kHeaderLength + kMaximumInboundPayload];
size_t serialReceiveLength = 0;
uint8_t bleReceiveFrame[kHeaderLength + kMaximumInboundPayload];
size_t bleReceiveLength = 0;
uint16_t bleReceiveFrameId = 0;
uint8_t bleReceiveFragmentCount = 0;
uint8_t bleReceiveNextFragment = 0;
uint8_t transmitBuffer[kHeaderLength + kMaximumOutboundPayload];
uint32_t controlSequence = 1;
uint32_t audioSequence = 1;
uint32_t audioStreamId = 0;
uint64_t samplesRecorded = 0;
uint16_t bleTransmitFrameId = 1;
uint16_t bleMtu = 23;
bool usbHostReady = false;
bool bleHostReady = false;
bool bleConnected = false;
bool bleDisconnectedPending = false;
CaptureState captureState = CaptureState::kIdle;
Link mirrorLink = Link::kNone;
String activeSessionId;
String activeRecordingId;
String deviceId;
String deviceSuffix;
uint64_t synchronizedEpochMs = 0;
uint32_t synchronizedAtMillis = 0;
volatile int buttonRaw = HIGH;
volatile int buttonStable = HIGH;
uint32_t buttonChangedAt = 0;
uint32_t buttonPressedAt = 0;
bool buttonLongHandled = false;
BLECharacteristic *bleControlTx = nullptr;
BLECharacteristic *bleAudioTx = nullptr;
QueueHandle_t bleIncomingQueue = nullptr;
QueueHandle_t buttonActionQueue = nullptr;
TaskHandle_t buttonSamplerTaskHandle = nullptr;

bool isCapturing() {
  return captureState == CaptureState::kRecording || captureState == CaptureState::kPaused;
}

bool linkAvailable(Link link) {
  if (link == Link::kBle) return bleHostReady && bleConnected;
  if (link == Link::kUsb) return usbHostReady;
  return false;
}

Link preferredMirrorLink() {
  if (bleHostReady && bleConnected) return Link::kBle;
  if (usbHostReady) return Link::kUsb;
  return Link::kNone;
}

uint64_t currentEpochMs() {
  if (synchronizedEpochMs == 0) return 0;
  return synchronizedEpochMs + static_cast<uint32_t>(millis() - synchronizedAtMillis);
}

String uint64String(uint64_t value) {
  char buffer[24];
  snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
  return String(buffer);
}

String jsonEscape(const String &value) {
  String result;
  result.reserve(value.length() + 8);
  for (size_t index = 0; index < value.length(); ++index) {
    const uint8_t character = static_cast<uint8_t>(value[index]);
    if (character == '"' || character == '\\') {
      result += '\\';
      result += static_cast<char>(character);
    } else if (character == '\n') {
      result += "\\n";
    } else if (character == '\r') {
      result += "\\r";
    } else if (character == '\t') {
      result += "\\t";
    } else if (character >= 0x20) {
      result += static_cast<char>(character);
    }
  }
  return result;
}

String jsonStringField(const String &json, const char *field) {
  const String marker = String('"') + field + "\"";
  int cursor = json.indexOf(marker);
  if (cursor < 0) return "";
  cursor += marker.length();
  while (cursor < static_cast<int>(json.length()) && isspace(json[cursor])) ++cursor;
  if (cursor >= static_cast<int>(json.length()) || json[cursor++] != ':') return "";
  while (cursor < static_cast<int>(json.length()) && isspace(json[cursor])) ++cursor;
  if (cursor >= static_cast<int>(json.length()) || json[cursor++] != '"') return "";
  String result;
  bool escaped = false;
  for (; cursor < static_cast<int>(json.length()); ++cursor) {
    const char character = json[cursor];
    if (escaped) {
      if (character == 'n') result += '\n';
      else if (character == 'r') result += '\r';
      else if (character == 't') result += '\t';
      else result += character;
      escaped = false;
    } else if (character == '\\') {
      escaped = true;
    } else if (character == '"') {
      return result;
    } else {
      result += character;
    }
  }
  return "";
}

uint64_t jsonUInt64Field(const String &json, const char *field, uint64_t fallback = 0) {
  const String marker = String('"') + field + "\"";
  int cursor = json.indexOf(marker);
  if (cursor < 0) return fallback;
  cursor += marker.length();
  while (cursor < static_cast<int>(json.length()) && isspace(json[cursor])) ++cursor;
  if (cursor >= static_cast<int>(json.length()) || json[cursor++] != ':') return fallback;
  while (cursor < static_cast<int>(json.length()) && isspace(json[cursor])) ++cursor;
  const int start = cursor;
  while (cursor < static_cast<int>(json.length()) && isdigit(json[cursor])) ++cursor;
  return cursor == start ? fallback : strtoull(json.substring(start, cursor).c_str(), nullptr, 10);
}

String jsonOperation(const String &json) { return jsonStringField(json, "op"); }

void advertiseBle() {
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kBleServiceUuid);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
}

class RecorderServerCallbacks final : public BLEServerCallbacks {
 public:
  void onConnect(BLEServer *server, esp_ble_gatts_cb_param_t *param) override {
    bleConnected = true;
    bleDisconnectedPending = false;
    bleMtu = 23;
    server->updateConnParams(param->connect.remote_bda, 6, 12, 0, 200);
  }

  void onDisconnect(BLEServer *) override {
    bleConnected = false;
    bleHostReady = false;
    bleDisconnectedPending = true;
    advertiseBle();
  }

  void onMtuChanged(BLEServer *, esp_ble_gatts_cb_param_t *param) override {
    bleMtu = constrain(param->mtu.mtu, static_cast<uint16_t>(23), static_cast<uint16_t>(517));
  }
};

class RecorderControlCallbacks final : public BLECharacteristicCallbacks {
 public:
  void onWrite(BLECharacteristic *characteristic, esp_ble_gatts_cb_param_t *) override {
    const std::string value = characteristic->getValue();
    if (value.empty() || value.size() > kBleMaximumPacketLength || bleIncomingQueue == nullptr) return;
    BleIncomingPacket packet;
    packet.length = static_cast<uint16_t>(value.size());
    memcpy(packet.bytes, value.data(), value.size());
    xQueueSend(bleIncomingQueue, &packet, 0);
  }
};

RecorderServerCallbacks recorderServerCallbacks;
RecorderControlCallbacks recorderControlCallbacks;

bool sendBleFrame(const uint8_t *frame, size_t length, bool audio) {
  if (!bleConnected || length == 0 || length > kBleMaximumFrameLength) return false;
  BLECharacteristic *characteristic = audio ? bleAudioTx : bleControlTx;
  if (characteristic == nullptr) return false;
  const size_t packetLength = constrain(
      static_cast<size_t>(bleMtu > 3 ? bleMtu - 3 : 20),
      static_cast<size_t>(20), kBleMaximumPacketLength);
  if (packetLength <= kBleFragmentHeaderLength) return false;
  const size_t capacity = packetLength - kBleFragmentHeaderLength;
  const size_t count = (length + capacity - 1) / capacity;
  if (count == 0 || count > 255) return false;
  const uint16_t frameId = bleTransmitFrameId;
  bleTransmitFrameId = bleTransmitFrameId == 0xffff ? 1 : bleTransmitFrameId + 1;
  uint8_t packet[kBleMaximumPacketLength];
  for (size_t index = 0; index < count; ++index) {
    const size_t offset = index * capacity;
    const size_t bodyLength = min(capacity, length - offset);
    writeU16(packet, frameId);
    packet[2] = static_cast<uint8_t>(index);
    packet[3] = static_cast<uint8_t>(count);
    writeU16(packet + 4, static_cast<uint16_t>(bodyLength));
    memcpy(packet + kBleFragmentHeaderLength, frame + offset, bodyLength);
    characteristic->setValue(packet, kBleFragmentHeaderLength + bodyLength);
    if (audio) {
      characteristic->notify();
      delayMicroseconds(450);
    } else {
      characteristic->indicate();
    }
  }
  return true;
}

void writeFrame(Link target, uint8_t kind, uint8_t flags, uint32_t streamId,
                uint32_t sequence, uint32_t correlationId,
                const uint8_t *payload, size_t payloadLength) {
  if (target == Link::kNone || payloadLength > kMaximumOutboundPayload) return;
  encodeHeader(transmitBuffer, kind, flags, static_cast<uint32_t>(payloadLength),
               streamId, sequence, correlationId,
               payloadLength == 0 ? 0 : crc32(payload, payloadLength));
  if (payloadLength > 0) memcpy(transmitBuffer + kHeaderLength, payload, payloadLength);
  const size_t frameLength = kHeaderLength + payloadLength;
  if (target == Link::kBle) {
    sendBleFrame(transmitBuffer, frameLength, kind == kLiveAudio);
  } else if (target == Link::kUsb) {
    size_t offset = 0;
    const uint32_t deadline = millis() + 1000;
    while (offset < frameLength && static_cast<int32_t>(deadline - millis()) > 0) {
      const size_t written = Serial.write(transmitBuffer + offset, frameLength - offset);
      if (written == 0) delay(1);
      else offset += written;
    }
    // ESP32-S3 HWCDC 2.0.17 does not emit a terminating short packet when a
    // transfer is an exact multiple of the 64-byte USB endpoint. Without a
    // byte outside the LJHW frame, the host can receive this response only
    // after the next device write. Both protocol decoders deliberately discard
    // transport noise before the next LJHW magic.
    if (offset == frameLength && frameLength % 64U == 0U) {
      const uint8_t shortPacketTerminator = 0;
      Serial.write(&shortPacketTerminator, 1);
    }
    if (kind != kLiveAudio) Serial.flush();
  }
}

void writeJson(Link target, uint8_t kind, uint32_t correlationId,
               const String &json, uint8_t flags = 0) {
  writeFrame(target, kind, flags, 0, controlSequence++, correlationId,
             reinterpret_cast<const uint8_t *>(json.c_str()), json.length());
}

void sendError(Link target, uint32_t correlationId, const String &op,
               const char *code, bool retryable = false) {
  const String body = String("{\"schema_version\":1,\"op\":\"") + jsonEscape(op) +
      "\",\"ok\":false,\"error\":{\"code\":\"" + code +
      "\",\"retryable\":" + (retryable ? "true" : "false") + "}}";
  writeJson(target, kControlResponse, correlationId, body, retryable ? kRetryable : 0);
}

void emitMirrorEvent(const String &json) {
  if (linkAvailable(mirrorLink)) writeJson(mirrorLink, kEvent, 0, json);
}

String captureStateName() {
  if (captureState == CaptureState::kRecording) return "recording";
  if (captureState == CaptureState::kPaused) return "paused";
  if (captureState == CaptureState::kFinalizing) return "finalizing";
  if (wifiTransfer.active()) return "transferring";
  return recordingStorage.available() ? "ready" : "error";
}

void setupI2s() {
  const i2s_config_t config = {
      .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX),
      .sample_rate = kSampleRate,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
      .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 8,
      .dma_buf_len = kSamplesPerFrame,
      .use_apll = false,
      .tx_desc_auto_clear = false,
      .fixed_mclk = 0,
      .mclk_multiple = I2S_MCLK_MULTIPLE_DEFAULT,
      .bits_per_chan = I2S_BITS_PER_CHAN_DEFAULT,
  };
  const i2s_pin_config_t pins = {
      .mck_io_num = I2S_PIN_NO_CHANGE,
      .bck_io_num = kMicSckPin,
      .ws_io_num = kMicWsPin,
      .data_out_num = I2S_PIN_NO_CHANGE,
      .data_in_num = kMicSdPin,
  };
  ESP_ERROR_CHECK(i2s_driver_install(kI2sPort, &config, 0, nullptr));
  ESP_ERROR_CHECK(i2s_set_pin(kI2sPort, &pins));
  i2s_zero_dma_buffer(kI2sPort);
}

void setupBle() {
  bleIncomingQueue = xQueueCreate(16, sizeof(BleIncomingPacket));
  BLEDevice::init(kBleName);
  BLEDevice::setMTU(517);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(&recorderServerCallbacks);
  BLEService *service = server->createService(BLEUUID(kBleServiceUuid), 12);
  BLECharacteristic *controlRx = service->createCharacteristic(
      kBleControlRxUuid, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  controlRx->setCallbacks(&recorderControlCallbacks);
  bleControlTx = service->createCharacteristic(kBleControlTxUuid, BLECharacteristic::PROPERTY_INDICATE);
  bleControlTx->addDescriptor(new BLE2902());
  bleAudioTx = service->createCharacteristic(kBleAudioTxUuid, BLECharacteristic::PROPERTY_NOTIFY);
  bleAudioTx->addDescriptor(new BLE2902());
  service->start();
  advertiseBle();
}

void emitCaptureStarted(const char *source) {
  if (mirrorLink == Link::kNone) return;
  const String body = String("{\"schema_version\":1,\"op\":\"capture.started\",") +
      "\"session_id\":\"" + jsonEscape(activeSessionId) + "\",\"recording_id\":\"" +
      jsonEscape(activeRecordingId) + "\",\"stream_id\":" + audioStreamId +
      ",\"source\":\"" + source + "\",\"audio\":{\"codec\":\"pcm_s16le\"," +
      "\"sample_rate_hz\":16000,\"bits_per_sample\":16,\"channels\":1," +
      "\"local_storage\":true,\"device_monotonic_start_ms\":" + millis() +
      ",\"estimated_epoch_start_ms\":" +
      (currentEpochMs() == 0 ? String("null") : uint64String(currentEpochMs())) + "}}";
  emitMirrorEvent(body);
}

bool startCapture(String sessionId, const char *source, Link liveLink) {
  if (isCapturing() || !recordingStorage.available()) return false;
  wifiTransfer.close();
  if (!recordingStorage.start(sessionId, currentEpochMs())) return false;
  activeRecordingId = recordingStorage.activeId();
  activeSessionId = activeRecordingId;
  mirrorLink = linkAvailable(liveLink) ? liveLink : Link::kNone;
  audioStreamId = millis() | 1U;
  audioSequence = 1;
  samplesRecorded = 0;
  captureState = CaptureState::kRecording;
  i2s_zero_dma_buffer(kI2sPort);
  emitCaptureStarted(source);
  return true;
}

bool pauseCapture(const char *source) {
  if (captureState != CaptureState::kRecording) return false;
  captureState = CaptureState::kPaused;
  emitMirrorEvent(String("{\"schema_version\":1,\"op\":\"capture.paused\",") +
                  "\"session_id\":\"" + jsonEscape(activeSessionId) +
                  "\",\"source\":\"" + source + "\"}");
  return true;
}

bool resumeCapture(const char *source) {
  if (captureState != CaptureState::kPaused) return false;
  i2s_zero_dma_buffer(kI2sPort);
  captureState = CaptureState::kRecording;
  emitMirrorEvent(String("{\"schema_version\":1,\"op\":\"capture.resumed\",") +
                  "\"session_id\":\"" + jsonEscape(activeSessionId) +
                  "\",\"source\":\"" + source + "\"}");
  return true;
}

bool finishCapture(const char *reason) {
  if (!isCapturing()) return false;
  captureState = CaptureState::kFinalizing;
  StoredRecording completed;
  const bool stored = recordingStorage.finish(completed);
  const Link eventLink = mirrorLink;
  if (linkAvailable(eventLink)) {
    writeFrame(eventLink, kLiveAudio, kFinal, audioStreamId, audioSequence++, 0, nullptr, 0);
    if (stored) {
      const String body = String("{\"schema_version\":1,\"op\":\"capture.finished\",") +
          "\"session_id\":\"" + jsonEscape(activeSessionId) + "\",\"recording_id\":\"" +
          jsonEscape(completed.recordingId) + "\",\"generation\":\"" +
          jsonEscape(completed.generation) + "\",\"stream_id\":" + audioStreamId +
          ",\"reason\":\"" + reason + "\",\"samples\":" + uint64String(samplesRecorded) +
          ",\"byte_size\":" + uint64String(completed.byteSize) +
          ",\"duration_ms\":" + uint64String(completed.durationMs) +
          ",\"checksum_sha256\":\"" + completed.checksumSha256 +
          "\",\"checksum_scope\":\"audio_payload\"}";
      writeJson(eventLink, kEvent, 0, body);
    } else {
      const String body = String("{\"schema_version\":1,\"op\":\"capture.interrupted\",") +
          "\"session_id\":\"" + jsonEscape(activeSessionId) +
          "\",\"reason\":\"storage_failed\"}";
      writeJson(eventLink, kEvent, 0, body);
    }
  }
  captureState = CaptureState::kIdle;
  mirrorLink = Link::kNone;
  activeSessionId = "";
  activeRecordingId = "";
  samplesRecorded = 0;
  return stored;
}

String recordingJson(const StoredRecording &value) {
  return String("{\"recording_id\":\"") + jsonEscape(value.recordingId) +
      "\",\"generation\":\"" + jsonEscape(value.generation) +
      "\",\"title\":\"" + jsonEscape(value.title) +
      "\",\"audio\":{\"codec\":\"pcm_s16le\",\"sample_rate_hz\":16000," +
      "\"bits_per_sample\":16,\"channels\":1,\"local_storage\":true}," +
      "\"byte_size\":" + uint64String(value.byteSize) +
      ",\"duration_ms\":" + uint64String(value.durationMs) +
      ",\"checksum_sha256\":\"" + value.checksumSha256 +
      "\",\"checksum_scope\":\"audio_payload\",\"created_epoch_ms\":" +
      (value.createdEpochMs == 0 ? String("null") : uint64String(value.createdEpochMs)) +
      ",\"acknowledged\":" + (value.acknowledged ? "true" : "false") +
      ",\"recovered\":" + (value.recovered ? "true" : "false") + "}";
}

// Request dispatch is kept in one place so USB and BLE expose the same LJHW/1
// behavior. Wi-Fi only carries the selected immutable file body.
void handleRequest(Link source, const FrameHeader &header, const uint8_t *payload) {
  if (header.major != kProtocolMajor || header.kind != kControlRequest) {
    sendError(source, header.correlationId, "unknown", "unsupported_protocol");
    return;
  }
  String json;
  json.reserve(header.payloadLength);
  for (uint32_t index = 0; index < header.payloadLength; ++index) json += static_cast<char>(payload[index]);
  const String op = jsonOperation(json);

  if (op == "hello") {
    if (source == Link::kBle) bleHostReady = true;
    if (source == Link::kUsb) usbHostReady = true;
    const char *securityMode = source == Link::kBle ? "development_ble" : "development_usb";
    const String response = String("{\"schema_version\":1,\"op\":\"hello\",\"ok\":true,") +
        "\"protocol\":{\"major\":1,\"minor\":1},\"device\":{\"device_id\":\"" +
        deviceId + "\",\"model\":\"" + kModel + "\",\"firmware_revision\":\"" +
        kFirmwareRevision + "\",\"hardware_revision\":\"PD-AILAMP-D01-observed\"}," +
        "\"security\":{\"mode\":\"" + securityMode + "\"},\"capabilities\":{" +
        "\"transports\":[\"usb\",\"ble\",\"wifi\"]," +
        "\"control\":[\"record_toggle\",\"record_pause_resume\"]," +
        "\"capture\":{\"live_stream\":true,\"local_storage\":" +
        (recordingStorage.available() ? "true" : "false") +
        ",\"codecs\":[\"pcm_s16le\"],\"sample_rates_hz\":[16000],\"channels\":[1]}," +
        "\"power\":{\"battery_status\":false,\"soft_shutdown\":false}," +
        "\"storage\":{\"available\":" + (recordingStorage.available() ? "true" : "false") +
        ",\"range_resume\":true,\"file_management\":[\"list\",\"rename\",\"delete\",\"acknowledge\"]," +
        "\"capacity_bytes\":" + uint64String(recordingStorage.capacityBytes()) + "}," +
        "\"wifi\":{\"bulk_transfer\":true,\"security_modes\":[\"development_http\"]}}}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "status.get") {
    const String response = String("{\"schema_version\":1,\"op\":\"status.get\",\"ok\":true,") +
        "\"status\":{\"state\":\"" + captureStateName() + "\",\"session_id\":" +
        (isCapturing() ? String("\"") + jsonEscape(activeSessionId) + "\"" : "null") +
        ",\"recording_id\":" +
        (isCapturing() ? String("\"") + jsonEscape(activeRecordingId) + "\"" : "null") +
        ",\"battery_percent\":null,\"storage_free_bytes\":" +
        uint64String(recordingStorage.freeBytes()) + ",\"pending_recordings\":" +
        recordingStorage.count(true) + "}}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "time.sync") {
    synchronizedEpochMs = jsonUInt64Field(json, "epoch_ms", 0);
    synchronizedAtMillis = millis();
    const String response = String("{\"schema_version\":1,\"op\":\"time.sync\",\"ok\":true,") +
        "\"device_monotonic_ms\":" + millis() + "}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "diagnostics.ping") {
    const String response = String("{\"schema_version\":1,\"op\":\"diagnostics.ping\",\"ok\":true,") +
        "\"device_monotonic_ms\":" + millis() + "}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "capture.start") {
    if (isCapturing()) {
      sendError(source, header.correlationId, op, "busy", true);
      return;
    }
    if (!recordingStorage.available()) {
      sendError(source, header.correlationId, op, "capture_unavailable", true);
      return;
    }
    const String requestedSession = jsonStringField(json, "session_id");
    if (!startCapture(requestedSession, "app", source)) {
      sendError(source, header.correlationId, op,
                recordingStorage.freeBytes() < 1024ULL * 1024ULL ? "storage_full" : "capture_unavailable", true);
      return;
    }
    const String response = String("{\"schema_version\":1,\"op\":\"capture.start\",\"ok\":true,") +
        "\"session_id\":\"" + jsonEscape(activeSessionId) + "\",\"recording_id\":\"" +
        jsonEscape(activeRecordingId) + "\"}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "capture.pause" || op == "capture.resume") {
    const bool changed = op == "capture.pause" ? pauseCapture("app") : resumeCapture("app");
    if (!changed) {
      sendError(source, header.correlationId, op, "invalid_state");
      return;
    }
    const String response = String("{\"schema_version\":1,\"op\":\"") + op +
        "\",\"ok\":true,\"session_id\":\"" + jsonEscape(activeSessionId) + "\"}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "capture.stop") {
    if (!isCapturing()) {
      sendError(source, header.correlationId, op, "invalid_state");
      return;
    }
    const String requestedSession = jsonStringField(json, "session_id");
    if (!requestedSession.isEmpty() && requestedSession != activeSessionId) {
      sendError(source, header.correlationId, op, "invalid_state");
      return;
    }
    const String session = activeSessionId;
    const String response = String("{\"schema_version\":1,\"op\":\"capture.stop\",\"ok\":true,") +
        "\"session_id\":\"" + jsonEscape(session) + "\"}";
    writeJson(source, kControlResponse, header.correlationId, response);
    finishCapture("app");
  } else if (op == "recording.list") {
    const String cursor = jsonStringField(json, "cursor");
    const size_t requestedLimit = static_cast<size_t>(jsonUInt64Field(json, "limit", kRecordingPageSize));
    StoredRecording recordings[kRecordingPageSize];
    String nextCursor;
    const size_t count = recordingStorage.list(cursor, min(requestedLimit, kRecordingPageSize),
                                               recordings, nextCursor);
    String response = "{\"schema_version\":1,\"op\":\"recording.list\",\"ok\":true,\"recordings\":[";
    for (size_t index = 0; index < count; ++index) {
      if (index > 0) response += ',';
      response += recordingJson(recordings[index]);
    }
    response += "],\"next_cursor\":";
    response += nextCursor.isEmpty() ? "null" : String("\"") + jsonEscape(nextCursor) + "\"";
    response += '}';
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "recording.ack") {
    const String id = jsonStringField(json, "recording_id");
    const String generation = jsonStringField(json, "expected_generation");
    if (!recordingStorage.acknowledge(id, generation)) {
      sendError(source, header.correlationId, op, "resume_mismatch");
      return;
    }
    if (wifiTransfer.active() && wifiTransfer.offer().recordingId == id) wifiTransfer.close();
    writeJson(source, kControlResponse, header.correlationId,
              String("{\"schema_version\":1,\"op\":\"recording.ack\",\"ok\":true,") +
              "\"recording_id\":\"" + jsonEscape(id) + "\"}");
  } else if (op == "recording.rename") {
    const String id = jsonStringField(json, "recording_id");
    const String generation = jsonStringField(json, "expected_generation");
    StoredRecording updated;
    if (!recordingStorage.renameTitle(id, generation, jsonStringField(json, "title"), updated)) {
      sendError(source, header.correlationId, op, "resume_mismatch");
      return;
    }
    writeJson(source, kControlResponse, header.correlationId,
              String("{\"schema_version\":1,\"op\":\"recording.rename\",\"ok\":true,") +
              "\"recording\":" + recordingJson(updated) + "}");
  } else if (op == "recording.delete") {
    const String id = jsonStringField(json, "recording_id");
    const String generation = jsonStringField(json, "expected_generation");
    if (wifiTransfer.active() && wifiTransfer.offer().recordingId == id) wifiTransfer.close();
    if (!recordingStorage.remove(id, generation)) {
      sendError(source, header.correlationId, op, "resume_mismatch");
      return;
    }
    writeJson(source, kControlResponse, header.correlationId,
              String("{\"schema_version\":1,\"op\":\"recording.delete\",\"ok\":true,") +
              "\"recording_id\":\"" + jsonEscape(id) + "\"}");
  } else if (op == "transport.wifi.offer") {
    if (isCapturing()) {
      sendError(source, header.correlationId, op, "busy", true);
      return;
    }
    StoredRecording value;
    const String id = jsonStringField(json, "recording_id");
    const String generation = jsonStringField(json, "expected_generation");
    if (!recordingStorage.get(id, value) || value.generation != generation) {
      sendError(source, header.correlationId, op, "resume_mismatch");
      return;
    }
    if (!wifiTransfer.open(value, deviceSuffix, currentEpochMs())) {
      sendError(source, header.correlationId, op, "internal_error", true);
      return;
    }
    const WifiTransferOffer &offer = wifiTransfer.offer();
    const String response = String("{\"schema_version\":1,\"op\":\"transport.wifi.offer\",\"ok\":true,") +
        "\"wifi_offer\":{\"recording_id\":\"" + jsonEscape(offer.recordingId) +
        "\",\"generation\":\"" + jsonEscape(offer.generation) +
        "\",\"ssid\":\"" + jsonEscape(offer.ssid) + "\",\"password\":\"" +
        jsonEscape(offer.password) + "\",\"base_url\":\"" + offer.baseUrl +
        "\",\"path\":\"" + offer.path + "\",\"bearer_token\":\"" +
        offer.bearerToken + "\",\"security_mode\":\"development_http\"," +
        "\"certificate_sha256\":null,\"expires_epoch_ms\":" +
        uint64String(offer.expiresEpochMs) + ",\"expires_in_ms\":" + offer.expiresInMs + "}}";
    writeJson(source, kControlResponse, header.correlationId, response);
  } else if (op == "transport.wifi.close") {
    wifiTransfer.close();
    writeJson(source, kControlResponse, header.correlationId,
              "{\"schema_version\":1,\"op\":\"transport.wifi.close\",\"ok\":true}");
  } else {
    sendError(source, header.correlationId, op.isEmpty() ? "unknown" : op, "unsupported_operation");
  }
}

void processWireFrame(Link source, const uint8_t *frame, size_t length) {
  if (length < kHeaderLength) return;
  FrameHeader header;
  if (!decodeHeader(frame, header)) return;
  const size_t total = kHeaderLength + header.payloadLength;
  if (total != length) return;
  const uint8_t *payload = frame + kHeaderLength;
  const uint32_t expected = header.payloadLength == 0 ? 0 : crc32(payload, header.payloadLength);
  if (expected == header.payloadCrc32) handleRequest(source, header, payload);
}

void processSerial() {
  while (Serial.available() > 0 && serialReceiveLength < sizeof(serialReceiveBuffer)) {
    serialReceiveBuffer[serialReceiveLength++] = static_cast<uint8_t>(Serial.read());
  }
  while (serialReceiveLength >= 4) {
    size_t magic = 0;
    while (magic + 4 <= serialReceiveLength &&
           !(serialReceiveBuffer[magic] == 'L' && serialReceiveBuffer[magic + 1] == 'J' &&
             serialReceiveBuffer[magic + 2] == 'H' && serialReceiveBuffer[magic + 3] == 'W')) ++magic;
    if (magic > 0) {
      memmove(serialReceiveBuffer, serialReceiveBuffer + magic, serialReceiveLength - magic);
      serialReceiveLength -= magic;
    }
    if (serialReceiveLength < kHeaderLength) return;
    FrameHeader header;
    if (!decodeHeader(serialReceiveBuffer, header)) {
      memmove(serialReceiveBuffer, serialReceiveBuffer + 1, --serialReceiveLength);
      continue;
    }
    const size_t total = kHeaderLength + header.payloadLength;
    if (serialReceiveLength < total) return;
    processWireFrame(Link::kUsb, serialReceiveBuffer, total);
    memmove(serialReceiveBuffer, serialReceiveBuffer + total, serialReceiveLength - total);
    serialReceiveLength -= total;
  }
}

void resetBleReceive() {
  bleReceiveLength = 0;
  bleReceiveFrameId = 0;
  bleReceiveFragmentCount = 0;
  bleReceiveNextFragment = 0;
}

void processBle() {
  if (bleIncomingQueue == nullptr) return;
  BleIncomingPacket packet;
  while (xQueueReceive(bleIncomingQueue, &packet, 0) == pdTRUE) {
    if (packet.length < kBleFragmentHeaderLength) {
      resetBleReceive();
      continue;
    }
    const uint16_t frameId = readU16(packet.bytes);
    const uint8_t index = packet.bytes[2];
    const uint8_t count = packet.bytes[3];
    const uint16_t bodyLength = readU16(packet.bytes + 4);
    if (frameId == 0 || count == 0 || index >= count || bodyLength != packet.length - 6) {
      resetBleReceive();
      continue;
    }
    if (frameId != bleReceiveFrameId) {
      resetBleReceive();
      if (index != 0) continue;
      bleReceiveFrameId = frameId;
      bleReceiveFragmentCount = count;
    }
    if (count != bleReceiveFragmentCount || index != bleReceiveNextFragment ||
        bleReceiveLength + bodyLength > sizeof(bleReceiveFrame)) {
      resetBleReceive();
      continue;
    }
    memcpy(bleReceiveFrame + bleReceiveLength, packet.bytes + 6, bodyLength);
    bleReceiveLength += bodyLength;
    bleReceiveNextFragment += 1;
    if (bleReceiveNextFragment == bleReceiveFragmentCount) {
      processWireFrame(Link::kBle, bleReceiveFrame, bleReceiveLength);
      resetBleReceive();
    }
  }
}

void processConnectionLoss() {
  if (!bleDisconnectedPending) return;
  bleDisconnectedPending = false;
  resetBleReceive();
  if (mirrorLink == Link::kBle) mirrorLink = Link::kNone;
}

void emitButtonAction(const char *action) {
  const Link link = preferredMirrorLink();
  if (link == Link::kNone) return;
  writeJson(link, kEvent, 0,
            String("{\"schema_version\":1,\"op\":\"button.pressed\",\"payload\":{") +
            "\"button\":\"record_toggle\",\"action\":\"" + action + "\"}}");
}

void handleButtonLongPress() {
  if (captureState == CaptureState::kIdle) {
    const bool started = startCapture("", "button", preferredMirrorLink());
    if (started) emitButtonAction("start");
  } else if (isCapturing()) {
    emitButtonAction("finish");
    finishCapture("button");
  }
}

void handleButtonShortPress() {
  if (captureState == CaptureState::kRecording) {
    emitButtonAction("pause");
    pauseCapture("button");
  } else if (captureState == CaptureState::kPaused) {
    emitButtonAction("resume");
    resumeCapture("button");
  }
}

bool enqueueButtonAction(ButtonAction action) {
  return buttonActionQueue != nullptr && xQueueSend(buttonActionQueue, &action, 0) == pdTRUE;
}

void sampleButtonInput() {
  const int raw = digitalRead(kRecordButtonPin);
  const uint32_t now = millis();
  if (raw != buttonRaw) {
    buttonRaw = raw;
    buttonChangedAt = now;
  }
  if (raw != buttonStable && now - buttonChangedAt >= kButtonDebounceMs) {
    buttonStable = raw;
    if (buttonStable == LOW) {
      buttonPressedAt = now;
      buttonLongHandled = false;
    } else if (!buttonLongHandled) {
      enqueueButtonAction(ButtonAction::kShortPress);
    }
  }
  if (buttonStable == LOW && !buttonLongHandled && now - buttonPressedAt >= kButtonLongPressMs) {
    if (enqueueButtonAction(ButtonAction::kLongPress)) buttonLongHandled = true;
  }
}

void buttonSamplerTask(void *) {
  while (true) {
    sampleButtonInput();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

void processButtonActions() {
  if (buttonActionQueue == nullptr) return;
  ButtonAction action;
  while (xQueueReceive(buttonActionQueue, &action, 0) == pdTRUE) {
    if (action == ButtonAction::kLongPress) handleButtonLongPress();
    else if (action == ButtonAction::kShortPress) handleButtonShortPress();
  }
}

void streamAudio() {
  if (captureState != CaptureState::kRecording) return;
  size_t bytesRead = 0;
  const esp_err_t error = i2s_read(kI2sPort, i2sSamples, sizeof(i2sSamples),
                                   &bytesRead, pdMS_TO_TICKS(25));
  if (error != ESP_OK || bytesRead == 0) return;
  const size_t count = bytesRead / sizeof(i2sSamples[0]);
  for (size_t index = 0; index < count; ++index) {
    pcmSamples[index] = static_cast<int16_t>(i2sSamples[index] >> 16);
  }
  const size_t pcmBytes = count * sizeof(pcmSamples[0]);
  if (!recordingStorage.append(reinterpret_cast<const uint8_t *>(pcmSamples), pcmBytes)) {
    finishCapture("storage_full");
    return;
  }
  if (linkAvailable(mirrorLink)) {
    writeFrame(mirrorLink, kLiveAudio, 0, audioStreamId, audioSequence++, 0,
               reinterpret_cast<const uint8_t *>(pcmSamples), pcmBytes);
  }
  samplesRecorded += count;
}
}  // namespace

void setup() {
  Serial.begin(115200);
  const uint64_t mac = ESP.getEfuseMac();
  char identity[40];
  snprintf(identity, sizeof(identity), "esp32s3-%04x%08x",
           static_cast<uint16_t>(mac >> 32U), static_cast<uint32_t>(mac));
  deviceId = identity;
  char suffix[9];
  snprintf(suffix, sizeof(suffix), "%08x", static_cast<uint32_t>(mac));
  deviceSuffix = suffix;

  recordingStorage.begin(deviceSuffix, kStorageCsPin, kStorageMosiPin,
                         kStorageClockPin, kStorageMisoPin);
  setupI2s();
  setupBle();
  // Configure the strap-key GPIO after every peripheral. This prevents an
  // Arduino peripheral initializer from silently replacing the pull-up that
  // the physical S2 debounce state machine depends on.
  pinMode(kRecordButtonPin, INPUT_PULLUP);
  buttonRaw = buttonStable = digitalRead(kRecordButtonPin);
  buttonChangedAt = millis();
  buttonActionQueue = xQueueCreate(8, sizeof(ButtonAction));
  if (buttonActionQueue != nullptr) {
    const BaseType_t started = xTaskCreatePinnedToCore(
        buttonSamplerTask, "laoji-button", 2048, nullptr, 3,
        &buttonSamplerTaskHandle, ARDUINO_RUNNING_CORE);
    if (started != pdPASS) buttonSamplerTaskHandle = nullptr;
  }
}

void loop() {
  // Physical input is sampled by a dedicated task because BLE indications can
  // block this loop while awaiting client confirmation. State and storage
  // mutations remain single-owner here.
  if (buttonSamplerTaskHandle == nullptr) sampleButtonInput();
  processButtonActions();
  processSerial();
  processBle();
  processConnectionLoss();
  streamAudio();
  wifiTransfer.loop();
  if (captureState != CaptureState::kRecording) delay(2);
}
