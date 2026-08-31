#pragma once

#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_system.h>

#include "RecorderStorage.h"

namespace laoji::recorder {

struct WifiTransferOffer {
  String recordingId;
  String generation;
  String ssid;
  String password;
  String baseUrl;
  String path;
  String bearerToken;
  uint64_t expiresEpochMs = 0;
  uint32_t expiresInMs = 0;
};

class RecorderWifiTransfer final {
 public:
  explicit RecorderWifiTransfer(RecorderStorage &storage) : storage_(storage), server_(80) {}

  bool active() const { return active_; }
  const WifiTransferOffer &offer() const { return offer_; }

  bool open(const StoredRecording &recording, const String &deviceSuffix,
            uint64_t nowEpochMs, uint32_t ttlMs = 5 * 60 * 1000U) {
    close();
    if (!storage_.available() || storage_.active()) return false;
    File probe = storage_.openRecording(recording.recordingId, recording.generation);
    if (!probe) return false;
    probe.close();

    offer_ = WifiTransferOffer{};
    offer_.recordingId = recording.recordingId;
    offer_.generation = recording.generation;
    offer_.ssid = String("LaoJi-") + deviceSuffix.substring(max(0, static_cast<int>(deviceSuffix.length()) - 4));
    offer_.password = randomAlphaNumeric(14);
    offer_.bearerToken = randomHex(24);
    offer_.baseUrl = "http://192.168.4.1";
    offer_.path = "/recording";
    offer_.expiresInMs = ttlMs;
    offer_.expiresEpochMs = nowEpochMs == 0 ? 0 : nowEpochMs + ttlMs;

    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1),
                      IPAddress(255, 255, 255, 0));
    if (!WiFi.softAP(offer_.ssid.c_str(), offer_.password.c_str(), 6, false, 1)) {
      WiFi.mode(WIFI_OFF);
      offer_ = WifiTransferOffer{};
      return false;
    }
    const char *headers[] = {"Authorization", "Range", "If-Match"};
    server_.collectHeaders(headers, 3);
    server_.on("/recording", HTTP_GET, [this]() { handleRecording(); });
    server_.onNotFound([this]() { server_.send(404, "text/plain", "not_found"); });
    server_.begin();
    openedAtMs_ = millis();
    ttlMs_ = ttlMs;
    transferCompletedAtMs_ = 0;
    active_ = true;
    return true;
  }

  void loop() {
    if (!active_) return;
    server_.handleClient();
    const uint32_t now = millis();
    if (now - openedAtMs_ >= ttlMs_ ||
        (transferCompletedAtMs_ != 0 && now - transferCompletedAtMs_ >= 3000)) {
      close();
    }
  }

  void close() {
    if (active_) server_.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    active_ = false;
    openedAtMs_ = 0;
    ttlMs_ = 0;
    transferCompletedAtMs_ = 0;
    offer_ = WifiTransferOffer{};
  }

 private:
  RecorderStorage &storage_;
  WebServer server_;
  WifiTransferOffer offer_;
  bool active_ = false;
  uint32_t openedAtMs_ = 0;
  uint32_t ttlMs_ = 0;
  uint32_t transferCompletedAtMs_ = 0;

  static String randomHex(size_t bytes) {
    static const char digits[] = "0123456789abcdef";
    String result;
    result.reserve(bytes * 2);
    for (size_t index = 0; index < bytes; ++index) {
      const uint8_t value = static_cast<uint8_t>(esp_random());
      result += digits[value >> 4U];
      result += digits[value & 0x0fU];
    }
    return result;
  }

  static String randomAlphaNumeric(size_t length) {
    static const char values[] = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    String result;
    result.reserve(length);
    for (size_t index = 0; index < length; ++index) {
      result += values[esp_random() % (sizeof(values) - 1)];
    }
    return result;
  }

  void handleRecording() {
    if (!active_ || server_.header("Authorization") != String("Bearer ") + offer_.bearerToken) {
      server_.send(401, "text/plain", "unauthorized");
      return;
    }
    const String ifMatch = server_.header("If-Match");
    const String etag = String("\"") + offer_.generation + "\"";
    if (!ifMatch.isEmpty() && ifMatch != etag && ifMatch != offer_.generation) {
      server_.send(412, "text/plain", "generation_mismatch");
      return;
    }
    File file = storage_.openRecording(offer_.recordingId, offer_.generation);
    if (!file) {
      server_.send(409, "text/plain", "recording_changed");
      return;
    }
    const uint64_t total = file.size();
    uint64_t start = 0;
    bool partial = false;
    const String range = server_.header("Range");
    if (range.startsWith("bytes=")) {
      const int dash = range.indexOf('-', 6);
      const String startText = dash < 0 ? range.substring(6) : range.substring(6, dash);
      if (startText.isEmpty()) {
        file.close();
        server_.send(416, "text/plain", "invalid_range");
        return;
      }
      start = strtoull(startText.c_str(), nullptr, 10);
      partial = true;
    }
    if (start >= total || !file.seek(start)) {
      file.close();
      server_.sendHeader("Content-Range", String("bytes */") + uint64String(total));
      server_.send(416, "text/plain", "range_not_satisfiable");
      return;
    }
    const uint64_t length = total - start;
    server_.sendHeader("Accept-Ranges", "bytes");
    server_.sendHeader("ETag", etag);
    server_.sendHeader("Cache-Control", "no-store");
    server_.sendHeader("X-LaoJi-Checksum-Scope", "audio_payload");
    if (partial) {
      server_.sendHeader(
          "Content-Range",
          String("bytes ") + uint64String(start) + "-" + uint64String(total - 1) + "/" +
              uint64String(total));
    }
    server_.setContentLength(length);
    server_.send(partial ? 206 : 200, "audio/wav", "");
    WiFiClient client = server_.client();
    uint8_t buffer[4096];
    uint64_t sent = 0;
    while (sent < length && file.available() && client.connected()) {
      const size_t wanted = min(static_cast<uint64_t>(sizeof(buffer)), length - sent);
      const int count = file.read(buffer, wanted);
      if (count <= 0) break;
      size_t offset = 0;
      while (offset < static_cast<size_t>(count) && client.connected()) {
        const size_t written = client.write(buffer + offset, count - offset);
        if (written == 0) {
          delay(1);
          continue;
        }
        offset += written;
      }
      sent += offset;
      yield();
    }
    file.close();
    client.flush();
    if (sent == length) transferCompletedAtMs_ = millis();
  }

  static String uint64String(uint64_t value) {
    char buffer[24];
    snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
    return String(buffer);
  }
};

}  // namespace laoji::recorder
