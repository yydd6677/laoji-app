/* ES7210 register setup follows Espressif esp-bsp ES7210 (Apache-2.0).
 * Pin assignment: SCH ESP32S3 voice memo V1.0, MCU + Audio sheets.
 * No outputs are driven on BOOT, battery, charger or unknown expansion pins. */
#include "lj.h"
#include "board_audio.h"
#include "button_gesture.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/i2s_tdm.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/task.h"
#include <stdatomic.h>

static i2s_chan_handle_t rx;
static atomic_uint overruns;
static bool IRAM_ATTR overrun(i2s_chan_handle_t chan, i2s_event_data_t *event, void *ctx) {
    (void)chan; (void)event; (void)ctx;
    atomic_fetch_add_explicit(&overruns, 1, memory_order_relaxed); return false;
}
unsigned lj_board_overruns(void) { return atomic_load_explicit(&overruns, memory_order_relaxed); }
static esp_err_t reg_write(uint8_t reg, uint8_t val) {
    const uint8_t b[] = {reg, val};
    return i2c_master_write_to_device(I2C_NUM_0, 0x41, b, sizeof(b), pdMS_TO_TICKS(150));
}
esp_err_t lj_board_init(void) {
    const i2c_config_t i2c = {.mode = I2C_MODE_MASTER, .sda_io_num = 2, .scl_io_num = 1,
        .sda_pullup_en = GPIO_PULLUP_ENABLE, .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000};
    esp_err_t e = i2c_param_config(I2C_NUM_0, &i2c);
    if (e != ESP_OK) return e;
    e = i2c_driver_install(I2C_NUM_0, i2c.mode, 0, 0, 0);
    if (e != ESP_OK) return e;
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan.dma_desc_num = 12; chan.dma_frame_num = 256;
    e = i2s_new_channel(&chan, NULL, &rx);
    if (e != ESP_OK) return e;
    i2s_tdm_config_t cfg = {
        .clk_cfg = I2S_TDM_CLK_DEFAULT_CONFIG(LJ_RATE),
        .slot_cfg = I2S_TDM_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO, I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3),
        .gpio_cfg = {.mclk = 13, .bclk = 12, .ws = 11, .dout = -1, .din = 10},
    };
    cfg.slot_cfg.total_slot = 4;
    cfg.slot_cfg.ws_width = 32;
    e = i2s_channel_init_tdm_mode(rx, &cfg);
    if (e != ESP_OK) return e;
    i2s_event_callbacks_t callbacks = {.on_recv_q_ovf = overrun};
    e = i2s_channel_register_event_callback(rx, &callbacks, NULL);
    if (e != ESP_OK) return e;
    e = i2s_channel_enable(rx);
    if (e != ESP_OK) return e;
    const uint8_t regs[][2] = {
        {0x00,0xff},{0x00,0x32},{0x09,0x30},{0x0a,0x30},
        {0x23,0x2a},{0x22,0x0a},{0x21,0x2a},{0x20,0x0a},
        {0x11,0x60},{0x12,0x02},{0x40,0xc3},{0x41,0x70},{0x42,0x70},
        {0x43,0x1a},{0x44,0x1a},{0x45,0x1a},{0x46,0x1a},
        {0x47,0x08},{0x48,0x08},{0x49,0x08},{0x4a,0x08},
        {0x07,0x20},{0x02,0xc1},{0x04,0x01},{0x05,0x00},
        {0x06,0x04},{0x4b,0x0f},{0x4c,0x0f},{0x00,0x71},{0x00,0x41},
    };
    for (size_t i = 0; i < sizeof(regs)/sizeof(regs[0]); ++i) {
        e = reg_write(regs[i][0], regs[i][1]);
        if (e != ESP_OK) return e;
    }
    ESP_LOGI("board", "ES7210 ready: 16kHz / 4x16 TDM, mono = mean(MIC1,MIC2)");
    return ESP_OK;
}
esp_err_t lj_board_read(int16_t *mono, size_t samples, size_t *got) {
    int16_t raw[512 * 4];
    *got = 0;
    if (!rx || samples > 512) return ESP_ERR_INVALID_STATE;
    size_t n = 0;
    esp_err_t e = i2s_channel_read(rx, raw, samples * 8, &n, 250);
    *got = n / 8;
    for (size_t i = 0; i < *got; ++i)
        mono[i] = lj_board_mono(raw + i * 4);
    return e;
}
static void button_task(void *unused) {
    (void)unused;
    lj_key_state_t key = {0};
    for (;;) {
        lj_key_event_t event = lj_key_step(&key, !gpio_get_level(GPIO_NUM_38), esp_timer_get_time());
        if (event != LJ_KEY_NONE) lj_control_internal(event == LJ_KEY_LONG ? "button.long" :
            event == LJ_KEY_DOUBLE ? "button.double" : "button.short");
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
void lj_button_init(void) {
    const gpio_config_t config = {.pin_bit_mask = 1ULL << 38, .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE};
    gpio_config(&config);
    xTaskCreate(button_task, "button", 2560, NULL, 3, NULL);
}
