#include "metadata_index.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    lj_index_record a = {.mtime = 1792508902, .created_ms = 1792508902559LL,
        .file_bytes = 7106604, .data_offset = 44, .audio_bytes = 7106560}, b;
    for (unsigned i = 0; i < 32; ++i) { a.name_sha[i] = i; a.header_sha[i] = 255 - i; a.audio_sha[i] = i ^ 0x5a; }
    uint8_t bytes[LJ_INDEX_BYTES], corrupt[LJ_INDEX_BYTES];
    assert(lj_index_encode(&a, bytes) && lj_index_decode(bytes, sizeof(bytes), &b));
    assert(b.mtime == a.mtime && b.created_ms == a.created_ms && b.file_bytes == a.file_bytes &&
        b.data_offset == a.data_offset && b.audio_bytes == a.audio_bytes);
    assert(!memcmp(a.audio_sha,b.audio_sha,32) && !memcmp(a.header_sha,b.header_sha,32) && !memcmp(a.name_sha,b.name_sha,32));
    for (unsigned i = 0; i < sizeof(bytes); ++i) {
        memcpy(corrupt, bytes, sizeof(bytes)); corrupt[i] ^= 1;
        assert(!lj_index_decode(corrupt, sizeof(corrupt), &b));
    }
    for (unsigned n = 0; n < sizeof(bytes); ++n) assert(!lj_index_decode(bytes, n, &b));
    assert(!lj_index_decode(bytes, sizeof(bytes) + 1, &b));
    a.data_offset = UINT32_MAX; assert(!lj_index_encode(&a, bytes));
    a.data_offset = 44; a.audio_bytes |= 1; assert(!lj_index_encode(&a, bytes));
    a.audio_bytes = a.file_bytes; assert(!lj_index_encode(&a, bytes));
    a.audio_bytes = 0; a.created_ms = -1; assert(!lj_index_encode(&a, bytes));
    a.created_ms = 0; a.mtime = -1; assert(!lj_index_encode(&a, bytes));
    puts("metadata index: roundtrip, 136 single-byte corruptions, truncation, version/CRC and bounds passed");
}
