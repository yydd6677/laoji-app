#pragma once

#include <Arduino.h>
#include <FS.h>
#include <Preferences.h>
#include <SD.h>
#include <SPI.h>
#include <mbedtls/sha256.h>

namespace laoji::recorder {

constexpr char kRecordingRoot[] = "/laoji";
constexpr uint32_t kRecordingSampleRate = 16000;
constexpr uint16_t kRecordingBitsPerSample = 16;
constexpr uint16_t kRecordingChannels = 1;
constexpr size_t kWavHeaderBytes = 44;

struct StoredRecording {
  String recordingId;
  String generation;
  String title;
  String checksumSha256;
  uint64_t createdEpochMs = 0;
  uint64_t byteSize = 0;
  uint64_t durationMs = 0;
  bool acknowledged = false;
  bool recovered = false;
};

class RecorderStorage final {
 public:
  explicit RecorderStorage(SPIClass &spi) : spi_(spi) {}

  bool begin(const String &deviceSuffix, int cs, int mosi, int clock, int miso) {
    deviceSuffix_ = sanitizeId(deviceSuffix);
    if (deviceSuffix_.isEmpty()) deviceSuffix_ = "board";
    cs_ = cs;
    spi_.begin(clock, miso, mosi, cs);
    const uint32_t frequencies[] = {4000000, 1000000, 400000};
    for (uint32_t frequency : frequencies) {
      if (SD.begin(cs_, spi_, frequency)) {
        mounted_ = true;
        break;
      }
      SD.end();
      delay(100);
    }
    if (!mounted_) return false;
    if (!SD.exists(kRecordingRoot) && !SD.mkdir(kRecordingRoot)) {
      mounted_ = false;
      return false;
    }
    preferences_.begin("laoji-recorder", false);
    recoverPartials();
    return true;
  }

  bool available() const { return mounted_; }
  bool active() const { return active_; }
  const String &activeId() const { return activeId_; }
  uint64_t activePcmBytes() const { return activePcmBytes_; }
  uint64_t capacityBytes() const { return mounted_ ? SD.totalBytes() : 0; }
  uint64_t freeBytes() const {
    if (!mounted_) return 0;
    const uint64_t total = SD.totalBytes();
    const uint64_t used = SD.usedBytes();
    return total > used ? total - used : 0;
  }

  String nextStandaloneId() {
    const uint32_t counter = preferences_.getUInt("next-id", 1);
    preferences_.putUInt("next-id", counter == UINT32_MAX ? 1 : counter + 1);
    char value[96];
    snprintf(value, sizeof(value), "tb-%s-%010u", deviceSuffix_.c_str(), counter);
    return String(value);
  }

  bool start(String recordingId, uint64_t createdEpochMs) {
    if (!mounted_ || active_ || freeBytes() < 1024ULL * 1024ULL) return false;
    recordingId = sanitizeId(recordingId);
    if (recordingId.isEmpty()) recordingId = nextStandaloneId();
    if (recordingId.length() > 96) recordingId = recordingId.substring(0, 96);
    const String finalPath = wavPath(recordingId);
    const String partialPath = partPath(recordingId);
    if (SD.exists(finalPath) || SD.exists(partialPath)) return false;

    activeFile_ = SD.open(partialPath, FILE_WRITE);
    if (!activeFile_) return false;
    uint8_t emptyHeader[kWavHeaderBytes] = {};
    if (activeFile_.write(emptyHeader, sizeof(emptyHeader)) != sizeof(emptyHeader)) {
      activeFile_.close();
      SD.remove(partialPath);
      return false;
    }
    writeTextAtomic(timePath(recordingId), uint64String(createdEpochMs));
    mbedtls_sha256_init(&sha_);
    if (mbedtls_sha256_starts_ret(&sha_, 0) != 0) {
      activeFile_.close();
      SD.remove(partialPath);
      SD.remove(timePath(recordingId));
      mbedtls_sha256_free(&sha_);
      return false;
    }
    shaInitialized_ = true;
    active_ = true;
    activeId_ = recordingId;
    activeCreatedEpochMs_ = createdEpochMs;
    activePcmBytes_ = 0;
    lastCheckpointAt_ = millis();
    return true;
  }

  bool append(const uint8_t *pcm, size_t length) {
    if (!active_ || pcm == nullptr || length == 0 || (length & 1U) != 0) return false;
    if (activeFile_.write(pcm, length) != length) return false;
    if (mbedtls_sha256_update_ret(&sha_, pcm, length) != 0) return false;
    activePcmBytes_ += length;
    const uint32_t now = millis();
    if (now - lastCheckpointAt_ >= 5000) {
      if (!checkpointHeader()) return false;
      lastCheckpointAt_ = now;
    }
    return true;
  }

  bool finish(StoredRecording &result, bool recovered = false) {
    if (!active_) return false;
    const String id = activeId_;
    const uint64_t created = activeCreatedEpochMs_;
    const uint64_t pcmBytes = activePcmBytes_ & ~1ULL;
    if (!patchWavHeader(activeFile_, pcmBytes)) return abortActive();
    activeFile_.flush();
    activeFile_.close();

    uint8_t digest[32] = {};
    if (!shaInitialized_ || mbedtls_sha256_finish_ret(&sha_, digest) != 0) {
      return abortActive();
    }
    mbedtls_sha256_free(&sha_);
    shaInitialized_ = false;

    const String partialPath = partPath(id);
    const String finalPath = wavPath(id);
    if (pcmBytes == 0 || SD.exists(finalPath) || !SD.rename(partialPath, finalPath)) {
      SD.remove(partialPath);
      SD.remove(timePath(id));
      clearActive();
      return false;
    }
    result.recordingId = id;
    result.generation = generationFor(pcmBytes);
    result.title = "";
    result.checksumSha256 = String("sha256:") + hexDigest(digest);
    result.createdEpochMs = created;
    result.byteSize = pcmBytes + kWavHeaderBytes;
    result.durationMs = pcmBytes * 1000ULL /
        (kRecordingSampleRate * kRecordingChannels * (kRecordingBitsPerSample / 8));
    result.acknowledged = false;
    result.recovered = recovered;
    const bool metadataWritten = writeMetadata(result);
    SD.remove(timePath(id));
    clearActive();
    if (!metadataWritten) {
      SD.remove(finalPath);
      return false;
    }
    return true;
  }

  bool abortActive() {
    if (activeFile_) activeFile_.close();
    if (shaInitialized_) {
      mbedtls_sha256_free(&sha_);
      shaInitialized_ = false;
    }
    if (!activeId_.isEmpty()) {
      SD.remove(partPath(activeId_));
      SD.remove(timePath(activeId_));
    }
    clearActive();
    return false;
  }

  size_t count(bool onlyPending = false) {
    if (!mounted_) return 0;
    size_t result = 0;
    File directory = SD.open(kRecordingRoot);
    for (File entry = directory.openNextFile(); entry; entry = directory.openNextFile()) {
      const String name = baseName(entry.name());
      entry.close();
      if (!name.endsWith(".meta")) continue;
      StoredRecording metadata;
      if (readMetadata(name.substring(0, name.length() - 5), metadata) &&
          (!onlyPending || !metadata.acknowledged)) {
        ++result;
      }
    }
    directory.close();
    return result;
  }

  size_t list(const String &cursor, size_t limit, StoredRecording *output,
              String &nextCursor) {
    nextCursor = "";
    if (!mounted_ || output == nullptr || limit == 0) return 0;
    limit = min(limit, static_cast<size_t>(32));
    bool afterCursor = cursor.isEmpty();
    size_t written = 0;
    File directory = SD.open(kRecordingRoot);
    for (File entry = directory.openNextFile(); entry; entry = directory.openNextFile()) {
      const String name = baseName(entry.name());
      entry.close();
      if (!name.endsWith(".meta")) continue;
      const String id = name.substring(0, name.length() - 5);
      if (!afterCursor) {
        if (id == cursor) afterCursor = true;
        continue;
      }
      StoredRecording metadata;
      if (!readMetadata(id, metadata)) continue;
      if (written < limit) {
        output[written++] = metadata;
      } else {
        nextCursor = output[written - 1].recordingId;
        break;
      }
    }
    directory.close();
    return written;
  }

  bool get(const String &recordingId, StoredRecording &result) {
    return mounted_ && readMetadata(sanitizeId(recordingId), result);
  }

  bool acknowledge(const String &recordingId, const String &expectedGeneration) {
    StoredRecording value;
    if (!get(recordingId, value) || value.generation != expectedGeneration) return false;
    if (value.acknowledged) return true;
    value.acknowledged = true;
    return writeMetadata(value);
  }

  bool renameTitle(const String &recordingId, const String &expectedGeneration,
                   String title, StoredRecording &updated) {
    if (!get(recordingId, updated) || updated.generation != expectedGeneration) return false;
    title.replace("\r", " ");
    title.replace("\n", " ");
    title.trim();
    if (title.length() > 120) title = title.substring(0, 120);
    updated.title = title;
    return writeMetadata(updated);
  }

  bool remove(const String &recordingId, const String &expectedGeneration) {
    StoredRecording value;
    if (!get(recordingId, value) || value.generation != expectedGeneration) return false;
    const String id = value.recordingId;
    if (active_ && id == activeId_) return false;
    bool ok = true;
    const String paths[] = {wavPath(id), metaPath(id), timePath(id), partPath(id)};
    for (const String &path : paths) {
      if (SD.exists(path) && !SD.remove(path)) ok = false;
    }
    return ok;
  }

  File openRecording(const String &recordingId, const String &expectedGeneration) {
    StoredRecording value;
    if (!get(recordingId, value) || value.generation != expectedGeneration) return File();
    return SD.open(wavPath(value.recordingId), FILE_READ);
  }

 private:
  SPIClass &spi_;
  Preferences preferences_;
  File activeFile_;
  mbedtls_sha256_context sha_;
  bool mounted_ = false;
  bool active_ = false;
  bool shaInitialized_ = false;
  int cs_ = -1;
  String deviceSuffix_;
  String activeId_;
  uint64_t activeCreatedEpochMs_ = 0;
  uint64_t activePcmBytes_ = 0;
  uint32_t lastCheckpointAt_ = 0;

  static String sanitizeId(const String &value) {
    String result;
    result.reserve(min(value.length(), static_cast<unsigned int>(128)));
    for (size_t index = 0; index < value.length() && result.length() < 128; ++index) {
      const char character = value[index];
      if (isalnum(static_cast<unsigned char>(character)) || character == '.' ||
          character == '_' || character == ':' || character == '-') {
        result += character;
      }
    }
    return result;
  }

  static String baseName(const String &path) {
    const int slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.substring(slash + 1);
  }

  static String uint64String(uint64_t value) {
    char buffer[24];
    snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
    return String(buffer);
  }

  static uint64_t parseUInt64(const String &value) {
    return strtoull(value.c_str(), nullptr, 10);
  }

  static String hexDigest(const uint8_t digest[32]) {
    static const char digits[] = "0123456789abcdef";
    char encoded[65];
    for (size_t index = 0; index < 32; ++index) {
      encoded[index * 2] = digits[digest[index] >> 4U];
      encoded[index * 2 + 1] = digits[digest[index] & 0x0fU];
    }
    encoded[64] = '\0';
    return String(encoded);
  }

  String wavPath(const String &id) const { return String(kRecordingRoot) + "/" + id + ".wav"; }
  String partPath(const String &id) const { return String(kRecordingRoot) + "/" + id + ".part"; }
  String metaPath(const String &id) const { return String(kRecordingRoot) + "/" + id + ".meta"; }
  String timePath(const String &id) const { return String(kRecordingRoot) + "/" + id + ".time"; }

  String generationFor(uint64_t pcmBytes) {
    const uint32_t value = preferences_.getUInt("next-gen", 1);
    preferences_.putUInt("next-gen", value == UINT32_MAX ? 1 : value + 1);
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "g-%010u-%llu", value,
             static_cast<unsigned long long>(pcmBytes));
    return String(buffer);
  }

  static void writeU16(File &file, uint16_t value) {
    const uint8_t bytes[] = {static_cast<uint8_t>(value), static_cast<uint8_t>(value >> 8U)};
    file.write(bytes, sizeof(bytes));
  }

  static void writeU32(File &file, uint32_t value) {
    const uint8_t bytes[] = {
        static_cast<uint8_t>(value), static_cast<uint8_t>(value >> 8U),
        static_cast<uint8_t>(value >> 16U), static_cast<uint8_t>(value >> 24U)};
    file.write(bytes, sizeof(bytes));
  }

  static bool patchWavHeader(File &file, uint64_t pcmBytes) {
    if (!file || pcmBytes > 0xffffffffULL - 36ULL || !file.seek(0)) return false;
    const uint16_t blockAlign = kRecordingChannels * (kRecordingBitsPerSample / 8);
    const uint32_t byteRate = kRecordingSampleRate * blockAlign;
    file.write(reinterpret_cast<const uint8_t *>("RIFF"), 4);
    writeU32(file, static_cast<uint32_t>(36ULL + pcmBytes));
    file.write(reinterpret_cast<const uint8_t *>("WAVEfmt "), 8);
    writeU32(file, 16);
    writeU16(file, 1);
    writeU16(file, kRecordingChannels);
    writeU32(file, kRecordingSampleRate);
    writeU32(file, byteRate);
    writeU16(file, blockAlign);
    writeU16(file, kRecordingBitsPerSample);
    file.write(reinterpret_cast<const uint8_t *>("data"), 4);
    writeU32(file, static_cast<uint32_t>(pcmBytes));
    return file.seek(kWavHeaderBytes + pcmBytes);
  }

  bool checkpointHeader() {
    if (!patchWavHeader(activeFile_, activePcmBytes_ & ~1ULL)) return false;
    activeFile_.flush();
    return true;
  }

  bool writeTextAtomic(const String &path, const String &value) {
    const String temporary = path + ".tmp";
    SD.remove(temporary);
    File file = SD.open(temporary, FILE_WRITE);
    if (!file) return false;
    const size_t written = file.print(value);
    file.flush();
    file.close();
    if (written != value.length()) {
      SD.remove(temporary);
      return false;
    }
    SD.remove(path);
    return SD.rename(temporary, path);
  }

  String readText(const String &path) {
    File file = SD.open(path, FILE_READ);
    if (!file) return "";
    String result = file.readString();
    file.close();
    result.trim();
    return result;
  }

  bool writeMetadata(const StoredRecording &value) {
    String body;
    body.reserve(420 + value.title.length());
    body += "recording_id=" + value.recordingId + "\n";
    body += "generation=" + value.generation + "\n";
    body += "title=" + value.title + "\n";
    body += "checksum_sha256=" + value.checksumSha256 + "\n";
    body += "checksum_scope=audio_payload\n";
    body += "created_epoch_ms=" + uint64String(value.createdEpochMs) + "\n";
    body += "byte_size=" + uint64String(value.byteSize) + "\n";
    body += "duration_ms=" + uint64String(value.durationMs) + "\n";
    body += String("acknowledged=") + (value.acknowledged ? "1\n" : "0\n");
    body += String("recovered=") + (value.recovered ? "1\n" : "0\n");
    return writeTextAtomic(metaPath(value.recordingId), body);
  }

  bool readMetadata(const String &recordingId, StoredRecording &value) {
    const String id = sanitizeId(recordingId);
    if (id.isEmpty()) return false;
    File file = SD.open(metaPath(id), FILE_READ);
    if (!file) return false;
    value = StoredRecording{};
    while (file.available()) {
      String line = file.readStringUntil('\n');
      if (line.endsWith("\r")) line.remove(line.length() - 1);
      const int separator = line.indexOf('=');
      if (separator < 0) continue;
      const String key = line.substring(0, separator);
      const String field = line.substring(separator + 1);
      if (key == "recording_id") value.recordingId = field;
      else if (key == "generation") value.generation = field;
      else if (key == "title") value.title = field;
      else if (key == "checksum_sha256") value.checksumSha256 = field;
      else if (key == "created_epoch_ms") value.createdEpochMs = parseUInt64(field);
      else if (key == "byte_size") value.byteSize = parseUInt64(field);
      else if (key == "duration_ms") value.durationMs = parseUInt64(field);
      else if (key == "acknowledged") value.acknowledged = field == "1";
      else if (key == "recovered") value.recovered = field == "1";
    }
    file.close();
    return value.recordingId == id && !value.generation.isEmpty() &&
        value.checksumSha256.startsWith("sha256:") && value.byteSize >= kWavHeaderBytes &&
        SD.exists(wavPath(id));
  }

  bool computePayloadDigest(const String &path, uint8_t digest[32]) {
    File file = SD.open(path, FILE_READ);
    if (!file || file.size() < static_cast<int>(kWavHeaderBytes) || !file.seek(kWavHeaderBytes)) {
      if (file) file.close();
      return false;
    }
    mbedtls_sha256_context context;
    mbedtls_sha256_init(&context);
    if (mbedtls_sha256_starts_ret(&context, 0) != 0) {
      file.close();
      mbedtls_sha256_free(&context);
      return false;
    }
    uint8_t buffer[4096];
    bool ok = true;
    while (file.available()) {
      const int count = file.read(buffer, sizeof(buffer));
      if (count < 0 || mbedtls_sha256_update_ret(&context, buffer, count) != 0) {
        ok = false;
        break;
      }
    }
    file.close();
    if (ok) ok = mbedtls_sha256_finish_ret(&context, digest) == 0;
    mbedtls_sha256_free(&context);
    return ok;
  }

  void recoverPartials() {
    File directory = SD.open(kRecordingRoot);
    String paths[16];
    size_t count = 0;
    for (File entry = directory.openNextFile(); entry && count < 16;
         entry = directory.openNextFile()) {
      const String path = entry.name();
      const String name = baseName(path);
      entry.close();
      if (name.endsWith(".part")) paths[count++] = String(kRecordingRoot) + "/" + name;
    }
    directory.close();
    for (size_t index = 0; index < count; ++index) recoverPartial(paths[index]);
  }

  void recoverPartial(const String &path) {
    const String name = baseName(path);
    if (!name.endsWith(".part")) return;
    const String id = sanitizeId(name.substring(0, name.length() - 5));
    if (id.isEmpty()) {
      SD.remove(path);
      return;
    }
    File file = SD.open(path, FILE_WRITE);
    if (!file) return;
    uint64_t size = file.size();
    uint64_t pcmBytes = size > kWavHeaderBytes ? size - kWavHeaderBytes : 0;
    pcmBytes &= ~1ULL;
    if (pcmBytes == 0 || !patchWavHeader(file, pcmBytes)) {
      file.close();
      SD.remove(path);
      SD.remove(timePath(id));
      return;
    }
    file.flush();
    file.close();
    const String finalPath = wavPath(id);
    if (SD.exists(finalPath) || !SD.rename(path, finalPath)) return;
    uint8_t digest[32] = {};
    if (!computePayloadDigest(finalPath, digest)) {
      SD.remove(finalPath);
      return;
    }
    StoredRecording value;
    value.recordingId = id;
    value.generation = generationFor(pcmBytes);
    value.checksumSha256 = String("sha256:") + hexDigest(digest);
    value.createdEpochMs = parseUInt64(readText(timePath(id)));
    value.byteSize = pcmBytes + kWavHeaderBytes;
    value.durationMs = pcmBytes * 1000ULL /
        (kRecordingSampleRate * kRecordingChannels * (kRecordingBitsPerSample / 8));
    value.recovered = true;
    if (!writeMetadata(value)) SD.remove(finalPath);
    SD.remove(timePath(id));
  }

  void clearActive() {
    active_ = false;
    activeId_ = "";
    activeCreatedEpochMs_ = 0;
    activePcmBytes_ = 0;
  }
};

}  // namespace laoji::recorder
