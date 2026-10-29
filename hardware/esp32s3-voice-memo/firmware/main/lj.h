#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include "cJSON.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "capture_context.h"

#define LJ_VERSION "2.2.0"
#define LJ_DISK "/disk"
#define LJ_NAME_MAX 120
#define LJ_PATH_MAX 144
#define LJ_RATE 16000
#define LJ_BYTES_PER_SECOND 32000
#define LJ_LIVE_RING (256 * 1024)
#define LJ_LIVE_REPAIR_MAX 32768

typedef struct {
    char name[LJ_NAME_MAX + 1];
    char generation[64];
    char sha[72];
    uint32_t data_offset;
    uint32_t audio_bytes;
    uint32_t file_bytes;
    int64_t created_ms;
    bool recovered;
    lj_capture_context_t context;
} lj_recording_t;

typedef struct {
    char session[96], name[LJ_NAME_MAX + 1];
    uint32_t stream, bytes;
    bool active, paused, finalizing, live;
    int64_t created_ms;
    lj_capture_context_t context;
} lj_capture_t;

/* Each active stream owns its DMA-capable stdio buffer until fclose. A shared
 * process buffer would corrupt concurrent catalog/HTTP/BLE readers. */
typedef struct { FILE *file; void *buffer; } lj_reader_t;
bool lj_reader_open(lj_reader_t *reader, const char *path);
void lj_reader_close(lj_reader_t *reader);

extern SemaphoreHandle_t lj_fs_mutex;
extern char lj_device_id[40];

/* Pure functions also exercised on the host, not a second protocol owner. */
size_t lj_pcm_capacity(unsigned mtu);
bool lj_safe_name(const char *name);
bool lj_decode_name(const char *src, char *dst, size_t cap);
bool lj_http_range(const char *range, uint64_t size, uint64_t *start, uint64_t *length);
void lj_audio_header(uint8_t out[20], uint8_t kind, bool final, uint32_t stream, uint32_t sequence, uint64_t offset);
void lj_wav_header(uint8_t out[44], uint32_t bytes);
uint16_t lj_u16(const uint8_t *p);
uint32_t lj_u32(const uint8_t *p);
size_t lj_ring_window(uint64_t committed, uint64_t *cursor, size_t capacity, size_t limit);
bool lj_ring_copy(const uint8_t *ring, size_t capacity, uint64_t committed,
                  uint64_t offset, size_t bytes, uint8_t *out, size_t out_capacity);

esp_err_t lj_board_init(void);
esp_err_t lj_board_read(int16_t *mono, size_t samples, size_t *got);
unsigned lj_board_overruns(void);
void lj_button_init(void);
esp_err_t lj_storage_init(void);
bool lj_storage_ready(void);
uint64_t lj_storage_free(void);
unsigned lj_storage_count(void);
cJSON *lj_storage_list(unsigned offset, unsigned limit, bool *more);
cJSON *lj_storage_preview(const char *name);
esp_err_t lj_storage_meta(const char *name, lj_recording_t *out);
cJSON *lj_recording_json(const lj_recording_t *m);
cJSON *lj_audio_json(void);
void lj_storage_invalidate(void);
void lj_storage_forget(const char *name);
void lj_storage_recover(void);
esp_err_t lj_storage_committed(const char *name, uint32_t bytes, const char *sha, int64_t created, lj_recording_t *out);
bool lj_storage_pinned(void);
void lj_storage_pin(bool value);

void lj_recorder_init(void);
lj_capture_t lj_capture_snapshot(void);
esp_err_t lj_capture_start(const char *session, bool live, bool schedule);
esp_err_t lj_capture_pause(bool pause);
esp_err_t lj_capture_stop(void);
/* Called only after the started indication was acknowledged. */
void lj_capture_activate(void);
void lj_capture_disconnect(void);
bool lj_capture_repair_ready(void);
esp_err_t lj_capture_copy(const char *session, uint32_t stream, uint32_t offset,
                          size_t bytes, uint8_t *out, size_t out_capacity);

esp_err_t lj_ble_init(void);
bool lj_ble_ready(void);
bool lj_ble_audio_ready(void);
unsigned lj_ble_mtu(void);
esp_err_t lj_ble_json(const cJSON *object);
esp_err_t lj_ble_key_request(const cJSON *object);
esp_err_t lj_ble_audio(uint8_t kind, bool final, uint32_t stream, uint32_t seq,
                        uint64_t offset, const void *pcm, size_t bytes, unsigned wait_ms);
void lj_control_init(void);
bool lj_control_enqueue(const uint8_t *json, size_t n);
void lj_control_internal(const char *op);
void lj_control_disconnected(void);
void lj_control_finished(const lj_capture_t *s, const lj_recording_t *m, const char *failure);
int64_t lj_epoch_ms(void);
bool lj_time_ready(void);
const char *lj_timezone(void);

esp_err_t lj_wifi_init(void);
esp_err_t lj_wifi_offer(cJSON *reply);
void lj_wifi_status(cJSON *reply);
void lj_wifi_close(void);
void lj_wifi_expire_if_idle(void);
void lj_wifi_close_for(const char *reason);
bool lj_wifi_active(void);
