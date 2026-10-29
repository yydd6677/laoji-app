#include "pcm_fifo.h"
#include <string.h>

bool lj_pcm_fifo_init(lj_pcm_fifo_t *q, uint8_t *data, size_t capacity) {
    if (!q || !data || capacity < 2 || capacity % 2) return false;
    *q = (lj_pcm_fifo_t){.data = data, .capacity = capacity};
    return true;
}
bool lj_pcm_fifo_put(lj_pcm_fifo_t *q, const void *data, size_t bytes) {
    if (!q || !q->data || !data || !bytes || bytes % 2 || bytes > q->capacity - q->used) return false;
    size_t at = (q->head + q->used) % q->capacity;
    size_t first = bytes < q->capacity - at ? bytes : q->capacity - at;
    memcpy(q->data + at, data, first);
    memcpy(q->data, (const uint8_t *)data + first, bytes - first);
    q->used += bytes;
    return true;
}
size_t lj_pcm_fifo_get(lj_pcm_fifo_t *q, void *out, size_t capacity) {
    if (!q || !q->data || !out || capacity < 2) return 0;
    capacity &= ~(size_t)1;
    size_t bytes = q->used < capacity ? q->used : capacity;
    size_t first = bytes < q->capacity - q->head ? bytes : q->capacity - q->head;
    memcpy(out, q->data + q->head, first);
    memcpy((uint8_t *)out + first, q->data, bytes - first);
    q->head = (q->head + bytes) % q->capacity;
    q->used -= bytes;
    return bytes;
}
