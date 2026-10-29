#include "pcm_fifo.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint32_t seed = 0x65bd1234;
static unsigned next(void) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; }
int main(void) {
    uint8_t ring[1024], input[1030], output[1030], expected[1024];
    lj_pcm_fifo_t q = {0}; size_t used = 0;
    assert(!lj_pcm_fifo_init(NULL, ring, sizeof(ring)));
    assert(!lj_pcm_fifo_init(&q, NULL, sizeof(ring)));
    assert(!lj_pcm_fifo_init(&q, ring, 0));
    assert(!lj_pcm_fifo_init(&q, ring, 1023));
    assert(lj_pcm_fifo_init(&q, ring, sizeof(ring)));
    unsigned accepted = 0, rejected = 0, consumed = 0;
    for (unsigned i = 0; i < 100000; ++i) {
        if (next() & 1) {
            size_t n = next() % 1030;
            for (size_t k = 0; k < n; ++k) input[k] = next();
            bool ok = n && !(n % 2) && n <= sizeof(ring) - used;
            assert(lj_pcm_fifo_put(&q, input, n) == ok);
            if (ok) { memcpy(expected + used, input, n); used += n; ++accepted; }
            else ++rejected;
        } else {
            size_t cap = next() % 1030;
            size_t want = (cap & ~(size_t)1) < used ? (cap & ~(size_t)1) : used;
            memset(output, 0xa5, sizeof(output));
            size_t got = lj_pcm_fifo_get(&q, output, cap);
            assert(got == want && !memcmp(output, expected, got));
            for (size_t k = got; k < sizeof(output); ++k) assert(output[k] == 0xa5);
            memmove(expected, expected + got, used - got); used -= got; consumed += got != 0;
        }
        assert(q.used == used && q.used <= q.capacity && !(q.head % 2));
        if (i % 1000 == 999) { assert(lj_pcm_fifo_init(&q, ring, sizeof(ring))); used = 0; }
    }
    assert(accepted > 5000 && rejected > 5000 && consumed > 5000);
    assert(!lj_pcm_fifo_put(&q, NULL, 2)); assert(!lj_pcm_fifo_get(&q, NULL, 2));
    assert(lj_pcm_fifo_init(&q, ring, sizeof(ring)));
    memset(input, 0x42, 1024); assert(lj_pcm_fifo_put(&q, input, 1024));
    assert(!lj_pcm_fifo_put(&q, input, 2));
    assert(lj_pcm_fifo_get(&q, output, 1024) == 1024 && !memcmp(input, output, 1024));
    puts("PCM FIFO: 100000 model-checked operations; wrap, full, reset and PCM alignment preserved");
}
