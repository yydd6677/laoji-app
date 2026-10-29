#pragma once
#include <stdint.h>

/* ES7210 four-slot Philips TDM order is MIC1, MIC3, MIC2, MIC4.
 * This PCB fits microphones on MIC1/MIC2, not the first two wire slots.
 * Espressif order_info: espressif/esp-audio-dev/esp_codec_dev/device/es7210/es7210.c */
static inline int16_t lj_board_mono(const int16_t frame[4]) {
    return ((int32_t)frame[0] + frame[2]) / 2;
}
