#include "metadata_index.h"
#include <string.h>

static uint32_t get32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void put32(uint8_t *p, uint32_t v) { for (unsigned i = 0; i < 4; ++i) p[i] = v >> (8 * i); }
static void put64(uint8_t *p, uint64_t v) { put32(p, v); put32(p + 4, v >> 32); }
static uint64_t get64(const uint8_t *p) { return get32(p) | (uint64_t)get32(p + 4) << 32; }
static uint32_t crc(const uint8_t *p, size_t n) {
    uint32_t v = UINT32_MAX;
    while (n--) { v ^= *p++; for (unsigned i = 0; i < 8; ++i) v = (v >> 1) ^ (0xedb88320u & (0u - (v & 1))); }
    return ~v;
}
static bool valid(const lj_index_record *r) {
    return r->mtime >= 0 && r->created_ms >= 0 && r->file_bytes >= 44 && r->data_offset >= 12 &&
        r->data_offset <= r->file_bytes && r->audio_bytes <= r->file_bytes - r->data_offset && !(r->audio_bytes & 1);
}
bool lj_index_encode(const lj_index_record *r, uint8_t out[LJ_INDEX_BYTES]) {
    if (!r || !out || !valid(r)) return false;
    memcpy(out, "LJMI", 4); put32(out + 4, 1);
    memcpy(out + 8, r->name_sha, 32); memcpy(out + 40, r->header_sha, 32);
    put64(out + 72, r->mtime); put32(out + 80, r->file_bytes);
    put32(out + 84, r->data_offset); put32(out + 88, r->audio_bytes); put64(out + 92, r->created_ms);
    memcpy(out + 100, r->audio_sha, 32); put32(out + 132, crc(out, 132)); return true;
}
bool lj_index_decode(const uint8_t *p, size_t size, lj_index_record *r) {
    if (!p || !r || size != LJ_INDEX_BYTES || memcmp(p, "LJMI", 4) || get32(p + 4) != 1 ||
        get32(p + 132) != crc(p, 132) || get64(p + 72) > INT64_MAX || get64(p + 92) > INT64_MAX) return false;
    memset(r, 0, sizeof(*r));
    memcpy(r->name_sha, p + 8, 32); memcpy(r->header_sha, p + 40, 32);
    r->mtime = get64(p + 72); r->file_bytes = get32(p + 80); r->data_offset = get32(p + 84);
    r->audio_bytes = get32(p + 88); r->created_ms = get64(p + 92); memcpy(r->audio_sha, p + 100, 32);
    return valid(r);
}
