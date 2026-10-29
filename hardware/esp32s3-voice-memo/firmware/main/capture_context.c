#include "capture_context.h"
#include <string.h>
static void u32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; ++i) p[i] = v >> (8 * i); }
void lj_context_header(uint8_t out[LJ_CAPTURE_HEADER_BYTES], uint32_t n, const lj_capture_context_t *c) {
    memset(out, 0, LJ_CAPTURE_HEADER_BYTES);
    memcpy(out, "RIFF", 4); u32(out + 4, n + LJ_CAPTURE_HEADER_BYTES - 8); memcpy(out + 8, "WAVEfmt ", 8);
    u32(out + 16, 16); out[20] = 1; out[22] = 1; u32(out + 24, 16000); u32(out + 28, 32000);
    out[32] = 2; out[34] = 16;
    memcpy(out + 36, "ljct", 4); u32(out + 40, LJ_CONTEXT_BYTES);
    uint8_t *p = out + 44; p[0] = 1; p[1] = c->schedule;
    for (int i = 0; i < 8; ++i) p[4 + i] = (uint64_t)c->epoch_ms >> (i * 8);
    memcpy(p + 12, c->timezone, 64); memcpy(p + 76, c->id, 96);
    memcpy(out + 216, "data", 4); u32(out + 220, n);
}
bool lj_context_decode(const uint8_t *p, unsigned n, lj_capture_context_t *c) {
    if (n != LJ_CONTEXT_BYTES || p[0] != 1 || p[1] > 1 || !memchr(p + 12, 0, 64) || !memchr(p + 76, 0, 96)) return false;
    memset(c, 0, sizeof(*c)); c->schedule = p[1];
    uint64_t epoch = 0; for (int i = 0; i < 8; ++i) epoch |= (uint64_t)p[4 + i] << (i * 8);
    if (epoch && (epoch < 1577836800000ULL || epoch >= 4102444800000ULL)) return false;
    c->epoch_ms = epoch; memcpy(c->timezone, p + 12, 64); memcpy(c->id, p + 76, 96);
    return c->id[0] != 0;
}
