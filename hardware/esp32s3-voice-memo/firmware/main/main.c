#include "lj.h"
#include <inttypes.h>
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"

char lj_device_id[40];
void app_main(void) {
    esp_log_level_set("NimBLE", ESP_LOG_WARN);
    uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(lj_device_id, sizeof(lj_device_id), "esp32s3-%02x%02x%02x%02x%02x%02x", mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    ESP_LOGI("laoji", "source firmware %s IDF=%s", LJ_VERSION, esp_app_get_description()->idf_ver);
    esp_err_t e = nvs_flash_init();
    if (e != ESP_OK) { ESP_LOGE("laoji", "NVS error=%s; NOT erasing existing NVS", esp_err_to_name(e)); return; }
    /* No bootloader, partition, NVS schema or eFuse changes are required. */
    lj_storage_init(); lj_storage_recover(); lj_recorder_init();
    e = lj_wifi_init(); if (e != ESP_OK) ESP_LOGE("laoji", "netif error=%s", esp_err_to_name(e));
    lj_control_init();
    e = lj_ble_init(); if (e != ESP_OK) ESP_LOGE("laoji", "BLE error=%s", esp_err_to_name(e));
    lj_button_init();
    ESP_LOGI("laoji", "ready internal=%u psram=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}
