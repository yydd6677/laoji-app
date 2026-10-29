#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
size_t lj_pcm_capacity(unsigned mtu);
bool lj_safe_name(const char *name);
bool lj_decode_name(const char *src, char *dst, size_t cap);
bool lj_http_range(const char *s, uint64_t size, uint64_t *start, uint64_t *length);
void lj_audio_header(uint8_t out[20], uint8_t kind, bool final, uint32_t stream, uint32_t sequence, uint64_t offset);
void lj_wav_header(uint8_t out[44], uint32_t bytes);
uint16_t lj_u16(const uint8_t *p);
uint32_t lj_u32(const uint8_t *p);
size_t lj_ring_window(uint64_t committed, uint64_t *cursor, size_t capacity, size_t limit);
/* Caller holds the source snapshot lock and provides a separate output buffer.
 * Reject expired/uncommitted ranges; never advance an offset to make it fit. */
bool lj_ring_copy(const uint8_t *ring, size_t capacity, uint64_t committed,
                  uint64_t offset, size_t bytes, uint8_t *out, size_t out_capacity);
bool lj_ap_ssid(char *out, size_t capacity, const uint8_t mac[6]);
