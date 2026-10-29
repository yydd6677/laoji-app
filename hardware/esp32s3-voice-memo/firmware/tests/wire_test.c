#include "wire.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char ssid[33]; uint8_t ap[6] = {0x7c, 0x4f, 0xad, 0xbb, 0x38, 0xb1};
    assert(lj_ap_ssid(ssid, sizeof(ssid), ap) && !strcmp(ssid, "LaoJi-7c4fadbb38b1"));
    char small[18] = "untouched";
    assert(!lj_ap_ssid(small, sizeof(small), ap) && !strcmp(small, "untouched"));
    ap[5]++; assert(lj_ap_ssid(ssid, sizeof(ssid), ap) && !strcmp(ssid, "LaoJi-7c4fadbb38b2"));
    assert(lj_pcm_capacity(23) == 0);
    assert(lj_pcm_capacity(24) == 0);
    assert(lj_pcm_capacity(64) == 40);
    assert(lj_pcm_capacity(247) == 224);
    assert(lj_pcm_capacity(517) == 492);
    assert(lj_pcm_capacity(1024) == 492);
    assert(lj_safe_name("客户访谈.wav"));
    const char *bad[] = {"", ".", "..", "../secret", "a/b.wav", "a\\b.wav", "a\r\n", "a:b", "x?y"};
    for (unsigned i = 0; i < sizeof(bad)/sizeof(*bad); ++i) assert(!lj_safe_name(bad[i]));
    char name[121];
    assert(lj_decode_name("%E5%AE%A2%E6%88%B7%20A.wav", name, sizeof(name)) && !strcmp(name, "客户 A.wav"));
    assert(!lj_decode_name("..%2Fsecret", name, sizeof(name)));
    assert(!lj_decode_name("a%00.wav", name, sizeof(name)));
    assert(!lj_decode_name("a%2", name, sizeof(name)));
    assert(lj_decode_name("%252F.wav", name, sizeof(name)) && !strcmp(name, "%2F.wav"));
    uint64_t a, n;
    assert(lj_http_range(NULL, 100, &a, &n) && a == 0 && n == 100);
    assert(lj_http_range("bytes=10-", 100, &a, &n) && a == 10 && n == 90);
    assert(lj_http_range("bytes=10-19", 100, &a, &n) && a == 10 && n == 10);
    assert(lj_http_range("bytes=-10", 100, &a, &n) && a == 90 && n == 10);
    assert(lj_http_range("bytes=0-999", 100, &a, &n) && a == 0 && n == 100);
    const char *ranges[] = {"bytes=100-", "bytes=20-10", "bytes=0-1,4-5", "bytes=-0", "bytes=+1-", "bytes=1-foo", "bytes=18446744073709551616-", "items=0-1"};
    for (unsigned i = 0; i < sizeof(ranges)/sizeof(*ranges); ++i) assert(!lj_http_range(ranges[i], 100, &a, &n));
    uint8_t h[44]; lj_wav_header(h, 32000);
    assert(!memcmp(h, "RIFF", 4) && lj_u32(h + 4) == 32036 && lj_u32(h + 40) == 32000);
    assert(lj_u16(h + 22) == 1 && lj_u32(h + 24) == 16000);
    uint8_t frame[20]; lj_audio_header(frame, 0x10, false, 123, 7, 0x123456789ULL);
    assert(frame[0] == 1 && frame[1] == 3 && frame[2] == 0x10 && frame[3] == 0);
    assert(lj_u32(frame + 4) == 123 && lj_u32(frame + 8) == 7);
    assert(lj_u32(frame + 12) == 0x23456789 && lj_u32(frame + 16) == 1);
    /* A stalled sender cannot relabel a later ring segment as offset zero. */
    uint64_t cursor = 0;
    assert(lj_ring_window(8192, &cursor, 4096, 492) == 492 && cursor == 4096);
    assert(lj_ring_window(8192, &cursor, 4096, 492) == 492 && cursor == 4096); /* retry unchanged */
    cursor += 492;
    assert(lj_ring_window(9000, &cursor, 4096, 492) == 492 && cursor == 4904);
    cursor = 9000; assert(lj_ring_window(9000, &cursor, 4096, 492) == 0);
    cursor = 1; assert(lj_ring_window(10, &cursor, 4096, 492) == 0);
    /* Every successful frame points to the same source even after losses. */
    unsigned char source[12000], ring[4096];
    for (unsigned i = 0; i < sizeof(source); ++i) source[i] = (i * 7 + i / 199) & 255;
    cursor = 0;
    for (unsigned end = 128; end <= sizeof(source); end += 128) {
        for (unsigned j = end - 128; j < end; ++j) ring[j % sizeof(ring)] = source[j];
        if ((end / 128) % 9 == 0) {
            size_t bytes = lj_ring_window(end, &cursor, sizeof(ring), 492);
            for (size_t j = 0; j < bytes; ++j) assert(ring[(cursor + j) % sizeof(ring)] == source[cursor + j]);
            cursor += bytes;
        }
    }
    puts("wire / filename / range / WAV / absolute-source ring invariants passed");
}
