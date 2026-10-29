#include "wire.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned char source(uint64_t index) { return (index * 13 + index / 251) & 255; }
static unsigned random_state = 0x514b;
static unsigned next(void) {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    random_state ^= random_state << 5;
    return random_state;
}

int main(void) {
    uint8_t ring[1024], out[1030];
    unsigned accepted = 0;
    for (unsigned trial = 0; trial < 20000; ++trial) {
        size_t capacity = 2 + next() % 1023;
        uint64_t committed = ((uint64_t)(next() % 3) << 32) + next() % 4096;
        uint64_t offset = committed > 2048 ? committed - next() % 2048 : next() % 4096;
        size_t bytes = next() % 1100, available = next() % 1030;
        /* Guarantee positive cases rather than passing a mostly-rejection
         * generator whose parity/range correlations hide the copying path. */
        if (trial % 4 == 0) {
            capacity = 2 * (1 + next() % 512);
            committed = ((uint64_t)next() << 16) + capacity;
            size_t distance = 2 * (1 + next() % (capacity / 2));
            offset = committed - distance;
            bytes = 2 * (1 + next() % (distance / 2));
            available = bytes + next() % (sizeof(out) - 2 - bytes + 1);
        }
        for (size_t j = 0; j < capacity; ++j) {
            uint64_t absolute = committed - committed % capacity + j;
            if (absolute >= committed && absolute >= capacity) absolute -= capacity;
            ring[j] = source(absolute);
        }
        memset(out, 0xa5, sizeof(out));
        bool expected = capacity % 2 == 0 && committed % 2 == 0 && offset % 2 == 0 && bytes && bytes % 2 == 0 &&
            bytes <= available && bytes <= capacity && offset <= committed &&
            committed - offset <= capacity && bytes <= committed - offset;
        bool copied = lj_ring_copy(ring, capacity, committed, offset, bytes, out + 2, available);
        assert(copied == expected);
        accepted += copied;
        for (size_t j = 0; j < sizeof(out); ++j)
            assert(out[j] == (copied && j >= 2 && j - 2 < bytes ? source(offset + j - 2) : 0xa5));
    }
    assert(accepted >= 5000);
    memset(out, 0xa5, sizeof(out));
    assert(!lj_ring_copy(NULL, 8, 8, 0, 2, out, 2));
    assert(!lj_ring_copy(ring, 8, 8, 0, 2, NULL, 2));
    assert(!lj_ring_copy(ring, 0, 8, 0, 2, out, 2));
    assert(!lj_ring_copy(ring, 8, UINT64_MAX - 1, UINT64_MAX - 1, 2, out, 2));
    assert(!lj_ring_copy(ring, 8, 16, 6, 2, out, 2)); /* overwritten prefix */
    assert(!lj_ring_copy(ring, 8, 16, 8, 10, out, 10)); /* future bytes */
    for (size_t j = 0; j < sizeof(out); ++j) assert(out[j] == 0xa5);
    printf("candidate live-ring bounded snapshot: 20000 cases (%u valid), no shifted source or out-of-range writes\n", accepted);
}
