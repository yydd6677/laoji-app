#pragma once

#include <Arduino.h>

namespace laoji::hardware {

constexpr uint8_t kProtocolMajor = 1;
constexpr uint8_t kProtocolMinor = 1;
constexpr size_t kHeaderLength = 32;
constexpr size_t kMaximumControlPayload = 8192;
constexpr size_t kMaximumInboundPayload = 1024;

enum FrameKind : uint8_t {
  kControlRequest = 0x01,
  kControlResponse = 0x02,
  kEvent = 0x03,
  kLiveAudio = 0x10,
  kFileChunk = 0x11,
  kAcknowledgement = 0x12,
};

enum FrameFlag : uint8_t {
  kFinal = 0x01,
  kRetryable = 0x02,
};

struct FrameHeader {
  uint8_t major = 0;
  uint8_t minor = 0;
  uint8_t kind = 0;
  uint8_t flags = 0;
  uint32_t payloadLength = 0;
  uint32_t streamId = 0;
  uint32_t sequence = 0;
  uint32_t correlationId = 0;
  uint32_t payloadCrc32 = 0;
};

inline uint16_t readU16(const uint8_t *value) {
  return static_cast<uint16_t>(value[0]) |
         (static_cast<uint16_t>(value[1]) << 8U);
}

inline uint32_t readU32(const uint8_t *value) {
  return static_cast<uint32_t>(value[0]) |
         (static_cast<uint32_t>(value[1]) << 8U) |
         (static_cast<uint32_t>(value[2]) << 16U) |
         (static_cast<uint32_t>(value[3]) << 24U);
}

inline void writeU16(uint8_t *target, uint16_t value) {
  target[0] = static_cast<uint8_t>(value & 0xffU);
  target[1] = static_cast<uint8_t>((value >> 8U) & 0xffU);
}

inline void writeU32(uint8_t *target, uint32_t value) {
  target[0] = static_cast<uint8_t>(value & 0xffU);
  target[1] = static_cast<uint8_t>((value >> 8U) & 0xffU);
  target[2] = static_cast<uint8_t>((value >> 16U) & 0xffU);
  target[3] = static_cast<uint8_t>((value >> 24U) & 0xffU);
}

inline uint32_t crc32(const uint8_t *data, size_t length) {
  uint32_t result = 0xffffffffU;
  for (size_t index = 0; index < length; ++index) {
    result ^= data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      result = (result >> 1U) ^ (0xedb88320U &
          static_cast<uint32_t>(-static_cast<int32_t>(result & 1U)));
    }
  }
  return result ^ 0xffffffffU;
}

inline bool decodeHeader(const uint8_t *wire, FrameHeader &header) {
  if (wire[0] != 'L' || wire[1] != 'J' || wire[2] != 'H' || wire[3] != 'W') {
    return false;
  }
  header.major = wire[4];
  header.minor = wire[5];
  header.kind = wire[6];
  header.flags = wire[7];
  if (readU16(wire + 8) != kHeaderLength || readU16(wire + 10) != 0) {
    return false;
  }
  header.payloadLength = readU32(wire + 12);
  header.streamId = readU32(wire + 16);
  header.sequence = readU32(wire + 20);
  header.correlationId = readU32(wire + 24);
  header.payloadCrc32 = readU32(wire + 28);
  return header.payloadLength <= kMaximumInboundPayload &&
         (header.flags & ~(kFinal | kRetryable)) == 0;
}

inline void encodeHeader(uint8_t *wire, uint8_t kind, uint8_t flags,
                         uint32_t payloadLength, uint32_t streamId,
                         uint32_t sequence, uint32_t correlationId,
                         uint32_t payloadCrc32) {
  wire[0] = 'L'; wire[1] = 'J'; wire[2] = 'H'; wire[3] = 'W';
  wire[4] = kProtocolMajor;
  wire[5] = kProtocolMinor;
  wire[6] = kind;
  wire[7] = flags;
  writeU16(wire + 8, kHeaderLength);
  writeU16(wire + 10, 0);
  writeU32(wire + 12, payloadLength);
  writeU32(wire + 16, streamId);
  writeU32(wire + 20, sequence);
  writeU32(wire + 24, correlationId);
  writeU32(wire + 28, payloadCrc32);
}

}  // namespace laoji::hardware
