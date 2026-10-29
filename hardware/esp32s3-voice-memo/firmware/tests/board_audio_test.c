#include "board_audio.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>

int main(void) {
    const int16_t silence[] = {0, INT16_MAX, 0, INT16_MIN};
    assert(lj_board_mono(silence) == 0); /* unpopulated MIC3/4 cannot leak into mono */
    const int16_t speech[] = {12000, -30000, 8000, 30000};
    assert(lj_board_mono(speech) == 10000);
    const int16_t negative[] = {-12000, 0, -8000, 0};
    assert(lj_board_mono(negative) == -10000);
    const int16_t max[] = {INT16_MAX, 0, INT16_MAX, 0};
    assert(lj_board_mono(max) == INT16_MAX);
    const int16_t min[] = {INT16_MIN, 0, INT16_MIN, 0};
    assert(lj_board_mono(min) == INT16_MIN);
    puts("board MIC1/MIC2 slot mapping and signed averaging passed");
}
