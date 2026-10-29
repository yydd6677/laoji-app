#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Single source, caller-serialized, PCM16 only. Never overwrites an unread
 * sample and never partially accepts a producer block. No RTOS/SD dependency. */
typedef struct {
    uint8_t *data;
    size_t capacity, head, used;
} lj_pcm_fifo_t;
bool lj_pcm_fifo_init(lj_pcm_fifo_t *q, uint8_t *data, size_t capacity);
bool lj_pcm_fifo_put(lj_pcm_fifo_t *q, const void *data, size_t bytes);
size_t lj_pcm_fifo_get(lj_pcm_fifo_t *q, void *out, size_t capacity);
