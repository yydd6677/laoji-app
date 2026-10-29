#include "wire.h"
#include <ctype.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

bool lj_ap_ssid(char *out, size_t capacity, const uint8_t mac[6]) {
    if (!out || !mac || capacity < 19) return false;
    int n = snprintf(out, capacity, "LaoJi-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return n == 18;
}

uint16_t lj_u16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
uint32_t lj_u32(const uint8_t *p) { return lj_u16(p) | ((uint32_t)lj_u16(p + 2) << 16); }
static void p16(uint8_t *p, uint16_t n) { p[0] = n; p[1] = n >> 8; }
static void p32(uint8_t *p, uint32_t n) { p16(p, n); p16(p + 2, n >> 16); }
size_t lj_pcm_capacity(unsigned mtu) {
    if (mtu <= 23) return 0;
    size_t attribute = mtu - 3;
    if (attribute > 512) attribute = 512;
    return (attribute - 20) & ~(size_t)1;
}
size_t lj_ring_window(uint64_t committed, uint64_t *cursor, size_t capacity, size_t limit) {
    if (!capacity || capacity % 2 || committed % 2 || *cursor % 2 || *cursor > committed) return 0;
    if (committed - *cursor > capacity) *cursor = committed - capacity;
    uint64_t available = committed - *cursor;
    return (available < limit ? (size_t)available : limit) & ~(size_t)1;
}
bool lj_ring_copy(const uint8_t *ring, size_t capacity, uint64_t committed,
                  uint64_t offset, size_t bytes, uint8_t *out, size_t out_capacity) {
    if (!ring || !out || !capacity || capacity % 2 || committed % 2 || offset % 2 || !bytes || bytes % 2 ||
        bytes > out_capacity || bytes > capacity || offset > committed ||
        committed - offset > capacity || bytes > committed - offset) return false;
    size_t at = offset % capacity;
    size_t first = bytes < capacity - at ? bytes : capacity - at;
    memcpy(out, ring + at, first);
    memcpy(out + first, ring, bytes - first);
    return true;
}
bool lj_safe_name(const char *s) {
    if (!s || !*s || strlen(s) > 120 || !strcmp(s, ".") || !strcmp(s, "..")) return false;
    for (const unsigned char *p = (const unsigned char *)s; *p; ++p)
        if (*p < 32 || *p == 127 || strchr("/\\<>:\"|?*", *p)) return false;
    return true;
}
static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    c = (char)tolower((unsigned char)c);
    return c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
bool lj_decode_name(const char *s, char *dst, size_t cap) {
    size_t n = 0;
    if (!s || !cap) return false;
    while (*s) {
        unsigned char c = *s++;
        if (c == '%') {
            if (!s[0] || !s[1] || hex(s[0]) < 0 || hex(s[1]) < 0) return false;
            c = (hex(s[0]) << 4) | hex(s[1]); s += 2;
        }
        if (!c || n + 1 >= cap) return false;
        dst[n++] = (char)c;
    }
    dst[n] = 0;
    return lj_safe_name(dst);
}
bool lj_http_range(const char *s, uint64_t size, uint64_t *start, uint64_t *length) {
    *start = 0; *length = size;
    if (!s || !*s) return true;
    if (strncmp(s, "bytes=", 6) || !size || strchr(s, ',')) return false;
    s += 6;
    char *end;
    errno = 0;
    if (*s == '-') {
        if (!isdigit((unsigned char)s[1])) return false;
        unsigned long long n = strtoull(s + 1, &end, 10);
        if (errno || *end || !n) return false;
        if (n > size) n = size;
        *start = size - n; *length = n; return true;
    }
    if (!isdigit((unsigned char)*s)) return false;
    uint64_t first = strtoull(s, &end, 10);
    if (errno || *end != '-' || first >= size) return false;
    s = end + 1;
    uint64_t last = size - 1;
    if (*s) {
        if (!isdigit((unsigned char)*s)) return false;
        last = strtoull(s, &end, 10);
        if (errno || *end || last < first) return false;
        if (last >= size) last = size - 1;
    }
    *start = first; *length = last - first + 1; return true;
}
void lj_audio_header(uint8_t out[20], uint8_t kind, bool final, uint32_t stream, uint32_t seq, uint64_t offset) {
    out[0] = 1; out[1] = 3; out[2] = kind; out[3] = final ? 1 : 0;
    p32(out + 4, stream); p32(out + 8, seq); p32(out + 12, offset); p32(out + 16, offset >> 32);
}
void lj_wav_header(uint8_t out[44], uint32_t bytes) {
    memset(out, 0, 44); memcpy(out, "RIFF", 4); p32(out + 4, bytes + 36);
    memcpy(out + 8, "WAVEfmt ", 8); p32(out + 16, 16); p16(out + 20, 1); p16(out + 22, 1);
    p32(out + 24, 16000); p32(out + 28, 32000); p16(out + 32, 2); p16(out + 34, 16);
    memcpy(out + 36, "data", 4); p32(out + 40, bytes);
}
