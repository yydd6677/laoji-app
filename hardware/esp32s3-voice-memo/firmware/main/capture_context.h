#pragma once
#include <stdbool.h>
#include <stdint.h>
#define LJ_CONTEXT_BYTES 172
#define LJ_CAPTURE_HEADER_BYTES 224
typedef struct {
    bool schedule;
    int64_t epoch_ms;
    char timezone[64];
    char id[96];
} lj_capture_context_t;
void lj_context_header(uint8_t out[LJ_CAPTURE_HEADER_BYTES], uint32_t audio_bytes, const lj_capture_context_t *context);
bool lj_context_decode(const uint8_t *bytes, unsigned length, lj_capture_context_t *out);
