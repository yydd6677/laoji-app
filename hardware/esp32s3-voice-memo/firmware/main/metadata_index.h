#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Explicit little-endian layout; never persist a compiler/ABI-dependent struct.
 * The CRC detects torn/corrupt index files, not malicious modification. The
 * receiver still verifies the complete audio SHA before accepting the file. */
#define LJ_INDEX_BYTES 136
typedef struct {
    uint8_t name_sha[32], header_sha[32], audio_sha[32];
    int64_t mtime, created_ms;
    uint32_t file_bytes, data_offset, audio_bytes;
} lj_index_record;
bool lj_index_encode(const lj_index_record *record, uint8_t out[LJ_INDEX_BYTES]);
bool lj_index_decode(const uint8_t *bytes, size_t size, lj_index_record *record);
